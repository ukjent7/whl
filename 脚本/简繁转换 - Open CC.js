// ==UserScript==
// @name         OpenCC-WASM Liquid Glass Converter
// @namespace    https://tampermonkey.net/
// @version      9.0.0
// @description  Apple Liquid Glass & Dynamic Island style webpage Chinese converter powered by opencc-wasm.
// @author       ANY
// @match        https://czbooks.net/*
// @match        https://baijiahao.baidu.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const OPENCC_LIB_VERSION = "0.12.0";
  const OPENCC_PKG_BASE = `https://cdn.jsdelivr.net/npm/opencc-wasm@${OPENCC_LIB_VERSION}/dist/`;
  const OPENCC_ESM_URL = `${OPENCC_PKG_BASE}esm/index.js`;
  const OPENCC_CONFIG_BASE = `${OPENCC_PKG_BASE}data/config/`;

  const DEFAULT_CONFIG = "tw2sp";
  const DEFAULT_ENABLED = true;
  const DEFAULT_INCLUDE_TOFU_RISK = true;

  const CONVERT_CHUNK_SIZE = 320;
  const PROCESS_DEBOUNCE_MS = 50;
  const BATCH_SENTINEL = "\uFDD0";
  const BATCH_SEP = `\n${BATCH_SENTINEL}\n`;

  const PANEL_ID = "opencc-liquid-glass-host";
  const STORE_PREFIX = "openccWasmUserscript.v1.";
  const CONVERTIBLE_ATTRS = ["placeholder", "title", "alt", "aria-label"];
  const ATTR_SELECTOR = CONVERTIBLE_ATTRS.map((a) => `[${a}]`).join(",");

  // Structured matrix covering all 29 OpenCC configs without a clumsy <select>
  const ROUTES = [
    // Tab 0: 繁 → 简
    {
      id: "tw2s",
      tab: 0,
      title: "台湾正体 → 简体",
      sub: "台繁字形与惯用词转大陆简体",
      short: "台→简",
      variants: { base: "tw2s", p: "tw2sp", pj: "tw2sp_jieba" },
    },
    {
      id: "hk2s",
      tab: 0,
      title: "香港繁体 → 简体",
      sub: "港繁字形与惯用词转大陆简体",
      short: "港→简",
      variants: { base: "hk2s", p: "hk2sp", pj: "hk2sp_jieba" },
    },
    {
      id: "t2s",
      tab: 0,
      title: "通用繁体 → 简体",
      sub: "OpenCC 标准繁体转简体",
      short: "繁→简",
      variants: { base: "t2s" },
    },
    {
      id: "t2s_cngov",
      tab: 0,
      title: "传统繁 → 国标简",
      sub: "依据《通用规范汉字表》转简",
      short: "国标简",
      variants: { base: "t2s_cngov" },
    },

    // Tab 1: 简 → 繁
    {
      id: "s2tw",
      tab: 1,
      title: "简体 → 台湾正体",
      sub: "转换为台湾标准正体字形与词汇",
      short: "简→台",
      variants: { base: "s2tw", p: "s2twp", j: "s2tw_jieba", pj: "s2twp_jieba" },
    },
    {
      id: "s2hk",
      tab: 1,
      title: "简体 → 香港繁体",
      sub: "转换为香港教育局标准字形与词汇",
      short: "简→港",
      variants: { base: "s2hk", p: "s2hkp", j: "s2hk_jieba", pj: "s2hkp_jieba" },
    },
    {
      id: "s2t",
      tab: 1,
      title: "简体 → 传统繁体",
      sub: "OpenCC 标准简体转繁体",
      short: "简→繁",
      variants: { base: "s2t", j: "s2t_jieba" },
    },
    {
      id: "s2t_cngov",
      tab: 1,
      title: "简体 → 国标繁体",
      sub: "依据《通用规范汉字表》转繁",
      short: "简→国繁",
      variants: { base: "s2t_cngov" },
    },

    // Tab 2: 异体 · 专向
    {
      id: "t2tw",
      tab: 2,
      title: "传统繁 → 台湾正体",
      sub: "仅作繁体字形台湾标准化",
      short: "繁→台",
      variants: { base: "t2tw" },
    },
    {
      id: "t2hk",
      tab: 2,
      title: "传统繁 → 香港繁体",
      sub: "仅作繁体字形香港标准化",
      short: "繁→港",
      variants: { base: "t2hk" },
    },
    {
      id: "tw2t",
      tab: 2,
      title: "台湾正体 → 传统繁",
      sub: "台湾字形还原为 OpenCC 传统繁",
      short: "台→繁",
      variants: { base: "tw2t" },
    },
    {
      id: "hk2t",
      tab: 2,
      title: "香港繁体 → 传统繁",
      sub: "香港字形还原为 OpenCC 传统繁",
      short: "港→繁",
      variants: { base: "hk2t" },
    },
    {
      id: "jp2t",
      tab: 2,
      title: "日文新字体 → 旧字体",
      sub: "日本现代新字体转传统旧字体",
      short: "日新→旧",
      variants: { base: "jp2t" },
    },
    {
      id: "t2jp",
      tab: 2,
      title: "传统旧字体 → 日文新字",
      sub: "传统旧字体转日本常用新字体",
      short: "旧→日新",
      variants: { base: "t2jp" },
    },
    {
      id: "t2cngov",
      tab: 2,
      title: "繁体 → 国标繁体",
      sub: "异体字规范化为国标繁体",
      short: "繁→国繁",
      variants: { base: "t2cngov", j: "t2cngov_jieba" },
    },
    {
      id: "t2cngov_keep",
      tab: 2,
      title: "国标繁体 (保留简体)",
      sub: "仅转换繁体异体，保留原文简体字",
      short: "国繁留简",
      variants: { base: "t2cngov_keep_simp", j: "t2cngov_keep_simp_jieba" },
    },
  ];

  // Reverse lookup: configName -> { route, phrase, jieba }
  const CONFIG_TO_META = new Map();
  for (const route of ROUTES) {
    const v = route.variants;
    if (v.base) CONFIG_TO_META.set(v.base, { route, phrase: false, jieba: false });
    if (v.p) CONFIG_TO_META.set(v.p, { route, phrase: true, jieba: false });
    if (v.j) CONFIG_TO_META.set(v.j, { route, phrase: false, jieba: true });
    if (v.pj) CONFIG_TO_META.set(v.pj, { route, phrase: true, jieba: true });
  }

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

  const HAS_HAN = /\p{Script=Han}/u;

  const yieldToMain = () =>
    globalThis.scheduler?.yield
      ? globalThis.scheduler.yield()
      : new Promise((r) => setTimeout(r, 0));

  const scheduleBackground = (fn) =>
    globalThis.scheduler?.postTask
      ? globalThis.scheduler.postTask(fn, { priority: "background" })
      : setTimeout(fn, 0);

  const state = {
    config: DEFAULT_CONFIG,
    activeTab: 0,
    routeId: "tw2s",
    usePhrase: true,
    useJieba: false,
    includeTofuRisk: DEFAULT_INCLUDE_TOFU_RISK,

    enabled: DEFAULT_ENABLED,
    collapsed: true,
    peeking: false,
    activeDrawer: null, // null | "glossary" | "sandbox"

    customRulesRaw: "",
    customRules: [], // [{ from, to }]
    customRegex: null,
    customMap: new Map(),

    sandboxInput: "",
    sandboxOutput: "",

    queue: [],
    queuedNodes: new WeakSet(),
    processing: false,
    processingPromise: Promise.resolve(),
    generation: 0,

    observing: false,
    processTimer: 0,
    toggling: false,

    stats: { nodes: 0, lastMs: 0 },
    status: { text: "", busy: false, error: false },
    ui: null,
  };

  const listeners = new Set();
  const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
  const notify = () => listeners.forEach((fn) => fn(state));

  // DOM state tracking
  const nodeStates = new WeakMap();
  const attrStates = new WeakMap(); // Element -> Map(attrName -> { original, convertedText, configKey })
  const titleState = { original: null, convertedText: null, configKey: null };

  let openccModulePromise = null;
  const converterCache = new Map();
  const tofuMetaCache = new Map();
  const observer = new MutationObserver(handleMutations);

  main().catch((err) => {
    console.error("[OpenCC-WASM] Fatal:", err);
    setStatus("出错", false, true);
  });

  async function main() {
    if (document.contentType && !/html/i.test(document.contentType)) return;
    if (!document.body) return;

    const savedCfg = storeGet("config", DEFAULT_CONFIG);
    syncRouteStateFromConfig(CONFIG_TO_META.has(savedCfg) ? savedCfg : DEFAULT_CONFIG);

    state.enabled = Boolean(storeGet("enabled", DEFAULT_ENABLED));
    state.collapsed = Boolean(storeGet("collapsed", true));
    state.includeTofuRisk = Boolean(storeGet("includeTofuRisk", DEFAULT_INCLUDE_TOFU_RISK));
    compileCustomRules(storeGet("customRules", ""));

    state.status.text = state.enabled ? getCurrentRoute().short : "已关闭";

    createIslandUI();
    setupGlobalShortcutsAndSelection();
    void ensureTofuRiskMetadata(state.config);

    if (state.enabled) {
      startObserving();
      scanFullDocument();
    }
  }

  function storeGet(key, fallback) {
    try {
      const raw = localStorage.getItem(STORE_PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function storeSet(key, value) {
    try {
      localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
    } catch {}
  }

  function getCurrentRoute() {
    return ROUTES.find((r) => r.id === state.routeId) || ROUTES[0];
  }

  function syncRouteStateFromConfig(configName) {
    const meta = CONFIG_TO_META.get(configName) || CONFIG_TO_META.get(DEFAULT_CONFIG);
    state.config = configName;
    state.routeId = meta.route.id;
    state.activeTab = meta.route.tab;
    state.usePhrase = meta.phrase;
    state.useJieba = meta.jieba;
  }

  function resolveConfigFromRoute(route, wantPhrase, wantJieba) {
    const v = route.variants;
    if (wantPhrase && wantJieba && v.pj) return { config: v.pj, phrase: true, jieba: true };
    if (wantPhrase && v.p) return { config: v.p, phrase: true, jieba: false };
    if (wantJieba && v.j) return { config: v.j, phrase: false, jieba: true };
    if (wantJieba && v.pj) return { config: v.pj, phrase: true, jieba: true };
    if (wantPhrase && v.pj) return { config: v.pj, phrase: true, jieba: true };
    return { config: v.base, phrase: false, jieba: false };
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function compileCustomRules(rawText) {
    state.customRulesRaw = String(rawText ?? "");
    const rules = [];
    const map = new Map();
    const lines = state.customRulesRaw.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) {
        // Protection rule: keep word as-is
        rules.push({ from: line, to: line });
        map.set(line, line);
      } else {
        const from = line.slice(0, eqIdx).trim();
        const to = line.slice(eqIdx + 1).trim();
        if (from) {
          rules.push({ from, to });
          map.set(from, to);
        }
      }
    }

    // Sort longer matches first so phrases take precedence over single chars
    rules.sort((a, b) => b.from.length - a.from.length);
    state.customRules = rules;
    state.customMap = map;
    state.customRegex =
      rules.length > 0
        ? new RegExp(rules.map((r) => escapeRegExp(r.from)).join("|"), "g")
        : null;
  }

  function applyWithCustomRules(text, rawConverterFn) {
    if (!state.customRegex) {
      return rawConverterFn(text);
    }
    const placeholders = [];
    const masked = text.replace(state.customRegex, (match) => {
      const idx = placeholders.length;
      placeholders.push(state.customMap.get(match) ?? match);
      // Use Private Use Area codepoints surrounded by ASCII digits so OpenCC ignores them
      return `\uE000${idx}\uE001`;
    });

    return Promise.resolve(rawConverterFn(masked)).then((converted) => {
      if (placeholders.length === 0) return converted;
      return String(converted).replace(/\uE000(\d+)\uE001/g, (_, i) => placeholders[Number(i)] ?? "");
    });
  }

  function dictNodeHasTofuRisk(node) {
    if (!node || typeof node !== "object") return false;
    if (node.may_output_tofu === true) return true;
    return Array.isArray(node.dicts) && node.dicts.some(dictNodeHasTofuRisk);
  }

  function configJsonHasTofuRisk(cfg) {
    if (!cfg || typeof cfg !== "object") return false;
    return Boolean(
      cfg.normalization?.some((s) => dictNodeHasTofuRisk(s?.dict)) ||
        dictNodeHasTofuRisk(cfg.segmentation?.dict) ||
        cfg.conversion_chain?.some((s) => dictNodeHasTofuRisk(s?.dict))
    );
  }

  function getTofuMeta(configName = state.config) {
    return tofuMetaCache.get(configName) || { status: "idle", supported: false };
  }

  function ensureTofuRiskMetadata(configName = state.config) {
    const existing = tofuMetaCache.get(configName);
    if (existing?.status === "ready") return Promise.resolve(existing.supported);
    if (existing?.status === "loading") return existing.promise;

    const promise = fetch(`${OPENCC_CONFIG_BASE}${configName}.json`)
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
      })
      .then((json) => {
        const supported = configJsonHasTofuRisk(json);
        tofuMetaCache.set(configName, { status: "ready", supported });
        return supported;
      })
      .catch(() => {
        tofuMetaCache.set(configName, { status: "error", supported: false });
        return false;
      })
      .finally(notify);

    tofuMetaCache.set(configName, { status: "loading", supported: false, promise });
    notify();
    return promise;
  }

  async function loadOpenCCModule() {
    if (!openccModulePromise) {
      openccModulePromise = (async () => {
        let lastErr;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const mod = await import(OPENCC_ESM_URL);
            const resolved = mod.default || mod;
            if (typeof resolved?.Converter !== "function") {
              throw new Error("Invalid opencc-wasm export");
            }
            return resolved;
          } catch (err) {
            lastErr = err;
            if (attempt < 3) {
              setStatus(`加载重试 ${attempt}/3…`, true);
              await new Promise((r) => setTimeout(r, 1000 * attempt));
            }
          }
        }
        openccModulePromise = null;
        throw lastErr;
      })();
    }
    return openccModulePromise;
  }

  function getConfigKey(
    configName = state.config,
    includeTofuRisk = state.includeTofuRisk,
    rulesRaw = state.customRulesRaw
  ) {
    return `${configName}::tofu=${Boolean(includeTofuRisk)}::rules=${rulesRaw}`;
  }

  async function getConverter(configName, includeTofuRisk) {
    const opencc = await loadOpenCCModule();
    const cacheKey = `${configName}::tofu=${Boolean(includeTofuRisk)}`;
    let p = converterCache.get(cacheKey);
    if (!p) {
      p = (async () => {
        const converter = opencc.Converter({
          config: configName,
          includeTofuRiskDictionaries: Boolean(includeTofuRisk),
        });
        await converter("的");
        return converter;
      })().catch((err) => {
        converterCache.delete(cacheKey);
        throw err;
      });
      converterCache.set(cacheKey, p);
    }
    return p;
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    return el.isContentEditable || Boolean(el.closest(SKIP_SELECTOR));
  }

  function isConvertibleTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const parent = node.parentElement;
    if (!parent || shouldSkipElement(parent)) return false;
    const ns = nodeStates.get(node);
    const sourceText =
      ns && ns.convertedText !== null && node.nodeValue === ns.convertedText
        ? ns.original
        : node.nodeValue;
    return Boolean(sourceText && HAS_HAN.test(sourceText));
  }

  function syncNodeState(node) {
    let ns = nodeStates.get(node);
    const currentVal = node.nodeValue ?? "";
    if (!ns) {
      ns = { original: currentVal, convertedText: null, configKey: null };
      nodeStates.set(node, ns);
    } else if (!state.peeking) {
      if (ns.convertedText !== null && currentVal !== ns.convertedText) {
        ns.original = currentVal;
        ns.convertedText = null;
        ns.configKey = null;
      } else if (ns.convertedText === null) {
        ns.original = currentVal;
      }
    }
    return ns;
  }

  function walkTextNodes(root, callback) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      if (isConvertibleTextNode(root)) callback(root);
      return;
    }
    if (root.nodeType === Node.ELEMENT_NODE && shouldSkipElement(root)) return;
    if (
      root.nodeType !== Node.DOCUMENT_NODE &&
      root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE &&
      root.nodeType !== Node.ELEMENT_NODE
    ) {
      return;
    }

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            return node.isContentEditable || node.matches(SKIP_SELECTOR)
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === Node.TEXT_NODE) callback(n);
    }
  }

  function enqueueNode(node) {
    if (state.queuedNodes.has(node)) return false;
    const ns = syncNodeState(node);
    if (!ns.original || !HAS_HAN.test(ns.original)) return false;
    const targetKey = getConfigKey();
    if (ns.configKey === targetKey && node.nodeValue === ns.convertedText) return false;
    state.queuedNodes.add(node);
    state.queue.push(node);
    return true;
  }

  function collectFromRoot(root) {
    let count = 0;
    walkTextNodes(root, (node) => {
      if (enqueueNode(node)) count++;
    });
    return count;
  }

  function clearQueue() {
    state.queue.length = 0;
    state.queuedNodes = new WeakSet();
  }

  function scanFullDocument() {
    if (!state.enabled || !document.body) return;
    clearQueue();
    const count = collectFromRoot(document.body);
    scheduleProcess(0);
    if (count === 0 && !HAS_HAN.test(document.title)) {
      setStatus(getCurrentRoute().short);
    }
  }

  function scheduleProcess(delay = PROCESS_DEBOUNCE_MS) {
    if (!state.enabled) return;
    if (state.processTimer) {
      clearTimeout(state.processTimer);
      state.processTimer = 0;
    }
    state.processTimer = setTimeout(() => {
      state.processTimer = 0;
      scheduleBackground(() => {
        state.processingPromise = processQueue();
      });
    }, Math.max(0, delay));
  }

  async function convertTitleAndAttributes(converter, targetKey, gen) {
    if (isStale(gen)) return;

    // 1. Document Title
    const currentTitle = document.title;
    if (currentTitle) {
      if (titleState.convertedText !== null && currentTitle !== titleState.convertedText && !state.peeking) {
        titleState.original = currentTitle;
        titleState.convertedText = null;
        titleState.configKey = null;
      } else if (titleState.original === null) {
        titleState.original = currentTitle;
      }

      if (
        HAS_HAN.test(titleState.original) &&
        !(titleState.configKey === targetKey && currentTitle === titleState.convertedText)
      ) {
        try {
          const converted = String(await applyWithCustomRules(titleState.original, converter));
          if (!isStale(gen)) {
            titleState.convertedText = converted;
            titleState.configKey = targetKey;
            if (!state.peeking && document.title !== converted) {
              document.title = converted;
            }
          }
        } catch {}
      }
    }

    // 2. User-visible attributes (placeholder, title, alt, aria-label)
    if (!document.body || isStale(gen)) return;
    const elements = document.body.querySelectorAll(ATTR_SELECTOR);
    const pendingAttrs = [];

    for (const el of elements) {
      if (el.closest(`#${PANEL_ID}, [data-opencc-ignore]`)) continue;
      let map = attrStates.get(el);
      if (!map) {
        map = new Map();
        attrStates.set(el, map);
      }
      for (const attr of CONVERTIBLE_ATTRS) {
        const val = el.getAttribute(attr);
        if (!val) continue;
        let entry = map.get(attr);
        if (!entry) {
          entry = { original: val, convertedText: null, configKey: null };
          map.set(attr, entry);
        } else if (!state.peeking && entry.convertedText !== null && val !== entry.convertedText) {
          entry.original = val;
          entry.convertedText = null;
          entry.configKey = null;
        }
        if (HAS_HAN.test(entry.original) && entry.configKey !== targetKey) {
          pendingAttrs.push({ el, attr, entry, original: entry.original });
        }
      }
    }

    if (pendingAttrs.length > 0 && !isStale(gen)) {
      const results = await convertBatch(pendingAttrs, converter);
      if (!isStale(gen)) {
        for (let i = 0; i < pendingAttrs.length; i++) {
          const { el, attr, entry } = pendingAttrs[i];
          entry.convertedText = results[i];
          entry.configKey = targetKey;
          if (!state.peeking && el.isConnected) {
            el.setAttribute(attr, results[i]);
          }
        }
      }
    }
    observer.takeRecords();
  }

  const snapshotGen = () => ({
    generation: state.generation,
    config: state.config,
    includeTofuRisk: state.includeTofuRisk,
    configKey: getConfigKey(),
  });

  const isStale = (gen) =>
    !state.enabled ||
    state.generation !== gen.generation ||
    state.config !== gen.config ||
    state.includeTofuRisk !== gen.includeTofuRisk ||
    getConfigKey() !== gen.configKey;

  async function convertBatch(chunk, converter) {
    if (chunk.length === 1) {
      const res = String(await applyWithCustomRules(chunk[0].original, converter));
      return [res];
    }

    const canBatch = !chunk.some((item) => item.original.includes(BATCH_SENTINEL));
    if (canBatch) {
      const joined = chunk.map((item) => item.original).join(BATCH_SEP);
      const convertedJoined = String(await applyWithCustomRules(joined, converter));
      const parts = convertedJoined.split(BATCH_SEP);
      if (parts.length === chunk.length) {
        return parts;
      }
    }

    const out = new Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      out[i] = String(await applyWithCustomRules(chunk[i].original, converter));
    }
    return out;
  }

  async function processQueue() {
    if (state.processing || !state.enabled) return;
    state.processing = true;
    const gen = snapshotGen();
    const t0 = performance.now();
    let convertedCount = 0;

    try {
      setStatus("加载词典…", true);
      const converter = await getConverter(gen.config, gen.includeTofuRisk);
      if (isStale(gen)) return;

      await convertTitleAndAttributes(converter, gen.configKey, gen);
      void updateSandboxPreview();

      while (!isStale(gen) && state.queue.length > 0) {
        const chunk = [];
        while (state.queue.length > 0 && chunk.length < CONVERT_CHUNK_SIZE) {
          const node = state.queue.shift();
          state.queuedNodes.delete(node);
          if (!node.isConnected || !isConvertibleTextNode(node)) continue;

          const ns = syncNodeState(node);
          if (!ns.original || !HAS_HAN.test(ns.original)) continue;
          if (ns.configKey === gen.configKey && node.nodeValue === ns.convertedText) continue;

          chunk.push({ node, ns, original: ns.original });
        }

        if (chunk.length === 0) continue;

        setStatus(`转换中 · 剩 ${state.queue.length}`, true);
        const results = await convertBatch(chunk, converter);
        if (isStale(gen)) break;

        const preRecords = observer.takeRecords();
        if (preRecords.length) handleMutations(preRecords);

        for (let i = 0; i < chunk.length; i++) {
          const { node, ns, original } = chunk[i];
          if (!node.isConnected) continue;
          const currentNow = node.nodeValue ?? "";
          if (!state.peeking && currentNow !== original && currentNow !== ns.convertedText) {
            enqueueNode(node);
            continue;
          }
          const convertedText = results[i];
          ns.convertedText = convertedText;
          ns.configKey = gen.configKey;
          convertedCount++;
          if (!state.peeking && node.nodeValue !== convertedText) {
            node.nodeValue = convertedText;
          }
        }

        observer.takeRecords();
        if (state.queue.length > 0) {
          await yieldToMain();
        }
      }

      if (!isStale(gen)) {
        if (convertedCount > 0) {
          state.stats.nodes = convertedCount;
          state.stats.lastMs = Math.max(1, Math.round(performance.now() - t0));
        }
        setStatus(getCurrentRoute().short);
      }
    } catch (err) {
      console.error("[OpenCC-WASM] Error:", err);
      clearQueue();
      setStatus("加载失败 · 点此重试", false, true);
    } finally {
      state.processing = false;
      if (state.enabled && state.queue.length > 0 && !state.status.error) {
        scheduleProcess(0);
      }
    }
  }

  function handleMutations(mutations) {
    if (!state.enabled || state.peeking) return;
    let enqueued = 0;
    let titleChanged = false;

    for (const m of mutations) {
      if (m.type === "characterData") {
        const node = m.target;
        if (!node.isConnected) continue;
        if (node.parentElement?.tagName === "TITLE") {
          titleChanged = true;
          continue;
        }
        const ns = nodeStates.get(node);
        if (ns && node.nodeValue === ns.convertedText) continue;
        if (isConvertibleTextNode(node) && enqueueNode(node)) enqueued++;
      } else if (m.type === "childList") {
        if (m.target.nodeName === "TITLE" || m.target.nodeName === "HEAD") {
          titleChanged = true;
        }
        for (const added of m.addedNodes) {
          if (added.nodeName === "TITLE") titleChanged = true;
          enqueued += collectFromRoot(added);
        }
      }
    }

    if (enqueued > 0 || titleChanged) {
      scheduleProcess(PROCESS_DEBOUNCE_MS);
    }
  }

  function startObserving() {
    if (state.observing || !state.enabled) return;
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    state.observing = true;
  }

  function stopObserving() {
    if (!state.observing) return;
    observer.takeRecords();
    observer.disconnect();
    state.observing = false;
  }

  // Instantaneous (<2ms) swap between original and converted text for Hold-to-Peek
  function setPeeking(wantPeek) {
    wantPeek = Boolean(wantPeek);
    if (!state.enabled) wantPeek = false;
    if (wantPeek === state.peeking) return;
    state.peeking = wantPeek;

    if (document.body) {
      walkTextNodes(document.body, (node) => {
        const ns = nodeStates.get(node);
        if (!ns || ns.convertedText === null) return;
        const target = wantPeek ? ns.original : ns.convertedText;
        if (node.nodeValue !== target) node.nodeValue = target;
      });

      const elements = document.body.querySelectorAll(ATTR_SELECTOR);
      for (const el of elements) {
        const map = attrStates.get(el);
        if (!map) continue;
        for (const [attr, entry] of map.entries()) {
          if (entry.convertedText === null) continue;
          el.setAttribute(attr, wantPeek ? entry.original : entry.convertedText);
        }
      }
    }

    if (titleState.original !== null && titleState.convertedText !== null) {
      document.title = wantPeek ? titleState.original : titleState.convertedText;
    }

    observer.takeRecords();
    notify();
  }

  async function restoreOriginals() {
    if (state.processTimer) {
      clearTimeout(state.processTimer);
      state.processTimer = 0;
    }
    state.peeking = false;
    stopObserving();

    if (titleState.original !== null) {
      if (document.title === titleState.convertedText) {
        document.title = titleState.original;
      }
      titleState.convertedText = null;
      titleState.configKey = null;
    }

    if (document.body) {
      walkTextNodes(document.body, (node) => {
        const ns = nodeStates.get(node);
        if (!ns) return;
        if (ns.convertedText !== null && node.nodeValue === ns.convertedText) {
          node.nodeValue = ns.original;
        }
        ns.convertedText = null;
        ns.configKey = null;
      });

      const elements = document.body.querySelectorAll(ATTR_SELECTOR);
      for (const el of elements) {
        const map = attrStates.get(el);
        if (!map) continue;
        for (const [attr, entry] of map.entries()) {
          if (entry.convertedText !== null) {
            el.setAttribute(attr, entry.original);
            entry.convertedText = null;
            entry.configKey = null;
          }
        }
      }
    }
    clearQueue();
  }

  async function setEnabled(nextEnabled) {
    nextEnabled = Boolean(nextEnabled);
    if (nextEnabled === state.enabled && !state.status.error) {
      notify();
      return;
    }

    state.generation++;
    state.toggling = true;

    try {
      if (!nextEnabled) {
        stopObserving();
        if (state.processing) {
          await Promise.race([
            state.processingPromise,
            new Promise((r) => setTimeout(r, 1500)),
          ]);
        }
        state.enabled = false;
        storeSet("enabled", false);
        await restoreOriginals();
        setStatus("已关闭");
      } else {
        state.enabled = true;
        storeSet("enabled", true);
        setStatus(getCurrentRoute().short, true);
        startObserving();
        scanFullDocument();
      }
    } finally {
      state.toggling = false;
      notify();
    }
  }

  function applyResolvedConfig(resolved) {
    state.config = resolved.config;
    state.usePhrase = resolved.phrase;
    state.useJieba = resolved.jieba;
    storeSet("config", state.config);

    state.generation++;
    clearQueue();
    void ensureTofuRiskMetadata(state.config);
    void updateSandboxPreview();

    if (state.enabled) {
      setStatus(`切换 ${ getCurrentRoute().short }…`, true);
      scanFullDocument();
    } else {
      setStatus("已关闭");
    }
    notify();
  }

  function selectRoute(routeId) {
    const route = ROUTES.find((r) => r.id === routeId);
    if (!route) return;
    state.routeId = route.id;
    state.activeTab = route.tab;
    const resolved = resolveConfigFromRoute(route, state.usePhrase, state.useJieba);
    applyResolvedConfig(resolved);
  }

  function togglePhraseMode() {
    const route = getCurrentRoute();
    const v = route.variants;
    if (!v.p && !v.pj) return;
    const nextPhrase = !state.usePhrase;
    const resolved = resolveConfigFromRoute(route, nextPhrase, state.useJieba);
    applyResolvedConfig(resolved);
  }

  function toggleJiebaMode() {
    const route = getCurrentRoute();
    const v = route.variants;
    if (!v.j && !v.pj) return;
    const nextJieba = !state.useJieba;
    const resolved = resolveConfigFromRoute(
      route,
      nextJieba && !v.j && v.pj ? true : state.usePhrase,
      nextJieba
    );
    applyResolvedConfig(resolved);
  }

  function toggleTofuRisk() {
    const meta = getTofuMeta(state.config);
    if (meta.status !== "ready") {
      void ensureTofuRiskMetadata(state.config);
      return;
    }
    if (!meta.supported) return;
    state.includeTofuRisk = !state.includeTofuRisk;
    storeSet("includeTofuRisk", state.includeTofuRisk);
    state.generation++;
    clearQueue();
    if (state.enabled) scanFullDocument();
    void updateSandboxPreview();
    notify();
  }

  async function updateSandboxPreview() {
    const raw = state.sandboxInput.trim();
    if (!raw) {
      state.sandboxOutput = "";
      notify();
      return;
    }
    try {
      const converter = await getConverter(state.config, state.includeTofuRisk);
      state.sandboxOutput = String(await applyWithCustomRules(raw, converter));
    } catch {
      state.sandboxOutput = "转换器加载失败";
    }
    notify();
  }

  function setStatus(text, busy = false, error = false) {
    state.status = { text, busy, error };
    notify();
  }

  function setupGlobalShortcutsAndSelection() {
    // Hold Alt+O anywhere on the page to peek original text
    window.addEventListener("keydown", (e) => {
      if (e.altKey && (e.code === "KeyO" || e.key === "o" || e.key === "O") && !e.repeat) {
        if (state.enabled) {
          e.preventDefault();
          setPeeking(true);
        }
      } else if (e.key === "Escape" && !state.collapsed) {
        state.collapsed = true;
        storeSet("collapsed", true);
        notify();
      }
    });

    window.addEventListener("keyup", (e) => {
      if (state.peeking && (e.code === "KeyO" || e.key === "Alt" || !e.altKey)) {
        setPeeking(false);
      }
    });

    window.addEventListener("blur", () => {
      if (state.peeking) setPeeking(false);
    });

    // Capture webpage text selection into the live sandbox
    document.addEventListener("selectionchange", () => {
      if (state.collapsed) return;
      const sel = window.getSelection()?.toString()?.trim();
      if (sel && sel.length <= 300 && HAS_HAN.test(sel) && sel !== state.sandboxInput) {
        state.sandboxInput = sel;
        if (state.ui?.sandboxInput && document.activeElement !== state.ui.sandboxInput) {
          state.ui.sandboxInput.value = sel;
        }
        void updateSandboxPreview();
      }
    });
  }

  function createIslandUI() {
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
  right: 22px;
  bottom: 22px;
  width: 120px;
  height: 42px;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  /* Apple Spring Physics Easing Curves */
  --spring-morph: linear(
    0, 0.009, 0.035 2.1%, 0.141, 0.281 6.7%, 0.723 12.9%, 0.938 16.7%, 1.017,
    1.046 22.7%, 1.038 26.8%, 1.006 35.7%, 0.998 45.2%, 1
  );
  --spring-snappy: cubic-bezier(0.22, 1.18, 0.36, 1);
  --ease-fluid: cubic-bezier(0.25, 0.9, 0.3, 1);
  --glass-bg: linear-gradient(155deg, rgba(36, 38, 54, 0.68) 0%, rgba(16, 17, 26, 0.78) 100%);
  --glass-tile: rgba(255, 255, 255, 0.065);
  --glass-tile-hover: rgba(255, 255, 255, 0.11);
  --glass-active: linear-gradient(140deg, rgba(10, 132, 255, 0.42), rgba(94, 92, 230, 0.38));
  --accent-blue: #0a84ff;
  --accent-cyan: #64d2ff;
  --emerald: #30d158;
  --amber: #ffd60a;
  --coral: #ff453a;
  --text-1: rgba(255, 255, 255, 0.96);
  --text-2: rgba(235, 235, 245, 0.68);
  --text-3: rgba(235, 235, 245, 0.42);
  transition: left 0.28s var(--ease-fluid), top 0.28s var(--ease-fluid);
}
:host(.dragging) {
  transition: none !important;
  user-select: none;
}
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}
button, input, textarea {
  font: inherit;
  color: inherit;
}

