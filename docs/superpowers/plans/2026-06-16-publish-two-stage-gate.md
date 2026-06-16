# publish 步两段化 + 自动发布开关 + 跳过本步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 e2e 编排器 publish 步从"检查+发布一把梭"改成 dashboard 上"先检查→看结果→再发布"的两段确认，加自动发布开关（默认关）+ 跳过本步。

**Architecture:** publish 步不拆 step，在 hitl 上加 `kind:'publish'` + `phase` 三态状态机（await-check/blocked/await-publish）；CAP 拆 `CAP_CHECK`+`CAP_PUBLISH_EXEC`；engine publish 步入口停在 await-check（替代旧 manualGate）；bg 三函数（orchPublishCheck/Exec/Skip）+ 三 WF_ 消息驱动 phase 转移；dashboard 三态卡。

**Tech Stack:** Vanilla JS（UMD 双模式纯逻辑 + chrome MV3 SW/content/dashboard），`node --test` 单测，`python build/build_extension.py` 构建。

**Spec:** `docs/superpowers/specs/2026-06-16-publish-two-stage-gate-and-auto-publish-toggle-design.md`

**全程约束：** 改 JS 后跑 `node --test tests/*.test.js`（**不要** `node --test tests/`，会把 .py 当 JS）。每 Task 末提交。分支 `feature/publish-two-stage-gate`（已存在，spec 已提交其上）。

---

## File Structure

| 文件 | 改动 | Task |
|------|------|------|
| `automation/orchestrator/steps.js` | publish def `manualGate→gate:'publish'`；buildInitialWorkflow map 透传 `gate` | 1 |
| `automation/orchestrator/engine.js` | 加 `buildPublishHitl`；run-auto 闸 `manualGate→gate==='publish'` 分支；导出 | 2 |
| `automation/dashboard/hitl-action.js` | buildHitlMessage 加 `publish-check`/`publish-exec`/`skip` | 3 |
| `features/check_and_publish/content/index.js` | `CAP_PUBLISH` 拆 `CAP_CHECK`+`CAP_PUBLISH_EXEC` | 4 |
| `automation/bg-entry.js` | 抽 `findDxmEditTab`；删 orchAdapterPublish+ORCH_ADAPTERS.publish；加 orchPublishCheck/Exec/Skip+持久化；三 WF_ handler | 5 |
| `automation/dashboard/components/hitl-queue.js` + `dashboard.js` | publish-kind 三态卡 + checkbox 全局初态 | 6 |
| `tests/orchestrator-steps.test.js` / `orchestrator-engine.test.js` / `hitl-action.test.js` | 新断言 | 1/2/3 |
| build + 全量测试 + 端到端 checklist | — | 7 |

---

## Task 1: steps.js — publish gate 字段透传（防死代码回归）

**Files:**
- Modify: `automation/orchestrator/steps.js`（publish def 约 :34；buildInitialWorkflow map 约 :85）
- Test: `tests/orchestrator-steps.test.js`

> 教训 [[feedback_stepdefs_field_passthrough]]：STEP_DEFS 加字段必须同步 buildInitialWorkflow map 透传，否则 engine 读 `step.gate` 永 undefined 成死代码，且 mkStep 直构造的单测照样绿 → 必须加"经工厂"的回归测试。

- [ ] **Step 1: 写失败测试**（追加到 `tests/orchestrator-steps.test.js`）

```js
test('buildInitialWorkflow 透传 publish 步的 gate 字段（防死代码）', () => {
  const { buildInitialWorkflow } = require('../automation/orchestrator/steps.js');
  let n = 0;
  const wf = buildInitialWorkflow({}, () => 'w' + (++n));
  const publish = wf.steps.find(s => s.id === 'publish');
  assert.ok(publish, 'publish 步应存在');
  assert.strictEqual(publish.gate, 'publish', 'publish 步实例必须带 gate:"publish"（经工厂透传，非仅 STEP_DEFS）');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/orchestrator-steps.test.js`
Expected: FAIL（`gate` 为 undefined，因 STEP_DEFS 仍是 manualGate、map 未透传 gate）

- [ ] **Step 3: 改 publish def + map 透传**

`steps.js` publish 步 def（把 `manualGate: true` 换成 `gate: 'publish'`）：

```js
    { id: 'publish',          label: '合规预检+发布',         type: 'auto', feature: 'check_and_publish',     reversible: false, gate: 'publish', domain: 'dianxiaomi.com' },
```

`steps.js` buildInitialWorkflow 的 step map（把 `manualGate: d.manualGate || false` 换成 `gate: d.gate || null`）：

