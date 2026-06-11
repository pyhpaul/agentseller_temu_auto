# packing_label 接入编排器 + 立通用基建（Plan 2-2b 续刀样板）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) 或 superpowers:executing-plans 逐 Task 实施。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 把 `pack_label` 步的 stub fallback 换成真实 adapter,**同时立起「无命令处理器 feature 接入」的 3 个通用基建**（`orchNavigateAndWait`/`orchPollState`/`orchSendStepCommand`），用改造量最小、可逆零风险的 `packing_label` 验证「导航→等就绪→发命令→fire-forget 自驱→轮询 storage→回报」全链路成立,后续 `ship`/`gen_label` 直接复用基建。

**Architecture:** 四层。① `steps.js` 补 `target` 字段透传（`buildInitialWorkflow` 当前未拷 target）+ `pack_label` 的 `target{url,readySignal}`。② `service-worker.js` 加 3 个通用 helper（导航等就绪 / 轮询 storage 终态 / 不带 CPO `ok` 语义的命令发送）。③ `packing_label/content/index.js` 抽 `runBatchPrint` 纯批量函数（从 `onStart` 提取、去 UI 依赖）+ onMessage 命令入口（`PL_START_BATCH`,fire-forget：立即 ack、content 自驱跑完写 `pl_state`）。④ `service-worker.js` `orchAdapterPackLabel`（导航→等就绪→发命令→轮询 `pl_state`）+ `ORCH_ADAPTERS` 注册。

**Tech Stack:** Vanilla JS（UMD 双模式）,`node:test` 单测,Chrome MV3 classic service worker（`importScripts`）。复用 CPO 的 `cpoWaitTabComplete` + `packing_label` 全部现有 DOM 逻辑（`collectPrintTargets`/`printAndCapture`/`savePdf`/`resolveUniquePath` 零改）。

---

## 范围说明

本 plan 是 **Plan 2-2b 续刀的第一个样板**（用户 2026-06-10 拍板「逐个样板,从 pack_label 起」）。目的：用 4 个待接 feature 里**改造量最小、可逆零风险**的 `packing_label`,趟通「无命令处理器 feature 接入编排器」的核心链路,**并把该链路抽成 3 个通用 helper 供后续 `ship`/`gen_label` 复用**。源 spec：`docs/superpowers/specs/2026-06-09-automation-orchestrator-deterministic-skeleton-design.md`（§7 feature 改造 / §9.1 SW 5min 实测）。调研依据：`probe-packlabel` 报告（含 9a/9b/9c 代码草案）。

- **覆盖**：steps.js target 透传 + pack_label target；3 通用 helper；packing_label content onMessage 入口（抽 runBatchPrint + fire-forget 写 pl_state）；orchAdapterPackLabel + 注册。
- **不在本 plan**（续刀后续 / 2-2c）：`ship`/`gen_label`/`publish` 的 adapter；编排器配置层 `saveDir` 透传（首版用 content 回退 `getSavePath()`）；按 `wf.product` 订单标识**精确定位**待打单（首版扫页面已勾选）。
- **验证**：steps.js target 透传 = `node --test` 纯逻辑单测；helper/content/adapter = `node --check` 语法 + dev build；端到端 = chrome 手动分级（L1 content 直测 + L2 adapter 手搭 state,均可逆零风险,见 Task 5）。

## 关键决策（实现前先读,review 把关）

| # | 决策 | 理由 |
|---|------|------|
| D1 | 抽 **3 通用 helper**（不内联 pack_label） | 样板价值就是立基建：`ship`/`gen_label` 直接复用「导航等就绪 / 轮询 storage / 发命令」,避免每 feature 重写。 |
| D2 | **fire-forget + 轮询 `pl_state`** | 虚拟滚动批量打印逼近 SW 5min 上限（spec §9.1）。content 自驱跑（绑 tab 生命周期不受 SW 限）、SW 只发启动信号 + 轮询 storage 终态。命令通道只传「已启动」ack,完成走 storage。 |
| D3 | `saveDir` 首版 **content 回退 `getSavePath()`** | 编排器统一配置透传更可靠但需配置层,留后续；样板聚焦验链路,用用户曾手动设的 localStorage 路径。 |
| D4 | 「打哪些单」首版**扫页面已勾选**,无目标报 `validate` 错 | 精确定位（按 `wf.product` 订单标识）待数据流补；样板不解决订单定位,但**禁止静默全打**（无目标即报错,不误打）。 |
| D5 | **可逆,无 committing** | 重打物理无害（`resolveUniquePath` 撞名递增 `_2/_3`）+ 业务允许补打（confirm 弹窗自动处理）。engine recover 对 reversible 步直接 rerun,不需 ask-hitl。 |
| D6 | `orchSendStepCommand` **不带 CPO `ok` 语义** | CPO `cpoSendCommand` 有 `resp.ok===false → throw`（CPO 私有协议）。新 feature 回 `{ok,started}`/`{status,...}`,需独立发送函数（保留 retry+超时,去 ok 检查,超时可配——`ship` 单单 30-60s 要长超时）。 |

