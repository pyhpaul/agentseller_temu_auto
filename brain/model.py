# brain/model.py — 模型抽象层（model-agnostic，spec §3.2/§11）。
# 统一接口 decide(messages, tools=None) → str（模型回的原始文本，调用方自行解析）。
# 换模型只改本文件的适配器；诊断器 / server 不依赖具体模型。
import json
import socket
import time
import urllib.error
import urllib.request

# 瞬时类 HTTP 码（限流 / 服务端瞬时）——值得有界重试；鉴权/4xx 不在内（立即抛）
_TRANSIENT_HTTP = {429, 500, 502, 503, 504}


class MockModel:
    """测试 / 离线 fallback 用的确定性模型。
    canned 给定 → decide 恒返回它；否则规则式（messages 末条含 timeout/超时 → retry，其余 → escalate）。
    规则式仅为单测确定性 + 演示，真智能在 OpenAICompatModel。
    """

    def __init__(self, canned=None):
        self._canned = canned

    def decide(self, messages, tools=None):
        if self._canned is not None:
            return self._canned
        last = (messages[-1].get("content", "") if messages else "").lower()
        if "timeout" in last or "超时" in last:
            return '{"action":"retry","reason":"超时类瞬时故障，重试"}'
        return '{"action":"escalate","reason":"非瞬时故障，转人工"}'


class OpenAICompatModel:
    """OpenAI-compatible /chat/completions 适配器（urllib，零三方依赖）。
    base_url 如 http://localhost:11434/v1（ollama）/ https://api.openai.com/v1 / 各家兼容端点；
    换模型只改 model 名 / 端点（model-agnostic）。真 API 走通留 e2e（用户配 key）。
    """

    def __init__(self, base_url, api_key, model, timeout=30, max_retries=2, backoff_base=0.5):
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._key = api_key
        self._model = model
        self._timeout = timeout
        self._max_retries = max_retries
        self._backoff_base = backoff_base

    @staticmethod
    def _is_transient(e):
        """瞬时类失败（值得重试）：限流/服务端 5xx、读超时、连接拒绝（端点冷启动）。"""
        if isinstance(e, urllib.error.HTTPError):
            return e.code in _TRANSIENT_HTTP
        if isinstance(e, socket.timeout):
            return True
        if isinstance(e, urllib.error.URLError):
            return isinstance(e.reason, (ConnectionRefusedError, socket.timeout))
        return False

    def decide(self, messages, tools=None):
        body = json.dumps(
            {"model": self._model, "messages": messages, "temperature": 0},
            ensure_ascii=False,
        ).encode("utf-8")
        req = urllib.request.Request(
            self._url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self._key,
            },
        )
        # 瞬时类有界退避重试；非瞬时 或 超界 → 抛原异常（绝不吞成假成功，让上层 diagnoser 安全 escalate）
        attempt = 0
        while True:
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                    obj = json.loads(resp.read().decode("utf-8"))
                break
            except Exception as e:
                if self._is_transient(e) and attempt < self._max_retries:
                    if self._backoff_base:
                        time.sleep(self._backoff_base * (2 ** attempt))
                    attempt += 1
                    continue
                raise
        # 防御性取值：本地端点可能空 choices / choices[0] 非 dict / message 非 dict /
        # content=null（内容过滤/tool_calls）/ error JSON。逐层 isinstance 兜底——
        # 形态不对一律 → 显式 ValueError（带片段，区分「响应形态」vs「模型判 escalate」），
        # 绝不 AttributeError/返回 None（兑现 decide → str | ValueError 契约）。
        choices = obj.get("choices") or []
        first = choices[0] if choices else None
        message = first.get("message") if isinstance(first, dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str):
            raise ValueError("unexpected response shape: " + str(obj)[:200])
        return content