```js
        gate: d.gate || null, analysis: d.analysis || null,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/orchestrator-steps.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add automation/orchestrator/steps.js tests/orchestrator-steps.test.js
git commit -m "feat(automation): publish 步 manualGate→gate:'publish' + 工厂透传

Why: 两段化需 engine 据 step.gate 路由 publish 闸；manualGate 是旧硬闸单一字段。
What: STEP_DEFS publish 改 gate:'publish'；buildInitialWorkflow map 透传 gate（防死代码）。
Test: node --test tests/orchestrator-steps.test.js 通过

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: engine.js — buildPublishHitl + run-auto gate 分支

**Files:**
- Modify: `automation/orchestrator/engine.js`（buildReviewHitl 后约 :69 加函数；run-auto 闸约 :129-137；api 导出约 :268）
- Test: `tests/orchestrator-engine.test.js`

- [ ] **Step 1: 写失败测试**（追加到 `tests/orchestrator-engine.test.js`）

```js
test('publish 步(gate:publish)进入即停在 await-check 两段闸', async () => {
  const store = fakeStore(mkSkeleton([
    mkStep({ id: 'publish', type: 'auto', reversible: false, gate: 'publish' }),
  ]));
  const queue = makeMutationQueue(store.read, store.write);
  const engine = makeEngine({ read: store.read, queue, stepRunner: async () => ({ status: 'done', result: {} }), now: () => 1 });
  await engine.advance('w1');
  const wf = store.peek().batch.workflows[0];
  assert.strictEqual(wf.status, 'paused');
  assert.strictEqual(wf.steps[0].status, 'paused');
  assert.ok(wf.hitl, 'hitl 应被构造');
  assert.strictEqual(wf.hitl.kind, 'publish');
  assert.strictEqual(wf.hitl.phase, 'await-check');
});

test('buildPublishHitl 形态', () => {
  const h = buildPublishHitl({ id: 'publish', label: '合规预检+发布' }, { phase: 'await-publish', checkResult: { passCount: 3 } });
  assert.strictEqual(h.kind, 'publish');
  assert.strictEqual(h.phase, 'await-publish');
  assert.strictEqual(h.checkResult.passCount, 3);
  assert.strictEqual(h.editable, false);
  assert.strictEqual(h.stepId, 'publish');
});
```

注：`buildPublishHitl` 需加入测试文件顶部的 require 解构：
```js
const { makeEngine, buildHitl, buildReviewHitl, buildPublishHitl, pickProduct, computeMargin } = require('../automation/orchestrator/engine.js');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/orchestrator-engine.test.js`
Expected: FAIL（`buildPublishHitl` 未定义 / publish 步当前走 stepRunner done 不会停）

- [ ] **Step 3: 加 buildPublishHitl（在 `buildReviewHitl` 函数后，约 :69）**

```js
  // publish 两段闸 HITL（kind:'publish'）：phase await-check → blocked / await-publish。
  // 进入 publish 步即停在 await-check（替代旧 manualGate）；bg 据 CAP_CHECK 结果转 phase。
  // 不携带 autoPublish：engine 纯函数不读 storage，开关初态由 dashboard 直接读 storage key。
  function buildPublishHitl(step, opts) {
    opts = opts || {};
    return {
      action: step.label, stepId: step.id, kind: 'publish',
      phase: opts.phase || 'await-check',
      checkResult: opts.checkResult || null,
      publishError: opts.publishError || null,
      editable: false, fields: [],
      targetUrl: (step.target && step.target.url) || null,
      status: 'pending',
    };
  }
