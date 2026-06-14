# create_purchase_order Feature

> 顶层架构（公共骨架 / 注册契约 / Core API / 构建 / native_host）见项目根 `CLAUDE.md`。本文件覆盖本 feature 细节，并**沉淀 Temu 商家中心 + 店小秘 自动化的踩坑与最佳实践**，供后续 Phase 与新 feature 复用。
>
> 设计 spec：`docs/superpowers/specs/2026-05-26-create-purchase-order-phase1-design.md`
> 实施 plan：`docs/superpowers/plans/2026-05-26-create-purchase-order-phase1.md`
> （spec/plan 是初始设计；本文件记录**最终落地实现**，二者有差异以本文件为准）
> v1.2.2 简化复购 spec：`docs/superpowers/specs/2026-06-01-cpo-repurchase-simplified-design.md`
> v1.2.2 简化复购 plan：`docs/superpowers/plans/2026-06-01-cpo-rebuy-simplified.md`

## 概述

- **Feature ID**：`create_purchase_order`「创建采购单」，order=5
- **作用**：把「在店小秘新建商品 SKU + 创建采购单」这件跨 Temu / 1688 / 店小秘 三平台手工搬运的事自动化
- **两阶段**（状态都在面板显示，但各自页面触发，**不自动串联**，用户手动逐段触发）：
  - **① 添加SKU（Phase 1，已实现）**：在 **Temu 商品列表**发起 → 自动从 Temu 取数 + 1688 取标题 → 在店小秘建商品 SKU 并自动保存
  - **② 创建采购单（Phase 2，已实现）**：在 **店小秘**发起（需 Phase 1 完成）→ 填 1688订单号 → 新开 tab 自动走「创建现有订单 → 获取1688订单 → 编辑页填采购人员/收货仓库 + 配对商品 → 保存并通过审核 → 待到货页搜索定位」，停在「申请付款」前交人工
- **跨三域**：`agentseller.temu.com` / `detail.1688.com` / `www.dianxiaomi.com`（content_matches 显式声明三域；FAB 会在三域出现，项目已知现状）

### 复购模式（v1.2.2 简化版）
- ②区「商品复购」开关（**仅店小秘页**显示，位于①②之间）。勾选 = 跳过①添加SKU 和 ②配对，只需填 `1688订单号`，自动「取订单 → 选仓库 + 采购人员 → 保存通过审核 → 待到货页用 PO 号搜索定位」。
- **复购仓库三选项**（复购勾选后显示，radio）：本地仓=「中正科技仓」/ TEMU仓=「TEMU商品代发仓」/ 默认=不操作下拉、用页面默认值（初始选「默认」）。选中态持久化 `cpo_state.repurchaseWarehouse`（'local'|'temu'|'default'），renderState 驱动跨 tab 一致；启动时从 storage 读后随 `CPO_START_PHASE2` → bg → `CPO_P2_EDIT_FILL` 透传。新品不受影响（固定「中正科技仓」）。
- **作用域约束（防死锁）**：复购开关 + ①区灰显**均只在店小秘页生效**。Temu 列表页①区永远正常可用 —— 否则用户在 Temu 页既取消不了复购（开关不在该页）、又用不了①区 → 死锁。
- **状态**：复购态持久化 `cpo_state.repurchase`（boolean），与 phase1/phase2 同属单一状态源；checkbox 勾选态 / ①区灰显由 `renderState` 据它驱动，跨 tab / 面板重建一致。`onToggleRepurchase` 写入、`onClear`（remove 整个 `cpo_state`）/ 新品跑 Phase 1（`cpoRun` 重置）时归 false。
- **复购流程跳过的步骤**：① Phase 1（添加 SKU）整段；② Phase 2 CPO_P2_EDIT_FILL 的配对步（店小秘获取 1688 订单时已自动载入 SKU，无需重配）。
- **完成锁定**：`phase2.status==='done' && collected2.orderNo1688`（不依赖 phase1 done），覆盖两模式；done 后 1688 订单号框回填只读，「清除当前流程」解锁。
- **校验**：`validatePhase2({ repurchase:true, orderNo1688 })` 只要订单号非空即通过；新品分支向后兼容（不传 repurchase 即原「phase1 done + 订单号」）。`tests/cpo-logic.test.js` 含 4 例复购用例 + 2 例新加（订单号非空通过 / 仅空白失败）。

## 架构：background 编排者（归位 feature 目录）

本 feature 的跨 tab 编排逻辑位于 `features/create_purchase_order/background/handler.js`，经 `self.AgentSellerBg.registerHandler('CPO_', fn)` 注册命令处理器，由 build 的 `assemble_feature_backgrounds` 将其 importScripts 注入 SW 末尾，与 SW 共享同一 global scope。`feature.json` 加 `"background": "background/handler.js"` 字段触发装配。

