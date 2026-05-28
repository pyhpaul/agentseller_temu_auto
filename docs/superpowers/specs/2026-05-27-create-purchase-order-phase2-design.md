# 创建采购单 Feature — Phase 2 设计

> 日期：2026-05-27
> Feature ID：`create_purchase_order`
> 范围：**仅 Phase 2**（在店小秘「创建现有订单」生成采购单并通过审核 → 跳待到货页定位商品行 → 提醒手动申请付款）。
> 前置：Phase 1 已完成（已合入 main #32）。Phase 2 读 `cpo_state.phase1.collected` 拿已采集数据，不重新采集。
> （spec 是初始设计；最终落地以 feature 的 `CLAUDE.md` 为准，二者有差异以 CLAUDE.md 为准。）

## 1. 背景与目标

Phase 1 已经在店小秘建好了商品 SKU。Phase 2 把「在店小秘为这个 SKU 创建一张采购单、通过审核、移入待到货」这件原本手工跨多个店小秘页面操作的事自动化，最终停在「申请付款」前由用户手动确认付款。

Phase 2 全程在店小秘域（`www.dianxiaomi.com`）内，**不跨 Temu / 1688**，不调用 native host（纯 DOM + tab 编排）。

### 用户输入（Phase 2 新增）
| 输入 | 用途 |
|------|------|
| `1688订单号` | Phase 2 ②区新增输入框；填进 add 页「1688订单」框，作为获取 1688 订单的关键字；也是 hub 输出的 `bbb` |

`skuNo`（SKU货号）不再让用户输入，bg 直接从 `cpo_state.phase1.collected.skuNo` 读。

### 触发条件
②区「开始创建采购单」按钮可点 = **三者同时满足**：
1. `cpo_state.phase1.status === 'done'`
2. 当前 tab 在店小秘页（`isDxmPage()`）
3. ②区输入框填了 `1688订单号`

### 非目标（Phase 2 不做）
- 不自动点「申请付款」（本期只提醒，用户手动点；自动点留待后续迭代）
- 不做 reload 跨刷新续跑的复杂状态机（沿用 Phase 1 的轻状态模型）
- 不处理「同一 SKU 历史多张采购单」的歧义——采购单号直接从审核成功弹窗文本取，不依赖待到货页搜索结果

## 2. 控制模型（已与用户确认）

- **一键连续跑完**：从点「开始创建采购单」到停在「申请付款」前，全自动连续跑，中途只在异常时停。
- **全程状态提示 + toast**：每个 step 把中文 label 写进 `cpo_state.phase2`，面板②区实时显示；关键步骤辅以全屏 toast。
- **唯一人工终点**：流程跑到待到货页、定位出商品行后停下，hub 显示订单信息并提醒用户手动点「申请付款」。
- **起点**：用户在**任意店小秘页**打开 Hub →②区填 1688订单号 → 点「开始创建采购单」。触发 tab 保留不动，bg 另开/捕获工作 tab，便于异常时关掉工作 tab 天然回到触发 tab。

## 3. 架构（沿用 Phase 1）

跨多 tab、跨页面状态共享的约束已锁定架构，沿用 Phase 1 验证过的模式，不引入替代方案：

- **bg 编排大脑**（`core/background/service-worker.js` 标记段内）：新增 `cpoRun2()` 主序列 + `cpoSetPhase2()` 写状态，复用现成 `cpoWaitTabComplete` / `cpoSendCommand` / `cpoCloseTab`。
- **状态源**：`chrome.storage.local['cpo_state'].phase2`，content 各 tab 靠 `storage.onChanged` 同步显示。
- **content 命令处理器**：在现有 `handlers` 表加 Phase 2 店小秘各页命令；content 不自驱，只响应 bg 命令。

### tab 流转策略（领域信息已确认）

| 跳转 | URL 可预测性 | 策略 |
|------|------|------|
| 起点 → `draft/aliPurchasing` | 固定 URL | bg 构造 URL 开 tab |
| `draft → add` | **add 是新建参数、不可预测** | **必须跟随**：content 在 draft 页点「创建采购单」下拉→「创建现有订单」→ 店小秘弹出 add tab → bg 用 `chrome.tabs.onCreated`（按 `openerTabId` + URL 含 `/order/add` 匹配）捕获接管 |
| `add → edit` | edit 可能固定（dump 确认） | 以**跟随跳转**为主：「获取1688订单」成功后店小秘自动跳 edit，bg 监听 add tab `onUpdated` 到 `/order/edit`（或捕获新弹 tab）；URL 固定与否只影响兜底重开 |
| `edit → waitArrival` | 固定 URL | bg 构造 URL 开 tab |

