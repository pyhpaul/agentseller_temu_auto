# Plan 3 第三刀：overlay WF_START 启动入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 overlay 浮层加「开始流水线」启动入口（无 active workflow 的空态填商品 label → 发 `WF_START {label}`），解 Plan 2「`WF_START` 仅能 SW console 手调」缺口（spec §8）。

**Architecture:** 纯 overlay 前端一刀，bg 零改动（`WF_START` handler + `buildInitialWorkflow` 的 `product.label` 在 2-2a 已预埋）。抽 `core/content/overlay-view.js`（UMD 纯逻辑：视图决策 + label 规范化）承载可测决策，overlay.js 引用它分派三态（active 现状 / idle 启动入口 / hidden 发版隔离沉睡）。启动入口经 `__AS_BUILD_INFO__.isDev` 守卫——release 空态仍 hidden，保持「release 行为与 Plan 2 一致」（dead code 隔离，同 OPEN_MONITOR 先例）。

**Tech Stack:** content script（IIFE + isolated world 共享全局）、UMD 双模式模块、node:test 纯逻辑单测、`chrome.runtime.sendMessage('WF_START')`。

---

## File Structure

- **Create** `core/content/overlay-view.js` — UMD 纯逻辑：`activeWorkflow(batch)`（从 Plan 2 overlay.js 平移）+ `decideOverlayView(batch, buildInfo)`（→ `{view, workflow}`，封装 isDev 发版隔离守卫）+ `normalizeStartLabel(raw)`（trim，空→null）。挂 `window.__AS_OVERLAY_VIEW__`（content）/ `module.exports`（node 测）。
- **Create** `tests/overlay-view.test.js` — node:test 覆盖三态决策（含 release / 缺 buildInfo → hidden 发版隔离锁定）+ label 规范化。
- **Modify** `core/content/overlay.js` — 删本地 `activeWorkflow`（移入 overlay-view）；`render` 改用 `decideOverlayView` 分派；新增 `renderIdle`/`bindIdleActions`（空态启动入口二级交互）+ 本地 `composing` 状态。
- **Modify** `build/build_extension.py`（content_scripts 列表）— `overlay-view.js` 插 `overlay.js` 前。
- **Create** `docs/superpowers/2026-06-11-plan3-overlay-wf-start-verification.md` — 验证说明（自动化结果 + chrome 手验 + 发版隔离论证）。

---

## Task 1: overlay-view.js 视图决策纯逻辑 + 单测

**Files:**
- Create: `core/content/overlay-view.js`
- Test: `tests/overlay-view.test.js`

- [ ] **Step 1: 写失败测试**

Create `tests/overlay-view.test.js`:

```javascript
// tests/overlay-view.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { activeWorkflow, decideOverlayView, normalizeStartLabel } = require('../core/content/overlay-view.js');

function batchWith(status) {
  return { workflows: [{ id: 'w1', status }] };
}

test('activeWorkflow：取 running/paused/error 那个', () => {
  assert.strictEqual(activeWorkflow(batchWith('running')).id, 'w1');
  assert.strictEqual(activeWorkflow(batchWith('paused')).id, 'w1');
  assert.strictEqual(activeWorkflow(batchWith('error')).id, 'w1');
});

test('activeWorkflow：done/aborted/空 → null', () => {
  assert.strictEqual(activeWorkflow(batchWith('done')), null);
  assert.strictEqual(activeWorkflow(batchWith('aborted')), null);
  assert.strictEqual(activeWorkflow(null), null);
  assert.strictEqual(activeWorkflow({ workflows: [] }), null);
});

test('decideOverlayView：有 active workflow → active（无视 buildInfo）', () => {
  const r = decideOverlayView(batchWith('running'), { isDev: false });
  assert.strictEqual(r.view, 'active');
  assert.strictEqual(r.workflow.id, 'w1');
});

test('decideOverlayView：无 active + dev → idle（启动入口）', () => {
  const r = decideOverlayView(batchWith('done'), { isDev: true });
  assert.strictEqual(r.view, 'idle');
  assert.strictEqual(r.workflow, null);
});

test('decideOverlayView：无 active + release → hidden（发版隔离沉睡）', () => {
  assert.strictEqual(decideOverlayView(batchWith('done'), { isDev: false }).view, 'hidden');
});

test('decideOverlayView：无 active + buildInfo 缺失 → hidden（安全默认 release）', () => {
  assert.strictEqual(decideOverlayView(null, null).view, 'hidden');
  assert.strictEqual(decideOverlayView(null, undefined).view, 'hidden');
});

test('normalizeStartLabel：去首尾空白', () => {
  assert.strictEqual(normalizeStartLabel('  商品A  '), '商品A');
});

test('normalizeStartLabel：空/纯空白/null/undefined → null', () => {
  assert.strictEqual(normalizeStartLabel(''), null);
  assert.strictEqual(normalizeStartLabel('   '), null);
  assert.strictEqual(normalizeStartLabel(null), null);
  assert.strictEqual(normalizeStartLabel(undefined), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/overlay-view.test.js`