/* Single Morphing Liquid Glass Vessel (Dynamic Island) */
.island {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 120px;
  height: 42px;
  border-radius: 21px;
  background: var(--glass-bg);
  backdrop-filter: blur(48px) saturate(210%) brightness(1.06);
  -webkit-backdrop-filter: blur(48px) saturate(210%) brightness(1.06);
  box-shadow:
    0 24px 64px -10px rgba(0, 0, 0, 0.58),
    0 6px 20px rgba(0, 0, 0, 0.32),
    inset 0 1px 0.5px rgba(255, 255, 255, 0.44),
    inset 0 -1px 1px rgba(255, 255, 255, 0.08);
  overflow: hidden;
  transform-origin: bottom right;
  transition:
    width 0.52s var(--spring-morph),
    height 0.52s var(--spring-morph),
    border-radius 0.52s var(--spring-morph),
    transform 0.25s var(--ease-fluid),
    box-shadow 0.3s ease;
  will-change: width, height, border-radius, transform;
}
:host(.flip-x) .island {
  right: auto;
  left: 0;
  transform-origin: bottom left;
}
:host(.flip-y) .island {
  bottom: auto;
  top: 0;
  transform-origin: top right;
}
:host(.flip-x.flip-y) .island {
  transform-origin: top left;
}

