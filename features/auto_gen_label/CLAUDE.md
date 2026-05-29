# auto_gen_label Feature

> 顶层架构（公共骨架 / feature 注册契约 / Core API / 构建命令）见项目根 `CLAUDE.md`。本文档只覆盖本 feature 的实现细节。

## Feature 概述

- **Feature ID**：`auto_gen_label`
- **作用**：Temu 商家中心三连流程自动化 —— 生成标签 → 填合规信息 → 上传标签主图
- **触发页面**：
  - `https://seller.temu.com/.../label`（条码管理页，Phase 1 入口）
  - `https://*.temu.com/govern/compliant-live-photos`（Phase 2 Step 1 + Phase 3）
  - `https://*.temu.com/govern/information-supplementation`（Phase 2 Step 2/3）

## feature.json 元数据

```json
{
  "id": "auto_gen_label",
  "icon": "🚀",
  "label": "标签生成",
  "locked": false,
  "order": 1,
  "content_script": "content/index.js",
  "host_permissions": ["https://seller.temu.com/*", "https://*.temu.com/*"],
  "permissions": ["nativeMessaging"],
  "native_host": "com.temu.label_host"
}
```

## 内部组织

```
features/auto_gen_label/
├── feature.json
├── content/index.js          # chrome 端业务（Phase 1/2/3 全部，约 1500 行）
├── samples/                  # 调试辅料（DOM 抓取、日志样本）
└── CLAUDE.md
```

> **Native host 已上移到顶层共享层 `native_host/`**（所有 feature 共用唯一 host
> `com.temu.label_host`）。本 feature 不再持有 feature-local `native_host/` 或 `build/`。
> 协议入口 / 通用文件能力 / 注册脚本 / EXE 构建见顶层 `native_host/`：
>
> - `native_host/main.py` — Native Messaging 协议入口 + `DISPATCH` 表
> - `native_host/file_ops.py` — 通用文件能力 + tkinter 文件/文件夹对话框
> - `native_host/handlers/bartender.py` — **本 feature 专属** `generate_label`（BarTender .NET SDK，下文是其实现细节）
> - `native_host/resources/background.png` — Phase 1 标签底图
> - `native_host/{install,dev_install}.bat`、`com.temu.label_host.json`、`requirements.txt`
> - `native_host/build/build.bat` — PyInstaller 打 `TemuLabelHost.exe`

`content/index.js` 内部组织（按职责顺序）：

1. 顶部：U/sendNative/onPageChange 别名 + TAL_DEBUG 常量 + fstate（{ product }）
2. 页面判断（isBarcodeManagementPage / isCompliantLivePhotosPage / isComplianceInfoPage）
3. 路径设置（getPaths / refreshPathsUI / onPickTemplate / onPickOutputDir）
4. 状态栏 + 商品状态（setStatus / refreshProductUI / setProduct / clearSelection / getWidthRatio）
5. 行绑定 + 数据提取
6. Phase 1：标签生成（onRunAllPhases / onRunPhase1Only / clickAndCaptureCanvas / Canvas 渲染检测）
7. Phase 2 流程状态（CFlow 在 localStorage `talCFlow` 持久化跨 tab）
8. Phase 2 Rocket UI 工具集（findFormItemByLabel / findSectionByOwnTitle / applyPhase2Rules / rocketSelect / ensureSelected / 等）
9. Phase 2 主流程（runStep1 查 SPU → runStep2 查合规列表 + 点编辑 → runStep3 填 drawer + 提交）
10. Phase 3：主图插入（runImgSearch + runImgUpload + 标签图槽位定位 + File 对象注入）
11. renderAutoGenLabel（feature view）
12. registerFeature 调用（注册到 core）

## Phase 1：标签生成

**触发**：条码管理页选商品行 → 点 feature view 的"开始执行"按钮。

**流程**：

1. 点商品行的"查看条码" → 弹出 modal 含 `<canvas id="canvas">`
2. 用 `computeCanvasStats` 轮询采样 canvas 中央像素（白底 >30% + 黑条 >5%）判断绘制就绪 + 二次确认
3. `canvas.toDataURL('image/png')` 取条形码 base64
4. `sendNative('PROCESS_LABEL', {...})` 发给 native_host
5. Native host 调 BarTender SDK 生成 PDF + PNG 到用户选的输出目录
6. 成功后 PNG 路径存 localStorage `talLabelPng`，触发 Phase 2 启动（跳页 + setCFlow）

### BarTender 2022 SDK

> **重要**：ActiveX/COM API（`win32com`）的 `ExportToFile` 因许可证限制无法导出文件，必须改用 **pythonnet .NET SDK**。

- DLL 路径：`C:\Program Files\Seagull\BarTender 2022\Seagull.BarTender.Print.dll`
- 模板 SubStrings 名称（经实测确认，.NET API 用 `SubStrings` 而非 `NamedSubStrings`）：
  - `具名条形码`：值为本地 PNG 文件路径（条形码图片）
  - `具名序列号`：值为 SKC货号字符串
