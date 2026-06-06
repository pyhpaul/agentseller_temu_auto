// node --test 单测：sme-utils 纯函数（CSV 转义 / 商品信息字段解析 / 文件名）
const test = require('node:test');
const assert = require('node:assert');
const U = require('../content/sme-utils.js');

test('csvField: 普通值原样返回', () => {
  assert.strictEqual(U.csvField('RAC449'), 'RAC449');
});

test('csvField: 含逗号/引号/换行时双引号包裹并转义内部引号', () => {
  assert.strictEqual(U.csvField('a,b'), '"a,b"');
  assert.strictEqual(U.csvField('say "hi"'), '"say ""hi"""');
  assert.strictEqual(U.csvField('l1\nl2'), '"l1\nl2"');
  assert.strictEqual(U.csvField('a\rb'), '"a\rb"');
});

test('csvField: null/undefined 转空串', () => {
  assert.strictEqual(U.csvField(null), '');
  assert.strictEqual(U.csvField(undefined), '');
});

test('buildCsvText: 表头 + 行，CRLF 分隔', () => {
  const rows = [
    { skc: '55589159770', skcCode: 'RAC449', spu: '2354682166', name: 'Aluminum alloy, magnetic' },
  ];
  assert.strictEqual(
    U.buildCsvText(rows),
    'SKC,SKC货号,SPU,商品名称\r\n55589159770,RAC449,2354682166,"Aluminum alloy, magnetic"\r\n'
  );
});

test('parseInfoFields: 从商品信息格 p 文本提取三字段', () => {
  const r = U.parseInfoFields([
    'SKC：55589159770',
    '加入站点时长：-天',
    'SPU：2354682166',
    'SKC货号：RAC449',
    '节日/季节标签：-',
  ]);
  assert.deepStrictEqual(r, { skc: '55589159770', skcCode: 'RAC449', spu: '2354682166' });
});

test('parseInfoFields: 兼容半角冒号与首尾空白', () => {
  const r = U.parseInfoFields(['SKC: 111 ', ' SPU：222', 'SKC货号:ABC-1']);
  assert.deepStrictEqual(r, { skc: '111', skcCode: 'ABC-1', spu: '222' });
});

test('parseInfoFields: 缺字段返回空串（由调用方报数据校验错）', () => {
  const r = U.parseInfoFields(['SPU：222']);
  assert.deepStrictEqual(r, { skc: '', skcCode: '', spu: '222' });
});

test('parseInfoFields: SKC货号 行不得误吞进 SKC（前缀更长者优先）', () => {
  const r = U.parseInfoFields(['SKC货号：RAC449']);
  assert.strictEqual(r.skc, '');
  assert.strictEqual(r.skcCode, 'RAC449');
});

test('buildCsvFileName: 销售管理清单_YYYYMMDD_HHMMSS.csv', () => {
  const d = new Date(2026, 5, 5, 14, 30, 22); // 2026-06-05 14:30:22
  assert.strictEqual(U.buildCsvFileName(d), '销售管理清单_20260605_143022.csv');
});