/* 1px Refractive Specular Rim Bevel (visionOS / iOS 26 Liquid Glass signature) */
.island::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.55) 0%,
    rgba(255, 255, 255, 0.14) 32%,
    rgba(120, 180, 255, 0.06) 65%,
    rgba(255, 255, 255, 0.32) 100%
  );
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
  z-index: 3;
}

/* Interactive Caustic Light Reflection */
.island::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(
    260px circle at var(--mx, 50%) var(--my, 0%),
    rgba(255, 255, 255, 0.13),
    transparent 70%
  );
  pointer-events: none;
  z-index: 1;
}

.island.collapsed {
  cursor: pointer;
}
.island.collapsed:hover {
  transform: scale(1.045) translateY(-1px);
  box-shadow:
    0 28px 70px -8px rgba(0, 0, 0, 0.65),
    0 0 24px rgba(100, 210, 255, 0.18),
    inset 0 1px 1px rgba(255, 255, 255, 0.62);
}
.island.collapsed:active {
  transform: scale(0.95);
}
.island.expanded {
  width: 364px;
  height: var(--expanded-h, 456px);
  border-radius: 32px;
}

/* Compact Pill Layer */
.compact-layer {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 14px;
  z-index: 2;
  user-select: none;
  opacity: 1;
  filter: blur(0px);
  transform: scale(1);
  transition:
    opacity 0.2s ease,
    filter 0.24s ease,
    transform 0.28s var(--ease-fluid);
}
.island.expanded .compact-layer {
  opacity: 0;
  filter: blur(10px);
  transform: scale(0.84);
  pointer-events: none;
}

