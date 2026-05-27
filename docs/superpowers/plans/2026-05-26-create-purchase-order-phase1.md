# 创建采购单 Feature — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `create_purchase_order` feature 的 Phase 1：从 temu 商品列表 + 编辑页 + 1688 商品页自动采集数据，在店小秘 add 页填好一个商品 SKU 并停在保存前等用户核对。

**Architecture:** background service worker 当编排者（`core/background/service-worker.js` 内新增 `CPO_` 标记段，沿用 img_search 先例），跨 tab 线性 `await` 序列：开 tab → 发命令 → 收数据 → 关 tab → 下一步。content script（`features/create_purchase_order/content/index.js`，跑在 temu/1688/店小秘 三域）只暴露命令处理器，自加 `chrome.runtime.onMessage` 监听。纯逻辑（serial 提取 / 识别码 / 字段映射）拆 `cpo-logic.js` 双模式模块，`node --test` 单测。

**Tech Stack:** Chrome MV3 content script + service worker；纯 JS（无构建框架）；`node:test` + `node:assert` 单测；`python build/build_extension.py` 构建到 `dist/extension/`。

**Spec:** `docs/superpowers/specs/2026-05-26-create-purchase-order-phase1-design.md`

---

## 消息协议（全任务共享，类型必须一致）

**content → bg**（裸 `chrome.runtime.sendMessage`，沿用 img_search）：

| type | data | bg 响应 |
|------|------|---------|
| `CPO_START` | `{url1688, skc, skuNo, spuId}` | `{ok:true}` 立即 ack（编排异步跑），或 `{ok:false, error}`。skc/skuNo/spuId 由 content 从用户**点选的商品行**读出（不再手输 SKC、不再 bg 端读货号）|

**bg → 起点 temu tab**（进度推送，`chrome.tabs.sendMessage(originTabId, …)`，content 侧只读不回）：

| type | payload |
|------|---------|
| `CPO_PROGRESS` | `{step, label}` —— 面板显示「步骤 step：label」 |
| `CPO_DONE` | `{}` —— 面板显示「已填好，请在店小秘页核对后保存」 |
| `CPO_ERROR` | `{step, message, kind}` —— `kind` ∈ `read`/`validate`，面板红字显示 |

**bg → 目标 tab 命令**（`chrome.tabs.sendMessage`，content 用 `sendResponse` 回传；handler 内 `return true` 保持异步通道）：

| type | data | 成功响应 | 失败响应 |
|------|------|----------|----------|
| `CPO_READ_1688_TITLE` | — | `{ok:true, title}` | `{ok:false, error}` |
| `CPO_GRAB_PREVIEW` | — | `{ok:true, previewUrl}` | `{ok:false, error}` |
| `CPO_FILL_DXM` | `{collected}` | `{ok:true, filled:true}` | `{ok:false, error}` |

> 执行期简化：原计划「开店小秘 index → CPO_DXM_OPEN_ADD 点击进入 add 页」已废弃。add 页 URL 参数固定（`openAddModal?type=0&editOrCopy=0`），bg 直接导航，省掉一个命令 + click-through。

**bg 内部状态** `collectedData = { skc, url1688, serial, title, skuNo, previewUrl }`，每步更新后镜像 `chrome.storage.local['cpo_state'] = { status, step, collectedData }`，`status` ∈ `idle|running|awaiting_save|error`。

**起点前置条件（执行期澄清）**：用户在 temu 列表页**先手动查询好该 SKC**（列表已显示结果），再开 Hub 输入点开始。故 `CPO_READ_SKU_NO` 只定位行 + 读货号，**不做查询动作**（省掉字段下拉/输入/查询按钮的脆弱自动化）。

**关键 URL 常量**（bg + content 共用，硬编码）：
- temu 列表：`https://agentseller.temu.com/goods/list`
- temu 编辑（识别）：URL 含 `/goods/edit`
- 店小秘商品管理首页：`https://www.dianxiaomi.com/web/dxmCommodityProduct/index`
- 店小秘 add 页（识别）：URL 含 `openAddModal`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `features/create_purchase_order/cpo-logic.js`（新） | 纯逻辑双模式模块：`extractSerial` / `buildIdCode` / `validateInputs` / `mapDxmFields`。挂 `window.__CPOLogic` + `module.exports` |
| `features/create_purchase_order/tests/cpo-logic.test.js`（新） | `node:test` 单测 |
| `features/create_purchase_order/content/index.js`（新） | 注册 feature + 输入 UI + 进度面板 + `chrome.runtime.onMessage` 命令路由（6 个 handler） |
| `features/create_purchase_order/feature.json`（新） | 元数据；三域 content_matches + `tabs`/`storage` 权限。**最后一步才创建**（多 agent 约束：content_script 跑得起来前不落 feature.json） |
| `features/create_purchase_order/CLAUDE.md`（新） | feature 文档 |
| `features/create_purchase_order/samples/*.txt`（新） | 各页面真实 DOM dump（实现期抓） |
| `core/background/service-worker.js`（改） | 末尾新增 `// ── create_purchase_order ──` 标记段：`CPO_START` 监听 + 编排序列 + tab 工具 |

> `cpo-logic.js` 通过 feature.json 的 `extra_content_scripts`（document_start）加载，早于 index.js，挂 `window.__CPOLogic` 供 index.js 用 —— 沿用 packing_label `naming.js` 模式。

---

## Task 1: 纯逻辑模块 cpo-logic.js（TDD）

**Files:**
- Create: `features/create_purchase_order/cpo-logic.js`
- Test: `features/create_purchase_order/tests/cpo-logic.test.js`

- [ ] **Step 1: 写失败测试**

