// ==UserScript==
// @name         OpenCC 网页繁简转换
// @namespace    https://github.com/opencc-wasm
// @version      2.1.0
// @description  基于 opencc-wasm 的网页繁简转换工具（优化版）
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(async () => {
  'use strict';

  if (window.__OPENCC_USER_SCRIPT__) return;
  window.__OPENCC_USER_SCRIPT__ = true;

  const CONFIG = {
    cdn: 'https://cdn.jsdelivr.net/npm/opencc-wasm@0.8.2/dist/esm/index.js',
    batchSize: 1000,
    mutationDebounceMs: 200,

    skipTags: new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA',
      'INPUT', 'CODE', 'PRE', 'SVG', 'MATH', 'IFRAME'
    ]),

    modes: [
      ['t2s', '繁 → 简'],
      ['tw2sp', '台繁 → 简'],
      ['hk2s', '港繁 → 简'],
      ['s2t', '简 → 繁'],
      ['s2twp', '简 → 台繁'],
      ['s2hk', '简 → 港繁'],
    ],
  };

  const state = {
    enabled: false,
    mode: GM_getValue('mode', 't2s'),
    OpenCC: null,
    converter: null,
    converterMode: '',
    originalMap: new WeakMap(),
    converting: new WeakSet(),
    originalTitle: '',
    observerPaused: false,
    loading: false,
  };

  const mutationQueue = new Set();
  let mutationTimer = null;

  /* ---------- 核心工具 ---------- */

  async function getConverter(mode) {
    if (state.converter && state.converterMode === mode) {
      return state.converter;
    }
    if (!state.OpenCC) {
      const mod = await import(CONFIG.cdn);
      state.OpenCC = mod.default ?? mod;
    }
    state.converter = state.OpenCC.Converter({ config: mode });
    state.converterMode = mode;
    return state.converter;
  }

  function* walkTextNodes(root) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (CONFIG.skipTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
          if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let current;
    while ((current = walker.nextNode())) yield current;
  }

  // 关键改进：不再跳过已转换节点，仅防止并发重复转换
  async function convertTextNode(node, converter) {
    if (state.converting.has(node)) return;

    const current = node.nodeValue;
    if (!current.trim()) return;

    state.converting.add(node);
    try {
      const converted = await converter(current);
      if (current === converted) return;

      if (!state.originalMap.has(node)) {
        state.originalMap.set(node, current);
      }
      node.nodeValue = converted;
    } catch (e) {
      console.error('[OpenCC] 节点转换失败:', e);
    } finally {
      state.converting.delete(node);
    }
  }

  async function convertNodes(nodes, converter) {
    for (let i = 0; i < nodes.length; i++) {
      await convertTextNode(nodes[i], converter);
      if (i > 0 && i % CONFIG.batchSize === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }

  async function convertRoot(root = document.body) {
    const converter = await getConverter(state.mode);
    await convertNodes(Array.from(walkTextNodes(root)), converter);
  }

  /* ---------- 页面级操作 ---------- */

  async function convertPage() {
    if (state.loading || state.enabled) return;
    state.loading = true;
    updateButtonState();

    try {
      const converter = await getConverter(state.mode);

      // 先尝试转换 title，确保 converter 可用，避免 body 转一半失败
      state.originalTitle = document.title;
      const newTitle = await converter(document.title);

      await convertRoot();

      document.title = newTitle;
      state.enabled = true;
      toast('转换完成');
    } catch (err) {
      console.error('[OpenCC]', err);
      toast('转换失败: ' + (err.message || '未知错误'));
    } finally {
      state.loading = false;
      updateButtonState();
    }
  }

  function restorePage() {
    if (!state.enabled) return;
    state.observerPaused = true;

    for (const node of walkTextNodes(document.body)) {
      const original = state.originalMap.get(node);
      if (original !== undefined) node.nodeValue = original;
    }

    if (state.originalTitle) document.title = state.originalTitle;

    state.originalMap = new WeakMap();
    state.converting = new WeakSet();
    state.enabled = false;

    toast('已恢复原文');

    requestAnimationFrame(() => {
      state.observerPaused = false;
    });
  }

  /* ---------- MutationObserver ---------- */

  async function processMutations() {
    mutationTimer = null;
    if (!state.enabled || state.loading) {
      mutationQueue.clear();
      return;
    }

    const converter = await getConverter(state.mode);
    const nodes = Array.from(mutationQueue);
    mutationQueue.clear();

    const textNodes = [];
    const elementNodes = [];

    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) textNodes.push(node);
      else if (node.nodeType === Node.ELEMENT_NODE) elementNodes.push(node);
    }

    await convertNodes(textNodes, converter);

    for (const el of elementNodes) {
      for (const node of walkTextNodes(el)) {
        await convertTextNode(node, converter);
      }
    }
  }

  new MutationObserver(mutations => {
    if (!state.enabled || state.observerPaused) return;

    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        mutationQueue.add(mutation.target);
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
          mutationQueue.add(node);
        }
      }
    }

    if (!mutationTimer) {
      mutationTimer = setTimeout(processMutations, CONFIG.mutationDebounceMs);
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  /* ---------- UI ---------- */

  GM_addStyle(`
    #opencc-btn {
      position: fixed;
      right: 20px;
      bottom: 20px;
      width: 52px;
      height: 52px;
      border: none;
      border-radius: 50%;
      z-index: 2147483647;
      cursor: pointer;
      background: #1f2937;
      color: white;
      font-size: 18px;
      box-shadow: 0 4px 12px rgba(0,0,0,.25);
      transition: all .2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    #opencc-btn:hover { transform: scale(1.05); }
    #opencc-btn:active { transform: scale(0.95); }
    #opencc-btn.active { background: #2563eb; }
    #opencc-btn.loading {
      background: #4b5563;
      pointer-events: none;
    }
    #opencc-btn.loading::after {
      content: '';
      width: 18px;
      height: 18px;
      border: 2px solid transparent;
      border-top-color: white;
      border-radius: 50%;
      animation: opencc-spin 1s linear infinite;
      position: absolute;
    }
    #opencc-btn.loading span { visibility: hidden; }
    @keyframes opencc-spin { to { transform: rotate(360deg); } }

    #opencc-panel {
      position: fixed;
      right: 20px;
      bottom: 84px;
      z-index: 2147483647;
      background: rgba(30,30,40,.96);
      padding: 10px;
      border-radius: 10px;
      display: none;
      flex-direction: column;
      gap: 8px;
      backdrop-filter: blur(8px);
      min-width: 140px;
    }
    #opencc-panel.open { display: flex; }

    .opencc-mode {
      border: none;
      background: #374151;
      color: white;
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
      text-align: left;
      font-size: 14px;
      transition: background .15s;
    }
    .opencc-mode:hover { background: #4b5563; }
    .opencc-mode.active { background: #2563eb; }

    #opencc-toast {
      position: fixed;
      bottom: 90px;
      right: 20px;
      z-index: 2147483647;
      background: rgba(0,0,0,.8);
      color: white;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 14px;
      opacity: 0;
      transition: opacity .2s;
      pointer-events: none;
      white-space: nowrap;
    }
    #opencc-toast.show { opacity: 1; }
  `);

  const button = document.createElement('button');
  button.id = 'opencc-btn';
  button.innerHTML = '<span>文</span>';
  button.title = '左键：转换 / 恢复\n右键：切换模式';

  const panel = document.createElement('div');
  panel.id = 'opencc-panel';

  const toastEl = document.createElement('div');
  toastEl.id = 'opencc-toast';

  function updateButtonState() {
    button.classList.toggle('active', state.enabled);
    button.classList.toggle('loading', state.loading);
  }

  function buildPanel() {
    panel.innerHTML = '';
    for (const [key, label] of CONFIG.modes) {
      const btn = document.createElement('button');
      btn.className = 'opencc-mode';
      if (key === state.mode) btn.classList.add('active');
      btn.textContent = label;
      btn.onclick = async () => {
        if (key === state.mode) {
          panel.classList.remove('open');
          return;
        }
        state.mode = key;
        GM_setValue('mode', key);
        panel.classList.remove('open');

        if (state.enabled) {
          restorePage();
          await convertPage();
        }
      };
      panel.appendChild(btn);
    }
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastEl.classList.remove('show'), 2000);
  }

  /* ---------- 事件绑定 ---------- */

  let longPressTimer;
  let ignoreNextClick = false;

  button.addEventListener('touchstart', () => {
    ignoreNextClick = false;
    longPressTimer = setTimeout(() => {
      ignoreNextClick = true;
      buildPanel();
      panel.classList.toggle('open');
    }, 600);
  }, { passive: true });

  button.addEventListener('touchend', () => clearTimeout(longPressTimer));
  button.addEventListener('touchmove', () => clearTimeout(longPressTimer));

  button.onclick = () => {
    if (ignoreNextClick) {
      ignoreNextClick = false;
      return;
    }
    panel.classList.remove('open');
    if (state.enabled) restorePage();
    else convertPage();
  };

  button.oncontextmenu = e => {
    e.preventDefault();
    buildPanel();
    panel.classList.toggle('open');
  };

  document.addEventListener('click', e => {
    if (!panel.contains(e.target) && e.target !== button) {
      panel.classList.remove('open');
    }
  });

  document.body.append(button, panel, toastEl);

  /* ---------- 预加载 ---------- */
  getConverter(state.mode).catch(() => {});
})();