## 文件结构

| 文件 | 职责 | 改动 |
|------|------|------|
| `core/background/orchestrator/steps.js` | `STEP_DEFS` 的 `pack_label` 加 `target`+精确子域；`buildInitialWorkflow` steps.map 透 `target` | 改 2 处 |
| `tests/orchestrator-steps.test.js` | 加 target 透传断言（pack_label 有 / HITL 步无） | 改 |
| `core/background/service-worker.js` | orchestrator 段加 3 通用 helper + `orchAdapterPackLabel` + `ORCH_ADAPTERS` 注册 | 改 |
| `features/packing_label/content/index.js` | 抽 `runBatchPrint`（onStart 复用）+ onMessage `PL_START_BATCH`（fire-forget 写 `pl_state`） | 改 |

> 不新建文件。`packing_label` 的 DOM 逻辑（collectPrintTargets/printAndCapture/savePdf/resolveUniquePath/findScrollContainer）**零改动**——只抽函数 + 加入口。CPO 现有代码零改动。

---

## Task 1：steps.js target 透传 + pack_label target（纯逻辑 TDD）

**Files:**
- Modify: `core/background/orchestrator/steps.js`（STEP_DEFS pack_label + buildInitialWorkflow steps.map）
- Modify: `tests/orchestrator-steps.test.js`

`buildInitialWorkflow` 当前 `steps.map` 不拷 `target`（engine.js `buildHitl` 读 `step.target.url` 会拿到 undefined；adapter 也读不到导航 URL/readySignal）。先让 `target` 透传 + 给 pack_label 声明 target,用单测锁定。

- [ ] **Step 1: 先写失败测试**

在 `tests/orchestrator-steps.test.js` 末尾（沿用文件顶部已有的 `test`/`assert`/`buildInitialWorkflow` import）加：

```js
test('buildInitialWorkflow：target 字段透传到 step（pack_label 有 / HITL 步无）', () => {
  const wf = buildInitialWorkflow({ label: 'X' }, () => 'w1');
  const pack = wf.steps.find(s => s.id === 'pack_label');
  assert.strictEqual(pack.target.url, 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list');
  assert.strictEqual(pack.target.readySignal, '[class*="shipping-list_choose"]');
  const sel = wf.steps.find(s => s.id === 'select_product');
  assert.strictEqual(sel.target, null);   // 未声明 target 的步透传为 null（不是 undefined）
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/orchestrator-steps.test.js`
Expected: FAIL — `pack.target` 为 undefined（steps.map 没拷 target），`pack.target.url` 抛 `Cannot read properties of undefined`。

- [ ] **Step 3: 改 steps.js**

(a) `STEP_DEFS` 的 pack_label 行（当前 `{ id: 'pack_label', ... domain: 'kuajingmaihuo.com' },`）改为：

```js
    { id: 'pack_label',       label: '打印打包标签',          type: 'auto', feature: 'packing_label',         reversible: true,  domain: 'seller.kuajingmaihuo.com',
      target: { url: 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list', readySignal: '[class*="shipping-list_choose"]' } },
```

(b) `buildInitialWorkflow` 的 `steps: STEP_DEFS.map(d => ({` 块里，把：

```js
        reversible: d.reversible, domain: d.domain,
```

改为：

```js
        reversible: d.reversible, domain: d.domain, target: d.target || null,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/orchestrator-steps.test.js`
Expected: PASS — 原有用例 + 新增 target 透传用例全绿。

- [ ] **Step 5: commit**

```bash
git add core/background/orchestrator/steps.js tests/orchestrator-steps.test.js
git commit -m "feat(orchestrator): steps target 透传 + pack_label target（续刀基建）

Why: buildInitialWorkflow 未拷 target,engine buildHitl/adapter 读不到导航 URL/readySignal;
     续刀 4 个无处理器 feature 都需 adapter 按 step.target 导航,先打通 target 透传。
What: STEP_DEFS pack_label 加 target{url,readySignal}+精确子域 seller.kuajingmaihuo.com;
     buildInitialWorkflow steps.map 加 target: d.target || null。
Test: node --test orchestrator-steps target 透传用例(pack_label 有 / HITL 步 null)全绿。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Task 1 完成：`target` 透传打通,pack_label 携带导航 URL + readySignal,后续 adapter 可读。

---

## Task 2：3 个通用 adapter 基建 helper（service-worker.js，node --check）

**Files:**
- Modify: `core/background/service-worker.js`（orchestrator 段，`orchStubStepRunner` 之后、`// ── CPO adapter` 注释之前）

