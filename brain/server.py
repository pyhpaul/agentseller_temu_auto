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
