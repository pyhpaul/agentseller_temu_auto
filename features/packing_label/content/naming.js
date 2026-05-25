// 纯函数：物流单号拆分 + 文件名构造 + 非法字符清洗。
// 双用途：浏览器挂 window.__PLNaming；node 测试用 module.exports。
(function () {
  'use strict';

  // "极兔速递，JT0023769813149" → {carrier, trackingNo}。支持中/英文逗号，只取前两段。
  function parseTrackingInfo(raw) {
    const text = String(raw == null ? '' : raw).trim();
    const parts = text.split(/[，,]/).map((s) => s.trim());
    return { carrier: parts[0] || '', trackingNo: parts[1] || '' };
  }

  // 去 Windows 非法文件名字符 \ / : * ? " < > | 及控制字符。
  function sanitizeSegment(s) {
    return String(s == null ? '' : s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim();
  }

  // {carrier, trackingNo, qty} → "承运商_单号_数量件_贴标自提.pdf"
  function buildBaseFileName({ carrier, trackingNo, qty }) {
    const segs = [carrier, trackingNo, qty, '贴标自提'].map(sanitizeSegment);
    return segs.join('_') + '.pdf';
  }

  const api = { parseTrackingInfo, sanitizeSegment, buildBaseFileName };
  if (typeof window !== 'undefined') window.__PLNaming = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
