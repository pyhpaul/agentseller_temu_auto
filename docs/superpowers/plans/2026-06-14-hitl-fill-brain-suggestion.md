# HITL 回填的模型提议（通用通道）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 让大脑为回填型 HITL 步（skc/url1688/orderNo1688）从上下文 + 页面快照**提议**回填值，overlay 预填 + 人工复核确认，大脑永不自动落 product。

**Architecture:** 新增 `brain/filler.py`（与 diagnoser 并列的第二判断点）；server 加 `FILL_REQUEST→FILL_SUGGEST` WS 消息对；engine 加 `onPaused` 钩子；bg-entry 在回填步 pause 时抓上下文+快照发请求、收提议写 `hitl.suggestion`；overlay 预填+🧠badge。改动只在 `brain/` + `automation/`，不碰 core/feature。

**Tech Stack:** Python stdlib（复用 `brain/jsonx.py` 容错解析）；JS UMD 模块（node --test）；pytest。spec：`docs/superpowers/specs/2026-06-14-hitl-fill-brain-suggestion-design.md`。

---

## 三条不变量（GUARDRAILS — 任何任务不得破坏）

1. **人工确认门是唯一落 product 的闸**：suggestion 只写 `hitl.suggestion`、只做 overlay 预填；product 永远只经 `WF_HITL_CONFIRM`→`orchHitlConfirm` 更新（本计划不改该函数）。
2. **大脑绝不编造**：filler 模型挂/解析不出/不确定 → 空 `values`（退回纯人工）。
3. **发版隔离**：改动只在 `brain/`（Python，dev-only）+ `automation/`（dev-only 装配）。不碰 `core/` 和任何 feature。

## 数据形状（全计划统一，勿改名）

- `FILL_REQUEST.data` = `{workflowId, stepId, fields:[{key,label,fieldType,required}], context:{product, recentSteps:[{id,status}], pageSnapshot: str|null}}`
- `FILL_SUGGEST.data` = `{workflowId, stepId, values:{key:str}, reason:str, confidence:float}`
- `filler.suggest(step_id, fields, context, model)` → `{"values":{key:str}, "reason":str, "confidence":float}`（空提议 = `values` 为空 dict）
- `wf.hitl.suggestion` = `{values, reason, confidence}`

## File Structure

| 文件 | 职责 |
|------|------|
| `brain/filler.py`（新） | `suggest()`：调模型→jsonx 容错解析→`{values,reason,confidence}`；空提议兜底 |
| `brain/server.py`（改） | `FILL_REQUEST` 路由 → `to_thread(suggest)` → `FILL_SUGGEST` + `suggest` BRAIN_EVENT；filler 抛点兜底空提议 |
| `automation/orchestrator/engine.js`（改） | `pause-hitl` 时 `onPaused(workflowId)` 钩子（fire-forget，默认 noop） |
| `automation/overlay/overlay-view.js`（改） | 纯逻辑 `hasSuggestion(hitl)` + `mergeSuggestion(fields, suggestion)` |
| `automation/overlay/overlay.js`（改） | 回填字段渲染：有 suggestion 时预填 value + 🧠badge + 顶部 reason/confidence |
| `automation/bg-entry.js`（改） | `onPaused`→`orchRequestFillSuggest`；`orchCapturePageSnapshot`；ws `FILL_SUGGEST` handler；`WF_FILL_REFRESH` 分支 |
| `tests/test_brain_filler.py`（新） | filler 单测（含空提议红线） |
| `tests/test_brain_server.py`（改） | FILL_REQUEST→FILL_SUGGEST 集成 + filler 抛兜底 |
| `tests/orchestrator-engine.test.js`（改） | onPaused 触发测试 |
| `tests/overlay-view.test.js`（改） | hasSuggestion/mergeSuggestion 测试 |

---

## Task 1：`brain/filler.py` — 回填提议（核心，与 diagnoser 并列）

**Files:** Create `brain/filler.py`、Create `tests/test_brain_filler.py`

