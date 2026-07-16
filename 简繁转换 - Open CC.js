// ==UserScript==
// @name         OpenCC-WASM Webpage Converter
// @namespace    https://tampermonkey.net/
// @version      7.5.0
// @description  Convert webpage Chinese text using opencc-wasm. 
// @author       ANY
// @match        https://czbooks.net/*
// @match        https://baijiahao.baidu.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==
/* global scheduler */

(function () {
  "use strict";

  const OPENCC_LIB_VERSION = "0.12.0";
  const OPENCC_PKG_BASE = `https://cdn.jsdelivr.net/npm/opencc-wasm@${OPENCC_LIB_VERSION}/dist/`;
  const OPENCC_ESM_URL = `${OPENCC_PKG_BASE}esm/index.js`;
  const OPENCC_CONFIG_BASE = `${OPENCC_PKG_BASE}data/config/`;
  const DEFAULT_CONFIG = "t2s";
  const DEFAULT_ENABLED = true;
  const DEFAULT_INCLUDE_TOFU_RISK = true;
  const CONVERT_CHUNK_SIZE = 300;
  const RESTORE_YIELD_EVERY_N_NODES = 300;
  const PROCESS_DEBOUNCE_MS = 80;
  const FULL_SCAN_DEBOUNCE_MS = 100;
  const MIN_FULL_SCAN_DELAY_MS = 16;
  const MAX_CONVERTER_ERRORS = 5;
  const CONVERTER_ERROR_COOLDOWN_MS = 200;
  const CONVERTER_FATAL_COOLDOWN_MS = 5000;
  const MAX_NODE_CONVERT_ERRORS = 2;
  const MAX_MODULE_LOAD_ERRORS = 3;
  const MODULE_LOAD_RETRY_STEP_MS = 2000;
  const PANEL_ID = "opencc-wasm-tm-panel-host";
  const STORE_PREFIX = "openccWasmUserscript.v1.";
  const WARMUP_TEXT = "的";
  const STATUS_ON_PREFIX = "On · ";
  const INITIAL_NODE_VERSION = 1;

  const CONFIG_GROUPS = [
    { label: "简→繁", configs: [
      ["s2t", "简 → 繁体"], ["s2twp", "简 → 台繁 + 词汇"], ["s2tw", "简 → 台繁"],
      ["s2hkp", "简 → 港繁 + 词汇"], ["s2hk", "简 → 港繁"], ["s2t_jieba", "简 → 繁体 (结巴)"],
      ["s2twp_jieba", "简 → 台繁 + 词汇 (结巴)"], ["s2tw_jieba", "简 → 台繁 (结巴)"],
      ["s2hkp_jieba", "简 → 港繁 + 词汇 (结巴)"], ["s2hk_jieba", "简 → 港繁 (结巴)"],
    ]},
    { label: "繁→简", configs: [
      ["t2s", "繁体 → 简"], ["tw2sp", "台繁 → 简 + 词汇"], ["tw2s", "台繁 → 简"],
      ["hk2sp", "港繁 → 简 + 词汇"], ["hk2s", "港繁 → 简"], ["tw2sp_jieba", "台繁 → 简 + 词汇 (结巴)"],
      ["hk2sp_jieba", "港繁 → 简 + 词汇 (结巴)"], ["t2s_cngov", "繁体 → 国标简"],
    ]},
    { label: "繁→繁", configs: [
      ["t2tw", "繁体 → 台繁"], ["t2hk", "繁体 → 港繁"], ["tw2t", "台繁 → 繁体"], ["hk2t", "港繁 → 繁体"],
    ]},
    { label: "日文", configs: [
      ["jp2t", "新字体 → 旧字体"], ["t2jp", "旧字体 → 新字体"],
    ]},
    { label: "国标", configs: [
      ["s2t_cngov", "简 → 国标繁"], ["t2cngov", "繁体 → 国标繁"],
      ["t2cngov_keep_simp", "国标繁 (保留简体)"], ["t2cngov_jieba", "国标繁 (结巴)"],
      ["t2cngov_keep_simp_jieba","国标繁 (保留简体, 结巴)"],
    ]},
  ];

  const CONFIG_VALUES = new Set(CONFIG_GROUPS.flatMap(g => g.configs.map(([v]) => v)));

  const tofuRiskMeta = new Map();         // configName -> boolean: has tofu-risk dicts
  const tofuRiskMetaPromises = new Map(); // configName -> in-flight metadata fetch
  const tofuRiskMetaFailed = new Set();   // configName -> last fetch failed (click tofu row to retry)
  const configJsonCache = new Map();
  function fetchConfigJson(name) {
    let p = configJsonCache.get(name);
    if (!p) {
      p = fetch(`${OPENCC_CONFIG_BASE}${name}.json`)
        .then(resp => {
          if (!resp.ok) throw new Error(`Fetch ${name}.json failed: ${resp.status}`);
          return resp.json();
        })
        .catch(err => {
          configJsonCache.delete(name);
          throw err;
        });
      configJsonCache.set(name, p);
    }
    return p;
  }

  const SKIP_SELECTOR = [
    `#${PANEL_ID}`, "[data-opencc-ignore]", "script", "style", "noscript", "template",
    "textarea", "input", "select", "option", "code", "pre", "kbd", "samp", "svg", "math", "canvas",
  ].join(",");

  const HAS_HAN = /\p{Script=Han}/u;

  const state = {
    config: DEFAULT_CONFIG, enabled: DEFAULT_ENABLED, collapsed: false,
    includeTofuRisk: DEFAULT_INCLUDE_TOFU_RISK,

    queue: [], queuedNodes: new WeakSet(), processing: false, generation: 0,
    processingDone: Promise.resolve(), processingDone_resolve: null,

    observing: false, processTimer: 0, fullScanTimer: 0,

    toggling: false, pendingConfig: null,

    converterErrorCount: 0, converterCooldownUntil: 0, moduleLoadErrorCount: 0, loadDisabled: false,
    _retryDelay: null, brokenConfigs: new Set(),

    status: { text: "", busy: false, error: false }, ui: null,
  };

  const listeners = new Set();
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const notify = () => listeners.forEach(fn => fn(state));

  const nodeStates = new WeakMap();
  let openccModulePromise = null;
  let openccModule = null;
  const converterCache = new Map();
  const observer = new MutationObserver(handleMutations);

  main().catch(err => {
    console.error("[OpenCC-WASM] Fatal:", err);
    setStatus("Fatal error", false, true);
  });

  async function main() {
    state.config = readConfig();
    state.enabled = storeGet("enabled", DEFAULT_ENABLED);
    state.collapsed = storeGet("collapsed", false);
    state.includeTofuRisk = Boolean(storeGet("includeTofuRisk", DEFAULT_INCLUDE_TOFU_RISK));
    state.status.text = state.enabled ? STATUS_ON_PREFIX + state.config : "Off";

    if (document.contentType && !/html/i.test(document.contentType)) return;
    if (!document.body) return;
    
    createPanel();
    void ensureTofuRiskMetadata(state.config);
    if (state.enabled) { startObserving(); scheduleFullScan(0); }
  }

  function readConfig() {
    const saved = storeGet("config", DEFAULT_CONFIG);
    return CONFIG_VALUES.has(saved) ? saved : DEFAULT_CONFIG;
  }

  function storeGet(key, fallback) {
    try {
      const raw = localStorage.getItem(STORE_PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  }

  function storeSet(key, value) {
    try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); } catch {}
  }

  function dictNodeHasTofuRisk(node) {
    if (!node || typeof node !== "object") return false;
    if (node.may_output_tofu === true) return true;
    return Array.isArray(node.dicts) && node.dicts.some(dictNodeHasTofuRisk);
  }

  function configJsonHasTofuRisk(cfg) {
    if (!cfg || typeof cfg !== "object") return false;
    return (
      cfg.normalization?.some(s => dictNodeHasTofuRisk(s?.dict)) ||
      dictNodeHasTofuRisk(cfg.segmentation?.dict) ||
      cfg.conversion_chain?.some(s => dictNodeHasTofuRisk(s?.dict)) ||
      false
    );
  }

  function configSupportsTofuRisk(configName) {
    return tofuRiskMeta.get(configName) === true;
  }

  function tofuMetaState(configName) {
    if (tofuRiskMeta.has(configName)) return "ready";
    if (tofuRiskMetaPromises.has(configName)) return "loading";
    return tofuRiskMetaFailed.has(configName) ? "error" : "idle";
  }

  // Lazy, per-config metadata: only the selected config is ever queried, so only
  // its JSON is fetched (instead of all 26 up front). Failures are tracked per
  // config so the tofu row can offer a real retry.
  function ensureTofuRiskMetadata(configName = state.config) {
    if (tofuRiskMeta.has(configName)) return Promise.resolve(tofuRiskMeta.get(configName));
    let p = tofuRiskMetaPromises.get(configName);
    if (!p) {
      p = fetchConfigJson(configName)
        .then(json => {
          tofuRiskMeta.set(configName, configJsonHasTofuRisk(json));
          tofuRiskMetaFailed.delete(configName);
        })
        .catch(err => {
          tofuRiskMetaFailed.add(configName);
          console.warn(`[OpenCC-WASM] Failed to load tofu-risk metadata for '${configName}':`, err);
        })
        .finally(() => {
          tofuRiskMetaPromises.delete(configName);
          notify();
        });
      tofuRiskMetaPromises.set(configName, p);
    }
    return p;
  }

  function noteModuleLoadFailure() {
    openccModulePromise = null; openccModule = null;
    state.moduleLoadErrorCount++;
    if (state.moduleLoadErrorCount >= MAX_MODULE_LOAD_ERRORS) return { giveUp: true };
    return { giveUp: false, delayMs: MODULE_LOAD_RETRY_STEP_MS * state.moduleLoadErrorCount };
  }

  async function getConverter(configName, includeTofuRiskDictionaries = true) {
    if (!openccModulePromise) {
      openccModulePromise = import(OPENCC_ESM_URL).then(mod => {
        openccModule = mod.default || mod;
        if (typeof openccModule?.Converter !== "function") throw new Error("No Converter fn");
        return openccModule;
      }).catch(err => {
        openccModulePromise = null;
        const e = new Error(`Load module failed: ${err?.message ?? err}`);
        e.kind = "module_load";
        throw e;
      });
    }
    await openccModulePromise;
    const cacheKey = `${configName}::tofu=${includeTofuRiskDictionaries}`;
    let p = converterCache.get(cacheKey);
    if (!p) {
      p = (async () => {
        const converter = openccModule.Converter({ config: configName, includeTofuRiskDictionaries });
        await converter(WARMUP_TEXT);
        return converter;
      })().catch(err => {
        converterCache.delete(cacheKey);
        const e = new Error(`Build converter failed '${configName}': ${err?.message ?? err}`);
        e.kind = "converter_init";
        e.config = configName;
        throw e;
      });
      converterCache.set(cacheKey, p);
    }
    return p;
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    return el.isContentEditable || Boolean(el.closest(SKIP_SELECTOR));
  }

  function shouldProcessTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const text = node.nodeValue;
    if (!text || !HAS_HAN.test(text)) return false;
    return Boolean(node.parentElement && !shouldSkipElement(node.parentElement));
  }

  function walkTextNodes(root, filterFn, callback) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      if (filterFn(root)) callback(root);
      return;
    }
    if (root.nodeType === Node.ELEMENT_NODE && shouldSkipElement(root)) return;
    if (root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE && root.nodeType !== Node.ELEMENT_NODE) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          return (node.isContentEditable || node.matches(SKIP_SELECTOR)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return filterFn(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let node;
    while ((node = walker.nextNode())) callback(node);
  }

  function enqueueNode(node) {
    if (state.queuedNodes.has(node)) return false;
    state.queuedNodes.add(node);
    state.queue.push(node);
    return true;
  }

  function rememberOriginal(node, resetOriginal = false) {
    let entry = nodeStates.get(node);
    if (!entry) {
      entry = { original: node.nodeValue, version: INITIAL_NODE_VERSION, convertedConfig: null, convertedTofuRisk: null, convertedText: null, errorCount: 0 };
      nodeStates.set(node, entry);
    } else if (resetOriginal) {
      entry.original = node.nodeValue;
      entry.version++;
      entry.convertedConfig = null; entry.convertedText = null;
      entry.errorCount = 0;
    }
    return entry;
  }

  function enqueueTextNode(node, resetOriginal = false) {
    if (!shouldProcessTextNode(node)) return false;
    rememberOriginal(node, resetOriginal);
    return enqueueNode(node);
  }

  function walkAndEnqueue(root, walkFilter, shouldQueue) {
    if (!root) return 0;
    let count = 0;
    walkTextNodes(root, walkFilter, n => {
      if (shouldQueue(n) && enqueueNode(n)) count++;
    });
    return count;
  }

  function collectTextNodes(root, resetOriginal = false) {
    return walkAndEnqueue(
      root,
      n => Boolean(n.nodeValue && HAS_HAN.test(n.nodeValue)),
      n => { rememberOriginal(n, resetOriginal); return true; }
    );
  }

  function requeueForConfigChange() {
    return walkAndEnqueue(
      document.body,
      n => nodeStates.has(n),
      n => {
        const ns = nodeStates.get(n);
        if (!ns) return false;
        const needsProcess = (ns.original && HAS_HAN.test(ns.original)) || (ns.convertedText !== null && shouldProcessTextNode(n));
        if (!needsProcess) return false;
        return !(ns.convertedConfig === state.config && ns.convertedTofuRisk === state.includeTofuRisk && n.nodeValue === ns.convertedText);
      }
    );
  }

  function clearQueue() { state.queue.length = 0; state.queuedNodes = new WeakSet(); }

  const yieldToMain = () => scheduler.yield();

  function promiseWithTimeout(promise, ms) {
    let timer;
    const timeout = new Promise(r => { timer = setTimeout(r, ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function scheduleFullScan(delay = FULL_SCAN_DEBOUNCE_MS) {
    if (!state.enabled || state.loadDisabled) return;
    if (state.brokenConfigs.has(state.config)) return;
    if (state.fullScanTimer) { clearTimeout(state.fullScanTimer); state.fullScanTimer = 0; }
    state.fullScanTimer = setTimeout(() => {
      state.fullScanTimer = 0;
      if (!state.enabled || !document.body) return;
      stopObserving(false); clearQueue();
      const count = collectTextNodes(document.body, true);
      if (count > 0) { setStatus(`Queued ${count} nodes`, true); scheduleProcess(0); }
      else setStatus(STATUS_ON_PREFIX + state.config);
      if (state.enabled) startObserving();
    }, Math.max(delay, MIN_FULL_SCAN_DELAY_MS));
  }

  function scheduleModuleRetry(delay) {
    if (!state.enabled) return;
    if (state.processTimer) { clearTimeout(state.processTimer); state.processTimer = 0; }
    state.processTimer = setTimeout(() => {
      state.processTimer = 0;
      state.loadDisabled = false;
      scheduler.postTask(() => processQueue(), { priority: "background" });
    }, delay);
  }

  function scheduleProcess(delay = PROCESS_DEBOUNCE_MS) {
    if (!state.enabled || state.loadDisabled) return;
    if (state.processTimer) { clearTimeout(state.processTimer); state.processTimer = 0; }
    const wait = Math.max(delay, state.converterCooldownUntil - Date.now());
    state.processTimer = setTimeout(() => {
      state.processTimer = 0;
      scheduler.postTask(() => processQueue(), { priority: "background" });
    }, wait);
  }

  const currentGen = () => ({ generation: state.generation, config: state.config, includeTofuRisk: state.includeTofuRisk });
  const isStale = (gen) => !state.enabled || state.generation !== gen.generation || state.config !== gen.config || state.includeTofuRisk !== gen.includeTofuRisk;

  function writeConverted(converted, gen) {
    for (const { item, result } of converted) {
      if (isStale(gen)) break;
      if (item.state.version !== item.version) {
        if (item.node.isConnected && shouldProcessTextNode(item.node)) enqueueNode(item.node);
        continue;
      }
      if (!item.node.isConnected || !shouldProcessTextNode(item.node)) continue;
      const convertedText = String(result);
      try {
        item.state.convertedConfig = gen.config;
        item.state.convertedTofuRisk = gen.includeTofuRisk;
        item.state.convertedText = convertedText;
        if (item.node.nodeValue !== convertedText) item.node.nodeValue = convertedText;
      } catch {
        nodeStates.delete(item.node);
      }
    }
  }

  async function convertChunk(chunk, converter, gen) {
    const converted = [];
    for (const item of chunk) {
      if (isStale(gen)) break;
      let result;
      try {
        result = await converter(item.original);
        state.converterErrorCount = 0;
      } catch (err) {
        item.state.errorCount = (item.state.errorCount || 0) + 1;
        state.converterErrorCount++;
        if (state.converterErrorCount >= MAX_CONVERTER_ERRORS) {
          clearQueue();
          state.converterErrorCount = 0;
          state.converterCooldownUntil = Date.now() + CONVERTER_FATAL_COOLDOWN_MS;
          if (converted.length && !isStale(gen)) {
            stopObserving(true);
            writeConverted(converted, gen);
            if (!isStale(gen)) startObserving();
          }
          setStatus("Conversion failed", false, true);
          converterCache.delete(`${gen.config}::tofu=${gen.includeTofuRisk}`);
          return { fatal: true };
        }
        if (item.state.errorCount >= MAX_NODE_CONVERT_ERRORS) continue;
        enqueueNode(item.node);
        await new Promise(r => setTimeout(r, CONVERTER_ERROR_COOLDOWN_MS * state.converterErrorCount));
        continue;
      }
      converted.push({ item, result });
    }
    return { converted };
  }

  async function processQueue() {
    if (state.processing || !state.enabled) return;
    if (state.processTimer) { clearTimeout(state.processTimer); state.processTimer = 0; }
    if (!state.queue.length) { setStatus(STATUS_ON_PREFIX + state.config); return; }
    
    state.processing = true;
    const { promise, resolve } = Promise.withResolvers();
    state.processingDone = promise; state.processingDone_resolve = resolve;
    const gen = currentGen();
    
    try {
      setStatus(`Loading ${gen.config}…`, true);
      let converter;
      try { converter = await getConverter(gen.config, gen.includeTofuRisk); }
      catch (err) {
        if (err?.kind === "converter_init" && err.config === gen.config) {
          state.brokenConfigs.add(gen.config);
          setStatus(`Config '${gen.config}' failed`, false, true);
          clearQueue();
          return;
        }
        throw err;
      }
      state.brokenConfigs.delete(gen.config);
      state.moduleLoadErrorCount = 0; state.converterErrorCount = 0; state.loadDisabled = false;
      if (isStale(gen)) return;

      let didWork = true, chunkCounter = 0;
      while (!isStale(gen) && didWork) {
        didWork = false;
        const chunk = [];
        while (state.queue.length && chunk.length < CONVERT_CHUNK_SIZE) {
          const node = state.queue.shift();
          state.queuedNodes.delete(node);
          if (!node.isConnected || !shouldProcessTextNode(node)) continue;
          const ns = nodeStates.get(node) || rememberOriginal(node, false);
          if (!ns.original || !HAS_HAN.test(ns.original)) continue;
          if (ns.convertedConfig === gen.config && ns.convertedTofuRisk === gen.includeTofuRisk && node.nodeValue === ns.convertedText) continue;
          chunk.push({ node, state: ns, version: ns.version, original: ns.original });
        }
        if (!chunk.length) { await yieldToMain(); continue; }
        
        didWork = true; chunkCounter++;
        if (chunkCounter % 3 === 0 || state.queue.length === 0) setStatus(`Converting… ${state.queue.length} left`, true);
        
        const { converted, fatal } = await convertChunk(chunk, converter, gen);
        if (fatal) return;
        if (isStale(gen)) break;

        stopObserving(true);
        writeConverted(converted, gen);
        if (!isStale(gen)) startObserving();
        await yieldToMain();
      }
      if (!isStale(gen)) setStatus(STATUS_ON_PREFIX + gen.config);
    } catch (err) {
      const isModuleError = err?.kind === "module_load" || !openccModule;
      if (isModuleError) {
        const { giveUp, delayMs } = noteModuleLoadFailure();
        if (giveUp) {
          setStatus("Load failed – reload page", false, true);
          clearQueue(); state.loadDisabled = true; stopObserving(false); clearScheduledTimers();
          return;
        }
        setStatus(`Load error – retry in ${delayMs / 1000}s…`, false, true);
        state._retryDelay = delayMs;
        state.loadDisabled = true;
      } else {
        setStatus("Internal error — see console", false, true); clearQueue();
      }
    } finally {
      if (!isStale(gen)) {
        const pending = observer.takeRecords();
        if (pending.length) handleMutations(pending);
      }
      state.processing = false;
      if (state.enabled && !state.loadDisabled) startObserving();
      if (state.processingDone_resolve) { state.processingDone_resolve(); state.processingDone_resolve = null; }
      if (state.enabled) {
        const delay = state._retryDelay ?? 0;
        state._retryDelay = null;
        if (delay > 0) {
          scheduleModuleRetry(delay);
        } else if (state.queue.length) {
          scheduleProcess(0);
        }
      } else clearQueue();
    }
  }

  function handleMutations(mutations) {
    if (!state.enabled || state.loadDisabled) return;
    let enqueued = 0;
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const node = mutation.target;
        if (!node.isConnected) { nodeStates.delete(node); continue; }
        if (shouldProcessTextNode(node)) {
          const ns = nodeStates.get(node);
          if (ns) {
            if (node.nodeValue === ns.convertedText) continue;
            rememberOriginal(node, true);
            if (enqueueNode(node)) enqueued++;
          } else if (enqueueTextNode(node, true)) enqueued++;
        } else nodeStates.delete(node);
      } else if (mutation.type === "childList") {
        for (const added of mutation.addedNodes) enqueued += collectTextNodes(added, false);
      }
    }
    if (enqueued > 0) scheduleProcess(PROCESS_DEBOUNCE_MS);
  }

  function startObserving() {
    if (state.observing || !state.enabled || !document.body) return;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    state.observing = true;
  }

  function stopObserving(processPending = false) {
    if (!state.observing) return;
    if (processPending) { const p = observer.takeRecords(); if (p.length) handleMutations(p); }
    observer.disconnect(); state.observing = false;
  }

  function clearScheduledTimers() {
    if (state.processTimer) { clearTimeout(state.processTimer); state.processTimer = 0; }
    if (state.fullScanTimer) { clearTimeout(state.fullScanTimer); state.fullScanTimer = 0; }
  }

  async function restoreOriginals() {
    clearScheduledTimers();
    stopObserving(true);
    const myGen = state.generation;
    const nodes = [];
    walkTextNodes(document.body, n => nodeStates.has(n), n => nodes.push(n));
    let count = 0;
    for (const n of nodes) {
      if (state.generation !== myGen) break;
      const ns = nodeStates.get(n);
      if (ns) {
        try {
          if (n.isConnected && n.nodeValue !== ns.original) n.nodeValue = ns.original;
        } catch {
          nodeStates.delete(n);
          continue;
        }
        ns.convertedConfig = null;
        ns.convertedText = null;
        ns.convertedTofuRisk = null;
        ns.version++;
      }
      if (++count % RESTORE_YIELD_EVERY_N_NODES === 0) await yieldToMain();
    }
    clearQueue();
  }

  async function setEnabled(nextEnabled) {
    nextEnabled = Boolean(nextEnabled);
    if (nextEnabled === state.enabled) { notify(); return; }
    state.generation++; clearScheduledTimers(); state.toggling = true;
    try {
      if (!nextEnabled) {
        stopObserving(false);
        if (state.processing) await promiseWithTimeout(state.processingDone, 3000);
        state.enabled = false; storeSet("enabled", false);
        await restoreOriginals();
        setStatus("Off");
      } else {
        state.enabled = true; storeSet("enabled", true); state.loadDisabled = false;
        state.converterCooldownUntil = 0;
        setStatus(STATUS_ON_PREFIX + state.config, true);
        startObserving(); scheduleFullScan(0);
      }
    } finally { state.toggling = false; }
    
    if (state.pendingConfig) { const p = state.pendingConfig; state.pendingConfig = null; setConfig(p); }
    else notify();
  }

  function setConfig(nextConfig) {
    if (!CONFIG_VALUES.has(nextConfig)) return;
    if (state.toggling) { state.pendingConfig = nextConfig; return; }
    if (nextConfig === state.config) { notify(); return; }
    state.config = nextConfig; storeSet("config", state.config);
    state.generation++; clearQueue();
    state.converterCooldownUntil = 0;
    void ensureTofuRiskMetadata(state.config);
    state.brokenConfigs.delete(nextConfig);
    if (state.enabled) {
      setStatus(`Switching to ${state.config}…`, true);
      if (state.brokenConfigs.has(state.config)) {
        scheduleFullScan(0);
      } else {
        const count = requeueForConfigChange();
        if (count > 0) scheduleProcess(0); else setStatus(STATUS_ON_PREFIX + state.config);
      }
    } else setStatus("Off");
    notify();
  }

  function setIncludeTofuRisk(next) {
    if (!configSupportsTofuRisk(state.config)) { notify(); return; }
    next = Boolean(next);
    if (next === state.includeTofuRisk) { notify(); return; }
    state.includeTofuRisk = next;
    storeSet("includeTofuRisk", next);
    state.generation++; clearQueue();
    if (state.enabled) {
      setStatus(`Switching…`, true);
      const count = requeueForConfigChange();
      if (count > 0) scheduleProcess(0); else setStatus(STATUS_ON_PREFIX + state.config);
    } else setStatus("Off");
    notify();
  }

  function setStatus(text, busy = false, error = false) {
    state.status = { text, busy, error };
    notify();
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.setAttribute("data-opencc-ignore", "true");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
<style>
:host{all:initial;display:block;position:fixed;right:22px;bottom:22px;width:56px;height:56px;overflow:visible;z-index:2147483647;font-family:"Noto Sans SC","SF Pro Display",system-ui,sans-serif;--accent:#8b7cff;--accent-soft:rgba(139,124,255,.18);--danger:#ff6b7d;--success:#48d597;--warning:#ffc857;--surface:rgba(16,16,28,.9);--surface-2:rgba(255,255,255,.06);--line:rgba(255,255,255,.1);--text:#f7f6ff;--muted:#aaa8c4;--dim:#69677e;anchor-name:--opencc-anchor;transition:left .25s ease,top .25s ease}
:host(.dragging){user-select:none;transition:none}
*{box-sizing:border-box;margin:0;padding:0}
button,select{font:inherit}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(72,213,151,.35)}50%{box-shadow:0 0 0 7px rgba(72,213,151,0)}}
@keyframes blink{50%{opacity:.45}}
.fab{position:absolute;right:0;bottom:0;width:56px;height:56px;border:1px solid rgba(255,255,255,.18);border-radius:18px;background:linear-gradient(145deg,rgba(45,42,78,.95),rgba(17,17,29,.95));backdrop-filter:blur(22px);box-shadow:0 12px 30px rgba(0,0,0,.42),inset 0 1px rgba(255,255,255,.14);cursor:pointer;display:grid;place-items:center;transition:transform .2s ease,box-shadow .2s ease}
.fab:hover{transform:translateY(-2px) scale(1.04);box-shadow:0 16px 34px rgba(0,0,0,.48),0 0 0 3px var(--accent-soft),inset 0 1px rgba(255,255,255,.14)}
.fab:active{transform:scale(.95)}
.fab-inner{font-size:20px;font-weight:800;line-height:1;background:linear-gradient(135deg,#c4b5fd,#67e8f9);background-clip:text;color:transparent}
.fab-dot,.header-dot{border-radius:50%;background:var(--dim);transition:background .2s,box-shadow .2s}
.fab-dot{position:absolute;top:7px;right:7px;width:8px;height:8px;border:1.5px solid #16151f}
.header-dot{width:8px;height:8px;flex:0 0 auto}
.fab-dot.on,.header-dot.on{background:var(--success);animation:pulse 3s ease-in-out infinite}
.fab-dot.busy,.header-dot.busy{background:var(--warning);animation:blink 1s ease-in-out infinite}
.fab-dot.error,.header-dot.error{background:var(--danger);animation:blink 1s ease-in-out infinite}
.panel{width:350px;border:1px solid var(--line);border-radius:22px;background:var(--surface);backdrop-filter:blur(28px);box-shadow:0 26px 70px rgba(0,0,0,.58),0 0 0 1px var(--accent-soft),inset 0 1px rgba(255,255,255,.1);overflow:hidden;position-anchor:--opencc-anchor;position-area:block-start span-inline-start;position-try-fallbacks: flip-block;margin:8px;opacity:0;transform:translateY(12px) scale(.97);transition:opacity .25s ease,transform .3s cubic-bezier(.2,.8,.2,1),overlay .25s allow-discrete,display .25s allow-discrete}
.panel:popover-open{opacity:1;transform:none}
@starting-style{.panel:popover-open{opacity:0;transform:translateY(20px) scale(.94)}}
.panel::backdrop{background:transparent}
.header{display:flex;align-items:center;gap:9px;padding:16px 18px 14px;border-bottom:1px solid var(--line);cursor:grab;user-select:none}
.header:active{cursor:grabbing}
.header-label{font-size:14px;font-weight:800;letter-spacing:.02em;color:var(--text)}
.header-status{margin-left:auto;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dim)}
.header-status.busy{color:var(--warning)}
.header-status.error{color:var(--danger)}
.body{padding:18px}
.eyebrow{font-size:11px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase}
.config-field{display:block}
.config-field .eyebrow{display:block;margin-bottom:7px}
.config-select{width:100%;height:42px;padding:0 38px 0 13px;border:1px solid var(--line);border-radius:12px;outline:none;background:var(--surface-2);color:var(--text);cursor:pointer;appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 17px) 18px,calc(100% - 12px) 18px;background-size:5px 5px,5px 5px;background-repeat:no-repeat;transition:border-color .2s,background-color .2s}
.config-select:hover,.config-select:focus{border-color:rgba(158,145,255,.7);background-color:rgba(139,124,255,.1)}
.config-select option,.config-select optgroup{background:#202033;color:#f7f6ff}
.settings{display:grid;gap:10px;margin-top:14px}
.setting{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 13px;border:1px solid var(--line);border-radius:13px;background:rgba(255,255,255,.035);cursor:pointer;user-select:none;transition:border-color .2s,background-color .2s,opacity .2s}
.setting:hover:not(.locked){border-color:rgba(158,145,255,.45);background:rgba(139,124,255,.08)}
.setting.locked{opacity:.48;cursor:not-allowed}
.setting-copy{min-width:0}.setting-title{font-size:13px;color:var(--text)}.setting-help{margin-top:3px;font-size:11px;color:var(--dim);line-height:1.35}
.switch{width:34px;height:20px;flex:0 0 auto;border:1px solid var(--line);border-radius:20px;background:rgba(255,255,255,.08);position:relative;transition:background .2s,border-color .2s}
.switch::after{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:var(--muted);transition:transform .2s cubic-bezier(.2,.8,.2,1),background .2s}
.setting.on .switch{border-color:rgba(139,124,255,.55);background:var(--accent-soft)}
.setting.on .switch::after{transform:translateX(14px);background:#fff}
.setting.locked .switch{border-color:var(--line);background:rgba(255,255,255,.05)}
.btn{width:100%;height:42px;margin-top:16px;border:0;border-radius:12px;background:linear-gradient(135deg,#8273ff,#a78bfa);color:#fff;cursor:pointer;font-size:14px;font-weight:800;letter-spacing:.03em;box-shadow:0 8px 18px rgba(105,88,230,.25);transition:transform .15s,filter .2s,background .2s}
.btn:hover{filter:brightness(1.08)}
.btn:active{transform:scale(.98)}
.btn:disabled{cursor:wait;opacity:.6}
.btn.off{background:rgba(255,255,255,.08);color:var(--text);box-shadow:none}
.footer{display:flex;align-items:center;justify-content:space-between;padding:11px 18px 13px;border-top:1px solid var(--line);color:var(--dim);font-size:10px;letter-spacing:.04em}
.footer-hint{color:var(--muted)}
</style>
<div class="fab" title="OpenCC-WASM — 拖拽移动"><div class="fab-inner">文</div><div class="fab-dot"></div></div>
<div class="panel" popover="auto">
  <div class="header">
    <div class="header-dot"></div>
    <span class="header-label">OpenCC</span>
    <div class="header-status"></div>
  </div>
  <div class="body">
    <label class="config-field">
      <span class="eyebrow">转换方案</span>
      <select class="config-select" aria-label="OpenCC conversion config"></select>
    </label>
    <div class="settings">
      <div class="setting tofu-row" role="switch" tabindex="0" aria-checked="false" aria-disabled="false">
        <div class="setting-copy"><div class="setting-title">罕见字词典</div><div class="setting-help tofu-help"></div></div>
        <div class="switch"></div>
      </div>
    </div>
    <button class="btn" type="button"></button>
  </div>
  <div class="footer">
    <span class="footer-version">opencc-wasm ${OPENCC_LIB_VERSION}</span>
    <span class="footer-hint">拖拽标题栏移动</span>
  </div>
</div>`;

    state.ui = {
      host, root,
      status: root.querySelector(".header-status"),
      configSelect: root.querySelector(".config-select"),
      tofuRow: root.querySelector(".tofu-row"),
      tofuHelp: root.querySelector(".tofu-help"),
      toggle: root.querySelector(".btn"),
      fab: root.querySelector(".fab"),
      panel: root.querySelector(".panel"),
      fabDot: root.querySelector(".fab-dot"),
      headerDot: root.querySelector(".header-dot"),
      header: root.querySelector(".header"),
    };

    state.ui.panel.addEventListener("toggle", (e) => {
      if (e.newState === "closed" && !state.collapsed) {
        state.collapsed = true;
        storeSet("collapsed", true);
        notify();
      }
    });

    populateConfigOptions();
    state.ui.configSelect.addEventListener("change", e => setConfig(e.target.value));

    const onTofuRowActivate = () => {
      if (tofuMetaState(state.config) !== "ready") { void ensureTofuRiskMetadata(state.config); return; }
      if (!configSupportsTofuRisk(state.config)) return;
      setIncludeTofuRisk(!state.includeTofuRisk);
    };
    state.ui.tofuRow.addEventListener("click", onTofuRowActivate);
    state.ui.tofuRow.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      onTofuRowActivate();
    });

    state.ui.toggle.addEventListener("click", async () => {
      state.ui.toggle.disabled = true;
      try { await setEnabled(!state.enabled); }
      finally { state.ui.toggle.disabled = false; }
    });

    setupDrag();
    subscribe(renderUI);
    renderUI();
  }

  function populateConfigOptions() {
    state.ui.configSelect.replaceChildren(
      ...CONFIG_GROUPS.map(({ label, configs }) => {
        const og = document.createElement("optgroup");
        og.label = label;
        og.append(...configs.map(([value, text]) => new Option(text, value)));
        return og;
      }),
    );
  }

  function renderUI() {
    if (!state.ui) return;
    const { ui, collapsed, enabled, config, status, includeTofuRisk } = state;
    const tofuMeta = tofuMetaState(config);
    const tofuAvailable = tofuMeta === "ready" && configSupportsTofuRisk(config);

    if (collapsed) {
      if (ui.panel.matches(":popover-open")) ui.panel.hidePopover();
    } else if (!ui.panel.matches(":popover-open")) {
      ui.panel.showPopover();
    }

    ui.configSelect.value = config;
    const tofuLocked = tofuMeta === "ready" && !tofuAvailable;
    ui.tofuRow.classList.toggle("on", tofuAvailable && includeTofuRisk);
    ui.tofuRow.classList.toggle("locked", tofuLocked);
    ui.tofuRow.setAttribute("aria-checked", tofuAvailable && includeTofuRisk ? "true" : "false");
    ui.tofuRow.setAttribute("aria-disabled", tofuLocked ? "true" : "false");
    ui.tofuRow.tabIndex = tofuLocked ? -1 : 0;
    if (tofuMeta === "idle" || tofuMeta === "loading") {
      ui.tofuHelp.textContent = "正在检测当前方案是否含罕见字词典…";
      ui.tofuRow.title = "正在读取转换方案元数据";
    } else if (tofuMeta === "error") {
      ui.tofuHelp.textContent = "读取方案元数据失败，点击重试";
      ui.tofuRow.title = "读取转换方案元数据失败，点击重试";
    } else if (tofuAvailable) {
      ui.tofuHelp.textContent = "包含当前方案中可能产生罕见字（豆腐字）的词典条目";
      ui.tofuRow.title = "是否包含当前方案中可能产生罕见字的词典条目；与方案名中的“词汇”无关";
    } else {
      ui.tofuHelp.textContent = "当前转换方案不含罕见字词典，开关已锁定";
      ui.tofuRow.title = "当前转换方案不含罕见字词典";
    }

    ui.toggle.textContent = enabled ? "关闭网页转换" : "开启网页转换";
    ui.toggle.classList.toggle("off", !enabled);

    if (ui.status.textContent !== status.text) ui.status.textContent = status.text;
    ui.status.classList.toggle("busy", status.busy);
    ui.status.classList.toggle("error", status.error);

    const stateClass = status.error ? "error" : status.busy ? "busy" : enabled ? "on" : "";
    ui.fabDot.className = "fab-dot " + stateClass;
    ui.headerDot.className = "header-dot " + stateClass;
  }

  function setupDrag() {
    if (!state.ui) return;
    const DRAG_THRESHOLD = 8;
    const savedPos = storeGet("panelPos", null);
    let cachedW = state.ui.host.offsetWidth || 52;
    let cachedH = state.ui.host.offsetHeight || 52;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0, moved = false;
    let wasOpen = false;

    requestAnimationFrame(() => {
      cachedW = state.ui.host.offsetWidth || cachedW;
      cachedH = state.ui.host.offsetHeight || cachedH;
      if (savedPos && typeof savedPos.left === "number") applyPosition(savedPos.left, savedPos.top);
    });

    function applyPosition(left, top) {
      const maxL = window.innerWidth - cachedW;
      const maxT = window.innerHeight - cachedH;
      state.ui.host.style.right = "auto";
      state.ui.host.style.bottom = "auto";
      state.ui.host.style.left = Math.max(0, Math.min(left, maxL)) + "px";
      state.ui.host.style.top = Math.max(0, Math.min(top, maxT)) + "px";
    }

    const resizeHandler = () => requestAnimationFrame(() => {
      if (!state.ui.host.isConnected) { window.removeEventListener("resize", resizeHandler); return; }
      const rect = state.ui.host.getBoundingClientRect();
      applyPosition(rect.left, rect.top);
    });
    window.addEventListener("resize", resizeHandler);

    function startPointerDrag(e) {
      if (e.button !== 0) return;
      moved = false; startX = e.clientX; startY = e.clientY;
      wasOpen = state.ui.panel.matches(":popover-open");
      const rect = state.ui.host.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      applyPosition(startLeft, startTop);
      state.ui.host.setPointerCapture(e.pointerId);
      state.ui.host.classList.add("dragging");
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!state.ui.host.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      moved = true;
      applyPosition(startLeft + dx, startTop + dy);
    }

    function endPointerDrag(e) {
      if (!state.ui.host.hasPointerCapture(e.pointerId)) return;
      state.ui.host.releasePointerCapture(e.pointerId);
      state.ui.host.classList.remove("dragging");
      if (e.type !== "pointerup") return;
      if (moved) {
        const rect = state.ui.host.getBoundingClientRect();
        storeSet("panelPos", { left: rect.left, top: rect.top });
      } else {
        state.collapsed = wasOpen;
        storeSet("collapsed", state.collapsed);
        notify();
      }
    }

    state.ui.fab.addEventListener("pointerdown", startPointerDrag);
    state.ui.header.addEventListener("pointerdown", startPointerDrag);
    state.ui.host.addEventListener("pointermove", onPointerMove);
    state.ui.host.addEventListener("pointerup", endPointerDrag);
    state.ui.host.addEventListener("pointercancel", endPointerDrag);
  }
})();
