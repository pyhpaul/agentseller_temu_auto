// core/content/overlay-view.js — overlay 视图决策纯逻辑（与 DOM/chrome 解耦，可 node 测）。spec §8。
// 职责：从 storage 骨架 + 构建信息决定 overlay 渲染哪个视图 + 启动 label 规范化。
// overlay.js（content script）引用全局 window.__AS_OVERLAY_VIEW__；node 测引用 module.exports。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.__AS_OVERLAY_VIEW__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 首版单 workflow：取 running/paused/error 那个（done/aborted 不显示）
  function activeWorkflow(batch) {
    const wfs = (batch && batch.workflows) || [];
    return wfs.find(w => w && ['running', 'paused', 'error'].includes(w.status)) || null;
  }

  // 决定 overlay 渲染哪个视图：
  //   有 active workflow  → 'active'（进度 / HITL / error，Plan 2 现状）
  //   无 active + dev     → 'idle'（启动入口「开始流水线」，本刀新增）
  //   无 active + release → 'hidden'（发版隔离：release overlay 沉睡，行为同 Plan 2）
  // buildInfo = window.__AS_BUILD_INFO__（{ isDev }）；缺失按 release 处理（安全默认 hidden）。
  function decideOverlayView(batch, buildInfo) {
    const wf = activeWorkflow(batch);
    if (wf) return { view: 'active', workflow: wf };
    const isDev = !!(buildInfo && buildInfo.isDev);
    return { view: isDev ? 'idle' : 'hidden', workflow: null };
  }

  // 启动 label 规范化：去首尾空白；空 → null（label 必填，调用方据此拒发 WF_START）
  function normalizeStartLabel(raw) {
    const s = (raw == null ? '' : String(raw)).trim();
    return s.length ? s : null;
  }

  return { activeWorkflow, decideOverlayView, normalizeStartLabel };
});