- [ ] **Step 1: 写失败测试** `tests/test_brain_filler.py`

```python
# tests/test_brain_filler.py — 回填提议单测。空提议红线：模型挂/垃圾/诊断式输出 → values 为空（不编造，守不变量2）。
from brain.filler import suggest
from brain.model import MockModel

FIELDS = [{"key": "url1688", "label": "1688 货源链接", "fieldType": "text", "required": True}]


def _ctx():
    return {"product": {"label": "A"}, "recentSteps": [], "pageSnapshot": "some 1688 page text"}


def test_parses_fill_values():
    m = MockModel(canned='{"values":{"url1688":"https://x.1688.com/a"},"reason":"匹配","confidence":0.8}')
    out = suggest("compare_1688", FIELDS, _ctx(), m)
    assert out["values"]["url1688"] == "https://x.1688.com/a"
    assert out["confidence"] == 0.8


def test_codefenced_values_parse():
    m = MockModel(canned='```json\n{"values":{"url1688":"https://y.1688.com/b"},"reason":"r"}\n```')
    assert suggest("compare_1688", FIELDS, _ctx(), m)["values"]["url1688"] == "https://y.1688.com/b"


def test_model_exception_empty_no_fabricate():
    class Boom:
        def decide(self, m, tools=None):
            raise RuntimeError("down")
    assert suggest("compare_1688", FIELDS, _ctx(), Boom())["values"] == {}


def test_garbage_empty():
    assert suggest("compare_1688", FIELDS, _ctx(), MockModel(canned="I cannot help"))["values"] == {}


def test_diagnosis_style_output_yields_empty():
    # 默认 MockModel 产诊断式 {"action":...}，无 values → 空提议（退回人工）
    assert suggest("compare_1688", FIELDS, _ctx(), MockModel())["values"] == {}


def test_only_requested_keys_kept():
    m = MockModel(canned='{"values":{"url1688":"https://x.1688.com/a","evil":"x"},"reason":"r"}')
    assert "evil" not in suggest("compare_1688", FIELDS, _ctx(), m)["values"]


def test_empty_string_value_ignored():
    m = MockModel(canned='{"values":{"url1688":"  "},"reason":"r"}')
    assert suggest("compare_1688", FIELDS, _ctx(), m)["values"] == {}
```

- [ ] **Step 2: 跑确认失败** — `cd /home/linux_dev/projects/wt-hitl-fill-brain && python3 -m pytest tests/test_brain_filler.py -q`。预期 ModuleNotFoundError（brain.filler 未建）。

- [ ] **Step 3: 写实现** `brain/filler.py`

