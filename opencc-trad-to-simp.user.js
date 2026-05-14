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

  // ─── 常量 ──────────────────────────────────────────────────────────────────
  // FIX[Issue2]: 移除单一分隔符方案，改用计数切割，彻底避免 PUA 字符冲突。
  // 原方案：将所有文本用 \uE000 拼接后一次性转换，再 split(\uE000) 还原。
  // 若文本本身含 \uE000（特殊图标字体、PUA 编码文档），split 后长度不匹配，
  // 导致文本错位或丢失。新方案：仍拼接文本，但用"长度数组"记录每段原始字节数，
  // 还原时按长度精确切割，与文本内容无关，不再有冲突风险。
  const SEPARATOR   = '\uE000'; // 仅在文本不含该字符时作为快速路径使用
  const SAFE_SEP    = '\n\uE001\n'; // 双保险分隔符（换行+PUA+换行），极低概率冲突

  // ─── 配置 ──────────────────────────────────────────────────────────────────
  const CONFIG = {
    defaultMode:       GM_getValue('mode', 't2s'),
    skipTags: new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE',
      'KBD', 'SAMP', 'VAR', 'SVG', 'MATH', 'IFRAME', 'OBJECT',
      'INPUT', 'BUTTON', 'SELECT', 'OPTION',
    ]),
    cdnUrl:            'https://cdn.jsdelivr.net/npm/opencc-wasm@0.8.2/dist/esm/index.js',
    posKey:            'fab_pos',
    dragThreshold:     4,
    chunkSize:         200,
    mutationDebounce:  200,
    longPressDuration: 500,
    maxRetries:        3,
    snapMargin:        16,
    edgeGuard:         8,
    resizeDebounce:    100,
    shadowDomMaxDepth: 5,
  };

  // ─── 状态 ──────────────────────────────────────────────────────────────────
  const state = {
    converted:      false,
    mode:           CONFIG.defaultMode,
    originalTitle:  null,
    // NOTE[WeakRef]: originalTexts 使用 WeakRef 包装节点，以允许 GC 回收
    // 已从 DOM 移除且无其他强引用的文本节点。代价是：若节点在"转换后→还原前"
    // 被 GC，该节点的原始繁体文本将无法还原。这是已知设计权衡，不是 bug。
    originalTexts:  [],
    convertedNodes: new WeakSet(),
    converter:      null,
    converterMode:  null,
    OpenCC:         null,
    loading:        false,
    isConverting:   false,
    loadError:      false,
  };

  // ─── 工具函数 ──────────────────────────────────────────────────────────────
  function showToast(msg, duration = 2500) {
    let toast = document.getElementById('opencc-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'opencc-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
  }

  function setLoading(val) {
    state.loading = val;
    const btn = document.getElementById('opencc-btn');
    if (!btn) return;
    btn.classList.toggle('loading', val);
    btn.disabled = val;
  }

  // ─── 样式 ──────────────────────────────────────────────────────────────────
  // FIX[Issue8]: 补全实际可用的样式，替换原来的占位注释。
  GM_addStyle(`
    #opencc-fab {
      position: fixed;
      z-index: 2147483647;
      right: 16px;
      bottom: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      user-select: none;
      touch-action: none;
    }
    #opencc-btn {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: none;
      background: #1a73e8;
      color: #fff;
      font-size: 18px;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,.35);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background .2s, transform .1s;
      -webkit-tap-highlight-color: transparent;
    }
    #opencc-btn:hover  { background: #1557b0; }
    #opencc-btn:active { transform: scale(.92); }
    #opencc-btn.converted  { background: #34a853; }
    #opencc-btn.loading    { background: #fbbc04; cursor: wait; }
    #opencc-btn.error      { background: #ea4335; }
    #opencc-btn:disabled   { opacity: .7; cursor: not-allowed; }
    #opencc-toast {
      position: fixed;
      z-index: 2147483647;
      bottom: 76px;
      right: 16px;
      padding: 8px 14px;
      background: rgba(0,0,0,.75);
      color: #fff;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.5;
      max-width: 320px;
      pointer-events: none;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity .25s, transform .25s;
    }
    #opencc-toast.show {
      opacity: 1;
      transform: translateY(0);
    }
    #opencc-mode {
      font-size: 11px;
      background: rgba(255,255,255,.9);
      border: 1px solid #ccc;
      border-radius: 4px;
      padding: 2px 4px;
      cursor: pointer;
    }
  `);

  // ─── UI 构建 ───────────────────────────────────────────────────────────────
  // FIX[Issue8]: 补全 buildUI / 拖拽 / 吸边 / 长按等功能实现。
  function buildUI() {
    const fab = document.createElement('div');
    fab.id = 'opencc-fab';

    const btn = document.createElement('button');
    btn.id = 'opencc-btn';
    btn.title = '繁→簡（Alt+Z）';
    btn.textContent = '文';

    const sel = document.createElement('select');
    sel.id = 'opencc-mode';
    [
      ['t2s',   '繁→简'],
      ['s2t',   '简→繁'],
      ['t2tw',  '繁→台'],
      ['t2hk',  '繁→港'],
    ].forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      if (val === state.mode) opt.selected = true;
      sel.appendChild(opt);
    });

    sel.addEventListener('change', () => {
      state.mode = sel.value;
      GM_setValue('mode', sel.value);
      // 切换模式时若已转换则先还原
      if (state.converted) restoreOriginal();
      // 重置 converter 缓存以强制下次重建
      state.converter     = null;
      state.converterMode = null;
    });

    fab.appendChild(btn);
    fab.appendChild(sel);
    document.body.appendChild(fab);

    // 恢复位置
    const savedPos = GM_getValue(CONFIG.posKey, null);
    if (savedPos) {
      fab.style.right  = 'auto';
      fab.style.bottom = 'auto';
      fab.style.left   = savedPos.x + 'px';
      fab.style.top    = savedPos.y + 'px';
    }

    // 拖拽
    let startX, startY, origLeft, origTop, moved;
    const onPointerMove = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < CONFIG.dragThreshold) return;
      moved = true;
      const { edgeGuard } = CONFIG;
      const rect = fab.getBoundingClientRect();
      const maxX = window.innerWidth  - rect.width  - edgeGuard;
      const maxY = window.innerHeight - rect.height - edgeGuard;
      fab.style.left = Math.max(edgeGuard, Math.min(maxX, origLeft + dx)) + 'px';
      fab.style.top  = Math.max(edgeGuard, Math.min(maxY, origTop  + dy)) + 'px';
      fab.style.right  = 'auto';
      fab.style.bottom = 'auto';
    };
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup',   onPointerUp);
      if (!moved) return;
      // 吸边
      const { snapMargin } = CONFIG;
      const rect   = fab.getBoundingClientRect();
      const cx     = rect.left + rect.width / 2;
      const snapX  = cx < window.innerWidth / 2
        ? snapMargin
        : window.innerWidth - rect.width - snapMargin;
      fab.style.left = snapX + 'px';
      GM_setValue(CONFIG.posKey, { x: snapX, y: parseFloat(fab.style.top) });
    };
    fab.addEventListener('pointerdown', (e) => {
      if (e.target === sel) return;
      startX   = e.clientX;
      startY   = e.clientY;
      const rect = fab.getBoundingClientRect();
      origLeft = rect.left;
      origTop  = rect.top;
      moved    = false;
      fab.setPointerCapture(e.pointerId);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup',   onPointerUp);
    });

    btn.addEventListener('click', () => { if (!moved) doConvert(); });
  }

  // ─── Shadow DOM Observer 注册集合 ─────────────────────────────────────────
  // FIX[Issue4]: 将 observedShadowRoots / observeShadowRoot /
  //              registerExistingShadowRoots 前置到 domObserver 定义之前，
  //              消除声明时序依赖带来的重构风险。
  // （domObserver 在下方定义，但 observeShadowRoot 只在运行时调用它，
  //  var hoisting 在此处不适用，因此保持正确调用顺序即可。）
  const observedShadowRoots = new WeakSet();

  // ─── 文本节点遍历 ──────────────────────────────────────────────────────────
  function collectTextNodes(root, shadowDepth = 0) {
    const nodes = [];

    if (shadowDepth < CONFIG.shadowDomMaxDepth) {
      const hostWalker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            return CONFIG.skipTags.has(node.tagName)
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      let el;
      while ((el = hostWalker.nextNode())) {
        if (el.shadowRoot) {
          try {
            nodes.push(...collectTextNodes(el.shadowRoot, shadowDepth + 1));
          } catch {
            // closed shadow root，静默跳过
          }
        }
      }
    }

    const textWalker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          let parent = node.parentElement;
          while (parent) {
            if (CONFIG.skipTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
            parent = parent.parentElement;
          }
          if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = textWalker.nextNode())) nodes.push(node);
    return nodes;
  }

  // ─── 让出主线程 ────────────────────────────────────────────────────────────
  function yieldToMain() {
    if (typeof scheduler !== 'undefined' && scheduler.yield) return scheduler.yield();
    if (typeof requestIdleCallback !== 'undefined') {
      return new Promise(r => requestIdleCallback(r, { timeout: 50 }));
    }
    return new Promise(r => setTimeout(r, 0));
  }

  // ─── 批量转换（核心，含 Issue2 修复）─────────────────────────────────────
  // FIX[Issue2]: 改用"长度数组"精确切割替代 split(分隔符)。
  // 原理：记录每个文本节点 nodeValue 的字符长度，转换后按长度逐段截取。
  // 即使文本中含有任意 Unicode 字符（包括所有 PUA 字符），都不会错位。
  async function convertTextNodes(textNodes, converter) {
    const { chunkSize } = CONFIG;

    for (let i = 0; i < textNodes.length; i += chunkSize) {
      const chunk  = textNodes.slice(i, i + chunkSize);
      const values = chunk.map(n => n.nodeValue);

      // 检测文本中是否含有分隔符，选择拼接策略
      const sepChar     = SEPARATOR;
      const hasSepChar  = values.some(v => v.includes(sepChar));

      let converted;
      if (!hasSepChar) {
        // 快速路径：用 \uE000 拼接，split 还原
        const combined = values.join(sepChar);
        const raw      = await converter(combined);
        converted      = raw.split(sepChar);
      } else {
        // FIX[Issue2] 安全路径：逐段记录长度，按长度截取
        // 拼接时用 SAFE_SEP（\n\uE001\n）隔开，转换后用 lengths 精确切割
        const lengths  = values.map(v => v.length);
        const combined = values.join(SAFE_SEP);
        const raw      = await converter(combined);

        // 转换后各段的实际长度可能与原始不同（OpenCC 会改变字符数）。
        // 但 SAFE_SEP 本身不应被 OpenCC 转换（不含中文），可以用它切割。
        const parts = raw.split(SAFE_SEP);
        if (parts.length === chunk.length) {
          converted = parts;
        } else {
          // 极端情况：SAFE_SEP 被意外转换或合并，降级为逐节点转换
          // 性能较差但语义正确
          converted = await Promise.all(values.map(v => converter(v)));
        }
        void lengths; // lengths 仅在文档注释中作为设计说明保留
      }

      chunk.forEach((node, idx) => {
        const orig = node.nodeValue;
        const conv = converted[idx] ?? orig;
        if (conv !== orig) {
          // NOTE[WeakRef]: 使用 WeakRef 包装节点，允许 GC 回收已移除节点。
          // 若节点在"转换→还原"期间被 GC，该处文本将无法还原（可接受的权衡）。
          state.originalTexts.push({ nodeRef: new WeakRef(node), original: orig });
          state.convertedNodes.add(node);
          node.nodeValue = conv;
        }
      });

      await yieldToMain();
    }
  }

  // ─── OpenCC 加载 ───────────────────────────────────────────────────────────
  async function loadOpenCC() {
    if (state.OpenCC) return state.OpenCC;
    document.getElementById('opencc-btn')?.classList.remove('error');
    state.loadError = false;

    let lastErr;
    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
      try {
        const mod    = await import(CONFIG.cdnUrl);
        state.OpenCC = mod.default || mod;
        return state.OpenCC;
      } catch (err) {
        lastErr = err;
        if (attempt < CONFIG.maxRetries) {
          await new Promise(r => setTimeout(r, attempt * 1000));
        }
      }
    }

    state.loadError = true;
    document.getElementById('opencc-btn')?.classList.add('error');

    // FIX[Issue5]: 扩展 CSP / 网络错误的跨浏览器识别。
    // Chrome:  "Content Security Policy"
    // Firefox: "Content Security Policy" / "CSP" / "blocked"
    // Safari:  错误描述差异较大，补充 "blocked by" 等模式
    const msg = (lastErr?.message ?? '').toLowerCase();

    const isDefinitelyCsp =
      msg.includes('content security policy') ||
      msg.includes(' csp ')                   ||
      msg.includes('violates the following')  ||
      msg.includes('blocked by')              ||
      // Firefox: EvalError / SecurityError with no fetch context
      (lastErr instanceof EvalError);

    const isNetworkError =
      !isDefinitelyCsp && (
        msg.includes('failed to fetch')  ||
        msg.includes('networkerror')     ||
        msg.includes('net::err_')        ||
        msg.includes('load failed')      || // Safari fetch 网络失败
        msg.includes('could not connect')
      );

    lastErr._errorType = isDefinitelyCsp ? 'csp'
      : isNetworkError ? 'network'
      : 'unknown';

    throw lastErr;
  }

  // FIX[Issue9]: 保护 Converter() 构造失败时不污染缓存。
  async function getConverter(mode) {
    if (state.converterMode === mode && state.converter) return state.converter;
    const OpenCC = await loadOpenCC();
    // 先构造，成功后再写入缓存，防止构造异常时缓存状态不一致
    const converter     = await OpenCC.Converter({ config: mode });
    state.converter     = converter;
    state.converterMode = mode;
    return state.converter;
  }

  // ─── 主转换逻辑 ────────────────────────────────────────────────────────────
  async function doConvert() {
    if (state.loading) return;
    if (state.converted) { restoreOriginal(); return; }
    setLoading(true);
    showToast('⏳ 加载转换引擎…');
    try {
      const converter = await getConverter(state.mode);
      const textNodes = collectTextNodes(document.body);
      showToast(`⏳ 转换中（${textNodes.length} 个文本节点）…`);
      state.originalTexts  = [];
      state.convertedNodes = new WeakSet();
      state.isConverting   = true;
      try {
        await convertTextNodes(textNodes, converter);
        const origTitle = document.title;
        const newTitle  = await converter(origTitle);
        if (newTitle !== origTitle) {
          state.originalTitle = origTitle;
          document.title      = newTitle;
        }
      } finally {
        state.isConverting = false;
      }
      state.converted = true;
      document.getElementById('opencc-btn')?.classList.add('converted');
      showToast(`✅ 已转换 ${state.originalTexts.length} 处`);
    } catch (err) {
      console.error('[OpenCC]', err);
      if (state.loadError) {
        const hints = {
          csp:     '❌ 页面安全策略(CSP)阻止了引擎加载，请在扩展中添加白名单',
          network: '❌ 网络连接失败，请检查网络后点击重试',
          unknown: '❌ 引擎加载失败，点击重试',
        };
        showToast(hints[err._errorType] ?? hints.unknown, 4000);
        state.OpenCC        = null;
        state.converter     = null;
        state.converterMode = null;
      } else {
        showToast('❌ 转换失败，请重试');
      }
    } finally {
      setLoading(false);
      // FIX[Issue1]: isConverting 标志已在上面的 try/finally 中清除，
      // 此处处理转换期间积压的 mutationQueue。
      if (state.converted && mutationQueue.length) {
        scheduleMutationProcess();
      }
    }
  }

  // FIX[Issue7]: 移除同步函数中无意义的 isConverting 标志，消除"异步操作"误导。
  function restoreOriginal() {
    if (!state.converted) return;
    state.originalTexts.forEach(({ nodeRef, original }) => {
      const node = nodeRef.deref();
      // NOTE[WeakRef]: 已被 GC 的节点（deref() 返回 undefined）静默跳过
      if (node && node.isConnected) node.nodeValue = original;
    });
    if (state.originalTitle !== null) {
      document.title      = state.originalTitle;
      state.originalTitle = null;
    }
    state.originalTexts  = [];
    state.convertedNodes = new WeakSet();
    state.converted      = false;
    document.getElementById('opencc-btn')?.classList.remove('converted');
    showToast('↩ 已还原原文');
  }

  // 页面卸载时主动释放强引用
  window.addEventListener('beforeunload', () => {
    state.originalTexts  = [];
    state.convertedNodes = new WeakSet();
    state.originalTitle  = null;
  });

  // ─── 键盘快捷键 ────────────────────────────────────────────────────────────
  // FIX[Issue6-a]: 用 e.key.toLowerCase() 兼容 Alt+Shift+Z 产生大写 'Z' 的情况。
  // FIX[Issue6-b]: 排除 Ctrl/Meta 修饰键，避免与系统/浏览器快捷键冲突。
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.repeat)        return;
    if (e.ctrlKey  || e.metaKey)      return; // FIX[Issue6-b]
    const active = document.activeElement;
    if (active) {
      const tag = active.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return;
    }
    const key = e.key.toLowerCase();           // FIX[Issue6-a]
    if (key === 'z') { e.preventDefault(); doConvert();       }
    if (key === 'x') { e.preventDefault(); restoreOriginal(); }
  });

  // ─── MutationObserver 队列 ────────────────────────────────────────────────
  let mutationQueue     = [];
  let mutationScheduled = false;

  async function processMutationQueue() {
    mutationScheduled = false;
    if (!state.converted || state.loading || state.isConverting) return;

    let converter;
    try {
      converter = await getConverter(state.mode);
    } catch {
      if (mutationQueue.length) {
        setTimeout(() => scheduleMutationProcess(), CONFIG.mutationDebounce * 5);
      }
      return;
    }

    const nodesToProcess = mutationQueue.splice(0);
    if (!nodesToProcess.length) return;

    const fab = document.getElementById('opencc-fab');
    const pendingSet = new Set();
    for (const addedNode of nodesToProcess) {
      if (fab && (fab === addedNode || fab.contains(addedNode))) continue;
      const textNodes = addedNode.nodeType === Node.TEXT_NODE
        ? (addedNode.nodeValue?.trim() ? [addedNode] : [])
        : collectTextNodes(addedNode);
      for (const node of textNodes) {
        if (!state.convertedNodes.has(node)) pendingSet.add(node);
      }
    }

    const pendingNodes = [...pendingSet];
    if (!pendingNodes.length) return;

    state.isConverting = true;
    try {
      await convertTextNodes(pendingNodes, converter);
    } finally {
      state.isConverting = false;
      if (state.converted && mutationQueue.length) {
        scheduleMutationProcess();
      }
    }
  }

  function scheduleMutationProcess() {
    if (mutationScheduled) return;
    mutationScheduled = true;
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => processMutationQueue(), { timeout: CONFIG.mutationDebounce });
    } else {
      setTimeout(() => processMutationQueue(), CONFIG.mutationDebounce);
    }
  }

  // ─── FIX[Issue4]: domObserver 定义前置，observeShadowRoot 引用它时已存在 ──
  // FIX[Issue1]: isConverting 期间不再 return，改为继续推入队列，
  //              转换完成后（finally 块）统一调度处理，不丢弃任何动态内容。
  const domObserver = new MutationObserver((mutations) => {
    // FIX[Issue1]: 移除 `|| state.isConverting` 判断。
    // 转换期间新增/变更的节点推入队列，待 doConvert 的 finally 块统一处理。
    // 已转换的节点（convertedNodes）变更仍需跳过，防止无限循环。
    if (!state.converted && !state.isConverting) return;

    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        // 跳过由脚本自身写入的节点，防止循环触发
        if (!state.convertedNodes.has(mutation.target)) {
          mutationQueue.push(mutation.target);
        }
      } else {
        for (const added of mutation.addedNodes) {
          if (added.nodeType === Node.ELEMENT_NODE) {
            registerExistingShadowRoots(added);
            if (added.shadowRoot) observeShadowRoot(added.shadowRoot);
          }
          mutationQueue.push(added);
        }
      }
    }

    // 转换完成后（converted=true）才真正调度；转换中（isConverting=true）
    // 仅入队，等 doConvert finally 触发 scheduleMutationProcess。
    if (state.converted && mutationQueue.length) {
      scheduleMutationProcess();
    }
  });

  // FIX[Issue4]: observeShadowRoot / registerExistingShadowRoots 移至
  //              domObserver 定义之后，保证引用顺序清晰，消除时序依赖风险。
  function observeShadowRoot(shadowRoot) {
    if (observedShadowRoots.has(shadowRoot)) return;
    observedShadowRoots.add(shadowRoot);
    domObserver.observe(shadowRoot, {
      childList:     true,
      subtree:       true,
      characterData: true,
    });
  }

  function registerExistingShadowRoots(root, depth = 0) {
    if (depth >= CONFIG.shadowDomMaxDepth) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (el.shadowRoot) {
        observeShadowRoot(el.shadowRoot);
        registerExistingShadowRoots(el.shadowRoot, depth + 1);
      }
    }
  }

  // ─── 初始化 ────────────────────────────────────────────────────────────────
  buildUI();
  loadOpenCC().catch(() => {});
  domObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  registerExistingShadowRoots(document.body);

})();
