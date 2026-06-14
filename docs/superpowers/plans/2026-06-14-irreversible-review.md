# 不可逆复核（大脑第三判断点）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 不可逆 AUTO 步（reversible===false：publish/gen_label/create_po/ship）执行前，大脑复核 product 数据 + 页面快照 → PASS 自动跑 / HOLD 暂停转人工，大脑永不假 PASS 放行不可逆。

**Architecture:** 新增 `brain/reviewer.py`（大脑第三判断点，fail-safe→hold）；server 加 `REVIEW_REQUEST→REVIEW_VERDICT`；engine `run-auto` 加 `reviewGate` 注入钩子（阻塞 advance 等 verdict）；bg-entry 实现 reviewGate（请求/响应关联 + 超时）+ WF_REVIEW_APPROVE；overlay 渲染 review-HITL。改动只 brain/ + automation/。

**Tech Stack:** Python stdlib（复用 `brain/jsonx.py`）；JS UMD（node --test）；pytest。spec：`docs/superpowers/specs/2026-06-14-irreversible-review-design.md`。

---

## 三不变量（GUARDRAILS — 不得破坏）

1. **人工是不可逆动作最终授权**：HOLD→人工 proceed/abort；大脑不自动 abort、不无视 concern 自动 proceed。product 写入路径（orchHitlConfirm / engine pickProduct）本计划不碰。
2. **fail-safe**：复核器在线却不确定（模型挂/解析不出/verdict 非法）→ hold，**绝不假 PASS 放行不可逆**。
3. **发版隔离**：只动 `brain/`（Python dev-only）+ `automation/`（dev-only 装配）；不碰 `core/` 和任何 feature。reviewGate 仅 automation 注入；release engine 无 reviewGate（默认 null=proceed）。

## 数据形状（全计划统一，勿改名）

- `REVIEW_REQUEST.data` = `{workflowId, stepId, product, context:{pageSnapshot}}`
- `REVIEW_VERDICT.data` = `{workflowId, stepId, verdict:'pass'|'hold', reason:str, concerns:[str]}`
- `reviewer.review(step_id, product, context, model)` → `{"verdict":"pass"|"hold", "reason":str, "concerns":[str]}`
- `reviewGate(workflowId, step, wf)` → `{verdict,reason,concerns}` | `null`（null=proceed：离线/超时）
- review-HITL = `{action, stepId, kind:'review', concerns:[str], reason, editable:false, fields:[], targetUrl, status:'pending'}`
- step 加 `reviewed:false` 字段（buildInitialWorkflow）

## File Structure

| 文件 | 职责 |
|------|------|
| `brain/reviewer.py`（新） | `review()`：调模型→jsonx 解析→`{verdict,reason,concerns}`；fail-safe→hold |
| `brain/server.py`（改） | `REVIEW_REQUEST` 路由→to_thread(review)→`REVIEW_VERDICT`；reviewer 抛→兜底 hold |
| `automation/orchestrator/steps.js`（改） | buildInitialWorkflow step 加 `reviewed:false` |
| `automation/orchestrator/engine.js`（改） | `reviewGate` 注入 + run-auto 复核闸 + `buildReviewHitl` |
| `automation/bg-entry.js`（改） | `orchReviewGate`（请求/响应关联+超时）+ `orchResolveReview` + REVIEW_VERDICT handler + `orchReviewApprove` + WF_REVIEW_APPROVE + makeEngine 注入 reviewGate |
| `automation/overlay/overlay-view.js`（改） | 纯逻辑 `isReviewHitl(hitl)` |
| `automation/overlay/overlay.js`（改） | review-HITL 渲染：concerns + 前往核对 + 确认提交 + 中止 |
| `tests/test_brain_reviewer.py`（新） | reviewer 单测（fail-safe 红线） |
| `tests/test_brain_server.py`（改） | REVIEW 往返 + 兜底 hold |
| `tests/orchestrator-engine.test.js`（改） | reviewGate hold/pass/reviewed/可逆步不复核/向后兼容 |
| `tests/orchestrator-steps.test.js`（改） | reviewed 字段 |
| `tests/overlay-view.test.js`（改） | isReviewHitl |

---

## Task 1：`brain/reviewer.py` — 不可逆复核（核心，fail-safe）

**Files:** Create `brain/reviewer.py`、Create `tests/test_brain_reviewer.py`

