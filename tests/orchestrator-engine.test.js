// tests/orchestrator-engine.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { makeEngine, buildHitl, buildReviewHitl, buildPublishHitl, pickProduct, computeMargin } = require('../automation/orchestrator/engine.js');
const { makeMutationQueue } = require('../automation/orchestrator/mutation-queue.js');

// fake storage：深拷贝读（防引用串改），内存写
function fakeStore(skeleton) {
  let val = skeleton;
  return {
    read: async () => JSON.parse(JSON.stringify(val)),
    write: async (v) => { val = v; },
    peek: () => val,
  };
}

// minimal skeleton：batch 里放一个 workflow（engine 测试聚焦推进/恢复，用 2-3 步 fixture；13 步结构见 steps.test.js）
function mkSkeleton(steps, over) {
  const wf = Object.assign({
    id: 'w1', product: {}, status: 'running', cursor: 0,
    steps, hitl: null, tmpTabs: [],
  }, over);
  return { schemaVersion: 1, batch: { id: 'b1', activeWorkflowId: 'w1', workflows: [wf] } };
}
function mkStep(over) {
  return Object.assign({
    id: 's', label: 'L', type: 'auto', status: 'pending',
    reversible: false, committing: false, result: null, error: null, target: null,
  }, over);
}
function setupEngine(skeleton, stepRunner, onStepSettled) {
  const store = fakeStore(skeleton);
  const queue = makeMutationQueue(store.read, store.write);
  const engine = makeEngine({ read: store.read, queue, stepRunner, now: () => 1, onStepSettled });
  return { engine, store };
}
const wf0 = (store) => store.peek().batch.workflows[0];

test('advance：auto 步跑 stub → done + result + product 回填', async () => {
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a' })]),
    async () => ({ status: 'done', result: { spuId: 'SPU9' } })
  );
  await engine.advance('w1');
  assert.strictEqual(wf0(store).steps[0].status, 'done');
  assert.deepStrictEqual(wf0(store).steps[0].result, { spuId: 'SPU9' });
  assert.strictEqual(wf0(store).product.spuId, 'SPU9');   // 渐进填充
  assert.strictEqual(wf0(store).status, 'done');          // 单步且末尾 → complete
});

test('advance：result 含 url1688/orderNo1688/poNo → product 全回填（CPO 数据流）', async () => {
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a' })]),
    async () => ({ status: 'done', result: { skuNo: 'SKU1', poNo: 'PO9', url1688: 'https://detail.1688.com/offer/123.html', orderNo1688: 'ORD7' } })
  );
  await engine.advance('w1');
  assert.strictEqual(wf0(store).product.skuNo, 'SKU1');
  assert.strictEqual(wf0(store).product.poNo, 'PO9');
  assert.strictEqual(wf0(store).product.url1688, 'https://detail.1688.com/offer/123.html');
  assert.strictEqual(wf0(store).product.orderNo1688, 'ORD7');
});

test('buildHitl：带 hitlSpec.fields 的步 → editable=true + fields', () => {
  const step = { id: 'compare_1688', label: '1688比价核价',
    hitlSpec: { fields: [{ key: 'url1688', label: '1688 货源链接', fieldType: 'text', required: true }] } };
  const h = buildHitl(step);
  assert.strictEqual(h.editable, true);
  assert.strictEqual(h.fields.length, 1);
  assert.strictEqual(h.fields[0].key, 'url1688');
});

test('buildHitl：无 hitlSpec 的纯确认步 → editable=false + fields 空', () => {
  // wait_payment（等付款）是真纯确认步；select_product 现已带 sourceUrl hitlSpec（回填步）
  const h = buildHitl({ id: 'wait_payment', label: '等财务付款' });
  assert.strictEqual(h.editable, false);
  assert.deepStrictEqual(h.fields, []);
});

test('buildHitl：hitlSpec.fields 空数组 → editable=false', () => {
  const h = buildHitl({ id: 'x', label: 'x', hitlSpec: { fields: [] } });
  assert.strictEqual(h.editable, false);
});

