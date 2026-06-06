# sale_manage_export Feature

> 顶层架构见项目根 `CLAUDE.md`。本文档只覆盖本 feature 细节。

## 作用

销售管理页（`https://agentseller.temu.com/stock/fully-mgt/sale-manage/main`）一键采集
结果表格**所有分页**的 SKC / SKC货号 / SPU / 商品名称（SKC 粒度），按 SKC 去重后导出
xlsx（`销售管理清单_YYYYMMDD_HHMMSS.xlsx`，固定列宽 + 全表左对齐）到预设文件夹。

## 文件

- `content/sme-utils.js` — 纯函数（CSV 转义 / 字段解析 / 文件名），双导出，document_start 注入挂 `window.__SMEUtils`
- `content/sme-xlsx.js` — 最小 xlsx 生成器（zip stored + CRC32 + inlineStr sheet，无第三方依赖），挂 `window.__SMEXlsx`
- `content/index.js` — panel UI + 表格扫描 + 分页循环 + SAVE_FILE_CHUNK 落盘
- `tests/sme-utils.test.js`、`tests/sme-xlsx.test.js` — `node --test`

## 表格 DOM 关键事实

- Beast UI 表格，class 带版本 hash（`_5-120-1`）→ selector 一律 `data-testid` / `class*=` 前缀。
- rowspan 分组：每 SKC 组 = 首行（含商品信息格，四字段都在这）+ N 个 SKU 行 + 1 个「合计」行（无商品信息格，扫描时自然跳过）。
- 标准分页器（非虚拟滚动）：`beast-core-pagination`；末页 next 含 `PGT_disabled`。
- **`Spn_spinningMask` 不能当 loading 信号**：该 mask 节点常驻 DOM 且恒为 `display:block` 可见
  （静止状态实测 offsetParent 非 null、盖住整个表格区域）。用它做等待门槛会让就绪判断永远不执行。
  loading 等待只认内容签名变化。

## 采集流程与坑

1. `maximizePageSize`：best-effort 调大每页条数，写后读校验；下拉选项在 body portal，
   过滤「纯数字 + 可见 + 不在分页器内」防止误点页码；失败降级按当前条数翻页。
2. 回第 1 页（改条数可能重置页码；用户也可能停在第 N 页点开始，不回头会漏采）。
3. 逐页 `collectPageGroups` → `Map<SKC,row>` 去重 → `clickNextAndWait` 翻页。
4. **翻页后必须等内容签名（首组SKC|末组SKC|组数）变化**，spin 遮罩消失不够（auto_ship #47 同款坑）。
   **签名禁止含激活页码**：点 next 后页码立即变、表格数据 4-5s 后才到（端到端实测），
   含页码的签名会提前放行 → 扫旧数据重复采集 + 连点误判末页。只认表格内容变化。
   `clickNextAndWait` 每次点击等 8s 内容变化，没变就重点（≤3 次）；变化后校验激活页码 == 期望页，
   跳页（双点击都生效）则中止防漏采。
5. 任一页 0 组 / 缺 SKC 字段 → 立即中止不写文件；错误文案分「读取失败/数据校验/写入失败/不能操作」四层。
6. 「共有 N 条」与采集 SKC 数不一致时只提示不硬校验（N 可能为 SKU 计数）。
7. **数据源稳定性**：每页比对「共有 N 条」与开始时是否一致，变了（采集中用户改筛选）立即中止防混杂。
8. **前台约束**：后台 tab 被 Chrome 节流 timer，采集会变慢/假死 → 开始时 toast + 状态区提醒保持前台；
   每页采完弹一次进度 toast。
9. 导出格式为 xlsx（v2，原 CSV 方案被列宽问题淘汰）：列宽/左对齐是**文件属性，CSV 无法承载**——
   `="..."` 文本公式只解决了对齐和科学计数，解决不了列宽。`sme-xlsx.js` 手写最小 xlsx：
   zip stored（不压缩，省 deflate 实现）+ CRC32 + 6 个固定 XML 部件；sheet 用 inlineStr
   单元格免 sharedStrings；`<cols>` 固化列宽（SKC 14 / SKC货号 12 / SPU 14 / 商品名称 60）；
   styles.xml `cellXfs[1]` 左对齐（注意 fills 必须 ≥2，否则部分 Excel 报文件损坏）。
   SKC/SPU 列出**数字单元格**（`<v>`，无绿三角提示）；值非安全数字（含字母/前导零/超
   15 位双精度丢精度）时逐格回退文本。SKC货号/商品名称恒为 inlineStr 文本。
   CSV 函数（`csvTextField` / `buildCsvText`）保留未删，xlsx 出问题可一行切回。

## native host 用法（不新增 action）

`PICK_FOLDER`（保存目录，localStorage `smeSavePath`）+ `SAVE_FILE_CHUNK`（512KB 分块写 xlsx）。
