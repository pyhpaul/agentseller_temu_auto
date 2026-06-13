# brain/model.py — 模型抽象层（model-agnostic，spec §3.2/§11）。
# 统一接口 decide(messages, tools=None) → str（模型回的原始文本，调用方自行解析）。
# 换模型只改本文件的适配器；诊断器 / server 不依赖具体模型。
import json
import urllib.request


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

    def __init__(self, base_url, api_key, model, timeout=30):
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._key = api_key
        self._model = model
        self._timeout = timeout

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
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            obj = json.loads(resp.read().decode("utf-8"))
        return obj["choices"][0]["message"]["content"]