**重要架构约定**：`cpoRun`/`cpoRun2` **故意不包 IIFE**——`automation/bg-entry.js` 的 orchestrator adapter 直调这两个函数（受控的 SW global 函数共享，同 scope 可达，非模块反向依赖）；`await` 可靠等终态，优于「命令入口+轮询 storage」方案。CPO handler 内部仅写 `cpo_state`（自治），automation adapter 单向读 `cpo_state` 映射进 `as_workflow_state.step.result`，CPO 对 automation contract 零反向依赖。

```
content(temu列表) ──CPO_START{url1688,skc,skuNo,spuId}──▶ background 线性 async 编排
                                                            │ 进度只写 chrome.storage.local['cpo_state']
   开后台tab        命令前台tab          命令前台tab          │
 1688商品页        temu编辑页           店小秘 add页          │
 抓document.title  抓预览图(SKU框)      填表+保存+落index      │
        每个 content 页面：只暴露命令处理器（onMessage 分发）+ 面板订阅 storage.onChanged
```

### 状态模型（单一状态源，跨 tab 共享 —— 关键设计）
- `chrome.storage.local['cpo_state'] = { phase1:{status,step,label,collected}, phase2:{status,step,label,collected2}, updatedAt }`
  - `collected2 = { poNo, orderNo1688 }`（采购单号 + 1688订单号）；新品 Phase 2 复用 `phase1.collected.skuNo` 做配对（v1.2.2 起待到货页搜索统一用 `collected2.poNo`，不再用 skuNo；复购跳过配对，不读 skuNo）
  - **Phase 2 状态被多层消费**（UI 按钮 disabled / UI 点击校验 / bg 编排校验 / bg 取 skuNo），调试打桩**只改这一个数据源**，不要逐层改校验逻辑（见踩坑 #13）
- **bg 把进度全部写进 storage**（不再用 `tabs.sendMessage` 推给某个 origin tab）。
- **每个 tab 的面板从 storage 读 + 订阅 `chrome.storage.onChanged`** → 任何平台/任何 tab 打开 Hub 都能看到同一份状态与已采集数据。
- **为什么必须这样**：工作流跨平台（Phase 1 在 Temu 发起、Phase 2 在店小秘发起）。若状态存在「单个 tab 的 content script 内存」里，切 tab 打开 feature 就是空的。storage 是唯一能跨 tab/跨域共享的载体。
- `collected = {skc,url1688,serial,skuNo,previewUrl,spuId,title}`；这也是 Phase 2 的数据基础（Phase 2 读 `cpo_state.phase1.collected` 即可，不必重新采集）。
- **状态清理时机**：对新商品点「开始」时 `cpoRun` 整体重置 `cpo_state`（phase1=running、phase2=idle、复购态归零）——做完一单回列表选新商品**直接点开始即可**，无需先清除。面板「清除当前流程」按钮直接清、不弹确认（误清成本低，重跑即可）。

### 消息协议
| 方向 | type | data | 说明 |
|------|------|------|------|
| content→bg | `CPO_START` | `{url1688,skc,skuNo,spuId}` | Phase 1 启动；立即 ack；编排异步跑、进度写 storage（`skuNo` = 完整 SKU货号/变体货号，**仅新品 Phase 2 配对用**；复购跳过配对不读它） |
| bg→tab 命令 | `CPO_READ_1688_TITLE` | — | 1688 页抓标题 |
| bg→tab 命令 | `CPO_GRAB_PREVIEW` | — | 编辑页抓预览图 |
| bg→tab 命令 | `CPO_FILL_DXM` | `{collected}` | 店小秘填表 + 自动保存 |
| content→bg | `CPO_START_PHASE2` | `{orderNo1688}` | Phase 2 启动；bg 用 `_sender.tab.id` 仅做新 tab 定位 + error 切回，不复用其跑流程 |
| bg→tab 命令 | `CPO_P2_ADD_FETCH` | `{orderNo1688}` | add 页填单号 + 点「获取1688订单」+ 轮询「已存在」弹窗分流 |
| bg→tab 命令 | `CPO_P2_EDIT_FILL` | `{skuNo, repurchase, warehouse}` | edit 页填收货仓库（按模式/三选项）/采购人员 + 配对商品弹窗 |
| bg→tab 命令 | `CPO_P2_EDIT_SAVE` | — | 点「保存，并通过审核」+ 抓成功弹窗解析采购单号 |
| bg→tab 命令 | `CPO_P2_WAIT_SEARCH` | `{skuNo}` | 待到货页搜索定位商品行（停在申请付款前） |

