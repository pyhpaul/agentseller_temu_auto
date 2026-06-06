# sale_manage_export Feature

> 顶层架构见项目根 `CLAUDE.md`。本文档只覆盖本 feature 细节。

## 作用

销售管理页（`https://agentseller.temu.com/stock/fully-mgt/sale-manage/main`）一键采集
结果表格**所有分页**的 SKC / SKC货号 / SPU / 商品名称（SKC 粒度），按 SKC 去重后导出
UTF-8 BOM CSV（`销售管理清单_YYYYMMDD_HHMMSS.csv`）到预设文件夹。

## 文件

- `content/sme-utils.js` — 纯函数（CSV 转义 / 字段解析 / 文件名），双导出，document_start 注入挂 `window.__SMEUtils`
- `content/index.js` — panel UI + 表格扫描 + 分页循环 + SAVE_FILE_CHUNK 落盘
- `tests/sme-utils.test.js` — `node --test`

## 表格 DOM 关键事实

- Beast UI 表格，class 带版本 hash（`_5-120-1`）→ selector 一律 `data-testid` / `class*=` 前缀。
- rowspan 分组：每 SKC 组 = 首行（含商品信息格，四字段都在这）+ N 个 SKU 行 + 1 个「合计」行（无商品信息格，扫描时自然跳过）。
- 标准分页器（非虚拟滚动）：`beast-core-pagination`；末页 next 含 `PGT_disabled`。

## 采集流程与坑

1. `maximizePageSize`：best-effort 调大每页条数，写后读校验；下拉选项在 body portal，
   过滤「纯数字 + 可见 + 不在分页器内」防止误点页码；失败降级按当前条数翻页。
2. 回第 1 页（改条数可能重置页码；用户也可能停在第 N 页点开始，不回头会漏采）。
3. 逐页 `collectPageGroups` → `Map<SKC,row>` 去重 → `clickNextAndWait` 翻页。
4. **翻页后必须等内容签名（激活页|首组SKC|组数）变化**，spin 遮罩消失不够（auto_ship #47 同款坑）。
   **且点击本身可能被刷新尾声吞掉（点了 ≠ 生效，端到端实测）**→ `clickNextAndWait` 每次点击只等 8s，
   没变化就重点（≤3 次）；签名变化后校验激活页码 == 期望页，跳页（双点击都生效）则中止防漏采。
5. 任一页 0 组 / 缺 SKC 字段 → 立即中止不写文件；错误文案分「读取失败/数据校验/写入失败/不能操作」四层。
6. 「共有 N 条」与采集 SKC 数不一致时只提示不硬校验（N 可能为 SKU 计数）。

## native host 用法（不新增 action）

`PICK_FOLDER`（保存目录，localStorage `smeSavePath`）+ `SAVE_FILE_CHUNK`（512KB 分块写 CSV）。
