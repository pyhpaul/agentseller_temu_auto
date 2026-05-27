# 创建采购单 Feature — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `create_purchase_order` feature 加 Phase 2：在店小秘「创建现有订单」自动生成采购单、通过审核、移入待到货，跳待到货页定位商品行后停在「申请付款」前提醒用户手动付款。

**Architecture:** 沿用 Phase 1 已验证的模式——background service worker（`core/background/service-worker.js` 的 `CPO_` 标记段内）当编排者，新增 `cpoRun2()` 线性序列 + `cpoSetPhase2()` 状态写入 + tab 捕获辅助，复用现成 `cpoWaitTabComplete`/`cpoSendCommand`/`cpoCloseTab`。content（`features/create_purchase_order/content/index.js`）②区加输入框 + 启用逻辑 + 5 个店小秘页命令 handler。纯逻辑（采购单号正则提取 + Phase 2 校验）拆进 `cpo-logic.js`，`node --test` 单测。状态写 `chrome.storage.local['cpo_state'].phase2`，各 tab 面板靠 `storage.onChanged` 同步。

**Tech Stack:** Chrome MV3 content script + service worker；纯 JS；`node:test` + `node:assert` 单测；`python build/build_extension.py` 构建到 `dist/extension/`。

**Spec:** `docs/superpowers/specs/2026-05-27-create-purchase-order-phase2-design.md`

---

## 消息协议（全任务共享，类型必须一致）

**content → bg**（裸 `chrome.runtime.sendMessage`）：

| type | data | bg 响应 |
|------|------|---------|
| `CPO_START_PHASE2` | `{orderNo1688}` | `{ok:true}` 立即 ack（编排异步跑），或 `{ok:false, error}`。`skuNo` 由 bg 从 `cpo_state.phase1.collected.skuNo` 读，不经 content 传 |

**bg → 店小秘目标 tab 命令**（`chrome.tabs.sendMessage`，content `sendResponse` 回传，handler 内 `return true` 保持异步通道）：

| type | data | 成功响应 | 失败响应 |
|------|------|----------|----------|
| `CPO_P2_DRAFT_CREATE` | — | `{ok:true}` | `{ok:false, error}` |
| `CPO_P2_ADD_FETCH` | `{orderNo1688}` | `{ok:true, exists:bool}` | `{ok:false, error}` |
| `CPO_P2_EDIT_FILL` | `{skuNo}` | `{ok:true}` | `{ok:false, error}` |
| `CPO_P2_EDIT_SAVE` | — | `{ok:true, poNo}` | `{ok:false, error}` |
| `CPO_P2_WAIT_SEARCH` | `{skuNo}` | `{ok:true, found:bool}` | `{ok:false, error}` |

**bg 状态** `chrome.storage.local['cpo_state'].phase2 = { status, step, label, collected2 }`：
- `status` ∈ `idle|running|done|error`
- `collected2 = { poNo, orderNo1688 }`：`poNo`=采购单号（审核成功弹窗正则提取），`orderNo1688`=用户输入

**弹窗分流（bg 主导，见 spec §3/§5）**：`CPO_P2_ADD_FETCH` 只检测「已存在弹窗」返回 `exists`；「跳转 edit」由 bg 监听 add tab 导航判断（content 在跳转时会随页面销毁，无法回传）。bg 在发 `CPO_P2_ADD_FETCH` **之前**先挂好 edit tab 监听（注册时序：捕获监听必须在触发动作前注册）。

**关键 URL 常量**（bg + content 共用，硬编码）：
- 草稿创建页：`https://www.dianxiaomi.com/web/purchasing/order/draft/aliPurchasing`
- add 页识别：URL 含 `/purchasing/order/add`
- edit 页识别：URL 含 `/purchasing/order/edit`
- 待到货页：`https://www.dianxiaomi.com/web/purchasing/order/waitArrival`

---

## 文件结构

| 文件 | 职责 | 改动 |
|------|------|------|
| `features/create_purchase_order/cpo-logic.js` | 加 `extractPoNo` / `validatePhase2` 纯函数 | 改 |
| `features/create_purchase_order/tests/cpo-logic.test.js` | 加 Phase 2 纯逻辑单测 | 改 |
| `features/create_purchase_order/content/index.js` | ②区加 1688订单号输入框 + 启用逻辑 + hub 输出渲染 + 5 个 `CPO_P2_*` handler | 改 |
| `core/background/service-worker.js` | `CPO_` 标记段内加 `cpoRun2`/`cpoSetPhase2`/tab 捕获辅助 + `CPO_START_PHASE2` 路由 | 改 |
| `features/create_purchase_order/samples/dxm_draft.txt` | 草稿页「创建采购单」下拉 DOM | 新 |
| `features/create_purchase_order/samples/dxm_purchase_add.txt` | add 页 1688账号/订单框/获取按钮/已存在弹窗 DOM | 新 |
| `features/create_purchase_order/samples/dxm_purchase_edit.txt` | edit 页 采购人员/收货仓库/配对商品弹窗/保存审核/成功弹窗 DOM | 新 |
| `features/create_purchase_order/samples/dxm_wait_arrival.txt` | 待到货页 搜索区/商品表格/物流列/申请付款 DOM | 新 |
| `features/create_purchase_order/CLAUDE.md` | 补 Phase 2 实现 + 踩坑，解除「Phase 2 预告」 | 改 |

**feature.json 不改**：三域 content_matches + `tabs/storage/scripting` 权限 Phase 1 已覆盖，Phase 2 全在店小秘域内。

---

## Task 1: 纯逻辑扩展 cpo-logic.js（TDD）

**Files:**
- Modify: `features/create_purchase_order/cpo-logic.js`
- Modify: `features/create_purchase_order/tests/cpo-logic.test.js`

- [ ] **Step 1: 追加失败测试**

在 `features/create_purchase_order/tests/cpo-logic.test.js` 的 `require` 行加入新函数，并在文件末尾追加测试。

把首行 require 改为（加 `extractPoNo, validatePhase2`）：
```js
const { extractSerial, buildIdCode, validateInputs, mapDxmFields, extractPoNo, validatePhase2 } = require('../cpo-logic.js');
```

文件末尾追加：
```js
test('extractPoNo: 标准审核成功弹窗文案', () => {
  assert.strictEqual(
    extractPoNo('操作成功：1个，采购单：PO1SLPT250527001已移入待到货状态'),
    'PO1SLPT250527001'
  );
});
test('extractPoNo: 冒号为半角', () => {
  assert.strictEqual(extractPoNo('操作成功:1个,采购单:PO1SLPT999已移入待到货状态'), 'PO1SLPT999');
});
test('extractPoNo: 无采购单号返回 null', () => {
  assert.strictEqual(extractPoNo('操作成功：1个'), null);
  assert.strictEqual(extractPoNo(''), null);
  assert.strictEqual(extractPoNo(null), null);
});

test('validatePhase2: 合法', () => {
  assert.deepStrictEqual(validatePhase2({ orderNo1688: 'AB123', phase1Done: true }), { ok: true });
});
test('validatePhase2: phase1 未完成', () => {
  const r = validatePhase2({ orderNo1688: 'AB123', phase1Done: false });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Phase 1|添加SKU/);
});
test('validatePhase2: 订单号为空', () => {
  const r = validatePhase2({ orderNo1688: '  ', phase1Done: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /1688订单号/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test features/create_purchase_order/tests/cpo-logic.test.js`
Expected: FAIL（`extractPoNo is not a function` / `validatePhase2 is not a function`）

- [ ] **Step 3: 在 cpo-logic.js 加实现**

