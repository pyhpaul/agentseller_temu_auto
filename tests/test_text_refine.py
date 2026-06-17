# tests/test_text_refine.py — 标题润色 native provider 单测（员工可用，走 native host 调 LLM）。
# 安全红线：无 key→mock 返原标题；LLM 调用失败/解析不出→退回原标题（不编造、不阻断）。
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "native_host"))
from handlers import text_refine as tr


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
