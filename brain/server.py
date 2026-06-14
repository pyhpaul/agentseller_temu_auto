# brain/server.py — Plan 3 大脑进程 WS server（第一刀：管道连通，不诊断）。
# 按 HELLO role 注册连接；PING→PONG；STEP_RESULT→回 log BRAIN_EVENT broadcast 给 dashboard。
# 诊断 / 模型 / STATE_PATCH 留后续刀。
import asyncio
import time
import websockets
from brain.protocol import encode, decode
from brain.diagnoser import diagnose
from brain.model import MockModel

# dashboard 连接集合（broadcast BRAIN_EVENT 用）。模块级：第一刀单进程单 batch，够用。
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
            # 其余类型第一刀忽略
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
