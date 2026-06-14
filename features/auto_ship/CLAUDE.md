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

**双触发入口**：
(1) 人工——Hub「开始/单步」按钮；
(2) 编排器——automation 大脑经 SW 发 `AUTO_SHIP_RUN_ONE` 命令（content 的
  `chrome.runtime.onMessage → asHandleRunOne`，一次处理一单），由
  `automation/bg-entry.js` 的 `orchAdapterShip` 驱动；编排器模式强制 `autoConfirm=true`
  跳过逐单确认弹窗、返回结构化 `{status, result, error}`、发货后 `waitOrderGone`
  等单消失确认。仍无 background/handler.js、无 native host。

## 关键设计

- **一行一单**（重要，与初始假设不同）：每个 `[data-testid="beast-core-table-body-tr"]` =
  一个发货单，自带 checkbox，**无 rowspan 分组**（不同于 packing_label 待仓库收货 tab）。
  故定位用 `findRow`(按 tr)，非 `findGroup`。
- 虚拟滚动表格：每轮重扫活表格 + 按发货单号去重(processed-set)，不一次性快照
- 防脏数据：流程自探测 in-page tab，不在待装箱发货主动切回(`ensureOnPendingTab`)；
  无未处理单时切 tab 刷新再确认才结束(`nextPick` 二次扫描)；等包裹号中途切 tab 刷新一次(`waitPackageNo`)；
  **发货后等上一个已发货单从扫描结果消失再取单**(`run.lastShipped`，超时 8s 降级)——发货后表格异步刷新，
  中间态下行渲染不全会漏扫其他单（实测：虚拟滚动下行渲染不全会漏扫某些行），「已发货单消失」才是刷新完成的真实信号
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

### 弹层容器有三类（联调 dump 确认，关键——不能一个 topModal 通吃）

Temu Beast 弹层分三种容器，各自定位（见 samples/{print_confirm,first_ship_small,batch_ship,edit_page}.txt）：

| 步骤 | 容器类型 | 定位 | 动作 |
|------|---------|------|------|
| 确认打印商品打包标签 | **modal** (`MDL_`) | `topModal` = `[data-testid="beast-core-modal-inner"]` 取末个 | 点正文 dashed link「先发货后打印」(`clickFirstShipThenPrint`) |
| 先发货后打印 二次确认 | **popover** (`PP_`) | `topPopover` = 可见 `[class*="popoverContent"]` | 点「确认」(`confirmSmallModal`) |
| 批量装箱发货 确认 | **modal** | `topModal` | 点「去装箱发货」(`confirmBatchShipModal`，含「30天不再提醒」勾后不弹的容错) |
| 装箱发货 编辑页 | **drawer** (`Drawer_`) | `topDrawer` = 可见 `[data-testid="beast-core-drawer-content"]` | 见下 |
| 确认发货 二次确认 | **popover** | `topPopover`（drawer 内点完「确认发货」后弹出，标题「确认装箱完毕并发货？」） | 点「确认」(`confirmShipPopover`)——**漏点这步 drawer 不会关、不真发货** |

### 编辑页（drawer）字段——按 form-item id 精确定位

| 字段 | form-item id | 控件 | 操作 |
|------|-------------|------|------|
| 包装方式 | `#packagingType` | radioGroup | 找 radio label 内 `.RD_textWrapper`=「箱子和袋子」→ 点 label(`selectPackType`，写后读 data-checked) |
| 发货总箱/包数 | `#expressPackageNum` | inputNumber | `input[data-testid="beast-core-inputNumber-htmlInput"]` 填「1」(`fillBoxCount`，写后读 value) |
| 预约取货时间 | `#expectPickUpGoodsDate` / `#expectPickUpGoodsTime` | datePicker / timePicker | **填完箱数后 Temu 自动补日期**，时间需手选「18:00」(`fillPickupTime`，写后读 value)；详见踩坑 7 |
| 确认发货 | drawer footer | button | span「确认发货」(`clickConfirmShip`)；其余字段(发货方式/重量/仓库)已预填不动 |

