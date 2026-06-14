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

**触发**：条码管理页选商品行（支持多选） → 点 feature view 的"开始执行"按钮。

**流程**：

1. 点击商品行进行选择（支持多选，见下文「多SKU支持」）
2. 每个选中的商品：
   - 点"查看条码" → 弹出 modal 含 `<canvas id="canvas">`
   - 用 `computeCanvasStats` 轮询采样 canvas 中央像素（白底 >30% + 黑条 >5%）判断绘制就绪 + 二次确认
   - `canvas.toDataURL('image/png')` 取条形码 base64
   - `sendNative('PROCESS_LABEL', {...})` 发给 native_host
3. Native host 调 BarTender SDK 为每个商品生成 PDF + PNG 到用户选的输出目录
4. 成功后所有标签路径存 localStorage `talLabelPaths`（数组，见下文「数据结构」），触发 Phase 2 启动（跳页 + setCFlow）

### 多SKU支持

**选择方式**：
- **普通点击**：排他选择该商品（清除其他SKC的商品，但同SKC内支持多行/多SKU并选）
- **Ctrl/Cmd+点击**：多SKC多选（添加到选择列表而不清除其他SKC）

**核心约束（业务确认）**：同一 SKC 下的多个 SKU，**合规信息（Phase 2）和主图槽位（Phase 3）都是 SKC/SPU 级别共享的**。所以：
- Phase 1：为每个 SKU 货号各生成一个独立标签文件
- Phase 2：按 SKC/SPU 只填**一次**合规信息（不是每 SKU 一次）
- Phase 3：在同一组主图「标签图」槽位里，把该 SKC 下**所有** SKU 的标签**连续上传**（标签图 input 带 `multiple`，一次性多文件注入）

**生成逻辑**：
- `fstate.products` 存储选中的商品数组：`[{ skcNumber: '12345', skcSku: 'CLI319-White-2pcs' }, ...]`
- `onRunAllPhases` 逐个商品循环调用 native host，为每个SKU货号生成独立的标签文件
- Phase 2 用第一个商品的 skcNumber 启动（同 SKC 共享，任一 SKU 的 skcNumber 等价）
- Phase 2→3 transition：从 `talLabelPaths` filter 出该 skcNumber 下**所有** SKU 标签，存入 `imgFlow.labelPngPaths`
- Phase 3：读取 `labelPngPaths` 全部文件 → 一次 `DataTransfer` 多文件注入标签图槽位

**多 SKC 边界（fail-soft）**：Ctrl/Cmd+点击可跨 SKC 多选，但合规/主图按 SKC 共享，自动流程**只覆盖第一个 SKC 的全部 SKU**。检测到多个 SKC 时 setStatus 明确提示"其余 SKC 请分别选择后再执行"——不阻断、不偷偷错处理。其余 SKC 的标签已生成在磁盘，用户重新选该 SKC 行再执行即可。

**典型用途**：同一SKC有多个颜色/尺寸规格（多SKU货号）时，一次点击全选这个SKC的所有变种，自动生成所有规格的标签，Phase 3 一次性把这些标签连续传到该商品的标签图槽位。

### ⚠️ 条码管理页表格列关系（核心，踩坑根源）

表格**每行 = 一个 SKU**，4 个关键列各有粒度（实测 DOM 确认，`samples/html.txt`）：

| 列 | 表头 | 粒度 | 同 SKC 多行 | 用途 |
|----|------|------|------------|------|
| col4 | SKC | SKC ID（数字） | 相同 | 文件夹前半 |
| col5 | SKU | SKU ID（数字） | **不同** | **选中/定位行的唯一区分键** |
| col6 | SKC货号 | 如 `RAC-020` | 相同 | 文件夹后半 |
| col7 | SKU货号 | 如 `RAC-020-Black` | **不同** | 文件名 + 标签序列号 |

> 历史 bug：曾用 `SKC货号`（col6，同 SKC 各行相同）当选中区分键 → 点同 SKC 第二个 SKU 被判"已选"取消 → **多 SKU 永远只能选一行**；且 `findRowBySkc` 按 SKC 找行会让同 SKC 所有 SKU 都命中首行 → 标签全用第一个条码。
> 修复：`extractRowData` 取全 4 列，**区分键用 col5 SKU ID**，定位行用 `findRowBySku(skuId)`，命名用 col7 SKU货号。**SKC货号(col6) 与 SKU货号(col7) 是两个独立列，不是 split 出来的。**

### 文件命名（按列分工）

| 项 | 规则 | 取值列 | 例 |
|----|------|--------|-----|
| 文件夹 | `{SKC ID}-{SKC货号}` | col4 + col6 | `9483336741-RAC-020` |
| PDF/PNG 文件名 | `{SKU货号}` | col7 | `RAC-020-Black.jpeg` |

同 SKC 的多个 SKU 标签集中在同一文件夹（col4-col6），文件名各按 SKU货号区分。SKU货号缺失时文件名退回 SKC货号 / `label-{SKC ID}`。

### 数据结构

**localStorage 改动**：

