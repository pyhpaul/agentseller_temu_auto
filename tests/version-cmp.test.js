const { test } = require('node:test');
const assert = require('node:assert');
const { cmpVersion } = require('../core/background/version-cmp.js');

test('cmpVersion: 高版本 > 低版本', () => {
  assert.strictEqual(cmpVersion('1.3.0', '1.2.0') > 0, true);
  assert.strictEqual(cmpVersion('2.0.0', '1.9.9') > 0, true);
});
test('cmpVersion: 相等', () => {
  assert.strictEqual(cmpVersion('1.2.0', '1.2.0'), 0);
  assert.strictEqual(cmpVersion('1.0.0', '1.0.0'), 0);
});
test('cmpVersion: 低版本 < 高版本', () => {
  assert.strictEqual(cmpVersion('1.2.0', '1.3.0') < 0, true);
});
test('cmpVersion: 段数不等（短补 0）', () => {
  assert.strictEqual(cmpVersion('1.2', '1.2.0'), 0);
  assert.strictEqual(cmpVersion('1.2', '1.2.1') < 0, true);
  assert.strictEqual(cmpVersion('1.3', '1.2.9') > 0, true);
});
test('cmpVersion: NaN 段算 0（安全降级）', () => {
  assert.strictEqual(cmpVersion('1.x.0', '1.0.0'), 0);
  assert.strictEqual(cmpVersion('abc', 'def'), 0);
});