`features/create_purchase_order/tests/cpo-logic.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { extractSerial, buildIdCode, validateInputs, mapDxmFields } = require('../cpo-logic.js');

test('extractSerial: 标准 1688 offer url', () => {
  assert.strictEqual(extractSerial('https://detail.1688.com/offer/653412345678.html'), '653412345678');
});
test('extractSerial: 带 query 参数', () => {
  assert.strictEqual(extractSerial('https://detail.1688.com/offer/653412345678.html?spm=a262eq.123'), '653412345678');
});
test('extractSerial: 无 offer id 返回 null', () => {
  assert.strictEqual(extractSerial('https://detail.1688.com/index.html'), null);
});
test('extractSerial: 空/非字符串返回 null', () => {
  assert.strictEqual(extractSerial(''), null);
  assert.strictEqual(extractSerial(null), null);
});

test('buildIdCode: serial-skuNo 拼接', () => {
  assert.strictEqual(buildIdCode('653412345678', 'ABC-001'), '653412345678-ABC-001');
});

test('validateInputs: 合法输入', () => {
  assert.deepStrictEqual(
    validateInputs({ skc: 'SKC123', url1688: 'https://detail.1688.com/offer/653412345678.html' }),
    { ok: true, serial: '653412345678' }
  );
});
test('validateInputs: skc 为空', () => {
  const r = validateInputs({ skc: '  ', url1688: 'https://detail.1688.com/offer/653412345678.html' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /SKC/);
});
test('validateInputs: url 无法提取 serial', () => {
  const r = validateInputs({ skc: 'SKC123', url1688: 'https://detail.1688.com/index.html' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /serial|url|1688/i);
});

test('mapDxmFields: 完整映射', () => {
  assert.deepStrictEqual(
    mapDxmFields({ skuNo: 'ABC-001', title: '夏季纯棉T恤', serial: '653412345678', url1688: 'https://detail.1688.com/offer/653412345678.html', previewUrl: 'https://img.example/p.jpg' }),
    {
      spuSku: 'ABC-001', enName: 'ABC-001', platformSku: 'ABC-001',
      cnName: '夏季纯棉T恤', idCode: '653412345678-ABC-001',
      sourceUrl: 'https://detail.1688.com/offer/653412345678.html',
      imageUrl: 'https://img.example/p.jpg',
    }
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test features/create_purchase_order/tests/cpo-logic.test.js`
Expected: FAIL（`Cannot find module '../cpo-logic.js'`）

- [ ] **Step 3: 写最小实现**

`features/create_purchase_order/cpo-logic.js`:
```js
// 纯逻辑：1688 serial 提取 + 识别码拼接 + 输入校验 + 店小秘字段映射。
// 双用途：浏览器挂 window.__CPOLogic；node 测试用 module.exports。
(function () {
  'use strict';

  // "https://detail.1688.com/offer/653412345678.html?..." → "653412345678"；无则 null
  function extractSerial(url1688) {
    const text = String(url1688 == null ? '' : url1688);
    const m = text.match(/\/offer\/(\d+)/);
    return m ? m[1] : null;
  }

  // 识别码 = serial-skuNo
  function buildIdCode(serial, skuNo) {
    return `${serial}-${skuNo}`;
  }

  // 校验 Hub 输入：skc 非空 + url1688 能提取 serial
  function validateInputs({ skc, url1688 } = {}) {
    if (!skc || !String(skc).trim()) {
      return { ok: false, error: 'SKC编码不能为空' };
    }
    const serial = extractSerial(url1688);
    if (!serial) {
      return { ok: false, error: '1688商品url 格式异常，无法提取 serial（应形如 detail.1688.com/offer/数字.html）' };
    }
    return { ok: true, serial };
  }

  // collectedData → 店小秘各字段值（user-name 在页面动态读，不在此）
  function mapDxmFields({ skuNo, title, serial, url1688, previewUrl } = {}) {
    return {
      spuSku: skuNo,
      enName: skuNo,
      platformSku: skuNo,
      cnName: title,
      idCode: buildIdCode(serial, skuNo),
      sourceUrl: url1688,
      imageUrl: previewUrl,
    };
  }

  const api = { extractSerial, buildIdCode, validateInputs, mapDxmFields };
  if (typeof window !== 'undefined') window.__CPOLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test features/create_purchase_order/tests/cpo-logic.test.js`
Expected: PASS（9 tests, 0 fail）

- [ ] **Step 5: 提交**

```bash
git add features/create_purchase_order/cpo-logic.js features/create_purchase_order/tests/cpo-logic.test.js
git commit -m "feat(create_purchase_order): 纯逻辑模块 serial/识别码/校验/字段映射

Why: Phase 1 取数前的纯逻辑可独立 TDD，先锁定不依赖 DOM 的部分
What: extractSerial/buildIdCode/validateInputs/mapDxmFields 双模式模块 + node 单测
Test: node --test (9 passed)"
```

---

## Task 2: feature scaffold —— index.js（注册 + 输入 UI + 命令路由骨架）+ feature.json

> 本任务让 feature 在三域加载、Hub 出图标、feature view 有输入表单、点「开始」发 `CPO_START`，并装好 `onMessage` 命令路由骨架（各 handler 先返回「未实现」，Task 4-7 逐个填实现）。命令处理器空实现也要先在，以便 Task 3 的 bg 编排能跑通调用链。

**Files:**
- Create: `features/create_purchase_order/content/index.js`
- Create: `features/create_purchase_order/feature.json`

- [ ] **Step 1: 写 content/index.js**

`features/create_purchase_order/content/index.js`:
```js
// create_purchase_order —— 创建采购单 Phase 1
// 跑在 temu/1688/店小秘 三域：注册 feature + 输入 UI + 进度面板 + bg 命令处理器。
(function () {
  'use strict';

  const L = window.__CPOLogic;                 // Task 1 的纯逻辑（document_start 已挂）
  const U = window.AgentSeller.utils;          // sleep/waitForEl/findByText/setInputValue
  const FID = 'create_purchase_order';

  // ── 进度面板状态（只在起点 temu tab 有意义，其它域不渲染进度） ──
  let progressEl = null;
  function setProgress(text, kind = 'info') {
    if (!progressEl) return;
    progressEl.textContent = text;
    progressEl.style.color = kind === 'error' ? '#ff4d4f' : kind === 'done' ? '#52c41a' : '#666';
  }

  // ── feature 注册 + Hub 输入 UI ──
  window.AgentSeller.registerFeature({
    id: FID,
    icon: '🛒',
    label: '创建采购单',
    locked: false,
    order: 5,
    init() {},
    render(viewEl) {
      viewEl.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

      const skcInput = document.createElement('input');
      skcInput.placeholder = 'SKC编码';
      skcInput.className = 'tal-input';
      skcInput.style.cssText = 'padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;';

      const urlInput = document.createElement('input');
      urlInput.placeholder = '1688商品url';
      urlInput.className = 'tal-input';
      urlInput.style.cssText = skcInput.style.cssText;

      const btn = document.createElement('button');
      btn.className = 'tal-action-btn';
      btn.textContent = '开始';

      progressEl = document.createElement('div');
      progressEl.style.cssText = 'font-size:12px;color:#666;line-height:1.5;min-height:18px;';

      btn.addEventListener('click', async () => {
        const skc = skcInput.value.trim();
        const url1688 = urlInput.value.trim();
        const v = L.validateInputs({ skc, url1688 });   // 本地先校验，避免无谓启动
        if (!v.ok) { setProgress(v.error, 'error'); return; }
        btn.disabled = true;
        setProgress('启动中…');
        try {
          const resp = await chrome.runtime.sendMessage({ type: 'CPO_START', data: { skc, url1688 } });
          if (!resp?.ok) { setProgress(resp?.error || '启动失败', 'error'); btn.disabled = false; }
        } catch (e) {
          setProgress('启动失败：' + e.message, 'error');
          btn.disabled = false;
        }
      });

      wrap.append(skcInput, urlInput, btn, progressEl);
      viewEl.appendChild(wrap);
    },
  });

  // ── bg → content 命令处理器（6 个，Task 4-7 填实现，这里先占位返回 not_implemented） ──
  const handlers = {
    CPO_READ_1688_TITLE: async () => ({ ok: false, error: 'not_implemented: CPO_READ_1688_TITLE' }),
    CPO_QUERY_SKC_GET_NO: async (_data) => ({ ok: false, error: 'not_implemented: CPO_QUERY_SKC_GET_NO' }),
    CPO_CLICK_EDIT: async (_data) => ({ ok: false, error: 'not_implemented: CPO_CLICK_EDIT' }),
    CPO_GRAB_PREVIEW: async () => ({ ok: false, error: 'not_implemented: CPO_GRAB_PREVIEW' }),
    CPO_DXM_OPEN_ADD: async () => ({ ok: false, error: 'not_implemented: CPO_DXM_OPEN_ADD' }),
    CPO_FILL_DXM: async (_data) => ({ ok: false, error: 'not_implemented: CPO_FILL_DXM' }),
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // 进度推送（起点 tab 接收，无需回 response）
    if (msg.type === 'CPO_PROGRESS') { setProgress(`步骤${msg.step}：${msg.label}`); return; }
    if (msg.type === 'CPO_DONE')     { setProgress('已填好，请在店小秘页核对后保存', 'done'); return; }
    if (msg.type === 'CPO_ERROR')    { setProgress(`步骤${msg.step}失败：${msg.message}`, 'error'); return; }

    const h = handlers[msg.type];
    if (!h) return;                                  // 非本 feature 命令，放行
    h(msg.data).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;                                     // 异步通道
  });
})();
```

