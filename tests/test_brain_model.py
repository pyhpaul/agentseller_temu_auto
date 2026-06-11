# tests/test_brain_model.py — 模型抽象层单测（MockModel 行为；OpenAICompatModel 真 API 留 e2e）。
from brain.model import MockModel


def test_mock_canned_overrides_rule():
    m = MockModel(canned='{"action":"retry","reason":"x"}')
    assert m.decide([{"role": "user", "content": "anything"}]) == '{"action":"retry","reason":"x"}'


def test_mock_rule_timeout_retry():
    m = MockModel()
    assert '"action":"retry"' in m.decide([{"role": "user", "content": "waitForEl timeout 10s"}])


def test_mock_rule_chinese_timeout_retry():
    m = MockModel()
    assert '"action":"retry"' in m.decide([{"role": "user", "content": "选择器等待超时"}])


def test_mock_rule_other_escalate():
    m = MockModel()
    assert '"action":"escalate"' in m.decide([{"role": "user", "content": "selector not found"}])


def test_mock_empty_messages_escalate():
    m = MockModel()
    assert '"action":"escalate"' in m.decide([])   # 无信息 → 安全默认
