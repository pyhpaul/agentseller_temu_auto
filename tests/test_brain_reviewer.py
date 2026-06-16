# tests/test_brain_reviewer.py — 不可逆复核单测。fail-safe 红线：模型挂/垃圾/verdict 非法 → hold（绝不假 pass）。
from brain.reviewer import review
from brain.model import MockModel


def _ctx():
    return {"pageSnapshot": "page text"}


def test_pass_parsed():
    m = MockModel(canned='{"verdict":"pass","reason":"ok","concerns":[]}')
    assert review("ship", {"skc": "S1"}, _ctx(), m)["verdict"] == "pass"


def test_hold_with_concerns():
    m = MockModel(canned='{"verdict":"hold","reason":"skc空","concerns":["skc 缺失"]}')
    out = review("gen_label", {"skc": ""}, _ctx(), m)
    assert out["verdict"] == "hold"
    assert "skc 缺失" in out["concerns"]


def test_codefenced_verdict():
    m = MockModel(canned='```json\n{"verdict":"pass","reason":"r"}\n```')
    assert review("ship", {}, _ctx(), m)["verdict"] == "pass"


def test_verdict_case_normalized():
    m = MockModel(canned='{"verdict":" PASS ","reason":"r"}')
    assert review("ship", {}, _ctx(), m)["verdict"] == "pass"


def test_model_exception_holds():   # fail-safe 红线
    class Boom:
        def decide(self, m, tools=None):
            raise RuntimeError("down")
    assert review("ship", {}, _ctx(), Boom())["verdict"] == "hold"


def test_garbage_holds():   # fail-safe 红线
    assert review("ship", {}, _ctx(), MockModel(canned="I cannot review"))["verdict"] == "hold"


def test_illegal_verdict_holds():   # fail-safe 红线：verdict 非 pass/hold → hold（绝不默认 pass）
    assert review("ship", {}, _ctx(), MockModel(canned='{"verdict":"approve"}'))["verdict"] == "hold"


def test_diagnosis_style_holds():   # 默认 MockModel 产 {"action":...} 无 verdict → hold
    assert review("ship", {}, _ctx(), MockModel())["verdict"] == "hold"


def test_empty_snapshot_holds_deterministically_without_model():
    # 复核在执行前跑、目标页未打开 → 空快照。不调模型（弱模型会乱编"页面快照未提供"），
    # 确定性 hold + 可操作理由（让人工确认字段后放行）。
    called = {"n": 0}

    class Spy:
        def decide(self, messages, tools=None):
            called["n"] += 1
            return '{"verdict":"pass"}'

    out = review("gen_label", {"skc": "S1"}, {"pageSnapshot": ""}, Spy())
    assert out["verdict"] == "hold"
    assert "人工" in out["reason"] and "确认" in out["reason"]   # 可操作指引
    assert called["n"] == 0                                      # 空快照不调模型


def test_missing_snapshot_key_holds_deterministically():
    out = review("ship", {"skc": "S1"}, {}, MockModel(canned='{"verdict":"pass"}'))
    assert out["verdict"] == "hold"
    assert "人工" in out["reason"]