> ⚠️ **dump 阶段必须先验证的风险点**：content 在 draft 页 `.click()`「创建现有订单」时已脱离原始用户手势，若它是 `_blank`/`window.open`，可能被 Chrome 弹窗拦截（Phase 1 点「编辑」链接踩过同类坑）。dump 时确认其真实跳转机制；若被拦，需在实现阶段调整（如读 href 构造 URL，或退回让用户在该步手动点）。
>
> ⚠️ **tab 捕获监听的注册时序**：bg 监听新弹 tab（`chrome.tabs.onCreated`）必须在**发出触发点击的命令之前**注册，否则点击瞬间弹出的 tab 会漏捕获（同项目其它 feature「捕获监听必须 click 前注册」经验）。`add→edit` 的导航/新 tab 监听同理，须在发 `CPO_P2_ADD_FETCH` 前挂好。

## 4. 编排序列

每个 step 把 `{status:'running', step, label}` 写进 `cpo_state.phase2`，②区面板实时显示。

| step | 页面 | bg 动作 + content 命令 | 异常分流 |
|---|---|---|---|
| 1 | draft | 开 draft tab → `CPO_P2_DRAFT_CREATE`（点下拉→创建现有订单）→ 捕获 add tab | 捕获不到 add tab → error |
| 2 | add | `CPO_P2_ADD_FETCH{orderNo1688}`（选 1688账号第一项 + 填 1688订单号 + 点「获取1688订单」） | — |
| 3 | add | **弹窗分流（bg 主导）**：bg `Promise.race` [`CPO_P2_ADD_FETCH` 返回「已存在弹窗」, bg 监听 add tab 跳转 `/order/edit`]。content 只检测已存在弹窗、不判断跳转（跳转会销毁 content script） | 已存在弹窗先到 → **error**：关 add tab（天然回触发 tab）→ ②区红字「当前输入的1688订单号已入库」 |
| 4 | edit | `CPO_P2_EDIT_FILL{skuNo}`（采购人员选 user_name、收货仓库选「中正科技仓」、配对商品弹窗：搜索类型=商品SKU→填 SKU货号→搜索→唯一行点「选中」→「修改所有xxx」→「确认」） | 配对搜不到商品 → error |
| 5 | edit | `CPO_P2_EDIT_SAVE`（点「保存，并通过审核」→ 抓成功弹窗文本 → 正则提 `poNo`） | 无成功弹窗 / 未提到 poNo → error，**不误标 done** |
| 6 | waitArrival | 跳 waitArrival → `CPO_P2_WAIT_SEARCH{skuNo}`（搜索类型=商品SKU、搜索内容=SKU货号、点搜索，定位商品行） | 搜不到只 warn，不阻断 done |
| 7 | — | `cpo_state.phase2 = done`；②区显示 `当前订单信息：poNo（orderNo1688）`，toast 提醒**手动点「申请付款」** | — |

- `skuNo` bg 从 `cpo_state.phase1.collected.skuNo` 读，不经 content 传入。
- `user_name` 由 content 在 edit 页读 `.user-name`（和 Phase 1 一致），不写死。
- 收货仓库「中正科技仓」当前写死文案，dump 确认下拉选项结构。
- 1688账号「下拉只有一个、与当前店小秘账号绑定」→ 直接选第一项，不按文本匹配。

## 5. 消息协议（新增）

| 方向 | type | data | 返回 | 说明 |
|---|---|---|---|---|
| content→bg | `CPO_START_PHASE2` | `{orderNo1688}` | `{ok}` | 立即 ack，bg 异步跑 `cpoRun2`；skuNo bg 自取 |
| bg→tab | `CPO_P2_DRAFT_CREATE` | — | `{ok}` | draft 点「创建采购单」下拉→「创建现有订单」 |
| bg→tab | `CPO_P2_ADD_FETCH` | `{orderNo1688}` | `{ok, exists:bool, message?}` | add 页选账号 + 填订单号 + 点获取后，轮询是否出现「已存在」弹窗；`exists=true` 即已入库。页面跳转 edit 会销毁本命令通道，由 bg 监听捕获，不视作错误 |
| bg→tab | `CPO_P2_EDIT_FILL` | `{skuNo}` | `{ok}` | edit 填采购人员/收货仓库 + 配对商品全流程 |
| bg→tab | `CPO_P2_EDIT_SAVE` | — | `{ok, poNo}` | 点「保存，并通过审核」+ 抓成功弹窗 + 提 poNo |
| bg→tab | `CPO_P2_WAIT_SEARCH` | `{skuNo}` | `{ok, found}` | waitArrival 搜索定位商品行 |