- 条形码从弹窗 `<canvas id="canvas">` 直接捕获为 PNG base64，解码后写入临时文件再传入

**经实测确认的完整调用（pythonnet 3.0）**：

```python
import clr
clr.AddReference(BT_DLL)
from Seagull.BarTender.Print import (
    Engine, ImageType, ColorDepth, OverwriteOptions, SaveOptions, Resolution
)
engine = Engine(False)
engine.Start()
fmt = engine.Documents.Open(btw_path)
fmt.SubStrings['具名条形码'].Value = png_path
fmt.SubStrings['具名序列号'].Value = skc_sku
res = Resolution(600)          # 单参数 = 600 DPI（双参数 = 像素尺寸，不是DPI）
fmt.ExportImageToFile(out_pdf, ImageType.PDF, ColorDepth.ColorDepth24bit, res, OverwriteOptions.Overwrite)
fmt.ExportImageToFile(out_png, ImageType.PNG, ColorDepth.ColorDepth24bit, res, OverwriteOptions.Overwrite)
fmt.Close(SaveOptions.DoNotSaveChanges)
engine.Stop()
```

**关键枚举值（经反射确认）**：

| 枚举 | 值 |
|------|-----|
| `ImageType.PNG` | 3 |
| `ImageType.PDF` | 35 |
| `ColorDepth.ColorDepth24bit` | 4 |
| `OverwriteOptions.Overwrite` | 2 |
| `SaveOptions.DoNotSaveChanges` | — |

**Resolution 构造说明**：

- `Resolution(600)` → 600 DPI，输出 1890×1417 像素（80×60mm 模板）✓
- `Resolution(600, 600)` → 输出 600×600 像素（≈190 DPI），不是 600 DPI ✗

## Phase 2：合规信息填写

**触发**：Phase 1 成功后自动跳页到 `/govern/compliant-live-photos`，CFlow.step=1 启动。

**流程**：

- **Step 1**（实拍图页面）：从 SKC 查 SPU（v1.1.1 数据正确性加固，见根 `CLAUDE.md`「数据正确性」§1/§2）
  - `ensureSkcSearchInput`：选搜索类型=SKC，**以 skcIdStr 输入框就绪为成功信号**（非 selection-item 文本），组件未就绪时重试
  - `fillSkcAndVerify`：填 skcNumber 后写后读校验「类型仍 SKC 且值==目标」，**被页面异步初始化(`mallModel`)重置回 SPU 就退避重试**，总超时窗口(25s)内自愈
  - `extractSpuFromUniqueResult`：点查询后**轮询等"含 SPU 结果行恰好 1 行"再取 SPU**（精确 SKC 结果必唯一），不唯一/超时报错中止——**绝不抓全页第一个 SPU**（曾因此把默认第一行 SPU 当目标、全程操作错误商品）
  - 写入 CFlow.spuId → 跳页到 `/govern/information-supplementation`
- **Step 2**（合规信息列表）：输入 SPU 查询 → 强校验目标行（`ensureQueryMatchesSpu` 重试 3 次）→ 点匹配行的"编辑"按钮 → 等 drawer 打开
- **Step 3**（drawer 填表）：
  - `waitForAllSectionsRendered` 等所有 `div[id=数字]` section 内 form 控件就绪
  - 按 `SECTION_RULES_PHASE2` 白名单循环填充
  - 提交后校验列表"商品合规信息"列全部"上传成功"（含 rowspan-aware 列映射）
  - 成功后写入 imgFlow + 跳页启动 Phase 3

### SECTION_RULES_PHASE2 白名单

每条 rule 有 `type: 'single' | 'group'`：

- `single`：精确匹配 section 标题（border-left header 文本），填入 `fields[]`
- `group`：匹配 group header（如"韩国公示信息"），含其后多个数字 id section，对每个 form-item 自动填 NA（autoFillNA），可有 `exceptions` 覆写特定字段

每个 field 的 `mode`：

- `ensure`：强制改为目标值（含清空多选旧值，含未生效重试）
- `ifEmpty`：仅当容器无值时填入

`kind`：`'select'`（默认）或 `'text'`。

`__SKC_SKU__` 占位符在 `applyFieldRule` 中替换为运行时 ctx.skcSku。

## Phase 3：标签主图插入

**触发**：Phase 2 成功且 PNG 文件存在时自动跳页启动；或 Phase 1 完成后单独用 `onStartImageUpload` 手动启动。

**流程**：

