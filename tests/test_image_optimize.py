# tests/test_image_optimize.py — 主图优化 provider 框架 + handle 单测（框架先行，mock 路径）。
import os, sys, base64
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "native_host"))
from handlers import image_optimize as io


def test_default_provider_is_mock(monkeypatch):
    monkeypatch.delenv("IMAGE_PROVIDER", raising=False)
    assert isinstance(io._select_provider(), io.MockProvider)


def test_env_selects_real_provider(monkeypatch):
    monkeypatch.setenv("IMAGE_PROVIDER", "tongyi")
    monkeypatch.setenv("IMAGE_API_KEY", "k")
    assert isinstance(io._select_provider(), io.TongyiProvider)


def test_unknown_provider_falls_back_mock(monkeypatch):
    monkeypatch.setenv("IMAGE_PROVIDER", "nonexist")
    assert isinstance(io._select_provider(), io.MockProvider)


def test_mock_returns_original_bytes():
    data = b"\x89PNG fake"
    assert io.MockProvider().replace_background(data, {}) == data


def test_real_provider_stub_raises():
    with pytest.raises(NotImplementedError):
        io.TongyiProvider("k").replace_background(b"x", {})


def test_handle_missing_url():
    out = io.handle({"action": "optimize_image"})
    assert out["success"] is False and "imageUrl" in out["error"]


def test_handle_mock_success(monkeypatch):
    monkeypatch.delenv("IMAGE_PROVIDER", raising=False)
    monkeypatch.setattr(io, "_download", lambda url: b"\x89PNG raw")
    out = io.handle({"action": "optimize_image", "imageUrl": "https://x/img.png", "options": {}})
    assert out["success"] is True
    assert base64.b64decode(out["image_b64"]) == b"\x89PNG raw"   # mock 返回原图


def test_handle_download_failure(monkeypatch):
    monkeypatch.setattr(io, "_download", lambda url: (_ for _ in ()).throw(RuntimeError("net down")))
    out = io.handle({"action": "optimize_image", "imageUrl": "https://x"})
    assert out["success"] is False and "下载失败" in out["error"]


def test_handle_provider_not_implemented(monkeypatch):
    monkeypatch.setenv("IMAGE_PROVIDER", "tongyi")
    monkeypatch.setenv("IMAGE_API_KEY", "k")
    monkeypatch.setattr(io, "_download", lambda url: b"raw")
    out = io.handle({"action": "optimize_image", "imageUrl": "https://x"})
    assert out["success"] is False and "待接入" in out["error"]   # 友好提示，不假成功
