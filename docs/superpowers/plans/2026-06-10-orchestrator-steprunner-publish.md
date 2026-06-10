# publish 续刀（check_and_publish 接入编排器）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把编排器 `publish` 步的 stub fallback 换成真实 adapter，接 `check_and_publish` 的「合规检查 + 立即发布」能力（**填表自动化留独立后续**，本刀不做）。这是 2-2b 续刀的最后一刀。

**Architecture:** `check_and_publish` 无跨页（检查 + 发布都在同一店小秘编辑页 tab），故 **直接回报**（同 ship，无 storage 桥接/轮询）。**数据流死结**：编辑页 URL 含店小秘商品 id，但 `wf.product` 没有这个锚点 → adapter **不导航**，用 `chrome.tabs.query` 找上游 `collect_dxm`（HITL 采集建品）留下的编辑页 tab（url 含 `dianxiaomi` + `edit`），激活后发命令 → **steps.js 零改动（publish 无 target）**。**填表缺口优雅降级**：检查发现必填空字段 → block → adapter 报 `validate` 错误 → 转人工填表/修正后重试（本刀不自动填表）。

**Tech Stack:** Chrome MV3（classic SW，`importScripts`）+ content script；`chrome.tabs.query`/`chrome.tabs.update`（复用编辑页 tab）；直接回报（无 storage）；复用 ship 验证过的 `orchSendStepCommand`/`orchMarkCommitting`。

---

## 关键决策

- **D1 直接回报（同 ship）**：检查 + 发布同一编辑页 tab、无跨页 reload，adapter `orchSendStepCommand` await content 返回 `{status,result,error}` 即可。不需 fire-forget/storage 轮询（区别于 pack_label/gen_label）。
- **D2 复用上游编辑页 tab（不导航）**：数据流死结的解法。`collect_dxm`（HITL，publish 前一步）人工在店小秘建品，编辑页天然打开。adapter `chrome.tabs.query('*://*.dianxiaomi.com/*')` → find url 含 `edit`。**steps.js publish 不加 target、零改动**（adapter 用 query 不读 target）。依赖：collect_dxm HITL 后用户保持编辑页打开（后续在 HITL 提示约束）。
- **D3 committing 发命令前粗标（同 ship）**：不可逆点 = clickPublishImmediate。adapter 发命令前标 committing。检查 block（可逆失败）也会被标，但 block 本就需人工修正（填表/改标题）→ 恢复转人工 = 合理，无副作用。
- **D4 填表缺口优雅降级**：本刀不做填表自动化（需 probe-fillform 的 8 DOM + 7 规则补料写 spec）。检查发现必填空 → `required_fields_empty` 规则 block → adapter 报 `validate`（含哪些字段）→ 转人工填后重试。填表自动化是独立后续 scope。
- **D5 错误分层**：非编辑页/找不到 tab/发布按钮缺 → `read`；检查 block（含必填空）→ `validate`；命令未送达 → `read`。对齐 debugging-rules 错误分层。
- **D6 激活编辑页 tab（active:true）**：Ant Design dropdown 在后台 tab 可能不展开（同前几刀失焦坑）。adapter 发命令前 `chrome.tabs.update(editTab.id, {active:true})` + 短等渲染。

## Task 1: check_and_publish content — capHandlePublish + onMessage

**Files:**
- Modify: `features/check_and_publish/content/index.js`（register 之前）

复用现有 `runChecks`/`bucketize`/`clickPublishImmediate`/`isEditPage`，**零改 DOM 逻辑**。直接回报（无 storage）。

- [ ] **Step 1: 插入命令处理器 + onMessage**

锚点：`onPublish` 结束（`renderInternal(viewEl);\n  }`）与 `// ─── 注册` 之间，插入：

