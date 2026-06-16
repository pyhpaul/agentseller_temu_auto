const { test } = require('node:test');
const assert = require('node:assert');
const { filterWorkflows } = require('../automation/dashboard/state/filter-workflows.js');

const wf = (over) => Object.assign({
  id: 'w', product: { label: '保温杯', grossMargin: null },
  status: 'running', cursor: 0,
  steps: [{ id: 'select_product' }, { id: 'publish' }],
}, over);

test('空 criteria → 返回全部', () => {
  const list = [wf(), wf({ id: 'w2' })];
  assert.strictEqual(filterWorkflows(list, {}).length, 2);
});

test('text：子串匹配 product.label、不区分大小写', () => {
  const list = [wf({ product: { label: 'ABC杯' } }), wf({ product: { label: '雨伞' } })];
  assert.strictEqual(filterWorkflows(list, { text: 'abc' }).length, 1);
});

test('text：label 为空 + 有 text → 不匹配', () => {
  assert.strictEqual(filterWorkflows([wf({ product: { label: '' } })], { text: 'x' }).length, 0);
});

test('statuses：命中状态；空数组=全部', () => {
  const list = [wf({ status: 'running' }), wf({ status: 'paused' })];
  assert.strictEqual(filterWorkflows(list, { statuses: ['paused'] }).length, 1);
  assert.strictEqual(filterWorkflows(list, { statuses: [] }).length, 2);
});

test('stepId：匹配当前 cursor step.id', () => {
  const list = [wf({ cursor: 0 }), wf({ id: 'w2', cursor: 1 })];   // w 在 select_product，w2 在 publish
  assert.strictEqual(filterWorkflows(list, { stepId: 'publish' }).length, 1);
  assert.strictEqual(filterWorkflows(list, { stepId: 'publish' })[0].id, 'w2');
});

test('margin：区间匹配 grossMargin（百分比）；无 grossMargin 设了区间→排除', () => {
  const list = [
    wf({ product: { label: 'a', grossMargin: 0.35 } }),   // 35%
    wf({ product: { label: 'b', grossMargin: 0.10 } }),   // 10%
    wf({ product: { label: 'c', grossMargin: null } }),   // 无
  ];
  assert.strictEqual(filterWorkflows(list, { marginMin: 20 }).length, 1);          // 仅 35%
  assert.strictEqual(filterWorkflows(list, { marginMax: 20 }).length, 1);          // 仅 10%
  assert.strictEqual(filterWorkflows(list, { marginMin: 0, marginMax: 100 }).length, 2);  // 排除 null
});

test('AND 叠加：多维同时生效', () => {
  const list = [
    wf({ product: { label: '保温杯', grossMargin: 0.35 }, status: 'paused' }),
    wf({ id: 'w2', product: { label: '保温杯', grossMargin: 0.05 }, status: 'paused' }),
  ];
  assert.strictEqual(filterWorkflows(list, { text: '杯', statuses: ['paused'], marginMin: 20 }).length, 1);
});

test('无 steps / 空入参兜底不崩', () => {
  assert.deepStrictEqual(filterWorkflows(null, {}), []);
  assert.strictEqual(filterWorkflows([wf({ steps: undefined })], { stepId: 'x' }).length, 0);
});
