# 主图优化（发布检查环节）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 或 superpowers:executing-plans 逐 task 实现。步骤用 checkbox。

**Goal:** 框架先行——搭可插拔 ImageProvider 框架 + MockProvider（返回原图占位）+ native_host optimize_image action + check_and_publish content 优化入口；真实 AI 图像服务留 stub，待 API key 接入。

**Architecture:** native_host/handlers/image_optimize.py 定义 provider 接口/注册表/mock/stub（对齐 brain model.py 环境变量选择）；main.py DISPATCH 挂 optimize_image（惰性 import）；check_and_publish content 加优化入口（对称标题润色：按钮+对比+采用注入轮播图+写后读）+ feature.json 加 nativeMessaging。

**Tech Stack:** native_host（Python，PIL 已有、urllib 标准库）、check_and_publish content（JS）、pytest + node --check。

**Spec:** `docs/superpowers/specs/2026-06-17-main-image-optimize-on-publish-design.md`

**测试 import 注意:** native_host 非包（无 __init__.py），测试文件用 `sys.path.insert(0, '../native_host')` 后 `from handlers import image_optimize`（无现成 native 测试基建，本 plan 首次建）。

**与 title-refine 冲突提示:** Task 3 改 check_and_publish content 的 renderPassed（与 PR #80 同区域）。**实现 Task 3 前 #80 应已 merge**，基于含「润色标题」按钮的 renderPassed 再加「优化主图」按钮；否则 merge 冲突需手解。

**不变量:** mock 未配 key 时返回原图、UI/链路端到端可跑；失败/未接入保留原图、不阻断发布；不静默替换主图（唯一入口人工确认后 capApplyImage）；真实 provider stub 抛 NotImplementedError（不假成功）。

---

## 文件结构

| 文件 | 责任 | 改动 |
|------|------|------|
| `native_host/handlers/image_optimize.py`（新） | provider 框架 + 下载 + handle | 新建 |
| `native_host/main.py` | DISPATCH 注册 | 加 `'optimize_image'`（惰性 import） |
| `tests/test_image_optimize.py`（新） | provider/handle 单测 | 新建（sys.path 注入 native_host） |
| `features/check_and_publish/content/index.js` | 优化入口 + 对比 + 上传 + 写后读 | 加 capOptimizeImage/capApplyImage + panel 按钮 |
| `features/check_and_publish/feature.json` | 权限 | permissions 加 `nativeMessaging` |

---

## Task 1: native_host/handlers/image_optimize.py — provider 框架 + handle

**Files:**
- Create: `native_host/handlers/image_optimize.py`
- Test: `tests/test_image_optimize.py`

- [ ] **Step 1: 写失败测试**

`tests/test_image_optimize.py`：

```python
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
```

- [ ] **Step 2: 跑测试验证失败**

Run: `python3 -m pytest tests/test_image_optimize.py -q`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 native_host/handlers/image_optimize.py**

```python
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
```

- [ ] **Step 4: 跑测试验证通过**

Run: `python3 -m pytest tests/test_image_optimize.py -q`
Expected: PASS（9 用例）

- [ ] **Step 5: Commit**

```bash
git add native_host/handlers/image_optimize.py tests/test_image_optimize.py
git commit -m "feat(native_host): 主图优化 provider 框架 + mock（真实服务 stub 待 API key）"
```

---

## Task 2: native_host/main.py — DISPATCH 注册 optimize_image

**Files:**
- Modify: `native_host/main.py`

native handler 测试基建不足（file_ops import tkinter，pytest 环境难 import main）→ 本 task 靠 `py_compile` 语法 + Task 1 已覆盖 handle 逻辑；DISPATCH 注册是一行 + 惰性 import 函数（对齐 `_generate_label`），低风险。

- [ ] **Step 1: 实现**

加惰性 import 函数（仿 `_generate_label`）：
```python
def _optimize_image(msg: dict) -> dict:
    """主图优化，惰性 import image_optimize（urllib 下载 + 可插拔 provider，对齐 _generate_label 惰性）。"""
    from handlers import image_optimize
    return image_optimize.handle(msg)
```

DISPATCH 加一条：
```python
    'optimize_image': _optimize_image,
```

- [ ] **Step 2: 语法验证**

Run: `python3 -m py_compile native_host/main.py && echo OK`
Expected: OK

- [ ] **Step 3: SW 透传确认（只读，必要才改）**

`core/background/service-worker.js` 的 native 透传是否按 action 白名单放行？若有白名单，加 `optimize_image`；若通用透传（任意 action 转 native）则无需改。**只读确认。**

- [ ] **Step 4: Commit**

```bash
git add native_host/main.py
git commit -m "feat(native_host): main DISPATCH 注册 optimize_image（惰性 import）"
```

---

## Task 3: check_and_publish content — 优化入口 + 上传 + 写后读 + 权限

**Files:**
- Modify: `features/check_and_publish/content/index.js`
- Modify: `features/check_and_publish/feature.json`（permissions 加 nativeMessaging）

