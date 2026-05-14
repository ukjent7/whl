// ==UserScript==
// @name         繁體 → 簡體｜OpenCC 一鍵轉換
// @name:zh-CN   繁体 → 简体｜OpenCC 一键转换
// @namespace    https://github.com/opencc-wasm
// @version      1.7.0
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

  // 重复挂载防护（SPA 软刷新、调试重注入场景）
  if (document.getElementById('opencc-fab')) return;

  // ─── 配置 ──────────────────────────────────────────────────────────────────
  const CONFIG = {
    defaultMode: GM_getValue('mode', 't2s'),
    defaultPos: {
      x: GM_getValue('pos_x', window.innerWidth  - 80),
      y: GM_getValue('pos_y', window.innerHeight - 80),
    },
    skipTags: new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE',
      'KBD', 'SAMP', 'VAR', 'SVG', 'MATH', 'IFRAME', 'OBJECT',
      'INPUT', 'BUTTON', 'SELECT', 'OPTION',
    ]),
    cdnUrl: 'https://cdn.jsdelivr.net/npm/opencc-wasm@0.8.2/dist/esm/index.js',
    chunkSize: 200,
    separator: '\uE000',
  };

  // 预计算 skipTags CSS 选择器（避免在 collectTextNodes 中重复构建）
  const SKIP_SELECTOR = [...CONFIG.skipTags].join(',');

  // ─── 布局常量 ──────────────────────────────────────────────────────────────
  const PANEL_EST_W = 185;
  const PANEL_EST_H = 315;
  const BTN_SIZE    = 52;
  const EDGE_MARGIN = 8;

  // ─── 工具函数 ──────────────────────────────────────────────────────────────

  /**
   * 将坐标限制在 FAB 可见区域内
   * 出现 3 次的 Math.min(Math.max(...)) 统一收口，避免散落的魔法数字
   */
  const clampPos = (x, y) => ({
    x: Math.min(Math.max(x, EDGE_MARGIN), window.innerWidth  - BTN_SIZE - EDGE_MARGIN),
    y: Math.min(Math.max(y, EDGE_MARGIN), window.innerHeight - BTN_SIZE - EDGE_MARGIN),
  });

  // ─── 状态 ──────────────────────────────────────────────────────────────────
  const state = {
    converted:    false,
    mode:         CONFIG.defaultMode,
    converter:    null,
    currentMode:  null,
    OpenCC:       null,
    loading:      false,
    isConverting: false,
    loadError:    false,
    dragging:     false,

    originalMap:       new WeakMap(),  // TextNode → 原始字符串
    convertedRefs:     [],             // WeakRef<TextNode>[]，用于可迭代还原
    convertedSet:      new WeakSet(),  // O(1) 查重
    convertedValueMap: new WeakMap(),  // TextNode → 转换后字符串（震荡检测）

    originalTitle: null,               // 标题独立存储
  };

  // ─── 公共状态操作 ──────────────────────────────────────────────────────────

  /**
   * 将单个节点的转换结果写入状态并更新 DOM
   * 原 doConvert / processMutationQueue 中重复的 5 行 forEach 逻辑统一收口
   */
  function applyConversion(node, orig, conv) {
    state.originalMap.set(node, orig);
    state.convertedValueMap.set(node, conv);
    state.convertedRefs.push(new WeakRef(node));
    state.convertedSet.add(node);
    node.nodeValue = conv;
  }

  /**
   * 重置所有转换相关状态（不含 UI 操作）
   * doConvert 开头清场、restoreOriginal 结尾清场均使用此函数
   */
  function resetConversionState() {
    state.originalMap       = new WeakMap();
    state.convertedRefs     = [];
    state.convertedSet      = new WeakSet();
    state.convertedValueMap = new WeakMap();
    state.converted         = false;
  }

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
      50%       { opacity: 0.5; }
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

    #opencc-btn.loading .opencc-label   { display: none; }
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

    .opencc-action-btn:hover { background: rgba(80,60,200,0.4); }
  `);

  // ─── 弹出方向计算 ──────────────────────────────────────────────────────────
  // 保留 JS 计算：面板需要同时处理水平/垂直共 4 种方向组合，
  // 纯 CSS position:absolute 无法保证不超出视口，JS 方案更可靠。
  function updatePopupDirection() {
    const fab   = document.getElementById('opencc-fab');
    const panel = document.getElementById('opencc-panel');
    const toast = document.getElementById('opencc-toast');
    if (!fab || !panel || !toast) return;

    const fabL = parseInt(fab.style.left, 10);
    const fabT = parseInt(fab.style.top,  10);
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;
    const gap  = 8;

    // 水平：右侧空间不足时向左展开
    const alignLeft = (vw - fabL - BTN_SIZE) >= PANEL_EST_W;
    panel.style.left  = alignLeft ? '0'    : 'auto';
    panel.style.right = alignLeft ? 'auto' : '0';
    toast.style.left  = alignLeft ? '0'    : 'auto';
    toast.style.right = alignLeft ? 'auto' : '0';

    // 垂直：下方空间不足时向上展开
    const alignDown = (vh - fabT - BTN_SIZE) >= PANEL_EST_H;
    const offset    = BTN_SIZE + gap;
    panel.style.top    = alignDown ? `${offset}px` : 'auto';
    panel.style.bottom = alignDown ? 'auto' : `${offset}px`;
    toast.style.top    = alignDown ? `${offset}px` : 'auto';
    toast.style.bottom = alignDown ? 'auto' : `${offset}px`;
  }

  // ─── UI 构建 ───────────────────────────────────────────────────────────────
  function buildUI() {
    const fab = document.createElement('div');
    fab.id = 'opencc-fab';

    // 使用 clampPos 统一边界计算（消除重复的 Math.min/Math.max）
    const { x: initX, y: initY } = clampPos(CONFIG.defaultPos.x, CONFIG.defaultPos.y);
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
    `;

    const toast = document.createElement('div');
    toast.id = 'opencc-toast';

    const btn = document.createElement('button');
    btn.id    = 'opencc-btn';
    btn.title = '单击转换 · 拖动移位 · 右键选项';
    btn.innerHTML = `
      <span class="opencc-label">文</span>
      <div id="opencc-spinner"></div>
    `;

    fab.appendChild(panel);
    fab.appendChild(toast);
    fab.appendChild(btn);
    document.body.appendChild(fab);
    updatePopupDirection();

    // ── 拖拽（Pointer Events）─────────────────────────────────────────────────
    const DRAG_THRESHOLD = 5;
    let dragStartX = 0, dragStartY = 0;
    let fabStartX  = 0, fabStartY  = 0;
    let hasDragged = false;
    let activePointerId = null;

    function resetDragState() {
      btn.classList.remove('dragging');
      state.dragging  = false;
      activePointerId = null;
      hasDragged      = false;
    }

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

      hasDragged     = true;
      state.dragging = true;
      btn.classList.add('dragging');
      closePanel();

      // 使用 clampPos 统一边界计算
      const { x: newX, y: newY } = clampPos(fabStartX + dx, fabStartY + dy);
      fab.style.left = `${newX}px`;
      fab.style.top  = `${newY}px`;
      updatePopupDirection();
    });

    btn.addEventListener('pointerup', async (e) => {
      if (e.pointerId !== activePointerId) return;
      if (!btn.hasPointerCapture(e.pointerId)) return;
      btn.releasePointerCapture(e.pointerId);

      const wasDragging = hasDragged;
      resetDragState();

      if (wasDragging) {
        GM_setValue('pos_x', parseInt(fab.style.left, 10));
        GM_setValue('pos_y', parseInt(fab.style.top,  10));
      } else {
        await doConvert();
      }
    });

    btn.addEventListener('pointercancel', (e) => {
      if (e.pointerId !== activePointerId) return;
      if (hasDragged) {
        GM_setValue('pos_x', parseInt(fab.style.left, 10));
        GM_setValue('pos_y', parseInt(fab.style.top,  10));
      }
      resetDragState();
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!state.dragging) togglePanel();
    });

    // 模式选择（事件代理）
    panel.addEventListener('click', async (e) => {
      const modeBtn = e.target.closest('.opencc-mode-btn');
      if (!modeBtn) return;
      const newMode = modeBtn.dataset.mode;
      if (newMode === state.mode) return;

      state.mode        = newMode;
      state.converter   = null;
      state.currentMode = null;
      GM_setValue('mode', newMode);
      panel.querySelectorAll('.opencc-mode-btn').forEach(b => b.classList.remove('active'));
      modeBtn.classList.add('active');

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

    document.addEventListener('click', (e) => {
      if (!fab.contains(e.target)) closePanel();
    });

    // resize：防抖 300ms 后再持久化，避免拖动窗口边缘时频繁写磁盘
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      const curX = parseInt(fab.style.left, 10);
      const curY = parseInt(fab.style.top,  10);
      const { x: clampedX, y: clampedY } = clampPos(curX, curY);

      if (clampedX !== curX || clampedY !== curY) {
        fab.style.left = `${clampedX}px`;
        fab.style.top  = `${clampedY}px`;
      }
      updatePopupDirection();

      // 防抖写入：仅在位置实际变化时写，且延迟到 resize 结束后
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const finalX = parseInt(fab.style.left, 10);
        const finalY = parseInt(fab.style.top,  10);
        if (finalX !== curX || finalY !== curY) {
          GM_setValue('pos_x', finalX);
          GM_setValue('pos_y', finalY);
        }
      }, 300);
    });
  }

  function togglePanel() { document.getElementById('opencc-panel')?.classList.toggle('open'); }
  function closePanel()  { document.getElementById('opencc-panel')?.classList.remove('open'); }

  let toastTimer = null;
  function showToast(msg, duration = 2000) {
    const toast = document.getElementById('opencc-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
  }

  function setLoading(loading) {
    state.loading = loading;
    document.getElementById('opencc-btn')?.classList.toggle('loading', loading);
  }

  // ─── OpenCC 加载 ───────────────────────────────────────────────────────────
  const MAX_RETRIES = 3;

  async function loadOpenCC() {
    if (state.OpenCC) return state.OpenCC;
    document.getElementById('opencc-btn')?.classList.remove('error');
    state.loadError = false;

    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const mod    = await import(CONFIG.cdnUrl);
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

  async function getConverter(mode) {
    if (state.currentMode === mode && state.converter) return state.converter;
    const OpenCC      = await loadOpenCC();
    state.converter   = OpenCC.Converter({ config: mode });
    state.currentMode = mode;
    return state.converter;
  }

  // ─── 文本节点遍历 ──────────────────────────────────────────────────────────
  // 使用 Generator 替代 TreeWalker：
  //   TreeWalker(SHOW_TEXT) 中 FILTER_REJECT 退化为 FILTER_SKIP，
  //   无法剪枝整棵子树（如跳过整个 <script> 的所有子文本节点），
  //   导致 skipTags 内的每个文本节点仍被逐一检查，白白消耗性能。
  //   Generator 方案在 Element 层级直接 continue 跳过整个子树，
  //   剪枝语义准确，且代码更短更易读。
  function* walkTextNodes(root) {
    for (const child of root.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.nodeValue.trim()) yield child;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        // closest() 从自身开始向上查找，能正确识别 child 本身就是跳过标签的情况
        // isContentEditable 是继承属性，子元素会自动继承父级 contenteditable，
        // 故只需检查 child.isContentEditable 即可覆盖所有层级
        if (child.isContentEditable || child.closest(SKIP_SELECTOR)) continue;
        yield* walkTextNodes(child);
      }
    }
  }

  function collectTextNodes(root) {
    return [...walkTextNodes(root)];
  }

  // ─── 批量转换 ──────────────────────────────────────────────────────────────
  async function batchConvert(nodes, converter) {
    if (!nodes.length) return [];

    const values   = nodes.map(n => n.nodeValue);
    const combined = values.join(CONFIG.separator);
    const result   = await converter(combined);
    const parts    = result.split(CONFIG.separator);

    let pairs;
    if (parts.length === nodes.length) {
      pairs = nodes.map((node, i) => ({ node, orig: values[i], conv: parts[i] }));
    } else {
      // 回落：分隔符对齐失败（原文含 PUA 字符），逐节点串行转换
      console.warn('[OpenCC] 分隔符对齐失败，回落逐节点转换', {
        expected: nodes.length, got: parts.length,
      });
      pairs = [];
      for (let i = 0; i < nodes.length; i++) {
        pairs.push({ node: nodes[i], orig: values[i], conv: await converter(values[i]) });
      }
    }

    return pairs.filter(p => p.conv !== p.orig);
  }

  // ─── 转换核心 ──────────────────────────────────────────────────────────────
  async function doConvert() {
    if (state.loading) return;
    if (state.converted) { restoreOriginal(); return; }

    setLoading(true);
    showToast('⏳ 加载转换引擎…');

    try {
      const converter = await getConverter(state.mode);
      const textNodes = collectTextNodes(document.body);

      showToast(`⏳ 转换中（${textNodes.length} 个节点）…`);

      // 使用公共函数清空状态
      resetConversionState();

      state.isConverting = true;
      try {
        for (let i = 0; i < textNodes.length; i += CONFIG.chunkSize) {
          const chunk   = textNodes.slice(i, i + CONFIG.chunkSize);
          const changed = await batchConvert(chunk, converter);

          // 使用 applyConversion 统一写入，消除重复逻辑
          changed.forEach(({ node, orig, conv }) => applyConversion(node, orig, conv));

          await new Promise(r => setTimeout(r, 0));
        }
      } finally {
        state.isConverting = false;
      }

      // 转换标题
      const origTitle = document.title;
      const newTitle  = await converter(origTitle);
      if (newTitle !== origTitle) {
        state.originalTitle = origTitle;
        document.title      = newTitle;
      }

      state.converted = true;
      document.getElementById('opencc-btn')?.classList.add('converted');
      showToast(`✅ 已转换 ${state.convertedRefs.length} 处`);

    } catch (err) {
      console.error('[OpenCC]', err);
      showToast(
        state.loadError ? '❌ 引擎加载失败，点击重试' : '❌ 转换失败，请重试',
        3500,
      );
      if (state.loadError) {
        state.OpenCC = state.converter = state.currentMode = null;
      }
    } finally {
      setLoading(false);
    }
  }

  // ─── 还原 ──────────────────────────────────────────────────────────────────
  function restoreOriginal() {
    if (!state.converted) return;

    state.isConverting = true;
    try {
      for (const ref of state.convertedRefs) {
        const node = ref.deref();
        if (!node || !node.isConnected) continue;
        const orig = state.originalMap.get(node);
        if (orig !== undefined) node.nodeValue = orig;
      }
      if (state.originalTitle !== null) {
        document.title      = state.originalTitle;
        state.originalTitle = null;
      }
    } finally {
      state.isConverting = false;
    }

    // 使用公共函数清空状态（含 state.converted = false）
    resetConversionState();
    document.getElementById('opencc-btn')?.classList.remove('converted');
    showToast('↩ 已还原原文');
  }

  // ─── 键盘快捷键 ────────────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' || t.isContentEditable) return;

    if (e.altKey && e.key === 'z') { e.preventDefault(); doConvert(); }
    if (e.altKey && e.key === 'x') { e.preventDefault(); restoreOriginal(); }
  });

  // ─── MutationObserver：SPA 动态内容 ───────────────────────────────────────
  const mutationQueue   = new Set();
  let mutationScheduled = false;

  // WeakRef 数组周期性清理阈值：超过此数量时在下次 processMutationQueue 执行清理
  // 避免长生命周期 SPA 中失效 WeakRef 无限堆积导致还原遍历变慢
  const WEAKREF_CLEANUP_THRESHOLD = 500;

  async function processMutationQueue() {
    mutationScheduled = false;
    if (!state.converted || state.loading) return;

    const nodes = [...mutationQueue];
    mutationQueue.clear();
    if (!nodes.length) return;

    // WeakRef 数组膨胀检测：SPA 路由切换后 DOM 被框架销毁，
    // convertedRefs 中的 WeakRef 虽然 deref() 返回 undefined（不再持有引用），
    // 但数组本身不会自动缩减，需主动过滤失效条目
    if (state.convertedRefs.length > WEAKREF_CLEANUP_THRESHOLD) {
      state.convertedRefs = state.convertedRefs.filter(ref => ref.deref() !== undefined);
    }

    const converter = await getConverter(state.mode);
    const fab       = document.getElementById('opencc-fab');

    const pending = [];
    for (const node of nodes) {
      if (fab && (fab === node || fab.contains(node))) continue;
      const textNodes = node.nodeType === Node.TEXT_NODE
        ? (node.nodeValue?.trim() ? [node] : [])
        : collectTextNodes(node);
      for (const tn of textNodes) {
        if (!state.convertedSet.has(tn)) pending.push(tn);
      }
    }

    if (!pending.length) return;

    state.isConverting = true;
    try {
      for (let i = 0; i < pending.length; i += CONFIG.chunkSize) {
        const chunk   = pending.slice(i, i + CONFIG.chunkSize);
        const changed = await batchConvert(chunk, converter);

        // 使用 applyConversion 统一写入，消除重复逻辑
        changed.forEach(({ node, orig, conv }) => applyConversion(node, orig, conv));

        if (pending.length > CONFIG.chunkSize) {
          await new Promise(r => setTimeout(r, 0));
        }
      }
    } finally {
      state.isConverting = false;
    }
  }

  const domObserver = new MutationObserver((mutations) => {
    if (!state.converted || state.isConverting) return;

    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const node = mutation.target;

        if (state.convertedSet.has(node)) {
          const conv = state.convertedValueMap.get(node);
          const orig = state.originalMap.get(node);

          if (node.nodeValue === conv) {
            // 场景B：值未变（框架回写转换值），忽略
            continue;
          }
          if (node.nodeValue === orig) {
            // 场景C：已回到原值，放弃控制权，防止震荡
            state.convertedSet.delete(node);
            continue;
          }
          // 场景A：新内容，重新转换
          state.convertedSet.delete(node);
          mutationQueue.add(node);
        } else {
          mutationQueue.add(node);
        }
      } else {
        for (const added of mutation.addedNodes) {
          mutationQueue.add(added);
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
  loadOpenCC().catch(() => {});
  domObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

})();