> content 侧无中心化消息分发：`index.js` 自建 `chrome.runtime.onMessage` 路由（沿用 image_search injector 先例）。命令处理器按域写在同一 `handlers` 表，bg 只把命令发给对的 tab。

## 文件结构

```
features/create_purchase_order/
├── feature.json          # 三域 content_matches；permissions: tabs/storage/scripting；cpo-logic.js 作 extra_content_scripts(document_start)
├── cpo-logic.js          # 纯逻辑双模式模块（window.__CPOLogic + module.exports）：extractSerial/buildIdCode/validateInputs/mapDxmFields/extractPoNo/validatePhase2
├── content/index.js      # 注册 + 两区 Hub UI + 选品高亮 + storage 订阅 + 命令处理器（三域 + Phase 2 selector 全在此）
├── tests/cpo-logic.test.js   # node --test 纯逻辑单测
├── samples/              # 真实 DOM 基线（temu_goods_list / temu_goods_edit / 1688_offer / dxm_add_form / dxm_purchase_edit）
└── CLAUDE.md             # 本文件
```

## 各页 selector 全集（据 samples/ 真实 DOM 校准）

### Temu 商品列表（Beast UI）
| 目标 | 定位 |
|------|------|
| 数据行 | `tr[data-testid="beast-core-table-body-tr"]` |
| 行内 SKC ID / SPU ID | `.product-info_idContent__iDukx` 文本 `SKC ID：` / `SPU ID：` + 数字（normText 后正则 `SKCID[:：]?(\d+)`） |
| **SKU货号 列** | 表头有 rowspan/colspan，**按表头文本「SKU货号」动态算 leaf 列索引**（`cpoLeafColIndex`：遍历 thead 第一行 th，按 colspan 累加），再取行的第 idx 个 `:scope>td`；值 `-` 或空 = 未维护货号 |
| 编辑入口 | **不点「编辑」链接**（见踩坑），用 SPU ID 拼 `goods/edit?from=productList&productId=<SPU ID>` |

### Temu 商品编辑页（Beast UI）
| 目标 | 定位 |
|------|------|
| SKU 信息框 | 标题文本是「SKU 信息」（**SKU 与 信息间有空格**，必须 normText 去空格匹配）；从该 label 向上找首个含预览图的祖先 |
| 预览图 | 框内 `img.preview-image_img__LvHNP`（**必须限定在 SKU 框内**：顶部「商品轮播图」同 class）；取 `src`（保留 `?imageMogr2/thumbnail/300x` 缩略参数，按需求要 300x） |

### 1688 商品详情页
| 目标 | 定位 |
|------|------|
| 商品标题 | `document.title` 去「- 阿里巴巴 / 1688」后缀（**og:title 常缺失、h1 是店铺名，都不可用**） |
| 风控页 | path 含 `/punish` 或 search 含 `x5secdata` → 早退 |

### 店小秘添加单个SKU 页（**Ant Design Vue**，非 React-Ant）
add 页 URL 参数固定：`openAddModal?type=0&editOrCopy=0`（可直接导航，无需点「添加商品→添加单个SKU」）。

| 店小秘字段 | 定位 | 填值 |
|-----------|------|------|
| 商品SKU | `#proSku` | skuNo |
| 英文名称 | `#proNameEn` | skuNo |
| 平台SKU | `input[placeholder*="平台销售SKU"]`（无 id） | skuNo |
| 中文名称 | `#proName`（**不是 `#nameCn`——那是报关中文名！**） | 1688 标题 |
| 识别码 | `#proSbm` | `serial-skuNo` |
| 来源URL | `#SOURCE_URL`（name=sourceUrl） | url1688 |
| 图片 | 「选择图片」**hover 展开** ant-dropdown → `div.item` 文本「网络图片」→ 弹窗 `textarea[placeholder*="图片URL"]` 填 url → 点「**添加**」（非「确定」） | previewUrl |
| 人员信息（3 下拉） | 「人员信息」卡内 `.ant-select`：点 `.ant-select-selector` 开 → 用 combo 的 `aria-controls` 锁定本 select 的 `.ant-select-dropdown` → `[role="option"]` 中 textContent 精确等于 user-name 的项 → click | `.user-name` 文本（如 ZQCHAO1） |
| 保存 | 橙色 `.ant-btn` 文本「保存」（含 `btn-orang`）；点前先取消勾选所有「继续创建」复选框 | 自动点 |
| user-name | `.user-name` | — |

### 店小秘 创建采购单 add 页（Phase 2，`isPaste=1` 模式）
直接导航 URL：`purchasing/order/add?pageType=2&isAlibaba=1&isPaste=1`。**此模式下无「1688账号」下拉**，直接填单号即可。