- [ ] **Step 1: 写失败测试** `tests/test_brain_reviewer.py`

```python
# tests/test_brain_reviewer.py — 不可逆复核单测。fail-safe 红线：模型挂/垃圾/verdict 非法 → hold（绝不假 pass）。
from brain.reviewer import review
from brain.model import MockModel


def _ctx():
    return {"pageSnapshot": "page text"}


def test_pass_parsed():
    m = MockModel(canned='{"verdict":"pass","reason":"ok","concerns":[]}')
    assert review("ship", {"skc": "S1"}, _ctx(), m)["verdict"] == "pass"


def test_hold_with_concerns():
    m = MockModel(canned='{"verdict":"hold","reason":"skc空","concerns":["skc 缺失"]}')
    out = review("gen_label", {"skc": ""}, _ctx(), m)
    assert out["verdict"] == "hold"
    assert "skc 缺失" in out["concerns"]


def test_codefenced_verdict():
    m = MockModel(canned='```json\n{"verdict":"pass","reason":"r"}\n```')
    assert review("ship", {}, _ctx(), m)["verdict"] == "pass"


def test_verdict_case_normalized():
    m = MockModel(canned='{"verdict":" PASS ","reason":"r"}')
    assert review("ship", {}, _ctx(), m)["verdict"] == "pass"


def test_model_exception_holds():   # fail-safe 红线
    class Boom:
        def decide(self, m, tools=None):
            raise RuntimeError("down")
    assert review("ship", {}, _ctx(), Boom())["verdict"] == "hold"


def test_garbage_holds():   # fail-safe 红线
    assert review("ship", {}, _ctx(), MockModel(canned="I cannot review"))["verdict"] == "hold"


def test_illegal_verdict_holds():   # fail-safe 红线：verdict 非 pass/hold → hold（绝不默认 pass）
    assert review("ship", {}, _ctx(), MockModel(canned='{"verdict":"approve"}'))["verdict"] == "hold"


def test_diagnosis_style_holds():   # 默认 MockModel 产 {"action":...} 无 verdict → hold
    assert review("ship", {}, _ctx(), MockModel())["verdict"] == "hold"
```

- [ ] **Step 2: 跑确认失败** — `cd /home/linux_dev/projects/wt-irreversible-review && python3 -m pytest tests/test_brain_reviewer.py -q`（预期 ModuleNotFoundError）。

- [ ] **Step 3: 写实现** `brain/reviewer.py`

```python
# brain/reviewer.py — 不可逆复核（大脑第三判断点，与 diagnoser/filler 并列）。spec 2026-06-14。
# 不可逆 AUTO 步执行前复核 product 数据 + 页面快照 → {verdict:'pass'|'hold', reason, concerns}。
# fail-safe：模型挂/解析不出/verdict 非法 → hold（绝不假 PASS 放行不可逆，守不变量2）。
import logging

from brain.jsonx import extract_decision

_log = logging.getLogger("brain.reviewer")


def review(step_id, product, context, model):
    """product: 当前 workflow.product；context: {pageSnapshot}。
    返回 {"verdict":"pass"|"hold", "reason":str, "concerns":[str]}。fail-safe 默认 hold。"""
    try:
        raw = model.decide(_build_messages(step_id, product, context))
    except Exception as e:
        _log.warning("复核模型调用失败: %s: %s", type(e).__name__, str(e)[:200])
        return {"verdict": "hold", "reason": "复核不可用（{}），保守转人工".format(type(e).__name__), "concerns": []}
    obj = extract_decision(raw)
    if not isinstance(obj, dict):
        return {"verdict": "hold", "reason": "复核输出无法解析，保守转人工", "concerns": []}
    verdict = obj.get("verdict")
    verdict = verdict.strip().lower() if isinstance(verdict, str) else verdict
    if verdict not in ("pass", "hold"):
        return {"verdict": "hold", "reason": "复核 verdict 非法，保守转人工", "concerns": []}
    raw_concerns = obj.get("concerns")
    concerns = [str(c) for c in raw_concerns] if isinstance(raw_concerns, list) else []
    return {"verdict": verdict, "reason": str(obj.get("reason") or ""), "concerns": concerns}


def _build_messages(step_id, product, context):
    ctx = context or {}
    snapshot = (ctx.get("pageSnapshot") or "")[:6000]
    return [
        {"role": "system", "content":
            "你是自动化流水线的不可逆动作复核员。这一步将执行【不可逆】操作（发布/生成标签/创建采购单/发货）。"
            "复核 product 数据是否安全提交：格式 sanity、跨字段一致、与页面是否对得上。"
            "只回 JSON：{\"verdict\":\"pass\"|\"hold\",\"reason\":\"简述\",\"concerns\":[\"可疑点\"]}。"
            "数据看起来安全 → pass；发现空/畸形/不匹配/页面态不符 → hold + concerns；拿不准 → hold。"},
        {"role": "user", "content":
            "当前不可逆步: {}\nproduct: {}\n页面快照(截断):\n{}".format(step_id, product, snapshot)},
    ]
```