```python
# brain/filler.py — HITL 回填提议（大脑第二判断点，与 diagnoser 并列）。spec 2026-06-14。
# 给回填型 HITL 步提议回填值：调模型 → jsonx 容错解析 → {values, reason, confidence}。
# 安全：模型挂/解析不出/不确定 → 空 values（绝不编造，守不变量2）；落 product 仍由人工确认门。
import logging

from brain.jsonx import extract_decision

_log = logging.getLogger("brain.filler")


def suggest(step_id, fields, context, model):
    """fields: [{key,label,fieldType,required}]; context: {product, recentSteps, pageSnapshot}。
    返回 {"values": {key: str}, "reason": str, "confidence": float}。空提议 = values 为空 dict。"""
    fields = fields or []
    keys = [f.get("key") for f in fields if f.get("key")]
    if not keys:
        return {"values": {}, "reason": "无字段", "confidence": 0.0}
    try:
        raw = model.decide(_build_messages(step_id, fields, context))
    except Exception as e:
        _log.warning("回填提议模型调用失败: %s: %s", type(e).__name__, str(e)[:200])
        return {"values": {}, "reason": "模型不可用", "confidence": 0.0}
    obj = extract_decision(raw)
    if not isinstance(obj, dict):
        return {"values": {}, "reason": "无法解析提议", "confidence": 0.0}
    raw_values = obj.get("values")
    values = {}
    if isinstance(raw_values, dict):
        for k in keys:                       # 只收请求的字段、强制非空字符串、空串忽略（不编造）
            v = raw_values.get(k)
            if isinstance(v, (str, int, float)) and str(v).strip():
                values[k] = str(v).strip()
    conf = obj.get("confidence")
    confidence = float(conf) if isinstance(conf, (int, float)) and not isinstance(conf, bool) else 0.0
    return {"values": values, "reason": str(obj.get("reason") or ""), "confidence": confidence}


def _build_messages(step_id, fields, context):
    field_desc = ", ".join(
        "{}（{}{}）".format(f.get("key"), f.get("label") or "", "，必填" if f.get("required") else "")
        for f in fields)
    ctx = context or {}
    snapshot = (ctx.get("pageSnapshot") or "")[:6000]
    return [
        {"role": "system", "content":
            "你是自动化流水线的回填助手。根据上下文为指定字段提议回填值。"
            "只回 JSON：{\"values\":{\"<字段key>\":\"<值>\"},\"reason\":\"简述依据\",\"confidence\":0~1}。"
            "无法可靠判断的字段【留空或不给】，绝不编造。"},
        {"role": "user", "content":
            "当前步: {}\n需填字段: {}\n已知 product: {}\n近期步骤: {}\n页面快照(截断):\n{}".format(
                step_id, field_desc, ctx.get("product"), ctx.get("recentSteps"), snapshot)},
    ]
```

- [ ] **Step 4: 跑确认通过** — `python3 -m pytest tests/test_brain_filler.py -q`，预期 7 pass。
- [ ] **Step 5: Commit** — `git add brain/filler.py tests/test_brain_filler.py && git commit`（message 见末尾约定）。

---

## Task 2：`brain/server.py` — FILL_REQUEST 路由

**Files:** Modify `brain/server.py`、Modify `tests/test_brain_server.py`

- [ ] **Step 1: 写失败测试**（追加 `tests/test_brain_server.py`，文件顶部已 `from unittest import mock`）

```python
def test_fill_request_returns_suggest():
    server._dashboards.clear()
    server._model = MockModel(canned='{"values":{"url1688":"https://x.1688.com/a"},"reason":"r","confidence":0.7}')

    async def scenario():
        async with websockets.serve(server.handler, "localhost", 0) as s:
            port = s.sockets[0].getsockname()[1]
            async with websockets.connect("ws://localhost:{}".format(port)) as bg:
                await bg.send(encode("HELLO", {"role": "bg"}))
                await bg.send(encode("FILL_REQUEST", {
                    "workflowId": "w", "stepId": "compare_1688",
                    "fields": [{"key": "url1688", "label": "L", "required": True}], "context": {}}))
                return decode(await asyncio.wait_for(bg.recv(), timeout=2))

    t, d = _run(scenario())
    assert t == "FILL_SUGGEST"
    assert d["values"]["url1688"] == "https://x.1688.com/a"


def test_fill_request_filler_crash_degrades_empty():
    server._dashboards.clear()

    async def scenario():
        async with websockets.serve(server.handler, "localhost", 0) as s:
            port = s.sockets[0].getsockname()[1]
            async with websockets.connect("ws://localhost:{}".format(port)) as bg:
                await bg.send(encode("FILL_REQUEST", {
                    "workflowId": "w", "stepId": "x", "fields": [{"key": "k"}], "context": {}}))
                return decode(await asyncio.wait_for(bg.recv(), timeout=2))

    with mock.patch("brain.server.suggest", side_effect=RuntimeError("boom")):
        t, d = _run(scenario())
    assert t == "FILL_SUGGEST"
    assert d["values"] == {}
```

- [ ] **Step 2: 跑确认失败** — `python3 -m pytest tests/test_brain_server.py -q`。

