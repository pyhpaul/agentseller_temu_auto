// automation/orchestrator/steps.js
// 14 原子 step 声明表 + 初始 workflow 工厂。真源 spec §3.2。UMD 双模式（sw importScripts + node 单测）。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.__AS_ORCH_STEPS__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // type: 'auto' 调 feature / 'hitl' 人工卡点。reversible: 中断恢复用（spec §4.2），hitl 步为 null。
  // domain: 目标平台域（导航 + 「前往」用）。auto 步（gen_label/pack_label/ship）已补真实 target.url+readySignal；
  //   HITL 步 domain 仍为初值，按运营实际页校准。
  //   ⚠ Temu 卖家后台真实域 = agentseller.temu.com（用户实测：seller.temu.com 未登录→no-auth.html）。
  //   选品/返单价/确认申报价/gen_label/create_sku/create_po 全用 agentseller.temu.com。
  // create_sku 的 reversible=true 是 spec §3.2 △（写后读可检测已建，半可逆）的落地：
  //   恢复时重跑，由 feature 层做幂等校验，故按可逆处理。
  // hitlSpec: 回填型 HITL 的字段元数据（fields[{key,label,fieldType,required}]）。engine.buildHitl 读它
  //   条件化 editable；overlay 据此渲染回填控件。无 hitlSpec 的 hitl 步为纯确认型（editable=false）。
  //   hitlSpec.noFill=true：字段仍人工可输入，但值大脑无法推导（人工/外部产出，如 SKC 经店小秘插件采集），
  //   故跳过大脑回填提议，避免弱模型幻觉出假值污染建议（bg-entry orchRequestFillSuggest 检测此标记）。
  //   首版一 SKC 一 SKU、单值契约（多变种 per-SKU 数组留后续）。
  const STEP_DEFS = [
    { id: 'select_product',   label: '选品',                  type: 'hitl', feature: null,                   reversible: null,  domain: 'agentseller.temu.com',
      // 记录选品的源商品 Temu 详情页 url（流水线第一个锚点）。当前仅记录进 product.sourceUrl；
      // 后续方案承接：基于此 url 自动化完成店小秘一键采集（collect_dxm 升级为 url 驱动半自动）。
      guide: '在 Temu 商家中心选定要做的商品 → 复制该商品详情页 URL 填入下方 → 点提交。',
      hitlSpec: { noFill: true, fields: [
        { key: 'sourceUrl', label: 'Temu 商品详情页 URL', fieldType: 'text', required: true },
      ] } },
    { id: 'collect_dxm',      label: '店小秘采集建品',        type: 'hitl', feature: null,                   reversible: null,  domain: 'dianxiaomi.com',
      guide: '用店小秘插件对该商品一键采集建品并完成编辑 → 把生成的 SKC（SPU ID 若有）填入下方 → 点提交。',
      hitlSpec: { noFill: true, fields: [
        { key: 'skc',   label: 'SKC（采集后创建，唯一）', fieldType: 'text', required: true },
        { key: 'spuId', label: 'SPU ID（可选）',          fieldType: 'text', required: false },
      ] } },
    { id: 'publish',          label: '合规预检+发布',         type: 'auto', feature: 'check_and_publish',     reversible: false, gate: 'publish', domain: 'dianxiaomi.com',
      guide: '先在店小秘打开该商品编辑页（URL 含 edit）→ 点「检查」看合规结果 → 通过后点「发布」（或勾「自动发布」让检查通过即发）。' },
    { id: 'get_return_price', label: '获取返单价',            type: 'hitl', feature: null,                   reversible: null,  domain: 'agentseller.temu.com',
      // 等 Temu 后台审核返回的参考申报价，人工从商家中心抄填（大脑无从推导 → noFill）。
      guide: '等 Temu 后台审核返回参考申报价（小时/天级）→ 在商家中心查到后把参考申报价填入下方 → 点提交。',
      hitlSpec: { noFill: true, fields: [
        { key: 'returnPrice', label: 'Temu 参考申报价', fieldType: 'number', required: true },
      ] } },
    { id: 'compare_1688',     label: '1688比价核价',          type: 'hitl', feature: null,                   reversible: null,  domain: '1688.com',
      // 核价输入：货源链接 + 1688成本价 + 国内运费（供下一步「确认申报价」算毛利率）。运费可空按 0 计。
      guide: '在 1688 找到货源 → 把货源链接、成本价、国内运费（可空按 0）填入下方 → 点提交；下一步据此算毛利率。',
      hitlSpec: { noFill: true, fields: [
        { key: 'url1688',          label: '1688 货源链接', fieldType: 'text',   required: true },
        { key: 'cost1688',         label: '1688 成本价',   fieldType: 'number', required: true },
        { key: 'domesticShipping', label: '国内运费/头程', fieldType: 'number', required: false },
      ] } },
    // 确认申报价格：HITL 人工确认步，内嵌核价分析（analysis:'margin'）。
    // engine.buildHitl 据 analysis 标记调 computeMargin 把毛利率填进 keyValues 展示（复用纯确认型卡）；
    // 人工在商家中心实点「确认申报价格」后于 dashboard 点确认 → orchHitlConfirm 落 grossMargin 快照 → 推进。
    { id: 'confirm_declare_price', label: '确认申报价格',     type: 'hitl', feature: null,                   reversible: null,  domain: 'agentseller.temu.com', analysis: 'margin',
      guide: '核对下方毛利率，可接受则在 Temu 商家中心实际点「确认申报价格」→ 回此点「确认完成」推进。' },
    { id: 'order_1688',       label: '1688下单',              type: 'hitl', feature: null,                   reversible: null,  domain: '1688.com',
      guide: '在 1688 对该货源下单付款 → 把 1688 订单号填入下方 → 点提交。',
      hitlSpec: { noFill: true, fields: [{ key: 'orderNo1688', label: '1688 订单号', fieldType: 'text', required: true }] } },
    { id: 'gen_label',        label: '货号+标签+合规+标签图', type: 'auto', feature: 'auto_gen_label',        reversible: false, domain: 'agentseller.temu.com',
      guide: '确认下方已采集数据无误 → 点「确认提交」放行；系统会自动打开 Temu 货号/标签页生成货号+标签+合规+标签图。',
      // ⚠ 真实卖家后台域是 agentseller.temu.com（非 seller.temu.com）——后者用户未登录→no-auth.html。
      // readySignal 用搜索框（页面加载即在），不用表格行——条码页搜索驱动，行要按 SKC 搜索后才出现，
      // content 的 AGL_GEN_LABEL 自己 ensureSkcSearchInput→搜索→等行；等表格行当就绪会死锁超时。
      target: { url: 'https://agentseller.temu.com/goods/label', readySignal: 'input#goodsSearchType' } },
    { id: 'create_sku',       label: '建店小秘SKU',           type: 'auto', feature: 'create_purchase_order', reversible: true,  domain: 'agentseller.temu.com',
      guide: '自动步：系统据 1688 链接在店小秘自动建 SKU，无需操作；若报错按错误卡提示处理。' },
    { id: 'create_po',        label: '创建采购单',            type: 'auto', feature: 'create_purchase_order', reversible: false, domain: 'dianxiaomi.com',
      guide: '确认下方已采集数据无误 → 点「确认提交」放行；系统会自动在店小秘创建采购单（填 1688 订单号 + 配对）。' },
    { id: 'wait_payment',     label: '等财务付款',            type: 'hitl', feature: null,                   reversible: null,  domain: 'dianxiaomi.com',
      guide: '等财务在店小秘完成采购单付款 → 付款后点「确认完成」推进。' },
    { id: 'wait_arrival',     label: '等到货',                type: 'hitl', feature: null,                   reversible: null,  domain: 'kuajingmaihuo.com',
      guide: '等货到仓 → 到货后点「确认完成」推进。' },
    { id: 'pack_label',       label: '打印打包标签',          type: 'auto', feature: 'packing_label',         reversible: true,  domain: 'seller.kuajingmaihuo.com',
      guide: '自动步：系统自动打开发货台打印打包标签，无需操作；若报错按错误卡提示处理。',
      target: { url: 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list', readySignal: '[class*="shipping-list_choose"]' } },
    { id: 'ship',             label: '确认发货',              type: 'auto', feature: 'auto_ship',             reversible: false, domain: 'kuajingmaihuo.com',
      guide: '确认下方已采集数据无误 → 点「确认提交」放行；系统会自动打开发货台执行确认发货。',
      target: { url: 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list', readySignal: '[data-testid="beast-core-table-body-tr"]' } },
  ];

  // 初始 product 工厂（buildInitialWorkflow + orchestrator restart 重头共用，单一真源防字段漂移）。
  function emptyProduct(label) {
    return { label: label || null, sourceUrl: null, spuId: null, skc: null, skuNo: null, url1688: null, orderNo1688: null, poNo: null,
      returnPrice: null, cost1688: null, domesticShipping: null, grossMargin: null };
  }

  // idGen 注入（纯逻辑测试要确定性，不在模块内调 Date.now/random）。
  function buildInitialWorkflow(product, idGen) {
    product = product || {};
    return {
      id: idGen(),
      product: emptyProduct(product.label),
      status: 'pending',
      cursor: 0,
      startedAt: null,
      updatedAt: null,
      steps: STEP_DEFS.map(d => ({
        id: d.id, label: d.label, feature: d.feature, type: d.type,
        reversible: d.reversible, domain: d.domain, target: d.target || null,
        hitlSpec: d.hitlSpec || null,
        gate: d.gate || null, analysis: d.analysis || null, guide: d.guide || '',
        status: 'pending', startedAt: null, endedAt: null,
        result: null, brainBrief: '(确定性)', note: null, committing: false, error: null, retryCount: 0, reviewed: false,
      })),
      hitl: null,
      tmpTabs: [],
    };
  }

  return { STEP_DEFS, buildInitialWorkflow, emptyProduct };
});
