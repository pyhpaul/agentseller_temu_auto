# 编排器真实 stepRunner 框架 + CPO 闭环（Plan 2-2b 第一刀）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 2-2a 的 stub stepRunner 升级为「真实 dispatch 框架 + `create_sku`/`create_po` 两个真实 adapter」，其余 4 个 AUTO 步暂留 stub fallback，验证「真实 feature 嵌在 13 步骨架里被编排器调用 + HITL 回填数据流到下游 AUTO 步」的端到端模式成立。

**Architecture:** 三层。① **product 数据契约扩展**：`steps.js` buildInitialWorkflow + `engine.js` pickProduct 加 `url1688/orderNo1688/poNo`，打通「HITL 回填 → workflow.product → 下游 AUTO 步输入」的数据流。② **stepRunner dispatch 框架**：service-worker.js orchestrator 段加 `ORCH_ADAPTERS` 表，按 `step.id` 分发——已接入→真 adapter，未接入→stub fallback。③ **CPO 两个 adapter**：直接 `await` 现有 `cpoRun`/`cpoRun2`（CPO 自管 tab，adapter 不导航）+ 读 `cpo_state` 桥接回 engine 的 `{status,result,error}`；`create_po` 用 committing 标记包裹不可逆点。

**Tech Stack:** Vanilla JS（UMD 双模式，沿用 orchestrator 模块），`node:test` 单测，Chrome MV3 classic service worker（`importScripts`），复用已落地的 `create_purchase_order` 的 `cpoRun`/`cpoRun2` 跨 tab 编排（不改 CPO 现有代码）。

---

## 范围说明

本 plan 是 **Plan 2-2b 的第一刀**（用户 2026-06-09 拍板「框架+CPO 闭环先行」），目的是用改造量最小、回报模式最复杂的 `create_purchase_order` 验证 stepRunner 框架成立，**不碰其余 4 个 feature 的 index.js**。源 spec：`docs/superpowers/specs/2026-06-09-automation-orchestrator-deterministic-skeleton-design.md`（§3 product 渐进填充 / §4.2 committing 恢复 / §7 feature 改造）。

- **覆盖**：product 数据契约扩展（url1688/orderNo1688/poNo）+ pickProduct 扩展 + stepRunner dispatch 框架（adapter 注册表 + stub fallback）+ `create_sku`/`create_po` 两个真实 adapter（桥接现有 CPO 编排）+ committing 包裹。
- **不在本 plan**（留后续 2-2b 续刀 / 2-2c）：`publish`/`gen_label`/`pack_label`/`ship` 4 个 AUTO 步的真实 adapter（各需改对应 feature 加命令入口 + 导航 + readySignal）；业务页浮层 HITL 回填 UI；WS 架子。
- **验证方式**：product 契约 + pickProduct = `node --test` 纯逻辑单测；CPO adapter 接线 = `node --check` 语法 + dev build；端到端 = chrome 手动**分级**验证（L1 框架 / L2 数据流 / L3 create_sku 真实 / L4 create_po 真实，见 Task 3——L3/L4 是真实写操作）。

## 关键决策（实现前先读，review 时把关）