⚠ **前置**：PR #80（标题润色）应已 merge——本 task 在含「润色标题」按钮的 renderPassed 上加「优化主图」按钮，否则同区域冲突。content 跨进程/DOM 逻辑靠 e2e + node --check。

- [ ] **Step 1: feature.json 加权限**

```json
  "permissions": ["storage", "nativeMessaging"],
```

- [ ] **Step 2: 加优化核心函数**（仿标题润色 capRefineTitle/capApplyTitle）

```js
// ─── 主图优化（保留主体换背景降重，走 native host provider；spec 2026-06-17）──────
// 读轮播图主图 url → sendNative('optimize_image') → 收 image_b64。失败/未接入 → 保留原图（不阻断）。
async function capOptimizeImage() {
  const imgs = getCarouselImagesField();
  const first = imgs.value && imgs.value[0];
  if (!first || !first.src) return { available: false, error: '读取失败：未找到主图' };
  let resp;
  try {
    resp = await window.AgentSeller.sendNative('optimize_image', { imageUrl: first.src, options: {} });
  } catch (e) {
    return { available: false, error: '优化不可用：' + ((e && e.message) || e) + '，保留原图' };
  }
  if (!resp || !resp.success) return { available: false, error: (resp && resp.error) || '优化失败，保留原图' };
  return { available: true, originalSrc: first.src, imageB64: resp.image_b64 };
}

// 采用：base64 → File → 注入轮播图上传 input[type=file]（仿 auto_gen_label Phase3 injectFilesToInput）
// + 写后读校验（轮播图新增/替换该图）。
// ⚠ 上传控件精确 selector（店小秘轮播图 input[type=file]/rocket-upload）实现阶段 dump
//   samples/total_dom.txt + 现场 DOM 定位（对齐项目「改 selector 前 dump 真实 DOM」铁律）。
async function capApplyImage(imageB64) {
  const file = b64ToFile(imageB64, 'main-image.png', 'image/png');
  const input = findCarouselUploadInput();         // ← 实现阶段按真实 DOM 定位
  if (!input) return { ok: false, error: '读取失败：未找到轮播图上传控件' };
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // 写后读：等轮播图列表出现新图（数量+1 或目标位替换），超时报数据校验
  const ok = await waitCarouselUpdated();          // ← 实现阶段定就绪信号
  return ok ? { ok: true } : { ok: false, error: '数据校验：主图替换未生效，请重试' };
}

function b64ToFile(b64, name, mime) {
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: mime });
}
```

- [ ] **Step 3: 优化交互 + panel 按钮**

`onOptimizeImage(viewEl, btn)`（仿 onRefineTitle）→ capOptimizeImage → `renderImageCompare`（原图/优化图两 `<img>` 并排 + 采用/放弃）→ 采用调 capApplyImage → toast + 提示重新检查。
renderPassed 在「润色标题」按钮后加「🖼 优化主图」按钮。

- [ ] **Step 4: 语法检查**

Run: `node --check features/check_and_publish/content/index.js`
Expected: 无输出（OK）

- [ ] **Step 5: Commit**

```bash
git add features/check_and_publish/content/index.js features/check_and_publish/feature.json
git commit -m "feat(check_and_publish): 主图优化 feature 手动入口（content 优化+对比+注入轮播图+写后读）"
```

---

## 完成验证清单

- [ ] `python3 -m pytest tests/ -q` 全绿（+ image_optimize 9 用例）
- [ ] `python3 -m py_compile native_host/main.py` OK
- [ ] `node --check` content OK
- [ ] `python3 build/build_extension.py` 成功（feature.json nativeMessaging 聚合进 manifest）
- [ ] 端到端（人工 gated，**mock provider，无需 API key**）：
  - [ ] 店小秘编辑页检查通过 → 点「优化主图」→ mock 返回原图 → 原/优化对比卡 → 采用 → 轮播图替换 + 写后读通过（验证 UI/native/注入全链路）
  - [ ] native host 未注册 → 提示「优化不可用」，保留原图，发布照常
  - [ ] 配 `IMAGE_PROVIDER=tongyi`（无 key 实现）→ 提示「主图优化待接入」（验证 stub 路径）

## Spec 覆盖自查

| spec 节 | 落地 task |
|---|---|
| §4 可插拔 provider 框架（接口/注册表/mock/stub） | Task 1 |
| §5 native_host handle（下载/provider/base64） | Task 1 + Task 2（DISPATCH） |
| §6 content UI（按钮/对比/采用注入/写后读） | Task 3 |
| §7 数据流（源图 url / 结果回传） | Task 1（下载）+ Task 3（注入） |
| §8 权限 nativeMessaging | Task 3 Step 1 |
| §9 HITL + 错误分层 | Task 3（读取/数据校验）+ Task 1（业务降级 stub） |
| §11 测试（provider 选择/mock/stub/handle） | Task 1 + 验证清单 |
