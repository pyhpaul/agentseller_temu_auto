// tests/orchestrator-engine.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { makeEngine } = require('../core/background/orchestrator/engine.js');
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
function setupEngine(skeleton, stepRunner) {
  const store = fakeStore(skeleton);
  const queue = makeMutationQueue(store.read, store.write);
  const engine = makeEngine({ read: store.read, queue, stepRunner, now: () => 1 });
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