test('pickProduct：提取 sourceUrl（选品步回填的源商品锚点）', () => {
  const out = pickProduct({ sourceUrl: 'https://seller.temu.com/goods/detail?id=123', skc: 'SKC1' });
  assert.strictEqual(out.sourceUrl, 'https://seller.temu.com/goods/detail?id=123');
  assert.strictEqual(out.skc, 'SKC1');
});

test('pickProduct：忽略未白名单字段、null 不覆盖', () => {
  const out = pickProduct({ sourceUrl: null, bogus: 'x', poNo: 'PO9' });
  assert.ok(!('sourceUrl' in out));   // null 不进（渐进填充不抹）
  assert.ok(!('bogus' in out));       // 非白名单忽略
  assert.strictEqual(out.poNo, 'PO9');
});

test('pickProduct：提取核价字段 returnPrice/cost1688/domesticShipping（④⑤回填 → product）', () => {
  const out = pickProduct({ returnPrice: '100', cost1688: '60', domesticShipping: '5' });
  assert.strictEqual(out.returnPrice, '100');   // ④ 填的参考申报价必须进 product，否则 ⑥ 核价读不到
  assert.strictEqual(out.cost1688, '60');
  assert.strictEqual(out.domesticShipping, '5');
});

test('advance：多 auto 步连续推进到末尾 done', async () => {
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a' }), mkStep({ id: 'b' }), mkStep({ id: 'c' })]),
    async (step) => ({ status: 'done', result: { ran: step.id } })
  );
  await engine.advance('w1');
  assert.ok(wf0(store).steps.every(s => s.status === 'done'));
  assert.strictEqual(wf0(store).status, 'done');
  assert.strictEqual(wf0(store).cursor, 2);               // 停在最后一步
});

test('advance：遇 hitl 步 → paused + hitl 摘要 + 停（不驻留）', async () => {
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a' }), mkStep({ id: 'h', type: 'hitl' }), mkStep({ id: 'c' })]),
    async () => ({ status: 'done', result: {} })
  );
  await engine.advance('w1');
  assert.strictEqual(wf0(store).steps[0].status, 'done');
  assert.strictEqual(wf0(store).steps[1].status, 'paused');
  assert.strictEqual(wf0(store).status, 'paused');
  assert.strictEqual(wf0(store).cursor, 1);               // 停在 hitl 步
  assert.strictEqual(wf0(store).hitl.stepId, 'h');
  assert.strictEqual(wf0(store).hitl.status, 'pending');
  assert.strictEqual(wf0(store).steps[2].status, 'pending'); // 后续未动
});

test('advance：auto 步 stub 返回 error → step.error + workflow.error + 停', async () => {
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a' }), mkStep({ id: 'b' })]),
    async () => ({ status: 'error', error: { category: 'business', code: 'X', message: '失败', recoverable: false } })
  );
  await engine.advance('w1');
  assert.strictEqual(wf0(store).steps[0].status, 'error');
  assert.strictEqual(wf0(store).steps[0].error.code, 'X');
  assert.strictEqual(wf0(store).status, 'error');
  assert.strictEqual(wf0(store).steps[1].status, 'pending'); // 不继续
});

test('advance：stepRunner 抛异常 → 包成 read 类 error', async () => {
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a' })]),
    async () => { throw new Error('boom'); }
  );
  await engine.advance('w1');
  assert.strictEqual(wf0(store).steps[0].status, 'error');
  assert.strictEqual(wf0(store).steps[0].error.category, 'read');
  assert.strictEqual(wf0(store).steps[0].error.code, 'STEP_THREW');
  assert.strictEqual(wf0(store).status, 'error');
});

test('advance：workflow 非 running（paused）→ noop 不动', async () => {
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a' })], { status: 'paused' }),
    async () => ({ status: 'done', result: {} })
  );
  await engine.advance('w1');
  assert.strictEqual(wf0(store).steps[0].status, 'pending');  // 没跑
});

