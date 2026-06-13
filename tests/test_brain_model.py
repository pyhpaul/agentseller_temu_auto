# tests/test_brain_model.py — 模型抽象层单测（MockModel 行为 + OpenAICompatModel 请求构造/响应解析，mock HTTP）。
import json
from unittest import mock

from brain.model import MockModel, OpenAICompatModel


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


class _FakeResp:
    """mock urllib 响应（支持 with ... as resp + resp.read()）。"""
    def __init__(self, payload):
        self._p = json.dumps(payload).encode("utf-8")
    def read(self):
        return self._p
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def test_openai_builds_request_and_parses():
    # OpenAICompatModel 真实适配器：正确构造 OpenAI /chat/completions 请求 + 解析 choices[0].message.content。
    # mock HTTP（不发真 API）；真 API 走通仍留 e2e（用户配 key）。
    m = OpenAICompatModel(base_url="http://host/v1/", api_key="secret", model="gpt-x")
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["auth"] = req.headers.get("Authorization")
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResp({"choices": [{"message": {"content": "hello"}}]})

    with mock.patch("urllib.request.urlopen", fake_urlopen):
        out = m.decide([{"role": "user", "content": "hi"}])

    assert out == "hello"
    assert captured["url"] == "http://host/v1/chat/completions"   # base_url 末尾斜杠被 rstrip
    assert captured["auth"] == "Bearer secret"
    assert captured["body"]["model"] == "gpt-x"
    assert captured["body"]["temperature"] == 0                   # 确定性
    assert captured["body"]["messages"] == [{"role": "user", "content": "hi"}]


def test_openai_decide_propagates_http_error():
    # urlopen 抛异常 → decide 不吞（由上层 diagnoser try/except 兜底转人工，见 test_brain_diagnoser）。
    m = OpenAICompatModel(base_url="http://h/v1", api_key="k", model="m")

    def boom(req, timeout=None):
        raise OSError("connection refused")

    with mock.patch("urllib.request.urlopen", boom):
        try:
            m.decide([{"role": "user", "content": "x"}])
            assert False, "decide 应传播 urlopen 异常，不静默吞"
        except OSError:
            pass
