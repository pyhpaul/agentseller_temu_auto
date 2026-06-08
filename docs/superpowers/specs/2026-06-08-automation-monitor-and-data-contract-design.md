# 自动化流程监控系统设计：Dashboard + 数据契约 + 连接架构

> 状态：设计定稿（UI 视觉定稿 2026-06-08）；业务流真实顺序待对齐（见 §9）。
> 关联：方案总览见 memory `project-full-automation-plan`；UI 原型 `ui-prototype/dashboard.html`（深色盯盘，浏览器可直接打开）。
> 定位：本 spec 是「全流程自动化（上架→发货）」的**第一个落地 spec**——监控 + 数据契约 + 连接基础。后续另有「LLM 编排大脑」「feature 改造为可调用工具」「业务流编排」等 spec。

## 范围

**覆盖**：
- hybrid 架构的三层结构 + 连接拓扑（确定性执行器 + 外部 LLM 大脑 + WebSocket 桥接）
- 监控系统信息架构（dashboard + 业务页浮层）
- 数据契约（storage 权威骨架 + WebSocket 实时层）
- UI 视觉规范（深色盯盘设计语言）
- 交互态规格、集成点、实现优先级

**不覆盖**（留后续 spec）：LLM 大脑的编排/诊断/复核 prompt 与逻辑、各 feature 改造为「可被调用的工具」的细节、业务流真实环节顺序。

## 目录
1. 背景与目标
2. 架构：三层 + 连接拓扑
3. 信息架构
4. 数据契约（storage 骨架 + WebSocket 血肉）
5. UI 视觉规范
6. 交互态规格
7. 集成点
8. 实现优先级
9. 待对齐与工程风险

## 1. 背景与目标

### 1.1 背景
现有 8 个调试成熟的确定性 DOM 自动化 feature（auto_gen_label / price_declare / image_search_1688 / check_and_publish / packing_label / create_purchase_order / auto_ship / sale_manage_export），覆盖 Temu 商家中心、1688、店小秘、kuajingmaihuo 四平台。当前各 feature 由人在 Hub 手动逐个触发、各用各的 storage、无全局上下文。目标是串成「上架→发货」全自动流水线，引入 LLM agent 当大脑负责编排、出错诊断、填写复核。

### 1.2 为什么是 hybrid（确定性骨架 + LLM 判断点）
调研结论：任务全是 WRITE 类（填表/发货/下单），是 LLM browser-agent 最弱区间——真实环境成功率 ~46%（Web Bench WRITE），长链相乘趋近不可用。现有确定性代码已踩平大量 DOM 坑（Ant Design Vue isTrusted / 虚拟滚动 / 写后读校验），是资产；跑真实登录浏览器天然绕过 agent 最大 blocker（登录/2FA/CAPTCHA）。故：**确定性插件做执行器，外部 LLM 进程做大脑（只在编排/诊断/复核三个判断点介入），主流程不靠 LLM 逐步决策。**

### 1.3 监控系统目标
- 运营 5 秒看清：进度到哪、卡在哪、为什么卡、要不要介入。
- 完整呈现 LLM 大脑的工作（编排进度 + 诊断推理 + self-heal + 复核结论），不只是结果。
- 不可逆动作前的 HITL 人工确认入口。
- 与编排大脑解耦：dashboard 消费通用数据契约，业务流环节是运行时数据、不锁死 UI。

## 2. 架构：三层 + 连接拓扑

### 2.1 三层
```
[编排大脑 · 外部进程 / Claude Agent SDK]   编排 / 诊断 self-heal / 复核修改
            ↕  WebSocket (localhost)
[连接层 · 扩展 background（编排中枢）]      收大脑指令→调度 feature；进度写 storage
            ↕  runtime message / chrome.storage
[执行器 · 8×content script + native host]  已调好的确定性 DOM 操作（全保留）
```
- **大脑不碰 DOM**：把每个 feature 当「工具」调用，看结构化回报决策；需要看页面时由 content script 抓 DOM/截图回传。
- **native host** 继续承担文件 / BarTender / 系统能力，不做主编排通道。

