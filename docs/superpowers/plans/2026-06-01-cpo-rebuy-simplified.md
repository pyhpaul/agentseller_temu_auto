# CPO 复购模式简化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CPO 复购模式简化为「只填 1688 订单号 + 选采购人员/仓库 → 保存通过审核 → PO 号搜索定位」；新品 Phase 2 的待到货页搜索 key 也从 skuNo 切到 poNo。

**Architecture:** 沿用 v1.2.0 既有架构（background 编排 + content 命令处理器 + chrome.storage.local 单一状态源），方案 A 原地替换——`CPO_P2_EDIT_FILL` 加 1 处 `if(repurchase)` 分支，`CPO_P2_WAIT_SEARCH` 入参 + 搜索类型 tag 全局统一改。

**Tech Stack:** 纯 JavaScript（ES2020+）；node --test 单测；Chrome MV3 content script + service worker；店小秘 Ant Design Vue。

**Spec:** `docs/superpowers/specs/2026-06-01-cpo-repurchase-simplified-design.md`

---

## Task 1: 验证待到货页搜索类型 DOM 假设（不写代码、必须先做）

**Files:**
- 无（只 dump 现场 DOM）

**Why first:** spec §7 #1 强制——若「采购单号」tag 不存在，后续 Task 6 实施代码会失败。必须先用真实 DOM 锁定 tag 文字（可能命名变体「采购单号」/「采购单 号」/「采购单 编号」/英文等）。

- [ ] **Step 1: 给用户 dump 脚本**

请用户：
1. 打开 https://www.dianxiaomi.com/purchasing/order/waitArrival
2. F12 → Console（page world 即可，不涉及扩展全局）
3. 粘贴：

```js
(function dumpSearchTypeTags() {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const tags = Array.from(document.querySelectorAll('.d-tag-group-item'));
  console.log(`找到 ${tags.length} 个 .d-tag-group-item:`);
  tags.forEach((t, i) => {
    console.log(`  [${i}] textContent="${norm(t.textContent)}" | classList=${[...t.classList].join(',')}`);
  });
  // 顺便检查搜索框 placeholder
  const kw = document.querySelector('#searchValue, input[name="tableSearchInput"]');
  console.log('搜索框 placeholder:', kw && kw.placeholder);
})();
```

- [ ] **Step 2: 收集用户反馈**

用户回贴 console 输出。Plan 执行者据结果填入下表（Task 6 实施时按此 tag 文案查询）：

| 字段 | 值 |
|------|---|
| 「采购单号」tag 完整精确文字 | **<待填>** |
| 切此 tag 后搜索框 placeholder 变成 | **<待填>** |

- [ ] **Step 3: 决策点**

- 若有「采购单号」tag → 继续 Task 2
- 若无 → **暂停**，回 brainstorming 改方案（备选：打开待到货页不搜、改用 1688 订单号搜、纯 done 不开待到货页）

**无需 commit**（无文件改动）。

---

## Task 2: validatePhase2 复购分支单测（TDD 红）

**Files:**
- Test: `features/create_purchase_order/tests/cpo-logic.test.js`

- [ ] **Step 1: 找到现有复购用例位置**

打开 `features/create_purchase_order/tests/cpo-logic.test.js`，找包含 `'复购'` 或 `repurchase` 字样的测试。预期有 4 例（spec §1 提及）。

运行：
```bash
grep -n "repurchase\|复购" features/create_purchase_order/tests/cpo-logic.test.js
```

- [ ] **Step 2: 改写 4 例复购用例 + 加 2 例新例**

把现有 4 例复购 `validatePhase2` 用例改造为：「不再要求 skuNo」「orderNo1688 是唯一必填」。

具体改造原则：
- 删除断言「skuNo 空时报错」（这例直接删除或改写）
- 删除断言「skuNo + orderNo1688 都非空 → 通过」中的 skuNo 入参（应改为 orderNo1688 单字段非空即通过）
- 保留断言「orderNo1688 空时报错」
- 保留断言「repurchase=true 跳过 phase1 done 校验」

加 2 个新例（写在 4 例旁，明确放在 `test('validatePhase2 复购分支')` 块附近）：

```js
test('validatePhase2: 复购模式 orderNo1688 非空 → 通过（无需 skuNo）', () => {
  const r = L.validatePhase2({ repurchase: true, orderNo1688: 'P1688001' });
  assert.deepEqual(r, { ok: true });
});

test('validatePhase2: 复购模式 orderNo1688 空 → 校验失败', () => {
  const r = L.validatePhase2({ repurchase: true, orderNo1688: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /1688订单号|订单号.*不能为空/);
});
```

- [ ] **Step 3: 跑单测验证红**

```bash
node --test features/create_purchase_order/tests/cpo-logic.test.js
```