- [ ] **Step 4: 跑确认通过** — `python3 -m pytest tests/test_brain_reviewer.py -q`（预期 8 pass）。
- [ ] **Step 5: Commit** — `git add brain/reviewer.py tests/test_brain_reviewer.py && git commit`（message 见末尾约定）。

---

## Task 2：`brain/server.py` — REVIEW_REQUEST 路由

**Files:** Modify `brain/server.py`、Modify `tests/test_brain_server.py`

- [ ] **Step 1: 写失败测试**（追加 `tests/test_brain_server.py`，顶部已 `from unittest import mock`）

```python
def test_review_request_returns_verdict():
    server._dashboards.clear()
    server._model = MockModel(canned='{"verdict":"hold","reason":"skc空","concerns":["skc 缺失"]}')

    async def scenario():
        async with websockets.serve(server.handler, "localhost", 0) as s:
            port = s.sockets[0].getsockname()[1]
            async with websockets.connect("ws://localhost:{}".format(port)) as bg:
                await bg.send(encode("HELLO", {"role": "bg"}))
                await bg.send(encode("REVIEW_REQUEST", {
                    "workflowId": "w", "stepId": "gen_label", "product": {"skc": ""}, "context": {}}))
                return decode(await asyncio.wait_for(bg.recv(), timeout=2))

    t, d = _run(scenario())
    assert t == "REVIEW_VERDICT"
    assert d["verdict"] == "hold"
    assert "skc 缺失" in d["concerns"]


def test_review_request_reviewer_crash_holds():   # fail-safe：reviewer 抛 → hold（非 pass）
    server._dashboards.clear()

    async def scenario():
        async with websockets.serve(server.handler, "localhost", 0) as s:
            port = s.sockets[0].getsockname()[1]
            async with websockets.connect("ws://localhost:{}".format(port)) as bg:
                await bg.send(encode("REVIEW_REQUEST", {
                    "workflowId": "w", "stepId": "ship", "product": {}, "context": {}}))
                return decode(await asyncio.wait_for(bg.recv(), timeout=2))

    with mock.patch("brain.server.review", side_effect=RuntimeError("boom")):
        t, d = _run(scenario())
    assert t == "REVIEW_VERDICT"
    assert d["verdict"] == "hold"
```

- [ ] **Step 2: 跑确认失败** — `python3 -m pytest tests/test_brain_server.py -q`。

- [ ] **Step 3: 改 `brain/server.py`**
  - 顶部加：`from brain.reviewer import review`
  - `handler()` 消息循环加分支（在 `FILL_REQUEST` 分支后）：
    ```python
            elif mtype == "REVIEW_REQUEST":
                await _handle_review_request(websocket, data)
    ```
  - 新增函数：
    ```python
    async def _handle_review_request(websocket, data):
        """REVIEW_REQUEST → reviewer 复核 → REVIEW_VERDICT 回 bg + review BRAIN_EVENT。
        fail-safe：reviewer 任何抛点兜底 hold（绝不假 pass 放行不可逆）。to_thread 防阻塞模型冻结。"""
        try:
            result = await asyncio.to_thread(
                review, data.get("stepId"), data.get("product") or {}, data.get("context") or {}, _model)
        except Exception as e:
            result = {"verdict": "hold", "reason": "复核异常兜底（{}），保守转人工".format(type(e).__name__), "concerns": []}
        await _broadcast_dashboards(_brain_event(
            data, "review", "{}：{}".format(result["verdict"], result["reason"])))
        try:
            await websocket.send(encode("REVIEW_VERDICT", {
                "workflowId": data.get("workflowId"), "stepId": data.get("stepId"),
                "verdict": result["verdict"], "reason": result["reason"], "concerns": result["concerns"],
            }))
        except Exception:
            pass
    ```

