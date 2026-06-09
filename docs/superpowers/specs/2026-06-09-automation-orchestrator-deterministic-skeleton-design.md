# 自动化编排器设计：确定性骨架（上架 → 发货 9 步流水线）

> 状态：设计定稿（2026-06-09 brainstorming 通过）。
> 关联：全局架构 + 数据契约见 spec `2026-06-08-automation-monitor-and-data-contract-design.md`；进度/隔离真源见 `docs/superpowers/automation-monitor-roadmap.md`；Plan 1（dashboard）已落地（main `34cc6a6`）。
> 定位：本 spec 是「全流程自动化（上架 → 发货）」的**第二个落地 spec**——把现有离散 feature 串成确定性流水线骨架。LLM 大脑（编排智能 / 诊断 self-heal / 比价决策）留后续 sub-project 叠加。

## 范围

**覆盖**：
- background 本地确定性编排器（事件驱动状态机，按 9 步业务流推进，不靠 LLM）
- 13 原子 step 骨架定义（6 AUTO 调现有 feature + 7 HITL 人工卡点）
- 每步目标页面导航（`target` 声明 + 自动导航 / HITL「前往」）
- storage 写入收口（唯一写入者 + 串行化 mutation 队列）
- SW 回收恢复语义（checkpoint + 副作用标记 + 不可逆步转 HITL）
- HITL 流转 + 业务页浮层（就地确认 / 回填 / 前往）
- WS 通道架子（client 框架 + 连接状态；无大脑 server 显示离线）
- 错误三分层 + 测试策略

**不覆盖**（留后续 sub-project）：
- LLM 编排大脑（编排智能 / 诊断 self-heal / 比价核价决策）
- 缺口环节自动化（返单价抓取 / 1688 自动下单 / 选品判断）
- WS 承载编排指令（首版编排走 bg 本地，WS 只搭架子为大脑铺路）

## 业务流前提（2026-06-09 用户对齐）

运营真实 9 步（详见 roadmap「业务流真实顺序」段）：选品 → 店小秘采集+发布 → 获返单价 → 1688 比价 → 下单 → 维护货号+标签+合规 → 创建采购单 → 等付款 → 到货发货。

关键决策：**先上架后采购**（发布后才有 SKC，采购由返单价驱动比价）、合规所有商品必经、首版切法 = **无 LLM 确定性骨架，整条端到端，缺口/决策点全挂 HITL，大脑后叠加**。

## 目录
1. 架构总览 + 数据流
2. 编排器状态机
3. Step 模型 + 13 步骨架
4. storage 写入收口 + SW 恢复语义
5. HITL 流转 + 浮层
6. WS 通道架子 + 错误处理
7. feature 改造清单
8. 测试策略
9. 待对齐与工程风险

## 1. 架构总览 + 数据流

### 1.1 首版三层

对照全局 spec §2.1，首版把「外部 LLM 大脑」换成「background 本地确定性编排器」，WS 只搭架子：

```
[监控层] dashboard（storage 订阅 ✓Plan1）+ 浮层（新，只读 storage）+ WS client（连接灯）
            ↑ storage.onChanged                    ↑ message（HITL 确认/回填）
[编排层] background 确定性状态机 ── 唯一 storage 写入者
         + WS client 架子（连/重连/心跳；无 server → 显示离线）
            ↓ 导航 tabs.create/update + 命令 message
[执行层] 现有 feature content script
         改造：从「人工 Hub 触发」→ 加「bg 可编程调用」入口
```

### 1.2 数据流（一个 workflow 的生命周期）

1. **启动**：dashboard/浮层点「开始」→ message → 编排器建 workflow（storage：`cursor=0`，`steps[]` 全 `pending`）。
2. **推进循环**（事件驱动，每轮不驻留）：读 `cursor` → 当前 step → 分支：**自动步** = 导航 tab 到 `step.target` + 等 `readySignal` → 调 feature 收 `result` → 写 result + 推进 `cursor` → 下一轮；**HITL 步** = 写 `paused` + `hitl`（含 targetUrl）后退出等人（**不自动导航**，targetUrl 供浮层「前往」按钮）。
3. **显示**：每次 storage 写 → `onChanged` → dashboard/浮层重渲；WS 灯首版恒「离线」。
4. **HITL 确认**：人在浮层/dashboard 点确认/回填 → message → bg 写 `hitl.status` + step `result` + 推进 `cursor` → 回到推进循环。

