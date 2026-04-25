// ==UserScript==
// @name         免费小说阅读网 - 自动输入查看码
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  自动从页面或URL提取查看码并点击阅读按钮，展示完整章节内容
// @author       You
// @match        *://www.mianfeixiaoshuoyueduwang.com/book/*/*
// @match        *://mianfeixiaoshuoyueduwang.com/book/*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /**
     * 获取查看码
     * 优先从页面内 .red span 提取（最准确），
     * 其次从当前 URL 末段数字提取作为兜底。
     */
    function getCode() {
        // 方法一：直接读取页面上展示的查看码
        const redSpan = document.querySelector('h2.title .red');
        if (redSpan) {
            const code = redSpan.textContent.trim();
            if (/^\d+$/.test(code)) return code;
        }

        // 方法二：从 URL 中提取末段纯数字（如 /book/282/2054039.html → 2054039）
        const match = location.pathname.match(/\/(\d+)\.html$/);
        if (match) return match[1];

        return null;
    }

    function run() {
        const codeInput = document.querySelector('input[name="kk"]');
        const readBtn = document.querySelector('form[name="form"] button.button');

        // 如果没有验证码表单，说明章节本来就是公开的，无需处理
        if (!codeInput || !readBtn) return;

        const code = getCode();
        if (!code) {
            console.warn('[查看码脚本] 未能获取到查看码，请手动输入。');
            return;
        }

        console.log(`[查看码脚本] 提取到查看码：${code}，正在自动提交…`);

        // 填入查看码
        codeInput.value = code;

        // 触发原生 input/change 事件（防止某些框架只监听事件而非 .value）
        codeInput.dispatchEvent(new Event('input', { bubbles: true }));
        codeInput.dispatchEvent(new Event('change', { bubbles: true }));

        // 点击阅读按钮
        readBtn.click();
    }

    // DOMContentLoaded 已过则直接执行，否则等待
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else {
        run();
    }
})();