# brain/diagnoser.py — 诊断器（self-heal 首版唯一智能，spec §6）。
# 输入 StepError + 上下文 → 两条安全红线 + 三分层 → 仅 read 类调模型判断瞬时 vs 结构性 → {action, reason}。
import json

from brain.registry import describe_step

MAX_RETRY = 2   # 重试上限红线（默认 2 次，spec §6）


def diagnose(step_error, context, model):
    """step_error: {category, code, message, recoverable}；context: {stepId, retryCount}；
    model: 实现 decide(messages) 的对象。返回 {"action": "retry"|"escalate", "reason": str}。"""
    err = step_error or {}
    ctx = context or {}

    # 红线 1：不可逆绝不重试（recoverable:false → 转人工，守 committing 语义）
    if err.get("recoverable") is False:
        return {"action": "escalate", "reason": "不可逆步骤出错，绝不重试，转人工"}

    # 三分层：仅 read 类可 self-heal；validate / business → 转人工（非技术自愈）
    category = err.get("category")
    if category != "read":
        return {"action": "escalate", "reason": "{} 类错误需人工处理".format(category)}

    # 红线 2：重试上限（达上限强制转人工，防死循环）
    if ctx.get("retryCount", 0) >= MAX_RETRY:
        return {"action": "escalate",
                "reason": "已重试 {} 次达上限，转人工".format(ctx.get("retryCount", 0))}

    # read 类未达上限 → 调模型判断「瞬时（重试）vs 结构性（转人工）」
    return _ask_model(err, ctx, model)


def _ask_model(err, ctx, model):
    messages = [
        {"role": "system", "content":
            "你是自动化流程诊断器。判断 read 类错误是瞬时（值得重试，如网络抖动 / 渲染未就绪 / 超时）"
            "还是结构性（重试无用需人工，如选择器失效 / 页面改版）。"
            "只回 JSON：{\"action\":\"retry\"|\"escalate\",\"reason\":\"简述\"}。"},
        {"role": "user", "content":
            "step={} category={} code={} message={}".format(
                describe_step(ctx.get("stepId")), err.get("category"), err.get("code"), err.get("message"))},
    ]
    try:
        obj = json.loads(model.decide(messages))
    except Exception:
        return {"action": "escalate", "reason": "诊断不可用（模型异常 / 解析失败），安全转人工"}
    action = obj.get("action") if isinstance(obj, dict) else None
    if action not in ("retry", "escalate"):
        return {"action": "escalate", "reason": "模型返回非法 action，安全转人工"}
    return {"action": action, "reason": obj.get("reason") or ""}
