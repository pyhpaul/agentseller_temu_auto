const { test } = require('node:test');
const assert = require('node:assert');
const { STEP_DEFS, buildInitialWorkflow, emptyProduct } = require('../automation/orchestrator/steps.js');

test('STEP_DEFS: 13 步、id 唯一、字段完整', () => {
  assert.strictEqual(STEP_DEFS.length, 13);
  const ids = STEP_DEFS.map(d => d.id);
  assert.strictEqual(new Set(ids).size, 13);                       // id 唯一
  for (const d of STEP_DEFS) {
    assert.ok(['auto', 'hitl'].includes(d.type), `${d.id} type 合法`);
    assert.ok(typeof d.domain === 'string' && d.domain, `${d.id} 有 domain`);
    if (d.type === 'auto') assert.ok(d.feature, `${d.id} auto 必有 feature`);
    if (d.type === 'hitl') assert.strictEqual(d.feature, null, `${d.id} hitl feature=null`);
  }
});

test('STEP_DEFS: 6 AUTO + 7 HITL（spec §3.2）', () => {
  assert.strictEqual(STEP_DEFS.filter(d => d.type === 'auto').length, 6);
  assert.strictEqual(STEP_DEFS.filter(d => d.type === 'hitl').length, 7);
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
  assert.strictEqual(wf.steps.length, 13);
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
  assert.strictEqual(gl.target.url, 'https://seller.temu.com/goods/label');
  assert.strictEqual(gl.target.readySignal, 'tr[data-testid="beast-core-table-body-tr"]');
});

test('buildInitialWorkflow: step 带 retryCount=0（Plan 3 self-heal 重试上限）', () => {
  const wf = buildInitialWorkflow({ label: 'X' }, () => 'w1');
  assert.ok(wf.steps.every(s => s.retryCount === 0));
});

test('buildInitialWorkflow：每步含 reviewed:false', () => {
  const wf = buildInitialWorkflow({ label: 'A' }, () => 'id');
  assert.ok(wf.steps.every(s => s.reviewed === false));
});