### 2.2 连接拓扑
- **大脑进程 = WebSocket server**（localhost:PORT）；background 与 dashboard 都是 client。
- **background ↔ 大脑**：双向（指令下发 + 结果回报 + storage 写驱动 + 观察 + 用户操作转发）。
- **dashboard ↔ 大脑**：纯下行（大脑推送实时血肉：推理流 + HITL 详情）。
- **浮层不连 WS**：只读 storage（绕开 content script 连 ws 受站点 CSP 限制的坑）。
- **大脑进程生命周期（单点，须显式处理）**：大脑是 WS server，必须**先于流程启动**，且是扩展生命周期外的独立进程——拉起方式（手动启动脚本 / native host 拉起）待定（见 §9.2）。大脑不可用（没启动/崩溃）时：bg/dashboard 连不上 → 顶栏 WS 灯红 + 明示「大脑离线，流水线暂停」；进行中 workflow 卡在 storage 的 running 态，恢复入口 = 大脑重启重连 + 按 §4.3 恢复语义续跑。**不能让大脑崩了就静默卡死无提示**。

### 2.3 两个唯一性（健壮性支点）
- **storage 唯一写入者 = background**：大脑、浮层、dashboard 都**不直接写** `chrome.storage`——前端（浮层/dashboard）的 HITL 确认/改/拒绝发 runtime message 给 background（与现有 `CPO_START` 模式一致），大脑发 WS 消息给 background，**一律由 background 落盘**。
  - **写入必须串行化**：background 内对 `as_workflow_state` 的所有写入走一条 mutation 队列（async-lock），**字段级合并、不整对象覆盖**。否则大脑 `STATE_PATCH`（写 cursor/status/hitl）与 background 自写 `STEP_RESULT`（写 step.status/result）两条 async read-modify-write 路径交错，后完成的 `set` 会用陈旧快照覆盖先完成的字段（lost-update）。现有 `cpoSetPhase` 的 RMW 模式仅在单流程串行、无外部并发写源时安全，引入大脑后不再成立。
- **用户操作唯一汇聚 = 前端 message → background → 大脑**：前端确认/改/拒绝**不写 storage**，发 message 给 background；background 写 `hitl.status` + 转大脑 `USER_ACTION`。这样大脑上行只有 background 一个来源，且避免「前端写 storage 触发 background 自己的 onChanged」回环。

## 3. 信息架构

### 3.1 层级
```
监控中心 (dashboard)
├─ L1 队列总览 (batch)         多商品，起步只 1 个、留位
│    每行: 商品 | 整体状态 | 进度 N/总 | 当前环节 → 点击进 L2
└─ L2 单商品详情 (workflow)
     ① 流程总览条: 商品标识 | status | cursor N/总
     ② 环节列表 steps: 每环节 状态 / 产物 / 错误
     ③ 🧠 大脑实时流: review / diagnose / selfheal / log
     ④ ⏸ HITL 队列: 待确认项 [确认][改][拒绝]

浮层 (业务页) ← 只读 storage 骨架
     迷你进度条 + HITL 弹窗([确认][拒绝]，「改」跳 dashboard)
```

### 3.2 数据来源分工
| 板块 | 数据来源 |
|------|---------|
| 流程总览 / 环节列表 / HITL 摘要 | storage 骨架（dashboard + 浮层都读） |
| 🧠 大脑实时流 / HITL 详情 | WebSocket（仅 dashboard，storage 没有） |

dashboard = storage 订阅者（骨架）+ WebSocket 客户端（血肉）；刷新或 WS 断线都能从 storage 重建骨架。浮层只读 storage。

## 4. 数据契约

### 4.1 storage 权威骨架
`chrome.storage.local['as_workflow_state']` —— 唯一权威状态，background 唯一写入。

