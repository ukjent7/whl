// ==UserScript==
// @name         繁體 → 簡體｜OpenCC 一鍵轉換
// @name:zh-CN   繁体 → 简体｜OpenCC 一键转换
// @namespace    https://github.com/opencc-wasm
// @version      1.3.0
// @description  一鍵將網頁繁體中文轉換為簡體中文，基於 OpenCC WASM，本地處理不上傳數據
// @description:zh-CN  一键将网页繁体中文转换为简体中文，基于 OpenCC WASM，本地处理不上传数据
// @author       OpenCC WASM Userscript
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(async function () {
  'use strict';

  // ─── 配置 ──────────────────────────────────────────────────────────────────
  const CONFIG = {
    // 转换方向：'t2s'（繁→简）或 's2t'（简→繁）
    defaultMode: GM_getValue('mode', 't2s'),
    // 跳过这些标签（不转换其内容）
    skipTags: new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE',
      'KBD', 'SAMP', 'VAR', 'SVG', 'MATH', 'IFRAME', 'OBJECT',
      'INPUT', 'BUTTON', 'SELECT', 'OPTION',
    ]),
    // OpenCC WASM CDN
    cdnUrl: 'https://cdn.jsdelivr.net/npm/opencc-wasm@0.8.2/dist/esm/index.js',
  };

  // ─── 状态 ──────────────────────────────────────────────────────────────────
  const state = {
    converted: false,
    mode: CONFIG.defaultMode,
    originalTexts: [],      // { node, original }
    convertedNodes: new WeakSet(), // O(1) 去重，避免重复处理；弱引用不阻止 GC
    converter: null,
    currentMode: null,      // 与 converter 配套，用于缓存命中判断
    OpenCC: null,
    loading: false,
    isConverting: false,    // 防止脚本自身的 nodeValue 修改触发 characterData Observer
    loadError: false,       // CDN 加载失败标志，用于 Error 状态展示
  };

  // ─── 样式 ──────────────────────────────────────────────────────────────────
  GM_addStyle(`
    #opencc-fab {
      position: fixed;
      bottom: 28px;
      right: 28px;
      z-index: 2147483647;
      font-family: 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      user-select: none;
    }

    #opencc-btn {
      width: 52px;
      height: 52px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      background: #1a1a2e;
      color: #e0e0ff;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.5px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.35), 0 0 0 2px rgba(120,100,255,0.3);
      transition: transform 0.18s cubic-bezier(.34,1.56,.64,1),
                  box-shadow 0.18s ease,
                  background 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      outline: none;
      position: relative;
      overflow: hidden;
    }

    #opencc-btn::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background: linear-gradient(135deg, rgba(120,100,255,0.2), transparent);
      pointer-events: none;
    }

    #opencc-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 28px rgba(80,60,200,0.5), 0 0 0 3px rgba(120,100,255,0.5);
    }

    #opencc-btn:active {
      transform: scale(0.95);
    }

    #opencc-btn.converted {
      background: #0f3460;
      box-shadow: 0 4px 20px rgba(0,80,180,0.4), 0 0 0 2px rgba(80,160,255,0.4);
    }

    #opencc-btn.error {
      background: #3a1020;
      box-shadow: 0 4px 20px rgba(180,30,60,0.4), 0 0 0 2px rgba(255,80,100,0.4);
    }

    #opencc-btn.loading {
      pointer-events: none;
      animation: opencc-pulse 1s ease-in-out infinite;
    }

    @keyframes opencc-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    #opencc-spinner {
      display: none;
      width: 20px;
      height: 20px;
      border: 2.5px solid rgba(200,200,255,0.3);
      border-top-color: #a0a0ff;
      border-radius: 50%;
      animation: opencc-spin 0.7s linear infinite;
    }

    @keyframes opencc-spin {
      to { transform: rotate(360deg); }
    }

    #opencc-btn.loading .opencc-label { display: none; }
    #opencc-btn.loading #opencc-spinner { display: block; }

    #opencc-toast {
      position: absolute;
      bottom: 60px;
      right: 0;
      background: rgba(20, 20, 40, 0.92);
      color: #d0d0ff;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 8px;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 0.2s, transform 0.2s;
      border: 1px solid rgba(120,100,255,0.3);
      backdrop-filter: blur(8px);
    }

    #opencc-toast.show {
      opacity: 1;
      transform: translateY(0);
    }

    #opencc-panel {
      position: absolute;
      bottom: 60px;
      right: 0;
      background: rgba(20, 20, 40, 0.96);
      border: 1px solid rgba(120,100,255,0.35);
      border-radius: 12px;
      padding: 14px 16px;
      min-width: 180px;
      display: none;
      flex-direction: column;
      gap: 8px;
      backdrop-filter: blur(12px);
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }

    #opencc-panel.open { display: flex; }

    .opencc-panel-title {
      font-size: 11px;
      color: rgba(180,180,255,0.6);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 2px;
      padding-bottom: 6px;
      border-bottom: 1px solid rgba(120,100,255,0.2);
    }

    .opencc-mode-btn {
      background: transparent;
      border: 1px solid rgba(120,100,255,0.25);
      border-radius: 7px;
      color: #c0c0f0;
      font-size: 12.5px;
      padding: 7px 10px;
      cursor: pointer;
      text-align: left;
      transition: background 0.15s, border-color 0.15s;
      font-family: inherit;
    }

    .opencc-mode-btn:hover {
      background: rgba(120,100,255,0.15);
      border-color: rgba(120,100,255,0.5);
    }

    .opencc-mode-btn.active {
      background: rgba(80,60,200,0.35);
      border-color: rgba(120,100,255,0.7);
      color: #e8e8ff;
    }

    .opencc-divider {
      height: 1px;
      background: rgba(120,100,255,0.15);
      margin: 2px 0;
    }

    .opencc-action-btn {
      background: rgba(80,60,200,0.2);
      border: 1px solid rgba(120,100,255,0.35);
      border-radius: 7px;
      color: #b0b0ff;
      font-size: 12px;
      padding: 6px 10px;
      cursor: pointer;
      text-align: center;
      transition: background 0.15s;
      font-family: inherit;
    }

    .opencc-action-btn:hover {
      background: rgba(80,60,200,0.4);
    }
  `);

  // ─── UI 构建 ───────────────────────────────────────────────────────────────
  function buildUI() {
    const fab = document.createElement('div');
    fab.id = 'opencc-fab';

    // 悬浮面板
    const panel = document.createElement('div');
    panel.id = 'opencc-panel';
    panel.innerHTML = `
      <div class="opencc-panel-title">OpenCC 转换</div>
      <button class="opencc-mode-btn ${state.mode === 't2s' ? 'active' : ''}" data-mode="t2s">繁 → 简（标准）</button>
      <button class="opencc-mode-btn ${state.mode === 'hk2s' ? 'active' : ''}" data-mode="hk2s">港繁 → 简</button>
      <button class="opencc-mode-btn ${state.mode === 'tw2sp' ? 'active' : ''}" data-mode="tw2sp">台繁 → 简（词汇）</button>
      <div class="opencc-divider"></div>
      <button class="opencc-mode-btn ${state.mode === 's2t' ? 'active' : ''}" data-mode="s2t">简 → 繁（标准）</button>
      <button class="opencc-mode-btn ${state.mode === 's2twp' ? 'active' : ''}" data-mode="s2twp">简 → 台繁（词汇）</button>
      <button class="opencc-mode-btn ${state.mode === 's2hk' ? 'active' : ''}" data-mode="s2hk">简 → 港繁</button>
      <div class="opencc-divider"></div>
      <button class="opencc-action-btn" id="opencc-restore-btn">↩ 还原原文</button>
    `;

    // Toast 提示
    const toast = document.createElement('div');
    toast.id = 'opencc-toast';

    // 主按钮
    const btn = document.createElement('button');
    btn.id = 'opencc-btn';
    btn.title = '繁简转换（右键/长按查看选项）';
    btn.innerHTML = `
      <span class="opencc-label">文</span>
      <div id="opencc-spinner"></div>
    `;

    fab.appendChild(panel);
    fab.appendChild(toast);
    fab.appendChild(btn);
    document.body.appendChild(fab);

    // ── 事件绑定 ──
    let longPressTimer = null;

    btn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        togglePanel();
      }, 500);
    });

    btn.addEventListener('mouseup', async (e) => {
      if (e.button !== 0) return;
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        await doConvert();
      }
    });

    // 光标滑出按钮时取消长按计时，避免意外触发面板
    btn.addEventListener('mouseleave', () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      togglePanel();
    });

    // 模式按钮
    panel.querySelectorAll('.opencc-mode-btn').forEach(modeBtn => {
      modeBtn.addEventListener('click', async (e) => {
        const newMode = e.target.dataset.mode;
        if (newMode === state.mode) return;
        state.mode = newMode;
        GM_setValue('mode', newMode);
        panel.querySelectorAll('.opencc-mode-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        state.converter = null; // 重置转换器
        // 如果已转换，重新转换
        if (state.converted) {
          restoreOriginal();
          await doConvert();
        }
        closePanel();
      });
    });

    // 还原按钮
    document.getElementById('opencc-restore-btn').addEventListener('click', () => {
      restoreOriginal();
      closePanel();
    });

    // 点击外部关闭面板
    document.addEventListener('click', (e) => {
      if (!fab.contains(e.target)) closePanel();
    });
  }

  function togglePanel() {
    const panel = document.getElementById('opencc-panel');
    panel.classList.toggle('open');
  }

  function closePanel() {
    document.getElementById('opencc-panel')?.classList.remove('open');
  }

  function showToast(msg, duration = 2000) {
    const toast = document.getElementById('opencc-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
  }

  function setLoading(loading) {
    const btn = document.getElementById('opencc-btn');
    if (!btn) return;
    state.loading = loading;
    btn.classList.toggle('loading', loading);
  }

  // ─── OpenCC 加载（含重试）─────────────────────────────────────────────────
  const MAX_RETRIES = 3;

  async function loadOpenCC() {
    if (state.OpenCC) return state.OpenCC;

    // 每次尝试加载都清除 error 状态
    document.getElementById('opencc-btn')?.classList.remove('error');
    state.loadError = false;

    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const mod = await import(CONFIG.cdnUrl);
        state.OpenCC = mod.default || mod;
        return state.OpenCC;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_RETRIES) {
          // 指数退避：1s、2s
          await new Promise(r => setTimeout(r, attempt * 1000));
        }
      }
    }

    // 全部重试失败
    state.loadError = true;
    document.getElementById('opencc-btn')?.classList.add('error');
    throw lastErr;
  }

  async function getConverter(mode) {
    // 命中缓存：同一模式直接复用已实例化的 converter，避免重复加载字典
    if (state.currentMode === mode && state.converter) return state.converter;
    const OpenCC = await loadOpenCC();
    state.converter = OpenCC.Converter({ config: mode });
    state.currentMode = mode;
    return state.converter;
  }

  // ─── 文本节点遍历 ──────────────────────────────────────────────────────────
  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          // 跳过空白节点
          if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          // 跳过 skipTags 集合中的标签（含表单元素）
          let el = node.parentElement;
          while (el) {
            if (CONFIG.skipTags.has(el.tagName)) return NodeFilter.FILTER_REJECT;
            el = el.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  // ─── 转换逻辑 ──────────────────────────────────────────────────────────────
  // Unicode 私用区字符作分隔符：OpenCC 转换域为 CJK 及常用字符，绝不会生成 PUA 字符
  const SEPARATOR = '\uE000';
  const CHUNK = 200; // 每批节点数，平衡 WASM 调用次数与让出主线程频率

  async function doConvert() {
    if (state.loading) return;
    if (state.converted) {
      restoreOriginal();
      return;
    }

    setLoading(true);
    showToast('⏳ 加载转换引擎…');

    try {
      const converter = await getConverter(state.mode);
      const textNodes = collectTextNodes(document.body);

      showToast(`⏳ 转换中（${textNodes.length} 个文本节点）…`);

      state.originalTexts = [];
      state.convertedNodes = new WeakSet();

      state.isConverting = true; // 加锁：屏蔽 characterData Observer 对脚本自身修改的响应
      try {
        for (let i = 0; i < textNodes.length; i += CHUNK) {
          const chunk = textNodes.slice(i, i + CHUNK);
          // 批量合并：PUA 分隔符在 OpenCC 转换后保持原样，split 结果与 chunk 严格对齐
          const combined = chunk.map(n => n.nodeValue).join(SEPARATOR);
          const converted = await converter(combined);
          const parts = converted.split(SEPARATOR);

          chunk.forEach((node, idx) => {
            const orig = node.nodeValue;
            const conv = parts[idx] ?? orig;
            if (conv !== orig) {
              state.originalTexts.push({ node, original: orig });
              state.convertedNodes.add(node);
              node.nodeValue = conv;
            }
          });

          // 每批处理完让出主线程，保持页面响应
          await new Promise(r => setTimeout(r, 0));
        }
      } finally {
        state.isConverting = false; // 无论成功失败均释放锁
      }

      // 转换页面标题
      const origTitle = document.title;
      const newTitle = await converter(origTitle);
      if (newTitle !== origTitle) {
        state.originalTexts.push({ node: 'title', original: origTitle });
        document.title = newTitle;
      }

      state.converted = true;
      document.getElementById('opencc-btn')?.classList.add('converted');
      showToast(`✅ 已转换 ${state.originalTexts.length} 处`);

    } catch (err) {
      console.error('[OpenCC]', err);
      if (state.loadError) {
        showToast('❌ 引擎加载失败，点击按钮重试', 3500);
        // 清除缓存，下次点击触发重新加载
        state.OpenCC = null;
        state.converter = null;
        state.currentMode = null;
      } else {
        showToast('❌ 转换失败，请重试');
      }
    } finally {
      setLoading(false);
    }
  }

  function restoreOriginal() {
    if (!state.converted) return;
    state.isConverting = true;
    state.originalTexts.forEach(({ node, original }) => {
      if (node === 'title') {
        document.title = original;
      } else if (node.isConnected) {
        // SPA 路由跳转后节点可能已从 DOM 卸载，跳过失效节点
        node.nodeValue = original;
      }
    });
    state.isConverting = false;
    state.originalTexts = [];
    state.convertedNodes = new WeakSet();
    state.converted = false;
    document.getElementById('opencc-btn')?.classList.remove('converted');
    showToast('↩ 已还原原文');
  }

  // ─── 键盘快捷键 ───────────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // Alt + Z 触发转换
    if (e.altKey && e.key === 'z') {
      e.preventDefault();
      doConvert();
    }
    // Alt + X 还原
    if (e.altKey && e.key === 'x') {
      e.preventDefault();
      restoreOriginal();
    }
  });

  // ─── MutationObserver：处理 SPA 动态注入的新内容 ──────────────────────────
  // 用一个微任务队列合并高频 mutation，避免对每个微小变化都触发转换
  let mutationQueue = [];
  let mutationScheduled = false;

  async function processMutationQueue() {
    mutationScheduled = false;
    if (!state.converted || state.loading) return;

    const nodesToConvert = mutationQueue.splice(0);
    if (!nodesToConvert.length) return;

    const converter = await getConverter(state.mode);
    const fab = document.getElementById('opencc-fab');

    for (const addedNode of nodesToConvert) {
      // 严谨地跳过 FAB 自身及其所有子节点（含文本节点，无 .id 属性）
      if (fab && (fab === addedNode || fab.contains(addedNode))) continue;

      const textNodes = addedNode.nodeType === Node.TEXT_NODE
        ? (addedNode.nodeValue?.trim() ? [addedNode] : [])
        : collectTextNodes(addedNode);

      for (const node of textNodes) {
        // WeakSet O(1) 查找，替代 Array.some O(N) 避免双重循环
        if (state.convertedNodes.has(node)) continue;
        const orig = node.nodeValue;
        const conv = await converter(orig);
        if (conv !== orig) {
          state.originalTexts.push({ node, original: orig });
          state.convertedNodes.add(node);
          node.nodeValue = conv;
        }
      }
    }
  }

  const domObserver = new MutationObserver((mutations) => {
    // isConverting 为 true 时说明是脚本自身修改触发的 characterData，直接忽略
    if (!state.converted || state.isConverting) return;
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        // 文本内容被框架就地修改（Vue/React 不新增节点，直接改 textNode.nodeValue）
        mutationQueue.push(mutation.target);
      } else {
        for (const added of mutation.addedNodes) {
          mutationQueue.push(added);
        }
      }
    }
    if (!mutationScheduled && mutationQueue.length) {
      mutationScheduled = true;
      setTimeout(processMutationQueue, 200);
    }
  });

  // ─── 初始化 ────────────────────────────────────────────────────────────────
  buildUI();

  // 预加载 OpenCC（静默，不阻塞）
  loadOpenCC().catch(() => {});

  // 启动 DOM 观察（childList 捕获新增节点，characterData 捕获框架就地修改的文本节点）
  domObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

})();
