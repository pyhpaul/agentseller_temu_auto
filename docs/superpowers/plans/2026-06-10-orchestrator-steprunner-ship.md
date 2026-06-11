# ship 步接入编排器（Plan 2-2b 续刀·auto_ship）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans 逐 Task 实施。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 把 `ship` 步的 stub fallback 换成真实 adapter,接 `auto_ship`。**复用 pack_label 样板立的 3 个通用 helper**（零新增基建）,增量只在 ship 特定:强不可逆 `committing` 包裹、强制 `autoConfirm` 跳人工弹窗、成功判定靠 popover 二次确认 + 行消失、运单号发货页拿不到降级产出。

**Architecture:** 三层。① `steps.js` ship 加 `target{url,readySignal}`。② `auto_ship/content/index.js` 加 onMessage `AUTO_SHIP_RUN_ONE`（强制 `run.autoConfirm=true`、`scanForPick` 取一单、`processOrder` 处理、补 `waitOrderGone` 行消失确认、结构化回报）。③ `service-worker.js` `orchAdapterShip`（`orchNavigateAndWait` 导航 → `orchMarkCommitting` 包裹不可逆 → `orchSendStepCommand` **直接回报**[非 fire-forget,单单 30-60s] → 透传）+ `ORCH_ADAPTERS` 注册。

**Tech Stack:** Vanilla JS,`node:test`,Chrome MV3 classic SW。复用样板 helper（`orchNavigateAndWait`/`orchSendStepCommand`/`orchMarkCommitting`）+ auto_ship 全部现有 DOM 逻辑（processOrder/scanForPick/clickConfirmShip 零改）。

---

## 范围说明

Plan 2-2b 续刀第二个 feature（pack_label 样板之后）。auto_ship 与 pack_label 同为「无处理器 + 页面自扫描」,但 **ship 强不可逆**（真实发货）+ **成功判定无后端信号**。源 spec §7；调研依据 `probe-ship` 报告（9a/9b/9c）。

- **覆盖**：ship target + auto_ship onMessage `AUTO_SHIP_RUN_ONE` + orchAdapterShip + 注册。
- **不在本 plan**：`gen_label`/`publish` adapter（续刀后续）；运单号真实获取（发货页拿不到,降级 `waybillNo:null`）；按 `wf.product` 订单标识**精确指定发哪单**（首版扫 `scanForPick` 取下一单,product 无发货单号字段）。
- **验证**：steps target = `node --test`；onMessage/adapter = `node --check` + dev build；chrome **L1 content 直测**（安全,不真发货——见 Task 4）+ **L2 adapter+真实发货**（⚠ 强不可逆,需测试单 + 用户授权）。

## 关键决策（实现前先读）

| # | 决策 | 理由 |
|---|------|------|
| D1 | **复用样板 3 helper,零新增基建** | pack_label 已验证 `orchNavigateAndWait`/`orchSendStepCommand`/`orchMarkCommitting`;ship 直接用。 |
| D2 | **直接回报（非 fire-forget）** | ship 一次一单、单单 30-60s,远低于 SW 5min。`orchSendStepCommand({timeoutMs:180000})` await 拿 content 回报即可,不需 pack_label 的 storage 轮询（那是为批量不定长 fire-forget）。 |
| D3 | `committing` **粗粒度（发命令前标）** | `processOrder` 含不可逆 `clickConfirmShip`;前半段（打印/批量发货/填编辑页）可逆,但精确标记需 content 反向信号、复杂。发命令前标 committing：前半段失败也转人工（过度保守但安全,符合 spec §4.2「不确定→转人工」,且 ship 是末步、前半段失败概率低）。 |
| D4 | 强制 `run.autoConfirm=true` | 编排器调用=无人盯,必须跳 `askConfirmShip`（487 行人工弹窗,否则卡在永不 resolve 的 Promise）。handler `finally` 还原 `prevAutoConfirm`。 |
| D5 | **一次一单**（`AUTO_SHIP_RUN_ONE`）| auto_ship 自扫描全部待发货单 vs 编排器单 workflow。命令调 `scanForPick` 取下一未处理单 + `processOrder` 一单。⚠ 精确指定发哪单（product 订单标识）留后续——product 无发货单号字段。 |
| D6 | 成功判定 + 运单号降级 | `processOrder` 返回 `kind:'shipped'`（popover 二次确认已在 `clickConfirmShip` 内点）+ handler 补 `waitOrderGone`（行从待发货列表消失=后端受理,弹窗操作生效铁律）。运单号发货页 DOM 拿不到 → 产出 `{shipped:true, orderNo, waybillNo:null}`（orderNo 可靠追溯）。 |

