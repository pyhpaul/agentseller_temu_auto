# tests/test_brain_filler.py — 回填提议单测。空提议红线：模型挂/垃圾/诊断式输出 → values 为空（不编造，守不变量2）。
from brain.filler import suggest
from brain.model import MockModel

FIELDS = [{"key": "url1688", "label": "1688 货源链接", "fieldType": "text", "required": True}]


def _ctx():
    return {"product": {"label": "A"}, "recentSteps": [], "pageSnapshot": "some 1688 page text"}


def test_parses_fill_values():
    m = MockModel(canned='{"values":{"url1688":"https://x.1688.com/a"},"reason":"匹配","confidence":0.8}')
    out = suggest("compare_1688", FIELDS, _ctx(), m)
    assert out["values"]["url1688"] == "https://x.1688.com/a"
    assert out["confidence"] == 0.8


def test_codefenced_values_parse():
    m = MockModel(canned='```json\n{"values":{"url1688":"https://y.1688.com/b"},"reason":"r"}\n```')
    assert suggest("compare_1688", FIELDS, _ctx(), m)["values"]["url1688"] == "https://y.1688.com/b"


def test_model_exception_empty_no_fabricate():
    class Boom:
        def decide(self, m, tools=None):
            raise RuntimeError("down")
    assert suggest("compare_1688", FIELDS, _ctx(), Boom())["values"] == {}


def test_garbage_empty():
    assert suggest("compare_1688", FIELDS, _ctx(), MockModel(canned="I cannot help"))["values"] == {}


def test_diagnosis_style_output_yields_empty():
    # 默认 MockModel 产诊断式 {"action":...}，无 values → 空提议（退回人工）
    assert suggest("compare_1688", FIELDS, _ctx(), MockModel())["values"] == {}


def test_only_requested_keys_kept():
    m = MockModel(canned='{"values":{"url1688":"https://x.1688.com/a","evil":"x"},"reason":"r"}')
    assert "evil" not in suggest("compare_1688", FIELDS, _ctx(), m)["values"]


def test_empty_string_value_ignored():
    m = MockModel(canned='{"values":{"url1688":"  "},"reason":"r"}')
    assert suggest("compare_1688", FIELDS, _ctx(), m)["values"] == {}
