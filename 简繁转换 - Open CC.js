// ==UserScript==
// @name         OpenCC-WASM Webpage Converter
// @namespace    https://tampermonkey.net/
// @version      8.0.0
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

  const OPENCC_ESM_URL = "https://cdn.jsdelivr.net/npm/opencc-wasm@0.10.0/dist/esm/index.js";
  const DEFAULT_CONFIG = "t2s";
  const CONVERT_CHUNK_SIZE = 300;
  const PROCESS_DEBOUNCE_MS = 80;
  const FULL_SCAN_DEBOUNCE_MS = 100;
  const MAX_MODULE_LOAD_ERRORS = 3;
  const MODULE_LOAD_RETRY_BASE_MS = 2000;
  const PANEL_ID = "opencc-wasm-tm-panel-host";
  const STORE_PREFIX = "openccWasmUserscript.v1.";
  const STATUS_ON_PREFIX = "On · ";
  const HAS_HAN = /\p{Script=Han}/u;

  const CFG = (id, label, color, configs) => ({ id, label, color, configs });
  const CONFIG_GROUPS = [
    CFG("s2t", "简→繁", "#f59e0b", [["s2t","简 → 繁体"],["s2twp","简 → 台繁 + 词汇"],["s2tw","简 → 台繁"],["s2hkp","简 → 港繁 + 词汇"],["s2hk","简 → 港繁"],["s2t_jieba","简 → 繁体 (结巴)"],["s2twp_jieba","简 → 台繁 + 词汇 (结巴)"],["s2tw_jieba","简 → 台繁 (结巴)"],["s2hkp_jieba","简 → 港繁 + 词汇 (结巴)"],["s2hk_jieba","简 → 港繁 (结巴)"]]),
    CFG("t2s", "繁→简", "#10b981", [["t2s","繁体 → 简"],["tw2sp","台繁 → 简 + 词汇"],["tw2s","台繁 → 简"],["hk2sp","港繁 → 简 + 词汇"],["hk2s","港繁 → 简"],["tw2sp_jieba","台繁 → 简 + 词汇 (结巴)"],["hk2sp_jieba","港繁 → 简 + 词汇 (结巴)"],["t2s_cngov","繁体 → 国标简"]]),
    CFG("tw2hk", "繁→繁", "#8b5cf6", [["t2tw","繁体 → 台繁"],["t2hk","繁体 → 港繁"],["tw2t","台繁 → 繁体"],["hk2t","港繁 → 繁体"]]),
    CFG("jp", "日文", "#ec4899", [["jp2t","新字体 → 旧字体"],["t2jp","旧字体 → 新字体"]]),
    CFG("cngov", "国标", "#6366f1", [["s2t_cngov","简 → 国标繁"],["t2cngov","繁体 → 国标繁"],["t2cngov_keep_simp","国标繁 (保留简体)"],["t2cngov_jieba","国标繁 (结巴)"],["t2cngov_keep_simp_jieba","国标繁 (保留简体, 结巴)"]])
  ];

  const CONFIG_VALUES = new Set(CONFIG_GROUPS.flatMap(g => g.configs.map(c => c[0])));
  const CONFIG_INDEX = new Map(CONFIG_GROUPS.flatMap(g => g.configs.map(c => [c[0], g.id])));
  const SKIP_SELECTOR = `#${PANEL_ID}, [data-opencc-ignore], script, style, noscript, template, textarea, input, select, option, code, pre, kbd, samp, svg, math, canvas`;

  const state = {
    config: DEFAULT_CONFIG, enabled: true, collapsed: false,
    queue: [], queuedNodes: new WeakSet(), processing: false, generation: 0,
    processTimer: 0, fullScanTimer: 0, toggling: false, pendingConfig: null,
    loadDisabled: false, status: { text: "", busy: false, error: false },
    ui: null, brokenConfigs: new Set(), moduleLoadErrorCount: 0,
  };

  const listeners = new Set();
  const subscribe = fn => (listeners.add(fn), () => listeners.delete(fn));
  const notify = () => listeners.forEach(fn => fn(state));

  const nodeStates = new WeakMap();
  let openccModulePromise = null;
  const converterCache = new Map();
  const observer = new MutationObserver(handleMutations);

  const storeGet = (k, f) => { try { return JSON.parse(localStorage.getItem(STORE_PREFIX + k)) ?? f; } catch { return f; } };
  const storeSet = (k, v) => { try { localStorage.setItem(STORE_PREFIX + k, JSON.stringify(v)); } catch {} };

  const yieldToMain = scheduler?.yield instanceof Function 
    ? () => scheduler.yield() 
    : () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => (ch.port1.close(), ch.port2.close(), r()); ch.port2.postMessage(null); });

  main().catch(err => {
    console.error("[OpenCC-WASM] Fatal:", err);
    setStatus("Fatal error", false, true);
  });

  async function main() {
    state.config = storeGet("config", DEFAULT_CONFIG);
    if (!CONFIG_VALUES.has(state.config)) state.config = DEFAULT_CONFIG;
    state.enabled = storeGet("enabled", true);
    state.collapsed = storeGet("collapsed", false);
    state.status.text = state.enabled ? STATUS_ON_PREFIX + state.config : "Off";

    if (document.contentType && !/html/i.test(document.contentType)) return;
    if (!document.body) return;
    
    createPanel();
    if (state.enabled) { startObserving(); scheduleFullScan(0); }
  }

  function shouldProcessTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const text = node.nodeValue;
    return text && HAS_HAN.test(text) && node.parentElement && !node.parentElement.closest(SKIP_SELECTOR) && !node.parentElement.isContentEditable;
  }

  function walkTextNodes(root, filterFn, cb) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) 
          return (n.isContentEditable || n.matches?.(SKIP_SELECTOR)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return filterFn(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let n;
    while (n = walker.nextNode()) if (n.nodeType === Node.TEXT_NODE) cb(n);
  }

  const rememberOriginal = (node, reset = false) => {
    let entry = nodeStates.get(node);
    if (!entry) {
      entry = { original: node.nodeValue, version: 1, convertedConfig: null, convertedText: null };
      nodeStates.set(node, entry);
    } else if (reset) {
      entry.original = node.nodeValue;
      entry.version++;
      entry.convertedConfig = null; entry.convertedText = null;
    }
    return entry;
  };

  const enqueueNode = node => {
    if (state.queuedNodes.has(node)) return false;
    state.queuedNodes.add(node);
    state.queue.push(node);
    return true;
  };

  const enqueueTextNode = (node, reset = false) => {
    if (!shouldProcessTextNode(node)) return false;
    rememberOriginal(node, reset);
    return enqueueNode(node);
  };

  function collectTextNodes(root, reset = false) {
    let count = 0;
    walkTextNodes(root, n => n.nodeValue && HAS_HAN.test(n.nodeValue), n => {
      rememberOriginal(n, reset);
      if (enqueueNode(n)) count++;
    });
    return count;
  }

  function requeueForConfigChange() {
    if (!document.body) return 0;
    let count = 0;
    walkTextNodes(document.body, n => nodeStates.has(n), n => {
      const ns = nodeStates.get(n);
      if (!ns || (ns.convertedConfig === state.config && n.nodeValue === ns.convertedText)) return;
      if ((ns.original && HAS_HAN.test(ns.original)) || (ns.convertedText !== null && shouldProcessTextNode(n))) {
        if (enqueueNode(n)) count++;
      }
    });
    return count;
  }

  const clearQueue = () => { state.queue.length = 0; state.queuedNodes = new WeakSet(); };
  const clearScheduledTimers = () => { clearTimeout(state.processTimer); clearTimeout(state.fullScanTimer); };

  async function getConverter(configName) {
    if (!openccModulePromise) {
      openccModulePromise = import(OPENCC_ESM_URL).then(mod => {
        const m = mod.default || mod;
        if (typeof m?.Converter !== "function") throw new Error("No Converter fn");
        return m;
      }).catch(err => {
        openccModulePromise = null;
        throw Object.assign(new Error(`Load module failed: ${err?.message ?? err}`), { kind: "module_load" });
      });
    }
    const openccModule = await openccModulePromise;
    
    if (!converterCache.has(configName)) {
      const buildPromise = (async () => {
        const converter = openccModule.Converter({ config: configName });
        await converter("的");
        return converter;
      })();
      converterCache.set(configName, buildPromise);
      try {
        return await buildPromise;
      } catch (err) {
        converterCache.delete(configName);
        state.brokenConfigs.add(configName);
        throw Object.assign(new Error(`Build converter failed '${configName}': ${err?.message ?? err}`), { kind: "converter_init", config: configName });
      }
    }
    return converterCache.get(configName);
  }

  function scheduleFullScan(delay = FULL_SCAN_DEBOUNCE_MS) {
    if (!state.enabled || state.loadDisabled) return;
    clearTimeout(state.fullScanTimer);
    state.fullScanTimer = setTimeout(() => {
      state.fullScanTimer = 0;
      if (!state.enabled || !document.body) return;
      clearQueue();
      const count = collectTextNodes(document.body, true);
      if (count > 0) { setStatus(`Queued ${count} nodes`, true); scheduleProcess(0); }
      else setStatus(STATUS_ON_PREFIX + state.config);
    }, Math.max(delay, 16));
  }

  function scheduleProcess(delay = PROCESS_DEBOUNCE_MS) {
    if (!state.enabled || state.loadDisabled) return;
    clearTimeout(state.processTimer);
    state.processTimer = setTimeout(() => {
      state.processTimer = 0;
      if (scheduler?.postTask) scheduler.postTask(processQueue, { priority: "background" });
      else processQueue();
    }, delay);
  }

  async function processQueue() {
    if (state.processing || !state.enabled || state.loadDisabled) return;
    clearTimeout(state.processTimer); state.processTimer = 0;
    if (!state.queue.length) return setStatus(STATUS_ON_PREFIX + state.config);
    
    state.processing = true;
    const gen = { generation: state.generation, config: state.config };
    const isStale = () => !state.enabled || state.generation !== gen.generation || state.config !== gen.config;
    
    try {
      setStatus(`Loading ${gen.config}…`, true);
      const converter = await getConverter(gen.config);
      state.loadDisabled = false; state.moduleLoadErrorCount = 0;
      if (isStale()) return;

      let didWork = true, chunkCounter = 0;
      while (!isStale() && didWork) {
        didWork = false;
        const chunk = [];
        while (state.queue.length && chunk.length < CONVERT_CHUNK_SIZE) {
          const node = state.queue.shift();
          state.queuedNodes.delete(node);
          if (!node.isConnected || !shouldProcessTextNode(node)) continue;
          const ns = nodeStates.get(node) || rememberOriginal(node);
          if (!ns.original || !HAS_HAN.test(ns.original) || (ns.convertedConfig === gen.config && node.nodeValue === ns.convertedText)) continue;
          chunk.push({ node, state: ns, version: ns.version, original: ns.original });
        }
        
        if (!chunk.length) { await yieldToMain(); continue; }
        didWork = true; chunkCounter++;
        if (chunkCounter % 3 === 0 || state.queue.length === 0) setStatus(`Converting… ${state.queue.length} left`, true);
        
        const converted = [];
        for (const item of chunk) {
          if (isStale()) break;
          try {
            const result = await converter(item.original);
            converted.push({ item, result });
          } catch (err) {
            nodeStates.delete(item.node);
          }
        }
        if (isStale()) break;
        
        for (const { item, result } of converted) {
          const ns = nodeStates.get(item.node);
          if (!ns || ns.version !== item.version) {
            if (item.node.isConnected && shouldProcessTextNode(item.node)) enqueueNode(item.node);
            continue;
          }
          if (!item.node.isConnected || !shouldProcessTextNode(item.node)) continue;
          const text = String(result);
          ns.convertedConfig = gen.config;
          ns.convertedText = text;
          if (item.node.nodeValue !== text) item.node.nodeValue = text;
        }
        await yieldToMain();
      }
      if (!isStale()) setStatus(STATUS_ON_PREFIX + gen.config);
    } catch (err) {
      if (err?.kind === "converter_init") {
        setStatus(`Config '${gen.config}' failed`, false, true);
        clearQueue();
      } else if (err?.kind === "module_load") {
        state.moduleLoadErrorCount++;
        if (state.moduleLoadErrorCount >= MAX_MODULE_LOAD_ERRORS) {
          setStatus("Load failed – reload page", false, true);
          state.loadDisabled = true; clearScheduledTimers();
        } else {
          const backoff = MODULE_LOAD_RETRY_BASE_MS * state.moduleLoadErrorCount;
          setStatus(`Load error – retry in ${backoff / 1000}s…`, false, true);
          setTimeout(() => scheduleProcess(backoff), 0);
        }
        clearQueue();
      } else {
        setStatus("Internal error — see console", false, true);
        console.error("[OpenCC-WASM]", err);
      }
    } finally {
      state.processing = false;
      if (state.enabled && state.queue.length && !state.loadDisabled) scheduleProcess(0);
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

  const startObserving = () => {
    if (!state.enabled || !document.body) return;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  const stopObserving = () => observer.disconnect();

  async function restoreOriginals() {
    clearScheduledTimers();
    const myGen = state.generation;
    walkTextNodes(document.body, n => nodeStates.has(n), n => {
      if (state.generation !== myGen) return;
      const ns = nodeStates.get(n);
      if (ns && n.isConnected && n.nodeValue !== ns.original) n.nodeValue = ns.original;
    });
    clearQueue();
  }

  async function setEnabled(nextEnabled) {
    nextEnabled = Boolean(nextEnabled);
    if (nextEnabled === state.enabled) return notify();
    state.generation++; clearScheduledTimers(); state.toggling = true;
    try {
      if (!nextEnabled) {
        state.enabled = false; storeSet("enabled", false);
        await restoreOriginals();
        setStatus("Off");
      } else {
        state.enabled = true; storeSet("enabled", true); state.loadDisabled = false;
        setStatus(STATUS_ON_PREFIX + state.config, true);
        scheduleFullScan(0);
      }
    } finally { state.toggling = false; }
    if (state.pendingConfig) { const p = state.pendingConfig; state.pendingConfig = null; setConfig(p); }
    else notify();
  }

  function setConfig(nextConfig) {
    if (!CONFIG_VALUES.has(nextConfig)) return;
    if (state.toggling) return state.pendingConfig = nextConfig;
    if (nextConfig === state.config) return notify();
    state.config = nextConfig; storeSet("config", nextConfig);
    state.generation++; clearQueue();
    if (state.enabled) {
      if (state.brokenConfigs.has(state.config)) scheduleFullScan(0);
      else {
        const count = requeueForConfigChange();
        if (count > 0) scheduleProcess(0); else setStatus(STATUS_ON_PREFIX + state.config);
      }
    }
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
:host{all:initial;display:block;position:fixed;right:20px;bottom:20px;width:52px;height:52px;z-index:2147483647;font-family:system-ui,sans-serif;--p:#7c6af7;--bg:rgba(12,12,20,.85);--bd:rgba(255,255,255,.1);--t1:#f0f0f8;--t2:#9898b8;--t3:#55556a;anchor-name:--fab;transition:left .3s cubic-bezier(0.2,0.8,0.2,1),top .3s cubic-bezier(0.2,0.8,0.2,1)}
:host(.dragging){user-select:none;transition:none}
*{box-sizing:border-box;margin:0;padding:0}
.fab,.panel{position:absolute;border-radius:16px;background:var(--bg);backdrop-filter:blur(20px);border:1px solid var(--bd);box-shadow:0 8px 32px rgba(0,0,0,.5)}
.fab{right:0;bottom:0;width:52px;height:52px;cursor:grab;display:flex;align-items:center;justify-content:center;transition:transform .2s}
.fab:hover{transform:scale(1.05)}
.fab::before{content:"文";font-size:18px;font-weight:800;background:linear-gradient(135deg,#a78bfa,#67e8f9);background-clip:text;-webkit-background-clip:text;color:transparent}
.fab-dot{position:absolute;top:7px;right:7px;width:8px;height:8px;border-radius:50%;border:1.5px solid rgba(10,10,18,.9);background:var(--t3)}
.fab-dot.on{background:#34d399;animation:breathe 3s infinite}
.fab-dot.busy{background:#fbbf24;animation:blink 1.2s infinite}
.fab-dot.error{background:#f25c6e;animation:blink 1.2s infinite}
@keyframes breathe{0%,100%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}50%{box-shadow:0 0 0 8px rgba(52,211,153,0)}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}
.panel{width:320px;border-radius:18px;position-anchor:--fab;position-area:block-end span-inline-end;margin:4px;opacity:0;transform:translateY(12px) scale(.98);transition:.3s cubic-bezier(0.16,1,0.3,1),overlay .3s allow-discrete,display .3s allow-discrete}
.panel:popover-open{opacity:1;transform:none}
@starting-style{.panel:popover-open{opacity:0;transform:translateY(24px) scale(.92)}}
.header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--bd)}
.header-dot{width:7px;height:7px;border-radius:50%;background:var(--t3);flex-shrink:0}
.header-dot.on{background:#34d399}.header-dot.busy{background:#fbbf24}.header-dot.error{background:#f25c6e}
.header-label{font-size:13px;font-weight:800;color:var(--t1)}
.header-status{flex:1;font-size:12px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header-status.busy{color:#fbbf24}.header-status.error{color:#f25c6e}
.body{display:flex;height:200px;padding:10px 0}
.body-left{width:78px;display:flex;flex-direction:column;padding:0 8px;gap:4px;border-right:1px solid var(--bd)}
.cat-btn{flex:1;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--t3);cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;position:relative}
.cat-btn:hover{background:rgba(255,255,255,.04)}
.cat-btn.active{color:var(--t1);background:color-mix(in srgb,var(--cat-color) 12%,transparent)}
.cat-btn.active::before{content:"";position:absolute;left:-1px;top:20%;bottom:20%;width:3px;border-radius:2px;background:var(--cat-color)}
.body-right{flex:1;display:flex;flex-direction:column;padding:0 9px;gap:8px;min-width:0}
.config-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.config-item{display:flex;align-items:flex-start;gap:7px;padding:5px 8px;border-radius:7px;cursor:pointer;border:1px solid transparent}
.config-item:hover{background:rgba(255,255,255,.04)}
.config-item.selected{background:color-mix(in srgb,var(--p) 12%,transparent);border-color:color-mix(in srgb,var(--p) 28%,transparent)}
.config-radio{width:13px;height:13px;border-radius:50%;border:1.5px solid var(--t3);margin-top:2px;flex-shrink:0;position:relative}
.config-item.selected .config-radio{border-color:var(--p);box-shadow:0 0 0 3px rgba(124,106,247,.15)}
.config-item.selected .config-radio::after{content:"";position:absolute;inset:3px;background:var(--p);border-radius:50%}
.config-label{font-size:13px;color:var(--t2);word-break:break-all}
.config-item.selected .config-label{color:var(--t1)}
.btn{height:36px;border-radius:10px;background:linear-gradient(135deg,#6d5af0,#9b6fff);color:#fff;border:none;cursor:pointer;font-weight:700;font-size:14px;transition:transform .1s}
.btn:active{transform:scale(0.96)}
.btn.off{background:rgba(255,255,255,.04);color:var(--t1);border:1px solid var(--bd)}
.footer{padding:7px 14px;border-top:1px solid var(--bd);display:flex;justify-content:space-between;font-size:11px;color:var(--t3)}
</style>
<div class="fab"><div class="fab-dot"></div></div>
<div class="panel" popover="auto">
  <div class="header"><div class="header-dot"></div><span class="header-label">OpenCC</span><div class="header-status"></div></div>
  <div class="body">
    <div class="body-left"><div class="categories"></div></div>
    <div class="body-right"><div class="config-list"></div><button class="btn off" type="button"></button></div>
  </div>
  <div class="footer"><span>opencc-wasm</span><span>拖拽移动</span></div>
</div>`;

    state.ui = {
      host, root,
      status: root.querySelector(".header-status"),
      configList: root.querySelector(".config-list"),
      categories: root.querySelector(".categories"),
      toggle: root.querySelector(".btn"),
      fab: root.querySelector(".fab"),
      panel: root.querySelector(".panel"),
      fabDot: root.querySelector(".fab-dot"),
      headerDot: root.querySelector(".header-dot"),
      activeCategory: CONFIG_INDEX.get(state.config),
    };

    state.ui.panel.addEventListener("toggle", e => {
      if (e.newState === "closed" && !state.collapsed) {
        state.collapsed = true; storeSet("collapsed", true); notify();
      }
    });

    CONFIG_GROUPS.forEach(group => {
      const btn = document.createElement("button");
      btn.className = "cat-btn";
      btn.dataset.cat = group.id;
      btn.textContent = group.label;
      btn.style.setProperty("--cat-color", group.color);
      btn.onclick = () => { state.ui.activeCategory = group.id; populateConfigList(); updateCategoryTabs(); };
      state.ui.categories.appendChild(btn);
    });

    populateConfigList();
    updateCategoryTabs();

    state.ui.toggle.onclick = async () => {
      state.ui.toggle.disabled = true;
      try { await setEnabled(!state.enabled); } finally { state.ui.toggle.disabled = false; }
    };

    setupDrag();
    subscribe(renderUI);
    renderUI();
  }

  function populateConfigList() {
    const group = CONFIG_GROUPS.find(g => g.id === state.ui.activeCategory) ?? CONFIG_GROUPS[0];
    const list = state.ui.configList;
    list.innerHTML = "";
    state.ui.categories.style.setProperty("--p", group.color);
    group.configs.forEach(([value, label]) => {
      const item = document.createElement("div");
      item.className = "config-item" + (value === state.config ? " selected" : "");
      item.dataset.val = value;
      item.innerHTML = `<div class="config-radio"></div><div class="config-label">${label}</div>`;
      item.onclick = () => setConfig(value);
      list.appendChild(item);
    });
  }

  function updateCategoryTabs() {
    state.ui.categories.querySelectorAll(".cat-btn").forEach(btn => 
      btn.classList.toggle("active", btn.dataset.cat === state.ui.activeCategory)
    );
  }

  function renderUI() {
    if (!state.ui) return;
    const { ui, collapsed, enabled, config, status } = state;
    
    if (collapsed) { if (ui.panel.matches(":popover-open")) ui.panel.hidePopover(); }
    else if (!ui.panel.matches(":popover-open")) ui.panel.showPopover();

    const catId = CONFIG_INDEX.get(config);
    if (ui.activeCategory !== catId) {
      ui.activeCategory = catId;
      populateConfigList();
    } else {
      ui.configList.querySelectorAll(".config-item").forEach(item => 
        item.classList.toggle("selected", item.dataset.val === config)
      );
    }
    updateCategoryTabs();

    ui.toggle.textContent = enabled ? "关" : "开";
    ui.toggle.className = "btn" + (enabled ? "" : " off");

    ui.status.textContent = status.text;
    ui.status.className = "header-status" + (status.busy ? " busy" : "") + (status.error ? " error" : "");
    
    const stateClass = status.error ? "error" : status.busy ? "busy" : enabled ? "on" : "";
    ui.fabDot.className = "fab-dot " + stateClass;
    ui.headerDot.className = "header-dot " + stateClass;
  }

  function setupDrag() {
    let startX, startY, startLeft, startTop, moved = false;
    const DRAG_THRESHOLD = 8;
    
    const applyPosition = (left, top) => {
      const maxL = innerWidth - 52, maxT = innerHeight - 52;
      Object.assign(state.ui.host.style, { right: "auto", bottom: "auto", left: Math.max(0, Math.min(left, maxL)) + "px", top: Math.max(0, Math.min(top, maxT)) + "px" });
    };

    const savedPos = storeGet("panelPos", null);
    requestAnimationFrame(() => { if (savedPos) applyPosition(savedPos.left, savedPos.top); });

    addEventListener("resize", () => requestAnimationFrame(() => {
      if (state.ui.host.isConnected) {
        const rect = state.ui.host.getBoundingClientRect();
        applyPosition(rect.left, rect.top);
      }
    }));

    state.ui.host.addEventListener("pointerdown", e => {
      if (e.button !== 0 || !e.target.closest('.fab, .header')) return;
      moved = false; startX = e.clientX; startY = e.clientY;
      const rect = state.ui.host.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      applyPosition(startLeft, startTop);
      state.ui.host.setPointerCapture(e.pointerId);
      state.ui.host.classList.add("dragging");
      e.preventDefault();
    });

    state.ui.host.addEventListener("pointermove", e => {
      if (!state.ui.host.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      moved = true;
      applyPosition(startLeft + dx, startTop + dy);
    });

    state.ui.host.addEventListener("pointerup", e => {
      if (!state.ui.host.hasPointerCapture(e.pointerId)) return;
      state.ui.host.releasePointerCapture(e.pointerId);
      state.ui.host.classList.remove("dragging");
      if (moved) {
        const rect = state.ui.host.getBoundingClientRect();
        storeSet("panelPos", { left: rect.left, top: rect.top });
      } else {
        state.collapsed = !state.collapsed;
        storeSet("collapsed", state.collapsed);
        notify();
      }
    });
  }
})();