- [ ] **Step 2: 创建 feature.json**（content/index.js 已可运行，现在才落地，避免连累他人 build）

`features/create_purchase_order/feature.json`:
```json
{
  "id": "create_purchase_order",
  "icon": "🛒",
  "label": "创建采购单",
  "locked": false,
  "order": 5,
  "content_script": "content/index.js",
  "content_matches": [
    "https://agentseller.temu.com/*",
    "https://detail.1688.com/*",
    "https://www.dianxiaomi.com/*"
  ],
  "host_permissions": [
    "https://agentseller.temu.com/*",
    "https://detail.1688.com/*",
    "https://www.dianxiaomi.com/*"
  ],
  "permissions": ["tabs", "storage"],
  "extra_content_scripts": [
    {
      "js": ["cpo-logic.js"],
      "matches": [
        "https://agentseller.temu.com/*",
        "https://detail.1688.com/*",
        "https://www.dianxiaomi.com/*"
      ],
      "run_at": "document_start"
    }
  ]
}
```

- [ ] **Step 3: 构建**

Run: `python build/build_extension.py`
Expected: 输出含 `discovered feature: create_purchase_order`，无报错，`dist/extension/manifest.json` 生成。

- [ ] **Step 4: 验证 manifest 聚合正确**

Run: `python -c "import json; m=json.load(open('dist/extension/manifest.json')); print('perms', m['permissions']); print('hosts', m['host_permissions']); print('cs0_matches', m['content_scripts'][0]['matches']); print('has cpo-logic extra cs', any('cpo-logic.js' in (cs.get('js') or [''])[0] for cs in m['content_scripts']))"`
Expected: `permissions` 含 `tabs`/`storage`；`host_permissions` 含三域；`content_scripts[0].matches` 含三域；`has cpo-logic extra cs` 为 `True`。

- [ ] **Step 5: 手动验证 UI（浏览器）**

chrome `chrome://extensions` reload `dist/extension/` → 打开 `https://agentseller.temu.com/goods/list` → FAB → Hub 应出现「🛒 创建采购单」→ 点开 → 有 SKC/1688url 输入框 + 开始按钮。
输入空 SKC 点开始 → 面板红字「SKC编码不能为空」。输入非 1688 url → 红字提示 serial 提取失败。
Expected: UI 正常、本地校验生效（此时点合法输入会发 CPO_START 但 bg 尚无 handler，面板停在「启动中…」属正常，Task 3 接上）。

- [ ] **Step 6: 提交**

```bash
git add features/create_purchase_order/content/index.js features/create_purchase_order/feature.json
git commit -m "feat(create_purchase_order): feature scaffold + 输入UI + 命令路由骨架

Why: 让 feature 三域加载、Hub 出入口、装好 bg→content 命令通道骨架
What: index.js 注册+输入表单+进度面板+6 个 handler 占位+onMessage 路由；feature.json 三域 content_matches + tabs/storage + cpo-logic extra cs
Test: build OK + manifest 聚合校验 + 手动 UI 验证（本地校验生效）"
```

---

## Task 3: bg 编排段（service-worker.js 内 CPO_ 标记段）

> 把整条线性序列写进 `core/background/service-worker.js`，沿用 img_search 的「文件内标记段」先例。此时 content handler 还是占位（Task 2），所以编排跑到第一个命令就会收到 `not_implemented` → 走错误分支。这是预期的：本任务验证「编排骨架 + 错误推送 + tab 工具」可跑通，不验证真实取数。

**Files:**
- Modify: `core/background/service-worker.js`（文件末尾追加标记段，不动现有 listener）

- [ ] **Step 1: 在 service-worker.js 末尾追加 CPO 编排段**

