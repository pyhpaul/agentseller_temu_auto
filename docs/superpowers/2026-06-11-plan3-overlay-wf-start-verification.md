# Plan 3 第三刀 overlay WF_START 启动入口 — 验证说明

> 配套 plan `docs/superpowers/plans/2026-06-11-plan3-overlay-wf-start.md`、spec §8。
> 本刀 = overlay 空态「开始流水线」启动入口：无 active workflow + dev → 填商品 label → 发 `WF_START{label}`，解 Plan 2「WF_START 仅 SW console 手调」缺口。**bg 零改动**（WF_START handler + buildInitialWorkflow.product.label 在 2-2a 已预埋）。

## 一、自动化验证（已跑，可复现）

| 项 | 命令 | 结果 |
|----|------|------|
| overlay-view 纯逻辑（三态决策 + label 规范化）| `node --test tests/overlay-view.test.js` | 8 passed |
| 全量 JS（不回归 + 新增 overlay-view）| `node --test tests/*.test.js` | 79 pass / 0 fail |
| 全量 Python（不回归）| `python3 -m pytest tests/` | 43 passed |
| overlay 语法 | `node --check core/content/overlay.js` | exit 0 |
| overlay-view 语法 | `node --check core/content/overlay-view.js` | exit 0 |
| dev build（overlay-view 拷贝 + 注册）| `python3 build/build_extension.py` | 8 features / 15 cs |

> ⚠ JS 测试命令必须用 `node --test tests/*.test.js`（整目录会把 pytest `.py` 当 JS 解析失败）。
> ⚠ 踩坑记录：执行期 `build_extension.py` 首次改动因 tool-call 畸形未生效，cs 数停在 14；修正后 14→15、manifest 含 overlay-view 1 次。content script 数是「overlay-view 真注册」的硬验证点。

## 二、chrome e2e（留「大脑一起验」，task #30，本刀不强跑）

前置：`python3 build/build_extension.py`；reload 扩展；打开任一业务页。

1. **空态启动入口（dev）**：无运行中 workflow 时，业务页右下角 overlay 显示「▶ 开始流水线」按钮（不再隐藏）。
2. **二级交互 + WF_START**：点按钮 → 展开 label 输入框 → 填商品 label → 点「开始」→ bg 建 workflow → overlay 经 storage.onChanged 自动切「编排进度 1/13」。SW console 验 `as_workflow_state.batch.workflows[0].product.label` === 填的值。
3. **label 必填**：留空点「开始」→ 不发 WF_START（输入框重聚焦），无 workflow 建立。
4. **取消**：点「取消」→ 回「▶ 开始流水线」按钮态。
5. **接力**：workflow 建立后进度条 / HITL / error chip 行为同 Plan 2（本刀未改）。

## 三、发版隔离论证（release 行为与 Plan 2 零差异）

- **机制**：`decideOverlayView` 在「无 active workflow」时 dev → `idle`（启动入口），release（`isDev=false` 或 buildInfo 缺失）→ `hidden`。
- **结果**：release `isDev=false` → 空态恒 `hidden` → overlay 沉睡，**行为同 Plan 2**（Plan 2 时 overlay 也因「无人写 storage」恒隐藏）。
- **dead code**：release 含 overlay-view.js + renderIdle 分支，但 isDev 守卫使其永不触发——同既有 OPEN_MONITOR 按钮 dead code 先例，用户已接受不剥这点 JS。
- **storage permission**：overlay/overlay-view 属 core，permission 由 render_manifest 硬编码（2-2c-1），不靠 feature.json 偶然聚合。
- **WF_START handler**：release bg 仍有 handler（Plan 2 起在），但启动入口 hidden → 无人发 → orchestrator release 沉睡无副作用（service-worker.js L630 注释一致）。

## 四、本刀边界 / 下一刀

本刀做 overlay 启动入口（解 WF_START 缺口）。**不含**：HITL 回填的模型决策（仍人工）、product 其余字段自动填（spuId/skc/url1688 首版靠流程中 HITL 人工补，spec §8）、多 workflow 启动。

- **下一刀（第四刀）**：model-agnostic 验证（换一个模型适配器跑通同一诊断用例，证明可换；spec §10/§12）。
- **发版隔离总账（Plan 3 合 main 前统一处理）**：① ws-client 自启（第一刀）② STATE_PATCH handler（第二刀）③ overlay 启动入口（本刀，已靠 isDev 守卫天然隔离）。前两项需在合 main 前确认 release 沉睡策略（spec §12）。
- **chrome e2e**：本刀 + 第一/二刀 + Plan 2 各 adapter 一起真实端到端验（task #30，用户决策「大脑搭完一起验」）。
