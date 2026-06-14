// automation/bg-entry.js — automation 的 SW 侧入口（确定性编排器 + 监控窗口）。
// 由 build 的 assemble_automation 拷到 dist/background/automation-bg-entry.js，并由
// assemble_feature_backgrounds 在 dist SW 末尾追加 importScripts('automation-bg-entry.js')。
// 运行时与 service-worker.js 同一 global scope（同被 SW importScripts），故：
//   ① 依赖 SW 已提供的 self.AgentSellerBg.registerHandler（bg-router.js 接线）注册 WF_/OPEN_MONITOR；
//   ② orchNavigateAndWait 内部直调 CPO 段的 cpoWaitTabComplete（仍在 SW 全局），同 scope 可达。
// importScripts 路径按 dist 运行时算（automation-bg-entry.js 落 dist/background/，与 SW 同级），
// 与原 SW 中这两组 importScripts 完全一致。

// ── orchestrator ── 确定性编排器 bg 接线（Plan 2-2a）─────────────────────────
// Plan 2-1 纯逻辑核心（steps/state-machine/recovery/mutation-queue/engine）接真实 chrome。
// 发版（D2）：importScripts 纯定义无副作用；唯一触发源是浮层「开始」(2-2c,isDev 守卫,release 不注入)，
// 故 release 无人发 WF_START；恢复对空 storage noop → orchestrator 在 release 沉睡无副作用。
importScripts(
  '../contract.js',
  'orchestrator/steps.js',
  'orchestrator/state-machine.js',
  'orchestrator/recovery.js',
  'orchestrator/mutation-queue.js',
  'orchestrator/engine.js',
);

// WS 通道（Plan 3）：加载 WsClient 类（挂 self.__AS_WS__）。importScripts 纯定义无副作用。
importScripts('ws-client.js');

// bg ws-client 按需连（Plan 3 收尾·发版隔离 D）：不在 SW 顶层自启，改由首个 WF_* 消息触发
// orchEnsureWs（幂等）。触发源 = 浮层「开始」(isDev 守卫,release 不注入) → release 无 WF_* →
// 永不连 → ws 沉睡（与 orchestrator「无人发 WF_START 即沉睡」同一隔离机制，无需 package_all 剥离）。
// ⚠ 绝不在 SW 顶层 / orchRecoverAll 调 orchEnsureWs——那会让 release 也连，破坏隔离。
let orchWsClient = null;
function orchEnsureWs() {
  if (orchWsClient) return;   // 幂等：已连（或重连中）则跳过
  orchWsClient = self.__AS_WS__.startWsClient({
    onStatus: s => console.log('[orch-ws]', s),
    handlers: {
      // 大脑诊断决策落地（spec §5/§6）：仍由 bg 写 storage；applyDiagnosis 含红线兜底。
      // orchEngine 在下方定义——运行时回调（收到消息才执行），届时已初始化，闭包延迟引用安全。
      STATE_PATCH: (data) => {
        orchEngine.applyDiagnosis(data.workflowId, data)
          .catch(e => console.warn('[orch-ws] applyDiagnosis 失败', e));
      },
    },
  });
}

const ORCH = {
  contract: self.__AS_DASH_CONTRACT__,
  steps: self.__AS_ORCH_STEPS__,
  mq: self.__AS_ORCH_MQ__,
  engine: self.__AS_ORCH_ENGINE__,
};

// storage 读写适配：read 经 normalizeSkeleton 兜底（缺失/损坏→emptyBatch）；write 整 skeleton
function orchRead() {
  const { STORAGE_KEY, normalizeSkeleton } = ORCH.contract;
  return chrome.storage.local.get(STORAGE_KEY).then(r => normalizeSkeleton(r[STORAGE_KEY]));
}
function orchWrite(skeleton) {
  return chrome.storage.local.set({ [ORCH.contract.STORAGE_KEY]: skeleton });
}

const orchQueue = ORCH.mq.makeMutationQueue(orchRead, orchWrite);

