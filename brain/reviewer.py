# brain/reviewer.py — 不可逆复核（大脑第三判断点，与 diagnoser/filler 并列）。spec 2026-06-14。
# 不可逆 AUTO 步执行前复核 product 数据 + 页面快照 → {verdict:'pass'|'hold', reason, concerns}。
# fail-safe：模型挂/解析不出/verdict 非法 → hold（绝不假 PASS 放行不可逆，守不变量2）。
import logging

from brain.jsonx import extract_decision

_log = logging.getLogger("brain.reviewer")


def review(step_id, product, context, model):
    """product: 当前 workflow.product；context: {pageSnapshot}。
    返回 {"verdict":"pass"|"hold", "reason":str, "concerns":[str]}。fail-safe 默认 hold。"""
    # 复核在【步骤执行前】跑，gen_label/create_po/ship 的目标页此刻还没打开 → 抓到空快照。
    # 弱模型拿到空快照会乱编"页面快照未提供"之类的 hold 理由（误导人工）。结构性短路：
    # 无快照不调模型，确定性 hold + 可操作理由（与"字段为空不该 hold"同思路——约束给结构而非 prompt）。
    snapshot = ((context or {}).get("pageSnapshot") or "").strip()
    if not snapshot:
        return {
            "verdict": "hold",
            "reason": "复核在执行前进行、目标页尚未打开，无法自动核对页面——请人工确认已采集字段无误后点「确认提交」放行。",
            "concerns": [],
        }
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
    # 只把【已采集（非空）】字段交给模型复核：product 是流水线渐进填充的，未到的步骤其字段此刻为空属正常。
    # 全量传入会让弱模型把"后续步字段为空"误报成"缺必填字段"而错误 hold（第③步 publish 误报缺
    # url1688/orderNo1688/skuNo/poNo 即此坑）。required 字段的存在性校验由各 adapter 自己做（MISSING_* 错误），
    # reviewer 只负责【已有值字段】的 sanity / 一致性 / 与页面是否对得上——结构性地不让模型看到空字段。
    present = {k: v for k, v in (product or {}).items() if v not in (None, "", [], {})}
    return [
        {"role": "system", "content":
            "你是自动化流水线的不可逆动作复核员。这一步将执行【不可逆】操作（发布/生成标签/创建采购单/发货）。"
            "复核【已采集字段】是否安全提交：格式 sanity、跨字段一致、与页面是否对得上。"
            "只回 JSON：{\"verdict\":\"pass\"|\"hold\",\"reason\":\"简述\",\"concerns\":[\"可疑点\"]}。"
            "已采集字段的值安全 → pass；已采集字段出现畸形/矛盾/与页面不符 → hold + concerns；拿不准 → hold。"
            "重要：只复核下方列出的【已采集字段】，绝不可因为某字段未出现/为空而 hold——"
            "未列出的字段由后续步骤产生，此刻为空是正常的。"},
        {"role": "user", "content":
            "当前不可逆步: {}\n已采集字段: {}\n页面快照(截断):\n{}".format(step_id, present, snapshot)},
    ]
