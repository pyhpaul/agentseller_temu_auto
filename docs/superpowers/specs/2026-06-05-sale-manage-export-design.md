# 销售管理清单采集导出 CSV — 设计文档

日期：2026-06-05
Feature ID：`sale_manage_export`
目标页面：`https://agentseller.temu.com/stock/fully-mgt/sale-manage/main`

## 1. 背景与目标

用户在销售管理页用筛选条件查询后，需要把结果表格中**所有页**的数据采集为 CSV。采集字段（SKC 粒度，全部位于「商品信息」rowspan 格内）：

| 列 | 来源 |
|----|------|
| SKC | 商品信息格 `<p>SKC：...</p>` |
| SKC货号 | 商品信息格 `<p>SKC货号：...</p>` |
| SPU | 商品信息格 `<p>SPU：...</p>` |
| 商品名称 | `.main_productName` 文本 |

要求：**采集要全（覆盖所有分页）且不重复**（按 SKC 去重）。

## 2. 方案选型

- **A（选定）：content script 内单页循环采集** —— 单 tab 全流程，复用现有 `sendNative` 通道；packing_label 已验证 `PICK_FOLDER` + `SAVE_FILE_CHUNK` 链路。
- B：background 跨 tab 编排 —— 无跨 tab 需求，排除。
- C：MAIN world 拦截查询接口 JSON —— 需逆向 `temu-sca-stock` 微前端接口，脆弱，4 个字段 DOM 可稳定获取，排除。

## 3. 页面 DOM 事实（来自真实 dump）

- Beast UI 表格（`TB_*_5-120-1` hash class，selector 须用 `data-testid` / class 前缀匹配，不硬编码完整 hash）。
- **rowspan 分组**：每个 SKC 一组，组内含 N 个 SKU 行 + 末尾 1 个「合计」行；checkbox、商品信息格、操作列以 rowspan 合并在组首行。「合计」行没有商品信息格。
- **标准分页器**（非虚拟滚动）：`data-testid="beast-core-pagination"`，含「共有 N 条」、每页条数 select、`beast-core-pagination-next`（末页时带 `PGT_disabled` 类）。
- 加载遮罩：`Spn_spinningMask`。

## 4. Feature 骨架

```
features/sale_manage_export/
├── feature.json
├── content/index.js
└── CLAUDE.md
```

feature.json 要点：
- `content_matches` / `host_permissions`：仅 `https://agentseller.temu.com/*`
- `permissions`: `["nativeMessaging", "storage"]`
- 该域名已被现有 feature 覆盖，无新增注入面。

### Panel UI

- 「保存文件夹」行：显示当前目录 + 选择按钮（`PICK_FOLDER`），结果存 `chrome.storage.local`，下次默认复用。
- 「开始采集」按钮：仅当 URL 含 `/stock/fully-mgt/sale-manage` 时可用，否则灰显并提示前往该页面。
- 进度/状态区：第 X/Y 页、已采 N 个 SKC、错误信息。

## 5. 采集流程

1. **前置校验**：表格与分页器存在；读「共有 N 条」作完整性参考。
2. **调大每页条数**：点开分页器 size select，运行时读取实际选项选最大值（不硬编码 50/100）；**写后读校验**：回读 select 值 == 期望，并等表格刷新完成。
3. **逐页扫描**：
   - 取 `tbody` 内含商品信息格（rowspan 首行）的 `<tr>`，每组解析 4 字段；「合计」行自然被跳过。
   - 去重：`Map<SKC, row>`，重复 SKC 跳过。
   - 任一页扫描到 0 组 → 报错中止，不静默。
   - 点 next 翻页；next 带 `PGT_disabled` 则结束。
4. **翻页后等待刷新**（对应 auto_ship #47 同 SKC 漏扫坑）：记录翻页前激活页码 + 首行 SKC，轮询直到「激活页码已变 且 spin 遮罩消失 且 首行 SKC 可读」，超时报错（读取层文案）。不允许裸 sleep 替代条件轮询。
5. **完整性校验**：完成后对比去重 SKC 数与逐页累计组数；与「共有 N 条」做提示性对比（N 的语义——SKC 还是 SKU 计数——首版通过运行日志确认，不做硬校验）。

## 6. CSV 生成与保存

- 表头 `SKC,SKC货号,SPU,商品名称`；字段标准 CSV 转义（含逗号/引号/换行时双引号包裹，内部 `"` → `""`）。
- 内容前缀 **UTF-8 BOM**（Excel 中文兼容）。
- base64 分块经 `SAVE_FILE_CHUNK` 写入 `<目录>/销售管理清单_YYYYMMDD_HHMMSS.csv`；成功后 toast + 显示完整路径。
- 采集中途失败：**不写文件**。

## 7. 错误处理（分层文案铁律）

| 层 | 示例文案 |
|----|---------|
| 读取/选择器 | 「未找到表格/分页器」「翻页后表格刷新超时（第 X 页）」 |
| 数据校验 | 「第 X 页第 Y 组缺少 SKC 字段」→ 立即中止 |
| 业务拦截 | 「当前不在销售管理页，无法采集」「未选择保存文件夹」 |

## 8. 验证清单

1. 全量（310 条 / 31 页）端到端，CSV 行数 == 页面 SKC 组数。
2. 带搜索条件的小结果集。
3. 单页结果（next 初始即 disabled）。
4. 翻页刷新超时路径的报错文案。
5. Excel 打开 CSV 无乱码、含逗号商品名不串列。
