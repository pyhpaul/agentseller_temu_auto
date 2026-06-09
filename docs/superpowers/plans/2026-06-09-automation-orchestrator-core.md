# 自动化编排器核心（Plan 2-1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 background 确定性编排器核心——按 13 步声明表驱动 storage 状态机，支持导航 / HITL / SW 回收恢复，用 stub feature 调用验证骨架可跑通。

**Architecture:** 纯逻辑核心（steps 声明表 + `decideNext` 状态机 + recovery 决策 + mutation 队列，UMD 双模式可单测）+ background 接线层（把纯逻辑接 chrome storage/tabs/message API）。编排器事件驱动、不驻留、storage 唯一写入（spec §2.2 / §2.3）。

**Tech Stack:** Vanilla JS（UMD 双模式，沿用 `contract.js` / `version-cmp.js`），`node:test` 单测，Chrome MV3 service worker。

---

## 范围说明

本 plan 是 Plan 2 的**第一个执行 plan**，聚焦**编排器纯逻辑核心**——4 个 UMD 双模式模块，严格 TDD，**零现有代码 / chrome API 依赖**，可完全离线单测。源 spec：`docs/superpowers/specs/2026-06-09-automation-orchestrator-deterministic-skeleton-design.md`。

- **覆盖**：13 步声明表（`steps.js`）+ `decideNext` 纯函数状态机（`state-machine.js`）+ SW 恢复决策（`recovery.js`）+ storage 写入串行化（`mutation-queue.js`）。这 4 个模块是编排器的"决策大脑"。
- **不在本 plan**（移到 Plan 2-2，依赖真实 chrome / DOM）：storage 契约提取（`contract.js` 从 `dashboard/` 解耦到 core 共享——供 bg 与 dashboard 共用，且 release 剥 dashboard 后核心仍有契约）、bg 接线（`// ── orchestrator ──` 段：WF_START / advance 循环 / 导航 / HITL / 恢复）、6 个 AUTO feature 改造（含每步 `target` 的精确 `urlTemplate` / `readySignal`）、业务页浮层、WS 通道架子、stub 端到端验证。
- **验证方式**：全部 `node --test` 纯逻辑单测，无需 chrome。

> **为什么先做纯逻辑核心**：编排器最难、最该先锁死的是"状态机决策 + 不可逆恢复 + 写入串行化"这套逻辑（spec §2.2 / §4）。做成无 chrome 依赖的纯函数先严格 TDD，Plan 2-2 再接到 chrome（storage/tabs/message）成可跑骨架——核心逻辑出错的成本远低于在集成层调试。
>
> Plan 2-1 的 step 定义只含确定的 `id/label/type/feature/reversible/domain`；每步导航的精确 `urlTemplate`/`readySignal` 随 Plan 2-2 的 feature 改造一并补（那时按各 feature `samples/` 校准）。

## 文件结构

| 文件 | 职责 | 新建/改 |
|------|------|--------|
| `core/background/orchestrator/steps.js` | 13 步声明表 `STEP_DEFS` + `buildInitialWorkflow` 工厂 | 新建 |
| `core/background/orchestrator/state-machine.js` | `decideNext(workflow)` 纯函数（状态机决策，无副作用） | 新建 |
| `core/background/orchestrator/recovery.js` | `decideRecovery(step)`（SW 回收恢复决策） | 新建 |
| `core/background/orchestrator/mutation-queue.js` | `makeMutationQueue(read, write)` storage 写入串行化 | 新建 |
| `tests/orchestrator-steps.test.js` 等 4 个 | 纯逻辑模块单测 | 新建 |

> 4 个模块放 `core/background/orchestrator/`（随 background 拷贝）；Plan 2-2 的 bg 接线会 `importScripts` 它们。本 plan 只做纯逻辑 + `node --test`，不碰 service-worker.js。

---

## 实施任务（纯逻辑核心，严格 TDD）

### Task 1: steps.js — 13 步声明表 + buildInitialWorkflow

**Files:**
- Create: `core/background/orchestrator/steps.js`
- Test: `tests/orchestrator-steps.test.js`

