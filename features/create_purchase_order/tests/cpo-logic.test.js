const { test } = require('node:test');
const assert = require('node:assert');
const { extractSerial, buildIdCode, validateInputs, mapDxmFields } = require('../cpo-logic.js');

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
