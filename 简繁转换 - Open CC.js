// ==UserScript==
// @name         OpenCC-WASM Webpage Converter
// @namespace    https://tampermonkey.net/
// @version      1.1.1
// @description  Convert webpage Chinese text using opencc-wasm.
// @author       ChatGPT-5.5-xhigh
// @match        https://czbooks.net/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      cdn.jsdelivr.net
// ==/UserScript==

(function () {
  "use strict";

  /**
   * opencc-wasm is ESM, so this userscript uses dynamic import().
   * Default conversion: Simplified Chinese -> Taiwan Traditional + regional terms.
   */
  const OPENCC_ESM_URL = "https://cdn.jsdelivr.net/npm/opencc-wasm@0.8.2/dist/esm/index.js";
  const DEFAULT_CONFIG = "s2twp";
  const DEFAULT_ENABLED = true;

  const CHUNK_SIZE = 80;
  const PROCESS_DEBOUNCE_MS = 80;
  const FULL_SCAN_DEBOUNCE_MS = 60;
  const PANEL_ID = "opencc-wasm-tm-panel-host";
  const STORE_PREFIX = "openccWasmUserscript.";
  const WARMUP_TEXT = "测试測試服务器軟體勇敢的士兵";

  const CONFIGS = [
    ["s2twp", "s2twp — Simplified → Taiwan Traditional + terms"],
    ["s2twp_jieba", "s2twp_jieba — Simplified → Taiwan Traditional + terms, Jieba"],
    ["s2tw", "s2tw — Simplified → Taiwan Traditional"],
    ["s2hk", "s2hk — Simplified → Hong Kong Traditional"],
    ["s2t", "s2t — Simplified → OpenCC Traditional"],

    ["tw2s", "tw2s — Taiwan Traditional → Simplified"],
    ["tw2sp", "tw2sp — Taiwan Traditional → Simplified + terms"],
    ["tw2sp_jieba", "tw2sp_jieba — Taiwan Traditional → Simplified + terms, Jieba"],
    ["hk2s", "hk2s — Hong Kong Traditional → Simplified"],
    ["t2s", "t2s — 繁体 → 简体"],

    ["hk2t", "hk2t — Hong Kong Traditional → OpenCC Traditional"],
    ["t2hk", "t2hk — OpenCC Traditional → Hong Kong Traditional"],
    ["tw2t", "tw2t — Taiwan Traditional → OpenCC Traditional"],
    ["t2tw", "t2tw — OpenCC Traditional → Taiwan Traditional"],

    ["jp2t", "jp2t — Japanese Shinjitai → Kyūjitai"],
    ["t2jp", "t2jp — Kyūjitai → Japanese Shinjitai"],

    ["t2cngov", "t2cngov — Normalize to China Gov standard traditional"],
    ["t2cngov_keep_simp", "t2cngov_keep_simp — Normalize traditional, keep simplified"],
    ["t2cngov_jieba", "t2cngov_jieba — China Gov standard traditional, Jieba"],
    ["t2cngov_keep_simp_jieba", "t2cngov_keep_simp_jieba — Normalize traditional, keep simplified, Jieba"],
  ];

  const CONFIG_VALUES = new Set(CONFIGS.map(([value]) => value));

  const SKIP_SELECTOR = [
    `#${PANEL_ID}`,
    "[data-opencc-ignore]",
    "script",
    "style",
    "noscript",
    "template",
    "textarea",
    "input",
    "select",
    "option",
    "code",
    "pre",
    "kbd",
    "samp",
    "svg",
    "math",
    "canvas",
  ].join(",");

  let HAS_HAN;
  try {
    HAS_HAN = new RegExp("\\p{Script=Han}", "u");
  } catch (_) {
    HAS_HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
  }

  let config = readConfig();
  let enabled = Boolean(storeGet("enabled", DEFAULT_ENABLED));
  let collapsed = Boolean(storeGet("collapsed", false));

  let openCCPromise = null;
  const converters = new Map();
  const converterPromises = new Map();

  const nodeStates = new Map();
  let queue = [];
  let queuedNodes = new WeakSet();

  let processing = false;
  let generation = 0;
  let observing = false;
  let processTimer = 0;
  let fullScanTimer = 0;
  let pruneTimer = 0;

  let latestStatus = enabled ? `Starting · ${config}` : "Off";
  let latestBusy = false;
  let latestError = false;
  let ui = null;
  let statusBusyTimer = 0;

  const observer = new MutationObserver(handleMutations);

  main().catch((err) => {
    console.error("[OpenCC-WASM userscript] Fatal error:", err);
    setStatus("Fatal error", false, true);
  });

  async function main() {
    if (document.contentType && !/html/i.test(document.contentType)) return;

    await domReady();
    if (!document.body) return;

    createPanel();
    registerMenus();

    if (enabled) {
      startObserving();
      scheduleFullScan(0);
    } else {
      setStatus("Off");
    }
  }

  function domReady() {
    if (document.readyState === "loading") {
      return new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", resolve, { once: true });
      });
    }
    return Promise.resolve();
  }

  function readConfig() {
    const saved = storeGet("config", DEFAULT_CONFIG);
    return CONFIG_VALUES.has(saved) ? saved : DEFAULT_CONFIG;
  }

  function storeGet(key, fallback) {
    const fullKey = STORE_PREFIX + key;

    try {
      if (typeof GM_getValue === "function") {
        return GM_getValue(fullKey, fallback);
      }
    } catch (_) {}

    try {
      const raw = localStorage.getItem(fullKey);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function storeSet(key, value) {
    const fullKey = STORE_PREFIX + key;

    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(fullKey, value);
        return;
      }
    } catch (_) {}

    try {
      localStorage.setItem(fullKey, JSON.stringify(value));
    } catch (_) {}
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== "function") return;

    GM_registerMenuCommand("OpenCC-WASM: Toggle conversion", () => {
      setEnabled(!enabled);
    });

    GM_registerMenuCommand("OpenCC-WASM: Convert page now", () => {
      if (!enabled) setEnabled(true);
      else scheduleFullScan(0);
    });

    GM_registerMenuCommand("OpenCC-WASM: Restore original text / turn off", () => {
      setEnabled(false);
    });
  }

  async function loadOpenCC() {
    if (!openCCPromise) {
      openCCPromise = import(OPENCC_ESM_URL)
        .then((mod) => mod.default || mod)
        .catch((err) => {
          openCCPromise = null;
          throw err;
        });
    }

    return openCCPromise;
  }

  async function getConverter(configName) {
    if (converters.has(configName)) {
      return converters.get(configName);
    }

    if (converterPromises.has(configName)) {
      return converterPromises.get(configName);
    }

    const promise = (async () => {
      const OpenCC = await loadOpenCC();
      const converter = OpenCC.Converter({ config: configName });

      // Warm up and trigger resource download once.
      await converter(WARMUP_TEXT);

      converters.set(configName, converter);
      converterPromises.delete(configName);
      return converter;
    })().catch((err) => {
      converterPromises.delete(configName);
      throw err;
    });

    converterPromises.set(configName, promise);
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

  function rememberOriginal(node, resetOriginal = false) {
    let state = nodeStates.get(node);

    if (!state || resetOriginal) {
      state = {
        original: node.nodeValue,
        version: state ? state.version + 1 : 1,
        convertedConfig: null,
        convertedText: null,
      };
      nodeStates.set(node, state);
    }

    return state;
  }

  function enqueueTextNode(node, resetOriginal = false) {
    if (!shouldProcessTextNode(node)) return false;

    rememberOriginal(node, resetOriginal);

    if (!queuedNodes.has(node)) {
      queuedNodes.add(node);
      queue.push(node);
      return true;
    }

    return false;
  }

  function collectTextNodes(root, resetOriginal = false) {
    if (!root) return 0;

    if (root.nodeType === Node.TEXT_NODE) {
      return enqueueTextNode(root, resetOriginal) ? 1 : 0;
    }

    if (
      root.nodeType !== Node.ELEMENT_NODE &&
      root.nodeType !== Node.DOCUMENT_NODE &&
      root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
    ) {
      return 0;
    }

    if (root.nodeType === Node.ELEMENT_NODE && shouldSkipElement(root)) {
      return 0;
    }

    let count = 0;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return shouldProcessTextNode(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });

    let node;
    while ((node = walker.nextNode())) {
      if (enqueueTextNode(node, resetOriginal)) count++;
    }

    return count;
  }

  function clearQueue() {
    queue = [];
    queuedNodes = new WeakSet();
  }

  function scheduleFullScan(delay = FULL_SCAN_DEBOUNCE_MS) {
    if (!enabled) return;

    if (fullScanTimer) clearTimeout(fullScanTimer);

    fullScanTimer = setTimeout(() => {
      fullScanTimer = 0;
      if (!enabled || !document.body) return;

      clearQueue();

      const count = collectTextNodes(document.body, false);

      if (count > 0) {
        setStatus(`Queued ${count} text nodes`, true);
        scheduleProcess(0);
      } else {
        setStatus(`On · ${config}`);
      }
    }, delay);
  }

  function scheduleProcess(delay = PROCESS_DEBOUNCE_MS) {
    if (!enabled) return;

    if (processTimer) clearTimeout(processTimer);

    processTimer = setTimeout(() => {
      processTimer = 0;
      void processQueue();
    }, delay);
  }

  async function processQueue() {
    if (processing || !enabled) return;

    if (processTimer) {
      clearTimeout(processTimer);
      processTimer = 0;
    }

    if (!queue.length) {
      setStatus(`On · ${config}`);
      return;
    }

    processing = true;

    const myGeneration = generation;
    const myConfig = config;

    try {
      setStatus(`Loading ${myConfig}…`, true);

      const converter = await getConverter(myConfig);

      if (!enabled || generation !== myGeneration || config !== myConfig) return;

      while (
        enabled &&
        generation === myGeneration &&
        config === myConfig &&
        queue.length
      ) {
        const chunk = [];

        while (queue.length && chunk.length < CHUNK_SIZE) {
          const node = queue.shift();
          queuedNodes.delete(node);

          if (!node || !node.isConnected) continue;

          if (!shouldProcessTextNode(node)) continue;

          let state = nodeStates.get(node);
          if (!state) state = rememberOriginal(node, false);

          if (!state.original || !HAS_HAN.test(state.original)) continue;

          if (
            state.convertedConfig === myConfig &&
            node.nodeValue === state.convertedText
          ) {
            continue;
          }

          chunk.push({
            node,
            state,
            version: state.version,
            original: state.original,
          });
        }

        if (!chunk.length) {
          await yieldToBrowser();
          continue;
        }

        setStatus(`Converting… ${queue.length} left`, true);

        let results;
        try {
          results = await Promise.all(
            chunk.map((item) => converter(item.original))
          );
        } catch (err) {
          console.error("[OpenCC-WASM userscript] Conversion failed:", err);
          setStatus("Conversion failed", false, true);
          return;
        }

        if (!enabled || generation !== myGeneration || config !== myConfig) {
          break;
        }

        stopObserving(true);

        try {
          for (let i = 0; i < chunk.length; i++) {
            if (!enabled || generation !== myGeneration || config !== myConfig) {
              break;
            }

            const item = chunk[i];
            const currentState = nodeStates.get(item.node);

            if (currentState !== item.state) continue;
            if (item.state.version !== item.version) continue;
            if (!item.node.isConnected) continue;
            if (!shouldProcessTextNode(item.node)) continue;

            const convertedText =
              typeof results[i] === "string" ? results[i] : String(results[i]);

            if (item.node.nodeValue !== convertedText) {
              item.node.nodeValue = convertedText;
            }

            item.state.convertedConfig = myConfig;
            item.state.convertedText = convertedText;
          }
        } finally {
          if (enabled) startObserving();
        }

        await yieldToBrowser();
      }

      if (enabled && generation === myGeneration && config === myConfig) {
        setStatus(`On · ${myConfig}`);
      }
    } catch (err) {
      console.error("[OpenCC-WASM userscript] OpenCC load/process error:", err);
      setStatus("OpenCC error", false, true);
    } finally {
      processing = false;

      if (enabled && queue.length) {
        scheduleProcess(0);
      }
    }
  }

  function handleMutations(mutations) {
    if (!enabled) return;

    let enqueued = 0;
    let sawRemovedNodes = false;

    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const node = mutation.target;

        if (shouldProcessTextNode(node)) {
          if (enqueueTextNode(node, true)) enqueued++;
        } else {
          nodeStates.delete(node);
        }
      } else if (mutation.type === "childList") {
        for (const added of mutation.addedNodes) {
          enqueued += collectTextNodes(added, false);
        }

        if (mutation.removedNodes && mutation.removedNodes.length) {
          sawRemovedNodes = true;
        }
      }
    }

    if (enqueued > 0) scheduleProcess(PROCESS_DEBOUNCE_MS);
    if (sawRemovedNodes) schedulePrune();
  }

  function startObserving() {
    if (observing || !enabled || !document.body) return;

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    observing = true;
  }

  function stopObserving(processPending = false) {
    if (!observing) return;

    if (processPending) {
      const pending = observer.takeRecords();
      if (pending.length) handleMutations(pending);
    }

    observer.disconnect();
    observing = false;
  }

  function schedulePrune() {
    if (pruneTimer) return;

    pruneTimer = setTimeout(() => {
      pruneTimer = 0;

      for (const [node] of nodeStates) {
        if (!node.isConnected) {
          nodeStates.delete(node);
        }
      }
    }, 2000);
  }

  function clearScheduledTimers() {
    if (processTimer) {
      clearTimeout(processTimer);
      processTimer = 0;
    }

    if (fullScanTimer) {
      clearTimeout(fullScanTimer);
      fullScanTimer = 0;
    }
    
    if (pruneTimer) {
      clearTimeout(pruneTimer);
      pruneTimer = 0;
    }
  }

  function restoreOriginals() {
    clearScheduledTimers();
    stopObserving(false);

    for (const [node, state] of nodeStates) {
      try {
        if (
          node &&
          node.nodeType === Node.TEXT_NODE &&
          typeof state.original === "string" &&
          node.nodeValue !== state.original
        ) {
          node.nodeValue = state.original;
        }
      } catch (_) {}
    }

    nodeStates.clear();
    clearQueue();
  }

  function setEnabled(nextEnabled) {
    nextEnabled = Boolean(nextEnabled);

    if (nextEnabled === enabled) {
      if (enabled) {
        clearScheduledTimers();
        scheduleFullScan(0);
      } 

      refreshControls();
      return;
    }

    generation++;
    clearScheduledTimers();

    if (!nextEnabled) {
      // Process pending external page mutations before restoring originals.
      stopObserving(true);

      enabled = false;
      storeSet("enabled", enabled);

      restoreOriginals();
      setStatus("Off");
    } else {
      enabled = true;
      storeSet("enabled", enabled);

      setStatus(`Starting · ${config}`, true);
      startObserving();
      scheduleFullScan(0);
    }

    refreshControls();
  }

  function setConfig(nextConfig) {
    if (!CONFIG_VALUES.has(nextConfig)) return;

    if (nextConfig === config) {
      refreshControls();
      return;
    }

    config = nextConfig;
    storeSet("config", config);

    generation++;
    clearQueue();

    refreshControls();

    if (enabled) {
      setStatus(`Switching to ${config}…`, true);
      scheduleFullScan(0);
    } else {
      setStatus("Off");
    }
  }

  function yieldToBrowser() {
    return new Promise((resolve) => {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(() => resolve(), { timeout: 100 });
      } else {
        setTimeout(resolve, 0);
      }
    });
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
        :host {
          all: initial;
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: #111827;
        }

        * {
          box-sizing: border-box;
        }

        .card {
          width: 340px;
          background: rgba(255, 255, 255, 0.97);
          border: 1px solid rgba(17, 24, 39, 0.14);
          border-radius: 12px;
          box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22);
          overflow: hidden;
          backdrop-filter: blur(8px);
        }

        .top {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          background: #111827;
          color: #fff;
        }

        .brand {
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.01em;
        }

        .status {
          margin-left: auto;
          max-width: 170px;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
          font-size: 11px;
          color: #d1d5db;
        }

        .status.error {
          color: #fecaca;
        }

        .status.busy::before {
          content: "";
          display: inline-block;
          width: 7px;
          height: 7px;
          margin-right: 5px;
          border: 1px solid #9ca3af;
          border-top-color: transparent;
          border-radius: 999px;
          animation: spin 0.9s linear infinite;
          vertical-align: -1px;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .icon {
          width: 24px;
          height: 22px;
          border: 0;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.12);
          color: #fff;
          cursor: pointer;
          font: inherit;
          line-height: 1;
        }

        .icon:hover {
          background: rgba(255, 255, 255, 0.22);
        }

        .body {
          padding: 10px;
        }

        .body[hidden] {
          display: none !important;
        }

        label {
          display: block;
          margin-bottom: 5px;
          font-size: 12px;
          font-weight: 600;
          color: #374151;
        }

        select {
          width: 100%;
          min-height: 32px;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          padding: 5px 8px;
          background: #fff;
          color: #111827;
          font: 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        .row {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 6px;
          margin-top: 9px;
        }

        button {
          min-height: 30px;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          background: #f9fafb;
          color: #111827;
          cursor: pointer;
          font: 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        button:hover {
          background: #f3f4f6;
        }

        button.primary {
          border-color: #2563eb;
          background: #2563eb;
          color: #fff;
        }

        button.primary:hover {
          background: #1d4ed8;
        }

        button.danger {
          border-color: #dc2626;
          background: #dc2626;
          color: #fff;
        }

        button.danger:hover {
          background: #b91c1c;
        }

        .hint {
          margin-top: 8px;
          font-size: 11px;
          color: #6b7280;
        }
      </style>

      <div class="card">
        <div class="top">
          <div class="brand">OpenCC-WASM</div>
          <div id="status" class="status"></div>
          <button id="collapse" class="icon" title="Collapse">−</button>
        </div>

        <div id="body" class="body">
          <label for="config">转换配置</label>
          <select id="config"></select>

          <div class="row">
            <button id="toggle"></button>
            <button id="convert">立即转换</button>
            <button id="restore">重置/关</button>
          </div>

          <div class="hint">
            使用来自 jsDelivr 的 opencc-wasm 0.8.2 版本。跳过输入内容、代码块和预格式化文本。
          </div>
        </div>
      </div>
    `;

    const select = root.getElementById("config");

    for (const [value, label] of CONFIGS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }

    ui = {
      host,
      root,
      status: root.getElementById("status"),
      select,
      toggle: root.getElementById("toggle"),
      convert: root.getElementById("convert"),
      restore: root.getElementById("restore"),
      collapse: root.getElementById("collapse"),
      body: root.getElementById("body"),
    };

    ui.select.addEventListener("change", () => {
      setConfig(ui.select.value);
    });

    ui.toggle.addEventListener("click", () => {
      setEnabled(!enabled);
    });

    ui.convert.addEventListener("click", () => {
      if (!enabled) setEnabled(true);
      else scheduleFullScan(0);
    });

    ui.restore.addEventListener("click", () => {
      setEnabled(false);
    });

    ui.collapse.addEventListener("click", () => {
      collapsed = !collapsed;
      storeSet("collapsed", collapsed);
      refreshControls();
    });

    refreshControls();
    setStatus(latestStatus, latestBusy, latestError);
  }

  function refreshControls() {
    if (!ui) return;

    ui.select.value = config;

    ui.toggle.textContent = enabled ? "关" : "开";
    ui.toggle.classList.toggle("danger", enabled);
    ui.toggle.classList.toggle("primary", !enabled);

    ui.body.hidden = collapsed;
    ui.collapse.textContent = collapsed ? "▴" : "−";
    ui.collapse.title = collapsed ? "展开" : "折叠";
  }


  // 替换 setStatus 函数：
  function setStatus(text, busy = false, error = false) {
    latestStatus = text;
    latestBusy = busy;
    latestError = error;

    if (!ui || !ui.status) return;

    // 如果是 busy 状态，延迟渲染以避免缓存命中时的瞬间闪烁
    if (busy) {
      if (!statusBusyTimer) {
        statusBusyTimer = setTimeout(() => {
          statusBusyTimer = 0;
          // 只有当状态仍然是 busy 时才渲染
          if (latestBusy) {
            ui.status.textContent = latestStatus;
            ui.status.classList.add("busy");
            ui.status.classList.remove("error");
          }
        }, 150);
      }
      return;
    }

    // 非 busy 状态：取消待渲染的 busy，立即显示最终状态
    if (statusBusyTimer) {
      clearTimeout(statusBusyTimer);
      statusBusyTimer = 0;
    }

    ui.status.textContent = text;
    ui.status.classList.toggle("busy", false);
    ui.status.classList.toggle("error", error);
  }
})();
