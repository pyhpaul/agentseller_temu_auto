// automation/dashboard/hitl-action.js — HITL 动作 → WF_* 消息映射（纯逻辑，UMD 双模式）。
// dashboard.js（经全局 window.__AS_DASH_HITL_ACTION__）+ node 测共用。
// view 注入 overlay-view api（buildFillResult/validateFill），保持本模块无全局依赖、可纯测。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.__AS_DASH_HITL_ACTION__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // act: confirm(纯确认) / submit(回填提交) / approve(复核确认) / reject / retry / refresh / abort / delete / restart
  // opts: restart 用 opts.fromStep（重头=0 / 当前步=cursor / 任意步=下拉值）。
  // 回填 submit 校验失败返回 {error:[{key,msg}]}（调用方提示，不发消息）；其余返回 {type,data}。
  function buildHitlMessage(act, wf, getField, view, opts) {
    opts = opts || {};
    const workflowId = wf && wf.id;
    switch (act) {
      case 'confirm':
        return { type: 'WF_HITL_CONFIRM', data: { workflowId, result: {} } };
      case 'submit': {
        const fields = (wf.hitl && wf.hitl.fields) || [];
        const result = view.buildFillResult(fields, getField);
        const v = view.validateFill(fields, result);
        if (!v.ok) return { error: v.errors };
        return { type: 'WF_HITL_CONFIRM', data: { workflowId, result } };
      }
      case 'approve': return { type: 'WF_REVIEW_APPROVE', data: { workflowId } };
      case 'reject':  return { type: 'WF_HITL_REJECT',   data: { workflowId } };
      case 'retry':   return { type: 'WF_RETRY',         data: { workflowId } };
      case 'refresh': return { type: 'WF_FILL_REFRESH',  data: { workflowId } };
      case 'abort':   return { type: 'WF_ABORT',         data: { workflowId } };
      case 'delete':  return { type: 'WF_DELETE',        data: { workflowId } };
      case 'restart': return { type: 'WF_RESTART',       data: { workflowId, fromStep: opts.fromStep | 0 } };
      default: return { error: [{ msg: '未知动作 ' + act }] };
    }
  }
  return { buildHitlMessage };
});
