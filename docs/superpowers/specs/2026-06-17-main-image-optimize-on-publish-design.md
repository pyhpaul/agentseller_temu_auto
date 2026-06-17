# 主图优化（发布检查环节）设计文档

> 日期：2026-06-17
> 状态：设计待 review
> 范围：check_and_publish feature + native_host（图像处理 handler）。**框架先行**：本期搭可插拔 provider 框架 + mock 实现 + UI + native action，真实 AI 图像服务待 API key 后接入。

## 1. 背景与问题

铺货商品主图常与源/同款雷同 → 平台判重/降权。需在**发布检查环节**加「主图优化」：**保留商品主体内容、更新背景**（抠图保留主体 + AI 重绘/替换背景），降低与源图重复度。

项目**零图像生成能力**（brain 是文本 LLM；native_host 仅 bartender 有 PIL 简单合成）。「保留主体换背景」必须接外部 AI 图像服务（通义万相/即梦/Photoroom 等，2026 调研见对话）。**用户策略：框架先行，服务后接**——本期把可插拔 provider 框架、UI、native action、mock provider 全搭好，能端到端跑通流程（mock 返回原图占位），后续给 API key 只需填一个 provider 实现。

**对齐既有模式**：完全对称 brain 的 `model.py`（配 `BRAIN_LLM_BASE_URL` 用真模型、否则 MockModel）——本设计 native_host 用 `IMAGE_PROVIDER`/`IMAGE_API_KEY` 环境变量选 provider，未配则 mock。

## 2. 目标 / 非目标

**目标（本期框架）**
- 可插拔 `ImageProvider` 框架（接口 + 注册表 + 环境变量选 provider）。
- `MockProvider`：返回原图（或加可辨识占位背景标记），让 UI + native action 端到端可跑，**无需任何 API key**。
- native_host 新 action `optimize_image`：下载源图 → 调 provider → 回结果图 base64。
- check_and_publish content：检查环节「优化主图」按钮 + 原/优化图对比 + 人工确认 → 注入轮播图上传控件 + 写后读。
- 真实 provider 留 **stub + TODO**（接口齐全、实现抛 `NotImplementedError` 或友好提示「未配置 API key」）。

**非目标（本期不做）**
- 真实 AI 图像服务实现（待 API key；接入只填 provider）。
- 抠图算法/背景重绘质量调优。
- 标题润色（独立 spec，已做）。
- 多张轮播图批量优化（本期先主图单张，多张留后续）。

## 3. 架构

```
[check_and_publish content]  读轮播图主图 url（getCarouselImagesField 已有）
        │ sendNative('optimize_image', {imageUrl, options})
        ▼
[SW]  透传 → native host（core 已有 native 透传路由）
        ▼
[native_host/handlers/image_optimize.py]
        下载源图(urllib) → PROVIDERS[选中].replace_background(bytes, options) → 结果图 base64
        provider 选择：env IMAGE_PROVIDER（未配→mock）；鉴权 IMAGE_API_KEY
        ◀── { success, image_b64 } / { success:false, error }
        │
        ▼
[content]  原图 vs 优化图对比 → 人工：采用 / 放弃
        │ 采用
        ▼
[content]  注入轮播图上传控件（File 注入，仿 auto_gen_label Phase3 injectFilesToInput）+ 写后读
```

| 层 | 职责 | 改动 |
|---|---|---|
| `native_host/handlers/image_optimize.py`（新） | provider 框架 + 下载 + 调 provider | 新建；惰性 import（对齐 bartender） |
| `native_host/main.py` | DISPATCH 注册 | 加 `'optimize_image': _optimize_image`（惰性 import handler） |
| `check_and_publish content` | 优化入口 + 对比 + 上传 + 写后读 | 加 capOptimizeImage/capApplyImage + panel 按钮 |
| `check_and_publish feature.json` | 权限 | permissions 加 `nativeMessaging`（主图走 native host） |

**为何 native_host 而非 brain**：图像二进制 + 外部 HTTP + 文件 IO 是 native_host 本职（已有 PIL、Python urllib），brain 是 WS 文本判断。

## 4. 可插拔 provider 框架（核心）

`native_host/handlers/image_optimize.py`：

```python
# ImageProvider：replace_background(image_bytes: bytes, options: dict) -> bytes（结果图字节）。
# options: {"backgroundPrompt": str?, "preset": str?}（文本引导/预设背景；mock 忽略）。
# 注册表 + 环境变量选择，对齐 brain/model.py（配 key 用真实、否则 mock）。

class MockProvider:
    """框架占位：返回原图（不改），让 UI/native action 端到端可跑，无需 API key。
    可选：用 PIL 在角落打一个可辨识水印/边框，肉眼确认走了优化链路（非必需）。"""
    def replace_background(self, image_bytes, options):
        return image_bytes

class TongyiProvider:   # stub，待 API key
    def __init__(self, api_key): self.api_key = api_key
    def replace_background(self, image_bytes, options):
        raise NotImplementedError("通义万相 provider 待接入：需 IMAGE_API_KEY + 抠图(RGBA)→背景生成")

# 同样 stub：JimengProvider / PhotoroomProvider

PROVIDERS = {"mock": MockProvider, "tongyi": TongyiProvider, "jimeng": JimengProvider, "photoroom": PhotoroomProvider}

def _select_provider():
    name = os.environ.get("IMAGE_PROVIDER", "mock").strip() or "mock"
    cls = PROVIDERS.get(name, MockProvider)
    key = os.environ.get("IMAGE_API_KEY", "")
    return cls(key) if name != "mock" else cls()
```

接入真实服务 = 实现对应 Provider 的 `replace_background` + 配 `IMAGE_PROVIDER`/`IMAGE_API_KEY` 环境变量，**不动 UI/native action/content**。

