const { test } = require('node:test');
const assert = require('node:assert');
const { paginate } = require('../automation/dashboard/state/paginate.js');

const L = (n) => Array.from({ length: n }, (_, i) => i + 1);

test('正常切页：第 1 页取前 pageSize 个', () => {
  const r = paginate(L(50), 1, 20);
  assert.deepStrictEqual(r.items, L(20));
  assert.strictEqual(r.page, 1);
  assert.strictEqual(r.totalPages, 3);
  assert.strictEqual(r.total, 50);
});

test('末页不足 pageSize', () => {
  const r = paginate(L(50), 3, 20);
  assert.strictEqual(r.items.length, 10);   // 41..50
  assert.strictEqual(r.items[0], 41);
});

test('page 越界 → 钳到末页', () => {
  const r = paginate(L(50), 99, 20);
  assert.strictEqual(r.page, 3);
  assert.strictEqual(r.items[0], 41);
});

test('page < 1 → 钳到 1', () => {
  assert.strictEqual(paginate(L(50), 0, 20).page, 1);
  assert.strictEqual(paginate(L(50), -5, 20).page, 1);
});

test('空列表 → totalPages=1, items=[]', () => {
  const r = paginate([], 1, 20);
  assert.deepStrictEqual(r.items, []);
  assert.strictEqual(r.totalPages, 1);
  assert.strictEqual(r.total, 0);
});

test('恰好整除', () => {
  assert.strictEqual(paginate(L(40), 2, 20).totalPages, 2);
});

test('非数组 / pageSize 非法兜底', () => {
  assert.deepStrictEqual(paginate(null, 1, 20).items, []);
  assert.strictEqual(paginate(L(5), 1, 0).items.length, 5);   // pageSize<=0 → 默认 20
});
