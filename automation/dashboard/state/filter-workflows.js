// 商品列表多维过滤（AND 叠加）。纯函数、UMD 双模式（node 单测 + 浏览器 window.__AS_DASH_FILTER__）。
// criteria = { text, statuses[], stepId, marginMin, marginMax }；grossMargin 存小数，criteria.margin 是百分比。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.__AS_DASH_FILTER__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function matchText(wf, text) {
    if (!text) return true;
    const label = (wf.product && wf.product.label) || '';
    return label.toLowerCase().includes(String(text).toLowerCase());
  }
  function matchStatus(wf, statuses) {
    if (!statuses || statuses.length === 0) return true;
    return statuses.includes(wf.status);
  }
  function matchStep(wf, stepId) {
    if (!stepId) return true;
    const cur = (wf.steps || [])[wf.cursor];
    return !!cur && cur.id === stepId;
  }
  function matchMargin(wf, min, max) {
    if (min == null && max == null) return true;
    const gm = wf.product && wf.product.grossMargin;
    if (gm == null) return false;                    // 设了区间但无 grossMargin → 排除
    const pct = gm * 100;
    if (min != null && pct < min) return false;
    if (max != null && pct > max) return false;
    return true;
  }
  function filterWorkflows(workflows, criteria) {
    const c = criteria || {};
    return (workflows || []).filter(wf =>
      matchText(wf, c.text) && matchStatus(wf, c.statuses) &&
      matchStep(wf, c.stepId) && matchMargin(wf, c.marginMin, c.marginMax));
  }
  return { filterWorkflows };
});