// stub stepRunner（2-2a）：模拟 auto 步成功，让骨架端到端可验证。
// 2-2b 换真实：导航 tab → waitForEl(step.target.readySignal) → 调 feature 命令 → 收结构化回报。
async function orchStubStepRunner(step) {
  await new Promise(r => setTimeout(r, 300));   // 模拟耗时
  console.log(`[orch-stub] 自动步「${step.label}」(feature=${step.feature}) 模拟完成`);
  return { status: 'done', result: { stub: step.id, feature: step.feature }, error: null };
}

// ── 通用 adapter 基建（无命令处理器 feature 接入；后续 ship/gen_label 复用）──────────────
// CPO 自管 tab、adapter 直接 await；其余 feature 无处理器,adapter 要主动:
// 导航 tab(orchNavigateAndWait)→ 发命令(orchSendStepCommand)→ 长任务轮询 storage 终态(orchPollState)。

// 导航到 url(前台 active 防失焦不渲染)→ 等 tab complete → executeScript 轮询 readySignal → 返回 tabId
// ⚠ readySignal 检查依赖 manifest host_permissions 含目标域(scripting 权限 CPO cpoCloseTab 已在用);
//   executeScript 失败(权限/页面未就绪)→ false 继续轮询,超时才抛——content handler 首行 waitForEl 再兜一层。
async function orchNavigateAndWait(url, readySignal, { tabTimeoutMs = 30000, readyTimeoutMs = 30000 } = {}) {
  const tab = await chrome.tabs.create({ url, active: true });
  await cpoWaitTabComplete(tab.id, tabTimeoutMs);
  if (!readySignal) return tab.id;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    const hit = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: sel => !!document.querySelector(sel), args: [readySignal],
    }).then(arr => !!(arr && arr[0] && arr[0].result)).catch(() => false);
    if (hit) return tab.id;
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

// ── CPO adapter（create_sku / create_po）─────────────────────────────────────
// CPO 自管 tab（cpoRun/cpoRun2 内部 chrome.tabs.create）：adapter 不导航/不 waitForEl，
// 直接 await（两者 async、await 到终态才返回、done/error 都写 cpo_state.phaseN 正常返回不 throw），
// 再读 cpo_state 桥接回 engine 的 {status,result,error}。cpo_state(CPO 私有)与 as_workflow_state(编排器)并存。

// 标记/清除当前 cursor step 的 committing（不可逆提交点保护，spec §4.2/§7；走 orchQueue 串行化）
function orchMarkCommitting(workflowId, value) {
  return orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf) return undefined;
    wf.steps[wf.cursor].committing = value;
    return skeleton;
  });
}

// create_sku（Phase1，△半可逆）：product → CPO_START 入参（cpoRun 内部校验 serial/skuNo/spuId）→ 读 phase1
async function orchAdapterCreateSku(step, wf) {
  const { url1688, skc, skuNo, spuId } = (wf && wf.product) || {};
  if (!url1688) return { status: 'error', error: { category: 'validate', code: 'MISSING_URL1688', message: '缺 1688 链接（比价/下单步未回填 url1688）', recoverable: false } };
  await cpoRun({ url1688, skc, skuNo, spuId });
  const { cpo_state } = await chrome.storage.local.get('cpo_state');
  const p1 = (cpo_state && cpo_state.phase1) || {};
  if (p1.status === 'done') return { status: 'done', result: { skuNo: (p1.collected && p1.collected.skuNo) || skuNo || null }, error: null };
  return { status: 'error', error: { category: 'business', code: 'CPO_P1_FAILED', message: p1.label || '建店小秘 SKU 失败', recoverable: false } };
}

