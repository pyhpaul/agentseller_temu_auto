# brain/reviewer.py — 不可逆复核（大脑第三判断点，与 diagnoser/filler 并列）。spec 2026-06-14。
# 不可逆 AUTO 步执行前复核 product 数据 + 页面快照 → {verdict:'pass'|'hold', reason, concerns}。
# fail-safe：模型挂/解析不出/verdict 非法 → hold（绝不假 PASS 放行不可逆，守不变量2）。
import logging

from brain.jsonx import extract_decision

_log = logging.getLogger("brain.reviewer")


def review(step_id, product, context, model):
    """product: 当前 workflow.product；context: {pageSnapshot}。
    返回 {"verdict":"pass"|"hold", "reason":str, "concerns":[str]}。fail-safe 默认 hold。"""
    try:
        raw = model.decide(_build_messages(step_id, product, context))
    except Exception as e:
        _log.warning("复核模型调用失败: %s: %s", type(e).__name__, str(e)[:200])
        return {"verdict": "hold", "reason": "复核不可用（{}），保守转人工".format(type(e).__name__), "concerns": []}
    obj = extract_decision(raw)
    if not isinstance(obj, dict):
        return {"verdict": "hold", "reason": "复核输出无法解析，保守转人工", "concerns": []}
    verdict = obj.get("verdict")
    verdict = verdict.strip().lower() if isinstance(verdict, str) else verdict
    if verdict not in ("pass", "hold"):
        return {"verdict": "hold", "reason": "复核 verdict 非法，保守转人工", "concerns": []}
    raw_concerns = obj.get("concerns")
    concerns = [str(c) for c in raw_concerns] if isinstance(raw_concerns, list) else []
    return {"verdict": verdict, "reason": str(obj.get("reason") or ""), "concerns": concerns}


def _build_messages(step_id, product, context):
    ctx = context or {}
    snapshot = (ctx.get("pageSnapshot") or "")[:6000]
    return [
        {"role": "system", "content":
            "你是自动化流水线的不可逆动作复核员。这一步将执行【不可逆】操作（发布/生成标签/创建采购单/发货）。"
            "复核 product 数据是否安全提交：格式 sanity、跨字段一致、与页面是否对得上。"
            "只回 JSON：{\"verdict\":\"pass\"|\"hold\",\"reason\":\"简述\",\"concerns\":[\"可疑点\"]}。"
            "数据看起来安全 → pass；发现空/畸形/不匹配/页面态不符 → hold + concerns；拿不准 → hold。"},
        {"role": "user", "content":
            "当前不可逆步: {}\nproduct: {}\n页面快照(截断):\n{}".format(step_id, product, snapshot)},
    ]
