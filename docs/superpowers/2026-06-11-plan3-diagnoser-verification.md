# Plan 3 第二刀 诊断器 self-heal 闭环 — 验证说明

> 配套 plan `docs/superpowers/plans/2026-06-11-plan3-diagnoser-selfheal.md`、spec §6。
> 本刀 = 出错诊断 self-heal 闭环：step error → 报大脑 → 诊断（红线 + 模型）→ STATE_PATCH → 重试 / 转人工。

## 一、自动化验证（已跑，可复现）

| 项 | 命令 | 结果 |
|----|------|------|
| 模型抽象层 | `python3 -m pytest tests/test_brain_model.py -v` | 5 passed |
| 诊断器决策 + 两红线 | `python3 -m pytest tests/test_brain_diagnoser.py -v` | 8 passed |
| server 集成（error→STATE_PATCH+diagnose）| `python3 -m pytest tests/test_brain_server.py -v` | 3 passed |
| bg engine onStepSettled/applyDiagnosis | `node --test tests/orchestrator-engine.test.js` | 17 passed |
| 全量 Python | `python3 -m pytest tests/` | 43 passed |
| 全量 JS | `node --test tests/*.test.js` | 71 pass / 0 fail |
| bg SW 语法 | `node --check core/background/service-worker.js` | exit 0 |
| dev build | `python3 build/build_extension.py` | 8 features / 14 cs |
| server 冒烟（MockModel）| `timeout -s INT 2 python3 -m brain` | `using MockModel`→`starting`→`stopped`，无报错 |

> ⚠ 真实模型（OpenAICompatModel）端到端不在自动化里——单测全用 MockModel；真 API 留第四刀 / chrome e2e（用户配 `BRAIN_LLM_BASE_URL`/`BRAIN_LLM_API_KEY`/`BRAIN_LLM_MODEL`）。
> ⚠ JS 测试命令必须用 `node --test tests/*.test.js`（不是整目录；整目录会把 pytest `.py` 当 JS 解析失败）。

## 二、chrome 诊断闭环 e2e（留「大脑一起验」，本刀不强跑）

前置：`python3 -m brain`（MockModel 即可演示规则式 self-heal）；`python3 build/build_extension.py`；reload 扩展。

1. **起大脑 + bg 连上**：SW console 见 `[orch-ws] live`；Hub「打开监控」→ dashboard 灯 live。
2. **造一个 read 类瞬时错误**：SW console 手搭一条 workflow，让某 auto step 返回 `{status:'error',error:{category:'read',code:'TIMEOUT',message:'timeout',recoverable:true}}`（或临时改 adapter 抛超时）。
3. **看 self-heal**：dashboard 大脑流应出现 `diagnose` 类 BRAIN_EVENT（`retry：超时类瞬时故障...`）；storage 里该 step `retryCount` +1、status 回 `pending`→`running`（自动重试）。
4. **看红线—结构性转人工**：造 `message:'selector not found'`、`code` 不含 timeout 的 read error → dashboard `diagnose`（`escalate`）；step 转 `paused`、wf `paused`、overlay 弹 HITL（`reviewedBrief` 含「大脑转人工」）。
5. **看红线—不可逆不重试**：不可逆步（`recoverable:false`）出错 → 即便大脑说 retry 也强制 escalate（applyDiagnosis 兜底）。
6. **真实模型**：配 `BRAIN_LLM_*` env 重起大脑 → 同样流程，诊断由真模型判断（验 model-agnostic 留第四刀换适配器）。

## 三、本刀边界 / 下一刀

本刀做 self-heal 诊断闭环（read 智能重试 / 其余转人工 / 两红线）。**不含**：HITL 回填的模型决策（仍人工）、不可逆复核、可偏离、`WF_START` 启动入口（第三刀）。

- **下一刀（第三刀）**：overlay「开始流水线」按钮解 `WF_START` 启动入口缺口（spec §8）。
- **发版隔离待办仍在**（spec §12）：bg ws-client 自启 + STATE_PATCH handler 在 release 应隔离，Plan 3 合 main 前统一处理。
