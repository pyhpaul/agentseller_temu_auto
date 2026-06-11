# 自动化编排器 bg 集成核心（Plan 2-2a）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Plan 2-1 的编排器纯逻辑核心接到真实 Chrome service worker，用 stub feature 调用驱动 13 步骨架在 SW 里端到端跑通——自动步自动推进、HITL 步暂停等人、SW 回收后从 storage 恢复。

**Architecture:** 三层落地。① **contract 提取**：`core/dashboard/contract.js` → `core/contract.js`，成为 bg + dashboard 共享契约（SW importScripts / dashboard script / node require 三方共用，且 release 剥 dashboard 后核心仍有契约）。② **engine.js**：注入依赖（read/queue/stepRunner）的编排引擎，消费 Plan 2-1 的 `decideNext`/`decideRecovery`，实现 `advance` 单步推进 + `recover` 恢复，纯逻辑可 node 测。③ **service-worker.js 接线段**：把 engine 注入真实 chrome（storage 读写 + mutation 队列 + **stub stepRunner**）+ WF_START/HITL 消息入口 + onStartup 恢复。

**Tech Stack:** Vanilla JS（UMD 双模式，沿用 `contract.js`/`version-cmp.js`/orchestrator 4 模块），`node:test` 单测，Chrome MV3 classic service worker（`importScripts`，非 module），Python `pytest`（build 拷贝/剥离验证）。

---

## 范围说明

本 plan 是 **Plan 2-2 集成层的第一个子 plan**（2-2a），把编排器在真实 SW 跑起来，**用 stub stepRunner 验证骨架**，不碰 5 个 feature 的 index.js。源 spec：`docs/superpowers/specs/2026-06-09-automation-orchestrator-deterministic-skeleton-design.md`（§1 架构 / §2 状态机 / §4 storage 写入+恢复 / §5 HITL）。

- **覆盖**：contract 提取（dashboard→core 共享）+ `engine.js`（advance/recover 注入式引擎）+ service-worker.js orchestrator 接线段（importScripts + mutation 队列包 chrome.storage + stub stepRunner + WF_START/HITL_CONFIRM/HITL_REJECT/WF_ABORT 消息 + onStartup 恢复）+ build 拷贝调整。
- **不在本 plan**（留 2-2b / 2-2c）：5 个 AUTO feature 改造（真实 stepRunner：导航 + feature 命令 + readySignal）、业务页浮层、WS 通道架子、深色 UI 迁移。
- **验证方式**：`engine.js` 全 `node --test` 纯逻辑单测（fake storage + stub stepRunner）；contract 提取靠 dashboard-store 测试不回归 + pytest 验证 build 拷贝/剥离；SW 接线段靠 chrome 手动端到端（Task 5 给清单）。

## 关键决策（实现前先读，review 时把关）

| # | 决策 | 理由 |
|---|------|------|
| D1 | contract 落 **`core/contract.js`（根级）**，非 `core/background/` | 它是 bg+dashboard 共享契约，不属任何一方；**核心动因**：SW importScripts 它拿 `STORAGE_KEY/normalizeSkeleton`，若留 dashboard 里 `_strip_dashboard_for_release` 会删它 → release SW 崩。根级则 strip dashboard 不碰（Explore 已确认 strip 只删 `dist/.../dashboard/` 目录树）。 |
| D2 | orchestrator **沉睡发版**（不剥离） | 延续 Plan 1 dead-code 策略（用户已接受 OPEN_MONITOR dead code）。4 模块 importScripts 纯定义无副作用；**SW 读不到 content 的 `__AS_BUILD_INFO__`，故 isDev 守卫在浮层「开始」按钮（2-2c）、不在 SW handler**——release 无浮层 → 无人发 `WF_START`；SW 恢复对空 storage（无 workflow）安全 noop。剥离 SW 内段（string replace）太脆，沉睡更稳。 |
| D3 | engine **注入依赖**（`makeEngine({read,queue,stepRunner,now})`） | 延续 Plan 2-1 可测性：advance/recover 不直接碰 chrome，fake storage + stub runner 可完整 node 测。 |
| D4 | **stepRunner = 2-2a↔2-2b 边界**；2-2a 用 stub | stub 返回模拟 `{status:'done', result}`，让骨架端到端可验证（13 步走通 + HITL 暂停 + 恢复）。2-2b 把 stub 换成真实「导航 tab + waitForEl(readySignal) + 调 feature 命令」。 |
| D5 | engine 用 **minimal 自定义 workflow** 做单测（非真 13 步） | 13 步序列结构已由 Plan 2-1 `steps.test.js` 覆盖；engine 测试聚焦推进/恢复分支，用 2-3 步 fixture 更清晰。 |

