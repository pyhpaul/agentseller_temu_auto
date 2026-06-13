// tests/overlay-view.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { activeWorkflow, decideOverlayView, normalizeStartLabel } = require('../core/content/overlay-view.js');

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

test('decideOverlayView：无 active + dev → idle（启动入口）', () => {
  const r = decideOverlayView(batchWith('done'), { isDev: true });
  assert.strictEqual(r.view, 'idle');
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
