// tests/overlay-view.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { activeWorkflow, decideOverlayView, normalizeStartLabel, buildFillResult, validateFill } = require('../automation/overlay/overlay-view.js');

function batchWith(status) {
  return { workflows: [{ id: 'w1', status }] };
}

test('activeWorkflow：取 running/paused/error 那个', () => {
  assert.strictEqual(activeWorkflow(batchWith('running')).id, 'w1');
  assert.strictEqual(activeWorkflow(batchWith('paused')).id, 'w1');
  assert.strictEqual(activeWorkflow(batchWith('error')).id, 'w1');
});

test('activeWorkflow：done/aborted/空 → null', () => {
  assert.strictEqual(activeWorkflow(batchWith('done')), null);
  assert.strictEqual(activeWorkflow(batchWith('aborted')), null);
  assert.strictEqual(activeWorkflow(null), null);
  assert.strictEqual(activeWorkflow({ workflows: [] }), null);
});

test('decideOverlayView：有 active workflow → active（无视 buildInfo）', () => {
  const r = decideOverlayView(batchWith('running'), { isDev: false });
  assert.strictEqual(r.view, 'active');
  assert.strictEqual(r.workflow.id, 'w1');
});

test('decideOverlayView：无 active（dev 也）→ hidden（启动入口移 dashboard，业务页空态不显示）', () => {
  const r = decideOverlayView(batchWith('done'), { isDev: true });
  assert.strictEqual(r.view, 'hidden');
  assert.strictEqual(r.workflow, null);
});

test('decideOverlayView：无 active + release → hidden（发版隔离沉睡）', () => {
  assert.strictEqual(decideOverlayView(batchWith('done'), { isDev: false }).view, 'hidden');
});

test('decideOverlayView：无 active + buildInfo 缺失 → hidden（安全默认 release）', () => {
  assert.strictEqual(decideOverlayView(null, null).view, 'hidden');
  assert.strictEqual(decideOverlayView(null, undefined).view, 'hidden');
});

test('normalizeStartLabel：去首尾空白', () => {
  assert.strictEqual(normalizeStartLabel('  商品A  '), '商品A');
});

test('normalizeStartLabel：空/纯空白/null/undefined → null', () => {
  assert.strictEqual(normalizeStartLabel(''), null);
  assert.strictEqual(normalizeStartLabel('   '), null);
  assert.strictEqual(normalizeStartLabel(null), null);
  assert.strictEqual(normalizeStartLabel(undefined), null);
});

const FILL_FIELDS = [
  { key: 'url1688', label: '1688 链接', fieldType: 'text', required: true },
  { key: 'qty', label: '数量', fieldType: 'number', required: false },
];

test('buildFillResult：按 fields 收集，trim 文本、number 转数字', () => {
  const r = buildFillResult(FILL_FIELDS, k => ({ url1688: '  https://x.1688.com/a  ', qty: '12' }[k]));
  assert.strictEqual(r.url1688, 'https://x.1688.com/a');
  assert.strictEqual(r.qty, 12);
});

test('validateFill：required 空 → error', () => {
  const v = validateFill(FILL_FIELDS, { url1688: '', qty: 1 });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some(e => e.key === 'url1688'));
});

test('validateFill：url1688 不含 1688.com → error', () => {
  const v = validateFill(FILL_FIELDS, { url1688: 'https://taobao.com/x', qty: 1 });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some(e => e.key === 'url1688'));
});

test('validateFill：全合法 → ok', () => {
  const v = validateFill(FILL_FIELDS, { url1688: 'https://x.1688.com/a', qty: 1 });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.errors, []);
});

test('validateFill：非必填空字段不报错（qty 非 required）', () => {
  const v = validateFill(FILL_FIELDS, { url1688: 'https://x.1688.com/a', qty: NaN });
  assert.strictEqual(v.ok, true);
});