预期：上面 2 个新例 + 改造后的若干旧例失败（具体看 `validatePhase2` 当前实现）。**输出里至少有 1 条 FAIL**。

若全部通过 → 说明改的不到位（旧例可能没真删 skuNo 必填断言）→ 回 Step 2 检查。

- [ ] **Step 4: 不 commit**（等 Task 3 绿了一起 commit）

---

## Task 3: validatePhase2 复购分支实现（TDD 绿）

**Files:**
- Modify: `features/create_purchase_order/cpo-logic.js`

- [ ] **Step 1: 定位 validatePhase2 当前实现**

```bash
grep -n "validatePhase2\|repurchase" features/create_purchase_order/cpo-logic.js
```

- [ ] **Step 2: 改 validatePhase2 复购分支**

原逻辑（v1.2.0 推断）：
```js
function validatePhase2({ orderNo1688, phase1Done, repurchase, skuNo }) {
  if (repurchase) {
    if (!skuNo || !String(skuNo).trim()) return { ok:false, error:'SKU货号不能为空（复购模式）' };
    if (!orderNo1688 || !String(orderNo1688).trim()) return { ok:false, error:'1688订单号不能为空' };
    return { ok:true };
  }
  // 新品分支不变
  ...
}
```

改为：
```js
function validatePhase2({ orderNo1688, phase1Done, repurchase }) {
  if (repurchase) {
    if (!orderNo1688 || !String(orderNo1688).trim()) {
      return { ok:false, error:'1688订单号不能为空（复购模式）' };
    }
    return { ok:true };
  }
  // 新品分支不变（继续原逻辑）
  ...
}
```

**关键**：删 `skuNo` 解构、删 skuNo 必填校验；签名向前兼容（调用方仍可传 skuNo，会被忽略）。

- [ ] **Step 3: 跑单测验证绿**

```bash
node --test features/create_purchase_order/tests/cpo-logic.test.js
```

预期：所有用例 PASS（包括 Task 2 新加的 2 例）。

若仍红 → 看 fail 输出，回 Step 2 检查 validatePhase2 实现。

- [ ] **Step 4: commit**