在 `mapDxmFields` 函数之后、`const api = {...}` 之前插入：
```js
  // 审核成功弹窗文本 "操作成功：1个，采购单：PO1SLPT...已移入待到货状态" → "PO1SLPT..."；无则 null
  function extractPoNo(successText) {
    const text = String(successText == null ? '' : successText);
    const m = text.match(/采购单[:：]\s*(PO\w+)/);
    return m ? m[1] : null;
  }

  // 校验 Phase 2 启动：phase1 必须 done + 1688订单号非空
  function validatePhase2({ orderNo1688, phase1Done } = {}) {
    if (!phase1Done) {
      return { ok: false, error: '请先完成 Phase 1 添加SKU' };
    }
    if (!orderNo1688 || !String(orderNo1688).trim()) {
      return { ok: false, error: '1688订单号不能为空' };
    }
    return { ok: true };
  }
```
并把 `const api = {...}` 那行改为（加两个新函数）：
```js
  const api = { extractSerial, buildIdCode, validateInputs, mapDxmFields, extractPoNo, validatePhase2 };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test features/create_purchase_order/tests/cpo-logic.test.js`
Expected: PASS（15 tests, 0 fail —— 原 9 + 新 6）

- [ ] **Step 5: 提交**

```bash
git add features/create_purchase_order/cpo-logic.js features/create_purchase_order/tests/cpo-logic.test.js
git commit -m "feat(create_purchase_order): Phase 2 纯逻辑 extractPoNo + validatePhase2

Why: Phase 2 采购单号解析与启动校验可独立 TDD，先锁定不依赖 DOM 的部分
What: extractPoNo（审核成功弹窗正则提采购单号）+ validatePhase2（phase1 done + 订单号非空）+ node 单测
Test: node --test (15 passed)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: ②区 UI —— 1688订单号输入框 + 启用逻辑 + hub 输出 + 启动

> 改造 `content/index.js` 的 ②区：店小秘页显示「1688订单号」输入框 + 「开始创建采购单」按钮（启用条件=phase1 done + 在店小秘页 + 订单号非空），点击发 `CPO_START_PHASE2`；`done` 时显示 `当前订单信息：poNo（orderNo1688）`。不依赖 DOM dump，全完整代码。此时 bg 尚无 `CPO_START_PHASE2` handler，点开始会停在「启动中…」（Task 3 接上）。

**Files:**
- Modify: `features/create_purchase_order/content/index.js`

- [ ] **Step 1: 扩展 ui 对象**

把现有 `const ui = { startBtn: null, urlInput: null, localMsg: null, p1Status: null, p1Data: null, p2Status: null, p2Btn: null };` 替换为：
```js
  const ui = { startBtn: null, urlInput: null, localMsg: null, p1Status: null, p1Data: null,
               p2Status: null, p2Data: null, p2Btn: null, orderInput: null, p2Msg: null };
```

- [ ] **Step 2: 加 setP2Msg / recomputeP2Btn / onStartPhase2**

在 `setLocalMsg` 函数之后插入 `setP2Msg`：
```js
  function setP2Msg(text, kind = 'info') {
    if (!ui.p2Msg) return;
    ui.p2Msg.textContent = text || '';
    ui.p2Msg.style.color = kind === 'error' ? '#ff4d4f' : '#666';
  }
```

在 `onClear` 函数之前插入按钮启用重算 + Phase 2 启动（`lastP1Done` 缓存供 input 事件用，避免每次读 storage）：
```js
  // ②区按钮启用：phase1 done + 在店小秘页 + 输入框有值。lastP1Done 由 renderState 更新
  let lastP1Done = false;
  function recomputeP2Btn() {
    if (!ui.p2Btn) return;
    const orderVal = (ui.orderInput && ui.orderInput.value || '').trim();
    ui.p2Btn.disabled = !(lastP1Done && isDxmPage() && orderVal);
  }

  // 发起 Phase 2（仅店小秘页）：校验 → CPO_START_PHASE2
  let cpoStarting2 = false;   // 重入守卫
  async function onStartPhase2() {
    if (cpoStarting2) return;
    const orderNo1688 = (ui.orderInput && ui.orderInput.value || '').trim();
    const o = await chrome.storage.local.get(STATE_KEY);
    const p1Done = !!(o[STATE_KEY] && o[STATE_KEY].phase1 && o[STATE_KEY].phase1.status === 'done');
    const v = L.validatePhase2({ orderNo1688, phase1Done: p1Done });
    if (!v.ok) { setP2Msg(v.error, 'error'); return; }
    cpoStarting2 = true;
    if (ui.p2Btn) ui.p2Btn.disabled = true;
    let started = false;
    try {
      setP2Msg('启动中…');
      const resp = await chrome.runtime.sendMessage({ type: 'CPO_START_PHASE2', data: { orderNo1688 } });
      if (!resp?.ok) setP2Msg(resp?.error || '启动失败', 'error');
      else started = true;
    } catch (e) {
      setP2Msg('启动失败：' + e.message, 'error');
    } finally {
      cpoStarting2 = false;
      if (!started) recomputeP2Btn();   // 启动成功则保持禁用（流程在跑）
    }
  }
```

- [ ] **Step 3: 改 renderState 的 ②区分支**

把 renderState 里这三行：
```js
    if (ui.p2Status) ui.p2Status.textContent = '状态：' + statusText(p2);
    // Phase 2 按钮：Phase 1 完成 + 当前在店小秘页 才可点（动作待开发）
    if (ui.p2Btn) ui.p2Btn.disabled = !(p1.status === 'done' && isDxmPage());
```
替换为：
```js
    if (ui.p2Status) ui.p2Status.textContent = '状态：' + statusText(p2);
    if (ui.p2Data) {
      const c2 = p2.collected2 || {};
      ui.p2Data.textContent = (p2.status === 'done' && c2.poNo)
        ? '当前订单信息：' + c2.poNo + '（' + (c2.orderNo1688 || '-') + '）'
        : '';
    }
    lastP1Done = (p1.status === 'done');
    recomputeP2Btn();
```

- [ ] **Step 4: 替换 ②区 render 块**

把 render 里整个「② 创建采购单」块（从 `const h2 = document.createElement('div');` 到 `wrap.append(h2, ui.p2Status, note2, ui.p2Btn);`）替换为：
```js
      // ===== ② 创建采购单（店小秘发起，需 Phase 1 完成） =====
      const h2 = document.createElement('div');
      h2.style.cssText = 'font-weight:600;color:#1677ff;';
      h2.textContent = '② 创建采购单';
      ui.p2Status = document.createElement('div');
      ui.p2Status.style.cssText = 'color:#666;';
      ui.p2Data = document.createElement('div');
      ui.p2Data.style.cssText = 'color:#888;font-size:11px;line-height:1.4;';
      wrap.append(h2, ui.p2Status, ui.p2Data);

      if (isDxmPage()) {
        const hint2 = document.createElement('div');
        hint2.style.cssText = 'color:#666;line-height:1.4;';
        hint2.textContent = '需先完成①添加SKU；填 1688订单号后开始';
        ui.orderInput = document.createElement('input');
        ui.orderInput.placeholder = '1688订单号';
        ui.orderInput.style.cssText = 'padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;';
        ui.orderInput.addEventListener('input', recomputeP2Btn);
        ui.p2Btn = document.createElement('button');
        ui.p2Btn.className = 'tal-action-btn';
        ui.p2Btn.textContent = '开始创建采购单';
        ui.p2Btn.disabled = true;
        ui.p2Btn.addEventListener('click', onStartPhase2);
        ui.p2Msg = document.createElement('div');
        ui.p2Msg.style.cssText = 'font-size:11px;color:#666;min-height:16px;';
        wrap.append(hint2, ui.orderInput, ui.p2Btn, ui.p2Msg);
      } else {
        const note2 = document.createElement('div');
        note2.style.cssText = 'color:#999;font-size:11px;line-height:1.4;';
        note2.textContent = '（在店小秘页发起；需先完成①添加SKU）';
        wrap.append(note2);
      }
