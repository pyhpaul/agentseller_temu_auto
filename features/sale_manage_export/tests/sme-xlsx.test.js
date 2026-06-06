// node --test 单测：sme-xlsx 最小 xlsx 生成器（zip stored + CRC32 + inlineStr sheet）
const test = require('node:test');
const assert = require('node:assert');
const X = require('../content/sme-xlsx.js');

// ── crc32 ──────────────────────────────────────────────────────────────────
test('crc32: 标准校验值（"123456789" → 0xCBF43926）', () => {
  const bytes = new TextEncoder().encode('123456789');
  assert.strictEqual(X.crc32(bytes) >>> 0, 0xcbf43926);
});

test('crc32: 空输入 → 0', () => {
  assert.strictEqual(X.crc32(new Uint8Array(0)) >>> 0, 0);
});

// ── sheet XML ──────────────────────────────────────────────────────────────
test('buildSheetXml: 含列宽 cols + 表头 + 数据行', () => {
  const xml = X.buildSheetXml([
    { skc: '55589159770', skcCode: 'RAC449', spu: '2354682166', name: 'Aluminum alloy' },
  ]);
  // 4 列列宽（SKC 14 / SKC货号 12 / SPU 14 / 商品名称 60）
  assert.match(xml, /<col min="1" max="1" width="14" customWidth="1"\/>/);
  assert.match(xml, /<col min="2" max="2" width="12" customWidth="1"\/>/);
  assert.match(xml, /<col min="3" max="3" width="14" customWidth="1"\/>/);
  assert.match(xml, /<col min="4" max="4" width="60" customWidth="1"\/>/);
  // 表头是 inlineStr，全部挂左对齐 style s="1"
  assert.match(xml, /<c t="inlineStr" s="1"><is><t[^>]*>SKC<\/t><\/is><\/c>/);
  // SKC/SPU 是数字单元格（无 t 属性 + <v>）；SKC货号/商品名称是 inlineStr
  assert.match(xml, /<c s="1"><v>55589159770<\/v><\/c>/);
  assert.match(xml, /<c s="1"><v>2354682166<\/v><\/c>/);
  assert.match(xml, /<c t="inlineStr" s="1"><is><t[^>]*>RAC449<\/t><\/is><\/c>/);
  assert.match(xml, /<t[^>]*>Aluminum alloy<\/t>/);
});

test('buildSheetXml: SKC/SPU 非安全数字时回退文本单元格', () => {
  const xml = X.buildSheetXml([
    // 含字母 / 前导零（数字化会丢零）/ 超 15 位（双精度丢精度）→ 全部回退 inlineStr
    { skc: 'AB123', skcCode: 'X', spu: '007', name: 'n1' },
    { skc: '1234567890123456', skcCode: 'Y', spu: '12345678901234', name: 'n2' },
  ]);
  assert.match(xml, /<is><t[^>]*>AB123<\/t><\/is>/);
  assert.match(xml, /<is><t[^>]*>007<\/t><\/is>/);
  assert.match(xml, /<is><t[^>]*>1234567890123456<\/t><\/is>/);
  assert.doesNotMatch(xml, /<v>1234567890123456<\/v>/);
  // 14 位在安全范围内 → 数字
  assert.match(xml, /<c s="1"><v>12345678901234<\/v><\/c>/);
});

test('buildSheetXml: XML 特殊字符转义', () => {
  const xml = X.buildSheetXml([
    { skc: 'a<b', skcCode: 'c&d', spu: 'e>f', name: 'say "hi" & <tag>' },
  ]);
  assert.match(xml, /a&lt;b/);
  assert.match(xml, /c&amp;d/);
  assert.match(xml, /e&gt;f/);
  assert.match(xml, /say "hi" &amp; &lt;tag&gt;/);
  assert.doesNotMatch(xml, /<tag>/);
});

test('buildSheetXml: null/undefined 字段转空串', () => {
  const xml = X.buildSheetXml([{ skc: null, skcCode: undefined, spu: '', name: 'x' }]);
  assert.match(xml, /<t[^>]*><\/t>/);
});

// ── zip 容器 ───────────────────────────────────────────────────────────────
// 解析 stored zip：local file header 链 → {name → data}；顺带校验 CRC 与 EOCD entry 数
function parseStoredZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const files = {};
  let off = 0;
  while (dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const crc = dv.getUint32(off + 14, true);
    const compSize = dv.getUint32(off + 18, true);
    const rawSize = dv.getUint32(off + 22, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    assert.strictEqual(method, 0, 'stored（不压缩）');
    assert.strictEqual(compSize, rawSize, 'stored 时压缩前后大小一致');
    const name = new TextDecoder().decode(u8.subarray(off + 30, off + 30 + nameLen));
    const data = u8.subarray(off + 30 + nameLen + extraLen, off + 30 + nameLen + extraLen + compSize);
    assert.strictEqual(X.crc32(data) >>> 0, crc >>> 0, name + ' 的 CRC32 一致');
    files[name] = data;
    off += 30 + nameLen + extraLen + compSize;
  }
  // EOCD（无 comment，固定在末尾 22 字节）
  const eocd = u8.length - 22;
  assert.strictEqual(dv.getUint32(eocd, true), 0x06054b50, 'EOCD 签名');
  return { files, entryCount: dv.getUint16(eocd + 10, true) };
}

test('buildXlsxBytes: 合法 stored zip，含 6 个 OOXML 部件，CRC 全部一致', () => {
  const u8 = X.buildXlsxBytes([
    { skc: '55589159770', skcCode: 'RAC449', spu: '2354682166', name: 'Aluminum alloy, magnetic' },
    { skc: '111', skcCode: 'A&B', spu: '222', name: '<名称>' },
  ]);
  assert.ok(u8 instanceof Uint8Array);
  const { files, entryCount } = parseStoredZip(u8);
  const names = Object.keys(files);
  assert.deepStrictEqual(names.sort(), [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml',
  ]);
  assert.strictEqual(entryCount, 6);
  const sheet = new TextDecoder().decode(files['xl/worksheets/sheet1.xml']);
  assert.match(sheet, /55589159770/);
  assert.match(sheet, /A&amp;B/);
  // styles：cellXfs 第二个 xf 是左对齐
  const styles = new TextDecoder().decode(files['xl/styles.xml']);
  assert.match(styles, /<alignment horizontal="left"/);
});

test('buildXlsxBytes: 空行集也生成合法 xlsx（仅表头）', () => {
  const { files, entryCount } = parseStoredZip(X.buildXlsxBytes([]));
  assert.strictEqual(entryCount, 6);
  assert.match(new TextDecoder().decode(files['xl/worksheets/sheet1.xml']), /SKC货号/);
});
