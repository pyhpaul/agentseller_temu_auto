// dashboard ↔ storage 契约常量 + 空骨架工厂。双模式：浏览器 ES module export + node 单测 module.exports。
// 真源是 spec §4.1（chrome.storage.local['as_workflow_state']）。store / storage-source 共用本文件，
// 避免「STORAGE_KEY 字符串散落多处、改一处漏一处」。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;          // node 单测
  if (typeof window !== 'undefined') window.__AS_DASH_CONTRACT__ = api;                // 浏览器全局兜底
  root.__AS_DASH_CONTRACT_FACTORY__ = factory;                                        // 便于 ES export 重用
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'as_workflow_state';
  const SCHEMA_VERSION = 1;

  // status / kind / error.category 枚举（与 spec §4.1 / §5.3 对齐；组件渲染按这些值映射 class）
  const WORKFLOW_STATUS = ['pending', 'running', 'paused', 'error', 'done', 'aborted'];
  const STEP_STATUS = ['pending', 'running', 'paused', 'done', 'error', 'skipped'];
  const BRAIN_KIND = ['review', 'diagnose', 'selfheal', 'log'];
  const ERROR_CATEGORY = ['read', 'validate', 'business'];

  // 空骨架：schemaVersion 缺失/过低/损坏时重置成它，避免裸展开 batch.workflows[].steps[] 时 undefined（spec §4.1 初始化/迁移）
  function emptyBatch() {
    return {
      schemaVersion: SCHEMA_VERSION,
      batch: { id: null, createdAt: null, activeWorkflowId: null, workflows: [] },
    };
  }

  // 校验并归一化外部读到的 storage 值：合法返回原值，非法（缺 schemaVersion / 版本过低 / 结构坏）返回 emptyBatch()
  function normalizeSkeleton(raw) {
    if (!raw || typeof raw !== 'object') return emptyBatch();
    if (raw.schemaVersion !== SCHEMA_VERSION) return emptyBatch();
    if (!raw.batch || !Array.isArray(raw.batch.workflows)) return emptyBatch();
    return raw;
  }

  return {
    STORAGE_KEY, SCHEMA_VERSION,
    WORKFLOW_STATUS, STEP_STATUS, BRAIN_KIND, ERROR_CATEGORY,
    emptyBatch, normalizeSkeleton,
  };
});
