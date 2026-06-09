const { test } = require('node:test');
const assert = require('node:assert');
const { STEP_DEFS, buildInitialWorkflow } = require('../core/background/orchestrator/steps.js');

test('STEP_DEFS: 13 步、id 唯一、字段完整', () => {
  assert.strictEqual(STEP_DEFS.length, 13);
  const ids = STEP_DEFS.map(d => d.id);
  assert.strictEqual(new Set(ids).size, 13);                       // id 唯一
  for (const d of STEP_DEFS) {
    assert.ok(['auto', 'hitl'].includes(d.type), `${d.id} type 合法`);
    assert.ok(typeof d.domain === 'string' && d.domain, `${d.id} 有 domain`);
    if (d.type === 'auto') assert.ok(d.feature, `${d.id} auto 必有 feature`);
    if (d.type === 'hitl') assert.strictEqual(d.feature, null, `${d.id} hitl feature=null`);
  }
});

test('STEP_DEFS: 6 AUTO + 7 HITL（spec §3.2）', () => {
  assert.strictEqual(STEP_DEFS.filter(d => d.type === 'auto').length, 6);
  assert.strictEqual(STEP_DEFS.filter(d => d.type === 'hitl').length, 7);
});

test('STEP_DEFS: AUTO 步声明 reversible 布尔值', () => {
  for (const d of STEP_DEFS.filter(d => d.type === 'auto')) {
    assert.strictEqual(typeof d.reversible, 'boolean', `${d.id} reversible 是布尔`);
  }
});

test('buildInitialWorkflow: 初始 workflow 结构正确', () => {
  let n = 0;
  const wf = buildInitialWorkflow({ label: '保温杯' }, () => `w${++n}`);
  assert.strictEqual(wf.id, 'w1');
  assert.strictEqual(wf.status, 'pending');
  assert.strictEqual(wf.cursor, 0);
  assert.strictEqual(wf.product.label, '保温杯');
  assert.strictEqual(wf.product.spuId, null);                      // 渐进填充，初始 null
  assert.strictEqual(wf.steps.length, 13);
  assert.ok(wf.steps.every(s => s.status === 'pending'));
  assert.strictEqual(wf.steps[0].committing, false);
  assert.deepStrictEqual(wf.tmpTabs, []);
});

test('buildInitialWorkflow: 缺 product.label 不抛、label=null', () => {
  const wf = buildInitialWorkflow({}, () => 'w1');
  assert.strictEqual(wf.product.label, null);
});
