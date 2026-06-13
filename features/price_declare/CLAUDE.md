# price_declare Feature

> 在 Temu 商家中心"待卖家确认调价"列表页自动批量点"不调整"。

## 目标页面

`https://agentseller.temu.com/main/adjust-price-manage/order-price*`

只在该 URL 激活（`registerFeature.init` 内有 URL 检查）。

## 代码来源

源自独立项目 `/home/linux_dev/projects/price_declare/`，迁移时将 7 个模块合并为单文件 `content/index.js`，保留了原有的 `window.TPD` 命名空间和 IIFE 结构，末尾追加 `window.AgentSeller.registerFeature` 注册。

合并顺序（严格按依赖）：
`dom-utils → selectors → storage → actions → engine → panel → AgentSeller注册入口`

## 内部架构

```
window.TPD.sleep / randomDelay / nativeSetValue / waitFor / nowTs   (dom-utils)
window.TPD.selectors.*                                              (selectors)
window.TPD.storage.*                                                (storage)
window.TPD.actions.*                                                (actions)
window.TPD.engine.*                                                 (engine)
window.TPD.panel.mount()                                            (panel，当前未调用)
```

状态机：`IDLE → RUNNING ⇄ PAUSED ⇄ STEPPING → IDLE/ERROR`

## UI

控制面板并入 AgentSeller Hub 的 feature view（不再弹独立 Shadow DOM 浮层）。

Hub 面板设置项：
- **不调整原因**：填写到弹窗 textarea 的文本（默认"已提交活动，没有利润"）
- 失败固定暂停（stopOnError 硬编码 true，无法关闭）

## 刷新同步机制（关键设计）

**信号选择因场景而异**：

| 场景 | 主信号 | 原因 |
|------|--------|------|
| 单行处理完毕后等同步 | **目标行从 DOM 消失** | badge 在多 SKU 分批更新场景下减少量不确定，行消失更精确 |
| mainLoop 末页 0 行兜底判定（是否真完成） | **tab badge count** > totalText | rows/totalText 都可能是 loading 占位，badge 来自 Temu UI 顶层最稳。注：`badge > totalText` 是优先级降级链（badge 取不到才退 totalText），非数值大小比较 |

**流程**：处理完一条行后，切 tab 触发 Temu React 重新请求列表数据，等目标行从 `findPendingRows()` 消失才继续，最多切 5 次，5 次后 fallback reload。

**同步判断 key**：优先用 `SPU ID:SKC ID` 组合（`readSKUKey(row)`），不可读时降级到 HJD。

**注意**：「行消失」不等于「Temu 后端真完成」。多 SKU 场景下 Temu 后端**异步分批处理**同 SPU+SKC 的调价单，React 可能先把部分行从 DOM 移除（误信号「已消失」），但实际后端还在处理，下一次 confirm 会被拒（数据对不上）。所以 `triggerRefresh` 内行消失判断前的 sleep 设到 2000ms，配合多信号兜底降低误判。

## 多 SKU 弹窗（重要）

**业务规则**：同一商品（相同 SPU ID + SKC ID）可能有多个调价单（不同时间段）。点击列表任意一行都会弹出包含所有调价单的汇总弹窗，确认后 Temu 同时处理所有相关行。

**DOM 结构差异**：

| 类型 | 弹窗选择器 |
|------|-----------|
| 单 SKU 弹窗 | `[data-testid="beast-core-modal-innerWrapper"]` |
| 多 SKU 弹窗 | 只有 `[data-testid="beast-core-modal-inner"]`，**无 innerWrapper** |

`findActiveModal()` 优先找 `innerWrapper`，找不到再找 `inner`，两种弹窗均可正确定位。

**多 SKU 同步判断**：用 SPU+SKC key 判断——等所有相同 key 的行全部消失，而非等单个 HJD 消失。

样本文件：`samples/mul_sku_win_dom.txt`（多 SKU 弹窗内部 DOM）

## mainLoop 退出 / 完成判定（多信号兜底）

**核心约束**：「rows.length=0」**不等于**「真完成」，三种语义被混在同一信号里：

