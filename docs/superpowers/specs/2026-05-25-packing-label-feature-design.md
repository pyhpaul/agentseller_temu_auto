# packing_label feature 设计

- 日期：2026-05-25
- 状态：设计已确认，待转 writing-plans
- 关联 core 前置：native host 已提取到顶层共享层 `native_host/` 并新增通用 `write_file_chunk`（PR #29，已合入 main）

## 1. 背景与问题

在跨境卖货后台 `https://seller.kuajingmaihuo.com/main/order-manager/shipping-list`「待仓库收货」tab，用户勾选发货批次行后，需要为选中行下的**每个商品**连续打印「打包标签」，并把每张标签 PDF 按统一规则命名、保存到一个固定文件夹，用于贴标自提。手工逐个点打印 → 走 Chrome 打印预览 → 选「另存为 PDF」→ 手选文件夹 → 手敲文件名，重复几十次，极其费时。

### 核心技术约束（已实测确认）

点「打印商品打包标签」后的链路：

```
点打印 → 页面客户端构造 Blob(application/pdf, ~600KB)
       → URL.createObjectURL 得 blob: URL
       → 插入 <iframe src="blob:..."> → iframe.contentWindow.print()
       → 弹出 Chrome 原生打印预览（chrome://print，print-preview-app）
```

- **Chrome 打印预览页（`chrome://print`）和操作系统文件保存对话框都属于浏览器/系统 UI，content script 无法访问、无法控制**。所以"自动点打印对话框、自动选文件夹、自动命名"这条直接路径**不可行**。
- 但实测确认：标签 PDF 在进打印预览**之前**，已以 `Blob(application/pdf)` 形态存在于页面（`createObjectURL` 的 hook 直接拿到了 Blob 对象引用）。
- 因此可行路径是 **在页面 main world 拦截这个 PDF blob 的字节 + 拦掉打印预览的弹出**，把字节交给本地 native host 按命名写到预设文件夹。完全绕开打印对话框和文件保存对话框。这与 auto_gen_label「从页面抓 canvas 产物 → native host 保存」是同一思路，只是抓的产物从 canvas 变成 blob。

诊断证据（用户在 Console 跑 hook 抓到）：

```
[PLDIAG] createObjectURL Blob type=application/pdf size=600367B -> blob:https://seller.kuajingmaihuo.com/...
[PLDIAG] new IFRAME src/data= blob:https://seller.kuajingmaihuo.com/...
```

`window.print()` 未被调用 → 是 iframe 内部 `contentWindow.print()` 触发的。

## 2. 目标 / 非目标

**目标**：
- 勾选发货批次行 → 一键连续打印选中行下所有商品的打包标签
- 每张标签 PDF 静默保存到用户预设的固定文件夹，命名 `承运商_单号_数量件_贴标自提.pdf`
- 全程无人值守：不弹打印预览、不弹文件保存对话框、可选地自动处理 confirm 弹窗

**非目标**：
- 不使用页面自带的「批量打印商品打包标签」按钮（它合并成单一打印流，无法对每个商品单独命名）
- 不在本 feature 内做标签内容生成（标签 PDF 由 Temu 页面产出，我们只捕获+保存）
- 不处理打印预览 UI 本身（直接绕过）

## 3. 需求与已确认决策

| 项 | 决策 |
|----|------|
| 保存方式 | native host 写**任意预设文件夹**（共享层 `SAVE_FILE_CHUNK`） |
| native host 归属 | 共享顶层 `native_host/`（PR #29 已就绪），packing_label 几乎不写 native 代码 |
| confirm 弹窗「30天内不再提醒」 | **自动勾选 + 点「继续打印」**；勾过后 30 天内不再弹，逻辑兼容"没弹就跳过" |
| 文件名撞名（同行多商品、单号+数量相同） | **追加 `_2` / `_3`**，去重在 native 侧（磁盘真实存在判断） |
| 处理顺序 | **串行**（一次只在途一个商品），保证捕获到的 blob 与当前商品命名上下文一一对应 |

## 4. 架构（三层）