```js
{
  schemaVersion: 1,
  batch: { id, createdAt, activeWorkflowId, workflows: [ Workflow ] }  // 起步仅 1 个
}

Workflow {
  id, product: { label, spuId, skc, skuNo },
  status,        // pending | running | paused | error | done | aborted
  cursor,        // 当前 step 索引（-1=未开始）
  startedAt, updatedAt,
  steps: [ Step ],
  hitl: HitlSummary | null    // 同一时刻至多一个待确认项
}

Step {
  id,            // 稳定 key，如 'gen_label' 'create_po'
  label, feature,
  status,        // pending | running | paused(停HITL) | done | error | skipped
  startedAt, endedAt,
  result,        // 产物 dict，如 {poNo}{spuId,labelPng}；流向下游 step 输入
  brainBrief,    // 该步大脑关键结论摘要：'review:pass' / 'selfheal:...'
  note,          // 补充说明，如 skipped 原因「本批不导出」
  error: StepError | null
}

StepError {
  category,      // read | validate | business  ← 决定大脑策略
  code, message, recoverable, suggestion
}

HitlSummary {
  id, action,    // 「申请付款」「确认发货」
  keyValues,     // {金额:'¥128.00', 收货仓库:'中正科技仓'}
  reviewedBrief, // LLM 复核一句话结论
  editable,      // [可改字段名]        ← 进 storage（断线也能改）
  fieldType,     // {字段: 'number'|'select'|'readonly'}
  options,       // {字段: [可选值]}（select 用）
  status         // pending | confirmed | modified | rejected
}
```

**关键设计**：
- `hitl` 单字段不是数组——流程串行，同一时刻至多停一个待确认点，浮层逻辑极简。
- `result` 是产物载体——上游 step 的 result 喂下游 step 输入，解决「无全局上下文」缺口。
- `error.category` 是路由字段——read→self-heal、validate→复核修正、business→交人工。
- HITL 编辑元数据（editable/fieldType/options）**进 storage 不进 WS**——确认/改/拒绝是关键操作，WS 断线也要能改。
- **step 停 HITL 的表达**：`step.status='paused'` + `cursor` 指向该 step + `workflow.hitl` 挂摘要/详情入口；dashboard 据 `step.status==='paused'` 渲染 HITL 标记，**不靠「running 叠加 tag」的隐式约定**（原型那一帧用 run+tag 绕过，契约要显式）。
- **初始化/迁移**：background 启动校验 `schemaVersion`，缺失或低版本则重置为空 `{schemaVersion:1, batch:{workflows:[]}}`，避免裸展开深层嵌套（batch.workflows[].steps[]）时 undefined。

### 4.2 WebSocket 实时层

连接：大脑进程 = WS server（localhost:PORT）；background + dashboard = client。信封 `{ v:1, type, id, ts, payload }`，指令带 `id`、回报带 `replyTo:id`。

**大脑 → background**（双向通道）
| type | payload | 作用 |
|------|---------|------|
| `RUN_STEP` | {workflowId, step{id,label,feature,input}} | 调度某 feature 执行一步 |
| `STATE_PATCH` | {path, value} | 驱动 bg 更新编排级 storage 字段（cursor/status/hitl） |
| `OBSERVE` | {workflowId, target} | 令 content 抓 DOM/截图回传（self-heal/复核看页面） |
| `ABORT` | {workflowId} | 中止 |

**background → 大脑**
| type | payload | 作用 |
|------|---------|------|
| `HELLO` | {role:'bg', v} | 握手/重连 |
| `STEP_RESULT` | {workflowId, stepId, status, result, error} | 一步执行结构化结果 |
| `OBSERVE_RESULT` | {snapshot\|screenshot} | 页面观察回传 |
| `USER_ACTION` | {kind, hitlId?, payload} | 转发用户操作（confirm/modify/reject/pause/resume/abort） |

**大脑 → dashboard**（纯下行推送）
| type | payload | 作用 |
|------|---------|------|
| `BRAIN_EVENT` | {workflowId, stepId, kind, text} | 推理流（review/diagnose/selfheal/log） |
| `HITL_DETAIL` | {hitlId, action, fullReview, valueDiff:[{field,current,proposed}], risk} | HITL 详情 |

**通用**：`HELLO`/`WELCOME` 握手（dashboard 报 role:'dash'）；`PING`/`PONG` 心跳保活。

