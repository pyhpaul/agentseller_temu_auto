# tests/test_brain_refiner.py — 标题润色单测。安全红线：模型挂/垃圾/无 refined → 退回原标题（不编造）。
from brain.refiner import refine_title
from brain.model import MockModel

ORIG = "Wireless Bluetooth Earbuds Noise Cancelling"


def test_parses_refined():
    m = MockModel(canned='{"refined":"Noise-Cancelling Wireless Bluetooth Earphones","changes":"语序+同义","confidence":0.8}')
    out = refine_title(ORIG, {}, m)
    assert out["refined"] == "Noise-Cancelling Wireless Bluetooth Earphones"
    assert out["confidence"] == 0.8


def test_codefenced_parse():
    m = MockModel(canned='```json\n{"refined":"BT Earbuds ANC Wireless","changes":"r"}\n```')
    assert refine_title(ORIG, {}, m)["refined"] == "BT Earbuds ANC Wireless"


def test_model_exception_returns_original():
    class Boom:
        def decide(self, m, tools=None):
            raise RuntimeError("down")
    out = refine_title(ORIG, {}, Boom())
    assert out["refined"] == ORIG          # 退回原标题，不编造
    assert out["confidence"] == 0.0


def test_garbage_returns_original():
    assert refine_title(ORIG, {}, MockModel(canned="I cannot help"))["refined"] == ORIG


def test_no_refined_field_returns_original():
    # 默认 MockModel 产诊断式 {"action":...}，无 refined → 退回原标题
    assert refine_title(ORIG, {}, MockModel())["refined"] == ORIG


def test_empty_original():
    out = refine_title("", {}, MockModel())
    assert out["refined"] == ""
    assert out["confidence"] == 0.0


def test_only_string_refined_accepted():
    # refined 非字符串（如数字）→ 退回原标题
    m = MockModel(canned='{"refined":123,"changes":"x"}')
    assert refine_title(ORIG, {}, m)["refined"] == ORIG
