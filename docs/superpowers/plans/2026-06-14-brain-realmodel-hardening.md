# Brain 接真实模型 + 健壮性加固 Implementation Plan

> **For agentic workers:** TDD 逐任务执行；步骤用 checkbox（`- [ ]`）跟踪。本 plan 由 2026-06-14 对抗性审计 workflow（4 透镜 / 12 缺口）去重后落定。

**Goal:** 让 brain 大脑接真实 OpenAI 兼容模型后 self-heal 真正生效（当前对真模型几乎永远 escalate），并加固传输/解析/并发健壮性——全程不破坏三条安全不变量。

**Architecture:** 改动全在 `brain/`（Python，零三方依赖，只用 stdlib）。JS 侧 ws-bridge 经审计判定已稳健、本次不动。核心是一个共享容错解析 helper + 传输层有界重试 + 诊断器可观测性 + server 并发不冻结。

**Tech Stack:** Python 3 stdlib（json / urllib / asyncio / logging / re）；pytest（`python3 -m pytest tests/`）。

---

## 三条不变量（GUARDRAILS — 任何任务不得破坏）

1. **不可逆永不重试**：`error.recoverable === false` → 永远 escalate。发生在调模型【之前】（diagnoser 红线 1），本次改动不触碰该路径。
2. **不确定 → 安全降级 escalate**：模型挂了 / 输出无法解析成合法决策 / 真垃圾 → 一律 escalate（转人工）。容错解析只放宽【合法决策的表面形态】（围栏/散文/大小写），绝不放宽【语义判定】。
3. **release ws 沉睡**：ws-client 在 release 绝不自动连。本次不动 JS，天然不涉及。

## 缺口 → 任务映射（审计去重后）

| 缺口 id | 严重度 | 任务 |
|---------|--------|------|
| json-codefence-wrapping + refusal-not-misread + action-case-normalization | HIGH | Task 1+2 |
| no-bounded-retry-on-transient-http | MED | Task 3 |
| http-response-content-shape | MED | Task 3 |
| blocking-urlopen-in-async-handler | MED | Task 4 |
| flat-escalate-reason / opaque-model-failure-cause（两透镜同一缺口，合一） | LOW | Task 2 |
| status-error-without-error-obj-silently-logged | LOW | Task 4 |

**诚实剔除（不做，审计标 worthDoing=false）**：宽松反序列化（单引号/尾逗号/Python 字面量——扩大「拒答被误读成决策」攻击面，顶撞不变量 2）、gzip/SSE 解码（假想代理行为，本项目不发 stream=true）、半开 TCP PONG 超时检测（dev 工具镀金，STEP_RESULT 丢失已安全降级到「停 error 转人工」）。

## File Structure

- **Create** `brain/jsonx.py` — `extract_decision(text) -> dict | None`：容错抽取模型决策 JSON。纯函数、零依赖、可单测。**唯一职责**=把真实模型的脏输出还原成 dict 或判定为不可解析（None）。
- **Modify** `brain/diagnoser.py` — `_ask_model` 改用 `extract_decision` + action 归一化 + except 透出 cause。
- **Modify** `brain/model.py` — `OpenAICompatModel.decide` 加有界瞬时重试 + 防御性响应取值。
- **Modify** `brain/server.py` — `_handle_step_result` 用 `asyncio.to_thread` 跑诊断 + send 包 try + status=error gate 收紧。
- **Create** `tests/test_brain_jsonx.py` — extract_decision 单测（含拒答/垃圾→None 红线）。
- **Modify** `tests/test_brain_diagnoser.py` / `tests/test_brain_model.py` / `tests/test_brain_server.py` — 补加固后的新行为用例。

---

## Task 1：`brain/jsonx.py` — 容错决策抽取（核心）

**Files:** Create `brain/jsonx.py`、Create `tests/test_brain_jsonx.py`

设计（最小、只剥表面形态、不放宽语义）：
1. 剥 ` ```json … ``` ` / ` ``` … ``` ` 代码围栏。
2. 若仍非纯 JSON，扫描抓【首个平衡花括号块】（深度计数 `{` `}`，跳过字符串内的括号 + 转义）。
3. 对抓到的子串 `json.loads`；成功且是 dict → 返回 dict；任何失败 → 返回 `None`。
4. **绝不**做单引号/尾逗号/`ast.literal_eval` 宽松反序列化（守不变量 2）。

- [ ] **Step 1: 写失败测试** `tests/test_brain_jsonx.py`

