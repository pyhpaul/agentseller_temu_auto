# publish 步两段化（检查 / 发布分离）+ 自动发布开关 + 跳过本步 设计

> 日期：2026-06-16
> 范围：automation dev-only 子系统（orchestrator 编排器 + dashboard + check_and_publish 桥接）
> 变更类型：L2 iteration（改 publish 步交互形态，触及 orchestrator 状态机 + dashboard HITL 卡 + CAP 桥接）

## 背景与现状

publish（③，14 步链路）实操是 **店小秘 dianxiaomi.com 编辑页** 上的**两个动作**：① 合规检查填写内容 ② 点「立即发布」。当前两条路径行为不一致：

| 路径 | 当前行为 | 文件 |
|------|---------|------|
| 手动 Hub「✅ 检查与发布」 | **已是两段**：点「🔍 检查并发布」→ `onCheck` 只跑规则出结果 → 通过则显示「✓ 确认发布」→ 人工再点 → `clickPublishImmediate` | `features/check_and_publish/content/index.js:644/674` |
| e2e 编排器 `CAP_PUBLISH` | **一把梭**：`capHandlePublish()` 里检查+发布连做（无 block 直接发），中间无人工可见的检查结果停顿 | 同文件 `:692-713` |
| 编排器 publish 步硬闸 | `manualGate:true` → engine 停一次出 review 卡，人工点「确认提交」→ 随后一把梭检查+发布 | `engine.js:130-136`、`steps.js:34` |

**问题**：e2e 路径下，人工那一下「确认提交」实际触发的是"检查+立即发布"，**看不到检查结果、无法在检查通过后再决定发不发**。

## 目标

1. e2e 编排器 publish 步改为 **dashboard 上两段确认**：先检查（结果可见）→ 人工看 → 再点发布。
2. 提供 **「检查通过后自动发布」开关**（持久化，默认关）：勾上则本次检查通过后直接连发，不停第二段。
3. 提供 **「跳过本步」**：测试期可跳过整个 publish 步（不检查不发布），步标 `skipped`，cursor 进下一步。

## 非目标（YAGNI）

- 不动手动 Hub「检查与发布」路径（它本来就两段，符合预期）。
- 不改其余不可逆步（⑦gen_label / ⑨create_po / ⑬ship）的 reviewGate 大脑复核闸 —— "后续再议"维持现状。
- 不做 publish 步完全无人值守自动跑（即便开关开，人工仍需点一次「检查」启动；这是安全选择）。
- 不改店小秘编辑页 URL 自动打开（仍需人工保持编辑页 tab 打开，随 collect_dxm 自动化后续做）。

## 状态模型：publish-gate HITL

publish 步**不拆成两个 step**（链路仍 14 步），在 hitl 对象上引入新 `kind:'publish'` + `phase` 子状态机：

| phase | dashboard 卡片 | 人工动作 → 消息 |
|-------|---------------|----------------|
| `await-check` | 提示"先开店小秘编辑页" + ☐「检查通过后自动发布」(checked=hitl.autoPublish) + 「🔍 检查」+「⏭ 跳过本步」 | 检查 → `WF_PUBLISH_CHECK{autoPublish}`；跳过 → `WF_SKIP` |
| `blocked` | 阻断/警告/跳过项列表（来自 hitl.checkResult）+「🔍 重新检查」+「⏭ 跳过本步」（**不给发布**） | 重新检查 → `WF_PUBLISH_CHECK`；跳过 → `WF_SKIP` |
| `await-publish` | ✓ 通过(N项) + 警告列表 + 上次发布错误(若有) +「✓ 发布」+「⏭ 跳过本步」 | 发布 → `WF_PUBLISH_EXEC`；跳过 → `WF_SKIP` |

**关键时序**：publish 步进入即停在 `await-check`（替代现 manualGate 的 review 停顿）。自动发布开关在 `await-check` 卡上、点检查**前**读取 → 治当前这次，不是下次。检查 block **永远转 `blocked` 人工**，自动发布开关在此失效（安全兜底）。