## 5. native_host handler

```python
def handle(msg):
    """optimize_image：下载源图 → provider 换背景 → 回 base64。
    入参 msg: {action, imageUrl, options}；出参 {success, image_b64} / {success:false, error}。"""
    image_url = msg.get("imageUrl")
    if not image_url:
        return {"success": False, "error": "缺 imageUrl"}
    try:
        src = _download(image_url)            # urllib，超时兜底
    except Exception as e:
        return {"success": False, "error": "源图下载失败：%s" % e}
    try:
        provider = _select_provider()
        out = provider.replace_background(src, msg.get("options") or {})
    except NotImplementedError as e:
        return {"success": False, "error": str(e)}   # 真实 provider 未接入 → 友好提示
    except Exception as e:
        return {"success": False, "error": "图像处理失败：%s" % e}
    return {"success": True, "image_b64": base64.b64encode(out).decode("ascii")}
```

`main.py` DISPATCH 加 `'optimize_image': _optimize_image`，`_optimize_image` 惰性 import（对齐 `_generate_label`）。

## 6. content UI（对称标题润色）

检查通过（renderPassed）态加「🖼 优化主图」按钮：
- `capOptimizeImage()`：读轮播图主图 url（`getCarouselImagesField` 取第一张 img.src）→ `sendNative('optimize_image', {imageUrl, options})` → 收 `image_b64`。
- 渲染原图 vs 优化图对比卡（两张 `<img>` 并排）+ 「采用并替换」/「放弃」。
- `capApplyImage(image_b64)`：把 base64 转 File → 注入轮播图上传 `input[type=file]`（仿 `auto_gen_label` Phase3 `injectFilesToInput`：DataTransfer + dispatch change）→ 写后读校验（轮播图列表新增/替换该图）。
- 失败/服务未接入 → toast 友好提示，保留原图，不阻断发布。

> 上传控件精确选择器（店小秘轮播图 `input[type=file]` / rocket-upload）在**实现阶段**用 `samples/total_dom.txt` + 现场 DOM 定位（spec 不锁死，对齐项目「改 selector 前 dump 真实 DOM」铁律）。

## 7. 数据流

- **源图 url**：店小秘编辑页轮播图 `<img>` 的 src（`getCarouselImagesField` 已能取）。native_host 用 urllib 直接下载（Python 无跨域限制；content 也可 fetch 转 base64 传入，二选一，**首选 native 下载**省一次大 base64 过消息通道）。
- **结果图回传**：native 回 `image_b64` → content 转 File 注入上传控件。
- **多图**：本期只处理主图（第一张）；多张轮播图批量留后续（options 预留扩展）。

## 8. 权限

`check_and_publish/feature.json` permissions 加 `nativeMessaging`（当前只有 `storage`）。build 聚合去重写入 manifest。native host 用顶层共享 `com.temu.label_host`（已注册）。

## 9. HITL + 错误分层

主图是发布关键素材，**无静默替换**——唯一替换入口是人工确认后的 capApplyImage。

| 失败 | 分类 | 文案 |
|---|---|---|
| 取不到主图 url | 读取 | `读取失败：未找到主图` |
| native host 未注册 / 下载失败 | 读取 | `优化不可用：<原因>，保留原图` |
| provider 未接入（真实 stub） | 业务（降级） | `主图优化未配置：请联系管理员配置图像服务 API key`（mock 不触发） |
| 注入后写后读不符 | 数据校验 | `主图替换未生效，请重试` |

## 10. 不变量 / 向后兼容

- **mock 兜底**：未配 `IMAGE_PROVIDER` → mock 返回原图，UI/链路端到端可跑（框架验证不依赖真服务）。
- **失败保留原图、不阻断发布**：优化是检查环节旁路增强，放弃/失败/未接入都不影响原有 检查→发布。
- **不静默替换主图**：唯一入口人工确认后 capApplyImage（对齐项目「写后读 + 关键动作人工确认」铁律）。
- **release**：feature 在 release 装配；native host 是顶层共享（release 已含）。但**真实 provider 未接入前**点优化 = mock 返回原图（或友好提示）——员工 release 是否暴露此按钮见 §12 待定。

## 11. 测试策略

**native_host（pytest）**
- `image_optimize._select_provider`：env 选择（未配→mock / 配 tongyi→TongyiProvider）。
- `MockProvider.replace_background`：返回原图字节（in==out 或可辨识标记）。
- `handle`：缺 imageUrl → error；mock 路径 → success + image_b64（用本地小图 bytes 桩，mock 下载或注入 _download）。
- 真实 provider stub：调 `replace_background` 抛 NotImplementedError（确认 stub 在位、不静默假成功）。

**content**：靠 e2e（DOM 注入/上传）+ `node --check`。

**端到端（人工 gated，mock provider）**
- 检查通过 → 点「优化主图」→ mock 返回原图 → 对比卡 → 采用 → 轮播图替换 + 写后读通过（验证 UI/native/注入全链路，无需 API key）。
- 配真实 provider 后（未来）：换背景结果显示在对比卡。

## 12. 范围边界 / 待确认

- 本期只搭框架 + mock + UI + native action；真实 provider（通义万相/即梦/Photoroom）待 API key，接入只填 `replace_background`。
- **待确认①**：员工 release 是否暴露「优化主图」按钮（真实 provider 未接入前点 = mock/提示）。倾向 dev 先验证，release 待真实服务接入再开放（可用构建期开关或 provider 探测隐藏）。
- **待确认②**：背景生成的 options（文本引导 backgroundPrompt / 预设风格）由谁定——接入真实服务时按其 API 能力定，本期 options 仅占位透传。
- 多张轮播图批量优化留后续。
