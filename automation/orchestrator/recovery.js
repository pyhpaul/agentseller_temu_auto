// core/background/orchestrator/recovery.js
// SW 回收恢复决策：对中断的 running step 判断重跑 vs 转 HITL。spec §4.2。UMD 双模式。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.__AS_ORCH_RECOVERY__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function decideRecovery(step) {
    if (!step || step.status !== 'running') return { action: 'none' };
    if (step.reversible === true) return { action: 'rerun' };               // 可逆 → 重置重跑
    if (step.committing || step.result) return { action: 'ask-hitl' };      // 不可逆且可能已提交 → 转人工确认
    return { action: 'rerun' };                                             // 不可逆但未触提交点 → 重跑（含 reversible=null 防御兜底：HITL 步正常不入 running）
  }

  return { decideRecovery };
});