## 文件结构

| 文件 | 职责 | 新建/改 |
|------|------|--------|
| `core/contract.js` | 共享 storage 契约（从 `core/dashboard/contract.js` 移来）；UMD 加 `self` 挂载供 SW importScripts | 移动 + 改 |
| `core/dashboard/state/store.js` | contract require 路径 `../contract.js`→`../../contract.js` | 改 1 行 |
| `core/dashboard/dashboard.html` | contract script src `contract.js`→`../contract.js` | 改 1 行 |
| `tests/dashboard-store.test.js` | contract require `../core/dashboard/contract.js`→`../core/contract.js` | 改 1 行 |
| `build/build_extension.py` | 新增 `copy_core_root_files()` 拷 `core/contract.js`→`dist/extension/contract.js` | 改 |
| `tests/test_build.py` | 验证 contract 拷到 dist 根级（+ release strip 后仍在） | 改/加 |
| `core/background/orchestrator/engine.js` | `makeEngine({read,queue,stepRunner,now})`→advance/recover，注入式可测 | 新建 |
| `tests/orchestrator-engine.test.js` | engine advance/recover 推进逻辑单测（fake storage + stub runner） | 新建 |
| `core/background/service-worker.js` | 加 `// ── orchestrator ──` 段：importScripts + 队列包 storage + stub runner + 消息入口 + onStartup 恢复 | 改 |

> engine.js 放 `core/background/orchestrator/`（随 background 拷贝，SW importScripts 同级 `orchestrator/engine.js`）。contract.js 移到 `core/` 根级，需 build 显式拷贝（copy_core_assets 只拷 4 子目录，不含根级文件）。

---

## Task 1：contract 提取到 core/contract.js（含 build 拷贝 + 发版安全测试）

**Files:**
- Move: `core/dashboard/contract.js` → `core/contract.js`
- Modify: `core/contract.js`（UMD 加 self 挂载）
- Modify: `core/dashboard/state/store.js:13`、`core/dashboard/dashboard.html:9`、`tests/dashboard-store.test.js:4`
- Modify: `build/build_extension.py`（加 `copy_core_root_files`）
- Modify: `tests/test_strip_dashboard.py`（加根级 contract 保留测试）

重构（移动 + 改引用）+ build 拷贝调整，**一个原子 commit**（避免中间 dev build 损坏）。无新业务行为，验证靠现有测试不回归 + dev build 成功 + 新增 strip 保留测试。

- [ ] **Step 1: git mv contract.js 到 core 根级**

```bash
git mv core/dashboard/contract.js core/contract.js
```

- [ ] **Step 2: UMD 加 self 挂载（SW 友好）**

service worker 无 `window` 只有 `self`。改 `core/contract.js` 这一行让浏览器（window===self）和 SW 都能拿全局。

把：
```js
  if (typeof window !== 'undefined') window.__AS_DASH_CONTRACT__ = api;                // 浏览器全局兜底
```
改为：
```js
  if (typeof self !== 'undefined') self.__AS_DASH_CONTRACT__ = api;                    // 浏览器(window===self) + SW(self) 全局
```
> 浏览器 `self===window`，故 dashboard 端 `window.__AS_DASH_CONTRACT__` 读取不变（同一对象）。node 端走 `module.exports`（typeof self===undefined）。

- [ ] **Step 3: 改三处引用路径**

`core/dashboard/state/store.js:13`（store 仍在 `state/`，contract 上移一级，相对路径多一级）：
```js
    ? nodeRequire('../contract.js')
```
→
```js
    ? nodeRequire('../../contract.js')
```

`core/dashboard/dashboard.html:9`：
```html
<script src="contract.js"></script>
```
→
```html
<script src="../contract.js"></script>
```

`tests/dashboard-store.test.js:4`：
```js
const { SCHEMA_VERSION, emptyBatch } = require('../core/dashboard/contract.js');
```
→
```js
const { SCHEMA_VERSION, emptyBatch } = require('../core/contract.js');
```

