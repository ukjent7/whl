// ==UserScript==
// @name         Force Noto Sans SC
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  强制 czbooks 使用 Noto Sans SC 字体
// @author       -
// @match        https://czbooks.net/*
// @run-at       document-start
// @grant        GM_addStyle
// ==/UserScript==

GM_addStyle(`
    @layer userscript {
        body, p, div, span, h1, h2, h3, h4, h5, h6, a, li, td, th,
        input, textarea, button, label, blockquote {
            font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
        }

        code, pre, kbd, samp {
            font-family: ui-monospace, Consolas, monospace;
        }
    }
`);