追加到文件最后（现有 `chrome.runtime.onMessage.addListener` 之后；CPO 用**独立的**第二个 listener，互不干扰）：
```js

// ── create_purchase_order ── Phase 1 跨 tab 编排 ───────────────────────────────
const CPO_DXM_INDEX_URL = 'https://www.dianxiaomi.com/web/dxmCommodityProduct/index';
const CPO_CMD_TIMEOUT   = 20000;   // 单条命令往返超时
const CPO_READY_RETRIES = 25;      // 等 content 就绪重试次数（每次 200ms ≈ 5s）

function cpoSetState(patch) {
  return chrome.storage.local.get('cpo_state').then(({ cpo_state }) => {
    const next = { status: 'idle', step: 0, collectedData: {}, ...(cpo_state || {}), ...patch };
    return chrome.storage.local.set({ cpo_state: next });
  });
}

// 等 tab 加载完成（status==='complete'）
function cpoWaitTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('tab 加载超时')); }, timeout);
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') { cleanup(); resolve(); }
    }
    function cleanup() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); }
    chrome.tabs.onUpdated.addListener(onUpdated);
    // 兜底：可能已 complete
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') { cleanup(); resolve(); } }).catch(() => {});
  });
}

// 等某个 tab 的 URL 满足 predicate（处理「点击后同 tab 跳转或新开 tab」两种）→ 返回 tabId
function cpoWaitForUrl(predicate, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('未等到目标页面')); }, timeout);
    function onUpdated(tabId, info, tab) {
      const url = info.url || tab.url || '';
      if (url && predicate(url) && (info.status === 'complete' || info.url)) {
        // 等到 complete 再 resolve，确保 content script 注入
        if (tab.status === 'complete') { cleanup(); resolve(tabId); }
      }
    }
    function cleanup() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// 向 tab 发命令，content 未就绪（Receiving end does not exist）时重试
async function cpoSendCommand(tabId, type, data) {
  let lastErr;
  for (let i = 0; i < CPO_READY_RETRIES; i++) {
    try {
      const resp = await Promise.race([
        chrome.tabs.sendMessage(tabId, { type, data }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('命令超时: ' + type)), CPO_CMD_TIMEOUT)),
      ]);
      if (resp && resp.ok === false) throw new Error(resp.error || (type + ' 失败'));
      return resp;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (!/Receiving end does not exist|Could not establish connection/.test(msg)) throw e;
      await new Promise(r => setTimeout(r, 200));   // content 还没注入，等等再试
    }
  }
  throw lastErr || new Error('命令无法送达: ' + type);
}

function cpoNotify(originTabId, type, payload) {
  chrome.tabs.sendMessage(originTabId, { type, ...payload }).catch(() => {});
}

// 主编排序列
async function cpoRun(originTabId, { skc, url1688 }) {
  const serial = url1688.match(/\/offer\/(\d+)/)?.[1] || null;
  if (!serial) {   // bg 侧二次校验（content 已校验，双保险）
    cpoNotify(originTabId, 'CPO_ERROR', { step: 0, message: '1688商品url 无法提取 serial', kind: 'validate' });
    await cpoSetState({ status: 'error', step: 0 });
    return;
  }
  const collected = { skc, url1688, serial, title: '', skuNo: '', previewUrl: '' };
  const tmpTabs = [];   // 临时 tab，出错时统一回收
  try {
    await cpoSetState({ status: 'running', step: 1, collectedData: collected });

    // 步骤1：后台开 1688 → 抓标题 → 关
    cpoNotify(originTabId, 'CPO_PROGRESS', { step: 1, label: '读取 1688 标题' });
    const t1688 = await chrome.tabs.create({ url: url1688, active: false });
    tmpTabs.push(t1688.id);
    await cpoWaitTabComplete(t1688.id);
    const r1 = await cpoSendCommand(t1688.id, 'CPO_READ_1688_TITLE');
    collected.title = r1.title;
    await chrome.tabs.remove(t1688.id); tmpTabs.splice(tmpTabs.indexOf(t1688.id), 1);
    await cpoSetState({ step: 2, collectedData: collected });

    // 步骤2：起点 temu 列表查 SKC 读货号
    cpoNotify(originTabId, 'CPO_PROGRESS', { step: 2, label: '查询 SKC、读取 SKU货号' });
    const r2 = await cpoSendCommand(originTabId, 'CPO_QUERY_SKC_GET_NO', { skc });
    if (!r2.skuNo || !String(r2.skuNo).trim()) {
      cpoNotify(originTabId, 'CPO_ERROR', { step: 2, message: '该商品需先维护货号', kind: 'validate' });
      await cpoSetState({ status: 'error', step: 2 });
      return;
    }
    collected.skuNo = r2.skuNo.trim();
    await cpoSetState({ step: 3, collectedData: collected });

    // 步骤3：点编辑（新开 edit tab）→ 抓预览图 → 关
    cpoNotify(originTabId, 'CPO_PROGRESS', { step: 3, label: '进入编辑页、读取预览图' });
    const editTabP = cpoWaitForUrl(u => u.includes('/goods/edit'));
    await cpoSendCommand(originTabId, 'CPO_CLICK_EDIT', { skc });
    const editTabId = await editTabP;
    tmpTabs.push(editTabId);
    const r3 = await cpoSendCommand(editTabId, 'CPO_GRAB_PREVIEW');
    collected.previewUrl = r3.previewUrl;
    await chrome.tabs.remove(editTabId); tmpTabs.splice(tmpTabs.indexOf(editTabId), 1);
    await cpoSetState({ step: 4, collectedData: collected });

    // 步骤4：开店小秘 index → 进添加单个SKU → 填表（停在保存前）
    cpoNotify(originTabId, 'CPO_PROGRESS', { step: 4, label: '店小秘填表' });
    const tDxm = await chrome.tabs.create({ url: CPO_DXM_INDEX_URL, active: true });
    await cpoWaitTabComplete(tDxm.id);
    const addTabP = cpoWaitForUrl(u => u.includes('openAddModal'));
    await cpoSendCommand(tDxm.id, 'CPO_DXM_OPEN_ADD');
    const addTabId = await addTabP;       // 同 tab 跳转或新开 tab 都覆盖
    await cpoSendCommand(addTabId, 'CPO_FILL_DXM', { collected });

    await cpoSetState({ status: 'awaiting_save', step: 4, collectedData: collected });
    cpoNotify(originTabId, 'CPO_DONE', {});
  } catch (e) {
    // 回收所有未关闭的临时 tab
    for (const id of tmpTabs) { chrome.tabs.remove(id).catch(() => {}); }
    cpoNotify(originTabId, 'CPO_ERROR', { step: '?', message: String(e?.message || e), kind: 'read' });
    await cpoSetState({ status: 'error' });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'CPO_START') return;            // 只接管 CPO_START；其余命令是 bg→content，不在此
  const originTabId = sender.tab?.id;
  if (!originTabId) { sendResponse({ ok: false, error: '无起点 tab' }); return; }
  cpoRun(originTabId, msg.data);                   // 异步跑，不阻塞 ack
  sendResponse({ ok: true });                      // 立即 ack
});
// ── end create_purchase_order ────────────────────────────────────────────────
```

- [ ] **Step 2: 构建**

Run: `python build/build_extension.py`
Expected: 无报错；`dist/extension/background/service-worker.js` 含 `create_purchase_order` 段。

- [ ] **Step 3: 手动验证编排骨架跑通（浏览器）**