test('advance：workflowId 不存在 → 安全 noop（不抛）', async () => {
  const { engine } = setupEngine(mkSkeleton([mkStep({})]), async () => ({ status: 'done' }));
  await engine.advance('nonexistent');   // 不抛即通过
});

test('recover：可逆 running 步 → 重置 pending 并续跑', async () => {
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a', status: 'running', reversible: true })]),
    async (step) => ({ status: 'done', result: { ran: step.id } })
  );
  const d = await engine.recover('w1');
  assert.strictEqual(d.action, 'rerun');
  assert.strictEqual(wf0(store).steps[0].status, 'done');   // 重跑后完成
  assert.strictEqual(wf0(store).status, 'done');
});

test('recover：不可逆 + committing 中断 → ask-hitl（paused + 恢复确认）', async () => {
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a', status: 'running', reversible: false, committing: true })]),
    async () => ({ status: 'done', result: {} })
  );
  const d = await engine.recover('w1');
  assert.strictEqual(d.action, 'ask-hitl');
  assert.strictEqual(wf0(store).steps[0].status, 'paused');
  assert.strictEqual(wf0(store).status, 'paused');
  assert.strictEqual(wf0(store).hitl.fieldType, 'recovery');
  assert.ok(wf0(store).hitl.action.includes('恢复确认'));
});

test('recover：workflow 非 running → none（无中断）', async () => {
  const { engine } = setupEngine(mkSkeleton([mkStep({ status: 'done' })], { status: 'done' }), async () => ({}));
  const d = await engine.recover('w1');
  assert.strictEqual(d.action, 'none');
});

test('onStepSettled：每步落地后被调（auto 步 done 通知，hitl 步不调）', async () => {
  const calls = [];
  const { engine } = setupEngine(
    mkSkeleton([mkStep({ id: 'a' }), mkStep({ id: 'h', type: 'hitl' })]),
    async () => ({ status: 'done', result: {} }),
    (wfId, step, res) => calls.push({ id: step.id, status: res.status })
  );
  await engine.advance('w1');
  assert.strictEqual(calls.length, 1);                       // 只 a 是 auto（h 是 hitl 不跑 stepRunner）
  assert.deepStrictEqual(calls[0], { id: 'a', status: 'done' });
});

test('onStepSettled：throw 步也通知（覆盖第一刀缺口）', async () => {
  const calls = [];
  const { engine } = setupEngine(
    mkSkeleton([mkStep({ id: 'a' })]),
    async () => { throw new Error('boom'); },
    (wfId, step, res) => calls.push(res)
  );
  await engine.advance('w1');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].status, 'error');
  assert.strictEqual(calls[0].error.code, 'STEP_THREW');     // throw 被 catch 包成 error 后通知
});

test('applyDiagnosis：retry → step 重置 pending + retryCount+1 + 续跑', async () => {
  let runs = 0;
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a', status: 'error', error: { category: 'read', recoverable: true }, retryCount: 0 })],
      { status: 'error' }),
    async () => { runs++; return { status: 'done', result: {} }; }
  );
  await engine.applyDiagnosis('w1', { stepId: 'a', action: 'retry', reason: '瞬时' });
  assert.strictEqual(runs, 1);                               // 重跑了
  assert.strictEqual(wf0(store).steps[0].status, 'done');    // 重跑成功
  assert.strictEqual(wf0(store).steps[0].retryCount, 1);     // +1
});

test('applyDiagnosis：escalate → 转 paused HITL + reason', async () => {
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a', status: 'error', error: { category: 'validate', recoverable: true }, retryCount: 0 })],
      { status: 'error' }),
    async () => ({ status: 'done' })
  );
  await engine.applyDiagnosis('w1', { stepId: 'a', action: 'escalate', reason: '需人工' });
  assert.strictEqual(wf0(store).steps[0].status, 'paused');
  assert.strictEqual(wf0(store).status, 'paused');
  assert.ok(wf0(store).hitl.reviewedBrief.includes('需人工'));
});

