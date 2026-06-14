# Plan 2 编排器 Chrome 端到端验证清单

> 自动化「上架→发货」确定性骨架（Plan 2，无 LLM）已合入 main（merge `3ea8990`）。
> 本清单给「下次」照着在 Chrome 里跑。所有 SW console snippet 基于真实代码（`core/background/service-worker.js` + `automation/orchestrator/engine.js` + `automation/orchestrator/steps.js`）。
>
> 注：#61 后 orchestrator/ws-client 已迁至 `automation/`，本清单 console snippet（用 SW 全局符号名 `orchEngine`/`ORCH`/`orchStartWorkflow` 等，不依赖文件路径）仍有效，仅源码文件路径变更。
> **硬约束：本清单全过之前不发版（不推 tag）。** 任一不可逆步翻车 → 停下回 debug，不发员工。

---

## 前置（一次性）

1. **构建 + 加载**
   ```bash
   python3 build/build_extension.py        # 全量构建 → dist/extension/
   ```
   `chrome://extensions` → 加载已解压扩展（首次）或点扩展卡片右下角 **reload**（已加载）。

2. **确认 Chrome 真 reload 了新版**：业务页 Panel 标题栏右上角灰色小字 `dev:<ts>`，`<ts>` 与本次 build 时间一致才算生效。

3. **打开 SW console**（跑所有 snippet 的地方）：
   `chrome://extensions` → AgentSeller 卡片 → 点 **Service Worker** 蓝链 → DevTools console。
   验一下编排器顶层符号可见：
   ```js
   typeof orchStartWorkflow === 'function' && typeof orchEngine === 'object' && typeof ORCH === 'object'
   // 预期 true。若 false：SW 可能刚回收，关掉 DevTools 重开一次。
   ```

4. **⚠ 浮层验证头号坑 —— 孤儿 tab**：浮层（overlay.js）是 content script，只在「扩展 reload **之后**重新加载过」的业务页里活。
   reload 扩展前就开着的 tab = 孤儿（content script 已失效，`storage.onChanged` 静默失效，看不到浮层 / 看到旧状态）。
   **验浮层前，把目标业务页 F5 刷新一次**（或新开）。详见 memory `feedback_orphan_tab_reload`。

5. **浮层出现的域**：只在 host_permissions 匹配的页注入 —— `seller.temu.com` / `*.temu.com` / `dianxiaomi.com` / `kuajingmaihuo.com` / `1688.com`。SW console 构造 workflow 后，去这些域里**已刷新过**的 tab 看浮层（右下角，FAB 上方）。

---

## 13 步副作用风险表（决定隔离验证的安全度）

| cursor | step | 类型 | 副作用 | 隔离单验 |
|---|---|---|---|---|
| 0 | select_product | HITL | 无 | ✓ 零副作用 |
| 1 | collect_dxm | HITL | 无 | ✓ |
| 2 | **publish** | AUTO | ✗ 真发布到 Temu | ⚠ 不可逆 |
| 3 | get_return_price | HITL | 无 | ✓ |
| 4 | compare_1688 | HITL | 无 | ✓ |
| 5 | order_1688 | HITL | 无 | ✓ |
| 6 | **gen_label** | AUTO | ✗ 真写合规 + 插标签主图到 Temu 商品 | ⚠ 不可逆（污染商品数据） |
| 7 | **create_sku** | AUTO | △ 建店小秘 SKU | 半可逆（feature 层幂等校验） |
| 8 | **create_po** | AUTO | ✗ 真下 1688 采购单 | ⚠⚠ 强不可逆 |
| 9 | wait_payment | HITL | 无 | ✓ |
| 10 | wait_arrival | HITL | 无 | ✓ |
| 11 | **pack_label** | AUTO | ✓ 生成打包标签文件 | 可逆（已验过） |
| 12 | **ship** | AUTO | ✗ 真发货 | ⚠⚠ 强不可逆 |

**验证顺序建议**：L0 纯逻辑 → L1 浮层（零副作用）→ L2 逐个 AUTO 隔离（按可逆→不可逆排，pack_label 先、ship/create_po 最后）→ L3 完整端到端（要测试商品）→ L4 WS（dashboard）。

---

## L0 — 纯逻辑回归（零副作用，先跑）

WSL/终端跑，不进 Chrome：
```bash
node --test tests/*.test.js        # ⚠ 不要 node --test tests/（整目录会把 pytest .py 当 JS 解析失败）
python3 -m pytest tests/
```
预期：JS 全过（含 `ws-client.test.js` 4 用例 + `dashboard-store` + `version-cmp`）、Python `20 passed`（剥离 + build 逻辑）。
这是合入前已验过的基线，reload 前先复跑确认工作树干净没回归。

