// sme-utils：sale_manage_export 纯函数（CSV 转义 / 商品信息字段解析 / 文件名）。
// 双导出：browser 挂 window.__SMEUtils，node 走 module.exports 供单测。
(function (root) {
  'use strict';

  // CSV 单字段转义：含逗号/引号/换行 → 双引号包裹，内部 " → ""
  function csvField(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // rows: [{skc, skcCode, spu, name}] → CSV 文本（表头 + CRLF，Excel 友好；BOM 由保存层加）
  function buildCsvText(rows) {
    const lines = ['SKC,SKC货号,SPU,商品名称'];
    for (const r of rows) {
      lines.push([csvField(r.skc), csvField(r.skcCode), csvField(r.spu), csvField(r.name)].join(','));
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

  function buildCsvFileName(d) {
    const ymd = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    const hms = pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    return '销售管理清单_' + ymd + '_' + hms + '.csv';
  }

  const api = { csvField, buildCsvText, parseInfoFields, buildCsvFileName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__SMEUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
