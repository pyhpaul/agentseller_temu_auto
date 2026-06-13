# Plan 3 第二刀：诊断器 + error hook + STATE_PATCH（self-heal 闭环）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给已通的 WS 管道（第一刀）加上首版唯一智能——出错时大脑诊断 self-heal：step 出错 → 报大脑 → 诊断器（两条红线 + 模型判断瞬时 vs 结构性）→ STATE_PATCH 回 bg → 重试 / 转人工。

**Architecture:** 大脑进程内**两层解耦**——编排框架（模型无关：诊断器 + tool registry 镜像 + WS server）+ LLM 后端（可插拔：`decide(messages)` 接口，`MockModel` 规则式 / `OpenAICompatModel` urllib 打 OpenAI 兼容端点）。bg `orchEngine` 加 `onStepSettled` hook（每步落地上报 STEP_RESULT，覆盖 throw）+ `applyDiagnosis`（落地 STATE_PATCH，红线兜底）。诊断决策经 STATE_PATCH 落地，**仍由 bg 写 storage**（守数据契约）。

**Tech Stack:** Python 3 + 标准库 `urllib`（零新依赖的 OpenAI 兼容适配器）+ `websockets`（第一刀已装）;现有 `engine.js`/`steps.js`（UMD）+ `service-worker.js`/`ws-client.js`;测试 `pytest` + `node --test`。

**契约基线**（实现前必读）:
- spec `docs/superpowers/specs/2026-06-10-plan3-llm-brain-design.md` §3（组件）/§4（数据流出错分支）/§5（STATE_PATCH）/§6（self-heal + 两条红线）/§7（系统错误）/§10（测试）
- 第一刀产物：`brain/protocol.py`（`encode`/`decode`）、`brain/server.py`（`handler`/`_dashboards`/`_broadcast_dashboards`/STEP_RESULT→log BRAIN_EVENT）、`tests/test_brain_{protocol,server}.py`
- `core/background/orchestrator/engine.js`：`makeEngine({read,queue,stepRunner,now})`→`{advance,recover}`；run-auto 落地 error 在 advance 内（`s.status='error'; w.status='error'`）；`buildHitl(step)`、`findWorkflow`、`MAX_LOOP`
- `core/background/orchestrator/steps.js`：`buildInitialWorkflow` 的 step 对象字段（加 `retryCount`）
- `core/background/service-worker.js`：`orchWsClient`（第一刀自启，L645 区）、`orchRealStepRunner`（L918，第一刀加了 STEP_RESULT 上报，本刀移走）、`orchEngine = makeEngine({...})`（L931）
- `core/background/ws-client.js`：`createWsClient({handlers:{<type>:fn(data,send)}})` 已支持入站 handler 路由（onmessage L58-60）；**不改**
- `StepError` 形状：`{category:'read'|'validate'|'business', code, message, recoverable:bool}`（engine.js 落地处可见）

**关键设计决策**（brainstorming 已对齐）:
1. **真实后端 = `urllib` 打 OpenAI-compatible `/chat/completions`**（零依赖、最大兼容）。第四刀验证「换模型」时加 LiteLLM 适配器证明可换。
2. **本刀单测全用 `MockModel`，不发真 API**；真 API 端到端留第四刀 / chrome e2e（用户配 key）。
3. **两条红线 brain + bg 双守门**：诊断器主守（`recoverable:false` / `retryCount>=2` / 非 read 类 → 强制 escalate），`applyDiagnosis` 防御兜底。

---

## File Structure

**新建（大脑）**:
- `brain/model.py` — 模型抽象层：`MockModel`（规则式 + canned）+ `OpenAICompatModel`（urllib）
- `brain/diagnoser.py` — 诊断器：`diagnose(step_error, context, model) → {action, reason}` + 两条红线 + 三分层

**新建（测试）**:
- `tests/test_brain_model.py` — `MockModel` 行为单测
- `tests/test_brain_diagnoser.py` — 诊断器决策 + 红线（用 `MockModel`）

**修改**:
- `brain/server.py` — STEP_RESULT 带 error → 诊断 → `diagnose` BRAIN_EVENT + STATE_PATCH 回 bg；模块级 `_model` 可注入
- `brain/__main__.py` — 按 env 注入真实 `OpenAICompatModel`（否则 `MockModel`）
- `tests/test_brain_server.py` — 加「STEP_RESULT(error) → STATE_PATCH + diagnose BRAIN_EVENT」集成测试
- `core/background/orchestrator/steps.js` — step 加 `retryCount: 0`
- `tests/orchestrator-steps.test.js` — 加 `retryCount` 断言
- `core/background/orchestrator/engine.js` — `onStepSettled` hook（注入，默认 noop）+ `applyDiagnosis`（红线兜底）+ `MAX_RETRY`
- `tests/orchestrator-engine.test.js` — `onStepSettled` + `applyDiagnosis`（retry/escalate/两红线）测试
- `core/background/service-worker.js` — `startWsClient` 加 STATE_PATCH handler + `makeEngine` 加 `onStepSettled` 上报 + `orchRealStepRunner` 删第一刀上报
- `docs/superpowers/2026-06-11-plan3-diagnoser-verification.md` — 诊断闭环 e2e 验证说明（新建）

**不改**:
- `core/background/ws-client.js`（handler 路由机制第一刀已就绪）
- `core/dashboard/`（`appendBrainEvent` 无 kind 校验，`diagnose`/`selfheal` 与 mock 同构直接渲染）

---

## Task 1: brain/model.py — 模型抽象层（model-agnostic）

**Files:**
- Create: `brain/model.py`
- Test: `tests/test_brain_model.py`