> 弹窗分流（step 3）**bg 主导**，不让 content 判断跳转——「跳转 edit」会导致 add 页 content script 随页面销毁、无法回传。bg `Promise.race` 两路：(a) `CPO_P2_ADD_FETCH` 返回 `exists=true`（检测到「已存在/不能重复添加」弹窗）→ 中断；(b) bg 监听 add tab 导航到 `/order/edit`（或捕获新弹 edit tab）→ 接管。content 通道因导航中断时 bg 走 (b)，不视作错误。监听须在发 `CPO_P2_ADD_FETCH` 前挂好（见 §3 注册时序）。

## 6. 数据模型

```
cpo_state.phase2 = {
  status: 'idle' | 'running' | 'done' | 'error',
  step: 0..7,
  label: '<当前步骤中文>',
  collected2: { poNo: '', orderNo1688: '' }   // poNo=采购单号 PO1SLPTxxx；orderNo1688=用户输入
}
```

- `orderNo1688`：用户在②区输入框填入。
- `poNo`：从审核成功弹窗文本 `操作成功：xx个，采购单：PO1SLPTxxx已移入待到货状态` 正则提取。
- ②区数据行：`done` 时显示 `当前订单信息：<poNo>（<orderNo1688>）`。

## 7. 纯逻辑（cpo-logic.js 新增，走 node --test）

- `extractPoNo(successText)`：从审核成功弹窗文本正则提 `采购单：(PO\w+)`，无匹配返回 `null`。
- `validatePhase2({ orderNo1688, phase1Done })`：phase1 未 done → `{ok:false, error:'请先完成 Phase 1 添加SKU'}`；订单号空 → `{ok:false, error:'1688订单号不能为空'}`；否则 `{ok:true}`。

## 8. 错误文案分层（项目铁律）

| 失败类别 | 例 | 文案 |
|---|---|---|
| 读取/选择器故障 | 捕获不到 add tab、配对弹窗未出现、保存按钮未找到 | 「未找到 X / X 未出现」+ 所在页面 |
| 数据校验 | 1688订单号空、phase1 未 done | 「X 不能为空 / 请先完成 Phase 1」 |
| 业务拦截 | 该 1688 订单已入库不能重复添加 | 「当前输入的1688订单号已入库」 |

「已入库」是**业务拦截**（非读取失败），文案必须让用户 5 秒内看懂是「这单做过了」而非「页面读不到」。

## 9. 测试策略

- **纯逻辑**：`cpo-logic.test.js` 加 `extractPoNo` / `validatePhase2` 用例（正常 + 边界 + 无匹配）。
- **DOM 交互层**：无法单测，靠 **dump 真实 DOM + 手动实测**（Phase 1 同款铁律）。实现第一步先抓 4 个页面 DOM 基线进 `samples/`：
  - `draft/aliPurchasing`（创建采购单下拉、创建现有订单项）
  - `add`（1688账号下拉、1688订单框、获取1688订单按钮、已存在弹窗）
  - `edit`（采购人员/收货仓库下拉、配对商品按钮、配对弹窗含「修改所有xxx」、保存并通过审核按钮、审核成功弹窗）
  - `waitArrival`（搜索类型/搜索内容、商品信息表格、物流列、申请付款按钮、采购单号）

## 10. 文件改动范围

- `core/background/service-worker.js`：标记段内加 `cpoRun2` / `cpoSetPhase2` / tab 捕获辅助 + `CPO_START_PHASE2` 路由。
- `features/create_purchase_order/content/index.js`：②区 UI 加输入框 + 启用逻辑 + 6 个 `CPO_P2_*` handler + hub 输出渲染。
- `features/create_purchase_order/cpo-logic.js`：加 `extractPoNo` / `validatePhase2`。
- `features/create_purchase_order/tests/cpo-logic.test.js`：加测试。
- `features/create_purchase_order/samples/`：加 4 个页面 DOM 基线。
- `features/create_purchase_order/CLAUDE.md`：补 Phase 2 实现 + 踩坑。

**feature.json 不改**：三域 content_matches、`tabs/storage/scripting` 权限 Phase 1 已覆盖，Phase 2 全在店小秘域内。

## 11. 已知限制 / 风险

- 「创建现有订单」若 `_blank` 被拦，需实现阶段调整（见 §3 风险点）。
- 收货仓库写死「中正科技仓」、1688账号选第一项——换仓库/多账号场景需改代码。
- 待到货页搜索若该 SKU 有多张采购单，定位的是搜索结果行（仅用于让用户找到申请付款入口）；采购单号不依赖此结果，从审核弹窗取，无歧义。
- 申请付款本期手动，不校验付款是否成功。
