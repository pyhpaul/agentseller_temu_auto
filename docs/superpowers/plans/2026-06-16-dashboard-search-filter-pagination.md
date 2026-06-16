# Dashboard 商品搜索 + 多维筛选 + 分页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 automation dashboard 的 queue-list 加商品名搜索 + 四维筛选（状态/步骤/利润率）+ 扁平分页，商品多时可定位。

**Architecture:** 筛选是纯 UI 状态、不进 store。两个 UMD 纯函数（`filterWorkflows`/`paginate`，node 可测）+ 一个 filter-bar DOM 组件 + queue-list 改扁平分页 + dashboard.js 持 `filterCriteria`/`page` 局部 state 串联。dev-only mock fixture（`?mock=N`）灌假数据测列表规模。

**Tech Stack:** 原生 JS（无框架）。纯函数走 UMD classic（仿 `automation/dashboard/state/select-active.js`），挂 `window.__AS_DASH_*`，`node --test` 测；DOM 组件走 ES module + `h()` 构建（仿 `automation/dashboard/components/queue-list.js`）。

**Spec:** `docs/superpowers/specs/2026-06-16-dashboard-search-filter-pagination-design.md`

---

## File Structure

| 文件 | 动作 | 责任 |
|------|------|------|
| `automation/dashboard/state/filter-workflows.js` | Create | `filterWorkflows(workflows, criteria)` AND 过滤纯函数 |
| `automation/dashboard/state/paginate.js` | Create | `paginate(list, page, pageSize)` 切页纯函数 |
| `automation/dashboard/components/filter-bar.js` | Create | `renderFilterBar(mountEl, criteria, uiState, stepOptions, onChange)` |
| `automation/dashboard/components/queue-list.js` | Modify | 改扁平列表 + 分页控件（去 groupWorkflows） |
| `automation/dashboard/mock/mock-workflows.js` | Create | `buildMockBatch(n)` dev-only fixture |
| `automation/dashboard/dashboard.js` | Modify | 持 criteria/page、串联过滤分页、`?mock=N` |
| `automation/dashboard/dashboard.html` | Modify | classic script 段加 filter-workflows.js + paginate.js |
| `tests/dashboard-filter-workflows.test.js` | Create | filterWorkflows 单测 |
| `tests/dashboard-paginate.test.js` | Create | paginate 单测 |

**约定**：`criteria = { text:'', statuses:[], stepId:null, marginMin:null, marginMax:null }`；`grossMargin` 存小数（0.35），criteria 的 margin 是百分比数值（35）。`PAGE_SIZE = 20`。

---

## Task 1: filterWorkflows 纯函数

**Files:**
- Create: `automation/dashboard/state/filter-workflows.js`
- Test: `tests/dashboard-filter-workflows.test.js`

- [ ] **Step 1: 写失败测试**