.orb {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: rgba(255, 255, 255, 0.3);
  transition: background 0.25s, box-shadow 0.25s;
}
.orb.on {
  background: var(--emerald);
  box-shadow: 0 0 10px var(--emerald), 0 0 3px #fff;
}
.orb.busy {
  background: var(--amber);
  box-shadow: 0 0 12px var(--amber);
  animation: pulse-orb 0.9s ease-in-out infinite alternate;
}
.orb.peek {
  background: var(--accent-cyan);
  box-shadow: 0 0 12px var(--accent-cyan);
}
.orb.error {
  background: var(--coral);
  box-shadow: 0 0 12px var(--coral);
}
@keyframes pulse-orb {
  from { transform: scale(0.85); opacity: 0.65; }
  to { transform: scale(1.2); opacity: 1; }
}

.compact-glyph {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  letter-spacing: -0.01em;
}
.compact-sep {
  width: 1px;
  height: 11px;
  background: rgba(255, 255, 255, 0.18);
}
.compact-tag {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Expanded Control Center View */
.expanded-layer {
  position: relative;
  width: 364px;
  z-index: 2;
  opacity: 0;
  filter: blur(12px);
  transform: scale(0.92);
  pointer-events: none;
  transition:
    opacity 0.26s ease 0.04s,
    filter 0.3s ease 0.04s,
    transform 0.42s var(--spring-morph);
}
.island.expanded .expanded-layer {
  opacity: 1;
  filter: blur(0px);
  transform: scale(1);
  pointer-events: auto;
}

/* Top Bar (Draggable Handle) */
.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px 12px;
  cursor: grab;
  user-select: none;
}
.topbar:active {
  cursor: grabbing;
}
.brand-badge {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background: linear-gradient(140deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05));
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.45), 0 4px 12px rgba(0, 0, 0, 0.2);
  display: grid;
  place-items: center;
  font-size: 16px;
  font-weight: 800;
  color: var(--text-1);
}
.brand-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.brand-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  letter-spacing: -0.01em;
}
.brand-sub {
  font-size: 11px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.brand-sub.error {
  color: var(--coral);
  cursor: pointer;
  text-decoration: underline;
}

.topbar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Master Power Pill */
.power-pill {
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: rgba(48, 209, 88, 0.22);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.35), 0 0 16px rgba(48, 209, 88, 0.2);
  color: #72f592;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.16s var(--spring-snappy), background 0.2s, color 0.2s, box-shadow 0.2s;
}
.power-pill:hover {
  transform: scale(1.04);
}
.power-pill:active {
  transform: scale(0.93);
}
.power-pill.off {
  background: rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.18);
  color: var(--text-2);
}

