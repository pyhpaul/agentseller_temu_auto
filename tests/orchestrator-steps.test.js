const { test } = require('node:test');
const assert = require('node:assert');
const { STEP_DEFS, buildInitialWorkflow, emptyProduct } = require('../automation/orchestrator/steps.js');

test('STEP_DEFS: 14 步、id 唯一、字段完整', () => {
  assert.strictEqual(STEP_DEFS.length, 14);
  const ids = STEP_DEFS.map(d => d.id);
  assert.strictEqual(new Set(ids).size, 14);                       // id 唯一
  for (const d of STEP_DEFS) {
    assert.ok(['auto', 'hitl'].includes(d.type), `${d.id} type 合法`);
    assert.ok(typeof d.domain === 'string' && d.domain, `${d.id} 有 domain`);
    if (d.type === 'auto') assert.ok(d.feature, `${d.id} auto 必有 feature`);
    if (d.type === 'hitl') assert.strictEqual(d.feature, null, `${d.id} hitl feature=null`);
  }
});

test('STEP_DEFS: 6 AUTO + 8 HITL（新增确认申报价 HITL 步）', () => {
  assert.strictEqual(STEP_DEFS.filter(d => d.type === 'auto').length, 6);
  assert.strictEqual(STEP_DEFS.filter(d => d.type === 'hitl').length, 8);
});

test('STEP_DEFS: AUTO 步声明 reversible 布尔值', () => {
  for (const d of STEP_DEFS.filter(d => d.type === 'auto')) {
    assert.strictEqual(typeof d.reversible, 'boolean', `${d.id} reversible 是布尔`);
  }
});

test('buildInitialWorkflow: 初始 workflow 结构正确', () => {
  let n = 0;
  const wf = buildInitialWorkflow({ label: '保温杯' }, () => `w${++n}`);
  assert.strictEqual(wf.id, 'w1');
  assert.strictEqual(wf.status, 'pending');
  assert.strictEqual(wf.cursor, 0);
  assert.strictEqual(wf.product.label, '保温杯');
  assert.strictEqual(wf.product.sourceUrl, null);                  // 选品步回填的源商品 Temu 详情页 url，初始 null
  assert.strictEqual(wf.product.spuId, null);                      // 渐进填充，初始 null
  assert.strictEqual(wf.product.url1688, null);                    // CPO create_sku 输入（比价/下单步回填）
  assert.strictEqual(wf.product.orderNo1688, null);                // CPO create_po 输入（下单步回填）
  assert.strictEqual(wf.product.poNo, null);                       // CPO create_po 产出
  assert.strictEqual(wf.steps.length, 14);
  assert.ok(wf.steps.every(s => s.status === 'pending'));
  assert.strictEqual(wf.steps[0].committing, false);
  assert.deepStrictEqual(wf.tmpTabs, []);
});

test('emptyProduct: 保留 label、其余字段 null（restart 重头复用，字段完整）', () => {
  const p = emptyProduct('保温杯');
  assert.strictEqual(p.label, '保温杯');
  assert.strictEqual(p.sourceUrl, null);
  assert.strictEqual(p.spuId, null);
  assert.strictEqual(p.skc, null);
  assert.strictEqual(p.skuNo, null);
  assert.strictEqual(p.url1688, null);
  assert.strictEqual(p.orderNo1688, null);
  assert.strictEqual(p.poNo, null);
  assert.strictEqual(p.returnPrice, null);          // Temu 参考申报价（④ 人工抄）
  assert.strictEqual(p.cost1688, null);             // 1688 成本价（⑤ 核价填）
  assert.strictEqual(p.domesticShipping, null);     // 国内运费/头程（⑤ 核价填）
  assert.strictEqual(p.grossMargin, null);          // 毛利率快照（确认申报价步落值）
  assert.strictEqual(emptyProduct().label, null);   // 缺 label 不抛
});

test('select_product: 回填步带 sourceUrl hitlSpec（记录选品源商品 url）', () => {
  const sel = STEP_DEFS.find(d => d.id === 'select_product');
  assert.ok(sel.hitlSpec && Array.isArray(sel.hitlSpec.fields), 'select_product 有 hitlSpec.fields');
  const f = sel.hitlSpec.fields.find(x => x.key === 'sourceUrl');
  assert.ok(f, 'hitlSpec 含 sourceUrl 字段');
  assert.strictEqual(f.required, true, 'sourceUrl 必填');
  assert.strictEqual(sel.type, 'hitl');
});

test('confirm_declare_price: 新步存在、HITL、analysis=margin、位于 compare_1688 后 order_1688 前', () => {
  const ids = STEP_DEFS.map(d => d.id);
  const idx = ids.indexOf('confirm_declare_price');
  assert.ok(idx > 0, '存在 confirm_declare_price 步');
  const step = STEP_DEFS[idx];
  assert.strictEqual(step.type, 'hitl');
  assert.strictEqual(step.feature, null);
  assert.strictEqual(step.analysis, 'margin');                    // 核价分析标记（buildHitl 据此填 keyValues）
  assert.ok(ids.indexOf('compare_1688') < idx, '在 compare_1688 之后');
  assert.ok(idx < ids.indexOf('order_1688'), '在 order_1688 之前');
});

test('get_return_price: 加 returnPrice hitlSpec（人工抄 Temu 参考申报价、noFill）', () => {
  const s = STEP_DEFS.find(d => d.id === 'get_return_price');
  assert.ok(s.hitlSpec && Array.isArray(s.hitlSpec.fields));
  assert.strictEqual(s.hitlSpec.noFill, true);                    // 人工抄、大脑推导不了
  const f = s.hitlSpec.fields.find(x => x.key === 'returnPrice');
  assert.ok(f, '含 returnPrice 字段');
  assert.strictEqual(f.required, true);
  assert.strictEqual(f.fieldType, 'number');
});

