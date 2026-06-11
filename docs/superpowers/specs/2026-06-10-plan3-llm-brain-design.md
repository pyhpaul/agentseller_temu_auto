# Plan 3：LLM 大脑（自动化编排智能层）设计

> 全自动化「上架→发货」hybrid 架构的智能层。在已合入 main 的确定性编排骨架（Plan 2）之上叠加一个 **model-agnostic 外部大脑**；首版聚焦「可被任意模型驱动的框架 + 出错诊断 self-heal」。

## 背景与关系

- **Plan 1**（已合 main）：dashboard 监控页 + 数据契约。
- **Plan 2**（已合 main `21d3075`）：确定性编排骨架——13 步状态机、6 AUTO adapter、HITL 浮层、WS 通道架子（`ws-client.js` 不自启 / `ws-source.js` 降级 mock）。
- **Plan 3（本 spec）**：大脑智能层。WS 消息协议 + storage 数据契约在 `docs/superpowers/specs/2026-06-08-automation-monitor-and-data-contract-design.md` 已定稿，本 spec 落地其中「大脑」部分，并记录两处对早期决策的修正（见 §11）。

**首版目标（成功标准）**：一个真实模型通过 WS 接入骨架，**在出错时诊断 self-heal**（read 类智能重试、其余转人工），全程 dashboard 可见；框架 **model-agnostic**（换模型只改一个适配器）。

## §1 架构总览

**agent + tools**：每个动作（Plan 2 的 adapter / feature 能力）= 一个 **tool**，有清晰的输入 / 输出 schema。新增能力 = 注册一个新 tool（`ORCH_ADAPTERS` 进化成 tool registry）。流程不再硬编码——见控制权。

> ⚠ **关键区分**：agent + tools 是**能力模型**（决定有哪些动作、能否扩展），不是**执行模型**（谁逐步驱动）。可扩展性是能力模型的事；首版**执行**由确定性引擎驱动。两者正交——这是本设计区别于「纯大脑逐步驱动」的核心。

**两层解耦（大脑进程内部）**：
- **编排框架（模型无关，项目自建）**：tool registry + 诊断器 + WS server + 三职责 hook（首版只实现诊断）。
- **LLM 后端（可插拔）**：统一模型接口 `decide(messages, tools) → tool_calls / text`，适配 LiteLLM 或 OpenAI-compatible 端点。换模型只改这层。

**控制权 = 确定性引擎驱动 + 大脑判断点介入**（核心，区别于「大脑逐步驱动」）：
- bg 的 `orchEngine` 继续按 **playbook（数据）** 自动 advance，跑可逆步——快、稳、SW 友好、复用 Plan 2。
- 大脑**不逐步发令**，只在判断点被召唤；首版唯一判断点 = **出错**（诊断 self-heal）。
- **可扩展性正交于驱动方式**：靠 tool registry（新增 = 注册 tool）+ playbook 数据化（改流程 = 改数据，多 playbook 对应多场景）保证，**不靠大脑逐步驱动**。
- 「可偏离 / 编排」（后续）= 大脑在判断点返回「跳过 / 插入 / 换 tool」指令，引擎执行。
- **大脑离线 → 天然降级**为「纯确定性 + 人工 HITL」（即 Plan 2 现状），无需额外降级代码。

## §2 进程拓扑

```
                  ┌─ WS server (localhost:8787) ─┐
   [大脑进程 Python] ←─────────────────────────→ [Chrome 扩展 bg]  ← client
        │  ↑                                            │ 执行 tool
   编排框架│  │ LLM 后端(可换)                          ↓ (现有 adapter，零改)
        │  └── LiteLLM / OpenAI-compatible            [content / feature 页]
        └──────────────────────────────────→ [dashboard]  ← client(只读血肉)
```

- **大脑进程**（Python，新）= WS server，常驻、监听 localhost，本地起（dev 手动）。
- **bg** = WS client（连大脑）+ tool 执行者（现有 adapter）。
- **dashboard** = WS client，只收大脑流（首版 `BRAIN_EVENT`；`HITL_DETAIL` 后续）+ 读 storage。
- WS 端点 `ws://localhost:8787` 与已铺架子（`ws-client.js` / `ws-source.js`）一致。

## §3 组件划分

**A. 大脑进程（Python，新）—— 首版四组件**：
1. **WS server**（localhost:8787）：管理 bg / dashboard 连接 + 消息收发。
2. **模型抽象层**：`decide(messages, tools) → tool_calls / text`，适配 LiteLLM / OpenAI-compatible；换模型只改这层。
3. **tool registry（镜像）**：tool 的 name / description / 输入输出 schema，供诊断时大脑理解「有哪些手段、当前 step 在干什么」。首版静态声明，与 bg adapter / `steps.js` 对齐。
4. **诊断器（self-heal）**：首版唯一智能。输入 `StepError` + 上下文 → 模型抽象层 → 结构化决策 → `STATE_PATCH`。