```

- [ ] **Step 5: 构建**

Run: `python build/build_extension.py`
Expected: 无报错，`dist/extension/` 生成。

- [ ] **Step 6: 手动验证 UI（浏览器）**

reload `dist/extension/` → 打开店小秘任意页（如 `https://www.dianxiaomi.com/web/purchasing/order/draft/aliPurchasing`）→ FAB → Hub →「🛒 创建采购单」→②区应有「1688订单号」输入框 + 「开始创建采购单」按钮。
- phase1 未 done 或输入框空 → 按钮 disabled。
- 在 SW 控制台手动置 phase1 done：`chrome.storage.local.get('cpo_state').then(s=>chrome.storage.local.set({cpo_state:{...(s.cpo_state||{}),phase1:{status:'done',collected:{skuNo:'TEST-001'}}}}))`，回面板填订单号 → 按钮启用。
- 点开始 → 面板停在「启动中…」（bg 尚无 handler，属正常，Task 3 接上）。
- 切到非店小秘页（temu 列表）打开②区 → 只显示状态 + 「（在店小秘页发起…）」提示，无输入框。

Expected: 输入框/按钮按页面与状态正确显隐启停；校验文案正确。

- [ ] **Step 7: 提交**

```bash
git add features/create_purchase_order/content/index.js
git commit -m "feat(create_purchase_order): Phase 2 ②区 UI 输入框+启用逻辑+hub输出

Why: Phase 2 在店小秘发起，需 1688订单号输入框、启用门槛（phase1 done+店小秘页+订单号）、done 后展示订单信息
What: ②区加 orderInput/p2Data/p2Msg；recomputeP2Btn 启用重算；onStartPhase2 校验+发 CPO_START_PHASE2；renderState 渲染 collected2
Test: 手动验证 UI 显隐启停 + 本地校验（bg handler 未接，停在启动中属预期）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: bg 编排段 —— cpoRun2 + tab 捕获 + CPO_START_PHASE2 路由

> 在 `core/background/service-worker.js` 的 `CPO_` 标记段内加 Phase 2 编排（chrome.tabs API 全完整代码，不依赖页面选择器）。此时 content 的 `CPO_P2_*` handler 还没建（Task 4-8），编排跑到第一个命令时 content 无 handler → 不点击 → 捕获 add tab 超时 → phase2 error。这是本任务预期：验证编排骨架 + tab 捕获 + 错误回收。

**Files:**
- Modify: `core/background/service-worker.js`（标记段内追加，不动 Phase 1 代码）

- [ ] **Step 1: 在 `// ── end create_purchase_order ──` 之前插入 Phase 2 编排**

紧接 Phase 1 的 `CPO_START` listener 之后、`// ── end create_purchase_order ──` 之前插入：
```js

// ── Phase 2：创建现有订单跨 tab 编排 ──
const CPO_DXM_DRAFT_URL = 'https://www.dianxiaomi.com/web/purchasing/order/draft/aliPurchasing';
const CPO_DXM_WAIT_URL  = 'https://www.dianxiaomi.com/web/purchasing/order/waitArrival';

// 写 cpo_state.phase2（单一状态源；各 tab 面板靠 storage.onChanged 同步）
function cpoSetPhase2(patch) {
  return chrome.storage.local.get('cpo_state').then(({ cpo_state }) => {
    const cur = cpo_state || {};
    const p2 = { status: 'idle', step: 0, label: '', collected2: {}, ...(cur.phase2 || {}), ...patch };
    return chrome.storage.local.set({ cpo_state: { ...cur, phase2: p2, updatedAt: Date.now() } });
  });
}

// 捕获 openerTabId 点击弹出的子 tab，等 URL 命中 predicate 且加载完成 → tabId
// 注册时序：必须在发出触发点击命令【之前】调用，否则点击瞬间弹出的 tab 会漏捕获
function cpoCaptureChildTab(openerTabId, urlPredicate, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('未捕获到目标子 tab')); }, timeout);
    let childId = null;
    function hit(id, tab) {
      const url = (tab && tab.url) || '';
      if (url && urlPredicate(url) && tab.status === 'complete') { cleanup(); resolve(id); }
    }
    function onCreated(tab) {
      if (childId == null && tab.openerTabId === openerTabId) { childId = tab.id; hit(tab.id, tab); }
    }
    function onUpdated(id, _info, tab) { if (id === childId) hit(id, tab); }
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }
    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// add→edit：「获取1688订单」成功后店小秘跳 edit（同 tab 导航或新弹 tab 都覆盖）→ edit tabId
function cpoWaitEditTab(addTabId, timeout = 30000) {
  const pred = u => /\/purchasing\/order\/edit/.test(u);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('获取1688订单后未跳转到采购单编辑页')); }, timeout);
    function onUpdated(id, info, tab) {
      const url = (tab && tab.url) || info.url || '';
      if (url && pred(url) && tab.status === 'complete' && (id === addTabId || tab.openerTabId === addTabId)) {
        cleanup(); resolve(id);
      }
    }
    function cleanup() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// Phase 2 主编排：创建现有订单 → 通过审核 → 待到货定位 → 停在申请付款前
async function cpoRun2({ orderNo1688 }) {
  const { cpo_state } = await chrome.storage.local.get('cpo_state');
  const p1 = (cpo_state && cpo_state.phase1) || {};
  const skuNo = ((p1.collected && p1.collected.skuNo) || '').trim();
  if (p1.status !== 'done') { await cpoSetPhase2({ status: 'error', label: '请先完成 Phase 1 添加SKU' }); return; }
  if (!skuNo) { await cpoSetPhase2({ status: 'error', label: 'Phase 1 未采集到 SKU货号' }); return; }
  if (!orderNo1688 || !orderNo1688.trim()) { await cpoSetPhase2({ status: 'error', label: '1688订单号不能为空' }); return; }
  const order = orderNo1688.trim();

  const collected2 = { poNo: '', orderNo1688: order };
  const tmpTabs = [];   // 临时 tab，出错统一回收（待到货页除外）
  try {
    await cpoSetPhase2({ status: 'running', step: 1, label: '打开草稿页、点创建现有订单', collected2 });

    // step1：开 draft → 先挂 add tab 捕获监听（注册时序）→ 点创建现有订单 → 捕获 add tab
    const tDraft = await chrome.tabs.create({ url: CPO_DXM_DRAFT_URL, active: true });
    tmpTabs.push(tDraft.id);
    await cpoWaitTabComplete(tDraft.id);
    const addTabP = cpoCaptureChildTab(tDraft.id, u => /\/purchasing\/order\/add/.test(u));
    await cpoSendCommand(tDraft.id, 'CPO_P2_DRAFT_CREATE');
    const addTabId = await addTabP;
    tmpTabs.push(addTabId);

    // step2-3：add 选账号+填单号+获取；弹窗分流（bg 主导）
    await cpoSetPhase2({ step: 2, label: '填写1688账号与订单号、获取订单', collected2 });
    await cpoWaitTabComplete(addTabId);
    const editTabP = cpoWaitEditTab(addTabId).catch(() => null);   // 先挂 edit 监听（注册时序）；超时 null
    let exists = false;
    try {
      const r = await cpoSendCommand(addTabId, 'CPO_P2_ADD_FETCH', { orderNo1688: order });
      exists = !!(r && r.exists);
    } catch (_) { /* 跳转 edit 销毁 content 通道，靠 editTabP 接管 */ }
    if (exists) {
      await cpoCloseTab(addTabId);   // 关 add tab → 天然回触发 tab
      await cpoSetPhase2({ status: 'error', label: '当前输入的1688订单号已入库', collected2 });
      return;
    }

    // step3→4：接管 edit tab
    await cpoSetPhase2({ step: 3, label: '进入采购单编辑页', collected2 });
    const editTabId = await editTabP;
    if (!editTabId) throw new Error('获取1688订单后未跳转到采购单编辑页');
    tmpTabs.push(editTabId);
    await cpoWaitTabComplete(editTabId);

    // step4：edit 填采购人员/收货仓库 + 配对商品
    await cpoSetPhase2({ step: 4, label: '填采购人员/收货仓库、配对商品', collected2 });
    await cpoSendCommand(editTabId, 'CPO_P2_EDIT_FILL', { skuNo });

    // step5：保存并通过审核 → 抓成功弹窗提采购单号
    await cpoSetPhase2({ step: 5, label: '保存并通过审核', collected2 });
    const rSave = await cpoSendCommand(editTabId, 'CPO_P2_EDIT_SAVE');
    collected2.poNo = rSave.poNo;
    await cpoSetPhase2({ step: 5, label: '已通过审核，采购单 ' + rSave.poNo, collected2 });

    // step6：开待到货页搜索定位（新开 tab + 关 edit tab，避免 edit 未保存守卫阻塞 update + 残留）
    await cpoSetPhase2({ step: 6, label: '打开待到货页、搜索定位商品', collected2 });
    await cpoCloseTab(editTabId); tmpTabs.splice(tmpTabs.indexOf(editTabId), 1);
    const tWait = await chrome.tabs.create({ url: CPO_DXM_WAIT_URL, active: true });
    await cpoWaitTabComplete(tWait.id);
    await cpoSendCommand(tWait.id, 'CPO_P2_WAIT_SEARCH', { skuNo });
    // tWait 待到货页保留给用户点申请付款，不加入 tmpTabs、不回收

    // step7：done，提醒手动申请付款
    await cpoSetPhase2({ status: 'done', step: 7, label: '已定位商品，请手动点「申请付款」完成', collected2 });
  } catch (e) {
    for (const id of tmpTabs) { chrome.tabs.remove(id).catch(() => {}); }
    await cpoSetPhase2({ status: 'error', label: String(e?.message || e), collected2 });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'CPO_START_PHASE2') return;     // 只接管 CPO_START_PHASE2
  if (!msg.data) { sendResponse({ ok: false, error: '缺少启动参数' }); return; }
  cpoRun2(msg.data);                               // 异步跑，进度写 storage；不阻塞 ack
  sendResponse({ ok: true });
});
```