- [ ] **Step 4: 跑确认通过** — `python3 -m pytest tests/test_brain_server.py -q`（含旧用例不回归）。
- [ ] **Step 5: Commit**

---

## Task 3：`orchestrator` — reviewed 字段 + engine reviewGate 复核闸 + buildReviewHitl

**Files:** Modify `automation/orchestrator/steps.js`、`automation/orchestrator/engine.js`、`tests/orchestrator-steps.test.js`、`tests/orchestrator-engine.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `tests/orchestrator-steps.test.js`：
```js
test('buildInitialWorkflow：每步含 reviewed:false', () => {
  const wf = buildInitialWorkflow({ label: 'A' }, () => 'id');
  assert.ok(wf.steps.every(s => s.reviewed === false));
});
```

`tests/orchestrator-engine.test.js`：先把顶部 import 改为带 `buildReviewHitl`：
```js
const { makeEngine, buildHitl, buildReviewHitl } = require('../automation/orchestrator/engine.js');
```
再追加：
```js
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
  assert.strictEqual(ran, false);                       // adapter 未跑
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
  assert.strictEqual(gated, false);                     // 可逆步 reviewGate 不被调
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

test('buildReviewHitl：review-kind + concerns', () => {
  const h = buildReviewHitl({ id: 'ship', label: '确认发货', target: { url: 'u' } }, { verdict: 'hold', reason: 'r', concerns: ['c1'] });
  assert.strictEqual(h.kind, 'review');
  assert.strictEqual(h.editable, false);
  assert.deepStrictEqual(h.concerns, ['c1']);
  assert.strictEqual(h.targetUrl, 'u');
});
```

- [ ] **Step 2: 跑确认失败** — `node --test tests/orchestrator-engine.test.js tests/orchestrator-steps.test.js`（reviewGate/buildReviewHitl/reviewed 相关 fail）。

- [ ] **Step 3: 改 `steps.js`**
  `buildInitialWorkflow` 的 `STEP_DEFS.map(d => ({...}))` 里，`committing: false, error: null, retryCount: 0,` 改为加 `reviewed: false`：
  ```js
        result: null, brainBrief: '(确定性)', note: null, committing: false, error: null, retryCount: 0, reviewed: false,
  ```

- [ ] **Step 4: 改 `engine.js`**
  - `makeEngine(deps)` 内 `const onPaused = deps.onPaused || (() => {});` 下面加：
    ```js
    const reviewGate = deps.reviewGate || null;   // 后续刀：不可逆步复核闸（async，注入；默认 null=不复核，release 沉睡）
    ```
  - `advance` 的 `case 'run-auto':`，`const step = wf.steps[wf.cursor];` 之后、第一个 `await mutateWorkflow(...status='running'...)` 之前，插入复核闸：
    ```js
            // 不可逆复核（后续刀）：reversible===false 且未复核 + reviewGate 注入 → 复核闸（阻塞 advance 等 verdict）
            if (step.reversible === false && reviewGate && !step.reviewed) {
              const verdict = await reviewGate(workflowId, step, wf);   // bg 实现：WS 往返+超时；离线/超时→null=proceed
              if (verdict && verdict.verdict === 'hold') {
                await mutateWorkflow(workflowId, w => {
                  w.steps[w.cursor].status = 'paused'; w.status = 'paused';
                  w.hitl = buildReviewHitl(w.steps[w.cursor], verdict);
                  w.updatedAt = now();
                });
                return;                                                // 不跑 adapter，等人工确认提交/中止
              }
            }
    ```
  - 同一 run-auto 的 `mutate(status='running')` 块里加 `s.reviewed = true;`（PASS 后标记防重复复核）：
    ```js
            await mutateWorkflow(workflowId, w => {
              const s = w.steps[w.cursor];
              s.status = 'running'; s.startedAt = now(); s.error = null; s.reviewed = true;   // checkpoint + PASS 标 reviewed
            });
    ```
  - 加 `buildReviewHitl` 函数（放在 `buildHitl` 函数附近）：
    ```js
    // 不可逆复核 HOLD → review-kind HITL（concerns + reason；editable:false，人工确认提交/中止）
    function buildReviewHitl(step, verdict) {
      return {
        action: '不可逆复核：' + step.label, stepId: step.id, kind: 'review',
        keyValues: {}, reviewedBrief: '',
        concerns: (verdict && verdict.concerns) || [],
        reason: (verdict && verdict.reason) || '',
        editable: false, fields: [],
        targetUrl: (step.target && step.target.url) || null,
        status: 'pending',
      };
    }
    ```
  - 最终 `return { makeEngine, findWorkflow, pickProduct, buildHitl };` 改为加 `buildReviewHitl`：
    ```js
    return { makeEngine, findWorkflow, pickProduct, buildHitl, buildReviewHitl };
    ```

- [ ] **Step 5: 跑确认通过 + Commit** — `node --test tests/orchestrator-engine.test.js tests/orchestrator-steps.test.js`（旧测试不回归）；`git add automation/orchestrator/steps.js automation/orchestrator/engine.js tests/orchestrator-engine.test.js tests/orchestrator-steps.test.js && git commit`。

---

## Task 4：`overlay-view.js` — `isReviewHitl`（纯逻辑）

**Files:** Modify `automation/overlay/overlay-view.js`、`tests/overlay-view.test.js`

- [ ] **Step 1: 写失败测试**（追加 `tests/overlay-view.test.js`）
```js
const { isReviewHitl } = require('../automation/overlay/overlay-view.js');