reload 扩展 → temu 列表页 → Hub → 创建采购单 → 输入合法 SKC + 真实 1688 url → 点开始。
观察：面板依次显示「步骤1：读取 1688 标题」；后台短暂开/关一个 1688 tab；随后因 content handler 仍是占位，面板显示「步骤1失败：not_implemented: CPO_READ_1688_TITLE」（**这正是本任务的预期结果**）。
打开 SW 控制台（chrome://extensions → service worker「检查」）确认无未捕获异常、临时 1688 tab 已被关闭。
Expected: 编排链路通、进度推送到面板、错误能回传并清理临时 tab。

- [ ] **Step 4: 提交**

```bash
git add core/background/service-worker.js
git commit -m "feat(create_purchase_order): bg 跨 tab 编排段

Why: Phase 1 需 background 当编排者（开关 tab + 发命令 + 收数据），沿用 img_search 文件内标记段先例
What: service-worker.js 末尾加 CPO 段——CPO_START 监听、cpoRun 线性序列、tab 就绪/URL 等待/命令重试工具、错误统一回收临时 tab + 进度推送
Test: build OK + 手动验证编排链路通（handler 占位故停在 step1 not_implemented，符合预期），临时 tab 正确回收"
```

---

> **DOM 任务通用说明（Task 4-7）**：这些 handler 依赖外部站点真实 DOM，**无法离线单测**——验证手段是浏览器实测（项目既有 feature 均如此）。每个任务第一步必须 dump 真实 DOM 存到 `samples/`，再据真实结构确认/调整 handler 里的选择器。代码给出的选择器是**基于项目约定的最佳起点（data-testid / 文本匹配 / label 邻接 input）**，不是占位符，但**必须对照 dump 校准**。selector 铁律：优先 `data-testid` 和文本匹配，禁 hash class。

## Task 4: temu 列表 handler —— CPO_QUERY_SKC_GET_NO + CPO_CLICK_EDIT

**Files:**
- Modify: `features/create_purchase_order/content/index.js`（填实现这两个 handler）
- Create: `features/create_purchase_order/samples/temu_goods_list.txt`（DOM dump）

- [ ] **Step 1: dump temu 列表页 DOM**

浏览器开 `https://agentseller.temu.com/goods/list`，手动按「商品ID查询=SKC」查一个真实 SKC 出结果。DevTools console 跑下面，把输出存到 `features/create_purchase_order/samples/temu_goods_list.txt`：
```js
// 1) 查询条件区（找「商品ID查询」下拉 + 输入框 + 查询按钮）
copy(document.querySelector('[class*="search"], form, .filter')?.outerHTML || document.body.outerHTML.slice(0, 20000));
```
重点记录：查询字段下拉（怎么切到 SKC）、SKC 输入框选择器、查询按钮、结果表格行结构、行内「SKU货号」列、行内「操作」列的「编辑」按钮。data-testid / 文本锚点都记下。

- [ ] **Step 2: 据 dump 实现两个 handler**

把 index.js 里这两个占位替换为实现（选择器对照 Step 1 的 dump 校准）：
```js
    CPO_QUERY_SKC_GET_NO: async ({ skc }) => {
      // a) 把「商品ID查询」下拉切到 SKC（若默认已是 SKC 可跳过；据 dump 决定）
      //    下拉触发器常见为含「商品ID」「SKC」文案的 selector trigger
      const selTrigger = U.findByText('[class*="select"],[class*="Select"]', '商品ID');
      if (selTrigger) {
        selTrigger.click();
        await U.sleep(300);
        const opt = U.findByText('[class*="option"],[role="option"],li', 'SKC');
        if (opt) { opt.click(); await U.sleep(300); }
      }
      // b) 填 SKC 输入框（据 dump：查询区内的文本 input）
      const input = await U.waitForEl('input[placeholder*="SKC"], [class*="search"] input, input[type="text"]');
      U.setInputValue(input, skc);
      // c) 点查询按钮
      const queryBtn = U.findByText('button', '查询') || U.findByText('[class*="btn"]', '查询');
      if (!queryBtn) return { ok: false, error: '未找到查询按钮' };
      queryBtn.click();
      // d) 等结果行渲染，定位含该 SKC 的行，读 SKU货号列
      await U.sleep(800);
      const row = await cpoFindSkcRow(skc);
      if (!row) return { ok: false, error: `未找到 SKC 对应商品行（${skc}）` };
      const skuNo = cpoReadSkuNoFromRow(row);   // 空串表示未维护货号（交 bg 判 abort）
      return { ok: true, skuNo: skuNo || '' };
    },

    CPO_CLICK_EDIT: async ({ skc }) => {
      const row = await cpoFindSkcRow(skc);
      if (!row) return { ok: false, error: `点编辑时未找到 SKC 行（${skc}）` };
      const editBtn = U.findByText('a,button,[class*="btn"]', '编辑');   // 限定在行内查
      const btnInRow = row.querySelector('a,button') &&
        Array.from(row.querySelectorAll('a,button,[class*="btn"]')).find(b => U.normText(b.textContent).includes('编辑'));
      const target = btnInRow || editBtn;
      if (!target) return { ok: false, error: '未找到行内编辑按钮' };
      target.click();   // temu 自动新开 edit tab，由 bg 的 cpoWaitForUrl 捕获
      return { ok: true };
    },
```
并在 IIFE 内（handlers 之前）加两个辅助函数（据 dump 校准选择器）：
```js
  // 在结果表格里找包含指定 SKC 文本的数据行
  async function cpoFindSkcRow(skc) {
    try { await U.waitForEl('table tr, [class*="table"] [class*="row"], [role="row"]', document, 6000); }
    catch { return null; }
    const rows = document.querySelectorAll('table tbody tr, [role="row"], [class*="Table"] [class*="row"]');
    return Array.from(rows).find(r => r.textContent.includes(skc)) || null;
  }

  // 从行内读「SKU货号」列的值（据 dump：可能是带 label 的单元格或独立列）
  function cpoReadSkuNoFromRow(row) {
    // 优先：行内带 data-testid / 含「货号」label 的单元格邻接文本
    const labelCell = Array.from(row.querySelectorAll('*'))
      .find(el => U.normText(el.textContent).includes('SKU货号'));
    if (labelCell) {
      const m = labelCell.textContent.replace(/\s/g, '').match(/SKU货号[:：]?(.+)/);
      if (m && m[1]) return m[1].trim();
    }
    return '';   // 据 dump 调整：若货号是独立列，改成按 cellIndex 取
  }
```

- [ ] **Step 3: 构建**

Run: `python build/build_extension.py`
Expected: 无报错。

- [ ] **Step 4: 手动验证（浏览器）**