- [ ] **Step 2: 构建**

Run: `python build/build_extension.py`
Expected: 无报错；`dist/extension/background/service-worker.js` 含 `cpoRun2`。

- [ ] **Step 3: 手动验证编排骨架（浏览器）**

reload → 店小秘页 → 按 Task 2 Step 6 的方法置 phase1 done（带 `collected.skuNo`）→②区填订单号 → 开始。
观察：②区状态依次「进行中（打开草稿页…）」；前台开 draft tab；因 content 无 `CPO_P2_DRAFT_CREATE` handler，不弹 add tab，约 30s 后 add 捕获超时 → ②区红字「❌ 未捕获到目标子 tab」。SW 控制台（chrome://extensions → service worker）确认无未捕获异常、draft 临时 tab 已回收。
Expected: 编排链路通、状态写入 phase2、超时错误回收临时 tab（**handler 未实现故停在 step1，符合预期**）。

- [ ] **Step 4: 提交**

```bash
git add core/background/service-worker.js
git commit -m "feat(create_purchase_order): Phase 2 bg 编排 cpoRun2 + tab 捕获

Why: Phase 2 跨 draft/add/edit/waitArrival 多 tab，需 bg 编排 + 捕获店小秘自弹/跳转的 tab（add 不可构造 URL）
What: CPO 段加 cpoSetPhase2/cpoCaptureChildTab/cpoWaitEditTab/cpoRun2 + CPO_START_PHASE2 路由；bg 主导弹窗分流（race 已存在弹窗 vs edit 跳转）
Test: 手动验证编排链路通（handler 未实现故 step1 捕获超时 error，符合预期），临时 tab 回收

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

> **DOM 任务通用说明（Task 4-8）**：这些 handler 依赖店小秘真实 DOM，**无法离线单测**——验证靠浏览器实测。每个任务第一步必须 dump 真实 DOM 存到 `samples/`，再据真实结构校准 handler 选择器。给出的选择器是**基于 Phase 1 店小秘经验的最佳起点**（店小秘=Ant Design Vue：字段优先 `id`/`placeholder`；下拉/弹窗/选项结构非标准必须 dump；交互可能 hover 触发；确认按钮文案可能非「确定」），不是占位符，但**必须对照 dump 校准**。所有 `CPO_P2_*` handler 追加到 `content/index.js` 现有 `handlers` 表内（与 Phase 1 的 `CPO_READ_1688_TITLE` 等并列）。辅助函数加到 IIFE 内 `handlers` 之前。

## Task 4: 草稿页 handler —— CPO_P2_DRAFT_CREATE

**Files:**
- Modify: `features/create_purchase_order/content/index.js`
- Create: `features/create_purchase_order/samples/dxm_draft.txt`

- [ ] **Step 1: dump 草稿页「创建采购单」下拉 DOM**

开 `https://www.dianxiaomi.com/web/purchasing/order/draft/aliPurchasing`，console 跑并存到 `samples/dxm_draft.txt`：
```js
copy(Array.from(document.querySelectorAll('button,.ant-btn,a')).filter(b=>/创建采购单|创建现有|采购单/.test(b.textContent)).map(b=>b.outerHTML).join('\n---\n') || 'NOT_FOUND');
```
手动点开「创建采购单」按钮看下拉，再 dump 菜单：
```js
copy(Array.from(document.querySelectorAll('.ant-dropdown, .dropdown, [role="menu"]')).filter(d=>d.getBoundingClientRect().height>0).map(d=>d.outerHTML).join('\n---\n').slice(0,8000) || 'NO_DROPDOWN');
```
**重点记录**：①「创建采购单」按钮 selector + 下拉触发方式（click 还是 hover）；②「创建现有订单」菜单项 selector；③**关键风险**：点「创建现有订单」是同页路由、新 tab（`_blank`/`window.open`），还是别的——用 `getEventListeners` 或看元素 `href`/`target`。若 `_blank` 弹窗可能被拦（见 spec §3 风险点）。

- [ ] **Step 2: 据 dump 实现 handler**

