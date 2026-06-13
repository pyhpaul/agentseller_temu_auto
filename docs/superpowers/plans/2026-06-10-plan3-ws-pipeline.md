# Plan 3 第一刀：WS 端到端管道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起「大脑进程 ↔ bg ↔ dashboard」的 WebSocket 管道：大脑进程（Python）起 WS server，bg ws-client 自启上报每步结果，dashboard 收大脑流并亮 live 灯。

**Architecture:** 大脑进程用 Python `websockets` 库起 server（localhost:8787），按 `HELLO` 的 role 区分 bg / dashboard 连接。bg（已有 `ws-client.js`）改「不自启」为自启，连上后发 `HELLO`、每步经 `orchRealStepRunner` 包装上报 `STEP_RESULT`。大脑收 `STEP_RESULT` 后**不诊断**（诊断留第二刀），只回一条 `log` 类 `BRAIN_EVENT` 并 broadcast 给 dashboard。dashboard（已有 `ws-source.js`）连上即亮 live 灯、渲染大脑流。本刀只做**单向上报 + broadcast 的管道连通**，不碰模型 / 诊断 / error hook / 启动入口。

**Tech Stack:** Python 3 + `websockets` 库（server）;现有 `ws-client.js`（JS UMD，client）+ `ws-source.js`（ESM，dashboard client）;测试 `pytest`（python）+ `node --test`（js 纯逻辑）。

**契约基线**（实现前必读）:
- spec `docs/superpowers/specs/2026-06-10-plan3-llm-brain-design.md`（§2 拓扑 / §4 数据流 / §5 协议子集）
- `core/background/ws-client.js`:`createWsClient({url,handlers,onStatus})→{connect,send,close}`、`startWsClient(opts)`、`encode(type,data)=JSON.stringify({type,data:data||{}})`、`nextReconnectDelay`、`WS_URL='ws://localhost:8787'`、`PING_INTERVAL_MS=25000`;UMD 挂 `self.__AS_WS__`
- `core/dashboard/state/ws-source.js`:`startWsSource(store)` 已连 `ws://localhost:8787`、`onopen→setWsStatus('live')+HELLO`、`onmessage→BRAIN_EVENT/HITL_DETAIL`、`onclose→fallback(mock)`
- `core/background/service-worker.js`:L643 `importScripts('ws-client.js')`（不自启）;L912-915 `orchRealStepRunner(step,wf)`;L917-919 `makeEngine({read,queue,stepRunner,now})`
- `tests/ws-client.test.js`:`node --test` 风格(nextReconnectDelay/encode)

---

## File Structure

**新建（大脑进程）**:
- `brain/__init__.py` — package 标记（空文件，供 pytest `from brain.x import`）
- `brain/protocol.py` — WS 消息编解码（`encode` / `decode`，对齐 js `ws-client.js` 的 encode 格式）
- `brain/server.py` — WS server：连接注册（按 role）+ 消息路由（HELLO/PING→PONG/STEP_RESULT→BRAIN_EVENT broadcast）
- `brain/__main__.py` — 启动入口（`python -m brain` 起 server）
- `brain/requirements.txt` — `websockets`

**新建（测试）**:
- `tests/test_brain_protocol.py` — protocol 编解码单测（pytest）
- `tests/test_brain_server.py` — server 集成单测（python client ↔ server 握手 / PING / STEP_RESULT→BRAIN_EVENT）

**修改**:
- `core/background/service-worker.js` — ws-client 自启 + `orchRealStepRunner` 包装上报 `STEP_RESULT`
- `core/dashboard/state/ws-source.js` — 验证连真实大脑（架子已具备，微调注释 / 确认灯 live；无逻辑大改）
- `tests/ws-client.test.js` — 加 `decode`（消息解析）纯逻辑测试

**不改**:
- `core/background/ws-client.js` — 现有 `createWsClient`/`startWsClient` 第一刀直接用，不动

---

## Task 1: brain/protocol.py — WS 消息编解码

**Files:**
- Create: `brain/__init__.py`、`brain/protocol.py`
- Test: `tests/test_brain_protocol.py`

- [ ] **Step 1: 建 package 标记**