```python
# tests/test_brain_jsonx.py — extract_decision 容错抽取单测。
# 红线：合法决策的脏包装能还原；真垃圾/拒答 → None（上层据此 escalate，守不变量2）。
from brain.jsonx import extract_decision


def test_plain_json():
    assert extract_decision('{"action":"retry","reason":"x"}') == {"action": "retry", "reason": "x"}


def test_codefence_json():
    assert extract_decision('```json\n{"action":"escalate","reason":"y"}\n```') == {"action": "escalate", "reason": "y"}


def test_codefence_no_lang():
    assert extract_decision('```\n{"action":"retry","reason":"z"}\n```') == {"action": "retry", "reason": "z"}


def test_prose_prefix_suffix():
    assert extract_decision('根据分析，建议：{"action":"retry","reason":"渲染未就绪"} 以上。')["action"] == "retry"


def test_first_balanced_block_with_nested():
    # 嵌套对象不破坏平衡计数
    out = extract_decision('noise {"action":"retry","reason":"a","ctx":{"k":"}"}} tail')
    assert out["action"] == "retry"
    assert out["ctx"] == {"k": "}"}   # 字符串内的 } 不被当块结束


def test_refusal_text_returns_none():
    # 红线（不变量2）：纯拒答/散文无合法 JSON dict → None
    assert extract_decision("I cannot help with that.") is None
    assert extract_decision("作为AI助手我无法判断这个错误。") is None


def test_thinking_no_json_returns_none():
    assert extract_decision("让我想想……这个超时可能是网络问题，也可能是选择器失效。") is None


def test_garbage_returns_none():
    assert extract_decision("") is None
    assert extract_decision(None) is None
    assert extract_decision("{not json}") is None
    assert extract_decision("[1,2,3]") is None        # 非 dict（数组）→ None


def test_single_quotes_not_accepted():
    # 不做宽松反序列化：Python 风格单引号伪 JSON → None（守不变量2，不扩大攻击面）
    assert extract_decision("{'action':'retry'}") is None
```

- [ ] **Step 2: 跑测试确认失败** — `python3 -m pytest tests/test_brain_jsonx.py -q`，预期 ModuleNotFoundError（brain.jsonx 未建）。

- [ ] **Step 3: 写实现** `brain/jsonx.py`

```python
# brain/jsonx.py — 容错抽取模型决策 JSON（接真实模型用，spec Plan3 §3.2/§6）。
# 真实/本地/便宜模型常把决策 JSON 包在 ```围栏``` 或前后散文里；直接 json.loads 会失败。
# 本 helper 只剥【表面形态】（围栏 + 定位首个平衡花括号块），不放宽语义：
#   抓不到能 json.loads 成 dict 的块 → None（上层据此安全 escalate，守不变量2「真垃圾→转人工」）。
# 绝不做单引号/尾逗号/ast 宽松反序列化——那会把拒答/思考误读成决策（扩大攻击面）。
import json
import re

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def _first_balanced_object(text):
    """返回首个平衡花括号块子串（跳过字符串内括号 + 转义）；无则 None。"""
    start = text.find("{")
    while start != -1:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            c = text[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        return text[start:i + 1]
        start = text.find("{", start + 1)   # 本块不平衡，从下一个 { 再试
    return None


def extract_decision(text):
    """脏文本 → 决策 dict 或 None。只接受能 json.loads 成 dict 的内容。"""
    if not isinstance(text, str) or not text.strip():
        return None
    candidates = []
    m = _FENCE.search(text)
    if m:
        candidates.append(m.group(1).strip())   # 围栏内优先
    candidates.append(text.strip())             # 整串（可能本就是纯 JSON）
    block = _first_balanced_object(text)
    if block:
        candidates.append(block)                # 散文里抓平衡块
    for c in candidates:
        try:
            obj = json.loads(c)
        except (ValueError, TypeError):
            continue
        if isinstance(obj, dict):
            return obj
    return None
```

- [ ] **Step 4: 跑测试确认通过** — `python3 -m pytest tests/test_brain_jsonx.py -q`，预期全 pass。

- [ ] **Step 5: Commit** — `git add brain/jsonx.py tests/test_brain_jsonx.py && git commit`（message 见 Done 段约定）。

---

## Task 2：`diagnoser.py` 接入容错抽取 + action 归一化 + cause 透出

**Files:** Modify `brain/diagnoser.py:34-51`（`_ask_model`）、Modify `tests/test_brain_diagnoser.py`

- [ ] **Step 1: 写失败测试**（追加到 `tests/test_brain_diagnoser.py`）

