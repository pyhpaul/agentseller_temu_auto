// sme-utils：sale_manage_export 纯函数（CSV 转义 / 商品信息字段解析 / 文件名）。
// 双导出：browser 挂 window.__SMEUtils，node 走 module.exports 供单测。
(function (root) {
  'use strict';

  // CSV 单字段转义：含逗号/引号/换行 → 双引号包裹，内部 " → ""
  function csvField(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // ="..." 文本公式形式：Excel 打开即按文本处理（左对齐、长数字不科学计数、不丢精度）。
  // 值内引号先按 Excel 公式语义加倍，再整体走 CSV 转义。空值返回空串不生成 ="" 噪音。
  function csvTextField(v) {
    const s = v == null ? '' : String(v);
    if (s === '') return '';
    return csvField('="' + s.replace(/"/g, '""') + '"');
  }

  // rows: [{skc, skcCode, spu, name}] → CSV 文本（表头 + CRLF，Excel 友好；BOM 由保存层加）。
  // SKC/SKC货号/SPU 用文本公式形式（编号类，防科学计数）；商品名称普通转义。
  function buildCsvText(rows) {
    const lines = ['SKC,SKC货号,SPU,商品名称'];
    for (const r of rows) {
      lines.push([csvTextField(r.skc), csvTextField(r.skcCode), csvTextField(r.spu), csvField(r.name)].join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  // 商品信息格 <p> 文本数组 → {skc, skcCode, spu}。
  // 前缀更长的「SKC货号」必须先于「SKC」匹配，否则被误吞。缺字段返回空串，由调用方分层报错。
  function parseInfoFields(pTexts) {
    const out = { skc: '', skcCode: '', spu: '' };
    for (const raw of pTexts || []) {
      const t = String(raw).trim();
      let m;
      if ((m = t.match(/^SKC货号[：:]\s*(.+)$/))) out.skcCode = m[1].trim();
      else if ((m = t.match(/^SKC[：:]\s*(.+)$/))) out.skc = m[1].trim();
      else if ((m = t.match(/^SPU[：:]\s*(.+)$/))) out.spu = m[1].trim();
    }
    return out;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function buildExportFileName(d, ext) {
    const ymd = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    const hms = pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    return '销售管理清单_' + ymd + '_' + hms + '.' + ext;
  }

  function buildCsvFileName(d) { return buildExportFileName(d, 'csv'); }
  function buildXlsxFileName(d) { return buildExportFileName(d, 'xlsx'); }

  const api = { csvField, csvTextField, buildCsvText, parseInfoFields, buildCsvFileName, buildXlsxFileName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__SMEUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
