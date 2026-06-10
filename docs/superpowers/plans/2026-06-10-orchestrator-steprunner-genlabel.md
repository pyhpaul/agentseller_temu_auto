# gen_label 续刀（auto_gen_label 接入编排器）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把编排器 `gen_label` 步的 stub fallback 换成真实 adapter，驱动 `auto_gen_label` 的跨页自驱三阶段流程（Phase1 标签生成 → Phase2 合规填写 → Phase3 标签主图上传），复用 pack_label 样板的 3 个通用 helper，零新增基建。

**Architecture:** `auto_gen_label` 是 content **完全自驱**——Phase1 在条码管理页同 tab 跑完后 `window.open` 新 tab，靠 localStorage `talCFlow`/`talImgFlow` 跨 4 个页面 reload 续跑（`init()` 的 `onPageChange` 钩子按页分发 `checkAndRunStep1`/`checkAndRunStep2or3`/`checkAndRunImgUpload`）。content 跨页 reload 即销毁，adapter **无法 await**——沿用 pack_label 的 **fire-forget + 轮询** 模式：adapter 导航条码页 → 发 `AGL_GEN_LABEL` 命令（content 立即 ack started、后台 IIFE 跑 Phase1 并 `window.open` 启动自驱）→ `orchPollState('agl_state')` 等终态。committing 用 `orchPollState` 的 **onTick 钩子** 在 content 报告"合规提交"阶段时标记（比 ship 发命令前粗标更精准）。

**Tech Stack:** Chrome MV3（classic SW，`importScripts`）+ content script；`chrome.storage.local['agl_state']`（adapter 读得到的桥接通道）；localStorage `talCFlow`/`talImgFlow`/`talOrch`（content 自驱状态 + orch gating）；native host `PROCESS_LABEL`/`READ_FILE_CHUNK`（已有路由）。

---

## 关键决策（写代码前定调）

- **D1 fire-forget + 轮询（同 pack_label）**：content 跨页 reload 销毁、Phase2/3 在新 tab 自驱，adapter 不可能 await 到终态。命令处理器立即 ack `{started:true}`，content 后台跑；adapter `orchPollState('agl_state')`。SW 5min 上限天然规避（adapter 不 await content）。
- **D2 输入只需 `wf.product.skc`**：手动流程靠用户点行选中（`fstate.product`）。编排器无人选 → 命令处理器用 `data.skc` 调 `findRowBySkc` 反查表格行，再 `extractRowData` 拿 `skcSku`（"SKC货号"列）。gen_label 在 create_sku（建店小秘 SKU）之前，`product.skuNo` 此时还是 null，skcSku 必须从条码页表格现读，**不能用 product.skuNo**。
- **D3 路径复用 localStorage（预配置）**：`templatePath`/`talOutputDir` 现由用户在 feature view 点选、存 localStorage。编排器无人选 → 命令处理器检查 `getPaths()`，缺则 ack `{started:false, reason:'NO_PATHS'}`，adapter 报 `validate`（让用户先在 feature view 配一次，localStorage 持久跨会话）。不引入新配置通道（最小改动）。
- **D4 committing 用 onTick 在"合规提交"阶段标**：gen_label 第一个写数据到 Temu 的动作是 `runStep3` 提交合规信息（confirmBtn）。content 在该点前写 `agl_state.phase='committing'`；adapter 的 `orchPollState` onTick 看到 `phase==='committing'` 调 `orchMarkCommitting(wf.id,true)`（一次性）。语义：合规提交后若 SW 回收 → 恢复转人工（不盲目重跑覆盖）。复用 pack_label helper 的 onTick 钩子，零新增。
- **D5 agl_state 走 chrome.storage.local + talOrch gating**：adapter 在 SW 里读不到 localStorage，故终态/中间态写 `chrome.storage.local['agl_state']`（扩展全局、跨 tab 共享）。gating：命令处理器启动时 `localStorage.setItem('talOrch','1')`，收尾点 `aglIsOrch()` 判定（仅编排触发才写 agl_state，手动点 button 不污染）；终态清 talOrch。
- **D6 三收尾点只追加 storage 写、不碰 DOM**：成功（`runImgUpload` 末尾）/ 失败（4 个 `check*` catch + step3 上传校验失败）/ committing（`runStep3` confirmBtn 前），每处加一行 `aglReportXxx`，原有 toast/clear/DOM 逻辑零改。违反"只加入口"字面但符合实质（只加 storage 写）——与 memory 既定方案一致。