.icon-btn {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.22);
  color: var(--text-2);
  display: grid;
  place-items: center;
  cursor: pointer;
  font-size: 13px;
  transition: transform 0.15s, background 0.2s, color 0.2s;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.16);
  color: var(--text-1);
  transform: scale(1.06);
}
.icon-btn:active {
  transform: scale(0.92);
}

/* Body Content */
.content {
  padding: 4px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Apple Sliding Segmented Control */
.segmented {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 3px;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.28);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.35), 0 1px 0 rgba(255, 255, 255, 0.07);
}
.seg-thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc((100% - 6px) / 3);
  border-radius: 11px;
  background: linear-gradient(165deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.1));
  box-shadow:
    0 3px 10px rgba(0, 0, 0, 0.3),
    inset 0 1px 0.5px rgba(255, 255, 255, 0.5);
  transform: translateX(calc(var(--tab-idx, 0) * 100%));
  transition: transform 0.38s var(--spring-morph);
  pointer-events: none;
}
.seg-btn {
  position: relative;
  z-index: 1;
  height: 30px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.2s;
}
.seg-btn.active {
  color: var(--text-1);
  font-weight: 700;
}

/* Route Cards Grid */
.route-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
.route-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 12px;
  border: 0;
  border-radius: 16px;
  background: var(--glass-tile);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.14);
  text-align: left;
  cursor: pointer;
  transition:
    transform 0.16s var(--spring-snappy),
    background 0.2s,
    box-shadow 0.2s;
}
.route-card:hover {
  background: var(--glass-tile-hover);
}
.route-card:active {
  transform: scale(0.96);
}
.route-card.active {
  background: var(--glass-active);
  box-shadow:
    0 6px 18px rgba(10, 132, 255, 0.24),
    inset 0 1px 0.5px rgba(255, 255, 255, 0.55);
}
.route-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-1);
  letter-spacing: -0.01em;
}
.route-sub {
  font-size: 10.5px;
  color: var(--text-2);
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Bento Control Center Tiles (4-Grid: 3 Engine Toggles + 1 Hold-to-Peek) */
.bento-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 7px;
}
.bento-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 10px 6px 9px;
  border: 0;
  border-radius: 16px;
  background: var(--glass-tile);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.14);
  cursor: pointer;
  user-select: none;
  transition:
    transform 0.16s var(--spring-snappy),
    background 0.2s,
    box-shadow 0.2s,
    opacity 0.2s;
}
.bento-tile:hover:not(.locked) {
  background: var(--glass-tile-hover);
}
.bento-tile:active:not(.locked) {
  transform: scale(0.93);
}
.bento-tile.on {
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.12));
  box-shadow:
    0 4px 14px rgba(0, 0, 0, 0.22),
    inset 0 1px 0.5px rgba(255, 255, 255, 0.55);
}
.bento-tile.peek-active {
  background: linear-gradient(145deg, rgba(100, 210, 255, 0.42), rgba(10, 132, 255, 0.32));
  box-shadow: 0 0 18px rgba(100, 210, 255, 0.35), inset 0 1px 0.5px rgba(255, 255, 255, 0.65);
}
.bento-tile.locked {
  opacity: 0.36;
  cursor: not-allowed;
}
.tile-icon {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-2);
  transition: background 0.2s, color 0.2s;
}
.bento-tile.on .tile-icon {
  background: var(--accent-blue);
  color: #fff;
  box-shadow: 0 0 10px rgba(10, 132, 255, 0.55);
}
.bento-tile.peek-active .tile-icon {
  background: var(--accent-cyan);
  color: #002638;
}
.tile-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-1);
  white-space: nowrap;
}
.tile-state {
  font-size: 9.5px;
  color: var(--text-3);
}
.bento-tile.on .tile-state {
  color: var(--accent-cyan);
}