**B. bg（扩展）—— 两处改动 + 两处不动**：
- `ws-client` 自启（连大脑；把架子的「不自启」改掉）。
- `orchEngine` 的 **error 分支加 hook**：大脑在线 → 经 WS 发 `StepError` 问诊断 → 按决策（重试 / 转人工）；大脑离线 → 现状（error 停 + 人工 HITL）。
- **playbook 留在 bg**（`steps.js` + `orchEngine` 确定性推进，首版不动驱动主干，只加 error hook）。
- tool = 现有 adapter（**零改**）。

**C. dashboard**：`ws-source` 接真实大脑（架子已有连接 + 降级），收 `BRAIN_EVENT`（诊断流）；`HITL_DETAIL` 后续（首版人工 HITL，大脑不产生）。

## §4 数据流

**正常流程（无错）**：
1. `WF_START`（启动入口见 §8）→ bg `orchEngine` 按 playbook 自动 advance。
2. 每步：bg 跑 tool（adapter）→ 写 storage → `STEP_RESULT` 报大脑 → 大脑回 `log` 类 `BRAIN_EVENT` 给 dashboard。
3. dashboard：读 storage（骨架）+ 收 `BRAIN_EVENT`（血肉）；overlay：读 storage 显示进度。
4. HITL 步：bg pause，overlay 人工确认（**首版回填 = 人工 overlay，模型不管回填**）。

**出错流程（self-heal，首版核心智能）**：
5. step error → bg error hook → `STEP_RESULT`（带 `StepError`）报大脑。
6. 大脑诊断器：调模型抽象层，按三分层决策 → 发 `diagnose` / `selfheal` 类 `BRAIN_EVENT`（dashboard 看推理）+ `STATE_PATCH` 落地决策。
7. bg 应用 `STATE_PATCH`（重试 = step 重置 pending / 转人工 = 转 paused HITL）→ 继续 advance。
8. 大脑离线 / 超时 → bg 退化（error 停 + 人工 HITL，即现状）。

## §5 WS 协议子集

首版只用已定契约（`2026-06-08` spec §4.2）的最小集：

| 消息 | 方向 | 用途 |
|------|------|------|
| `HELLO` | bg / dashboard → 大脑 | 握手（带 role） |
| `PING` / `PONG` | 双向 | 保活 |
| `STEP_RESULT` | bg → 大脑 | 每步报告（含 `StepError`） |
| `STATE_PATCH` | 大脑 → bg | 诊断决策落地（改 workflow 状态意图） |
| `BRAIN_EVENT` | 大脑 → dashboard | `log` / `diagnose` / `selfheal` |

**首版不用**：`RUN_STEP`（不逐步驱动）/ `OBSERVE`·`OBSERVE_RESULT`（诊断暂用 `StepError` 够）/ `USER_ACTION`·`HITL_DETAIL`（首版人工 HITL，大脑不掺和）。

**关键一致性**：诊断决策通过 `STATE_PATCH` 落地——大脑只发「改状态意图」，**仍由 bg 写 storage**（守住数据契约「storage 唯一写入者 = bg」），大脑不直接写、不逐步驱动。

## §6 self-heal 机制 + 安全红线

**三分层落地（首版）**：
- **read（DOM / 超时 / 选择器）= 可 self-heal**：大脑读 `StepError` 全文 + 上下文，模型判断「瞬时（值得重试）vs 结构性（重试无用）」→ 重试 或 转人工。**智能正在此**：不是机械按 category 重试，是模型读 message 判断（超时 → 重试；选择器找不到 = 页面结构变了 → 转人工）。
- **validate（数据校验）** → 转人工（数据修正需回填能力，首版回填 = 人工）。
- **business（业务拦截）** → 转人工（业务问题非技术自愈）。

**两条安全红线**：
- **重试上限**（默认 2 次）：storage 的 step 加 `retryCount`，超限强制转人工（防死循环）。
- **不可逆绝不重试**：`recoverable:false` 的 error（不可逆步）→ 大脑直接转人工，**绝不 self-heal**（重试 = 重复不可逆操作）。守住 Plan 2 committing 语义——故首版 self-heal 实际只对 `recoverable:true`（read 类）生效。

**诊断器接口**：输入 `StepError` + 上下文（step / product / 最近几步）+ tool registry → 模型 → 结构化决策 `{action: retry | escalate, reason}` → `STATE_PATCH`。