## 数据流（e2e 路径）

```
publish 步 pending
  → engine.advance run-auto: reversible===false && !reviewed && step.gate==='publish'
  → 停下，buildPublishHitl(phase='await-check', autoPublish=持久化默认)
  → dashboard await-check 卡

人工[可选勾自动发布] 点「检查」→ WF_PUBLISH_CHECK{workflowId, autoPublish}
  → bg orchPublishCheck: 持久化 autoPublish；找店小秘编辑页 tab 发 CAP_CHECK
     ├ tab 没开 → PUBLISH_NO_EDIT_TAB（error 卡，recoverable）
     ├ block 命中 → hitl.phase='blocked' + checkResult，仍 paused
     ├ 通过 && autoPublish=ON → 内联 orchPublishExec（见下）
     └ 通过 && autoPublish=OFF → hitl.phase='await-publish' + checkResult，仍 paused

人工 点「发布」→ WF_PUBLISH_EXEC{workflowId}
  → bg orchPublishExec: 找编辑页 tab 发 CAP_PUBLISH_EXEC
     ├ 成功 → step.status='done' + advance（cursor 进 ④）
     └ 失败 → hitl.phase='await-publish' + publishError，仍 paused（可重点发布）

人工 点「跳过本步」(任意 phase) → WF_SKIP{workflowId}
  → bg orchSkipStep: 当前 step.status='skipped' + advance（decideNext 已支持 skipped→advance-cursor）
```

## 组件改动清单

### 1. `features/check_and_publish/content/index.js`（CAP 拆分）
- `CAP_PUBLISH`（检查+发布一把梭）→ 拆成：
  - **`CAP_CHECK`**：`runChecks`+`bucketize` → `{status:'done', result:{passCount, blocks:[{id,name,reason}], warns:[...], skippeds:N}}`。block 是正常检查产出（不是 error）→ 回 done 带结构化结果，由 bg 判 phase。保留 `CAP_NOT_EDIT_PAGE`/`CAP_CHECK_THREW` 真错误。
  - **`CAP_PUBLISH_EXEC`**：仅 `clickPublishImmediate` → `{status:'done',result:{published:true}}` 或 `CAP_PUBLISH_FAILED`。
- 删除旧 `CAP_PUBLISH` 一把梭 handler（编排器不再用；手动 Hub 路径走 `onCheck`/`onPublish`，不受影响）。
- `runChecks`/`bucketize`/`clickPublishImmediate` 三个纯能力函数复用，不改。

### 2. `automation/orchestrator/steps.js`
- publish 步 def：`manualGate:true` → 改 `gate:'publish'`（reversible:false 不变）。
- `buildInitialWorkflow` step map **透传 `gate: d.gate || null`**（[[feedback_stepdefs_field_passthrough]] 教训：加字段必须同步工厂 map，否则 engine 读到永 undefined 成死代码）+ 加经工厂的回归测试。manualGate 字段可一并移除（publish 是唯一使用者）。

### 3. `automation/orchestrator/engine.js`
- run-auto 不可逆闸：`if (step.gate==='publish')` → `buildPublishHitl` 停在 `await-check` 并 return（替代 manualGate 分支）；其余仍走 `reviewGate`。
- 新增 `buildPublishHitl(step, {phase, checkResult, publishError})` → `{action, stepId, kind:'publish', phase, checkResult, publishError, status:'pending'}`。**hitl 不携带 autoPublish** —— engine 是纯函数不读 storage，开关初态由 dashboard 直接读 storage key（见 §4），保持 engine 纯净。
- 导出 buildPublishHitl 供 bg 各 phase 转移时复用（bg 用 mutateWorkflow 直接改 hitl.phase/checkResult 亦可）。

