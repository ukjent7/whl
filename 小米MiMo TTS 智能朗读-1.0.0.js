// ==UserScript==
// @name         MiMo TTS 智能朗读
// @namespace    https://github.com/mimo-tts-reader
// @version      1.0.0
// @description  基于 MiMo-V2.5-TTS 的划词点读与智能全文朗读，支持新闻/小说/文章内容自动识别
// @author       MiMo TTS Reader
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── 配置 ────────────────────────────────────────────────────────────────────
  const CFG_KEY = 'mimo_tts_config';
  const defaultConfig = {
    apiKey: '',
    baseUrl: 'https://api.xiaomimimo.com',
    model: 'mimo-v2.5-tts',
    voice: 'Mia',
    format: 'wav',
    userInstruction: '',
    selectionEnabled: true,
    autoDetectContent: true,
    volume: 1.0,
    panelOpen: false,
  };

  let config = Object.assign({}, defaultConfig, GM_getValue(CFG_KEY, {}));
  function saveConfig() { GM_setValue(CFG_KEY, config); }

  // ─── 音频状态 ─────────────────────────────────────────────────────────────────
  let audioCtx = null;
  let currentSource = null;
  let isPlaying = false;
  let isPaused = false;
  let pauseOffset = 0;
  let startTime = 0;
  let currentBuffer = null;

  function getAudioCtx() {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  // ─── 智能内容提取 ─────────────────────────────────────────────────────────────
  /**
   * 评分候选元素，找出最可能是主内容区的节点
   */
  function extractMainContent() {
    // 优先查找语义化标签
    const semanticSelectors = [
      'article',
      '[role="main"]',
      'main',
      '.article-content',
      '.post-content',
      '.entry-content',
      '.content-body',
      '.news-content',
      '.article-body',
      '.story-body',
      '#article-content',
      '#main-content',
      '#content',
      '.chapter-content',
      '.read-content',
      '.novel-content',
      '.book-content',
      '.text-content',
    ];

    for (const sel of semanticSelectors) {
      const el = document.querySelector(sel);
      if (el && getTextLength(el) > 200) return cleanText(el.innerText);
    }

    // 启发式评分：找文字密度最高的块
    const candidates = Array.from(
      document.querySelectorAll('div, section, td')
    ).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 400 && getTextLength(el) > 200;
    });

    if (candidates.length === 0) {
      return cleanText(document.body.innerText);
    }

    // 评分：文字数 / (链接文字数 + 1)，文字密度高的胜出
    let best = null;
    let bestScore = -1;
    for (const el of candidates) {
      const allText = getTextLength(el);
      const linkText = Array.from(el.querySelectorAll('a'))
        .reduce((s, a) => s + (a.innerText || '').length, 0);
      const score = allText - linkText * 2;
      // 排除包含太多子div的（导航/列表类）
      const childDivCount = el.querySelectorAll('div').length;
      const density = score / (childDivCount + 1);
      if (density > bestScore) {
        bestScore = density;
        best = el;
      }
    }

    return best ? cleanText(best.innerText) : cleanText(document.body.innerText);
  }

  function getTextLength(el) {
    return (el.innerText || '').replace(/\s+/g, '').length;
  }

  function cleanText(text) {
    return text
      .replace(/\t/g, ' ')
      .replace(/[ \u00A0]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/gm, '')
      .trim()
      .slice(0, 8000); // 避免超长
  }

  // ─── TTS API 调用 ─────────────────────────────────────────────────────────────
  async function synthesize(text, instruction = '') {
    if (!config.apiKey) {
      showToast('⚠️ 请先在设置面板填写 API Key', 'warn');
      return null;
    }
    if (!config.baseUrl) {
      showToast('⚠️ 请先在设置面板填写 Base URL', 'warn');
      return null;
    }

    const messages = [];
    if (instruction || config.userInstruction) {
      messages.push({ role: 'user', content: instruction || config.userInstruction });
    }
    messages.push({ role: 'assistant', content: text });

    const body = {
      model: config.model,
      messages,
      audio: { format: 'wav', voice: config.voice },
    };

    if (config.model === 'mimo-v2.5-tts-voicedesign') {
      if (!messages.find(m => m.role === 'user')) {
        messages.unshift({ role: 'user', content: 'Natural, clear reading voice.' });
      }
      body.audio.optimize_text_preview = false;
    }

    setLoading(true);

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: config.baseUrl.replace(/\/$/, '') + '/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          'api-key': config.apiKey,
        },
        data: JSON.stringify(body),
        onload(resp) {
          setLoading(false);
          try {
            const data = JSON.parse(resp.responseText);
            if (data.error) {
              // 直透 API 原始错误，不做二次封装
              const e = data.error;
              const parts = [];
              if (resp.status) parts.push(`HTTP ${resp.status}`);
              if (e.code)    parts.push(`[${e.code}]`);
              if (e.type)    parts.push(`(${e.type})`);
              const prefix = parts.length ? parts.join(' ') + ' ' : '';
              showError(prefix + (e.message || JSON.stringify(e)));
              return resolve(null);
            }
            const audioData = data.choices?.[0]?.message?.audio?.data;
            if (!audioData) {
              // 没有 error 字段但也没音频，把整个响应体展示出来方便排查
              showError(`未收到音频数据（HTTP ${resp.status}）：${resp.responseText.slice(0, 300)}`);
              return resolve(null);
            }
            resolve(audioData);
          } catch (e) {
            showError(`响应解析失败（HTTP ${resp.status}）：${resp.responseText.slice(0, 200)}`);
            resolve(null);
          }
        },
        onerror(e) {
          setLoading(false);
          showError(`网络请求失败，无法连接到 ${config.baseUrl}，请检查 Base URL 与网络连接`);
          resolve(null);
        },
      });
    });
  }

  // WAV base64 → ArrayBuffer → AudioBuffer → 播放
  async function playBase64Wav(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();

    const buffer = await ctx.decodeAudioData(bytes.buffer);
    currentBuffer = buffer;
    playBuffer(buffer, 0);
  }

  function playBuffer(buffer, offset = 0) {
    stopCurrentSource();
    const ctx = getAudioCtx();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gainNode = ctx.createGain();
    gainNode.gain.value = config.volume;
    source.connect(gainNode);
    gainNode.connect(ctx.destination);
    source.start(0, offset);
    startTime = ctx.currentTime - offset;
    currentSource = source;
    isPlaying = true;
    isPaused = false;
    updatePlayBtn();

    source.onended = () => {
      if (!isPaused) {
        isPlaying = false;
        currentBuffer = null;
        updatePlayBtn();
        showToast('✅ 朗读完毕', 'success');
      }
    };
  }

  function stopCurrentSource() {
    if (currentSource) {
      try { currentSource.onended = null; currentSource.stop(); } catch (_) {}
      currentSource = null;
    }
  }

  function pauseResume() {
    if (!currentBuffer && !isPlaying) return;
    const ctx = getAudioCtx();
    if (isPlaying && !isPaused) {
      pauseOffset = ctx.currentTime - startTime;
      stopCurrentSource();
      isPaused = true;
      isPlaying = false;
      updatePlayBtn();
    } else if (isPaused && currentBuffer) {
      playBuffer(currentBuffer, pauseOffset);
    }
  }

  function stopAll() {
    stopCurrentSource();
    isPlaying = false;
    isPaused = false;
    pauseOffset = 0;
    currentBuffer = null;
    updatePlayBtn();
  }

  // ─── UI ──────────────────────────────────────────────────────────────────────
  GM_addStyle(`
    #mimo-tts-root * { box-sizing: border-box; font-family: 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif; }

    /* 浮动工具栏 */
    #mimo-tts-bar {
      position: fixed;
      bottom: 32px;
      right: 28px;
      z-index: 2147483640;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 10px;
      pointer-events: none;
    }

    /* 划词气泡 */
    #mimo-sel-bubble {
      position: fixed;
      z-index: 2147483641;
      display: none;
      pointer-events: auto;
    }
    #mimo-sel-bubble button {
      background: #1a1a2e;
      color: #e8d5b7;
      border: 1px solid rgba(232,213,183,0.25);
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      transition: background 0.2s;
      white-space: nowrap;
    }
    #mimo-sel-bubble button:hover { background: #2d2d52; }

    /* 主按钮组 */
    .mimo-btn-group {
      display: flex;
      gap: 8px;
      pointer-events: auto;
      align-items: center;
    }

    .mimo-fab {
      width: 48px; height: 48px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.35);
      transition: transform 0.2s, box-shadow 0.2s;
      position: relative;
      flex-shrink: 0;
    }
    .mimo-fab:hover { transform: translateY(-2px); box-shadow: 0 8px 28px rgba(0,0,0,0.45); }
    .mimo-fab:active { transform: scale(0.94); }

    .mimo-fab-main {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #e8d5b7;
      border: 1.5px solid rgba(232,213,183,0.3);
      width: 54px; height: 54px; font-size: 22px;
    }
    .mimo-fab-ctrl {
      background: rgba(26,26,46,0.92);
      color: #c9b99a;
      border: 1px solid rgba(232,213,183,0.18);
      backdrop-filter: blur(12px);
      width: 42px; height: 42px; font-size: 17px;
    }
    .mimo-fab-ctrl:disabled { opacity: 0.35; cursor: not-allowed; }
    .mimo-fab-ctrl:disabled:hover { transform: none; box-shadow: 0 4px 20px rgba(0,0,0,0.35); }

    /* 加载动画 */
    .mimo-fab-main.loading::after {
      content: '';
      position: absolute;
      inset: -3px;
      border-radius: 50%;
      border: 2.5px solid transparent;
      border-top-color: #e8d5b7;
      animation: mimo-spin 0.8s linear infinite;
    }
    @keyframes mimo-spin { to { transform: rotate(360deg); } }

    /* 设置面板 */
    #mimo-panel {
      position: fixed;
      bottom: 100px;
      right: 28px;
      z-index: 2147483639;
      width: 320px;
      background: #0f0f1e;
      border: 1px solid rgba(232,213,183,0.2);
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6);
      pointer-events: auto;
      color: #d4c5aa;
      transform-origin: bottom right;
      transition: transform 0.25s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s;
      display: none;
    }
    #mimo-panel.open {
      display: block;
      animation: mimo-panel-in 0.25s cubic-bezier(0.34,1.56,0.64,1) forwards;
    }
    @keyframes mimo-panel-in {
      from { opacity:0; transform: scale(0.85) translateY(12px); }
      to   { opacity:1; transform: scale(1) translateY(0); }
    }

    #mimo-panel h3 {
      margin: 0 0 16px;
      font-size: 14px;
      font-weight: 600;
      color: #e8d5b7;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      display: flex; align-items: center; gap: 8px;
    }
    #mimo-panel label {
      display: block;
      font-size: 11px;
      color: #9a8c7a;
      margin-bottom: 4px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    #mimo-panel input[type=text],
    #mimo-panel input[type=password],
    #mimo-panel select,
    #mimo-panel textarea {
      width: 100%;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(232,213,183,0.15);
      border-radius: 8px;
      color: #d4c5aa;
      padding: 8px 10px;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
      margin-bottom: 12px;
      resize: none;
    }
    #mimo-panel input:focus,
    #mimo-panel select:focus,
    #mimo-panel textarea:focus {
      border-color: rgba(232,213,183,0.5);
    }
    #mimo-panel select option { background: #1a1a2e; }
    #mimo-panel input[type=range] {
      width: 100%; margin-bottom: 12px; accent-color: #e8d5b7;
    }

    .mimo-toggle-row {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 12px;
    }
    .mimo-toggle-label { font-size: 12px; color: #b8a898; }
    .mimo-toggle {
      position: relative; width: 36px; height: 20px;
    }
    .mimo-toggle input { opacity: 0; width: 0; height: 0; }
    .mimo-toggle-slider {
      position: absolute; inset: 0;
      background: rgba(255,255,255,0.1);
      border-radius: 20px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .mimo-toggle-slider::before {
      content: '';
      position: absolute;
      width: 14px; height: 14px;
      left: 3px; top: 3px;
      background: #6b5f52;
      border-radius: 50%;
      transition: transform 0.2s, background 0.2s;
    }
    .mimo-toggle input:checked + .mimo-toggle-slider { background: rgba(232,213,183,0.25); }
    .mimo-toggle input:checked + .mimo-toggle-slider::before {
      transform: translateX(16px);
      background: #e8d5b7;
    }

    .mimo-save-btn {
      width: 100%;
      background: linear-gradient(135deg, #2a2a4e, #1e1e38);
      color: #e8d5b7;
      border: 1px solid rgba(232,213,183,0.3);
      border-radius: 8px;
      padding: 9px;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.2s;
      margin-top: 4px;
    }
    .mimo-save-btn:hover { background: linear-gradient(135deg, #35355e, #292944); }

    .mimo-divider {
      border: none; border-top: 1px solid rgba(232,213,183,0.1);
      margin: 12px 0;
    }

    /* Toast */
    #mimo-toast-container {
      position: fixed;
      top: 24px;
      right: 24px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }
    .mimo-toast {
      background: #1a1a2e;
      color: #d4c5aa;
      border: 1px solid rgba(232,213,183,0.2);
      border-radius: 10px;
      padding: 10px 16px;
      font-size: 13px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      animation: mimo-toast-in 0.3s ease forwards;
      max-width: 300px;
    }
    .mimo-toast.error { border-color: rgba(255,100,100,0.4); color: #ffaaaa; }
    .mimo-toast.warn  { border-color: rgba(255,200,80,0.4); color: #ffd080; }
    .mimo-toast.success { border-color: rgba(100,220,150,0.4); color: #80dda0; }
    @keyframes mimo-toast-in {
      from { opacity:0; transform: translateX(20px); }
      to   { opacity:1; transform: translateX(0); }
    }

    /* 全文朗读进度条 */
    #mimo-progress {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 3px;
      z-index: 2147483645;
      background: rgba(255,255,255,0.08);
      display: none;
    }
    #mimo-progress-bar {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #c9a96e, #e8d5b7);
      transition: width 0.3s;
    }
  `);

  // ─── 构建 DOM ─────────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.id = 'mimo-tts-root';

  // 顶部进度条
  const progressEl = document.createElement('div');
  progressEl.id = 'mimo-progress';
  progressEl.innerHTML = '<div id="mimo-progress-bar"></div>';

  // 浮动工具栏
  const bar = document.createElement('div');
  bar.id = 'mimo-tts-bar';

  const btnGroup = document.createElement('div');
  btnGroup.className = 'mimo-btn-group';

  const stopBtn = makeCtrlBtn('⏹', '停止');
  const pauseBtn = makeCtrlBtn('⏸', '暂停/继续');
  const fullBtn = makeCtrlBtn('📖', '全文朗读');
  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'mimo-fab mimo-fab-main';
  settingsBtn.title = 'MiMo TTS 设置';
  settingsBtn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z"/><path d="M12 8v4l3 3"/></svg>`;

  [stopBtn, pauseBtn, fullBtn].forEach(b => { b.disabled = true; });

  btnGroup.append(stopBtn, pauseBtn, fullBtn, settingsBtn);
  bar.appendChild(btnGroup);

  // 设置面板
  const panel = document.createElement('div');
  panel.id = 'mimo-panel';
  panel.innerHTML = `
    <h3>🎙 MiMo TTS 设置</h3>

    <label>API Key</label>
    <input type="password" id="mimo-apikey" placeholder="填写你的 MIMO_API_KEY" value="${config.apiKey}" />

    <label>Base URL</label>
    <input type="text" id="mimo-baseurl" placeholder="例：https://api.xiaomimimo.com" value="${config.baseUrl}" />

    <label>模型</label>
    <select id="mimo-model">
      <option value="mimo-v2.5-tts" ${config.model==='mimo-v2.5-tts'?'selected':''}>MiMo-V2.5-TTS（预置音色）</option>
      <option value="mimo-v2.5-tts-voicedesign" ${config.model==='mimo-v2.5-tts-voicedesign'?'selected':''}>VoiceDesign（文字设计音色）</option>
    </select>

    <label>音色 / Voice</label>
    <select id="mimo-voice">
      <option value="冰糖" ${config.voice==='冰糖'?'selected':''}>冰糖（中文女）</option>
      <option value="茉莉" ${config.voice==='茉莉'?'selected':''}>茉莉（中文女）</option>
      <option value="苏打" ${config.voice==='苏打'?'selected':''}>苏打（中文男）</option>
      <option value="白桦" ${config.voice==='白桦'?'selected':''}>白桦（中文男）</option>
      <option value="Mia" ${config.voice==='Mia'?'selected':''}>Mia（英文女）</option>
      <option value="Chloe" ${config.voice==='Chloe'?'selected':''}>Chloe（英文女）</option>
      <option value="Milo" ${config.voice==='Milo'?'selected':''}>Milo（英文男）</option>
      <option value="Dean" ${config.voice==='Dean'?'selected':''}>Dean（英文男）</option>
    </select>

    <label>朗读风格指令（可选）</label>
    <textarea id="mimo-instruction" rows="2" placeholder="例：用温柔舒缓的语调朗读，语速适中">${config.userInstruction}</textarea>

    <label>音量 <span id="mimo-vol-val">${Math.round(config.volume*100)}%</span></label>
    <input type="range" id="mimo-volume" min="0" max="2" step="0.05" value="${config.volume}" />

    <hr class="mimo-divider" />

    <div class="mimo-toggle-row">
      <span class="mimo-toggle-label">划词点读</span>
      <label class="mimo-toggle">
        <input type="checkbox" id="mimo-sel-toggle" ${config.selectionEnabled?'checked':''} />
        <span class="mimo-toggle-slider"></span>
      </label>
    </div>
    <div class="mimo-toggle-row">
      <span class="mimo-toggle-label">智能识别正文（全文朗读）</span>
      <label class="mimo-toggle">
        <input type="checkbox" id="mimo-detect-toggle" ${config.autoDetectContent?'checked':''} />
        <span class="mimo-toggle-slider"></span>
      </label>
    </div>

    <button class="mimo-save-btn" id="mimo-save">保存设置</button>
  `;

  // 划词气泡
  const selBubble = document.createElement('div');
  selBubble.id = 'mimo-sel-bubble';
  selBubble.innerHTML = `<button id="mimo-read-sel">🔊 朗读选中</button>`;

  // Toast 容器
  const toastContainer = document.createElement('div');
  toastContainer.id = 'mimo-toast-container';

  root.append(progressEl, bar, panel, selBubble, toastContainer);
  document.documentElement.appendChild(root);

  function makeCtrlBtn(icon, title) {
    const b = document.createElement('button');
    b.className = 'mimo-fab mimo-fab-ctrl';
    b.title = title;
    b.textContent = icon;
    return b;
  }

  // ─── 事件绑定 ─────────────────────────────────────────────────────────────────

  // 设置面板开关
  settingsBtn.addEventListener('click', () => {
    const isOpen = panel.classList.contains('open');
    if (isOpen) {
      panel.classList.remove('open');
      panel.style.display = 'none';
    } else {
      panel.style.display = 'block';
      requestAnimationFrame(() => panel.classList.add('open'));
    }
  });

  // 音量实时显示
  panel.querySelector('#mimo-volume').addEventListener('input', e => {
    panel.querySelector('#mimo-vol-val').textContent = Math.round(e.target.value * 100) + '%';
  });

  // 保存设置
  panel.querySelector('#mimo-save').addEventListener('click', () => {
    config.apiKey    = panel.querySelector('#mimo-apikey').value.trim();
    config.baseUrl   = panel.querySelector('#mimo-baseurl').value.trim().replace(/\/$/, '');
    config.model     = panel.querySelector('#mimo-model').value;
    config.voice     = panel.querySelector('#mimo-voice').value;
    config.userInstruction = panel.querySelector('#mimo-instruction').value.trim();
    config.volume    = parseFloat(panel.querySelector('#mimo-volume').value);
    config.selectionEnabled   = panel.querySelector('#mimo-sel-toggle').checked;
    config.autoDetectContent  = panel.querySelector('#mimo-detect-toggle').checked;

    // VoiceDesign 不用预置音色选项
    if (config.model === 'mimo-v2.5-tts-voicedesign') {
      showToast('VoiceDesign 模式：请在"风格指令"中描述你想要的音色', 'warn');
    }

    saveConfig();
    showToast('✅ 设置已保存', 'success');
    panel.classList.remove('open');
    panel.style.display = 'none';
  });

  // 全文朗读
  fullBtn.addEventListener('click', async () => {
    if (isPlaying) { stopAll(); return; }
    const text = config.autoDetectContent ? extractMainContent() : cleanText(document.body.innerText);
    if (!text) { showToast('未找到可朗读的文字内容', 'warn'); return; }

    showToast(`📖 正在合成 ${text.length} 字...`, '');
    const b64 = await synthesize(text);
    if (b64) {
      setPlayState(true);
      await playBase64Wav(b64);
    }
  });

  // 暂停/继续
  pauseBtn.addEventListener('click', () => { pauseResume(); });

  // 停止
  stopBtn.addEventListener('click', () => { stopAll(); setPlayState(false); });

  // 划词气泡 - 朗读选中
  selBubble.querySelector('#mimo-read-sel').addEventListener('click', async () => {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    selBubble.style.display = 'none';
    if (!text) return;

    showToast(`🔊 正在合成 "${text.slice(0, 20)}${text.length>20?'…':''}"`, '');
    const b64 = await synthesize(text);
    if (b64) {
      setPlayState(true);
      await playBase64Wav(b64);
    }
  });

  // 监听鼠标抬起，显示划词气泡
  document.addEventListener('mouseup', e => {
    if (!config.selectionEnabled) return;
    // 如果点击在面板/按钮上不触发
    if (root.contains(e.target)) return;

    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text.length > 1) {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        selBubble.style.display = 'block';
        const bubbleW = 130;
        let left = rect.left + rect.width / 2 - bubbleW / 2 + window.scrollX;
        left = Math.max(8, Math.min(left, window.innerWidth - bubbleW - 8));
        const top = rect.top + window.scrollY - 44;
        selBubble.style.left = left + 'px';
        selBubble.style.top  = Math.max(8, top) + 'px';
      } else {
        selBubble.style.display = 'none';
      }
    }, 10);
  });

  // 点击其他地方隐藏气泡
  document.addEventListener('mousedown', e => {
    if (!selBubble.contains(e.target)) {
      selBubble.style.display = 'none';
    }
  });

  // ─── 状态更新 ─────────────────────────────────────────────────────────────────
  function setPlayState(playing) {
    stopBtn.disabled  = !playing;
    pauseBtn.disabled = !playing;
    fullBtn.disabled  = false;
    fullBtn.textContent = playing ? '⏹' : '📖';
    fullBtn.title = playing ? '停止朗读' : '全文朗读';
  }

  function updatePlayBtn() {
    stopBtn.disabled  = !isPlaying && !isPaused;
    pauseBtn.disabled = !isPlaying && !isPaused;
    pauseBtn.textContent = isPaused ? '▶️' : '⏸';
    pauseBtn.title = isPaused ? '继续' : '暂停';
  }

  function setLoading(on) {
    if (on) settingsBtn.classList.add('loading');
    else settingsBtn.classList.remove('loading');
  }

  // ─── 错误弹窗（持久，可点击关闭） ────────────────────────────────────────────────
  function showError(msg) {
    const t = document.createElement('div');
    t.className = 'mimo-toast error';
    t.style.cssText = 'cursor:pointer; max-width:340px; white-space:pre-wrap; line-height:1.5;';
    t.title = '点击关闭';
    // 前缀标识 + 完整原始错误
    t.textContent = '❌ ' + msg;
    const close = document.createElement('span');
    close.textContent = ' ×';
    close.style.cssText = 'float:right; font-size:15px; margin-left:8px; opacity:0.7;';
    t.appendChild(close);
    toastContainer.appendChild(t);
    t.addEventListener('click', () => t.remove());
    // 10 秒后自动淡出（比普通 toast 更久）
    setTimeout(() => {
      if (!t.parentNode) return;
      t.style.opacity = '0';
      t.style.transition = 'opacity 0.4s';
      setTimeout(() => t.remove(), 400);
    }, 10000);
  }


  function showToast(msg, type = '') {
    const t = document.createElement('div');
    t.className = 'mimo-toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transition = 'opacity 0.3s';
      setTimeout(() => t.remove(), 300);
    }, 3500);
  }

  // ─── 首次使用引导 ─────────────────────────────────────────────────────────────
  if (!config.apiKey) {
    setTimeout(() => {
      showToast('👋 欢迎使用 MiMo TTS！请点击右下角按钮，填写 Base URL 与 API Key', '');
    }, 1200);
  }

})();