在 `content/index.js` 的 `handlers` 表内追加（选择器据 Step 1 dump 校准）：
```js
    CPO_P2_DRAFT_CREATE: async () => {
      // 「创建采购单」带下拉。店小秘 Ant Design Vue，下拉可能 hover 触发（Phase 1「选择图片」踩过）
      const trigger = U.findByText('button, .ant-btn, a', '创建采购单');
      if (!trigger) return { ok: false, error: '未找到「创建采购单」按钮' };
      const host = trigger.closest('.ant-dropdown-trigger') || trigger;
      host.click();
      ['pointerover', 'mouseover', 'mouseenter'].forEach(n =>
        host.dispatchEvent(new MouseEvent(n, { bubbles: true, view: window })));
      try { await U.waitForEl('.ant-dropdown .item, .dropdown .item, [role="menuitem"], li', document, 4000); } catch {}
      const item = U.findByText('.ant-dropdown .item, .dropdown .item, [role="menuitem"], li, div.item', '创建现有订单');
      if (!item) return { ok: false, error: '未找到「创建现有订单」菜单项' };
      item.click();   // 触发店小秘弹出 add tab，bg cpoCaptureChildTab 捕获
      return { ok: true };
    },
```
> 若 Step 1 发现「创建现有订单」是 `_blank` 被拦：改为读其 `href` 由 bg `chrome.tabs.create` 打开（参考 Phase 1 踩坑1）；但 add URL 含新建参数（spec §3），若 href 是 js 动态生成则退回「让用户手动点该步」并在 ②区提示。具体策略据 dump 实测定。

- [ ] **Step 3: 构建**

Run: `python build/build_extension.py`
Expected: 无报错。

- [ ] **Step 4: 手动验证（浏览器）**

reload → 开 draft 页 → SW 控制台拿到该 tab id（`chrome.tabs.query({active:true,currentWindow:true}).then(t=>console.log(t[0].id))`）→ 发命令 `chrome.tabs.sendMessage(<draftTabId>, {type:'CPO_P2_DRAFT_CREATE'}).then(console.log)`。
Expected: 返回 `{ok:true}`，且店小秘弹出 add 页 tab（`/purchasing/order/add`）。若被弹窗拦截 → 按 Step 2 备注调整。

- [ ] **Step 5: 提交**

```bash
git add features/create_purchase_order/content/index.js features/create_purchase_order/samples/dxm_draft.txt
git commit -m "feat(create_purchase_order): 草稿页 handler 点创建现有订单

Why: Phase 2 step1 在草稿页触发「创建采购单→创建现有订单」弹出 add tab
What: CPO_P2_DRAFT_CREATE（找按钮+hover/click 展开下拉+点创建现有订单）；选择器据 samples/dxm_draft.txt 校准
Test: 手动验证返回 ok 且弹出 add tab（DOM handler 无离线单测）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: add 页 handler —— CPO_P2_ADD_FETCH（含 Ant Select 辅助）

**Files:**
- Modify: `features/create_purchase_order/content/index.js`
- Create: `features/create_purchase_order/samples/dxm_purchase_add.txt`

- [ ] **Step 1: dump add 页 DOM**

开 add 页（由 Task 4 弹出，或草稿页手动点「创建现有订单」进入），console 存到 `samples/dxm_purchase_add.txt`：
```js
copy(document.querySelector('form, .ant-form, body').outerHTML.slice(0, 30000));
```
填一个**已入库**的订单号点「获取1688订单」，待弹窗出现后 dump：
```js
copy(Array.from(document.querySelectorAll('.ant-modal,.ant-modal-confirm,.modal')).filter(d=>d.getBoundingClientRect().height>0).map(d=>d.outerHTML).join('\n---\n').slice(0,8000)||'NO_MODAL');
```
**重点记录**：①「1688账号」下拉 label + `.ant-select` 结构；②「1688订单」输入框 `id`/`placeholder`；③「获取1688订单」按钮文案；④已存在弹窗的文案关键词（确认是否含「已存在/不能重复添加/已完成」）+ 关闭按钮 selector；⑤未入库时跳转 edit 是同 tab 还是新 tab。

- [ ] **Step 2: 加 Ant Select 辅助函数**

在 `content/index.js` 的 IIFE 内、`handlers` 之前插入（与 Phase 1 `cpoFillPersonnel` 同款 aria-controls 锁定 + 轮询渲染）：
```js
  // 找标签文本对应的 ant-select（同 form-item 内含 .ant-select 的最小容器）
  function cpoFindSelectByLabel(labelText) {
    const want = U.normText(labelText);
    const item = Array.from(document.querySelectorAll('.ant-form-item, .form-item, [class*="item"], div'))
      .filter(el => U.normText(el.textContent).includes(want) && el.querySelector('.ant-select'))
      .sort((a, b) => a.textContent.length - b.textContent.length)[0];
    return item ? item.querySelector('.ant-select') : null;
  }

  // 打开 ant-select 下拉、选第一个可见非空选项（用于唯一项的账号下拉）→ 成功 true
  async function cpoSelectFirstOption(sel) {
    const combo = sel.querySelector('input');
    (sel.querySelector('.ant-select-selector') || sel).click();
    const listId = combo && (combo.getAttribute('aria-controls') || combo.getAttribute('aria-owns'));
    for (let i = 0; i < 30; i++) {
      await U.sleep(100);
      const scoped = listId && document.getElementById(listId)?.closest('.ant-select-dropdown');
      const scopes = scoped ? [scoped]
        : Array.from(document.querySelectorAll('.ant-select-dropdown')).filter(d => d.getBoundingClientRect().height > 0);
      for (const s of scopes) {
        const opt = Array.from(s.querySelectorAll('[role="option"], .ant-select-item-option'))
          .find(o => U.normText(o.textContent));   // 第一个有文本的选项
        if (opt) { opt.click(); return true; }
      }
    }
    return false;
  }

  // 选 ant-select 中 textContent 精确等于 want 的选项（采购人员/收货仓库用）→ 成功 true
  async function cpoSelectOptionByText(sel, want) {
    const combo = sel.querySelector('input');
    (sel.querySelector('.ant-select-selector') || sel).click();
    const listId = combo && (combo.getAttribute('aria-controls') || combo.getAttribute('aria-owns'));
    const target = U.normText(want);
    for (let i = 0; i < 30; i++) {
      await U.sleep(100);
      const scoped = listId && document.getElementById(listId)?.closest('.ant-select-dropdown');
      const scopes = scoped ? [scoped]
        : Array.from(document.querySelectorAll('.ant-select-dropdown')).filter(d => d.getBoundingClientRect().height > 0);
      for (const s of scopes) {
        const opt = Array.from(s.querySelectorAll('[role="option"], .ant-select-item-option'))
          .find(o => U.normText(o.textContent) === target);
        if (opt) { opt.click(); return true; }
      }
    }
    return false;
  }
```

- [ ] **Step 3: 据 dump 实现 handler**

在 `handlers` 表内追加（选择器据 Step 1 dump 校准）：
```js
    CPO_P2_ADD_FETCH: async ({ orderNo1688 }) => {
      // a) 1688账号下拉选第一项（唯一、与账号绑定）
      const acctSel = cpoFindSelectByLabel('1688账号');
      if (!acctSel) return { ok: false, error: '未找到「1688账号」下拉' };
      if (!(await cpoSelectFirstOption(acctSel))) return { ok: false, error: '「1688账号」下拉无可选项' };
      await U.sleep(200);
      // b) 填 1688订单号（据 dump 校准 id/placeholder）
      const orderInput = document.querySelector('input[placeholder*="1688订单"], input[placeholder*="订单号"]');
      if (!orderInput) return { ok: false, error: '未找到「1688订单」输入框' };
      U.setInputValue(orderInput, orderNo1688);
      await U.sleep(150);
      // c) 点「获取1688订单」
      const fetchBtn = U.findByText('button, .ant-btn', '获取1688订单') || U.findByText('button, .ant-btn', '获取订单');
      if (!fetchBtn) return { ok: false, error: '未找到「获取1688订单」按钮' };
      fetchBtn.click();
      // d) 轮询「已存在」弹窗（业务拦截）；未出现则 exists:false（bg 靠 edit 跳转监听接管）
      for (let i = 0; i < 25; i++) {                 // ~5s
        await U.sleep(200);
        const dlg = Array.from(document.querySelectorAll('.ant-modal, .ant-modal-confirm, .modal'))
          .find(d => d.getBoundingClientRect().height > 0 && /已存在|不能重复添加|已完成/.test(d.textContent));
        if (dlg) {
          const closeBtn = U.findByText('.ant-modal button, .modal button', '关闭')
            || dlg.querySelector('.ant-modal-close, .ant-modal-close-x');
          closeBtn?.click();
          return { ok: true, exists: true };
        }
      }
      return { ok: true, exists: false };
    },