- [ ] **Step 3: 改 `brain/server.py`**
  - 顶部加 import：`from brain.filler import suggest`
  - `handler()` 的消息循环加分支（在 `STEP_RESULT` 分支后）：
    ```python
            elif mtype == "FILL_REQUEST":
                await _handle_fill_request(websocket, data)
    ```
  - 新增函数：
    ```python
    async def _handle_fill_request(websocket, data):
        """FILL_REQUEST → filler 提议 → FILL_SUGGEST 回 bg + suggest BRAIN_EVENT 给 dashboard。
        filler 任何抛点兜底空提议（守不变量2），不崩 handler。to_thread 防阻塞模型冻结事件循环。"""
        try:
            result = await asyncio.to_thread(
                suggest, data.get("stepId"), data.get("fields") or [], data.get("context") or {}, _model)
        except Exception as e:
            result = {"values": {}, "reason": "提议异常兜底（{}）".format(type(e).__name__), "confidence": 0.0}
        await _broadcast_dashboards(_brain_event(
            data, "suggest", "回填提议 {}：{}".format(list(result["values"].keys()), result["reason"])))
        try:
            await websocket.send(encode("FILL_SUGGEST", {
                "workflowId": data.get("workflowId"), "stepId": data.get("stepId"),
                "values": result["values"], "reason": result["reason"], "confidence": result["confidence"],
            }))
        except Exception:
            pass
    ```

- [ ] **Step 4: 跑确认通过** — `python3 -m pytest tests/test_brain_server.py -q`（含旧用例不回归）。
- [ ] **Step 5: Commit**

---

## Task 3：`engine.js` — `onPaused` 钩子（回填步 pause 通知 bg）

**Files:** Modify `automation/orchestrator/engine.js`、Modify `tests/orchestrator-engine.test.js`

- [ ] **Step 1: 写失败测试**（追加 `tests/orchestrator-engine.test.js`，harness `fakeStore/mkSkeleton/mkStep/wf0/makeMutationQueue` 已在文件内）

```js
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
```

- [ ] **Step 2: 跑确认失败** — `node --test tests/orchestrator-engine.test.js`。预期 onPaused 测试 fail（pausedId 仍 null）。

- [ ] **Step 3: 改 `engine.js`**
  - `makeEngine(deps)` 内 `onStepSettled` 那行下面加：
    ```js
    const onPaused = deps.onPaused || (() => {});   // 后续刀：回填型 HITL pause 时通知 bg 请求大脑提议（fire-forget）
    ```
  - `advance` 的 `case 'pause-hitl':` 块，`await mutateWorkflow(...)` 之后、`return;` 之前加一行：
    ```js
            onPaused(workflowId);   // fire-forget：bg 据此为回填型步请求大脑提议（非回填步 bg 端自行过滤）
    ```

- [ ] **Step 4: 跑确认通过** — `node --test tests/orchestrator-engine.test.js`，预期全 pass（旧 onStepSettled 等不回归）。
- [ ] **Step 5: Commit**

---

## Task 4：`overlay-view.js` — `hasSuggestion` + `mergeSuggestion`（纯逻辑）

**Files:** Modify `automation/overlay/overlay-view.js`、Modify `tests/overlay-view.test.js`

- [ ] **Step 1: 写失败测试**（追加 `tests/overlay-view.test.js`）

```js
const { hasSuggestion, mergeSuggestion } = require('../automation/overlay/overlay-view.js');

test('hasSuggestion：有非空 values → true；空/无 → false', () => {
  assert.strictEqual(hasSuggestion({ suggestion: { values: { skc: 'X' } } }), true);
  assert.strictEqual(hasSuggestion({ suggestion: { values: {} } }), false);
  assert.strictEqual(hasSuggestion({}), false);
  assert.strictEqual(hasSuggestion(null), false);
});

test('mergeSuggestion：字段附 suggestedValue（命中→值，未命中→空串），保留原字段', () => {
  const fields = [{ key: 'skc', label: 'SKC' }, { key: 'spuId', label: 'SPU' }];
  const out = mergeSuggestion(fields, { values: { skc: 'SKC123' } });
  assert.strictEqual(out[0].suggestedValue, 'SKC123');
  assert.strictEqual(out[1].suggestedValue, '');
  assert.strictEqual(out[0].label, 'SKC');   // 原字段 label 保留
});

test('mergeSuggestion：无 suggestion → 全空串（现状不变）', () => {
  assert.strictEqual(mergeSuggestion([{ key: 'skc' }], null)[0].suggestedValue, '');
});
```

