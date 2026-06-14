// core/background/orchestrator/state-machine.js
// 编排器状态机核心：纯函数，输入 workflow 快照 → 输出下一步指令（无副作用）。spec §2.2。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.__AS_ORCH_SM__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function decideNext(wf) {
    if (!wf || wf.status !== 'running') return { kind: 'noop' };
    const step = wf.steps[wf.cursor];
    if (!step) return { kind: 'complete' };           // cursor 越界 = 全部跑完
    const isLast = wf.cursor >= wf.steps.length - 1;
    switch (step.status) {
      case 'pending':
        return step.type === 'auto'
          ? { kind: 'run-auto', stepId: step.id, cursor: wf.cursor }
          : { kind: 'pause-hitl', stepId: step.id, cursor: wf.cursor };
      case 'running':
        return { kind: 'noop' };                       // 处理中，幂等防重入
      case 'paused':
        return { kind: 'noop' };                       // 等 HITL
      case 'done':
      case 'skipped':
        return isLast ? { kind: 'complete' } : { kind: 'advance-cursor', from: wf.cursor };
      case 'error':
        return { kind: 'error', stepId: step.id };
      default:
        return { kind: 'noop' };
    }
  }

  return { decideNext };
});
