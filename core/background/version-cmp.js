// 纯逻辑版本号比较。双模式：浏览器 SW 用 importScripts 拿 self.cmpVersion；node 单测 require module.exports。
// 安全降级：段含 NaN（如 '1.x.0'）按 0 处理，确保异常不抛、最坏返回 0（不 reload）。
(function () {
  'use strict';

  function cmpVersion(a, b) {
    const sa = String(a == null ? '' : a).split('.').map(Number);
    const sb = String(b == null ? '' : b).split('.').map(Number);
    const n = Math.max(sa.length, sb.length);
    for (let i = 0; i < n; i++) {
      const va = Number.isFinite(sa[i]) ? sa[i] : 0;
      const vb = Number.isFinite(sb[i]) ? sb[i] : 0;
      const d = va - vb;
      if (d !== 0) return d;
    }
    return 0;
  }

  if (typeof self !== 'undefined') self.cmpVersion = cmpVersion;
  if (typeof module !== 'undefined' && module.exports) module.exports = { cmpVersion };
})();
