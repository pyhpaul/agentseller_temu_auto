const { test } = require('node:test');
const assert = require('node:assert');
const { extractSerial, buildIdCode, validateInputs, mapDxmFields, extractPoNo, validatePhase2 } = require('../cpo-logic.js');

test('extractSerial: 标准 1688 offer url', () => {
  assert.strictEqual(extractSerial('https://detail.1688.com/offer/653412345678.html'), '653412345678');
});
test('extractSerial: 带 query 参数', () => {
  assert.strictEqual(extractSerial('https://detail.1688.com/offer/653412345678.html?spm=a262eq.123'), '653412345678');
});
test('extractSerial: 无 offer id 返回 null', () => {
  assert.strictEqual(extractSerial('https://detail.1688.com/index.html'), null);
});
test('extractSerial: 空/非字符串返回 null', () => {
  assert.strictEqual(extractSerial(''), null);
  assert.strictEqual(extractSerial(null), null);
});

test('buildIdCode: serial-skuNo 拼接', () => {
  assert.strictEqual(buildIdCode('653412345678', 'ABC-001'), '653412345678-ABC-001');
});

test('validateInputs: 合法输入', () => {
  assert.deepStrictEqual(
    validateInputs({ skc: 'SKC123', url1688: 'https://detail.1688.com/offer/653412345678.html' }),
    { ok: true, serial: '653412345678' }
  );
});
test('validateInputs: skc 为空', () => {
  const r = validateInputs({ skc: '  ', url1688: 'https://detail.1688.com/offer/653412345678.html' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /SKC/);
});
test('validateInputs: url 无法提取 serial', () => {
  const r = validateInputs({ skc: 'SKC123', url1688: 'https://detail.1688.com/index.html' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /serial|url|1688/i);
});

test('mapDxmFields: 完整映射', () => {
  assert.deepStrictEqual(
    mapDxmFields({ skuNo: 'ABC-001', title: '夏季纯棉T恤', serial: '653412345678', url1688: 'https://detail.1688.com/offer/653412345678.html', previewUrl: 'https://img.example/p.jpg' }),
    {
      spuSku: 'ABC-001', enName: 'ABC-001', platformSku: 'ABC-001',
      cnName: '夏季纯棉T恤', idCode: '653412345678-ABC-001',
      sourceUrl: 'https://detail.1688.com/offer/653412345678.html',
      imageUrl: 'https://img.example/p.jpg',
    }
  );
});

test('extractPoNo: 标准审核成功弹窗文案', () => {
  assert.strictEqual(
    extractPoNo('操作成功：1个，采购单：PO1SLPT250527001已移入待到货状态'),
    'PO1SLPT250527001'
  );
});
test('extractPoNo: 冒号为半角', () => {
  assert.strictEqual(extractPoNo('操作成功:1个,采购单:PO1SLPT999已移入待到货状态'), 'PO1SLPT999');
});
test('extractPoNo: 无采购单号返回 null', () => {
  assert.strictEqual(extractPoNo('操作成功：1个'), null);
  assert.strictEqual(extractPoNo(''), null);
  assert.strictEqual(extractPoNo(null), null);
});

test('extractPoNo: textContent 跨节点空白（真实弹窗 dump）', () => {
  // 真实 textContent：DOM 跨节点拼接插入空白（「关 闭」即为证据），冒号/PO 间夹空格
  assert.strictEqual(
    extractPoNo('提示操作成功：1个，采购单： PO1SLPT027940 已移入「待到货」状态。关 闭'),
    'PO1SLPT027940'
  );
  assert.strictEqual(
    extractPoNo('采购单 ： PO1SLPT027940 已移入'),
    'PO1SLPT027940'
  );
});

test('extractPoNo: 采购单号 措辞（已存在弹窗同款）', () => {
  assert.strictEqual(
    extractPoNo('3304702093890742986采购单号：PO1SLPT027932已存在，不能重复添加'),
    'PO1SLPT027932'
  );
});

test('validatePhase2: 合法', () => {
  assert.deepStrictEqual(validatePhase2({ orderNo1688: 'AB123', phase1Done: true }), { ok: true });
});
test('validatePhase2: phase1 未完成', () => {
  const r = validatePhase2({ orderNo1688: 'AB123', phase1Done: false });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Phase 1|添加SKU/);
});
test('validatePhase2: 订单号为空', () => {
  const r = validatePhase2({ orderNo1688: '  ', phase1Done: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /1688订单号/);
});
