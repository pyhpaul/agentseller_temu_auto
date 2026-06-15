# Dashboard HITL 操作中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 HITL 人工操作从业务页 overlay 搬进监控 dashboard，使 dashboard 成为唯一操作中心；业务页 overlay 降级为只读进度提示。

**Architecture:** dashboard 的 `hitl-queue` 组件当前只渲染只读卡片 + 死按钮（`onHitlAction` 是 `console.log` 占位）。本计划让它按 HITL 类型（回填 / 复核 / 纯确认）条件渲染可交互控件，并把 `onHitlAction` 接通 `WF_*` 消息回路（dashboard 是扩展页，可 `chrome.runtime.sendMessage`，与 overlay 同机制）。复用已测的 `overlay-view.js` 纯逻辑（经 classic script 挂全局），不重写一套。error 态并入同一面板（重试 / 转人工）。新增「中止当前批次」按钮。overlay 去操作化只留进度。

**Tech Stack:** 原生 JS（dashboard ES module + classic script 混合）、chrome.runtime messaging、node:test 单测。

**关键约束（实现者必读）：**
- dashboard 运行时路径：dashboard.html 在 `dist/extension/dashboard/`，overlay-view 在 `dist/extension/content/overlay-view.js` → 引用写 `../content/overlay-view.js`（dist 运行时相对路径，源码结构下无效但 dashboard 只在 dist 跑）。
- 不破坏发版隔离：所有改动仍在 `automation/` 内，release 不装配 → 天然不进生产。
- 不改 `bg-entry.js` 的 `WF_*` handler（已全部就绪：WF_HITL_CONFIRM/WF_REVIEW_APPROVE/WF_HITL_REJECT/WF_RETRY/WF_FILL_REFRESH/WF_ABORT），本计划只接通 dashboard 发送端。
- 复用纯逻辑：`buildFillResult` / `validateFill` / `hasSuggestion` / `mergeSuggestion` / `isReviewHitl`（均在 `automation/overlay/overlay-view.js`，已被 `tests/overlay-view.test.js` 覆盖）。
- 临时验证态：`bg-entry.js:423` 当前是 `orchStubStepRunner`（E2E-STUB 标记），本计划不动它；交付 PR 时单独 revert。

---

## File Structure

| 文件 | 责任 | 改动 |
|------|------|------|
| `automation/dashboard/dashboard.html` | 扩展页壳 | 加 classic `<script src="../content/overlay-view.js">` 引入纯逻辑 |
| `automation/dashboard/components/hitl-queue.js` | 人工介入面板 | 重写：按 HITL 类型条件渲染 + error 态 + 中止按钮 |
| `automation/dashboard/dashboard.js` | 装配入口 | `onHitlAction` 接通 `WF_*` 回路；传 wf 给 hitl-queue |
| `automation/dashboard/hitl-action.js`（新建） | 动作→消息映射纯逻辑 | `buildHitlMessage(act, wf, getField)` → `{type,data}` 或 `{error}`，可 node 测 |
| `automation/overlay/overlay.js` | 业务页浮层 | `renderBody` 去操作按钮，只留进度行（降级只读） |
| `tests/hitl-action.test.js`（新建） | 单测 | 覆盖 `buildHitlMessage` 各分支 |

---

### Task 1: hitl-action.js — 动作→WF_* 消息映射纯逻辑（TDD）

**Files:**
- Create: `automation/dashboard/hitl-action.js`
- Test: `tests/hitl-action.test.js`

设计：纯函数 `buildHitlMessage(act, wf, getField, view)` → `{type, data}`（可发送）或 `{error:[{key?,msg}]}`（校验失败）。`view` 是注入的 overlay-view api（测试传 require、dashboard 传 `window.__AS_OVERLAY_VIEW__`），保持纯逻辑无全局依赖。回填型 `submit` 用 `view.buildFillResult` + `view.validateFill`。