| # | 决策 | 理由 |
|---|------|------|
| D1 | adapter 按 **`step.id`** 分发，非 `step.feature` | `create_purchase_order` 一个 feature 对应两个独立 step（create_sku / create_po），feature 粒度无法区分，必须 step.id 粒度。 |
| D2 | 未接入 AUTO 步 **fallback stub**（不报错） | 框架+CPO 阶段只有 create_sku/create_po 真实，publish/gen_label/pack_label/ship 暂留 stub→13 步骨架仍端到端可跑（验证「真实 feature 嵌在骨架里」），后续 plan 逐个把 stub 换真 adapter，不破坏已跑通的骨架。 |
| D3 | CPO adapter **不导航 / 不 waitForEl** | `cpoRun`/`cpoRun2` 内部 `chrome.tabs.create` 自管 tab（开 1688/Temu编辑/店小秘并自行等加载），adapter 只需 `await` 它 + 读 storage。与其余 4 个需「导航+sendMessage」的 feature 形态不同——**印证 adapter 异构**，框架不强求统一调用模板。 |
| D4 | CPO adapter 是**两套 storage 的桥** | `cpoRun` 写 `cpo_state`（CPO 私有 key），adapter 读 `cpo_state.phaseN` 把结果回报给 engine（engine 写 `as_workflow_state`）。两 key 并存、互不干扰，adapter 负责桥接。**`await cpoRun(...)` 后直接读 `cpo_state` 即拿终态**（cpoRun/cpoRun2 是 async、await 到 done/error 才返回、正常返回不 throw），无需轮询。 |
| D5 | `create_po` **autoSave=true 全自动 + committing 包裹** | 不可逆动作首版自动跑（确定性骨架定位）；committing 标记保证 SW 回收→恢复时转人工确认（`recovery.js`：committing 未清→ask-hitl），不重复创建采购单。执行前「人复核不可逆动作」（spec §5.1 分级 HITL）留大脑 sub-project（spec §9.4）。**⚠ chrome 验证 create_po 会真实创建采购单**（Task 3 L4 风险说明）。不用 cpoRun2 自带的 `autoSave=false` 确认框——那是 CPO 私有浮层，与编排器统一 HITL 机制冲突。 |
| D6 | HITL 回填首版靠 **console 手动传 result** | `orchHitlConfirm({workflowId, result})` 已支持 `result` 回填 + pickProduct（2-2a 已实现），只要 pickProduct 含目标字段，数据流即通。chrome 验证时人在 SW console 传 `result:{spuId,skc,url1688,orderNo1688}`。浮层回填 UI 留 2-2c。 |

## 文件结构

| 文件 | 职责 | 改动 |
|------|------|------|
| `core/background/orchestrator/steps.js` | buildInitialWorkflow 的 `product` 加 `url1688/orderNo1688/poNo` 三字段（初始 null） | 改 1 行 |
| `core/background/orchestrator/engine.js` | `pickProduct` 提取字段列表加 `url1688/orderNo1688/poNo` | 改 1 行 |
| `tests/orchestrator-steps.test.js` | buildInitialWorkflow 测试加 product 新字段 null 断言 | 改 |
| `tests/orchestrator-engine.test.js` | 加 pickProduct 新字段回填测试 | 改 |
| `core/background/service-worker.js` | orchestrator 段：committing helper + `orchAdapterCreateSku` + `orchAdapterCreatePo` + `ORCH_ADAPTERS` dispatch + `orchRealStepRunner`，makeEngine 的 stepRunner 从 stub 换 real | 改 |

> 不新建文件。CPO 现有代码（service-worker.js:314-625 `cpoRun`/`cpoRun2`、content/index.js CPO handlers）**零改动**——adapter 只调用、不修改（spec §7「只加入口、不改现有逻辑」）。

---

## Task 1：product 数据契约扩展 + pickProduct（纯逻辑 TDD）

**Files:**
- Modify: `core/background/orchestrator/steps.js`（buildInitialWorkflow product）
- Modify: `core/background/orchestrator/engine.js`（pickProduct 字段列表）
- Modify: `tests/orchestrator-steps.test.js`、`tests/orchestrator-engine.test.js`

打通数据流的契约层：HITL 回填（get_return_price→spuId/skc、order_1688→orderNo1688、比价→url1688）和 AUTO 产出（create_po→poNo）都要落到 `workflow.product`，供下游 create_sku/create_po 读取。先扩字段 + 测试锁定。

- [ ] **Step 1: 先写失败测试（steps product 新字段）**

在 `tests/orchestrator-steps.test.js` 的 `buildInitialWorkflow: 初始 workflow 结构正确` 测试里，`assert.strictEqual(wf.product.spuId, null);` 之后加三行：

```js
    assert.strictEqual(wf.product.url1688, null);                    // CPO create_sku 输入（比价/下单步回填）
    assert.strictEqual(wf.product.orderNo1688, null);                // CPO create_po 输入（下单步回填）
    assert.strictEqual(wf.product.poNo, null);                       // CPO create_po 产出
```

- [ ] **Step 2: 加 pickProduct 新字段回填测试**

在 `tests/orchestrator-engine.test.js` 的第一个 advance 测试（`advance：auto 步跑 stub → done + result + product 回填`）之后插入新 test：