- [ ] **Step 1: 写失败测试**

```js
// tests/orchestrator-steps.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { STEP_DEFS, buildInitialWorkflow } = require('../core/background/orchestrator/steps.js');

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
  assert.strictEqual(wf.product.spuId, null);                      // 渐进填充，初始 null
  assert.strictEqual(wf.steps.length, 13);
  assert.ok(wf.steps.every(s => s.status === 'pending'));
  assert.strictEqual(wf.steps[0].committing, false);
  assert.deepStrictEqual(wf.tmpTabs, []);
});

test('buildInitialWorkflow: 缺 product.label 不抛、label=null', () => {
  const wf = buildInitialWorkflow({}, () => 'w1');
  assert.strictEqual(wf.product.label, null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/orchestrator-steps.test.js`
Expected: FAIL — `Cannot find module '../core/background/orchestrator/steps.js'`

- [ ] **Step 3: 写实现**

```js
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
      product: { label: product.label || null, spuId: null, skc: null, skuNo: null },
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/orchestrator-steps.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: commit**

```bash
git add core/background/orchestrator/steps.js tests/orchestrator-steps.test.js
git commit -m "feat(orchestrator): 13 步声明表 + buildInitialWorkflow 工厂

Why: Plan 2-1 编排器核心地基,声明式 step 表驱动状态机。
What: STEP_DEFS(6 AUTO+7 HITL,spec §3.2)+ buildInitialWorkflow(idGen 注入保证可测)。
Test: node --test tests/orchestrator-steps.test.js（5 通过）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2: state-machine.js — decideNext 纯函数状态机

**Files:**
- Create: `core/background/orchestrator/state-machine.js`
- Test: `tests/orchestrator-state-machine.test.js`

`decideNext(workflow)` 是纯函数：输入 workflow 快照，输出"下一步该做什么"指令对象，无副作用。bg 接线层（Task 6）执行指令的副作用。I/O 分离——核心逻辑可完整单测。

- [ ] **Step 1: 写失败测试**

```js
// tests/orchestrator-state-machine.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { decideNext } = require('../core/background/orchestrator/state-machine.js');

function wf(over) {
  return Object.assign({
    status: 'running', cursor: 0,
    steps: [{ id: 's0', type: 'auto', status: 'pending' }],
  }, over);
}

test('workflow 非 running → noop', () => {
  assert.strictEqual(decideNext(wf({ status: 'paused' })).kind, 'noop');
  assert.strictEqual(decideNext(wf({ status: 'done' })).kind, 'noop');
  assert.strictEqual(decideNext(null).kind, 'noop');
});

test('pending auto step → run-auto', () => {
  const d = decideNext(wf());
  assert.strictEqual(d.kind, 'run-auto');
  assert.strictEqual(d.stepId, 's0');
  assert.strictEqual(d.cursor, 0);
});

test('pending hitl step → pause-hitl', () => {
  const d = decideNext(wf({ steps: [{ id: 's0', type: 'hitl', status: 'pending' }] }));
  assert.strictEqual(d.kind, 'pause-hitl');
  assert.strictEqual(d.stepId, 's0');
});

test('running step → noop（幂等，处理中不重入）', () => {
  assert.strictEqual(decideNext(wf({ steps: [{ id: 's0', type: 'auto', status: 'running' }] })).kind, 'noop');
});

test('paused step → noop（等 HITL）', () => {
  assert.strictEqual(decideNext(wf({ steps: [{ id: 's0', type: 'hitl', status: 'paused' }] })).kind, 'noop');
});

test('done step 非末尾 → advance-cursor', () => {
  const d = decideNext(wf({
    cursor: 0,
    steps: [{ id: 's0', type: 'auto', status: 'done' }, { id: 's1', type: 'auto', status: 'pending' }],
  }));
  assert.strictEqual(d.kind, 'advance-cursor');
  assert.strictEqual(d.from, 0);
});

test('done step 末尾 → complete', () => {
  const d = decideNext(wf({ cursor: 0, steps: [{ id: 's0', type: 'auto', status: 'done' }] }));
  assert.strictEqual(d.kind, 'complete');
});

test('skipped step 同 done（非末尾推进 / 末尾 complete）', () => {
  assert.strictEqual(decideNext(wf({ cursor: 0, steps: [{ id: 's0', status: 'skipped' }, { id: 's1', status: 'pending', type: 'auto' }] })).kind, 'advance-cursor');
  assert.strictEqual(decideNext(wf({ cursor: 0, steps: [{ id: 's0', status: 'skipped' }] })).kind, 'complete');
});

test('error step → error', () => {
  const d = decideNext(wf({ steps: [{ id: 's0', type: 'auto', status: 'error' }] }));
  assert.strictEqual(d.kind, 'error');
  assert.strictEqual(d.stepId, 's0');
});

test('cursor 越界（step undefined）→ complete', () => {
  assert.strictEqual(decideNext(wf({ cursor: 5 })).kind, 'complete');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/orchestrator-state-machine.test.js`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 写实现**

