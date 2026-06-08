// select-active.js — 从 batch 选「当前 workflow」。UMD 双模式（node 单测 require + 浏览器全局）。
// 规则：先按 activeWorkflowId 命中；无效则退化取首个；空则 null（spec：起步单 workflow，数组留位）。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.__AS_DASH_SELECT__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function selectActiveWorkflow(batch) {
    if (!batch || !Array.isArray(batch.workflows) || batch.workflows.length === 0) return null;
    const byId = batch.workflows.find(w => w.id === batch.activeWorkflowId);
    return byId || batch.workflows[0];
  }
  return { selectActiveWorkflow };
});