```js
// tests/dashboard-filter-workflows.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { filterWorkflows } = require('../automation/dashboard/state/filter-workflows.js');

const wf = (over) => Object.assign({
  id: 'w', product: { label: '保温杯', grossMargin: null },
  status: 'running', cursor: 0,
  steps: [{ id: 'select_product' }, { id: 'publish' }],
}, over);

test('空 criteria → 返回全部', () => {
  const list = [wf(), wf({ id: 'w2' })];
  assert.strictEqual(filterWorkflows(list, {}).length, 2);
});

test('text：子串匹配 product.label、不区分大小写', () => {
  const list = [wf({ product: { label: 'ABC杯' } }), wf({ product: { label: '雨伞' } })];
  assert.strictEqual(filterWorkflows(list, { text: 'abc' }).length, 1);
});

test('text：label 为空 + 有 text → 不匹配', () => {
  assert.strictEqual(filterWorkflows([wf({ product: { label: '' } })], { text: 'x' }).length, 0);
});

test('statuses：命中状态；空数组=全部', () => {
  const list = [wf({ status: 'running' }), wf({ status: 'paused' })];
  assert.strictEqual(filterWorkflows(list, { statuses: ['paused'] }).length, 1);
  assert.strictEqual(filterWorkflows(list, { statuses: [] }).length, 2);
});

test('stepId：匹配当前 cursor step.id', () => {
  const list = [wf({ cursor: 0 }), wf({ id: 'w2', cursor: 1 })];   // w 在 select_product，w2 在 publish
  assert.strictEqual(filterWorkflows(list, { stepId: 'publish' }).length, 1);
  assert.strictEqual(filterWorkflows(list, { stepId: 'publish' })[0].id, 'w2');
});

test('margin：区间匹配 grossMargin（百分比）；无 grossMargin 设了区间→排除', () => {
  const list = [
    wf({ product: { label: 'a', grossMargin: 0.35 } }),   // 35%
    wf({ product: { label: 'b', grossMargin: 0.10 } }),   // 10%
    wf({ product: { label: 'c', grossMargin: null } }),   // 无
  ];
  assert.strictEqual(filterWorkflows(list, { marginMin: 20 }).length, 1);          // 仅 35%
  assert.strictEqual(filterWorkflows(list, { marginMax: 20 }).length, 1);          // 仅 10%
  assert.strictEqual(filterWorkflows(list, { marginMin: 0, marginMax: 100 }).length, 2);  // 排除 null
});

test('AND 叠加：多维同时生效', () => {
  const list = [
    wf({ product: { label: '保温杯', grossMargin: 0.35 }, status: 'paused' }),
    wf({ id: 'w2', product: { label: '保温杯', grossMargin: 0.05 }, status: 'paused' }),
  ];
  assert.strictEqual(filterWorkflows(list, { text: '杯', statuses: ['paused'], marginMin: 20 }).length, 1);
});

test('无 steps / 空入参兜底不崩', () => {
  assert.deepStrictEqual(filterWorkflows(null, {}), []);
  assert.strictEqual(filterWorkflows([wf({ steps: undefined })], { stepId: 'x' }).length, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/dashboard-filter-workflows.test.js`
Expected: FAIL — `filterWorkflows is not a function`（模块未建）

- [ ] **Step 3: 实现**

```js
// automation/dashboard/state/filter-workflows.js
// 商品列表多维过滤（AND 叠加）。纯函数、UMD 双模式（node 单测 + 浏览器 window.__AS_DASH_FILTER__）。
// criteria = { text, statuses[], stepId, marginMin, marginMax }；grossMargin 存小数，criteria.margin 是百分比。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.__AS_DASH_FILTER__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function matchText(wf, text) {
    if (!text) return true;
    const label = (wf.product && wf.product.label) || '';
    return label.toLowerCase().includes(String(text).toLowerCase());
  }
  function matchStatus(wf, statuses) {
    if (!statuses || statuses.length === 0) return true;
    return statuses.includes(wf.status);
  }
  function matchStep(wf, stepId) {
    if (!stepId) return true;
    const cur = (wf.steps || [])[wf.cursor];
    return !!cur && cur.id === stepId;
  }
  function matchMargin(wf, min, max) {
    if (min == null && max == null) return true;
    const gm = wf.product && wf.product.grossMargin;
    if (gm == null) return false;                    // 设了区间但无 grossMargin → 排除
    const pct = gm * 100;
    if (min != null && pct < min) return false;
    if (max != null && pct > max) return false;
    return true;
  }
  function filterWorkflows(workflows, criteria) {
    const c = criteria || {};
    return (workflows || []).filter(wf =>
      matchText(wf, c.text) && matchStatus(wf, c.statuses) &&
      matchStep(wf, c.stepId) && matchMargin(wf, c.marginMin, c.marginMax));
  }
  return { filterWorkflows };
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/dashboard-filter-workflows.test.js`
Expected: PASS（8 tests）

- [ ] **Step 5: Commit**

```bash
git add automation/dashboard/state/filter-workflows.js tests/dashboard-filter-workflows.test.js
git commit -m "feat(dashboard): filterWorkflows 多维过滤纯函数"
```

---

## Task 2: paginate 纯函数

**Files:**
- Create: `automation/dashboard/state/paginate.js`
- Test: `tests/dashboard-paginate.test.js`

- [ ] **Step 1: 写失败测试**