## §7 系统级错误处理（非业务）

- **WS 断线** → ws-client 重连（架子已有指数退避）；断线期间退化（error 停 + 人工）。
- **模型 API 调用失败** → 大脑回退「转人工」（诊断不了就转人工，安全默认）。
- **大脑进程崩溃** → bg 检测连接断 → 退化为纯确定性 + 人工 HITL。
- **SW 回收** → Plan 2 恢复语义不变（committing / reversible）；大脑首版不参与恢复（恢复是 bg 确定性逻辑）。

## §8 启动入口

Plan 2 缺口（`WF_START` 仅能 SW console 手调），首版必解：

- **overlay 加「开始流水线」按钮**（业务页操作场景最顺，overlay 已是 content script）。
- 点击弹小输入框填 **商品 label** → 发 `WF_START { label }`。
- 其余 product 字段（`spuId` / `skc` / `url1688` / `orderNo1688`…）首版靠流程中 HITL 人工补（回填 = 人工）。

## §9 首版边界

**✅ 做**：大脑进程（WS server + 模型抽象层 + tool registry 镜像 + 诊断器）/ bg ws-client 自启 + `orchEngine` error hook / dashboard 接真实大脑 / self-heal（read 智能重试、其余转人工、两条红线）/ `WF_START` overlay 启动入口。

**⬜ 不做（后续刀）**：可偏离 / HITL 回填的模型决策（回填 = 人工 overlay）/ 不可逆复核 / 完整降级（`orchEngine` 自动续跑作大脑离线兜底）/ 生产部署（dev 手动起大脑）/ `OBSERVE`·`RUN_STEP`。

**实现拆刀（粗，细节留 plan）**：① WS 端到端管道（大脑 server + bg ws-client 自启 + HELLO/STEP_RESULT/PING）→ ② 诊断器 + error hook + STATE_PATCH（self-heal 闭环）→ ③ overlay 启动入口 → ④ model-agnostic 验证（换适配器）。每刀可独立验。

## §10 测试策略

- **纯逻辑单测**：模型抽象层（mock 模型）/ 诊断器决策（给 `StepError` → 期望 `retry`/`escalate`）/ WS 协议编解码 / 重试上限 + 不可逆不重试（红线）。
- **WS 集成**：大脑 server ↔ bg client（node 测 client 端、python 测 server 端）。
- **model-agnostic 验证**：换一个模型适配器跑通同一诊断用例（证明可换）。
- **e2e**：留 chrome，配合 `docs/superpowers/2026-06-10-plan2-chrome-verification-checklist.md` + Plan 2 各 adapter 一起验（用户决策「大脑搭完一起验」）。

## §11 与早期决策的关系（两处修正）

1. **model-agnostic（颠覆「Claude Agent SDK」旧决策）**：`2026-06-08` spec / 早期 memory 写「LLM 大脑 = 外部进程 Claude Agent SDK」。Plan 3 brainstorming 修正为：**不锁定任何家**——编排框架自建（模型无关），LLM 后端可插拔（统一接口 + LiteLLM / OpenAI-compatible），换模型只改适配器。理由：用户要按性价比换模型、骨架成熟后任意模型可驱动。
2. **控制权（确定性引擎驱动 vs 大脑逐步驱动）**：早期设想偏「大脑逐步 `RUN_STEP` 调度」。修正为：**确定性 `orchEngine` 按 playbook 驱动 + 大脑仅判断点介入**。理由：可扩展性靠 tool registry + playbook 数据化保证（正交于驱动方式），逐步驱动只增成本（每步 WS 往返 + LLM 调用 + SW 风险）不增收益，且与自主程度 c（模板 + 可偏离）更自洽。

## §12 待后续 / 未定

- **可偏离机制**：大脑在判断点返回「跳过 / 插入 / 换 tool」指令，引擎执行（贯穿性，框架成熟后整体上）。
- **HITL 回填的模型决策**：首版人工 overlay；后续大脑从上下文推断回填值。
- **不可逆复核（③职责）**：首版人工确认覆盖；后续大脑复核不可逆动作的数据 / 时机。
- **完整降级**：大脑离线时 `orchEngine` 自动续跑可逆步（首版仅「停 + 人工」）。
- **生产部署**：常驻大脑进程的启动 / 分发 / API key 配置 / 成本归属（首版 dev 手动）。
- **tool registry 动态同步**：首版静态声明，后续 bg 启动时经 HELLO 同步 tool 清单给大脑。
- **playbook 外置数据化**：首版 = `steps.js`；后续抽成可配置数据 + 多 playbook（多场景）。
- **self-heal 改参**：首版只重跑（不改参），后续大脑可建议改 product 参数再重试。
