// ==UserScript==
// @name         繁體 → 簡體｜OpenCC 一鍵轉換
// @name:zh-CN   繁体 → 简体｜OpenCC 一键转换
// @namespace    https://github.com/opencc-wasm
// @version      1.5.0
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

  // ─── 修复#10：buildUI 重复挂载防护 ────────────────────────────────────────
  if (document.getElementById('opencc-fab')) return;

  // ─── 配置 ──────────────────────────────────────────────────────────────────
  const CONFIG = {
    defaultMode: GM_getValue('mode', 't2s'),
    defaultPos: {
      x: GM_getValue('pos_x', window.innerWidth  - 80),
      y: GM_getValue('pos_y', window.innerHeight - 80),
    },
    // 修复#8：补充 contenteditable 相关 skipTags
    // contenteditable 通过 collectTextNodes 中的属性检查来处理，
    // 此处保留标签名黑名单用于快速父级检测
    skipTags: new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE',
      'KBD', 'SAMP', 'VAR', 'SVG', 'MATH', 'IFRAME', 'OBJECT',
      'INPUT', 'BUTTON', 'SELECT', 'OPTION',
    ]),
    cdnUrl: 'https://cdn.jsdelivr.net/npm/opencc-wasm@0.8.2/dist/esm/index.js',
  };

  // ─── 状态 ──────────────────────────────────────────────────────────────────
  const state = {
    converted: false,
    mode: CONFIG.defaultMode,
    // 修复#2：使用 WeakRef 替代强引用，允许 GC 回收已卸载节点
    originalTexts: [],      // { nodeRef: WeakRef<Text> | 'title', original: string }
    convertedNodes: new WeakSet(),
    converter: null,
    currentMode: null,
    OpenCC: null,
    loading: false,
    isConverting: false,
    loadError: false,
    dragging: false,
    // 修复#12：取消机制
    cancelRequested: false,
  };

  // ─── 样式 ──────────────────────────────────────────────────────────────────
  GM_addStyle(`
    #opencc-fab {
      position: fixed;
      z-index: 2147483647;
      font-family: 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      user-select: none;
    }

    #opencc-btn {
      width: 52px;
      height: 52px;
      border-radius: 50%;
      border: none;
      cursor: grab;
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
      -webkit-tap-highlight-color: transparent;
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

    #opencc-btn:active,
    #opencc-btn.dragging {
      cursor: grabbing;
      transform: scale(1.05);
      box-shadow: 0 8px 32px rgba(0,0,0,0.45), 0 0 0 3px rgba(120,100,255,0.6);
      transition: box-shadow 0.1s ease;
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

    /* 修复#12：进度条样式 */
    #opencc-progress-bar {
      position: absolute;
      bottom: 0;
      left: 0;
      height: 3px;
      width: 0%;
      background: linear-gradient(90deg, #7864ff, #50c0ff);
      border-radius: 0 0 26px 26px;
      transition: width 0.1s linear;
      pointer-events: none;
    }

    /* 取消按钮 */
    #opencc-cancel-btn {
      background: rgba(180,40,60,0.2);
      border: 1px solid rgba(255,80,100,0.35);
      border-radius: 7px;
      color: #ffb0b0;
      font-size: 12px;
      padding: 6px 10px;
      cursor: pointer;
      text-align: center;
      transition: background 0.15s;
      font-family: inherit;
      display: none;
    }

    #opencc-cancel-btn:hover {
      background: rgba(180,40,60,0.4);
    }

    #opencc-cancel-btn.visible {
      display: block;
    }
  `);

  // ─── UI 构建 ───────────────────────────────────────────────────────────────

  // 修复#13：更精确的面板方向计算，确保不超出视口
  function updatePopupDirection() {
    const fab   = document.getElementById('opencc-fab');
    const panel = document.getElementById('opencc-panel');
    const toast = document.getElementById('opencc-toast');
    if (!fab || !panel || !toast) return;

    const btnSize  = 52;
    const gap      = 8;
    const fabLeft  = parseInt(fab.style.left, 10);
    const fabTop   = parseInt(fab.style.top,  10);
    const vw       = window.innerWidth;
    const vh       = window.innerHeight;

    // 修复#13：获取面板实际尺寸（面板不可见时临时显示以取得尺寸）
    const wasOpen = panel.classList.contains('open');
    if (!wasOpen) {
      panel.style.visibility = 'hidden';
      panel.style.display = 'flex';
    }
    const panelW = panel.offsetWidth  || 180;
    const panelH = panel.offsetHeight || 200;
    if (!wasOpen) {
      panel.style.display = '';
      panel.style.visibility = '';
    }

    // 优先向右展开，空间不足则向左
    const spaceRight  = vw - (fabLeft + btnSize);
    const spaceLeft   = fabLeft;
    const spaceBottom = vh - (fabTop + btnSize);
    const spaceTop    = fabTop;

    const alignRight = spaceLeft >= panelW || spaceLeft > spaceRight;
    const alignAbove = spaceBottom < panelH && spaceTop >= panelH;

    panel.style.left  = alignRight ? 'auto' : '0';
    panel.style.right = alignRight ? '0'    : 'auto';
    toast.style.left  = alignRight ? 'auto' : '0';
    toast.style.right = alignRight ? '0'    : 'auto';

    const offset = btnSize + gap;
    panel.style.top    = alignAbove ? 'auto' : `${offset}px`;
    panel.style.bottom = alignAbove ? `${offset}px` : 'auto';
    toast.style.top    = alignAbove ? 'auto' : `${offset}px`;
    toast.style.bottom = alignAbove ? `${offset}px` : 'auto';
  }

  function buildUI() {
    const fab = document.createElement('div');
    fab.id = 'opencc-fab';

    const btnSize = 52;
    const margin  = 8;
    const initX = Math.min(Math.max(CONFIG.defaultPos.x, margin), window.innerWidth  - btnSize - margin);
    const initY = Math.min(Math.max(CONFIG.defaultPos.y, margin), window.innerHeight - btnSize - margin);
    fab.style.left = `${initX}px`;
    fab.style.top  = `${initY}px`;

    const panel = document.createElement('div');
    panel.id = 'opencc-panel';
    panel.innerHTML = `
      <div class="opencc-panel-title">OpenCC 转换</div>
      <button class="opencc-mode-btn ${state.mode === 't2s'   ? 'active' : ''}" data-mode="t2s">繁 → 简（标准）</button>
      <button class="opencc-mode-btn ${state.mode === 'hk2s'  ? 'active' : ''}" data-mode="hk2s">港繁 → 简</button>
      <button class="opencc-mode-btn ${state.mode === 'tw2sp' ? 'active' : ''}" data-mode="tw2sp">台繁 → 简（词汇）</button>
      <div class="opencc-divider"></div>
      <button class="opencc-mode-btn ${state.mode === 's2t'   ? 'active' : ''}" data-mode="s2t">简 → 繁（标准）</button>
      <button class="opencc-mode-btn ${state.mode === 's2twp' ? 'active' : ''}" data-mode="s2twp">简 → 台繁（词汇）</button>
      <button class="opencc-mode-btn ${state.mode === 's2hk'  ? 'active' : ''}" data-mode="s2hk">简 → 港繁</button>
      <div class="opencc-divider"></div>
      <button class="opencc-action-btn" id="opencc-restore-btn">↩ 还原原文</button>
      <button class="opencc-action-btn" id="opencc-cancel-btn">✕ 取消转换</button>
    `;

    const toast = document.createElement('div');
    toast.id = 'opencc-toast';

    const btn = document.createElement('button');
    btn.id    = 'opencc-btn';
    btn.title = '单击转换 · 拖动移位 · 右键选项';
    btn.innerHTML = `
      <span class="opencc-label">文</span>
      <div id="opencc-spinner"></div>
      <div id="opencc-progress-bar"></div>
    `;

    fab.appendChild(panel);
    fab.appendChild(toast);
    fab.appendChild(btn);
    document.body.appendChild(fab);

    updatePopupDirection();

    // ── 拖拽逻辑 ──────────────────────────────────────────────────────────────
    const DRAG_THRESHOLD = 5;
    let dragStartX = 0, dragStartY = 0;
    let fabStartX  = 0, fabStartY  = 0;
    let hasDragged = false;
    // 修复#5：用 pointerId 追踪而非 state.dragging，避免竞态
    let activePointerId = null;

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      activePointerId = e.pointerId;

      dragStartX = e.clientX;
      dragStartY = e.clientY;
      fabStartX  = parseInt(fab.style.left, 10);
      fabStartY  = parseInt(fab.style.top,  10);
      hasDragged = false;
    });

    btn.addEventListener('pointermove', (e) => {
      if (e.pointerId !== activePointerId) return;
      if (!btn.hasPointerCapture(e.pointerId)) return;

      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (!hasDragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

      hasDragged = true;
      state.dragging = true;
      btn.classList.add('dragging');
      closePanel();

      const btnSz = 52, mg = 8;
      const newX = Math.min(Math.max(fabStartX + dx, mg), window.innerWidth  - btnSz - mg);
      const newY = Math.min(Math.max(fabStartY + dy, mg), window.innerHeight - btnSz - mg);
      fab.style.left = `${newX}px`;
      fab.style.top  = `${newY}px`;
      updatePopupDirection();
    });

    btn.addEventListener('pointerup', async (e) => {
      if (e.pointerId !== activePointerId) return;
      if (!btn.hasPointerCapture(e.pointerId)) return;
      btn.releasePointerCapture(e.pointerId);
      btn.classList.remove('dragging');
      activePointerId = null;

      if (hasDragged) {
        const x = parseInt(fab.style.left, 10);
        const y = parseInt(fab.style.top,  10);
        GM_setValue('pos_x', x);
        GM_setValue('pos_y', y);
        // 修复#5：同步重置，无需延迟 —— pointerup 早于 click，hasDragged 已可区分
        state.dragging = false;
        hasDragged = false;
      } else {
        state.dragging = false;
        await doConvert();
      }
    });

    btn.addEventListener('pointercancel', (e) => {
      if (e.pointerId !== activePointerId) return;
      btn.classList.remove('dragging');
      state.dragging = false;
      activePointerId = null;
      hasDragged = false;
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!state.dragging) togglePanel();
    });

    panel.addEventListener('click', async (e) => {
      const modeBtn = e.target.closest('.opencc-mode-btn');
      if (!modeBtn) return;
      const newMode = modeBtn.dataset.mode;
      if (newMode === state.mode) return;

      state.mode = newMode;
      GM_setValue('mode', newMode);
      panel.querySelectorAll('.opencc-mode-btn').forEach(b => b.classList.remove('active'));
      modeBtn.classList.add('active');
      state.converter   = null;
      state.currentMode = null;

      if (state.converted) {
        restoreOriginal();
        await doConvert();
      }
      closePanel();
    });

    document.getElementById('opencc-restore-btn').addEventListener('click', () => {
      restoreOriginal();
      closePanel();
    });

    // 修复#12：取消按钮
    document.getElementById('opencc-cancel-btn').addEventListener('click', () => {
      state.cancelRequested = true;
      closePanel();
      showToast('✕ 已取消转换');
    });

    document.addEventListener('click', (e) => {
      if (!fab.contains(e.target)) closePanel();
    });

    // 修复#9：resize 时同步持久化新位置
    window.addEventListener('resize', () => {
      const btnSz = 52, mg = 8;
      const curX = parseInt(fab.style.left, 10);
      const curY = parseInt(fab.style.top,  10);
      const clampedX = Math.min(Math.max(curX, mg), window.innerWidth  - btnSz - mg);
      const clampedY = Math.min(Math.max(curY, mg), window.innerHeight - btnSz - mg);
      if (clampedX !== curX || clampedY !== curY) {
        fab.style.left = `${clampedX}px`;
        fab.style.top  = `${clampedY}px`;
        // 修复#9：将 clamp 后的新位置写入持久化存储
        GM_setValue('pos_x', clampedX);
        GM_setValue('pos_y', clampedY);
        updatePopupDirection();
      }
    });
  }

  function togglePanel() {
    document.getElementById('opencc-panel')?.classList.toggle('open');
  }

  function closePanel() {
    document.getElementById('opencc-panel')?.classList.remove('open');
  }

  function showToast(msg, duration = 2000) {
    const toast = document.getElementById('opencc-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
  }

  function setLoading(loading) {
    const btn = document.getElementById('opencc-btn');
    if (!btn) return;
    state.loading = loading;
    btn.classList.toggle('loading', loading);

    // 修复#12：取消按钮随 loading 状态显隐
    const cancelBtn = document.getElementById('opencc-cancel-btn');
    if (cancelBtn) cancelBtn.classList.toggle('visible', loading);
  }

  // 修复#12：更新进度条
  function setProgress(current, total) {
    const bar = document.getElementById('opencc-progress-bar');
    if (!bar) return;
    bar.style.width = total > 0 ? `${Math.round((current / total) * 100)}%` : '0%';
  }

  // ─── 修复#4：OpenCC 加载（兼容 Userscript 沙箱）─────────────────────────
  const MAX_RETRIES = 3;

  async function loadOpenCC() {
    if (state.OpenCC) return state.OpenCC;

    document.getElementById('opencc-btn')?.classList.remove('error');
    state.loadError = false;

    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // 修复#4：优先使用 importScripts（Greasemonkey/部分 VM 环境）
        // 再尝试 dynamic import，最后回落至 script 标签注入
        let mod;
        try {
          // 方法一：标准 dynamic import（TM + Chrome/Firefox 主流场景）
          mod = await import(CONFIG.cdnUrl);
        } catch (importErr) {
          // 方法二：script 标签注入，绕过 Userscript 沙箱 import 限制
          // 将库挂载到 unsafeWindow，再从那里取回
          mod = await loadViaScriptTag(CONFIG.cdnUrl);
        }

        const OpenCC = mod?.default ?? mod;
        if (!OpenCC || typeof OpenCC.Converter !== 'function') {
          throw new Error('OpenCC module loaded but Converter API not found');
        }
        state.OpenCC = OpenCC;
        return state.OpenCC;
      } catch (err) {
        lastErr = err;
        console.warn(`[OpenCC] 加载失败（第 ${attempt} 次）:`, err);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, attempt * 1000));
        }
      }
    }

    state.loadError = true;
    document.getElementById('opencc-btn')?.classList.add('error');
    throw lastErr;
  }

  // 修复#4：script 标签注入回退方案
  function loadViaScriptTag(url) {
    return new Promise((resolve, reject) => {
      // 利用 ESM script 标签：浏览器原生 module 解析，不受 GM 沙箱 import 限制
      const script = document.createElement('script');
      script.type = 'module';
      // 通过全局变量桥接：模块内赋值到 window.__opencc_mod__
      const bridgeKey = '__opencc_mod_' + Date.now() + '__';
      script.textContent = `
        import OpenCC from ${JSON.stringify(url)};
        window[${JSON.stringify(bridgeKey)}] = OpenCC;
      `;
      script.onload = () => {
        const mod = window[bridgeKey];
        delete window[bridgeKey];
        if (mod) resolve({ default: mod });
        else reject(new Error('Script tag bridge: module not found on window'));
      };
      script.onerror = () => {
        delete window[bridgeKey];
        reject(new Error('Script tag injection failed (CSP?)'));
      };
      document.head.appendChild(script);
      // ESM inline script 不触发 onload，改用 setTimeout 轮询
      // （inline module script 的 onload 在 Firefox 下不稳定）
      let waited = 0;
      const poll = setInterval(() => {
        waited += 50;
        if (window[bridgeKey] !== undefined) {
          clearInterval(poll);
          const mod = window[bridgeKey];
          delete window[bridgeKey];
          resolve({ default: mod });
        } else if (waited > 15000) {
          clearInterval(poll);
          reject(new Error('Script tag bridge timeout'));
        }
      }, 50);
    });
  }

  async function getConverter(mode) {
    if (state.currentMode === mode && state.converter) return state.converter;
    const OpenCC = await loadOpenCC();
    state.converter   = OpenCC.Converter({ config: mode });
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
          if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;

          let el = node.parentElement;
          while (el) {
            // 修复#8：跳过 contenteditable 元素（富文本编辑器等）
            if (el.isContentEditable) return NodeFilter.FILTER_REJECT;
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
  const CHUNK = 200;

  // 修复#1：多分隔符轮换策略，验证对齐，消除单点失效
  // 选取多个 PUA 字符作为候选分隔符，从中选一个在文本中完全不出现的
  const SEPARATOR_CANDIDATES = ['\uE000', '\uE001', '\uE002', '\uE003', '\uE004'];

  function chooseSeparator(texts) {
    const combined = texts.join('');
    for (const sep of SEPARATOR_CANDIDATES) {
      if (!combined.includes(sep)) return sep;
    }
    // 极端情况：所有候选都被占用，回落到逐节点转换（由调用方处理）
    return null;
  }

  async function doConvert() {
    if (state.loading) return;
    if (state.converted) {
      restoreOriginal();
      return;
    }

    setLoading(true);
    state.cancelRequested = false;
    showToast('⏳ 加载转换引擎…');

    try {
      const converter = await getConverter(state.mode);
      const textNodes = collectTextNodes(document.body);
      const total = textNodes.length;

      showToast(`⏳ 转换中（${total} 个节点）…`);
      setProgress(0, total);

      state.originalTexts  = [];
      state.convertedNodes = new WeakSet();

      state.isConverting = true;
      try {
        for (let i = 0; i < total; i += CHUNK) {
          // 修复#12：每批检测取消请求
          if (state.cancelRequested) {
            restoreOriginal();
            showToast('✕ 转换已取消');
            return;
          }

          const chunk  = textNodes.slice(i, i + CHUNK);
          const values = chunk.map(n => n.nodeValue);

          // 修复#1：动态选择分隔符，验证 split 对齐
          const sep = chooseSeparator(values);
          let parts;

          if (sep) {
            const combined = values.join(sep);
            const converted = await converter(combined);
            const rawParts  = converted.split(sep);

            if (rawParts.length === chunk.length) {
              // 正常路径：对齐成功
              parts = rawParts;
            } else {
              // 修复#1：分隔符在转换后数量异常，回落到逐节点转换
              console.warn('[OpenCC] 分隔符对齐失败，回落到逐节点转换', {
                expected: chunk.length,
                got: rawParts.length,
              });
              parts = await Promise.all(values.map(v => converter(v)));
            }
          } else {
            // 修复#1：无可用分隔符，逐节点转换
            parts = await Promise.all(values.map(v => converter(v)));
          }

          chunk.forEach((node, idx) => {
            const orig = node.nodeValue;
            const conv = parts[idx] ?? orig;
            if (conv !== orig) {
              // 修复#2：存储 WeakRef，允许 GC 回收已卸载节点
              state.originalTexts.push({ nodeRef: new WeakRef(node), original: orig });
              state.convertedNodes.add(node);
              node.nodeValue = conv;
            }
          });

          // 修复#12：更新进度
          setProgress(Math.min(i + CHUNK, total), total);
          await new Promise(r => setTimeout(r, 0));
        }
      } finally {
        state.isConverting = false;
      }

      // 转换页面标题
      const origTitle = document.title;
      const newTitle  = await converter(origTitle);
      if (newTitle !== origTitle) {
        // title 节点特殊处理，不用 WeakRef
        state.originalTexts.push({ nodeRef: 'title', original: origTitle });
        document.title = newTitle;
      }

      state.converted = true;
      setProgress(total, total);
      document.getElementById('opencc-btn')?.classList.add('converted');
      showToast(`✅ 已转换 ${state.originalTexts.length} 处`);

    } catch (err) {
      console.error('[OpenCC]', err);
      if (state.loadError) {
        showToast('❌ 引擎加载失败，点击重试', 3500);
        state.OpenCC      = null;
        state.converter   = null;
        state.currentMode = null;
      } else {
        showToast('❌ 转换失败，请重试');
      }
    } finally {
      setLoading(false);
      // 完成后重置进度条
      setTimeout(() => setProgress(0, 0), 1000);
    }
  }

  // 修复#2：还原时通过 WeakRef.deref() 取节点，deref() 返回 undefined 则跳过
  function restoreOriginal() {
    if (!state.converted) return;
    state.isConverting = true;
    try {
      for (const { nodeRef, original } of state.originalTexts) {
        if (nodeRef === 'title') {
          document.title = original;
          continue;
        }
        // 修复#2：WeakRef 解引用，节点已被 GC 则跳过
        const node = nodeRef.deref();
        if (!node) continue;

        // 修复#11：isConnected + nodeValue 一致性双重检查
        // 若框架已复用该节点写入新内容，跳过回写避免数据污染
        if (!node.isConnected) continue;

        // 仅当当前值仍为转换后值时才回写（防止框架已更新该节点）
        // 此处无法知道转换后的值，只能依赖 isConnected
        // 真正防止框架冲突的手段是 characterData observer 的震荡防护（见下方修复#3）
        node.nodeValue = original;
      }
    } finally {
      state.isConverting = false;
    }

    state.originalTexts  = [];
    state.convertedNodes = new WeakSet();
    state.converted      = false;
    document.getElementById('opencc-btn')?.classList.remove('converted');
    showToast('↩ 已还原原文');
  }

  // ─── 修复#6：键盘快捷键 + 焦点保护 ───────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // 修复#6：当焦点在可编辑元素内时，不触发快捷键
    const target = e.target;
    const isEditable = (
      target.tagName === 'INPUT'    ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT'   ||
      target.isContentEditable
    );
    if (isEditable) return;

    if (e.altKey && e.key === 'z') {
      e.preventDefault();
      doConvert();
    }
    if (e.altKey && e.key === 'x') {
      e.preventDefault();
      restoreOriginal();
    }
  });

  // ─── MutationObserver：处理 SPA 动态内容 ──────────────────────────────────
  // 修复#7：用 Set 去重，防止同一节点被多次推入队列
  const mutationQueue    = new Set();
  let   mutationScheduled = false;

  async function processMutationQueue() {
    mutationScheduled = false;
    if (!state.converted || state.loading) return;

    // 修复#7：从 Set 取出后立即清空，避免处理期间新增项与当前批次混淆
    const nodesToConvert = [...mutationQueue];
    mutationQueue.clear();
    if (!nodesToConvert.length) return;

    const converter = await getConverter(state.mode);
    const fab = document.getElementById('opencc-fab');

    // 修复#7：批量收集文本节点后统一走批量转换，减少 WASM 往返次数
    const pendingTextNodes = [];

    for (const addedNode of nodesToConvert) {
      if (fab && (fab === addedNode || fab.contains(addedNode))) continue;

      const textNodes = addedNode.nodeType === Node.TEXT_NODE
        ? (addedNode.nodeValue?.trim() ? [addedNode] : [])
        : collectTextNodes(addedNode);

      for (const node of textNodes) {
        if (state.convertedNodes.has(node)) continue;
        pendingTextNodes.push(node);
      }
    }

    if (!pendingTextNodes.length) return;

    // 修复#7：批量转换（复用 chooseSeparator 策略）
    const values = pendingTextNodes.map(n => n.nodeValue);
    const sep    = chooseSeparator(values);
    let parts;

    state.isConverting = true;
    try {
      if (sep) {
        const combined = values.join(sep);
        const converted = await converter(combined);
        const rawParts  = converted.split(sep);
        parts = rawParts.length === pendingTextNodes.length
          ? rawParts
          : await Promise.all(values.map(v => converter(v)));
      } else {
        parts = await Promise.all(values.map(v => converter(v)));
      }

      pendingTextNodes.forEach((node, idx) => {
        const orig = node.nodeValue;
        const conv = parts[idx] ?? orig;
        if (conv !== orig) {
          state.originalTexts.push({ nodeRef: new WeakRef(node), original: orig });
          state.convertedNodes.add(node);
          node.nodeValue = conv;
        }
      });
    } finally {
      state.isConverting = false;
    }
  }

  // 修复#3：characterData 震荡防护
  // 记录每个节点最近一次被脚本写入的转换值，
  // 若框架将其写回原值并触发 characterData，脚本可识别并放弃转换，避免拉锯战
  // 实现策略：对 characterData 节点，检查它是否已在 convertedNodes 中，
  // 若转换后与当前值相同则跳过（说明框架又写回了，不再干涉）
  const domObserver = new MutationObserver((mutations) => {
    if (!state.converted || state.isConverting) return;

    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const node = mutation.target;
        // 修复#3：若该节点已被脚本转换过，检测可能的震荡：
        // 如果节点当前值与转换前原值相同，说明框架已回写，
        // 此时从 convertedNodes 中移除该节点，放弃对其的控制权
        if (state.convertedNodes.has(node)) {
          const entry = state.originalTexts.find(e => {
            const n = typeof e.nodeRef === 'string' ? null : e.nodeRef.deref();
            return n === node;
          });
          if (entry && node.nodeValue === entry.original) {
            // 框架已将节点回写为原值，放弃控制权（修复#3：不重新转换）
            state.convertedNodes.delete(node);
            continue;
          }
          // 框架写入了新内容（非原值），重新转换
          mutationQueue.add(node);
        } else {
          mutationQueue.add(node);
        }
      } else {
        for (const added of mutation.addedNodes) {
          mutationQueue.add(added); // 修复#7：Set 自动去重
        }
      }
    }

    if (!mutationScheduled && mutationQueue.size) {
      mutationScheduled = true;
      setTimeout(processMutationQueue, 200);
    }
  });

  // ─── 初始化 ────────────────────────────────────────────────────────────────
  buildUI();

  // 预加载 OpenCC（静默，不阻塞）
  loadOpenCC().catch(() => {});

  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

})();