## 文件结构

| 文件 | 职责 | 改动 |
|------|------|------|
| `core/background/orchestrator/steps.js` | ship 步加 `target{url,readySignal}` | 改 1 处 |
| `tests/orchestrator-steps.test.js` | 加 ship target 断言 | 改 |
| `features/auto_ship/content/index.js` | 加 onMessage `AUTO_SHIP_RUN_ONE` + `waitOrderGone` + StepError 工厂 | 改（只加入口,DOM 逻辑零改） |
| `core/background/service-worker.js` | `orchAdapterShip` + `ORCH_ADAPTERS` 注册 ship | 改 |

> auto_ship 的 processOrder/scanForPick/clickConfirmShip/confirmShipPopover/closeEditPage **零改动**——只加命令入口调用它们。样板 3 helper 零改动——只调用。

---

## Task 1：steps.js ship target（纯逻辑 TDD）

**Files:** Modify `core/background/orchestrator/steps.js`、`tests/orchestrator-steps.test.js`

target 透传已由 pack_label 样板打通（buildInitialWorkflow 的 `target: d.target||null`）,本 Task 只给 ship 声明 target。

- [ ] **Step 1: 先写失败测试**（`tests/orchestrator-steps.test.js` 末尾加）

```js
test('buildInitialWorkflow: ship step 带 target（续刀 auto_ship）', () => {
  const wf = buildInitialWorkflow({ label: 'X' }, () => 'w1');
  const ship = wf.steps.find(s => s.id === 'ship');
  assert.strictEqual(ship.target.url, 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list');
  assert.strictEqual(ship.target.readySignal, '[data-testid="beast-core-table-body-tr"]');
});
```

- [ ] **Step 2: 跑失败** — `node --test tests/orchestrator-steps.test.js` → ship.target 为 null,`ship.target.url` 抛 TypeError。

- [ ] **Step 3: 改 steps.js** — ship 行（`{ id: 'ship', ... domain: 'kuajingmaihuo.com' },`）改为：

```js
    { id: 'ship',             label: '确认发货',              type: 'auto', feature: 'auto_ship',             reversible: false, domain: 'kuajingmaihuo.com',
      target: { url: 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list', readySignal: '[data-testid="beast-core-table-body-tr"]' } },
```

- [ ] **Step 4: 跑通过** — `node --test tests/orchestrator-steps.test.js` → 全绿（pack 样板 6 例 + ship 1 = 7 例）。

- [ ] **Step 5: commit**