reload → temu 列表页 → 创建采购单 → 输入一个**已维护货号**的 SKC + 真实 1688 url → 开始。
观察：步骤1 标题读取后（Task 6 前 1688 仍会 not_implemented —— 为单测本 handler，可临时在 SW 控制台直接 `chrome.tabs.sendMessage(<列表tabId>, {type:'CPO_QUERY_SKC_GET_NO', data:{skc:'<真实SKC>'}}).then(console.log)` 单独验证此 handler 返回 `{ok:true, skuNo:'…'}`）。
再单独验证 `CPO_CLICK_EDIT`：发命令后应自动新开 edit tab。
Expected: 货号正确读出；编辑按钮点击后新开 edit tab。

- [ ] **Step 5: 提交**

```bash
git add features/create_purchase_order/content/index.js features/create_purchase_order/samples/temu_goods_list.txt
git commit -m "feat(create_purchase_order): temu 列表 handler 查SKC读货号+点编辑

Why: Phase 1 步骤2-3 在 temu 列表页取 SKU货号并进编辑页
What: 实现 CPO_QUERY_SKC_GET_NO（切SKC字段+填+查+定位行+读货号）与 CPO_CLICK_EDIT（行内编辑按钮，触发新开 edit tab）；选择器据 samples/temu_goods_list.txt 校准
Test: 手动验证货号读出 + 编辑新开 tab（DOM handler 无离线单测）"
```

---

## Task 5: temu 编辑页 handler —— CPO_GRAB_PREVIEW

**Files:**
- Modify: `features/create_purchase_order/content/index.js`
- Create: `features/create_purchase_order/samples/temu_goods_edit.txt`

- [ ] **Step 1: dump 编辑页 SKU 信息框 DOM**

开任一商品编辑页 `https://agentseller.temu.com/goods/edit?...productId=...`，定位「SKU信息」框里的预览图，console 跑并存到 `samples/temu_goods_edit.txt`：
```js
copy(Array.from(document.querySelectorAll('*')).find(el => /SKU信息|预览图|预览/.test(el.textContent) && el.querySelector('img'))?.outerHTML?.slice(0,15000) || 'NOT_FOUND');
```
重点：预览图是 `<img src>` 还是背景图 / 是否有「复制url」按钮 / src 是缩略图还是原图 url（注意 naturalWidth）。

- [ ] **Step 2: 据 dump 实现 handler**

替换 index.js 里 `CPO_GRAB_PREVIEW` 占位：
```js
    CPO_GRAB_PREVIEW: async () => {
      // 据 dump 定位 SKU 信息框内的预览图 img；优先 data-testid / 含「预览」的容器内 img
      let img;
      try {
        img = await U.waitForEl('[class*="preview"] img, [data-testid*="preview"] img', document, 8000);
      } catch { img = null; }
      if (!img) {
        // 退路：SKU 信息区第一张商品图
        const box = Array.from(document.querySelectorAll('*')).find(el => /SKU信息/.test(el.textContent) && el.querySelector('img'));
        img = box?.querySelector('img') || null;
      }
      const previewUrl = img?.src || img?.getAttribute('data-src') || '';
      if (!previewUrl) return { ok: false, error: '预览图url 读取失败（编辑页未找到预览图）' };
      return { ok: true, previewUrl };
    },
```

- [ ] **Step 3: 构建**

Run: `python build/build_extension.py`
Expected: 无报错。

- [ ] **Step 4: 手动验证（浏览器）**

开一个编辑页 → SW 控制台 `chrome.tabs.sendMessage(<editTabId>, {type:'CPO_GRAB_PREVIEW'}).then(console.log)`。
Expected: 返回 `{ok:true, previewUrl:'https://…'}`，url 可在新标签打开看到图。

- [ ] **Step 5: 提交**

```bash
git add features/create_purchase_order/content/index.js features/create_purchase_order/samples/temu_goods_edit.txt
git commit -m "feat(create_purchase_order): temu 编辑页 handler 抓预览图url

Why: Phase 1 步骤3 在编辑页 SKU 信息框取预览图 url
What: 实现 CPO_GRAB_PREVIEW，定位预览图 img 读 src；选择器据 samples/temu_goods_edit.txt 校准
Test: 手动验证返回可访问的预览图 url"
```

---

## Task 6: 1688 标题 handler —— CPO_READ_1688_TITLE

**Files:**
- Modify: `features/create_purchase_order/content/index.js`
- Create: `features/create_purchase_order/samples/1688_offer.txt`

- [ ] **Step 1: dump 1688 商品页标题 DOM**

开一个真实 1688 商品页 `https://detail.1688.com/offer/<id>.html`，console 跑并存到 `samples/1688_offer.txt`：
```js
console.log('document.title =', document.title);
console.log('h1 =', document.querySelector('h1')?.textContent);
console.log('og:title =', document.querySelector('meta[property="og:title"]')?.content);
copy(Array.from(document.querySelectorAll('h1, [class*="title"], [class*="offer-title"]')).map(e=>e.outerHTML).join('\n').slice(0,8000));
```
记录：标题最稳的取法（`og:title` meta 通常最稳，不受动态渲染影响）、是否登录墙、是否风控页（路径含 `/punish` 或参数含 `x5secdata`，参考 img_search injector）。

- [ ] **Step 2: 据 dump 实现 handler**

替换 index.js 里 `CPO_READ_1688_TITLE` 占位：
```js
    CPO_READ_1688_TITLE: async () => {
      // 风控/登录页早退（参考 img_search injector）
      if (location.pathname.includes('/punish') || location.search.includes('x5secdata')) {
        return { ok: false, error: '1688 触发风控/验证页，请先在浏览器完成验证' };
      }
      // 优先 og:title（动态渲染下最稳），退到 h1 / 标题容器，再退 document.title
      const og = document.querySelector('meta[property="og:title"]')?.content?.trim();
      if (og) return { ok: true, title: og };
      let h;
      try { h = await U.waitForEl('h1, [class*="offer-title"], [class*="title"]', document, 8000); }
      catch { h = null; }
      const fromEl = h?.textContent?.trim();
      if (fromEl) return { ok: true, title: fromEl };
      const fromDoc = (document.title || '').replace(/[-_|].*$/, '').trim();
      if (fromDoc) return { ok: true, title: fromDoc };
      return { ok: false, error: '1688标题读取失败（可能未登录/页面未渲染）' };
    },
```

- [ ] **Step 3: 构建 + 手动验证**

Run: `python build/build_extension.py`，reload。
SW 控制台：`chrome.tabs.create({url:'https://detail.1688.com/offer/<id>.html', active:false}).then(t=>new Promise(r=>setTimeout(()=>r(t),3000))).then(t=>chrome.tabs.sendMessage(t.id,{type:'CPO_READ_1688_TITLE'})).then(console.log)`
Expected: 返回 `{ok:true, title:'<商品标题>'}`。

