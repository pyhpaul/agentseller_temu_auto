# 2-2c 业务页 HITL 浮层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本 plan 实现留新会话**（浮层是大 UI 工程 + 需 chrome 验证 HITL 交互，值得充足 context）。调研已完成（spec §5.3/§6.2 + ui.js 注入机制 + bg message 路由），方案已成型。

**Goal:** 给所有业务页（Temu/店小秘/1688/kuajingmaihuo）注入一个 HITL 浮层（与 FAB/Panel 同级），让人在业务页就地看编排进度 + 处理 HITL（前往/确认/回填/拒绝）+ 处理 error（重试/转人工）。这是 Plan 2-2 第三刀的核心部分（2-2c-1）；WS 架子（2-2c-2）并入 Plan 3。

**Architecture:** core 新组件 `core/content/overlay.js`，作为 content script 注入（与 ui.js 同 matches）。**只读 `chrome.storage.local['as_workflow_state']` + 发 message（WF_*），不连 WS（绕 CSP）**。订阅 `storage.onChanged` 全量重渲。bg 侧 HITL 流转 + message 路由已就绪（2-2a），浮层是纯消费端；唯一新增 bg 改动 = `WF_RETRY` handler（重置 step→pending + advance，spec §6.2 重试用）。首版单 workflow（取 workflows 里 running/paused/error 那个）。

**Tech Stack:** Chrome MV3 content script（隔离世界，不受页面 CSP）；`chrome.storage.onChanged`；`chrome.runtime.sendMessage`；复用 ui.js 的样式 token 模式。

---

## 关键决策

- **D1 独立组件 overlay.js（非塞 ui.js）**：浮层职责独立（编排消费端），单独文件。加入 core content script 序列（manifest），自驱 IIFE init（同 ui.js 不依赖 core.js 显式调，或 core.js 加一行——按现有 core.js 装配模式定）。
- **D2 只读 storage + 发 message，不连 WS**：浮层读 `as_workflow_state`、发 `WF_HITL_CONFIRM/REJECT/RETRY`，绝不直接写 storage（spec §2.3 唯一写入者=bg）、不连 WS（绕 CSP）。
- **D3 单 workflow（首版）**：`activeWorkflow(batch)` = `workflows.find(w => ['running','paused','error'].includes(w.status))`。多 workflow 留后续。
- **D4 全量重渲**：`storage.onChanged[as_workflow_state]` → render 整个浮层。浮层简单（进度条 + 一个弹窗），无需增量。
- **D5 重试需 bg 新增 WF_RETRY**：spec §6.2「重试 = 重置 step→pending→advance」。bg 现有 WF_START/CONFIRM/REJECT/ABORT 无重试 → 加 `orchRetry(workflowId)`（step.status=pending/error=null/committing=false + wf.status=running + advance）+ WF_RETRY message。
- **D6 回填控件按 fieldType 渲染**：纯确认型（无 editable）→ [确认完成] 发 `result:{}`；回填型（editable=true）→ 按 `fieldType`（text/number/select+options）渲染输入 → [提交] 发 `result:{<key>:值}`。实现时核对 engine.js `buildHitl` 实际给的字段。

## Task 1: overlay.js 骨架（注入 + storage 订阅 + 迷你进度条）

**Files:**
- Create: `core/content/overlay.js`

- [ ] **Step 1: 创建 overlay.js 骨架**

