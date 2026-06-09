// core/background/orchestrator/steps.js
// 13 原子 step 声明表 + 初始 workflow 工厂。真源 spec §3.2。UMD 双模式（sw importScripts + node 单测）。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.__AS_ORCH_STEPS__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // type: 'auto' 调 feature / 'hitl' 人工卡点。reversible: 中断恢复用（spec §4.2），hitl 步为 null。
  // domain: 目标平台域（导航 + 「前往」用）；精确 urlTemplate/readySignal 由 Plan 2-2 feature 改造补。
  //   ⚠ Temu 系分两子域：create_sku/create_po 用 agentseller.temu.com（CPO 真实域），
  //   auto_gen_label/选品/返单价用 seller.temu.com（核实自各 feature.json host_permissions）。
  //   HITL 步（选品/返单价）domain 为初值，Plan 2-2 按运营实际页校准。
  // create_sku 的 reversible=true 是 spec §3.2 △（写后读可检测已建，半可逆）的落地：
  //   恢复时重跑，由 feature 层做幂等校验，故按可逆处理。
  const STEP_DEFS = [
    { id: 'select_product',   label: '选品',                  type: 'hitl', feature: null,                   reversible: null,  domain: 'seller.temu.com' },
    { id: 'collect_dxm',      label: '店小秘采集建品',        type: 'hitl', feature: null,                   reversible: null,  domain: 'dianxiaomi.com' },
    { id: 'publish',          label: '合规预检+发布',         type: 'auto', feature: 'check_and_publish',     reversible: false, domain: 'dianxiaomi.com' },
    { id: 'get_return_price', label: '获取返单价',            type: 'hitl', feature: null,                   reversible: null,  domain: 'seller.temu.com' },
    { id: 'compare_1688',     label: '1688比价核价',          type: 'hitl', feature: null,                   reversible: null,  domain: '1688.com' },
    { id: 'order_1688',       label: '1688下单',              type: 'hitl', feature: null,                   reversible: null,  domain: '1688.com' },
    { id: 'gen_label',        label: '货号+标签+合规+标签图', type: 'auto', feature: 'auto_gen_label',        reversible: false, domain: 'seller.temu.com' },
    { id: 'create_sku',       label: '建店小秘SKU',           type: 'auto', feature: 'create_purchase_order', reversible: true,  domain: 'agentseller.temu.com' },
    { id: 'create_po',        label: '创建采购单',            type: 'auto', feature: 'create_purchase_order', reversible: false, domain: 'dianxiaomi.com' },
    { id: 'wait_payment',     label: '等财务付款',            type: 'hitl', feature: null,                   reversible: null,  domain: 'dianxiaomi.com' },
    { id: 'wait_arrival',     label: '等到货',                type: 'hitl', feature: null,                   reversible: null,  domain: 'kuajingmaihuo.com' },
    { id: 'pack_label',       label: '打印打包标签',          type: 'auto', feature: 'packing_label',         reversible: true,  domain: 'kuajingmaihuo.com' },
    { id: 'ship',             label: '确认发货',              type: 'auto', feature: 'auto_ship',             reversible: false, domain: 'kuajingmaihuo.com' },
  ];

  // idGen 注入（纯逻辑测试要确定性，不在模块内调 Date.now/random）。
  function buildInitialWorkflow(product, idGen) {
    product = product || {};
    return {
      id: idGen(),
      product: { label: product.label || null, spuId: null, skc: null, skuNo: null, url1688: null, orderNo1688: null, poNo: null },
      status: 'pending',
      cursor: 0,
      startedAt: null,
      updatedAt: null,
      steps: STEP_DEFS.map(d => ({
        id: d.id, label: d.label, feature: d.feature, type: d.type,
        reversible: d.reversible, domain: d.domain,
        status: 'pending', startedAt: null, endedAt: null,
        result: null, brainBrief: '(确定性)', note: null, committing: false, error: null,
      })),
      hitl: null,
      tmpTabs: [],
    };
  }

  return { STEP_DEFS, buildInitialWorkflow };
});