test('isReviewHitl：kind==="review" → true；其他 → false', () => {
  assert.strictEqual(isReviewHitl({ kind: 'review' }), true);
  assert.strictEqual(isReviewHitl({ kind: 'fill' }), false);
  assert.strictEqual(isReviewHitl({}), false);
  assert.strictEqual(isReviewHitl(null), false);
});
```

- [ ] **Step 2: 跑确认失败** — `node --test tests/overlay-view.test.js`。

- [ ] **Step 3: 改 `overlay-view.js`**
  - 在 `mergeSuggestion` 函数后加：
    ```js
    // 不可逆复核 HITL（engine buildReviewHitl 写 kind:'review'）：overlay 据此渲染 concerns + 确认提交/中止。
    function isReviewHitl(hitl) {
      return !!(hitl && hitl.kind === 'review');
    }
    ```
  - 把 `return {... hasSuggestion, mergeSuggestion };` 改为加上 `isReviewHitl`：
    ```js
    return { activeWorkflow, decideOverlayView, normalizeStartLabel, buildFillResult, validateFill, hasSuggestion, mergeSuggestion, isReviewHitl };
    ```

- [ ] **Step 4: 跑确认通过** — `node --test tests/overlay-view.test.js`。
- [ ] **Step 5: Commit**

---

## Task 5：`overlay.js` — review-HITL 渲染（concerns + 确认提交 + 中止）

**Files:** Modify `automation/overlay/overlay.js`（DOM，靠静态校验 + overlay-view 测试 + e2e）

- [ ] **Step 1: `renderBody` 的 `paused && wf.hitl` 分支顶部插入 review-kind 分叉**
  在 `renderBody` 的 `if (wf.status === 'paused' && wf.hitl) {` 之后、`const h = wf.hitl;` 之后，回填渲染之前，插入：
```js
      // 不可逆复核 HITL（kind:'review'）：渲染 concerns + 前往核对 + 确认提交 + 中止（与回填 HITL 分叉）
      if (VIEW.isReviewHitl(h)) {
        let rb = `<div style="margin-bottom:6px;">⚠️ 不可逆复核：<b>${step.label || ''}</b></div>`;
        if (h.reason) rb += `<div style="font-size:12px;color:#d29922;margin-bottom:6px;">${h.reason}</div>`;
        if (Array.isArray(h.concerns) && h.concerns.length) {
          rb += `<ul style="margin:6px 0;padding-left:18px;font-size:12px;color:#ff7b72;">` +
            h.concerns.map(c => `<li>${c}</li>`).join('') + `</ul>`;
        }
        rb += `<div>`;
        const goUrl = h.targetUrl || (step.target && step.target.url);
        if (goUrl) rb += `<button class="aso-btn aso-btn-go" data-act="go">前往核对</button>`;
        rb += `<button class="aso-btn aso-btn-ok" data-act="approve">确认提交</button>`;
        rb += `<button class="aso-btn aso-btn-no" data-act="reject">中止</button></div>`;
        return rb;
      }
```
（注意：放在 `const h = wf.hitl;` 后、原 `if (wf.status === 'paused' && wf.hitl)` 块内回填逻辑之前；review 分叉 `return rb` 直接返回，不走回填渲染。`step` 是 renderBody 第二参数。concerns/reason 注入 innerHTML 未转义——与现有 keyValues/step.label/fill-reason 同模式，dev-only 浮层、operator 自己的 LLM，沿既有模式不在此 PR 扩转义。）

- [ ] **Step 2: `bindActions` 加 `approve` 分支**
  在 `else if (act === 'refresh') {...}` 后加：
```js
        } else if (act === 'approve') {
          send('WF_REVIEW_APPROVE', { workflowId: wf.id });   // 人工确认提交不可逆动作
```
（`reject` 分支已存在 → WF_HITL_REJECT，复核中止复用它；`go` 已存在。）

- [ ] **Step 3: 静态校验** — `cd /home/linux_dev/projects/wt-irreversible-review`；`node -e "new Function(require('fs').readFileSync('automation/overlay/overlay.js','utf8')); console.log('overlay.js 语法 OK')"`；`node --test tests/overlay-view.test.js`。
- [ ] **Step 4: 自审** — 确认 review 分叉不破坏回填 HITL / error / running 渲染；approve 接进 bindActions if/else 链括号匹配。
- [ ] **Step 5: Commit**

---

## Task 6：`bg-entry.js` — 接线（reviewGate 请求/响应关联 + WF_REVIEW_APPROVE）

**Files:** Modify `automation/bg-entry.js`（chrome 编排，无单测——复用已测单元；端到端靠 chrome e2e）

> 不变量3：reviewGate 首行 `if(!orchWsClient) return null`（离线 proceed）；reviewGate 仅由 engine 注入调用、REVIEW_VERDICT 仅 ws handler 触发 → release 无 ws/无注入 → 永不阻塞、永不复核。**绝不**在 SW 顶层/orchRecoverAll 调。`orchCapturePageSnapshot` 已存在（回填刀引入），直接复用。

- [ ] **Step 1: 加复核请求/响应关联状态 + 三函数**（放在 `const orchQueue = ...` 之后，与 orchRequestFillSuggest 等并列）
```js
// 不可逆复核（后续刀）：reviewGate 阻塞 advance 等 REVIEW_VERDICT（区别于回填 fire-and-forget）。
const orchReviewPending = new Map();          // key=`${wfId}:${stepId}` → {resolve, timer}
const ORCH_REVIEW_TIMEOUT_MS = 15000;

// engine 注入的复核闸：离线/超时 → null(proceed，additive)；仅显式 verdict 才返回。绝不写 product。
async function orchReviewGate(workflowId, step, wf) {
  if (!orchWsClient) return null;             // 大脑离线 → proceed（守不变量3：release 无 ws 永不复核）
  const key = workflowId + ':' + step.id;
  const pageSnapshot = await orchCapturePageSnapshot(step.domain);
  return new Promise(resolve => {
    const timer = setTimeout(() => { orchReviewPending.delete(key); resolve(null); }, ORCH_REVIEW_TIMEOUT_MS);  // 超时→proceed
    orchReviewPending.set(key, { resolve, timer });
    orchWsClient.send('REVIEW_REQUEST', { workflowId, stepId: step.id, product: wf.product, context: { pageSnapshot } });
  });
}

// REVIEW_VERDICT 回来：按 key 找等待的 resolver，resolve(verdict)。无对应（超时已 resolve）→ 忽略。
function orchResolveReview(data) {
  const key = data.workflowId + ':' + data.stepId;
  const pending = orchReviewPending.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  orchReviewPending.delete(key);
  pending.resolve({ verdict: data.verdict, reason: data.reason, concerns: data.concerns });
}

// 人工确认提交不可逆动作：标 reviewed=true + running + advance（这次 reviewGate 被 !reviewed 跳过 → 跑 adapter）。
async function orchReviewApprove(workflowId) {
  await orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf || wf.status !== 'paused') return undefined;
    const step = wf.steps[wf.cursor];
    if (!step || !wf.hitl || wf.hitl.kind !== 'review') return undefined;   // 只对 review-HITL 生效
    step.reviewed = true;
    wf.status = 'running'; wf.updatedAt = Date.now();
    return skeleton;
  });
  await orchEngine.advance(workflowId);
}
```

- [ ] **Step 2: `orchEnsureWs` handlers 加 `REVIEW_VERDICT`**
  现有 `FILL_SUGGEST: (data) => {...},` 后加：
```js
      REVIEW_VERDICT: (data) => { orchResolveReview(data); },
