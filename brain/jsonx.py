# brain/jsonx.py — 容错抽取模型决策 JSON（接真实模型用，spec Plan3 §3.2/§6）。
# 真实/本地/便宜模型常把决策 JSON 包在 ```围栏``` 或前后散文里；直接 json.loads 会失败。
# 本 helper 只剥【表面形态】（围栏 + 定位首个平衡花括号块），不放宽语义：
#   抓不到能 json.loads 成 dict 的块 → None（上层据此安全 escalate，守不变量2「真垃圾→转人工」）。
# 绝不做单引号/尾逗号/ast 宽松反序列化——那会把拒答/思考误读成决策（扩大攻击面）。
import json
import re

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def _balanced_objects(text):
    """返回所有【顶层】平衡花括号块子串（跳过字符串内括号 + 转义）。"""
    blocks = []
    n = len(text)
    start = text.find("{")
    while start != -1:
        depth = 0
        in_str = False
        esc = False
        end = -1
        for i in range(start, n):
            c = text[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        end = i
                        break
        if end == -1:
            break                                # 余下无完整顶层块
        blocks.append(text[start:end + 1])
        start = text.find("{", end + 1)          # 从本块之后找下一个顶层块
    return blocks


def _as_dict(s):
    """str → dict（json.loads 成功且是 dict）或 None。"""
    try:
        obj = json.loads(s)
    except (ValueError, TypeError):
        return None
    return obj if isinstance(obj, dict) else None


def extract_decision(text):
    """脏文本 → 决策 dict 或 None。只接受能 json.loads 成 dict 的内容。"""
    if not isinstance(text, str) or not text.strip():
        return None
    # 1) 干净结构优先：围栏内 / 整串纯 JSON（模型给了明确结构，最可信）
    m = _FENCE.search(text)
    if m:
        obj = _as_dict(m.group(1).strip())
        if obj is not None:
            return obj
    obj = _as_dict(text.strip())
    if obj is not None:
        return obj
    # 2) 散文嵌入块：唯一才信；多个 → 歧义 → None
    #    守不变量2：绝不在多个候选块里猜「首块」，否则丢弃的示例/自纠会被当成结论（方向不安全）。
    dicts = [d for d in (_as_dict(b) for b in _balanced_objects(text)) if d is not None]
    return dicts[0] if len(dicts) == 1 else None
