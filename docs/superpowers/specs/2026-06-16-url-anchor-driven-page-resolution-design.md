# URL 锚点驱动取页 — 设计文档

> 日期：2026-06-16
> 状态：设计待 review
> 范围：automation/ 编排器取页链路加固（dev-only 子系统，不影响 release）

## 1. 背景与问题

自动化编排器的状态同步分两层，健壮性不一：

**稳的一层（不动）**：workflow 状态 = `chrome.storage.local['as_workflow_state']`，background 唯一写、dashboard 只读订阅 `onChanged`，SW 回收后 `orchRecoverAll()` 从 storage 恢复；长任务结果走 `pl_state`/`agl_state`/`cpo_state` storage 轮询（content 自驱、SW 只观察）。这层不依赖任何 tab，持久化 + 单写多读，健壮。

**脆的一层（本设计修）**：凡是「需要读某个平台页面」的地方，都靠 `chrome.tabs.query` 碰运气找当前打开的 tab。三处同根：

| 位置 | 现状 | 脆在哪 |
|------|------|--------|
| `findDxmEditTab()`（publish 两段闸） | `tabs.query(dianxiaomi)` 找 url 含 `edit` 的 tab | 没开/关了/导航走 → `PUBLISH_NO_EDIT_TAB` 直接死（代码注释自标「数据流死结」） |
| `orchCapturePageSnapshot(domain)`（大脑诊断/复核/回填） | `tabs.query(domain)` 取 `tabs[0]` | 不命中 → 快照 null，大脑降级瞎判 |
| `orchNavigateAndWait()`（auto 步） | 自己 `tabs.create` 主动导航 | 最稳；唯一隐患是落地后未登录（no-auth）只会 readySignal 超时，错误归类含糊 |

**根因一句话**：`wf.product` 缺各平台的 **URL 锚点**。有锚点的步（gen_label/pack_label/ship 有 `target.url`）能主动导航；没锚点的（店小秘编辑页 URL 无法由 spuId 推导）只能 query 赌当前 tab。`select_product` 已记 `sourceUrl` 开了头，但这条线没贯穿下游。

## 2. 设计目标 / 非目标

**目标**
- 把「读现有 tab 碰运气」升级成「凭 product 的 URL 锚点定位确切页面」。
- 解 publish 找不到店小秘编辑页的死结。
- 提升大脑快照命中率（query 域名 tabs[0] → query 确切锚点 URL）。
- auto 步导航后识别未登录态，错误分层准确。

**非目标（明确不做）**
- 店小秘编辑页 URL 的**自动捕获**——本期人工填，自动捕获留给 `collect_dxm` 自动化那一刀。
- product 字段的自动化采集（skc/returnPrice 等 noFill 步仍人工抄）。
- 触碰已稳的 storage 状态同步 / 长任务轮询机制。

## 3. 核心抽象：`resolvePageTab`

收掉三处散落的「找页面」逻辑，统一成单一锚点解析器（bg-entry.js，SW world）：

```
resolvePageTab(step, wf, { navigate }) → { tab } | { error } | null

  1. 解析目标 URL：
       anchorUrl = step.target?.url 或 product 锚点（按 step.id 映射，如 publish → product.dxmEditUrl）
  2. anchorUrl 存在 → chrome.tabs.query({ url: 锚点确切 URL pattern }) → 命中即返回 { tab }
  3. 不命中：
       navigate === true（auto 主流程） → orchNavigateAndWait(anchorUrl, readySignal) 主动开 → { tab }
       navigate === false（快照）        → 返回 null（降级，不开 tab）
  4. anchorUrl 无法解析（缺锚点）：
       有 domain 退回旧 query（向后兼容） → 命中 { tab } / 不命中按调用方语义返回 error 或 null
```

**为什么统一**：三处现在各写各的 query，错误形态、兜底策略、锚点优先级都不一致。统一后锚点解析规则单一真源，三处只传 `navigate` 语义差异，符合 coding-rules「公共规则集中封装、禁止散落多调用点」。代价是新增一个函数——可接受。

## 4. 数据契约变更（最小）

`wf.product` 加 URL 锚点字段，贯穿三处单一真源（防字段漂移）：

| 字段 | 含义 | 填入步 | 锚点解析归属 |
|------|------|--------|------------|
| `sourceUrl` | Temu 商品详情页（**已存在**） | `select_product` | 暂不用于取页（详情页非操作页），保留 |
| `dxmEditUrl` | 店小秘编辑页 URL（**新增**） | `collect_dxm` 人工填 | `publish` 步取页锚点 |

落地点（三处必须同步，对齐 `steps.js` 注释「单一真源防字段漂移」）：
1. `automation/orchestrator/steps.js` `emptyProduct()` 加 `dxmEditUrl: null`。
2. `engine.js` `pickProduct()` 白名单加 `dxmEditUrl`（HITL 回填经 `orchHitlConfirm` 的 `Object.assign(wf.product, pickProduct(result))` 落库）。
3. `steps.js` `collect_dxm` 的 `hitlSpec.fields` 加：
   ```js
   { key: 'dxmEditUrl', label: '店小秘编辑页 URL（发布步用）', fieldType: 'text', required: false }
   ```