- [ ] **Step 4: build_extension.py 加 copy_core_root_files**

在 `build/build_extension.py` 的 `copy_dashboard_assets()` 函数后插入新函数：

```python
def copy_core_root_files():
    """拷贝 core/ 根级共享文件（contract.js 等）→ dist/extension/。
    这些是 bg + dashboard 共用的契约模块（不属 background/content/popup/dashboard 任一子目录），
    单独拷到 dist 根级；SW importScripts('../contract.js')、dashboard <script src="../contract.js"> 共用。
    """
    for name in ['contract.js']:
        src = CORE / name
        if not src.exists():
            continue
        dst = DIST / name
        shutil.copy2(src, dst)
        _inject_source_url(dst, str(src.relative_to(ROOT)))
        print(f'[build] {name} → dist/extension/{name}')
```

在 `build_all()` 里 `copy_core_assets()` 之后调用：
```python
def build_all():
    clean_dist()
    copy_core_assets()
    copy_core_root_files()          # ← 新增：拷 core 根级共享 contract.js
    copy_dashboard_assets()
    emit_build_info()
    features = scan_features()
    copy_feature_assets(features)
    copy_extra_cs_assets(features)
    render_manifest(features=features)
    print(f'[build] done → {DIST}')
```

- [ ] **Step 5: test_strip_dashboard.py 加根级 contract 保留测试**

在 `tests/test_strip_dashboard.py` 的 `test_strip_idempotent_when_dashboard_absent` 函数后加（验证 D1 发版安全）：

```python
def test_strip_dashboard_keeps_root_contract(tmp_path):
    """contract.js 提到 dist 根级后，strip dashboard 不应删它（release SW importScripts 依赖）。"""
    ext = _make_extension_dir(tmp_path, with_dashboard=True)
    (ext / 'contract.js').write_text('// shared contract', encoding='utf-8')

    _strip_dashboard_for_release(ext)

    assert not (ext / 'dashboard').exists(), 'dashboard/ 应被删'
    assert (ext / 'contract.js').exists(), '根级 contract.js 不应被删（SW importScripts 依赖）'
```

并在文件末尾 `if __name__ == '__main__':` 块加调用：
```python
    with tempfile.TemporaryDirectory() as d:
        test_strip_dashboard_keeps_root_contract(Path(d) / 'case7')
```

- [ ] **Step 6: 跑 JS 测试确认不回归**

Run: `node --test tests/dashboard-store.test.js`
Expected: PASS（16 例，contract 移动后 require 解析、store 仍拿到 emptyBatch/normalizeSkeleton）

- [ ] **Step 7: 跑 dev build 确认成功 + contract 落根级**

```bash
python3 build/build_extension.py && ls -la dist/extension/contract.js && test ! -f dist/extension/dashboard/contract.js && echo "OK: contract 在根级、不在 dashboard"
```
Expected: build 成功并打印 `contract.js → dist/extension/contract.js`；`dist/extension/contract.js` 存在；`dist/extension/dashboard/contract.js` 不存在；末尾打印 `OK: ...`

- [ ] **Step 8: 跑 pytest 确认 strip 保留测试 + 不回归**

Run: `python3 -m pytest tests/test_strip_dashboard.py -q`
Expected: PASS（原 6 例 + 新增 1 例 = 7 例）

- [ ] **Step 9: commit**

```bash
git add core/contract.js core/dashboard/state/store.js core/dashboard/dashboard.html tests/dashboard-store.test.js build/build_extension.py tests/test_strip_dashboard.py
git commit -m "refactor(contract): contract.js 从 dashboard 提到 core 根级共享

Why: bg orchestrator 要 importScripts contract 拿 STORAGE_KEY/normalizeSkeleton;
     留 dashboard 里会被 _strip_dashboard_for_release 删掉导致 release SW importScripts 崩。
What: git mv→core/contract.js; UMD 加 self 挂载(SW 无 window); 改 store/html/test 三处引用;
     build 加 copy_core_root_files 拷根级 contract; test_strip 加根级 contract 保留断言。
Test: node --test dashboard-store(16) + dev build(contract 落根级) + pytest test_strip(7) 全绿

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Task 1 完成：contract 已是 bg(importScripts) + dashboard(script) + node(require) 三方共享，且发版剥 dashboard 不影响它。

---

## Task 2：engine.js — advance/recover 注入式编排引擎

**Files:**
- Create: `core/background/orchestrator/engine.js`
- Test: `tests/orchestrator-engine.test.js`

`makeEngine({read, queue, stepRunner, now})` 是编排引擎：消费 Plan 2-1 的 `decideNext`/`decideRecovery`，实现 `advance`（单步推进循环）+ `recover`（SW 恢复）。**依赖全注入**（read/queue/stepRunner），不直接碰 chrome → 可完整 node 测（fake storage + stub stepRunner）。spec §2.2 / §4.2。

严格 TDD：先写测试 → 跑失败 → 写实现 → 跑通。

- [ ] **Step 1: 写失败测试**

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/orchestrator-engine.test.js`
Expected: FAIL — `Cannot find module '../core/background/orchestrator/engine.js'`