// create_po（Phase2，✗强不可逆）：committing 包裹 → product.orderNo1688 → CPO_START_PHASE2(autoSave 全自动) → 读 phase2
async function orchAdapterCreatePo(step, wf) {
  const orderNo1688 = (wf && wf.product && wf.product.orderNo1688) || '';
  if (!orderNo1688) return { status: 'error', error: { category: 'validate', code: 'MISSING_ORDER_NO', message: '缺 1688 订单号（下单步未回填 orderNo1688）', recoverable: false } };
  await orchMarkCommitting(wf.id, true);   // 不可逆提交点前标记；正常路径 engine 收尾清 committing，回收路径留 true→恢复转人工
  await cpoRun2({ orderNo1688, autoSave: true, repurchase: false, warehouse: 'default' }, null);
  const { cpo_state } = await chrome.storage.local.get('cpo_state');
  const p2 = (cpo_state && cpo_state.phase2) || {};
  if (p2.status === 'done') return { status: 'done', result: { poNo: (p2.collected2 && p2.collected2.poNo) || null }, error: null };
  return { status: 'error', error: { category: 'business', code: 'CPO_P2_FAILED', message: p2.label || '创建采购单失败', recoverable: false } };
}

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

// ── auto_gen_label adapter（gen_label,✗强不可逆·跨页自驱）─────────────────────
// content 跨 4 页自驱、SW 无法 await：fire-forget+轮询 agl_state（同 pack_label）。
// committing 用 onTick 在 content 报告"合规提交"阶段标（比 ship 发命令前粗标精准）。
async function orchAdapterGenLabel(step, wf) {
  const target = step.target || {};
  const url = target.url || 'https://seller.temu.com/goods/label';
  // 1. 清旧 agl_state(防读到上次残留终态)
  await chrome.storage.local.remove('agl_state');
  // 2. 导航条码页 + 等表格行就绪(前台 active 防失焦不渲染)
  let tabId;
  try {
    tabId = await orchNavigateAndWait(url, target.readySignal, { readyTimeoutMs: 30000 });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'AGL_NAV_FAILED', message: '条码管理页打不开或未就绪:' + String(e?.message || e), recoverable: true } };
  }
  // 3. 发命令(fire-forget:content 立即 ack started,后台跑 Phase1+跨页自驱)
  let ack;
  try {
    ack = await orchSendStepCommand(tabId, 'AGL_GEN_LABEL', { skc: (wf && wf.product && wf.product.skc) || null });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'AGL_CMD_FAILED', message: '标签生成命令未送达:' + String(e?.message || e), recoverable: true } };
  }
  if (ack && ack.started === false) {
    const reasonMap = {
      NO_PATHS: '模板/输出路径未配置(请先在 feature view 设置一次,localStorage 持久)',
      NO_SKC: '缺 SKC(product.skc 为空,上游 HITL 未回填)',
      ROW_NOT_FOUND: '条码管理页未找到该 SKC 对应商品行',
      NO_SKC_SKU: '该商品无 SKC货号,无法生成标签',
    };
    return { status: 'error', error: { category: 'validate', code: 'AGL_NOT_STARTED', message: reasonMap[ack.reason] || ('未启动:' + ack.reason), recoverable: true } };
  }
  // 4. 轮询 agl_state 终态;onTick 在 content 报 committing 阶段时一次性标记
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

// ── check_and_publish adapter（publish,✗不可逆·复用上游编辑页 tab）──────────────
// 数据流死结:wf.product 无店小秘商品 URL 锚点 → 不导航,query 找 collect_dxm 留的编辑页 tab。
// 直接回报(检查+发布同 tab,无跨页);committing 发命令前粗标(检查 block 也转人工=填表缺口本需人工)。
async function orchAdapterPublish(step, wf) {
  // 1. 找上游编辑页 tab(url 含 dianxiaomi + edit;不导航,无 URL 锚点)
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: '*://*.dianxiaomi.com/*' });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'PUBLISH_TAB_QUERY_FAILED', message: 'tab 查询失败:' + String(e?.message || e), recoverable: true } };
  }
  const editTab = (tabs || []).find(t => /edit/i.test(t.url || ''));
  if (!editTab) {
    return { status: 'error', error: { category: 'read', code: 'PUBLISH_NO_EDIT_TAB', message: '未找到店小秘编辑页 tab(collect_dxm 后请保持编辑页打开)', recoverable: true } };
  }
  // 2. 激活编辑页 tab(前台防 Ant dropdown 后台 tab 不展开)
  try {
    await chrome.tabs.update(editTab.id, { active: true });
    await new Promise(res => setTimeout(res, 500));
  } catch (e) {
    console.warn('[orch][publish] 激活编辑页 tab 失败,继续尝试', e);
  }
  // 3. ★不可逆提交点:发命令前标 committing(粗粒度;检查 block 也标→恢复转人工=填表本需人工,无副作用)
  await orchMarkCommitting(wf.id, true);
  // 4. 发命令,直接回报(检查+发布同 tab,无跨页/无 storage)
  let resp;
  try {
    resp = await orchSendStepCommand(editTab.id, 'CAP_PUBLISH', {}, { timeoutMs: 60000 });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'PUBLISH_CMD_FAILED', message: '发布命令未送达:' + String(e?.message || e), recoverable: false } };
  }
  return resp || { status: 'error', error: { category: 'read', code: 'PUBLISH_NO_RESP', message: '发布命令无响应', recoverable: false } };
}

