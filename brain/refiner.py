# brain/refiner.py — 标题润色（措辞独特化降重，大脑文本判断点）。spec 2026-06-17。
# 调模型改写标题 → jsonx 容错解析 → {refined, changes, confidence}。
# 安全：模型挂/解析不出/无有效 refined → 退回原标题（不编造劣质标题，对齐 filler 不编造哲学）；
# 合规校验在 content 端确定性重跑 title 规则（约束给结构），brain 只生成。
import logging

from brain.jsonx import extract_decision

_log = logging.getLogger("brain.refiner")


def refine_title(original, constraints, model):
    """original: 原标题 str；constraints: {maxLen,...} 提示用 dict。
    返回 {"refined": str, "changes": str, "confidence": float}。退回 = refined==original。"""
    original = (original or "").strip()
    if not original:
        return {"refined": "", "changes": "原标题为空", "confidence": 0.0}
    try:
        raw = model.decide(_build_messages(original, constraints or {}))
    except Exception as e:
        _log.warning("标题润色模型调用失败: %s: %s", type(e).__name__, str(e)[:200])
        return {"refined": original, "changes": "模型不可用，保留原标题", "confidence": 0.0}
    obj = extract_decision(raw)
    if not isinstance(obj, dict):
        return {"refined": original, "changes": "无法解析，保留原标题", "confidence": 0.0}
    refined = obj.get("refined")
    if not isinstance(refined, str) or not refined.strip():
        return {"refined": original, "changes": "无有效改写，保留原标题", "confidence": 0.0}
    conf = obj.get("confidence")
    confidence = float(conf) if isinstance(conf, (int, float)) and not isinstance(conf, bool) else 0.0
    return {"refined": refined.strip(), "changes": str(obj.get("changes") or ""), "confidence": confidence}


def _build_messages(original, constraints):
    max_len = constraints.get("maxLen", 250)
    return [
        {"role": "system", "content":
            "你是跨境电商标题优化助手。把商品标题改写得与原始表述显著不同但语义等价，"
            "用于降低与同源铺货商品的重复度。要求：保留核心品类词与关键卖点；纯英文；"
            "不超过 {} 字符；禁中文标点；禁营销违禁词（free/sale/best/discount 等）。"
            "只回 JSON：{{\"refined\":\"<新标题>\",\"changes\":\"<改动简述>\",\"confidence\":0~1}}。"
            "无法可靠改写就把 refined 设为原标题。".format(max_len)},
        {"role": "user", "content": "原标题：{}".format(original)},
    ]