```js
test('advance：result 含 url1688/orderNo1688/poNo → product 全回填（CPO 数据流）', async () => {
  const { engine, store } = setupEngine(
    mkSkeleton([mkStep({ id: 'a' })]),
    async () => ({ status: 'done', result: { skuNo: 'SKU1', poNo: 'PO9', url1688: 'https://detail.1688.com/offer/123.html', orderNo1688: 'ORD7' } })
  );
  await engine.advance('w1');
  assert.strictEqual(wf0(store).product.skuNo, 'SKU1');
  assert.strictEqual(wf0(store).product.poNo, 'PO9');
  assert.strictEqual(wf0(store).product.url1688, 'https://detail.1688.com/offer/123.html');
  assert.strictEqual(wf0(store).product.orderNo1688, 'ORD7');
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test tests/orchestrator-steps.test.js tests/orchestrator-engine.test.js`
Expected: FAIL — steps 测试 `wf.product.url1688` 为 `undefined` 不等于 `null`；engine 测试 `product.url1688`/`orderNo1688`/`poNo` 为 `undefined`（pickProduct 没提取）。

- [ ] **Step 4: 改 steps.js buildInitialWorkflow product**

`core/background/orchestrator/steps.js` 把：
```js
      product: { label: product.label || null, spuId: null, skc: null, skuNo: null },
```
改为：
```js
      product: { label: product.label || null, spuId: null, skc: null, skuNo: null, url1688: null, orderNo1688: null, poNo: null },
```

- [ ] **Step 5: 改 engine.js pickProduct 字段列表**

`core/background/orchestrator/engine.js` 把：
```js
    for (const k of ['spuId', 'skc', 'skuNo']) {
```
改为：
```js
    for (const k of ['spuId', 'skc', 'skuNo', 'url1688', 'orderNo1688', 'poNo']) {
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test tests/orchestrator-steps.test.js tests/orchestrator-engine.test.js`
Expected: PASS — steps（5 例）+ engine（11 例，原 10 + 新增 1）全绿。

- [ ] **Step 7: commit**

```bash
git add core/background/orchestrator/steps.js core/background/orchestrator/engine.js tests/orchestrator-steps.test.js tests/orchestrator-engine.test.js
git commit -m "feat(orchestrator): product 契约加 url1688/orderNo1688/poNo（CPO 数据流）

Why: create_sku 需 url1688、create_po 需 orderNo1688/产出 poNo,这些来自上游 HITL 回填,
     必须落 workflow.product 供下游 AUTO 步读取,打通「HITL 回填→product→AUTO 输入」数据流。
What: buildInitialWorkflow product 加 3 字段(初始 null); pickProduct 提取列表加同 3 字段。
Test: node --test steps(5)+engine(11,新增 pickProduct 全字段回填) 全绿。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Task 1 完成：product 契约可承载 CPO 闭环的全部输入/产出，pickProduct 自动回填，数据流契约锁定。

---

## Task 2：CPO adapter + stepRunner dispatch 框架

**Files:**
- Modify: `core/background/service-worker.js`（orchestrator 段，line 660-668 区域）

把 stub 升级为 dispatch 框架 + 两个真实 CPO adapter。接线层不写 node 单测（依赖 chrome.storage/cpoRun），靠 `node --check` 语法 + Task 3 chrome 端到端。

- [ ] **Step 1: 在 orchStubStepRunner 之后、makeEngine 之前插入 adapter + dispatch**

`core/background/service-worker.js` 当前（line 660-668）：
```js
async function orchStubStepRunner(step) {
  await new Promise(r => setTimeout(r, 300));   // 模拟耗时
  console.log(`[orch-stub] 自动步「${step.label}」(feature=${step.feature}) 模拟完成`);
  return { status: 'done', result: { stub: step.id, feature: step.feature }, error: null };
}

const orchEngine = ORCH.engine.makeEngine({
  read: orchRead, queue: orchQueue, stepRunner: orchStubStepRunner, now: () => Date.now(),
});
```

在 `orchStubStepRunner` 函数结束（`}`）之后、`const orchEngine` 之前，插入：

```js

// ── CPO adapter（create_sku / create_po）─────────────────────────────────────
// CPO 自管 tab（cpoRun/cpoRun2 内部 chrome.tabs.create）：adapter 不导航/不 waitForEl，
// 直接 await（两者 async、await 到终态才返回、done/error 都写 cpo_state.phaseN 正常返回不 throw），
// 再读 cpo_state 桥接回 engine 的 {status,result,error}。cpo_state(CPO 私有)与 as_workflow_state(编排器)并存。