- [ ] **Step 1: 写失败测试**

创建 `tests/test_brain_model.py`:

```python
# tests/test_brain_model.py — 模型抽象层单测（MockModel 行为；OpenAICompatModel 真 API 留 e2e）。
from brain.model import MockModel


def test_mock_canned_overrides_rule():
    m = MockModel(canned='{"action":"retry","reason":"x"}')
    assert m.decide([{"role": "user", "content": "anything"}]) == '{"action":"retry","reason":"x"}'


def test_mock_rule_timeout_retry():
    m = MockModel()
    assert '"action":"retry"' in m.decide([{"role": "user", "content": "waitForEl timeout 10s"}])


def test_mock_rule_chinese_timeout_retry():
    m = MockModel()
    assert '"action":"retry"' in m.decide([{"role": "user", "content": "选择器等待超时"}])


def test_mock_rule_other_escalate():
    m = MockModel()
    assert '"action":"escalate"' in m.decide([{"role": "user", "content": "selector not found"}])


def test_mock_empty_messages_escalate():
    m = MockModel()
    assert '"action":"escalate"' in m.decide([])   # 无信息 → 安全默认
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python3 -m pytest tests/test_brain_model.py -v`
Expected: FAIL（`ModuleNotFoundError: No module named 'brain.model'`）

- [ ] **Step 3: 写实现**

创建 `brain/model.py`:

```python
# brain/model.py — 模型抽象层（model-agnostic，spec §3.2/§11）。
# 统一接口 decide(messages, tools=None) → str（模型回的原始文本，调用方自行解析）。
# 换模型只改本文件的适配器；诊断器 / server 不依赖具体模型。
import json
import urllib.request


class MockModel:
    """测试 / 离线 fallback 用的确定性模型。
    canned 给定 → decide 恒返回它；否则规则式（messages 末条含 timeout/超时 → retry，其余 → escalate）。
    规则式仅为单测确定性 + 演示，真智能在 OpenAICompatModel。
    """

    def __init__(self, canned=None):
        self._canned = canned

    def decide(self, messages, tools=None):
        if self._canned is not None:
            return self._canned
        last = (messages[-1].get("content", "") if messages else "").lower()
        if "timeout" in last or "超时" in last:
            return '{"action":"retry","reason":"超时类瞬时故障，重试"}'
        return '{"action":"escalate","reason":"非瞬时故障，转人工"}'


class OpenAICompatModel:
    """OpenAI-compatible /chat/completions 适配器（urllib，零三方依赖）。
    base_url 如 http://localhost:11434/v1（ollama）/ https://api.openai.com/v1 / 各家兼容端点；
    换模型只改 model 名 / 端点（model-agnostic）。真 API 走通留 e2e（用户配 key）。
    """

    def __init__(self, base_url, api_key, model, timeout=30):
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._key = api_key
        self._model = model
        self._timeout = timeout

    def decide(self, messages, tools=None):
        body = json.dumps(
            {"model": self._model, "messages": messages, "temperature": 0},
            ensure_ascii=False,
        ).encode("utf-8")
        req = urllib.request.Request(
            self._url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self._key,
            },
        )
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            obj = json.loads(resp.read().decode("utf-8"))
        return obj["choices"][0]["message"]["content"]
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python3 -m pytest tests/test_brain_model.py -v`
Expected: PASS（5 passed）

- [ ] **Step 5: Commit**

```bash
git add brain/model.py tests/test_brain_model.py
git commit -F - <<'EOF'
feat(plan3): brain 模型抽象层（model-agnostic：MockModel + OpenAICompatModel）

Why: Plan 3 第二刀诊断器需可插拔模型后端，换模型只改适配器（spec §3.2/§11）
What: brain/model.py decide(messages) 统一接口 + MockModel(规则式/canned 测试用) + OpenAICompatModel(urllib 打 OpenAI 兼容端点，零依赖) + 5 单测
Test: pytest tests/test_brain_model.py 5 passed（真 API 留 e2e）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: brain/diagnoser.py + registry.py — 诊断器（self-heal）+ tool registry 镜像

**Files:**
- Create: `brain/registry.py`（tool registry 镜像，spec §3 A.3）、`brain/diagnoser.py`
- Test: `tests/test_brain_diagnoser.py`

- [ ] **Step 1: 写失败测试**

创建 `tests/test_brain_diagnoser.py`:

```python
# tests/test_brain_diagnoser.py — 诊断器决策 + 两条红线 + 三分层（用 MockModel，不发真 API）。
from brain.diagnoser import diagnose, MAX_RETRY
from brain.model import MockModel


def _err(category="read", recoverable=True, message="waitForEl timeout", code="TIMEOUT"):
    return {"category": category, "code": code, "message": message, "recoverable": recoverable}


def test_irreversible_never_retry():
    # 红线 1：recoverable:false → escalate（优先于模型，即使模型说 retry）
    d = diagnose(_err(recoverable=False), {"retryCount": 0},
                 MockModel(canned='{"action":"retry","reason":"x"}'))
    assert d["action"] == "escalate"


def test_validate_category_escalate():
    # 三分层：validate → 转人工（不调模型）
    d = diagnose(_err(category="validate"), {"retryCount": 0},
                 MockModel(canned='{"action":"retry","reason":"x"}'))
    assert d["action"] == "escalate"


def test_business_category_escalate():
    d = diagnose(_err(category="business"), {"retryCount": 0},
                 MockModel(canned='{"action":"retry","reason":"x"}'))
    assert d["action"] == "escalate"