创建空文件 `brain/__init__.py`（内容仅一行注释）:

```python
# brain — Plan 3 大脑进程（Python WS server + 后续模型抽象层/诊断器）。
```

- [ ] **Step 2: 写失败测试**

创建 `tests/test_brain_protocol.py`:

```python
# tests/test_brain_protocol.py — WS 消息编解码单测（对齐 js ws-client.js 的 encode 格式）。
from brain.protocol import encode, decode


def test_encode_basic():
    assert encode("PING", {}) == '{"type":"PING","data":{}}'


def test_encode_data_default():
    # data 缺省 → 空对象（对齐 js encode(type)）
    assert encode("PING") == '{"type":"PING","data":{}}'


def test_encode_with_data():
    assert encode("HELLO", {"role": "bg"}) == '{"type":"HELLO","data":{"role":"bg"}}'


def test_decode_roundtrip():
    t, d = decode(encode("STEP_RESULT", {"stepId": "ship", "status": "done"}))
    assert t == "STEP_RESULT"
    assert d == {"stepId": "ship", "status": "done"}


def test_decode_invalid_json():
    assert decode("not json") == (None, {})


def test_decode_missing_type():
    assert decode('{"data":{}}') == (None, {})


def test_decode_null_data():
    # data 为 null → 归一成空 dict
    assert decode('{"type":"PING","data":null}') == ("PING", {})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `python3 -m pytest tests/test_brain_protocol.py -v`
Expected: FAIL（`ModuleNotFoundError: No module named 'brain.protocol'`）

- [ ] **Step 4: 写最小实现**

创建 `brain/protocol.py`:

```python
# brain/protocol.py — WS 消息编解码。
# 格式对齐 bg ws-client.js 的 encode：紧凑 JSON {"type":..., "data":...}，data 缺省/为 null → {}。
import json