## Task 1: steps.js — gen_label step 补 target

**Files:**
- Modify: `core/background/orchestrator/steps.js`（STEP_DEFS 的 gen_label 行 ~L24）
- Test: `tests/orchestrator-steps.test.js`

gen_label 当前只有 `domain`，adapter 导航需要 `target.url`/`target.readySignal`（同 pack_label/ship）。条码管理页 = 标签生成入口（`isBarcodeManagementPage`：路径 `/goods/label`）；readySignal = 表格行（`findRowBySkc`/`extractRowData` L250/258 依赖 `tr[data-testid="beast-core-table-body-tr"]`）。

- [ ] **Step 1: 写失败测试**

`tests/orchestrator-steps.test.js` 末尾加：
```js
test('buildInitialWorkflow: gen_label step 带 target（续刀 auto_gen_label）', () => {
  const wf = buildInitialWorkflow({ label: 'X' }, () => 'w1');
  const gl = wf.steps.find(s => s.id === 'gen_label');
  assert.strictEqual(gl.target.url, 'https://seller.temu.com/goods/label');
  assert.strictEqual(gl.target.readySignal, 'tr[data-testid="beast-core-table-body-tr"]');
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `node --test tests/orchestrator-steps.test.js`
Expected: FAIL（`gl.target` 为 null）

- [ ] **Step 3: steps.js gen_label 行加 target**

把 gen_label 行（约 L24）改为：
```js
    { id: 'gen_label',        label: '货号+标签+合规+标签图', type: 'auto', feature: 'auto_gen_label',        reversible: false, domain: 'seller.temu.com',
      target: { url: 'https://seller.temu.com/goods/label', readySignal: 'tr[data-testid="beast-core-table-body-tr"]' } },