**机制**：
- 重连恢复：background SW 被回收唤醒 → 重连 `HELLO` → 大脑 `WELCOME` 回当前 cursor → 从 storage 读 step 态续跑（可恢复工作流，复用 create_purchase_order 恢复逻辑）；dashboard 重连只重订血肉，骨架从 storage 恢复、错过的血肉可丢。
- 指令 `ack` + 超时重试：沿用 cpo `cpoSendCommand` 的 ack+超时重试**模式**，但 WS 与 `chrome.tabs.sendMessage` 是不同传输层，**WS 侧需独立实现**（非代码复用）。
- **OBSERVE_RESULT 体积**：截图/快照经 WS 单帧可能数 MB，约定上限 ~4MB（对齐现有 image_search 的 `IMG_MAX_BYTES`），超限走 native host 分块或降采样。

### 4.3 Service Worker 回收与 step 恢复语义（关键工程约束）

MV3 service worker 在长时间静默（如等 HITL 确认期间）可能被回收，进行中的 `RUN_STEP` async 栈直接蒸发。因任务多为**不可逆 WRITE**（已下单/已发货），「从 storage 续跑」会造成重复副作用，必须按以下语义恢复：

- **step 级 checkpoint**：每个 step 开始/结束写 storage（startedAt / status / result），形成可恢复断点。
- **副作用标记**：step 进入「已产生副作用」（提交前 vs 提交后）要落 storage（如 `step.committed:true`、或 result 已有 poNo/运单号）。恢复时据此判断是否已写过下游。
- **恢复决策**（SW 重启 + 重连后，对 cursor 指向的中断 step）：
  - 未产生副作用（仅填表未提交）→ 可安全重跑。
  - **已产生 / 不确定副作用（不可逆动作）→ 不自动重跑，转 HITL** 让人确认「这一步是否已完成」，由人决定跳过或重试。
- **孤儿 tab 清理**：RUN_STEP 开的临时 tab（参考 cpoRun2 的 `tmpTabs`）现为内存态、回收即丢。须把临时 tab id 落 storage（`workflow.tmpTabs`），恢复时先清理孤儿 tab 再继续。
- **保活仅尽力**：`PING/PONG` 延长 SW 寿命但不保证（静默期仍可能 30s 回收），故恢复语义是**正确性底线**，不能依赖保活规避回收。

> 这是整个 hybrid 架构最大的真实工程风险（不可逆动作 + SW 易失），必须在实现步骤 3（接 WS + 端到端 RUN_STEP）前按本节设计，不可临场补。

## 5. UI 视觉规范

> 视觉真源：`ui-prototype/dashboard.html`（深色盯盘，浏览器可直接打开）。本节提炼 tokens 与规则，实现时把 tokens 提到 `:root`、dashboard 与浮层共用。

### 5.1 调性
深色数据盯盘风（Grafana/Datadog 类）。统一设计语言，**不沿用旧 FAB/Panel 的功能性样式**，现有 UI 后续迁移对齐。

### 5.2 Design tokens（深色）
- 背景层次：`--bg-0:#0d1117 / --bg-1:#161b22 / --bg-2:#1c2128 / --bg-3:#21262d`
- 边框 `--border:#30363d / --border-muted:#21262d`；文字 `--text-0:#e6edf3 / --text-1:#8b949e / --text-2:#6e7681`
- 强调 `--accent:#58a6ff`（hover 亮蓝 `#79c0ff`）

### 5.3 状态色板
done `#3fb950` 绿 / running `#58a6ff` 蓝（loader 旋转）/ pending `#6e7681` 灰 / error `#f85149` 红 / skipped `#484f58` / paused(HITL) `#d29922` 橙。
- 大脑流 kind：review `#58a6ff` / diagnose `#e3b341` / selfheal `#bc8cff` / log `#6e7681`。
- 错误三分层：read 紫红 `#db61a2` / validate 黄 `#e3b341` / business 红 `#f85149`（**paused 橙与 validate 黄已分离，解决橙过载**）。