- [ ] **Step 4: 提交**

```bash
git add features/create_purchase_order/content/index.js features/create_purchase_order/samples/1688_offer.txt
git commit -m "feat(create_purchase_order): 1688 标题 handler

Why: Phase 1 步骤1 取 1688 商品标题作店小秘中文名称
What: 实现 CPO_READ_1688_TITLE，og:title 优先 + h1/title 退路 + 风控页早退；据 samples/1688_offer.txt 校准
Test: 手动验证后台 tab 抓到标题"
```

---

## Task 7: 店小秘填表 handler —— CPO_DXM_OPEN_ADD + CPO_FILL_DXM

> 本任务是 Phase 1 最大块。`CPO_DXM_OPEN_ADD` 在商品管理首页点「添加商品→添加单个SKU」（触发跳转到 openAddModal 页，由 bg 捕获）。`CPO_FILL_DXM` 在 openAddModal 页填全部 card 并**停在保存前**（不点保存）。

**Files:**
- Modify: `features/create_purchase_order/content/index.js`
- Create: `features/create_purchase_order/samples/dxm_index.txt`（首页添加按钮区）
- Create: `features/create_purchase_order/samples/dxm_add_form.txt`（openAddModal 表单）

- [ ] **Step 1: dump 店小秘首页「添加商品」区 + add 表单**

开 `https://www.dianxiaomi.com/web/dxmCommodityProduct/index`，点「添加商品」看下拉，console 存 `samples/dxm_index.txt`：
```js
copy(Array.from(document.querySelectorAll('button,[class*="btn"],a')).filter(b=>/添加商品|添加单个|添加SKU/.test(b.textContent)).map(b=>b.outerHTML).join('\n'));
```
点进「添加单个SKU」到 openAddModal 页，console 存 `samples/dxm_add_form.txt`：
```js
// 各 card label + 对应输入框；图片选择按钮；人员下拉；保存按钮
copy(document.querySelector('form, [class*="add"], body').outerHTML.slice(0, 40000));
console.log('user-name 元素:', document.querySelector('.user-name, [class*="user-name"]')?.textContent);
```
重点记录：基础信息 card 的「商品SKU/英文名称/平台SKU/中文名称/识别码」各 input（label 文案 + name 属性）；「来源URL」card input；图片信息「选择图片」按钮 + 下拉「网络图片」项 + 弹窗 url 输入框 + 确定按钮；人员信息各下拉 + 当前 user-name 文本；底部保存按钮。

- [ ] **Step 2: 据 dump 实现两个 handler + 填表辅助**

替换 index.js 里 `CPO_DXM_OPEN_ADD` / `CPO_FILL_DXM` 占位：
```js
    CPO_DXM_OPEN_ADD: async () => {
      const addBtn = U.findByText('button,[class*="btn"],a', '添加商品');
      if (!addBtn) return { ok: false, error: '未找到「添加商品」按钮' };
      addBtn.click();
      await U.sleep(400);
      const single = U.findByText('[class*="menu"] *, li, a, button', '添加单个SKU')
        || U.findByText('li,a,button', '单个SKU');
      if (!single) return { ok: false, error: '未找到「添加单个SKU」菜单项' };
      single.click();    // 触发跳转 openAddModal，bg 的 cpoWaitForUrl 捕获
      return { ok: true };
    },

    CPO_FILL_DXM: async ({ collected }) => {
      const f = L.mapDxmFields(collected);
      // 等表单渲染
      try { await U.waitForEl('form, [class*="add"] input', document, 10000); }
      catch { return { ok: false, error: '店小秘添加表单未渲染' }; }

      // 基础信息：商品SKU / 英文名称 / 平台SKU / 中文名称 / 识别码（label 邻接 input，据 dump 校准）
      cpoFillByLabel('商品SKU', f.spuSku);
      cpoFillByLabel('英文名称', f.enName);
      cpoFillByLabel('平台SKU', f.platformSku);
      cpoFillByLabel('中文名称', f.cnName);
      cpoFillByLabel('识别码', f.idCode);
      // 来源URL card
      cpoFillByLabel('来源URL', f.sourceUrl) || cpoFillByLabel('来源', f.sourceUrl);

      // 图片信息：选择图片 → 网络图片 → 填 url → 确定
      const picRes = await cpoAddNetworkImage(f.imageUrl);
      if (!picRes.ok) return picRes;

      // 人员信息：所有下拉选当前 user-name
      await cpoFillPersonnel();

      return { ok: true, filled: true };
    },
```
辅助函数（加到 IIFE 内 handlers 之前；选择器据 dump 校准）：
```js
  // 据 label 文案找到邻接 input 并填值；返回是否填成功
  function cpoFillByLabel(labelText, value) {
    const label = Array.from(document.querySelectorAll('label, [class*="label"], th, td'))
      .find(el => U.normText(el.textContent) === U.normText(labelText)
                || U.normText(el.textContent).startsWith(U.normText(labelText)));
    if (!label) return false;
    // 邻接策略：label 的同级/父级容器内第一个 input
    const scope = label.closest('[class*="item"], [class*="form"], tr, div') || label.parentElement;
    const input = scope?.querySelector('input, textarea');
    if (!input) return false;
    U.setInputValue(input, value);
    return true;
  }

  // 图片信息 card：点「选择图片」→ 下拉「网络图片」→ 弹窗填 url → 确定
  async function cpoAddNetworkImage(url) {
    const choose = U.findByText('button,[class*="btn"],a,span', '选择图片');
    if (!choose) return { ok: false, error: '未找到「选择图片」按钮' };
    choose.click();
    await U.sleep(300);
    const net = U.findByText('[class*="dropdown"] *, [class*="menu"] *, li, a', '网络图片');
    if (!net) return { ok: false, error: '未找到「网络图片」选项' };
    net.click();
    await U.sleep(300);
    // 弹窗内 url 输入框
    let input;
    try { input = await U.waitForEl('[class*="modal"] input, [class*="dialog"] input, .ant-modal input', document, 5000); }
    catch { return { ok: false, error: '网络图片弹窗未出现' }; }
    U.setInputValue(input, url);
    await U.sleep(150);
    const okBtn = U.findByText('[class*="modal"] button, [class*="dialog"] button, .ant-modal button', '确定')
      || U.findByText('button', '确定');
    if (!okBtn) return { ok: false, error: '网络图片弹窗未找到「确定」' };
    okBtn.click();
    await U.sleep(300);
    return { ok: true };
  }

  // 人员信息 card：所有下拉选当前店铺 user-name
  async function cpoFillPersonnel() {
    const userName = (document.querySelector('.user-name, [class*="user-name"]')?.textContent || '').trim();
    if (!userName) return;   // 读不到就跳过（据 dump 校准 user-name 选择器）
    // 找人员信息 card 内的下拉触发器；逐个打开选 userName
    const card = Array.from(document.querySelectorAll('[class*="card"], [class*="panel"], section, div'))
      .find(el => /人员信息/.test(el.textContent));
    const selects = Array.from((card || document).querySelectorAll('[class*="select"] [class*="selector"], .ant-select'));
    for (const sel of selects) {
      sel.click();
      await U.sleep(250);
      const opt = U.findByText('[class*="option"], [role="option"], li', userName);
      if (opt) opt.click();
      await U.sleep(150);
    }
  }
```