def test_retry_limit_escalate():
    # 红线 2：retryCount 达上限 → escalate（优先于模型）
    d = diagnose(_err(), {"retryCount": MAX_RETRY},
                 MockModel(canned='{"action":"retry","reason":"x"}'))
    assert d["action"] == "escalate"


def test_read_transient_retry():
    # read + 未达上限 + 模型判瞬时（规则式 timeout）→ retry
    d = diagnose(_err(message="timeout"), {"retryCount": 0}, MockModel())
    assert d["action"] == "retry"


def test_read_structural_escalate():
    # read + 模型判结构性（规则式：整条 user content 不含 timeout）→ escalate
    # 注意 code 也要避开 TIMEOUT —— MockModel 看整条 user content（含 code）小写后是否含 timeout
    d = diagnose(_err(message="selector not found", code="NOT_FOUND"), {"retryCount": 0}, MockModel())
    assert d["action"] == "escalate"


def test_model_exception_escalate():
    # spec §7：模型异常 → 安全转人工
    class BoomModel:
        def decide(self, messages, tools=None):
            raise RuntimeError("api down")

    d = diagnose(_err(), {"retryCount": 0}, BoomModel())
    assert d["action"] == "escalate"


def test_model_garbage_escalate():
    # 模型返回非 JSON / 非法 action → 安全转人工
    d = diagnose(_err(), {"retryCount": 0}, MockModel(canned="not json at all"))
    assert d["action"] == "escalate"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python3 -m pytest tests/test_brain_diagnoser.py -v`
Expected: FAIL（`ModuleNotFoundError`：brain.diagnoser / brain.registry 尚未创建）

- [ ] **Step 3: 写实现（registry 镜像 + 诊断器）**

创建 `brain/registry.py`:

```python
# brain/registry.py — tool registry 镜像（spec §3 A.3）。静态声明，与 bg adapter/steps.js 对齐。
# 首版供诊断时大脑理解「当前 step 在干什么」；动态同步（HELLO 同步 tool 清单）留后续（spec §12）。
STEP_TOOLS = {
    "publish":    {"feature": "check_and_publish",     "desc": "合规预检+发布到 Temu"},
    "gen_label":  {"feature": "auto_gen_label",        "desc": "货号+标签+合规+标签图"},
    "create_sku": {"feature": "create_purchase_order", "desc": "建店小秘 SKU"},
    "create_po":  {"feature": "create_purchase_order", "desc": "创建采购单"},
    "pack_label": {"feature": "packing_label",         "desc": "打印打包标签"},
    "ship":       {"feature": "auto_ship",             "desc": "确认发货"},
}


def describe_step(step_id):
    """step_id → 人类可读描述（诊断 prompt 用，让模型理解当前 step 语境）。"""
    t = STEP_TOOLS.get(step_id)
    return "{}（{}）".format(step_id, t["desc"]) if t else str(step_id)
```

创建 `brain/diagnoser.py`:

```python
# brain/diagnoser.py — 诊断器（self-heal 首版唯一智能，spec §6）。
# 输入 StepError + 上下文 → 两条安全红线 + 三分层 → 仅 read 类调模型判断瞬时 vs 结构性 → {action, reason}。
import json

from brain.registry import describe_step

MAX_RETRY = 2   # 重试上限红线（默认 2 次，spec §6）


def diagnose(step_error, context, model):
    """step_error: {category, code, message, recoverable}；context: {stepId, retryCount}；
    model: 实现 decide(messages) 的对象。返回 {"action": "retry"|"escalate", "reason": str}。"""
    err = step_error or {}
    ctx = context or {}

    # 红线 1：不可逆绝不重试（recoverable:false → 转人工，守 committing 语义）
    if err.get("recoverable") is False:
        return {"action": "escalate", "reason": "不可逆步骤出错，绝不重试，转人工"}

    # 三分层：仅 read 类可 self-heal；validate / business → 转人工（非技术自愈）
    category = err.get("category")
    if category != "read":
        return {"action": "escalate", "reason": "{} 类错误需人工处理".format(category)}

    # 红线 2：重试上限（达上限强制转人工，防死循环）
    if ctx.get("retryCount", 0) >= MAX_RETRY:
        return {"action": "escalate",
                "reason": "已重试 {} 次达上限，转人工".format(ctx.get("retryCount", 0))}

    # read 类未达上限 → 调模型判断「瞬时（重试）vs 结构性（转人工）」
    return _ask_model(err, ctx, model)


def _ask_model(err, ctx, model):
    messages = [
        {"role": "system", "content":
            "你是自动化流程诊断器。判断 read 类错误是瞬时（值得重试，如网络抖动 / 渲染未就绪 / 超时）"
            "还是结构性（重试无用需人工，如选择器失效 / 页面改版）。"
            "只回 JSON：{\"action\":\"retry\"|\"escalate\",\"reason\":\"简述\"}。"},
        {"role": "user", "content":
            "step={} category={} code={} message={}".format(
                describe_step(ctx.get("stepId")), err.get("category"), err.get("code"), err.get("message"))},
    ]
    try:
        obj = json.loads(model.decide(messages))
    except Exception:
        return {"action": "escalate", "reason": "诊断不可用（模型异常 / 解析失败），安全转人工"}
    action = obj.get("action") if isinstance(obj, dict) else None
    if action not in ("retry", "escalate"):
        return {"action": "escalate", "reason": "模型返回非法 action，安全转人工"}
    return {"action": action, "reason": obj.get("reason") or ""}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python3 -m pytest tests/test_brain_diagnoser.py -v`
Expected: PASS（8 passed）

- [ ] **Step 5: Commit**

```bash
git add brain/registry.py brain/diagnoser.py tests/test_brain_diagnoser.py
git commit -F - <<'EOF'
feat(plan3): brain 诊断器（self-heal：两条红线 + 三分层 + 模型判断）+ tool registry 镜像

