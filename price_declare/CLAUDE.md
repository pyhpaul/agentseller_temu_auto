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
window.TPD.panel.mount()                                            (panel)
```

状态机：`IDLE → RUNNING ⇄ PAUSED ⇄ STEPPING → IDLE/ERROR`

## UI

使用自己的 Shadow DOM 浮层（右下角），不使用 AgentSeller Hub 的 feature view。  
Hub 里显示状态摘要 + 跳转链接。

## DOM Selector 规范

与原项目一致：
- 优先 `data-testid`
- 中文文案匹配（`不调整` / `确认`）
- Beast UI 类名前缀模糊匹配（`[class*="PGT_pagerItemActive"]`）
- **绝不**用 hash class（如 `.TB_tr_5-120-1`）作主锚点

`samples/` 是 DOM 基线，勿删勿动。

## 状态持久化

`chrome.storage.local['tpd_state']` 单 key，支持刷新续跑（60s 内自动恢复）。

## 风控缓解

- 纯 UI 模拟，随机延时，无并发
- `maxPerSession=300` 单会话上限
- 风控信号即停（登录页跳转 / 验证码）