```js
  // ═══════════════════════════════════════════════════════════════════════════
  // 编排器桥接（orch）：命令处理器 CAP_PUBLISH。检查+发布同 tab、直接回报（无跨页/无 storage）。
  // 填表缺口降级：检查 block→validate 错误（含哪些字段）→转人工。复用 runChecks/bucketize/clickPublishImmediate。
  // ═══════════════════════════════════════════════════════════════════════════
  async function capHandlePublish() {
    if (!isEditPage()) {
      return { status: 'error', error: { category: 'read', code: 'CAP_NOT_EDIT_PAGE', message: '当前 tab 非店小秘编辑页（URL 不含 edit）', recoverable: true } };
    }
    let buckets;
    try {
      const { results } = runChecks();
      buckets = bucketize(results);
    } catch (e) {
      return { status: 'error', error: { category: 'read', code: 'CAP_CHECK_THREW', message: '合规检查异常：' + ((e && e.message) || e), recoverable: true } };
    }
    if (buckets.blocks.length) {
      const names = buckets.blocks.map(b => b.rule.name).join('、');
      return { status: 'error', error: { category: 'validate', code: 'CAP_CHECK_BLOCKED', message: '合规检查未过（' + buckets.blocks.length + ' 阻断）：' + names + '。需人工修正/填表后重试', recoverable: true } };
    }
    try {
      await clickPublishImmediate();
    } catch (e) {
      return { status: 'error', error: { category: 'read', code: 'CAP_PUBLISH_FAILED', message: '立即发布失败：' + ((e && e.message) || e), recoverable: false } };
    }
    return { status: 'done', result: { published: true, warns: buckets.warns.map(w => w.rule.name), skipped: buckets.skippeds.length }, error: null };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'CAP_PUBLISH') return;
    capHandlePublish()
      .then(sendResponse)
      .catch((e) => sendResponse({ status: 'error', error: { category: 'read', code: 'CAP_HANDLER_THREW', message: String((e && e.message) || e), recoverable: false } }));
    return true;  // 异步 sendResponse
  });
```

- [ ] **Step 2: node --check + dev build**

Run: `node --check features/check_and_publish/content/index.js && python3 build/build_extension.py`
Expected: 语法 OK；build 成功（8 features）。

- [ ] **Step 3: commit**

```bash
git add features/check_and_publish/content/index.js
git commit -m "$(cat <<'EOF'
feat(check_and_publish): 加 CAP_PUBLISH 命令入口（publish 续刀）

Why: 编排器 publish 步需驱动 check_and_publish 检查+发布；content 此前无 onMessage。
What: 加命令处理器 capHandlePublish（isEditPage 守卫 / runChecks+bucketize / blocks→validate 含字段名 /
  全过→clickPublishImmediate→done）+ onMessage CAP_PUBLISH 直接回报。复用现有函数零改 DOM。
Test: node --check 语法 + dev build。chrome 端到端待验。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> 填表缺口降级：必填空 → `required_fields_empty` 规则 block → `CAP_CHECK_BLOCKED` validate 错误（含字段名）→ 转人工填后重试。本刀不自动填表。

---

## Task 2: service-worker.js — orchAdapterPublish + 注册

**Files:**
- Modify: `core/background/service-worker.js`（orchAdapterGenLabel 之后、ORCH_ADAPTERS 之前）

复用 ship 验证过的 `orchSendStepCommand`/`orchMarkCommitting`。**不导航**（query 复用上游编辑页 tab）。直接回报。

> 依赖：`chrome.tabs.query({url:'*://*.dianxiaomi.com/*'})` 读 tab.url 需 dianxiaomi host_permission——manifest 已含（check_and_publish feature.json 声明，build 聚合）。

- [ ] **Step 1: 插入 orchAdapterPublish**

锚点：`orchAdapterGenLabel` 结束 `}`（`...AGL_FAILED...recoverable: true } };\n}`）与 `// adapter 注册表` 之间，插入：

```js
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
```

- [ ] **Step 2: ORCH_ADAPTERS 注册（6 个 AUTO 步全接入）**

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
改为：
```js
const ORCH_ADAPTERS = {
  create_sku: orchAdapterCreateSku,
  create_po: orchAdapterCreatePo,
  pack_label: orchAdapterPackLabel,
  ship: orchAdapterShip,
  gen_label: orchAdapterGenLabel,
  publish: orchAdapterPublish,
};
```

- [ ] **Step 3: node --check + dev build + 回归**

Run: `node --check core/background/service-worker.js && python3 build/build_extension.py && node --test tests/*.test.js`
Expected: 语法 OK；build 成功；JS 60 绿。

- [ ] **Step 4: commit**