Why: Plan 3 第二刀首版唯一智能，read 类错误模型判瞬时 vs 结构性，其余转人工；registry 给诊断 step 语境（spec §3/§6）
What: brain/registry.py(静态 tool 镜像 describe_step)+ diagnoser.py diagnose() —— 红线1(recoverable:false 绝不重试)+三分层(仅 read 调模型)+红线2(retryCount>=2 强制转人工)+模型异常/非法回退 escalate；8 单测覆盖全路径
Test: pytest tests/test_brain_diagnoser.py 8 passed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: brain/server.py 集成诊断 + __main__ env 注入

**Files:**
- Modify: `brain/server.py`、`brain/__main__.py`
- Test: `tests/test_brain_server.py`

- [ ] **Step 1: 写失败测试**

在 `tests/test_brain_server.py` 顶部 import 段加 `MockModel`：

把
```python
from brain.protocol import encode, decode
from brain import server
```
改成
```python
from brain.protocol import encode, decode
from brain import server
from brain.model import MockModel
```

在文件末尾追加集成测试：

```python
def test_step_result_error_triggers_diagnose_and_state_patch():
    server._dashboards.clear()
    server._model = MockModel()   # 规则式（timeout→retry）

    async def scenario():
        async with websockets.serve(server.handler, "localhost", 0) as s:
            port = s.sockets[0].getsockname()[1]
            async with websockets.connect("ws://localhost:{}".format(port)) as dash:
                await dash.send(encode("HELLO", {"role": "dash"}))
                await asyncio.sleep(0.05)
                async with websockets.connect("ws://localhost:{}".format(port)) as bg:
                    await bg.send(encode("HELLO", {"role": "bg"}))
                    await bg.send(encode("STEP_RESULT", {
                        "workflowId": "w1", "stepId": "gen_label", "status": "error",
                        "retryCount": 0,
                        "error": {"category": "read", "code": "TIMEOUT",
                                  "message": "waitForEl timeout", "recoverable": True},
                    }))
                    patch = decode(await asyncio.wait_for(bg.recv(), timeout=2))   # bg 收 STATE_PATCH
                    ev = decode(await asyncio.wait_for(dash.recv(), timeout=2))    # dash 收 diagnose
                    return patch, ev

    (pt, pd), (et, ed) = _run(scenario())
    assert pt == "STATE_PATCH"
    assert pd["workflowId"] == "w1"
    assert pd["stepId"] == "gen_label"
    assert pd["action"] == "retry"        # read + timeout + retryCount0 → retry
    assert et == "BRAIN_EVENT"
    assert ed["kind"] == "diagnose"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python3 -m pytest tests/test_brain_server.py -v`
Expected: 新 case FAIL（现 STEP_RESULT 走 log 分支不发 STATE_PATCH → `bg.recv` 超时 / `AttributeError: module 'brain.server' has no attribute '_model'`）；原 2 case 仍 PASS。

- [ ] **Step 3a: server.py 加 imports + 模块级 _model**

把 `brain/server.py` 顶部
```python
import asyncio
import time
import websockets
from brain.protocol import encode, decode
```
改成
```python
import asyncio
import time
import websockets
from brain.protocol import encode, decode
from brain.diagnoser import diagnose
from brain.model import MockModel
```

把
```python
# dashboard 连接集合（broadcast BRAIN_EVENT 用）。模块级：第一刀单进程单 batch，够用。
_dashboards = set()
```
改成
```python
# dashboard 连接集合（broadcast BRAIN_EVENT 用）。模块级：第一刀单进程单 batch，够用。
_dashboards = set()

# 诊断用模型（model-agnostic）。默认 MockModel；真实部署由 __main__ 按 env 注入 OpenAICompatModel。
_model = MockModel()
```

- [ ] **Step 3b: server.py STEP_RESULT 改调诊断 + 新增 _handle_step_result**

把 handler 里
```python
            elif mtype == "STEP_RESULT":
                # 第一刀不诊断：只回一条 log BRAIN_EVENT broadcast 给 dashboard。
                # data 对齐 mock-data.js 的 MOCK_BRAIN_EVENTS 元素：{workflowId,stepId,kind,text,ts}
                text = "step {} → {}".format(data.get("stepId"), data.get("status"))
                await _broadcast_dashboards(encode("BRAIN_EVENT", {
                    "workflowId": data.get("workflowId"),
                    "stepId": data.get("stepId"),
                    "kind": "log",
                    "text": text,
                    "ts": int(time.time() * 1000),
                }))
            # 其余类型（STATE_PATCH 等）第一刀忽略
```
改成
```python
            elif mtype == "STEP_RESULT":
                await _handle_step_result(websocket, data)
            # 其余类型第一刀忽略
```