```bash
git add core/background/orchestrator/steps.js tests/orchestrator-steps.test.js
git commit -m "feat(orchestrator): ship step target（续刀 auto_ship 接入准备）

Why: ship adapter 需按 step.target 导航到发货页 + readySignal 等就绪。
What: STEP_DEFS ship 加 target{url:shipping-list, readySignal:beast-core-table-body-tr}。
Test: node --test orchestrator-steps ship target 用例全绿。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2：auto_ship onMessage AUTO_SHIP_RUN_ONE（node --check）

**Files:** Modify `features/auto_ship/content/index.js`

在 `AS.registerFeature({` 之前插入命令入口。复用现有 `scanForPick`/`processOrder`/`closeEditPage`/`ensureOnPendingTab`/`scanOrderNos`/`clearRowHighlight`/`run`/`SEL`,**DOM 逻辑零改**。

- [ ] **Step 1: 插入命令入口（在 `AS.registerFeature({` 之前）**

```js
  // ── 编排器命令入口（与人工「开始/单步」并存,不自驱）──────────────────────
  // 命令 AUTO_SHIP_RUN_ONE：处理待装箱发货 tab 扫到的下一个未处理单(一次一单)。
  // 编排器调用=无人盯 → 强制 autoConfirm 跳 askConfirmShip 弹窗(否则卡永不 resolve 的 Promise)。
  function asStepError(category, code, message, recoverable) {
    return { category, code, message, recoverable, suggestion: null };
  }
  // 发货后等该单从待装箱发货列表消失(=后端受理、表格刷新)。超时返 false(降级不抛)。
  async function waitOrderGone(orderNo, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      await ensureOnPendingTab();
      const live = await scanOrderNos();
      if (!live.includes(orderNo)) return true;
      await U.sleep(600);
    }
    return false;
  }
  async function asHandleRunOne() {
    // 1. 就绪等待(fresh tab handler 铁律:首行 waitForEl)
    try { await U.waitForEl(SEL.bodyRow, 12000); }
    catch (e) { return { status: 'error', error: asStepError('read', 'SHIP_LIST_NOT_READY', '读取失败：发货单列表 12s 内未渲染（' + e.message + '）', true) }; }
    if (run.active) return { status: 'error', error: asStepError('business', 'SHIP_BUSY', '业务：已有发货任务在跑', true) };
    run.active = true;
    const prevAutoConfirm = run.autoConfirm;
    run.autoConfirm = true;   // 编排器=无人盯,强制全自动确认(跳 askConfirmShip)
    try {
      const orderNo = await scanForPick();
      if (!orderNo) return { status: 'done', result: { shipped: false, reason: 'NO_PENDING', orderNo: null }, error: null };
      let r;
      try {
        r = await processOrder(orderNo);
      } catch (err) {
        try { await closeEditPage(); } catch (e2) { console.warn('[auto_ship] 清理残留弹窗失败', e2); }
        run.processed.add(orderNo);
        const cat = (err && err._cat) === 'data' ? 'validate' : (err && err._cat) === 'biz' ? 'business' : 'read';
        return { status: 'error', error: asStepError(cat, 'SHIP_FAILED', (err && err.message) || String(err), cat !== 'business') };
      }
      run.processed.add(orderNo);
      if (r.kind === 'local') return { status: 'done', result: { shipped: false, reason: 'LOCAL_WAREHOUSE', orderNo }, error: null };
      if (r.kind === 'cancelled') return { status: 'error', error: asStepError('business', 'SHIP_CANCELLED', '业务：发货被取消', true) };
      // r.kind === 'shipped'：确认发货已点(含 popover 二次确认)。补「行消失」确认(弹窗操作生效铁律)。
      run.lastShipped = orderNo;
      const gone = await waitOrderGone(orderNo, 8000);
      return { status: 'done', result: { shipped: true, orderNo, waybillNo: null, vanished: gone }, error: null };
    } finally {
      run.active = false; run.autoConfirm = prevAutoConfirm; clearRowHighlight();
    }
  }
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'AUTO_SHIP_RUN_ONE') return;   // 只接管本命令,其余放行
    asHandleRunOne().then(sendResponse).catch((e) => sendResponse({ status: 'error', error: asStepError('read', 'HANDLER_THREW', String((e && e.message) || e), false) }));
    return true;   // 异步通道
  });
```

> ⚠ 强制 `autoConfirm` 关键：不跳 `askConfirmShip`(487)会卡在永不 resolve 的人工弹窗 Promise。`finally` 必还原 `prevAutoConfirm`,不污染人工模式。`waitOrderGone` 是唯一新增 DOM 交互（只读 scanOrderNos,落实「弹窗操作以行消失为生效信号」铁律）。运单号发货页拿不到 → `waybillNo:null`。

- [ ] **Step 2: node --check** — `node --check features/auto_ship/content/index.js` → 无输出。

- [ ] **Step 3: commit**

```bash
git add features/auto_ship/content/index.js
git commit -m "feat(auto_ship): onMessage AUTO_SHIP_RUN_ONE 命令入口（接编排器）

Why: auto_ship 无命令处理器,编排器无法程序化调用;ship 强不可逆需无人盯全自动。
What: 加 AUTO_SHIP_RUN_ONE(强制 run.autoConfirm 跳人工弹窗、scanForPick 取一单、processOrder
     处理、补 waitOrderGone 行消失确认、错误 _cat→category 映射)；DOM 逻辑零改。
     成功判定靠 processOrder kind=shipped(popover 已点)+行消失;运单号拿不到 waybillNo:null。
Test: node --check; chrome 端到端见 plan Task 4(L2 真实发货需授权)。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3：orchAdapterShip + 注册（node --check + dev build）

**Files:** Modify `core/background/service-worker.js`（`orchAdapterPackLabel` 之后、`ORCH_ADAPTERS` 之前；+ 表）

- [ ] **Step 1: 插入 orchAdapterShip（在 `orchAdapterPackLabel` 函数结束之后、`const ORCH_ADAPTERS` 之前）**

