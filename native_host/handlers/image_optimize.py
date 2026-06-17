# native_host/handlers/image_optimize.py — 主图优化（保留主体换背景）。框架先行：可插拔 provider。
# provider 选择对齐 brain/model.py（环境变量 IMAGE_PROVIDER 选、IMAGE_API_KEY 鉴权；未配→mock）。
# 真实服务（通义万相/即梦/Photoroom）待 API key，实现 replace_background 即可，不动 UI/native/content。
import os
import base64
import urllib.request

_DOWNLOAD_TIMEOUT = 30


class MockProvider:
    """框架占位：返回原图（不改），让 UI/native action 端到端可跑，无需 API key。"""
    def replace_background(self, image_bytes, options):
        return image_bytes


class TongyiProvider:        # stub，待 API key（阿里通义万相图像背景生成：需抠图 RGBA → 背景生成）
    def __init__(self, api_key):
        self.api_key = api_key

    def replace_background(self, image_bytes, options):
        raise NotImplementedError("通义万相 provider 待接入：配 IMAGE_API_KEY 后实现 replace_background")


class JimengProvider:        # stub，待 API key（字节即梦图生图3.0：替换背景一体化指令）
    def __init__(self, api_key):
        self.api_key = api_key

    def replace_background(self, image_bytes, options):
        raise NotImplementedError("即梦 provider 待接入：配 IMAGE_API_KEY 后实现 replace_background")


class PhotoroomProvider:     # stub，待 API key（Photoroom 电商换背景一体化）
    def __init__(self, api_key):
        self.api_key = api_key

    def replace_background(self, image_bytes, options):
        raise NotImplementedError("Photoroom provider 待接入：配 IMAGE_API_KEY 后实现 replace_background")


PROVIDERS = {
    "mock": MockProvider,
    "tongyi": TongyiProvider,
    "jimeng": JimengProvider,
    "photoroom": PhotoroomProvider,
}


def _select_provider():
    name = (os.environ.get("IMAGE_PROVIDER", "mock") or "mock").strip()
    cls = PROVIDERS.get(name, MockProvider)
    if cls is MockProvider:
        return MockProvider()
    return cls(os.environ.get("IMAGE_API_KEY", ""))


def _download(url):
    with urllib.request.urlopen(url, timeout=_DOWNLOAD_TIMEOUT) as r:
        return r.read()


def handle(msg):
    """optimize_image：下载源图 → provider 换背景 → 回 base64。
    入参 {action, imageUrl, options}；出参 {success, image_b64} / {success:false, error}。"""
    image_url = msg.get("imageUrl")
    if not image_url:
        return {"success": False, "error": "缺 imageUrl"}
    try:
        src = _download(image_url)
    except Exception as e:
        return {"success": False, "error": "源图下载失败：%s" % e}
    try:
        out = _select_provider().replace_background(src, msg.get("options") or {})
    except NotImplementedError as e:
        return {"success": False, "error": "主图优化待接入：%s" % e}
    except Exception as e:
        return {"success": False, "error": "图像处理失败：%s" % e}
    return {"success": True, "image_b64": base64.b64encode(out).decode("ascii")}
