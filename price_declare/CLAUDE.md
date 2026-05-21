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

**信号选择**：用"目标行从 DOM 消失"替代 badge count 判断。

badge count 不可靠原因：
- 切 tab 后异步渲染导致数值短暂闪烁
- 多 SKU 服务器分批更新，count 减少量不确定
- 后台新增数据会使 count 反增

**流程**：处理完一条行后，切 tab 触发 Temu React 重新请求列表数据，等目标行从 `findPendingRows()` 消失才继续，最多切 5 次，5 次后 fallback reload。

**同步判断 key**：优先用 `SPU ID:SKC ID` 组合（`readSKUKey(row)`），不可读时降级到 HJD。

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