```js
// tests/dashboard-paginate.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { paginate } = require('../automation/dashboard/state/paginate.js');

const L = (n) => Array.from({ length: n }, (_, i) => i + 1);

test('正常切页：第 1 页取前 pageSize 个', () => {
  const r = paginate(L(50), 1, 20);
  assert.deepStrictEqual(r.items, L(20));
  assert.strictEqual(r.page, 1);
  assert.strictEqual(r.totalPages, 3);
  assert.strictEqual(r.total, 50);
});

test('末页不足 pageSize', () => {
  const r = paginate(L(50), 3, 20);
  assert.strictEqual(r.items.length, 10);   // 41..50
  assert.strictEqual(r.items[0], 41);
});

test('page 越界 → 钳到末页', () => {
  const r = paginate(L(50), 99, 20);
  assert.strictEqual(r.page, 3);
  assert.strictEqual(r.items[0], 41);
});

test('page < 1 → 钳到 1', () => {
  assert.strictEqual(paginate(L(50), 0, 20).page, 1);
  assert.strictEqual(paginate(L(50), -5, 20).page, 1);
});

test('空列表 → totalPages=1, items=[]', () => {
  const r = paginate([], 1, 20);
  assert.deepStrictEqual(r.items, []);
  assert.strictEqual(r.totalPages, 1);
  assert.strictEqual(r.total, 0);
});

test('恰好整除', () => {
  assert.strictEqual(paginate(L(40), 2, 20).totalPages, 2);
});

test('非数组 / pageSize 非法兜底', () => {
  assert.deepStrictEqual(paginate(null, 1, 20).items, []);
  assert.strictEqual(paginate(L(5), 1, 0).items.length, 5);   // pageSize<=0 → 默认 20
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/dashboard-paginate.test.js`
Expected: FAIL — `paginate is not a function`

- [ ] **Step 3: 实现**

```js
// automation/dashboard/state/paginate.js
// 列表切页纯函数。UMD 双模式（node 单测 + 浏览器 window.__AS_DASH_PAGINATE__）。
// 返回 {items, page, totalPages, total}；page 越界钳制、空列表 totalPages=1。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.__AS_DASH_PAGINATE__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function paginate(list, page, pageSize) {
    const arr = Array.isArray(list) ? list : [];
    const size = pageSize > 0 ? pageSize : 20;
    const total = arr.length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const p = Math.min(Math.max(1, (page | 0) || 1), totalPages);
    const start = (p - 1) * size;
    return { items: arr.slice(start, start + size), page: p, totalPages, total };
  }
  return { paginate };
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/dashboard-paginate.test.js`
Expected: PASS（7 tests）

- [ ] **Step 5: Commit**

```bash
git add automation/dashboard/state/paginate.js tests/dashboard-paginate.test.js
git commit -m "feat(dashboard): paginate 切页纯函数"
```

---

## Task 3: filter-bar 组件

DOM 组件不单测（跟现有组件一致），靠 Task 6 的 mock fixture 人工验证。`h()` 把 `onInput/onChange/onClick` 转 addEventListener（见 `dom.js:10`）。**搜索框焦点恢复**：全量重渲会重建输入框，渲染末尾若焦点原在搜索框则 restore（否则没法连续打字）。

**Files:**
- Create: `automation/dashboard/components/filter-bar.js`

- [ ] **Step 1: 实现 renderFilterBar**