### 4. `automation/bg-entry.js`
- 抽 `findDxmEditTab()` 复用（现 `orchAdapterPublish` 内的 `*://*.dianxiaomi.com/*` + url 含 edit 查找逻辑）。
- 删 `orchAdapterPublish` + `ORCH_ADAPTERS['publish']`（publish 不再走 stepRunner，改由 WF_PUBLISH_CHECK/EXEC 驱动）。
- 新 `orchPublishCheck(workflowId, autoPublish)` / `orchPublishExec(workflowId)` / `orchSkipStep(workflowId)`（均走 orchQueue 串行化 mutate）。
- autoPublish 持久化：storage key `as_publish_autopublish`（boolean，默认 false）；`orchPublishCheck` 收到 checkbox 值即写回 storage（记住，作下次 checkbox 初态默认）。bg 不读它做分支 —— 分支只认 WF_PUBLISH_CHECK 传来的当前 checkbox 值（治本次）。
- WF_ handler 注册三条新分支：`WF_PUBLISH_CHECK` / `WF_PUBLISH_EXEC` / `WF_SKIP`。

### 5. `automation/dashboard/components/hitl-queue.js`
- `hitlCard` 加 `kind:'publish'` 分支（置于 review/fill/confirm 之前），按 `hitl.phase` 三态渲染 + checkbox + 三按钮。
- checkbox 初态：dashboard 读 storage key `as_publish_autopublish`（默认 false）渲染 checked；值读取复用 getField 式 DOM 读（点检查时读 `#dash-publish-auto` 的 checked，经 opts.autoPublish 传给 hitl-action）。

### 6. `automation/dashboard/hitl-action.js`
- `buildHitlMessage` 加 act：`publish-check`→`WF_PUBLISH_CHECK{workflowId, autoPublish:opts.autoPublish}`、`publish-exec`→`WF_PUBLISH_EXEC`、`skip`→`WF_SKIP`。

## 错误分层（沿用项目铁律）

| 场景 | category / code | 卡片 |
|------|-----------------|------|
| 编辑页 tab 没开 | read / `PUBLISH_NO_EDIT_TAB` | error 卡（recoverable，可重试） |
| 检查异常 | read / `CAP_CHECK_THREW` | error 卡 |
| 检查 block 命中 | （非 error）checkResult.blocks | `blocked` 卡（列出阻断规则名） |
| 立即发布失败 | read / `CAP_PUBLISH_FAILED` | `await-publish` 卡显 publishError，可重点发布 |

## 安全影响（净收益）

- publish 步从"停一次点确认就连发"→"**必须人工点检查、看结果、再点发布**（或显式勾自动发布）"，且**任何路径都需人工先点一次检查启动**，无无人值守自动发布路径 → 比现状更安全。
- 检查 block 永远转人工、自动发布开关失效 → 不合规商品不会被自动发布。
- 其余不可逆步（⑦⑨⑬）reviewGate 现状不变（本次不碰）。

## 测试

- `tests/orchestrator-*.test.js`：publish 步 pending→run-auto 停在 `kind:'publish'/phase:'await-check'`；`skipped` 状态 → advance-cursor（state-machine 已支持，补断言）。
- `tests/steps.test.js`（或现有 buildInitialWorkflow 测试）：`gate` 字段经工厂透传到实例（防死代码回归）。
- `tests/dashboard-hitl-action.test.js`：新增 `publish-check`/`publish-exec`/`skip` act → 正确 WF_* 消息（纯逻辑，必测）。
- CAP_CHECK / CAP_PUBLISH_EXEC 是 content-world DOM 耦合 → 手动端到端验证（店小秘编辑页实跑），不强求单测。
- 全量：`node --test tests/*.test.js` + `python3 -m pytest tests/` 保持全绿。

## 实施分期（可选）

1. **后端链路**（CAP 拆分 + engine gate + bg 三函数 + WF_ 消息 + steps gate 透传 + 单测）—— 可先用 dashboard 现有按钮/console 验证。
2. **dashboard UI**（publish-gate 三态卡 + checkbox + hitl-action 映射）—— 接通可视两段确认。
3. 本地 build + 店小秘编辑页端到端实测（可弃测试商品）。