test('applyDiagnosis：红线—recoverable:false 的 retry 被强制 escalate（不重跑）', async () => {
  let runs = 0;
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a', status: 'error', error: { category: 'read', recoverable: false }, retryCount: 0 })],
      { status: 'error' }),
    async () => { runs++; return { status: 'done' }; }
  );
  await engine.applyDiagnosis('w1', { stepId: 'a', action: 'retry', reason: '大脑误判' });
  assert.strictEqual(runs, 0);                               // 不可逆绝不重跑
  assert.strictEqual(wf0(store).steps[0].status, 'paused');  // 强制转人工
});

test('applyDiagnosis：红线—retryCount 达上限的 retry 被强制 escalate（不重跑）', async () => {
  let runs = 0;
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a', status: 'error', error: { category: 'read', recoverable: true }, retryCount: 2 })],
      { status: 'error' }),
    async () => { runs++; return { status: 'done' }; }
  );
  await engine.applyDiagnosis('w1', { stepId: 'a', action: 'retry', reason: '超限仍重试' });
  assert.strictEqual(runs, 0);                               // 达上限不重跑
  assert.strictEqual(wf0(store).steps[0].status, 'paused');
});

test('onPaused：回填型 HITL pause 时被调（传 workflowId）', async () => {
  const store = fakeStore(mkSkeleton([mkStep({ id: 'h', type: 'hitl', status: 'pending', hitlSpec: { fields: [{ key: 'skc' }] } })]));
  const queue = makeMutationQueue(store.read, store.write);
  let pausedId = null;
  const engine = makeEngine({ read: store.read, queue, stepRunner: async () => ({ status: 'done' }), now: () => 1, onPaused: (id) => { pausedId = id; } });
  await engine.advance('w1');
  assert.strictEqual(wf0(store).status, 'paused');
  assert.strictEqual(pausedId, 'w1');
});

test('onPaused：缺省不报错（向后兼容）', async () => {
  const store = fakeStore(mkSkeleton([mkStep({ id: 'h', type: 'hitl', status: 'pending' })]));
  const queue = makeMutationQueue(store.read, store.write);
  const engine = makeEngine({ read: store.read, queue, stepRunner: async () => ({ status: 'done' }), now: () => 1 });
  await engine.advance('w1');   // 无 onPaused 注入也不抛
  assert.strictEqual(wf0(store).status, 'paused');
});

test('reviewGate：不可逆步 hold → 暂停 review-HITL，不跑 adapter', async () => {
  const store = fakeStore(mkSkeleton([mkStep({ id: 'pub', reversible: false })]));
  const queue = makeMutationQueue(store.read, store.write);
  let ran = false;
  const engine = makeEngine({
    read: store.read, queue, now: () => 1,
    stepRunner: async () => { ran = true; return { status: 'done' }; },
    reviewGate: async () => ({ verdict: 'hold', reason: 'skc空', concerns: ['skc 缺失'] }),
  });
  await engine.advance('w1');
  assert.strictEqual(ran, false);
  assert.strictEqual(wf0(store).status, 'paused');
  assert.strictEqual(wf0(store).hitl.kind, 'review');
  assert.deepStrictEqual(wf0(store).hitl.concerns, ['skc 缺失']);
});

test('reviewGate：不可逆步 pass → 跑 adapter + 标 reviewed', async () => {
  const store = fakeStore(mkSkeleton([mkStep({ id: 'pub', reversible: false })]));
  const queue = makeMutationQueue(store.read, store.write);
  let ran = false;
  const engine = makeEngine({
    read: store.read, queue, now: () => 1,
    stepRunner: async () => { ran = true; return { status: 'done' }; },
    reviewGate: async () => ({ verdict: 'pass' }),
  });
  await engine.advance('w1');
  assert.strictEqual(ran, true);
  assert.strictEqual(wf0(store).steps[0].reviewed, true);
  assert.strictEqual(wf0(store).steps[0].status, 'done');
});