- [ ] **Step 1: 写失败测试** `tests/hitl-action.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildHitlMessage } = require('../automation/dashboard/hitl-action.js');
const view = require('../automation/overlay/overlay-view.js');

const wfConfirm = { id: 'w1', hitl: { editable: false, fields: [] } };
const wfFill = { id: 'w2', hitl: { editable: true, fields: [
  { key: 'sourceUrl', label: 'Temu 商品详情页 URL', fieldType: 'text', required: true } ] } };

test('confirm（纯确认）→ WF_HITL_CONFIRM 空 result', () => {
  const m = buildHitlMessage('confirm', wfConfirm, () => '', view);
  assert.deepStrictEqual(m, { type: 'WF_HITL_CONFIRM', data: { workflowId: 'w1', result: {} } });
});

test('submit（回填）必填缺失 → error，不发消息', () => {
  const m = buildHitlMessage('submit', wfFill, () => '', view);
  assert.ok(m.error && m.error.length === 1);
  assert.ok(!m.type);
});

test('submit（回填）填了值 → WF_HITL_CONFIRM 带 result', () => {
  const m = buildHitlMessage('submit', wfFill, k => k === 'sourceUrl' ? ' https://seller.temu.com/x ' : '', view);
  assert.strictEqual(m.type, 'WF_HITL_CONFIRM');
  assert.strictEqual(m.data.result.sourceUrl, 'https://seller.temu.com/x');   // trim 过
});

test('approve/reject/retry/refresh/abort → 对应 WF_*，data 只含 workflowId', () => {
  const map = { approve: 'WF_REVIEW_APPROVE', reject: 'WF_HITL_REJECT', retry: 'WF_RETRY', refresh: 'WF_FILL_REFRESH', abort: 'WF_ABORT' };
  for (const [act, type] of Object.entries(map)) {
    const m = buildHitlMessage(act, wfConfirm, () => '', view);
    assert.deepStrictEqual(m, { type, data: { workflowId: 'w1' } });
  }
});

test('未知动作 → error', () => {
  const m = buildHitlMessage('bogus', wfConfirm, () => '', view);
  assert.ok(m.error && !m.type);
});
```

- [ ] **Step 2: 运行测试确认 fail**：`node --test tests/hitl-action.test.js` → FAIL（模块不存在）
- [ ] **Step 3: 写实现** `automation/dashboard/hitl-action.js`

```js
// automation/dashboard/hitl-action.js — HITL 动作 → WF_* 消息映射（纯逻辑，UMD 双模式）。
// dashboard.js（ES module 经全局）+ node 测共用。view 注入 overlay-view api，保持无全局依赖。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.__AS_DASH_HITL_ACTION__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // act: confirm(纯确认) / submit(回填提交) / approve(复核确认) / reject / retry / refresh / abort
  function buildHitlMessage(act, wf, getField, view) {
    const workflowId = wf && wf.id;
    switch (act) {
      case 'confirm':
        return { type: 'WF_HITL_CONFIRM', data: { workflowId, result: {} } };
      case 'submit': {
        const fields = (wf.hitl && wf.hitl.fields) || [];
        const result = view.buildFillResult(fields, getField);
        const v = view.validateFill(fields, result);
        if (!v.ok) return { error: v.errors };
        return { type: 'WF_HITL_CONFIRM', data: { workflowId, result } };
      }
      case 'approve': return { type: 'WF_REVIEW_APPROVE', data: { workflowId } };
      case 'reject':  return { type: 'WF_HITL_REJECT',   data: { workflowId } };
      case 'retry':   return { type: 'WF_RETRY',         data: { workflowId } };
      case 'refresh': return { type: 'WF_FILL_REFRESH',  data: { workflowId } };
      case 'abort':   return { type: 'WF_ABORT',         data: { workflowId } };
      default: return { error: [{ msg: '未知动作 ' + act }] };
    }
  }
  return { buildHitlMessage };
});
```

- [ ] **Step 4: 运行测试确认 pass**：`node --test tests/hitl-action.test.js` → 全 pass
- [ ] **Step 5: Commit**：`git add automation/dashboard/hitl-action.js tests/hitl-action.test.js && git commit`（message 走 type(scope): summary + Why/What/Test）