在 `_broadcast_dashboards` 函数**之前**新增：
```python
def _brain_event(data, kind, text):
    """构造 BRAIN_EVENT（对齐 mock-data.js MOCK_BRAIN_EVENTS：{workflowId,stepId,kind,text,ts}）。"""
    return encode("BRAIN_EVENT", {
        "workflowId": data.get("workflowId"),
        "stepId": data.get("stepId"),
        "kind": kind,
        "text": text,
        "ts": int(time.time() * 1000),
    })


async def _handle_step_result(websocket, data):
    """STEP_RESULT 路由：出错 → 诊断 self-heal（diagnose BRAIN_EVENT + STATE_PATCH 回 bg）；正常 → log。"""
    err = data.get("error")
    if data.get("status") == "error" and err:
        ctx = {"stepId": data.get("stepId"), "retryCount": data.get("retryCount", 0)}
        decision = diagnose(err, ctx, _model)
        # diagnose 类 BRAIN_EVENT 给 dashboard 看推理
        await _broadcast_dashboards(_brain_event(
            data, "diagnose", "{}：{}".format(decision["action"], decision["reason"])))
        # STATE_PATCH 回 bg 落地决策（仍由 bg 写 storage，守数据契约 spec §5）
        await websocket.send(encode("STATE_PATCH", {
            "workflowId": data.get("workflowId"),
            "stepId": data.get("stepId"),
            "action": decision["action"],
            "reason": decision["reason"],
        }))
    else:
        await _broadcast_dashboards(_brain_event(
            data, "log", "step {} → {}".format(data.get("stepId"), data.get("status"))))
```

- [ ] **Step 3c: __main__.py 按 env 注入真实模型**

把 `brain/__main__.py`
```python
# brain/__main__.py — `python -m brain` 启动 WS server。
import asyncio
from brain.server import serve

if __name__ == "__main__":
    print("brain WS server starting on ws://localhost:8787 ...")
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        print("\nbrain WS server stopped.")
```
改成
```python
# brain/__main__.py — `python -m brain` 启动 WS server。
# 配 BRAIN_LLM_BASE_URL 用真实 OpenAI 兼容模型；否则 MockModel（规则式，离线可跑）。
import asyncio
import os
from brain import server
from brain.model import OpenAICompatModel
from brain.server import serve

if __name__ == "__main__":
    base = os.environ.get("BRAIN_LLM_BASE_URL")
    if base:
        server._model = OpenAICompatModel(
            base,
            os.environ.get("BRAIN_LLM_API_KEY", ""),
            os.environ.get("BRAIN_LLM_MODEL", "gpt-4o-mini"),
        )
        print("brain: using OpenAICompatModel", os.environ.get("BRAIN_LLM_MODEL", "gpt-4o-mini"))
    else:
        print("brain: using MockModel (set BRAIN_LLM_BASE_URL for a real model)")
    print("brain WS server starting on ws://localhost:8787 ...")
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        print("\nbrain WS server stopped.")
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python3 -m pytest tests/test_brain_server.py -v`
Expected: PASS（3 passed：原 2 + 新 1）

- [ ] **Step 5: Commit**

```bash
git add brain/server.py brain/__main__.py tests/test_brain_server.py
git commit -F - <<'EOF'
feat(plan3): brain server 集成诊断（STEP_RESULT error → STATE_PATCH + diagnose BRAIN_EVENT）

Why: Plan 3 第二刀闭环大脑侧，出错 STEP_RESULT 经诊断器产出落地决策 + 推理流（spec §4/§6）
What: server.py STEP_RESULT 出错→diagnose→diagnose BRAIN_EVENT(给 dashboard)+STATE_PATCH(回 bg，守 storage 唯一写入)；模块级 _model 可注入；__main__ 按 BRAIN_LLM_* env 注入 OpenAICompatModel 否则 MockModel；+1 集成单测
Test: pytest tests/test_brain_server.py 3 passed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: bg steps.js retryCount + engine.js onStepSettled/applyDiagnosis（纯逻辑）

**Files:**
- Modify: `core/background/orchestrator/steps.js`、`core/background/orchestrator/engine.js`
- Test: `tests/orchestrator-steps.test.js`、`tests/orchestrator-engine.test.js`

- [ ] **Step 1: steps 加 retryCount 断言（先写测试）**

在 `tests/orchestrator-steps.test.js` 末尾追加：

```javascript
test('buildInitialWorkflow: step 带 retryCount=0（Plan 3 self-heal 重试上限）', () => {
  const wf = buildInitialWorkflow({ label: 'X' }, () => 'w1');
  assert.ok(wf.steps.every(s => s.retryCount === 0));
});
```

- [ ] **Step 2: 跑确认失败**

Run: `node --test tests/orchestrator-steps.test.js`
Expected: 新 case FAIL（`s.retryCount` 为 undefined ≠ 0）。

- [ ] **Step 3: steps.js 加 retryCount 字段**

`core/background/orchestrator/steps.js` 把
```javascript
        status: 'pending', startedAt: null, endedAt: null,
        result: null, brainBrief: '(确定性)', note: null, committing: false, error: null,
```
改成
```javascript
        status: 'pending', startedAt: null, endedAt: null,
        result: null, brainBrief: '(确定性)', note: null, committing: false, error: null, retryCount: 0,
```

- [ ] **Step 4: 跑确认通过**

Run: `node --test tests/orchestrator-steps.test.js`
Expected: 全 PASS（原 8 + 新 1）。

- [ ] **Step 5: engine 测试（setupEngine 加 onStepSettled + 6 新 case）**

`tests/orchestrator-engine.test.js` 把
```javascript
function setupEngine(skeleton, stepRunner) {
  const store = fakeStore(skeleton);
  const queue = makeMutationQueue(store.read, store.write);
  const engine = makeEngine({ read: store.read, queue, stepRunner, now: () => 1 });
  return { engine, store };
}
```
改成
```javascript
function setupEngine(skeleton, stepRunner, onStepSettled) {
  const store = fakeStore(skeleton);
  const queue = makeMutationQueue(store.read, store.write);
  const engine = makeEngine({ read: store.read, queue, stepRunner, now: () => 1, onStepSettled });
  return { engine, store };
}
```

在文件末尾追加：

```javascript
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
```

- [ ] **Step 6: 跑确认失败**

Run: `node --test tests/orchestrator-engine.test.js`
Expected: 新 6 case FAIL（`onStepSettled` 未调 / `engine.applyDiagnosis` 不是函数）；原 case 仍 PASS。

- [ ] **Step 7: engine.js 加 MAX_RETRY + onStepSettled + applyDiagnosis**

改动 1 —— `core/background/orchestrator/engine.js` 顶部常量，把
```javascript
  const MAX_LOOP = 100;   // advance 循环上限防御（13 步 + cursor 推进正常 < 30 轮）
