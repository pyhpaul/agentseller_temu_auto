# 创建采购单 Feature — 商品复购模式 设计

> 日期：2026-05-29
> Feature ID：`create_purchase_order`
> 范围：在现有 ①添加SKU / ②创建采购单 两阶段之上，新增「商品复购」模式，让已走过完整流程的复购商品**跳过 Phase 1**，手填 `SKU货号 + 1688订单号` 直接跑 Phase 2。
> 前置：Phase 1（已合入 main）、Phase 2（已合入 main）。本次只增量改三处逻辑分叉 + ②区 UI，不动 Phase 2 内部编排步骤。
> （spec 是初始设计；最终落地以 feature 的 `CLAUDE.md` 为准，二者有差异以 CLAUDE.md 为准。）

## 1. 背景与目标

现状：新商品入库必须先在 Temu 列表页跑 ①添加SKU（采集货号/标题/预览图 → 店小秘建 SKU），Phase 1 done 后才能在店小秘页跑 ②创建采购单。Phase 2 的 `skuNo` 硬从 `cpo_state.phase1.collected.skuNo` 读、并强校验 `phase1.status==='done'`。

问题：**复购商品**（已走过一遍流程、店小秘已有 SKU 档案）再次采购时，无需重建 SKU，但现状强制要求 Phase 1 done 才能跑 Phase 2，等于每次复购都要空跑一遍①。

目标：新增「商品复购」开关。勾选后用户手填 `SKU货号 + 1688订单号` 即可直接跑 Phase 2，跳过①。SKU货号输入框的校验与样式与 1688订单号一致（都只校验非空）。

## 2. 作用域与页面约束（关键决策，已与用户确认）

复购流程本质 = **跳过 Phase 1，在店小秘页手填两个输入直接跑 Phase 2**。由此锁定两条边界：

- **复购开关 + SKU货号输入框只在店小秘页（`isDxmPage()`）渲染**。Temu 列表页不显示开关 —— 在 Temu 页跑复购无意义，显示开关会误导。
- **①区灰显只在店小秘页生效**。Temu 列表页①区永远正常可用。
  - **为什么**：开关只在店小秘页出现。若 Temu 列表页①区也随复购态灰显，用户在 Temu 页既无法取消复购（开关不在）、又无法用①区添加SKU → **死锁**。故①区灰显严格限定 `isDxmPage()`。

> 此约束偏离了「全局模式切换」的字面含义（开关视觉位置仍按用户选择放在①②之间），但规避死锁。复购被定位为「店小秘页 ②区的一个模式」，Temu 列表页不受影响。

## 3. UI 结构（店小秘页 ②区）

```
① 添加SKU
  状态：✅ 已完成 / 未开始        ← 复购模式时整块 opacity 灰显 + pointer-events:none
  货号 xxx ｜ 标题 xxx
- - - - - - - - - - - - - - - -
[☑] 商品复购（手动填SKU货号，跳过①添加SKU）   ← 新开关，①②之间
② 创建采购单
  状态：未开始
  SKU货号：  [____________]      ← 新增输入框，复购可编辑 / 新品只读回填
  1688订单号：[____________]
  [☐] 自动点击「保存，并通过审核」…
  [ 开始创建采购单 ]
  采购单号：[_______] (done显示)
```

- **新品模式（默认未勾选）**：SKU货号框 `readOnly`、灰底，值由 `renderState` 回填 `phase1.collected.skuNo`（Phase 1 done 后自动出现）。
- **复购模式（勾选）**：SKU货号框可编辑（样式同 1688订单号框），①区灰显（`opacity:0.45 + pointer-events:none`）+ 一行提示「复购模式无需添加SKU，取消勾选可切回新品流程」。

## 4. 状态与数据流

- 新增持久化标志 `cpo_state.repurchase`（boolean）。
  - checkbox `change` 时写入 `cpo_state.repurchase`。
  - 「清除当前流程」随 `cpo_state` 一起 remove → 归 false。
  - 新品跑 Phase 1（`cpoRun` 整体重置 `cpo_state`）时不带 repurchase → 自然归 false。