```

- [ ] **Step 4: 构建 + 手动验证（浏览器）**

Run: `python build/build_extension.py`，reload。
开 add 页 → SW 控制台对该 tab 发 `chrome.tabs.sendMessage(<addTabId>, {type:'CPO_P2_ADD_FETCH', data:{orderNo1688:'<真实订单号>'}}).then(console.log)`：
- 用**已入库**订单号 → 返回 `{ok:true, exists:true}`，弹窗被关。
- 用**未入库**订单号 → 账号选好、订单号填入、点获取后页面跳转 edit（content 通道断属正常），返回前可能因导航中断；在 add 页未跳转时返回 `{ok:true, exists:false}`。
Expected: 账号/订单号正确填、获取触发；已入库识别准确并关弹窗。

- [ ] **Step 5: 提交**

```bash
git add features/create_purchase_order/content/index.js features/create_purchase_order/samples/dxm_purchase_add.txt
git commit -m "feat(create_purchase_order): add 页 handler 选账号+填单号+获取+已存在分流

Why: Phase 2 step2-3 在 add 页选1688账号、填订单号、获取订单，并检测已入库弹窗
What: CPO_P2_ADD_FETCH + cpoFindSelectByLabel/cpoSelectFirstOption/cpoSelectOptionByText 辅助；轮询已存在弹窗返回 exists；选择器据 samples/dxm_purchase_add.txt 校准
Test: 手动验证已入库/未入库两场景（DOM handler 无离线单测）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: edit 页 handler —— CPO_P2_EDIT_FILL（采购人员/收货仓库 + 配对商品）

> Phase 2 最大块。采购人员选 `user_name`（读 `.user-name`，同 Phase 1）、收货仓库选「中正科技仓」、配对商品弹窗全流程（搜索 SKU货号→选中→修改所有xxx→确认）。

**Files:**
- Modify: `features/create_purchase_order/content/index.js`
- Create: `features/create_purchase_order/samples/dxm_purchase_edit.txt`

- [ ] **Step 1: dump edit 页 + 配对弹窗 DOM**

进 edit 页（Task 5 未入库订单跳转而来），console 存 `samples/dxm_purchase_edit.txt`：
```js
copy(document.querySelector('form, .ant-form, body').outerHTML.slice(0, 40000));
console.log('user-name:', document.querySelector('.user-name, [class*="user-name"]')?.textContent);
```
点「配对商品」后 dump 弹窗：
```js
copy(Array.from(document.querySelectorAll('.ant-modal-content,.modal-content,iframe')).filter(d=>d.getBoundingClientRect().height>0).map(d=>d.outerHTML||('IFRAME:'+d.src)).join('\n---\n').slice(0,20000)||'NONE');
```
点行内「选中」后 dump 二次弹窗：
```js
copy(Array.from(document.querySelectorAll('.ant-modal-content,.ant-modal-confirm,.modal-content')).filter(d=>d.getBoundingClientRect().height>0).map(d=>d.outerHTML).join('\n---\n').slice(0,8000)||'NONE');
```
**重点记录**：①采购人员/收货仓库下拉 label + 是否有「中正科技仓」选项；②「配对商品」按钮（行内操作列）；③**配对弹窗是 modal 还是 iframe**（决定 root 取法）；④搜索类型下拉/搜索内容框/搜索按钮；⑤结果行「选中」按钮；⑥二次弹窗「修改所有xxx」**确切文案** + 确认按钮文案（「确认」还是「确定」）；⑦「保存，并通过审核」按钮文案（Task 7 用）。

- [ ] **Step 2: 实现 handler + 配对辅助**

在 IIFE 内 `handlers` 之前加配对辅助（**默认假设同页 modal**——ant-select dropdown 会 portal 到 body，沿用 `cpoSelectOptionByText`）：
```js
  // 配对商品：点「配对商品」→ 弹窗 → 搜索类型=商品SKU + 填货号 + 搜索 → 唯一行「选中」→「修改所有xxx」→「确认」
  async function cpoPairProduct(skuNo) {
    const pairBtn = U.findByText('button, .ant-btn, a', '配对商品');
    if (!pairBtn) return { ok: false, error: '未找到「配对商品」按钮' };
    pairBtn.click();
    let modal;
    try { modal = await U.waitForEl('.ant-modal-content, .modal-content', document, 6000); } catch {}
    if (!modal) return { ok: false, error: '配对商品弹窗未出现（若为 iframe 见 plan 备注）' };
    // 搜索类型选「商品SKU」（select 在 modal 内，dropdown portal 到 body）
    const typeSel = Array.from(modal.querySelectorAll('.ant-select'))
      .find(s => /搜索类型/.test((s.closest('.ant-form-item, [class*="item"], div') || modal).textContent))
      || modal.querySelector('.ant-select');
    if (typeSel) await cpoSelectOptionByText(typeSel, '商品SKU');
    await U.sleep(150);
    // 搜索内容填 skuNo
    const kwInput = modal.querySelector('input[placeholder*="搜索内容"], input[placeholder*="内容"], input[type="text"]');
    if (!kwInput) return { ok: false, error: '配对：未找到搜索内容输入框' };
    U.setInputValue(kwInput, skuNo);
    await U.sleep(150);
    // 搜索
    const searchBtn = U.findByText('button, .ant-btn', '搜索', modal);
    if (!searchBtn) return { ok: false, error: '配对：未找到搜索按钮' };
    searchBtn.click();
    // 等结果行内「选中」
    let selBtn = null;
    for (let i = 0; i < 30 && !selBtn; i++) {
      await U.sleep(200);
      selBtn = U.findByText('tbody button, tbody a, .ant-table button, .ant-table a', '选中', modal);
    }
    if (!selBtn) return { ok: false, error: '配对：搜索无结果或无「选中」按钮（货号 ' + skuNo + '）' };
    selBtn.click();
    // 二次弹窗：选「修改所有xxx」→ 确认（文案据 dump 校准）
    await U.sleep(300);
    const confirmModal = Array.from(document.querySelectorAll('.ant-modal-content, .ant-modal-confirm, .modal-content'))
      .filter(m => m.getBoundingClientRect().height > 0)
      .find(m => /修改所有/.test(m.textContent));
    if (confirmModal) {
      const opt = Array.from(confirmModal.querySelectorAll('label, .ant-radio-wrapper, .ant-checkbox-wrapper, [role="radio"]'))
        .find(el => /修改所有/.test(el.textContent));
      opt?.click();
      await U.sleep(150);
      const confirmBtn = U.findByText('.ant-modal button, .modal button', '确认', confirmModal)
        || U.findByText('.ant-modal button, .modal button', '确定', confirmModal);
      if (!confirmBtn) return { ok: false, error: '配对：未找到确认按钮' };
      confirmBtn.click();
    }
    await U.sleep(400);
    return { ok: true };
  }
```
在 `handlers` 表内追加：
```js
    CPO_P2_EDIT_FILL: async ({ skuNo }) => {
      U.showToast('创建采购单：填写采购信息…', 'info');
      // a) 采购人员选 user_name（读 .user-name，同 Phase 1）
      const userName = (document.querySelector('.user-name, [class*="user-name"]')?.textContent || '').trim();
      const buyerSel = cpoFindSelectByLabel('采购人员');
      if (buyerSel && userName) await cpoSelectOptionByText(buyerSel, userName);
      await U.sleep(150);
      // b) 收货仓库选「中正科技仓」
      const whSel = cpoFindSelectByLabel('收货仓库');
      if (!whSel) return { ok: false, error: '未找到「收货仓库」下拉' };
      if (!(await cpoSelectOptionByText(whSel, '中正科技仓'))) return { ok: false, error: '收货仓库下拉无「中正科技仓」选项' };
      await U.sleep(200);
      // c) 配对商品
      const pair = await cpoPairProduct(skuNo);
      if (!pair.ok) return pair;
      return { ok: true };
    },
```
> 若 Step 1 发现配对弹窗是 **iframe**：把 `cpoPairProduct` 里的 `document`/`modal` 改成 `iframe.contentDocument` 作 root，select 的 dropdown 也在 iframe document 内查（不 portal 到主 body）。据 dump 实测调整。