**`required: false` 的理由**：`collect_dxm` 已是 noFill 人工步，强制每次贴 URL 增加负担且不向后兼容（旧 workflow 无此字段）。设可选——缺了 `publish` 优雅退回旧域名 query（保持现有行为），仅当**既无锚点又 query 不到**时才报「数据校验：缺店小秘编辑页 URL（请在采集步回填，或保持编辑页打开）」。渐进、不 hard-break。

## 5. 三处改造细节

### 5.1 `findDxmEditTab()` → 走 `resolvePageTab`（publish 死结）

```
优先：product.dxmEditUrl 存在 → query 该确切 URL → 命中返回 { tab }
退回：无 dxmEditUrl 或不命中 → 现有 query({ url: '*://*.dianxiaomi.com/*' }) 找含 edit 的 tab（向后兼容）
都失败：
  - 有 dxmEditUrl 但该 tab 没开 → { error: 数据校验 + 锚点 URL，提示「保持编辑页打开或重新采集」}
  - 无 dxmEditUrl 且 query 空 → { error: 读取，PUBLISH_NO_EDIT_TAB（沿用旧文案） }
```
命中后保留现有「激活 tab + sleep 500ms」防 Ant dropdown 后台不展开的逻辑。

### 5.2 `orchCapturePageSnapshot(domain)` → `(step, wf)`（快照精确化）

签名从按域名改为按 step：
```
anchorUrl = step.target?.url 或 product 锚点（publish→dxmEditUrl）
anchorUrl 存在 → query 确切 URL → 命中抓 innerText（截断 6000）
不命中 / 无锚点 → 退回旧 query(step.domain) 取 tabs[0]（向后兼容）→ 仍不命中返回 null
```
**仍是尽力而为**：抓不到 null，大脑凭 workflow 上下文判（filler/diagnoser/reviewer 本就这么兜底）。**不为喂快照主动开 tab**（用户已选「抓不到就降级」）。调用点 `orchRequestFillSuggest` / `orchReviewGate` 改传 `(step, wf)`。

### 5.3 `orchNavigateAndWait()` — 落地页未登录检测

`waitTabComplete` 后、轮询 readySignal 前，加一次落地 URL 检查：
```
读 tab.url（或 executeScript 取 location.href）→ 含 /no-auth / /login 等未登录标志
  → throw 业务拦截错误：'未登录：请先登录 <域名> 后重试'（区别于 readySignal 超时的「读取」错误）
```
未登录标志用**白名单 pattern 数组**（`no-auth`、`login`、`passport`），集中常量便于扩展。检测失败（取不到 url）不阻断，继续走 readySignal 轮询（不引入新脆点）。

## 6. 错误分层（对齐 debugging-rules 铁律）

| 失败 | 分类 | 文案模板 |
|------|------|---------|
| 缺 product 锚点 | 数据校验 | `数据校验：缺<X> URL（请在<步>回填）` |
| 锚点页未打开 / query 空 | 读取 | `读取失败：未找到<X>页 tab` |
| 落地未登录 | 业务拦截 | `未登录：请先登录<域名>后重试` |

三类绝不混用同一文案——下次调试 5 秒内能判断是「数据没填」还是「页面没开」还是「没登录」。

## 7. 不变量 / 向后兼容

- **release 隔离不破**：纯逻辑改造，无新触发源；`resolvePageTab` 只被 automation/ 调用，release 不装配 automation 即天然不生效。
- **storage 状态同步层不动**：只改「取页」，不碰 workflow 状态写入 / 恢复 / 轮询。
- **向后兼容**：锚点字段缺失时三处全部退回现有 query 行为，旧 workflow（无 `dxmEditUrl`）照跑不报错。
- **product 落库唯一入口不变**：锚点仍经 HITL 人工确认门 `orchHitlConfirm` → `pickProduct` 落库，不新增写 product 的路径（守 spec §4.1 不变量1）。

## 8. 测试策略

**纯逻辑单测（node --test，无 chrome）**
- `resolvePageTab` 锚点解析优先级：有 `target.url` 用之 / 无则用 product 锚点 / 都无退回 domain / 解析结果断言（注入 fake `chrome.tabs.query` 桩）。
- `steps.test.js`：`collect_dxm` hitlSpec 含 `dxmEditUrl` 字段、`required:false`；`emptyProduct` 含 `dxmEditUrl:null`；`buildInitialWorkflow` 透传。
- `engine.test.js`：`pickProduct` 白名单含 `dxmEditUrl`（result 带 → 落库；不带 → 不污染）。
- 未登录检测：URL pattern 命中 → 抛业务拦截错误；不命中 → 不抛。

**Python 端**：无改动（大脑契约 `pageSnapshot` 仍是可选字段，null 时已有降级测试覆盖）。

**端到端（人工 gated）**：
1. `collect_dxm` 人工填 `dxmEditUrl` → publish 不再赌 tab，主动命中编辑页。
2. 故意关掉店小秘编辑页 → publish 报「数据校验：缺/未找到编辑页」而非崩。
3. auto 步导航落未登录页 → 报「未登录」而非 readySignal 超时。

## 9. 范围边界

- 本期只解「取页脆弱」三处 + 一个数据契约字段，**不碰** collect_dxm 自动捕获、product 自动采集。
- `sourceUrl` 暂不接入取页（Temu 详情页是选品参考、非操作页）；保留字段供后续 collect_dxm url 驱动采集承接。
- 是 L2/L3 改动，走 spec → plan → 实施；automation 真模型 e2e 仍人工 gated。