| Key | 旧版 | 新版 |
|-----|------|------|
| `talLabelPng` | 单个字符串路径 | ~~删除~~ |
| `talLabelPaths` | ~~无~~ | 数组 `[{skcNumber, skuId, skcSku, skuSku, pngPath}, ...]`（Phase 1 全量写入） |
| `talLabelSkc` | 存 SKC 编号 | 存第一个选中商品的 SKC 编号 |
| `talImgFlow.labelPngPaths` | ~~无~~ | `[{skcSku, pngPath}, ...]`（该 SKC 下全部 SKU 标签，Phase 3 连续上传） |

**fstate.products 行模型**：`{ skcNumber(col4), skuId(col5), skcSku(col6), skuSku(col7) }`

**格式示例**：
```json
localStorage.talLabelPaths = [
  { "skcNumber": "9483336741", "skuId": "4225419140", "skcSku": "RAC-020", "skuSku": "RAC-020-Black", "pngPath": "D:\\Labels\\9483336741-RAC-020\\RAC-020-Black.jpeg" },
  { "skcNumber": "9483336741", "skuId": "6110759347", "skcSku": "RAC-020", "skuSku": "RAC-020-White", "pngPath": "D:\\Labels\\9483336741-RAC-020\\RAC-020-White.jpeg" }
]
```

**数据流**：
- Phase 1：所有选中 SKU 的标签写入 `talLabelPaths`（全量，含跨 SKC）
- Phase 2→3 transition：`talLabelPaths.filter(p => p.skcNumber === flow.skcNumber)` 取该 SKC 全部 SKU → `imgFlow.labelPngPaths`
- Phase 3 `runImgUpload`：遍历 `labelPngPaths` 分块读取每个标签 → `injectFilesToInput` 一次性多文件注入标签图 multiple input
- 向后兼容：`runImgUpload` 仍读旧 `labelPngPath` 单数字段（残留 imgFlow 不至于报错）

### BarTender 2022 SDK

> **重要**：ActiveX/COM API（`win32com`）的 `ExportToFile` 因许可证限制无法导出文件，必须改用 **pythonnet .NET SDK**。

- DLL 路径：`C:\Program Files\Seagull\BarTender 2022\Seagull.BarTender.Print.dll`
- 模板 SubStrings 名称（经实测确认，.NET API 用 `SubStrings` 而非 `NamedSubStrings`）：
  - `具名条形码`：值为本地 PNG 文件路径（条形码图片）
  - `具名序列号`：值为 **SKU货号**（col7，如 `RAC-020-Black`），多 SKU 时每个标签印各自变体货号
- 条形码从弹窗 `<canvas id="canvas">` 直接捕获为 PNG base64，解码后写入临时文件再传入

**PROCESS_LABEL 入参**：`skc_number`(col4) / `skc_sku`(col6 SKC货号) / `sku_sku`(col7 SKU货号) / barcode_png_b64 / template_path / output_dir / width_ratio

**文件命名算法**（generate_label）：
```python
# 文件夹：SKC ID + SKC货号（col4-col6，同 SKC 各 SKU 共目录）
folder_name = f'{skc_number}-{skc_sku}' if skc_sku else str(skc_number)
# 文件名 + 标签序列号：SKU货号（col7）；缺则退回 SKC货号 / label-{SKC ID}
label_serial = sku_sku or skc_sku or f'label-{skc_number}'
# 输出：{folder_name}/{label_serial}.pdf|.jpeg；具名序列号也印 label_serial
```

**背景**：SKC货号(col6) 与 SKU货号(col7) 是表格两个独立列，不靠 split。文件夹用 SKC 级（共目录），文件名/标签用 SKU 级（区分变体）。

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
6. 通过 native_host **逐个**分块读取该 SKC 下所有 SKU 标签 PNG（`imgFlow.labelPngPaths` 数组，`READ_FILE_SIZE` + `READ_FILE_CHUNK` 循环，避免 Chrome Native Messaging 1MB 单消息上限）
7. **在 drawer 内**定位"标签图"上传按钮（`drawer.querySelectorAll('.rocket-upload[role="button"]')` 内 `<span>标签图</span>`，**禁止 `document` 全局**——曾因全局查找把标签图传到列表页其他商品行，见根 `CLAUDE.md`「数据正确性」§3）
8. 取第一个空白槽位（计数器 `(0/N)`），无空白则取第一个槽位
9. `injectFilesToInput` 把**所有** SKU 标签 File 加进一个 `DataTransfer`，一次性赋值 `input.files`（标签图 input 带 `multiple`）+ dispatch 一次 change —— 等价用户在文件框多选 N 个文件
10. 点"上传并识别"按钮提交（一次提交全部标签）

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
| `OPEN_FOLDER` | path | success（生成后「自动打开文件夹」开关用；Windows `os.startfile`，非致命） |

## 生成后自动打开文件夹（开关）

feature 面板「当前设置」卡片有「生成后自动打开文件夹」勾选框（localStorage `talOpenFolderAfter`，`'1'` 开）。
勾选时，Phase 1 标签全部生成成功后，用资源管理器打开输出的 SKC 子文件夹（取首个标签 `pngPath` 的 dirname，
同 SKC 多 SKU 共目录；多 SKC 仅打开第一个）。`onRunAllPhases`（完整流程）和 `onRunPhase1Only`（调试）
都接 `maybeOpenOutputFolder`。失败只 `console.warn` 不中断主流程（非 Windows / 路径异常 → native 返回 error）。

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
