# packing_label Feature

> 顶层架构（公共骨架 / 注册契约 / Core API / 构建 / native_host）见项目根 `CLAUDE.md`。本文档只覆盖本 feature 细节。

## 作用

跨境后台「待仓库收货」页（`https://seller.kuajingmaihuo.com/main/order-manager/shipping-list`）
批量打印选中发货批次行下**所有商品**的打包标签，每张 PDF 静默保存到预设文件夹，命名
`承运商_单号_数量件_贴标自提.pdf`（如 `极兔速递_JT0023772101525_30件_贴标自提.pdf`）。

## 技术核心：拦截 PDF blob，绕过 Chrome 打印对话框

页面点「打印商品打包标签」的链路：构造 `Blob(application/pdf)` → `URL.createObjectURL` →
插入 `<iframe src="blob:...">` → `iframe.contentWindow.print()` 弹 Chrome 打印预览
（`chrome://print`，content script 无法控制；OS 文件保存对话框同理）。

本 feature 在 **MAIN world** hook `URL.createObjectURL` 抓 application/pdf blob 字节、并拦掉
blob iframe 的 `contentWindow.print`（绕过打印预览），字节经 isolated 侧 `SAVE_FILE_CHUNK`
写到预设文件夹。**实测确认捕获 ✓ + 预览拦截 ✓**（点打印捕获到 ~600KB PDF 且预览不弹）。

## 文件

```
features/packing_label/
├── feature.json              # order=4；content_script + 2 个 extra_content_scripts
├── content/
│   ├── inject-main.js        # MAIN world（document_start）：捕获 PDF blob + 拦截 iframe print
│   ├── naming.js             # isolated（document_start）：纯命名函数；双 browser/node 导出
│   └── index.js              # isolated（document_idle）：UI + 批量串行引擎
├── tests/naming.test.js      # naming.js 的 node 单测（node --test）
├── samples/                  # selected_row.txt / confirm_window.txt / print_dom.png / whole_page.txt
└── CLAUDE.md
```

## 注入顺序（关键）

- `inject-main.js`（MAIN, document_start）：在页面 JS 建 PDF 前装好 hook
- `naming.js`（isolated, document_start）：早于 index.js，挂 `window.__PLNaming`
- `index.js`（isolated, document_idle）：用 `__PLNaming`、驱动批量

isolated ↔ MAIN 用 `window.postMessage` 同源通信，协议 `{__pl:'ctrl'|'pdf'|'pdferr', ctxId, ...}`。
PDF 字节用 ArrayBuffer 直接 transfer（免 base64）。捕获模式由 isolated 侧 `ctrl('start'/'stop')` 开关，
关闭时不劫持用户手动打印。

## 表格 DOM：rowspan 分组结构（重要）

一个物流分组跨 **N 个 `<tr>`**（N=商品数）：

| 单元格 | 归属 | 内容 |
|--------|------|------|
| checkbox `td`（rowspan=N） | 分组级，仅首 tr | 勾选整个物流分组 |
| 物流信息 `td`（rowspan=N） | 分组级，仅首 tr | `物流单号：极兔速递，JT...`（承运商，单号） |
| 分组操作 `td`（rowspan=N） | 分组级，仅首 tr | 含「打印商品打包标签/打印运单标签/更换物流」——**合并打印，要排除** |
| 发货数量 `td` | 商品级，每 tr | `发货数量：30件` |
| 商品操作 `td` | 商品级，每 tr | 「打印商品打包标签/打印合包标签/打印商品条码」——**单品按钮在这** |

枚举（`collectPrintTargets`）：分组感知遍历——含 checkbox 的 tr 起新分组（取分组级物流单号），
选中分组下每个 tr 取商品级发货数量 + 单品打印按钮。
单品 vs 分组打印按钮靠**所在 `td` 不含「运单」**区分（分组操作列含运单相关动作，单品列不含）。

> 选择器以 `data-testid` + 文字匹配为主，少依赖带 hash 的 class（随版本变）。

## confirm 弹窗（可选）

点打印后可能弹「确认再次打印」窗（`samples/confirm_window.txt`），含「30天内不再提醒」勾选框。
`handleConfirmIfPresent` 在弹窗内勾未勾的 checkbox + 点「继续打印」；勾过 30 天后不再弹，
逻辑兼容"超时没弹则跳过"。

## native host 用法（不新增 action）

复用共享 `com.temu.label_host`：
- `SAVE_FILE_CHUNK`：分块写 PDF 到预设路径（512KB/块，base64 后 < 1MB Native Messaging 限制）
- `READ_FILE_SIZE`：撞名去重探测（目标路径存在则 `_2`/`_3` 递增）
- `PICK_FOLDER`：选预设保存文件夹（存 localStorage `plSavePath`）

## UX

- **全部不弹打印预览**（批量无人值守）
- 面板实时进度「打印中 i/N…」；完成显示「✅ 已存 N 个到 <path>」+ toast
- **不自动打开文件夹**（避免给共享 native host 加 open_path；用面板强反馈替代）

## 已知限制 / 待实测确认（Task 10）

- 打印拦截基于「createElement iframe 抢先 load 监听置空 print」，Console 最小验证通过；
  端到端批量下若个别页面拦不住，退化为"预览弹出但字节已存盘"（不丢数据）。
- confirm 弹窗「继续打印」按钮文案据补打变体样本；首次打印弹窗若文案不同需调 `findContinueBtn`。
- 行→商品枚举选择器据 `samples/selected_row.txt`（rowspan 结构）；Temu 改版需复核。
