const { test } = require('node:test');
const assert = require('node:assert');
const {
  isLocalWarehouse, isValidPackageNo, dedupOrderNos, summarize,
} = require('../content/auto_ship-logic.js');

test('isLocalWarehouse: 化州中正科技 → true', () => {
  assert.strictEqual(isLocalWarehouse('化州中正科技'), true);
});
test('isLocalWarehouse: 含该名(带前后噪音) → true', () => {
  assert.strictEqual(isLocalWarehouse('化州中正科技仓'), true);
});
test('isLocalWarehouse: 其它仓 → false', () => {
  assert.strictEqual(isLocalWarehouse('广州前置仓'), false);
});
test('isLocalWarehouse: 空 → false', () => {
  assert.strictEqual(isLocalWarehouse(''), false);
  assert.strictEqual(isLocalWarehouse(null), false);
});

test('isValidPackageNo: 真实包裹号 → true', () => {
  assert.strictEqual(isValidPackageNo('PKG12345678'), true);
});
test('isValidPackageNo: 空/占位 → false', () => {
  for (const v of ['', '  ', '-', '—', '无', '待生成', '暂无', '未生成', '打印打包标签后展示', null, undefined]) {
    assert.strictEqual(isValidPackageNo(v), false, '值: ' + v);
  }
});

test('dedupOrderNos: 去重 + 去空 + trim 保序', () => {
  assert.deepStrictEqual(
    dedupOrderNos(['A', ' A ', 'B', '', '  ', 'C', 'B']),
    ['A', 'B', 'C']
  );
});

test('summarize: 无失败', () => {
  assert.strictEqual(
    summarize({ shipped: 3, skippedLocal: 2, fails: [] }),
    '处理 3 单 / 跳过本地仓 2 / 失败 0'
  );
});
test('summarize: 有失败附明细', () => {
  const s = summarize({ shipped: 1, skippedLocal: 0, fails: [
    { orderNo: 'PO1', step: '包裹号', reason: '业务：超时未生成' },
  ]});
  assert.ok(s.startsWith('处理 1 单 / 跳过本地仓 0 / 失败 1'));
  assert.ok(s.includes('PO1｜包裹号｜业务：超时未生成'));
});