```js
// core/background/orchestrator/state-machine.js
// 编排器状态机核心：纯函数，输入 workflow 快照 → 输出下一步指令（无副作用）。spec §2.2。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.__AS_ORCH_SM__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function decideNext(wf) {
    if (!wf || wf.status !== 'running') return { kind: 'noop' };
    const step = wf.steps[wf.cursor];
    if (!step) return { kind: 'complete' };           // cursor 越界 = 全部跑完
    const isLast = wf.cursor >= wf.steps.length - 1;
    switch (step.status) {
      case 'pending':
        return step.type === 'auto'
          ? { kind: 'run-auto', stepId: step.id, cursor: wf.cursor }
          : { kind: 'pause-hitl', stepId: step.id, cursor: wf.cursor };
      case 'running':
        return { kind: 'noop' };                       // 处理中，幂等防重入
      case 'paused':
        return { kind: 'noop' };                       // 等 HITL
      case 'done':
      case 'skipped':
        return isLast ? { kind: 'complete' } : { kind: 'advance-cursor', from: wf.cursor };
      case 'error':
        return { kind: 'error', stepId: step.id };
      default:
        return { kind: 'noop' };
    }
  }

  return { decideNext };
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/orchestrator-state-machine.test.js`
Expected: PASS（10 tests）

- [ ] **Step 5: commit**

```bash
git add core/background/orchestrator/state-machine.js tests/orchestrator-state-machine.test.js
git commit -m "feat(orchestrator): decideNext 纯函数状态机

Why: 编排器核心决策,纯函数便于完整单测(I/O 分离)。
What: decideNext(wf) → run-auto/pause-hitl/advance-cursor/complete/error/noop;副作用由 bg 接线执行。
Test: node --test tests/orchestrator-state-machine.test.js（10 通过）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3: recovery.js — SW 回收恢复决策

**Files:**
- Create: `core/background/orchestrator/recovery.js`
- Test: `tests/orchestrator-recovery.test.js`

`decideRecovery(step)`：SW 唤醒后，对 cursor 指向的中断 `running` step 决定——重跑 / 转 HITL（spec §4.2）。

- [ ] **Step 1: 写失败测试**

```js
// tests/orchestrator-recovery.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { decideRecovery } = require('../core/background/orchestrator/recovery.js');

test('step 非 running（无中断）→ none', () => {
  assert.strictEqual(decideRecovery({ status: 'done' }).action, 'none');
  assert.strictEqual(decideRecovery({ status: 'pending' }).action, 'none');
  assert.strictEqual(decideRecovery(null).action, 'none');
});

test('可逆 step 中断 → rerun（安全重跑）', () => {
  assert.strictEqual(decideRecovery({ status: 'running', reversible: true }).action, 'rerun');
});

test('不可逆 + committing 未清 → ask-hitl', () => {
  assert.strictEqual(decideRecovery({ status: 'running', reversible: false, committing: true }).action, 'ask-hitl');
});

test('不可逆 + 已有 result（可能已提交）→ ask-hitl', () => {
  assert.strictEqual(decideRecovery({ status: 'running', reversible: false, result: { poNo: 'PO1' } }).action, 'ask-hitl');
});

