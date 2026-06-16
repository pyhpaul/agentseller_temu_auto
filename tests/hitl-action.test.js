const { test } = require('node:test');
const assert = require('node:assert');
const { buildHitlMessage } = require('../automation/dashboard/hitl-action.js');
const view = require('../automation/overlay/overlay-view.js');

const wfConfirm = { id: 'w1', hitl: { editable: false, fields: [] } };
const wfFill = { id: 'w2', hitl: { editable: true, fields: [
  { key: 'sourceUrl', label: 'Temu 商品详情页 URL', fieldType: 'text', required: true } ] } };

test('confirm（纯确认）→ WF_HITL_CONFIRM 空 result', () => {
  const m = buildHitlMessage('confirm', wfConfirm, () => '', view);
  assert.deepStrictEqual(m, { type: 'WF_HITL_CONFIRM', data: { workflowId: 'w1', result: {} } });
});

test('submit（回填）必填缺失 → error，不发消息', () => {
  const m = buildHitlMessage('submit', wfFill, () => '', view);
  assert.ok(m.error && m.error.length === 1);
  assert.ok(!m.type);
});

test('submit（回填）填了值 → WF_HITL_CONFIRM 带 result（trim 过）', () => {
  const m = buildHitlMessage('submit', wfFill, k => k === 'sourceUrl' ? ' https://seller.temu.com/x ' : '', view);
  assert.strictEqual(m.type, 'WF_HITL_CONFIRM');
  assert.strictEqual(m.data.result.sourceUrl, 'https://seller.temu.com/x');
});

test('approve/reject/retry/refresh/abort → 对应 WF_*，data 只含 workflowId', () => {
  const map = { approve: 'WF_REVIEW_APPROVE', reject: 'WF_HITL_REJECT', retry: 'WF_RETRY', refresh: 'WF_FILL_REFRESH', abort: 'WF_ABORT', delete: 'WF_DELETE' };
  for (const [act, type] of Object.entries(map)) {
    const m = buildHitlMessage(act, wfConfirm, () => '', view);
    assert.deepStrictEqual(m, { type, data: { workflowId: 'w1' } });
  }
});

test('restart → WF_RESTART 带 fromStep（opts.fromStep）', () => {
  const m = buildHitlMessage('restart', wfConfirm, () => '', view, { fromStep: 3 });
  assert.deepStrictEqual(m, { type: 'WF_RESTART', data: { workflowId: 'w1', fromStep: 3 } });
});

test('restart 缺 opts → fromStep 默认 0（重头）', () => {
  const m = buildHitlMessage('restart', wfConfirm, () => '', view);
  assert.deepStrictEqual(m, { type: 'WF_RESTART', data: { workflowId: 'w1', fromStep: 0 } });
});

test('未知动作 → error', () => {
  const m = buildHitlMessage('bogus', wfConfirm, () => '', view);
  assert.ok(m.error && !m.type);
});

test('publish-check → WF_PUBLISH_CHECK 带 autoPublish（来自 opts）', () => {
  const m = buildHitlMessage('publish-check', wfConfirm, () => '', view, { autoPublish: true });
  assert.deepStrictEqual(m, { type: 'WF_PUBLISH_CHECK', data: { workflowId: 'w1', autoPublish: true } });
});

test('publish-check 缺 opts → autoPublish 默认 false', () => {
  const m = buildHitlMessage('publish-check', wfConfirm, () => '', view);
  assert.deepStrictEqual(m, { type: 'WF_PUBLISH_CHECK', data: { workflowId: 'w1', autoPublish: false } });
});

test('publish-exec / skip → 对应 WF_*，data 只含 workflowId', () => {
  assert.deepStrictEqual(buildHitlMessage('publish-exec', wfConfirm, () => '', view), { type: 'WF_PUBLISH_EXEC', data: { workflowId: 'w1' } });
  assert.deepStrictEqual(buildHitlMessage('skip', wfConfirm, () => '', view), { type: 'WF_SKIP', data: { workflowId: 'w1' } });
});