```

- [ ] **Step 3: `makeEngine` 注入 `reviewGate`**
  `orchEngine = ORCH.engine.makeEngine({...})` deps 里，`onPaused: (...) => {...},` 后加：
```js
  reviewGate: orchReviewGate,   // 后续刀：不可逆步执行前复核（离线/超时→null=proceed）
```

- [ ] **Step 4: `WF_` handler 加 `WF_REVIEW_APPROVE` 分支**
  在 `if (msg.type === 'WF_FILL_REFRESH') {...}` 后加：
```js
  if (msg.type === 'WF_REVIEW_APPROVE') {
    orchReviewApprove((msg.data || {}).workflowId)
      .then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
```

- [ ] **Step 5: 静态校验 + 自审 + Commit**
  - `node -e "new Function(require('fs').readFileSync('automation/bg-entry.js','utf8')); console.log('bg-entry.js 语法 OK')"`
  - `python3 build/build_extension.py 2>&1 | tail -3`（8 features / automation=on / done）
  - 自审：①reviewGate 首行离线早返回 ②REVIEW_VERDICT handler 接好 ③reviewGate 注入进 makeEngine ④WF_REVIEW_APPROVE 接进 WF_ 链括号匹配 ⑤orchReviewApprove 只对 review-HITL 生效、不碰 product（只标 reviewed）⑥没在 SW 顶层/orchRecoverAll 调新函数。
  - `git add automation/bg-entry.js && git commit`。

---

## Task 7：全量回归 + 构建 + 真 brain 进程冒烟 + 收尾

- [ ] **Step 1: 全量纯逻辑回归**
  - `node --test tests/*.test.js`（预期 106 + engine 7 + buildReviewHitl 1 + steps 1 + overlay-view 1 = 116 pass）
  - `python3 -m pytest tests/ -q`（预期 80 + reviewer 8 + server 2 = 90 pass）
- [ ] **Step 2: 真 brain 进程 REVIEW_REQUEST 冒烟**
  起 `python3 -m brain`（MockModel），WS 发 `REVIEW_REQUEST` → 应收 `REVIEW_VERDICT`，**MockModel 产诊断式输出无 verdict → fail-safe hold**（证明通道通 + fail-safe；真 pass/hold 判断需配 `BRAIN_LLM_*` 真模型，留 e2e）。
- [ ] **Step 3: build 确认装配链** — `python3 build/build_extension.py`（8 features / automation=on）。
- [ ] **Step 4: 更新 roadmap** — `docs/superpowers/automation-monitor-roadmap.md` 后续刀段标注「不可逆复核已实施」+ 链接 spec/plan + fail-safe 语义 + 真模型仍人工 gated。
- [ ] **Step 5: Commit**

## Done Definition（验收 + 不变量复核）

- [ ] 三不变量成立：①HOLD→人工 proceed(WF_REVIEW_APPROVE)/abort(WF_HITL_REJECT)，orchReviewApprove 只标 reviewed 不碰 product ②reviewer 模型挂/垃圾/verdict 非法→hold（红线测试覆盖）；server reviewer 抛→hold ③只 brain/+automation/，release 无 reviewGate 注入/无 ws→沉睡。
- [ ] reviewGate 端到端：不可逆步 hold→暂停不跑 adapter / pass→跑+reviewed / 离线超时→proceed / 可逆步不复核 / reviewed 不重复（单元覆盖）；真 brain 进程 REVIEW 往返 + fail-safe hold 冒烟。
- [ ] 全量 node 116 / pytest 90 / build 健康。
- [ ] 真模型端到端（配 BRAIN_LLM_* + chrome）仍人工 gated，代码 turn-key。

## Commit message 约定

`<type>(<scope>): <summary>` + Why/What/Test，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。scope 用 `brain`/`automation`/`orchestrator`/`overlay`。

## 执行交接

实施用 **subagent-driven-development**（每任务 fresh subagent + 两段 review）或 **executing-plans**。Task 1-4 单元可测、适合 subagent；Task 5-6 chrome 绑定靠 e2e，review 重点放「fail-safe / 不写 product / 发版隔离 / reviewGate 不破坏 run-auto」。