| 字段 | 定位 | 备注 |
|------|------|------|
| 1688订单号 | `textarea[placeholder*="1688订单号"]`（**textarea 非 input**） | 填 orderNo1688 |
| 获取1688订单 | `findByText('button,.ant-btn','获取1688订单')` | 点击后页面新开 edit tab |
| 「已存在」弹窗 | `.ant-modal.dxm-modal`，文案含「采购单号：PO...已存在,不能重复添加」 | 关键词 `/已存在\|不能重复添加\|已完成/` 检测 → 已入库分流 |

### 店小秘 采购单 edit 页（Phase 2，见 `samples/dxm_purchase_edit.txt`）

| 字段 | 定位 | 填值 |
|------|------|------|
| 采购人员 | **搜索型下拉**（见踩坑 #15）：`cpoFindSelectByLabel('采购人员')` 打开后须先在 dropdown 内 `.search-input input` 输入关键字才渲染选项；匹配用可见 `.ant-select-item-option` 的 **`title`**（隐藏 a11y listbox 的 `[role=option]` textContent 是数字 ID） | `.user-name` 文本，**必须配对后再选**（见踩坑 #15） |
| 收货仓库 | `cpoFindSelectByLabel('收货仓库')`（选项少、直接渲染、无搜索框） | 新品固定「中正科技仓」；复购按面板三选项：本地仓=「中正科技仓」/ TEMU仓=「TEMU商品代发仓」/ 默认=**不操作下拉、用页面默认值** |
| 配对商品 | 操作列 `<span class="link block">配对商品/更换配对</span>`（**非 button**） | 点开弹窗 |
| 配对弹窗 | `.product-ref-modal`：搜索类型 `d-tag-group-item`「商品SKU」→ `input[name="tableSearchInput"]` 填 skuNo → submit → 结果行 `tr.content` 的 `.no-new-line2`（无 gray-c 的是 SKU）匹配 → `.link`「选择」 | skuNo |
| 二次确认 | 已配对时点选择弹「确认要更换配对关系」→ 选「修改所有」radio → 「确认」button（**会重置采购人员**，见踩坑 #15） | — |
| 填写后校验 | 每个 select 填完回读 `.ant-select-selection-item`（`title` 优先）确认 == 期望，不符报「数据校验」错（写后读铁律，见根 CLAUDE.md） | — |
| 保存 | `findByText('button,.ant-btn','保存，并通过审核')`（**文案含逗号**） | 自动点 |
| 成功弹窗 | 含「操作成功」「采购单」关键字；`extractPoNo` 解析采购单号（**解析前先去空白**，见踩坑 #12） | — |

### 店小秘 待到货页（Phase 2）
导航 URL：`purchasing/order/waitArrival`。搜索框 `#searchValue`（name=tableSearchInput）；搜索类型 tag `.d-tag-group-item`「采购单号」（**v1.2.2 起新品+复购统一用 PO 号搜**，不再用「商品SKU」；该 tag 通常默认 active，找不到显式报「读取失败」）；结果表 `.vxe-body--row` + 空态 `.vxe-table--empty-block`。定位后停在「申请付款」前交人工。

## 踩坑清单（含证据 + 修法 —— 后续开发直接抄）

1. **程序化点「编辑」被浏览器弹窗拦截**
   - 证据：编辑页是 `target=_blank`/`window.open`，content script `.click()` 无用户手势激活 → Chrome 拦截，流程卡死。
   - 修法：**不点链接，用数据拼 URL 由 bg `chrome.tabs.create` 打开**。本例 `productId == 列表行 SPU ID`（编辑页 URL 实测验证）。
   - 提炼：跨页跳转优先「构造 URL + bg 开 tab」，避开 `_blank` 弹窗拦截 + 免等被点 tab。

2. **后台 tab 不渲染 → 取数失败**
   - 证据：编辑页在前台（手动）跑 `CPO_GRAB_PREVIEW` 成功，bg 后台开 tab 跑则报「SKU信息框未找到预览图」。Temu 编辑页惰性渲染，隐藏 tab 不渲染 SKU 信息框。
   - 修法：需要渲染才能取的页面用 `chrome.tabs.create({active:true})` **前台打开**。只读 `document.title`（1688）这类无需渲染的可后台。

3. **关「有未保存守卫」的 tab 弹 beforeunload 框阻塞**
   - 证据：编辑页有「未保存修改」守卫，`chrome.tabs.remove` 触发「退出后修改取消」确认框，await 卡住，流程停在该步。
   - 修法：`cpoCloseTab` —— 关 tab 前 `chrome.scripting.executeScript({world:'MAIN'})` 注入 `window.onbeforeunload=null` + capture 阶段 `beforeunload` 监听里 `stopImmediatePropagation()`（capture 先于页面自身监听执行 → 不弹框）。需 `scripting` 权限。

