const { test } = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../core/dashboard/state/store.js');
const { SCHEMA_VERSION, emptyBatch } = require('../core/dashboard/contract.js');

function sampleBatch() {
  return {
    schemaVersion: SCHEMA_VERSION,
    batch: {
      id: 'B-1', createdAt: 1, activeWorkflowId: 'w1',
      workflows: [{
        id: 'w1', product: { label: '保温杯', spuId: '6821042', skc: 'C04A8', skuNo: 'SK99021' },
        status: 'running', cursor: 3, startedAt: 1, updatedAt: 2,
        steps: [{ id: 'gen_label', label: '标签生成', feature: 'auto_gen_label', status: 'done' }],
        hitl: null,
      }],
    },
  };
}

test('emptyBatch: 返回合法空骨架（schemaVersion + 空 workflows）', () => {
  const e = emptyBatch();
  assert.strictEqual(e.schemaVersion, SCHEMA_VERSION);
  assert.deepStrictEqual(e.batch.workflows, []);
  assert.strictEqual(e.batch.activeWorkflowId, null);
});

test('setSkeleton: 合法骨架整体替换，getState().skeleton 反映新值', () => {
  const s = createStore();
  s.setSkeleton(sampleBatch());
  assert.strictEqual(s.getState().skeleton.batch.workflows.length, 1);
  assert.strictEqual(s.getState().skeleton.batch.workflows[0].cursor, 3);
});

test('setSkeleton: schemaVersion 缺失 → 兜底为空 batch（不裸展开 undefined）', () => {
  const s = createStore();
  s.setSkeleton({ foo: 'bar' });
  assert.deepStrictEqual(s.getState().skeleton.batch.workflows, []);
  assert.strictEqual(s.getState().skeleton.schemaVersion, SCHEMA_VERSION);
});

test('setSkeleton: schemaVersion 低于当前 → 兜底为空 batch', () => {
  const s = createStore();
  s.setSkeleton({ schemaVersion: 0, batch: { workflows: [{ id: 'x' }] } });
  assert.deepStrictEqual(s.getState().skeleton.batch.workflows, []);
});

test('setSkeleton: null/undefined 输入 → 兜底为空 batch', () => {
  const s = createStore();
  s.setSkeleton(null);
  assert.deepStrictEqual(s.getState().skeleton.batch.workflows, []);
  s.setSkeleton(undefined);
  assert.deepStrictEqual(s.getState().skeleton.batch.workflows, []);
});

test('appendBrainEvent: 大脑流增量 append（不整体替换），保序', () => {
  const s = createStore();
  s.appendBrainEvent({ workflowId: 'w1', stepId: 'gen_label', kind: 'review', text: 'a', ts: 1 });
  s.appendBrainEvent({ workflowId: 'w1', stepId: 'gen_label', kind: 'log', text: 'b', ts: 2 });
  const ev = s.getState().brainEvents;
  assert.strictEqual(ev.length, 2);
  assert.strictEqual(ev[0].text, 'a');
  assert.strictEqual(ev[1].text, 'b');
});

test('appendBrainEvent: 超过上限时丢最旧（限流，保留最近 N 条）', () => {
  const s = createStore({ maxBrainEvents: 3 });
  for (let i = 0; i < 5; i++) s.appendBrainEvent({ kind: 'log', text: String(i), ts: i });
  const ev = s.getState().brainEvents;
  assert.strictEqual(ev.length, 3);
  assert.deepStrictEqual(ev.map(e => e.text), ['2', '3', '4']);
});

test('setHitlDetail: 血肉 HITL 详情按 hitlId 存，getState().hitlDetail 反映', () => {
  const s = createStore();
  s.setHitlDetail({ hitlId: 'h1', action: '申请付款', valueDiff: [], risk: 'low' });
  assert.strictEqual(s.getState().hitlDetail.hitlId, 'h1');
});

test('subscribe: 任一变更触发订阅回调；unsubscribe 后不再触发', () => {
  const s = createStore();
  let n = 0;
  const off = s.subscribe(() => { n++; });
  s.setSkeleton(sampleBatch());
  s.appendBrainEvent({ kind: 'log', text: 'x', ts: 1 });
  assert.strictEqual(n, 2);
  off();
  s.appendBrainEvent({ kind: 'log', text: 'y', ts: 2 });
  assert.strictEqual(n, 2);
});

test('subscribe: 回调抛错不影响 store 内部状态与其他订阅者', () => {
  const s = createStore();
  let good = 0;
  s.subscribe(() => { throw new Error('boom'); });
  s.subscribe(() => { good++; });
  s.setSkeleton(sampleBatch());
  assert.strictEqual(good, 1);
  assert.strictEqual(s.getState().skeleton.batch.workflows.length, 1);
});

test('setSkeleton: schemaVersion 高于当前 → 兜底为空 batch（旧客户端不识别新格式）', () => {
  const s = createStore();
  s.setSkeleton({ schemaVersion: 99, batch: { workflows: [{ id: 'x' }] } });
  assert.deepStrictEqual(s.getState().skeleton.batch.workflows, []);
});

test('appendBrainEvent: 恰好等于上限时不丢（length > max 严格大于边界）', () => {
  const s = createStore({ maxBrainEvents: 3 });
  for (let i = 0; i < 3; i++) s.appendBrainEvent({ kind: 'log', text: String(i), ts: i });
  const ev = s.getState().brainEvents;
  assert.strictEqual(ev.length, 3);
  assert.deepStrictEqual(ev.map(e => e.text), ['0', '1', '2']);
});

const { selectActiveWorkflow } = require('../core/dashboard/components/select-active.js');

test('selectActiveWorkflow: 按 activeWorkflowId 命中', () => {
  const batch = { activeWorkflowId: 'w2', workflows: [{ id: 'w1' }, { id: 'w2' }] };
  assert.strictEqual(selectActiveWorkflow(batch).id, 'w2');
});
test('selectActiveWorkflow: activeWorkflowId 无效 → 退化取首个', () => {
  const batch = { activeWorkflowId: 'nope', workflows: [{ id: 'w1' }, { id: 'w2' }] };
  assert.strictEqual(selectActiveWorkflow(batch).id, 'w1');
});
test('selectActiveWorkflow: 空 workflows → null', () => {
  assert.strictEqual(selectActiveWorkflow({ activeWorkflowId: null, workflows: [] }), null);
});
test('selectActiveWorkflow: batch 缺失 → null（不抛）', () => {
  assert.strictEqual(selectActiveWorkflow(null), null);
  assert.strictEqual(selectActiveWorkflow(undefined), null);
  assert.strictEqual(selectActiveWorkflow({}), null);
});