```python
def test_read_codefenced_retry_now_parses():
    # 加固后：围栏包裹的合法 retry 决策能被诊断器解析（此前会 escalate）
    d = diagnose(_err(message="selector not found", code="NOT_FOUND"), {"retryCount": 0},
                 MockModel(canned='```json\n{"action":"retry","reason":"渲染抖动"}\n```'))
    assert d["action"] == "retry"
    assert d["reason"] == "渲染抖动"


def test_action_case_normalized():
    # 大小写/空白归一化：" Retry " → retry
    d = diagnose(_err(message="x"), {"retryCount": 0},
                 MockModel(canned='{"action":" Retry ","reason":"r"}'))
    assert d["action"] == "retry"


def test_refusal_still_escalates():
    # 不变量2 红线：拒答文本无合法 JSON → escalate
    d = diagnose(_err(message="x"), {"retryCount": 0},
                 MockModel(canned="I cannot help with that."))
    assert d["action"] == "escalate"


def test_model_exception_reason_carries_cause():
    # 可观测性：异常类型透进 reason（仍 escalate，行为不变）
    class BoomModel:
        def decide(self, messages, tools=None):
            raise RuntimeError("api down")
    d = diagnose(_err(), {"retryCount": 0}, BoomModel())
    assert d["action"] == "escalate"
    assert "RuntimeError" in d["reason"]
```

- [ ] **Step 2: 跑确认失败** — `python3 -m pytest tests/test_brain_diagnoser.py -q`，预期新 4 条 fail。

- [ ] **Step 3: 改 `_ask_model`**（保留 system/user 构造不变，只改解析段）

```python
import logging
from brain.jsonx import extract_decision

_log = logging.getLogger("brain.diagnoser")

# _ask_model 末段（messages 构造后）改为：
    try:
        raw = model.decide(messages)
    except Exception as e:
        cause = "{}: {}".format(type(e).__name__, str(e)[:200])
        _log.warning("诊断模型调用失败: %s", cause)
        return {"action": "escalate", "reason": "诊断不可用（{}），安全转人工".format(cause)}
    obj = extract_decision(raw)
    if obj is None:
        return {"action": "escalate", "reason": "模型输出无法解析为决策，安全转人工"}
    action = (obj.get("action") or "").strip().lower()
    if action not in ("retry", "escalate"):
        return {"action": "escalate", "reason": "模型返回非法 action，安全转人工"}
    return {"action": action, "reason": obj.get("reason") or ""}
```

- [ ] **Step 4: 跑确认通过** — `python3 -m pytest tests/test_brain_diagnoser.py tests/test_brain_model_agnostic.py -q`，预期全 pass（含旧用例不回归）。
- [ ] **Step 5: Commit**

---

## Task 3：`model.py` 有界瞬时重试 + 防御性响应取值

**Files:** Modify `brain/model.py:26-53`（`OpenAICompatModel`）、Modify `tests/test_brain_model.py`

纪律：瞬时类（429 / 500 / 502 / 503 / 504 / socket.timeout / ConnectionRefused）有界退避重试（默认 2 次）；**超界 RE-RAISE 原异常**（绝不吞成假成功，守不变量 2）；鉴权/4xx（401/403/400/404/422）立即抛。响应取值防御化：形态不对 → `ValueError`（带片段），不返回 None。

- [ ] **Step 1: 写失败测试**（追加 `tests/test_brain_model.py`）

```python
import urllib.error
import socket


def test_retries_transient_then_succeeds():
    m = OpenAICompatModel(base_url="http://h/v1", api_key="k", model="m", max_retries=2, backoff_base=0)
    calls = {"n": 0}
    def flaky(req, timeout=None):
        calls["n"] += 1
        if calls["n"] < 2:
            raise urllib.error.HTTPError("u", 503, "busy", {}, None)
        return _FakeResp({"choices": [{"message": {"content": "ok"}}]})
    with mock.patch("urllib.request.urlopen", flaky):
        assert m.decide([{"role": "user", "content": "x"}]) == "ok"
    assert calls["n"] == 2


def test_auth_error_not_retried():
    m = OpenAICompatModel(base_url="http://h/v1", api_key="k", model="m", max_retries=3, backoff_base=0)
    calls = {"n": 0}
    def auth_fail(req, timeout=None):
        calls["n"] += 1
        raise urllib.error.HTTPError("u", 401, "unauthorized", {}, None)
    with mock.patch("urllib.request.urlopen", auth_fail):
        try:
            m.decide([{"role": "user", "content": "x"}]); assert False
        except urllib.error.HTTPError:
            pass
    assert calls["n"] == 1   # 401 不重试


def test_transient_exhausted_reraises():
    m = OpenAICompatModel(base_url="http://h/v1", api_key="k", model="m", max_retries=2, backoff_base=0)
    def always_503(req, timeout=None):
        raise urllib.error.HTTPError("u", 503, "busy", {}, None)
    with mock.patch("urllib.request.urlopen", always_503):
        try:
            m.decide([{"role": "user", "content": "x"}]); assert False, "超界必须抛原异常，不得吞"
        except urllib.error.HTTPError as e:
            assert e.code == 503


def test_empty_choices_raises_valueerror():
    m = OpenAICompatModel(base_url="http://h/v1", api_key="k", model="m")
    with mock.patch("urllib.request.urlopen", lambda req, timeout=None: _FakeResp({"choices": []})):
        try:
            m.decide([{"role": "user", "content": "x"}]); assert False
        except ValueError:
            pass


def test_content_null_raises_valueerror():
    m = OpenAICompatModel(base_url="http://h/v1", api_key="k", model="m")
    with mock.patch("urllib.request.urlopen",
                    lambda req, timeout=None: _FakeResp({"choices": [{"message": {"content": None}}]})):
        try:
            m.decide([{"role": "user", "content": "x"}]); assert False
        except ValueError:
            pass
```