4. **店小秘是 Ant Design Vue，不是 React-Ant —— 选择器假设全错**
   - 证据：dump 出 `data-v-*` scoped 属性、`prefixcls="ant-dropdown-menu"` 是**属性不是 class**；菜单项是 `<div class="item">` 而非 `.ant-dropdown-menu-item`；网络图片弹窗输入是 `textarea` 不是 `input`、确认按钮是「添加」不是「确定」。
   - 提炼：**店小秘任何下拉/弹窗/选项都必须先 dump 再写**，不能套 React-Ant 的标准 class。

5. **下拉是 hover 触发不是 click**
   - 证据：`.click()` 选择图片下拉后 `.ant-dropdown` count=0；派发 `mouseover/mouseenter/pointerover` 后才展开。
   - 提炼：点击触发的下拉先判断 hover vs click——COUNT=0 多半是 hover 触发，改派鼠标悬停事件。

6. **Ant Select 选项异步渲染 + 隐藏 a11y listbox 干扰**
   - 证据：选项文本在可见 `[role=option]` 的 textContent；另有隐藏 a11y listbox（`height:0`）其选项 textContent 为空、值在 aria-label。固定 250ms sleep 对后续下拉常常「开了没选中」。
   - 修法：**轮询等选项渲染**（非固定 sleep）+ 用 combo `aria-controls` 锁定本 select 的 dropdown + textContent **精确等于**（排除空文本的 a11y 项）。

7. **取值前不 dump 真实数据 = 确认偏误**（项目铁律，这次多次踩中）
   - 证据：原计划 1688 标题用 `og:title`→`h1` 兜底；实测 `og:title` 缺失会 fallback 到 `h1`=**店铺名**，完全取错。SKU货号也曾假设是「商品信息里的货号」，实际是独立列。
   - 提炼：**数据/选择器类一律先 dump 真实 DOM 再写**，别信「页面应该长这样」的直觉。

8. **表格 rowspan/colspan 列对齐**
   - 证据：Temu 列表表头两行含 rowspan/colspan，硬数 td 列号会错位。
   - 修法：按表头文本动态算 leaf 列索引（遍历表头第一行 th 累加 colspan）。

9. **in-page 导航不稳 → 关 tab 重开**
   - 证据：保存后 `chrome.tabs.update` 到 index「时好时坏」，与店小秘未保存守卫/自身路由竞争。
   - 修法：轮询 ~8s 等店小秘自己离开 add 页；仍不在 index 则 **`cpoCloseTab` 关掉 add tab + 新开干净 index tab**（绕开 in-page 导航竞争）。

10. **校验顺序 + 错误文案分层**
    - 先校验「商品本身（货号/SPU ID）」再校验「1688 url」——货号缺失是更根本的拦截，应先提示。错误文案分「读取/校验/业务」三层（项目铁律），别混用。

11. **Ant Design Vue 下拉的 `isTrusted` 检查 —— 程序化 click 永远打不开**（Phase 2 调试很久）
    - 证据：draft 页「创建采购单」是 `button.ant-dropdown-trigger`，程序化 `.click()`（含 stopPropagation 技巧、含从页面 console 直接点）后 `.ant-dropdown-menu-item` 恒为 **0 条**。根因：Ant Design Vue 对 `isTrusted` 做检查，仅真实用户事件才触发 `v-if` 渲染菜单项，程序化事件 `isTrusted===false`。
    - 修法：**别试图程序化开下拉**。本例「创建采购单 → 创建现有订单」只是导航，直接 bg `chrome.tabs.create({url: add页})` 绕过（add 页 URL = `purchasing/order/add?pageType=2&isAlibaba=1&isPaste=1`）。
    - 提炼：Ant Design Vue 下拉/弹窗打不开时，第一反应是「能否绕过 UI 直接到目标状态」，而非「怎么触发这个 click」。MAIN world 注入也是 `isTrusted=false`，绕不过。

12. **弹窗 `textContent` 跨 DOM 节点拼接会插入空白 —— 正则失配**
    - 证据：审核成功弹窗真实文本「操作成功：1个，采购单： PO1SLPT027940 已移入「待到货」状态。关 闭」——「关 闭」中间的空格是铁证（正常按钮文字不会有空格），说明 textContent 跨节点拼接插了空白；「采购单」与冒号/PO 间也夹空白，旧正则 `/采购单号?[:：]\s*(PO\w+)/` 失配。
    - 修法：`extractPoNo` 解析前先 `replace(/\s+/g,'')` 去掉所有空白再匹配。对有/无空白都成立，无回归。
    - 提炼：从弹窗/多节点元素取文本再正则匹配时，先归一化空白；别假设 textContent 是连续的。

