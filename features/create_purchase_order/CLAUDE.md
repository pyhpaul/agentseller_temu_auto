# create_purchase_order Feature

> 顶层架构（公共骨架 / 注册契约 / Core API / 构建 / native_host）见项目根 `CLAUDE.md`。本文件覆盖本 feature 细节，并**沉淀 Temu 商家中心 + 店小秘 自动化的踩坑与最佳实践**，供后续 Phase 与新 feature 复用。
>
> 设计 spec：`docs/superpowers/specs/2026-05-26-create-purchase-order-phase1-design.md`
> 实施 plan：`docs/superpowers/plans/2026-05-26-create-purchase-order-phase1.md`
> （spec/plan 是初始设计；本文件记录**最终落地实现**，二者有差异以本文件为准）

## 概述

- **Feature ID**：`create_purchase_order`「创建采购单」，order=5
- **作用**：把「在店小秘新建商品 SKU + 创建采购单」这件跨 Temu / 1688 / 店小秘 三平台手工搬运的事自动化
- **两阶段**（状态都在面板显示，但各自页面触发，**不自动串联**，用户手动逐段触发）：
  - **① 添加SKU（Phase 1，已实现）**：在 **Temu 商品列表**发起 → 自动从 Temu 取数 + 1688 取标题 → 在店小秘建商品 SKU 并自动保存
  - **② 创建采购单（Phase 2，待开发）**：在 **店小秘**发起（需 Phase 1 完成），动作待定
- **跨三域**：`agentseller.temu.com` / `detail.1688.com` / `www.dianxiaomi.com`（content_matches 显式声明三域；FAB 会在三域出现，项目已知现状）

## 架构：background 编排者（本项目新模式）

现有其它 feature 的 background 多是「native messaging 透传」；本 feature **首次把跨 tab 编排逻辑放进 `core/background/service-worker.js`**（沿用 image_search 的「文件内标记段」先例，段标记 `// ── create_purchase_order ──`）。

```
content(temu列表) ──CPO_START{url1688,skc,skuNo,spuId}──▶ background 线性 async 编排
                                                            │ 进度只写 chrome.storage.local['cpo_state']
   开后台tab        命令前台tab          命令前台tab          │
 1688商品页        temu编辑页           店小秘 add页          │
 抓document.title  抓预览图(SKU框)      填表+保存+落index      │
        每个 content 页面：只暴露命令处理器（onMessage 分发）+ 面板订阅 storage.onChanged
```

### 状态模型（单一状态源，跨 tab 共享 —— 关键设计）
- `chrome.storage.local['cpo_state'] = { phase1:{status,step,label,collected}, phase2:{status}, updatedAt }`
- **bg 把进度全部写进 storage**（不再用 `tabs.sendMessage` 推给某个 origin tab）。
- **每个 tab 的面板从 storage 读 + 订阅 `chrome.storage.onChanged`** → 任何平台/任何 tab 打开 Hub 都能看到同一份状态与已采集数据。
- **为什么必须这样**：工作流跨平台（Phase 1 在 Temu 发起、Phase 2 在店小秘发起）。若状态存在「单个 tab 的 content script 内存」里，切 tab 打开 feature 就是空的。storage 是唯一能跨 tab/跨域共享的载体。
- `collected = {skc,url1688,serial,skuNo,previewUrl,spuId,title}`；这也是 Phase 2 的数据基础（Phase 2 读 `cpo_state.phase1.collected` 即可，不必重新采集）。
- **状态清理时机**：对新商品点「开始」时 `cpoRun` 整体重置 `cpo_state`（phase1=running、phase2=idle）。另有面板「清除当前流程」按钮：两 phase 未全 done 时 `window.confirm` 二次确认再清。

### 消息协议
| 方向 | type | data | 说明 |
|------|------|------|------|
| content→bg | `CPO_START` | `{url1688,skc,skuNo,spuId}` | 立即 ack；编排异步跑、进度写 storage |
| bg→tab 命令 | `CPO_READ_1688_TITLE` | — | 1688 页抓标题 |
| bg→tab 命令 | `CPO_GRAB_PREVIEW` | — | 编辑页抓预览图 |
| bg→tab 命令 | `CPO_FILL_DXM` | `{collected}` | 店小秘填表 + 自动保存 |

> content 侧无中心化消息分发：`index.js` 自建 `chrome.runtime.onMessage` 路由（沿用 image_search injector 先例）。命令处理器按域写在同一 `handlers` 表，bg 只把命令发给对的 tab。

## 文件结构

```
features/create_purchase_order/
├── feature.json          # 三域 content_matches；permissions: tabs/storage/scripting；cpo-logic.js 作 extra_content_scripts(document_start)
├── cpo-logic.js          # 纯逻辑双模式模块（window.__CPOLogic + module.exports）：extractSerial/buildIdCode/validateInputs/mapDxmFields
├── content/index.js      # 注册 + 两区 Hub UI + 选品高亮 + storage 订阅 + 命令处理器（三域 selector 全在此）
├── tests/cpo-logic.test.js   # node --test 纯逻辑单测
├── samples/              # 三页真实 DOM 基线（temu_goods_list / temu_goods_edit / 1688_offer / dxm_add_form）
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

## 最佳实践（Temu + 店小秘 自动化通用，后续 Phase / 新 feature 复用）

- **Temu = Beast UI**：优先 `data-testid`；类名前缀模糊匹配（`IPT_`/`TB_`/`ST_`/`CBX_`/`BTN_`）；ID/编号用**文本匹配**（`SPU ID:`/`SKC ID:`）；**禁** hash class（`TB_tr_5-120-1` 之类随版本漂移）。
- **店小秘 = Ant Design Vue**：字段优先 `id` / `placeholder`；下拉/弹窗/选项结构非标准，**必须 dump**；交互可能 hover 触发；确认按钮文案可能是「添加」等非标准词。
- **跨 tab/跨平台编排**：bg 当大脑跑线性 async 序列；`chrome.storage.local` 单一状态源 + `storage.onChanged` 跨 tab 同步；content 只暴露命令处理器。**别把工作流状态留在单 tab 的 content 内存**。
- **页面跳转/关闭**：跳转优先「构造 URL + bg 开 tab」（避开 `_blank` 拦截）；落地页不稳就「关 tab + 新开」；关带未保存守卫的页先注入 MAIN world 抑制 beforeunload。
- **渲染依赖可见性**的页面用前台 tab；纯读 meta/title 的可后台 tab。
- **异步渲染**（Ant 选项、React 列表）用**轮询/waitForEl**，不要固定 sleep。
- **取数前先 dump**，纯逻辑（提取/拼接/映射/校验）拆 `*-logic.js` 双模式模块走 `node --test`。

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

## Phase 2 预告（待开发）

店小秘订单管理页 `purchasing/order/draft/manualPurchasing` → 「创建采购订单」→ 编辑页 `purchasing/order/add?...` → 动作待定。在店小秘发起，读 `cpo_state.phase1.collected` 拿已采集数据，届时补输入 `1688订单号`。单独 brainstorm + spec。