- [ ] **Step 3: 写实现**

```js
// core/background/orchestrator/engine.js
// 编排引擎：注入 read/queue/stepRunner/now，实现 advance 单步推进 + recover SW 恢复。
// 纯逻辑+注入（无 chrome 直接依赖），可 node 测。消费 state-machine.decideNext + recovery.decideRecovery。spec §2.2/§4.2。
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require : null);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.__AS_ORCH_ENGINE__ = api;
})(typeof self !== 'undefined' ? self : this, function (nodeRequire) {
  'use strict';

  // 取 Plan 2-1 模块：node require / SW 全局（importScripts 已挂 self.__AS_ORCH_*）
  const sm = nodeRequire ? nodeRequire('./state-machine.js') : self.__AS_ORCH_SM__;
  const rec = nodeRequire ? nodeRequire('./recovery.js') : self.__AS_ORCH_RECOVERY__;
  const { decideNext } = sm;
  const { decideRecovery } = rec;

  const MAX_LOOP = 100;   // advance 循环上限防御（13 步 + cursor 推进正常 < 30 轮）

  function findWorkflow(skeleton, workflowId) {
    const list = (skeleton && skeleton.batch && skeleton.batch.workflows) || [];
    return list.find(w => w.id === workflowId) || null;
  }

  // 从 step.result 提取要回填 workflow.product 的字段（渐进填充 spuId/skc/skuNo）
  function pickProduct(result) {
    const out = {};
    if (!result) return out;
    for (const k of ['spuId', 'skc', 'skuNo']) {
      if (result[k] != null) out[k] = result[k];
    }
    return out;
  }

  // HITL step → workflow.hitl 摘要（首版无大脑，精简；targetUrl 供浮层「前往」，2-2b 补 step.target）
  function buildHitl(step) {
    return {
      action: step.label, stepId: step.id,
      keyValues: {}, reviewedBrief: '',
      editable: false, fieldType: null, options: null,
      targetUrl: (step.target && step.target.url) || null,
      status: 'pending',
    };
  }

  function makeEngine(deps) {
    const { read, queue, stepRunner } = deps;
    const now = deps.now || (() => null);

    // 改 skeleton 里某 workflow（走 queue 串行化；workflow 不存在则跳过写）
    function mutateWorkflow(workflowId, fn) {
      return queue.enqueue(skeleton => {
        const wf = findWorkflow(skeleton, workflowId);
        if (!wf) return undefined;
        fn(wf);
        return skeleton;
      });
    }

    // 单步推进循环：读快照 → decideNext → 落地副作用 → 直到卡住（pause/complete/error/noop）
    async function advance(workflowId) {
      for (let guard = 0; guard < MAX_LOOP; guard++) {
        const wf = findWorkflow(await read(), workflowId);
        const decision = decideNext(wf);
        switch (decision.kind) {
          case 'run-auto': {
            const step = wf.steps[wf.cursor];                      // 本轮快照的 step 定义
            await mutateWorkflow(workflowId, w => {
              const s = w.steps[w.cursor];
              s.status = 'running'; s.startedAt = now(); s.error = null;   // checkpoint：占位防重入
            });
            let res;
            try {
              res = await stepRunner(step, wf);                    // 调 feature（2-2a 是 stub）— 长操作，在 queue 外
            } catch (e) {
              res = { status: 'error', error: { category: 'read', code: 'STEP_THREW', message: String((e && e.message) || e), recoverable: false } };
            }
            await mutateWorkflow(workflowId, w => {
              const s = w.steps[w.cursor];
              s.committing = false; s.endedAt = now();
              if (res && res.status === 'done') {
                s.status = 'done'; s.result = res.result || null; s.error = null;
                Object.assign(w.product, pickProduct(res.result));  // 渐进填充
              } else {
                s.status = 'error';
                s.error = (res && res.error) || { category: 'business', code: 'UNKNOWN', message: '步骤失败', recoverable: false };
                w.status = 'error';
              }
              w.updatedAt = now();
            });
            continue;
          }
          case 'pause-hitl': {
            await mutateWorkflow(workflowId, w => {
              w.steps[w.cursor].status = 'paused';
              w.status = 'paused';
              w.hitl = buildHitl(w.steps[w.cursor]);
              w.updatedAt = now();
            });
            return;                                                // 不驻留，等人确认
          }
          case 'advance-cursor': {
            await mutateWorkflow(workflowId, w => { w.cursor += 1; w.updatedAt = now(); });
            continue;
          }
          case 'complete': {
            await mutateWorkflow(workflowId, w => { w.status = 'done'; w.hitl = null; w.updatedAt = now(); });
            return;
          }
          case 'error': {
            await mutateWorkflow(workflowId, w => { w.status = 'error'; w.updatedAt = now(); });
            return;
          }
          default:                                                 // noop
            return;
        }
      }
      console.warn('[orch] advance 达循环上限 MAX_LOOP，疑似状态机异常', workflowId);
    }

    // SW 唤醒恢复：对 running workflow 的 cursor step 跑 decideRecovery（spec §4.2）
    async function recover(workflowId) {
      const wf = findWorkflow(await read(), workflowId);
      if (!wf || wf.status !== 'running') return { action: 'none' };
      const decision = decideRecovery(wf.steps[wf.cursor]);
      if (decision.action === 'rerun') {
        await mutateWorkflow(workflowId, w => {
          const s = w.steps[w.cursor];
          s.status = 'pending'; s.committing = false; s.error = null;
        });
        await advance(workflowId);
      } else if (decision.action === 'ask-hitl') {
        await mutateWorkflow(workflowId, w => {
          const s = w.steps[w.cursor];
          s.status = 'paused'; w.status = 'paused';
          w.hitl = {
            action: '恢复确认：' + s.label, stepId: s.id,
            keyValues: {}, reviewedBrief: '',
            prompt: '这步可能已执行，请确认：已完成→跳过 / 未完成→重试',
            editable: false, fieldType: 'recovery', options: ['已完成', '未完成'],
            targetUrl: (s.target && s.target.url) || null, status: 'pending',
          };
          w.updatedAt = now();
        });
      }
      return decision;
    }

    return { advance, recover };
  }

  return { makeEngine, findWorkflow, pickProduct, buildHitl };
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/orchestrator-engine.test.js`
Expected: PASS（10 tests）