/* Utility Pill Bar (Drawers for Custom Glossary & Live Sandbox) */
.utility-bar {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.util-btn {
  height: 32px;
  border: 0;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.055);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.12);
  color: var(--text-2);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: background 0.2s, color 0.2s, transform 0.15s;
}
.util-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-1);
}
.util-btn.active {
  background: rgba(255, 255, 255, 0.16);
  color: var(--text-1);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.35);
}
.badge-count {
  padding: 1px 6px;
  border-radius: 99px;
  background: rgba(10, 132, 255, 0.35);
  color: #8ce0ff;
  font-size: 10px;
}

/* Expandable Glass Drawer */
.drawer {
  display: none;
  flex-direction: column;
  gap: 8px;
  padding: 11px 12px;
  border-radius: 16px;
  background: rgba(0, 0, 0, 0.26);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.35), 0 1px 0 rgba(255, 255, 255, 0.07);
}
.drawer.open {
  display: flex;
}
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-2);
}
.glass-textarea {
  width: 100%;
  height: 76px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-1);
  font-size: 12px;
  line-height: 1.45;
  resize: none;
  outline: none;
  transition: border-color 0.2s, background 0.2s;
}
.glass-textarea:focus {
  border-color: rgba(100, 210, 255, 0.6);
  background: rgba(255, 255, 255, 0.08);
}
.sandbox-out {
  padding: 8px 10px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-1);
  font-size: 12px;
  line-height: 1.45;
  min-height: 36px;
  max-height: 76px;
  overflow-y: auto;
  word-break: break-word;
}
.mini-btn {
  padding: 3px 9px;
  border: 0;
  border-radius: 8px;
  background: rgba(10, 132, 255, 0.35);
  color: #9be4ff;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.mini-btn:hover {
  background: rgba(10, 132, 255, 0.52);
}

/* Footer Telemetry Bar */
.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 18px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  font-size: 10.5px;
  color: var(--text-3);
}
.code-pill {
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  color: var(--text-2);
}
</style>