```
[main world, document_start]  features/packing_label/content/inject-main.js
  • hook URL.createObjectURL：命中 application/pdf blob 且捕获模式开 → blob.arrayBuffer() 读字节
    → window.postMessage 给 isolated（带 ctxId）
  • 拦截该 blob iframe 的 contentWindow.print，阻止打印预览弹出
  • 仅在「捕获模式」开启时介入；关闭时一切照常（不劫持用户手动打印）
        │ window.postMessage（{type, ctxId, bytes}）
        ▼
[isolated world]  features/packing_label/content/index.js
  • registerFeature + feature view：预设保存路径 UI（复用 auto_gen_label 的 getPaths / PICK_FOLDER / localStorage 模式）
  • 批量驱动引擎：枚举选中行下商品打印按钮 + 命名信息 → 串行点击 → 处理 confirm → 等捕获 → 存盘 → 下一个
  • 收 PDF 字节 → base64 分块 → sendNative('SAVE_FILE_CHUNK', {path, data, offset, done})
        ▼
[shared native_host]  file_ops.write_file_chunk
  • 按命名写预设文件夹（写功能已就绪；撞名去重方案待定，见 §13 Open Issue #1）
```

**main world 注入方式**：feature.json 声明 `extra_content_scripts`，`world:"MAIN"`、`run_at:"document_start"`、`matches` 限定 shipping-list 域名。构建脚本 `build_extension.py` 已透传这些字段，无需改 core。isolated 与 main 之间用 `window.postMessage` 通信（同源），PDF 字节用 ArrayBuffer 直接传（免 base64）。

## 5. 数据流（批量串行循环）

1. 用户勾选发货批次行 → 点 feature view「开始打印」
2. 引擎收集所有**选中行**下、**未 disabled** 的「打印商品打包标签」按钮，连同每个商品的 `{承运商, 单号, 数量}` 命名信息
3. 开启捕获模式（postMessage 通知 main world）
4. 对每个商品**串行**：
   1. 设 `currentCtx = {承运商, 单号, 数量}`（生成 ctxId）
   2. 点该商品的打印按钮
   3. 若出现 confirm 弹窗 → 勾「30天内不再提醒」+ 点「继续打印」；超时没弹则跳过
   4. 等 main world 捕获到 PDF blob（带 ctxId 回传字节），同时 print 被拦、预览不弹
   5. 由 currentCtx 构造文件名 → 分块 `SAVE_FILE_CHUNK` 写预设文件夹（撞名 native 侧追加序号）
   6. 进度 +1，下一个
5. 全部完成 → 关闭捕获模式 → toast 汇总（成功 N 个 / 失败明细）

**串行的理由**：一次只在途一个商品，`createObjectURL` 命中的 PDF blob 必然属于 `currentCtx`，命名不会错位；也避免并发点击触发多个打印流难以归因。

## 6. PDF 捕获 + 打印拦截（最高风险点，实现时最先验证）

### 捕获
main world hook `URL.createObjectURL`；遇 `blob.type === 'application/pdf'` 且捕获模式开 → `blob.arrayBuffer()` 异步读字节 → `postMessage({type:'PL_PDF', ctxId, bytes})` 给 isolated。

### 拦截预览
页面流程：`createObjectURL → 插 <iframe src=blob:> → iframe.contentWindow.print()`。

拦截方案：在 `document_start` hook `document.createElement('iframe')`，对返回的 iframe **抢先注册 capture 阶段 `load` 监听器**，把 `contentWindow.print` 置为 noop。因为我们的监听器在元素创建时就注册（早于页面后续给 iframe 赋 src / 设自己的 onload），addEventListener 按注册顺序触发，我们先执行、先吃掉 print 调用。

### 风险与兜底
- 若页面同步调用 print、或换了触发方式（非 iframe.onload）导致拦不住 → 退化为"预览仍会弹、需手动关"，但 **PDF 字节已捕获保存**，不丢数据，只是批量体验下降。
- **实现第一步就做最小验证**：单独验证「点一次打印 → blob 捕获成功 + 预览不弹」，确认拦截可靠后再做批量驱动。

## 7. DOM 选择器（来自 samples，运行时需再确认——Temu class hash 会变）

> 样本：`features/packing_label/samples/{whole_page.txt, confirm_window.txt, print_dom.png}`

| 元素 | 选择器 / 特征 |
|------|--------------|
| 已选计数（商品数，非行数） | `.shipping-list_choose__vy9Hi` 内 `.shipping-list_chooseNum__nPuIs` |
| 每商品「打印商品打包标签」按钮 | `<a data-testid="beast-core-button-link">` 内 `<span>` 文字 = `打印商品打包标签`；不可用时带 `disabled=""`（需跳过） |
| 物流单号 | `物流单号：` label 后 `<a data-testid="beast-core-button-link">` span 文字，形如 `极兔速递，JT0023769813149`（承运商，单号） |
| 发货数量 | `发货数量：</span>` 后文本，形如 `20件` |
| confirm 弹窗 checkbox | `[data-testid="beast-core-checkbox"]`，文字 `30天内不再提醒`，状态看 `data-checked` |
| confirm 弹窗确认按钮 | `[data-testid="beast-core-button"]` 内 `<span>继续打印</span>`（primary） |