- [ ] **Step 5: commit**

```bash
git add core/background/orchestrator/engine.js tests/orchestrator-engine.test.js
git commit -m "feat(orchestrator): engine.js advance/recover 注入式引擎

Why: 编排循环要可测(I/O 分离),把推进/恢复落地逻辑与 chrome 解耦。
What: makeEngine({read,queue,stepRunner,now})→advance(消费 decideNext:run-auto/pause-hitl/
     advance-cursor/complete/error)+recover(消费 decideRecovery:rerun 续跑/ask-hitl 转人工)。
     stepRunner 注入(2-2a stub,2-2b 换真实导航+feature)。product 渐进填充。
Test: node --test tests/orchestrator-engine.test.js（10 通过,fake storage+stub runner）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Task 2 完成：engine 推进/恢复逻辑经完整 TDD 锁定（10 例），零 chrome 依赖，待 Task 3 注入真实 chrome。

---

## Task 3：service-worker.js orchestrator 接线段

**Files:**
- Modify: `core/background/service-worker.js`（末尾加 `// ── orchestrator ── … // ── end orchestrator ──` 段）

把 engine 注入真实 chrome（storage 读写 + mutation 队列 + stub stepRunner）+ 消息入口 + SW 恢复。**接线层不写 node 单测**（依赖 chrome.storage/runtime），靠 `node --check` 语法验证 + Task 4 chrome 手动端到端。