test('reviewGate：null（离线/超时）→ 照常跑 adapter', async () => {
  const store = fakeStore(mkSkeleton([mkStep({ id: 'pub', reversible: false })]));
  const queue = makeMutationQueue(store.read, store.write);
  let ran = false;
  const engine = makeEngine({
    read: store.read, queue, now: () => 1,
    stepRunner: async () => { ran = true; return { status: 'done' }; },
    reviewGate: async () => null,
  });
  await engine.advance('w1');
  assert.strictEqual(ran, true);
});

test('publish 两段闸：即使大脑判 pass 也停 await-check，不跑 adapter', async () => {
  const store = fakeStore(mkSkeleton([mkStep({ id: 'pub', reversible: false, gate: 'publish' })]));
  const queue = makeMutationQueue(store.read, store.write);
  let ran = false;
  const engine = makeEngine({
    read: store.read, queue, now: () => 1,
    stepRunner: async () => { ran = true; return { status: 'done' }; },
    reviewGate: async () => ({ verdict: 'pass' }),   // 大脑放行也不放行：publish 闸不依赖大脑判断
  });
  await engine.advance('w1');
  assert.strictEqual(ran, false);
  assert.strictEqual(wf0(store).status, 'paused');
  assert.strictEqual(wf0(store).hitl.kind, 'publish');
  assert.strictEqual(wf0(store).hitl.phase, 'await-check');
});

test('publish 两段闸：无 reviewGate 注入也停 await-check（不依赖大脑）', async () => {
  const store = fakeStore(mkSkeleton([mkStep({ id: 'pub', reversible: false, gate: 'publish' })]));
  const queue = makeMutationQueue(store.read, store.write);
  let ran = false;
  const engine = makeEngine({
    read: store.read, queue, now: () => 1,
    stepRunner: async () => { ran = true; return { status: 'done' }; },
  });
  await engine.advance('w1');
  assert.strictEqual(ran, false);
  assert.strictEqual(wf0(store).status, 'paused');
  assert.strictEqual(wf0(store).hitl.kind, 'publish');
  assert.strictEqual(wf0(store).hitl.phase, 'await-check');
});

test('buildPublishHitl 形态', () => {
  const h = buildPublishHitl({ id: 'publish', label: '合规预检+发布' }, { phase: 'await-publish', checkResult: { passCount: 3 } });
  assert.strictEqual(h.kind, 'publish');
  assert.strictEqual(h.phase, 'await-publish');
  assert.strictEqual(h.checkResult.passCount, 3);
  assert.strictEqual(h.editable, false);
  assert.strictEqual(h.stepId, 'publish');
});

test('三个 builder 都把 step.guide 带进 hitl（操作指引上卡）', () => {
  const step = { id: 'x', label: 'L', guide: '去做某事再回来点确认' };
  assert.strictEqual(buildHitl(step, {}).guide, '去做某事再回来点确认');
  assert.strictEqual(buildReviewHitl(step, {}).guide, '去做某事再回来点确认');
  assert.strictEqual(buildPublishHitl(step, {}).guide, '去做某事再回来点确认');
  // 无 guide → 空串（非 undefined）
  assert.strictEqual(buildHitl({ id: 'y', label: 'L' }, {}).guide, '');
});

test('reviewGate：可逆步(reversible:true) 不复核', async () => {
  const store = fakeStore(mkSkeleton([mkStep({ id: 'sku', reversible: true })]));
  const queue = makeMutationQueue(store.read, store.write);
  let gated = false;
  const engine = makeEngine({
    read: store.read, queue, now: () => 1,
    stepRunner: async () => ({ status: 'done' }),
    reviewGate: async () => { gated = true; return { verdict: 'hold' }; },
  });
  await engine.advance('w1');
  assert.strictEqual(gated, false);
  assert.strictEqual(wf0(store).status, 'done');
});

