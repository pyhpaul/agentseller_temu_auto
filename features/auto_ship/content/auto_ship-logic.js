// 纯函数：本地仓判定 / 包裹号有效判定 / 发货单号去重 / 结果汇总。
// 格式无关——DOM 单元格的原始文本提取放 index.js DOM 适配层。
// 双用途：浏览器挂 window.__AutoShipLogic；node 测试用 module.exports。
(function () {
  'use strict';

  const LOCAL_WAREHOUSE = '化州中正科技';
  // 包裹号占位符（无有效值）。「打印打包标签后展示」是待装箱发货 tab 真实空值文案（见 samples/table_and_tabs.txt）。
  const PKG_PLACEHOLDERS = ['', '-', '—', '无', '待生成', '暂无', '未生成', '打印打包标签后展示'];

  // 仓库名（已由 DOM 层提取出的纯名字）是否本地仓。
  function isLocalWarehouse(name) {
    return String(name == null ? '' : name).includes(LOCAL_WAREHOUSE);
  }

  // 包裹号值（已由 DOM 层提取）是否为有效包裹号。
  function isValidPackageNo(value) {
    const v = String(value == null ? '' : value).trim();
    if (!v) return false;
    if (PKG_PLACEHOLDERS.includes(v)) return false;
    if (/^[-—]+$/.test(v)) return false;
    return true;
  }

  // 去重 + 去空 + trim，保持首次出现顺序。
  function dedupOrderNos(list) {
    const seen = new Set();
    const out = [];
    for (const x of list || []) {
      const k = String(x == null ? '' : x).trim();
      if (k && !seen.has(k)) { seen.add(k); out.push(k); }
    }
    return out;
  }

  // 汇总文案：「处理 X 单 / 跳过本地仓 Y / 失败 Z」+ 失败明细行。
  function summarize({ shipped, skippedLocal, fails }) {
    const f = fails || [];
    let s = `处理 ${shipped} 单 / 跳过本地仓 ${skippedLocal} / 失败 ${f.length}`;
    if (f.length) {
      s += '\n' + f.map((x) => `${x.orderNo}｜${x.step}｜${x.reason}`).join('\n');
    }
    return s;
  }

  const api = { LOCAL_WAREHOUSE, PKG_PLACEHOLDERS, isLocalWarehouse, isValidPackageNo, dedupOrderNos, summarize };
  if (typeof window !== 'undefined') window.__AutoShipLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