---

## L1 — 浮层 + HITL 链路 + storage（零业务副作用）

**目的**：验浮层弹窗渲染 / 「确认完成」推进 / storage 跨 tab 同步。选 cursor=9（wait_payment，纯 HITL 无 target）起跑，推进到 cursor=10（wait_arrival，仍 HITL），全程不碰 AUTO 步 → 零业务副作用。

**SW console**：
```js
const wfId = 'wf_verify_hitl_' + Date.now();
await orchQueue.enqueue(sk => {
  const wf = ORCH.steps.buildInitialWorkflow({ label: '验证-浮层' }, () => wfId);
  wf.status = 'running';
  wf.cursor = 9;                       // wait_payment（HITL，无 target.url）
  wf.steps[9].status = 'pending';
  if (!sk.batch.id) { sk.batch.id = 'batch_verify'; sk.batch.createdAt = Date.now(); }
  sk.batch.workflows.push(wf);
  sk.batch.activeWorkflowId = wfId;
  return sk;
});
await orchEngine.advance(wfId);        // → pause-hitl，浮层应弹出
console.log('构造完成', wfId, '→ 去已刷新的业务页看右下角浮层');
```

**预期现象**：
- 任一已刷新的业务页右下角弹深色浮层：`编排进度 10/13 · 等财务付款` + 待处理标题 + 「确认完成」「拒绝」两个按钮。
- **无「前往」按钮** —— 首版 13 步的 HITL 都无 `step.target` → `buildHitl` 的 `targetUrl=null`。这是预期，不是 bug；「前往」是为未来带 target 的 HITL / 大脑保留的向前兼容分支。

**点「确认完成」** → overlay 发 `WF_HITL_CONFIRM` → SW `orchHitlConfirm` → cursor→10 → 浮层应变 `编排进度 11/13 · 等到货`。storage 跨 tab：另开一个业务页也应同步显示同一状态。

**⚠ 别再点第三次「确认完成」**：cursor=10 确认后会推进到 cursor=11（pack_label，AUTO），触发真跑（虽可逆）。验到这里即可。

**清理**：
```js
chrome.storage.local.remove('as_workflow_state');   // 或：发 WF_ABORT
```

**可选 —— 错误分层 chip**：手动把 workflow 置 error 看三色 chip。
```js
const wfId2 = 'wf_verify_err_' + Date.now();
await orchQueue.enqueue(sk => {
  const wf = ORCH.steps.buildInitialWorkflow({ label: '验证-error' }, () => wfId2);
  wf.status = 'error'; wf.cursor = 6;
  wf.steps[6].status = 'error';
  wf.steps[6].error = { category: 'read', code: 'TEST', message: '测试读取层错误', recoverable: true };
  if (!sk.batch.id) { sk.batch.id = 'batch_verify'; sk.batch.createdAt = Date.now(); }
  sk.batch.workflows.push(wf); sk.batch.activeWorkflowId = wfId2;
  return sk;
});
// 不 advance；error 是终态。去业务页看浮层。
```
预期：浮层显示紫色（`read`=#bc8cff）错误 chip + 「重试」（recoverable=true 才有）+「转人工」。改 `category` 为 `validate`（黄）/`business`（红）看变色；改 `recoverable:false` → 「重试」消失只剩「转人工」。点「重试」→ `WF_RETRY` → 当前步重置 pending + advance（cursor=6 是 gen_label，会真跑，验完 chip 渲染就 abort 别点重试）。清理同上。

---

## L2 — 单 AUTO adapter 隔离真跑（逐个，真业务副作用）

**目的**：跳过不可逆前置步，单跑某个 adapter，确认导航/命令/轮询/错误回报真实可用。按风险表排序：pack_label（可逆）先，ship/create_po（强不可逆）最后。

**通用构造 + 看结果（SW console，先粘一次）**：
```js
// 构造 cursor 直指目标步的 workflow，advance 单跑该 adapter。改 cursor + productPatch 切换目标。
async function verifyStep(cursor, productPatch = {}) {
  const wfId = 'wf_verify_' + cursor + '_' + Date.now();
  await orchQueue.enqueue(sk => {
    const wf = ORCH.steps.buildInitialWorkflow({ label: '验证-step' + cursor }, () => wfId);
    wf.status = 'running'; wf.cursor = cursor; wf.steps[cursor].status = 'pending';
    Object.assign(wf.product, productPatch);
    if (!sk.batch.id) { sk.batch.id = 'batch_verify'; sk.batch.createdAt = Date.now(); }
    sk.batch.workflows.push(wf); sk.batch.activeWorkflowId = wfId;
    return sk;
  });
  await orchEngine.advance(wfId);     // 单跑该 adapter（fire-forget 步会异步轮询，看 dump 等终态）
  return wfId;
}
const dump = async () => (await chrome.storage.local.get('as_workflow_state'))
  .as_workflow_state.batch.workflows.slice(-1)[0];        // 反复跑看当前 step 状态
const clean = async () => chrome.storage.local.remove(['as_workflow_state']);
```

