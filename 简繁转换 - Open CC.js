// ==UserScript==
// @name         OpenCC-WASM Webpage Converter
// @namespace    https://tampermonkey.net/
// @version      3.3.0
// @description  Convert webpage Chinese text using opencc-wasm.
// @author       ANY
// @match        https://czbooks.net/*
// @match        https://baijiahao.baidu.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const OPENCC_ESM_URL = "https://cdn.jsdelivr.net/npm/opencc-wasm@0.8.2/dist/esm/index.js";
  const DEFAULT_CONFIG = "s2twp";
  const DEFAULT_ENABLED = true;
  const CHUNK_SIZE = 80;
  const PROCESS_DEBOUNCE_MS = 80;
  const FULL_SCAN_DEBOUNCE_MS = 60;
  const PRUNE_DELAY_MS = 2000;
  const SWEEP_INTERVAL_MS = 8000;
  const PANEL_ID = "opencc-wasm-tm-panel-host";
  const STORE_PREFIX = "openccWasmUserscript.";
  const WARMUP_TEXT = "伺服器发现";
  const STATUS_ON_PREFIX = "On · ";

  const CONFIG_GROUPS = [
    { id: "s2t", label: "简→繁", color: "#f59e0b", configs: [
      ["s2twp",        "s2twp — 简体 → 台湾繁体 + 词汇"],
      ["s2twp_jieba",  "s2twp_jieba — 简体 → 台湾繁体 + 词汇 (结巴)"],
      ["s2tw",         "s2tw — 简体 → 台湾繁体"],
      ["s2hk",         "s2hk — 简体 → 香港繁体"],
      ["s2t",          "s2t — 简体 → 繁体"],
    ]},
    { id: "t2s", label: "繁→简", color: "#10b981", configs: [
      ["tw2s",         "tw2s — 台湾繁体 → 简体"],
      ["tw2sp",        "tw2sp — 台湾繁体 → 简体 + 词汇"],
      ["tw2sp_jieba",  "tw2sp_jieba — 台湾繁体 → 简体 + 词汇 (结巴)"],
      ["hk2s",         "hk2s — 香港繁体 → 简体"],
      ["t2s",          "t2s — 繁体 → 简体"],
    ]},
    { id: "tw2hk", label: "繁→繁", color: "#8b5cf6", configs: [
      ["hk2t",  "hk2t — 香港繁体 → 繁体"],
      ["t2hk",  "t2hk — 繁体 → 香港繁体"],
      ["tw2t",  "tw2t — 台湾繁体 → 繁体"],
      ["t2tw",  "t2tw — 繁体 → 台湾繁体"],
    ]},
    { id: "jp", label: "日文", color: "#ec4899", configs: [
      ["jp2t", "jp2t — 新字体 → 旧字体"],
      ["t2jp", "t2jp — 旧字体 → 新字体"],
    ]},
    { id: "cngov", label: "国标", color: "#6366f1", configs: [
      ["t2cngov",                "t2cngov — 国标繁体"],
      ["t2cngov_keep_simp",      "t2cngov_keep_simp — 国标繁体 (保留简体)"],
      ["t2cngov_jieba",          "t2cngov_jieba — 国标繁体 (结巴)"],
      ["t2cngov_keep_simp_jieba","t2cngov_keep_simp_jieba — 国标繁体 (保留简体, 结巴)"],
    ]},
  ];

  const CONFIGS = CONFIG_GROUPS.flatMap(g => g.configs);
  const CONFIG_VALUES = new Set(CONFIGS.map(([v]) => v));

  const CONFIG_INDEX = new Map(
    CONFIG_GROUPS.flatMap(g => g.configs.map(([v]) => [v, g.id]))
  );

  const SKIP_SELECTOR = [
    `#${PANEL_ID}`, "[data-opencc-ignore]", "script", "style", "noscript", "template",
    "textarea", "input", "select", "option", "code", "pre", "kbd", "samp", "svg", "math", "canvas",
  ].join(",");

  const HAS_HAN = (() => {
    try { return new RegExp("\\p{Script=Han}", "u"); }
    catch (_) { return /[\u3400-\u9fff\uf900-\ufaff]/; }
  })();

  let config = readConfig();
  let enabled = Boolean(storeGet("enabled", DEFAULT_ENABLED));
  let collapsed = Boolean(storeGet("collapsed", false));

  const converterPromises = new Map();

  const nodeEntries = new Map();

  setInterval(() => {
    for (const [key, entry] of nodeEntries) {
      const node = entry.ref.deref();
      if (!node || !node.isConnected) nodeEntries.delete(key);
    }
  }, SWEEP_INTERVAL_MS);

  let queue = [];
  let queuedNodes = new WeakSet();
  let processing = false;
  let writingBack = false;
  let generation = 0;
  let observing = false;
  let processTimer = 0;
  let fullScanTimer = 0;
  let pruneTimer = 0;
  let latestStatus = enabled ? STATUS_ON_PREFIX + config : "Off";
  let latestBusy = false;
  let latestError = false;
  let ui = null;
  let collapsing = false;
  let converterErrorCount = 0;
  const MAX_CONVERTER_ERRORS = 5;

  const observer = new MutationObserver(handleMutations);

  main().catch(err => {
    console.error("[OpenCC-WASM userscript] Fatal error:", err);
    setStatus("Fatal error", false, true);
  });

  async function main() {
    if (document.contentType && !/html/i.test(document.contentType)) return;
    await domReady();
    if (!document.body) return;
    createPanel();
    if (enabled) { startObserving(); scheduleFullScan(0); }
    else setStatus("Off");
  }

  function domReady() {
    if (document.readyState === "loading")
      return new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    return Promise.resolve();
  }

  function readConfig() {
    const saved = storeGet("config", DEFAULT_CONFIG);
    return CONFIG_VALUES.has(saved) ? saved : DEFAULT_CONFIG;
  }

  function storeGet(key, fallback) {
    try { const raw = localStorage.getItem(STORE_PREFIX + key); return raw == null ? fallback : JSON.parse(raw); } catch (_) { return fallback; }
  }

  function storeSet(key, value) {
    try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); } catch (_) {}
  }

  async function getConverter(configName) {
    if (converterPromises.has(configName)) return converterPromises.get(configName);
    const promise = (async () => {
      const mod = await import(OPENCC_ESM_URL);
      const OpenCC = mod.default || mod;
      const converter = OpenCC.Converter({ config: configName });
      await converter(WARMUP_TEXT);
      return converter;
    })();
    converterPromises.set(configName, promise);
    promise.catch(() => converterPromises.delete(configName));
    return promise;
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
    if (!parent || shouldSkipElement(parent)) return false;
    return true;
  }

  let _nodeKeyCounter = 0;
  const _nodeKeys = new WeakMap();
  function nodeKey(node) {
    if (!_nodeKeys.has(node)) _nodeKeys.set(node, ++_nodeKeyCounter);
    return _nodeKeys.get(node);
  }

  function rememberOriginal(node, resetOriginal = false) {
    const key = nodeKey(node);
    let entry = nodeEntries.get(key);
    if (!entry) {
      entry = {
        state: { original: node.nodeValue, version: 1, convertedConfig: null, convertedText: null },
        ref: new WeakRef(node),
      };
      nodeEntries.set(key, entry);
    } else if (resetOriginal) {
      entry.state = {
        original: node.nodeValue,
        version: entry.state.version + 1,
        convertedConfig: null,
        convertedText: null,
      };
    }
    return entry.state;
  }

  function getNodeState(node) {
    return nodeEntries.get(nodeKey(node))?.state;
  }

  function deleteNodeState(node) {
    nodeEntries.delete(nodeKey(node));
  }

  function enqueueTextNode(node, resetOriginal = false) {
    if (!shouldProcessTextNode(node)) return false;
    rememberOriginal(node, resetOriginal);
    if (!queuedNodes.has(node)) { queuedNodes.add(node); queue.push(node); return true; }
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

  function clearQueue() { queue = []; queuedNodes = new WeakSet(); }

  function scheduleFullScan(delay = FULL_SCAN_DEBOUNCE_MS) {
    if (!enabled) return;
    if (fullScanTimer) clearTimeout(fullScanTimer);
    fullScanTimer = setTimeout(() => {
      fullScanTimer = 0;
      if (!enabled || !document.body) return;

      stopObserving(true);

      const prevQueue = queue;
      const prevQueued = queuedNodes;
      queue = [];
      queuedNodes = new WeakSet();
      const count = collectTextNodes(document.body, false);

      if (count > 0) {
        setStatus(`Queued ${count} text nodes`, true);
        scheduleProcess(0);
      } else {
        queue = prevQueue;
        queuedNodes = prevQueued;
        setStatus(STATUS_ON_PREFIX + config);
      }

      if (enabled) startObserving();
    }, delay);
  }

  function scheduleProcess(delay = PROCESS_DEBOUNCE_MS) {
    if (!enabled) return;
    if (processTimer) { clearTimeout(processTimer); processTimer = 0; }
    processTimer = setTimeout(() => { processTimer = 0; void processQueue(); }, delay);
  }

  function yieldToBrowser() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  async function processQueue() {
    if (processing || !enabled) return;
    if (processTimer) { clearTimeout(processTimer); processTimer = 0; }
    if (!queue.length) { setStatus(STATUS_ON_PREFIX + config); return; }
    processing = true;
    const myGeneration = generation;
    const myConfig = config;
    try {
      setStatus(`Loading ${myConfig}…`, true);
      const converter = await getConverter(myConfig);
      if (!enabled || generation !== myGeneration || config !== myConfig) return;

      while (enabled && generation === myGeneration && config === myConfig && queue.length) {
        const chunk = [];
        while (queue.length && chunk.length < CHUNK_SIZE) {
          const node = queue.shift();
          queuedNodes.delete(node);
          if (!node.isConnected || !shouldProcessTextNode(node)) continue;
          const state = getNodeState(node) || rememberOriginal(node, false);
          if (!state.original || !HAS_HAN.test(state.original)) continue;
          if (state.convertedConfig === myConfig && node.nodeValue === state.convertedText) continue;
          chunk.push({ node, state, version: state.version, original: state.original });
        }
        if (!chunk.length) { await yieldToBrowser(); continue; }

        setStatus(`Converting… ${queue.length} left`, true);
        const results = [];
        for (const item of chunk) {
          if (!enabled || generation !== myGeneration || config !== myConfig) break;
          let converted;
          try {
            converted = await converter(item.original);
            converterErrorCount = 0;
          } catch (err) {
            converterErrorCount++;
            console.error("[OpenCC-WASM userscript] Conversion failed:", err);
            if (converterErrorCount >= MAX_CONVERTER_ERRORS) {
              setStatus("Conversion failed", false, true);
              return;
            }
            await new Promise(resolve => setTimeout(resolve, 200 * converterErrorCount));
            continue;
          }
          results.push(converted);
        }

        if (!enabled || generation !== myGeneration || config !== myConfig) break;

        writingBack = true;
        stopObserving(false);
        try {
          for (let i = 0; i < results.length; i++) {
            if (!enabled || generation !== myGeneration || config !== myConfig) break;
            const item = chunk[i];
            const currentState = getNodeState(item.node);
            if (currentState !== item.state || item.state.version !== item.version) continue;
            if (!item.node.isConnected || !shouldProcessTextNode(item.node)) continue;
            const convertedText = String(results[i]);
            if (item.node.nodeValue !== convertedText) item.node.nodeValue = convertedText;
            item.state.convertedConfig = myConfig;
            item.state.convertedText = convertedText;
          }
        } finally {
          writingBack = false;
          if (enabled) startObserving();
        }
        await yieldToBrowser();
      }

      if (enabled && generation === myGeneration && config === myConfig) setStatus(STATUS_ON_PREFIX + myConfig);
    } catch (err) {
      console.error("[OpenCC-WASM userscript] OpenCC load/process error:", err);
      setStatus("OpenCC error", false, true);
    } finally {
      processing = false;
      if (enabled && queue.length) scheduleProcess(0);
    }
  }

  function handleMutations(mutations) {
    if (!enabled || writingBack) return;
    let enqueued = 0;
    let sawRemovedNodes = false;
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const node = mutation.target;
        if (shouldProcessTextNode(node)) {
          if (enqueueTextNode(node, true)) enqueued++;
        } else {
          deleteNodeState(node);
        }
      } else if (mutation.type === "childList") {
        for (const added of mutation.addedNodes) enqueued += collectTextNodes(added, false);
        if (mutation.removedNodes.length) sawRemovedNodes = true;
      }
    }
    if (enqueued > 0) scheduleProcess(PROCESS_DEBOUNCE_MS);
    if (sawRemovedNodes) schedulePrune();
  }

  function startObserving() {
    if (observing || !enabled || !document.body) return;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    observing = true;
  }

  function stopObserving(processPending = false) {
    if (!observing) return;
    observer.disconnect();
    observing = false;
    if (processPending) { const pending = observer.takeRecords(); if (pending.length) handleMutations(pending); }
  }

  function schedulePrune() {
    if (pruneTimer) return;
    pruneTimer = setTimeout(() => {
      pruneTimer = 0;
      for (const [key, entry] of nodeEntries) {
        const node = entry.ref.deref();
        if (!node || !node.isConnected) nodeEntries.delete(key);
      }
    }, PRUNE_DELAY_MS);
  }

  function clearScheduledTimers() {
    if (processTimer)  { clearTimeout(processTimer);  processTimer  = 0; }
    if (fullScanTimer) { clearTimeout(fullScanTimer); fullScanTimer = 0; }
    if (pruneTimer)    { clearTimeout(pruneTimer);    pruneTimer    = 0; }
  }

  function restoreOriginals() {
    clearScheduledTimers();
    stopObserving(false);
    for (const [, entry] of nodeEntries) {
      const node = entry.ref.deref();
      if (node && node.isConnected && node.nodeValue !== entry.state.original) {
        node.nodeValue = entry.state.original;
      }
    }
    nodeEntries.clear();
    clearQueue();
  }

  function setEnabled(nextEnabled) {
    nextEnabled = Boolean(nextEnabled);
    if (nextEnabled === enabled) {
      refreshControls();
      return;
    }
    generation++;
    clearScheduledTimers();
    if (!nextEnabled) {
      stopObserving(false);
      enabled = false;
      storeSet("enabled", enabled);
      restoreOriginals();
      setStatus("Off");
    } else {
      enabled = true;
      storeSet("enabled", enabled);
      setStatus(STATUS_ON_PREFIX + config, true);
      startObserving();
      scheduleFullScan(0);
    }
    refreshControls();
  }

  function setConfig(nextConfig) {
    if (!CONFIG_VALUES.has(nextConfig) || nextConfig === config) { refreshControls(); return; }
    config = nextConfig;
    storeSet("config", config);
    generation++;
    clearQueue();
    refreshControls();
    if (enabled) { setStatus(`Switching to ${config}…`, true); scheduleFullScan(0); }
    else setStatus("Off");
  }

  function findGroupForConfig(val) {
    return CONFIG_INDEX.get(val) ?? CONFIG_GROUPS[0].id;
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.setAttribute("data-opencc-ignore", "true");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `<style>
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
.header{display:flex;align-items:center;gap:8px;padding:11px 14px 10px;cursor:grab;user-select:none;-webkit-user-select:none;border-bottom:1px solid var(--border)}
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
.config-list::-webkit-scrollbar{width:3px}
.config-list::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
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
</style>
<div class="fab" id="fab" title="OpenCC-WASM — 拖拽移动"><div class="fab-inner">文</div><div class="fab-dot" id="fabDot"></div></div>
<div class="panel" id="panel" hidden>
<div class="header" id="header"><div class="header-dot" id="headerDot"></div><span class="header-label">OpenCC</span><div class="header-status" id="status"></div></div>
<div id="body" class="body"><div class="body-left"><div class="categories" id="categories"></div></div><div class="body-right"><div class="config-list" id="configList"></div><button id="toggle" class="btn"></button></div></div>
<div class="footer"><span class="footer-version">opencc-wasm 0.8.2</span><span class="footer-hint">拖拽移动</span></div>
</div>`;

    ui = {
      host, root,
      status:     root.getElementById("status"),
      configList: root.getElementById("configList"),
      categories: root.getElementById("categories"),
      toggle:     root.getElementById("toggle"),
      body:       root.getElementById("body"),
      fab:        root.getElementById("fab"),
      panel:      root.getElementById("panel"),
      fabDot:     root.getElementById("fabDot"),
      headerDot:  root.getElementById("headerDot"),
      header:     root.getElementById("header"),
      activeCategory: findGroupForConfig(config),
    };

    for (const group of CONFIG_GROUPS) {
      const btn = document.createElement("button");
      btn.className = "cat-btn";
      btn.dataset.cat = group.id;
      btn.textContent = group.label;
      btn.style.setProperty("--cat-color", group.color);
      btn.addEventListener("click", () => { ui.activeCategory = group.id; populateConfigList(); updateCategoryTabs(); });
      ui.categories.appendChild(btn);
    }

    populateConfigList();
    updateCategoryTabs();

    ui.toggle.addEventListener("click", () => setEnabled(!enabled));

    if (!createPanel._outsideClickBound) {
      createPanel._outsideClickBound = true;
      const onOutsideClick = (e) => {
        if (collapsed) return;
        if (!ui || !ui.host) return;
        if (!ui.host.contains(e.target) && !ui.host.shadowRoot.contains(e.composedPath()[0])) {
          collapsed = true;
          storeSet("collapsed", collapsed);
          refreshControls();
        }
      };
      document.addEventListener("mousedown", onOutsideClick, { capture: false });
    }

    setupDrag();
    refreshControls();
    setStatus(latestStatus, latestBusy, latestError);
  }

  function populateConfigList() {
    const group = CONFIG_GROUPS.find(g => g.id === ui.activeCategory) || CONFIG_GROUPS[0];
    const list = ui.configList;
    list.innerHTML = "";
    list.classList.remove("switching");
    void list.offsetWidth;
    list.classList.add("switching");
    for (const [value, label] of group.configs) {
      const item = document.createElement("div");
      item.className = "config-item" + (value === config ? " selected" : "");
      item.dataset.value = value;
      const radio = document.createElement("div"); radio.className = "config-radio";
      const labelEl = document.createElement("div"); labelEl.className = "config-label"; labelEl.textContent = label;
      item.appendChild(radio); item.appendChild(labelEl);
      item.addEventListener("click", () => setConfig(value));
      list.appendChild(item);
    }
  }

  function updateConfigListSelection() {
    for (const item of ui.configList.querySelectorAll(".config-item"))
      item.classList.toggle("selected", item.dataset.value === config);
  }

  function updateCategoryTabs() {
    for (const btn of ui.categories.querySelectorAll(".cat-btn")) {
      const isActive = btn.dataset.cat === ui.activeCategory;
      btn.classList.toggle("active", isActive);
      const group = CONFIG_GROUPS.find(g => g.id === btn.dataset.cat);
      btn.style.background = isActive && group ? group.color : "";
    }
  }

  function refreshControls() {
    if (!ui) return;
    const catId = findGroupForConfig(config);
    if (ui.activeCategory !== catId) { ui.activeCategory = catId; populateConfigList(); }
    else updateConfigListSelection();
    updateCategoryTabs();

    if (collapsed) {
      if (!ui.panel.hidden && !collapsing) {
        collapsing = true;
        ui.panel.classList.add("collapsing");
        ui.panel.addEventListener("animationend", function onEnd() {
          ui.panel.removeEventListener("animationend", onEnd);
          ui.panel.classList.remove("collapsing");
          ui.panel.hidden = true;
          ui.fab.hidden = false;
          collapsing = false;
        }, { once: true });
      } else if (!collapsing) {
        ui.panel.hidden = true;
        ui.fab.hidden = false;
      }
    } else {
      ui.fab.hidden = true;
      ui.panel.hidden = false;
      ui.panel.classList.remove("collapsing");
      collapsing = false;
    }

    ui.toggle.textContent = enabled ? "关" : "开";
    ui.toggle.className = "btn " + (enabled ? "btn-danger" : "btn-primary");
    updateStatusDots();
  }

  function updateStatusDots() {
    if (!ui) return;
    const stateClass = latestError ? "error" : latestBusy ? "busy" : enabled ? "on" : "";
    ui.fabDot.className = "fab-dot " + stateClass;
    ui.headerDot.className = "header-dot " + stateClass;
    ui.fab.classList.toggle("busy", latestBusy);
  }

  function setStatus(text, busy = false, error = false) {
    latestStatus = text; latestBusy = busy; latestError = error;
    if (!ui || !ui.status) return;
    ui.status.textContent = text;
    ui.status.classList.toggle("busy", busy);
    ui.status.classList.toggle("error", error);
    updateStatusDots();
  }

  function setupDrag() {
    if (!ui) return;
    let startX, startY, startLeft, startTop, moved = false;
    const DRAG_THRESHOLD = 8;
    const savedPos = storeGet("panelPos", null);
    if (savedPos && typeof savedPos.left === "number") applyPosition(savedPos.left, savedPos.top);

    function applyPosition(left, top) {
      const hostW = 52;
      const hostH = 52;
      const maxL  = window.innerWidth  - hostW;
      const maxT  = window.innerHeight - hostH;
      ui.host.style.right  = "auto";
      ui.host.style.bottom = "auto";
      ui.host.style.left   = Math.max(0, Math.min(left, maxL)) + "px";
      ui.host.style.top    = Math.max(0, Math.min(top,  maxT)) + "px";
    }

    function updatePanelDirection() {
      const rect = ui.host.getBoundingClientRect();
      const vw   = window.innerWidth;
      const vh   = window.innerHeight;

      const panel    = ui.panel;
      const panelW   = panel.offsetWidth  || 280;
      const panelH   = panel.offsetHeight || 275;

      const spaceRight  = vw - rect.right;
      const spaceLeft   = rect.left;
      const spaceBelow  = vh - rect.bottom;
      const spaceAbove  = rect.top;

      const anchorRight  = spaceRight >= panelW ? false
                         : spaceLeft  >= panelW ? true
                         : spaceLeft > spaceRight;

      const anchorBottom = spaceAbove >= panelH ? true
                         : spaceBelow >= panelH ? false
                         : true;

      panel.style.right  = "";
      panel.style.left   = "";
      panel.style.bottom = "";
      panel.style.top    = "";

      if (anchorRight)  { panel.style.right  = "0"; } else { panel.style.left   = "0"; }
      if (anchorBottom) { panel.style.bottom = "0"; } else { panel.style.top    = "0"; }

      const horiz = anchorRight  ? "right"  : "left";
      const vert  = anchorBottom ? "bottom" : "top";
      panel.style.transformOrigin = vert + " " + horiz;
    }

    function syncDirection() { if (!collapsed) updatePanelDirection(); }

    window.addEventListener("resize", () => {
      const rect = ui.host.getBoundingClientRect();
      applyPosition(rect.left, rect.top);
      syncDirection();
    });

    function startDrag(clientX, clientY) {
      moved = false;
      startX = clientX; startY = clientY;
      const rect = ui.host.getBoundingClientRect();
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
        const rect = ui.host.getBoundingClientRect();
        storeSet("panelPos", { left: rect.left, top: rect.top });
        syncDirection();
      } else {
        collapsed = !collapsed;
        storeSet("collapsed", collapsed);
        refreshControls();
        if (!collapsed) requestAnimationFrame(updatePanelDirection);
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

    function onTouchMove(e) {
      if (e.touches.length !== 1) return;
      onMoveLogic(e.touches[0].clientX, e.touches[0].clientY);
      if (moved) e.preventDefault();
    }

    function onTouchEnd() {
      document.removeEventListener("touchmove", onTouchMove, { passive: false });
      document.removeEventListener("touchend", onTouchEnd);
      onUpLogic();
    }

    function startTouchDrag(e) {
      if (e.touches.length !== 1) return;
      startDrag(e.touches[0].clientX, e.touches[0].clientY);
      document.addEventListener("touchmove", onTouchMove, { passive: false });
      document.addEventListener("touchend", onTouchEnd);
    }

    requestAnimationFrame(updatePanelDirection);

    ui.fab.addEventListener("mousedown", startMouseDrag);
    ui.header.addEventListener("mousedown", startMouseDrag);
    ui.fab.addEventListener("touchstart", startTouchDrag, { passive: true });
    ui.header.addEventListener("touchstart", startTouchDrag, { passive: true });
  }

})();