### 1.3 关键不变量

- `as_workflow_state` = 唯一状态源，background = 唯一写入者（全局 spec §2.3）。
- 编排器事件驱动、**不驻留**（SW 回收安全）。
- WS 首版只承载「连接状态显示」，编排不经 WS。

## 2. 编排器状态机

### 2.1 状态机

复用全局 spec §4.1：`workflow.status` = `pending | running | paused | error | done | aborted`；`step.status` = `pending | running | paused | done | error | skipped`。

### 2.2 `advance(workflowId)` 单步推进器

编排器是事件驱动的单步推进器，每轮处理到「卡住」为止：

```
读 workflow；status ≠ running → return        // paused/done/error/aborted 不推进
step = steps[cursor]
switch step.status:
  pending:
    step.status = running                      // 写 storage，占位防重入
    if 自动步:
      导航: await (tab → step.target.url；waitForEl readySignal)
      result = await 调 feature 命令(message)
      step.result = result；step.status = done  // 写 storage(checkpoint)
      → 继续循环(回到 switch)
    if HITL 步:                                // 不自动导航
      step.status = paused；workflow.status = paused
      workflow.hitl = { 摘要, 目标URL(供「前往」按钮), 待回填字段 }
      return                                   // 等人，不驻留
  running:  return                             // 已在处理，幂等
  done:     cursor++；越界→workflow.status=done；否则继续循环
  error:    workflow.status = error；return
  paused:   return                             // 等 HITL
```

### 2.3 触发 `advance` 的事件

- 启动 message（用户点「开始」）
- 自动步 feature 命令结果返回
- HITL 确认 message（人确认 → 写 step.done + 推 cursor → advance）
- SW `onStartup` / 重连唤醒（从 cursor 续跑）

### 2.4 两个关键性质

- **不驻留**：遇 HITL 写 `paused` 立即 return；人确认时由 message 重新触发。SW 在 HITL 长停顿（数小时）被回收也无状态可丢。
- **幂等**：`step.status=running` 是「处理中」锁 + storage 串行化写入队列（§4），防同一步被并发事件重复执行。

> 单步内部（导航 + feature）仍是 async `await`——Chrome 对活跃 SW 保活，秒级单步回收风险低；**长停顿靠 paused 退出、单步中途回收靠 §4 副作用标记**，两条防线分工。

## 3. Step 模型 + 13 步骨架

### 3.1 Step 结构

扩展全局 spec §4.1，加 `type` + `target` + 恢复相关字段：

```js
Step {
  id, label, feature,        // feature=null → HITL 人工步
  type,                      // 'auto' | 'hitl'   ← 新增，编排器分支依据
  status, startedAt, endedAt,
  target: { domain, urlTemplate, readySignal } | null,  // 新增；HITL 步用于「前往」按钮
  reversible,                // 新增；中断后能否安全重跑（§4）
  committing,                // 新增；feature 在不可逆提交点前写 true（§4）
  result,                    // 产物 dict，流向下游 step 输入
  brainBrief,                // 首版无大脑 → '(确定性)'
  note, error: StepError|null
}
```

### 3.2 13 原子 step 序列

粒度原则：**单 feature + 单目标页面**。用户 9 业务步 → 13 原子步：

