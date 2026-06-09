// tests/orchestrator-recovery.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { decideRecovery } = require('../core/background/orchestrator/recovery.js');

test('step 非 running（无中断）→ none', () => {
  assert.strictEqual(decideRecovery({ status: 'done' }).action, 'none');
  assert.strictEqual(decideRecovery({ status: 'pending' }).action, 'none');
  assert.strictEqual(decideRecovery(null).action, 'none');
});

test('可逆 step 中断 → rerun（安全重跑）', () => {
  assert.strictEqual(decideRecovery({ status: 'running', reversible: true }).action, 'rerun');
});

test('不可逆 + committing 未清 → ask-hitl', () => {
  assert.strictEqual(decideRecovery({ status: 'running', reversible: false, committing: true }).action, 'ask-hitl');
});

test('不可逆 + 已有 result（可能已提交）→ ask-hitl', () => {
  assert.strictEqual(decideRecovery({ status: 'running', reversible: false, result: { poNo: 'PO1' } }).action, 'ask-hitl');
});

test('不可逆 + 未触提交点（committing=false, result=null）→ rerun', () => {
  assert.strictEqual(decideRecovery({ status: 'running', reversible: false, committing: false, result: null }).action, 'rerun');
});