```

- [ ] **Step 4: 跑测试看通过**

Run: `node --test tests/*.test.js`
Expected: PASS（全量 60 用例）

- [ ] **Step 5: commit**

```bash
git add core/background/orchestrator/steps.js tests/orchestrator-steps.test.js
git commit -m "$(cat <<'EOF'
feat(orchestrator): gen_label step 补 target（续刀 auto_gen_label）

Why: adapter 导航条码管理页需 target.url/readySignal，gen_label 此前只有 domain。
What: gen_label step 加 target{url:seller.temu.com/goods/label, readySignal:表格行}；测试补 gen_label target 透传。
Test: node --test tests/*.test.js（60 绿）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

⚠ **url 待 chrome 验证校准**：`/goods/label` 来自 `isBarcodeManagementPage` 多候选之一（也含 barcode/goods-barcode）；真实条码页可能带 query/店铺上下文，chrome 验证时调整 `target.url`（同 pack_label/ship 的 url 校准约定）。

---

## Task 2: content index.js — orch 桥接（helper + 命令入口 + onMessage + 收尾点）

**Files:**
- Modify: `features/auto_gen_label/content/index.js`

在"注册到 core"区块之前插入 orch 桥接代码块，再在 7 个收尾点追加 storage 写。**只加 storage 写、不碰原有 DOM/控制流。**

> ⚠ **window.open → location.href 修正**：手动 `onRunAllPhases`（L311）用 `window.open` 开 Phase2 新 tab，依赖 button click 的**用户手势**。编排器经 `sendMessage` 触发**无手势，window.open 会被弹窗拦截**。命令入口改用 `window.location.href`（同 tab 导航，不需手势；编排场景也无需保留条码页 tab，adapter 开的 tab 直接复用为 Phase2 页）。content 内部自驱的 `location.href`（runStep1 L1177 / runStep3 L1425）本就非手势、不受影响。

### 2A — orch helper + 命令入口 + onMessage

- [ ] **Step 1: 插入桥接代码块**

锚点：`refreshPathsUI();\n    refreshProductUI();\n  }`（renderAutoGenLabel 结束）与 `// 注册到 core` 之间，插入：

```js
  // ═══════════════════════════════════════════════════════════════════════════
  // 编排器桥接（orch）：content 跨页自驱、SW adapter 无法 await。
  // 命令入口 fire-forget 启动 Phase1+自驱；三收尾点写 chrome.storage.local['agl_state']；adapter 轮询。
  // gating：talOrch=1 才写（手动点 button 不污染 agl_state）。
  // ═══════════════════════════════════════════════════════════════════════════
  function aglIsOrch() {
    try { return localStorage.getItem('talOrch') === '1'; } catch { return false; }
  }
  function aglClearOrch() {
    try { localStorage.removeItem('talOrch'); } catch (e) { console.warn('[TAL][orch] 清 talOrch 失败', e); }
  }
  // 错误分层：content 既有 throw 用「数据校验:」前缀标 validate，其余按 read（DOM 没找到/超时）。
  function aglCatFromMsg(msg) {
    return /数据校验/.test(String(msg || '')) ? 'validate' : 'read';
  }
  async function aglWriteState(obj) {
    try { await chrome.storage.local.set({ agl_state: { ...obj, updatedAt: Date.now() } }); }
    catch (e) { console.warn('[TAL][orch] 写 agl_state 失败', e); }
  }
  async function aglReportDone(result) {
    if (!aglIsOrch()) return;
    await aglWriteState({ status: 'done', phase: 'done', result: result || {} });
    aglClearOrch();
  }
  async function aglReportError(category, code, message) {
    if (!aglIsOrch()) return;
    await aglWriteState({ status: 'error', phase: 'error', category, code, message: String(message || '') });
    aglClearOrch();
  }
  async function aglReportPhase(phase) {
    if (!aglIsOrch()) return;
    await aglWriteState({ status: 'running', phase });
  }

  // 命令入口：编排器发 AGL_GEN_LABEL 触发。无人选行 → data.skc 反查；路径缺 → 不启动报 reason。
  // fire-forget：立即 ack started；Phase1 后台 IIFE 在条码页跑，done 后 location.href 跳 Phase2，
  // 之后 content 自驱（onPageChange → checkAndRunStep1...），三收尾点写 agl_state。
  async function aglHandleGenLabel(data) {
    const { templatePath, outputDir } = getPaths();
    if (!templatePath || !outputDir) return { ok: true, started: false, reason: 'NO_PATHS' };
    const skc = data && data.skc;
    if (!skc) return { ok: true, started: false, reason: 'NO_SKC' };
    const row = findRowBySkc(skc);
    if (!row) return { ok: true, started: false, reason: 'ROW_NOT_FOUND' };
    const rowData = extractRowData(row);
    if (!rowData || !rowData.skcSku) return { ok: true, started: false, reason: 'NO_SKC_SKU' };

    // 清旧自驱状态 + 置 orch gating + 初态
    clearCFlow();
    clearImgFlow();
    try { localStorage.setItem('talOrch', '1'); } catch (e) { console.warn('[TAL][orch] 置 talOrch 失败', e); }
    await aglWriteState({ status: 'running', phase: 'phase1' });

    // fire-forget：Phase1 在条码页同 tab 跑，成功后 location.href 跳转启动 Phase2/3 自驱
    (async () => {
      try {
        const { barcodePngB64, skcNumber } = await clickAndCaptureCanvas(row);
        U.ensureExtensionAlive();
        const result = await sendNative('PROCESS_LABEL', {
          skcNumber: skcNumber || rowData.skcNumber,
          skcSku: rowData.skcSku,
          barcodePngB64, templatePath, outputDir, widthRatio: getWidthRatio(),
        });
        if (!result?.success) throw new Error(result?.error || '标签生成失败');
        if (result.output_png) {
          localStorage.setItem('talLabelPng', result.output_png);
          localStorage.setItem('talLabelSkc', rowData.skcNumber || '');
        }
        setCFlow({
          active: true, step: 1,
          skcNumber: rowData.skcNumber, skcSku: rowData.skcSku,
          spuId: null, continueToPhase3: true,
        });
        // 编排无用户手势：location.href 同 tab 跳（非 window.open，避免弹窗拦截）
        window.location.href = '/govern/compliant-live-photos';
      } catch (err) {
        await aglReportError(aglCatFromMsg(err?.message), 'AGL_PHASE1_FAILED', err?.message || err);
      }
    })();

    return { ok: true, started: true };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'AGL_GEN_LABEL') return;
    aglHandleGenLabel(msg.data || {})
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: true, started: false, reason: 'HANDLER_THREW', error: String((e && e.message) || e) }));
    return true;  // 异步 sendResponse
  });
```

- [ ] **Step 2: dev build 验证语法**

Run: `python3 build/build_extension.py`
Expected: 成功（8 features）

### 2B — 7 收尾点追加（成功 / committing / 上传校验失败 / 4 个 catch）

每处在原行旁加一行 `aglReportXxx`，不改原 toast/clear/DOM 逻辑。

- [ ] **Step 3: 成功终点（runImgUpload 末尾）**

```js
    await U.sleep(1000);
    clearImgFlow();
    U.showToast('③ 主图上传完成 ✓', 'ok');
```
改为（`aglReportDone` 在 clearImgFlow 前，从 flow 取结果）：
```js
    await U.sleep(1000);
    await aglReportDone({ spuId: flow.spuId || null, labelPng: flow.labelPngPath || null });
    clearImgFlow();
    U.showToast('③ 主图上传完成 ✓', 'ok');
```

- [ ] **Step 4: committing（runStep3 confirmBtn 前）**

```js
    if (!confirmBtn) throw new Error('未找到确认按钮');
    confirmBtn.click();
```
改为（合规提交=首个写数据点，await 确保 adapter onTick 能在 click 前读到 committing）：
```js
    if (!confirmBtn) throw new Error('未找到确认按钮');
    await aglReportPhase('committing');  // 合规提交=首个写数据点；adapter onTick 据此标 committing
    confirmBtn.click();
```

- [ ] **Step 5: 上传校验失败（runStep3）**

```js
    if (!uploadOk) {
      clearCFlow();
      U.showToast('②❌ 商品合规信息上传失败，请人工处理', 'err');
      return;
    }
```
改为：
```js
    if (!uploadOk) {
      aglReportError('validate', 'AGL_COMPLIANCE_UPLOAD_FAILED', '商品合规信息上传失败，请人工处理');
      clearCFlow();
      U.showToast('②❌ 商品合规信息上传失败，请人工处理', 'err');
      return;
    }
```

- [ ] **Step 6: checkAndRunStep1 catch**

```js
    catch (e) { U.showToast('步骤1失败: ' + e.message, 'err'); clearCFlow(); }
```
改为：
```js
    catch (e) { U.showToast('步骤1失败: ' + e.message, 'err'); aglReportError(aglCatFromMsg(e.message), 'AGL_STEP1_FAILED', e.message); clearCFlow(); }
```

- [ ] **Step 7: checkAndRunStep2or3 两个 catch（step2 / step3）**

step2 分支：
```js
      try { await runStep2(flow); }
      catch (e) { U.showToast('步骤2失败: ' + e.message, 'err'); clearCFlow(); clearImgFlow(); }
```
改为：
```js
      try { await runStep2(flow); }
      catch (e) { U.showToast('步骤2失败: ' + e.message, 'err'); aglReportError(aglCatFromMsg(e.message), 'AGL_STEP2_FAILED', e.message); clearCFlow(); clearImgFlow(); }
```
step3 分支：
```js
      try { await runStep3(getCFlow()); }
      catch (e) { U.showToast('步骤3失败: ' + e.message, 'err'); clearCFlow(); clearImgFlow(); }
```
改为：
```js
      try { await runStep3(getCFlow()); }
      catch (e) { U.showToast('步骤3失败: ' + e.message, 'err'); aglReportError(aglCatFromMsg(e.message), 'AGL_STEP3_FAILED', e.message); clearCFlow(); clearImgFlow(); }
```

- [ ] **Step 8: checkAndRunImgUpload catch**

```js
    catch (e) { U.showToast('主图上传失败: ' + e.message, 'err'); clearImgFlow(); }
```
改为：
```js
    catch (e) { U.showToast('主图上传失败: ' + e.message, 'err'); aglReportError(aglCatFromMsg(e.message), 'AGL_IMG_FAILED', e.message); clearImgFlow(); }
```

- [ ] **Step 9: dev build + 全量回归**

Run: `python3 build/build_extension.py && node --test tests/*.test.js && python3 -m pytest tests/ -q`
Expected: build 成功（8 features）；JS 60 绿；Python 20 绿。

- [ ] **Step 10: commit**

```bash
git add features/auto_gen_label/content/index.js
git commit -m "$(cat <<'EOF'
feat(auto_gen_label): 加 AGL_GEN_LABEL 命令入口 + orch 桥接（gen_label 续刀）

Why: 编排器 gen_label 步需驱动 auto_gen_label 跨页自驱三阶段；content 自驱 SW 无法 await。
What: 加 orch helper(aglIsOrch/aglReportDone/Error/Phase, agl_state gating talOrch) + 命令入口
  aglHandleGenLabel(skc 反查行/路径校验/fire-forget Phase1/location.href 跳转防弹窗拦截) +
  onMessage AGL_GEN_LABEL + 7 收尾点追加 storage 写（成功/committing/4 catch/上传校验失败，不碰 DOM）。
Test: node --test tests/*.test.js（60 绿）+ pytest（20 绿）+ dev build 成功。chrome 端到端待验。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: service-worker.js — orchAdapterGenLabel + 注册

**Files:**
- Modify: `core/background/service-worker.js`（orchAdapterShip 之后、ORCH_ADAPTERS 之前 ~L812）

复用 pack_label 样板 3 helper（`orchNavigateAndWait`/`orchSendStepCommand`/`orchPollState`），零新增基建。fire-forget + 轮询（同 pack_label），但加 `orchPollState` 的 onTick 标 committing（同 ship 的 committing 语义，触发点更精准）。

- [ ] **Step 1: 插入 orchAdapterGenLabel**

锚点：`orchAdapterShip` 函数结束 `}`（L812）与 `// adapter 注册表`（L814）之间，插入：

```js
// ── auto_gen_label adapter（gen_label,✗强不可逆·跨页自驱）─────────────────────
// content 跨 4 页自驱、SW 无法 await：fire-forget+轮询 agl_state（同 pack_label）。
// committing 用 onTick 在 content 报告"合规提交"阶段标（比 ship 发命令前粗标精准）。
async function orchAdapterGenLabel(step, wf) {
  const target = step.target || {};
  const url = target.url || 'https://seller.temu.com/goods/label';
  // 1. 清旧 agl_state（防读到上次残留终态）
  await chrome.storage.local.remove('agl_state');
  // 2. 导航条码页 + 等表格行就绪（前台 active 防失焦不渲染）
  let tabId;
  try {
    tabId = await orchNavigateAndWait(url, target.readySignal, { readyTimeoutMs: 30000 });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'AGL_NAV_FAILED', message: '条码管理页打不开或未就绪:' + String(e?.message || e), recoverable: true } };
  }
  // 3. 发命令（fire-forget：content 立即 ack started，后台跑 Phase1+跨页自驱）
  let ack;
  try {
    ack = await orchSendStepCommand(tabId, 'AGL_GEN_LABEL', { skc: (wf && wf.product && wf.product.skc) || null });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'AGL_CMD_FAILED', message: '标签生成命令未送达:' + String(e?.message || e), recoverable: true } };
  }
  if (ack && ack.started === false) {
    const reasonMap = {
      NO_PATHS: '模板/输出路径未配置（请先在 feature view 设置一次，localStorage 持久）',
      NO_SKC: '缺 SKC（product.skc 为空，上游 HITL 未回填）',
      ROW_NOT_FOUND: '条码管理页未找到该 SKC 对应商品行',
      NO_SKC_SKU: '该商品无 SKC货号，无法生成标签',
    };
    return { status: 'error', error: { category: 'validate', code: 'AGL_NOT_STARTED', message: reasonMap[ack.reason] || ('未启动:' + ack.reason), recoverable: true } };
  }
  // 4. 轮询 agl_state 终态；onTick 在 content 报 committing 阶段时一次性标记
  let committed = false;
  const st = await orchPollState('agl_state', {
    timeoutMs: 10 * 60 * 1000, intervalMs: 3000,
    onTick: async (obj) => {
      if (!committed && obj && obj.phase === 'committing') {
        await orchMarkCommitting(wf.id, true);
        committed = true;
      }
    },
  });
  if (st.status === 'done') {
    return { status: 'done', result: st.result || {}, error: null };
  }
  return { status: 'error', error: { category: st.category || 'read', code: st.code || 'AGL_FAILED', message: st.message || '标签生成流程失败', recoverable: true } };
}
```

- [ ] **Step 2: ORCH_ADAPTERS 注册**

```js
const ORCH_ADAPTERS = {
  create_sku: orchAdapterCreateSku,
  create_po: orchAdapterCreatePo,
  pack_label: orchAdapterPackLabel,
  ship: orchAdapterShip,
  // publish / gen_label 暂留 stub，后续 plan 逐个换真 adapter
};
```
改为：
```js
const ORCH_ADAPTERS = {
  create_sku: orchAdapterCreateSku,
  create_po: orchAdapterCreatePo,
  pack_label: orchAdapterPackLabel,
  ship: orchAdapterShip,
  gen_label: orchAdapterGenLabel,
  // publish 暂留 stub，后续 plan 换真 adapter
};
```

- [ ] **Step 3: dev build + 全量回归**

Run: `python3 build/build_extension.py && node --test tests/*.test.js && python3 -m pytest tests/ -q`
Expected: build 成功；JS 60 绿；Python 20 绿。

- [ ] **Step 4: commit**

```bash
git add core/background/service-worker.js
git commit -m "$(cat <<'EOF'
feat(orchestrator): orchAdapterGenLabel 接 auto_gen_label（gen_label 续刀收尾）

Why: gen_label 步此前回落 stub；接真实 adapter 驱动跨页自驱三阶段。
What: orchAdapterGenLabel 复用 3 helper（导航条码页→fire-forget 发 AGL_GEN_LABEL→
  orchPollState('agl_state')，onTick 在 committing 阶段标 orchMarkCommitting）；ORCH_ADAPTERS 注册 gen_label。
Test: node --test tests/*.test.js（60 绿）+ pytest（20 绿）+ dev build。chrome 端到端待验。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 全量回归 + chrome 验证准备

**Files:** 无（验证 + 文档）

- [ ] **Step 1: 全量自动验证**

```bash
node --test tests/*.test.js     # JS 60 绿（注意：不用 tests/ 整目录，会把 pytest .py 当 JS）
python3 -m pytest tests/ -q      # Python 20 绿
python3 build/build_extension.py # dev build（8 features）
git status                        # 工作树干净
```

- [ ] **Step 2: chrome L1 验证（content 直测，⚠ 真跑）**

前置：条码管理页已加载、feature view 已配过模板/输出路径一次（localStorage `talTemplatePath`/`talOutputDir`）、备一个**测试商品**的真实 SKC。

SW console（chrome://extensions → 本扩展 service worker）：
```js
const [tab] = await chrome.tabs.query({ url: '*://seller.temu.com/*' });
await chrome.storage.local.remove('agl_state');
const ack = await chrome.tabs.sendMessage(tab.id, { type: 'AGL_GEN_LABEL', data: { skc: '<真实SKC>' } });
console.log('ack', ack);                                   // 期望 {ok:true, started:true}
// 之后每隔几秒观察自驱（页面会自动跳转 Phase2/3）：
(await chrome.storage.local.get('agl_state')).agl_state;   // running/phase1 → phase2 → committing → done
```
负路径快验（不真跑）：`data:{skc:'NOT_EXIST'}` → ack `{started:false, reason:'ROW_NOT_FOUND'}`；清掉 localStorage 路径 → `reason:'NO_PATHS'`。

- [ ] **Step 3: chrome L2 验证（adapter 端到端，🔴 强不可逆真跑）**

手搭 cursor=6 的 workflow（product.skc 填真实测试商品），SW console：
```js
// 构造一个停在 gen_label 的骨架（13 步，前 6 步标 done，cursor=6，product.skc 真实）
const id = 'wf_agl_test';
const wf = ORCH.steps.buildInitialWorkflow({ label: 'AGL测试' }, () => id);
wf.product.skc = '<真实SKC>';
wf.status = 'running'; wf.cursor = 6;
for (let i = 0; i < 6; i++) wf.steps[i].status = 'done';
await chrome.storage.local.set({ as_workflow_state: { schemaVersion: 1, workflows: [wf], updatedAt: Date.now() } });
await orchEngine.advance(id);   // 触发 gen_label adapter 真跑
// 观察 as_workflow_state.workflows[0]：gen_label running → committing(steps[6].committing=true) → done，cursor→7
```
⚠ **gen_label 真跑 = 真生成标签 PDF/PNG + 真提交合规信息到 Temu + 真传标签主图**。合规提交（runStep3）是不可逆点（提交后 committing=true）。**必须用测试商品 + 明确授权**（同 ship L4 强度）。合规信息会写入该商品的审核流程，勿对正式商品误跑。

- [ ] **Step 4: 更新 memory + 标 task 完成**

`project_full_automation_plan.md` 加 gen_label 续刀 bullet（代码完成 + chrome 验证结果 + 下一步 publish）。TaskUpdate #32-35 completed。

---

## 自检清单（executing 前过一遍）

- **窗口手势**：命令入口用 `location.href` 非 `window.open`（编排无手势，window.open 会被拦）。✓ 已在 2A 修正。
- **输入来源**：只用 `wf.product.skc`，skcSku 现读条码页表格（gen_label 在 create_sku 前，product.skuNo 还是 null）。✓
- **gating**：`talOrch` localStorage 控制，仅编排写 agl_state；手动 button 跑（onRunAllPhases）talOrch 未置 → 不污染。✓
- **committing 触发点**：合规提交（首个写数据点），onTick 一次性标。✓
- **错误分层**：content 既有「数据校验:」前缀 → validate，其余 read；上传校验失败显式 validate。✓
- **SW 5min**：fire-forget，adapter 不 await content；轮询 10min 上限（三阶段 2-4min，buffer 足）。✓
- **复用基建**：3 helper 零改，仅新增 1 个 adapter + 注册 1 行。✓