---

### Task 2: hitl-queue.js 按类型条件渲染 + error 态 + 中止按钮

**Files:**
- Modify: `automation/dashboard/components/hitl-queue.js`（整体重写 `hitlCard` + `renderHitlQueue`）

设计：`renderHitlQueue(mountEl, workflow, onAction)` 按 workflow 状态分支：
- `paused` + `hitl` → 按 HITL 类型渲染（见下表），输入框 id 用 `dash-fill-<key>`
- `error` → 分层错误（复用 `errorChip` 逻辑或内联）+ 重试（`error.recoverable` 才有）/ 转人工
- 其它 → 空态「暂无待确认，流程自动推进中」

| HITL 类型 | 判定 | 渲染 | 按钮(data-act) |
|-----------|------|------|------|
| 复核型 | `view.isReviewHitl(hitl)` | reason + concerns 列表 | 确认提交(approve) · 中止(reject) |
| 回填型 | `hitl.editable && hitl.fields.length` | 每 field 输入框 + 🧠提议预填(`view.mergeSuggestion`) | 提交(submit) · 🔄重新建议(refresh) · 拒绝(reject) |
| 纯确认型 | 其它 | action + keyValues | 确认完成(confirm) · 拒绝(reject) |

顶部统一加「⏹ 中止当前批次」(data-act=abort)，workflow 存在即显示。

`onAction(act, { getField })` 回调签名：`getField(key)` 读 `mountEl.querySelector('#dash-fill-'+key).value`（由 hitl-queue 内部闭包提供，dashboard.js 不碰 DOM）。`view` 从 `window.__AS_OVERLAY_VIEW__` 取。

- [ ] **Step 1: 重写 `hitl-queue.js`**（保留 `h`/`icon` 导入与 `kvRows`；`hitlCard` 改为按类型分支；新增 error 分支与中止按钮；为输入框/按钮加 `data-act` 与 `id`，并在渲染后绑定 onClick 调 `onAction(act, {getField})`）。完整渲染参考 `automation/overlay/overlay.js` 的 `renderBody`（同款类型分支与文案），但用 dashboard 的 `h()` DOM helper 而非 innerHTML 字符串。
- [ ] **Step 2: 手动渲染验证**：用 `automation/dashboard/mock/mock-data.js` 的 mock 骨架在浏览器加载 dashboard，确认三类 HITL + error 都正确渲染、输入框可输入。（无自动化 DOM 测试，依赖 mock 回放，spec §渲染验证。）
- [ ] **Step 3: Commit**

---

### Task 3: dashboard 接通回路（引入 overlay-view + onHitlAction 发 WF_*）

**Files:**
- Modify: `automation/dashboard/dashboard.html`（加 classic script 引入 overlay-view + hitl-action）
- Modify: `automation/dashboard/dashboard.js`（`onHitlAction` 接通）

- [ ] **Step 1: dashboard.html 引入纯逻辑**。在 `<script type="module" src="dashboard.js"></script>` **之前**加两行 classic script（顺序：overlay-view 先，hitl-action 后，因 hitl-action 运行时不依赖 overlay-view 全局但保持一致）：

```html
  <script src="../content/overlay-view.js"></script>
  <script src="hitl-action.js"></script>
```

注意：`../content/overlay-view.js` 是 **dist 运行时路径**（dashboard.html 在 `dist/extension/dashboard/`，overlay-view 在 `dist/extension/content/`）。`hitl-action.js` 与 dashboard.html 同目录（build copytree 整目录）。两者分别挂 `window.__AS_OVERLAY_VIEW__` / `window.__AS_DASH_HITL_ACTION__`。

- [ ] **Step 2: dashboard.js `onHitlAction` 接通**。替换当前占位：