Expected: FAIL — `Cannot find module '../core/content/overlay-view.js'`

- [ ] **Step 3: 写最小实现**

Create `core/content/overlay-view.js`:

```javascript
// core/content/overlay-view.js — overlay 视图决策纯逻辑（与 DOM/chrome 解耦，可 node 测）。spec §8。
// 职责：从 storage 骨架 + 构建信息决定 overlay 渲染哪个视图 + 启动 label 规范化。
// overlay.js（content script）引用全局 window.__AS_OVERLAY_VIEW__；node 测引用 module.exports。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.__AS_OVERLAY_VIEW__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 首版单 workflow：取 running/paused/error 那个（done/aborted 不显示）
  function activeWorkflow(batch) {
    const wfs = (batch && batch.workflows) || [];
    return wfs.find(w => w && ['running', 'paused', 'error'].includes(w.status)) || null;
  }

  // 决定 overlay 渲染哪个视图：
  //   有 active workflow  → 'active'（进度 / HITL / error，Plan 2 现状）
  //   无 active + dev     → 'idle'（启动入口「开始流水线」，本刀新增）
  //   无 active + release → 'hidden'（发版隔离：release overlay 沉睡，行为同 Plan 2）
  // buildInfo = window.__AS_BUILD_INFO__（{ isDev }）；缺失按 release 处理（安全默认 hidden）。
  function decideOverlayView(batch, buildInfo) {
    const wf = activeWorkflow(batch);
    if (wf) return { view: 'active', workflow: wf };
    const isDev = !!(buildInfo && buildInfo.isDev);
    return { view: isDev ? 'idle' : 'hidden', workflow: null };
  }

  // 启动 label 规范化：去首尾空白；空 → null（label 必填，调用方据此拒发 WF_START）
  function normalizeStartLabel(raw) {
    const s = (raw == null ? '' : String(raw)).trim();
    return s.length ? s : null;
  }

  return { activeWorkflow, decideOverlayView, normalizeStartLabel };
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/overlay-view.test.js`
Expected: PASS — 8 tests pass

- [ ] **Step 5: commit**

```bash
git add core/content/overlay-view.js tests/overlay-view.test.js
git commit -m "$(cat <<'EOF'
feat(plan3): overlay-view 视图决策纯逻辑 + 单测（发版隔离守卫）

Why: 第三刀启动入口需在「无 active workflow」空态渲染，且 release 必须沉睡（不冒启动按钮）；
     把「渲染哪个视图」的决策抽成可测纯函数，TDD 锁定 isDev 发版隔离守卫。
What: 新建 core/content/overlay-view.js（UMD：activeWorkflow + decideOverlayView + normalizeStartLabel）
      + tests/overlay-view.test.js（8 用例，含 release/缺 buildInfo → hidden 隔离锁定）。
Test: node --test tests/overlay-view.test.js → 8 pass。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: overlay.js 接入 overlay-view + 空态启动入口

**Files:**
- Modify: `core/content/overlay.js`

> overlay.js 是 DOM/chrome 重耦合的 content script（Plan 2 起无 JS 单测，纯逻辑已由 Task 1 的 overlay-view 单测覆盖）。本 Task 验证 = `node --check` 语法 + chrome 手验（留大脑一起验，见验证文档）。

- [ ] **Step 1: 头部声明 VIEW + composing，删本地 activeWorkflow**

Edit 1 — 在 `let root = null;` 后追加状态与模块引用：

替换：
```javascript
  const STORAGE_KEY = 'as_workflow_state';
  const TOTAL_STEPS = 13;
  let root = null;