```bash
git add features/create_purchase_order/cpo-logic.js features/create_purchase_order/tests/cpo-logic.test.js
git commit -m "$(cat <<'EOF'
test+refactor(cpo): validatePhase2 复购分支只校验 orderNo1688

Why: 复购流程简化为只填 1688 订单号，SKU 货号不再参与流程。

What:
- cpo-logic.js: validatePhase2 复购分支删 skuNo 必填校验
- tests/cpo-logic.test.js: 改造 4 例复购用例 + 加 2 例（订单号空/非空）

Test: node --test features/create_purchase_order/tests/cpo-logic.test.js → all pass

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: cpoRun2 复购分支不读 skuNo + collected2 删字段

**Files:**
- Modify: `core/background/service-worker.js`（cpoRun2 函数）

- [ ] **Step 1: 定位 cpoRun2 复购分支代码**

```bash
grep -n "cpoRun2\|repurchaseSkuNo\|collected2 = \|repurchase" core/background/service-worker.js | head -30
```

- [ ] **Step 2: 改 cpoRun2 复购分支**

参考 service-worker.js:498-515 段。改动 3 处：

**改动 A：函数签名删 `skuNo: repurchaseSkuNo`**
```js
// 改前：
async function cpoRun2({ orderNo1688, autoSave = true, repurchase = false, skuNo: repurchaseSkuNo = '' }, originTabId = null) {

// 改后：
async function cpoRun2({ orderNo1688, autoSave = true, repurchase = false }, originTabId = null) {
```

**改动 B：复购分支不再取 / 校验 skuNo**

整段：
```js
// 改前（约 502-510）：
let skuNo;
if (repurchase) {
  skuNo = (repurchaseSkuNo || '').trim();
  if (!skuNo) { await cpoSetPhase2({ status: 'error', label: '复购模式：SKU货号不能为空' }); return; }
} else {
  skuNo = ((p1.collected && p1.collected.skuNo) || '').trim();
  if (!skuNo) { await cpoSetPhase2({ status: 'error', label: 'Phase 1 未采集到 SKU货号' }); return; }
}

// 改后：
let skuNo = '';                        // 新品才用；复购下 skuNo 留空
if (!repurchase) {
  skuNo = ((p1.collected && p1.collected.skuNo) || '').trim();
  if (!skuNo) { await cpoSetPhase2({ status: 'error', label: 'Phase 1 未采集到 SKU货号' }); return; }
}
```

**改动 C：collected2 删 skuNo 字段**
```js
// 改前（约 515）：
const collected2 = { poNo: '', orderNo1688: order, skuNo };

// 改后：
const collected2 = { poNo: '', orderNo1688: order };
```

- [ ] **Step 3: 改 CPO_P2_EDIT_FILL 调用入参（按复购模式区分）**

定位（约 service-worker.js:561）：
```bash
grep -n "CPO_P2_EDIT_FILL" core/background/service-worker.js
```

```js
// 改前：
await cpoSendCommand(editTabId, 'CPO_P2_EDIT_FILL', { skuNo });

// 改后（复购不传 skuNo，让 handler 据此决定是否走配对）：
await cpoSendCommand(editTabId, 'CPO_P2_EDIT_FILL', { skuNo, repurchase });
```

- [ ] **Step 4: 改 CPO_P2_WAIT_SEARCH 调用入参（新品+复购统一传 poNo）**

定位（约 service-worker.js:584）：
```bash
grep -n "CPO_P2_WAIT_SEARCH" core/background/service-worker.js
```

`poNo` 在保存成功后由 `extractPoNo` 写入 `collected2.poNo`。改：
```js
// 改前：
await cpoSendCommand(tWait.id, 'CPO_P2_WAIT_SEARCH', { skuNo });

// 改后：
const poNoForSearch = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY]?.phase2?.collected2?.poNo || '';
await cpoSendCommand(tWait.id, 'CPO_P2_WAIT_SEARCH', { poNo: poNoForSearch });
```

> 注：service-worker.js 可能已经把 collected2 维护在某个局部变量里——若 grep 看到 `collected2.poNo` 在 cpoRun2 局部可用，直接传 `collected2.poNo` 即可（比从 storage 反查更直接）。具体看 cpoRun2 实际结构。

- [ ] **Step 5: 不单测、build 自检**

无单测覆盖（service-worker 异步入口难单测）。靠 Task 8 联调验证。

```bash
node -c core/background/service-worker.js
```

预期：无 syntax error 输出。

- [ ] **Step 6: commit**

```bash
git add core/background/service-worker.js
git commit -m "$(cat <<'EOF'
refactor(cpo): cpoRun2 复购分支不再读 skuNo + 统一 WAIT_SEARCH 用 poNo

Why: 复购流程简化为只填 1688 订单号；待到货页搜索定位统一用 PO 号
（PO 号唯一性强、与保存返回值直接关联）。

What:
- cpoRun2 函数签名删 skuNo: repurchaseSkuNo 参数
- 复购分支不再校验 skuNo，新品分支保持
- collected2 字段精简为 { poNo, orderNo1688 }
- CPO_P2_EDIT_FILL 入参加 repurchase 标志（让 handler 决定是否配对）
- CPO_P2_WAIT_SEARCH 入参从 skuNo 改 poNo（新品+复购统一）

Test: node -c core/background/service-worker.js → syntax ok; 联调在 Task 8

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: UI 删 SKU 货号框 + renderState 改造

**Files:**
- Modify: `features/create_purchase_order/content/index.js`

- [ ] **Step 1: 定位 ui 引用对象 + skuInput DOM + renderState**

```bash
grep -n "skuInput\|SKU 货号\|SKU货号" features/create_purchase_order/content/index.js
```

预期看到：
- ui 对象声明 `skuInput`（约 line 36）
- renderState 内 `ui.skuInput.value = c2.skuNo || p1Sku` 等回填逻辑（约 line 102-106）
- ②区 panel render 内 SKU 货号 input DOM 块
- onStartPhase2 内 `const skuNo = (ui.skuInput && ui.skuInput.value || '').trim()`（约 line 210-217）

- [ ] **Step 2: ui 对象删 skuInput 引用**

约 line 36：
```js
// 改前：
const ui = { startBtn: null, urlInput: null, localMsg: null, p1Status: null, p1Data: null,
             p2Status: null, p2Data: null, p2Btn: null, orderInput: null, p2Msg: null,
             poOutput: null, poBox: null, autoSaveChk: null,
             skuInput: null, repurchaseChk: null, p1Section: null };

// 改后：
const ui = { startBtn: null, urlInput: null, localMsg: null, p1Status: null, p1Data: null,
             p2Status: null, p2Data: null, p2Btn: null, orderInput: null, p2Msg: null,
             poOutput: null, poBox: null, autoSaveChk: null,
             repurchaseChk: null, p1Section: null };
```

- [ ] **Step 3: renderState 删 skuInput 回填逻辑**

定位约 line 102-110。删除整段（含「完成锁定回填本次值」注释和 `ui.skuInput.value = ...` 赋值、`ui.skuInput.readOnly = ...` 锁定逻辑）。

- [ ] **Step 4: ②区 panel render DOM 删 SKU 货号 input 块**

定位 ②区 render 代码（搜 `'SKU货号'` 或 `skuInput` 在 createElement / innerHTML 段）。删除：
- SKU 货号 label
- SKU 货号 input 元素及其 `ui.skuInput = ...` 赋值
- 与之关联的样式 margin

> 不要删 1688 订单号框、复购开关、状态行 —— 只删 SKU 货号一组。

- [ ] **Step 5: onStartPhase2 内不再读 / 传 skuNo**

定位约 line 210-217：
```js
// 改前：
const skuNo = (ui.skuInput && ui.skuInput.value || '').trim();
...
const v = L.validatePhase2({ orderNo1688, phase1Done: p1Done, repurchase, skuNo });
...
const resp = await chrome.runtime.sendMessage({ type: 'CPO_START_PHASE2', data: { orderNo1688, autoSave, repurchase, skuNo } });

// 改后：
const v = L.validatePhase2({ orderNo1688, phase1Done: p1Done, repurchase });
...
const resp = await chrome.runtime.sendMessage({ type: 'CPO_START_PHASE2', data: { orderNo1688, autoSave, repurchase } });
```

- [ ] **Step 6: build 自检**

```bash
node -c features/create_purchase_order/content/index.js
python3 build/build_extension.py
```

预期：
- syntax 通过
- build 输出 `[build] features/create_purchase_order/content/index.js → dist/...`

- [ ] **Step 7: commit**

```bash
git add features/create_purchase_order/content/index.js
git commit -m "$(cat <<'EOF'
refactor(cpo): UI 删 SKU 货号框 + renderState 简化（复购模式）

Why: 复购模式简化为只填 1688 订单号；UI 上 SKU 货号框失去用途。

What:
- ui 对象删 skuInput 引用
- ②区 panel render 删 SKU 货号 input DOM + label
- renderState 删 c2.skuNo 回填 + skuInput readOnly 锁定逻辑
- onStartPhase2 不再读 / 传 skuNo

Test: node -c 通过，build_extension.py 通过；联调在 Task 8

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: CPO_P2_EDIT_FILL 复购分支跳过配对

**Files:**
- Modify: `features/create_purchase_order/content/index.js`（CPO_P2_EDIT_FILL handler 约 line 769-790）

- [ ] **Step 1: 定位 handler 当前实现**

```bash
grep -n "CPO_P2_EDIT_FILL\|cpoPairProduct" features/create_purchase_order/content/index.js
```

- [ ] **Step 2: 加复购分支跳过配对**

参考 index.js:769-790 当前 3 步：仓库 → 配对 → 采购人员。改为：

```js
CPO_P2_EDIT_FILL: async ({ skuNo, repurchase }) => {
  // 等 edit 页 Vue 表单渲染（收货仓库 d-selector 是渲染完成的标志）
  try { await U.waitForEl('label[title="收货仓库"], div.d-selector', document, 12000); }
  catch { return { ok: false, error: 'edit 页收货仓库下拉 12s 内未渲染，表单未就绪' }; }

  // a) 收货仓库选「中正科技仓」（新品+复购都跑）
  const whSel = cpoFindSelectByLabel('收货仓库');
  if (!whSel) return { ok: false, error: '业务拦截：未找到「收货仓库」下拉' };
  const whR = await cpoSelectAndVerify(whSel, '中正科技仓', '收货仓库');
  if (!whR.ok) return whR;

  // b) 配对商品——仅新品模式跑（复购模式店小秘已有 SKU 档案、获取订单时自动载入，无需配对）
  if (!repurchase) {
    const pair = await cpoPairProduct(skuNo);
    if (!pair.ok) return pair;
  }

  // c) 采购人员（新品+复购都跑；新品下放配对后，复购下放仓库后；两路径都是「最后一步」）
  const userName = await cpoGetCurrentUserName();
  const buyerSel = cpoFindSelectByLabel('采购人员');
  if (!buyerSel) return { ok: false, error: '业务拦截：未找到「采购人员」下拉' };
  const buyerR = await cpoSelectAndVerify(buyerSel, userName, '采购人员');
  if (!buyerR.ok) return buyerR;

  return { ok: true };
}
```

> 关键：保留新品的「仓库 → 配对 → 采购人员」顺序（配对会重置采购人员，必须放采购人员前）；复购无配对，「仓库 → 采购人员」顺序无所谓但对齐新品风格。

> 注：`cpoGetCurrentUserName` 的实际命名可能略不同，按 grep 现有代码用同名函数；若上面伪代码与 line 783-786 不一致，对齐现有代码。

- [ ] **Step 3: build + syntax 自检**

```bash
node -c features/create_purchase_order/content/index.js
python3 build/build_extension.py
```

- [ ] **Step 4: commit**

```bash
git add features/create_purchase_order/content/index.js
git commit -m "$(cat <<'EOF'
feat(cpo): CPO_P2_EDIT_FILL 复购模式跳过配对

Why: 复购商品店小秘已有 SKU 档案，店小秘"获取 1688 订单"时已载入到采购单，
配对是冗余操作。复购编辑页只需仓库 + 采购人员两步。

What:
- CPO_P2_EDIT_FILL handler 加 if (!repurchase) 跳过配对步
- 新品流程 3 步（仓库 → 配对 → 采购人员）完全不变
- 复购流程 2 步（仓库 → 采购人员）

Test: node -c 通过，build 通过；联调在 Task 8

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: CPO_P2_WAIT_SEARCH 改用 PO 号 + 切搜索类型 tag

**Files:**
- Modify: `features/create_purchase_order/content/index.js`（CPO_P2_WAIT_SEARCH handler 约 line 851-880）

> **前置**：Task 1 已确认「采购单号」tag 的精确文字。下面用 `<待到货页搜索类型_PO_TAG_TEXT>` 占位，实施时替换为 Task 1 表里记录的真实文案。

- [ ] **Step 1: 定位 handler 当前实现**

```bash
grep -n "CPO_P2_WAIT_SEARCH" features/create_purchase_order/content/index.js
```

- [ ] **Step 2: 改 handler 入参 + 搜索类型切换**

参考 index.js:851-880。改：

```js
CPO_P2_WAIT_SEARCH: async ({ poNo }) => {
  // 等待待到货页 Vue 渲染完成（tab.status=complete ≠ Vue 组件就绪）
  try { await U.waitForEl('#searchValue, input[name="tableSearchInput"]', document, 10000); }
  catch { return { ok: false, error: '读取失败：待到货页搜索框 10s 内未渲染，表单未就绪' }; }

  // 切搜索类型为「采购单号」（Task 1 dump 确认的精确文案）
  const PO_TAG_TEXT = '<待到货页搜索类型_PO_TAG_TEXT>';   // ← 用 Task 1 真实 dump 值替换
  const typeTag = Array.from(document.querySelectorAll('.d-tag-group-item'))
    .find(t => U.normText(t.textContent) === PO_TAG_TEXT);
  if (!typeTag) {
    return { ok: false, error: `读取失败：待到货页搜索类型「${PO_TAG_TEXT}」未找到` };
  }
  if (!typeTag.classList.contains('active')) { typeTag.click(); await U.sleep(150); }

  // 搜索内容：input#searchValue（name=tableSearchInput）
  const kwInput = document.querySelector('#searchValue, input[name="tableSearchInput"]');
  if (!kwInput) return { ok: false, error: '读取失败：待到货页未找到搜索内容输入框' };
  U.setInputValue(kwInput, poNo);
  await U.sleep(150);

  // 搜索按钮：限定在搜索框容器内取 submit（避开高级搜索区的「搜索」）
  const scope = kwInput.closest('.search-container-main, .searchContainer') || document;
  const searchBtn = scope.querySelector('button[type="submit"]') || U.findByText('button, .ant-btn', '搜索', scope);
  if (!searchBtn) return { ok: false, error: '读取失败：待到货页未找到搜索按钮' };
  searchBtn.click();

  // 等 vxe-table 出结果（有数据行 + 无「暂无数据」空态）
  let found = false;
  for (let i = 0; i < 25; i++) {     // ~5s
    await U.sleep(200);
    const rows = document.querySelectorAll('.vxe-body--row');
    const emptyShown = Array.from(document.querySelectorAll('.vxe-table--empty-block, .empty-container'))
      .some(e => e.getBoundingClientRect().height > 0 && /暂无数据/.test(e.textContent));
    if (rows.length > 0 && !emptyShown) { found = true; break; }
  }
  U.showToast(found ? '已定位采购单，请手动点「申请付款」' : '未搜到采购单行，请手动核对', found ? 'ok' : 'error');
  return { ok: true, found };       // 搜不到不阻断 done（PO 号已从审核弹窗取得）
}
```

> 关键变化：
> - 入参 `skuNo` → `poNo`
> - 切搜索类型 tag 从「商品SKU」→「采购单号」（用 Task 1 真实文案）
> - 切 tag 找不到 → 报「读取失败」中止（与现有「商品SKU」找不到时 silent 不切不同——因为新品也走 PO 搜，必须显式失败而非降级）
> - toast 文案从「已定位商品」→「已定位采购单」（更准确反映搜索 key）

- [ ] **Step 3: 替换 PO_TAG_TEXT 占位符**

把 `<待到货页搜索类型_PO_TAG_TEXT>` 替换为 Task 1 Step 2 表里的真实文案。

- [ ] **Step 4: build + syntax 自检**

```bash
node -c features/create_purchase_order/content/index.js
python3 build/build_extension.py
```

- [ ] **Step 5: commit**

```bash
git add features/create_purchase_order/content/index.js
git commit -m "$(cat <<'EOF'
feat(cpo): CPO_P2_WAIT_SEARCH 统一用 PO 号搜（新品+复购）

Why: PO 号唯一性强、与编辑页保存返回值直接关联。统一两条路径的搜索 key
让 WAIT_SEARCH 行为可预期，且复购流程下没 skuNo 也能定位采购单。

What:
- handler 入参 skuNo → poNo
- 搜索类型 tag 切换：商品SKU → 采购单号（dump 确认精确文案）
- 切 tag 失败显式报「读取失败」，不再 silent 降级
- toast 文案：定位商品 → 定位采购单（更准确）

Test: node -c 通过，build 通过；联调在 Task 8

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: 联调冒烟（人工触发，按场景核对）

**Files:**
- 无代码改动；可能据 bug 回退到 Task 4-7 修

**Why:** spec §7 集成层。Service worker / content script handler 改动单测难覆盖，靠真实店小秘流程闭环验证。

- [ ] **Step 1: 准备环境**

1. 拉本分支 `feature/cpo-rebuy-simplified` 到 worktree
2. `python3 build/build_extension.py`（已在 Task 5/6/7 跑过，确认 dist 已最新）
3. Chrome → `chrome://extensions` → AgentSeller 卡片右下角刷新圈 reload 扩展
4. 准备至少 1 条已有店小秘 SKU 档案的 1688 订单（复购冒烟用），1 个新商品 + 1688 订单（新品回归用）

- [ ] **Step 2: 复购冒烟（核心场景）**

1. 打开 `https://www.dianxiaomi.com/`，点 FAB → 「创建采购单」
2. ②区面板验证：**SKU 货号框不存在**（删干净），只有「商品复购」开关 + 1688 订单号框
3. 勾「商品复购」→ 填 1688 订单号 → 点「开始创建采购单」
4. 验证流程：
   - 新开 add tab → 自动填单号 + 获取订单成功
   - edit tab 被接管 → 自动选「中正科技仓」（写后读校验过）→ **不出现配对动作** → 自动选采购人员（写后读校验过）→ 点「保存，并通过审核」
   - 成功弹窗解析出 PO 号
   - 关 edit tab → 新开待到货 tab → 自动切「采购单号」搜索类型 → 填 PO 号 → 搜索 → 命中行
   - 面板状态显示 `done` + PO 号、1688 订单号回填只读
5. **若任一步失败**：截图 + console 日志 + 失败步骤，回 Task 4-7 对应代码修

- [ ] **Step 3: 新品回归冒烟（验证未连累）**

1. 不勾复购，在 Temu 列表点选有 SKU 货号的新商品
2. 跑 Phase 1（添加 SKU）全流程
3. Phase 1 done 后跑 Phase 2：填 1688 订单号 → 开始
4. 验证：
   - edit 页跑完整 3 步：仓库 + **配对**（用 skuNo 搜到结果选择）+ 采购人员
   - 保存通过审核
   - 待到货页：**新品也用 PO 号搜**（不再用 skuNo）→ 命中
5. 若新品配对步出问题或 PO 搜不到 → Task 4-7 没改干净

- [ ] **Step 4: 失败场景**

1. 勾复购 + 不填 1688 订单号 → 点开始 → 期望 UI 报「数据校验：1688 订单号不能为空（复购模式）」
2. 勾复购 + 填一个已存在的 1688 订单号 → 期望「已存在」弹窗分流报错 + 状态 error
3. 勾复购 + 填正确订单号但 edit 页采购人员下拉异常（手动制造，可选验证）→ 期望「数据校验：采购人员填写后不符」

- [ ] **Step 5: 联调通过则进 Task 9；失败回 Task 4-7**

通过即记录冒烟结果（pass list），失败回到对应改动 task 修 + 重 build + 重测。

> 联调修复属于 plan 执行过程中的回归，不专门 commit——直接在原 task 的 commit 上 amend 或在新 commit 里说明「fix from smoke test」。

---

## Task 9: CLAUDE.md 更新

**Files:**
- Modify: `features/create_purchase_order/CLAUDE.md`

- [ ] **Step 1: 复购模式段重写**

定位 CLAUDE.md「复购模式」段（约第 18-25 行）。改为：

```markdown
### 复购模式（v1.2.2 简化版）
- ②区「商品复购」开关（**仅店小秘页**显示，位于①②之间）。勾选 = 跳过①添加SKU 和 ②配对，只需填 `1688订单号`，自动「取订单 → 选仓库 + 采购人员 → 保存通过审核 → 待到货页用 PO 号搜索定位」。
- **作用域约束（防死锁）**：复购开关 + ①区灰显**均只在店小秘页生效**。Temu 列表页①区永远正常可用 —— 否则用户在 Temu 页既取消不了复购（开关不在该页）、又用不了①区 → 死锁。
- **状态**：复购态持久化 `cpo_state.repurchase`（boolean），与 phase1/phase2 同属单一状态源；checkbox 勾选态 / ①区灰显由 `renderState` 据它驱动，跨 tab / 面板重建一致。`onToggleRepurchase` 写入、`onClear`（remove 整个 `cpo_state`）/ 新品跑 Phase 1（`cpoRun` 重置）时归 false。
- **复购流程跳过的步骤**：① Phase 1（添加 SKU）整段；② Phase 2 CPO_P2_EDIT_FILL 的配对步（店小秘获取 1688 订单时已自动载入 SKU，无需重配）。
- **完成锁定**：`phase2.status==='done' && collected2.orderNo1688`（不依赖 phase1 done），覆盖两模式；done 后 1688 订单号框回填只读，「清除当前流程」解锁。
- **校验**：`validatePhase2({ repurchase:true, orderNo1688 })` 只要订单号非空即通过；新品分支向后兼容（不传 repurchase 即原「phase1 done + 订单号」）。`tests/cpo-logic.test.js` 含 4 例复购用例 + 2 例新加（订单号空/非空）。
```

> 关键变更：删原段所有 SKU 货号相关描述（手填、跳过校验、`collected2.skuNo` 回填等）。

- [ ] **Step 2: 待到货页 selector 表更新**

定位「店小秘 待到货页（Phase 2）」段（约 line 136-137）。改为：

```markdown
### 店小秘 待到货页（Phase 2）
导航 URL：`purchasing/order/waitArrival`。搜索框 `#searchValue`（name=tableSearchInput）；搜索类型 tag `.d-tag-group-item`「<采购单号 真实文案>」（Task 1 dump 锁定，**v1.2.2 起新品+复购统一用 PO 号搜**，不再用「商品SKU」）；结果表 `.vxe-body--row` + 空态 `.vxe-table--empty-block`。定位后停在「申请付款」前交人工。
```

把 `<采购单号 真实文案>` 替换为 Task 1 表的精确值。

- [ ] **Step 3: 踩坑清单加新条**

定位「踩坑清单」段末（约 line 207 之后）。在 #16 之后加 #17：

```markdown
17. **CPO_P2_EDIT_FILL 复购分支跳过配对（v1.2.2）**
    - 证据：v1.2.0 复购仍跑「配对商品」搜 skuNo，但复购商品店小秘已有 SKU 档案，店小秘"获取 1688 订单"已自动载入商品 → 配对是冗余动作浪费操作员时间。
    - 修法：handler 入参加 `repurchase` 标志，复购模式 `if (!repurchase)` 跳过 b 步配对。仓库 + 采购人员两步对所有模式共用。
    - 提炼：分支跳过逻辑放 handler 内（而非 background 选不同 message type），分叉点单一、协议成本最低。

18. **CPO_P2_WAIT_SEARCH 统一用 PO 号搜（v1.2.2）**
    - 证据：复购无 skuNo 无法用商品SKU搜；新品有 skuNo 但 PO 号唯一性更强、与审核保存直接关联。两路径用同一 key 让行为可预期、handler 无分叉。
    - 修法：待到货页搜索类型 tag 从「商品SKU」切到「采购单号」（Task 1 dump 锁定真实文案）；handler 入参从 skuNo 改 poNo；切 tag 失败显式报「读取失败」不再 silent 降级。
    - 提炼：跨流程统一 selector 时找最稳的 key（唯一性 + 来源可控），不要分支保留旧 key 增加调试盲区。
```

- [ ] **Step 4: 顶部 spec/plan 链接补充（保持文档自洽）**

定位 CLAUDE.md 顶部（约 line 4-7）的 spec/plan 引用段。在已有的 phase1/phase2/repurchase 引用下加：

```markdown
> v1.2.2 简化复购 spec：`docs/superpowers/specs/2026-06-01-cpo-repurchase-simplified-design.md`
> v1.2.2 简化复购 plan：`docs/superpowers/plans/2026-06-01-cpo-rebuy-simplified.md`
```

- [ ] **Step 5: commit**

```bash
git add features/create_purchase_order/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(cpo): CLAUDE.md 更新 v1.2.2 简化复购

Why: 复购模式从 v1.2.0「填 SKU + 配对」简化为 v1.2.2「只填订单号」；
待到货页搜索 key 全局改用 PO 号。文档需同步反映最终落地实现。

What:
- 复购模式段重写：删 SKU 货号手填、删 collected2.skuNo 回填、明示跳过配对
- 待到货页 selector 表：搜索类型 tag 改为「采购单号」(Task 1 dump 文案)
- 踩坑清单加新 #17（EDIT_FILL 复购跳配对）+ #18（WAIT_SEARCH 统一 PO）
- 顶部 spec/plan 链接补 v1.2.2 简化复购的 spec/plan 路径

Test: not run (纯文档)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: PR 流程（联调 + 文档 done 后）

**Files:**
- 无代码改动

- [ ] **Step 1: push 分支**

```bash
git push -u origin feature/cpo-rebuy-simplified
```

- [ ] **Step 2: gh pr create**

```bash
gh pr create --title "feat(cpo): 复购模式简化 + 待到货页统一用 PO 号搜 (v1.2.2)" --body "$(cat <<'EOF'
## Why

v1.2.0 复购仍需填 SKU 货号 + 跑配对，但复购商品店小秘已有 SKU 档案、
店小秘"获取 1688 订单"时自动载入——再走一次配对是冗余操作。

最小化后复购只需「1688 订单号 + 仓库 + 采购人员」3 个输入。

同时把待到货页搜索定位从 skuNo 改为 PO 号（**新品+复购统一**），
PO 号唯一性强、与审核保存返回值直接关联。

## What

**复购模式简化（默认替换 v1.2.0 行为）：**
- UI 删 SKU 货号框，只剩复购开关 + 1688 订单号
- Phase 2 编辑页 2 步（仓库 → 采购人员），跳过配对
- 校验：复购分支只要 orderNo1688 非空即通过

**待到货页搜索 key 统一（含新品）：**
- 搜索类型 tag 从「商品SKU」切到「采购单号」
- handler 入参 skuNo → poNo
- 切 tag 失败显式报错（不再 silent 降级）

**代码改动：6 处**
- cpo-logic.js：validatePhase2 复购分支只校验 orderNo1688
- service-worker.js：cpoRun2 复购分支不读 skuNo + collected2 删 skuNo + WAIT_SEARCH 传 poNo
- content/index.js：UI 删 SKU 框 + renderState 改 + EDIT_FILL 复购跳配对 + WAIT_SEARCH 改 poNo
- tests/cpo-logic.test.js：改 4 例 + 加 2 例
- CLAUDE.md：复购段 + 待到货页 selector + 踩坑 #17/#18

## Test

- node --test 单测全过（含改造 + 新加 2 例）
- 复购冒烟：填订单号 → 自动选仓库/采购人员 → 保存通过审核 → PO 搜定位 → 全链路通
- 新品回归冒烟：Phase 1 + Phase 2 完整（含配对）→ PO 搜定位（替代 skuNo）→ 全链路通
- 失败场景：订单号空 / 订单号已存在 → 文案符合分层

## 升级语义

v1.2.2 (PATCH) - 直接替换 v1.2.0 复购流程。员工装 v1.2.2 后扩展自动 reload（v1.2.1 起已有自检 + reload）。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: 报告 PR URL + 等用户审 / merge**

`gh pr create` 输出 URL 给用户。

按 shipping-rules，不自动 merge / 不主动推 tag —— 等用户说「merge」「打 tag」才执行下一步。

---

## Self-Review

> Spec coverage check（spec §1-10 每条对应 task）：
>
> | Spec § | 对应 task |
> |--------|-----------|
> | §2 In Scope: UI 删 SKU 框 | Task 5 |
> | §2: 复购 validatePhase2 只校验订单号 | Task 2 + 3 |
> | §2: EDIT_FILL 跳配对 | Task 6 |
> | §2: WAIT_SEARCH 统一 poNo + 切 tag | Task 1（dump）+ Task 4（bg 调用）+ Task 7（handler） |
> | §2: collected2 删 skuNo | Task 4 |
> | §2: 单测改造 | Task 2 + 3 |
> | §5 数据流：新品 EDIT_FILL 不动、WAIT_SEARCH 改 | Task 4（调用）+ Task 6 跳过 / Task 7 改 |
> | §6 错误处理：4 类失败 | Task 6（仓库/采购人员校验沿用）+ Task 7（切 tag 失败）+ Task 3（订单号空） |
> | §7 测试：单测 + 复购/新品冒烟 + 失败 | Task 2/3 + Task 8 |
> | §8 边缘场景：员工 reload / 残留字段 | 设计自动覆盖，无需独立 task |
> | §9 Done 定义 | Task 8 覆盖全 5 条 |
> | §10 升级语义 v1.2.2 | Task 10 PR 文案 |
>
> 全部对应。
>
> Placeholder scan: Task 1 / 7 / 9 均含「<待填>」标记 → **故意保留**，因为 Task 1 dump 才能填实际值，模板里显式标 `<...>` 占位符方便执行者识别替换点。
>
> Type consistency: `validatePhase2` 签名跨 Task 2/3/5 一致（`{ orderNo1688, phase1Done, repurchase }`）；`CPO_P2_EDIT_FILL` 入参跨 Task 4/6 一致（`{ skuNo, repurchase }`）；`CPO_P2_WAIT_SEARCH` 入参跨 Task 4/7 一致（`{ poNo }`）。