```js
// filter-bar.js — 商品列表过滤栏：搜索框 + 状态 chips（常驻）+ 折叠面板（步骤下拉 + 利润率区间）。
// onChange(newCriteria, newUiState) 通知 dashboard；dashboard 持 criteria/uiState，本组件每次全量重建。
// 搜索框焦点：重建会丢焦点，渲染末尾若原焦点在搜索框则 restore（光标置回原位）。
import { h, icon } from './dom.js';

const STATUS_OPTS = [
  { v: 'pending', t: '待处理' }, { v: 'running', t: '运行中' }, { v: 'paused', t: '待确认' },
  { v: 'error', t: '出错' }, { v: 'done', t: '已完成' }, { v: 'aborted', t: '已中止' },
];

export function renderFilterBar(mountEl, criteria, uiState, stepOptions, onChange) {
  const c = criteria;
  const emit = (patch) => onChange(Object.assign({}, c, patch), uiState);
  const emitUi = (patch) => onChange(c, Object.assign({}, uiState, patch));

  // 重建前记录搜索框焦点状态（contains 判当前 active 是否本组件搜索框）
  const ae = document.activeElement;
  const hadFocus = ae && ae.classList && ae.classList.contains('flt-search') && mountEl.contains(ae);
  const caret = hadFocus ? ae.selectionStart : null;

  const search = h('input', {
    class: 'flt-search', type: 'text', placeholder: '🔍 搜索商品名', value: c.text || '',
    onInput: (e) => emit({ text: e.target.value }),
  });

  const allActive = !c.statuses || c.statuses.length === 0;
  const chips = [
    h('div', { class: 'flt-chip' + (allActive ? ' on' : ''), onClick: () => emit({ statuses: [] }) }, '全部'),
    ...STATUS_OPTS.map(o => {
      const on = (c.statuses || []).includes(o.v);
      return h('div', { class: 'flt-chip' + (on ? ' on' : ''), onClick: () => {
        const set = new Set(c.statuses || []);
        on ? set.delete(o.v) : set.add(o.v);
        emit({ statuses: [...set] });
      } }, o.t);
    }),
  ];

  const moreCount = (c.stepId ? 1 : 0) + ((c.marginMin != null || c.marginMax != null) ? 1 : 0);
  const toggle = h('div', { class: 'flt-more', onClick: () => emitUi({ panelOpen: !uiState.panelOpen }) },
    [icon('ic-chevron'), ` 更多筛选 (${moreCount})`]);

  const children = [search, h('div', { class: 'flt-chips' }, chips), toggle];

  if (uiState.panelOpen) {
    const stepSel = h('select', { class: 'flt-step', onChange: (e) => emit({ stepId: e.target.value || null }) },
      [h('option', { value: '' }, '全部步骤'),
       ...(stepOptions || []).map(s => h('option', s.id === c.stepId ? { value: s.id, selected: 'selected' } : { value: s.id }, s.label))]);
    const mMin = h('input', { class: 'flt-margin', type: 'number', placeholder: 'min',
      value: c.marginMin != null ? String(c.marginMin) : '',
      onInput: (e) => emit({ marginMin: e.target.value === '' ? null : Number(e.target.value) }) });
    const mMax = h('input', { class: 'flt-margin', type: 'number', placeholder: 'max',
      value: c.marginMax != null ? String(c.marginMax) : '',
      onInput: (e) => emit({ marginMax: e.target.value === '' ? null : Number(e.target.value) }) });
    children.push(h('div', { class: 'flt-panel' }, [
      h('div', { class: 'flt-row' }, ['步骤 ', stepSel]),
      h('div', { class: 'flt-row' }, ['利润率 ', mMin, ' ~ ', mMax, ' %']),
    ]));
  }

  mountEl.replaceChildren(h('div', { class: 'filter-bar' }, children));

  if (hadFocus) { search.focus(); if (caret != null) try { search.setSelectionRange(caret, caret); } catch (e) {} }
}
```

- [ ] **Step 2: Commit**（无单测，下个 Task 一起 build 验证）

```bash
git add automation/dashboard/components/filter-bar.js
git commit -m "feat(dashboard): filter-bar 过滤栏组件（搜索+状态chips+折叠面板）"
```

---

## Task 4: queue-list 改扁平列表 + 分页

把 `renderQueueList` 从「按状态分三组」改成「接收已过滤分页的 items + 扁平渲染 + 分页控件」。`wfCard`/`miniBar`/`ST_DOT`/`ST_TEXT` 保留；删 `groupWorkflows`/`group`/`side-new`（新建入口已在 dashboard startBar）。

**Files:**
- Modify: `automation/dashboard/components/queue-list.js`

- [ ] **Step 1: 替换文件内容**