- [ ] **Step 3: 构建 + 手动验证（浏览器）**

Run: `python build/build_extension.py`，reload。
进一个真实 edit 页 → SW 控制台 `chrome.tabs.sendMessage(<editTabId>, {type:'CPO_P2_EDIT_FILL', data:{skuNo:'<phase1货号>'}}).then(console.log)`。
逐项核对：采购人员=user-name、收货仓库=中正科技仓、配对弹窗搜出唯一商品并选中、修改所有xxx 勾选、确认后回到 edit 页商品已配对。
Expected: 返回 `{ok:true}`，各项填对、商品配对成功。

- [ ] **Step 4: 提交**

```bash
git add features/create_purchase_order/content/index.js features/create_purchase_order/samples/dxm_purchase_edit.txt
git commit -m "feat(create_purchase_order): edit 页 handler 采购人员/收货仓库+配对商品

Why: Phase 2 step4 在 edit 页填采购人员、收货仓库，并配对 phase1 创建的 SKU 商品
What: CPO_P2_EDIT_FILL + cpoPairProduct（搜索类型=商品SKU+搜货号+选中+修改所有xxx+确认）；选择器据 samples/dxm_purchase_edit.txt 校准
Test: 手动验证三项填对 + 配对成功（DOM handler 无离线单测）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: edit 页 handler —— CPO_P2_EDIT_SAVE（保存并通过审核 + 提采购单号）

**Files:**
- Modify: `features/create_purchase_order/content/index.js`
- Modify: `features/create_purchase_order/samples/dxm_purchase_edit.txt`（补成功弹窗文案）

- [ ] **Step 1: dump 审核成功弹窗文案**

在一个可保存的 edit 页点「保存，并通过审核」，弹窗出现后立即 console：
```js
copy(Array.from(document.querySelectorAll('.ant-modal,.ant-modal-confirm,.ant-message,.ant-notification,.modal')).filter(d=>d.getBoundingClientRect().height>0).map(d=>d.textContent.trim()).join('\n---\n')||'NO_DLG');
```
追加到 `samples/dxm_purchase_edit.txt`。**重点核对**：成功弹窗文案是否形如 `操作成功：N个，采购单：PO1SLPTxxx已移入待到货状态`——确认 `extractPoNo` 的正则 `采购单[:：]\s*(PO\w+)` 能命中真实采购单号格式（若采购单号含连字符等非 `\w` 字符，回 Task 1 调正则并补单测）。

- [ ] **Step 2: 据 dump 实现 handler**

在 `handlers` 表内追加（选择器/弹窗 root 据 dump 校准）：
```js
    CPO_P2_EDIT_SAVE: async () => {
      const saveBtn = U.findByText('button, .ant-btn', '保存，并通过审核')
        || U.findByText('button, .ant-btn', '保存并通过审核');
      if (!saveBtn) return { ok: false, error: '未找到「保存，并通过审核」按钮' };
      U.showToast('创建采购单：正在保存并通过审核…', 'info');
      saveBtn.click();
      // 等成功弹窗（含「操作成功」或「采购单」）
      let text = '';
      for (let i = 0; i < 30; i++) {                 // ~6s
        await U.sleep(200);
        const dlg = Array.from(document.querySelectorAll('.ant-modal, .ant-modal-confirm, .ant-message, .ant-notification, .modal'))
          .find(d => d.getBoundingClientRect().height > 0 && /操作成功|采购单/.test(d.textContent));
        if (dlg) { text = dlg.textContent || ''; break; }
      }
      if (!text) return { ok: false, error: '未捕获到审核成功弹窗（保存可能被必填项拦截）' };
      const poNo = L.extractPoNo(text);
      if (!poNo) return { ok: false, error: '审核成功弹窗未解析出采购单号' };
      return { ok: true, poNo };
    },
```

- [ ] **Step 3: 构建 + 手动验证（浏览器）**

Run: `python build/build_extension.py`，reload。
在一个配对完成的 edit 页 → SW 控制台 `chrome.tabs.sendMessage(<editTabId>, {type:'CPO_P2_EDIT_SAVE'}).then(console.log)`。
Expected: 点保存并通过审核、弹窗出现，返回 `{ok:true, poNo:'PO1SLPT...'}`，poNo 与弹窗显示的采购单号一致。

- [ ] **Step 4: 提交**

```bash
git add features/create_purchase_order/content/index.js features/create_purchase_order/samples/dxm_purchase_edit.txt
git commit -m "feat(create_purchase_order): edit 页 handler 保存通过审核+提采购单号

Why: Phase 2 step5 点「保存，并通过审核」并从成功弹窗解析采购单号（hub 输出的 aaa）
What: CPO_P2_EDIT_SAVE（点保存+轮询成功弹窗+L.extractPoNo）；据 samples 校准弹窗文案
Test: 手动验证返回 poNo 与弹窗一致（DOM handler 无离线单测）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 待到货页 handler —— CPO_P2_WAIT_SEARCH

> 搜索定位商品行只为帮用户找到「申请付款」入口（采购单号已从审核弹窗取得，不依赖此搜索）。搜不到只 warn 不阻断 done（spec §4 step6）。

**Files:**
- Modify: `features/create_purchase_order/content/index.js`
- Create: `features/create_purchase_order/samples/dxm_wait_arrival.txt`

- [ ] **Step 1: dump 待到货页 DOM**

开 `https://www.dianxiaomi.com/web/purchasing/order/waitArrival`，console 存 `samples/dxm_wait_arrival.txt`：
```js
copy(document.querySelector('.search, form, .ant-form, body').outerHTML.slice(0, 30000));
```
手动搜一个货号出结果后，dump 表格区：
```js
copy(document.querySelector('.ant-table, table')?.outerHTML.slice(0,15000)||'NO_TABLE');
```
**重点记录**：①搜索类型下拉 label + 是否有「商品SKU」选项；②搜索内容输入框 `placeholder`；③搜索按钮文案（「搜索」还是「查询」）；④结果表格行 selector + 物流列（1688订单号显示处）；⑤「申请付款」按钮位置（供用户手动点，handler 不点）。

- [ ] **Step 2: 据 dump 实现 handler**