| # | step id | type | feature / 动作 | 目标域 | 产出 result | reversible |
|---|---------|------|---------------|--------|------------|-----------|
| 1 | select_product | HITL | 人工选品 | Temu | label | — |
| 2 | collect_dxm | HITL | 人工采集建品（店小秘原生） | 店小秘 | dxm 就绪 | — |
| 3 | publish | AUTO | check_and_publish | 店小秘 | 发布成功 | ✗ |
| 4 | get_return_price | HITL | 人工回填返单价 | Temu 商家 | returnPrice + spuId/skc | — |
| 5 | compare_1688 | HITL | 人工核价（image_search 辅助） | 1688 | 采购源 / 核价OK | — |
| 6 | order_1688 | HITL | 人工下单回填 | 1688 | orderNo1688 | — |
| 7 | gen_label | AUTO | auto_gen_label | Temu 商家 | labelPng + skuNo | ✗ |
| 8 | create_sku | AUTO | create_purchase_order Phase1 | Temu 列表 | dxm SKU | △ |
| 9 | create_po | AUTO | create_purchase_order Phase2 | 店小秘 | poNo | ✗ |
| 10 | wait_payment | HITL | 人工确认付款 | 店小秘 | 已付款 | — |
| 11 | wait_arrival | HITL | 人工确认到货 | kuajingmaihuo | 已到货 | — |
| 12 | pack_label | AUTO | packing_label | kuajingmaihuo | 标签文件 | ✓ |
| 13 | ship | AUTO | auto_ship | 发货页 | 运单号 | ✗ |

> reversible：✓ 可安全重跑 / ✗ 不可逆需确认 / △ 写后读可检测已建（半可逆） / — HITL 步不涉及。

### 3.3 关键点

- **HITL step 几乎零实现成本**：编排器一套逻辑（`paused` + 提示 + 「前往」+ 等确认/回填）覆盖全部 7 个。真正工作量在 **6 个 AUTO step 的 feature 改造**（§7）。
- **混合步拆原子**：业务步 2 → 采集（HITL）+ 发布（AUTO）；业务步 7 → 建 SKU（AUTO）+ 采购单（AUTO）；业务步 9 → 等到货（HITL）+ 打标（AUTO）+ 发货（AUTO）。每步要么纯人工、要么纯一个 feature，编排器分支干净。
- **product 渐进填充**：`workflow.product.spuId/skc` 在 step4（发布后）才有、`skuNo` 在 step7 后、`poNo` 在 step9——各 step 的 result 回填 `workflow.product` 供显示。
- **step 序列声明式**：13 步定义为一张声明式表（id/label/feature/type/target/reversible），编排器读表推进；加步/改序只动表、不动编排逻辑（开闭原则）。

## 4. storage 写入收口 + SW 恢复语义

首版最大工程风险所在（全局 spec §4.3），两部分。

### 4.1 storage 写入收口（全局 spec §2.3）

- background 唯一写入者；所有写入走一条 **mutation 队列**（async-lock），**字段级合并、不整对象覆盖**。
- 首版并发写源虽比有大脑时少，但 `advance` 的多触发源（feature 结果 / HITL 确认 message / SW 唤醒）仍会交错 read-modify-write，不串行化就 lost-update。
- 实现：`mutate(path, fn)` 入队，队列串行 `读 → 改 → 写`。cpo 的 `cpoSetPhase` RMW 仅单流程串行时安全，引入多触发源后必须真队列。

### 4.2 SW 回收恢复语义（全局 spec §4.3）

**checkpoint**：每 step 开始写 `running`、结束写 `done + result`，形成可恢复断点。

**可逆性元数据**（step 定义声明 + feature 回报）：
- `step.reversible`：中断后能否安全重跑（见 §3.2 表）。
- `step.committing`：feature 在「不可逆提交点」前写 `true`，成功后清掉并写 `result`。

**恢复决策**（SW 唤醒 → 读 storage，对 cursor 指向的中断 `running` step）：

```
if step.reversible:                    → status=pending，advance 重跑
elif step.committing 未清 或 不确定:
     → step.status=paused；workflow.status=paused
       hitl = {"这步可能已执行，请确认：已完成→跳过 / 未完成→重试"}
else (未触及提交点):                    → status=pending，重跑
```

**孤儿 tab 清理**：AUTO step 开的临时 tab id 落 `workflow.tmpTabs`（现为内存态、回收即丢）；恢复时先关孤儿 tab 再继续（参考 cpoRun2 的 `tmpTabs`）。

**保活仅尽力**：WS `PING/PONG` 延长 SW 寿命但不保证；恢复语义是**正确性底线**，不依赖保活规避回收。