test('不可逆 + 未触提交点（committing=false, result=null）→ rerun', () => {
  assert.strictEqual(decideRecovery({ status: 'running', reversible: false, committing: false, result: null }).action, 'rerun');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/orchestrator-recovery.test.js`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 写实现**

```js
// core/background/orchestrator/recovery.js
// SW 回收恢复决策：对中断的 running step 判断重跑 vs 转 HITL。spec §4.2。UMD 双模式。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.__AS_ORCH_RECOVERY__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function decideRecovery(step) {
    if (!step || step.status !== 'running') return { action: 'none' };
    if (step.reversible === true) return { action: 'rerun' };               // 可逆 → 重置重跑
    if (step.committing || step.result) return { action: 'ask-hitl' };      // 不可逆且可能已提交 → 转人工确认
    return { action: 'rerun' };                                             // 不可逆但未触提交点 → 重跑
  }

  return { decideRecovery };
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/orchestrator-recovery.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: commit**

```bash
git add core/background/orchestrator/recovery.js tests/orchestrator-recovery.test.js
git commit -m "feat(orchestrator): SW 回收恢复决策 decideRecovery

Why: 不可逆 WRITE 步中断后从 storage 续跑会重复副作用,须按 spec §4.2 区分重跑 vs 转 HITL。
What: decideRecovery(step) → rerun(可逆/未提交) / ask-hitl(不可逆且可能已提交) / none。
Test: node --test tests/orchestrator-recovery.test.js（5 通过）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4: mutation-queue.js — storage 写入串行化

**Files:**
- Create: `core/background/orchestrator/mutation-queue.js`
- Test: `tests/orchestrator-mutation-queue.test.js`

`makeMutationQueue(read, write)`：所有 `as_workflow_state` 写入走一条队列，串行 `读→改→写`，防多触发源交错导致 lost-update（spec §2.3 / §4.1）。read/write 注入便于单测。

- [ ] **Step 1: 写失败测试**

```js
// tests/orchestrator-mutation-queue.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { makeMutationQueue } = require('../core/background/orchestrator/mutation-queue.js');

// 模拟异步 storage：read/write 各有延迟，制造交错机会
function fakeStore(initial) {
  let val = initial;
  return {
    read: () => new Promise(r => setTimeout(() => r(val), 5)),
    write: (v) => new Promise(r => setTimeout(() => { val = v; r(); }, 5)),
    peek: () => val,
  };
}

test('串行化：两个并发 enqueue 不交错（后者看到前者的写）', async () => {
  const store = fakeStore({ n: 0 });
  const q = makeMutationQueue(store.read, store.write);
  await Promise.all([
    q.enqueue(cur => ({ n: cur.n + 1 })),
    q.enqueue(cur => ({ n: cur.n + 1 })),
  ]);
  assert.strictEqual(store.peek().n, 2);   // 若交错（lost-update）会是 1
});

test('字段级合并：mutator 只改一个字段，其他字段保留', async () => {
  const store = fakeStore({ a: 1, b: 2 });
  const q = makeMutationQueue(store.read, store.write);
  await q.enqueue(cur => ({ ...cur, a: 9 }));
  assert.deepStrictEqual(store.peek(), { a: 9, b: 2 });
});

test('mutator 返回 undefined → 跳过 write（只读不写）', async () => {
  let writes = 0;
  const q = makeMutationQueue(async () => ({ n: 1 }), async () => { writes++; });
  await q.enqueue(() => undefined);
  assert.strictEqual(writes, 0);
});

test('enqueue 返回的 promise 解析为 mutator 结果', async () => {
  const store = fakeStore({ n: 0 });
  const q = makeMutationQueue(store.read, store.write);
  const res = await q.enqueue(cur => ({ n: cur.n + 5 }));
  assert.deepStrictEqual(res, { n: 5 });
});

test('一个 mutator 抛错不卡死队列（后续仍执行）', async () => {
  const store = fakeStore({ n: 0 });
  const q = makeMutationQueue(store.read, store.write);
  await q.enqueue(() => { throw new Error('boom'); }).catch(() => {});
  await q.enqueue(cur => ({ n: cur.n + 1 }));
  assert.strictEqual(store.peek().n, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/orchestrator-mutation-queue.test.js`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 写实现**

```js
// core/background/orchestrator/mutation-queue.js
// storage 写入串行化队列：read→mutate→write 串行，防多触发源交错 lost-update。spec §2.3。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.__AS_ORCH_MQ__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function makeMutationQueue(read, write) {
    let chain = Promise.resolve();
    function enqueue(mutator) {
      const run = chain.then(async () => {
        const cur = await read();
        const next = await mutator(cur);          // mutator 负责字段级合并并返回新值
        if (next !== undefined) await write(next);
        return next;
      });
      // 链不因单个 mutator 抛错而断（吞错只为保持链活；调用方仍能从 run 拿到 rejection）
      chain = run.catch(() => {});
      return run;
    }
    return { enqueue };
  }

  return { makeMutationQueue };
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/orchestrator-mutation-queue.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: commit**

```bash
git add core/background/orchestrator/mutation-queue.js tests/orchestrator-mutation-queue.test.js
git commit -m "feat(orchestrator): storage 写入串行化 mutation 队列

Why: advance 多触发源(feature 结果/HITL/SW 唤醒)交错 RMW 会 lost-update(spec §2.3)。
What: makeMutationQueue(read,write) 串行 读→改→写;mutator 抛错不卡死队列。
Test: node --test tests/orchestrator-mutation-queue.test.js（5 通过）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 5: 全量回归（确认不破坏现有测试）

**Files:** 无新建（只跑测试验证）

- [ ] **Step 1: 跑全部 JS 单测，确认 orchestrator 全绿 + 现有不回归**

Run: `node --test tests/*.test.js`
Expected: PASS — orchestrator 4 模块新增 25 例（5+10+5+5）+ 现有 version-cmp + dashboard-store 21 例，**0 失败**。

> ⚠️ 必须用 `tests/*.test.js`，不要 `node --test tests/`（整目录会把 pytest 的 `.py` 当 JS 解析失败，见根 CLAUDE.md「测试命令」）。

- [ ] **Step 2: 跑 Python 单测确认不回归**

Run: `python3 -m pytest tests/`
Expected: PASS（现有 19 例；本 plan 未碰 build/package/strip 逻辑，应零影响）。

- [ ] **Step 3: 确认工作树干净**

```bash
git status --short
```
Expected: 空（4 个模块 + 测试已在 Task 1-4 各自 commit）。

## 完成定义（DoD）

- 4 个纯逻辑模块（steps / state-machine / recovery / mutation-queue）实现 + 单测通过（25 例）。
- `node --test tests/*.test.js` 全绿（含现有 21 例不回归）。
- `python3 -m pytest tests/` 全绿（19 例不回归）。
- 编排器"决策大脑"（状态机推进 / 不可逆恢复 / 写入串行化）经完整 TDD 锁定，零 chrome 依赖。

## 与 Plan 2-2 的衔接

Plan 2-2（集成层）消费本 plan 的纯逻辑模块：
- `importScripts('orchestrator/steps.js' ...)` 接入 service-worker.js 的 `// ── orchestrator ──` 段。
- bg 用 `makeMutationQueue` 包 `chrome.storage.local` 读写；用 `decideNext` 驱动 advance 循环；用 `decideRecovery` 处理 SW 唤醒。
- **先做 contract 提取**（`dashboard/contract.js` → `core/contract.js`），让 bg 与 dashboard 共用 `STORAGE_KEY` / `normalizeSkeleton`，且 release 剥 dashboard 后核心仍有契约。
- 然后：WF_START 入口 / 导航 + stub feature / HITL 接线 / onStartup 恢复 / 6 feature 改造（每步补 `target` 的 `urlTemplate`+`readySignal`）/ 浮层 / WS 架子 / 端到端。

> Plan 2-2 在本 plan 全绿并 review 后另起（brainstorming→spec→plan 或直接 writing-plans，视范围决定）。