- **为什么持久化**：沿用本 feature「`chrome.storage.local` 单一状态源 + `storage.onChanged` 跨 tab 同步」哲学。让 checkbox 勾选态 / SKU框可编辑性 / ①区灰显在面板重建、跨 tab 时保持一致（Phase 2 异步跑期间面板可能重建）。不引入第二套本地状态。
- 复购跑 Phase 2 时把手填 `skuNo` 写进 `cpo_state.phase2.collected2.skuNo`，供 done 后回填展示。

## 5. 三处逻辑分叉

| 位置 | 文件 | 新品（现状） | 复购（新增分支） |
|------|------|------|------|
| **校验** `validatePhase2` | `cpo-logic.js` | phase1 done + 订单号非空 | skuNo 非空 + 订单号非空（**不校验 phase1**） |
| **按钮启用** `recomputeP2Btn` | `content/index.js` | `lastP1Done && isDxmPage && orderVal && !locked` | `isDxmPage && orderVal && skuVal && !locked`（去掉 phase1 依赖） |
| **取 skuNo** `cpoRun2` | `service-worker.js` | `phase1.collected.skuNo` + 强校验 `phase1.status==='done'` | `data.skuNo`（消息传入）+ 跳过 phase1 校验 |

- **消息扩展**：`CPO_START_PHASE2 { orderNo1688, autoSave, repurchase, skuNo }`（后两字段复购时带）。
- **`validatePhase2` 签名扩展**：`validatePhase2({ orderNo1688, phase1Done, repurchase, skuNo })`。`repurchase===true` 走「skuNo + orderNo1688 非空」分支；否则走现状分支。保持向后兼容（旧调用不传 repurchase → 默认新品分支）。
- **`cpoRun2` 分支**：`data.repurchase` 为真时 `skuNo = (data.skuNo||'').trim()`、跳过 `phase1.status` 校验、把 skuNo 写进 `collected2`；否则现状（读 phase1）。Phase 2 的 add/edit/save/wait 步骤完全不变。

## 6. 完成锁定（用户选「同新品一致」）

- 锁定条件从 `bothDone`（依赖 `phase1.status==='done'`）改为 **`phase2.status==='done' && collected2.orderNo1688`**，覆盖两种模式（复购模式 phase1 可能 idle）。
- done 后：SKU货号框 + 1688订单号框都回填本次值并 `readOnly`、灰底；采购单号只读框显示；点「清除当前流程」才解锁恢复可输入。
- `renderState` 回填 SKU框值的优先级：`collected2.skuNo`（复购）> `phase1.collected.skuNo`（新品）。这样 done 后展示不依赖 checkbox 当前勾选态，单看数据源即可正确回填。

## 7. 校验与测试

- **纯逻辑单测**（`tests/cpo-logic.test.js`，`node --test`）：`validatePhase2` 新增复购分支用例 —— 复购缺 skuNo / 复购缺订单号 / 复购两者齐全 / 新品分支不回归。
- **UI + 编排**：手动验证（chrome reload → 店小秘页勾「商品复购」→ 填 SKU货号+订单号 → 开始 → 走完 Phase 2）。复用 Phase 2 现成手动验证路径。
- **写后读铁律不变**：Phase 2 内部 edit 页填表的写后读校验（`cpoSelectAndVerify` 等）完全沿用，复购只改 skuNo 来源不改填表逻辑。

## 8. 非目标

- 不改 Phase 2 内部任何编排步骤（add 取单 / edit 填表配对 / save 审核 / wait 定位）—— 复购只换 skuNo 来源 + 跳过前置校验。
- 不做「复购模式下也能在 Temu 列表页操作」—— 复购严格限定店小秘页。
- 不校验「用户手填的 SKU货号在店小秘是否真有档案」—— 沿用现状，配对弹窗搜不到时 `cpoPairProduct` 自然报「未找到配对结果」。
- 不批量复购（一次一个 SKU），与现状一致。