```

- [ ] **Step 4: 改 run-auto 闸分支（约 :129-137，把 `if (step.manualGate)` 整块换成 publish gate）**

```js
            if (step.reversible === false && !step.reviewed) {
              if (step.gate === 'publish') {
                await mutateWorkflow(workflowId, w => {
                  w.steps[w.cursor].status = 'paused'; w.status = 'paused';
                  w.hitl = buildPublishHitl(w.steps[w.cursor], { phase: 'await-check' });
                  w.updatedAt = now();
                });
                return;                                              // publish 两段闸：停 await-check，等 WF_PUBLISH_CHECK
              }
              if (reviewGate) {
```

（其下 `reviewGate` 块、以及该 if 的闭合不变。）

- [ ] **Step 5: 导出 buildPublishHitl（文件末 api 对象，约 :268）**

```js
  return { makeEngine, findWorkflow, pickProduct, buildHitl, buildReviewHitl, buildPublishHitl, computeMargin };
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test tests/orchestrator-engine.test.js`
Expected: PASS（新 2 测试 + 原有全过）

- [ ] **Step 7: 提交**

```bash
git add automation/orchestrator/engine.js tests/orchestrator-engine.test.js
git commit -m "feat(automation): engine publish 步两段闸——buildPublishHitl + await-check 停顿

Why: publish 需停在 dashboard 两段确认（检查→发布），替代旧 manualGate 一停即连发。
What: 加 buildPublishHitl(kind:publish,phase)；run-auto 不可逆闸 manualGate→gate==='publish' 分支停 await-check；导出。
Test: node --test tests/orchestrator-engine.test.js 通过

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: hitl-action.js — publish-check / publish-exec / skip 动作映射

**Files:**
- Modify: `automation/dashboard/hitl-action.js`（buildHitlMessage switch + 顶部 act 注释）
- Test: `tests/hitl-action.test.js`

- [ ] **Step 1: 写失败测试**（追加到 `tests/hitl-action.test.js`）

```js
test('publish-check → WF_PUBLISH_CHECK 带 autoPublish（来自 opts）', () => {
  const m = buildHitlMessage('publish-check', wfConfirm, () => '', view, { autoPublish: true });
  assert.deepStrictEqual(m, { type: 'WF_PUBLISH_CHECK', data: { workflowId: 'w1', autoPublish: true } });
});

test('publish-check 缺 opts → autoPublish 默认 false', () => {
  const m = buildHitlMessage('publish-check', wfConfirm, () => '', view);
  assert.deepStrictEqual(m, { type: 'WF_PUBLISH_CHECK', data: { workflowId: 'w1', autoPublish: false } });
});

test('publish-exec / skip → 对应 WF_*，data 只含 workflowId', () => {
  assert.deepStrictEqual(buildHitlMessage('publish-exec', wfConfirm, () => '', view), { type: 'WF_PUBLISH_EXEC', data: { workflowId: 'w1' } });
  assert.deepStrictEqual(buildHitlMessage('skip', wfConfirm, () => '', view), { type: 'WF_SKIP', data: { workflowId: 'w1' } });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/hitl-action.test.js`
Expected: FAIL（三 act 落到 default → `{error:[{msg:'未知动作 ...'}]}`）

- [ ] **Step 3: 加 switch 分支（`buildHitlMessage` 内，`restart` case 后、`default` 前）**

```js
      case 'publish-check': return { type: 'WF_PUBLISH_CHECK', data: { workflowId, autoPublish: !!opts.autoPublish } };
      case 'publish-exec':  return { type: 'WF_PUBLISH_EXEC',  data: { workflowId } };
      case 'skip':          return { type: 'WF_SKIP',          data: { workflowId } };
```

并把顶部 act 注释行补上新动作：

```js
  // act: confirm / submit / approve / reject / retry / refresh / abort / delete / restart / publish-check / publish-exec / skip
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/hitl-action.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add automation/dashboard/hitl-action.js tests/hitl-action.test.js
git commit -m "feat(automation): hitl-action 加 publish-check/publish-exec/skip 动作映射

Why: dashboard publish 两段卡 + 跳过按钮需映射到新 WF_ 消息。
What: buildHitlMessage 加三 act→WF_PUBLISH_CHECK(带 autoPublish)/WF_PUBLISH_EXEC/WF_SKIP。
Test: node --test tests/hitl-action.test.js 通过

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: check_and_publish — CAP_PUBLISH 拆 CAP_CHECK + CAP_PUBLISH_EXEC

**Files:**
- Modify: `features/check_and_publish/content/index.js`（编排器桥接段，约 :688-721）

> content-world DOM 耦合，无 node 单测 → 本 Task 不写测试，靠 Task 7 端到端手动验证。手动 Hub 路径（`onCheck`/`onPublish`）不动。

- [ ] **Step 1: 替换 capHandlePublish + onMessage 监听（约 :688-721 整段）**

```js
  // ═══════════════════════════════════════════════════════════════════════════
  // 编排器桥接（orch）：CAP_CHECK（只检查回结构化结果）+ CAP_PUBLISH_EXEC（只发布）。
  // 两段化：检查与发布拆开，dashboard 上人工看检查结果再决定发布（spec 2026-06-16）。
  // 复用 runChecks/bucketize/clickPublishImmediate；手动 Hub 路径(onCheck/onPublish)不受影响。
  // ═══════════════════════════════════════════════════════════════════════════
  async function capHandleCheck() {
    if (!isEditPage()) {
      return { status: 'error', error: { category: 'read', code: 'CAP_NOT_EDIT_PAGE', message: '当前 tab 非店小秘编辑页（URL 不含 edit）', recoverable: true } };
    }
    let buckets;
    try {
      const { results } = runChecks();
      buckets = bucketize(results);
    } catch (e) {
      return { status: 'error', error: { category: 'read', code: 'CAP_CHECK_THREW', message: '合规检查异常：' + ((e && e.message) || e), recoverable: true } };
    }
    // block 是正常检查产出（非 error）→ 回结构化结果，由 bg 判 phase（blocked / await-publish）。
    return {
      status: 'done',
      result: {
        passCount: buckets.passes.length,
        blocks: buckets.blocks.map(b => ({ id: b.rule.id, name: b.rule.name, reason: b.reason || '' })),
        warns: buckets.warns.map(w => ({ id: w.rule.id, name: w.rule.name, reason: w.reason || '' })),
        skippeds: buckets.skippeds.length,
      },
      error: null,
    };
  }

  async function capHandlePublishExec() {
    if (!isEditPage()) {
      return { status: 'error', error: { category: 'read', code: 'CAP_NOT_EDIT_PAGE', message: '当前 tab 非店小秘编辑页（URL 不含 edit）', recoverable: true } };
    }
    try {
      await clickPublishImmediate();
    } catch (e) {
      return { status: 'error', error: { category: 'read', code: 'CAP_PUBLISH_FAILED', message: '立即发布失败：' + ((e && e.message) || e), recoverable: false } };
    }
    return { status: 'done', result: { published: true }, error: null };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    let handler = null;
    if (msg.type === 'CAP_CHECK') handler = capHandleCheck;
    else if (msg.type === 'CAP_PUBLISH_EXEC') handler = capHandlePublishExec;
    else return;
    handler()
      .then(sendResponse)
      .catch((e) => sendResponse({ status: 'error', error: { category: 'read', code: 'CAP_HANDLER_THREW', message: String((e && e.message) || e), recoverable: false } }));
    return true;  // 异步 sendResponse
  });
```

- [ ] **Step 2: 同步更新本文件顶部注释（约 :2-3）**——把"合规检查 + 模拟发布…用户点「检查并发布」→…→ 点「发布」"保留（手动路径不变），但编排器段说明已在代码注释更新，无需额外改。检查文件内不再有 `CAP_PUBLISH`（一把梭）残留：

Run: `grep -n "CAP_PUBLISH\b\|capHandlePublish\b" features/check_and_publish/content/index.js`
Expected: 无输出（旧一把梭 handler 已删；只剩 CAP_CHECK / CAP_PUBLISH_EXEC / capHandleCheck / capHandlePublishExec）

- [ ] **Step 3: 提交**

```bash
git add features/check_and_publish/content/index.js
git commit -m "feat(check_and_publish): CAP_PUBLISH 拆 CAP_CHECK + CAP_PUBLISH_EXEC

Why: 编排器两段化需检查与发布分开，dashboard 看检查结果后再发布。
What: 删一把梭 CAP_PUBLISH；加 capHandleCheck(回 blocks/warns/passCount 结构化结果)+capHandlePublishExec(只点立即发布)。手动 Hub 路径不动。
Test: not run (content-world DOM 耦合，Task 7 端到端验)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: bg-entry.js — findDxmEditTab + orchPublishCheck/Exec/Skip + 持久化 + WF_ handlers

**Files:**
- Modify: `automation/bg-entry.js`（orchAdapterPublish 段约 :365-401；ORCH_ADAPTERS 约 :404-411；orch* 函数群约 :455-525；WF_ handler 约 :558-611）

> chrome SW 耦合，无 node 单测 → 靠 Task 7 端到端验证 + 既有测试不回归。

- [ ] **Step 1: 删 orchAdapterPublish，加 findDxmEditTab（替换约 :365-401 整段）**

```js
// ── 店小秘编辑页 tab 查找（publish 两段闸 CAP_CHECK/CAP_PUBLISH_EXEC 共用）──────────────
// publish 实操页是【店小秘 dianxiaomi.com 编辑页】（选择器/发布 UX 全按店小秘 DOM 建，samples 为证）。
// 数据流死结:wf.product 无店小秘商品 URL 锚点 → 不导航,query 找 collect_dxm 留的编辑页 tab（含 edit）。
async function findDxmEditTab() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: '*://*.dianxiaomi.com/*' });
  } catch (e) {
    return { error: { category: 'read', code: 'PUBLISH_TAB_QUERY_FAILED', message: 'tab 查询失败:' + String(e?.message || e), recoverable: true } };
  }
  const editTab = (tabs || []).find(t => /edit/i.test(t.url || ''));
  if (!editTab) {
    return { error: { category: 'read', code: 'PUBLISH_NO_EDIT_TAB', message: '未找到店小秘编辑页 tab(collect_dxm 后请保持店小秘编辑页打开)', recoverable: true } };
  }
  // 激活编辑页 tab（前台防 Ant dropdown 后台 tab 不展开）
  try {
    await chrome.tabs.update(editTab.id, { active: true });
    await new Promise(res => setTimeout(res, 500));
  } catch (e) {
    console.warn('[orch][publish] 激活编辑页 tab 失败,继续尝试', e);
  }
  return { tab: editTab };
}
```

- [ ] **Step 2: 从 ORCH_ADAPTERS 删 publish（约 :404-411）**

```js
const ORCH_ADAPTERS = {
  create_sku: orchAdapterCreateSku,
  create_po: orchAdapterCreatePo,
  pack_label: orchAdapterPackLabel,
  ship: orchAdapterShip,
  gen_label: orchAdapterGenLabel,
};
```

（publish 步不再走 stepRunner —— engine 在 await-check 停下，WF_PUBLISH_CHECK/EXEC 驱动；publish 走到 run-auto 的唯一路径是 reviewed=true，而新流程从不给 publish 标 reviewed。）

- [ ] **Step 3: 加 orchPublishCheck/Exec/Skip（放在 orchReviewApprove 函数后，约 :150）**

```js
// publish 两段闸——检查（phase await-check）。持久化 autoPublish；找编辑页 tab 发 CAP_CHECK；
// block→phase blocked；通过+autoPublish→内联执行发布；通过+手动→phase await-publish。
const PUBLISH_AUTO_KEY = 'as_publish_autopublish';
async function orchPublishCheck(workflowId, autoPublish) {
  try { await chrome.storage.local.set({ [PUBLISH_AUTO_KEY]: !!autoPublish }); } catch (_) {}
  const found = await findDxmEditTab();
  if (found.error) { await orchPublishSetError(workflowId, found.error); return; }
  let resp;
  try {
    resp = await orchSendStepCommand(found.tab.id, 'CAP_CHECK', {}, { timeoutMs: 60000 });
  } catch (e) {
    await orchPublishSetError(workflowId, { category: 'read', code: 'CAP_CHECK_CMD_FAILED', message: '检查命令未送达:' + String(e?.message || e), recoverable: true });
    return;
  }
  if (!resp || resp.status !== 'done') {
    await orchPublishSetError(workflowId, (resp && resp.error) || { category: 'read', code: 'CAP_CHECK_NO_RESP', message: '检查命令无响应', recoverable: true });
    return;
  }
  const checkResult = resp.result || {};
  const blocked = Array.isArray(checkResult.blocks) && checkResult.blocks.length > 0;
  if (blocked) {
    await orchPublishSetPhase(workflowId, 'blocked', checkResult);
    return;
  }
  if (autoPublish) { await orchPublishExec(workflowId); return; }   // 通过+自动 → 直接连发
  await orchPublishSetPhase(workflowId, 'await-publish', checkResult);
}

// publish 两段闸——发布（phase await-publish 点发布 / 自动发布内联）。成功 done+advance；失败回 await-publish 显错。
async function orchPublishExec(workflowId) {
  const found = await findDxmEditTab();
  if (found.error) { await orchPublishSetError(workflowId, found.error); return; }
  await orchMarkCommitting(workflowId, true);   // 不可逆提交点：发命令前标 committing
  let resp;
  try {
    resp = await orchSendStepCommand(found.tab.id, 'CAP_PUBLISH_EXEC', {}, { timeoutMs: 60000 });
  } catch (e) {
    await orchPublishSetPublishError(workflowId, { code: 'CAP_PUBLISH_CMD_FAILED', message: '发布命令未送达:' + String(e?.message || e) });
    return;
  }
  if (resp && resp.status === 'done') {
    await orchQueue.enqueue(skeleton => {
      const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
      if (!wf) return undefined;
      const s = wf.steps[wf.cursor];
      s.status = 'done'; s.committing = false; s.endedAt = Date.now(); s.result = resp.result || null; s.error = null;
      Object.assign(wf.product, ORCH.engine.pickProduct(resp.result));
      wf.status = 'running'; wf.hitl = null; wf.updatedAt = Date.now();
      return skeleton;
    });
    await orchEngine.advance(workflowId);
    return;
  }
  await orchPublishSetPublishError(workflowId, (resp && resp.error) || { code: 'CAP_PUBLISH_NO_RESP', message: '发布命令无响应' });
}

// 跳过当前步（测试期）：标 skipped + advance（decideNext 已支持 skipped→advance-cursor）。
async function orchSkipStep(workflowId) {
  await orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf || wf.status !== 'paused') return undefined;
    const s = wf.steps[wf.cursor];
    s.status = 'skipped'; s.committing = false; s.endedAt = Date.now();
    wf.status = 'running'; wf.hitl = null; wf.updatedAt = Date.now();
    return skeleton;
  });
  await orchEngine.advance(workflowId);
}

// publish hitl phase 转移辅助（保持 paused，仅改 hitl）。
async function orchPublishSetPhase(workflowId, phase, checkResult) {
  await orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf || !wf.hitl || wf.hitl.kind !== 'publish') return undefined;
    wf.steps[wf.cursor].committing = false;
    wf.hitl.phase = phase;
    if (checkResult !== undefined) wf.hitl.checkResult = checkResult;
    wf.hitl.publishError = null;
    wf.updatedAt = Date.now();
    return skeleton;
  });
}
async function orchPublishSetPublishError(workflowId, publishError) {
  await orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf || !wf.hitl || wf.hitl.kind !== 'publish') return undefined;
    wf.steps[wf.cursor].committing = false;
    wf.hitl.phase = 'await-publish';
    wf.hitl.publishError = publishError;
    wf.updatedAt = Date.now();
    return skeleton;
  });
}
// 读/命令类硬错误（tab 没开等）→ 走 step.error + error 卡（recoverable 可重试整步）。
async function orchPublishSetError(workflowId, error) {
  await orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf) return undefined;
    const s = wf.steps[wf.cursor];
    s.status = 'error'; s.committing = false; s.error = error;
    wf.status = 'error'; wf.hitl = null; wf.updatedAt = Date.now();
    return skeleton;
  });
}
```

注：`orchMarkCommitting` 已存在（orchAdapterPublish 原用过）；`orchSendStepCommand`、`orchQueue`、`orchEngine`、`ORCH.engine.findWorkflow/pickProduct` 均现成。

- [ ] **Step 4: 注册三条 WF_ handler（约 :609，`WF_RESTART` 分支后、handler 闭合 `});` 前）**

```js
  if (msg.type === 'WF_PUBLISH_CHECK') {
    orchPublishCheck((msg.data || {}).workflowId, !!(msg.data || {}).autoPublish)
      .then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'WF_PUBLISH_EXEC') {
    orchPublishExec((msg.data || {}).workflowId)
      .then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'WF_SKIP') {
    orchSkipStep((msg.data || {}).workflowId)
      .then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
```

- [ ] **Step 5: 验证既有 JS 测试不回归**

Run: `node --test tests/*.test.js`
Expected: PASS（bg 改动不被单测覆盖，但确认 engine/steps/hitl-action 改动协同无回归）

- [ ] **Step 6: 提交**

```bash
git add automation/bg-entry.js
git commit -m "feat(automation): bg publish 两段闸驱动 + WF_PUBLISH_CHECK/EXEC + WF_SKIP

Why: engine 停在 await-check 后，需 bg 驱动 检查→发布 两段 + 跳过 + 持久化自动发布开关。
What: 抽 findDxmEditTab；删 orchAdapterPublish+ORCH_ADAPTERS.publish；加 orchPublishCheck(持久化+CAP_CHECK+判phase)/orchPublishExec(CAP_PUBLISH_EXEC+done+advance)/orchSkipStep+phase辅助；注册三 WF_ handler。
Test: node --test tests/*.test.js 不回归

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: dashboard — publish-kind 三态卡 + 自动发布 checkbox

**Files:**
- Modify: `automation/dashboard/components/hitl-queue.js`（hitlCard 加 publish 分支 + publishCard 函数）
- Modify: `automation/dashboard/dashboard.js`（seed `window.__AS_PUBLISH_AUTO__` from storage）

> UI/DOM 耦合，靠 Task 7 端到端验证。

- [ ] **Step 1: hitl-queue.js — hitlCard 顶部加 publish 分支（`if (view.isReviewHitl(hitl))` 之前）**

```js
  // publish 两段闸（kind:'publish'）：phase await-check / blocked / await-publish
  if (hitl.kind === 'publish') {
    return publishCard(hitl, head, onAction);
  }
```

- [ ] **Step 2: hitl-queue.js — 加 publishCard 函数（放在 hitlCard 函数后）**

```js
// publish 两段闸卡：await-check（检查+自动发布勾选+跳过）/ blocked（阻断列表+重检+跳过）/ await-publish（通过+发布+跳过）。
function publishCard(hitl, head, onAction) {
  const phase = hitl.phase || 'await-check';
  const cr = hitl.checkResult || {};
  const skipBtn = h('div', { class: 'btn no', onClick: () => onAction && onAction('skip', {}) }, [icon('ic-slash'), ' 跳过本步']);
  const body = [head];

  if (phase === 'await-check') {
    const autoDefault = !!window.__AS_PUBLISH_AUTO__;
    body.push(h('div', { class: 'review-reason' }, '请先人工打开店小秘商品编辑页（URL 含 edit），再点检查。'));
    const cb = h('input', autoDefault
      ? { type: 'checkbox', id: 'dash-publish-auto', class: 'pub-auto', checked: 'checked' }
      : { type: 'checkbox', id: 'dash-publish-auto', class: 'pub-auto' });
    body.push(h('label', { class: 'pub-auto-row' }, [cb, ' 检查通过后自动发布']));
    body.push(h('div', { class: 'hitl-acts' }, [
      h('div', { class: 'btn ok', onClick: () => {
        const el = document.getElementById('dash-publish-auto');
        onAction && onAction('publish-check', { autoPublish: !!(el && el.checked) });
      } }, [icon('ic-check'), ' 检查']),
      skipBtn,
    ]));
  } else if (phase === 'blocked') {
    const items = [...(cr.blocks || []).map(b => ['✗ 阻断', b.name, b.reason]),
                   ...(cr.warns || []).map(w => ['⚠ 警告', w.name, w.reason])];
    body.push(h('div', { class: 'review-reason' }, `检查未通过：${(cr.blocks || []).length} 阻断 / ${(cr.warns || []).length} 警告`));
    body.push(h('ul', { class: 'concerns' }, items.map(([tag, name, reason]) => h('li', {}, `${tag} ${name}${reason ? '：' + reason : ''}`))));
    body.push(h('div', { class: 'hitl-acts' }, [
      h('div', { class: 'btn edit', onClick: () => onAction && onAction('publish-check', { autoPublish: false }) }, [icon('ic-refresh'), ' 重新检查']),
      skipBtn,
    ]));
  } else {   // await-publish
    body.push(h('div', { class: 'review-reason' }, `✓ 检查通过（${cr.passCount || 0} 项）${(cr.warns || []).length ? '，' + cr.warns.length + ' 警告' : ''}`));
    if ((cr.warns || []).length) {
      body.push(h('ul', { class: 'concerns' }, cr.warns.map(w => h('li', {}, `⚠ ${w.name}${w.reason ? '：' + w.reason : ''}`))));
    }
    if (hitl.publishError) {
      body.push(h('div', { class: 'review-reason', style: 'color:var(--st-error,#cf1322)' }, '上次发布失败：' + (hitl.publishError.message || '')));
    }
    body.push(h('div', { class: 'hitl-acts' }, [
      h('div', { class: 'btn ok', onClick: () => onAction && onAction('publish-exec', {}) }, [icon('ic-check'), ' 发布']),
      skipBtn,
    ]));
  }
  return h('div', { class: 'hitl-card publish' }, body);
}
```

注：`onAction(act, opts)` 第二参在现有 `actBtn` 里是 `{ getField }`；publish 卡的 skip/publish-exec 传 `{}`、publish-check 传 `{ autoPublish }`。dashboard.js 的 onAction 调 `buildHitlMessage(act, wf, getField, view, opts)` 时把第二参当 opts —— 确认 dashboard.js 透传 opts（见 Step 4 校验）。

- [ ] **Step 3: dashboard.js — seed 自动发布开关全局（在数据源启动段，约 :142 附近）**

```js
// publish 自动发布开关：dashboard 读 storage 作 checkbox 初态（bg 在 WF_PUBLISH_CHECK 时写回）。
window.__AS_PUBLISH_AUTO__ = false;
chrome.storage.local.get('as_publish_autopublish').then(o => { window.__AS_PUBLISH_AUTO__ = !!o.as_publish_autopublish; }).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.as_publish_autopublish) window.__AS_PUBLISH_AUTO__ = !!changes.as_publish_autopublish.newValue;
});
```

- [ ] **Step 4: 校验 dashboard.js onAction 透传 opts 给 buildHitlMessage**

Run: `grep -n "buildHitlMessage\|onAction\|function.*Action\|opts" automation/dashboard/dashboard.js | head`
Expected: 找到 onAction → buildHitlMessage(act, wf, getField, view, opts) 的调用；若当前签名漏传第 5 参 opts，补上 opts 透传（publish-check 依赖 opts.autoPublish、restart 已依赖 opts.fromStep——restart 能工作即说明 opts 已透传）。

- [ ] **Step 5: （可选）加 publish 卡 CSS**——`.pub-auto-row`/`.hitl-card.publish` 复用现有 `.hitl-card`/`.concerns`/`.review-reason` 样式即可，无需新增；如对勾选行排版不满意，在 `dashboard.css` 加：

```css
.pub-auto-row { display:flex; align-items:center; gap:6px; margin:8px 0; font-size:12px; color:var(--fg-dim,#aaa); cursor:pointer; }
.pub-auto-row input { margin:0; }
```

- [ ] **Step 6: 提交**

```bash
git add automation/dashboard/components/hitl-queue.js automation/dashboard/dashboard.js automation/dashboard/dashboard.css
git commit -m "feat(automation): dashboard publish 两段闸卡（检查/阻断/发布三态）+ 自动发布开关

Why: 接通 e2e 两段确认 UI——人工看检查结果再决定发布，可勾自动发布 / 跳过本步。
What: hitl-queue 加 kind:'publish' 三态 publishCard（checkbox+检查/重检/发布/跳过按钮）；dashboard.js seed window.__AS_PUBLISH_AUTO__。
Test: not run (UI DOM 耦合，Task 7 端到端验)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 全量验证 + 构建 + 端到端 checklist

**Files:** 无（验证）

- [ ] **Step 1: JS + Python 全量单测**

Run: `node --test tests/*.test.js && python3 -m pytest tests/ -q`
Expected: JS 全 PASS（≥163+新增）、Python 90 PASS

- [ ] **Step 2: 构建 dev 产物（automation=on）**

Run: `python3 build/build_extension.py 2>&1 | tail -3`
Expected: `done → .../dist/extension (automation=on)`，无 hard fail

- [ ] **Step 3: 确认产物含新代码**

Run: `grep -c "CAP_CHECK\|CAP_PUBLISH_EXEC" dist/extension/features/check_and_publish/content/index.js; grep -c "WF_PUBLISH_CHECK\|orchPublishCheck" dist/extension/background/service-worker.js`
Expected: 两条均 > 0（feature 已拷、bg 已 importScripts 注入 SW）

- [ ] **Step 4: 端到端手动验证（用户在 Chrome，可弃测试商品）**——`chrome://extensions` reload 扩展 → 打开监控 dashboard → 新建/跑 workflow 到 publish 步：
  - [ ] publish 停在 `await-check` 卡：显示「检查」+ ☐ 自动发布 + 跳过本步
  - [ ] 不开店小秘编辑页直接点检查 → error 卡 `PUBLISH_NO_EDIT_TAB`（可重试）
  - [ ] 开店小秘编辑页 → 点检查（不勾自动发布）→ 通过则转 `await-publish` 显「✓ 检查通过(N)」+ 发布按钮；有 block 则转 `blocked` 列阻断规则名
  - [ ] `await-publish` 点「发布」→ 店小秘真实点「立即发布」→ 步 done，cursor 进 ④
  - [ ] 重跑：勾「自动发布」→ 点检查 → 通过后**不停 await-publish**直接连发
  - [ ] 任意 phase 点「跳过本步」→ 步标 skipped，cursor 进 ④（不检查不发布）
  - [ ] 自动发布勾选状态跨 workflow 记住（再开一条到 publish 看 checkbox 初态）

- [ ] **Step 5: 端到端通过后报告用户**——不自动开 PR / 不自动 merge（按 shipping-rules，等用户触发词）。

---

## Self-Review 记录

- **Spec 覆盖**：①两段确认→Task 2/4/5/6 ②自动发布开关(默认关/治本次/持久化)→Task 5 Step3 持久化 + Task 6 Step3 初态 + Task 3 autoPublish 传参 ③跳过整步→Task 5 orchSkipStep + Task 3 skip 映射 + Task 6 skip 按钮。CAP 拆分→Task 4。engine gate→Task 2。错误分层→Task 4(CAP error code)+Task 5(orchPublishSetError/PublishError)。✓ 全覆盖。
- **类型一致**：`kind:'publish'`、`phase` ∈ {await-check,blocked,await-publish}、`checkResult:{passCount,blocks[],warns[],skippeds}`、storage key `as_publish_autopublish`、全局 `window.__AS_PUBLISH_AUTO__`、act `publish-check`/`publish-exec`/`skip` —— 跨 Task 命名一致。✓
- **无占位符**：每改码步含完整代码。✓
- **风险点**：Task 6 Step4 依赖 dashboard.js 已透传 opts 给 buildHitlMessage（restart 能工作即证已透传）；若未透传需补，校验步已标注。