// 标记/清除当前 cursor step 的 committing（不可逆提交点保护，spec §4.2/§7；走 orchQueue 串行化）
function orchMarkCommitting(workflowId, value) {
  return orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf) return undefined;
    wf.steps[wf.cursor].committing = value;
    return skeleton;
  });
}

// create_sku（Phase1，△半可逆）：product → CPO_START 入参（cpoRun 内部校验 serial/skuNo/spuId）→ 读 phase1
async function orchAdapterCreateSku(step, wf) {
  const { url1688, skc, skuNo, spuId } = (wf && wf.product) || {};
  if (!url1688) return { status: 'error', error: { category: 'validate', code: 'MISSING_URL1688', message: '缺 1688 链接（比价/下单步未回填 url1688）', recoverable: false } };
  await cpoRun({ url1688, skc, skuNo, spuId });
  const { cpo_state } = await chrome.storage.local.get('cpo_state');
  const p1 = (cpo_state && cpo_state.phase1) || {};
  if (p1.status === 'done') return { status: 'done', result: { skuNo: (p1.collected && p1.collected.skuNo) || skuNo || null }, error: null };
  return { status: 'error', error: { category: 'business', code: 'CPO_P1_FAILED', message: p1.label || '建店小秘 SKU 失败', recoverable: false } };
}

// create_po（Phase2，✗强不可逆）：committing 包裹 → product.orderNo1688 → CPO_START_PHASE2(autoSave 全自动) → 读 phase2
async function orchAdapterCreatePo(step, wf) {
  const orderNo1688 = (wf && wf.product && wf.product.orderNo1688) || '';
  if (!orderNo1688) return { status: 'error', error: { category: 'validate', code: 'MISSING_ORDER_NO', message: '缺 1688 订单号（下单步未回填 orderNo1688）', recoverable: false } };
  await orchMarkCommitting(wf.id, true);   // 不可逆提交点前标记；正常路径 engine 收尾清 committing，回收路径留 true→恢复转人工
  await cpoRun2({ orderNo1688, autoSave: true, repurchase: false, warehouse: 'default' }, null);
  const { cpo_state } = await chrome.storage.local.get('cpo_state');
  const p2 = (cpo_state && cpo_state.phase2) || {};
  if (p2.status === 'done') return { status: 'done', result: { poNo: (p2.collected2 && p2.collected2.poNo) || null }, error: null };
  return { status: 'error', error: { category: 'business', code: 'CPO_P2_FAILED', message: p2.label || '创建采购单失败', recoverable: false } };
}

// adapter 注册表：按 step.id 分发（cpo 一 feature 两步，必须 id 粒度）。未接入 AUTO 步 → stub fallback。
const ORCH_ADAPTERS = {
  create_sku: orchAdapterCreateSku,
  create_po: orchAdapterCreatePo,
  // publish / gen_label / pack_label / ship 暂留 stub，后续 plan 逐个换真 adapter
};

// 真实 stepRunner：dispatch 到 adapter；未接入 step.id 回落 stub（13 步骨架仍端到端可跑）
async function orchRealStepRunner(step, wf) {
  const adapter = ORCH_ADAPTERS[step.id];
  return adapter ? adapter(step, wf) : orchStubStepRunner(step);
}
```

- [ ] **Step 2: makeEngine 的 stepRunner 从 stub 换 real**

紧接上面，把：
```js
const orchEngine = ORCH.engine.makeEngine({
  read: orchRead, queue: orchQueue, stepRunner: orchStubStepRunner, now: () => Date.now(),
});
```
改为：
```js
const orchEngine = ORCH.engine.makeEngine({
  read: orchRead, queue: orchQueue, stepRunner: orchRealStepRunner, now: () => Date.now(),
});
```

> `orchStubStepRunner` 保留（被 `orchRealStepRunner` fallback 调用），不删。

- [ ] **Step 3: node --check 验证语法**

Run: `node --check core/background/service-worker.js`
Expected: 无输出（语法有效；cpoRun/cpoRun2/chrome 是运行时全局）。

- [ ] **Step 4: dev build 确认入 dist**

Run: `python3 build/build_extension.py`
Expected: exit 0；orchestrator 模块 + contract 入 dist（无报错）。

- [ ] **Step 5: commit**

```bash
git add core/background/service-worker.js
git commit -m "feat(orchestrator): 真实 stepRunner 框架 + CPO 两 adapter（create_sku/create_po）