// adapter 注册表：按 step.id 分发（cpo 一 feature 两步，必须 id 粒度）。未接入 AUTO 步 → stub fallback。
const ORCH_ADAPTERS = {
  create_sku: orchAdapterCreateSku,
  create_po: orchAdapterCreatePo,
  pack_label: orchAdapterPackLabel,
  ship: orchAdapterShip,
  gen_label: orchAdapterGenLabel,
  publish: orchAdapterPublish,
};

// 真实 stepRunner：dispatch 到 adapter；未接入 step.id 回落 stub（13 步骨架仍端到端可跑）。
// STEP_RESULT 上报移到 engine onStepSettled（覆盖 throw + 带 retryCount，Plan 3 第二刀）。
async function orchRealStepRunner(step, wf) {
  const adapter = ORCH_ADAPTERS[step.id];
  return adapter ? adapter(step, wf) : orchStubStepRunner(step);
}

const orchEngine = ORCH.engine.makeEngine({
  read: orchRead, queue: orchQueue, stepRunner: orchRealStepRunner, now: () => Date.now(),
  // Plan 3 第二刀：每步落地后上报 STEP_RESULT（带 retryCount，含 throw 包装的 error）。fire-forget。
  onStepSettled: (workflowId, step, res) => {
    try {
      if (orchWsClient) orchWsClient.send('STEP_RESULT', {
        workflowId, stepId: step.id,
        status: (res && res.status) || null,
        error: (res && res.error) || null,
        retryCount: step.retryCount || 0,
      });
    } catch (e) { console.debug('[orch-ws] STEP_RESULT 发送忽略', e); }
  },
});

// SW 唤醒恢复：每次 SW 实例化（冷启 / 回收唤醒 / 浏览器启动）即跑。
// 不挂 onStartup——recover 不幂等（rerun 有副作用），靠顶层单次调用覆盖所有实例化场景。
async function orchRecoverAll() {
  try {
    const skeleton = await orchRead();
    const wf = (skeleton.batch.workflows || []).find(w => w.status === 'running');
    if (!wf) return;   // 无 running workflow（release 常态）→ noop
    console.log('[orch] SW 实例化，尝试恢复 workflow', wf.id);
    await orchEngine.recover(wf.id);
  } catch (e) { console.warn('[orch] 恢复失败（不影响其他业务）', e); }
}
orchRecoverAll();

// 编排器消息入口：WF_START（建+跑）/ WF_HITL_CONFIRM（确认推进）/ WF_HITL_REJECT / WF_ABORT
let orchWfSeq = 0;
function orchGenId() { return 'wf_' + Date.now() + '_' + (++orchWfSeq); }