```js
// HITL 动作 → WF_* 回路：buildHitlMessage 映射后 sendMessage；回填校验失败 alert 提示。
function onHitlAction(act, payload) {
  const wf = selectActiveWorkflow(store.getState().skeleton.batch);
  if (!wf) return;
  const view = window.__AS_OVERLAY_VIEW__;
  const getField = (payload && payload.getField) || (() => '');
  const msg = window.__AS_DASH_HITL_ACTION__.buildHitlMessage(act, wf, getField, view);
  if (msg.error) { window.alert(msg.error.map(e => e.msg).join('\n')); return; }
  try { chrome.runtime.sendMessage(msg); }
  catch (e) { console.warn('[dashboard] HITL 发送失败', e); }
}
```

（`onHitlAction` 签名从 `(kind, hitl)` 改为 `(act, payload)`，与 Task 2 的 `onAction(act, {getField})` 对齐。）

- [ ] **Step 3: 验证**：`node --test tests/*.test.js` 全绿（不应破坏；本步无新单测，逻辑已在 Task 1 覆盖）。
- [ ] **Step 4: 手动端到端验证**（见 Task 5 集成）。
- [ ] **Step 5: Commit**

---

### Task 4: overlay 降级为只读进度

**Files:**
- Modify: `automation/overlay/overlay.js`（`renderBody` 去操作按钮 + `bindActions` 简化/移除）

设计：业务页 overlay 不再承担操作，只显示进度行。保留 `render` 的进度条（`编排进度 N/13 · 步骤名`），`renderBody` 对 paused/error 一律返回空字符串（或一行「请在监控面板操作」提示），`bindActions` 不再绑定任何 `data-act`（无按钮可绑）。

- [ ] **Step 1: 改 `renderBody`**：删除 paused（HITL/复核）与 error 的按钮分支，paused 时返回 `<div style="font-size:12px;color:#8b949e;">⏳ 等待人工处理（请在监控面板操作）</div>`，error 时返回分层错误**只读** chip（无按钮）。
- [ ] **Step 2: 改 `bindActions`**：因无 `data-act` 按钮，函数体可空或保留 querySelectorAll（空集合无副作用）；移除 go/confirm/reject/retry/refresh/approve 分支。
- [ ] **Step 3: 验证 overlay-view 单测仍绿**：`node --test tests/overlay-view.test.js`（overlay-view 纯逻辑未动，应全 pass）。
- [ ] **Step 4: Commit**

---

### Task 5: 集成验证 + 全量回归 + build

**Files:** 无新增；端到端验证 + 构建。

- [ ] **Step 1: 全量单测**：`node --test tests/*.test.js`（含新 hitl-action）+ `python3 -m pytest tests/` 全绿。
- [ ] **Step 2: build**：`python3 build/build_extension.py`，确认 `automation=on`、`dist/extension/dashboard/hitl-action.js` 存在、`dist/extension/dashboard/dashboard.html` 含 `../content/overlay-view.js`。
- [ ] **Step 3: 手动端到端**（dashboard 操作中心）：reload 扩展 → 清 storage → dashboard 发起 → 选品步在 dashboard「HITL 待确认」面板出现 sourceUrl 输入框 → 填 url 点提交 → SW console 验 `product.sourceUrl` 存入 → 流程推进到下一步。中止按钮能 abort。
- [ ] **Step 4: 最终 code review**（subagent-driven 收尾的整体审查）。

---

## Self-Review

- **Spec coverage**：① hitl-queue 三类型渲染 → Task 2；② 回路接通 → Task 1+3；③ error 重试/转人工 → Task 2（渲染）+ Task 1（消息）；④ 中止按钮 → Task 2（渲染）+ Task 1（abort 消息）；⑤ overlay 降级 → Task 4；⑥ 复用纯逻辑 → Task 1（view 注入）+ Task 3（引入）。全覆盖。
- **类型一致**：`onAction(act, {getField})`（Task 2）↔ `onHitlAction(act, payload)`（Task 3）↔ `buildHitlMessage(act, wf, getField, view)`（Task 1）签名链一致。
- **无占位**：所有代码步给出完整代码或明确改法。
- **风险**：dashboard DOM 渲染无自动化测试 → 靠 mock 回放 + 端到端手动验证（已在 Task 2/5 标注，非占位）。