Why: 2-2b 第一刀——把 stub 换真实 dispatch,接通改造量最小/回报最复杂的 CPO,验证骨架成立。
What: ORCH_ADAPTERS 按 step.id 分发(未接入 fallback stub); orchAdapterCreateSku/CreatePo 桥接现有
     cpoRun/cpoRun2(自管 tab,await 后读 cpo_state→engine 回报); create_po committing 包裹不可逆点;
     makeEngine stepRunner 换 orchRealStepRunner。CPO 现有代码零改动。
Test: node --check 语法 + dev build; chrome 端到端见 Task 3(L3/L4 真实写操作)。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Task 2 完成：dispatch 框架就位，create_sku/create_po 真实接通（committing 保护），其余 AUTO 步 stub fallback；待 Task 3 验证。

---

## Task 3：全量回归 + chrome 端到端分级验证

**Files:** 无新建（验证）

> ⚠ **关键安全边界**：CPO adapter 真跑 = **真实写操作**。L1/L2 安全（stub + console，不碰真实系统，任何时候可验）；**L3 create_sku 半可逆**（真实建店小秘 SKU，可手动删，中风险，用测试商品）；**L4 create_po 强不可逆**（真实创建采购单+通过审核，后端正式生效，高风险）。**L4 必须用户明确授权 + 用可作废的测试订单号**，对齐 always-on rules「不可逆操作先确认」。implementer 不得自行跑 L3/L4，交控制者协调用户在合适时机执行。

- [ ] **Step 1: 全量 JS 单测**

Run: `node --test tests/*.test.js`
Expected: PASS — 现有 56 例 + Task 1 新增 1 例（pickProduct 全字段）= **57 例，0 失败**。
> ⚠ 必须 `tests/*.test.js`，不要 `node --test tests/`（整目录会把 pytest 的 `.py` 当 JS 解析失败，见根 CLAUDE.md）。

- [ ] **Step 2: 全量 Python 单测**

Run: `python3 -m pytest tests/ -q`
Expected: PASS — 20 例（本 plan 不动 build/strip，无新增）。

- [ ] **Step 3: dev build + 工作树干净**

Run: `python3 build/build_extension.py && git status --short`
Expected: build exit 0；git status 空（Task 1-2 各自 commit）。

- [ ] **Step 4: chrome 验证 L1——框架（未接入步 stub fallback，安全）**

1. `chrome://extensions` → reload 扩展（dist/extension/ 已 build）。
2. 扩展卡片「service worker」→「检查」开 SW console。
3. `orchStartWorkflow({ label: 'CPO测试商品' })` → 记下返回的 workflowId。
   - **预期**：停在 step0 `select_product`（HITL）paused。
4. 连续 `orchHitlConfirm({ workflowId: '<id>' })` 穿过 select_product(0) / collect_dxm(1)。
   - **预期**：到 step2 `publish`（AUTO），SW console 打印 `[orch-stub] 自动步「合规预检+发布」(feature=check_and_publish) 模拟完成`（**未接入步走 stub fallback**），再停在 step3 `get_return_price` paused。
   - ✅ 验证点：D2「未接入 AUTO 步 fallback stub」成立——publish 没有真跑 check_and_publish。

- [ ] **Step 5: chrome 验证 L2——数据流（HITL console 回填 → product 渐进填充，安全）**

承接 L1，在各 HITL 步用 `result` 回填，每步后查 product：

```js
// step3 get_return_price：回填 spuId/skc（发布后人工去 Temu 商家看到的）
orchHitlConfirm({ workflowId: '<id>', result: { spuId: 'SPU_TEST', skc: 'SKC_TEST' } })
// step4 compare_1688：回填 url1688（1688 比价确定的采购源链接）
orchHitlConfirm({ workflowId: '<id>', result: { url1688: 'https://detail.1688.com/offer/123.html' } })
// 查 product 渐进填充
chrome.storage.local.get('as_workflow_state').then(r => {
  const wf = r.as_workflow_state.batch.workflows.find(w => w.id === '<id>');
  console.log('product:', JSON.stringify(wf.product));
})
```

