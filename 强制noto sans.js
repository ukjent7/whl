// ==UserScript==
// @name         Force Noto Sans SC
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  强制所有网站使用 Noto Sans SC 字体
// @author       -
// @match        https://czbooks.net/*
// @run-at       document-start
// @grant        GM_addStyle
// ==/UserScript==

GM_addStyle(`
    body, p, div, span, h1, h2, h3, h4, h5, h6, a, li, td, th, input, textarea {
        font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif !important;
    }
    code, pre, kbd, samp,
    .fas, .far, .fal, .fab, .fad, [class*="fa-"],
    .icon, [class*="icon"], [class*="Icon"],
    i[class], svg text {
        font-family: revert !important;
    }
`);