```
改成
```javascript
  const MAX_LOOP = 100;   // advance 循环上限防御（13 步 + cursor 推进正常 < 30 轮）
  const MAX_RETRY = 2;    // self-heal 重试上限红线（spec §6；与 brain/diagnoser MAX_RETRY 对齐）
```

改动 2 —— makeEngine 取 deps，把
```javascript
  function makeEngine(deps) {
    const { read, queue, stepRunner } = deps;
    const now = deps.now || (() => null);
```
改成
```javascript
  function makeEngine(deps) {
    const { read, queue, stepRunner } = deps;
    const now = deps.now || (() => null);
    const onStepSettled = deps.onStepSettled || (() => {});   // Plan 3：每步落地后通知（上报 STEP_RESULT），默认 noop
```

改动 3 —— run-auto 落地后调 onStepSettled，把
```javascript
              w.updatedAt = now();
            });
            continue;
          }
          case 'pause-hitl': {
```
改成
```javascript
              w.updatedAt = now();
            });
            onStepSettled(workflowId, step, res);   // Plan 3：通知（上报 STEP_RESULT 带 error+retryCount）；含 throw（res 已被 catch 包成 error）
            continue;
          }
          case 'pause-hitl': {
```

改动 4 —— 加 applyDiagnosis 并导出，把
```javascript
    return { advance, recover };
  }
```
改成
```javascript
    // Plan 3：应用大脑诊断决策（STATE_PATCH）。红线兜底（防大脑发错）后 retry / escalate。spec §6。
    async function applyDiagnosis(workflowId, patch) {
      const wf = findWorkflow(await read(), workflowId);
      if (!wf) return;
      const step = wf.steps[wf.cursor];
      if (!step || step.id !== patch.stepId) return;   // 只对当前 cursor step 生效
      let action = patch.action;
      const err = step.error || {};
      // 红线兜底：不可逆 / 超上限 强制 escalate（即使大脑说 retry）
      if (action === 'retry' && (err.recoverable === false || (step.retryCount || 0) >= MAX_RETRY)) {
        action = 'escalate';
      }
      if (action === 'retry') {
        await mutateWorkflow(workflowId, w => {
          const s = w.steps[w.cursor];
          s.status = 'pending'; s.error = null; s.committing = false;
          s.retryCount = (s.retryCount || 0) + 1;
          w.status = 'running'; w.updatedAt = now();
        });
        await advance(workflowId);
      } else {
        await mutateWorkflow(workflowId, w => {
          const s = w.steps[w.cursor];
          s.status = 'paused'; w.status = 'paused';
          w.hitl = buildHitl(s);
          w.hitl.reviewedBrief = (patch.reason || '') + '（大脑转人工）';
          w.updatedAt = now();
        });
      }
    }

    return { advance, recover, applyDiagnosis };
  }
```

- [ ] **Step 8: 跑确认通过**

Run: `node --test tests/orchestrator-engine.test.js tests/orchestrator-steps.test.js`
Expected: 全 PASS（engine 原 12 + 新 6；steps 原 8 + 新 1）。

- [ ] **Step 9: Commit**

```bash
git add core/background/orchestrator/steps.js core/background/orchestrator/engine.js tests/orchestrator-steps.test.js tests/orchestrator-engine.test.js
git commit -F - <<'EOF'
feat(plan3): bg engine onStepSettled hook + applyDiagnosis + step retryCount

Why: Plan 3 第二刀闭环 bg 侧，每步上报 + 落地大脑诊断决策（重试/转人工），守红线（spec §6）
What: steps.js step 加 retryCount:0；engine.js 加 onStepSettled(注入式默认 noop，每步落地通知含 throw 覆盖第一刀缺口)+applyDiagnosis(retry 重置 pending+retryCount+1+续跑 / escalate 转 paused HITL；红线兜底:recoverable:false 或 retryCount>=2 的 retry 强制 escalate)+MAX_RETRY；+7 单测
Test: node --test orchestrator-engine+steps 全过（engine 18 + steps 9）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: bg service-worker.js 接线（STATE_PATCH handler + onStepSettled 上报）

**Files:**
- Modify: `core/background/service-worker.js`

> **测试说明**：本 task 是 SW + WebSocket 副作用，无纯逻辑单测点（STEP_RESULT 封装走已测 `encode`；`applyDiagnosis`/`onStepSettled` 决策逻辑已在 Task 4 engine 单测覆盖）。验证靠 `node --check` 语法 + dev build 不回归 + chrome e2e（Task 6 文档，配合大脑一起验）。

- [ ] **Step 1: startWsClient 加 STATE_PATCH handler**