- [ ] **Step 2: 跑确认失败** — `node --test tests/overlay-view.test.js`，预期新 3 测试 fail（函数未导出）。

- [ ] **Step 3: 改 `overlay-view.js`**
  - 在 `validateFill` 函数后、`return {...}` 前加：
    ```js
    // 回填提议（大脑 FILL_SUGGEST 写入 hitl.suggestion）：判定有无提议 + 合并到字段渲染（overlay 预填用）。
    function hasSuggestion(hitl) {
      return !!(hitl && hitl.suggestion && hitl.suggestion.values
        && Object.keys(hitl.suggestion.values).length);
    }
    function mergeSuggestion(fields, suggestion) {
      const vals = (suggestion && suggestion.values) || {};
      return (fields || []).map(f => ({
        ...f, suggestedValue: (vals[f.key] != null) ? String(vals[f.key]) : '',
      }));
    }
    ```
  - 把 `return { activeWorkflow, decideOverlayView, normalizeStartLabel, buildFillResult, validateFill };` 改为：
    ```js
    return { activeWorkflow, decideOverlayView, normalizeStartLabel, buildFillResult, validateFill, hasSuggestion, mergeSuggestion };
    ```

- [ ] **Step 4: 跑确认通过** — `node --test tests/overlay-view.test.js`，预期全 pass。
- [ ] **Step 5: Commit**

---

## Task 5：`overlay.js` — 回填字段预填 + 🧠badge + reason + 重新建议按钮

**Files:** Modify `automation/overlay/overlay.js`（DOM 渲染，靠 Task 4 纯逻辑 + chrome e2e 验证，无单测）

- [ ] **Step 1: 改 `renderBody` 的回填字段渲染段**
  把现有 `if (h.editable && Array.isArray(h.fields) && h.fields.length) {...}` 段替换为（用 `VIEW.mergeSuggestion` 预填）：

```js
      if (h.editable && Array.isArray(h.fields) && h.fields.length) {
        // 大脑提议（FILL_SUGGEST 写入 h.suggestion）→ 预填 value + 🧠badge；无提议则空（现状）
        if (VIEW.hasSuggestion(h)) {
          b += `<div style="font-size:12px;color:#3fb950;margin:4px 0;">🧠 大脑建议（请核对）` +
            (h.suggestion.reason ? `：${h.suggestion.reason}` : '') +
            (typeof h.suggestion.confidence === 'number' ? `（信心 ${h.suggestion.confidence}）` : '') + `</div>`;
        }
        const merged = VIEW.mergeSuggestion(h.fields, h.suggestion);
        merged.forEach(f => {
          const sv = (f.suggestedValue || '').replace(/"/g, '&quot;');
          const badge = f.suggestedValue ? ` <span style="color:#3fb950;">🧠</span>` : '';
          b += `<div style="margin-top:6px;"><label style="font-size:12px;color:#8b949e;">` +
            `${f.label || f.key}${f.required ? ' <span style="color:#f85149;">*</span>' : ''}${badge}</label>`;
          if (f.fieldType === 'select' && Array.isArray(f.options)) {
            b += `<select class="aso-field" id="aso-fill-${f.key}">` +
              f.options.map(o => `<option value="${o}"${o === f.suggestedValue ? ' selected' : ''}>${o}</option>`).join('') + `</select>`;
          } else {
            b += `<input class="aso-field" id="aso-fill-${f.key}" ` +
              `type="${f.fieldType === 'number' ? 'number' : 'text'}" value="${sv}" placeholder="${f.label || f.key}"/>`;
          }
          b += `</div>`;
        });
      }
```