```js
// queue-list.js — L1 队列侧栏：接收已过滤+分页的 workflow 列表，扁平渲染 wf-card + 分页控件。
// 过滤/分页在 dashboard.js（filterWorkflows + paginate）；本组件只渲染结果。点 card 切 activeWorkflowId。
import { h, icon } from './dom.js';

const ST_DOT = {
  pending: 'var(--st-pending)', running: 'var(--st-running)', paused: 'var(--st-paused)',
  error: 'var(--st-error)', done: 'var(--st-done)', aborted: 'var(--st-skipped)',
};
const ST_TEXT = {
  pending: '待处理', running: '运行中', paused: '待确认',
  error: '出错', done: '已完成', aborted: '已中止',
};

function miniBar(steps) {
  return h('div', { class: 'mini-bar' }, steps.map(s =>
    h('i', { class: s.status === 'done' ? 'done' : (s.status === 'running' || s.status === 'paused') ? 'run' : '' })));
}

function wfCard(w, activeId, onSelect) {
  const steps = w.steps || [];
  const doneCount = steps.filter(s => s.status === 'done').length;
  return h('div', {
    class: 'wf-card' + (w.id === activeId ? ' active' : ''),
    onClick: () => onSelect(w.id),
  }, [
    h('div', { class: 'name' }, w.product?.label || w.id),
    h('div', { class: 'meta' }, [
      h('span', { class: 'st' }, [
        h('span', { class: 'd', style: 'background:' + (ST_DOT[w.status] || ST_DOT.pending) }),
        ST_TEXT[w.status] || w.status,
      ]),
      h('span', {}, `环节 ${doneCount}/${steps.length}`),
    ]),
    miniBar(steps),
  ]);
}

function pager(page, totalPages, total, onPageChange) {
  return h('div', { class: 'pager' }, [
    h('button', { class: 'pg-btn', disabled: page <= 1 ? 'disabled' : null,
      onClick: () => { if (page > 1) onPageChange(page - 1); } }, '‹'),
    h('span', { class: 'pg-info' }, `${page}/${totalPages}`),
    h('button', { class: 'pg-btn', disabled: page >= totalPages ? 'disabled' : null,
      onClick: () => { if (page < totalPages) onPageChange(page + 1); } }, '›'),
    h('span', { class: 'pg-total' }, `共 ${total}`),
  ]);
}

// paged = { items, page, totalPages, total }（dashboard 传入已过滤分页结果）
export function renderQueueList(mountEl, paged, activeId, onSelect, onPageChange) {
  const { items, page, totalPages, total } = paged;
  const body = items.length
    ? items.map(w => wfCard(w, activeId, onSelect))
    : [h('div', { class: 'side-empty' }, '无匹配商品')];
  mountEl.replaceChildren(h('div', { class: 'queue-flat' }, [
    ...body,
    pager(page, totalPages, total, onPageChange),
  ]));
}
```

- [ ] **Step 2: Commit**

```bash
git add automation/dashboard/components/queue-list.js
git commit -m "refactor(dashboard): queue-list 改扁平列表+分页（去三组分组）"
```

---

## Task 5: dashboard.js 协调 + mock fixture + html/css

串联：dashboard.js 持 `filterCriteria`/`filterUi`/`page`，在 `#queue-list` 内建 filterBar + list 两个挂载点，每次渲染走 filterWorkflows→sort→paginate。`?mock=N` 灌假数据。

**Files:**
- Create: `automation/dashboard/mock/mock-workflows.js`
- Modify: `automation/dashboard/dashboard.html`
- Modify: `automation/dashboard/dashboard.js`
- Modify: `automation/dashboard/dashboard.css`

- [ ] **Step 1: 建 mock fixture**

