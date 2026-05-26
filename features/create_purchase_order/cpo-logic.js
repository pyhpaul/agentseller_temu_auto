// 纯逻辑：1688 serial 提取 + 识别码拼接 + 输入校验 + 店小秘字段映射。
// 双用途：浏览器挂 window.__CPOLogic；node 测试用 module.exports。
(function () {
  'use strict';

  // "https://detail.1688.com/offer/653412345678.html?..." → "653412345678"；无则 null
  function extractSerial(url1688) {
    const text = String(url1688 == null ? '' : url1688);
    const m = text.match(/\/offer\/(\d+)/);
    return m ? m[1] : null;
  }

  // 识别码 = serial-skuNo
  function buildIdCode(serial, skuNo) {
    return `${serial}-${skuNo}`;
  }

  // 校验 Hub 输入：skc 非空 + url1688 能提取 serial
  function validateInputs({ skc, url1688 } = {}) {
    if (!skc || !String(skc).trim()) {
      return { ok: false, error: 'SKC编码不能为空' };
    }
    const serial = extractSerial(url1688);
    if (!serial) {
      return { ok: false, error: '1688商品url 格式异常，无法提取 serial（应形如 detail.1688.com/offer/数字.html）' };
    }
    return { ok: true, serial };
  }

  // collectedData → 店小秘各字段值（user-name 在页面动态读，不在此）
  function mapDxmFields({ skuNo, title, serial, url1688, previewUrl } = {}) {
    return {
      spuSku: skuNo,
      enName: skuNo,
      platformSku: skuNo,
      cnName: title,
      idCode: buildIdCode(serial, skuNo),
      sourceUrl: url1688,
      imageUrl: previewUrl,
    };
  }

  const api = { extractSerial, buildIdCode, validateInputs, mapDxmFields };
  if (typeof window !== 'undefined') window.__CPOLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