> 选择器优先用 `data-testid` + 文字匹配，少依赖带 hash 的 class（`*_5-117-0` / `*___xxx` 这类构建产物会随版本变）。

## 8. 文件名构造 + 预设路径

- 物流单号 `极兔速递，JT0023769813149` → 拆 `承运商=极兔速递`、`单号=JT0023769813149`（按中文逗号 `，` 或英文逗号分割，取两段）
- 数量 `20件` → 原样
- 文件名：`极兔速递_JT0023769813149_20件_贴标自提.pdf`（分隔符统一 `_`；清洗 Windows 非法文件名字符 `\ / : * ? " < > |`）
- 撞名去重：放 **native 侧**（`write_file_chunk` 前若同名文件已存在则追加 `_2`/`_3`…），因为只有 native 知道磁盘真实存在情况；isolated 侧只管传期望文件名
- 预设路径：feature view 一行「保存到」，点选走 `PICK_FOLDER`，存 localStorage；批量前校验已设，未设则提示先选文件夹（业务拦截类错误）

## 9. native host 用法（无需新增 action）

复用共享 `SAVE_FILE_CHUNK`（PR #29 已加）：

```js
// isolated 侧，分块发送（Native Messaging 单消息 1MB 上限）
await sendNative('SAVE_FILE_CHUNK', { path, data: <base64 块>, offset, done });
```

- `path`：预设文件夹 + 期望文件名的绝对路径
- `offset === 0` 首块截断创建，其余按位置写；`done:true` 返回 `{success, path, size}`
- 当前 `write_file_chunk` 直接按 path 写、无去重；**撞名去重放 native 还是 isolated 侧待定**——见 §13 Open Issue #1

## 10. 错误处理（分层文案，遵循 debugging-rules 的错误分层约束）

| 类别 | 例 | 文案模板 |
|------|----|---------|
| 读取/选择器故障 | 找不到打印按钮 / confirm 按钮 | 「未找到 X 按钮（第 N 个商品）」 |
| 捕获故障 | 点了打印但超时没捕获到 PDF blob | 「第 N 个商品未捕获到标签 PDF」 |
| 保存故障 | native 写盘失败 / 预设目录不存在 | 「保存失败：<native error>」 |
| 业务拦截 | 按钮 disabled / 未设预设路径 | 「该商品不可打印」/「请先设置保存文件夹」 |

单个商品失败**不中断**整批，计入失败明细，结尾汇总。

## 11. 边界

- disabled 打印按钮（`disabled=""`）跳过
- confirm 弹窗可能不出现（已勾过 30 天）→ 设超时，超时没弹直接进等待捕获
- 一行多商品：各自独立按钮、独立命名
- 「已选:x」是商品数不是行数——引擎直接枚举按钮，不依赖该计数

## 12. 测试

- **纯函数**（文件名构造、单号拆分、非法字符清洗、去重序号）→ 单元测试，Linux 可跑
- **捕获/拦截/驱动** → Windows + 真实页面手动验证；**实现顺序上先验证捕获+拦截可靠性**，再做批量驱动

## 13. Open Issues（写 plan / 实现时需定）

1. **撞名去重放 native 还是 isolated**：本设计倾向 native 侧（磁盘真实存在判断更准），但当前 `write_file_chunk` 不含去重——是给它加一个"存在则改名"选项，还是 isolated 侧先 `READ_FILE_SIZE` 探测再决定文件名？implementation 时定。
2. **打印拦截的兜底程度**：若 capture-load 拦截在真实页面不稳，是否需要更激进的手段（如 hook `window.open` / 移除 iframe），还是接受"预览弹出但已存盘"的退化。先做最小验证再决定。
3. **捕获超时阈值**：点打印后等多久判定"未捕获到 PDF"（受 Temu 生成 PDF 速度影响，~600KB 实测秒级）。

## 14. 不改动的部分

core API、service-worker、native_host（除可能的去重选项）、其它 feature 均不动。本 feature 自治在 `features/packing_label/`。