## 5. HITL 流转 + 浮层

### 5.1 HITL 统一流转

7 个人工步共用一套（全局 spec §2.3「用户操作唯一汇聚」）：

```
编排器到 HITL step:
  step.status=paused；workflow.status=paused
  workflow.hitl = { action, keyValues, editable, fieldType, options, targetUrl }
  退出（不驻留）

浮层/dashboard（storage.onChanged 触发）:
  弹「待处理：<action>」+ [前往] + [确认/回填提交] / [拒绝]

人操作 → message 给 background（不直接写 storage）:
  确认/回填 → bg 写 step.result=值 + step.status=done + hitl.status=confirmed/modified + cursor++ → advance
  拒绝     → bg 写 workflow.status=aborted（人重新决定）
```

> 首版无大脑：`reviewedBrief` 空、不转 `USER_ACTION` 给大脑（WS 架子在但无 server）。大脑接入后这条链路复用。

### 5.2 两类 HITL

- **纯确认型**（等到货 / 等付款）：人点「已完成」→ done → 推进，无回填。
- **回填型**（返单价 / 比价结果 / 1688 订单号）：人回填值 → 存 `step.result` → 流向下游（如 `orderNo1688` → create_po 输入）。

### 5.3 浮层（core 注入，全局 spec §8 步骤 4 / §3.1）

- **迷你进度条**：`cursor N/13` + 当前 step label（只读 storage）。
- **HITL 弹窗**：`workflow.status=paused` 时弹精简操作；复杂的「改」跳 dashboard。
- **「前往」按钮**：打开 `step.target.url`——解决「每步页面不同、原靠人工导航」：人一点就到正确页面操作。
- 全业务页注入（Temu / 店小秘 / 1688 / kuajingmaihuo，与 FAB/Panel 同级），只读 storage + 发 message，**不连 WS**（绕 CSP）。

### 5.4 浮层 vs dashboard 分工

浮层 = 业务页就地处理（看进度 + 确认/回填/前往）；dashboard = 全局总览 + 未来大脑详情（reviewedBrief / valueDiff / 「改」编辑态）。

## 6. WS 通道架子 + 错误处理

### 6.1 WS 通道架子（全局 spec §4.2，首版只搭不喂）

- bg + dashboard 各加 **WS client 类**（connect / 指数退避重连 / `PING-PONG` 心跳 / onclose→重连）。
- 顶栏连接灯绑状态：绿（连）/ 黄（重连）/ 红（断）；**首版无 server → 恒红「大脑离线」**（全局 spec §2.1）。
- 消息收发框架就位，`RUN_STEP` / `BRAIN_EVENT` 等 **handler 是 stub**（无 server 不触发）；大脑 sub-project 接入时填实现。
- 复用 Plan 1 的 `ws-source`：从 mock 回放改为「真实连接尝试 + 连不上降级」。
- token 首版**硬编码占位**（全局 spec §9.2 的分发机制留后续 sub-project）。

### 6.2 错误处理（全局 spec §6.2 三分层）

- AUTO step feature 失败 → 回报 `StepError{category, code, message, recoverable, suggestion}`；`category` 沿用各 feature 已有文案规则（写后读=validate / DOM 没找到=read / 业务拦截=business）。**导航失败（target 打不开 / readySignal 超时）= read 类**。
- 编排器：`step.status=error` + `workflow.status=error` → dashboard/浮层显示分层 chip；`recoverable=true` 显 [重试]（重置 step→pending→advance），否则 [转人工]。
- **首版无大脑 self-heal**：错误一律停下等人，不自动诊断重试。

## 7. feature 改造清单

6 个 AUTO step 的现有 feature 需加「bg 可编程调用入口」。统一改造模式（参考 `create_purchase_order` 已落地的「bg 命令处理器」先例）：