- **预期**：`product` 含 `spuId:'SPU_TEST'`、`skc:'SKC_TEST'`、`url1688:'https://...'`，证明 HITL 回填经 pickProduct 落到 product。
- ✅ 验证点：Task 1 数据流契约成立。
- **此后停在 step5 `order_1688` paused**。**到此 L1+L2 已验证框架+数据流，不碰真实系统**。要继续验真实 CPO 见 L3/L4（需真实环境 + 授权）。

- [ ] **Step 5.5: 取消验证（安全退出，不进 L3/L4 时用）**

若不立即验真实 CPO，`orchSetAborted` 或直接清理：
```js
chrome.storage.local.remove('as_workflow_state')   // 清编排器状态
chrome.storage.local.remove('cpo_state')           // 清 CPO 状态（若 L3/L4 跑过）
```

- [ ] **Step 6: chrome 验证 L3——create_sku 真实（半可逆，中风险，需测试商品 + 真实登录）**

> 前提：已登录 Temu agentseller + 店小秘；备一个**测试用** 1688 链接 + 对应 Temu spuId + SKU货号（建出的 SKU 可在店小秘手动删）。

承接 L2 停在 step5 `order_1688`。因 `gen_label`(step6) 暂 stub 不产 skuNo，**验证时借 order_1688 回填一次性补齐 skuNo**：

```js
// step5 order_1688：回填 orderNo1688 + 借道补 skuNo（gen_label 接真 adapter 前的临时手段）
orchHitlConfirm({ workflowId: '<id>', result: { orderNo1688: '<可作废测试订单号>', skuNo: '<测试SKU货号>' } })
```

- **预期**：
  - step6 `gen_label`（AUTO）走 stub fallback（打印 `[orch-stub] …(feature=auto_gen_label)…`），不覆盖 skuNo。
  - step7 `create_sku`（AUTO）**真跑** `cpoRun`：SW console 看到 1688 tab 开关、Temu 编辑页开关、店小秘 add 页填表保存（cpoRun 跨 tab 编排）。
  - 完成后 dashboard/storage：`steps[create_sku].status='done'`、`steps[create_sku].result.skuNo` 有值。
  - ⚠ **create_sku→create_po 连续自动真跑、无中间停顿**：回填 order_1688 后编排器一路 gen_label(stub)→create_sku(真)→**create_po(真)**→才停在 step9 `wait_payment`(HITL)。两个 AUTO 步之间无 HITL 暂停，**人无法在 create_sku 与 create_po 之间打断**——故「回填 order_1688」这一动作即等于**同时授权 L3+L4 真跑**。只想验框架/数据流、不碰真实 CPO 的，**止步 L2、走 Step 5.5 清理，不要回填 order_1688**。
- ✅ 验证点：真实 feature（CPO Phase1）嵌在骨架里被编排器调用成功，结果回报 product。

- [ ] **Step 7: chrome 验证 L4——create_po 真实（强不可逆，高风险，⚠ 真实创建采购单）**

> 🔴 **L4 会在店小秘真实创建采购单并通过审核，后端正式生效、不可回滚。必须：① 用户明确授权；② orderNo1688 是可作废/测试订单；③ 验证后人工去店小秘核对并作废该测试采购单。**

承接 L3，create_sku done 后编排器自动推进到 step8 `create_po`（AUTO）：
- **预期**：
  - adapter 先写 `steps[create_po].committing=true`（不可逆点保护）。
  - 真跑 `cpoRun2`（autoSave=true 全自动）：SW console 看到采购单 add→edit 页跨 tab 编排、保存通过审核。
  - 完成后 `steps[create_po].result.poNo` 有值（采购单号 `PO...`），`committing` 被 engine 收尾清回 false，编排器推进到 step9 `wait_payment`（HITL）paused。
  - 查 `product.poNo` 已回填。
- ✅ 验证点：强不可逆 AUTO 步真跑成功 + committing 包裹生效 + 全链路 product 数据流贯通。
- **验证后清理**：人工去店小秘作废该测试采购单；`chrome.storage.local.remove(['as_workflow_state','cpo_state'])`。