13. **多层消费同一状态 —— 打桩要打数据源，不要逐层改校验**（这次踩了，记取）
    - 证据：Phase 2 启动状态被 4 层消费：UI 按钮 disabled（`lastP1Done`）、UI 点击校验（`validatePhase2`）、bg 编排校验（`p1.status`）、bg 取 skuNo（`p1.collected.skuNo`）。最初在 bg `cpoRun2` 加 `CPO_STUB_SKU` 跳过校验，漏了 UI 两层 → 按钮仍灰、点不动。
    - 修法：直接往 `chrome.storage.local['cpo_state'].phase1` 写一个完整的 `{status:'done', collected:{skuNo}}`。`storage.onChanged` 全局广播 → 所有层一次满足、UI 自动刷新。
    - 提炼：状态有单一数据源时，**打桩打数据源**，逐层加桩既漏又脏。`chrome.storage` 是扩展上下文 API，**网页主世界 console 没有 `chrome.storage`**（报 `undefined reading 'local'`），要在 SW console 跑；`onChanged` 跨上下文广播，不限写入方所在 tab。

14. **跨 tab 编排：新 tab 在原 tab 旁开 + error 切回原 tab（体验）**
    - 新 tab 用 `chrome.tabs.create({index: origin.index+1, openerTabId})`（`cpoCreateTabNextTo`）紧邻触发页，不堆标签栏末尾；origin tab 已关则降级默认位置。
    - error 退出（catch + 业务分流 return）统一 `cpoFocusOrigin(originTabId)` 把焦点切回触发页，不留用户停在已关 tab 的空位。`originTabId` 来自 `_sender.tab.id`，**仅做定位 + 切回，不复用其跑流程**（流程在独立新 tab 跑，保留原页）。
    - **fresh tab handler 必须以 `waitForEl` 开头**：`tab.status==='complete'`/`cpoWaitTabComplete` ≠ Vue 组件已渲染，新开/刚导航的 tab 直接 querySelector 会概率性落空（ADD_FETCH/EDIT_FILL/EDIT_SAVE/WAIT_SEARCH 均已补）。

15. **「采购人员没填对」双重根因（调试很久，单修一个不够）**
    - **根因 ① 搜索型下拉**：采购人员下拉打开后**可见选项 `.ant-select-item-option` 不输入搜索词就不渲染**（dropdown 内有 `.search-input input`）；且并存**隐藏 a11y listbox**（`role=listbox` `height:0`），其 `[role=option]` textContent 是**数字 ID**（1966019）、用户名在 `aria-label`。旧代码匹配 `[role=option]` textContent === 用户名 → 永远命中数字 ID 失败。修法：打开后先在搜索框 `setInputValue(want)` 触发渲染，只匹配可见 `.ant-select-item-option` 的 **`title`**。收货仓库选项少直接渲染、无搜索框，所以一直没问题。
    - **根因 ② 配对会重置采购人员**：配对弹窗「修改所有草稿箱」确认**会重置采购人员**。即使 ① 修好选中了，配对一跑又被覆盖。修法：`CPO_P2_EDIT_FILL` 顺序改为 **收货仓库 → 配对商品 → 采购人员（最后选）**。
    - **写后读校验暴露了它**：给每个 select 填完加「回读 `.ant-select-selection-item` title == 期望」（`cpoSelectAndVerify`），把静默没填对变成显式「数据校验：采购人员填写后不符，期望X实际Y」。已立为项目铁律（根 CLAUDE.md「DOM 表单自动化铁律：写后读校验」）。
    - **提炼**：一个症状可能多根因叠加，修一个仍复现 → 回 Phase 1 重新 dump，别在第一个根因上加码；数据/选中类 bug 先 dump 真实 DOM（搜索型/隐藏 listbox/数字 ID 都是 dump 才发现的）。

16. **开发期 reload 扩展 → 孤儿 tab（非生产 bug）**
    - reload 扩展后，**reload 之前打开的 tab** content script 与新扩展断连，`storage.onChanged` 静默失效、看到旧状态；**F5 刷新**重新注入即恢复。
    - 调跨 tab 同步问题先排除孤儿：SW console 确认 storage 已是新值 + 没同步的 tab F5 试。生产环境员工不 reload 扩展，几乎不出现，故不加自愈机制。

17. **CPO_P2_EDIT_FILL 复购分支跳过配对（v1.2.2）**
    - 证据：v1.2.0 复购仍跑「配对商品」搜 skuNo，但复购商品店小秘已有 SKU 档案，店小秘"获取 1688 订单"已自动载入商品 → 配对是冗余动作浪费操作员时间。
    - 修法：handler 入参加 `repurchase` 标志，复购模式 `if (!repurchase)` 跳过 b 步配对。仓库 + 采购人员两步对所有模式共用。
    - 提炼：分支跳过逻辑放 handler 内（而非 background 选不同 message type），分叉点单一、协议成本最低。