```bash
git add core/background/service-worker.js
git commit -m "$(cat <<'EOF'
feat(orchestrator): orchAdapterPublish 接 check_and_publish（publish 续刀收尾，6 AUTO 步全接入）

Why: publish 步此前回落 stub；接真实 adapter，2-2b 续刀闭环。
What: orchAdapterPublish（chrome.tabs.query 复用上游编辑页 tab→激活→committing→CAP_PUBLISH 直接回报，
  数据流死结靠 query dianxiaomi+edit 不导航）；ORCH_ADAPTERS 注册 publish。6 个 AUTO 步全部接入真 adapter。
Test: node --test tests/*.test.js（60 绿）+ node --check 语法 + dev build。chrome 端到端待验。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 全量回归 + chrome 验证准备

**Files:** 无（验证 + 文档）

- [ ] **Step 1: 全量自动验证**

```bash
node --test tests/*.test.js     # JS 60 绿（publish 续刀无新单测——纯接线，靠 chrome 验证）
python3 -m pytest tests/ -q      # Python 20 绿
python3 build/build_extension.py # dev build（8 features）
git status                        # 工作树干净
```

- [ ] **Step 2: chrome L1（content 直测，⚠ 真跑）**

前置：店小秘商品编辑页（url 含 `edit`）已打开。SW console：
```js
const [t] = await chrome.tabs.query({ url: '*://*.dianxiaomi.com/*' });
const resp = await chrome.tabs.sendMessage(t.id, { type: 'CAP_PUBLISH' });
console.log(resp);
// 有必填空/违禁词 → {status:'error', error:{category:'validate', code:'CAP_CHECK_BLOCKED', message:含字段名}}
// 全过 → 真点「立即发布」→ {status:'done', result:{published:true, warns:[...]}}
```
负路径：在非编辑页 tab 发命令 → `{status:'error', code:'CAP_NOT_EDIT_PAGE'}`（安全，不发布）。

- [ ] **Step 3: chrome L2（adapter 端到端，🔴 不可逆真发布）**

前置：collect_dxm 已在店小秘建品、编辑页 tab 保持打开。手搭 cursor=2 publish，SW console：
```js
const id = 'wf_pub_test';
const wf = ORCH.steps.buildInitialWorkflow({ label: 'publish测试' }, () => id);
wf.status = 'running'; wf.cursor = 2;
for (let i = 0; i < 2; i++) wf.steps[i].status = 'done';
await chrome.storage.local.set({ as_workflow_state: { schemaVersion: 1, workflows: [wf], updatedAt: Date.now() } });
await orchEngine.advance(id);   // 触发 publish adapter（按实际 contract 调整 batch 结构）
// 观察 as_workflow_state.workflows[0]：publish committing(steps[2].committing=true)→done，cursor→3
```
安全子验证（不真发布）：编辑页 tab **关闭** 时 advance → adapter 报 `PUBLISH_NO_EDIT_TAB`（验 query 逻辑、不发布）。
⚠ **publish 真跑 = 真点「立即发布」**（商品发布到 Temu 进审核，不可逆）。**必须用测试商品 + 明确授权**（同 ship/gen_label L4 强度）。

- [ ] **Step 4: 更新 memory + 标 task 完成**

`project_full_automation_plan.md` 加 publish 续刀 bullet（**2-2b 续刀闭环：6 AUTO 步全接入**，下一步 2-2c 浮层+WS + 填表自动化独立 scope）。TaskUpdate #37-39 completed。

---

## 自检清单

- **直接回报**（无 storage/无跨页，同 ship）✓
- **复用 tab 不导航**（steps.js 零改动，无 target）✓
- **committing 发命令前粗标**（检查 block 也转人工=填表本需人工，合理）✓
- **填表缺口降级**（block→validate 含字段名→转人工，本刀不自动填）✓
- **激活编辑页 tab**（防 Ant dropdown 后台不展开）✓
- **6 AUTO 步全接入**（create_sku/create_po/pack_label/ship/gen_label/publish）✓
- **isTrusted 风险**：clickPublishImmediate 现有手动流程本就程序化 fireMouseSeq（onPublish 调，非用户直点立即发布）且 work → 编排场景同样程序化，风险大概率不存在，chrome 验证确认。