- [ ] **Step 2: 跑确认失败** — `python3 -m pytest tests/test_brain_model.py -q`。

- [ ] **Step 3: 改 `OpenAICompatModel`**

```python
import socket
import time
import urllib.error

_TRANSIENT_HTTP = {429, 500, 502, 503, 504}


class OpenAICompatModel:
    def __init__(self, base_url, api_key, model, timeout=30, max_retries=2, backoff_base=0.5):
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._key = api_key
        self._model = model
        self._timeout = timeout
        self._max_retries = max_retries
        self._backoff_base = backoff_base

    def _is_transient(self, e):
        if isinstance(e, urllib.error.HTTPError):
            return e.code in _TRANSIENT_HTTP
        if isinstance(e, socket.timeout):
            return True
        if isinstance(e, urllib.error.URLError):
            return isinstance(e.reason, (ConnectionRefusedError, socket.timeout))
        return False

    def _post(self):
        ...  # 原 urlopen + 防御取值，见下

    def decide(self, messages, tools=None):
        body = json.dumps({"model": self._model, "messages": messages, "temperature": 0},
                          ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self._url, data=body, headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + self._key})
        attempt = 0
        while True:
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                    obj = json.loads(resp.read().decode("utf-8"))
                break
            except Exception as e:
                if self._is_transient(e) and attempt < self._max_retries:
                    if self._backoff_base:
                        time.sleep(self._backoff_base * (2 ** attempt))
                    attempt += 1
                    continue
                raise                      # 非瞬时 或 超界 → 抛原异常（守不变量2，上层 escalate）
        choices = obj.get("choices") or []
        content = (choices[0].get("message", {}) or {}).get("content") if choices else None
        if not isinstance(content, str):
            raise ValueError("unexpected response shape: " + str(obj)[:200])
        return content
```

- [ ] **Step 4: 跑确认通过** — `python3 -m pytest tests/test_brain_model.py -q`（含旧 `test_openai_builds_request_and_parses` / `test_openai_decide_propagates_http_error` 不回归）。
- [ ] **Step 5: Commit**

---

## Task 4：`server.py` 诊断离主循环 + send 容错 + status=error gate

**Files:** Modify `brain/server.py:46-65`、Modify `tests/test_brain_server.py`

- [ ] **Step 1: 写失败测试**（追加 `tests/test_brain_server.py`）

```python
def test_status_error_without_error_obj_still_diagnoses():
    # status=error 但 error 缺失 → 仍进诊断（escalate），不被当 benign log 静默吞
    server._dashboards.clear()
    server._model = MockModel()
    async def scenario():
        async with websockets.serve(server.handler, "localhost", 0) as s:
            port = s.sockets[0].getsockname()[1]
            async with websockets.connect("ws://localhost:{}".format(port)) as bg:
                await bg.send(encode("HELLO", {"role": "bg"}))
                await bg.send(encode("STEP_RESULT", {"workflowId": "w", "stepId": "ship", "status": "error"}))
                return decode(await asyncio.wait_for(bg.recv(), timeout=2))
    t, d = _run(scenario())
    assert t == "STATE_PATCH"
    assert d["action"] == "escalate"
```

- [ ] **Step 2: 跑确认失败** — `python3 -m pytest tests/test_brain_server.py -q`。

