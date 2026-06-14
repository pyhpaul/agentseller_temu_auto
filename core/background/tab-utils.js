// core/background/tab-utils.js — SW 通用 tab 工具（被 CPO + automation orchestrator 共用）
// 由 SW 主体顶部 importScripts，须在 bg-router.js（创建 self.AgentSellerBg）之后加载；
// 提供 self.AgentSellerBg.util.*（AgentSellerBg 已由 bg-router 接线创建）。
(function () {
  'use strict';
  // 等 tab 加载完成（status==='complete'）
  function waitTabComplete(tabId, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('tab 加载超时')); }, timeout);
      function onUpdated(id, info) {
        if (id === tabId && info.status === 'complete') { cleanup(); resolve(); }
      }
      function cleanup() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); }
      chrome.tabs.onUpdated.addListener(onUpdated);
      // 兜底：可能已 complete
      chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') { cleanup(); resolve(); } }).catch(() => {});
    });
  }
  self.AgentSellerBg.util = self.AgentSellerBg.util || {};
  self.AgentSellerBg.util.waitTabComplete = waitTabComplete;
})();