```
为：
```javascript
  const STORAGE_KEY = 'as_workflow_state';
  const TOTAL_STEPS = 13;
  let root = null;
  let composing = false;                       // 空态启动入口本地 UI 状态（是否展开 label 输入框）
  const VIEW = window.__AS_OVERLAY_VIEW__;     // 视图决策纯逻辑（overlay-view.js，content 顺序保证先加载）
```

Edit 2 — 删本地 `activeWorkflow`（已移入 overlay-view.js）：

删除整段：
```javascript
  // 首版单 workflow：取 running/paused/error 那个（done/aborted 不显示）
  function activeWorkflow(batch) {
    const wfs = (batch && batch.workflows) || [];
    return wfs.find(w => w && ['running', 'paused', 'error'].includes(w.status)) || null;
  }
```

- [ ] **Step 2: render 改用 decideOverlayView 分派 + 新增 renderIdle/bindIdleActions**

Edit 3 — 替换 `render` 函数：

替换：
```javascript
  function render(batch) {
    const wf = activeWorkflow(batch);
    if (!wf) { hide(); return; }
    injectStyles();
    const el = ensureRoot();
    const step = wf.steps[wf.cursor] || {};
    let html = `<div class="aso-progress">编排进度 <b>${wf.cursor + 1}/${TOTAL_STEPS}</b> · <span class="aso-step">${step.label || ''}</span></div>`;
    html += renderBody(wf, step);
    el.innerHTML = html;
    bindActions(el, wf);
    el.classList.add('show');
  }
```
为：
```javascript
  // 空态启动入口（无 active workflow + dev）：默认「开始流水线」按钮 → 点击展开 label 输入框 → 发 WF_START。spec §8。
  function renderIdle() {
    injectStyles();
    const el = ensureRoot();
    if (composing) {
      el.innerHTML =
        `<div style="margin-bottom:6px;font-weight:600;">开始流水线</div>` +
        `<input class="aso-field" id="aso-start-label" type="text" placeholder="商品 label（必填）"/>` +
        `<div><button class="aso-btn aso-btn-ok" data-act="start-go">开始</button>` +
        `<button class="aso-btn aso-btn-no" data-act="start-cancel">取消</button></div>`;
      bindIdleActions(el);
      const input = el.querySelector('#aso-start-label');
      if (input) input.focus();
    } else {
      el.innerHTML = `<button class="aso-btn aso-btn-go" data-act="start-open">▶ 开始流水线</button>`;
      bindIdleActions(el);
    }
    el.classList.add('show');
  }

  function bindIdleActions(el) {
    el.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'start-open') { composing = true; renderIdle(); }
        else if (act === 'start-cancel') { composing = false; renderIdle(); }
        else if (act === 'start-go') {
          const input = el.querySelector('#aso-start-label');
          const label = VIEW.normalizeStartLabel(input ? input.value : '');
          if (!label) { if (input) input.focus(); return; }   // label 必填，空则不发
          send('WF_START', { label });
          composing = false;   // 等 storage 驱动切到 active 进度条；过渡先回按钮态
          renderIdle();
        }
      });
    });
  }

  function render(batch) {
    const decision = VIEW.decideOverlayView(batch, window.__AS_BUILD_INFO__);
    if (decision.view === 'hidden') { composing = false; hide(); return; }   // release 沉睡 / 无入口
    if (decision.view === 'idle') { renderIdle(); return; }                  // dev 空态 → 启动入口
    // 'active'：有运行中 workflow → 进度 / HITL / error（Plan 2 现状）
    composing = false;
    const wf = decision.workflow;
    injectStyles();
    const el = ensureRoot();
    const step = wf.steps[wf.cursor] || {};
    let html = `<div class="aso-progress">编排进度 <b>${wf.cursor + 1}/${TOTAL_STEPS}</b> · <span class="aso-step">${step.label || ''}</span></div>`;
    html += renderBody(wf, step);
    el.innerHTML = html;
    bindActions(el, wf);
    el.classList.add('show');
  }
```

- [ ] **Step 3: node --check 语法**

Run: `node --check core/content/overlay.js`
Expected: exit 0（无输出）

- [ ] **Step 4: commit**

```bash
git add core/content/overlay.js
git commit -m "$(cat <<'EOF'
feat(plan3): overlay 空态「开始流水线」启动入口（WF_START）

