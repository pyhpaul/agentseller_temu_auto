# native_host/handlers/text_refine.py — 标题润色（措辞独特化降重，员工 release 可用）。
# 走 native host（员工已装 com.temu.label_host），不依赖 dev-only brain WS。
# provider 模式对齐 image_optimize：配 LLM_BASE_URL + LLM_API_KEY 用真实 OpenAI-compat；未配 → mock。
# 安全：无 key/调用失败/解析不出 → 退回原标题（不编造、不阻断，对齐项目「润色失败保留原标题」）。
import os
import json
import urllib.request

_TIMEOUT = 30


class MockTextProvider:
    """框架占位：返回原标题（未配 LLM key 时），让链路端到端可跑。"""
    def refine(self, original, constraints):
        return {"refined": original, "changes": "未配 LLM（mock），保留原标题"}


class OpenAICompatProvider:
    """OpenAI 兼容 chat/completions（智谱 glm 等同此协议）。urllib 零三方依赖。"""
    def __init__(self, base_url, api_key, model):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    def _post(self, body):
        req = urllib.request.Request(
            self.base_url + "/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.api_key},
        )
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))

    def refine(self, original, constraints):
        max_len = (constraints or {}).get("maxLen", 250)
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content":
                    "你是跨境电商标题优化助手。把商品标题改写得与原始表述显著不同但语义等价，"
                    "用于降低与同源铺货商品的重复度。要求：保留核心品类词与关键卖点；纯英文；"
                    "不超过 {} 字符；禁中文标点；禁营销违禁词（free/sale/best/discount 等）。"
                    "只回 JSON：{{\"refined\":\"<新标题>\",\"changes\":\"<改动简述>\"}}。"
                    "无法可靠改写就把 refined 设为原标题。".format(max_len)},
                {"role": "user", "content": "原标题：" + original},
            ],
            "temperature": 0.7,
        }
        resp = self._post(body)
        content = (((resp or {}).get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        obj = _extract_json(content)
        refined = obj.get("refined") if isinstance(obj, dict) else None
        if not isinstance(refined, str) or not refined.strip():
            return {"refined": original, "changes": "无有效改写，保留原标题"}
        return {"refined": refined.strip(), "changes": str((obj.get("changes") or "")) if isinstance(obj, dict) else ""}


def _extract_json(text):
    """容错解析模型输出：直接 JSON / code fence 包裹 / 文本中首个 {...}。失败 → None。"""
    if not isinstance(text, str) or not text.strip():
        return None
    s = text.strip()
    if s.startswith("```"):
        s = s.strip("`")
        if s.lower().startswith("json"):
            s = s[4:]
        s = s.strip()
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        pass
    i, j = s.find("{"), s.rfind("}")
    if 0 <= i < j:
        try:
            return json.loads(s[i:j + 1])
        except (ValueError, TypeError):
            return None
    return None


def _select_provider():
    base = os.environ.get("LLM_BASE_URL", "").strip()
    key = os.environ.get("LLM_API_KEY", "").strip()
    if not base or not key:
        return MockTextProvider()
    model = (os.environ.get("LLM_MODEL", "") or "glm-4-flash").strip()
    return OpenAICompatProvider(base, key, model)


def handle(msg):
    """refine_title：original → provider 润色 → {success, refined, changes}。
    润色失败/无 key → 退回原标题（success:true，不阻断；UI 据 refined==original 提示）。"""
    original = (msg.get("original") or "").strip()
    if not original:
        return {"success": True, "refined": "", "changes": "原标题为空"}
    try:
        out = _select_provider().refine(original, msg.get("constraints") or {})
    except Exception as e:
        return {"success": True, "refined": original, "changes": "润色失败保留原标题：%s" % e}
    return {"success": True, "refined": out.get("refined") or original, "changes": out.get("changes") or ""}
