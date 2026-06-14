# 不可逆复核（大脑第三判断点）设计

> automation 大脑后续刀（spec §12「不可逆复核」）。在已合 main 的「确定性骨架 + 大脑诊断 + 回填提议」之上，给大脑加**第三个判断点**：不可逆 AUTO 步执行**之前**复核数据 + 时机，可拦下转人工。直击项目最痛的「操作错商品」数据正确性事故，给「未验证骨架」加一道安全网。

## 背景与关系

- **Plan 2/3 + 已合 main 的后续刀**：13 步确定性骨架 + 大脑诊断（出错 self-heal）+ 回填提议（HITL 回填值，PR #66）。大脑现有两个判断点：诊断 / 回填提议，都**不驱动流程**——确定性引擎照常 advance，大脑只在判断点辅助。
- **本刀**：加第三判断点 = **不可逆复核**。不可逆 AUTO 步（`reversible===false`）执行前，大脑复核 → PASS 自动跑 / HOLD 暂停转人工。
- **前提风险**：roadmap 注「后续刀需 chrome e2e 验证基础」，e2e 尚未跑。设计/实现 pre-e2e 安全（不进 release、不碰 feature）。本刀本身是给未验证骨架**加防护网**，与 e2e 风险互补。

## 当前不可逆处理（本刀的改造对象）

- step 有 `reversible` 字段（`automation/orchestrator/steps.js`）。不可逆 AUTO 步：`publish`/`gen_label`/`create_po`/`ship`（`reversible:false`）；`create_sku`（`reversible:true`，△半可逆）；`pack_label`（`reversible:true`）。
- `committing` 标记：不可逆提交点前由 adapter 标（`orchMarkCommitting`），SW 恢复时 `committing===true` 的步 → ask-hitl 恢复确认（可能已执行）。
- 引擎 `advance` 的 `run-auto` 分支：`mutate(status=running)` checkpoint → `await stepRunner(step,wf)`（跑 adapter）→ `mutate(result)`。**当前不可逆步零复核、直接跑 adapter。**
- 错误红线：`recoverable:false` → 绝不重试（diagnoser 红线1 + engine applyDiagnosis 红线）。

## 成功标准

不可逆 AUTO 步执行前，大脑（在线 + 真模型）从「product 数据 + 当前页快照」复核数据 sanity/一致性/页面态 → PASS 自动执行；发现可疑 → HOLD 暂停为「复核确认」HITL，人工看 concerns 后**确认提交 / 中止**。**唯一自动执行不可逆的情形 = 显式 PASS 或大脑未介入（离线）**；任何 HOLD/复核器在线出错都转人工。

## 复核能查什么（诚实边界）

大脑拿到 product 数据 + 当前页快照，能查：
- **格式/sanity**：skc 像不像 SKC、url1688 含不含 1688.com、orderNo1688 像不像订单号、必填字段空不空。
- **跨字段一致性**：页面快照里的商品是否对得上 product.label。
- **页面态合理性**：如 ship 前发货页是否真有匹配待发货单。

**查不了「数据是否微妙地错」**——无 ground truth 比对（那是 auto_gen_label 源头取错值的盲区）。复核拦「明显空/畸形/不匹配/页面态不符」，拦不住「自洽但取错对象」。**复核与「源头取值强校验」分工**，不替代后者。

## 门的语义

- **PASS**（数据过 sanity/一致性/页面态）→ 自动执行 adapter，无人工打断。
- **HOLD**（发现可疑）→ 暂停为「复核确认」HITL（`kind:'review'`），人工看 concerns → 确认提交 / 中止。

## 降级（fail-safe，关键安全决策）

- **大脑完全离线**（无 ws / reviewGate 返回 null）→ 不请求复核 → 照常执行（**additive，零复核=现状，不回归**）。dev 没起大脑不阻塞。
- **大脑在线但复核器出错/超时/解析不出** → **HOLD 转人工**（**fail-safe**：复核闸已激活却得不出结论 → 绝不假 PASS 自动放行不可逆，宁可问人）。
- 区别于 filler：filler 是 advisory（失败→空提议，人工填）；reviewer 是**闸**（失败→保守 hold）。这是两个组件本质不同的失败语义。

## 架构