def encode(msg_type, data=None):
    """编码为 WS 消息字符串。对齐 js：JSON.stringify({type, data: data||{}})。"""
    return json.dumps(
        {"type": msg_type, "data": data or {}},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def decode(raw):
    """解码 WS 消息 → (msg_type, data)。非法 JSON / 缺 type → (None, {})；data 为 null → {}。"""
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return None, {}
    if not isinstance(obj, dict) or "type" not in obj:
        return None, {}
    return obj["type"], obj.get("data") or {}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `python3 -m pytest tests/test_brain_protocol.py -v`
Expected: PASS（7 passed）

- [ ] **Step 6: Commit**

```bash
git add brain/__init__.py brain/protocol.py tests/test_brain_protocol.py
git commit -m "feat(plan3): brain WS 消息编解码 protocol + 单测

Why: Plan 3 第一刀 WS 管道地基，编解码需对齐 bg ws-client.js 格式
What: brain/protocol.py encode/decode（紧凑 JSON、data 缺省/null→{}）+ 7 单测
Test: pytest tests/test_brain_protocol.py 7 passed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: brain/server.py — WS server（管道核心）

**Files:**
- Create: `brain/server.py`、`brain/__main__.py`、`brain/requirements.txt`
- Test: `tests/test_brain_server.py`

- [ ] **Step 1: 建依赖清单 + 安装**

创建 `brain/requirements.txt`:

```
websockets>=11
```

Run: `pip install -r brain/requirements.txt`
Expected: 成功安装 websockets（server + 测试都需要）。

- [ ] **Step 2: 写失败测试**

创建 `tests/test_brain_server.py`:

```python
# tests/test_brain_server.py — WS server 集成单测（python client ↔ server）。
# 需 websockets：pip install -r brain/requirements.txt
# 用 asyncio.run 包装，不引入 pytest-asyncio。
import asyncio
import websockets
from brain.protocol import encode, decode
from brain import server


def _run(coro):
    return asyncio.run(coro)


def test_ping_pong():
    async def scenario():
        async with websockets.serve(server.handler, "localhost", 0) as s:
            port = s.sockets[0].getsockname()[1]
            async with websockets.connect("ws://localhost:{}".format(port)) as ws:
                await ws.send(encode("PING"))
                return decode(await asyncio.wait_for(ws.recv(), timeout=2))
    t, _ = _run(scenario())
    assert t == "PONG"


def test_step_result_broadcasts_brain_event_to_dashboard():
    server._dashboards.clear()   # 模块级集合，测试间清理

    async def scenario():
        async with websockets.serve(server.handler, "localhost", 0) as s:
            port = s.sockets[0].getsockname()[1]
            async with websockets.connect("ws://localhost:{}".format(port)) as dash:
                await dash.send(encode("HELLO", {"role": "dash"}))
                await asyncio.sleep(0.05)   # 等 server 注册 dashboard
                async with websockets.connect("ws://localhost:{}".format(port)) as bg:
                    await bg.send(encode("HELLO", {"role": "bg"}))
                    await bg.send(encode("STEP_RESULT", {"stepId": "ship", "status": "done"}))
                    return decode(await asyncio.wait_for(dash.recv(), timeout=2))
    t, d = _run(scenario())
    assert t == "BRAIN_EVENT"
    assert d["kind"] == "log"
    assert d["stepId"] == "ship"
    assert "ship" in d["text"]
```

- [ ] **Step 3: 跑测试确认失败**

Run: `python3 -m pytest tests/test_brain_server.py -v`
Expected: FAIL（`ImportError: cannot import name 'handler' from 'brain.server'` / 模块不存在）

- [ ] **Step 4: 写 server 实现**

创建 `brain/server.py`:

```python
# brain/server.py — Plan 3 大脑进程 WS server（第一刀：管道连通，不诊断）。
# 按 HELLO role 注册连接；PING→PONG；STEP_RESULT→回 log BRAIN_EVENT broadcast 给 dashboard。
# 诊断 / 模型 / STATE_PATCH 留后续刀。
import asyncio
import time
import websockets
from brain.protocol import encode, decode

# dashboard 连接集合（broadcast BRAIN_EVENT 用）。模块级：第一刀单进程单 batch，够用。
_dashboards = set()


async def handler(websocket):
    """单个 WS 连接的消息循环。websockets>=11 的 handler 签名为单参数。"""
    try:
        async for raw in websocket:
            mtype, data = decode(raw)
            if mtype == "HELLO":
                if data.get("role") == "dash":
                    _dashboards.add(websocket)
            elif mtype == "PING":
                await websocket.send(encode("PONG"))
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
    finally:
        _dashboards.discard(websocket)


async def _broadcast_dashboards(msg):
    """向所有 dashboard 连接发消息，顺手清理已断开的。"""
    dead = set()
    for d in _dashboards:
        try:
            await d.send(msg)
        except Exception:
            dead.add(d)
    _dashboards.difference_update(dead)


async def serve(host="localhost", port=8787):
    """起 server 运行至取消。"""
    async with websockets.serve(handler, host, port):
        await asyncio.Future()   # run forever
```

- [ ] **Step 5: 写启动入口**

创建 `brain/__main__.py`:

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

- [ ] **Step 6: 跑测试确认通过**

Run: `python3 -m pytest tests/test_brain_server.py -v`
Expected: PASS（2 passed）

- [ ] **Step 7: Commit**

```bash
git add brain/server.py brain/__main__.py brain/requirements.txt tests/test_brain_server.py
git commit -m "feat(plan3): brain WS server 骨架（管道连通，不诊断）

Why: Plan 3 第一刀管道核心，大脑进程起 WS server 收 bg 上报、broadcast 给 dashboard
What: brain/server.py（handler 按 role 注册 + PING→PONG + STEP_RESULT→log BRAIN_EVENT broadcast）+ __main__.py 启动入口 + requirements(websockets) + 2 集成单测
Test: pytest tests/test_brain_server.py 2 passed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: bg ws-client 自启 + STEP_RESULT 上报

**Files:**
- Modify: `core/background/service-worker.js`（L640-643 ws-client importScripts 段 + L912-915 `orchRealStepRunner`）

> **测试说明**：本 task 是 SW + WebSocket 副作用，无合适的纯逻辑单测点（消息封装走已测的 `encode`）。验证靠 `node --check` 语法 + dev build 不回归 + chrome e2e（Task 5 说明，配合大脑一起验）。这是这类 SW 集成代码的现实，不强凑单测。

- [ ] **Step 1: ws-client 改自启**

把 `core/background/service-worker.js` 现有的「不自启」段（importScripts ws-client.js + 三行注释）：

```javascript
// WS 通道架子（2-2c-2）：加载 WsClient 类（挂 self.__AS_WS__）；**不自启**——
// 架子阶段无大脑 server，startWsClient 留 Plan 3 在合适时机调（如 WF_START）。
// release：随 background/ 进包但顶层不连 → 沉睡 dead code 无害（同 orchestrator/OPEN_MONITOR）。
importScripts('ws-client.js');
```

改成（加自启）：

```javascript
// WS 通道（Plan 3 第一刀起自启）：加载 WsClient 类（挂 self.__AS_WS__）。
importScripts('ws-client.js');

// bg ws-client 自启：连大脑 localhost:8787。createWsClient onopen 自动发 HELLO{role:bg} + PING 保活。
// 连不上（dev 未起大脑 / release 无大脑）→ 指数退避重连（架子已有），不影响 bg 其他功能。
// 第一刀 handlers 空（入站 STATE_PATCH 诊断决策留第二刀）。
const orchWsClient = self.__AS_WS__.startWsClient({
  onStatus: s => console.log('[orch-ws]', s),
});
```

> ⚠ **发版隔离（记入 spec §12 生产部署，Plan 3 合 main / 发版前必处理）**：自启破坏了 Plan 2 的「release ws-client 沉睡」——release 包 bg 会尝试连 localhost:8787（员工机无大脑 → 一直退避重连，无害但不该有）。处理方式类比 dashboard 剥离：`package_all.py` 加一个 strip 把 `startWsClient(...)` 自启行在 release 移除，或注入 dev 守卫。**当前 Plan 3 在分支 `feature/automation-llm-brain` 开发、整体未发版，不影响**；待 Plan 3 要合 main / 发版时统一做（与「生产部署」一刀）。

- [ ] **Step 2: orchRealStepRunner 加 STEP_RESULT 上报**

把现有 `orchRealStepRunner`：

```javascript
// 真实 stepRunner：dispatch 到 adapter；未接入 step.id 回落 stub（13 步骨架仍端到端可跑）
async function orchRealStepRunner(step, wf) {
  const adapter = ORCH_ADAPTERS[step.id];
  return adapter ? adapter(step, wf) : orchStubStepRunner(step);
}
```

改成（执行后 fire-forget 上报）：

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

- [ ] **Step 3: 语法检查**

Run: `node --check core/background/service-worker.js && node --check core/background/ws-client.js`
Expected: 无输出（exit 0）。

- [ ] **Step 4: dev build 不回归**

Run: `python3 build/build_extension.py`
Expected: 构建成功，输出 8 features / content scripts 数量与之前一致，无报错。

- [ ] **Step 5: Commit**

```bash
git add core/background/service-worker.js
git commit -m "feat(plan3): bg ws-client 自启 + 每步 STEP_RESULT 上报大脑

Why: Plan 3 第一刀，bg 连大脑并上报每步结果，打通 bg→大脑 上行管道
What: service-worker.js ws-client 从不自启改自启（startWsClient，onopen 发 HELLO+PING）；orchRealStepRunner 包装 step 执行后 fire-forget 发 STEP_RESULT
Test: node --check 通过 + dev build 不回归；自启/上报 chrome e2e 留 Task 5（配合大脑一起验）
Note: 自启破坏 release ws 沉睡，发版隔离待 Plan 3 合 main 前处理（spec §12）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: dashboard 对接验证 + 全量回归 + 收尾

**Files:**
- Verify（预期无需改）: `core/dashboard/state/ws-source.js`
- Run: 全量测试 + server 冒烟

> **dashboard 是 Plan 1 架子红利**：`ws-source.js` 已具备「连 8787 → 灯 live + 发 HELLO{role:dash} → onmessage BRAIN_EVENT→appendBrainEvent → onclose 降级 mock」。本刀只需确认协议对齐，预期零代码改动。

- [ ] **Step 1: 确认 ws-source ↔ server 协议对齐（review，预期无改动）**

逐条核对（无需改代码，确认即可）：
- ws-source `onopen` 发 `HELLO {role:'dash'}` ↔ server `handler` 检查 `data.get('role')=='dash'` 注册 dashboard ✓
- ws-source `onmessage` 的 `BRAIN_EVENT → appendBrainEvent(msg.data)` ↔ server broadcast 的 `BRAIN_EVENT` data 结构 `{workflowId, stepId, kind, text, ts}`，与 `mock-data.js` 的 `MOCK_BRAIN_EVENTS` 元素同构 ✓
- `store.appendBrainEvent(ev)` 直接 push 无格式校验，故 server data 同构 mock 即可正常渲染 ✓

若发现不符（如 server 漏字段），回 Task 2 的 server BRAIN_EVENT 构造补齐，不在 ws-source 端凑。

- [ ] **Step 2: 全量 JS 回归**

Run: `node --test tests/*.test.js`
Expected: 全过（ws-client + dashboard-store + version-cmp，无回归）。⚠ 不要 `node --test tests/`（整目录会把 pytest .py 当 JS 解析失败）。

- [ ] **Step 3: 全量 Python 回归**

Run: `python3 -m pytest tests/`
Expected: 全过（原有 + 新 `test_brain_protocol` 7 + `test_brain_server` 2）。

- [ ] **Step 4: server 启动冒烟**

Run: `python3 -m brain`（另开终端）
Expected: 打印 `brain WS server starting on ws://localhost:8787 ...`，监听不报错；`Ctrl-C` 正常停（打印 stopped）。

- [ ] **Step 5: 写 chrome e2e 验证说明（留「大脑一起验」，本刀不强跑）**

新建 `docs/superpowers/2026-06-10-plan3-ws-pipeline-verification.md`，记一条端到端冒烟流程：
1. `python3 -m brain` 起 server
2. chrome reload 扩展 → SW console 应见 `[orch-ws] live`（bg 连上）
3. Hub「打开监控」开 dashboard → 顶栏 WS 灯应变 **live**（不再 mock 回放）
4. SW console `orchStartWorkflow({label:'测试'})` 跑一条 → dashboard 大脑流应增量出现 `step X → done` 的 `log` BRAIN_EVENT
5. 关 server（Ctrl-C）→ SW console 见 `[orch-ws] offline/reconnecting`、dashboard 灯回 offline + 重新 mock 回放（降级验证）

此 e2e 配合 Plan 2 各 adapter「大脑搭完一起验」（用户决策），本刀只跑 Step 2-4 的自动化验证。

- [ ] **Step 6: Commit**

```bash
git add core/dashboard/state/ws-source.js docs/superpowers/2026-06-10-plan3-ws-pipeline-verification.md
git commit -m "feat(plan3): dashboard 对接真实大脑验证 + WS 管道 e2e 说明

Why: Plan 3 第一刀收尾，确认 dashboard ws-source 协议与 brain server 对齐、补 e2e 验证文档
What: 确认 ws-source 架子满足（HELLO/BRAIN_EVENT 对齐，零代码改动）；新建 plan3-ws-pipeline-verification.md（起 server→bg 连→dashboard 灯 live→STEP_RESULT→BRAIN_EVENT 冒烟）
Test: node --test tests/*.test.js 全过 + pytest tests/ 全过 + python -m brain 启动冒烟 OK

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 实现顺序与验收

四个 Task 串行（Task 1→4），每 Task 独立 commit、可独立验：
- **Task 1**（protocol）+ **Task 2**（server）：纯 Python，pytest 全自动验，无 chrome 依赖。
- **Task 3**（bg 自启 + 上报）：SW 副作用，node --check + dev build 验，真实连接留 e2e。
- **Task 4**（dashboard + 回归）：协议对齐确认 + 全量回归 + server 冒烟，chrome e2e 留「大脑一起验」。

**本刀完成 = 管道结构就位**：大脑 server 可起、bg 可连可上报、dashboard 可收可显、协议对齐、降级保留。**下一刀（第二刀）**：诊断器 + error hook + STATE_PATCH 闭环（self-heal）。