### L2.1 pack_label（cursor=11，✓ 可逆，先验）
```js
await verifyStep(11);
// 等 10-30s 后反复：(await dump()).steps[11]
```
预期：新开 shipping-list tab（前台）→ 等 `[class*="shipping-list_choose"]` → 发 `PL_START_BATCH` → content 自驱批量打印 → 轮询 `pl_state` → `steps[11].status='done'`，`result.savedCount`/`saveDir`。
无可打包商品 → `started:false` → `validate` 错误「无可打包的待打包商品」（预期，非故障）。可逆，安全复验。

### L2.2 gen_label（cursor=6，⚠ 真写合规 + 插标签主图到 Temu 商品）
前置：① 先在 auto_gen_label feature view 里设过模板/输出路径（localStorage 持久，否则 ack `NO_PATHS`）；② `skc` 填条码管理页真实存在的 SKC。
```js
await verifyStep(6, { skc: '替换为真实SKC' });
// (await dump()).steps[6]  —— committing 中途应 true，终态清回 false
```
预期：新开 `seller.temu.com/goods/label` → 等表格行 → 发 `AGL_GEN_LABEL{skc}` → content 跨 4 页自驱（查 SPU→生成→合规→标签图）→ committing 阶段一次性标记 → 轮询 `agl_state` → done。
失败 ack 映射：`NO_PATHS`/`NO_SKC`/`ROW_NOT_FOUND`/`NO_SKC_SKU`（均 `validate`）。⚠ 用测试商品（写合规 + 插主图不可逆）。

### L2.3 publish（cursor=2，⚠ 真发布到 Temu）
前置：先手动打开店小秘**商品编辑页**（url 含 `dianxiaomi` + `edit`），保持打开 —— adapter 不导航，靠 `chrome.tabs.query` 找这个 tab。
```js
await verifyStep(2);
// (await dump()).steps[2]
```
预期：query `*://*.dianxiaomi.com/*` 找 url 含 `edit` 的 tab → 激活 → 标 committing → 发 `CAP_PUBLISH`（检查+发布同 tab）→ 透传 `{status,result,error}`。
无编辑页 tab → `read` 错误「未找到店小秘编辑页 tab」（预期）。⚠ 真发布。注意：填表自动化是已知缺口（见末尾），检查 block 也会转人工。

### L2.4 create_sku（cursor=7，△ 半可逆）
前置：product 需 `url1688` + `skc` + `skuNo` + `spuId`（CPO 内部校验）。
```js
await verifyStep(7, { url1688: '替换1688链接', skc: '替换SKC', skuNo: '替换货号', spuId: '替换SPU' });
```
预期：`cpoRun` 自管 tab → 读 `cpo_state.phase1` → done 回 `skuNo`。缺 `url1688` → `validate`「缺 1688 链接」。半可逆（重跑由 feature 幂等校验）。清理另需 `chrome.storage.local.remove('cpo_state')`。

### L2.5 create_po（cursor=8，⚠⚠ 强不可逆，真下采购单）
前置：product 需 `orderNo1688`。**留到最后验、用测试订单。**
```js
await verifyStep(8, { orderNo1688: '替换1688订单号' });
```
预期：标 committing → `cpoRun2({autoSave:true})` 全自动 → 读 `cpo_state.phase2` → done 回 `poNo`。缺 `orderNo1688` → `validate`。⚠⚠ 真下采购单。

### L2.6 ship（cursor=12，⚠⚠ 强不可逆，真发货）
前置：shipping-list 有真实待发货订单。**留到最后验。**
```js
await verifyStep(12);
// (await dump()).steps[12]  —— 单单 30-60s
```
预期：新开 shipping-list → 等 `[data-testid="beast-core-table-body-tr"]` → 标 committing → 发 `AUTO_SHIP_RUN_ONE`（180s 超时）→ 透传 `{status,result,error}`。无订单 → 业务错误。⚠⚠ 真发货。

---

## L3 — 完整 13 步端到端（全副作用，最后跑）

**从头起跑**（SW console）：
```js
await orchStartWorkflow({ label: '端到端测试品' });
// 或业务页 console：chrome.runtime.sendMessage({ type:'WF_START', data:{ label:'端到端测试品' } })
```
逐 HITL 在浮层点「确认完成」推进；AUTO 步自动真跑。