1. 跳到 `/govern/compliant-live-photos`，imgFlow.active=true
2. `fillSkcAndVerify` 选 SKC + 填 skcNumber + 写后读（同 Phase 2 Step1，自愈页面 `mallModel` 重置）
3. 强校验目标 SPU 行（同 Phase 2 Step 2）
4. 点匹配行"修改/上传"前**断言该行 SPU==目标**；点击后 `waitForDrawerOpen` 拿可见 drawer，**未打开即中止**（不退回列表页全局查找）
5. **drawer 内身份二次确认**：`drawer.querySelector('#spuId')` == 目标 SPU，不符中止（防点错行/rowspan 错位传错商品）
6. 通过 native_host 分块读取标签 PNG（`READ_FILE_SIZE` + `READ_FILE_CHUNK` 循环，避免 Chrome Native Messaging 1MB 单消息上限）
7. **在 drawer 内**定位"标签图"上传按钮（`drawer.querySelectorAll('.rocket-upload[role="button"]')` 内 `<span>标签图</span>`，**禁止 `document` 全局**——曾因全局查找把标签图传到列表页其他商品行，见根 `CLAUDE.md`「数据正确性」§3）
8. 优先空白槽位（计数器显示 `(0/N)`），全有则上传全部
9. `injectFileToInput` 用 DataTransfer + File 构造对象赋值 `input.files` + dispatch change 事件
10. 点"上传并识别"按钮提交

## Native Messaging 协议

`sendNative` 返回的 result 是 native_host 直接返回的 dict 本体（含 `success` 字段）。Service worker 已剥外层 `{success, result}` 包装。

**请求格式**：

```js
const result = await sendNative('PROCESS_LABEL', {
  skcNumber, skcSku, barcodePngB64, templatePath, outputDir, widthRatio
});
if (!result.success) throw new Error(result.error);
const { output_pdf, output_png } = result;
```

**Native host action 清单**（由 service worker 路由）。`PROCESS_LABEL` 是本 feature 专属
（→ 共享层 `native_host/handlers/bartender.py`），其余为共享文件能力（→ `native_host/file_ops.py`），
完整路由表见项目根 `CLAUDE.md` 的「Native Messaging Protocol」段：

| Action | 入参 | 出参 |
|--------|------|------|
| `PROCESS_LABEL` | skc_number / skc_sku / barcode_png_b64 / template_path / output_dir / width_ratio | output_pdf / output_png |
| `PICK_FILE` | title / filetypes | path |
| `PICK_FOLDER` | title | path |
| `READ_FILE` | path | data (base64) |
| `READ_FILE_SIZE` | path | size |
| `READ_FILE_CHUNK` | path / offset / length | data (base64) |

## Temu 弹窗结构（条码管理页）

- Modal 根节点：`[data-testid="beast-core-modal-body"]`
- 条形码画布：`#canvas`（canvas 元素，用 `toDataURL('image/png')` 提取）
- SKC 数值：`.label-value-module__label-value___1wVkH` 内 label 为 `SKC` 的 value
- 操作按钮：`button` 内 span 文字匹配（打印条码 / 保存条码 / 取消）

## Native Host 注册（共享层）

> Native host 注册归**顶层共享 `native_host/`**，所有 feature 共用。本节只作引用，细节随共享层文档走。

Native Host 名称：`com.temu.label_host`（共用唯一 host）
注册表路径：`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.temu.label_host`

`com.temu.label_host.json` 的 `allowed_origins` 中需填入插件的实际 Extension ID（首次加载插件后从 `chrome://extensions` 获取）。开发阶段临时用通配，生产部署时锁定具体 ID。

- 开发期注册：`native_host/dev_install.bat`
- 部署期注册：员工部署包内 `install.bat`（由顶层 `build/package_all.py` 从 `native_host/` 拷入）

## Key Dependencies

| 依赖 | 用途 |
|------|------|
| `pythonnet` | 调用 BarTender 2022 .NET SDK（不能用 win32com，许可证限制） |
| `pywin32` | win32com 备用 + 其他 Windows API |
| `tkinter` | 文件/文件夹选择对话框（Python 标准库） |
| `PyMuPDF` | PDF 处理 |
| PyInstaller | 打包为单文件 EXE（仅开发环境） |

完整列表见 `native_host/requirements.txt`。

## samples/ 调试辅料

- `html.txt` — Temu 条码管理页 DOM 抓取（Phase 1 入口参考）
- `barcode.txt` — 条码弹窗 DOM 抓取（canvas 节点结构）
- `compliant-live-photos.txt` — Phase 2 Step 1 实拍图页面 DOM
- `information-supplementation.txt` / `information-supplementation-edit.txt` — Phase 2 Step 2/3 合规信息页面 DOM
- `rocket-drawer.txt` / `rocket-drawer2.txt` — Phase 2 Step 3 编辑 drawer DOM（Rocket UI 工具集开发参考）
- `background.png` — Phase 1 标签背景图样本
- `temu_label_host.log` — Native host 运行日志样本

## 调试

`TAL_DEBUG = true`（`content/index.js` 顶部，dev 环境保持 true）启用 feature view 内的"调试"卡片：

- 标签缩放比例 input（持久化到 localStorage `talWidthRatio`，默认 0.45）
- "仅生成标签（调试）"按钮：只跑 Phase 1 不进 Phase 2

`build/package_all.py` 在打 release 部署包时会自动把这个常量改成 `false`（显式校验"原值必须存在"，避免静默失败）。
