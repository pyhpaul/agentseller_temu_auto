// tests/orchestrator-state-machine.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { decideNext } = require('../automation/orchestrator/state-machine.js');

function wf(over) {
  return Object.assign({
    status: 'running', cursor: 0,
    steps: [{ id: 's0', type: 'auto', status: 'pending' }],
  }, over);
}

test('workflow 非 running → noop', () => {
  assert.strictEqual(decideNext(wf({ status: 'paused' })).kind, 'noop');
  assert.strictEqual(decideNext(wf({ status: 'done' })).kind, 'noop');
  assert.strictEqual(decideNext(null).kind, 'noop');
});

test('pending auto step → run-auto', () => {
  const d = decideNext(wf());
  assert.strictEqual(d.kind, 'run-auto');
  assert.strictEqual(d.stepId, 's0');
  assert.strictEqual(d.cursor, 0);
});

test('pending hitl step → pause-hitl', () => {
  const d = decideNext(wf({ steps: [{ id: 's0', type: 'hitl', status: 'pending' }] }));
  assert.strictEqual(d.kind, 'pause-hitl');
  assert.strictEqual(d.stepId, 's0');
});

test('running step → noop（幂等，处理中不重入）', () => {
  assert.strictEqual(decideNext(wf({ steps: [{ id: 's0', type: 'auto', status: 'running' }] })).kind, 'noop');
});

test('paused step → noop（等 HITL）', () => {
  assert.strictEqual(decideNext(wf({ steps: [{ id: 's0', type: 'hitl', status: 'paused' }] })).kind, 'noop');
});

test('done step 非末尾 → advance-cursor', () => {
  const d = decideNext(wf({
    cursor: 0,
    steps: [{ id: 's0', type: 'auto', status: 'done' }, { id: 's1', type: 'auto', status: 'pending' }],
  }));
  assert.strictEqual(d.kind, 'advance-cursor');
  assert.strictEqual(d.from, 0);
});

test('done step 末尾 → complete', () => {
  const d = decideNext(wf({ cursor: 0, steps: [{ id: 's0', type: 'auto', status: 'done' }] }));
  assert.strictEqual(d.kind, 'complete');
});

test('skipped step 同 done（非末尾推进 / 末尾 complete）', () => {
  assert.strictEqual(decideNext(wf({ cursor: 0, steps: [{ id: 's0', status: 'skipped' }, { id: 's1', status: 'pending', type: 'auto' }] })).kind, 'advance-cursor');
  assert.strictEqual(decideNext(wf({ cursor: 0, steps: [{ id: 's0', status: 'skipped' }] })).kind, 'complete');
});

test('error step → error', () => {
  const d = decideNext(wf({ steps: [{ id: 's0', type: 'auto', status: 'error' }] }));
  assert.strictEqual(d.kind, 'error');
  assert.strictEqual(d.stepId, 's0');
});

test('cursor 越界（step undefined）→ complete', () => {
  assert.strictEqual(decideNext(wf({ cursor: 5 })).kind, 'complete');
});
