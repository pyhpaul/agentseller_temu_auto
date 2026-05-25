const { test } = require('node:test');
const assert = require('node:assert');
const { parseTrackingInfo, sanitizeSegment, buildBaseFileName } = require('../content/naming.js');

test('parseTrackingInfo: 中文逗号拆分承运商/单号', () => {
  assert.deepStrictEqual(
    parseTrackingInfo('极兔速递，JT0023769813149'),
    { carrier: '极兔速递', trackingNo: 'JT0023769813149' }
  );
});

test('parseTrackingInfo: 英文逗号同样支持', () => {
  assert.deepStrictEqual(
    parseTrackingInfo('韵达快递,313024122184033'),
    { carrier: '韵达快递', trackingNo: '313024122184033' }
  );
});

test('parseTrackingInfo: 缺单号段返回空串', () => {
  assert.deepStrictEqual(parseTrackingInfo('极兔速递'), { carrier: '极兔速递', trackingNo: '' });
});

test('sanitizeSegment: 去 Windows 非法文件名字符', () => {
  assert.strictEqual(sanitizeSegment('JT/00:1*?"<>|'), 'JT001');
});

test('buildBaseFileName: 完整拼接 + 后缀', () => {
  assert.strictEqual(
    buildBaseFileName({ carrier: '极兔速递', trackingNo: 'JT0023769813149', qty: '20件' }),
    '极兔速递_JT0023769813149_20件_贴标自提.pdf'
  );
});