**⚠ 首版真实边界（重要，非 bug）**：HITL 步 `editable=false` → 不回填 `product` → 下游 AUTO 缺数据会卡：
- `gen_label`(cursor 6) 缺 `product.skc` → ack `NO_SKC`
- `create_sku`(7) 缺 `url1688`/`skuNo`/`spuId`
- `create_po`(8) 缺 `orderNo1688`

要让端到端穿过这些步，在到达对应 AUTO 步**之前**手动注入 product：
```js
async function patchProduct(patch) {
  const sk = (await chrome.storage.local.get('as_workflow_state')).as_workflow_state;
  const wf = sk.batch.workflows.find(w => w.id === sk.batch.activeWorkflowId);
  Object.assign(wf.product, patch);
  await chrome.storage.local.set({ as_workflow_state: sk });
}
// 例（确认到 gen_label 前补齐全部下游字段）：
await patchProduct({ skc:'<SKC>', url1688:'<链接>', skuNo:'<货号>', spuId:'<SPU>', orderNo1688:'<订单号>' });
```

**预期**（测试商品 + 注入字段）：骨架从 cursor 0 推进到 12，HITL 步弹浮层等确认，AUTO 步真跑，**全程不可逆操作真实发生** —— 务必用测试商品/订单。
**判定**：不强求首版无注入跑通（HITL 回填 = Plan 3）；验「骨架推进无死循环 + HITL↔AUTO 衔接正确 + storage 单一状态源全程一致」即可。

---

## L4 — WS（dashboard ws-source）

**打开 dashboard**：业务页 Panel → Hub → 「打开监控」按钮（dev-only，`isDev` 守卫；release 不注入）→ 独立窗口开 `dashboard.html`。

**默认态（无大脑 server）—— 验降级**：
- 顶栏 WS 灯 = **offline**。
- 大脑流区每 ~1.2s 追加一条 mock 事件，回放完推一条 mock HITL 详情。
- 含义：ws-source `connect()` 连 `ws://localhost:8787` 失败 → `fallback()` → 灯 offline + mock 回放 + 每 5s 重连。架子阶段正常表现。

**可选 —— 验灯变 live**（需 node + `npm i ws`）：
```bash
node -e "const{WebSocketServer}=require('ws');new WebSocketServer({port:8787}).on('connection',s=>{console.log('dash connected');s.on('message',m=>console.log('recv',m.toString()))});console.log('ws://localhost:8787 up')"
```
预期：dashboard 灯变 **live**，mock 回放停；server 终端打印收到 `{"type":"HELLO","data":{"role":"dash",...}}`。Ctrl-C 关 server → dashboard `onclose` → 重回 offline + mock。
架子 server 不回 `BRAIN_EVENT`，故只验「连上→灯 live」，真实大脑流留 Plan 3。

**bg ws-client 本次不验**：`startWsClient` 不自启（沉睡 dead code），bg 侧不连 WS。bg↔大脑真实连接 + RUN_STEP 调度 = Plan 3。本次仅验 dashboard ws-source 降级/连接灯。

---

## 验证通过判定

- **可发版门槛**：L0 全过 + L1 浮层链路 OK + L2 六个 adapter 各自隔离 done（不可逆步用测试数据真跑成功）+ L4 dashboard 降级灯正确。
- L3 完整端到端**不作硬门槛**（HITL 回填是 Plan 3 缺口）：验到「骨架推进 + HITL↔AUTO 衔接 + 单一状态源」即可。
- ⚠ 任一不可逆步（publish/gen_label/create_po/ship）隔离验证翻车 → **不发版**，按错误 `category`（read/validate/business）回 debug，对照 debugging-rules 四阶段。

## 已知缺口（验证中会撞到，非 bug）

1. **无 UI 启动入口**：浮层是纯消费端无「开始」按钮 → 只能 SW console `orchStartWorkflow` 或业务页 `WF_START`。整条流水线缺正经触发入口。
2. **HITL 无回填**：`buildHitl` 的 `editable` 恒 false → 不回填 skc/url1688/orderNo1688 → 下游 AUTO 缺数据（L3 需手动注入）。
3. **publish 填表未自动化**：`CAP_PUBLISH` 做检查+发布，填表本需人工（probe-fillform 待补 DOM dump + 业务规则）。
4. **bg ws-client 沉睡**：Plan 3 才真连大脑 + RUN_STEP 调度。

> 缺口 1/2/3 属 Plan 2 功能边界 / Plan 3 范畴，已记于 memory `project_full_automation_plan.md` 的 4 层待办。