```js

// ── auto_ship adapter（ship,✗强不可逆）─────────────────────────────────────
// 无处理器 feature:adapter 导航→等就绪→committing 包裹→直接回报(单单 30-60s,非 fire-forget)。
async function orchAdapterShip(step, wf) {
  const target = step.target || {};
  const url = target.url || 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list';
  let tabId;
  try {
    tabId = await orchNavigateAndWait(url, target.readySignal, { readyTimeoutMs: 30000 });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'SHIP_NAV_FAILED', message: '发货页打不开或未就绪:' + String(e?.message || e), recoverable: true } };
  }
  // ★强不可逆提交点:发命令前标 committing(粗粒度取安全;正常 engine 收尾清,回收留 true→转人工不自动重发)
  await orchMarkCommitting(wf.id, true);
  let resp;
  try {
    resp = await orchSendStepCommand(tabId, 'AUTO_SHIP_RUN_ONE', {}, { timeoutMs: 180000, retries: 25 });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'SHIP_CMD_FAILED', message: '发货命令未送达:' + String(e?.message || e), recoverable: false } };
  }
  // content 回 {status,result,error},直接透传给 engine(advance 据 status 落地、清 committing)
  return resp || { status: 'error', error: { category: 'read', code: 'SHIP_NO_RESP', message: '发货命令无响应', recoverable: false } };
}
```

- [ ] **Step 2: ORCH_ADAPTERS 注册 ship**

把：
```js
  pack_label: orchAdapterPackLabel,
  // publish / gen_label / ship 暂留 stub，后续 plan 逐个换真 adapter
};
```
改为：
```js
  pack_label: orchAdapterPackLabel,
  ship: orchAdapterShip,
  // publish / gen_label 暂留 stub，后续 plan 逐个换真 adapter
};
```

- [ ] **Step 3: node --check** — `node --check core/background/service-worker.js` → 无输出。

- [ ] **Step 4: dev build** — `python3 build/build_extension.py` → exit 0。

- [ ] **Step 5: commit**