「无命令处理器」feature 接入要 adapter 主动「导航→等就绪→发命令→（长任务）轮询 storage」。抽 3 个通用 helper,本 plan 的 pack_label adapter 用,后续 `ship`/`gen_label` 直接复用。接线层依赖 chrome API,不写 node 单测,靠 `node --check` + Task 5 chrome 验。

- [ ] **Step 1: 插入 3 个 helper**

在 `core/background/service-worker.js` 的 `orchStubStepRunner` 函数结束（`}`）之后、`// ── CPO adapter（create_sku / create_po）` 注释之前,插入：

```js

// ── 通用 adapter 基建（无命令处理器 feature 接入；后续 ship/gen_label 复用）──────────────
// CPO 自管 tab、adapter 直接 await；其余 feature 无处理器,adapter 要主动:
// 导航 tab(orchNavigateAndWait)→ 发命令(orchSendStepCommand)→ 长任务轮询 storage 终态(orchPollState)。

// 导航到 url(前台 active 防失焦不渲染)→ 等 tab complete → executeScript 轮询 readySignal → 返回 tabId
// ⚠ readySignal 检查依赖 manifest host_permissions 含目标域(scripting 权限 CPO cpoCloseTab 已在用);
//   executeScript 抛错(权限/页面未就绪)时继续轮询,超时才抛——content handler 首行 waitForEl 再兜一层。
async function orchNavigateAndWait(url, readySignal, { tabTimeoutMs = 30000, readyTimeoutMs = 30000 } = {}) {
  const tab = await chrome.tabs.create({ url, active: true });
  await cpoWaitTabComplete(tab.id, tabTimeoutMs);
  if (!readySignal) return tab.id;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: sel => !!document.querySelector(sel), args: [readySignal],
      });
      if (r && r.result) return tab.id;
    } catch (_) { /* 页面/脚本尚未可注入,继续等 */ }
    await new Promise(res => setTimeout(res, 300));
  }
  throw new Error('readySignal 超时: ' + readySignal);
}

// 向 tab 发命令(content 未就绪重试)。不套 CPO 的 resp.ok===false→throw(CPO 私有协议),
// 直接返回 resp 由 adapter 自行解读({ok,started}/{status,...})。timeoutMs 可配(ship 单单长)。
async function orchSendStepCommand(tabId, type, data, { timeoutMs = 30000, retries = 25 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(tabId, { type, data }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('命令超时: ' + type)), timeoutMs)),
      ]);
    } catch (e) {
      lastErr = e;
      if (!/Receiving end does not exist|Could not establish connection/.test(String(e?.message || e))) throw e;
      await new Promise(r => setTimeout(r, 200));   // content 还没注入,等等再试
    }
  }
  throw lastErr || new Error('命令无法送达: ' + type);
}

// 轮询 chrome.storage.local[key] 到终态(status==='done'|'error')。fire-forget 长任务用:
// content 自驱跑、SW 只观察 storage(不受单条 message 通道/SW 5min await 限)。
// onTick 给需要的 feature 在中途标 committing(pack_label 可逆不用)。超时返回 error 终态。
async function orchPollState(key, { timeoutMs, intervalMs = 2000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const obj = (await chrome.storage.local.get(key))[key] || {};
    if (onTick) await onTick(obj);
    if (obj.status === 'done' || obj.status === 'error') return obj;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { status: 'error', code: 'POLL_TIMEOUT', message: key + ' 轮询超时' };
}
```

- [ ] **Step 2: node --check 验证语法**

Run: `node --check core/background/service-worker.js`
Expected: 无输出（语法有效；chrome/cpoWaitTabComplete 是运行时全局）。

- [ ] **Step 3: commit**