<div class="island collapsed">
  <!-- Compact Dynamic Island Pill -->
  <div class="compact-layer" title="左键展开控制中心 · 右键快速开关 · 拖拽移动">
    <div class="orb"></div>
    <span class="compact-glyph">文</span>
    <div class="compact-sep"></div>
    <span class="compact-tag"></span>
  </div>

  <!-- Expanded Liquid Glass Control Center -->
  <div class="expanded-layer">
    <div class="topbar">
      <div class="brand-badge">文</div>
      <div class="brand-meta">
        <div class="brand-title">
          <span>OpenCC</span>
          <div class="orb header-orb"></div>
        </div>
        <div class="brand-sub"></div>
      </div>
      <div class="topbar-actions">
        <button class="power-pill" type="button"></button>
        <button class="icon-btn collapse-btn" type="button" title="收起灵动岛 (Esc)">✕</button>
      </div>
    </div>

    <div class="content">
      <!-- Sliding Glass Segmented Control -->
      <div class="segmented" style="--tab-idx: 0">
        <div class="seg-thumb"></div>
        <button class="seg-btn" type="button" data-tab="0">繁 → 简</button>
        <button class="seg-btn" type="button" data-tab="1">简 → 繁</button>
        <button class="seg-btn" type="button" data-tab="2">异体 · 专向</button>
      </div>

      <!-- Route Matrix -->
      <div class="route-grid"></div>

      <!-- Control Center Bento Row -->
      <div class="bento-row">
        <button class="bento-tile tile-phrase" type="button" title="转换两岸三地地域惯用词汇（如：软体↔软件、记忆体↔内存）">
          <div class="tile-icon">词</div>
          <span class="tile-label">地域词汇</span>
          <span class="tile-state"></span>
        </button>
        <button class="bento-tile tile-jieba" type="button" title="启用结巴中文分词引擎提升上下文准确度">
          <div class="tile-icon">分</div>
          <span class="tile-label">结巴分词</span>
          <span class="tile-state"></span>
        </button>
        <button class="bento-tile tile-tofu" type="button" title="包含可能产生生僻字/豆腐字的扩展词典条目">
          <div class="tile-icon">僻</div>
          <span class="tile-label">生僻字库</span>
          <span class="tile-state"></span>
        </button>
        <button class="bento-tile tile-peek" type="button" title="按住此键（或在网页按住 Alt+O）瞬间透视网页原始文字">
          <div class="tile-icon">原</div>
          <span class="tile-label">按住透视</span>
          <span class="tile-state">Alt+O</span>
        </button>
      </div>

      <!-- Utility Drawers Triggers -->
      <div class="utility-bar">
        <button class="util-btn btn-glossary" type="button">
          <span>专名保护/词典</span>
          <span class="badge-count" hidden>0</span>
        </button>
        <button class="util-btn btn-sandbox" type="button">
          <span>划词对照/速转</span>
        </button>
      </div>

      <!-- Drawer 1: Custom Glossary & Proper Noun Protection -->
      <div class="drawer drawer-glossary">
        <div class="drawer-head">
          <span>每行一条：写「专有名词」保护不转，或「原文=替换词」</span>
          <button class="mini-btn save-glossary" type="button">保存生效</button>
        </div>
        <textarea class="glass-textarea glossary-input" placeholder="例如：&#10;范闲&#10;乾坤&#10;软体=App"></textarea>
      </div>

      <!-- Drawer 2: Live Selection Inspector & Sandbox -->
      <div class="drawer drawer-sandbox">
        <div class="drawer-head">
          <span>选中网页文字自动载入，或直接输入测试：</span>
          <button class="mini-btn copy-sandbox" type="button">复制结果</button>
        </div>
        <textarea class="glass-textarea sandbox-input" placeholder="在此输入或选中网页任意文字…"></textarea>
        <div class="sandbox-out"></div>
      </div>
    </div>

    <div class="footer">
      <span class="code-pill"></span>
      <span class="stats-pill">右键胶囊快速开关</span>
    </div>
  </div>
