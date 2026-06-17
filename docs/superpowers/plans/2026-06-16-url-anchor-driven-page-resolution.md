# URL 锚点驱动取页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把编排器取页从「query 碰运气找当前 tab」升级为「凭 product 的 URL 锚点定位确切页面」，解 publish 死结、提快照命中率、加未登录检测。

**Architecture:** 数据契约加 `product.dxmEditUrl` 锚点字段（collect_dxm 人工填，可选向后兼容）；纯逻辑抽 `resolveAnchorUrl(step, product)` + `isUnauthUrl(url)` 便于单测；`resolvePageTab(step, wf, {navigate})` 统一收三处散落 query；快照精确化抓不到降级；auto 步导航后未登录检测。

**Tech Stack:** Chrome MV3 SW（automation/ dev-only）、UMD 双模式纯逻辑模块、node --test 单测。

**Spec:** `docs/superpowers/specs/2026-06-16-url-anchor-driven-page-resolution-design.md`

**不变量（每个 task 守住）:** release 隔离不破（automation 不装配即沉睡）；storage 状态同步层不动；锚点缺失全退回旧 query（向后兼容）；product 落库唯一入口仍是 orchHitlConfirm→pickProduct。

---

## 文件结构

| 文件 | 责任 | 改动 |
|------|------|------|
| `automation/orchestrator/steps.js` | step 声明 + product 工厂 | `emptyProduct` 加 `dxmEditUrl`；`collect_dxm` hitlSpec 加字段 |
| `automation/orchestrator/engine.js` | 引擎 + pickProduct 白名单 + 纯函数 | `pickProduct` 白名单加 `dxmEditUrl`；新增 `resolveAnchorUrl`/`isUnauthUrl` 纯函数导出 |
| `automation/bg-entry.js` | SW 取页适配 | 新增 `resolvePageTab`；改 `findDxmEditTab`/`orchCapturePageSnapshot`/`orchNavigateAndWait` |
| `tests/orchestrator-steps.test.js` | steps 契约单测 | 加 dxmEditUrl 字段/工厂透传断言 |
| `tests/orchestrator-engine.test.js` | engine 单测 | 加 pickProduct/resolveAnchorUrl/isUnauthUrl 断言 |

锚点解析放 engine.js（纯逻辑、已 UMD 双模式、已被 bg 经 `ORCH.engine` 引用），不放 bg-entry.js（bg-entry 是 SW-only 不可 node 测）。`resolvePageTab` 含 chrome.tabs.query 留 bg-entry.js（靠 e2e）。

---

## Task 1: 数据契约 — product 加 dxmEditUrl 锚点

**Files:**
- Modify: `automation/orchestrator/steps.js`（emptyProduct + collect_dxm hitlSpec）
- Modify: `automation/orchestrator/engine.js`（pickProduct 白名单）
- Test: `tests/orchestrator-steps.test.js` + `tests/orchestrator-engine.test.js`

- [ ] **Step 1: 写失败测试（steps 契约）**

`tests/orchestrator-steps.test.js` 末尾加：

```js
test('collect_dxm: hitlSpec 加 dxmEditUrl 字段（可选、发布步取页锚点）', () => {
  const s = STEP_DEFS.find(d => d.id === 'collect_dxm');
  const f = s.hitlSpec.fields.find(x => x.key === 'dxmEditUrl');
  assert.ok(f, 'collect_dxm 含 dxmEditUrl 字段');
  assert.strictEqual(f.required, false, 'dxmEditUrl 可选（缺则退回旧 query，向后兼容）');
  assert.strictEqual(f.fieldType, 'text');
});

test('emptyProduct + buildInitialWorkflow: 含 dxmEditUrl=null', () => {
  assert.strictEqual(emptyProduct('X').dxmEditUrl, null);
  const wf = buildInitialWorkflow({ label: 'X' }, () => 'w1');
  assert.strictEqual(wf.product.dxmEditUrl, null);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `node --test tests/orchestrator-steps.test.js`
Expected: FAIL（dxmEditUrl 字段不存在 / undefined）

- [ ] **Step 3: 实现（steps.js）**

`emptyProduct` 返回对象加 `dxmEditUrl: null`（放 sourceUrl 后）：
```js
return { label: label || null, sourceUrl: null, dxmEditUrl: null, spuId: null, skc: null, skuNo: null, url1688: null, orderNo1688: null, poNo: null,
  returnPrice: null, cost1688: null, domesticShipping: null, grossMargin: null };