- [ ] **Step 8: 恢复语义验证（committing 保护，可选）**

在 L4 的 `create_po` 真跑窗口内（cpoRun2 执行中）点扩展卡片「停止」service worker 模拟回收 → 唤醒 SW → 查 `steps[create_po].committing` 若仍 `true`，恢复应转 ask-hitl（`hitl.fieldType='recovery'`），**不重复创建采购单**。
> 时间窗口难精确命中，此步为加分项；committing→ask-hitl 的纯逻辑已由 `recovery.js` + engine recover 单测覆盖。

## 完成定义（DoD）

- product 契约扩展 `url1688/orderNo1688/poNo`，pickProduct 回填，steps（5）+ engine（11）单测覆盖。
- stepRunner dispatch 框架（ORCH_ADAPTERS 按 step.id + stub fallback）+ create_sku/create_po 两 adapter（桥接现有 cpoRun/cpoRun2，CPO 代码零改动）+ create_po committing 包裹，`node --check` + dev build 通过。
- 全量 JS 57 例 + Python 20 例 0 失败，工作树干净。
- chrome **L1（框架 stub fallback）+ L2（数据流回填）验证通过**（安全，必做）。
- chrome **L3（create_sku 真实）/ L4（create_po 真实）= 真实写操作**：需用户授权 + 测试数据，控制者协调执行；L4 验证后作废测试采购单。

## 与后续刀的衔接

- **2-2b 续刀（逐个换真 adapter）**：把 `publish`/`gen_label`/`pack_label`/`ship` 的 stub fallback 逐个换成真实 adapter。与 CPO 不同，这 4 个 feature **当前都无命令处理器、需导航 + waitForEl**（probe 调研已摸清各自：触发入口/输入来源/不可逆点/readySignal/目标 URL）。每个 feature：① index.js 加 `chrome.runtime.onMessage` 命令入口（不改现有 DOM 逻辑）；② adapter 做「导航 tab→waitForEl(readySignal)→sendCommand→收回报」；③ 补 `steps.js` 该 step 的 `target.urlTemplate/readySignal`。**gen_label 接真 adapter 后自动产 skuNo**（消除 L3 借 order_1688 补 skuNo 的临时手段）。
- **已知缺口（诚实标注，非本 plan 修）**：① `create_sku` reversible=true 的重跑幂等性依赖 CPO feature 层，当前 CPO 无幂等校验，SW 回收→恢复重跑可能重复建 SKU（spec §3.2 注「由 feature 层做幂等校验」是预期、未落地）——后续 CPO 改造补；② create_po 执行前「人复核不可逆动作」（spec §5.1 分级 HITL）首版无（autoSave 全自动 + committing 兜回收），留大脑 sub-project 或 2-2c 浮层 pre-confirm。
- **2-2c（浮层 + WS）**：业务页浮层做 HITL 回填 UI（替代 L2 的 console 手动 result）+ 「前往」按钮 + isDev 守卫「开始」按钮；bg/dashboard WS client 架子 + 连接灯。
- **PR 时机**：2-2a + 2-2b（含本刀 + 续刀）+ 2-2c 一起 PR（单独都是半成品空壳）。

## Self-Review（writing-plans 自检，已跑）

- **spec 覆盖**：§3 product 渐进填充 → Task 1；§4.2 committing 恢复 → Task 2 orchMarkCommitting + recovery.js 既有；§7 feature 改造（CPO「小」改造量、只加入口不改逻辑）→ Task 2 adapter 桥接零改 CPO。其余 5 AUTO 步改造 = 衔接段（不在本刀）。
- **placeholder 扫描**：无 TBD/TODO；每个代码 step 有完整代码 + 确切命令 + 预期输出。
- **类型一致**：`orchAdapterCreateSku`/`orchAdapterCreatePo`/`orchMarkCommitting`/`ORCH_ADAPTERS`/`orchRealStepRunner` 命名跨 Task 2 一致；adapter 回报 `{status,result,error}` 与 engine.js advance 消费格式（`res.status==='done'`/`res.error`）对齐；product 字段 `url1688/orderNo1688/poNo` 在 steps/engine/adapter 三处一致。
- **风险**：L4 真实不可逆写操作已显式标注 + 授权门 + 清理步骤。