- [ ] **Step 3: 构建**

Run: `python build/build_extension.py`
Expected: 无报错。

- [ ] **Step 4: 手动验证（浏览器）**

reload → 店小秘首页 → SW 控制台先单测 `CPO_DXM_OPEN_ADD`（应跳到 openAddModal 页）→ 再对 openAddModal tab 发 `CPO_FILL_DXM` 带一组真实 collected，逐 card 核对填充：基础信息 5 框、来源URL、网络图片弹窗确定后图片出现、人员下拉选中 user-name。**确认未点保存**。
Expected: 所有字段填对、图片加上、人员选好，停在保存前。

- [ ] **Step 5: 提交**

```bash
git add features/create_purchase_order/content/index.js features/create_purchase_order/samples/dxm_index.txt features/create_purchase_order/samples/dxm_add_form.txt
git commit -m "feat(create_purchase_order): 店小秘添加单个SKU + 填表 handler

Why: Phase 1 步骤4 在店小秘建商品 SKU 并停在保存前等核对
What: CPO_DXM_OPEN_ADD（添加商品→添加单个SKU 触发跳转）+ CPO_FILL_DXM（基础信息5框/来源URL/网络图片弹窗/人员下拉，不点保存）；选择器据 samples/dxm_*.txt 校准
Test: 手动逐 card 核对填充正确且未保存"
```

---

## Task 8: 端到端 + 错误路径验证

> 不写新代码（除非验证暴露 bug）；用真实数据跑通全链路 + 验证两条中止路径。这是 Phase 1 的完成判定。

**Files:** 无新增（修 bug 时改 `content/index.js` 或 `core/background/service-worker.js`）

- [ ] **Step 1: 回归纯逻辑单测**

Run: `node --test features/create_purchase_order/tests/cpo-logic.test.js`
Expected: 9 passed, 0 fail。

- [ ] **Step 2: 端到端 happy path（浏览器）**

reload → temu 列表页 → 创建采购单 → 输入**已维护货号**的真实 SKC + 对应真实 1688 url → 开始。
全程不手动干预，观察面板依次：步骤1 读 1688 标题 → 步骤2 查 SKC 读货号 → 步骤3 进编辑页读预览图 → 步骤4 店小秘填表 → 「已填好，请在店小秘页核对后保存」。
切到店小秘 add tab 核对：基础信息 5 框、中文名称=1688标题、识别码=serial-货号、来源URL=1688url、图片=预览图、人员=user-name。临时 tab（1688/编辑页）已自动关闭。
Expected: 全链路通，数据正确，停在保存前；1688/edit 临时 tab 已关。

- [ ] **Step 3: 错误路径①——未维护货号**

输入一个**未维护 SKU货号**的 SKC → 开始。
Expected: 跑到步骤2 中止，面板红字「步骤2失败：该商品需先维护货号」；不进编辑页、不开店小秘。

- [ ] **Step 4: 错误路径②——SKC 不存在 / 非法 1688 url**

- 输入不存在的 SKC → Expected: 步骤2 红字「未找到 SKC 对应商品行」。
- 输入非 offer 格式的 1688 url → Expected: 点开始即本地校验拦截，红字 serial 提取失败（不启动 bg）。

- [ ] **Step 5: 验证错误后状态可重跑**

任一中止后，重新输入正确数据点开始 → Expected: 能正常重跑（`cpo_state` 不残留脏状态阻塞）。SW 控制台 `chrome.storage.local.get('cpo_state').then(console.log)` 确认中止后 `status:'error'`，重跑后回到 `running→awaiting_save`。

- [ ] **Step 6: 提交（若有修 bug）**

```bash
git add -A
git commit -m "fix(create_purchase_order): 端到端验证修复

Why: 真实数据端到端暴露的问题（选择器/时序/状态）
What: <按实际修复填写>
Test: 端到端 happy path 通 + 两条中止路径正确 + node --test 9 passed"
```
> 若无 bug，跳过提交，在 PR 描述里记录「端到端验证通过，无需修复」。

---

## Task 9: feature 文档 CLAUDE.md

**Files:**
- Create: `features/create_purchase_order/CLAUDE.md`

- [ ] **Step 1: 写 CLAUDE.md**

`features/create_purchase_order/CLAUDE.md`，覆盖：概述（ID/作用/三域/触发起点）、Phase 1 范围与 Phase 2 待定、架构（bg 编排者新模式 + 消息协议表，引用本 plan 的协议段）、线性流程表、店小秘字段映射表、错误文案分层、selector 策略与 samples 清单、调试方式（`node --test` + dev build + SW 控制台单测 handler 的命令）、已知限制（FAB 三域显示 / 1688 登录墙 / 选择器随改版漂移）。引用 spec 与 plan 路径。

- [ ] **Step 2: 提交**

```bash
git add features/create_purchase_order/CLAUDE.md
git commit -m "docs(create_purchase_order): feature 文档

Why: 记录 bg 编排新模式、消息协议、字段映射、调试方式供后续维护与 Phase 2 衔接
What: features/create_purchase_order/CLAUDE.md
Test: not run (文档)"
```

---

## 完成后

1. 全部 Task 完成后跑最终回归：`node --test features/create_purchase_order/tests/cpo-logic.test.js` + 一次端到端。
2. 用 `superpowers:requesting-code-review` 或 `/review` 审查整个 diff。
3. 推分支 + 开 PR（`shipping-rules.md` PR 流程）。PR 描述说明：新增 bg 编排模式（service-worker.js 加 CPO 段）、三域 content_matches、Phase 2 待定。
4. **CLAUDE.md 顶层文档**：本 feature 引入「background 编排者」新模式，合入后考虑在项目根 `CLAUDE.md` 的架构说明里补一句（service-worker.js 除 native 透传外，可含 feature 专属 bg 编排段，img_search/create_purchase_order 为例）——作为独立小 PR 或在本 PR 附带。