### 5.4 字体
- 栈 `"Segoe UI","Microsoft YaHei UI","PingFang SC",system-ui,sans-serif`；mono `"Cascadia Mono",Consolas,monospace`。
- **tabular-nums**（金额/ID/时间戳等宽对齐）；抗锯齿全套。
- 字号层级：基准 17 / 辅助 13–15 / 板块标题 18 / 商品名 24（流程总览条强调）。

### 5.5 图标
14 个 Lucide 风格线性图标，SVG sprite（`<symbol>` 定义一次 + `<use>` 复用），`stroke=currentColor` 跟随状态色。**不用彩色 emoji**。

### 5.6 交互
- hover 浮动：大框体抬升 6px + 亮蓝边 + 辉光 44px + 内发光；卡片抬升 4px + 辉光；按钮/chip 抬升 2px。
- 选中：环节行 / 大脑流条点击选中（蓝底 + 左 inset 蓝条）。
- HITL 卡橙描边呼吸；running loader 旋转 + dot 脉冲圈。

### 5.7 布局
- grid 两行（顶栏固定 + 主区）；主区两列（L1 队列 248px + L2 详情滚动区）。**顶栏 + 队列栏不随详情滚动**。
- L2：流程总览条满宽（视觉焦点，节点圆 32px）+ 下方两列（左环节列表 / 右 大脑流+HITL）。
- 间距紧凑争取一屏；大脑流 `max-height` 内部滚动。

## 6. 交互态规格

### 6.1 HITL「改」编辑态
点 [改] → HITL 卡就地展开为可编辑表单。每个 keyValues 项按 `fieldType` 渲染：number→输入框、select→下拉（用 `options`）、readonly→灰显不可改。改值时显式警示「覆盖大脑建议值」。确认 → **发 runtime message 给 background**（不直接写 storage），由 bg 写 `hitl.status=modified` + 修改后值并转大脑；遵循写后读校验（金额合法数字、仓库枚举内值）。**编辑元数据来自 storage，断线也能改**。

### 6.2 step error 三分层
`step.status=error` 行变红，右侧出错误分层 chip（read 紫红 / validate 黄 / business 红）+ message 截断；展开看 code/message/suggestion。`recoverable=true` 才显示 [重试]，否则只 [转人工]。视觉权重 business > validate > read（对应介入紧迫度）。

### 6.3 空态
无 workflow → L1/L2 空态留位（不隐藏，提示「多商品规划中」）；HITL 0 项 → 浅灰「暂无待确认，流程自动推进中」。

### 6.4 WS 断线降级
storage 骨架不依赖 WS——断线时进度/环节/HITL 摘要照常（来自 storage），仅大脑流全文 + HITL 详情停更并标注「连接断开，重连中」。顶栏 WS 灯：绿(连接)/黄(重连)/红(断开)。HITL 确认/拒绝走 storage 不依赖 WS；「改」若需 WS 详情则 disabled 提示。重连后补流。

## 7. 集成点

- **dashboard.html 落地（含 core 级 manifest 改造，新增点）**：dashboard 是可直接导航的扩展页（`chrome-extension://.../dashboard/dashboard.html`），**通常不需要 web_accessible_resources**（除非被 web 页 iframe 嵌入，否则别加）。但有两个现有 build 不支持的 core 级需求：① `manifest.template.json` 需加 `content_security_policy.extension_pages` 放行 `connect-src ws://localhost:*`，否则 dashboard 扩展页发 WS 会被默认 CSP（`connect-src 'self'`）**拦死**；② `build_extension.py` 现仅从 feature.json 聚合 permission、**无 core 级声明通道**——需扩充支持 core 级 manifest 字段（CSP / 扩展页）或在模板直接硬写。Hub 加「打开监控」入口（`chrome.runtime.getURL`，可拉独立窗口置顶）。
- **监控浮层归 core**：迷你进度条 + HITL 弹窗是跨所有 feature 的全局 UI，放 core（与 FAB/Panel 同级注入），不绑 feature；只读 storage。
- **storage 写入收口 background**：现有各 feature 直接写各自 key 的逻辑，流水线状态改为经 background 写统一 `as_workflow_state`（feature 自有 key 可兼容保留）。
- **WebSocket 客户端**：background 加 WS client（连大脑 + 调度 feature）；dashboard 加 WS client（收血肉）。native host 角色不变。
- **设计 tokens 沉淀**：深色 tokens 提到共享 `:root`，dashboard + 浮层共用；现有 FAB/Panel/Hub 迁移到这套 tokens 是独立任务（不在本 spec 范围）。