test('compare_1688: hitlSpec 含 cost1688 + domesticShipping（核价输入）', () => {
  const s = STEP_DEFS.find(d => d.id === 'compare_1688');
  const keys = s.hitlSpec.fields.map(f => f.key);
  assert.ok(keys.includes('url1688'), '保留原 url1688');
  assert.ok(keys.includes('cost1688'), '加 1688成本价');
  assert.ok(keys.includes('domesticShipping'), '加国内运费');
  assert.strictEqual(s.hitlSpec.fields.find(f => f.key === 'cost1688').fieldType, 'number');
});

test('buildInitialWorkflow: analysis 透传到 step + product 含核价字段', () => {
  const wf = buildInitialWorkflow({ label: 'X' }, () => 'w1');
  const cdp = wf.steps.find(s => s.id === 'confirm_declare_price');
  assert.strictEqual(cdp.analysis, 'margin');
  const sel = wf.steps.find(s => s.id === 'select_product');
  assert.strictEqual(sel.analysis, null);                         // 未声明 analysis 透传为 null（非 undefined）
  assert.strictEqual(wf.product.returnPrice, null);
  assert.strictEqual(wf.product.grossMargin, null);
});

test('buildInitialWorkflow: 缺 product.label 不抛、label=null', () => {
  const wf = buildInitialWorkflow({}, () => 'w1');
  assert.strictEqual(wf.product.label, null);
});

test('buildInitialWorkflow: target 字段透传到 step（pack_label 有 / HITL 步无）', () => {
  const wf = buildInitialWorkflow({ label: 'X' }, () => 'w1');
  const pack = wf.steps.find(s => s.id === 'pack_label');
  assert.strictEqual(pack.target.url, 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list');
  assert.strictEqual(pack.target.readySignal, '[class*="shipping-list_choose"]');
  const sel = wf.steps.find(s => s.id === 'select_product');
  assert.strictEqual(sel.target, null);                            // 未声明 target 的步透传为 null（不是 undefined）
});

test('buildInitialWorkflow: ship step 带 target（续刀 auto_ship）', () => {
  const wf = buildInitialWorkflow({ label: 'X' }, () => 'w1');
  const ship = wf.steps.find(s => s.id === 'ship');
  assert.strictEqual(ship.target.url, 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list');
  assert.strictEqual(ship.target.readySignal, '[data-testid="beast-core-table-body-tr"]');
});

test('buildInitialWorkflow: gen_label step 带 target（续刀 auto_gen_label）', () => {
  const wf = buildInitialWorkflow({ label: 'X' }, () => 'w1');
  const gl = wf.steps.find(s => s.id === 'gen_label');
  assert.strictEqual(gl.target.url, 'https://agentseller.temu.com/goods/label');   // 真实后台域 agentseller（seller.temu.com 用户未登录→no-auth）
  // readySignal 用搜索框（页面加载即在），不用表格行（搜索后才出现，等行会死锁超时）
  assert.strictEqual(gl.target.readySignal, 'input#goodsSearchType');
});

test('buildInitialWorkflow: step 带 retryCount=0（Plan 3 self-heal 重试上限）', () => {
  const wf = buildInitialWorkflow({ label: 'X' }, () => 'w1');
  assert.ok(wf.steps.every(s => s.retryCount === 0));
});

test('buildInitialWorkflow：每步含 reviewed:false', () => {
  const wf = buildInitialWorkflow({ label: 'A' }, () => 'id');
  assert.ok(wf.steps.every(s => s.reviewed === false));
});

test('buildInitialWorkflow 透传 publish 步的 gate 字段（防死代码）', () => {
  let n = 0;
  const wf = buildInitialWorkflow({}, () => 'w' + (++n));
  const publish = wf.steps.find(s => s.id === 'publish');
  assert.ok(publish, 'publish 步应存在');
  assert.strictEqual(publish.gate, 'publish', 'publish 步实例必须带 gate:"publish"（经工厂透传，非仅 STEP_DEFS）');
  const sel = wf.steps.find(s => s.id === 'select_product');
  assert.strictEqual(sel.gate, null, '未声明 gate 的步透传为 null（非 undefined）');
});

test('每步都有非空 guide（人工操作指引）且经工厂透传到 step 实例', () => {
  STEP_DEFS.forEach(d => {
    assert.ok(typeof d.guide === 'string' && d.guide.length > 0, `${d.id} STEP_DEFS 应有非空 guide`);
  });
  const wf = buildInitialWorkflow({}, () => 'w1');
  wf.steps.forEach(s => {
    assert.ok(typeof s.guide === 'string' && s.guide.length > 0, `${s.id} 实例应透传非空 guide`);
  });
});

test('collect_dxm: hitlSpec 加 dxmEditUrl 字段（可选、发布步取页锚点）', () => {
  const s = STEP_DEFS.find(d => d.id === 'collect_dxm');
  const f = s.hitlSpec.fields.find(x => x.key === 'dxmEditUrl');
  assert.ok(f, 'collect_dxm 含 dxmEditUrl 字段');
  assert.strictEqual(f.required, false, 'dxmEditUrl 可选（缺则退回旧 query，向后兼容）');
  assert.strictEqual(f.fieldType, 'text');
});

test('emptyProduct + buildInitialWorkflow: 含 dxmEditUrl=null', () => {
  assert.strictEqual(emptyProduct('X').dxmEditUrl, null);
  const wf = buildInitialWorkflow({ label: 'X' }, () => 'w1');
  assert.strictEqual(wf.product.dxmEditUrl, null);
});
