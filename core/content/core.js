// core/content/core.js — 装配入口（manifest 内 content_scripts 列表的最后一个 core 文件）
(function () {
  'use strict';

  // 把 utils 暴露到公开 API
  window.AgentSeller.utils = window.__AgentSellerUtils;

  // 初始化 UI 骨架
  window.__AgentSellerUI.init();

  // 启动页面变化分发
  window.__AgentSellerRegistry.hookHistory();

  // 用 setTimeout(0) 让所有 feature 脚本（在本文件之后由 chrome 顺序执行）
  // 完成 registerFeature 调用后，再触发首次页面变化分发。
  // 不用 Promise.resolve().then —— microtask 在 chrome content scripts 之间
  // 是否清空不保证；setTimeout 0 排到 macrotask，必然在所有 content scripts
  // 同步执行结束后触发。
  setTimeout(() => {
    window.__AgentSellerRegistry.dispatchPageChange();
  }, 0);

  console.log('[AgentSeller] core ready');
})();