test('reviewGate：已 reviewed 步不重复复核', async () => {
  const store = fakeStore(mkSkeleton([mkStep({ id: 'pub', reversible: false, reviewed: true })]));
  const queue = makeMutationQueue(store.read, store.write);
  let gated = false;
  const engine = makeEngine({
    read: store.read, queue, now: () => 1,
    stepRunner: async () => ({ status: 'done' }),
    reviewGate: async () => { gated = true; return { verdict: 'hold' }; },
  });
  await engine.advance('w1');
  assert.strictEqual(gated, false);
});

test('reviewGate：无注入 → 不可逆步照常跑（向后兼容）', async () => {
  const store = fakeStore(mkSkeleton([mkStep({ id: 'pub', reversible: false })]));
  const queue = makeMutationQueue(store.read, store.write);
  let ran = false;
  const engine = makeEngine({ read: store.read, queue, now: () => 1, stepRunner: async () => { ran = true; return { status: 'done' }; } });
  await engine.advance('w1');
  assert.strictEqual(ran, true);
});

test('reviewGate：approve 后(reviewed:true + status:pending) → advance 跑 adapter、不重核、step done', async () => {
  // 模拟 orchReviewApprove 后的状态：人工确认提交，step 回 pending + reviewed=true
  const store = fakeStore(mkSkeleton([mkStep({ id: 'pub', reversible: false, reviewed: true, status: 'pending' })]));
  const queue = makeMutationQueue(store.read, store.write);
  let ran = false, gated = false;
  const engine = makeEngine({
    read: store.read, queue, now: () => 1,
    stepRunner: async () => { ran = true; return { status: 'done' }; },
    reviewGate: async () => { gated = true; return { verdict: 'hold' }; },
  });
  await engine.advance('w1');
  assert.strictEqual(gated, false);                     // 已 reviewed → 不重核
  assert.strictEqual(ran, true);                        // 不可逆 adapter 真跑了（approve 生效）
  assert.strictEqual(wf0(store).steps[0].status, 'done');
});

test('reviewGate：paused 步(未回 pending) → advance noop，不跑 adapter（证明 approve 必须回 pending）', async () => {
  // 反证：若 approve 漏设 status=pending，step 停 paused → decideNext noop → adapter 永不跑
  const store = fakeStore(mkSkeleton([mkStep({ id: 'pub', reversible: false, reviewed: true, status: 'paused' })], { status: 'running' }));
  const queue = makeMutationQueue(store.read, store.write);
  let ran = false;
  const engine = makeEngine({ read: store.read, queue, now: () => 1, stepRunner: async () => { ran = true; return { status: 'done' }; } });
  await engine.advance('w1');
  assert.strictEqual(ran, false);                       // paused 步不跑（这就是 bug 的根因，approve 修复后不会停 paused）
});

test('buildReviewHitl：review-kind + concerns', () => {
  const h = buildReviewHitl({ id: 'ship', label: '确认发货', target: { url: 'u' } }, { verdict: 'hold', reason: 'r', concerns: ['c1'] });
  assert.strictEqual(h.kind, 'review');
  assert.strictEqual(h.editable, false);
  assert.deepStrictEqual(h.concerns, ['c1']);
  assert.strictEqual(h.targetUrl, 'u');
});

test('buildReviewHitl 带 product → keyValues 只含非空字段（复核卡可核对放行前数据）', () => {
  const h = buildReviewHitl({ id: 'gen_label', label: 'L' }, { concerns: [] }, { skc: 'S1', spuId: '', poNo: null, orderNo1688: 'O9' });
  assert.strictEqual(h.keyValues.skc, 'S1');
  assert.strictEqual(h.keyValues.orderNo1688, 'O9');
  assert.ok(!('spuId' in h.keyValues), '空串字段不显示');
  assert.ok(!('poNo' in h.keyValues), 'null 字段不显示');
});

