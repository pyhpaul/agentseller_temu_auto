# tests/test_brain_jsonx.py — extract_decision 容错抽取单测。
# 红线：合法决策的脏包装能还原；真垃圾/拒答 → None（上层据此 escalate，守不变量2）。
from brain.jsonx import extract_decision


def test_plain_json():
    assert extract_decision('{"action":"retry","reason":"x"}') == {"action": "retry", "reason": "x"}


def test_codefence_json():
    assert extract_decision('```json\n{"action":"escalate","reason":"y"}\n```') == {"action": "escalate", "reason": "y"}


def test_codefence_no_lang():
    assert extract_decision('```\n{"action":"retry","reason":"z"}\n```') == {"action": "retry", "reason": "z"}


def test_prose_prefix_suffix():
    assert extract_decision('根据分析，建议：{"action":"retry","reason":"渲染未就绪"} 以上。')["action"] == "retry"


def test_first_balanced_block_with_nested():
    # 嵌套对象不破坏平衡计数
    out = extract_decision('noise {"action":"retry","reason":"a","ctx":{"k":"}"}} tail')
    assert out["action"] == "retry"
    assert out["ctx"] == {"k": "}"}   # 字符串内的 } 不被当块结束


def test_refusal_text_returns_none():
    # 红线（不变量2）：纯拒答/散文无合法 JSON dict → None
    assert extract_decision("I cannot help with that.") is None
    assert extract_decision("作为AI助手我无法判断这个错误。") is None


def test_thinking_no_json_returns_none():
    assert extract_decision("让我想想……这个超时可能是网络问题，也可能是选择器失效。") is None


def test_garbage_returns_none():
    assert extract_decision("") is None
    assert extract_decision(None) is None
    assert extract_decision("{not json}") is None
    assert extract_decision("[1,2,3]") is None        # 非 dict（数组）→ None


def test_single_quotes_not_accepted():
    # 不做宽松反序列化：Python 风格单引号伪 JSON → None（守不变量2，不扩大攻击面）
    assert extract_decision("{'action':'retry'}") is None


def test_multiple_unfenced_blocks_ambiguous_none():
    # 无围栏多决策块（示例/自纠在前、真决策在后）→ 歧义 → None
    # 守不变量2：绝不在多个候选块里猜「首块」，否则会把丢弃的示例当成结论（方向不安全）
    assert extract_decision('Example {"action":"retry"}. Decision: {"action":"escalate","reason":"s"}') is None
    assert extract_decision('First {"action":"retry"}. No: {"action":"escalate"}') is None


def test_fenced_decision_wins_over_prose_example():
    # 围栏块优先：prose 里的示例块不干扰围栏内真决策
    assert extract_decision(
        'Bad example {"action":"retry"}\n```json\n{"action":"escalate","reason":"s"}\n```'
    ) == {"action": "escalate", "reason": "s"}


def test_nonstring_action_value_still_returns_dict():
    # jsonx 只负责抽 dict、不校验 action 类型（白名单 + 类型守卫在 diagnoser）：
    # 单个干净 dict（action 非字符串）仍返回，交 diagnoser 安全处理——不在 jsonx 崩
    assert extract_decision('{"action":1,"reason":"x"}') == {"action": 1, "reason": "x"}