```

`collect_dxm` 的 hitlSpec.fields 加（在 spuId 字段后）：
```js
{ key: 'dxmEditUrl', label: '店小秘编辑页 URL（发布步用）', fieldType: 'text', required: false },
```

- [ ] **Step 4: 跑测试验证通过**

Run: `node --test tests/orchestrator-steps.test.js`
Expected: PASS

- [ ] **Step 5: 写失败测试（pickProduct 白名单）**

`tests/orchestrator-engine.test.js` 加（找到现有 pickProduct 测试块附近）：
```js
test('pickProduct: 白名单含 dxmEditUrl（带则落库，不带不污染）', () => {
  assert.strictEqual(pickProduct({ dxmEditUrl: 'https://www.dianxiaomi.com/.../edit' }).dxmEditUrl, 'https://www.dianxiaomi.com/.../edit');
  assert.ok(!('dxmEditUrl' in pickProduct({ skc: 'X' })));   // 不带不出现
});
```
（确认文件顶部已从 require 解构出 `pickProduct`；没有则加。）

- [ ] **Step 6: 跑测试验证失败**

Run: `node --test tests/orchestrator-engine.test.js`
Expected: FAIL（dxmEditUrl 不在白名单）

- [ ] **Step 7: 实现（engine.js pickProduct）**

`pickProduct` 的白名单数组加 `'dxmEditUrl'`（放 sourceUrl 后）：
```js
for (const k of ['sourceUrl', 'dxmEditUrl', 'spuId', 'skc', 'skuNo', 'url1688', 'orderNo1688', 'poNo', 'returnPrice', 'cost1688', 'domesticShipping']) {
```

- [ ] **Step 8: 跑测试验证通过 + 全量回归**

Run: `node --test tests/*.test.js`
Expected: PASS（全绿，新增 ~4 用例）

- [ ] **Step 9: Commit**

```bash
git add automation/orchestrator/steps.js automation/orchestrator/engine.js tests/orchestrator-steps.test.js tests/orchestrator-engine.test.js
git commit -m "feat(automation): product 加 dxmEditUrl 锚点字段（契约层）"
```

---

## Task 2: 纯函数 — 锚点解析 / URL 比对 / 未登录检测

**Files:**
- Modify: `automation/orchestrator/engine.js`（新增 3 纯函数 + 导出）
- Test: `tests/orchestrator-engine.test.js`

锚点解析与 URL 判断是纯逻辑，放 engine.js（已 UMD 双模式、已被 bg 经 `ORCH.engine` 引用），node 可测。chrome.tabs.query 的脏活留 Task 3 的 `resolvePageTab`。

- [ ] **Step 1: 写失败测试**

`tests/orchestrator-engine.test.js` 加（顶部解构补 `resolveAnchorUrl, isUnauthUrl, matchAnchorTab`）：

```js
test('resolveAnchorUrl: target.url 优先 > product 锚点 > null', () => {
  // auto 步有 target.url → 用之
  assert.strictEqual(
    resolveAnchorUrl({ id: 'gen_label', target: { url: 'https://agentseller.temu.com/goods/label' } }, {}),
    'https://agentseller.temu.com/goods/label');
  // publish 无 target.url → 映射 product.dxmEditUrl
  assert.strictEqual(
    resolveAnchorUrl({ id: 'publish' }, { dxmEditUrl: 'https://www.dianxiaomi.com/x/edit?id=1' }),
    'https://www.dianxiaomi.com/x/edit?id=1');
  // publish 但 product 无锚点 → null（调用方退回旧 query）
  assert.strictEqual(resolveAnchorUrl({ id: 'publish' }, {}), null);
  // 未映射的 step 且无 target → null
  assert.strictEqual(resolveAnchorUrl({ id: 'select_product' }, { dxmEditUrl: 'x' }), null);
});

test('isUnauthUrl: 命中未登录标志 → true', () => {
  assert.strictEqual(isUnauthUrl('https://seller.temu.com/no-auth.html'), true);
  assert.strictEqual(isUnauthUrl('https://www.dianxiaomi.com/login'), true);
  assert.strictEqual(isUnauthUrl('https://passport.temu.com/x'), true);
  assert.strictEqual(isUnauthUrl('https://agentseller.temu.com/goods/label'), false);
  assert.strictEqual(isUnauthUrl(''), false);
  assert.strictEqual(isUnauthUrl(null), false);
});

test('matchAnchorTab: 忽略 query/hash 比对 origin+pathname', () => {
  // 同 origin+path、query 不同 → 命中（店小秘编辑页带不同 id）
  assert.strictEqual(matchAnchorTab('https://www.dianxiaomi.com/x/edit?id=2', 'https://www.dianxiaomi.com/x/edit?id=1'), true);
  // path 不同 → 不命中
  assert.strictEqual(matchAnchorTab('https://www.dianxiaomi.com/y/list', 'https://www.dianxiaomi.com/x/edit?id=1'), false);
  assert.strictEqual(matchAnchorTab(null, 'https://x/edit'), false);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `node --test tests/orchestrator-engine.test.js`
Expected: FAIL（函数未定义）

- [ ] **Step 3: 实现（engine.js）**

在 `computeMargin` 后、`makeEngine` 前加（模块级常量 + 纯函数）：

```js
  // step.id → product 锚点字段映射（auto 步用 target.url，HITL/无 target 步用此表回退 product）。
  const ANCHOR_FIELD_BY_STEP = { publish: 'dxmEditUrl' };
  const UNAUTH_PATTERNS = ['no-auth', 'login', 'passport'];

  // 取页锚点 URL：target.url 优先（auto 主流程），否则按 step.id 映射 product 字段，都无 → null。
  function resolveAnchorUrl(step, product) {
    if (step && step.target && step.target.url) return step.target.url;
    const field = step && ANCHOR_FIELD_BY_STEP[step.id];
    const v = field && product && product[field];
    return v || null;
  }

  // 落地页是否未登录态（URL 含 no-auth/login/passport 等标志）。非字符串/空 → false（不误判）。
  function isUnauthUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    const low = url.toLowerCase();
    return UNAUTH_PATTERNS.some(p => low.includes(p));
  }

  // tab.url 是否匹配锚点（忽略 query/hash，比 origin+pathname）。店小秘编辑页 id 在 query → 必须忽略。
  function matchAnchorTab(tabUrl, anchorUrl) {
    if (typeof tabUrl !== 'string' || typeof anchorUrl !== 'string') return false;
    const strip = (u) => { const i = u.search(/[?#]/); return i < 0 ? u : u.slice(0, i); };
    return strip(tabUrl) === strip(anchorUrl);
  }
```

导出（return 对象加三项）：
```js
  return { makeEngine, findWorkflow, pickProduct, buildHitl, buildReviewHitl, buildPublishHitl, computeMargin,
    resolveAnchorUrl, isUnauthUrl, matchAnchorTab };
```

- [ ] **Step 4: 跑测试验证通过 + 全量回归**

Run: `node --test tests/*.test.js`
Expected: PASS（全绿）

- [ ] **Step 5: Commit**

```bash
git add automation/orchestrator/engine.js tests/orchestrator-engine.test.js
git commit -m "feat(automation): 加锚点解析/URL 比对/未登录检测纯函数"
```

---

## Task 3: `resolvePageTab` 统一锚点解析器 + findDxmEditTab 改造

**Files:**
- Modify: `automation/bg-entry.js`（新增 `resolvePageTab`；重写 `findDxmEditTab`）

`resolvePageTab` 含 `chrome.tabs.query`（SW-only，靠 e2e；纯逻辑已在 Task 2 测）。

- [ ] **Step 1: 实现 resolvePageTab（bg-entry.js）**

在 `findDxmEditTab` 前加：

```js
// 统一锚点取页：解析 step 应在的确切 URL → query 该域找匹配 tab（忽略 query/hash）→
//   命中 { tab }；不命中按 navigate 决定（true 主动导航开 / false 返回 null 降级）；
//   无锚点 → 退回 step.domain 旧 query（向后兼容）。统一三处散落 query 的单一入口。
async function resolvePageTab(step, wf, { navigate } = {}) {
  const product = (wf && wf.product) || {};
  const anchorUrl = ORCH.engine.resolveAnchorUrl(step, product);
  if (anchorUrl) {
    let host;
    try { host = new URL(anchorUrl).hostname; } catch (_) { host = null; }
    if (host) {
      let tabs = [];
      try { tabs = await chrome.tabs.query({ url: `*://${host}/*` }); } catch (_) { tabs = []; }
      const hit = (tabs || []).find(t => ORCH.engine.matchAnchorTab(t.url, anchorUrl));
      if (hit) return { tab: hit };
    }
    if (navigate) {
      const tabId = await orchNavigateAndWait(anchorUrl, (step.target && step.target.readySignal) || null);
      try { return { tab: await chrome.tabs.get(tabId) }; } catch (e) { return { tab: { id: tabId, url: anchorUrl } }; }
    }
    return null;   // 有锚点但 tab 没开 + 不导航 → 降级（快照场景）；publish 场景由调用方据 null 报「数据校验」
  }
  // 无锚点：退回 step.domain 旧 query（向后兼容）
  if (!step.domain) return navigate ? { error: { category: 'validate', code: 'NO_ANCHOR_NO_DOMAIN', message: '数据校验：缺取页锚点且无 domain', recoverable: false } } : null;
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: `*://*.${step.domain}/*` }); } catch (_) { tabs = []; }
  return { tab: (tabs || [])[0] || null, fallback: true };
}
```

- [ ] **Step 2: 重写 findDxmEditTab 走 resolvePageTab**

替换现有 `findDxmEditTab`（保留激活 tab + sleep 500ms 防 Ant dropdown 不展开的逻辑）：

```js
// publish 取编辑页：优先 product.dxmEditUrl 锚点精确命中；无锚点/不命中退回旧 dianxiaomi query 找含 edit 的 tab。
// 错误分层：有锚点但页没开 → 数据校验（提示回填/保持打开）；无锚点且 query 空 → 读取（沿用 PUBLISH_NO_EDIT_TAB）。
async function findDxmEditTab(wf) {
  const step = wf && wf.steps && wf.steps[wf.cursor];
  const product = (wf && wf.product) || {};
  // 1. 有锚点：精确命中
  if (product.dxmEditUrl && step) {
    const r = await resolvePageTab(step, wf, { navigate: false });
    if (r && r.tab) return await activateEditTab(r.tab);
    return { error: { category: 'validate', code: 'PUBLISH_EDIT_TAB_CLOSED', message: '数据校验：店小秘编辑页未打开（请保持采集步留的编辑页，或重新采集回填 URL）', recoverable: true } };
  }
  // 2. 无锚点：退回旧 query（向后兼容）
  let tabs;
  try { tabs = await chrome.tabs.query({ url: '*://*.dianxiaomi.com/*' }); }
  catch (e) { return { error: { category: 'read', code: 'PUBLISH_TAB_QUERY_FAILED', message: 'tab 查询失败:' + String(e?.message || e), recoverable: true } }; }
  const editTab = (tabs || []).find(t => /edit/i.test(t.url || ''));
  if (!editTab) return { error: { category: 'read', code: 'PUBLISH_NO_EDIT_TAB', message: '未找到店小秘编辑页 tab(collect_dxm 后请保持店小秘编辑页打开)', recoverable: true } };
  return await activateEditTab(editTab);
}

// 激活编辑页 tab（前台防 Ant dropdown 后台不展开）+ 统一返回 { tab }。
async function activateEditTab(tab) {
  try { await chrome.tabs.update(tab.id, { active: true }); await new Promise(res => setTimeout(res, 500)); }
  catch (e) { console.warn('[orch][publish] 激活编辑页 tab 失败,继续尝试', e); }
  return { tab };
}
```

⚠ `findDxmEditTab` 现有调用点（`orchPublishCheck`/`orchPublishExec`）调的是 `findDxmEditTab()` 无参——改签名为 `findDxmEditTab(wf)`，两调用点需取到 wf 传入。

- [ ] **Step 3: 改两调用点传 wf**

`orchPublishCheck`/`orchPublishExec` 开头已有 workflowId，加读 wf：
```js
const wf = ORCH.engine.findWorkflow(await orchRead(), workflowId);
const found = await findDxmEditTab(wf);
```

- [ ] **Step 4: 全量回归（无新单测，纯 SW 逻辑靠 e2e）**

Run: `node --test tests/*.test.js`
Expected: PASS（不破现有）

- [ ] **Step 5: Commit**

```bash
git add automation/bg-entry.js
git commit -m "feat(automation): resolvePageTab 统一锚点取页 + findDxmEditTab 走锚点（解 publish 死结）"
```

---

## Task 4: 快照精确化 — orchCapturePageSnapshot 走锚点

**Files:**
- Modify: `automation/bg-entry.js`（重写 `orchCapturePageSnapshot` + 改 2 调用点）

- [ ] **Step 1: 重写 orchCapturePageSnapshot（签名 domain → step, wf）**

替换现有实现：

```js
// 按 step 锚点抓当前页 innerText 快照（截断 6000）。尽力而为：resolvePageTab(navigate:false) 命中即抓，
// 不命中（页没开/无锚点退回 domain 也空）→ null，大脑凭 workflow 上下文兜底。绝不为喂快照主动开 tab。
async function orchCapturePageSnapshot(step, wf) {
  if (!step) return null;
  let tab = null;
  try {
    const r = await resolvePageTab(step, wf, { navigate: false });
    tab = r && r.tab;
  } catch (_) { tab = null; }
  if (!tab || !tab.id) return null;
  try {
    const arr = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.body.innerText });
    const text = arr && arr[0] && arr[0].result;
    return typeof text === 'string' ? text.slice(0, 6000) : null;
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 2: 改调用点 orchRequestFillSuggest**

`const pageSnapshot = await orchCapturePageSnapshot(step.domain);` → `const pageSnapshot = await orchCapturePageSnapshot(step, wf);`
（该函数内已有 `wf` 和 `step` 局部变量，直接传。）

- [ ] **Step 3: 改调用点 orchReviewGate**

`const pageSnapshot = await orchCapturePageSnapshot(step.domain);` → `const pageSnapshot = await orchCapturePageSnapshot(step, wf);`
（`orchReviewGate(workflowId, step, wf)` 签名已有 step、wf。）

- [ ] **Step 4: 全量回归**

Run: `node --test tests/*.test.js`
Expected: PASS（不破现有；快照纯 SW 逻辑靠 e2e）

- [ ] **Step 5: Commit**

```bash
git add automation/bg-entry.js
git commit -m "feat(automation): 大脑快照按 step 锚点精确取页（抓不到降级 null）"
```

---

## Task 5: auto 步导航后未登录检测

**Files:**
- Modify: `automation/bg-entry.js`（`orchNavigateAndWait` 加检测 + 3 adapter 透传 category）

- [ ] **Step 1: orchNavigateAndWait 加落地未登录检测**

`waitTabComplete(tab.id, ...)` 之后、readySignal 轮询（`if (!readySignal) return tab.id;`）之前插入：

```js
  // 落地未登录检测：取 tab.url 判 isUnauthUrl → 抛业务拦截（区别于 readySignal 超时的「读取」错误）。
  // 取 url 失败不阻断（继续走 readySignal 轮询，不引入新脆点）。
  try {
    const landed = await chrome.tabs.get(tab.id);
    if (ORCH.engine.isUnauthUrl(landed && landed.url)) {
      let host = url; try { host = new URL(url).hostname; } catch (_) {}
      const err = new Error('未登录：请先登录 ' + host + ' 后重试');
      err.category = 'business';
      throw err;
    }
  } catch (e) {
    if (e && e.category === 'business') throw e;   // 未登录错误向上抛；tabs.get 自身异常吞掉继续
  }
```

- [ ] **Step 2: 3 adapter 的 nav catch 透传 category**

`orchAdapterGenLabel`/`orchAdapterPackLabel`/`orchAdapterShip` 的 `orchNavigateAndWait` catch 块，把硬编码 `category: 'read'` 改为透传：

```js
  } catch (e) {
    return { status: 'error', error: { category: (e && e.category) || 'read', code: 'XXX_NAV_FAILED', message: '...:' + String(e?.message || e), recoverable: true } };
  }
```
（各 adapter 保留自己的 code 与 message 前缀，仅 category 改为 `(e && e.category) || 'read'`。未登录时 e.category='business' → 错误卡显示业务拦截类。）

- [ ] **Step 3: 全量回归**

Run: `node --test tests/*.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add automation/bg-entry.js
git commit -m "feat(automation): auto 步导航后未登录检测（业务拦截分层）"
```

---

## 完成验证清单（全 task 后）

- [ ] `node --test tests/*.test.js` 全绿（新增 ~7 用例：契约 4 + 纯函数 3）
- [ ] `python3 -m pytest tests/` 全绿（本计划不动 Python，确认无连带破坏）
- [ ] `python3 build/build_extension.py` 成功（dist 重建，确认 SW 装配无语法错）
- [ ] 端到端（人工 gated，reload 扩展后）：
  - [ ] `collect_dxm` 人工填 `dxmEditUrl` → publish 主动命中编辑页（不再赌当前 tab）
  - [ ] 故意关掉店小秘编辑页 → publish 报「数据校验：店小秘编辑页未打开」而非崩
  - [ ] auto 步导航落未登录页 → 错误卡显示「未登录」业务拦截类，而非 readySignal 超时

## Spec 覆盖自查

| spec 节 | 落地 task |
|---------|----------|
| §3 resolvePageTab 统一抽象 | Task 3 |
| §4 product 加 dxmEditUrl（emptyProduct/pickProduct/hitlSpec） | Task 1 |
| §5.1 findDxmEditTab 走锚点 | Task 3 |
| §5.2 快照精确化抓不到降级 | Task 4 |
| §5.3 未登录检测 | Task 5 |
| §6 错误三层（数据校验/读取/业务拦截） | 贯穿 Task 3/5 |
| §8 测试（纯函数单测 + 契约透传 + e2e gated） | 各 task Step + 验证清单 |
