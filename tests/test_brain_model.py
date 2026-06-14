# tests/test_brain_model.py — 模型抽象层单测（MockModel 行为 + OpenAICompatModel 请求构造/响应解析，mock HTTP）。
import json
import socket
import urllib.error
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


def test_retries_transient_then_succeeds():
    # 瞬时类（503）有界重试后成功：第 1 次 503、第 2 次成功
    m = OpenAICompatModel(base_url="http://h/v1", api_key="k", model="m", max_retries=2, backoff_base=0)
    calls = {"n": 0}

    def flaky(req, timeout=None):
        calls["n"] += 1
        if calls["n"] < 2:
            raise urllib.error.HTTPError("u", 503, "busy", {}, None)
        return _FakeResp({"choices": [{"message": {"content": "ok"}}]})

    with mock.patch("urllib.request.urlopen", flaky):
        assert m.decide([{"role": "user", "content": "x"}]) == "ok"
    assert calls["n"] == 2


def test_auth_error_not_retried():
    # 鉴权类（401）立即抛、不重试（守不变量2：挽不回不吞）
    m = OpenAICompatModel(base_url="http://h/v1", api_key="k", model="m", max_retries=3, backoff_base=0)
    calls = {"n": 0}

    def auth_fail(req, timeout=None):
        calls["n"] += 1
        raise urllib.error.HTTPError("u", 401, "unauthorized", {}, None)

    with mock.patch("urllib.request.urlopen", auth_fail):
        try:
            m.decide([{"role": "user", "content": "x"}])
            assert False
        except urllib.error.HTTPError:
            pass
    assert calls["n"] == 1


def test_transient_exhausted_reraises():
    # 瞬时类超界 → 抛原异常（绝不吞成假成功，守不变量2）
    m = OpenAICompatModel(base_url="http://h/v1", api_key="k", model="m", max_retries=2, backoff_base=0)

    def always_503(req, timeout=None):
        raise urllib.error.HTTPError("u", 503, "busy", {}, None)

    with mock.patch("urllib.request.urlopen", always_503):
        try:
            m.decide([{"role": "user", "content": "x"}])
            assert False, "超界必须抛原异常，不得吞"
        except urllib.error.HTTPError as e:
            assert e.code == 503


def test_socket_timeout_is_transient():
    # socket.timeout 算瞬时 → 重试
    m = OpenAICompatModel(base_url="http://h/v1", api_key="k", model="m", max_retries=2, backoff_base=0)
    calls = {"n": 0}

    def slow(req, timeout=None):
        calls["n"] += 1
        if calls["n"] < 2:
            raise socket.timeout("read timed out")
        return _FakeResp({"choices": [{"message": {"content": "ok"}}]})

    with mock.patch("urllib.request.urlopen", slow):
        assert m.decide([{"role": "user", "content": "x"}]) == "ok"
    assert calls["n"] == 2


def test_empty_choices_raises_valueerror():
    # 响应形态异常：空 choices → 显式 ValueError（带片段），非 IndexError
    m = OpenAICompatModel(base_url="http://h/v1", api_key="k", model="m")
    with mock.patch("urllib.request.urlopen", lambda req, timeout=None: _FakeResp({"choices": []})):
        try:
            m.decide([{"role": "user", "content": "x"}])
            assert False
        except ValueError:
            pass


def test_content_null_raises_valueerror():
    # content=null（内容过滤/纯 tool_calls）→ 显式 ValueError，不返回 None（守 decide→str 契约）
    m = OpenAICompatModel(base_url="http://h/v1", api_key="k", model="m")
    with mock.patch("urllib.request.urlopen",
                    lambda req, timeout=None: _FakeResp({"choices": [{"message": {"content": None}}]})):
        try:
            m.decide([{"role": "user", "content": "x"}])
            assert False
        except ValueError:
            pass


def test_malformed_choices_item_raises_valueerror():
    # choices[0] 非 dict（null/str）/ message 非 dict → 一律 ValueError（不 AttributeError），
    # 兑现 decide → str | ValueError 契约（对抗 review 发现的契约不诚实点）
    m = OpenAICompatModel(base_url="http://h/v1", api_key="k", model="m")
    for payload in ({"choices": [None]}, {"choices": ["oops"]}, {"choices": [{"message": None}]}):
        with mock.patch("urllib.request.urlopen", lambda req, timeout=None, p=payload: _FakeResp(p)):
            try:
                m.decide([{"role": "user", "content": "x"}])
                assert False, payload
            except ValueError:
                pass