```bash
git add core/background/service-worker.js
git commit -m "feat(orchestrator): 3 个通用 adapter 基建 helper（无处理器 feature 接入）

Why: 续刀 4 个 feature 无命令处理器,adapter 要主动导航/等就绪/发命令/轮询;抽通用 helper
     供 pack_label(本刀)+ship/gen_label(续刀)复用,不每 feature 重写。
What: orchNavigateAndWait(导航+tab complete+executeScript 轮询 readySignal)/
     orchSendStepCommand(发命令重试,不带 CPO ok 语义,超时可配)/
     orchPollState(轮询 storage 终态,fire-forget 长任务用,onTick 可标 committing)。
Test: node --check 语法; chrome 端到端见 Task 5。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Task 2 完成：通用基建就位。`ship`/`gen_label` 续刀时直接 import 这 3 个,不重写导航/轮询/发命令。

---

## Task 3：packing_label content 抽 runBatchPrint + onMessage 入口（node --check）

**Files:**
- Modify: `features/packing_label/content/index.js`

现有 `onStart`（L262-332）把批量循环和 UI（`plConfirm`/`setStatus`/`setRunning`/`showToast`）耦合在一起。先抽 `runBatchPrint` 纯批量函数（去 UI、保留全部 DOM 逻辑 + PL_DIAG 日志、新增 `files` 收集），`onStart` 与编排器命令入口共用。命令入口走 **fire-forget**：收命令→立即 ack→content 后台跑完写 `pl_state`，adapter 轮询（D2）。DOM 逻辑（collectPrintTargets/printAndCapture/savePdf/resolveUniquePath/findScrollContainer）**零改动**。

- [ ] **Step 1: 抽 `runBatchPrint`（插在 `onStart` 函数之前）**

在 `async function onStart() {` 之前插入：

```js
  // 纯批量引擎（从 onStart 抽取,去 UI 依赖;人工 onStart 与 onMessage 命令入口共用）。
  // 复用 collectPrintTargets/printAndCapture/resolveUniquePath/savePdf,DOM 逻辑零改;新增 files 收集。
  async function runBatchPrint({ dir, onProgress }) {
    ctrl('start');
    const container = findScrollContainer();
    const processed = new Set();
    let ok = 0; const fails = []; const files = [];
    if (PL_DIAG) console.log('[PL-DIAG] 滚动容器 h=', container.scrollHeight, 'client=', container.clientHeight);
    try {
      container.scrollTop = 0;
      await U.sleep(400);
      let idleAtBottom = 0;
      for (let guard = 0; guard < 600; guard++) {
        const fresh = collectPrintTargets().filter((t) => t.key && !processed.has(t.key));
        if (fresh.length) {
          const t = fresh[0];
          processed.add(t.key);
          if (onProgress) onProgress(ok, fails.length);
          if (PL_DIAG) console.log(`[PL-DIAG] >>> key=${t.key} qty="${t.qty}" track="${t.trackingRaw}"`);
          try {
            const info = window.__PLNaming.parseTrackingInfo(t.trackingRaw);
            const baseName = window.__PLNaming.buildBaseFileName({ carrier: info.carrier, trackingNo: info.trackingNo, qty: t.qty });
            const bytes = await printAndCapture(t.btn, 8000);
            const path = await resolveUniquePath(dir, baseName);
            await savePdf(path, bytes);
            files.push(path); ok += 1;
          } catch (err) {
            if (PL_DIAG) console.log('[PL-DIAG] 失败', t.key, err.message);
            fails.push(`${t.key || '?'}(${t.qty || '?'}): ${err.message}`);
          }
          await U.sleep(250);
        } else {
          const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
          if (atBottom) { idleAtBottom += 1; if (idleAtBottom >= 2) break; } else { idleAtBottom = 0; }
          container.scrollTop += Math.max(150, Math.round(container.clientHeight * 0.5));
          await U.sleep(450);   // 等虚拟列表重渲染
        }
      }
    } finally {
      ctrl('stop');
      if (PL_DIAG) console.log('[PL-DIAG] === 完成 处理 key 数:', processed.size, '成功:', ok, '失败:', fails.length);
    }
    return { ok, fails, files, processedCount: processed.size };
  }
```

- [ ] **Step 2: `onStart` 改调 `runBatchPrint`（行为不变,只是复用抽出的引擎）**

把现有 `onStart`（L262-332）整体替换为：

```js
  // ── 滚动扫描批量引擎（虚拟列表:从顶滚到底,边滚边处理可见选中商品,按 key 去重）──────
  async function onStart() {
    const dir = getSavePath();
    if (!dir) { AS.showToast('请先设置保存文件夹', 'warn'); return; }
    const selCount = getSelectedCount();
    if (selCount === 0) { AS.showToast('请先勾选要打印的商品', 'warn'); return; }
    const msg = selCount == null
      ? '未能读取页面已选数量,仍要开始打印吗?\n\n(会自动滚动列表逐个打印并保存到预设文件夹)'
      : `当前已选中 ${selCount} 个商品,确认开始打印?\n\n(会自动滚动列表逐个打印并保存到预设文件夹)`;
    if (!(await plConfirm(msg))) return;

    setRunning(true);
    let r;
    try {
      r = await runBatchPrint({ dir, onProgress: (ok, nf) => setStatus(`打印中…已完成 ${ok}${nf ? `,失败 ${nf}` : ''}`) });
    } finally {
      setRunning(false);
    }
    const { ok, fails } = r;
    const total = ok + fails.length;
    if (fails.length) console.warn('[PL] 失败明细:', fails);
    // 对账:实际处理数 < 开始时「已选」数 → 有漏,显式告警而非静默
    const missed = (selCount != null && total < selCount) ? selCount - total : 0;
    if (total === 0) {
      setStatus('没有可打印的选中商品');
      AS.showToast('没有可打印的选中商品', 'warn');
    } else if (fails.length || missed) {
      const parts = [`成功 ${ok}`];
      if (fails.length) parts.push(`失败 ${fails.length}(见 console)`);
      if (missed) parts.push(`疑似漏 ${missed}(已选 ${selCount}、仅处理 ${total},请检查)`);
      setStatus(`完成:${parts.join(',')}｜保存到 ${dir}`);
      AS.showToast(parts.join(','), 'warn');
    } else {
      setStatus(`✅ 全部完成:${ok} 个已存到 ${dir}`);
      AS.showToast(`全部完成:${ok} 个`, 'success');
    }
  }
```

> ⚠ 这是 safe-refactor：人工 onStart 行为必须**完全不变**（同样的校验/确认框/对账/toast）,只是批量循环搬进 `runBatchPrint`。review 时逐行对照原 L262-332。

- [ ] **Step 3: 加 onMessage 命令入口（插在 `AS.registerFeature({` 之前）**

在 `AS.registerFeature({` 调用之前插入：

```js
  // ── 编排器命令入口（fire-forget:bg 发 PL_START_BATCH → 立即 ack;content 后台跑完写 pl_state）──
  // 与人工「开始打印」并存。长批量逼近 SW 5min,故不让 bg 一直 await,完成信号走 storage。
  const PL_STATE_KEY = 'pl_state';
  async function plSetState(patch) {
    const cur = (await chrome.storage.local.get(PL_STATE_KEY))[PL_STATE_KEY] || {};
    await chrome.storage.local.set({ [PL_STATE_KEY]: { ...cur, ...patch, updatedAt: Date.now() } });
  }
  async function plHandleStartBatch(data) {
    // 1. 就绪等待（fresh tab handler 铁律:首行 waitForEl;节点出现≠可交互由 collectPrintTargets 兜）
    try { await U.waitForEl('tr[data-testid="beast-core-table-body-tr"]', document, 15000); }
    catch (e) { return { ok: true, started: false, error: '读取失败:待打包订单表格 15s 未出现' }; }
    // 2. 保存路径（D3:自动化态优先 data.saveDir,回退用户曾手动设的 localStorage）
    const dir = (data && data.saveDir) || getSavePath();
    if (!dir) return { ok: true, started: false, error: '数据校验:未设置标签保存文件夹' };
    // 3. 校验有目标（D4:扫已勾选;无目标报错不静默全打）
    const targets = collectPrintTargets().filter((t) => t.key);
    if (!targets.length) return { ok: true, started: false, error: '数据校验:无选中的待打包商品' };
    // 4. fire-forget:写 running,不 await runBatchPrint,立即 ack;后台跑完写终态
    await plSetState({ status: 'running', total: targets.length, ok: 0, files: [], saveDir: dir });
    runBatchPrint({ dir }).then(async (r) => {
      const status = r.ok > 0 && !r.fails.length ? 'done' : 'error';   // 自动化无人盯:部分失败=漏发,报 error
      await plSetState({
        status, ok: r.ok, files: r.files, failedCount: r.fails.length, fails: r.fails, saveDir: dir,
        errorCategory: status === 'error' ? 'business' : null,
        error: status === 'error'
          ? (r.fails.length ? '部分失败:' + r.fails.join('; ') : '未打印任何标签(扫描到 0 个可打商品)')
          : null,
      });
    }).catch(async (e) => {
      await plSetState({ status: 'error', errorCategory: 'business', error: String(e?.message || e) });
    });
    return { ok: true, started: true };
  }
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'PL_START_BATCH') return;   // 只接管本命令,其余放行
    plHandleStartBatch(msg.data).then(sendResponse).catch((e) => sendResponse({ ok: true, started: false, error: String(e?.message || e) }));
    return true;   // 异步通道
  });
```

> 注：`init` 仍保持 `AS.onPageChange(() => {})`,onMessage 在 IIFE 顶层注册（与 CPO 一致）。`pl_state` 与 CPO 的 `cpo_state` 并存、互不干扰。部分失败报 `error`（比人工 onStart 的 warn 严格）—— 自动化无人盯,漏一个=漏发一个包裹,交编排器/HITL 处置。

- [ ] **Step 4: node --check 验证语法**

Run: `node --check features/packing_label/content/index.js`
Expected: 无输出（语法有效）。

- [ ] **Step 5: commit**

```bash
git add features/packing_label/content/index.js
git commit -m "feat(packing_label): 抽 runBatchPrint + onMessage fire-forget 命令入口（接编排器）

Why: packing_label 无命令处理器,编排器无法程序化调用;批量打印逼近 SW 5min 需 fire-forget。
What: 抽 runBatchPrint 纯批量(onStart 复用,行为不变,DOM 逻辑零改,新增 files 收集);
     加 PL_START_BATCH onMessage 入口(立即 ack started、content 后台跑完写 pl_state);
     saveDir 回退 getSavePath、无目标报 validate(不静默全打)、部分失败报 error。
Test: node --check; chrome 端到端见 plan Task 5（可逆零风险）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Task 3 完成：packing_label 可被 bg 程序化调用,fire-forget + pl_state 闭环,人工入口行为不变。

---

## Task 4：orchAdapterPackLabel + ORCH_ADAPTERS 注册（node --check + dev build）

**Files:**
- Modify: `core/background/service-worker.js`（`orchAdapterCreatePo` 之后、`ORCH_ADAPTERS` 之前；+ `ORCH_ADAPTERS` 表）

把 3 个通用 helper 组装成 pack_label adapter,注册到 dispatch 表,stub fallback 自动让位真 adapter。

- [ ] **Step 1: 插入 orchAdapterPackLabel（在 `orchAdapterCreatePo` 函数结束之后、`const ORCH_ADAPTERS` 之前）**

```js

// ── packing_label adapter（pack_label,可逆无 committing）─────────────────────
// 无处理器 feature:adapter 主动 导航→等就绪→发命令(fire-forget)→轮询 pl_state。复用通用 helper。
async function orchAdapterPackLabel(step, wf) {
  const target = step.target || {};
  const url = target.url || 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list';
  // 1. 清旧 pl_state(防读到上次残留终态)
  await chrome.storage.local.set({ pl_state: { status: 'idle', updatedAt: Date.now() } });
  // 2. 导航 + 等就绪(前台 active 防失焦不渲染)
  let tabId;
  try {
    tabId = await orchNavigateAndWait(url, target.readySignal, { readyTimeoutMs: 30000 });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'PACK_NAV_FAILED', message: '打包标签页打不开或未就绪:' + String(e?.message || e), recoverable: true } };
  }
  // 3. 发命令(fire-forget:content 立即 ack started,后台自驱跑)
  let ack;
  try {
    ack = await orchSendStepCommand(tabId, 'PL_START_BATCH', {});
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'PACK_CMD_FAILED', message: '打包命令未送达:' + String(e?.message || e), recoverable: true } };
  }
  if (ack && ack.started === false) {
    return { status: 'error', error: { category: 'validate', code: 'PACK_NO_TARGET', message: ack.error || '无可打印的待打包商品', recoverable: false } };
  }
  // 4. 轮询 pl_state 终态(content 自驱跑完写,不受 SW 5min await 限)
  const st = await orchPollState('pl_state', { timeoutMs: 8 * 60 * 1000, intervalMs: 3000 });
  if (st.status === 'done') {
    return { status: 'done', result: { savedCount: st.ok || 0, saveDir: st.saveDir || null, files: st.files || [], failedCount: st.failedCount || 0 }, error: null };
  }
  return { status: 'error', error: { category: st.errorCategory || 'business', code: st.code || 'PACK_BATCH_FAILED', message: st.error || st.message || '打包标签失败', recoverable: false } };
}
```

- [ ] **Step 2: ORCH_ADAPTERS 注册 pack_label**

把：
```js
const ORCH_ADAPTERS = {
  create_sku: orchAdapterCreateSku,
  create_po: orchAdapterCreatePo,
  // publish / gen_label / pack_label / ship 暂留 stub，后续 plan 逐个换真 adapter
};
```
改为：
```js
const ORCH_ADAPTERS = {
  create_sku: orchAdapterCreateSku,
  create_po: orchAdapterCreatePo,
  pack_label: orchAdapterPackLabel,
  // publish / gen_label / ship 暂留 stub，后续 plan 逐个换真 adapter
};
```

- [ ] **Step 3: node --check 验证语法**

Run: `node --check core/background/service-worker.js`
Expected: 无输出。

- [ ] **Step 4: dev build 确认入 dist**

Run: `python3 build/build_extension.py`
Expected: exit 0；orchestrator + packing_label + contract 入 dist 无报错。

- [ ] **Step 5: commit**

```bash
git add core/background/service-worker.js
git commit -m "feat(orchestrator): pack_label 真实 adapter（续刀样板第一个无处理器 feature）

Why: 续刀样板——验证「无命令处理器 feature 接入编排器」核心链路成立(导航→等就绪→发命令→
     fire-forget 自驱→轮询 storage→回报),后续 ship/gen_label 照此模式。
What: orchAdapterPackLabel 组装 3 通用 helper(orchNavigateAndWait/SendStepCommand/PollState);
     ORCH_ADAPTERS 注册 pack_label(stub fallback 自动让位);可逆无 committing;
     ack.started===false→validate 错,pl_state 终态→done/error 桥接。
Test: node --check + dev build; chrome 端到端见 Task 5。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Task 4 完成：pack_label dispatch 到真 adapter,「无处理器 feature 接入」链路代码闭环,待 Task 5 chrome 验证。

---

## Task 5：全量回归 + chrome 端到端分级验证

**Files:** 无新建（验证）

> pack_label **可逆**（重打无害），chrome 验证**零风险**,可全验。难点：pack_label 是第 12 步,正常流程要先过 `create_sku`(7)/`create_po`(8)——那俩是第一刀的**真实 CPO** adapter,为隔离 pack_label、不触发真实建单,验证用「**content 直测**」+「**手搭 state 跳到 pack_label**」两条路,均不跑真实 CPO。

- [ ] **Step 1: 全量 JS 单测**

Run: `node --test tests/*.test.js`
Expected: PASS — 第一刀 57 例 + Task 1 新增 1（target 透传）= **58 例,0 失败**。
> ⚠ 必须 `tests/*.test.js`,不要 `node --test tests/`（整目录把 pytest 的 `.py` 当 JS 解析失败,见根 CLAUDE.md）。

- [ ] **Step 2: 全量 Python 单测**

Run: `python3 -m pytest tests/ -q`
Expected: PASS — 20 例（本 plan 不动 build/strip）。

- [ ] **Step 3: dev build + 工作树干净**

Run: `python3 build/build_extension.py && git status --short`
Expected: build exit 0；git status 空（Task 1-4 各自 commit）。

- [ ] **Step 4: chrome 验证 L1——content 直测（fire-forget + 真实打印,必做）**

1. `chrome://extensions` → reload 扩展。
2. 打开 `https://seller.kuajingmaihuo.com/main/order-manager/shipping-list`,**勾选 1-2 个测试待打包订单**。
3. 扩展卡片「service worker」→「检查」开 SW console,跑：

```js
const [t] = await chrome.tabs.query({ url: 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list*' });
await chrome.storage.local.set({ pl_state: { status: 'idle' } });
const ack = await chrome.tabs.sendMessage(t.id, { type: 'PL_START_BATCH', data: { saveDir: 'D:\\test_labels' } }); // 改成你的真实文件夹
console.log('ack:', ack);   // 预期 { ok:true, started:true }
const iv = setInterval(async () => {
  const { pl_state } = await chrome.storage.local.get('pl_state');
  console.log('pl_state:', pl_state);
  if (pl_state.status === 'done' || pl_state.status === 'error') clearInterval(iv);
}, 2000);
```

- **预期**：`ack={ok:true,started:true}` 立即返回（fire-forget,不等批量）→ `pl_state` 从 `running` 变 `done`,`files` 有 PDF 绝对路径数组,`savedCount`>0,文件真实存到 `saveDir`。
- **不勾选**时重跑：`ack={ok:true,started:false,error:'数据校验:无选中的待打包商品'}`,`pl_state` 不进 running（D4「无目标报错不静默全打」成立）。
- ✅ 验证点：content onMessage 入口 + fire-forget + pl_state 闭环 + 真实打印保存全通。

- [ ] **Step 5: chrome 验证 L2——adapter 编排链路（手搭 state 跳到 pack_label,避开真实 CPO）**

承接 L1（shipping-list 页保持已勾选 1 个测试单）。SW console 手搭一个 cursor 停在 `wait_arrival`(step 11,HITL) 的 workflow,确认后即推进到 `pack_label`(12,AUTO) 真跑 adapter：

```js
const sk = ORCH.contract.normalizeSkeleton(null);                 // 空 batch 骨架
const wf = ORCH.steps.buildInitialWorkflow({ label: '打包adapter测试' }, () => 'wf_pack_test');
for (let i = 0; i < 11; i++) wf.steps[i].status = 'done';         // 前 11 步标 done（跳过真实 CPO）
wf.cursor = 11; wf.status = 'paused'; wf.steps[11].status = 'paused';
wf.hitl = { action: '人工确认到货', stepId: 'wait_arrival', keyValues: {}, reviewedBrief: '', editable: false, fieldType: null, options: null, targetUrl: null, status: 'pending' };
sk.batch.workflows.push(wf);
await chrome.storage.local.set({ [ORCH.contract.STORAGE_KEY]: sk });
orchHitlConfirm({ workflowId: 'wf_pack_test' });                  // 确认到货 → 推进 pack_label adapter
```

- **预期**：
  - SW console 看到 adapter 导航开 shipping-list tab（前台）→ `PL_START_BATCH` 发出 → content fire-forget 跑 → adapter 轮询 `pl_state`。
  - 完成后查 `as_workflow_state`：`steps[pack_label].status='done'`、`result.files`/`saveDir`/`savedCount` 有值,`cursor` 推进到 13 `ship`（stub fallback 跑）→ workflow `done`。
  - **无勾选**时：`steps[pack_label].status='error'`、`error.code='PACK_NO_TARGET'`、`category='validate'`,workflow `error`（adapter 错误路径成立）。
- ✅ 验证点：3 通用 helper（导航/发命令/轮询）组装的 adapter 被编排器调用、回报、推进全链路成立 —— 「无处理器 feature 接入」模式验证通过,后续 ship/gen_label 可照此。

- [ ] **Step 6: 清理**

```js
chrome.storage.local.remove(['as_workflow_state', 'pl_state'])
```
人工去文件夹删测试 PDF（如需要）。

## 完成定义（DoD）

- steps.js `target` 透传 + pack_label target,单测覆盖（58 例 0 失败）。
- 3 通用 helper（orchNavigateAndWait/orchPollState/orchSendStepCommand）就位,`node --check` 通过。
- packing_label 抽 runBatchPrint（人工 onStart 行为不变）+ onMessage fire-forget 入口,`pl_state` 闭环。
- orchAdapterPackLabel 注册 ORCH_ADAPTERS,dev build exit 0,工作树干净（Task 1-4 各自 commit）。
- chrome **L1（content 直测,含真实打印）+ L2（adapter 编排链路,手搭 state）验证通过**（可逆零风险,必做）。

## 与后续刀的衔接

- **样板立的基建直接复用**：3 通用 helper（导航等就绪 / 发命令 / 轮询 storage）+ fire-forget 模式 = 后续 `ship`/`gen_label` 的接入骨架。
  - **ship**：`orchSendStepCommand` 复用（`timeoutMs` 调 180000,单单 30-60s）+ 强不可逆要 `orchMarkCommitting` 包裹 + 成功判定靠「popover 二次确认 + 行消失」+ 运单号产出降级 `{shipped,orderNo,packageNo}`（probe-ship 报告）。
  - **gen_label**：跨页 localStorage 自驱 → content 三个收尾点写 `chrome.storage.local['agl_state']` + `orchPollState('agl_state', {onTick: 标 committing})`（probe-genlabel 报告）。
  - **publish**：数据流死结（无店小秘商品 URL 锚点）+ 填表缺口（probe-fillform）→ 单列,需先决 core 改动 / 填表 spec。
- **已知缺口（诚实标注,非本 plan 修）**：① `saveDir` 首版 content 回退 `getSavePath()`,编排器统一配置透传留后续；② 按 `wf.product` 订单标识**精确定位**待打单留数据流补（首版扫页面已勾选,无目标报错不静默全打）；③ SW 5min 大批量被回收时,engine recover 对 reversible 步 rerun（物理安全）,但 content 的 `processed` 不跨 SW 实例持久,rerun 会重扫已打的（重打无害但浪费）——后续可把 `processed` 写进 `pl_state` 续跑。
- **PR 时机**：2-2a + 2-2b（含第一刀 CPO + 本样板 + ship/gen_label 续刀）+ 2-2c 一起 PR（单独都是半成品）。

## Self-Review（writing-plans 自检,已跑）

- **spec 覆盖**：§7 改造模式（加命令入口 → Task 3；导航后就绪等待 → Task 2 orchNavigateAndWait + Task 3 handler 首行 waitForEl；结构化回报 → Task 3/4；不可逆提交点 → 本步可逆,D5 说明不需 committing）；§9.1 SW 5min → fire-forget（D2）。pack_label 改造 = 本 plan,其余 3 feature = 衔接段。
- **placeholder 扫描**：无 TBD/TODO；每个代码 step 有完整代码 + 确切命令 + 预期输出；chrome 验证给可跑 snippet。
- **类型一致**：`orchNavigateAndWait`/`orchPollState`/`orchSendStepCommand`/`orchAdapterPackLabel`/`PL_STATE_KEY`/`runBatchPrint` 跨 Task 命名一致；adapter 回报 `{status,result,error}` 与 engine.js advance 消费（`res.status==='done'`/`res.error`）对齐；`pl_state` 字段（status/ok/files/saveDir/failedCount/errorCategory/error）content 写与 adapter 读一致；ack `{ok,started,error}` content 返回与 adapter `ack.started===false` 判断一致。
- **风险**：可逆零风险（D5）；`orchNavigateAndWait` 的 `chrome.scripting.executeScript` readySignal 检查依赖 manifest host_permissions 含 seller.kuajingmaihuo.com（Task 2 标注,executeScript 失败降级 + content waitForEl 兜底,Task 5 实证）；SW 5min 大批量（衔接段缺口③,fire-forget 缓解 + recover rerun 兜底）。