在 `handlers` 表内追加：
```js
    CPO_P2_WAIT_SEARCH: async ({ skuNo }) => {
      // 搜索类型选「商品SKU」
      const typeSel = cpoFindSelectByLabel('搜索类型');
      if (typeSel) await cpoSelectOptionByText(typeSel, '商品SKU');
      await U.sleep(150);
      // 搜索内容填 skuNo
      const kwInput = document.querySelector('input[placeholder*="搜索内容"], input[placeholder*="内容"], input[placeholder*="SKU"]');
      if (!kwInput) return { ok: false, error: '待到货页：未找到搜索内容输入框' };
      U.setInputValue(kwInput, skuNo);
      await U.sleep(150);
      // 搜索
      const searchBtn = U.findByText('button, .ant-btn', '搜索') || U.findByText('button, .ant-btn', '查询');
      if (!searchBtn) return { ok: false, error: '待到货页：未找到搜索按钮' };
      searchBtn.click();
      // 等表格出结果（found = 表格有命中行）
      let found = false;
      for (let i = 0; i < 25; i++) {                 // ~5s
        await U.sleep(200);
        const rows = document.querySelectorAll('.ant-table-tbody tr, tbody tr');
        if (Array.from(rows).some(r => r.textContent.includes(skuNo))) { found = true; break; }
      }
      U.showToast(found ? '已定位商品，请手动点「申请付款」' : '未搜到商品行，请手动核对', found ? 'ok' : 'error');
      return { ok: true, found };   // 搜不到不阻断 done（采购单号已从审核弹窗取得）
    },
```

- [ ] **Step 3: 构建 + 手动验证（浏览器）**

Run: `python build/build_extension.py`，reload。
开待到货页 → SW 控制台 `chrome.tabs.sendMessage(<waitTabId>, {type:'CPO_P2_WAIT_SEARCH', data:{skuNo:'<phase1货号>'}}).then(console.log)`。
Expected: 搜索类型切到商品SKU、填入货号、点搜索，表格显示该商品行，返回 `{ok:true, found:true}`；toast 提醒手动申请付款。

- [ ] **Step 4: 提交**

```bash
git add features/create_purchase_order/content/index.js features/create_purchase_order/samples/dxm_wait_arrival.txt
git commit -m "feat(create_purchase_order): 待到货页 handler 搜索定位商品行

Why: Phase 2 step6 跳待到货页定位商品行，帮用户找到「申请付款」入口
What: CPO_P2_WAIT_SEARCH（搜索类型=商品SKU+填货号+搜索+判命中）；搜不到只 warn 不阻断 done；选择器据 samples/dxm_wait_arrival.txt 校准
Test: 手动验证搜索定位（DOM handler 无离线单测）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 端到端 + 错误路径验证

> 不写新代码（除非验证暴露 bug）；用真实数据跑通全链路 + 验证中断路径。这是 Phase 2 的完成判定。

**Files:** 无新增（修 bug 时改 `content/index.js` 或 `core/background/service-worker.js`）

- [ ] **Step 1: 回归纯逻辑单测**

Run: `node --test features/create_purchase_order/tests/cpo-logic.test.js`
Expected: 15 passed, 0 fail。

- [ ] **Step 2: 端到端 happy path（浏览器）**

先完整跑一遍 Phase 1（或手动构造一个 `phase1.status==='done'` 且 `collected.skuNo` 为真实已建 SKU 的 `cpo_state`）。
店小秘任意页 → Hub → 创建采购单 →②区填一个**未入库**的真实 1688订单号 → 开始。
全程不手动干预，观察②区状态依次：打开草稿页 → 填账号订单号获取 → 进编辑页 → 填采购人员/收货仓库配对 → 保存并通过审核（显示采购单号）→ 打开待到货页搜索 → 「✅ 已定位商品，请手动点「申请付款」完成」，并显示 `当前订单信息：PO1SLPT…（订单号）`。
待到货页应停留、定位到该商品行。临时 tab（draft/add）已关。
Expected: 全链路通、采购单创建并通过审核、hub 输出正确、停在申请付款前、待到货 tab 保留。

- [ ] **Step 3: 错误路径①——已入库订单号**

②区填一个**已入库**的 1688订单号 → 开始。
Expected: 跑到 add 页获取后检测到已存在弹窗 → 关闭弹窗 + 关 add tab → 回到触发 tab → ②区红字「❌ 当前输入的1688订单号已入库」。可重新填别的订单号再开始。

- [ ] **Step 4: 错误路径②——前置校验**

- phase1 未 done（清掉 cpo_state 或 phase1 非 done）→②区按钮 disabled；强行触发应被 `validatePhase2` 拦截，红字「请先完成 Phase 1 添加SKU」。
- 订单号留空 → 按钮 disabled，无法启动。

- [ ] **Step 5: 验证错误后可重跑**

任一中断后重新填正确未入库订单号点开始 → Expected: 正常重跑。SW 控制台 `chrome.storage.local.get('cpo_state').then(console.log)` 确认中断后 `phase2.status:'error'`，重跑后回 `running→done`。

- [ ] **Step 6: 提交（若有修 bug）**

```bash
git add -A
git commit -m "fix(create_purchase_order): Phase 2 端到端验证修复

Why: 真实数据端到端暴露的问题（选择器/时序/tab 捕获/状态）
What: <按实际修复填写>
Test: 端到端 happy path 通 + 已入库中断 + 前置校验 + node --test 15 passed

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```
> 若无 bug，跳过提交，在 PR 描述记录「端到端验证通过，无需修复」。

---

## Task 10: feature 文档 CLAUDE.md 更新

**Files:**
- Modify: `features/create_purchase_order/CLAUDE.md`

- [ ] **Step 1: 更新 CLAUDE.md**

覆盖以下改动（据最终落地实现，含 Task 4-8 dump 校准后的真实选择器）：
- 概述②区状态从「待开发」改为「已实现」。
- 「架构」段补 Phase 2 编排（`cpoRun2` + `cpoCaptureChildTab`/`cpoWaitEditTab` tab 捕获，bg 主导弹窗分流）。
- 「消息协议」表加 `CPO_START_PHASE2` + 5 个 `CPO_P2_*`。
- 「各页 selector 全集」加四节：草稿页 / add 页 / edit 页（含配对弹窗） / 待到货页（用 Task 4-8 dump 的真实选择器）。
- 「踩坑清单」补 Phase 2 新踩坑（如 add tab 捕获时序、`_blank` 拦截实测结论、配对弹窗 modal/iframe、bg 主导分流避免 content 销毁、已入库业务拦截文案分层）。
- 「状态模型」补 `phase2 = {status,step,label,collected2:{poNo,orderNo1688}}`。
- 删除/改写文末「Phase 2 预告」段为「Phase 2 已实现」小结。
- 引用 spec/plan：`2026-05-27-create-purchase-order-phase2-design.md` / `2026-05-27-create-purchase-order-phase2.md`。

- [ ] **Step 2: 提交**

```bash
git add features/create_purchase_order/CLAUDE.md
git commit -m "docs(create_purchase_order): 补 Phase 2 实现与踩坑

Why: 记录 Phase 2 编排、消息协议、店小秘采购页 selector、踩坑供后续维护
What: CLAUDE.md 补 Phase 2 架构/协议/selector全集/踩坑/状态模型，解除 Phase 2 预告
Test: not run (文档)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## 完成后

1. 最终回归：`node --test features/create_purchase_order/tests/cpo-logic.test.js`（15 passed）+ 一次完整端到端。
2. 用 `superpowers:requesting-code-review` 或 `/review` 审查整个 diff。
3. 推分支 + 开 PR（`shipping-rules.md` PR 流程）。PR 描述说明：Phase 2 跨 draft/add/edit/waitArrival 编排、bg 主导弹窗分流、停在申请付款前。
4. 本 PR 不发版（按 [[project_pending_release]] 攒批策略，等后续一起发 tag）。
