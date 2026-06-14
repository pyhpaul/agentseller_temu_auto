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


def test_read_codefenced_retry_now_parses():
    # 加固后：围栏包裹的合法 retry 决策能被诊断器解析（此前会 escalate）
    d = diagnose(_err(message="selector not found", code="NOT_FOUND"), {"retryCount": 0},
                 MockModel(canned='```json\n{"action":"retry","reason":"渲染抖动"}\n```'))
    assert d["action"] == "retry"
    assert d["reason"] == "渲染抖动"


def test_action_case_normalized():
    # 大小写/空白归一化：" Retry " → retry
    d = diagnose(_err(message="x"), {"retryCount": 0},
                 MockModel(canned='{"action":" Retry ","reason":"r"}'))
    assert d["action"] == "retry"


def test_refusal_still_escalates():
    # 不变量2 红线：拒答文本无合法 JSON → escalate
    d = diagnose(_err(message="x"), {"retryCount": 0},
                 MockModel(canned="I cannot help with that."))
    assert d["action"] == "escalate"


def test_model_exception_reason_carries_cause():
    # 可观测性：异常类型透进 reason（仍 escalate，行为不变）
    class BoomModel:
        def decide(self, messages, tools=None):
            raise RuntimeError("api down")
    d = diagnose(_err(), {"retryCount": 0}, BoomModel())
    assert d["action"] == "escalate"
    assert "RuntimeError" in d["reason"]


def test_nonstring_action_escalates_no_crash():
    # 回归防护（对抗 review 发现）：非字符串 action（list/int/dict/bool）→ escalate 且【不抛】。
    # 此前 (obj.get("action") or "").strip() 对非 str truthy 值崩 AttributeError，杀 ws handler、丢决策。
    for canned in ('{"action":1,"reason":"x"}', '{"action":["retry"]}',
                   '{"action":{"x":"retry"}}', '{"action":true}', '{"action":1.5}'):
        d = diagnose(_err(message="x"), {"retryCount": 0}, MockModel(canned=canned))
        assert d["action"] == "escalate", canned