新增 `reviewer` 组件（`brain/reviewer.py`），与 `diagnoser`/`filler` **并列、解耦**——大脑三判断点各一个模块，server 按消息类型分发。reviewer 复用 `jsonx.extract_decision` 容错解析。

引擎在 `run-auto` 路径加一个 **`reviewGate`** 注入钩子（async）：不可逆步执行前 await reviewGate；HOLD 则暂停不跑 adapter，PASS/null 则照常跑。这是比回填提议（pause 点辅助）**更深的介入**——复核要在「执行 / 暂停」间分叉。

## 组件划分

| 文件 | 改动 |
|------|------|
| `brain/reviewer.py`（新） | `review(step_id, product, context, model) -> {"verdict":"pass"\|"hold", "reason":str, "concerns":[str]}`；jsonx 解析；**模型挂/解析不出/verdict 非法 → hold（fail-safe，非 pass）** |
| `brain/server.py` | `REVIEW_REQUEST` 路由 → `asyncio.to_thread(review)` → `REVIEW_VERDICT` + `review` 类 BRAIN_EVENT；reviewer 抛 → 兜底 hold（fail-safe） |
| `automation/orchestrator/engine.js` | `makeEngine` 加 `reviewGate` 注入（默认 null=不复核）；`run-auto` 分支：`step.reversible===false && reviewGate && !step.reviewed` → `await reviewGate(step,wf)`；返回 `{verdict:'hold',...}` → 暂停 review-HITL（不跑 adapter）；否则 mutate(running, reviewed=true) → 跑 adapter。`buildInitialWorkflow` step 加 `reviewed:false` |
| `automation/bg-entry.js` | `reviewGate` 实现（见下「请求/响应关联」）：`if(!orchWsClient) return null`（离线 proceed）；发 `REVIEW_REQUEST` + 等 `REVIEW_VERDICT`（超时→null=proceed）；仅显式 `{verdict:'hold'}` 才返回 hold。`WF_REVIEW_APPROVE` handler（标 `step.reviewed=true` + wf.running + advance→跑 adapter）；review-HITL 中止复用 `WF_HITL_REJECT` |
| `automation/overlay/overlay-view.js` | 纯逻辑 `isReviewHitl(hitl)`（`hitl.kind==='review'`）；复核 concerns 渲染数据准备 |
| `automation/overlay/overlay.js` | review-kind HITL 渲染：concerns 列表 + reason + 「前往核对」+「确认提交」(WF_REVIEW_APPROVE) +「中止」(WF_HITL_REJECT) |

WS 协议加：`REVIEW_REQUEST{workflowId,stepId,product,context:{pageSnapshot}}` / `REVIEW_VERDICT{workflowId,stepId,verdict,reason,concerns}`。`protocol.py` 编解码不变。

### REVIEW 请求/响应关联（与回填 fire-and-forget 不同——reviewGate 要阻塞 advance 等结论）

回填提议是 fire-and-forget（FILL_SUGGEST handler 异步写 storage，不阻塞）；**复核必须阻塞 advance 直到拿到 verdict**（它是闸）。机制：
- bg 维护 `orchReviewPending` Map（key=`${workflowId}:${stepId}` → resolver）。
- `reviewGate(wfId, step, wf)`：若 `!orchWsClient` 立即 `return null`；否则抓快照 → 发 `REVIEW_REQUEST` → 返回一个 Promise（存 resolver 进 Map）+ `setTimeout(timeoutMs)` 到点 resolve(null)（超时=proceed）。
- `orchEnsureWs` 的 ws handlers 加 `REVIEW_VERDICT`：按 `${workflowId}:${stepId}` 找 resolver，resolve(verdict) 并清 Map + 清 timer。
- engine `await reviewGate(...)` 拿到 `null`（离线/超时）→ proceed；拿到 `{verdict:'hold',...}` → 暂停；拿到 `{verdict:'pass'}` → proceed。
- ⚠ 守发版隔离：reviewGate 首行 `if(!orchWsClient) return null` + reviewGate 仅由 engine reviewGate 注入调用（automation only）→ release 无 ws / 无注入 → 永不阻塞、永不复核。

## reviewGate 介入 run-auto 的精确位置

