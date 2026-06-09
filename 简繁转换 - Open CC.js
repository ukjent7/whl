// ==UserScript==
// @name         OpenCC-WASM Webpage Converter
// @namespace    https://tampermonkey.net/
// @version      4.6.1
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

  const OPENCC_ESM_URL = "https://cdn.jsdelivr.net/npm/opencc-wasm@0.8.2/dist/esm/index.js";
  const DEFAULT_CONFIG = "s2twp";
  const DEFAULT_ENABLED = true;
  const CHUNK_SIZE = 300;
  const PROCESS_DEBOUNCE_MS = 80;
  const FULL_SCAN_DEBOUNCE_MS = 60;
  const MIN_FULL_SCAN_DELAY_MS = 16;
  const MAX_CONVERTER_ERRORS = 5;
  const CONVERTER_RETRY_BASE_MS = 200;
  const MAX_MODULE_LOAD_ERRORS = 3;
  const MODULE_LOAD_RETRY_BASE_MS = 2000;
  const PANEL_ID = "opencc-wasm-tm-panel-host";
  const STORE_PREFIX = "openccWasmUserscript.";
  const WARMUP_TEXT = "的";
  const STATUS_ON_PREFIX = "On · ";
  const INITIAL_NODE_VERSION = 1;

  const CONFIG_GROUPS = [
    { id: "s2t", label: "简→繁", color: "#f59e0b", configs: [
      ["s2twp", "s2twp — 简体 → 台湾繁体 + 词汇"],
      ["s2twp_jieba", "s2twp_jieba — 简体 → 台湾繁体 + 词汇 (结巴)"],
      ["s2tw", "s2tw — 简体 → 台湾繁体"],
      ["s2hk", "s2hk — 简体 → 香港繁体"],
      ["s2t", "s2t — 简体 → 繁体"],
    ]},
    { id: "t2s", label: "繁→简", color: "#10b981", configs: [
      ["tw2s", "tw2s — 台湾繁体 → 简体"],
      ["tw2sp", "tw2sp — 台湾繁体 → 简体 + 词汇"],
      ["tw2sp_jieba", "tw2sp_jieba — 台湾繁体 → 简体 + 词汇 (结巴)"],
      ["hk2s", "hk2s — 香港繁体 → 简体"],
      ["t2s", "t2s — 繁体 → 简体"],
    ]},
    { id: "tw2hk", label: "繁→繁", color: "#8b5cf6", configs: [
      ["hk2t", "hk2t — 香港繁体 → 繁体"],
      ["t2hk", "t2hk — 繁体 → 香港繁体"],
      ["tw2t", "tw2t — 台湾繁体 → 繁体"],
      ["t2tw", "t2tw — 繁体 → 台湾繁体"],
    ]},
    { id: "jp", label: "日文", color: "#ec4899", configs: [
      ["jp2t", "jp2t — 新字体 → 旧字体"],
      ["t2jp", "t2jp — 旧字体 → 新字体"],
    ]},
    { id: "cngov", label: "国标", color: "#6366f1", configs: [
      ["t2cngov", "t2cngov — 国标繁体"],
      ["t2cngov_keep_simp", "t2cngov_keep_simp — 国标繁体 (保留简体)"],
      ["t2cngov_jieba", "t2cngov_jieba — 国标繁体 (结巴)"],
      ["t2cngov_keep_simp_jieba","t2cngov_keep_simp_jieba — 国标繁体 (保留简体, 结巴)"],
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
    : () => new Promise(r => setTimeout(r, 0));

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
    collapsing:          false,
    toggling:            false,
    converterErrorCount:    0,
    moduleLoadErrorCount:   0,
    status:              { text: "", busy: false, error: false },
    ui:                  null,
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
        return openccModule;
      }).catch(err => {
        openccModulePromise = null;
        openccModule = null;
        throw err;
      });
    }
    await openccModulePromise;
    if (converterCache.has(configName)) return converterCache.get(configName);
    const buildPromise = (async () => {
      let converter;
      try {
        converter = openccModule.Converter({ config: configName });
        await converter(WARMUP_TEXT);
      } catch (err) {
        converterCache.delete(configName);
        throw new Error(`Failed to build converter for '${configName}': ${err?.message ?? err}`);
      }
      return converter;
    })();
    converterCache.set(configName, buildPromise);
    const converter = await buildPromise;
    converterCache.set(configName, converter);
    return converter;
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
      entry = { original: node.nodeValue, version: INITIAL_NODE_VERSION, convertedConfig: null, convertedText: null };
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
    while ((node = walker.nextNode())) if (enqueueTextNode(node, resetOriginal)) count++;
    return count;
  }

  function clearQueue() { state.queue = []; state.queuedNodes = new WeakSet(); }

  function scheduleFullScan(delay = FULL_SCAN_DEBOUNCE_MS) {
    if (!state.enabled) return;
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
    if (!state.enabled) return;
    if (state.processTimer) { clearTimeout(state.processTimer); state.processTimer = 0; }
    state.processTimer = setTimeout(() => { state.processTimer = 0; void processQueue(); }, delay);
  }

  async function processQueue() {
    if (state.processing || !state.enabled) return;
    if (state.processTimer) { clearTimeout(state.processTimer); state.processTimer = 0; }
    if (!state.queue.length) { setStatus(STATUS_ON_PREFIX + state.config); return; }
    state.processing = true;
    const myGeneration = state.generation;
    const myConfig = state.config;
    try {
      setStatus(`Loading ${myConfig}…`, true);
      let converter;
      try {
        converter = await getConverter(myConfig);
      } catch (err) {
        const msg = err?.message ?? String(err);
        if (msg.includes(`'${myConfig}'`)) {
          setStatus(`Config '${myConfig}' failed – ${msg}`, false, true);
          clearQueue();
          return;
        }
        throw err;
      }
      state.moduleLoadErrorCount = 0;
      state.converterErrorCount = 0;
      if (!state.enabled || state.generation !== myGeneration || state.config !== myConfig) return;

      while (state.enabled && state.generation === myGeneration && state.config === myConfig && state.queue.length) {
        const chunk = [];
        while (state.queue.length && chunk.length < CHUNK_SIZE) {
          const node = state.queue.shift();
          state.queuedNodes.delete(node);
          if (!node.isConnected || !shouldProcessTextNode(node)) continue;
          const ns = nodeStates.get(node) || rememberOriginal(node, false);
          if (!ns.original || !HAS_HAN.test(ns.original)) continue;
          if (ns.convertedConfig === myConfig && node.nodeValue === ns.convertedText) continue;
          chunk.push({ node, state: ns, version: ns.version, original: ns.original });
        }
        if (!chunk.length) { await yieldToMain(); continue; }

        setStatus(`Converting… ${state.queue.length} left`, true);
        const converted = [];
        for (const item of chunk) {
          if (!state.enabled || state.generation !== myGeneration || state.config !== myConfig) break;
          let result;
          try {
            result = await converter(item.original);
            state.converterErrorCount = 0;
          } catch (err) {
            state.converterErrorCount++;
            console.error("[OpenCC-WASM userscript] Conversion failed:", err);
            if (!state.queuedNodes.has(item.node)) {
              state.queuedNodes.add(item.node);
              state.queue.unshift(item.node);
            }
            if (state.converterErrorCount >= MAX_CONVERTER_ERRORS) {
              setStatus("Conversion failed", false, true);
              clearQueue();
              state.converterErrorCount = 0;
              return;
            }
            await new Promise(resolve => setTimeout(resolve, CONVERTER_RETRY_BASE_MS * state.converterErrorCount));
            continue;
          }
          converted.push({ item, result });
        }

        if (!state.enabled || state.generation !== myGeneration || state.config !== myConfig) break;

        try {
          for (const { item, result } of converted) {
            if (!state.enabled || state.generation !== myGeneration || state.config !== myConfig) break;
            const currentState = nodeStates.get(item.node);
            if (currentState !== item.state || item.state.version !== item.version) continue;
            if (!item.node.isConnected || !shouldProcessTextNode(item.node)) continue;
            const convertedText = String(result);
            if (item.node.nodeValue !== convertedText) item.node.nodeValue = convertedText;
            item.state.convertedConfig = myConfig;
            item.state.convertedText = convertedText;
          }
        } finally {
          if (state.enabled) startObserving();
        }
        await yieldToMain();
      }

      if (state.enabled) {
        const pending = observer.takeRecords();
        if (pending.length) handleMutations(pending);
      }

      if (state.enabled && state.generation === myGeneration && state.config === myConfig){
        setStatus(STATUS_ON_PREFIX + myConfig);
      }
    } catch (err) {
      console.error("[OpenCC-WASM userscript] OpenCC load/process error:", err);
      state.moduleLoadErrorCount++;
      if (state.moduleLoadErrorCount >= MAX_MODULE_LOAD_ERRORS) {
        setStatus("Load failed – reload page to retry", false, true);
        clearQueue();
        return;
      }
      const backoff = MODULE_LOAD_RETRY_BASE_MS * state.moduleLoadErrorCount;
      setStatus(`Load error – retrying in ${backoff / 1000}s…`, false, true);
      await new Promise(r => setTimeout(r, backoff));
    } finally {
      state.processing = false;
      if (state.enabled && state.queue.length) scheduleProcess(0);
      else if (!state.enabled) clearQueue();
    }
  }

  function handleMutations(mutations) {
    if (!state.enabled) return;
    let enqueued = 0;
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const node = mutation.target;
        if (shouldProcessTextNode(node)) {
          const ns = nodeStates.get(node);
          if (ns) {
            if (node.nodeValue === ns.convertedText) continue;
            if (node.nodeValue === ns.original) continue;
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
        if (mutation.removedNodes.length && state.queue.length) {
          state.queue = state.queue.filter(n => {
            if (n.isConnected) return true;
            state.queuedNodes.delete(n);
            return false;
          });
        }
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
    let node;
    let iterCount = 0;
    while ((node = walker.nextNode())) {
      const ns = nodeStates.get(node);
      if (ns && node.isConnected && node.nodeValue !== ns.original) {
        node.nodeValue = ns.original;
      }
      if (++iterCount % CHUNK_SIZE === 0) await yieldToMain();
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
        state.enabled = false;
        storeSet("enabled", false);
        const deadline = Date.now() + 3000;
        while (state.processing && Date.now() < deadline) await yieldToMain();
        await restoreOriginals();
        setStatus("Off");
      } else {
        state.enabled = true;
        storeSet("enabled", true);
        setStatus(STATUS_ON_PREFIX + state.config, true);
        startObserving();
        scheduleFullScan(0);
      }
    } finally {
      state.toggling = false;
    }
    refreshControls();
  }

  function setConfig(nextConfig) {
    if (!CONFIG_VALUES.has(nextConfig)) return;
    if (state.toggling) return;
    if (nextConfig === state.config) { refreshControls(); return; }
    state.config = nextConfig;
    storeSet("config", state.config);
    state.generation++;
    clearQueue();
    refreshControls();
    if (state.enabled) { setStatus(`Switching to ${state.config}…`, true); scheduleFullScan(0); }
    else setStatus("Off");
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.setAttribute("data-opencc-ignore", "true");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
:host{all:initial;display:block;position:fixed;right:20px;bottom:20px;width:52px;height:52px;overflow:visible;z-index:2147483647;font-family:"Noto Sans SC",system-ui,-apple-system,sans-serif;--primary:#7c6af7;--primary-glow:rgba(124,106,247,.35);--danger:#f25c6e;--success:#34d399;--warning:#fbbf24;--bg:rgba(10,10,18,.88);--bg-card:rgba(255,255,255,.04);--border:rgba(255,255,255,.09);--border-strong:rgba(255,255,255,.15);--text-1:#f0f0f8;--text-2:#9898b8;--text-3:#55556a}
*{box-sizing:border-box;margin:0;padding:0}
@keyframes dotBlink{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes panelIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes panelOut{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(8px)}}
.fab{position:absolute;right:0;bottom:0;width:52px;height:52px;z-index:2;border-radius:16px;border:1px solid var(--border-strong);background:var(--bg);backdrop-filter:blur(24px);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .18s ease,box-shadow .2s ease;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.fab:hover{transform:scale(1.08) translateY(-2px)}
.fab:active{transform:scale(.95)}
.fab[hidden]{display:none!important}
.fab.busy{box-shadow:0 8px 32px rgba(0,0,0,.5),0 0 0 2px var(--warning)}
.fab-inner{font-size:18px;line-height:1;color:var(--text-1);font-weight:700}
.fab-dot{position:absolute;top:7px;right:7px;width:8px;height:8px;border-radius:50%;border:1.5px solid rgba(10,10,18,.9);background:var(--text-3);transition:background .3s ease}
.fab-dot.on{background:var(--success)}
.fab-dot.busy{background:var(--warning);animation:dotBlink 1s ease-in-out infinite}
.fab-dot.error{background:var(--danger)}
.panel{position:absolute;width:280px;z-index:1;border-radius:18px;border:1px solid var(--border);background:var(--bg);backdrop-filter:blur(32px);box-shadow:0 24px 64px rgba(0,0,0,.6);overflow:hidden;animation:panelIn .2s ease}
.panel[hidden]{display:none!important}
.panel.collapsing{animation:panelOut .18s ease forwards;pointer-events:none}
.header{display:flex;align-items:center;gap:8px;padding:11px 14px 10px;cursor:grab;user-select:none;border-bottom:1px solid var(--border)}
.header:active{cursor:grabbing}
.header-dot{width:7px;height:7px;border-radius:50%;background:var(--text-3);flex-shrink:0;transition:background .3s}
.header-dot.on{background:var(--success)}
.header-dot.busy{background:var(--warning);animation:dotBlink 1s ease-in-out infinite}
.header-dot.error{background:var(--danger)}
.header-label{font-size:13px;font-weight:700;color:var(--text-2);letter-spacing:.08em;text-transform:uppercase;flex-shrink:0}
.header-status{flex:1;font-size:12px;color:var(--text-3);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:ui-monospace,"SF Mono",monospace;transition:color .3s}
.header-status.busy{color:var(--warning)}
.header-status.error{color:var(--danger)}
.body{padding:10px 0 12px;display:flex;height:200px}
.body-left{width:78px;flex-shrink:0;display:flex;flex-direction:column;padding:0 8px;gap:4px;border-right:1px solid var(--border)}
.categories{display:flex;flex-direction:column;gap:4px;flex:1}
.cat-btn{flex:1;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text-3);font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:all .15s;display:flex;align-items:center;justify-content:center;padding:0 4px;line-height:1.25;text-align:center}
.cat-btn:hover{border-color:var(--border-strong);color:var(--text-2);background:var(--bg-card)}
.cat-btn.active{color:#fff;border-color:transparent;background:var(--cat-color,var(--primary))}
.body-right{flex:1;display:flex;flex-direction:column;padding:0 9px;gap:8px;min-width:0}
.config-list{flex:1;overflow-y:scroll;display:flex;flex-direction:column;gap:2px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
@keyframes listFade{from{opacity:0}to{opacity:1}}
.config-list.switching{animation:listFade .15s ease}
.config-item{display:flex;align-items:flex-start;gap:7px;padding:5px 8px;border-radius:7px;cursor:pointer;transition:background .12s;border:1px solid transparent}
.config-item:hover{background:var(--bg-card);border-color:var(--border)}
.config-item.selected{background:rgba(124,106,247,.1);border-color:rgba(124,106,247,.25)}
.config-radio{width:13px;height:13px;border-radius:50%;border:1.5px solid var(--text-3);flex-shrink:0;margin-top:2px;display:flex;align-items:center;justify-content:center;transition:border-color .15s}
.config-item.selected .config-radio{border-color:var(--primary)}
.config-radio::after{content:"";width:5px;height:5px;border-radius:50%;background:var(--primary);opacity:0;transition:opacity .15s}
.config-item.selected .config-radio::after{opacity:1}
.config-label{font-size:13px;color:var(--text-2);line-height:1.45;word-break:break-all;transition:color .12s}
.config-item.selected .config-label{color:var(--text-1)}
.btn{width:calc(100% + 2px);margin-left:-1px;height:36px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);color:var(--text-1);cursor:pointer;font-family:inherit;font-size:14px;font-weight:700;letter-spacing:.05em;transition:opacity .18s,transform .1s;display:flex;align-items:center;justify-content:center}
.btn:hover{opacity:.85}
.btn:active{transform:scale(.97)}
.btn-primary{background:linear-gradient(135deg,#6d5af0,#9b6fff);border-color:rgba(150,120,255,.25);color:#fff}
.btn-danger{background:linear-gradient(135deg,#e8415a,#f07);border-color:rgba(240,80,100,.25);color:#fff}
.footer{padding:7px 14px 9px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.footer-version{font-size:11px;color:var(--text-3);letter-spacing:.04em;font-family:ui-monospace,"SF Mono",monospace}
.footer-hint{font-size:10px;color:var(--text-3);opacity:.5}
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
      el("span", { className: "footer-version" }, "opencc-wasm 0.8.2"),
      el("span", { className: "footer-hint" }, "拖拽移动"),
    );

    const panel = el("div", { className: "panel" }, header, bodyEl, footer);
    panel.hidden = true;

    root.appendChild(style);
    root.appendChild(fab);
    root.appendChild(panel);

    state.ui = {
      host, root, status: statusEl, configList,
      categories: categoriesEl, toggle, fab, panel,
      fabDot, headerDot, header,
      activeCategory: CONFIG_INDEX.get(state.config),
    };

    for (const group of CONFIG_GROUPS) {
      const btn = document.createElement("button");
      btn.className = "cat-btn";
      btn.dataset.cat = group.id;
      btn.textContent = group.label;
      btn.style.setProperty("--cat-color", group.color);
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

    const panelCleanupMO = new MutationObserver(() => {
      if (!host.isConnected && state.ui?.onDocPointerUp) {
        document.removeEventListener("pointerup", state.ui.onDocPointerUp, { capture: false });
        panelCleanupMO.disconnect();
      }
    });
    panelCleanupMO.observe(document.body, { childList: true, subtree: false });

    setupDrag();
    refreshControls();
    setStatus(state.status.text, state.status.busy, state.status.error);
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
      const isActive = btn.dataset.cat === state.ui.activeCategory;
      btn.classList.toggle("active", isActive);
      const group = CONFIG_GROUPS.find(g => g.id === btn.dataset.cat);
      btn.style.background = isActive && group ? group.color : "";
    }
  }

  function refreshControls() {
    if (!state.ui) return;
    const catId = CONFIG_INDEX.get(state.config);
    if (state.ui.activeCategory !== catId) { state.ui.activeCategory = catId; populateConfigList(); }
    else updateConfigListSelection();
    updateCategoryTabs();

    if (state.collapsed) {
      if (!state.ui.panel.hidden && !state.collapsing) {
        state.collapsing = true;
        state.ui.panel.classList.add("collapsing");
        state.ui.panel.addEventListener("animationend", function onEnd() {
          state.ui.panel.removeEventListener("animationend", onEnd);
          if (!state.collapsing) return;
          state.ui.panel.classList.remove("collapsing");
          state.ui.panel.hidden = true;
          state.ui.fab.hidden = false;
          state.collapsing = false;
        }, { once: true });
      } else if (!state.collapsing) {
        state.ui.panel.hidden = true;
        state.ui.fab.hidden = false;
      }
    } else {
      state.ui.fab.hidden = true;
      state.ui.panel.hidden = false;
      state.ui.panel.classList.remove("collapsing");
      state.collapsing = false;
    }

    state.ui.toggle.textContent = state.enabled ? "关" : "开";
    state.ui.toggle.className = "btn " + (state.enabled ? "btn-danger" : "btn-primary");
    updateStatusDots();
  }

  function updateStatusDots() {
    if (!state.ui) return;
    const { error, busy } = state.status;
    const stateClass = error ? "error" : busy ? "busy" : state.enabled ? "on" : "";
    state.ui.fabDot.className = "fab-dot " + stateClass;
    state.ui.headerDot.className = "header-dot " + stateClass;
    state.ui.fab.classList.toggle("busy", busy);
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
      cachedHostW = state.ui.host.offsetWidth;
      cachedHostH = state.ui.host.offsetHeight;
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

    function updatePanelDirection() {
      const rect = state.ui.host.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const panel = state.ui.panel;
      const panelW = panel.offsetWidth || 280;
      const panelH = panel.offsetHeight || 275;

      const spaceRight = vw - rect.right;
      const spaceLeft = rect.left;
      const spaceBelow = vh - rect.bottom;
      const spaceAbove = rect.top;

      const anchorRight = spaceRight >= panelW ? false
                         : spaceLeft >= panelW ? true
                         : spaceLeft > spaceRight;

      const anchorBottom = spaceAbove >= panelH ? true
                         : spaceBelow >= panelH ? false
                         : true;

      panel.style.right = anchorRight ? "0" : "";
      panel.style.left = anchorRight ? "" : "0";
      panel.style.bottom = anchorBottom ? "0" : "";
      panel.style.top = anchorBottom ? "" : "0";
      panel.style.transformOrigin = `${anchorBottom ? "bottom" : "top"} ${anchorRight ? "right" : "left"}`;
    }

    function syncDirection() { if (!state.collapsed) updatePanelDirection(); }

    window.addEventListener("resize", () => requestAnimationFrame(() => {
      cachedHostW = state.ui.host.offsetWidth;
      cachedHostH = state.ui.host.offsetHeight;
      const rect = state.ui.host.getBoundingClientRect();
      applyPosition(rect.left, rect.top);
      syncDirection();
    }));

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
        syncDirection();
      } else {
        state.collapsed = !state.collapsed;
        storeSet("collapsed", state.collapsed);
        refreshControls();
        if (!state.collapsed) requestAnimationFrame(updatePanelDirection);
      }
    }

    function onMouseMove(e) { onMoveLogic(e.clientX, e.clientY); }
    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      onUpLogic();
    }

    function startMouseDrag(e) {
      if (e.button !== 0) return;
      startDrag(e.clientX, e.clientY);
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    }

    requestAnimationFrame(updatePanelDirection);

    state.ui.fab.addEventListener("mousedown", startMouseDrag);
    state.ui.header.addEventListener("mousedown", startMouseDrag);
  }

})();