18. **CPO_P2_WAIT_SEARCH 统一用 PO 号搜（v1.2.2）**
    - 证据：复购无 skuNo 无法用「商品SKU」搜；新品有 skuNo 但 PO 号唯一性更强、与审核保存直接关联。两路径用同一 key 让行为可预期、handler 无分叉。
    - 修法：待到货页搜索类型 tag 从「商品SKU」切到「采购单号」（dump 锁定真实文案无空格）；handler 入参从 skuNo 改 poNo；切 tag 失败显式报「读取失败」不再 silent 降级。
    - 提炼：跨流程统一 selector 时找最稳的 key（唯一性 + 来源可控），不要分支保留旧 key 增加调试盲区。

19. **清除当前流程要兼顾复购 + 清 input value（v1.2.2 联调修）**
    - 证据：①旧 onClear 的 hasData 只看 phase1，复购模式 phase1 永远 idle → 复购流程点清除 early return 不动 phase2；②旧 doClear 只 remove storage，但 renderState 仅在「之前 readOnly」时清 input.value，未锁定态下用户手填的 url / 订单号留存让人以为没清干净；③p1Msg / p2Msg 临时消息（启动中… / 启动失败）从未被清逻辑覆盖。
    - 修法：hasData 加 phase2 + 复购态 + 手填 input 任一非空；doClear 显式清 urlInput.value、orderInput.value（未 readOnly 时）、setLocalMsg('')、setP2Msg('')；同时 onStartPhase1/2 ack 成功后立即清「启动中…」临时消息，让 status 行接管。
    - 提炼：「清除当前流程」按钮必须包办**所有可见 UI 状态 reset**（storage + DOM input + 临时消息）；renderState 只负责 storage→UI 渲染，不负责清用户手填或临时反馈。

## 最佳实践（Temu + 店小秘 自动化通用，后续 Phase / 新 feature 复用）

- **Temu = Beast UI**：优先 `data-testid`；类名前缀模糊匹配（`IPT_`/`TB_`/`ST_`/`CBX_`/`BTN_`）；ID/编号用**文本匹配**（`SPU ID:`/`SKC ID:`）；**禁** hash class（`TB_tr_5-120-1` 之类随版本漂移）。
- **店小秘 = Ant Design Vue**：字段优先 `id` / `placeholder`；下拉/弹窗/选项结构非标准，**必须 dump**；交互可能 hover 触发；确认按钮文案可能是「添加」等非标准词。
- **跨 tab/跨平台编排**：bg 当大脑跑线性 async 序列；`chrome.storage.local` 单一状态源 + `storage.onChanged` 跨 tab 同步；content 只暴露命令处理器。**别把工作流状态留在单 tab 的 content 内存**。
- **页面跳转/关闭**：跳转优先「构造 URL + bg 开 tab」（避开 `_blank` 拦截）；落地页不稳就「关 tab + 新开」；关带未保存守卫的页先注入 MAIN world 抑制 beforeunload。
- **渲染依赖可见性**的页面用前台 tab；纯读 meta/title 的可后台 tab。
- **异步渲染**（Ant 选项、React 列表）用**轮询/waitForEl**，不要固定 sleep；**新开/刚导航的 tab 的 handler 必须以 waitForEl 开头**（`status=complete` ≠ 组件渲染完）。
- **取数前先 dump**，纯逻辑（提取/拼接/映射/校验）拆 `*-logic.js` 双模式模块走 `node --test`；从弹窗/多节点取文本再正则匹配时**先归一化空白**（textContent 跨节点会插空白）。
- **Ant Design Vue 下拉/弹窗程序化打不开**（`isTrusted` 检查）→ 别死磕 click，**绕过 UI 直接到目标状态**（构造 URL / 调底层接口）。
- **状态有单一数据源时，调试打桩打数据源**（写 `chrome.storage`），不要逐层改各消费方的校验逻辑——多层消费场景逐层加桩既漏又脏。

## 调试

```bash
node --test features/create_purchase_order/tests/cpo-logic.test.js   # 纯逻辑回归
python3 build/build_extension.py                                     # 构建 → dist/extension
# chrome reload → Temu 列表点选商品 → Hub「① 添加SKU」填 1688url → 开始
```
- 单测某个 handler：SW 控制台（`chrome://extensions`→卡片「service worker」→检查）`chrome.tabs.sendMessage(<tabId>, {type:'CPO_GRAB_PREVIEW'}).then(console.log)`。
- 看工作流状态：SW / 任意页 console `chrome.storage.local.get('cpo_state').then(console.log)`。
- `chrome.tabs.*` 只在 **SW 控制台**可用；页面 console 只能跑纯 DOM 逻辑。