> **发版安全（D2 修正）**：SW 读不到 content script 的 `window.__AS_BUILD_INFO__`，故「isDev 守卫」实际在**浮层「开始」按钮**（2-2c content script，release 不注入）。本段在 release 沉睡靠：① importScripts 4 模块纯定义无副作用；② release 无浮层 → 无人发 `WF_START`；③ 恢复对空 storage（release 无 `as_workflow_state`）noop。故 release SW 带沉睡 orchestrator 代码、零副作用（延续 Plan 1 OPEN_MONITOR dead-code 策略）。

- [ ] **Step 1: 在 service-worker.js 末尾加「编排器装配」段**

在文件末尾（`// ── end create_purchase_order ──` 之后）追加：

```js

// ── orchestrator ── 确定性编排器 bg 接线（Plan 2-2a）─────────────────────────
// Plan 2-1 纯逻辑核心（steps/state-machine/recovery/mutation-queue/engine）接真实 chrome。
// 发版（D2）：importScripts 纯定义无副作用；唯一触发源是浮层「开始」(2-2c,isDev 守卫,release 不注入)，
// 故 release 无人发 WF_START；恢复对空 storage noop → orchestrator 在 release 沉睡无副作用。
importScripts(
  '../contract.js',
  'orchestrator/steps.js',
  'orchestrator/state-machine.js',
  'orchestrator/recovery.js',
  'orchestrator/mutation-queue.js',
  'orchestrator/engine.js',
);

const ORCH = {
  contract: self.__AS_DASH_CONTRACT__,
  steps: self.__AS_ORCH_STEPS__,
  mq: self.__AS_ORCH_MQ__,
  engine: self.__AS_ORCH_ENGINE__,
};

// storage 读写适配：read 经 normalizeSkeleton 兜底（缺失/损坏→emptyBatch）；write 整 skeleton
function orchRead() {
  const { STORAGE_KEY, normalizeSkeleton } = ORCH.contract;
  return chrome.storage.local.get(STORAGE_KEY).then(r => normalizeSkeleton(r[STORAGE_KEY]));
}
function orchWrite(skeleton) {
  return chrome.storage.local.set({ [ORCH.contract.STORAGE_KEY]: skeleton });
}

const orchQueue = ORCH.mq.makeMutationQueue(orchRead, orchWrite);

// stub stepRunner（2-2a）：模拟 auto 步成功，让骨架端到端可验证。
// 2-2b 换真实：导航 tab → waitForEl(step.target.readySignal) → 调 feature 命令 → 收结构化回报。
async function orchStubStepRunner(step) {
  await new Promise(r => setTimeout(r, 300));   // 模拟耗时
  console.log(`[orch-stub] 自动步「${step.label}」(feature=${step.feature}) 模拟完成`);
  return { status: 'done', result: { stub: step.id, feature: step.feature }, error: null };
}

const orchEngine = ORCH.engine.makeEngine({
  read: orchRead, queue: orchQueue, stepRunner: orchStubStepRunner, now: () => Date.now(),
});

// SW 唤醒恢复：每次 SW 实例化（冷启 / 回收唤醒 / 浏览器启动）即跑。
// 不挂 onStartup——recover 不幂等（rerun 有副作用），靠顶层单次调用覆盖所有实例化场景。
async function orchRecoverAll() {
  try {
    const skeleton = await orchRead();
    const wf = (skeleton.batch.workflows || []).find(w => w.status === 'running');
    if (!wf) return;   // 无 running workflow（release 常态）→ noop
    console.log('[orch] SW 实例化，尝试恢复 workflow', wf.id);
    await orchEngine.recover(wf.id);
  } catch (e) { console.warn('[orch] 恢复失败（不影响其他业务）', e); }
}
orchRecoverAll();
```

- [ ] **Step 2: 续加「编排器消息入口」段**

紧接 Step 1 代码之后、`// ── end orchestrator ──` 之前追加：

