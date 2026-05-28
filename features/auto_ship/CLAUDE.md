# auto_ship Feature（自动发货）

> 顶层架构见项目根 CLAUDE.md。本文档只覆盖本 feature 细节。
> 设计 spec：docs/superpowers/specs/2026-05-28-auto-ship-design.md
> 实施 plan：docs/superpowers/plans/2026-05-28-auto-ship.md
> （spec/plan 是初始设计；本文件记录最终落地，二者有差异以本文件为准）

## 作用

发货单列表页（seller.kuajingmaihuo.com/main/order-manager/shipping-list）「待装箱发货」tab，
自动遍历发货单：非本地仓单走「打印商品打包标签(先发货后打印)→等包裹号→批量装箱发货→
编辑页填箱子和袋子+1箱→确认发货」；本地仓(化州中正科技)跳过；包裹号已存在的跳过打印步；
单步失败记录并跳过下一单。「确认发货」是不可逆出货，由 Hub 开关门控（默认逐单弹窗确认）。

## 架构（纯 content-script 单页编排，无 background/native host）

- `content/auto_ship-logic.js` — 纯函数（isLocalWarehouse/isValidPackageNo/dedupOrderNos/
  summarize；双 browser/node 导出），node 单测；只在 kuajingmaihuo 注入(document_start)
- `content/index.js` — DOM 适配层 + 逐单确认框 + 单发货单状态机 + 主循环 + Hub UI
- 运行态(processed/进度/fails)驻留内存（SPA 不整页 reload）；
  仅「自动确认发货」开关存 chrome.storage.local['auto_ship_auto_confirm']
- 主 index.js 在全域注入(项目既有行为，FAB 多域出现)；用到 logic 的路径被 isShipListPage 拦在发货单页

## 关键设计

- **一行一单**（重要，与初始假设不同）：每个 `[data-testid="beast-core-table-body-tr"]` =
  一个发货单，自带 checkbox，**无 rowspan 分组**（不同于 packing_label 待仓库收货 tab）。
  故定位用 `findRow`(按 tr)，非 `findGroup`。
- 虚拟滚动表格：每轮重扫活表格 + 按发货单号去重(processed-set)，不一次性快照
- 防脏数据：流程自探测 in-page tab，不在待装箱发货主动切回(`ensureOnPendingTab`)；
  无未处理单时切 tab 刷新再确认才结束(`nextPick` 二次扫描)；等包裹号中途切 tab 刷新一次(`waitPackageNo`)
- 写后读校验：选中 checkbox / 编辑页包装方式 / 箱数 填后回读(项目铁律)
- 错误分层：读取(`markRead`)/校验(`markData`)/业务(`markBiz`)，`catLabel` 映射「读取/校验/业务」，文案不混用

## DOM selector 现状（据 samples/table_and_tabs.txt 真实 dump）

`SEL` 常量是集中维护点。已据真实 DOM 确认：

| 目标 | 定位 | 状态 |
|------|------|------|
| 数据行 | `[data-testid="beast-core-table-body-tr"]`，一行一单 | ✓ dump 确认 |
| 列顺序 | td[0]=checkbox / td[1]=发货单号 / td[3]=发货信息(发货仓库) / td[4]=包裹号 / td[6]=操作 | ✓ dump 确认 |
| 发货单号 | td[1] 内首个无子元素纯文本 div（FH…） | ✓ dump 确认 |
| 发货仓库 | td[3]「发货仓库：」label 后内层 div 第一个 span | ✓ dump 确认 |
| 包裹号空值 | 文字「打印打包标签后展示」→ 视为空(已入 PKG_PLACEHOLDERS)；有值 PC+数字 | ✓ dump 确认 |
| checkbox | `[data-testid="beast-core-checkbox"]` data-checked / 内 input | ✓ dump 确认 |
| 操作列按钮 | td[6] `a[data-testid="beast-core-button-link"]` span 文字「打印商品打包标签」 | ✓ dump 确认 |
| in-page tab | `[data-testid="beast-core-tab-itemLabel"]` 文字精确匹配；激活态 class 含 active | ✓ dump 确认 |
| 滚动容器 | `[class*="contentContainer"]`（页面级） | ✓ dump 确认 |

**🔴 联调待验证（未 dump，用文字匹配初版，Task 11 现场确认/修正）：**
- 「确认打印商品打包标签」弹窗 → 下划线「先发货后打印」(`clickFirstShipThenPrint`)
- 「先发货后打印」后小弹窗 →「确认/确定」(`confirmSmallModal`)
- 「批量装箱发货」页面级按钮(`clickBatchShip`，文字匹配) + 确认弹窗「去装箱发货」(`confirmBatchShipModal`)
- **inner 编辑页**（风险最高）：「包装方式」点选「箱子和袋子」(`selectPackType`，控件类型 radio/卡片/select 待定) +
  「发货总箱/包数」输入框(`fillBoxCount`，placeholder 待定) + 「确认发货」按钮(`clickConfirmShip`)
- 弹窗容器 `topModal` 用宽候选(beast-core-modal-inner/DLG_/MDL_/role=dialog)，联调确认是否命中
- 联调若失败：据现场 dump 补 samples/{print_confirm,first_ship_small,batch_ship,edit_page}.txt + 修对应函数

## 已知限制

- F5 刷新会重头开始（半自动有人盯，可接受）
- ON 全自动模式连续发真实货，需用户自行确认批次
- 弹窗/编辑页 selector 为文字匹配初版，Temu 改版或弹窗结构特殊时需 dump 复核

## 调试

```bash
node --test features/auto_ship/tests/auto_ship-logic.test.js   # 纯逻辑回归(9 tests)
python3 build/build_extension.py                               # 构建 → dist/extension
# chrome reload → 发货单列表「待装箱发货」tab → Hub「自动发货」→ 开关 OFF → 开始
```
- 看运行态：面板进度/汇总区；失败明细 console `[auto_ship] 单失败:`
- 单步调试：发货单页 console 跑 `window.__AutoShipLogic.isLocalWarehouse('化州中正科技')` 等纯函数
