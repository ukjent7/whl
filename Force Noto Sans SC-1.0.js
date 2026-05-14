// ==UserScript==
// @name         Force Noto Sans SC
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  强制所有网站使用 Noto Sans SC 字体
// @author       -
// @match        https://czbooks.net/*
// @run-at       document-start
// @grant        GM_addStyle
// ==/UserScript==

GM_addStyle(`* { font-family: "Noto Sans SC", sans-serif !important; }`);