</div>`;

    const q = (sel) => root.querySelector(sel);
    state.ui = {
      host,
      root,
      island: q(".island"),
      compactLayer: q(".compact-layer"),
      compactOrb: q(".compact-layer .orb"),
      compactTag: q(".compact-tag"),
      expandedLayer: q(".expanded-layer"),
      topbar: q(".topbar"),
      headerOrb: q(".header-orb"),
      brandSub: q(".brand-sub"),
      powerPill: q(".power-pill"),
      collapseBtn: q(".collapse-btn"),
      segmented: q(".segmented"),
      segBtns: [...root.querySelectorAll(".seg-btn")],
      routeGrid: q(".route-grid"),
      tilePhrase: q(".tile-phrase"),
      tileJieba: q(".tile-jieba"),
      tileTofu: q(".tile-tofu"),
      tilePeek: q(".tile-peek"),
      btnGlossary: q(".btn-glossary"),
      badgeCount: q(".badge-count"),
      btnSandbox: q(".btn-sandbox"),
      drawerGlossary: q(".drawer-glossary"),
      glossaryInput: q(".glossary-input"),
      saveGlossary: q(".save-glossary"),
      drawerSandbox: q(".drawer-sandbox"),
      sandboxInput: q(".sandbox-input"),
      sandboxOut: q(".sandbox-out"),
      copySandbox: q(".copy-sandbox"),
      codePill: q(".code-pill"),
      statsPill: q(".stats-pill"),
    };

    state.ui.glossaryInput.value = state.customRulesRaw;

    // Auto-measure expanded height so the Dynamic Island morphs smoothly via spring CSS
    const ro = new ResizeObserver(() => {
      if (!state.collapsed && state.ui.expandedLayer) {
        const h = state.ui.expandedLayer.offsetHeight;
        if (h > 100) {
          state.ui.island.style.setProperty("--expanded-h", `${h}px`);
        }
      }
    });
    ro.observe(state.ui.expandedLayer);

    // Interactive pointer caustic light tracking
    state.ui.island.addEventListener("pointermove", (e) => {
      const rect = state.ui.island.getBoundingClientRect();
      state.ui.island.style.setProperty("--mx", `${e.clientX - rect.left}px`);
      state.ui.island.style.setProperty("--my", `${e.clientY - rect.top}px`);
    });

    // Right-click compact island to toggle conversion immediately
    state.ui.compactLayer.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      void setEnabled(!state.enabled);
    });

    state.ui.collapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.collapsed = true;
      storeSet("collapsed", true);
      notify();
    });

    state.ui.powerPill.addEventListener("click", (e) => {
      e.stopPropagation();
      void setEnabled(!state.enabled);
    });

    state.ui.brandSub.addEventListener("click", () => {
      if (state.status.error && state.enabled) scanFullDocument();
    });

    // Segmented Tab Switching
    for (const btn of state.ui.segBtns) {
      btn.addEventListener("click", () => {
        state.activeTab = Number(btn.dataset.tab);
        notify();
      });
    }

    // Bento Control Center Tiles
    state.ui.tilePhrase.addEventListener("click", togglePhraseMode);
    state.ui.tileJieba.addEventListener("click", toggleJiebaMode);
    state.ui.tileTofu.addEventListener("click", toggleTofuRisk);

    // Hold-to-Peek Tile (press & hold to view original webpage text)
    state.ui.tilePeek.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !state.enabled) return;
      state.ui.tilePeek.setPointerCapture(e.pointerId);
      setPeeking(true);
    });
    const endTilePeek = () => setPeeking(false);
    state.ui.tilePeek.addEventListener("pointerup", endTilePeek);
    state.ui.tilePeek.addEventListener("pointercancel", endTilePeek);

    // Drawers
    state.ui.btnGlossary.addEventListener("click", () => {
      state.activeDrawer = state.activeDrawer === "glossary" ? null : "glossary";
      notify();
    });
    state.ui.btnSandbox.addEventListener("click", () => {
      state.activeDrawer = state.activeDrawer === "sandbox" ? null : "sandbox";
      if (state.activeDrawer === "sandbox") void updateSandboxPreview();
      notify();
    });

    state.ui.saveGlossary.addEventListener("click", () => {
      compileCustomRules(state.ui.glossaryInput.value);
      storeSet("customRules", state.customRulesRaw);
      state.generation++;
      if (state.enabled) scanFullDocument();
      void updateSandboxPreview();
      const origText = state.ui.saveGlossary.textContent;
      state.ui.saveGlossary.textContent = "已生效 ✓";
      setTimeout(() => {
        state.ui.saveGlossary.textContent = origText;
      }, 1000);
      notify();
    });

    state.ui.sandboxInput.addEventListener("input", () => {
      state.sandboxInput = state.ui.sandboxInput.value;
      void updateSandboxPreview();
    });

    state.ui.copySandbox.addEventListener("click", async () => {
      if (!state.sandboxOutput) return;
      try {
        await navigator.clipboard.writeText(state.sandboxOutput);
        state.ui.copySandbox.textContent = "已复制 ✓";
        setTimeout(() => {
          state.ui.copySandbox.textContent = "复制结果";
        }, 1000);
      } catch {}
    });

    setupDragAndPosition();
    subscribe(renderUI);
    renderUI();
  }

  function renderRouteCards() {
    const { routeGrid } = state.ui;
    const routesInTab = ROUTES.filter((r) => r.tab === state.activeTab);
    routeGrid.replaceChildren(
      ...routesInTab.map((r) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "route-card" + (r.id === state.routeId ? " active" : "");
        btn.innerHTML = `
          <span class="route-title">${r.title}</span>
          <span class="route-sub">${r.sub}</span>
        `;
        btn.addEventListener("click", () => selectRoute(r.id));
        return btn;
      })
    );
  }

  function renderUI() {
    if (!state.ui) return;
    const { ui } = state;
    const route = getCurrentRoute();
    const v = route.variants;
    const tofuMeta = getTofuMeta(state.config);

    // 1. Morphing Island Container
    ui.island.classList.toggle("collapsed", state.collapsed);
    ui.island.classList.toggle("expanded", !state.collapsed);
    if (!state.collapsed) {
      requestAnimationFrame(() => {
        const h = ui.expandedLayer.offsetHeight;
        if (h > 100) ui.island.style.setProperty("--expanded-h", `${h}px`);
      });
    }

    // 2. Orbs & Status
    const orbState = state.peeking
      ? "peek"
      : state.status.error
      ? "error"
      : state.status.busy
      ? "busy"
      : state.enabled
      ? "on"
      : "";
    ui.compactOrb.className = `orb ${orbState}`;
    ui.headerOrb.className = `orb header-orb ${orbState}`;

    ui.compactTag.textContent = state.peeking
      ? "透视原文"
      : state.enabled
      ? route.short
      : "已关闭";

    ui.brandSub.textContent = state.peeking
      ? "正在透视网页原文 (松开恢复)"
      : state.status.text;
    ui.brandSub.classList.toggle("error", state.status.error);

    ui.powerPill.textContent = state.enabled ? "已开启" : "已关闭";
    ui.powerPill.classList.toggle("off", !state.enabled);

    // 3. Sliding Segmented Control & Route Cards
    ui.segmented.style.setProperty("--tab-idx", String(state.activeTab));
    ui.segBtns.forEach((btn, idx) => {
      btn.classList.toggle("active", idx === state.activeTab);
    });
    renderRouteCards();

    // 4. Bento Tiles
    const phraseSupported = Boolean(v.p || v.pj);
    ui.tilePhrase.classList.toggle("on", phraseSupported && state.usePhrase);
    ui.tilePhrase.classList.toggle("locked", !phraseSupported);
    ui.tilePhrase.querySelector(".tile-state").textContent = !phraseSupported
      ? "不适用"
      : state.usePhrase
      ? "已开启"
      : "已关闭";

    const jiebaSupported = Boolean(v.j || v.pj);
    ui.tileJieba.classList.toggle("on", jiebaSupported && state.useJieba);
    ui.tileJieba.classList.toggle("locked", !jiebaSupported);
    ui.tileJieba.querySelector(".tile-state").textContent = !jiebaSupported
      ? "不适用"
      : state.useJieba
      ? "已开启"
      : "已关闭";

    const tofuAvailable = tofuMeta.status === "ready" && tofuMeta.supported;
    const tofuLocked = tofuMeta.status === "ready" && !tofuMeta.supported;
    ui.tileTofu.classList.toggle("on", tofuAvailable && state.includeTofuRisk);
    ui.tileTofu.classList.toggle("locked", tofuLocked);
    ui.tileTofu.querySelector(".tile-state").textContent =
      tofuMeta.status === "loading" || tofuMeta.status === "idle"
        ? "检测中"
        : tofuLocked
        ? "不含生僻"
        : state.includeTofuRisk
        ? "已包含"
        : "已过滤";

    ui.tilePeek.classList.toggle("peek-active", state.peeking);
    ui.tilePeek.classList.toggle("locked", !state.enabled);
    ui.tilePeek.querySelector(".tile-state").textContent = state.peeking ? "透视中" : "Alt+O";

    // 5. Drawers & Telemetry
    ui.btnGlossary.classList.toggle("active", state.activeDrawer === "glossary");
    ui.btnSandbox.classList.toggle("active", state.activeDrawer === "sandbox");
    ui.drawerGlossary.classList.toggle("open", state.activeDrawer === "glossary");
    ui.drawerSandbox.classList.toggle("open", state.activeDrawer === "sandbox");

    const ruleCount = state.customRules.length;
    ui.badgeCount.hidden = ruleCount === 0;
    ui.badgeCount.textContent = String(ruleCount);

    ui.sandboxOut.textContent = state.sandboxOutput || "转换预览将显示于此…";
    ui.codePill.textContent = `方案: ${state.config}`;
    ui.statsPill.textContent =
      state.stats.nodes > 0
        ? `${state.stats.nodes} 节点 · ${state.stats.lastMs}ms`
        : `opencc-wasm ${OPENCC_LIB_VERSION}`;
  }

  function setupDragAndPosition() {
    const { host, compactLayer, topbar } = state.ui;
    const DRAG_THRESHOLD = 5;
    const HOST_W = 120;
    const HOST_H = 42;
    const savedPos = storeGet("panelPos", null);

    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let moved = false;
    let dragSource = null;

    function updateQuadrant(left, top) {
      host.classList.toggle("flip-x", left < 280);
      host.classList.toggle("flip-y", top < 440);
    }

    function applyPosition(left, top) {
      const maxL = Math.max(12, window.innerWidth - HOST_W - 12);
      const maxT = Math.max(12, window.innerHeight - HOST_H - 12);
      const clampedL = Math.max(12, Math.min(left, maxL));
      const clampedT = Math.max(12, Math.min(top, maxT));
      host.style.right = "auto";
      host.style.bottom = "auto";
      host.style.left = `${clampedL}px`;
      host.style.top = `${clampedT}px`;
      updateQuadrant(clampedL, clampedT);
    }

    requestAnimationFrame(() => {
      if (savedPos && typeof savedPos.left === "number" && typeof savedPos.top === "number") {
        applyPosition(savedPos.left, savedPos.top);
      } else {
        const rect = host.getBoundingClientRect();
        updateQuadrant(rect.left, rect.top);
      }
    });

    window.addEventListener("resize", () => {
      requestAnimationFrame(() => {
        if (!host.isConnected) return;
        const rect = host.getBoundingClientRect();
        applyPosition(rect.left, rect.top);
      });
    });

    function onPointerDown(e, source) {
      if (e.button !== 0) return;
      if (e.target.closest?.(".power-pill, .collapse-btn, .brand-sub.error")) return;
      moved = false;
      dragSource = source;
      startX = e.clientX;
      startY = e.clientY;
      const rect = host.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      applyPosition(startLeft, startTop);
      host.setPointerCapture(e.pointerId);
      host.classList.add("dragging");
      e.preventDefault();
    }

    compactLayer.addEventListener("pointerdown", (e) => onPointerDown(e, "compact"));
    topbar.addEventListener("pointerdown", (e) => onPointerDown(e, "topbar"));

    host.addEventListener("pointermove", (e) => {
      if (!host.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved = true;
      applyPosition(startLeft + dx, startTop + dy);
    });

    function onPointerEnd(e) {
      if (!host.hasPointerCapture(e.pointerId)) return;
      host.releasePointerCapture(e.pointerId);
      host.classList.remove("dragging");
      if (e.type !== "pointerup") return;

      if (moved) {
        const rect = host.getBoundingClientRect();
        storeSet("panelPos", { left: rect.left, top: rect.top });
      } else if (dragSource === "compact") {
        state.collapsed = false;
        storeSet("collapsed", false);
        notify();
      }
      dragSource = null;
    }

    host.addEventListener("pointerup", onPointerEnd);
    host.addEventListener("pointercancel", onPointerEnd);
  }
})();