```bash
git add core/background/service-worker.js
git commit -m "feat(orchestrator): ship 真实 adapter（续刀 auto_ship,复用样板基建）

Why: 续刀第二个无处理器 feature;复用 pack_label 样板的 3 helper 接 auto_ship。
What: orchAdapterShip(orchNavigateAndWait 导航→orchMarkCommitting 包裹强不可逆→
     orchSendStepCommand 直接回报 timeoutMs 180s→透传);ORCH_ADAPTERS 注册 ship。
     非 fire-forget(单单 30-60s 远低于 SW 5min);committing 粗粒度发命令前标。
Test: node --check + dev build; chrome 端到端见 Task 4(L2 真实发货需授权)。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4：全量回归 + chrome 验证

**Files:** 无新建（验证）

> ⚠ **ship 与 pack_label 关键不同**：pack_label 可逆,content 直测安全；**ship 强不可逆——只要发货页有待发货单,`AUTO_SHIP_RUN_ONE` 一发出就真发货（点确认发货,真出货不可回滚）**。故无「可逆安全直测」。验证策略：自动层(单测/check/build)安全必做；chrome 端只有「**无待发货单→NO_PENDING**」是安全路径；**真实发货必须用确实要发的真实单 + 用户明确授权**,不为验证发不该发的货。

- [ ] **Step 1: 全量 JS 单测** — `node --test tests/*.test.js` → **59 例**（pack 样板后 58 + ship target 1）,0 失败。⚠ 用 `tests/*.test.js` 不要 `tests/`。

- [ ] **Step 2: 全量 Python 单测** — `python3 -m pytest tests/ -q` → 20 例。

- [ ] **Step 3: dev build + git clean** — `python3 build/build_extension.py && git status --short` → exit 0 + 空。

- [ ] **Step 4: chrome 安全路径验证（NO_PENDING,不真发货）**

`chrome://extensions` reload → 登录 kuajingmaihuo 发货页。**确保「待装箱发货」tab 当前无待发货单**（或都已发完）。SW console（扩展卡片 service worker → 检查）：

```js
const sk = ORCH.contract.normalizeSkeleton(null);
const wf = ORCH.steps.buildInitialWorkflow({ label: 'ship测试' }, () => 'wf_ship_test');
for (let i = 0; i < 12; i++) wf.steps[i].status = 'done';   // 0-11 done(跳过含真实 CPO 的前序)
wf.cursor = 12; wf.status = 'running';                       // ship(12)待跑
sk.batch.workflows.push(wf);
await chrome.storage.local.set({ [ORCH.contract.STORAGE_KEY]: sk });
orchEngine.advance('wf_ship_test');
const iv = setInterval(async () => {
  const { as_workflow_state } = await chrome.storage.local.get('as_workflow_state');
  const w = as_workflow_state.batch.workflows.find(x => x.id === 'wf_ship_test');
  console.log('ship:', w.steps[12].status, JSON.stringify(w.steps[12].result || w.steps[12].error), 'wf:', w.status);
  if (['done','error'].includes(w.status)) clearInterval(iv);
}, 3000);
```

- **预期（无待发货单）**：adapter 导航发货页 → 标 committing → `AUTO_SHIP_RUN_ONE` → `scanForPick` 返回 null → `{shipped:false, reason:'NO_PENDING'}` → ship `done` → wf `done`。**全程不发货**,验证了导航 + committing + 命令往返 + 回报链路。
- > 若 `orchEngine` 未定义,改用 `orchHitlConfirm`：手搭 `wf.cursor=10`(wait_arrival HITL paused、`wf.status='paused'`、`steps[10].status='paused'`、加 hitl 摘要),`orchHitlConfirm({workflowId:'wf_ship_test'})` 推进（会连带 pack_label[11] 真跑——可逆打印,需 shipping-list 有待打包单+saveDir,否则 pack_label 报 NO_TARGET 中止、到不了 ship）。

- [ ] **Step 5: chrome 真实发货验证（🔴 强不可逆,需用户授权 + 真实待发单）**

> 🔴 **ship 会真实点「确认发货」→ 真出货,不可回滚、无法作废**。必须：① 用户明确授权；② 用一个**确实要发货的真实单**当验证对象（验证即完成真实业务,不发不该发的货）。

发货页「待装箱发货」有真实待发单时,跑 Step 4 同款 snippet：
- **预期**：adapter 导航 → committing → `AUTO_SHIP_RUN_ONE` → `processOrder`（打印打包标签→批量装箱发货→编辑页填箱数/时间→`clickConfirmShip`+popover 二次确认）→ `waitOrderGone` 该单从列表消失 → `{shipped:true, orderNo, waybillNo:null}` → ship `done`、`committing` 被 engine 清回 false → wf `done`。
- ✅ 验证点：强不可逆 ship 真跑成功 + committing 包裹 + 成功判定(popover+行消失)+ 运单号降级产出。
- 清理：`chrome.storage.local.remove('as_workflow_state')`。

## 完成定义（DoD）

- ship target 单测覆盖（JS 59 例 0 失败）。
- auto_ship onMessage `AUTO_SHIP_RUN_ONE`（强制 autoConfirm + 一次一单 + waitOrderGone + 错误分层映射）,DOM 逻辑零改,`node --check` 通过。
- orchAdapterShip（复用样板 3 helper + committing 包裹 + 直接回报）注册 ORCH_ADAPTERS,dev build exit 0,工作树干净。
- chrome **Step 4 安全路径（NO_PENDING）验证通过**（必做,不发货）。
- chrome **Step 5 真实发货 = 强不可逆**：需用户授权 + 真实待发单,控制者协调执行。

## 与后续刀的衔接

- **gen_label 续刀**：最复杂——跨页 localStorage 自驱（talCFlow→talImgFlow,content 跨 4 页 reload 销毁无法 await）。桥接=content 三收尾点写 `chrome.storage.local['agl_state']` + `orchPollState('agl_state', {onTick: 标 committing})`（复用样板 helper 的 onTick 钩子!）。SW 5min 风险最高。probe-genlabel 报告有方案。
- **publish 续刀**：数据流死结（wf.product 无店小秘商品 URL 锚点,推荐复用上游编辑页 tab）+ 填表缺口（probe-fillform,需先决 spec）。单列、最后做。
- **PR 时机**：2-2a + 2-2b（CPO 第一刀 + pack_label 样板 + 本 ship + gen_label）+ 2-2c 一起 PR。

## Self-Review（已跑）

- **spec 覆盖**：§7 改造模式（命令入口 → Task 2；导航就绪 → 样板 orchNavigateAndWait + handler 首行 waitForEl；结构化回报 → Task 2/3；不可逆 committing → Task 3 orchMarkCommitting）。
- **placeholder 扫描**：无 TBD；每代码 step 完整代码 + 命令 + 预期。
- **类型一致**：`orchAdapterShip`/`asHandleRunOne`/`AUTO_SHIP_RUN_ONE`/`waitOrderGone` 命名一致；content 回 `{status,result,error}` 与 orchSendStepCommand 透传 + engine advance 消费对齐；复用 helper 签名（`orchSendStepCommand(tabId,type,data,{timeoutMs,retries})`/`orchNavigateAndWait`/`orchMarkCommitting`）与样板一致。
- **风险**：ship 强不可逆无安全可逆直测（真命令即真发货）→ 验证策略分「安全路径 NO_PENDING」+「真实发货需授权」（Task 4 Step 4/5 显式分级 + 授权门）；committing 粗粒度（D3,过度保守但安全）；运单号降级 `waybillNo:null`（D6,发货页 DOM 不可得,诚实标注）。