- [ ] **Step 2: 在按钮行加「🔄 重新建议」**（仅回填型 editable 步显示）
  在 `renderBody` 的 paused 分支按钮区，`<button ... data-act="reject">拒绝</button>` 之前加：
```js
      if (h.editable) b += `<button class="aso-btn aso-btn-no" data-act="refresh">🔄 重新建议</button>`;
```

- [ ] **Step 3: 在 `bindActions` 加 refresh 分支**
  在 `else if (act === 'retry') {...}` 后加：
```js
        } else if (act === 'refresh') {
          send('WF_FILL_REFRESH', { workflowId: wf.id });   // 让 bg 重新请求大脑提议
```

- [ ] **Step 4: 静态校验** — `node -e "require('./automation/overlay/overlay-view.js'); console.log('overlay-view loadable')"`（overlay.js 含 chrome/DOM 不能直接 node require，靠 Task 4 测试 + e2e；此步仅确认 overlay-view 可加载）。
- [ ] **Step 5: Commit**

---

## Task 6：`bg-entry.js` — 接线（请求/接收提议 + 快照 + onPaused + WF_FILL_REFRESH）

**Files:** Modify `automation/bg-entry.js`（chrome 编排，无单测——复用已测单元 filler/server/engine onPaused/overlay-view；端到端靠 chrome e2e）

> 不变量3：所有触发都经 `orchWsClient`（仅 WF_* 按需连，release 无 WF_*→无 ws→永不触发）。**绝不**在 SW 顶层 / orchRecoverAll 调这些。

- [ ] **Step 1: `orchEnsureWs` 的 handlers 加 `FILL_SUGGEST`**
  现有 `STATE_PATCH: (data) => {...},` 后加：
```js
      FILL_SUGGEST: (data) => {
        orchApplyFillSuggest(data).catch(e => console.warn('[orch-ws] FILL_SUGGEST 写入失败', e));
      },
```

- [ ] **Step 2: 加三个函数**（放在 `const orchQueue = ...` 定义之后；函数声明 hoist，运行时调用，引用 ORCH/orchQueue/orchWsClient 安全）
```js
// 回填提议（后续刀）：回填型 HITL pause → 抓上下文 + 快照 → FILL_REQUEST；收 FILL_SUGGEST 写 hitl.suggestion。
// 仅大脑在线才发；非回填步跳过；绝不写 product（人工确认门唯一落 product，守不变量1）。
async function orchRequestFillSuggest(workflowId) {
  if (!orchWsClient) return;                       // 大脑离线/release 无 ws → 退回纯人工（守不变量3）
  const wf = ORCH.engine.findWorkflow(await orchRead(), workflowId);
  if (!wf || wf.status !== 'paused') return;
  const step = wf.steps[wf.cursor];
  const fields = (step && step.hitlSpec && step.hitlSpec.fields) || [];
  if (!fields.length) return;                      // 仅回填型步
  const pageSnapshot = await orchCapturePageSnapshot(step.domain);
  orchWsClient.send('FILL_REQUEST', {
    workflowId, stepId: step.id, fields,
    context: {
      product: wf.product,
      recentSteps: wf.steps.slice(Math.max(0, wf.cursor - 3), wf.cursor).map(s => ({ id: s.id, status: s.status })),
      pageSnapshot,
    },
  });
}

// 写大脑提议到 wf.hitl.suggestion（不碰 product）；只对当前 paused 的同一 step 生效（防过期提议串入）。
function orchApplyFillSuggest(data) {
  return orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, data.workflowId);
    if (!wf || wf.status !== 'paused' || !wf.hitl) return undefined;
    const step = wf.steps[wf.cursor];
    if (!step || step.id !== data.stepId) return undefined;
    wf.hitl.suggestion = { values: data.values || {}, reason: data.reason || '', confidence: data.confidence };
    wf.updatedAt = Date.now();
    return skeleton;
  });
}

// 按 domain 抓当前页 innerText 快照（截断 6000）。尽力而为：无匹配 tab / 报错 → null（filler 仅凭 workflow 上下文）。
async function orchCapturePageSnapshot(domain) {
  if (!domain) return null;
  try {
    const tabs = await chrome.tabs.query({ url: `*://*.${domain}/*` });
    const tab = tabs && tabs[0];
    if (!tab) return null;
    const arr = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.body.innerText });
    const text = arr && arr[0] && arr[0].result;
    return typeof text === 'string' ? text.slice(0, 6000) : null;
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 3: `makeEngine` 注入 `onPaused`**
  `orchEngine = ORCH.engine.makeEngine({...})` 的 deps 里，`onStepSettled: (...) => {...},` 后加：
