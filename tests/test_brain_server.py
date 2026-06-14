# tests/test_brain_server.py — WS server 集成单测（python client ↔ server）。
# 需 websockets：pip install -r brain/requirements.txt
# 用 asyncio.run 包装，不引入 pytest-asyncio。
import asyncio
from unittest import mock

import websockets
from brain.protocol import encode, decode
from brain import server
from brain.model import MockModel


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


def test_status_error_without_error_obj_still_diagnoses():
    # status=error 但 error 字段缺失 → 仍进诊断（escalate），不被当 benign log 静默吞
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
    assert d["action"] == "escalate"   # unknown 类（非 read）→ 天然 escalate


def test_diagnose_crash_degrades_to_escalate():
    # 纵深防御（对抗 review 建议）：即便 diagnose 内部抛（未来新增任何抛点），
    # server 兜底回 escalate STATE_PATCH，不崩 handler、不断 bg、不丢决策。
    server._dashboards.clear()

    async def scenario():
        async with websockets.serve(server.handler, "localhost", 0) as s:
            port = s.sockets[0].getsockname()[1]
            async with websockets.connect("ws://localhost:{}".format(port)) as bg:
                await bg.send(encode("HELLO", {"role": "bg"}))
                await bg.send(encode("STEP_RESULT", {
                    "workflowId": "w", "stepId": "ship", "status": "error",
                    "error": {"category": "read", "recoverable": True}}))
                return decode(await asyncio.wait_for(bg.recv(), timeout=2))

    with mock.patch("brain.server.diagnose", side_effect=RuntimeError("boom")):
        t, d = _run(scenario())
    assert t == "STATE_PATCH"
    assert d["action"] == "escalate"


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