| 表面 | 真实含义 |
|------|---------|
| `findPendingRows()=0` | DOM 当前空，可能是 React 异步未渲染 / 切 tab loading 占位 / 真无数据 |
| `pg.totalText="共有 0 条"` | 同样可能是 loading 占位（切 tab 瞬间）/ 真无数据 |
| `pg.ready=false` | 分页器 DOM 还没渲染回来 |
| tab 标签 badge 数字 | **最稳的信号**，直接来自 Temu UI 顶层，loading 中间态干扰最小 |

**mainLoop 「末页 0 行」5 次 retry 后的兜底判定（优先级从高到低）**：

1. `badge > 0` → 列表 0 行但 badge 显示有数据 = React 渲染卡死 → **fallback reload**
2. `pg.totalText 含数字 > 0` → 分页器显示有数据但行 0 = 同上 → **fallback reload**
3. 都 = 0 → **真完成**

retry 每次必须主动调 `refreshListByTabSwitch` 切 tab 触发 React 重拉，**被动 sleep 无效**（Temu 后端不会自己刷新）。

延时校准：`triggerRefresh` 内 `_rawSleep(2000)`、`refreshListByTabSwitch` detour 后 `randomDelay(1500, 2500)`。短于这个值 Temu 后端缓存来不及更新。

## ConfirmModalStuck（Temu confirm 拒绝处理）

**触发**：`waitModalClose` 15s 超时（confirm 后 modal 没自动关闭 = Temu 后端拒绝该请求，弹「数据对不上」/「更新失败」toast 但 modal 保留）。

**适用范围**：单 SKU / 多 SKU 都走同一路径（`waitModalClose` 不区分）。

**处理流程**：
1. 抛 `Error('ConfirmModalStuck')` → mainLoop 错误分支接管
2. `findCancelButton` → 点取消关闭 modal（不再让残留弹窗置顶）
3. **整组同 SPU+SKC 的 HJD 都加入 `skippedHJDs`**（多 SKU 共享调价单，一条拒绝 = 整组脏数据，跳过整组避免反复触发）
4. 固定 3s 冷却 + 主动 `refreshListByTabSwitch` 切 tab，让 React 重拉 + Temu 后端稳定
5. continue 继续处理下一行

**限流**：`consecutiveFailures >= 5` 时 `setMode(PAUSED)`（防异常状态死循环）。成功处理一行重置计数为 0。

`skippedHJDs` 仅在 mainLoop 内部维护，**不持久化**：fallback reload / 用户 stop+start 后清空。

## fallback reload 上限

`fallbackReload(reason)` 调用计数挂在 `state.snapshot.fallbackReloadCount`，上限 **3 次**。超过 → `setMode(PAUSED)` 等人工，避免页面死锁时无限刷新。

**重置时机**：
- 用户点 ▶ 开始（新 session）
- `processOneRow` 成功（mainLoop 恢复正常）

reload 后 `autoResumeIfNeeded` 触发时调 `window.AgentSeller.openFeature('price_declare')` 自动展开浮窗到 feature view（用户能立刻看到续跑状态，不用手动点 FAB）。

## DOM Selector 规范

- 优先 `data-testid`
- 中文文案匹配（`不调整` / `确认` / `取消`）
- Beast UI 类名前缀模糊匹配（`[class*="PGT_pagerItemActive"]`）
- **绝不**用 hash class（如 `.TB_tr_5-120-1`）作主锚点
- SPU ID / SKC ID 用文本内容匹配（`p.textContent.startsWith('SPU ID:')`），不用 class（版本号会漂移）

`samples/` 是 DOM 基线，勿删勿动。

## 状态持久化

`chrome.storage.local['tpd_state']` 单 key，支持刷新续跑（60s 内自动恢复）。

## 风控缓解

- 纯 UI 模拟，无 API 调用
- `maxPerSession=300` 单会话上限
- 风控信号即停（登录页跳转 / 验证码）

## 设计文档

- 刷新逻辑重设计：`docs/superpowers/specs/2026-05-20-price-declare-refresh-redesign.md`