Why: 解 Plan 2 缺口——WF_START 仅能 SW console 手调，整条流水线无正经触发入口（spec §8）。
What: overlay.js 改用 overlay-view.decideOverlayView 分派三态；无 active workflow 且 isDev
      → renderIdle 启动入口（「▶ 开始流水线」按钮 → 展开 label 输入框 → normalizeStartLabel
      校验 → send WF_START{label}）；删本地 activeWorkflow（移入 overlay-view）。
      release（isDev=false）空态仍 hidden，沉睡行为同 Plan 2（发版隔离 dead code，同 OPEN_MONITOR 先例）。
Test: node --check core/content/overlay.js → exit 0；纯逻辑由 overlay-view 单测覆盖；chrome 手验留大脑一起。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: build 注册 overlay-view + 全量回归 + 验证文档

**Files:**
- Modify: `build/build_extension.py`（content_scripts 列表）
- Create: `docs/superpowers/2026-06-11-plan3-overlay-wf-start-verification.md`

> `core/content/` 由 `copy_core_assets()` 的 `shutil.copytree` 整目录拷贝 → 新建的 `overlay-view.js` 自动进 `dist/extension/content/`，**无需改拷贝逻辑**；只需注册进 manifest 的 content_scripts js 数组（排在 overlay.js 前，因 overlay.js 引用 `window.__AS_OVERLAY_VIEW__`）。

- [ ] **Step 1: content_scripts 列表加 overlay-view（插 overlay 前）**

Edit — 替换：
```python
    # build-info.js 必须最先注入，让 ui.js 能读到 window.__AS_BUILD_INFO__
    content_scripts_js = (
        # overlay.js（编排消费端 HITL 浮层）插 registry 后 core 前：归入 core 体系；自驱 IIFE 不依赖加载顺序
        ['content/build-info.js', 'content/utils.js', 'content/ui.js', 'content/registry.js', 'content/overlay.js', 'content/core.js']
        + [f'features/{f["id"]}/{f["content_script"]}' for f in sorted(features, key=lambda x: x.get('order', 999))]
```
为：
```python
    # build-info.js 必须最先注入，让 ui.js / overlay 能读到 window.__AS_BUILD_INFO__
    content_scripts_js = (
        # overlay-view.js（视图决策纯逻辑）→ overlay.js（HITL 浮层 + 启动入口）插 registry 后 core 前：
        # 归入 core 体系；overlay.js 引用 window.__AS_OVERLAY_VIEW__，故 overlay-view 必须排在 overlay 前。
        ['content/build-info.js', 'content/utils.js', 'content/ui.js', 'content/registry.js',
         'content/overlay-view.js', 'content/overlay.js', 'content/core.js']
        + [f'features/{f["id"]}/{f["content_script"]}' for f in sorted(features, key=lambda x: x.get('order', 999))]
```

- [ ] **Step 2: dev build 确认 overlay-view 拷贝 + 注册**

Run: `python3 build/build_extension.py`
Expected: `[build] manifest.json generated  (8 features, 15 content scripts)`（14→15）；`ls dist/extension/content/overlay-view.js` 存在。

- [ ] **Step 3: 全量 JS 回归**

Run: `node --test tests/*.test.js`
Expected: 79 pass / 0 fail（Plan 3 第二刀 71 + 本刀 overlay-view 8）。⚠ 必须 `tests/*.test.js` 不是整目录。

- [ ] **Step 4: 全量 Python 回归（不回归）**

Run: `python3 -m pytest tests/`
Expected: 43 passed（本刀不动 Python）。

- [ ] **Step 5: Write 验证文档**

Create `docs/superpowers/2026-06-11-plan3-overlay-wf-start-verification.md`（结果表数字填 Step 2-4 实际输出）：

````markdown
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
````

- [ ] **Step 6: commit**

```bash
git add build/build_extension.py docs/superpowers/2026-06-11-plan3-overlay-wf-start-verification.md
git commit -m "$(cat <<'EOF'
docs(plan3): 第三刀 overlay 启动入口 build 注册 + 验证文档 + 全量回归

Why: overlay-view.js 需注册进 manifest content_scripts（排 overlay 前）；本刀收尾验证。
What: build_extension.py content_scripts 加 overlay-view.js（copytree 已自动拷贝，仅注册）；
      验证文档（自动化结果 + chrome 手验 + 发版隔离论证）。
Test: node --test tests/*.test.js → 79 pass；pytest tests/ → 43 passed；dev build 8 features/15 cs。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