- [ ] **Step 3: 改 server.py**
  - `_handle_step_result`：门改 `if data.get("status") == "error":`，内部 `err = err or {"category": "unknown", "recoverable": True}`（unknown 非 read → diagnose 天然 escalate）。
  - 诊断调用改 `decision = await asyncio.to_thread(diagnose, err, ctx, _model)`（阻塞 urlopen 移出事件循环）。
  - STATE_PATCH 的 `await websocket.send(...)` 包 `try/except Exception`（连接中途断静默，对齐 `_broadcast` 容错）。
  - 顶部 `import asyncio`（已有）。

- [ ] **Step 4: 跑确认通过** — `python3 -m pytest tests/test_brain_server.py -q`（含旧 3 用例不回归）。
- [ ] **Step 5: Commit**

---

## Task 5：全量回归 + 真端点 turn-key 文档 + 构建

- [ ] **Step 1: 全量纯逻辑回归**
  - `node --test tests/*.test.js`（预期 101 pass，JS 未动应不变）
  - `python3 -m pytest tests/ -q`（预期 44 + 新增用例全 pass）
- [ ] **Step 2: 真 brain 进程冒烟**（MockModel）— 复跑活 socket 冒烟脚本，确认 PING/PONG + 诊断往返不回归。
- [ ] **Step 3: 接真实模型 turn-key 说明** — 更新 `docs/superpowers/2026-06-13-l3-chrome-e2e-checklist.md` 前置段（已有 `BRAIN_LLM_*` 三环境变量），补一句「加固后真模型脏输出（围栏/散文/大小写）可被解析，self-heal 实际生效」。真端点端到端跑仍需用户配 endpoint（同 e2e 人工 gated）。
- [ ] **Step 4: build 确认** — `python3 build/build_extension.py`（JS 未动，确认装配链不回归）。

## Done Definition（验收 + 不变量复核）

- [ ] 三条不变量全部成立：①不可逆永不重试（diagnoser 红线 1 未动）②真垃圾/拒答/模型挂 → escalate（jsonx None + except 兜底，新增红线测试覆盖）③release ws 沉睡（JS 未动）。
- [ ] self-heal 对真模型脏输出（围栏/散文/大小写）实际生效（Task 2 新测试证明）。
- [ ] 瞬时类传输故障有界重试、超界抛原异常不吞（Task 3 新测试证明）。
- [ ] 慢模型不冻结事件循环（Task 4 to_thread）。
- [ ] 失败 cause 可观测（透进 reason + logging）。
- [ ] 全量回归绿 + 真 brain 进程冒烟不回归。
- [ ] 真端点端到端验证仍人工 gated（同 chrome e2e），代码已 turn-key。

---

## 实施 + 对抗 review 结果（2026-06-14）

5 任务全 TDD 落地。实现后跑对抗性 review workflow（4 透镜红队），抓到并修掉 **1 个本次加固引入的 HIGH 回归 + 1 个 MED 方向不安全 + 1 个 LOW 契约不诚实**：

| review finding | 严重度 | 修复 |
|----------------|--------|------|
| 非字符串 action（`{"action":1}`/`["retry"]`/`true`）→ `.strip()` 抛 AttributeError → 杀 ws handler、丢决策（比加固前更脆弱，破不变量2） | HIGH | diagnoser 加 action 类型守卫（非 str 保持原值→落白名单 escalate）+ server `to_thread(diagnose)` 包 try 兜底 escalate（纵深防御） |
| `_first_balanced_object` 抓首块，无围栏多决策块（`Example {retry}. Decision: {escalate}`）选错块、真 escalate 被读成 retry | MED | jsonx 改 `_balanced_objects` 抓所有顶层块；干净结构（围栏/整串纯 JSON）优先，散文块**唯一才信、多个→歧义→None→escalate** |
| model.py `choices[0]` 非 dict → AttributeError 而非承诺的 ValueError | LOW | 逐层 isinstance 防御取值，一律 ValueError |

两透镜（invariant-verifier / retry-redteam）独立判 pass：三不变量整体 hold、重试无死循环/不吞异常/超界必抛。诚实剔除镀金（jsonx O(n²) 病态输入、宽松反序列化）。修复后红队原始攻击字符串全部复验通过，brain 测试 38→57、全量 Python 70 / JS 101·0 fail / 真进程冒烟不回归。

**接真实模型 turn-key**：`BRAIN_LLM_BASE_URL` / `BRAIN_LLM_API_KEY` / `BRAIN_LLM_MODEL` 三环境变量起 `python3 -m brain` 即接 OpenAI 兼容端点；加固后真模型脏输出（围栏/散文/大小写）能被解析、self-heal 实际生效。真端点端到端跑仍人工 gated（同 chrome e2e，需用户配 endpoint）。