// ── 利润率计算 computeMargin（确认申报价步核价分析；毛利率口径=(申报-成本-运费)/申报）──
test('computeMargin：正常 → 毛利率=(申报-成本-运费)/申报，display 含各项', () => {
  const m = computeMargin({ returnPrice: 100, cost1688: 60, domesticShipping: 5 });
  assert.strictEqual(m.ok, true);
  assert.ok(Math.abs(m.value - 0.35) < 1e-9);            // (100-60-5)/100
  assert.strictEqual(m.display['毛利率'], '35.0%');
  assert.strictEqual(m.display['参考申报价'], '100');
  assert.strictEqual(m.display['1688成本价'], '60');
  assert.strictEqual(m.display['国内运费'], '5');
});

test('computeMargin：字符串入参（HITL 输入框存 string）也解析', () => {
  const m = computeMargin({ returnPrice: '80', cost1688: '50', domesticShipping: '0' });
  assert.strictEqual(m.ok, true);
  assert.ok(Math.abs(m.value - 0.375) < 1e-9);           // (80-50)/80
});

test('computeMargin：负利润 → ok:true 但 value/毛利率为负', () => {
  const m = computeMargin({ returnPrice: 50, cost1688: 60, domesticShipping: 0 });
  assert.strictEqual(m.ok, true);
  assert.ok(m.value < 0);
  assert.strictEqual(m.display['毛利率'], '-20.0%');     // (50-60)/50
});

test('computeMargin：运费缺省按 0 计', () => {
  const m = computeMargin({ returnPrice: 100, cost1688: 60 });
  assert.strictEqual(m.ok, true);
  assert.ok(Math.abs(m.value - 0.40) < 1e-9);
  assert.strictEqual(m.display['国内运费'], '0');
});

test('computeMargin：缺参考申报价 → ok:false 带 reason', () => {
  const m = computeMargin({ cost1688: 60 });
  assert.strictEqual(m.ok, false);
  assert.ok(m.reason);
});

test('computeMargin：缺 1688 成本价 → ok:false', () => {
  assert.strictEqual(computeMargin({ returnPrice: 100 }).ok, false);
});

test('computeMargin：申报价≤0 不能做分母 → ok:false', () => {
  assert.strictEqual(computeMargin({ returnPrice: 0, cost1688: 10 }).ok, false);
  assert.strictEqual(computeMargin({ returnPrice: -5, cost1688: 10 }).ok, false);
});

test('computeMargin：非数字串 → ok:false', () => {
  assert.strictEqual(computeMargin({ returnPrice: 'abc', cost1688: 60 }).ok, false);
});

// ── buildHitl 对 analysis:'margin' 步注入核价 keyValues（复用纯确认型卡渲染）──
test('buildHitl：analysis=margin + 齐全 product → keyValues 含毛利率，纯确认型', () => {
  const step = { id: 'confirm_declare_price', label: '确认申报价格', analysis: 'margin' };
  const h = buildHitl(step, { returnPrice: 100, cost1688: 60, domesticShipping: 5 });
  assert.strictEqual(h.keyValues['毛利率'], '35.0%');
  assert.strictEqual(h.keyValues['参考申报价'], '100');
  assert.strictEqual(h.editable, false);                 // 无 hitlSpec.fields → 纯确认型卡
});

test('buildHitl：analysis=margin + 缺字段 → keyValues 提示无法核价', () => {
  const h = buildHitl({ id: 'confirm_declare_price', label: 'X', analysis: 'margin' }, { returnPrice: 100 });
  assert.ok(/无法核价/.test(h.keyValues['核价']));
});

test('buildHitl：analysis=margin 但不传 product → 不抛、提示无法核价（向后兼容）', () => {
  const h = buildHitl({ id: 'confirm_declare_price', label: 'X', analysis: 'margin' });
  assert.ok(h.keyValues['核价']);
});

test('buildHitl：非 analysis 步传 product → keyValues 不被污染（仍空）', () => {
  const h = buildHitl({ id: 'wait_payment', label: '等付款' }, { returnPrice: 100, cost1688: 60 });
  assert.deepStrictEqual(h.keyValues, {});
});
