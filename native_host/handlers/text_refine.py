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
        resp = self._post(self._build_body(original, max_len))
        content = (((resp or {}).get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        obj = _extract_json(content)
        if not isinstance(obj, dict):
            return {"refined": original, "changes": "无有效改写，保留原标题"}
        refined = obj.get("refined")
        if not isinstance(refined, str) or not refined.strip():
            return {"refined": original, "changes": "无有效改写，保留原标题"}
        refined = refined.strip()
        # 客观兜底：只查"换了就一定是错"的客观项——规格数值（500ml/IPX5/SUV）与材质闭集
        # （ABS/stainless steel）。这些是有限可枚举、客观判定的，不依赖模型划界。
        # 动作词/修饰语（relieve/heavy-duty/long）不进校验，交模型自由改写——划界从语义
        # 降维成枚举，才统一得起来。功能机制词（suction cup→adhesive）这类开放语义失真，
        # 代码挡不了，靠"先分析再改写"让模型自觉 + 规格材质闭集兜底客观项。
        ok, missing = _validate_objective(original, refined)
        if not ok:
            return {"refined": original, "changes": "改写丢失规格/材质 %s，已退回原标题" % missing}
        return {"refined": refined, "changes": str(obj.get("changes") or "")}

    def _build_body(self, original, max_len):
        return {
            "model": self.model,
            "messages": [
                {"role": "system", "content":
                    "你是跨境电商标题优化助手，任务是把商品标题改写得与原始表述显著不同但语义等价，"
                    "降低与同源铺货商品的重复度。\n"
                    "请分两步，一次输出：\n"
                    "第一步·分析标题组成：把原标题拆成这几类——品类（product category，如 hook/earbuds/"
                    "water bottle）、功能机制（core function/mechanism，如 suction cup 吸盘、magnetic 磁吸、"
                    "noise cancelling，换了会改变产品本身或核心卖点的词）、材质（material，如 ABS/stainless "
                    "steel）、规格（specs，如 500ml/IPX5/SUV 这类数值型号）、修饰语（modifiers，如 heavy-duty/"
                    "strong/durable/soft/long 这些可自由同义改写的词）。功能机制词和品类词是产品的'是什么'，"
                    "禁止替换为同类但机制不同的词（suction cup 不能变 adhesive，那会改变安装方式属失真）；"
                    "修饰语是'怎么样'，鼓励改写降重。\n"
                    "第二步·改写：基于第一步分析，原样保留品类/功能机制/材质/规格词（可调语序、加修饰），"
                    "只对修饰语做同义改写和语序重组。材质词必须完整保留、不得缩写或简化"
                    "（stainless steel 不能写成 steel，ABS 不能省略——材质是产品重要属性，"
                    "缩写会改变材质认定属失真）。要求不夸大、不堆砌营销词；禁营销违禁词"
                    "（free/sale/best/discount/new 等）；纯英文；不超过 {} 字符；禁中文标点。\n"
                    "只回 JSON：{{\"analysis\":\"<标题组成分析，简述各类词分别是什么>\","
                    "\"refined\":\"<新标题>\",\"changes\":\"<逐项说明改了哪些修饰语/语序，保留了哪些核心词>\"}}。"
                    "无法可靠改写就把 refined 设为原标题。".format(max_len)},
                {"role": "user", "content": "原标题：" + original},
            ],
            "temperature": 0.7,
        }


# 材质闭集：有限可枚举，换了就是错的。客观校验，不靠模型划界。
# 维护：新增材质词加这里即可（闭集，不会无限膨胀）。
_MATERIALS = [
    "stainless steel", "abs", "pc", "pp", "pe", "silicone", "rubber",
    "leather", "cotton", "canvas", "nylon", "polyester", "aluminum", "aluminium",
    "wood", "bamboo", "glass", "ceramic", "copper", "iron", "carbon steel",
]


def _extract_specs(text):
    """从标题提取规格/型号 token：数值+单位（500ml/12v）、IPXX 防水等级、车型/平台型号（SUV/USB-C）。
    用正则客观提取，不靠模型判断。返回小写 token 列表。"""
    import re
    low = text.lower()
    found = set()
    # 数值+单位：500ml / 12v / 30w / 3.5mm / 2.4a 等
    for m in re.findall(r"\d+(?:\.\d+)?\s*(?:ml|l|g|kg|mm|cm|m|v|w|a|mah|hz)\b", low):
        found.add(m.replace(" ", ""))
    # IP 防水等级 IPX5 / IP68
    for m in re.findall(r"\bip\d?[x\d]\w*\b", low):
        found.add(m)
    # 车型/平台型号词（闭集常见）：suv / sedan / truck / usb-c / type-c / bluetooth5 等
    for kw in ["suv", "sedan", "truck", "usb-c", "type-c", "hdmi", "bluetooth 5",
               "bluetooth5", "wifi", "5g", "4g", "1080p", "4k"]:
        if kw in low:
            found.add(kw)
    return sorted(found)


def _validate_objective(original, refined):
    """客观校验：原标题的规格数值与材质闭集，改写后必须仍在。
    只查'换了就一定错'的客观项；动作词/修饰语不在此列，交模型自由改写。
    返回 (ok, missing_tokens)。这是代码兜底，不依赖模型划界。"""
    low_orig = original.lower()
    low_refined = refined.lower()
    missing = []
    for spec in _extract_specs(original):
        if spec not in low_refined:
            missing.append(spec)
    # 材质用词边界匹配，避免短材质词（pc/pe/pp）命中 1pc / ipx / happy 这类子串误伤
    import re
    for mat in _MATERIALS:
        pat = r"\b" + re.escape(mat) + r"\b"
        if re.search(pat, low_orig) and not re.search(pat, low_refined):
            missing.append(mat)
    return (not missing), missing


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
