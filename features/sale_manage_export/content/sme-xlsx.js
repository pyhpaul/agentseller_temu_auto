// sme-xlsx：最小 xlsx 生成器（无第三方依赖）。zip 容器用 stored（不压缩）+ CRC32，
// sheet 用 inlineStr 单元格（免 sharedStrings），<cols> 固化列宽 + styles 全表左对齐——
// 这两点是 CSV 做不到、本 feature 升级 xlsx 的全部动机。
// 双导出：browser 挂 window.__SMEXlsx，node 走 module.exports 供单测。
(function (root) {
  'use strict';

  // ── CRC32（标准 IEEE 802.3 反射表实现，zip 必需）──────────────────────────
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ── XML ────────────────────────────────────────────────────────────────────
  function xmlEscape(v) {
    return (v == null ? '' : String(v))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

  // 列定义：与 CSV 表头一致；width 单位是字符宽（Excel 标准）。
  // numeric: SKC/SPU 按用户要求出数字单元格（值不满足安全数字时逐格回退文本）；
  // SKC货号可能含字母/前导零、商品名称是自由文本 → 恒为文本。
  const COLUMNS = [
    { header: 'SKC', width: 14, numeric: true },
    { header: 'SKC货号', width: 12, numeric: false },
    { header: 'SPU', width: 14, numeric: true },
    { header: '商品名称', width: 60, numeric: false },
  ];

  // 数字单元格安全条件：纯数字、无前导零（数字化会丢零）、≤15 位（Excel 双精度上限，
  // 超出会静默改写尾数——宁可回退文本也不能丢精度）
  function isSafeNumber(s) {
    return /^(0|[1-9]\d{0,14})$/.test(s);
  }

  // s="1" 指向 styles.xml cellXfs 的左对齐 xf；
  // 文本格 xml:space="preserve" 防 Excel 吞值内前后空白
  function cell(v, numeric) {
    const s = v == null ? '' : String(v);
    if (numeric && isSafeNumber(s)) return '<c s="1"><v>' + s + '</v></c>';
    return '<c t="inlineStr" s="1"><is><t xml:space="preserve">' + xmlEscape(s) + '</t></is></c>';
  }

  // rows: [{skc, skcCode, spu, name}] → sheet1.xml 文本
  function buildSheetXml(rows) {
    const cols = COLUMNS.map((c, i) =>
      '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + c.width + '" customWidth="1"/>').join('');
    const lines = [XML_DECL +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<cols>' + cols + '</cols><sheetData>'];
    lines.push('<row>' + COLUMNS.map((c) => cell(c.header, false)).join('') + '</row>');
    for (const r of rows) {
      lines.push('<row>' + [r.skc, r.skcCode, r.spu, r.name]
        .map((v, i) => cell(v, COLUMNS[i].numeric)).join('') + '</row>');
    }
    lines.push('</sheetData></worksheet>');
    return lines.join('');
  }

  // 最小 styles：cellXfs[0] 默认、cellXfs[1] 左对齐（全表单元格用 s="1" 引用）。
  // fills 必须 ≥2（none + gray125），否则部分 Excel 版本报文件损坏。
  const STYLES_XML = XML_DECL +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
    '<cellXfs count="2"><xf/>' +
    '<xf applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf></cellXfs>' +
    '</styleSheet>';

  const CONTENT_TYPES_XML = XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  const ROOT_RELS_XML = XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const WORKBOOK_XML = XML_DECL +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="销售管理清单" sheetId="1" r:id="rId1"/></sheets></workbook>';

  const WORKBOOK_RELS_XML = XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  // ── zip 容器（stored，无压缩）────────────────────────────────────────────
  // entries: [{name(ASCII), data(Uint8Array)}] → 合法 zip 字节。
  // 时间戳固定 1980-01-01（DOS 最小合法值）：导出文件的修改时间由文件系统落盘时决定，
  // zip 内部时间无业务意义，固定值保证字节级可复现（便于单测）。
  function buildStoredZip(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const te = new TextEncoder();
    for (const e of entries) {
      const nameBytes = te.encode(e.name);
      const crc = crc32(e.data);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);  // local file header 签名
      lv.setUint16(4, 20, true);          // 需要版本 2.0
      lv.setUint16(8, 0, true);           // method 0 = stored
      lv.setUint16(10, 0, true);          // DOS time 00:00:00
      lv.setUint16(12, 0x21, true);       // DOS date 1980-01-01
      lv.setUint32(14, crc, true);
      lv.setUint32(18, e.data.length, true);
      lv.setUint32(22, e.data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      localParts.push(local, e.data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);  // central dir 签名
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, e.data.length, true);
      cv.setUint32(24, e.data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);     // local header 偏移
      central.set(nameBytes, 46);
      centralParts.push(central);
      offset += local.length + e.data.length;
    }
    const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);    // EOCD 签名
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);       // central dir 起始偏移
    const all = [...localParts, ...centralParts, eocd];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let pos = 0;
    for (const p of all) { out.set(p, pos); pos += p.length; }
    return out;
  }

  // rows: [{skc, skcCode, spu, name}] → xlsx 文件字节
  function buildXlsxBytes(rows) {
    const te = new TextEncoder();
    return buildStoredZip([
      { name: '[Content_Types].xml', data: te.encode(CONTENT_TYPES_XML) },
      { name: '_rels/.rels', data: te.encode(ROOT_RELS_XML) },
      { name: 'xl/workbook.xml', data: te.encode(WORKBOOK_XML) },
      { name: 'xl/_rels/workbook.xml.rels', data: te.encode(WORKBOOK_RELS_XML) },
      { name: 'xl/worksheets/sheet1.xml', data: te.encode(buildSheetXml(rows)) },
      { name: 'xl/styles.xml', data: te.encode(STYLES_XML) },
    ]);
  }

  const api = { crc32, buildSheetXml, buildXlsxBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__SMEXlsx = api;
})(typeof window !== 'undefined' ? window : globalThis);