```js
// mock/mock-workflows.js — dev-only UI 测试 fixture。生成 N 个多样 workflow 灌 store 测搜索/筛选/分页。
// 不碰真实 storage、不连 WS、不伪装运行状态（区别于已删的 WS 大脑流 mock 回放）。release 不装配 automation→天然无。
const STEP_DEFS = [
  ['select_product', '选品'], ['collect_dxm', '店小秘采集建品'], ['publish', '合规预检+发布'],
  ['get_return_price', '获取返单价'], ['compare_1688', '1688比价核价'], ['confirm_declare_price', '确认申报价格'],
  ['order_1688', '1688下单'], ['gen_label', '货号+标签+合规+标签图'], ['create_sku', '建店小秘SKU'],
  ['create_po', '创建采购单'], ['wait_payment', '等财务付款'], ['wait_arrival', '等到货'],
  ['pack_label', '打印打包标签'], ['ship', '确认发货'],
];
const STATUSES = ['pending', 'running', 'paused', 'error', 'done', 'aborted'];

function mockSteps(cursor, wfStatus) {
  return STEP_DEFS.map(([id, label], i) => ({
    id, label,
    status: i < cursor ? 'done'
      : i === cursor ? (wfStatus === 'done' ? 'done' : wfStatus === 'paused' ? 'paused' : 'running')
      : 'pending',
  }));
}

export function buildMockBatch(n) {
  const workflows = [];
  for (let i = 0; i < n; i++) {
    const status = STATUSES[i % STATUSES.length];
    const cursor = i % 14;
    // 走过 ⑥ confirm_declare_price（index 5）的才给 grossMargin（模拟核价过的）
    const grossMargin = cursor > 5 ? ((i % 9) * 5 + 5) / 100 : null;   // 0.05~0.45
    workflows.push({
      id: 'mock_' + i,
      product: { label: '测试商品 ' + (i + 1), grossMargin },
      status, cursor, steps: mockSteps(cursor, status),
      updatedAt: 1000 + i, hitl: null, tmpTabs: [],
    });
  }
  return {
    schemaVersion: 1,
    batch: { id: 'mock_batch', createdAt: 1000, activeWorkflowId: workflows[0] ? workflows[0].id : null, workflows },
  };
}
```

- [ ] **Step 2: dashboard.html 加纯函数 classic script**

在 `<script src="components/select-active.js"></script>`（line 11）**之后**插入两行：

```html
<script src="state/filter-workflows.js"></script>
<script src="state/paginate.js"></script>
```

- [ ] **Step 3: dashboard.js 改动**

3a. import 段（line 5 `renderQueueList` import 后、line 11 后）加：
```js
import { renderFilterBar } from './components/filter-bar.js';
import { buildMockBatch } from './mock/mock-workflows.js';
```

3b. window 全局解构（line 14 `selectActiveWorkflow` 后）加：
```js
const { filterWorkflows } = window.__AS_DASH_FILTER__;
const { paginate } = window.__AS_DASH_PAGINATE__;
const PAGE_SIZE = 20;
```

3c. 在 `let selectedStepId = null;`（line 70）后加过滤 state + 挂载点 + 回调 + renderQueue：
```js
// 过滤/分页：纯 UI 态，不进 store（spec §3）。filter-bar 与列表分别挂在 #queue-list 内两个子节点。
let filterCriteria = { text: '', statuses: [], stepId: null, marginMin: null, marginMax: null };
let filterUi = { panelOpen: false };
let page = 1;

const queueEl = document.getElementById('queue-list');
const filterBarMount = document.createElement('div');
const listMount = document.createElement('div');
queueEl.append(filterBarMount, listMount);

function onFilterChange(c, ui) { filterCriteria = c; filterUi = ui; page = 1; renderQueue(store.getState()); }
function onPageChange(p) { page = p; renderQueue(store.getState()); }

// 过滤 → updatedAt 倒序 → 分页 → 渲染 filter-bar + 扁平列表
function renderQueue(state) {
  const workflows = state.skeleton.batch.workflows || [];
  const activeId = state.skeleton.batch.activeWorkflowId;
  const stepOptions = (workflows[0]?.steps || []).map(s => ({ id: s.id, label: s.label }));
  renderFilterBar(filterBarMount, filterCriteria, filterUi, stepOptions, onFilterChange);
  const filtered = filterWorkflows(workflows, filterCriteria)
    .slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  renderQueueList(listMount, paginate(filtered, page, PAGE_SIZE), activeId, onSelectWorkflow, onPageChange);
}
```

3d. renderAll（line 97-105）里把 `renderQueueList(document.getElementById('queue-list'), state, onSelectWorkflow);`（line 100）替换为：
```js
  renderQueue(state);
```

3e. 启动段（line 113-115）把 `startStorageSource(store); startWsSource(store);` 替换为 `?mock` 分支：
```js
// ?mock=N：dev-only，灌 N 个假 workflow 测列表 UI，纯内存、不启真实数据源
const mockParam = new URLSearchParams(location.search).get('mock');
if (mockParam) {
  store.setSkeleton(buildMockBatch(parseInt(mockParam, 10) || 20));
} else {
  startStorageSource(store);
  startWsSource(store);
}
```

- [ ] **Step 4: dashboard.css 加样式**（追加到文件末尾，深色对齐现有 tokens）