```js
  // 后续刀：回填型 HITL pause → 请求大脑提议（fire-forget；非回填步 orchRequestFillSuggest 内部过滤）
  onPaused: (workflowId) => {
    orchRequestFillSuggest(workflowId).catch(e => console.debug('[orch] 回填提议请求忽略', e));
  },
```

- [ ] **Step 4: `WF_` handler 加 `WF_FILL_REFRESH` 分支**
  在 `if (msg.type === 'WF_RETRY') {...}` 后加：
```js
  if (msg.type === 'WF_FILL_REFRESH') {
    orchRequestFillSuggest((msg.data || {}).workflowId)
      .then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
```

- [ ] **Step 5: 静态校验 + Commit** — `node -e "new Function(require('fs').readFileSync('automation/bg-entry.js','utf8'))"`（仅语法解析，importScripts/chrome 运行时不执行）；通过后 commit。

---

## Task 7：全量回归 + 构建 + 真 brain 进程冒烟 + 收尾

- [ ] **Step 1: 全量纯逻辑回归**
  - `node --test tests/*.test.js`（预期 101 + 新增 engine onPaused 2 + overlay-view 3 = 106 pass）
  - `python3 -m pytest tests/ -q`（预期 70 + filler 7 + server 2 = 79 pass）
- [ ] **Step 2: 真 brain 进程 FILL_REQUEST 冒烟**
  起 `python3 -m brain`（MockModel），WS 连接发 `FILL_REQUEST` → 应收 `FILL_SUGGEST`（MockModel 产诊断式输出无 values → values 为空，**证明通道通**；真 values 需配 `BRAIN_LLM_*` 真模型，留 e2e）。
- [ ] **Step 3: build 确认装配链** — `python3 build/build_extension.py`（预期 8 features / automation=on / SW 含 automation-bg-entry）。
- [ ] **Step 4: 更新 roadmap** — `docs/superpowers/automation-monitor-roadmap.md` 的「后续刀」段标注「HITL 回填模型提议（通用通道）已实施」+ 链接本 spec/plan。
- [ ] **Step 5: Commit**

## Done Definition（验收 + 不变量复核）

- [ ] 三不变量成立：①product 只经 `orchHitlConfirm`（WF_HITL_CONFIRM）更新，suggestion 只写 hitl ②filler 模型挂/垃圾→空 values（红线测试覆盖）③改动只在 brain/+automation/，release 无 ws→onPaused 触发的 orchRequestFillSuggest 早返回。
- [ ] 通道端到端：FILL_REQUEST→filler→FILL_SUGGEST→hitl.suggestion→overlay 预填（单元 + 真进程冒烟证通道；真 values e2e gated）。
- [ ] 全量 node 106 / pytest 79 / build 健康。
- [ ] 真模型端到端（配 BRAIN_LLM_* + chrome）仍人工 gated，代码 turn-key。

## Commit message 约定

`<type>(<scope>): <summary>` + Why/What/Test，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。scope 用 `brain`/`automation`/`orchestrator`/`overlay`。

## 执行交接

实施用 **subagent-driven-development**（每任务 fresh subagent + 两段 review）或 **executing-plans**（本会话批量 + checkpoint）。Task 1-4 单元可测、适合 subagent；Task 5-6 chrome 绑定靠 e2e，review 重点放「不变量不破 + 不写 product」。
