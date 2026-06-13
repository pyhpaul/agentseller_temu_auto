// tests/orchestrator-engine.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { makeEngine, buildHitl } = require('../core/background/orchestrator/engine.js');
const { makeMutationQueue } = require('../core/background/orchestrator/mutation-queue.js');

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
  const h = buildHitl({ id: 'select_product', label: '选品' });
  assert.strictEqual(h.editable, false);
  assert.deepStrictEqual(h.fields, []);
});

test('buildHitl：hitlSpec.fields 空数组 → editable=false', () => {
  const h = buildHitl({ id: 'x', label: 'x', hitlSpec: { fields: [] } });
  assert.strictEqual(h.editable, false);
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
