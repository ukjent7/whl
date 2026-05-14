// ==UserScript==
// @name         OpenCC 网页繁简转换
// @namespace    https://github.com/opencc-wasm
// @version      2.0.0
// @description  基于 opencc-wasm 的网页繁简转换工具
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(async () => {
  'use strict';

  if (window.__OPENCC_USER_SCRIPT__) return;
  window.__OPENCC_USER_SCRIPT__ = true;

  const CONFIG = {
    cdn: 'https://cdn.jsdelivr.net/npm/opencc-wasm@0.8.2/dist/esm/index.js',
    chunkSize: 200,

    skipTags: new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT',
      'TEXTAREA', 'INPUT', 'CODE',
      'PRE', 'SVG', 'MATH'
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
    originalTitle: '',

    observerPaused: false,
    loading: false,
  };

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

          if (!parent) {
            return NodeFilter.FILTER_REJECT;
          }

          if (CONFIG.skipTags.has(parent.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }

          if (parent.isContentEditable) {
            return NodeFilter.FILTER_REJECT;
          }

          if (!node.nodeValue.trim()) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let current;

    while ((current = walker.nextNode())) {
      yield current;
    }
  }

  async function convertTextNode(node, converter) {
    if (state.originalMap.has(node)) return;

    const original = node.nodeValue;
    const converted = await converter(original);

    if (original === converted) return;

    state.originalMap.set(node, original);
    node.nodeValue = converted;
  }

  async function convertRoot(root = document.body) {
    const converter = await getConverter(state.mode);

    let batch = [];

    for (const node of walkTextNodes(root)) {
      batch.push(node);

      if (batch.length >= CONFIG.chunkSize) {
        await processBatch(batch, converter);
        batch = [];
      }
    }

    if (batch.length) {
      await processBatch(batch, converter);
    }
  }

  async function processBatch(batch, converter) {
    for (const node of batch) {
      await convertTextNode(node, converter);
    }

    await new Promise(r => setTimeout(r));
  }

  async function convertPage() {
    if (state.loading || state.enabled) return;

    state.loading = true;

    try {
      await convertRoot();

      const converter = await getConverter(state.mode);

      state.originalTitle = document.title;
      document.title = await converter(document.title);

      state.enabled = true;

      button.classList.add('active');
      toast('已完成转换');

    } catch (err) {
      console.error('[OpenCC]', err);
      toast('转换失败');
    }

    state.loading = false;
  }

  function restorePage() {
    if (!state.enabled) return;

    state.observerPaused = true;

    for (const node of walkTextNodes(document.body)) {
      const original = state.originalMap.get(node);

      if (original !== undefined) {
        node.nodeValue = original;
      }
    }

    if (state.originalTitle) {
      document.title = state.originalTitle;
    }

    state.originalMap = new WeakMap();
    state.enabled = false;

    button.classList.remove('active');

    setTimeout(() => {
      state.observerPaused = false;
    }, 0);

    toast('已恢复原文');
  }

  const mutationQueue = new Set();
  let mutationTimer = null;

  async function processMutations() {
    mutationTimer = null;

    if (!state.enabled || state.loading) {
      mutationQueue.clear();
      return;
    }

    const converter = await getConverter(state.mode);

    for (const node of mutationQueue) {
      if (node.nodeType === Node.TEXT_NODE) {
        await convertTextNode(node, converter);
        continue;
      }

      for (const textNode of walkTextNodes(node)) {
        await convertTextNode(textNode, converter);
      }
    }

    mutationQueue.clear();
  }

  new MutationObserver(mutations => {
    if (!state.enabled || state.observerPaused) {
      return;
    }

    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        mutationQueue.add(mutation.target);
      }

      for (const node of mutation.addedNodes) {
        mutationQueue.add(node);
      }
    }

    if (!mutationTimer) {
      mutationTimer = setTimeout(processMutations, 200);
    }

  }).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

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
    }

    #opencc-btn.active {
      background: #2563eb;
    }

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
    }

    #opencc-panel.open {
      display: flex;
    }

    .opencc-mode {
      border: none;
      background: #374151;
      color: white;
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
      text-align: left;
    }

    #opencc-toast {
      position: fixed;
      bottom: 90px;
      right: 20px;
      z-index: 2147483647;
      background: rgba(0,0,0,.8);
      color: white;
      padding: 8px 12px;
      border-radius: 8px;
      opacity: 0;
      transition: opacity .2s;
      pointer-events: none;
    }

    #opencc-toast.show {
      opacity: 1;
    }
  `);

  const button = document.createElement('button');
  button.id = 'opencc-btn';
  button.textContent = '文';

  const panel = document.createElement('div');
  panel.id = 'opencc-panel';

  const toastEl = document.createElement('div');
  toastEl.id = 'opencc-toast';

  for (const [key, label] of CONFIG.modes) {
    const btn = document.createElement('button');

    btn.className = 'opencc-mode';
    btn.textContent = label;

    btn.onclick = async () => {
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

  document.body.append(button, panel, toastEl);

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');

    clearTimeout(toast.timer);

    toast.timer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2000);
  }

  button.onclick = () => {
    panel.classList.remove('open');

    if (state.enabled) {
      restorePage();
    } else {
      convertPage();
    }
  };

  button.oncontextmenu = e => {
    e.preventDefault();
    panel.classList.toggle('open');
  };

  document.addEventListener('click', e => {
    if (!panel.contains(e.target) && e.target !== button) {
      panel.classList.remove('open');
    }
  });

  getConverter(state.mode).catch(console.error);
})();