## 已知限制

- 单 SKU 商品为主；编辑页多 SKU 时取框内首张预览图（多 SKU 需按 SKC 匹配行，后续扩展）。
- 自动保存不校验店小秘是否有「本 feature 没填的其它必填项」——若店小秘校验拦截，需补填或退回手动保存。
- FAB/Hub 在三域都出现（项目级现状）。
- 控制台 `postMessage error` / `unload is not allowed` 是店小秘自带统计脚本（hm.js）噪音，与本 feature 无关。

## Phase 2 实现（创建采购单，已落地）

在店小秘发起（需 Phase 1 done），②区填 `1688订单号` 点「开始创建采购单」→ bg `cpoRun2` 线性编排（进度写 `cpo_state.phase2`）：

1. **导航**：新开 tab（在触发页右侧）直达 add 页 `?pageType=2&isAlibaba=1&isPaste=1`（绕开 dropdown，见踩坑 #11）
2. **获取订单**：`CPO_P2_ADD_FETCH` 填单号 + 点「获取1688订单」；轮询「已存在」弹窗 → 已入库则分流报错、关 tab、切回原页
3. **接管 edit tab**：获取成功后页面新开 edit tab，`cpoWaitEditTab` 捕获（监听须在发命令前注册）
4. **填表 + 配对**：`CPO_P2_EDIT_FILL` 顺序 **收货仓库 → 配对商品 → 采购人员**（采购人员必须放配对后，否则被配对重置，见踩坑 #15；收货仓库新品固定「中正科技仓」、复购按三选项，「默认」跳过此步）；每个 select 填后写后读校验
5. **保存通过审核**：`autoSave` 勾选 → 直接 `CPO_P2_EDIT_SAVE`；**默认不勾选**（半自动）→ 先 `CPO_P2_CONFIRM_SAVE` 弹可拖动确认框等用户核对、点「确认保存」再继续（取消则保留 edit 页交人工）。成功后 `extractPoNo` 解析采购单号
6. **待到货定位**：关 edit tab + 新开待到货 tab（右侧），`CPO_P2_WAIT_SEARCH` 搜 PO 号定位商品行；命中后**按 PO 文本锁定 header-row `scrollIntoView` 置顶** + **`openHub()` 展开 Hub 网格**（不切 feature view——feature 面板更高会挡表格行，Hub 网格矮；用户点一次「创建采购单」看单号）+ **自动点「申请付款」**（按钮在 header-row 后的 content-row 操作列内锁定，不全表抓；以 `.ant-modal-title`「申请付款」弹窗出现为生效信号，弹窗内「提交申请」留给用户核对金额后自行点击）。**待到货表是两行分组结构**：header-row（PO 号 + 仓库/采购员）+ content-row（商品 + 操作列「申请付款/入库/更多」）
7. **done**：停在「申请付款」前；②区 1688订单号回填本次值 + 锁只读、采购单号只读框显示（`bothDone` 跨 tab 共享，清除/新流程才解锁）

**关键设计**：
- `_handlerError` 标记区分「handler 业务失败」vs「Chrome 通道销毁」——add 页获取订单后跳转 edit 会销毁旧通道（报 `back/forward cache` / `receiving end`），这是**正常导航副作用**，靠 `editTabP` 接管而非当错误；只有打了 `err._handlerError=true` 的才是真业务失败。**别用 error.message 字符串匹配**（文案随 Chrome 版本变）。
- **半自动确认命令走 `chrome.tabs.sendMessage` 直发**，不走 `cpoSendCommand`（后者 20s 超时 + retry 会打断用户核对、重复弹窗）；确认框 Promise 直到用户点击才 resolve。
- **完成锁定**：phase1+phase2 都 done 时，`renderState` 把 `collected2.orderNo1688` 回填 `orderInput` 并 `readOnly`，用 readOnly 自身判断解锁时机（清除/新流程清空恢复）；锁定态禁用开始按钮。
- 跨 tab 编排踩坑见踩坑清单 #11~#16。

### Phase 2 调试打桩（Phase 1 数据已清时）
SW console（`chrome://extensions`→卡片「service worker」→检查）跑，造一个 phase1 done 数据源，UI/bg 全链路一次满足：
```js
chrome.storage.local.get('cpo_state').then(o => {
  const st = o.cpo_state || {};
  st.phase1 = { status: 'done', collected: { skuNo: '<能在配对弹窗搜到的完整含属性 SKU货号>', title: '测试', serial: 'TEST' } };
  return chrome.storage.local.set({ cpo_state: st });
}).then(() => console.log('phase1 打桩完成'));
```
验完用面板「清除」按钮或重跑 Phase 1 覆盖。**不要在 bg 逐层加跳过校验的代码桩**（见踩坑 #13）。