## 踩坑清单（联调实测，后续复用）

1. **checkbox/radio 程序化勾选必须点 label，不能点 input**：`input.click()` 无效(data-checked 不变)，
   `label.click()`(即 `[data-testid="beast-core-checkbox"]`/`beast-core-radio` 元素本身) 才触发 React onChange。
2. **本地仓识别误判**：`label.parentElement.querySelector('div span')` 会误中 label 自身文字「发货仓库：」，
   改用整列文本 regex `发货仓库[:：]\s*([\s\S]*?)(?:更换|收货仓库|$)`。
3. **topModal 宽候选取到空 gradient**：`[class*="MDL_"]` + `c[last]` 会落到空的 `MDL_overflowGradient`，
   必须优先 `[data-testid="beast-core-modal-inner"]`。
4. **三类弹层容器**(见上表)：modal/popover/drawer 各自定位，混用必失配。
5. **批量装箱发货按所有选中行操作**：选中当前单前必须 `clearOtherSelections` 清掉上一单残留选中
   (尤其取消未发货的单 checkbox 仍勾着)，否则两单一起被操作而失败。
6. **包裹号空值文案**「打印打包标签后展示」(非空串/`-`)，已入 `PKG_PLACEHOLDERS`。
7. **「确认发货」按钮不是终点**：drawer footer 点完「确认发货」后 Temu **再弹 popover** 二次确认
   （标题「确认装箱完毕并发货？」），漏点这步 drawer 不会关、列表不刷新、**根本没真发货**。
   `clickConfirmShip` 必须在点完按钮后 `await confirmShipPopover()`。联调踩过——只点 drawer 按钮看着像成功
   （popover 自己出来还以为是 toast），实际后端零请求。
8. **预约取货时间填完箱数后才激活**：旧 dump「disabled 不动」是填箱数前的态；填完「发货总箱/包数」后
   Temu 自动补日期(`#expectPickUpGoodsDate`)、激活时间选择器(`#expectPickUpGoodsTime`)但时间为空，
   必须手选 18:00(`fillPickupTime`)。坑点：① 时间 input `readonly`，不能 setInputValue，必须点开下拉选；
   ② 下拉是 **document 级 portal**（`[data-testid="beast-core-portal"]` 内 `timePicker-list-hh/mm` 两 ul），
   **不在 drawer 内**，查询用 document 不能用 editScope()；③ **选「时」前「分」列表全 disabled**，
   选完 18 后 mm 才异步刷新出可选项，故 `clickTimeListItem('mm',..)` 轮询等待；④ `cIL_disabled` li 不可选
   （含已过时段，dump 里 00-13 时禁用），`cIL_active` 只是高亮态不代表可选；⑤ 无「确定」按钮，选完即回填。

## 已知限制

- F5 刷新会重头开始（半自动有人盯，可接受）
- ON 全自动模式连续发真实货，需用户自行确认批次
- `clearOtherSelections` 只清当前可见行选中；虚拟滚动下若残留选中行滚出视口可能漏(行少通常可见)
- 「共 N 个」总数含本地仓单(会被「处理」即跳过)，故 X 最终能到 N；若要 N 只算待发非本地仓单需开始前全扫分类
- Temu 改版/弹层结构变化时据 samples/ 复核 selector

## 调试

```bash
node --test features/auto_ship/tests/auto_ship-logic.test.js   # 纯逻辑回归(9 tests)
python3 build/build_extension.py                               # 构建 → dist/extension
# chrome reload → 发货单列表「待装箱发货」tab → Hub「自动发货」→ 开关 OFF → 开始
```
- 看运行态：面板进度/汇总区；失败明细 console `[auto_ship] 单失败:`
- 单步调试：发货单页 console 跑 `window.__AutoShipLogic.isLocalWarehouse('化州中正科技')` 等纯函数
