# HITL 回填打通 L3 端到端 — 验证说明

> 配套 plan `docs/superpowers/plans/2026-06-13-orchestrator-hitl-fill-l3.md`。
> 激活 3 个回填型 HITL（步2 collect_dxm 填 `skc`、步5 compare_1688 填 `url1688`、步6 order_1688 填 `orderNo1688`），打通 Plan 2/3 自动化流水线 L3 端到端数据流。**纯 core 改动不碰 feature**。首版一 SKC 一 SKU、单值契约。

## 一、自动化验证（已跑，可复现）

| 项 | 命令 | 结果 |
|----|------|------|
| engine.buildHitl 按步 editable/fields | `node --test tests/orchestrator-engine.test.js` | 20 pass（原 17 + 新 3）|
| overlay-view 回填收集/校验 | `node --test tests/overlay-view.test.js` | 13 pass（原 8 + 新 5）|
| 全量 JS | `node --test tests/*.test.js` | 87 pass / 0 fail |
| 全量 Python 不回归 | `python3 -m pytest tests/` | 49 passed |
| 语法 | `node --check`（overlay/overlay-view/steps/engine）| exit 0 |
| dev build 不回归 | `python3 build/build_extension.py` | 8 features / 15 cs |

> ⚠ JS 测试命令必须用 `node --test tests/*.test.js`（整目录会把 pytest `.py` 当 JS 解析失败）。

## 二、数据流打通（断点 → 通）

**断点（修复前）**：`engine.buildHitl` 的 `editable` 恒 false → 7 个 HITL 步共用纯确认摘要 → overlay 回填控件 dead branch → 步2/5/6 无法回填 → 下游 AUTO 步缺数据 → L3 端到端断。

**打通后**（写回机制复用现有 `pickProduct`，无需改）：

| HITL 步 | 回填字段 | 下游消费 |
|---------|---------|---------|
| 步2 collect_dxm | `skc`(+`spuId`) | 步7 gen_label（orchAdapterGenLabel 传 `product.skc`）|
| 步5 compare_1688 | `url1688` | 步8 create_sku（缺=hard error recoverable:false）|
| 步6 order_1688 | `orderNo1688` | 步9 create_po（缺=hard error）|

**机制链路**：steps.js `hitlSpec` 元数据 → `engine.buildHitl` 读 `step.hitlSpec` 条件化 `editable+fields` → overlay `renderBody` 多字段渲染 → `buildFillResult` 收集 + `validateFill` 校验 → `WF_HITL_CONFIRM {result}` → `orchHitlConfirm` 调 `pickProduct` 写回 `product`。AUTO 步产出同样经 `engine.js:84` `pickProduct` 写回（gen_label→skuNo、create_po→poNo）。

## 三、chrome e2e（留 task #30 一起验）

前置：`python3 build/build_extension.py`；reload 扩展；起 workflow（overlay「开始流水线」或 SW console `orchStartWorkflow`）。

1. **步2 回填 skc**：collect_dxm paused → overlay 弹「SKC（采集后创建，唯一）*」+「SPU ID（可选）」输入框 → 填 skc → 确认 → cursor 推进 + SW console 验 `as_workflow_state.batch.workflows[0].product.skc` 已写入。
2. **步5 回填 url1688 + 格式校验**：填非 1688 链接（如 taobao）点确认 → alert「1688 链接格式不对」拦截不发；填合法 url1688 → create_sku 拿到。
3. **步6 回填 orderNo1688** → create_po 拿到。
4. **required 空校验**：步2 skc 留空点确认 → alert「SKC… 必填」拦截不发。

## 四、首版边界

- **一 SKC 一 SKU**（单值契约）；多变种不同 1688 货源/订单（per-SKU 数组契约）留后续刀。
- **人工填**（spec §9「回填=人工 overlay」）；大脑从上下文推断回填值留后续（spec §12）。
- 步4 get_return_price 保持纯确认（无下游消费字段）。
- recovery 的 hitl（SW 恢复确认）`editable=false`、`recover` 内直接构造不走 buildHitl，不受影响。
- **发版隔离**：overlay 回填只在 active workflow 的 paused 态触发，release 无 WF_START → 无 workflow → 不触发，沉睡（同 overlay 既有 isDev 隔离）。