## 8. 实现优先级（先壳后肉，渐进可验证）

1. **dashboard 静态壳**：dashboard.html + 深色 tokens（`:root`）+ store 读 mock（`window.__AS_MOCK__`）→ 跑通静态渲染（①②③④）。**原型 `ui-prototype/dashboard.html` 已是这一步成果**。
2. **接 storage**：storage-source 订阅 `as_workflow_state` + onChanged → 替换 mock 骨架源，全量重渲。
3. **接 WebSocket**：ws-source 喂大脑流 + HITL 详情 + 断线降级；background 加 WS client + `RUN_STEP` 调度一个最成熟 feature（create_purchase_order）验证端到端。
4. **浮层**：core 注入迷你进度条 + HITL 弹窗（只读 storage，复用 makeDraggable/showToast）。
5. **接入更多 feature + 编排大脑**：留后续 spec。

组件拆分建议：`dashboard/{dashboard.html, dashboard.css, dashboard.js, state/{storage-source, ws-source, store}, components/{topbar, queue-list, overview-bar, step-list, brain-stream, hitl-queue, error-chip}, overlay/{mini-progress, hitl-popup}, mock/mock-data}`。**骨架全量重渲，大脑流增量 append**。
- **JS 加载**：dashboard 用原生 ES module（`<script type="module" src="dashboard.js">`，扩展页原生支持 import），**不走** content_scripts 的字符串拼接注入；`build_extension.py` 需加 dashboard 子目录拷贝分支 + 各 .js 的 sourceURL 注入（与现有 core copytree 区分）。原型是单文件内联，实现时拆成上述多文件。

## 9. 待对齐与工程风险

### 9.1 待对齐（阻塞真实环节落地，不阻塞本监控系统开发）
- **业务流真实顺序**：采购（create_purchase_order）排上架前/后？「上架」是哪个 feature（check_and_publish / auto_gen_label）？合规填写是否必经？—— 用户后续一一对齐。数据契约 steps 数据驱动，顺序定了只填环节，不返工 UI/契约。
- **多 workflow 并行的资源争用**：`batch.workflows[]` 留了并行位，但所有 workflow 共享同一浏览器 + 同批登录态 tab——两个 workflow 同跑 create_purchase_order 会抢同一店小秘表单、`cpoWaitEditTab` 监听串台。**起步单 workflow 串行执行，数组仅未来预留；并行的 tab/登录态隔离是后续 spec 的 must-resolve 项**，不可假设数组能直接并行。

### 9.2 工程风险（实现期必须实测，不可纸面假设）
- **MV3 service worker + WebSocket 保活**：Chrome 对活跃 WS 会保活 SW，但静默会被回收。靠 `PING/PONG` + 断线自动重连兜底，**必须实测确认**。
- **storage 写频率**：大脑流摘要若写过频可能触发限流，必要时节流。
- **本地 WS 鉴权 + token 分发**：localhost 明文，加简单 token 握手防本地进程冒用；但 token 从哪来、大脑进程与扩展（unpacked 多机部署、硬编码=公开）如何共享同一 token，**分发机制待定**（后续 spec）。
- **字号 vs 一屏张力**（low）：§5.4 大字号（基准 17 / 商品名 24）与 §5.7「一屏容纳」在小屏上冲突，**冲突时一屏优先、字号可下调**，实现时实测。

### 9.3 不在本 spec（后续）
LLM 编排/诊断/复核逻辑与 prompt、feature 改造为可调用工具、业务流编排顺序、现有 UI 迁移到新 tokens。
