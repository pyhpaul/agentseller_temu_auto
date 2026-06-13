# tests/test_brain_diagnoser.py — 诊断器决策 + 两条红线 + 三分层（用 MockModel，不发真 API）。
from brain.diagnoser import diagnose, MAX_RETRY
from brain.model import MockModel


def _err(category="read", recoverable=True, message="waitForEl timeout", code="TIMEOUT"):
    return {"category": category, "code": code, "message": message, "recoverable": recoverable}


def test_irreversible_never_retry():
    # 红线 1：recoverable:false → escalate（优先于模型，即使模型说 retry）
    d = diagnose(_err(recoverable=False), {"retryCount": 0},
                 MockModel(canned='{"action":"retry","reason":"x"}'))
    assert d["action"] == "escalate"


def test_validate_category_escalate():
    # 三分层：validate → 转人工（不调模型）
    d = diagnose(_err(category="validate"), {"retryCount": 0},
                 MockModel(canned='{"action":"retry","reason":"x"}'))
    assert d["action"] == "escalate"


def test_business_category_escalate():
    d = diagnose(_err(category="business"), {"retryCount": 0},
                 MockModel(canned='{"action":"retry","reason":"x"}'))
    assert d["action"] == "escalate"


def test_retry_limit_escalate():
    # 红线 2：retryCount 达上限 → escalate（优先于模型）
    d = diagnose(_err(), {"retryCount": MAX_RETRY},
                 MockModel(canned='{"action":"retry","reason":"x"}'))
    assert d["action"] == "escalate"


def test_read_transient_retry():
    # read + 未达上限 + 模型判瞬时（规则式 timeout）→ retry
    d = diagnose(_err(message="timeout"), {"retryCount": 0}, MockModel())
    assert d["action"] == "retry"


def test_read_structural_escalate():
    # read + 模型判结构性（规则式：整条 user content 不含 timeout）→ escalate
    # 注意 code 也要避开 TIMEOUT —— MockModel 看整条 user content（含 code）小写后是否含 timeout
    d = diagnose(_err(message="selector not found", code="NOT_FOUND"), {"retryCount": 0}, MockModel())
    assert d["action"] == "escalate"


def test_model_exception_escalate():
    # spec §7：模型异常 → 安全转人工
    class BoomModel:
        def decide(self, messages, tools=None):
            raise RuntimeError("api down")

    d = diagnose(_err(), {"retryCount": 0}, BoomModel())
    assert d["action"] == "escalate"


def test_model_garbage_escalate():
    # 模型返回非 JSON / 非法 action → 安全转人工
    d = diagnose(_err(), {"retryCount": 0}, MockModel(canned="not json at all"))
    assert d["action"] == "escalate"