async function orchStartWorkflow(product) {
  const wf = ORCH.steps.buildInitialWorkflow(product, orchGenId);
  wf.status = 'running'; wf.startedAt = Date.now();
  await orchQueue.enqueue(skeleton => {
    if (!skeleton.batch.id) { skeleton.batch.id = 'batch_' + Date.now(); skeleton.batch.createdAt = Date.now(); }
    skeleton.batch.workflows.push(wf);
    skeleton.batch.activeWorkflowId = wf.id;
    return skeleton;
  });
  orchEngine.advance(wf.id).catch(e => console.warn('[orch] advance 异常', e));   // 异步推进，不阻塞 ack
  return wf.id;
}

async function orchHitlConfirm({ workflowId, result }) {
  await orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf || wf.status !== 'paused') return undefined;
    const s = wf.steps[wf.cursor];
    s.status = 'done';
    if (result) { s.result = result; Object.assign(wf.product, ORCH.engine.pickProduct(result)); }
    if (wf.hitl) wf.hitl.status = 'confirmed';
    wf.status = 'running'; wf.updatedAt = Date.now();
    return skeleton;
  });
  orchEngine.advance(workflowId).catch(e => console.warn('[orch] advance 异常', e));   // HITL step 已 done → advance 推进 cursor 到下一步
}

async function orchSetAborted(workflowId, hitlStatus) {
  await orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf) return undefined;
    wf.status = 'aborted';
    if (hitlStatus && wf.hitl) wf.hitl.status = hitlStatus;
    wf.updatedAt = Date.now();
    return skeleton;
  });
}

// 重试：重置当前 cursor step→pending（清 error/committing）+ wf→running + advance（spec §6.2）。
// 仅 recoverable 错误在 overlay 有[重试]入口（error chip 守卫），故清 committing 安全：
// 不可逆步骤失败均 recoverable:false → 无重试入口，不会被本函数重发。
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

// WF_* 命令入口：经 bg-router 的 registerHandler 注册（前缀匹配 'WF_'）。
// 原 SW 的 chrome.runtime.onMessage.addListener((msg)=>{...WF_...}) 整体包进回调；
// 行为不变：任何 WF_* 先 orchEnsureWs（按需连），再据 msg.type 分发；每分支 return true 异步回应。
self.AgentSellerBg.registerHandler('WF_', (msg, _sender, sendResponse) => {
  // 任何 WF_* 操作前确保 ws 已连（按需连·发版隔离 D：release 无 WF_* → 不连 → 沉睡）。
  if (msg && typeof msg.type === 'string' && msg.type.startsWith('WF_')) orchEnsureWs();
  if (msg.type === 'WF_START') {
    orchStartWorkflow(msg.data || {})
      .then(id => sendResponse({ ok: true, workflowId: id }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'WF_HITL_CONFIRM') {
    orchHitlConfirm(msg.data || {})
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'WF_HITL_REJECT') {
    orchSetAborted((msg.data || {}).workflowId, 'rejected')
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'WF_ABORT') {
    orchSetAborted((msg.data || {}).workflowId, null)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'WF_RETRY') {
    orchRetry((msg.data || {}).workflowId)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});
// ── end orchestrator ─────────────────────────────────────────────────────────

// ── OPEN_MONITOR ── 独立窗口打开监控 dashboard（搬自 SW；经 registerHandler 注册）──────
// 已开则聚焦，未开则新建独立窗口（popup 型，可置顶盯盘）。失败兜底退化为 tab。
self.AgentSellerBg.registerHandler('OPEN_MONITOR', (msg, sender, sendResponse) => {
  const url = chrome.runtime.getURL('dashboard/dashboard.html');
  (async () => {
    try {
      const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup', 'normal'] });
      for (const w of wins) {
        const hit = (w.tabs || []).find(t => t.url === url);
        if (hit) { await chrome.windows.update(w.id, { focused: true }); sendResponse({ success: true, focused: true }); return; }
      }
      await chrome.windows.create({ url, type: 'popup', width: 1280, height: 860 });
      sendResponse({ success: true, created: true });
    } catch (e) {
      try { await chrome.tabs.create({ url }); sendResponse({ success: true, fallbackTab: true }); }
      catch (e2) { sendResponse({ success: false, error: String(e2?.message || e2) }); }
    }
  })();
  return true;
});