1. **加命令处理器**：content 暴露 `chrome.runtime.onMessage` 命令分发（不自驱，收 bg 命令 → 操作本页 DOM → 回报），与现有「人工 Hub 触发」入口并存。
2. **导航后就绪等待**：handler 第一行 `waitForEl(readySignal)`——`tab.status=complete` ≠ 组件就绪（项目铁律）。
3. **结构化回报**：返回 `{ status, result, error: StepError|null }`，`result` 字段对齐 §3.2 表的产出。
4. **不可逆提交点标记**：不可逆动作（发布 / 上传标签图 / 创建采购单 / 确认发货）前写 `step.committing`，成功后清并写 result（§4.2 恢复用）。

| feature | 改造量 | 备注 |
|---------|--------|------|
| create_purchase_order | 小 | 已是 bg 命令处理器模式（CPO_* 命令），仅需对齐回报格式 + committing 标记 |
| check_and_publish | 中 | 现为 Panel 按钮触发 onCheck/onPublish，需加命令入口 + 结构化回报 |
| auto_gen_label | 中 | 三阶段自动级联，加 bg 命令入口；上传标签图是不可逆提交点 |
| packing_label | 中 | 加命令入口；可逆（重打无害） |
| auto_ship | 中 | 加命令入口；确认发货是强不可逆提交点 |

> 改造**只加入口、不改现有 DOM 逻辑**（现有确定性代码是资产，全保留）。

## 8. 测试策略

- **纯逻辑单测**（`node --test tests/*.test.js`，沿用项目惯例）：
  - 编排器 `advance` 推进逻辑（pending→running→done→cursor++ / HITL→paused / error→停 / 越界→done）。
  - 恢复决策（reversible · committing → 重跑 vs 转 HITL）。
  - mutation 队列防 lost-update（并发写字段级合并）。
  - 13 步序列结构校验（id 唯一 / type 合法 / AUTO 必有 feature+target / reversible 声明完整）。
- **storage 契约**：沿用 Plan 1 `dashboard-store` 测试模式（normalizeSkeleton / emptyBatch 不回归）。
- **feature 改造 + 端到端**：6 个 AUTO feature 的「bg 可调用入口」依赖真实 DOM，**无法纯单测**，靠 chrome 手动端到端——真跑 AUTO 步 + 手动确认 HITL 步，验证编排 + 恢复 + HITL + 浮层。对齐 debugging-rules「验证铁律」：关键路径必须有新鲜验证证据。

## 9. 待对齐与工程风险

### 9.1 实现期必须实测（不可纸面假设）
- **MV3 SW + 长 AUTO step**：单个 SW 实例最长运行 ~5 分钟；packing_label 虚拟滚动扫描等长任务可能逼近上限，需实测，必要时拆步或分段 checkpoint。
- **MV3 SW + WebSocket 保活**：靠 `PING/PONG` + 重连兜底，**必须实测确认**（全局 spec §9.2）。
- **导航就绪信号**：每个 AUTO step 的 `readySignal` 选择器须用真实 DOM 校准（沿用各 feature `samples/`）。
- **跨域登录态**：13 步横跨 Temu / 店小秘 / 1688 / kuajingmaihuo 四域，依赖人已在各域登录；未登录时 AUTO step 会失败 → read 类错误转人工。

### 9.2 起步约束
- **单 workflow 串行**：`batch.workflows[]` 留并行位，但首版只跑 1 个 workflow 串行执行（全局 spec §9.1）；多 workflow 共享浏览器/登录态 tab 的隔离留后续 sub-project。
- **缺口环节人工**：返单价获取 / 1688 下单 / 选品判断 / 比价核价首版全 HITL，自动化留后续。

### 9.3 不在本 spec（后续 sub-project）
LLM 编排大脑（编排智能 / 诊断 self-heal / 比价核价决策与 prompt）、缺口环节自动化、WS 承载编排指令、现有 FAB/Panel/Hub 迁移到深色 tokens。

### 9.4 与后续 sub-project 的衔接
首版预留的衔接点：WS client 框架（大脑接入填 handler）、`USER_ACTION` 转发链路（无大脑时空转）、`brainBrief`/`reviewedBrief` 字段（无大脑时空）、storage 契约（大脑经 bg 写、不破坏唯一写入者）。大脑 sub-project = 实现 WS server + 把部分 HITL 判断点替换为「大脑判断 + 人确认」。
