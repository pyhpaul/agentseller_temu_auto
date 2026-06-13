# Plan 3 第四刀 model-agnostic 验证 — 验证说明

> 配套 plan `docs/superpowers/plans/2026-06-13-plan3-model-agnostic.md`、spec §10/§11.1。
> 本刀 = model-agnostic 验证：用实现机制完全不同的玩具第二适配器（内联 `ScriptedModel`）跑同一批诊断用例，证明诊断器 `diagnose()` 对 LLM 后端实现无感（换模型只改 `model.py` 适配器）。**不改 `brain/` 生产代码**。

## 一、自动化验证（已跑，可复现）

| 项 | 命令 | 结果 |
|----|------|------|
| model-agnostic 验证（红线优先 + read 透传，跨 2 适配器）| `python3 -m pytest tests/test_brain_model_agnostic.py -v` | 6 passed |
| 全量 Python（不回归 + 新增 6）| `python3 -m pytest tests/` | 49 passed（原 43 + 6）|
| 全量 JS（不回归，第四刀不动 JS）| `node --test tests/*.test.js` | 79 pass / 0 fail |
| dev build（不回归）| `python3 build/build_extension.py` | 8 features / 15 cs |

> ⚠ JS 测试命令必须用 `node --test tests/*.test.js`（整目录会把 pytest `.py` 当 JS 解析失败）。

## 二、命题与测试设计

**命题**：诊断器 `diagnose(step_error, context, model)` 只依赖 `model.decide(messages)` 接口、不依赖具体模型类——换 LLM 后端只改 `model.py` 适配器，诊断逻辑 / 安全红线不变（spec §11.1）。

**两个实现机制完全不同的适配器**（证明「可换」非循环论证的关键——不是换了个语义相同的克隆，而是换了内部机制）：
- `MockModel`（`brain/model.py`）：**if-else 规则式**，看 `messages` 末条 content 是否含 `timeout` / `超时`。
- `ScriptedModel`（测试内联）：**数据驱动关键词映射**，取末条 user 消息（避开 system 提示文案污染）按 `rules` 列表顺序匹配子串。机制与 `MockModel` / `OpenAICompatModel` 都不同，仅满足 `decide(messages, tools=None) -> str` 契约。

**两类断言**：
1. **安全红线 / 三分层优先于模型**（3 测试 × 2 适配器）：`recoverable=false`（红线 1）/ `retryCount` 达上限（红线 2）/ `validate`·`business`（三分层）——任意适配器（含倾向 retry 的）都强制 `escalate`。证明安全逻辑与模型实现无关。
2. **read 未触红线时诊断器忠实透传模型决策**（3 测试）：同一 read 用例瞬时→`retry`、结构性→`escalate` 跨适配器一致；且强制两适配器对「本会判 escalate 的用例」说 `retry` → 诊断 `retry`，证明 read 决策来自模型（可插拔）而非诊断器硬编码。

**结果**：6 测试全 Green = 诊断器本就 model-agnostic。本刀不是「让它变得可换」，而是把这一既有架构属性**锁进回归网**——日后任何对 `diagnoser.py` / `model.py` 的改动若引入对具体模型类的隐藏耦合，这组测试会失败。

## 三、范围边界（用户 2026-06-13 AskUserQuestion 拍板「玩具适配器」）

- **做**：玩具第二适配器（内联 `ScriptedModel`）+ model-agnostic 验证测试。不引入未验证的真实后端生产代码。
- **不做（留后续）**：
  - **真实第二家适配器**（如 Anthropic Messages API：system 抽独立字段 / 端点 `/messages` / 响应 `content[0].text`）——未来需要时按 `OpenAICompatModel` 范式加（~20 行 urllib）。
  - **`OpenAICompatModel` 单测**——它目前**零单测覆盖**（真 API 请求构造 + 响应解析逻辑），留 e2e（用户配 key）或后续补 mock HTTP 单测。本刀不碰（不在所选范围）。

## 四、Plan 3 四刀闭环 + 合 main 前收尾

**四刀全部代码完成**（均在 `feature/automation-llm-brain`，**未 push**）：
1. WS 端到端管道（大脑 server + bg ws-client 自启 + HELLO / STEP_RESULT / PING）
2. 诊断器 self-heal 闭环（STEP_RESULT error → 诊断 → STATE_PATCH → retry / escalate）
3. overlay WF_START 启动入口（空态「开始流水线」，isDev 守卫发版隔离）
4. model-agnostic 验证（本刀）

**合 main 前收尾清单**：
- **发版隔离总账**（spec §12）：① ws-client 自启（第一刀 Task3）破坏 release ws 沉睡——需确认 release 策略（沉睡 dead code vs 剥离）；② STATE_PATCH handler（第二刀）同属 bg 大脑联动代码；③ overlay 启动入口已靠 `isDev` 守卫天然隔离（第三刀）。前两项需在合 main 前统一核账（release 字节级零差异是红线）。
- **chrome e2e**（task #30）：Plan 2 各 adapter + Plan 3 大脑 WS 真实端到端，用户决策「大脑搭完一起验」。本刀完成后大脑四刀齐，具备一起验条件。
- **PR**：四刀 + 收尾后整体 PR 合 main。