把第一刀的
```javascript
const orchWsClient = self.__AS_WS__.startWsClient({
  onStatus: s => console.log('[orch-ws]', s),
});
```
改成
```javascript
const orchWsClient = self.__AS_WS__.startWsClient({
  onStatus: s => console.log('[orch-ws]', s),
  handlers: {
    // 大脑诊断决策落地（spec §5/§6）：仍由 bg 写 storage；applyDiagnosis 含红线兜底。
    // orchEngine 在下方定义——此为运行时回调（收到消息才执行），届时 orchEngine 已初始化，闭包延迟引用安全。
    STATE_PATCH: (data) => {
      orchEngine.applyDiagnosis(data.workflowId, data)
        .catch(e => console.warn('[orch-ws] applyDiagnosis 失败', e));
    },
  },
});
```

- [ ] **Step 2: orchRealStepRunner 删第一刀上报（移到 engine hook）**

把
```javascript
// 真实 stepRunner：dispatch 到 adapter；未接入 step.id 回落 stub（13 步骨架仍端到端可跑）。
// Plan 3 第一刀：step 执行后向大脑上报 STEP_RESULT（fire-forget；大脑离线则 send 返回 false、try 兜底）。
async function orchRealStepRunner(step, wf) {
  const adapter = ORCH_ADAPTERS[step.id];
  const res = adapter ? await adapter(step, wf) : await orchStubStepRunner(step);
  try {
    if (orchWsClient) orchWsClient.send('STEP_RESULT', {
      workflowId: wf.id, stepId: step.id,
      status: (res && res.status) || null,
      error: (res && res.error) || null,
    });
  } catch (e) { console.debug('[orch-ws] STEP_RESULT 发送忽略', e); }
  return res;
}
```
改回（删上报；上报移到 engine onStepSettled，覆盖 throw + 带 retryCount）
```javascript
// 真实 stepRunner：dispatch 到 adapter；未接入 step.id 回落 stub（13 步骨架仍端到端可跑）。
// STEP_RESULT 上报移到 engine onStepSettled（覆盖 throw + 带 retryCount，Plan 3 第二刀）。
async function orchRealStepRunner(step, wf) {
  const adapter = ORCH_ADAPTERS[step.id];
  return adapter ? adapter(step, wf) : orchStubStepRunner(step);
}
```

- [ ] **Step 3: makeEngine 加 onStepSettled 上报**

把
```javascript
const orchEngine = ORCH.engine.makeEngine({
  read: orchRead, queue: orchQueue, stepRunner: orchRealStepRunner, now: () => Date.now(),
});
```
改成
```javascript
const orchEngine = ORCH.engine.makeEngine({
  read: orchRead, queue: orchQueue, stepRunner: orchRealStepRunner, now: () => Date.now(),
  // Plan 3 第二刀：每步落地后上报 STEP_RESULT（带 retryCount，含 throw 包装的 error）。fire-forget。
  onStepSettled: (workflowId, step, res) => {
    try {
      if (orchWsClient) orchWsClient.send('STEP_RESULT', {
        workflowId, stepId: step.id,
        status: (res && res.status) || null,
        error: (res && res.error) || null,
        retryCount: step.retryCount || 0,
      });
    } catch (e) { console.debug('[orch-ws] STEP_RESULT 发送忽略', e); }
  },
});
```

- [ ] **Step 4: 语法检查**

Run: `node --check core/background/service-worker.js`
Expected: 无输出（exit 0）。

- [ ] **Step 5: dev build 不回归**

Run: `python3 build/build_extension.py`
Expected: 构建成功，8 features / 14 content scripts（与基线一致），无报错。

- [ ] **Step 6: Commit**

