# 创建采购单 — 商品复购模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 create_purchase_order 加「商品复购」模式：勾选后用户手填 SKU货号+1688订单号，跳过 Phase 1 直接跑 Phase 2。

**Architecture:** 增量改三处逻辑分叉（纯逻辑校验 / bg 取 skuNo / UI 按钮+渲染）+ ②区新增复购开关与 SKU货号输入框。复购态持久化到 `cpo_state.repurchase`，沿用本 feature「单一状态源 + storage.onChanged」哲学。Phase 2 内部编排步骤完全不动，只换 skuNo 来源 + 跳过前置校验。

**Tech Stack:** Chrome MV3 扩展（vanilla JS content script + service worker）、`chrome.storage.local`、`node:test` 纯逻辑单测。

**Spec:** `docs/superpowers/specs/2026-05-29-create-purchase-order-repurchase-mode-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `features/create_purchase_order/cpo-logic.js` | 纯逻辑（校验/映射/提取） | `validatePhase2` 加 repurchase 分支 |
| `features/create_purchase_order/tests/cpo-logic.test.js` | `node --test` 纯逻辑单测 | 加复购分支用例 |
| `core/background/service-worker.js` | bg 跨 tab 编排（CPO 标记段） | `cpoRun2` 加 repurchase skuNo 来源分叉 |
| `features/create_purchase_order/content/index.js` | ②区 UI + 渲染 + 启动 | 复购开关 + SKU输入框 + renderState/recomputeP2Btn/onStartPhase2 分支 |
| `features/create_purchase_order/CLAUDE.md` | feature 文档 | 落地后补复购模式说明 |

**依赖顺序**：Task 1（纯逻辑，无依赖）→ Task 2（bg，依赖消息字段约定）→ Task 3（UI，依赖 1+2 的契约）→ Task 4（构建/验证/文档）。Task 3 内部强耦合（render 建元素、renderState 引用、事件回调），作为一个 task 一次改完 index.js，避免留下运行时跑不通的中间态。

---

## Task 1: `validatePhase2` 复购分支（纯逻辑 TDD）

**Files:**
- Modify: `features/create_purchase_order/cpo-logic.js:52-60`
- Test: `features/create_purchase_order/tests/cpo-logic.test.js`

- [ ] **Step 1: 写失败测试**

在 `tests/cpo-logic.test.js` 末尾（第 98 行 `validatePhase2: 订单号为空` 用例之后、文件结束前）追加：

```javascript
test('validatePhase2: 复购模式 skuNo+订单号齐全（跳过 phase1）', () => {
  assert.deepStrictEqual(
    validatePhase2({ orderNo1688: 'AB123', phase1Done: false, repurchase: true, skuNo: 'SKU-001' }),
    { ok: true }
  );
});
test('validatePhase2: 复购模式缺 skuNo', () => {
  const r = validatePhase2({ orderNo1688: 'AB123', phase1Done: false, repurchase: true, skuNo: '  ' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /SKU货号/);
});
test('validatePhase2: 复购模式缺订单号', () => {
  const r = validatePhase2({ orderNo1688: '', phase1Done: false, repurchase: true, skuNo: 'SKU-001' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /1688订单号/);
});
test('validatePhase2: 新品分支不回归（repurchase 缺省）', () => {
  const r = validatePhase2({ orderNo1688: 'AB123', phase1Done: false });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Phase 1|添加SKU/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test features/create_purchase_order/tests/cpo-logic.test.js`
Expected: FAIL —— 「复购模式 skuNo+订单号齐全」用例失败（现状 `repurchase` 被忽略，`phase1Done:false` 走「请先完成 Phase 1」分支返回 `ok:false`，与期望 `{ok:true}` 不符）。

- [ ] **Step 3: 改 `validatePhase2` 加复购分支**

把 `cpo-logic.js` 第 52-60 行的 `validatePhase2`：

```javascript
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

替换为：

```javascript
  // 校验 Phase 2 启动：
  // - 复购模式（repurchase）：跳过 phase1 校验，要求手填 SKU货号 + 1688订单号
  // - 新品模式：phase1 必须 done + 1688订单号非空（现状，向后兼容：不传 repurchase 即此分支）
  function validatePhase2({ orderNo1688, phase1Done, repurchase, skuNo } = {}) {
    if (repurchase) {
      if (!skuNo || !String(skuNo).trim()) {
        return { ok: false, error: 'SKU货号不能为空' };
      }
    } else if (!phase1Done) {
      return { ok: false, error: '请先完成 Phase 1 添加SKU' };
    }
    if (!orderNo1688 || !String(orderNo1688).trim()) {
      return { ok: false, error: '1688订单号不能为空' };
    }
    return { ok: true };
  }
```

- [ ] **Step 4: 跑测试确认全过**

Run: `node --test features/create_purchase_order/tests/cpo-logic.test.js`
Expected: PASS —— 所有用例通过（含原有 validatePhase2 三例 + 新增四例），0 失败。

- [ ] **Step 5: 提交**

```bash
git add features/create_purchase_order/cpo-logic.js features/create_purchase_order/tests/cpo-logic.test.js
git commit -m "$(cat <<'EOF'
feat(create_purchase_order): validatePhase2 加复购分支

Why: 复购模式跳过 Phase 1，校验改为「手填 skuNo + 订单号非空」而非
「phase1 done + 订单号」。
What: validatePhase2 签名加 repurchase/skuNo，repurchase=true 走复购分支；
新品分支向后兼容（不传 repurchase 即原行为）。
Test: node --test cpo-logic.test.js 全过（含新增 4 例复购用例）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `cpoRun2` 复购模式 skuNo 来源分叉（bg 编排）

**Files:**
- Modify: `core/background/service-worker.js:465-474`（`cpoRun2` 签名 + 校验 + collected2 初始化）

**无纯逻辑单测**：`cpoRun2` 依赖 `chrome.storage` / `chrome.tabs` API，无法 `node --test`。本 task 只保证代码改对、service worker 能正常注册（无语法错）；复购端到端逻辑验证留到 Task 4。

- [ ] **Step 1: 改 `cpoRun2` 签名 + skuNo 来源分叉**

把 `service-worker.js` 第 465-474 行：

```javascript
async function cpoRun2({ orderNo1688, autoSave = true }, originTabId = null) {
  const { cpo_state } = await chrome.storage.local.get('cpo_state');
  const p1 = (cpo_state && cpo_state.phase1) || {};
  const skuNo = ((p1.collected && p1.collected.skuNo) || '').trim();
  if (p1.status !== 'done') { await cpoSetPhase2({ status: 'error', label: '请先完成 Phase 1 添加SKU' }); return; }
  if (!skuNo) { await cpoSetPhase2({ status: 'error', label: 'Phase 1 未采集到 SKU货号' }); return; }
  if (!orderNo1688 || !orderNo1688.trim()) { await cpoSetPhase2({ status: 'error', label: '1688订单号不能为空' }); return; }
  const order = orderNo1688.trim();

  const collected2 = { poNo: '', orderNo1688: order };
```

替换为：

```javascript
async function cpoRun2({ orderNo1688, autoSave = true, repurchase = false, skuNo: repurchaseSkuNo = '' }, originTabId = null) {
  const { cpo_state } = await chrome.storage.local.get('cpo_state');
  const p1 = (cpo_state && cpo_state.phase1) || {};
  // skuNo 来源分叉：复购用用户手填（消息传入，跳过 phase1）；新品用 Phase 1 采集值 + 强校验 phase1 done
  let skuNo;
  if (repurchase) {
    skuNo = (repurchaseSkuNo || '').trim();
    if (!skuNo) { await cpoSetPhase2({ status: 'error', label: '复购模式：SKU货号不能为空' }); return; }
  } else {
    skuNo = ((p1.collected && p1.collected.skuNo) || '').trim();
    if (p1.status !== 'done') { await cpoSetPhase2({ status: 'error', label: '请先完成 Phase 1 添加SKU' }); return; }
    if (!skuNo) { await cpoSetPhase2({ status: 'error', label: 'Phase 1 未采集到 SKU货号' }); return; }
  }
  if (!orderNo1688 || !orderNo1688.trim()) { await cpoSetPhase2({ status: 'error', label: '1688订单号不能为空' }); return; }
  const order = orderNo1688.trim();

  // collected2 写入 skuNo：供 done 后面板回填 SKU货号框展示（复购 skuNo 不在 phase1.collected）
  const collected2 = { poNo: '', orderNo1688: order, skuNo };
```

> 后续 `cpoSetPhase2({ ..., collected2 })` 各调用点不变 —— `collected2` 现在多带 `skuNo` 字段会随之写入 `phase2.collected2`。Phase 2 的 add/edit/save/wait 步骤用 `skuNo` 局部变量，来源已分叉、用法不变。

- [ ] **Step 2: 构建 + 确认 service worker 无语法错**

Run: `python3 build/build_extension.py`
Expected: 构建成功输出到 `dist/extension/`，无报错。

提示用户去 `chrome://extensions` reload 扩展，点扩展卡片「service worker」→「检查」，确认控制台**无红色语法/加载错误**（service worker 正常注册）。

- [ ] **Step 3: 提交**

```bash
git add core/background/service-worker.js
git commit -m "$(cat <<'EOF'
feat(create_purchase_order): cpoRun2 复购模式 skuNo 来源分叉

Why: 复购模式 skuNo 来自用户手填（消息传入）而非 phase1.collected，
且需跳过 phase1.status==='done' 强校验。
What: cpoRun2 签名加 repurchase/skuNo；repurchase=true 时 skuNo 取消息
入参 + 跳过 phase1 校验；collected2 写入 skuNo 供 done 后回填展示。
Phase 2 内部编排步骤不变。
Test: not run (依赖 chrome API 无单测)；build 确认 SW 无语法错，
端到端验证见 Task 4

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: ②区复购开关 + SKU货号输入框（content/index.js）

**Files:**
- Modify: `features/create_purchase_order/content/index.js`（ui 引用 / renderState / recomputeP2Btn / onStartPhase2 / render / 新增 onToggleRepurchase）

**无纯逻辑单测**：content script 全是 DOM + chrome API，靠 Task 4 手动验证。本 task 内部强耦合（render 建元素、renderState 引用、事件回调），一次改完 index.js 再 build，不留中间提交。

- [ ] **Step 1: ui 对象加引用字段**

把第 33-35 行：

```javascript
  const ui = { startBtn: null, urlInput: null, localMsg: null, p1Status: null, p1Data: null,
               p2Status: null, p2Data: null, p2Btn: null, orderInput: null, p2Msg: null,
               poOutput: null, poBox: null, autoSaveChk: null };
```

替换为：

```javascript
  const ui = { startBtn: null, urlInput: null, localMsg: null, p1Status: null, p1Data: null,
               p2Status: null, p2Data: null, p2Btn: null, orderInput: null, p2Msg: null,
               poOutput: null, poBox: null, autoSaveChk: null,
               skuInput: null, repurchaseChk: null, p1Section: null };
```

- [ ] **Step 2: renderState 改 —— 复购态驱动 + 锁定/回填/灰显**

把第 82-98 行（从 `if (ui.orderInput) {` 到 `recomputeP2Btn();`）：

```javascript
    if (ui.orderInput) {
      // phase1+phase2 都完成：回填本次 1688订单号并锁成只读，跨 tab 共享同一份；
      // 用 readOnly 自身判断「上次是否锁定」——从锁定态解除（清除/新流程）时清空回填值、恢复可输入
      const bothDone = p1.status === 'done' && p2.status === 'done' && c2.orderNo1688;
      if (bothDone) {
        ui.orderInput.value = c2.orderNo1688;
        ui.orderInput.readOnly = true;
        ui.orderInput.style.background = '#f7f7f7';
      } else if (ui.orderInput.readOnly) {
        ui.orderInput.value = '';
        ui.orderInput.readOnly = false;
        ui.orderInput.style.background = '';
      }
    }
    lastP1Done = (p1.status === 'done');
    recomputeP2Btn();
```

替换为：

```javascript
    // 复购态（持久化在 cpo_state.repurchase）：驱动 checkbox / SKU框可编辑 / ①区灰显
    const repurchase = !!(state && state.repurchase);
    if (ui.repurchaseChk) ui.repurchaseChk.checked = repurchase;

    // 完成锁定：phase2 done 即锁（覆盖复购——复购无 phase1 done，不能再依赖 bothDone）
    const locked = p2.status === 'done' && !!c2.orderNo1688;
    if (ui.orderInput) {
      // 用 readOnly 自身判断「上次是否锁定」——从锁定态解除（清除/新流程）时清空回填值、恢复可输入
      if (locked) {
        ui.orderInput.value = c2.orderNo1688;
        ui.orderInput.readOnly = true;
        ui.orderInput.style.background = '#f7f7f7';
      } else if (ui.orderInput.readOnly) {
        ui.orderInput.value = '';
        ui.orderInput.readOnly = false;
        ui.orderInput.style.background = '';
      }
    }
    if (ui.skuInput) {
      // SKU货号框：完成锁定回填本次值（复购 skuNo 在 collected2，新品在 phase1.collected）；
      // 复购态可编辑（保留用户输入）；新品态只读回填 phase1 货号
      const p1Sku = (p1.collected && p1.collected.skuNo) || '';
      if (locked) {
        ui.skuInput.value = c2.skuNo || p1Sku;
        ui.skuInput.readOnly = true;
        ui.skuInput.style.background = '#f7f7f7';
      } else if (repurchase) {
        if (ui.skuInput.readOnly) ui.skuInput.value = '';   // 从只读态切入复购清空一次，之后保留用户输入
        ui.skuInput.readOnly = false;
        ui.skuInput.style.background = '';
      } else {
        ui.skuInput.value = p1Sku;
        ui.skuInput.readOnly = true;
        ui.skuInput.style.background = '#f7f7f7';
      }
    }
    // ①区灰显：仅店小秘页 + 复购模式（Temu 列表页不灰，否则用户既取消不了复购、又用不了①区 → 死锁）
    if (ui.p1Section) {
      const dim = repurchase && isDxmPage();
      ui.p1Section.style.opacity = dim ? '0.45' : '';
      ui.p1Section.style.pointerEvents = dim ? 'none' : '';
    }
    lastP1Done = (p1.status === 'done');
    recomputeP2Btn();
```

> `c2` 已在本函数第 69 行定义（`const c2 = p2.collected2 || {};`），新增 `c2.skuNo` 引用复用它。

- [ ] **Step 3: recomputeP2Btn 加复购分支**

把第 156-162 行：

```javascript
  let lastP1Done = false;
  function recomputeP2Btn() {
    if (!ui.p2Btn) return;
    const orderVal = (ui.orderInput && ui.orderInput.value || '').trim();
    const locked = !!(ui.orderInput && ui.orderInput.readOnly);   // 流程完成锁定态：禁用，引导先清除再开新单
    ui.p2Btn.disabled = locked || !(lastP1Done && isDxmPage() && orderVal);
  }
```

替换为：

```javascript
  let lastP1Done = false;
  function recomputeP2Btn() {
    if (!ui.p2Btn) return;
    const orderVal = (ui.orderInput && ui.orderInput.value || '').trim();
    const locked = !!(ui.orderInput && ui.orderInput.readOnly);   // 流程完成锁定态：禁用，引导先清除再开新单
    const repurchase = !!(ui.repurchaseChk && ui.repurchaseChk.checked);
    if (repurchase) {
      // 复购：去掉 phase1 依赖，要求手填 SKU货号 + 1688订单号
      const skuVal = (ui.skuInput && ui.skuInput.value || '').trim();
      ui.p2Btn.disabled = locked || !(isDxmPage() && orderVal && skuVal);
    } else {
      ui.p2Btn.disabled = locked || !(lastP1Done && isDxmPage() && orderVal);
    }
  }
```

- [ ] **Step 4: onStartPhase2 带复购参数 + 新增 onToggleRepurchase**

把第 172-179 行（onStartPhase2 内 try 块开头）：

```javascript
      const orderNo1688 = (ui.orderInput && ui.orderInput.value || '').trim();
      const o = await chrome.storage.local.get(STATE_KEY);
      const p1Done = !!(o[STATE_KEY] && o[STATE_KEY].phase1 && o[STATE_KEY].phase1.status === 'done');
      const v = L.validatePhase2({ orderNo1688, phase1Done: p1Done });
      if (!v.ok) { setP2Msg(v.error, 'error'); return; }   // finally 会复位守卫+恢复按钮
      setP2Msg('启动中…');
      const autoSave = ui.autoSaveChk ? ui.autoSaveChk.checked : true;
      const resp = await chrome.runtime.sendMessage({ type: 'CPO_START_PHASE2', data: { orderNo1688, autoSave } });
```

替换为：

```javascript
      const orderNo1688 = (ui.orderInput && ui.orderInput.value || '').trim();
      const repurchase = !!(ui.repurchaseChk && ui.repurchaseChk.checked);
      const skuNo = (ui.skuInput && ui.skuInput.value || '').trim();
      const o = await chrome.storage.local.get(STATE_KEY);
      const p1Done = !!(o[STATE_KEY] && o[STATE_KEY].phase1 && o[STATE_KEY].phase1.status === 'done');
      const v = L.validatePhase2({ orderNo1688, phase1Done: p1Done, repurchase, skuNo });
      if (!v.ok) { setP2Msg(v.error, 'error'); return; }   // finally 会复位守卫+恢复按钮
      setP2Msg('启动中…');
      const autoSave = ui.autoSaveChk ? ui.autoSaveChk.checked : true;
      const resp = await chrome.runtime.sendMessage({ type: 'CPO_START_PHASE2', data: { orderNo1688, autoSave, repurchase, skuNo } });
```

紧接着在 `onStartPhase2` 函数的右大括号 `}`（第 188 行）之后、`// 清除当前流程数据` 注释（第 190 行）之前，新增函数：

```javascript

  // 切换复购态：写持久化 cpo_state.repurchase（storage.onChanged → renderState 统一刷新
  // checkbox / SKU框可编辑性 / ①区灰显，单一数据源驱动）
  async function onToggleRepurchase() {
    const o = await chrome.storage.local.get(STATE_KEY);
    const st = o[STATE_KEY] || {};
    st.repurchase = !!(ui.repurchaseChk && ui.repurchaseChk.checked);
    st.updatedAt = Date.now();
    await chrome.storage.local.set({ [STATE_KEY]: st });
  }
```

- [ ] **Step 5: render —— ①区包进 ui.p1Section 容器（供灰显）**

把第 225-255 行（①区构建，从 `// ===== ① 添加SKU` 到 list/note 分支结束）：

```javascript
      // ===== ① 添加SKU（Temu 发起） =====
      const h1 = document.createElement('div');
      h1.style.cssText = 'font-weight:600;color:#1677ff;';
      h1.textContent = '① 添加SKU';
      ui.p1Status = document.createElement('div');
      ui.p1Status.style.cssText = 'color:#666;';
      ui.p1Data = document.createElement('div');
      ui.p1Data.style.cssText = 'color:#888;font-size:11px;line-height:1.4;';
      wrap.append(h1, ui.p1Status, ui.p1Data);

      if (isListPage()) {
        const hint = document.createElement('div');
        hint.style.cssText = 'color:#666;line-height:1.4;';
        hint.textContent = '点选商品（整行高亮），填 1688 链接后开始';
        ui.urlInput = document.createElement('input');
        ui.urlInput.placeholder = '1688商品url';
        ui.urlInput.style.cssText = 'padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;';
        ui.startBtn = document.createElement('button');
        ui.startBtn.className = 'tal-action-btn';
        ui.startBtn.textContent = '开始添加SKU';
        ui.startBtn.disabled = !selectedSkc;
        ui.startBtn.addEventListener('click', onStartPhase1);
        ui.localMsg = document.createElement('div');
        ui.localMsg.style.cssText = 'font-size:11px;color:#666;min-height:16px;';
        wrap.append(hint, ui.urlInput, ui.startBtn, ui.localMsg);
      } else {
        const note = document.createElement('div');
        note.style.cssText = 'color:#999;font-size:11px;';
        note.textContent = '（在 Temu 商家中心商品列表发起）';
        wrap.append(note);
      }
```

替换为（所有 `wrap.append(...)` 改为 `ui.p1Section.append(...)`，末尾把容器挂上 wrap）：

```javascript
      // ===== ① 添加SKU（Temu 发起） =====
      // 包一层容器 ui.p1Section：复购模式时整块灰显（仅店小秘页，见 renderState）
      ui.p1Section = document.createElement('div');
      ui.p1Section.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
      const h1 = document.createElement('div');
      h1.style.cssText = 'font-weight:600;color:#1677ff;';
      h1.textContent = '① 添加SKU';
      ui.p1Status = document.createElement('div');
      ui.p1Status.style.cssText = 'color:#666;';
      ui.p1Data = document.createElement('div');
      ui.p1Data.style.cssText = 'color:#888;font-size:11px;line-height:1.4;';
      ui.p1Section.append(h1, ui.p1Status, ui.p1Data);

      if (isListPage()) {
        const hint = document.createElement('div');
        hint.style.cssText = 'color:#666;line-height:1.4;';
        hint.textContent = '点选商品（整行高亮），填 1688 链接后开始';
        ui.urlInput = document.createElement('input');
        ui.urlInput.placeholder = '1688商品url';
        ui.urlInput.style.cssText = 'padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;';
        ui.startBtn = document.createElement('button');
        ui.startBtn.className = 'tal-action-btn';
        ui.startBtn.textContent = '开始添加SKU';
        ui.startBtn.disabled = !selectedSkc;
        ui.startBtn.addEventListener('click', onStartPhase1);
        ui.localMsg = document.createElement('div');
        ui.localMsg.style.cssText = 'font-size:11px;color:#666;min-height:16px;';
        ui.p1Section.append(hint, ui.urlInput, ui.startBtn, ui.localMsg);
      } else {
        const note = document.createElement('div');
        note.style.cssText = 'color:#999;font-size:11px;';
        note.textContent = '（在 Temu 商家中心商品列表发起）';
        ui.p1Section.append(note);
      }
      wrap.append(ui.p1Section);
```

- [ ] **Step 6: render —— hr 后插入复购开关（仅店小秘页）**

把第 257-264 行（hr + ②区标题开头）：

```javascript
      const hr = document.createElement('div');
      hr.style.cssText = 'border-top:1px dashed #ddd;margin:4px 0;';
      wrap.append(hr);

      // ===== ② 创建采购单（店小秘发起，需 Phase 1 完成） =====
      const h2 = document.createElement('div');
      h2.style.cssText = 'font-weight:600;color:#1677ff;';
      h2.textContent = '② 创建采购单';
```

替换为：

```javascript
      const hr = document.createElement('div');
      hr.style.cssText = 'border-top:1px dashed #ddd;margin:4px 0;';
      wrap.append(hr);

      // ===== 复购开关（①②之间，仅店小秘页）：勾选 = 跳过①、手填SKU货号跑② =====
      if (isDxmPage()) {
        const repRow = document.createElement('label');
        repRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:#333;cursor:pointer;line-height:1.4;font-weight:600;';
        ui.repurchaseChk = document.createElement('input');
        ui.repurchaseChk.type = 'checkbox';
        ui.repurchaseChk.addEventListener('change', onToggleRepurchase);
        repRow.append(ui.repurchaseChk, document.createTextNode('商品复购（手动填SKU货号，跳过①添加SKU）'));
        wrap.append(repRow);
      }

      // ===== ② 创建采购单（店小秘发起；新品需 Phase 1 完成，复购手填SKU货号） =====
      const h2 = document.createElement('div');
      h2.style.cssText = 'font-weight:600;color:#1677ff;';
      h2.textContent = '② 创建采购单';
```

- [ ] **Step 7: render —— ②区加 SKU货号输入框 + 改 hint2 文案 + append 顺序**

7a. 把第 271-274 行（isDxmPage 分支开头的 hint2 + orderInput 起始）：

```javascript
      if (isDxmPage()) {
        const hint2 = document.createElement('div');
        hint2.style.cssText = 'color:#666;line-height:1.4;';
        hint2.textContent = '需先完成①添加SKU；填 1688订单号后开始';
        ui.orderInput = document.createElement('input');
```

替换为：

```javascript
      if (isDxmPage()) {
        const hint2 = document.createElement('div');
        hint2.style.cssText = 'color:#666;line-height:1.4;';
        hint2.textContent = '新品需先完成①添加SKU；复购勾选上方开关后手填SKU货号';
        // SKU货号框：复购可编辑 / 新品只读回填 phase1 货号（默认只读，renderState 据复购态切换）
        ui.skuInput = document.createElement('input');
        ui.skuInput.placeholder = 'SKU货号';
        ui.skuInput.readOnly = true;
        ui.skuInput.style.cssText = 'flex:1;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;background:#f7f7f7;';
        ui.skuInput.addEventListener('input', recomputeP2Btn);
        const skuRow = document.createElement('div');
        skuRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const skuLabel = document.createElement('span');
        skuLabel.textContent = 'SKU货号：';
        skuLabel.style.cssText = 'font-size:12px;color:#666;white-space:nowrap;';
        skuRow.append(skuLabel, ui.skuInput);
        ui.orderInput = document.createElement('input');
```

7b. 把第 309 行的 append（SKU框排在订单号上方）：

```javascript
        wrap.append(hint2, orderRow, saveChkLabel, ui.p2Btn, ui.poBox, ui.p2Msg);
```

替换为：

```javascript
        wrap.append(hint2, skuRow, orderRow, saveChkLabel, ui.p2Btn, ui.poBox, ui.p2Msg);
```

- [ ] **Step 8: 构建**

Run: `python3 build/build_extension.py`
Expected: 构建成功输出到 `dist/extension/`，无报错。

提示用户去 `chrome://extensions` 点扩展卡片右下角 reload，打开店小秘页 + Temu 列表页用于验证。

- [ ] **Step 9: 手动验证（reload 后逐项核对）**

> 复购验证需要一个**店小秘已建档的真实 SKU货号** + 一个**有效的 1688 订单号**（店小秘能获取到的）。

1. **复购态切换 + ①区灰显**：店小秘页打开 Hub「创建采购单」→ 勾「商品复购」→ ①添加SKU区整块变灰（半透明、点不动），SKU货号框由灰底只读变白底可编辑。取消勾选 → ①区恢复、SKU框回只读。
2. **死锁规避（关键）**：店小秘页勾「商品复购」后，切到 **Temu 列表页**打开同 feature → ①区**不灰**、能正常点选商品行 + 填 1688url + 点「开始添加SKU」。Temu 列表页**不出现**复购开关。
3. **复购按钮启用**：复购态下，仅填 SKU货号或仅填订单号 → 「开始创建采购单」灰；两者都填 → 按钮亮。
4. **复购端到端**：复购态填真实已建档 SKU货号 + 有效订单号 → 开始 → 走完 add取单 → edit填表配对 → 保存通过审核 → 待到货定位，采购单号正常解析显示。
5. **完成锁定**：复购 phase2 done 后，SKU货号框 + 1688订单号框都回填本次值且只读（灰底），采购单号只读框显示；点「清除当前流程」→ 两框解锁清空、复购开关取消勾选、采购单号框隐藏。
6. **跨 tab/面板重建一致**：勾复购后关闭 Hub 再打开（或另开一个店小秘 tab 打开 Hub）→ 复购开关仍勾选、SKU框仍可编辑（持久化生效）。
7. **新品回归**：不勾复购 → SKU货号框只读；「开始创建采购单」仍要求 phase1 done（无 phase1 时按钮灰）；跑过 phase1 后 SKU框自动回填采集到的货号。

- [ ] **Step 10: 提交**

```bash
git add features/create_purchase_order/content/index.js
git commit -m "$(cat <<'EOF'
feat(create_purchase_order): ②区复购开关 + SKU货号输入框

Why: 复购商品店小秘已有 SKU 档案，需跳过①添加SKU，手填 SKU货号+订单号
直接跑 Phase 2。
What: ①②之间加「商品复购」开关（仅店小秘页）+ ②区 SKU货号输入框；
复购态持久化 cpo_state.repurchase；renderState 据复购态驱动 checkbox/
SKU框可编辑性/①区灰显；recomputeP2Btn/onStartPhase2 加复购分支；
①区灰显限店小秘页防 Temu 页死锁。
Test: 手动验证 7 项（复购端到端/死锁规避/完成锁定/跨tab一致/新品回归）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 更新 feature 文档

**Files:**
- Modify: `features/create_purchase_order/CLAUDE.md`

- [ ] **Step 1: 在 CLAUDE.md「概述」的两阶段说明后补复购模式段**

在「## 概述」的两阶段列表之后，新增一小节（具体措辞按落地实现微调，要点须覆盖）：

```markdown
### 复购模式（v 后续）
- ②区「商品复购」开关（**仅店小秘页**显示，位于①②之间）。勾选 = 跳过①添加SKU，手填 `SKU货号 + 1688订单号` 直接跑 Phase 2。
- **作用域约束**：复购开关 + SKU货号框 + ①区灰显**均只在店小秘页生效**。Temu 列表页①区永远正常可用 —— 否则用户在 Temu 页既取消不了复购（开关不在）、又用不了①区 → 死锁。
- **状态**：复购态持久化 `cpo_state.repurchase`（boolean），与 phase1/phase2 同属单一状态源；checkbox/SKU框可编辑性/①区灰显全由 `renderState` 据它驱动，跨 tab / 面板重建一致。
- **skuNo 来源分叉**：复购 `cpoRun2` 用消息入参 `data.skuNo`（手填）+ 跳过 `phase1.status` 校验；新品仍读 `phase1.collected.skuNo`。复购 skuNo 写进 `collected2.skuNo` 供 done 后回填。
- **完成锁定**：改为 `phase2.status==='done' && collected2.orderNo1688`（不再依赖 phase1 done），覆盖两模式。
```

- [ ] **Step 2: 提交**

```bash
git add features/create_purchase_order/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(create_purchase_order): 补复购模式说明

Why: 沉淀复购模式的作用域约束（防死锁）+ 状态持久化 + skuNo 来源分叉，
供后续维护参考。
What: CLAUDE.md 概述补「复购模式」小节。
Test: not run (文档)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 完成定义

- `node --test cpo-logic.test.js` 全过（含 4 例复购用例）。
- 手动验证 7 项全部通过（重点：复购端到端 + 死锁规避 + 新品回归）。
- 四个 commit 落在 `feature/cpo-repurchase-mode` 分支。
- 后续走 PR 流程（用户触发）。
