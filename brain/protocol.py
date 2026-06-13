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