```bash
git add core/background/service-worker.js
git commit -F - <<'EOF'
feat(plan3): bg service-worker 接线诊断闭环（STATE_PATCH handler + onStepSettled 上报）

Why: Plan 3 第二刀打通 bg 端，收大脑 STATE_PATCH 落地 + 每步上报覆盖 throw（spec §4/§5/§6）
What: startWsClient 加 STATE_PATCH handler→orchEngine.applyDiagnosis；makeEngine 加 onStepSettled 上报 STEP_RESULT(带 retryCount)；orchRealStepRunner 删第一刀临时上报(移到 engine hook 覆盖 throw)
Test: node --check 通过 + dev build 不回归（8 features/14 cs）；诊断闭环 chrome e2e 留 Task 6（配合大脑一起验）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: 全量回归 + 诊断闭环 e2e 文档

**Files:**
- Create: `docs/superpowers/2026-06-11-plan3-diagnoser-verification.md`
- Run: 全量测试 + server 冒烟

- [ ] **Step 1: 全量 JS 回归**

Run: `node --test tests/*.test.js`
Expected: 全过（原 64 + Task 4 加 engine 6 + steps 1 = **71**，0 fail）。⚠ 不要 `node --test tests/`（整目录会把 pytest .py 当 JS 解析失败）。

- [ ] **Step 2: 全量 Python 回归**

Run: `python3 -m pytest tests/`
Expected: 全过（第一刀 29 + Task 1 model 5 + Task 2 diagnoser 8 + Task 3 server 1 = **43**）。

- [ ] **Step 3: server 启动冒烟（默认 MockModel）**

Run: `timeout -s INT 2 python3 -m brain`
Expected: 打印 `brain: using MockModel (set BRAIN_LLM_BASE_URL for a real model)` + `brain WS server starting ...` → `stopped.`，无报错。

- [ ] **Step 4: 写诊断闭环 e2e 验证文档**

创建 `docs/superpowers/2026-06-11-plan3-diagnoser-verification.md`:

```markdown
# Plan 3 第二刀 诊断器 self-heal 闭环 — 验证说明

> 配套 plan `docs/superpowers/plans/2026-06-11-plan3-diagnoser-selfheal.md`、spec §6。
> 本刀 = 出错诊断 self-heal 闭环：step error → 报大脑 → 诊断（红线 + 模型）→ STATE_PATCH → 重试 / 转人工。

## 一、自动化验证（已跑，可复现）

| 项 | 命令 | 结果 |
|----|------|------|
| 模型抽象层 | `python3 -m pytest tests/test_brain_model.py -v` | 5 passed |
| 诊断器决策 + 两红线 | `python3 -m pytest tests/test_brain_diagnoser.py -v` | 8 passed |
| server 集成（error→STATE_PATCH+diagnose）| `python3 -m pytest tests/test_brain_server.py -v` | 3 passed |
| bg engine onStepSettled/applyDiagnosis | `node --test tests/orchestrator-engine.test.js` | 18 passed |
| 全量 Python | `python3 -m pytest tests/` | 43 passed |
| 全量 JS | `node --test tests/*.test.js` | 71 pass / 0 fail |
| bg SW 语法 | `node --check core/background/service-worker.js` | exit 0 |
| dev build | `python3 build/build_extension.py` | 8 features / 14 cs |

> ⚠ 真实模型（OpenAICompatModel）端到端不在自动化里——单测全用 MockModel；真 API 留第四刀 / chrome e2e（用户配 `BRAIN_LLM_BASE_URL`/`BRAIN_LLM_API_KEY`/`BRAIN_LLM_MODEL`）。

## 二、chrome 诊断闭环 e2e（留「大脑一起验」，本刀不强跑）

前置：`python3 -m brain`（MockModel 即可演示规则式 self-heal）；`python3 build/build_extension.py`；reload 扩展。

1. **起大脑 + bg 连上**：SW console 见 `[orch-ws] live`；Hub「打开监控」→ dashboard 灯 live。
2. **造一个 read 类瞬时错误**：SW console 手搭一条 workflow，让某 auto step 返回 `{status:'error',error:{category:'read',code:'TIMEOUT',message:'timeout',recoverable:true}}`（或临时改 adapter 抛超时）。
3. **看 self-heal**：dashboard 大脑流应出现 `diagnose` 类 BRAIN_EVENT（`retry：超时类瞬时故障...`）；storage 里该 step `retryCount` +1、status 回 `pending`→`running`（自动重试）。
4. **看红线—结构性转人工**：造 `message:'selector not found'` 的 read error → dashboard `diagnose`（`escalate`）；step 转 `paused`、wf `paused`、overlay 弹 HITL（`reviewedBrief` 含「大脑转人工」）。
5. **看红线—不可逆不重试**：不可逆步（`recoverable:false`）出错 → 即便大脑说 retry 也强制 escalate（applyDiagnosis 兜底）。
6. **真实模型**：配 `BRAIN_LLM_*` env 重起大脑 → 同样流程，诊断由真模型判断（验 model-agnostic 留第四刀换适配器）。

## 三、本刀边界 / 下一刀

本刀做 self-heal 诊断闭环（read 智能重试 / 其余转人工 / 两红线）。**不含**：HITL 回填的模型决策（仍人工）、不可逆复核、可偏离、`WF_START` 启动入口（第三刀）。

- **下一刀（第三刀）**：overlay「开始流水线」按钮解 `WF_START` 启动入口缺口（spec §8）。
- **发版隔离待办仍在**（spec §12）：bg ws-client 自启 + STATE_PATCH handler 在 release 应隔离，Plan 3 合 main 前统一处理。
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/2026-06-11-plan3-diagnoser-verification.md
git commit -F - <<'EOF'
docs(plan3): 第二刀诊断器 self-heal 闭环验证说明 + 全量回归

Why: Plan 3 第二刀收尾，记录自动化验证结果 + chrome 诊断闭环 e2e 流程
What: 新建 plan3-diagnoser-verification.md（自动化结果表 + read 重试/结构性转人工/不可逆不重试三路径 chrome 冒烟 + 真实模型 env）
Test: node --test tests/*.test.js 71 pass + pytest tests/ 43 passed + server 冒烟 OK

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## 实现顺序与验收

六个 Task 串行（Task 1→6），每 Task 独立 commit、可独立验：
- **Task 1-3**（model / diagnoser / server 集成）：纯 Python，pytest 全自动验，无 chrome 依赖。诊断闭环的「大脑侧」完整。
- **Task 4**（bg steps/engine 纯逻辑）：node --test 全自动验，覆盖 onStepSettled + applyDiagnosis + 两红线兜底，无 chrome 依赖。
- **Task 5**（bg service-worker 接线）：SW 副作用，node --check + dev build 验，真实连接留 e2e。
- **Task 6**（回归 + 文档）：全量 JS+Python 回归 + server 冒烟，chrome 诊断闭环 e2e 留「大脑一起验」。

**本刀完成 = self-heal 诊断闭环就位**：step 出错 → 报大脑 → 诊断器（两红线 + 模型判瞬时/结构性）→ STATE_PATCH → bg 重试 / 转人工，全程 dashboard `diagnose` 流可见，model-agnostic（换模型只改 model.py 适配器）。**下一刀（第三刀）**：overlay `WF_START` 启动入口（spec §8）。

**安全红线自查（合 main / 真实启用前必过）**：
- 不可逆步骤（`recoverable:false`）**绝不**自动重试——诊断器主守 + applyDiagnosis 兜底双重保证（Task 2 + Task 4 单测覆盖）。
- 重试上限 `MAX_RETRY=2`——brain/diagnoser 与 bg/engine 两处常量对齐；超限强制转人工。
- 大脑离线 / 模型 API 失败 → 退化为「error 停 + 人工 HITL」（即 Plan 2 现状，spec §7）。