```js
// core/content/overlay.js — 业务页 HITL 浮层（只读 storage + 发 message，不连 WS）。spec §5.3。
(function () {
  'use strict';
  const STORAGE_KEY = 'as_workflow_state';
  const TOTAL_STEPS = 13;
  let root = null;

  function send(type, data) {
    try { chrome.runtime.sendMessage({ type, data }); }
    catch (e) { console.warn('[overlay] sendMessage 失败', e); }
  }
  // 首版单 workflow：取 running/paused/error 那个
  function activeWorkflow(batch) {
    const wfs = (batch && batch.workflows) || [];
    return wfs.find(w => w && ['running', 'paused', 'error'].includes(w.status)) || null;
  }

  function injectStyles() {
    if (document.getElementById('as-overlay-style')) return;
    const s = document.createElement('style');
    s.id = 'as-overlay-style';
    s.textContent = `
      #as-overlay { position: fixed; right: 16px; bottom: 80px; z-index: 2147483646;
        width: 280px; font: 13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;
        background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 10px;
        box-shadow: 0 8px 28px rgba(0,0,0,.5); padding: 12px; display: none; }
      #as-overlay.show { display: block; }
      .aso-progress { font-size: 12px; color: #8b949e; margin-bottom: 8px; }
      .aso-step { font-weight: 600; color: #58a6ff; }
      .aso-btn { padding: 6px 12px; margin: 4px 4px 0 0; border-radius: 6px; border: none;
        cursor: pointer; font-size: 12px; }
      .aso-btn-go { background: #1f6feb; color: #fff; }
      .aso-btn-ok { background: #238636; color: #fff; }
      .aso-btn-no { background: #6e7681; color: #fff; }
      .aso-btn-retry { background: #9e6a03; color: #fff; }
      .aso-err { background: #2d1518; border: 1px solid #f85149; color: #ff7b72;
        padding: 6px 8px; border-radius: 6px; margin: 6px 0; font-size: 12px; }
      .aso-field { width: 100%; margin: 6px 0; padding: 6px; box-sizing: border-box;
        background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; }`;
    document.head.appendChild(s);
  }

  function ensureRoot() {
    if (root && document.body.contains(root)) return root;
    root = document.createElement('div');
    root.id = 'as-overlay';
    document.body.appendChild(root);
    return root;
  }
  function hide() { if (root) root.classList.remove('show'); }

  function render(batch) {
    const wf = activeWorkflow(batch);
    if (!wf) { hide(); return; }
    injectStyles();
    const el = ensureRoot();
    const step = wf.steps[wf.cursor] || {};
    let html = `<div class="aso-progress">编排进度 <b>${wf.cursor + 1}/${TOTAL_STEPS}</b> · <span class="aso-step">${step.label || ''}</span></div>`;
    html += renderBody(wf, step);   // Task2（paused HITL）+ Task3（error chip）填充
    el.innerHTML = html;
    bindActions(el, wf);            // Task2/3 实现
    el.classList.add('show');
  }

  // Task2/3 实现：paused → HITL 弹窗；error → error chip；running → 仅进度条
  function renderBody(wf, step) { return ''; }
  function bindActions(el, wf) { /* Task2/3 实现 */ }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) render(changes[STORAGE_KEY].newValue);
  });

  function init() {
    chrome.storage.local.get(STORAGE_KEY, obj => render(obj[STORAGE_KEY] || null));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
```

- [ ] **Step 2: node --check 语法**

Run: `node --check core/content/overlay.js`
Expected: 语法 OK（manifest 接线在 Task 4）。

> 注：进度条用深色 token（对齐 dashboard `:root`）；浮层 `right/bottom` 避开 FAB（FAB 在右下，浮层抬到 bottom:80px）。实现时核对 FAB 实际位置避免重叠。

---

## Task 2: HITL 弹窗（前往 + 纯确认 + 回填控件 + 拒绝）

**Files:**
- Modify: `core/content/overlay.js`（替换 Task 1 的 stub `renderBody`/`bindActions`）

- [ ] **Step 1: renderBody 加 paused HITL 分支**

```js
  function renderBody(wf, step) {
    if (wf.status === 'paused' && wf.hitl) {
      const h = wf.hitl;
      let b = `<div style="margin-bottom:6px;">待处理：<b>${h.action || step.label || '人工确认'}</b></div>`;
      if (h.keyValues && typeof h.keyValues === 'object') {
        b += '<div style="font-size:12px;color:#8b949e;margin-bottom:6px;">' +
          Object.entries(h.keyValues).map(([k, v]) => `${k}: ${v}`).join('<br/>') + '</div>';
      }
      // 回填型：editable → 按 fieldType 渲染控件
      if (h.editable) {
        if (h.fieldType === 'select' && Array.isArray(h.options)) {
          b += `<select class="aso-field" id="aso-input">` +
            h.options.map(o => `<option value="${o}">${o}</option>`).join('') + `</select>`;
        } else {
          b += `<input class="aso-field" id="aso-input" type="${h.fieldType === 'number' ? 'number' : 'text'}" placeholder="回填值"/>`;
        }
      }
      b += `<div>`;
      const goUrl = h.targetUrl || (step.target && step.target.url);
      if (goUrl) b += `<button class="aso-btn aso-btn-go" data-act="go">前往</button>`;
      b += `<button class="aso-btn aso-btn-ok" data-act="confirm">${h.editable ? '提交' : '确认完成'}</button>`;
      b += `<button class="aso-btn aso-btn-no" data-act="reject">拒绝</button></div>`;
      return b;
    }
    return '';   // running 仅进度条；error → Task 3
  }
```

- [ ] **Step 2: bindActions 实现（go/confirm/reject，retry 占位给 Task 3）**

```js
  function bindActions(el, wf) {
    const step = wf.steps[wf.cursor] || {};
    el.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'go') {
          const url = (wf.hitl && wf.hitl.targetUrl) || (step.target && step.target.url);
          if (url) window.open(url, '_blank');
        } else if (act === 'confirm') {
          let result = {};
          if (wf.hitl && wf.hitl.editable) {
            const input = el.querySelector('#aso-input');
            const val = input ? input.value : '';
            const key = wf.hitl.resultKey || 'value';   // ⚠ 核对 engine.js buildHitl 回填 key 字段名
            result = { [key]: val };
          }
          send('WF_HITL_CONFIRM', { workflowId: wf.id, result });
        } else if (act === 'reject') {
          send('WF_HITL_REJECT', { workflowId: wf.id });
        } else if (act === 'retry') {
          send('WF_RETRY', { workflowId: wf.id });
        }
      });
    });
  }
```

- [ ] **Step 3: node --check + dev build + chrome 冒烟**

Run: `node --check core/content/overlay.js`（装配在 Task 4）。chrome 冒烟：手搭 paused workflow（SW console set as_workflow_state status=paused + hitl）→ 业务页浮层弹「待处理」+ 前往/确认/拒绝。

> ⚠ **实现前核对 engine.js `buildHitl`**：确认 `hitl` 实际给的字段（action/keyValues/editable/fieldType/options/targetUrl/回填 resultKey）。本 plan 按 spec §5.1 契约设计，engine.js 实际字段为准（尤其回填型的 key 名）。回填型 HITL（返单价/比价/订单号）首版可能 engine.js 还没给全 editable 元数据——若缺，回填能力可降级为「前往 dashboard 改」或本 plan 附带补 engine.js buildHitl 的 editable/fieldType（小改）。

---

## Task 3: error 分层 chip + bg WF_RETRY handler

**Files:**
- Modify: `core/content/overlay.js`（renderBody 加 error 分支）
- Modify: `core/background/service-worker.js`（orchRetry + WF_RETRY message）

- [ ] **Step 1: overlay.js renderBody 加 error 分支**（在 paused 分支后、`return ''` 前）

```js
    if (wf.status === 'error') {
      const err = step.error || {};
      const catColor = { read: '#bc8cff', validate: '#d29922', business: '#f85149' }[err.category] || '#f85149';
      let b = `<div class="aso-err" style="border-color:${catColor};color:${catColor};">[${err.category || 'error'}] ${err.message || '步骤失败'}</div><div>`;
      if (err.recoverable) b += `<button class="aso-btn aso-btn-retry" data-act="retry">重试</button>`;
      b += `<button class="aso-btn aso-btn-no" data-act="reject">转人工</button></div>`;
      return b;
    }
```
（retry 按钮的 click 已在 Task 2 `bindActions` 处理 → 发 `WF_RETRY`。）

- [ ] **Step 2: service-worker.js 加 orchRetry**（在 orchSetAborted 附近）

```js
// 重试：重置当前 step→pending（清 error/committing）+ wf→running + advance（spec §6.2）
async function orchRetry(workflowId) {
  await orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf) return undefined;
    const step = wf.steps[wf.cursor];
    if (step) { step.status = 'pending'; step.error = null; step.committing = false; }
    wf.status = 'running'; wf.updatedAt = Date.now();
    return skeleton;
  });
  await orchEngine.advance(workflowId);
}
```

- [ ] **Step 3: service-worker.js 加 WF_RETRY message 路由**（在 WF_ABORT 分支后）

```js
  if (msg.type === 'WF_RETRY') {
    orchRetry((msg.data || {}).workflowId)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
```

- [ ] **Step 4: node --check 两文件 + node --test**

Run: `node --check core/content/overlay.js && node --check core/background/service-worker.js && node --test tests/*.test.js`
Expected: 语法 OK；JS 60 绿（orchRetry 是接线，可选补 engine 层重试单测）。

---

## Task 4: 装配（manifest core content script）+ 回归 + chrome 验证

**Files:**
- Modify: `build/build_extension.py`（core content script 列表加 overlay.js）

- [ ] **Step 1: build_extension.py core 文件列表加 overlay.js**

确认 `build_extension.py` 拼 manifest 的 core content script 列表（现：`utils.js`/`ui.js`/`registry.js`/`core.js`）。把 `overlay.js` 加入——建议排 `registry.js` 之后、`core.js` 之前（overlay 自驱 IIFE 不依赖加载顺序，但放 core 体系内一致）。

- [ ] **Step 2: dev build 确认 overlay.js 进 manifest**

Run: `python3 build/build_extension.py`
Expected: 成功；`grep overlay dist/extension/manifest.json` 命中（core content scripts 含 overlay.js，各业务页 matches）。

- [ ] **Step 3: 全量回归**

Run: `node --test tests/*.test.js && python3 -m pytest tests/ -q`
Expected: JS 60+ 绿；Python 20 绿。

- [ ] **Step 4: chrome 端到端验证**

1. reload 扩展 → 业务页（Temu/店小秘）应见浮层进度条（先 SW console `orchStartWorkflow` 建 workflow）。
2. HITL 步：workflow 到 select_product（paused）→ 浮层弹「待处理」+ [前往]/[确认完成]/[拒绝] → 点确认 → cursor 推进、浮层更新。
3. 回填型 HITL（如到达 get_return_price，若 engine 给 editable）→ 浮层显输入框 → 填值提交 → 下游 product 回填。
4. error：手搭 workflow.status=error + step.error{recoverable:true} → 浮层弹分层 chip + [重试] → 点重试 → WF_RETRY → step 重跑。
5. [前往] 点击 → 打开 step.target.url。

- [ ] **Step 5: commit + 更新 memory**

```bash
git add core/content/overlay.js core/background/service-worker.js build/build_extension.py
git commit -m "feat(orchestrator): 业务页 HITL 浮层（2-2c-1：进度条+前往+确认/回填/拒绝+重试）"
```
memory 加 2-2c-1 浮层完成 bullet；下一步 2-2c-2 WS 架子（并 Plan 3）。

---

## 自检清单

- **只读 storage + 发 message**（WF_HITL_CONFIRM/REJECT/RETRY），绝不直接写 storage ✓
- **不连 WS**（绕 CSP）✓
- **单 workflow**（activeWorkflow 取 running/paused/error）✓
- **回填 key** 实现时核对 engine.js buildHitl 实际字段 ⚠
- **重试** 需 bg WF_RETRY（本 plan Task 3 补）✓
- **WS 架子（2-2c-2）不在本 plan**（并 Plan 3）✓
- **浮层位置** 避开 FAB（实现时核对）⚠
