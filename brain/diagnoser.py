# brain/diagnoser.py — 诊断器（self-heal 首版唯一智能，spec §6）。
# 输入 StepError + 上下文 → 两条安全红线 + 三分层 → 仅 read 类调模型判断瞬时 vs 结构性 → {action, reason}。
import logging

from brain.jsonx import extract_decision
from brain.registry import describe_step

MAX_RETRY = 2   # 重试上限红线（默认 2 次，spec §6）

_log = logging.getLogger("brain.diagnoser")


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
        raw = model.decide(messages)
    except Exception as e:
        # 可观测性（错误分层铁律）：透出异常类型 + 关键信息，dev 调坏模型时 5 秒分清
        # 限流(HTTPError)/网络(URLError)/超时(timeout)/解析。行为不变——仍统一 escalate。
        cause = "{}: {}".format(type(e).__name__, str(e)[:200])
        _log.warning("诊断模型调用失败: %s", cause)
        return {"action": "escalate", "reason": "诊断不可用（{}），安全转人工".format(cause)}
    # 容错抽取（剥围栏/散文/抓平衡块）：真模型脏输出能还原；真垃圾/拒答 → None → escalate（守不变量2）
    obj = extract_decision(raw)
    if obj is None:
        return {"action": "escalate", "reason": "模型输出无法解析为决策，安全转人工"}
    # 只归一化合法值的表面形态（大小写/空白），不放宽语义；非白名单仍 escalate。
    # 类型守卫：非字符串 action（list/int/dict/bool）保持原值 → 必不在白名单 → escalate（绝不崩）。
    action = obj.get("action")
    action = action.strip().lower() if isinstance(action, str) else action
    if action not in ("retry", "escalate"):
        return {"action": "escalate", "reason": "模型返回非法 action，安全转人工"}
    return {"action": action, "reason": obj.get("reason") or ""}
