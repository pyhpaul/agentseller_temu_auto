# brain/server.py — 大脑进程 WS server（三判断点已接线）。
# 按 HELLO role 注册连接；PING→PONG；STEP_RESULT→诊断 self-heal（diagnose→STATE_PATCH 回 bg + BRAIN_EVENT 给 dashboard）；
# FILL_REQUEST→filler 回填提议（FILL_SUGGEST）；REVIEW_REQUEST→reviewer 不可逆复核（REVIEW_VERDICT）。
import asyncio
import time
import websockets
from brain.protocol import encode, decode
from brain.diagnoser import diagnose
from brain.filler import suggest
from brain.reviewer import review
from brain.model import MockModel

# dashboard 连接集合（broadcast BRAIN_EVENT 用）。模块级：单进程单 batch，够用。
_dashboards = set()

# 诊断用模型（model-agnostic）。默认 MockModel；真实部署由 __main__ 按 env 注入 OpenAICompatModel。
_model = MockModel()


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
                await _handle_step_result(websocket, data)
            elif mtype == "FILL_REQUEST":
                await _handle_fill_request(websocket, data)
            elif mtype == "REVIEW_REQUEST":
                await _handle_review_request(websocket, data)
            # 其余类型忽略
    finally:
        _dashboards.discard(websocket)


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
    if data.get("status") == "error":
        # status=error 一律进诊断：error 缺失时合成保守 err（unknown 非 read → diagnose 天然 escalate），
        # 绝不把真实错误当 benign log 静默吞（守不变量2精神：诊断不到也要转人工，不放过）。
        err = data.get("error") or {"category": "unknown", "recoverable": True}
        ctx = {"stepId": data.get("stepId"), "retryCount": data.get("retryCount", 0)}
        # 诊断含阻塞 urlopen（接真模型时可能慢/僵）→ to_thread 移出事件循环，
        # 防慢模型冻结整个 server（否则 ws 库 ping 超时会误断所有连接、丢诊断结果）。
        # 纵深防御：诊断任何抛点都兜底成 escalate（守不变量2「不确定→转人工」），绝不崩 handler 丢决策。
        try:
            decision = await asyncio.to_thread(diagnose, err, ctx, _model)
        except Exception as e:
            decision = {"action": "escalate",
                        "reason": "诊断异常兜底（{}），安全转人工".format(type(e).__name__)}
        # diagnose 类 BRAIN_EVENT 给 dashboard 看推理
        await _broadcast_dashboards(_brain_event(
            data, "diagnose", "{}：{}".format(decision["action"], decision["reason"])))
        # STATE_PATCH 回 bg 落地决策（仍由 bg 写 storage，守数据契约 spec §5）。
        # 包 try：诊断期间 bg 连接可能已断，静默兜底（对齐 _broadcast 容错），不让一次发送失败崩 handler。
        try:
            await websocket.send(encode("STATE_PATCH", {
                "workflowId": data.get("workflowId"),
                "stepId": data.get("stepId"),
                "action": decision["action"],
                "reason": decision["reason"],
            }))
        except Exception:
            pass
    else:
        await _broadcast_dashboards(_brain_event(
            data, "log", "step {} → {}".format(data.get("stepId"), data.get("status"))))


async def _handle_fill_request(websocket, data):
    """FILL_REQUEST → filler 提议 → FILL_SUGGEST 回 bg + suggest 类 BRAIN_EVENT 给 dashboard。
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


async def _handle_review_request(websocket, data):
    """REVIEW_REQUEST → reviewer 复核 → REVIEW_VERDICT 回 bg + review 类 BRAIN_EVENT。
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