```css
/* 过滤栏 + 分页 */
.filter-bar { padding: 8px 10px; border-bottom: 1px solid #30363d; display: flex; flex-direction: column; gap: 6px; }
.flt-search { width: 100%; padding: 5px 8px; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; font: 12px sans-serif; box-sizing: border-box; }
.flt-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.flt-chip { padding: 2px 8px; font-size: 11px; color: #8b949e; background: #161b22; border: 1px solid #30363d; border-radius: 10px; cursor: pointer; }
.flt-chip.on { color: #fff; background: #1f6feb; border-color: #1f6feb; }
.flt-more { font-size: 11px; color: #8b949e; cursor: pointer; display: flex; align-items: center; gap: 3px; }
.flt-more .ic { width: 12px; height: 12px; }
.flt-panel { display: flex; flex-direction: column; gap: 5px; padding-top: 4px; }
.flt-row { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #8b949e; }
.flt-step { flex: 1; padding: 3px 6px; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 5px; font-size: 11px; }
.flt-margin { width: 52px; padding: 3px 5px; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 5px; font-size: 11px; }
.queue-flat { display: flex; flex-direction: column; }
.side-empty { padding: 16px; text-align: center; color: #8b949e; font-size: 12px; }
.pager { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-top: 1px solid #30363d; font-size: 12px; color: #8b949e; }
.pg-btn { padding: 1px 8px; background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 5px; cursor: pointer; }
.pg-btn[disabled] { opacity: .4; cursor: default; }
.pg-total { margin-left: auto; }
```

- [ ] **Step 5: Commit**

```bash
git add automation/dashboard/mock/mock-workflows.js automation/dashboard/dashboard.html automation/dashboard/dashboard.js automation/dashboard/dashboard.css
git commit -m "feat(dashboard): 串联搜索筛选分页 + ?mock fixture + 过滤栏样式"
```

---

## Task 6: build + 人工验证

**Files:** 无（构建 + 验证）

- [ ] **Step 1: 全量测试**

Run: `node --test tests/*.test.js`
Expected: PASS（含新增 filterWorkflows 8 + paginate 7 = 旧 148 + 15 = 163）

- [ ] **Step 2: 构建**

Run: `python3 build/build_extension.py`
Expected: `done → dist/extension (automation=on)`，无报错

- [ ] **Step 3: 人工验证（mock fixture）**

1. Chrome reload 扩展 → 打开 dashboard，URL 末尾加 `?mock=50`
2. 验证：
   - 列表显示扁平 wf-card（非三组分组），底部分页 `1/3 共 50`，每页 20
   - 搜索框输入「商品 1」→ 实时过滤、可连续打字（焦点不丢）
   - 状态 chips 点「待确认」→ 只剩 paused 的；点「全部」→ 恢复
   - 「更多筛选」展开 → 步骤下拉选「确认申报价格」→ 只剩 cursor 在该步的
   - 利润率 min=20 → 只剩 grossMargin≥20% 的（无 grossMargin 的被排除）
   - 多条件叠加生效（AND）；无匹配显示「无匹配商品」
   - 翻页 ‹ › 正常；改任一筛选条件后页码重置为 1
3. 去掉 `?mock=50` 刷新 → 回到真实 storage 数据（mock 不污染）

- [ ] **Step 4: 完成**（无新 commit；如人工验证发现问题，回对应 Task 修）

---

## 验证清单（spec 覆盖自检）

| spec 要求 | 对应 Task |
|-----------|-----------|
| filterWorkflows AND 四维 | Task 1 |
| paginate 切页/越界/空 | Task 2 |
| filter-bar 搜索+状态chips+折叠面板 | Task 3 |
| queue-list 扁平+分页（去分组） | Task 4 |
| criteria 不进 store / dashboard 持局部 | Task 5 (3c) |
| updatedAt 倒序 + PAGE_SIZE 20 + criteria 变更重置页码 | Task 5 (3c, onFilterChange) |
| grossMargin 小数↔criteria 百分比换算 | Task 1 (matchMargin) |
| mock fixture ?mock=N 不污染 storage | Task 5 (Step 1, 3e) |
| 无匹配空态 | Task 4 (renderQueueList) |