```js

// 编排器消息入口：WF_START（建+跑）/ WF_HITL_CONFIRM（确认推进）/ WF_HITL_REJECT / WF_ABORT
let orchWfSeq = 0;
function orchGenId() { return 'wf_' + Date.now() + '_' + (++orchWfSeq); }

async function orchStartWorkflow(product) {
  const wf = ORCH.steps.buildInitialWorkflow(product, orchGenId);
  wf.status = 'running'; wf.startedAt = Date.now();
  await orchQueue.enqueue(skeleton => {
    if (!skeleton.batch.id) { skeleton.batch.id = 'batch_' + Date.now(); skeleton.batch.createdAt = Date.now(); }
    skeleton.batch.workflows.push(wf);
    skeleton.batch.activeWorkflowId = wf.id;
    return skeleton;
  });
  orchEngine.advance(wf.id);   // 异步推进，不阻塞 ack
  return wf.id;
}

async function orchHitlConfirm({ workflowId, result }) {
  await orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf || wf.status !== 'paused') return undefined;
    const s = wf.steps[wf.cursor];
    s.status = 'done';
    if (result) { s.result = result; Object.assign(wf.product, ORCH.engine.pickProduct(result)); }
    if (wf.hitl) wf.hitl.status = 'confirmed';
    wf.status = 'running'; wf.updatedAt = Date.now();
    return skeleton;
  });
  orchEngine.advance(workflowId);   // HITL step 已 done → advance 推进 cursor 到下一步
}

async function orchSetAborted(workflowId, hitlStatus) {
  await orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf) return undefined;
    wf.status = 'aborted';
    if (hitlStatus && wf.hitl) wf.hitl.status = hitlStatus;
    wf.updatedAt = Date.now();
    return skeleton;
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'WF_START') {
    orchStartWorkflow(msg.data || {})
      .then(id => sendResponse({ ok: true, workflowId: id }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'WF_HITL_CONFIRM') {
    orchHitlConfirm(msg.data || {})
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'WF_HITL_REJECT') {
    orchSetAborted((msg.data || {}).workflowId, 'rejected')
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'WF_ABORT') {
    orchSetAborted((msg.data || {}).workflowId, null)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});
// ── end orchestrator ─────────────────────────────────────────────────────────
```

> orchestrator listener 只处理 `WF_*`；非 WF_* 消息不进任何分支、隐式 return undefined，不影响现有 3 个 listener（主路由 / CPO_START / CPO_START_PHASE2）。

- [ ] **Step 3: node --check 验证语法**

Run: `node --check core/background/service-worker.js`
Expected: 无输出（语法有效；importScripts/chrome/self 是运行时全局，`--check` 只验语法不报未定义符号）

- [ ] **Step 4: dev build 确认 orchestrator 模块 + contract 入 dist**

```bash
python3 build/build_extension.py && ls dist/extension/contract.js dist/extension/background/orchestrator/engine.js dist/extension/background/service-worker.js && echo "OK: orchestrator 模块 + contract 已入 dist"
```
Expected: 三个文件都列出 + 末尾 `OK: ...`（证明 SW importScripts 的相对路径 `../contract.js` / `orchestrator/*.js` 在 dist 中都能解析）

- [ ] **Step 5: commit**

