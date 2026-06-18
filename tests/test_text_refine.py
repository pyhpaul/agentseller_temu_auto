# tests/test_text_refine.py — 标题润色 native provider 单测（员工可用，走 native host 调 LLM）。
# 安全红线：无 key→mock 返原标题；LLM 调用失败/解析不出→退回原标题（不编造、不阻断）。
import os, sys
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "native_host"))
from handlers import text_refine as tr
import config


@pytest.fixture(autouse=True)
def _isolate_config_path(tmp_path, monkeypatch):
    """隔离 LLM 配置文件到 tmp_path，避免读到开发者机器上的真实 llm_config.json
    导致 _select_provider 意外走 OpenAICompatProvider（test_mock 类测试会 flaky）。"""
    monkeypatch.setattr(config, "_config_path",
                        lambda: str(tmp_path / "llm_config.json"))


def test_mock_default_no_env(monkeypatch):
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    assert isinstance(tr._select_provider(), tr.MockTextProvider)


def test_select_openai_with_env(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "https://api.x/v1")
    monkeypatch.setenv("LLM_API_KEY", "k")
    assert isinstance(tr._select_provider(), tr.OpenAICompatProvider)


def test_mock_returns_original():
    assert tr.MockTextProvider().refine("Orig Title", {})["refined"] == "Orig Title"


def test_extract_json_plain():
    assert tr._extract_json('{"refined":"Y","changes":"c"}')["refined"] == "Y"


def test_extract_json_codefenced():
    assert tr._extract_json('```json\n{"refined":"Z"}\n```')["refined"] == "Z"


def test_extract_json_garbage():
    assert tr._extract_json("no json here") is None


def test_handle_empty_original():
    out = tr.handle({"original": ""})
    assert out["success"] is True and out["refined"] == ""


def test_handle_mock_success(monkeypatch):
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    out = tr.handle({"original": "Old Title", "constraints": {"maxLen": 250}})
    assert out["success"] is True and out["refined"] == "Old Title"


def test_openai_provider_parses(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "https://api.x/v1")
    monkeypatch.setenv("LLM_API_KEY", "k")
    monkeypatch.setattr(tr.OpenAICompatProvider, "_post",
        lambda self, body: {"choices": [{"message": {"content": '{"refined":"New Title","changes":"语序"}'}}]})
    out = tr.handle({"original": "Old Title", "constraints": {}})
    assert out["success"] is True and out["refined"] == "New Title"


def test_handle_exception_returns_original(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "https://api.x/v1")
    monkeypatch.setenv("LLM_API_KEY", "k")
    def boom(self, body):
        raise RuntimeError("net down")
    monkeypatch.setattr(tr.OpenAICompatProvider, "_post", boom)
    out = tr.handle({"original": "Keep This", "constraints": {}})
    assert out["success"] is True and out["refined"] == "Keep This"   # 退回原标题、不阻断


# --- objective 校验：规格数值 + 材质闭集客观兜底，不靠模型划界 ---

def test_extract_specs_numeric_units():
    specs = set(tr._extract_specs("500ml Bottle with 12v Plug and IPX5"))
    assert "500ml" in specs and "12v" in specs and "ipx5" in specs


def test_extract_specs_vehicle_models():
    specs = set(tr._extract_specs("Universal for SUV Truck Sedan"))
    assert "suv" in specs and "sedan" in specs and "truck" in specs


def test_validate_objective_specs_preserved():
    ok, missing = tr._validate_objective(
        "500ml IPX5 Earbuds", "Refined 500ml Earbuds IPX5 Rated")
    assert ok is True and missing == []


def test_validate_objective_spec_missing():
    ok, missing = tr._validate_objective("500ml Bottle", "Refined Bottle No Capacity")
    assert ok is False and "500ml" in missing


def test_validate_objective_material_missing():
    # 材质词丢失 → 挡
    ok, missing = tr._validate_objective(
        "Stainless Steel Bottle", "Premium Iron Bottle")
    assert ok is False and any("stainless steel" in m for m in missing)


def test_validate_objective_material_preserved():
    ok, missing = tr._validate_objective(
        "ABS Plastic Hook", "Robust ABS Hook")
    assert ok is True and missing == []


def test_validate_objective_no_specs_passes():
    # 无规格无材质 → 无客观项，放过（交模型自由改）
    ok, missing = tr._validate_objective(
        "Heavy Duty Hook", "Robust Strong Hook")
    assert ok is True and missing == []


def test_validate_objective_pc_not_false_positive():
    # 1pc 里的 pc 不能被当成材质 PC 误伤（词边界匹配）
    ok, missing = tr._validate_objective(
        "1pc Car Armrest Pad", "1pc Vehicle Armrest Cushion")
    assert ok is True and missing == []


def test_validate_objective_real_pc_material_caught():
    # 真正的 PC 材质词丢失要挡得住
    ok, missing = tr._validate_objective(
        "PC Plastic Phone Case", "Silicone Phone Case")
    assert ok is False and "pc" in missing


def test_refine_objective_violation_returns_original(monkeypatch):
    """改写丢失规格 500ml → 代码校验退回原标题。"""
    monkeypatch.setenv("LLM_BASE_URL", "https://api.x/v1")
    monkeypatch.setenv("LLM_API_KEY", "k")
    monkeypatch.setattr(tr.OpenAICompatProvider, "_post",
        lambda self, body: {"choices": [{"message": {"content":
            '{"analysis":"...","refined":"Refined Bottle No Capacity","changes":"改了修饰语"}'}}]})
    out = tr.handle({"original": "500ml Water Bottle", "constraints": {}})
    assert out["success"] is True
    assert out["refined"] == "500ml Water Bottle"   # 规格丢失被挡
    assert "500ml" in out["changes"]


def test_refine_objective_honored_passes(monkeypatch):
    """改写保留规格材质 → 放行 refined。"""
    monkeypatch.setenv("LLM_BASE_URL", "https://api.x/v1")
    monkeypatch.setenv("LLM_API_KEY", "k")
    monkeypatch.setattr(tr.OpenAICompatProvider, "_post",
        lambda self, body: {"choices": [{"message": {"content":
            '{"analysis":"...","refined":"Premium 500ml ABS Bottle","changes":"改了修饰语"}'}}]})
    out = tr.handle({"original": "500ml ABS Water Bottle", "constraints": {}})
    assert out["success"] is True
    assert out["refined"] == "Premium 500ml ABS Bottle"