引擎 `advance` 的 `case 'run-auto'`：
1. **新增**：`const step = wf.steps[wf.cursor]`；若 `step.reversible === false && reviewGate && !step.reviewed`：
   - `const verdict = await reviewGate(workflowId, step, wf)`（bg 实现，含 WS 往返 + 超时；离线/超时 → null）。
   - 若 `verdict && verdict.verdict === 'hold'` → `mutateWorkflow`：`step.status='paused'`、`wf.status='paused'`、`wf.hitl = buildReviewHitl(step, verdict)`（`kind:'review'`, `editable:false`, `concerns`, `reason`, `targetUrl`），`return`（**不跑 adapter**）。
   - 否则（pass / null）→ 继续。
2. 原 `mutate(status=running)` checkpoint 时一并 `step.reviewed = true`（PASS 后标记；防 SW 重入/再 advance 重复复核）。
3. `await stepRunner` 跑 adapter（现状不变）。

> ⚠ reviewGate await 发生在 step 仍 `pending` 时（mutate-running 之前）。SW 在 reviewGate 期间回收 → 重 advance → reviewGate 幂等重跑（只读复核，无副作用）。HOLD 暂停后 SW 回收 → recover 对 paused 步 noop（recover 只动 running），人工恢复。

## 数据流

```
advance 到不可逆 AUTO 步(reversible===false, !reviewed)
  → engine reviewGate(wfId,step,wf) → bg REVIEW_REQUEST{product,context:{pageSnapshot}} → reviewer → REVIEW_VERDICT
  ├─ pass / 超时 / 离线(null) → mutate(running, reviewed=true) → 跑 adapter（现状）
  └─ hold → 暂停 review-HITL{concerns,reason} → overlay 显 concerns
       → 人工「确认提交」WF_REVIEW_APPROVE → step.reviewed=true + wf.running + advance → 跑 adapter
       → 人工「中止」WF_HITL_REJECT → wf.aborted
```

## 三安全不变量（贯穿，不破）

1. **人工是不可逆动作的最终授权**：HOLD → 人工 proceed/abort；大脑不自动 abort（不误拦合法动作）、也不无视 concern 自动 proceed。PASS 自动执行不弱于现状（现状本就零复核全自动）。
2. **fail-safe**：复核器在线却得不出结论（模型挂/解析不出/verdict 非法）→ hold，**绝不假 PASS 放行不可逆**。
3. **发版隔离**：只动 `brain/`（dev-only Python）+ `automation/`（dev-only 装配）；不碰 `core/` 和任何 feature。`reviewGate` 仅 automation 的 bg-entry 注入；release engine 无 reviewGate（默认 null=proceed）→ 自动续跑沉睡。

## 范围边界（YAGNI）

**做**：sanity/一致性/页面态复核 + PASS/HOLD 门 + fail-safe 降级 + `reviewed` 防重复复核 + review-HITL overlay。复核 `reversible===false` 的 4 个 AUTO 步（publish/gen_label/create_po/ship）。

**不做（后续刀）**：ground-truth 深度校验（查不了，归源头取值强校验）；可逆步（create_sku/pack_label）复核；可偏离编排；大脑自动修数据；复核历史持久化。

## 测试策略

- `brain/reviewer.py`：mock 模型 → pass/hold 解析；**fail-safe 红线**（模型抛 / 返回垃圾 / verdict 非 pass/hold → hold，绝不 pass）；concerns 透传。
- `brain/server.py`：REVIEW_REQUEST→REVIEW_VERDICT 真 socket 往返；reviewer 抛 → 兜底 hold（非 pass）。
- `automation/orchestrator/engine.js`：reviewGate hold → 暂停不跑 adapter（stepRunner 未被调）；pass → 跑 adapter + step.reviewed=true；`reversible:true` 步不复核（reviewGate 不被调）；无 reviewGate 注入 → 照常跑（向后兼容）；reviewed=true 步重 advance 不重复复核。
- `automation/overlay/overlay-view.js`：`isReviewHitl` 判定。
- bg reviewGate 离线/超时→null=proceed 的纯逻辑可抽测；端到端靠 chrome e2e。

## 待后续 / 未定

- reviewer 复核的 prompt 精度（首版通用 sanity；将来按 step 给精确 checklist）。
- 多次 HOLD 同一步（人工改数据后重核）：首版人工「确认提交」即 reviewed=true 放行，不再复核；将来可「改数据→重核」循环。
- 复核与「源头取值强校验」的协同（首版各自独立；将来复核可读 feature 的强校验结果）。