```bash
git add core/background/service-worker.js
git commit -m "feat(orchestrator): service-worker 编排器接线段（stub 驱动）

Why: 把 Plan 2-1+engine 接真实 chrome,让 13 步骨架在 SW 跑起来(stub 验证)。
What: orchestrator 段=importScripts 5 模块+contract; storage 读写适配+mutation 队列;
     stub stepRunner(2-2b 换真实); WF_START/WF_HITL_CONFIRM/WF_HITL_REJECT/WF_ABORT 消息入口;
     SW 实例化即恢复(顶层单次,不挂 onStartup 防 recover 重入)。
Test: node --check 语法 + dev build(contract+orchestrator 模块入 dist); chrome 端到端见 Task 4。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Task 3 完成：编排器在真实 SW 装配完毕（stub 驱动），待 Task 4 chrome 端到端验证 + 全量回归。

---

## Task 4：全量回归 + chrome 端到端验证

**Files:** 无新建（验证）

- [ ] **Step 1: 全量 JS 单测**

Run: `node --test tests/*.test.js`
Expected: PASS — 现有 46 例（version-cmp 5 + dashboard-store 16 + orchestrator steps/sm/recovery/mq 25）+ engine 新增 10 = **56 例，0 失败**。

> ⚠️ 必须 `tests/*.test.js`，不要 `node --test tests/`（整目录会把 pytest 的 `.py` 当 JS 解析失败，见根 CLAUDE.md）。

- [ ] **Step 2: 全量 Python 单测**

Run: `python3 -m pytest tests/ -q`
Expected: PASS — 现有 19 例 + Task 1 新增 1 例（strip 保留根级 contract）= **20 例**。

- [ ] **Step 3: dev build 成功**

Run: `python3 build/build_extension.py`
Expected: exit 0，打印 contract.js / dashboard / 各 feature 拷贝 + manifest 生成。

- [ ] **Step 4: 工作树干净确认**

Run: `git status --short`
Expected: 空（Task 1-3 各自 commit）。

- [ ] **Step 5: chrome 端到端验证（人工，控制者协调用户执行）**

> stub stepRunner 驱动，验证编排骨架在真实 SW 跑通。implementer 无法跑 chrome，此清单交人工。

1. `chrome://extensions` → reload 扩展（dist/extension/ 已 build）。
2. Hub「打开监控」开 dashboard 独立窗口（或地址栏 `chrome-extension://<id>/dashboard/dashboard.html`）。
3. `chrome://extensions` → 扩展卡片「service worker」→「检查」开 SW console。
4. SW console 执行：`orchStartWorkflow({ label: '测试商品' })`
   - **预期**：dashboard 出现 1 个 workflow；第 1 步 `select_product`（HITL）状态 paused，HITL 队列显示「待处理：选品」。
5. SW console 执行：`chrome.storage.local.get('as_workflow_state').then(r => console.log(JSON.stringify(r.as_workflow_state, null, 2)))`，确认 `cursor=0`、`steps[0].status='paused'`、`status='paused'`、`hitl.stepId='select_product'`。
6. 逐个确认 HITL 步推进（用第 4 步返回的 workflowId）：`orchHitlConfirm({ workflowId: '<id>' })`
   - **预期**：每次确认后，若下一步是 AUTO（如 `publish`），SW console 打印 `[orch-stub] 自动步「合规预检+发布」...`，dashboard 该步变 done，再停在下一个 HITL（`get_return_price`）paused。
7. 重复第 6 步穿过全部 HITL，观察 AUTO 步（publish/gen_label/create_sku/create_po/pack_label/ship）被 stub 自动跑过。
   - **预期**：最终 workflow `status='done'`，dashboard 流程总览全绿。
8. **恢复验证（paused 持久化）**：在某 HITL paused 态，`chrome://extensions` 卡片点「停止」service worker → 再点扩展图标 / 发任意 message 唤醒 SW → 查 storage 仍 paused（未丢）→ `orchHitlConfirm` 仍能推进。证明状态在 storage 持久、SW 回收不丢。
   > running-中-回收触发的 rerun / ask-hitl 恢复决策已由 engine 单测（Task 2 recover 用例）覆盖；chrome 手动难精确命中 stub 300ms 窗口，故 chrome 侧只验 paused 持久化。

## 完成定义（DoD）

- contract 提取到 `core/contract.js`，bg + dashboard + node 三方共享；build 拷根级、strip dashboard 不删它（pytest 验证）。
- `engine.js` advance/recover 注入式引擎，10 例 node 单测全绿。
- service-worker.js orchestrator 段：importScripts + 队列包 storage + stub stepRunner + WF_START/HITL 消息 + SW 恢复，`node --check` 语法 + dev build 通过。
- 全量 JS 56 例 + Python 20 例 0 失败。
- chrome 端到端（stub 驱动）人工验证：13 步骨架走通（AUTO 自动 / HITL 暂停确认）+ SW 回收 paused 持久化恢复。

## 与 Plan 2-2b / 2-2c 的衔接

- **2-2b（5 feature 改造）**：把 `orchStubStepRunner` 换成真实 stepRunner——按 `step.feature` 分发到各 feature 的 bg 命令（导航 tab → waitForEl(step.target.readySignal) → sendCommand → 收结构化回报）；每 feature 加命令入口 + committing 标记 + 补 step 的 `target.urlTemplate`/`readySignal`（steps.js 现仅有 domain）。涉及 5 个 feature：check_and_publish / auto_gen_label / create_purchase_order（create_sku+create_po 两步）/ packing_label / auto_ship。
- **2-2c（浮层 + WS）**：core 注入浮层（读 storage 显示进度 + HITL 弹窗「前往/确认」发 `WF_HITL_CONFIRM` message + isDev 守卫「开始」按钮发 `WF_START`）；bg + dashboard WS client 架子 + 连接灯。
- **PR 时机**：建议 2-2a+2-2b+2-2c 一起 PR（2-2a 是 stub、未接真 feature，单独合入是半成品；但每个子 plan 独立可测、可分阶段 review）。
