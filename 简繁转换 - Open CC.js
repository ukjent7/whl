// ==UserScript==
// @name         OpenCC-WASM Webpage Converter
// @namespace    https://tampermonkey.net/
// @version      6.0.5
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

  const OPENCC_LIB_VERSION = "0.9.0";
  const OPENCC_ESM_URL = `https://cdn.jsdelivr.net/npm/opencc-wasm@${OPENCC_LIB_VERSION}/dist/esm/index.js`;
  const DEFAULT_CONFIG = "t2s";
  const DEFAULT_ENABLED = true;
  const CONVERT_CHUNK_SIZE = 300;
  const RESTORE_YIELD_EVERY_N_NODES = 300;
  const PROCESS_DEBOUNCE_MS = 80;
  const FULL_SCAN_DEBOUNCE_MS = 100;
  const MIN_FULL_SCAN_DELAY_MS = 16;
  const MAX_CONVERTER_ERRORS = 5;
  const CONVERTER_ERROR_COOLDOWN_MS = 200;
  const MAX_NODE_CONVERT_ERRORS = 2;
  const MAX_MODULE_LOAD_ERRORS = 3;
  const MODULE_LOAD_RETRY_BASE_MS = 2000;
  const PANEL_ID = "opencc-wasm-tm-panel-host";
  const STORE_PREFIX = "openccWasmUserscript.v1.";
  const WARMUP_TEXT = "的";
  const STATUS_ON_PREFIX = "On · ";
  const INITIAL_NODE_VERSION = 1;

  const CONFIG_GROUPS = [
    { id: "s2t", label: "简→繁", color: "#f59e0b", configs: [
      ["s2t", "简 → 繁体"],
      ["s2twp", "简 → 台繁 + 词汇"],
      ["s2tw", "简 → 台繁"],
      ["s2hkp", "简 → 港繁 + 词汇"],
      ["s2hk", "简 → 港繁"],
      ["s2t_jieba", "简 → 繁体 (结巴)"],
      ["s2twp_jieba", "简 → 台繁 + 词汇 (结巴)"],
      ["s2tw_jieba", "简 → 台繁 (结巴)"],
      ["s2hkp_jieba", "简 → 港繁 + 词汇 (结巴)"],
      ["s2hk_jieba", "简 → 港繁 (结巴)"],
    ]},
    { id: "t2s", label: "繁→简", color: "#10b981", configs: [
      ["t2s", "繁体 → 简"],
      ["tw2sp", "台繁 → 简 + 词汇"],
      ["tw2s", "台繁 → 简"],
      ["hk2sp", "港繁 → 简 + 词汇"],
      ["hk2s", "港繁 → 简"],
      ["tw2sp_jieba", "台繁 → 简 + 词汇 (结巴)"],
      ["hk2sp_jieba", "港繁 → 简 + 词汇 (结巴)"],
      ["t2s_cngov", "繁体 → 国标简"],
    ]},
    { id: "tw2hk", label: "繁→繁", color: "#8b5cf6", configs: [
      ["t2tw", "繁体 → 台繁"],
      ["t2hk", "繁体 → 港繁"],
      ["tw2t", "台繁 → 繁体"],
      ["hk2t", "港繁 → 繁体"],
    ]},
    { id: "jp", label: "日文", color: "#ec4899", configs: [
      ["jp2t", "新字体 → 旧字体"],
      ["t2jp", "旧字体 → 新字体"],
    ]},
    { id: "cngov", label: "国标", color: "#6366f1", configs: [
      ["s2t_cngov", "简 → 国标繁"],
      ["t2cngov", "繁体 → 国标繁"],
      ["t2cngov_keep_simp", "国标繁 (保留简体)"],
      ["t2cngov_jieba", "国标繁 (结巴)"],
      ["t2cngov_keep_simp_jieba","国标繁 (保留简体, 结巴)"],
    ]},
  ];

  const CONFIG_VALUES = new Set();
  const CONFIG_INDEX = new Map();
  for (const g of CONFIG_GROUPS){
    for (const [v] of g.configs) { CONFIG_VALUES.add(v); CONFIG_INDEX.set(v, g.id); }
  }

  const SKIP_SELECTOR = [
    `#${PANEL_ID}`, "[data-opencc-ignore]", "script", "style", "noscript", "template",
    "textarea", "input", "select", "option", "code", "pre", "kbd", "samp", "svg", "math", "canvas",
  ].join(",");

  const HAS_HAN = /\p{Script=Han}/u;

  const yieldToMain = typeof scheduler?.yield === "function"
  ? () => scheduler.yield()
  : () => new Promise(r => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => { port1.close(); port2.close(); r(); };
      port2.postMessage(null);
    });

  const state = {
    config:              DEFAULT_CONFIG,
    enabled:             DEFAULT_ENABLED,
    collapsed:           false,
    queue:               [],
    queuedNodes:         new WeakSet(),
    processing:          false,
    generation:          0,
    observing:           false,
    processTimer:        0,
    fullScanTimer:       0,
    toggling:            false,
    converterErrorCount:    0,
    moduleLoadErrorCount:   0,
    pendingConfig:       null,
    loadDisabled:        false,
    status:              { text: "", busy: false, error: false },
    ui:                  null,
    _retryDelay:         null,
    processingDone:      Promise.resolve(),
    processingDone_resolve: null,
  };

  function initState() {
    state.config = readConfig();
    state.enabled = storeGet("enabled", DEFAULT_ENABLED);
    state.collapsed = storeGet("collapsed", false);
    state.status.text = state.enabled ? STATUS_ON_PREFIX + state.config : "Off";
  }

  const nodeStates = new WeakMap();
  let openccModulePromise = null;
  let openccModule = null;
  const converterCache = new Map();
  const observer = new MutationObserver(handleMutations);

  main().catch(err => {
    console.error("[OpenCC-WASM userscript] Fatal error:", err);
    setStatus("Fatal error", false, true);
  });

  async function main() {
    initState();
    if (document.contentType && !/html/i.test(document.contentType)) return;
    if (document.readyState === "loading"){
      await new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    }
    if (!document.body) return;
    createPanel();
    if (state.enabled) { startObserving(); scheduleFullScan(0); }
    else setStatus("Off");
  }

  function readConfig() {
    const saved = storeGet("config", DEFAULT_CONFIG);
    return CONFIG_VALUES.has(saved) ? saved : DEFAULT_CONFIG;
  }

  function storeGet(key, fallback) {
    try {
      const raw = localStorage.getItem(STORE_PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (err) {
      console.warn("[OpenCC-WASM userscript] storeGet failed:", err);
      return fallback;
    }
  }

  function storeSet(key, value) {
    try {
      localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
    } catch (err) {
      console.warn("[OpenCC-WASM userscript] storeSet failed:", err);
    }
  }

  async function getConverter(configName) {
    if (!openccModulePromise) {
      openccModulePromise = import(OPENCC_ESM_URL).then(mod => {
        openccModule = mod.default || mod;
        if (typeof openccModule?.Converter !== "function") {
          throw new Error("Loaded module does not expose a Converter function");
        }
        return openccModule;
      }).catch(err => {
        openccModulePromise = null;
        const e = new Error(`Failed to load OpenCC module: ${err?.message ?? err}`);
        e.kind = "module_load";
        throw e;
      });
    }
    await openccModulePromise;
    if (converterCache.has(configName)) return converterCache.get(configName);
    const buildPromise = (async () => {
      const converter = openccModule.Converter({ config: configName });
      await converter(WARMUP_TEXT);
      return converter;
    })();
    converterCache.set(configName, buildPromise);
    try {
      const converter = await buildPromise;
      converterCache.set(configName, Promise.resolve(converter));
      return converter;
    } catch (err) {
      converterCache.delete(configName);
      const e = new Error(`Failed to build converter for '${configName}': ${err?.message ?? err}`);
      e.kind = "converter_init";
      e.config = configName;
      throw e;
    }
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.isContentEditable) return true;
    return Boolean(el.closest(SKIP_SELECTOR));
  }

  function shouldProcessTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const text = node.nodeValue;
    if (!text || !HAS_HAN.test(text)) return false;
    const parent = node.parentElement;
    return Boolean(parent && !shouldSkipElement(parent));
  }

  function rememberOriginal(node, resetOriginal = false) {
    let entry = nodeStates.get(node);
    if (!entry) {
      entry = { original: node.nodeValue, version: INITIAL_NODE_VERSION, convertedConfig: null, convertedText: null, errorCount: 0 };
      nodeStates.set(node, entry);
    } else if (resetOriginal) {
      entry.original = node.nodeValue;
      entry.version++;
      entry.convertedConfig = null;
      entry.convertedText = null;
    }
    return entry;
  }

  function enqueueTextNode(node, resetOriginal = false) {
    if (!shouldProcessTextNode(node)) return false;
    rememberOriginal(node, resetOriginal);
    if (!state.queuedNodes.has(node)) {
      state.queuedNodes.add(node);
      state.queue.push(node);
      return true;
    }
    return false;
  }

  function collectTextNodes(root, resetOriginal = false) {
    if (!root) return 0;
    if (root.nodeType === Node.TEXT_NODE) return enqueueTextNode(root, resetOriginal) ? 1 : 0;
    if (
      root.nodeType !== Node.ELEMENT_NODE &&
      root.nodeType !== Node.DOCUMENT_NODE &&
      root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
    ) return 0;
    if (root.nodeType === Node.ELEMENT_NODE && shouldSkipElement(root)) return 0;
    let count = 0;
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.isContentEditable || node.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;
          }
          const text = node.nodeValue;
          if (!text || !HAS_HAN.test(text)) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let node;
    while ((node = walker.nextNode())) {
      rememberOriginal(node, resetOriginal);
      if (!state.queuedNodes.has(node)) {
        state.queuedNodes.add(node);
        state.queue.push(node);
        count++;
      }
    }
    return count;
  }

  function requeueForConfigChange() {
    if (!document.body) return 0;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.isContentEditable || node.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;
          }
          if (!nodeStates.has(node)) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let count = 0;
    let node;
    while ((node = walker.nextNode())) {
      const ns = nodeStates.get(node);
      if (!ns) continue;
      const needsProcess =
        (ns.original && HAS_HAN.test(ns.original)) ||
        (ns.convertedText !== null && shouldProcessTextNode(node));
      if (!needsProcess) continue;
      if (ns.convertedConfig === state.config && node.nodeValue === ns.convertedText) continue;
      if (!state.queuedNodes.has(node)) {
        state.queuedNodes.add(node);
        state.queue.push(node);
        count++;
      }
    }
    return count;
  }

  function clearQueue() { state.queue.length = 0; state.queuedNodes = new WeakSet(); }

  function scheduleFullScan(delay = FULL_SCAN_DEBOUNCE_MS) {
    if (!state.enabled || state.loadDisabled) return;
    if (state.fullScanTimer) { clearTimeout(state.fullScanTimer); state.fullScanTimer = 0; }
    state.fullScanTimer = setTimeout(() => {
      state.fullScanTimer = 0;
      if (!state.enabled || !document.body) return;
      stopObserving(false);
      clearQueue();
      const count = collectTextNodes(document.body, true);
      if (count > 0) {
        setStatus(`Queued ${count} text nodes`, true);
        scheduleProcess(0);
      } else {
        setStatus(STATUS_ON_PREFIX + state.config);
      }
      if (state.enabled) startObserving();
    }, Math.max(delay, MIN_FULL_SCAN_DELAY_MS));
  }

  function scheduleProcess(delay = PROCESS_DEBOUNCE_MS) {
    if (!state.enabled || state.loadDisabled) return;
    if (state.processTimer) { clearTimeout(state.processTimer); state.processTimer = 0; }
    state.processTimer = setTimeout(() => {
      state.processTimer = 0;
      if (typeof scheduler?.postTask === "function") {
        scheduler.postTask(() => processQueue(), { priority: "background" });
      } else {
        void processQueue();
      }
    }, delay);
  }

  function writeConverted(converted, myGeneration, myConfig) {
    for (const { item, result } of converted) {
      if (!state.enabled || state.generation !== myGeneration || state.config !== myConfig) break;
      const currentState = nodeStates.get(item.node);
      if (currentState !== item.state || item.state.version !== item.version) {
        if (item.node.isConnected && shouldProcessTextNode(item.node)
            && !state.queuedNodes.has(item.node)) {
          state.queuedNodes.add(item.node);
          state.queue.push(item.node);
        }
        continue;
      }
      if (!item.node.isConnected || !shouldProcessTextNode(item.node)) continue;
      const convertedText = String(result);
      try {
        item.state.convertedConfig = myConfig;
        item.state.convertedText = convertedText;
        if (item.node.nodeValue !== convertedText) item.node.nodeValue = convertedText;
      } catch (err) {
        console.warn("[OpenCC-WASM userscript] Failed to write converted text:", err);
        nodeStates.delete(item.node);
      }
    }
  }

  async function processQueue() {
    if (state.processing || !state.enabled) return;
    if (state.processTimer) { clearTimeout(state.processTimer); state.processTimer = 0; }
    if (!state.queue.length) { setStatus(STATUS_ON_PREFIX + state.config); return; }
    state.processing = true;
    state.processingDone = new Promise(r => { state.processingDone_resolve = r; });
    const myGeneration = state.generation;
    const myConfig = state.config;
    let myQueue = state.queue;
    let myQueuedNodes = state.queuedNodes;
    try {
      setStatus(`Loading ${myConfig}…`, true);
      let converter;
      try {
        converter = await getConverter(myConfig);
      } catch (err) {
        if (err?.kind === "converter_init" && err.config === myConfig) {
          setStatus(`Config '${myConfig}' failed – ${err.message}`, false, true);
          clearQueue();
          return;
        }
        throw err;
      }
      state.moduleLoadErrorCount = 0;
      state.converterErrorCount = 0;
      state.loadDisabled = false;
      if (!state.enabled || state.generation !== myGeneration || state.config !== myConfig) return;

      let didWork = true;
      let chunkCounter = 0;
      while (state.enabled && state.generation === myGeneration && state.config === myConfig && didWork) {
        myQueue = state.queue;
        myQueuedNodes = state.queuedNodes;
        didWork = false;
        const chunk = [];
        while (myQueue.length && chunk.length < CONVERT_CHUNK_SIZE) {
          const node = myQueue.shift();
          myQueuedNodes.delete(node);
          if (!node.isConnected || !shouldProcessTextNode(node)) continue;
          const ns = nodeStates.get(node) || rememberOriginal(node, false);
          if (!ns.original || !HAS_HAN.test(ns.original)) continue;
          if (ns.convertedConfig === myConfig && node.nodeValue === ns.convertedText) continue;
          chunk.push({ node, state: ns, version: ns.version, original: ns.original });
        }
        if (!chunk.length) { await yieldToMain(); continue; }
        didWork = true;
        chunkCounter++;
        if (chunkCounter % 3 === 0 || myQueue.length === 0) {
          setStatus(`Converting… ${myQueue.length} left`, true);
        }
        const converted = [];
        for (const item of chunk) {
          if (!state.enabled || state.generation !== myGeneration || state.config !== myConfig) break;
          let result;
          try {
            result = await converter(item.original);
            state.converterErrorCount = 0;
          } catch (err) {
            item.state.errorCount = (item.state.errorCount || 0) + 1;
            state.converterErrorCount++;
            console.error("[OpenCC-WASM userscript] Conversion failed:", err);
            if (item.state.errorCount >= MAX_NODE_CONVERT_ERRORS) {
              console.warn("[OpenCC-WASM userscript] Skipping node after repeated failures:", item.node.nodeValue);
              continue;
            }
            if (!myQueuedNodes.has(item.node)) {
              myQueuedNodes.add(item.node);
              myQueue.push(item.node);
            }
            if (state.converterErrorCount >= MAX_CONVERTER_ERRORS) {
              if (converted.length) {
                stopObserving(false);
                writeConverted(converted, myGeneration, myConfig);
                if (state.enabled && state.generation === myGeneration && state.config === myConfig) startObserving();
              }
              setStatus("Conversion failed", false, true);
              clearQueue();
              state.converterErrorCount = 0;
              return;
            }
            await new Promise(resolve => setTimeout(resolve, CONVERTER_ERROR_COOLDOWN_MS * state.converterErrorCount));
            continue;
          }
          converted.push({ item, result });
        }

        if (!state.enabled || state.generation !== myGeneration || state.config !== myConfig) break;

        stopObserving(false);
        writeConverted(converted, myGeneration, myConfig);
        if (state.enabled && state.generation === myGeneration && state.config === myConfig) startObserving();
        await yieldToMain();
      }

      if (state.enabled && state.generation === myGeneration && state.config === myConfig){
        setStatus(STATUS_ON_PREFIX + myConfig);
      }
    } catch (err) {
      const isModuleError = err?.kind === "module_load" || !openccModule;
      if (isModuleError) {
        console.error("[OpenCC-WASM userscript] Module load error:", err);
        openccModulePromise = null;
        openccModule = null;
        state.moduleLoadErrorCount++;
        if (state.moduleLoadErrorCount >= MAX_MODULE_LOAD_ERRORS) {
          setStatus("Load failed – reload page to retry", false, true);
          clearQueue();
          state.loadDisabled = true;
          stopObserving(false);
          clearScheduledTimers();
          return;
        }
        const backoff = MODULE_LOAD_RETRY_BASE_MS * state.moduleLoadErrorCount;
        setStatus(`Load error – retrying in ${backoff / 1000}s…`, false, true);
        state._retryDelay = backoff;
      } else {
        console.error("[OpenCC-WASM userscript] Unexpected runtime error:", err);
        setStatus("Internal error — see console", false, true);
        clearQueue();
      }
    } finally {
      if (state.enabled && state.generation === myGeneration && state.config === myConfig) {
        const pending = observer.takeRecords();
        if (pending.length) handleMutations(pending);
      }
      state.processing = false;
      if (state.enabled && !state.loadDisabled) startObserving();
      if (state.processingDone_resolve) {
        state.processingDone_resolve();
        state.processingDone_resolve = null;
      }
      if (state.enabled) {
        const delay = state._retryDelay ?? 0;
        state._retryDelay = null;
        if (delay > 0) {
          scheduleFullScan(delay);
        } else if (state.queue.length) {
          scheduleProcess(0);
        }
      } else {
        clearQueue();
      }
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
            if (!state.queuedNodes.has(node)) {
              state.queuedNodes.add(node);
              state.queue.push(node);
              enqueued++;
            }
          } else {
            if (enqueueTextNode(node, true)) enqueued++;
          }
        } else {
          nodeStates.delete(node);
        }
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
    if (processPending) { const pending = observer.takeRecords(); if (pending.length) handleMutations(pending); }
    observer.disconnect();
    state.observing = false;
  }

  function clearScheduledTimers() {
    if (state.processTimer) { clearTimeout(state.processTimer); state.processTimer = 0; }
    if (state.fullScanTimer) { clearTimeout(state.fullScanTimer); state.fullScanTimer = 0; }
  }

  async function restoreOriginals() {
    clearScheduledTimers();
    stopObserving(true);
    const myGeneration = state.generation;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.isContentEditable || node.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;
          }
          if (!nodeStates.has(node)) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let iterCount = 0;
    let node;
    while ((node = walker.nextNode())) {
      if (state.generation !== myGeneration) {
        do {
          const ns = nodeStates.get(node);
          if (ns) { ns.convertedConfig = null; ns.convertedText = null; ns.version++; }
        } while ((node = walker.nextNode()));
        break;
      }
      const ns = nodeStates.get(node);
      if (ns) {
        if (node.isConnected && node.nodeValue !== ns.original) {
          node.nodeValue = ns.original;
        }
        ns.convertedConfig = null;
        ns.convertedText = null;
        ns.version++;
      }
      if (++iterCount % RESTORE_YIELD_EVERY_N_NODES === 0) await yieldToMain();
    }
    clearQueue();
  }

  async function setEnabled(nextEnabled) {
    nextEnabled = Boolean(nextEnabled);
    if (nextEnabled === state.enabled) { refreshControls(); return; }
    state.generation++;
    clearScheduledTimers();
    state.toggling = true;
    try {
      if (!nextEnabled) {
        stopObserving(false);
        if (state.processing) {
          const timeout = new Promise(r => setTimeout(r, 3000));
          await Promise.race([state.processingDone, timeout]);
        }
        state.enabled = false;
        storeSet("enabled", false);
        await restoreOriginals();
        setStatus("Off");
      } else {
        state.enabled = true;
        storeSet("enabled", true);
        state.loadDisabled = false;
        setStatus(STATUS_ON_PREFIX + state.config, true);
        startObserving();
        scheduleFullScan(0);
      }
    } finally {
      state.toggling = false;
    }
    if (state.pendingConfig) {
      const pending = state.pendingConfig;
      state.pendingConfig = null;
      setConfig(pending);
    } else {
      refreshControls();
    }
  }

  function setConfig(nextConfig) {
    if (!CONFIG_VALUES.has(nextConfig)) return;
    if (state.toggling) {
      state.pendingConfig = nextConfig;
      return;
    }
    if (nextConfig === state.config) { refreshControls(); return; }
    state.config = nextConfig;
    storeSet("config", state.config);
    state.generation++;
    clearQueue();
    refreshControls();
    if (state.enabled) {
      setStatus(`Switching to ${state.config}…`, true);
      const count = requeueForConfigChange();
      if (count > 0) scheduleProcess(0);
      else setStatus(STATUS_ON_PREFIX + state.config);
    } else setStatus("Off");
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.setAttribute("data-opencc-ignore", "true");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `:host{all:initial;display:block;position:fixed;right:20px;bottom:20px;width:52px;height:52px;overflow:visible;z-index:2147483647;font-family:"Noto Sans SC","SF Pro Display",system-ui,-apple-system,sans-serif;--primary:#7c6af7;--primary-glow:rgba(124,106,247,.35);--danger:#f25c6e;--success:#34d399;--warning:#fbbf24;--bg:rgba(12,12,20,.85);--bg-card:rgba(255,255,255,.04);--border:rgba(255,255,255,.08);--border-strong:rgba(255,255,255,.15);--text-1:#f0f0f8;--text-2:#9898b8;--text-3:#55556a;anchor-name:--fab-anchor;transition:left .3s cubic-bezier(0.2,0.8,0.2,1),top .3s cubic-bezier(0.2,0.8,0.2,1)}
:host(.dragging){-webkit-user-select:none;user-select:none;transition:none}
*{box-sizing:border-box;margin:0;padding:0}
@keyframes dotBlink{0%,100%{opacity:1;box-shadow:0 0 6px 1px var(--warning)}50%{opacity:.4;box-shadow:0 0 2px 0px var(--warning)}}
@keyframes breathe{0%,100%{box-shadow:0 0 0 0 rgba(52,211,153,0.45)}50%{box-shadow:0 0 0 8px rgba(52,211,153,0)}}
@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-4px)}60%{transform:translateX(4px)}}

.fab::before,.panel::before{content:"";position:absolute;inset:0;border-radius:inherit;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.06'/%3E%3C/svg%3E");pointer-events:none;mix-blend-mode:overlay;z-index:1}
.fab-inner,.header,.body,.footer,.fab-dot,.btn{position:relative;z-index:2}

.fab{position:absolute;right:0;bottom:0;width:52px;height:52px;z-index:2;border-radius:16px;border:1px solid var(--border-strong);background:var(--bg);backdrop-filter:blur(24px);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .25s cubic-bezier(0.34,1.56,0.64,1),box-shadow .2s ease;box-shadow:0 8px 32px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,0.12),inset 0 -1px 0 rgba(0,0,0,0.3)}
.fab:hover{transform:scale(1.08) translateY(-2px)}
.fab:active{transform:scale(0.92)}
.fab[hidden]{display:none!important}
.fab:has(.fab-dot.busy){box-shadow:0 8px 32px rgba(0,0,0,.5),0 0 0 2px var(--warning),inset 0 1px 0 rgba(255,255,255,0.12)}
.fab-inner{font-size:18px;line-height:1;font-weight:800;background:linear-gradient(135deg,#a78bfa,#67e8f9);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.fab-dot{position:absolute;top:7px;right:7px;width:8px;height:8px;border-radius:50%;border:1.5px solid rgba(10,10,18,.9);background:var(--text-3);transition:background .3s ease,box-shadow .3s ease}
.fab-dot.on{background:var(--success);animation:breathe 3s ease-in-out infinite}
.fab-dot.busy{background:var(--warning);animation:dotBlink 1.2s ease-in-out infinite}
.fab-dot.error{background:var(--danger);animation:dotBlink 1.2s ease-in-out infinite,shake 0.5s ease-in-out}

.panel{width:320px;z-index:1;border-radius:18px;border:1px solid var(--border);background:var(--bg);backdrop-filter:blur(32px);box-shadow:0 0 0 1px var(--primary-glow),0 24px 64px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,0.08),inset 0 0 0 1px rgba(255,255,255,0.03);overflow:hidden;opacity:1;transform:translateY(0) scale(1);transition:opacity 0.35s cubic-bezier(0.16,1,0.3,1),transform 0.55s cubic-bezier(0.34,1.8,0.64,1),box-shadow 0.4s ease,display .3s allow-discrete;position:fixed;position-anchor:--fab-anchor;position-area:block-end span-inline-end;position-try-fallbacks:block-end span-inline-start,block-start span-inline-end,block-start span-inline-start;margin:4px}
@starting-style{.panel{opacity:0;transform:translateY(24px) scale(0.92) translateZ(0);box-shadow:0 4px 12px rgba(0,0,0,0.2)}}
.panel[hidden]{opacity:0;transform:translateY(12px) scale(0.98);display:none;pointer-events:none}
.panel::after{content:"";position:absolute;inset:-60px;border-radius:40px;background:radial-gradient(ellipse 80% 50% at 50% 0%,var(--primary-glow),transparent 70%);opacity:0.5;pointer-events:none;z-index:-1;filter:blur(20px);transition:opacity 0.4s ease}
.panel[hidden]::after{opacity:0}
.panel.collapsing{opacity:0;transform:translateY(12px) scale(0.98);pointer-events:none}

.header{display:flex;align-items:center;gap:8px;padding:12px 14px 11px;cursor:grab;user-select:none;border-bottom:1px solid var(--border)}
.header:active{cursor:grabbing}
.header-dot{width:7px;height:7px;border-radius:50%;background:var(--text-3);flex-shrink:0;transition:background .3s,box-shadow .3s}
.header-dot.on{background:var(--success);animation:breathe 3s ease-in-out infinite}
.header-dot.busy{background:var(--warning);animation:dotBlink 1.2s ease-in-out infinite}
.header-dot.error{background:var(--danger);animation:dotBlink 1.2s ease-in-out infinite,shake 0.5s ease-in-out}
.header-label{font-size:13px;font-weight:800;color:var(--text-1);letter-spacing:.02em;flex-shrink:0}
.header-status{flex:1;font-size:12px;color:var(--text-3);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;transition:color .3s;font-variant-numeric:tabular-nums;letter-spacing:0.02em}
.header-status.busy{color:var(--warning)}
.header-status.error{color:var(--danger)}

.body{padding:10px 0 12px;display:flex;height:200px}
.body-left{width:78px;flex-shrink:0;display:flex;flex-direction:column;padding:0 8px;gap:4px;border-right:1px solid var(--border)}
.categories{display:flex;flex-direction:column;gap:4px;flex:1}

.cat-btn{flex:1;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--text-3);font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:all .2s cubic-bezier(0.2,0.8,0.2,1);display:flex;align-items:center;justify-content:center;padding:0 4px;line-height:1.25;text-align:center;position:relative}
.cat-btn:hover{color:var(--text-2);background:var(--bg-card)}
.cat-btn::before{content:"";position:absolute;left:-1px;top:20%;bottom:20%;width:3px;border-radius:2px;background:var(--cat-color);opacity:0;transform:scaleY(0.5);transition:all .25s cubic-bezier(0.34,1.56,0.64,1)}
.cat-btn.active{color:var(--text-1);background:var(--cat-color-alpha)}
.cat-btn.active::before{opacity:1;transform:scaleY(1)}
.cat-btn[data-cat="s2t"]   {--cat-color:#f59e0b;--cat-color-alpha:rgba(245,158,11,.12)}
.cat-btn[data-cat="t2s"]   {--cat-color:#10b981;--cat-color-alpha:rgba(16,185,129,.12)}
.cat-btn[data-cat="tw2hk"] {--cat-color:#8b5cf6;--cat-color-alpha:rgba(139,92,246,.12)}
.cat-btn[data-cat="jp"]    {--cat-color:#ec4899;--cat-color-alpha:rgba(236,72,153,.12)}
.cat-btn[data-cat="cngov"] {--cat-color:#6366f1;--cat-color-alpha:rgba(99,102,241,.12)}

.body-right{flex:1;display:flex;flex-direction:column;padding:0 9px;gap:8px;min-width:0}
.config-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:2px;scrollbar-width:thin;scrollbar-color:var(--border) transparent;mask-image:linear-gradient(to bottom,transparent,black 16px,black calc(100% - 16px),transparent);-webkit-mask-image:linear-gradient(to bottom,transparent,black 16px,black calc(100% - 16px),transparent)}
.config-list::-webkit-scrollbar{width:5px}
.config-list::-webkit-scrollbar-track{background:transparent}
.config-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.12);border-radius:10px}
.config-list::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.25)}
@keyframes listFade{from{opacity:0}to{opacity:1}}
.config-list.switching{animation:listFade .15s ease}
.config-item{position:relative;overflow:visible;display:flex;align-items:flex-start;gap:7px;padding:5px 8px;border-radius:7px;cursor:pointer;transition:background .12s,border-color .12s;border:1px solid transparent;flex-shrink:0}
.config-item:hover{background:var(--bg-card);border-color:var(--border)}
.config-item::before{content:"";position:absolute;left:0;top:10%;bottom:10%;width:3px;border-radius:3px;background:linear-gradient(to bottom,transparent,var(--primary),transparent);opacity:0;transform:scaleY(0);transition:opacity 0.25s ease,transform 0.4s cubic-bezier(0.34,1.8,0.64,1)}
.config-item:hover::before{opacity:0.7;transform:scaleY(1)}
.config-item.selected{background:var(--active-cat-bg,rgba(124,106,247,.1));border-color:var(--active-cat-border,rgba(124,106,247,.25))}

.config-radio{width:13px;height:13px;border-radius:50%;border:1.5px solid var(--text-3);flex-shrink:0;margin-top:2px;display:flex;align-items:center;justify-content:center;transition:border-color .15s}
.config-item.selected .config-radio{border-color:var(--primary);box-shadow:0 0 0 3px rgba(124,106,247,.15)}
.config-radio::after{content:"";width:5px;height:5px;border-radius:50%;background:var(--primary);opacity:0;transform:scale(0);transition:transform .25s cubic-bezier(0.34,1.56,0.64,1),opacity .15s}
.config-item.selected .config-radio::after{opacity:1;transform:scale(1)}
.config-label{flex:1;min-width:0;font-size:13px;color:var(--text-2);line-height:1.45;word-break:break-all;transition:color .12s}
.config-item.selected .config-label{color:var(--text-1)}

.categories:has([data-cat="s2t"].active)~.body-right .config-item.selected,
.body:has([data-cat="s2t"].active) .config-item.selected{--active-cat-bg:rgba(245,158,11,.12);--active-cat-border:rgba(245,158,11,.28)}
.body:has([data-cat="t2s"].active) .config-item.selected{--active-cat-bg:rgba(16,185,129,.12);--active-cat-border:rgba(16,185,129,.28)}
.body:has([data-cat="tw2hk"].active) .config-item.selected{--active-cat-bg:rgba(139,92,246,.12);--active-cat-border:rgba(139,92,246,.28)}
.body:has([data-cat="jp"].active) .config-item.selected{--active-cat-bg:rgba(236,72,153,.12);--active-cat-border:rgba(236,72,153,.28)}
.body:has([data-cat="cngov"].active) .config-item.selected{--active-cat-bg:rgba(99,102,241,.12);--active-cat-border:rgba(99,102,241,.28)}

.btn{width:calc(100% + 2px);margin-left:-1px;height:36px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);color:var(--text-1);cursor:pointer;font-family:inherit;font-size:14px;font-weight:700;letter-spacing:.05em;transition:opacity .18s,transform .1s,background .22s ease,border-color .22s ease;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.btn:hover{opacity:.9}
.btn:active{transform:scale(0.96) translateY(1px);box-shadow:inset 0 2px 6px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.04)}
.btn::after{content:"";position:absolute;top:-50%;left:-60%;width:40%;height:200%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.15),transparent);transform:skewX(-20deg);transition:left .6s ease;pointer-events:none}
.btn:hover::after{left:120%}
.btn-primary{background:linear-gradient(135deg,#6d5af0,#9b6fff);border-color:rgba(150,120,255,.25);color:#fff}
.btn-danger{background:linear-gradient(135deg,#e8415a,#f07);border-color:rgba(240,80,100,.25);color:#fff}

.footer{padding:7px 14px 9px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.footer-version{font-size:11px;color:var(--text-2);letter-spacing:.04em;font-family:ui-monospace,"SF Mono",monospace}
.footer-hint{font-size:10px;color:var(--text-3);opacity:.45;letter-spacing:.03em}
`;

    const DOM_PROPS = new Set(["className", "title", "hidden", "type", "textContent", "htmlFor"]);
    function el(tag, attrs = {}, ...children) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (DOM_PROPS.has(k)) node[k] = v;
        else node.setAttribute(k, v);
      }
      for (const child of children) {
        node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
      }
      return node;
    }

    const fabDot = el("div", { className: "fab-dot" });
    const fab = el("div", { className: "fab", title: "OpenCC-WASM — 拖拽移动" },
                       el("div", { className: "fab-inner" }, "文"), fabDot);

    const headerDot = el("div", { className: "header-dot" });
    const statusEl = el("div", { className: "header-status" });
    const header = el("div", { className: "header" },
                       headerDot, el("span", { className: "header-label" }, "OpenCC"), statusEl);

    const categoriesEl = el("div", { className: "categories" });
    const configList = el("div", { className: "config-list" });
    const toggle = el("button", { className: "btn" });
    const bodyEl = el("div", { className: "body" },
      el("div", { className: "body-left" }, categoriesEl),
      el("div", { className: "body-right" }, configList, toggle),
    );

    const footer = el("div", { className: "footer" },
      el("span", { className: "footer-version" }, `opencc-wasm ${OPENCC_LIB_VERSION}`),
      el("span", { className: "footer-hint" }, "拖拽移动"),
    );

    const panel = el("div", { className: "panel" }, header, bodyEl, footer);
    panel.hidden = true;

    panel.addEventListener("transitionend", (e) => {
      if (e.propertyName === "opacity" && panel.classList.contains("collapsing")) {
        panel.classList.remove("collapsing");
        panel.hidden = true;
        state.ui.fab.hidden = false;
      }
    });

    root.appendChild(style);
    root.appendChild(fab);
    root.appendChild(panel);

    state.ui = {
      host, root, status: statusEl, configList,
      categories: categoriesEl, toggle, fab, panel,
      fabDot, headerDot, header,
      activeCategory: CONFIG_INDEX.get(state.config),
      onDocPointerUp: null,
    };

    for (const group of CONFIG_GROUPS) {
      const btn = document.createElement("button");
      btn.className = "cat-btn";
      btn.dataset.cat = group.id;
      btn.textContent = group.label;
      btn.addEventListener("click", () => {
        state.ui.activeCategory = group.id;
        populateConfigList();
        updateCategoryTabs();
      });
      state.ui.categories.appendChild(btn);
    }

    populateConfigList();
    updateCategoryTabs();

    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try { await setEnabled(!state.enabled); }
      finally { toggle.disabled = false; }
    });

    setupDrag();
    refreshControls();
    setStatus(state.status.text, state.status.busy, state.status.error);
  }

  function bindOutsideClick() {
    if (!state.ui || state.ui.onDocPointerUp) return;
    state.ui.onDocPointerUp = (e) => {
      if (state.collapsed || !state.ui) return;
      const inside = e.composedPath().some(n => n === state.ui.host);
      if (!inside) {
        state.collapsed = true;
        storeSet("collapsed", state.collapsed);
        refreshControls();
      }
    };
    document.addEventListener("pointerup", state.ui.onDocPointerUp, { capture: false });
  }

  function unbindOutsideClick() {
    if (!state.ui?.onDocPointerUp) return;
    document.removeEventListener("pointerup", state.ui.onDocPointerUp, { capture: false });
    state.ui.onDocPointerUp = null;
  }

  function populateConfigList() {
    const group = CONFIG_GROUPS.find(g => g.id === state.ui.activeCategory) ?? CONFIG_GROUPS[0];
    const list = state.ui.configList;
    list.innerHTML = "";
    list.classList.remove("switching");
    void list.offsetWidth; // Force a reflow so removing then re-adding the class restarts the CSS animation.
    list.classList.add("switching");
    for (const [value, label] of group.configs) {
      const item = document.createElement("div");
      item.className = "config-item" + (value === state.config ? " selected" : "");
      item.dataset.value = value;
      const radio = document.createElement("div"); radio.className = "config-radio";
      const labelEl = document.createElement("div"); labelEl.className = "config-label"; labelEl.textContent = label;
      item.appendChild(radio); item.appendChild(labelEl);
      item.addEventListener("click", () => setConfig(value));
      list.appendChild(item);
    }
  }

  function updateConfigListSelection() {
    for (const item of state.ui.configList.querySelectorAll(".config-item")){
      item.classList.toggle("selected", item.dataset.value === state.config);
    }
  }

  function updateCategoryTabs() {
    for (const btn of state.ui.categories.querySelectorAll(".cat-btn")) {
      btn.classList.toggle("active", btn.dataset.cat === state.ui.activeCategory);
    }
  }

  function refreshControls() {
    if (!state.ui) return;
    const catId = CONFIG_INDEX.get(state.config);
    if (state.ui.activeCategory !== catId) { state.ui.activeCategory = catId; populateConfigList(); }
    else updateConfigListSelection();
    updateCategoryTabs();

    if (state.collapsed) {
      unbindOutsideClick();
      if (!state.ui.panel.hidden) {
        state.ui.panel.classList.add("collapsing");
      }
    } else {
      bindOutsideClick();
      state.ui.fab.hidden = true;
      state.ui.panel.hidden = false;
      state.ui.panel.classList.remove("collapsing");
    }

    state.ui.toggle.textContent = state.enabled ? "关" : "开";
    state.ui.toggle.classList.toggle("btn-danger", state.enabled);
    state.ui.toggle.classList.toggle("btn-primary", !state.enabled);
    updateStatusDots();
  }

  function updateStatusDots() {
    if (!state.ui) return;
    const { error, busy } = state.status;
    const stateClass = error ? "error" : busy ? "busy" : state.enabled ? "on" : "";
    state.ui.fabDot.className = "fab-dot " + stateClass;
    state.ui.headerDot.className = "header-dot " + stateClass;
  }

  function setStatus(text, busy = false, error = false) {
    state.status = { text, busy, error };
    if (!state.ui?.status) return;
    state.ui.status.textContent = text;
    state.ui.status.classList.toggle("busy", busy);
    state.ui.status.classList.toggle("error", error);
    updateStatusDots();
  }

  function setupDrag() {
    if (!state.ui) return;
    let startX, startY, startLeft, startTop, moved = false;
    const DRAG_THRESHOLD = 8;
    const savedPos = storeGet("panelPos", null);
    let cachedHostW = state.ui.host.offsetWidth || 52;
    let cachedHostH = state.ui.host.offsetHeight || 52;
    requestAnimationFrame(() => {
      cachedHostW = state.ui.host.offsetWidth || cachedHostW;
      cachedHostH = state.ui.host.offsetHeight || cachedHostH;
      if (savedPos && typeof savedPos.left === "number") {
        applyPosition(savedPos.left, savedPos.top);
      }
    });

    function applyPosition(left, top) {
      const maxL = window.innerWidth - cachedHostW;
      const maxT = window.innerHeight - cachedHostH;
      state.ui.host.style.right = "auto";
      state.ui.host.style.bottom = "auto";
      state.ui.host.style.left = Math.max(0, Math.min(left, maxL)) + "px";
      state.ui.host.style.top = Math.max(0, Math.min(top, maxT)) + "px";
    }


    const resizeHandler = () => requestAnimationFrame(() => {
      if (!state.ui || !state.ui.host.isConnected) {
        window.removeEventListener("resize", resizeHandler);
        return;
      }
      cachedHostW = state.ui.host.offsetWidth;
      cachedHostH = state.ui.host.offsetHeight;
      const rect = state.ui.host.getBoundingClientRect();
      applyPosition(rect.left, rect.top);
    });
    window.addEventListener("resize", resizeHandler);
    state.ui.resizeHandler = resizeHandler;

    function startDrag(clientX, clientY) {
      moved = false;
      startX = clientX; startY = clientY;
      const rect = state.ui.host.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      applyPosition(startLeft, startTop);
    }

    function onMoveLogic(clientX, clientY) {
      const dx = clientX - startX, dy = clientY - startY;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      moved = true;
      applyPosition(startLeft + dx, startTop + dy);
    }

    function onUpLogic() {
      if (moved) {
        const rect = state.ui.host.getBoundingClientRect();
        storeSet("panelPos", { left: rect.left, top: rect.top });
      } else {
        state.collapsed = !state.collapsed;
        storeSet("collapsed", state.collapsed);
        refreshControls();
      }
    }

    function onPointerMove(e) {
      if (!state.ui.host.hasPointerCapture(e.pointerId)) return;
      onMoveLogic(e.clientX, e.clientY);
    }

    function endPointerDrag(e) {
      if (!state.ui.host.hasPointerCapture(e.pointerId)) return;
      state.ui.host.releasePointerCapture(e.pointerId);
      state.ui.host.classList.remove("dragging");
      if (e.type === "pointerup") onUpLogic();
    }

    function startPointerDrag(e) {
      if (e.button !== 0) return;
      startDrag(e.clientX, e.clientY);
      state.ui.host.setPointerCapture(e.pointerId);
      state.ui.host.classList.add("dragging");
      e.preventDefault();
    }

    state.ui.fab.addEventListener("pointerdown", startPointerDrag);
    state.ui.header.addEventListener("pointerdown", startPointerDrag);
    state.ui.host.addEventListener("pointermove", onPointerMove);
    state.ui.host.addEventListener("pointerup", endPointerDrag);
    state.ui.host.addEventListener("pointercancel", endPointerDrag);
  }

})();
