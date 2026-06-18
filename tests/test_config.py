# tests/test_config.py — LLM key 配置源（DPAPI 加密存本机）单测。
# 安全红线：get_llm_config_status 绝不回 key 明文；未配置返回 None；存读对称。
import os, sys, json, base64
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "native_host"))
import config


def _patch_path(monkeypatch, tmp_path):
    """隔离配置文件到 tmp_path，避免污染真实文件系统。"""
    cfg_file = str(tmp_path / "llm_config.json")
    monkeypatch.setattr(config, "_config_path", lambda: cfg_file)
    return cfg_file


def test_unset_returns_none(monkeypatch, tmp_path):
    _patch_path(monkeypatch, tmp_path)
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    assert config.get_llm_config() is None


def test_status_unset_not_configured(monkeypatch, tmp_path):
    _patch_path(monkeypatch, tmp_path)
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    st = config.get_llm_config_status()
    assert st["success"] is True and st["configured"] is False


def test_set_then_get_roundtrip(monkeypatch, tmp_path):
    _patch_path(monkeypatch, tmp_path)
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    r = config.set_llm_config("https://api.x/v1", "secret-key-123", "glm-4-plus")
    assert r["success"] is True
    c = config.get_llm_config()
    assert c is not None
    assert c["base_url"] == "https://api.x/v1"
    assert c["api_key"] == "secret-key-123"
    assert c["model"] == "glm-4-plus"


def test_status_after_set_no_key_leak(monkeypatch, tmp_path):
    """get_llm_config_status 只回 configured + model，绝不回 key 明文。"""
    _patch_path(monkeypatch, tmp_path)
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    config.set_llm_config("https://api.x/v1", "secret-key-123", "glm-4-plus")
    st = config.get_llm_config_status()
    assert st["configured"] is True
    assert st["model"] == "glm-4-plus"
    s = json.dumps(st)
    assert "secret-key-123" not in s   # key 明文不进 status


def test_key_not_plaintext_on_disk(monkeypatch, tmp_path):
    """落盘文件不能含 key 明文（DPAPI 或 base64，非明文）。"""
    cfg_file = _patch_path(monkeypatch, tmp_path)
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    config.set_llm_config("https://api.x/v1", "secret-key-123", "glm-4-plus")
    raw = open(cfg_file, encoding="utf-8").read()
    assert "secret-key-123" not in raw   # 明文不落盘


def test_set_rejects_empty(monkeypatch, tmp_path):
    _patch_path(monkeypatch, tmp_path)
    r = config.set_llm_config("", "k", "m")
    assert r["success"] is False
    r = config.set_llm_config("b", "", "m")
    assert r["success"] is False


def test_clear(monkeypatch, tmp_path):
    _patch_path(monkeypatch, tmp_path)
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    config.set_llm_config("https://api.x/v1", "k", "m")
    assert config.get_llm_config() is not None
    r = config.clear_llm_config()
    assert r["success"] is True
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    assert config.get_llm_config() is None


def test_default_model_when_blank(monkeypatch, tmp_path):
    _patch_path(monkeypatch, tmp_path)
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    config.set_llm_config("https://api.x/v1", "k", "")
    assert config.get_llm_config()["model"] == "glm-4-plus"


def test_env_fallback(monkeypatch, tmp_path):
    """无本地配置时退化读环境变量（开发期兼容）。"""
    _patch_path(monkeypatch, tmp_path)
    monkeypatch.setenv("LLM_BASE_URL", "https://env.x/v1")
    monkeypatch.setenv("LLM_API_KEY", "env-key")
    monkeypatch.setenv("LLM_MODEL", "env-model")
    c = config.get_llm_config()
    assert c["base_url"] == "https://env.x/v1"
    assert c["api_key"] == "env-key"
    assert c["model"] == "env-model"


def test_local_config_preferred_over_env(monkeypatch, tmp_path):
    """本地配置优先于环境变量。"""
    _patch_path(monkeypatch, tmp_path)
    monkeypatch.setenv("LLM_BASE_URL", "https://env.x/v1")
    monkeypatch.setenv("LLM_API_KEY", "env-key")
    config.set_llm_config("https://local.x/v1", "local-key", "local-model")
    c = config.get_llm_config()
    assert c["base_url"] == "https://local.x/v1"
    assert c["api_key"] == "local-key"


def test_non_windows_plaintext_fallback_roundtrip(monkeypatch, tmp_path):
    """非 Windows 无 DPAPI → 明文 base64 存，仍能存读对称（开发期路径）。"""
    _patch_path(monkeypatch, tmp_path)
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.setattr(config, "_dpapi_available", lambda: False)
    config.set_llm_config("https://api.x/v1", "plain-key", "m")
    c = config.get_llm_config()
    assert c["api_key"] == "plain-key"


def test_corrupt_config_returns_none(monkeypatch, tmp_path):
    """配置文件损坏 → 不抛异常，返回 None（退化 env / mock）。"""
    cfg_file = _patch_path(monkeypatch, tmp_path)
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    with open(cfg_file, "w", encoding="utf-8") as f:
        f.write("not json{{{")
    assert config.get_llm_config() is None
