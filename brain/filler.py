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
