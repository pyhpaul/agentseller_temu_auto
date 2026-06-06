# 销售管理清单采集导出 CSV (sale_manage_export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 agentseller.temu.com 销售管理页一键采集所有分页表格数据（SKC/SKC货号/SPU/商品名称），按 SKC 去重后导出 UTF-8 BOM CSV 到用户预设文件夹。

**Architecture:** 纯 content script 单页循环（spec 方案 A）：panel 按钮触发 → 调大每页条数（写后读校验）→ 逐页扫 rowspan 商品信息格 → 翻页等内容签名变化 → `Map<SKC,row>` 去重 → CSV 经共享 native host `SAVE_FILE_CHUNK` 落盘。纯函数（CSV 转义/字段解析/文件名）独立成 `sme-utils.js` 配 node 单测；DOM/分页逻辑在 `index.js`，靠真实页面验证。

**Tech Stack:** Chrome MV3 content script、`window.AgentSeller` core API（registerFeature/sendNative/utils）、共享 native host（PICK_FOLDER / SAVE_FILE_CHUNK）、`node --test` 单测。

**Spec:** `docs/superpowers/specs/2026-06-05-sale-manage-export-design.md`

**分支：** `feature/sale-manage-export`（已存在，spec 已提交）

## 背景速览（执行者必读）

- 项目根 `CLAUDE.md` 的「Feature 注册契约」「Core API」「DOM 表单自动化铁律」「DOM 自动化数据正确性」段是硬约束。
- 参考实现：`features/packing_label/content/index.js`（PICK_FOLDER 存路径 / SAVE_FILE_CHUNK 分块写 / rowspan 分组枚举 / panel UI 模式）、`features/packing_label/content/naming.js` + `tests/naming.test.js`（纯函数双导出 + node 单测模式）。
- 目标页 DOM 事实（来自真实 dump，见 spec 第 3 节）：
  - 行：`tr[data-testid="beast-core-table-body-tr"]`；每个 SKC 组 = 首行（含 rowspan 商品信息格）+ N 个 SKU 行 + 1 个「合计」行（无商品信息格）。
  - 商品信息格内：`[class*="main_productName"]` 商品名；`[class*="main_productInfoGrayContent"]` 下的 `<p>`：`SKC：…` / `SPU：…` / `SKC货号：…`。
  - 分页器：`[data-testid="beast-core-pagination"]`；总数 `[class*="PGT_totalText"]`（「共有 310 条」）；每页条数 select 在 `[class*="PGT_sizeChanger"]`；激活页 `[class*="PGT_pagerItemActive"]`；下一页 `[data-testid="beast-core-pagination-next"]`（末页含 `PGT_disabled` class）。
  - 加载遮罩：`[class*="Spn_spinningMask"]`。
  - class 带版本 hash（`_5-120-1`），**一律用 `class*=` 前缀匹配或 `data-testid`，禁止写完整 hash class**。
- **feature.json 落地时机硬约束**：`content_script` 文件完整可跑之前禁止创建 `feature.json`（否则全量 build hard fail 连累他人）。本计划放在 Task 2 末尾、index.js 骨架建好后落地。

---

### Task 1: 纯函数模块 sme-utils.js（CSV 转义 / 字段解析 / 文件名）+ node 单测

**Files:**
- Create: `features/sale_manage_export/content/sme-utils.js`
- Create: `features/sale_manage_export/tests/sme-utils.test.js`

- [ ] **Step 1: 写失败测试**

创建 `features/sale_manage_export/tests/sme-utils.test.js`：

```js
// node --test 单测：sme-utils 纯函数（CSV 转义 / 商品信息字段解析 / 文件名）
const test = require('node:test');
const assert = require('node:assert');
const U = require('../content/sme-utils.js');

test('csvField: 普通值原样返回', () => {
  assert.strictEqual(U.csvField('RAC449'), 'RAC449');
});

test('csvField: 含逗号/引号/换行时双引号包裹并转义内部引号', () => {
  assert.strictEqual(U.csvField('a,b'), '"a,b"');
  assert.strictEqual(U.csvField('say "hi"'), '"say ""hi"""');
  assert.strictEqual(U.csvField('l1\nl2'), '"l1\nl2"');
});

test('csvField: null/undefined 转空串', () => {
  assert.strictEqual(U.csvField(null), '');
  assert.strictEqual(U.csvField(undefined), '');
});

test('buildCsvText: 表头 + 行，CRLF 分隔', () => {
  const rows = [
    { skc: '55589159770', skcCode: 'RAC449', spu: '2354682166', name: 'Aluminum alloy, magnetic' },
  ];
  assert.strictEqual(
    U.buildCsvText(rows),
    'SKC,SKC货号,SPU,商品名称\r\n55589159770,RAC449,2354682166,"Aluminum alloy, magnetic"\r\n'
  );
});

test('parseInfoFields: 从商品信息格 p 文本提取三字段', () => {
  const r = U.parseInfoFields([
    'SKC：55589159770',
    '加入站点时长：-天',
    'SPU：2354682166',
    'SKC货号：RAC449',
    '节日/季节标签：-',
  ]);
  assert.deepStrictEqual(r, { skc: '55589159770', skcCode: 'RAC449', spu: '2354682166' });
});

test('parseInfoFields: 兼容半角冒号与首尾空白', () => {
  const r = U.parseInfoFields(['SKC: 111 ', ' SPU：222', 'SKC货号:ABC-1']);
  assert.deepStrictEqual(r, { skc: '111', skcCode: 'ABC-1', spu: '222' });
});

test('parseInfoFields: 缺字段返回空串（由调用方报数据校验错）', () => {
  const r = U.parseInfoFields(['SPU：222']);
  assert.deepStrictEqual(r, { skc: '', skcCode: '', spu: '222' });
});

test('parseInfoFields: SKC货号 行不得误吞进 SKC（前缀更长者优先）', () => {
  const r = U.parseInfoFields(['SKC货号：RAC449']);
  assert.strictEqual(r.skc, '');
  assert.strictEqual(r.skcCode, 'RAC449');
});

test('buildCsvFileName: 销售管理清单_YYYYMMDD_HHMMSS.csv', () => {
  const d = new Date(2026, 5, 5, 14, 30, 22); // 2026-06-05 14:30:22
  assert.strictEqual(U.buildCsvFileName(d), '销售管理清单_20260605_143022.csv');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/linux_dev/projects/agentseller_temu && node --test features/sale_manage_export/tests/`
Expected: FAIL（`Cannot find module '../content/sme-utils.js'`）

- [ ] **Step 3: 最小实现**

创建 `features/sale_manage_export/content/sme-utils.js`（双导出模式同 `packing_label/content/naming.js`）：

```js
// sme-utils：sale_manage_export 纯函数（CSV 转义 / 商品信息字段解析 / 文件名）。
// 双导出：browser 挂 window.__SMEUtils，node 走 module.exports 供单测。
(function (root) {
  'use strict';

  // CSV 单字段转义：含逗号/引号/换行 → 双引号包裹，内部 " → ""
  function csvField(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // rows: [{skc, skcCode, spu, name}] → CSV 文本（表头 + CRLF，Excel 友好；BOM 由保存层加）
  function buildCsvText(rows) {
    const lines = ['SKC,SKC货号,SPU,商品名称'];
    for (const r of rows) {
      lines.push([csvField(r.skc), csvField(r.skcCode), csvField(r.spu), csvField(r.name)].join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  // 商品信息格 <p> 文本数组 → {skc, skcCode, spu}。
  // 前缀更长的「SKC货号」必须先于「SKC」匹配，否则被误吞。缺字段返回空串，由调用方分层报错。
  function parseInfoFields(pTexts) {
    const out = { skc: '', skcCode: '', spu: '' };
    for (const raw of pTexts || []) {
      const t = String(raw).trim();
      let m;
      if ((m = t.match(/^SKC货号[：:]\s*(.+)$/))) out.skcCode = m[1].trim();
      else if ((m = t.match(/^SKC[：:]\s*(.+)$/))) out.skc = m[1].trim();
      else if ((m = t.match(/^SPU[：:]\s*(.+)$/))) out.spu = m[1].trim();
    }
    return out;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function buildCsvFileName(d) {
    const ymd = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    const hms = pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    return '销售管理清单_' + ymd + '_' + hms + '.csv';
  }

  const api = { csvField, buildCsvText, parseInfoFields, buildCsvFileName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__SMEUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test features/sale_manage_export/tests/`
Expected: PASS（9 tests, 0 fail）

- [ ] **Step 5: Commit**

```bash
git add features/sale_manage_export/content/sme-utils.js features/sale_manage_export/tests/sme-utils.test.js
git commit -m "feat(sale_manage_export): CSV/字段解析纯函数 + node 单测

Why: 采集导出的可测纯逻辑先行（TDD），DOM 部分后续接入
What: sme-utils.js（csvField/buildCsvText/parseInfoFields/buildCsvFileName）+ 9 个单测
Test: node --test features/sale_manage_export/tests/ 全过"
```

> 注意：此时**还没有 feature.json**，全量 build 不受影响（约束遵守）。

---

### Task 2: feature 骨架 + 单页采集 + CSV 落盘（端到端可用，仅当前页）

> 本 task 完成后 feature 已可真实使用（采当前页并导出 CSV），Task 3 再扩展为全分页。

**Files:**
- Create: `features/sale_manage_export/content/index.js`
- Create: `features/sale_manage_export/feature.json`（**最后一步落地**，index.js 完整后才建）

- [ ] **Step 1: 创建 index.js**

创建 `features/sale_manage_export/content/index.js`（模式对照 `features/packing_label/content/index.js`）：

```js
// sale_manage_export：销售管理页（agentseller.temu.com/stock/fully-mgt/sale-manage）
// 采集表格所有分页的 SKC/SKC货号/SPU/商品名称 → CSV 写入预设文件夹。
(function () {
  'use strict';
  const AS = window.AgentSeller;
  const U = AS.utils;
  const sendNative = AS.sendNative;
  const SU = window.__SMEUtils;   // sme-utils.js（document_start 注入）
  const LS_PATH = 'smeSavePath';

  function isSaleManagePage(href) {
    return /agentseller\.temu\.com\/stock\/fully-mgt\/sale-manage/.test(href || location.href);
  }

  // ── 错误分层（debugging-rules 错误文案铁律）─────────────────────────────
  function mkErr(kind, msg) {
    const prefix = { read: '读取失败', data: '数据校验', biz: '不能操作' }[kind] || '错误';
    return new Error(prefix + '：' + msg);
  }

  // ── 保存路径（同 packing_label：localStorage + PICK_FOLDER）──────────────
  function getSavePath() { return localStorage.getItem(LS_PATH) || ''; }
  function setSavePath(p) { localStorage.setItem(LS_PATH, p || ''); }

  async function onPickSavePath() {
    const r = await sendNative('PICK_FOLDER', { title: '选择 CSV 保存文件夹' });
    if (r && r.success && r.path) { setSavePath(r.path); refreshPathUI(); }
  }

  function refreshPathUI() {
    const el = document.getElementById('sme-path-v');
    if (el) el.textContent = getSavePath() || '(未设置)';
  }

  // ── Panel UI ─────────────────────────────────────────────────────────────
  function renderView(viewEl) {
    viewEl.innerHTML = `
      <div class="tal-card" style="display:flex;flex-direction:column;gap:14px;">
        <div class="tal-path-row" id="sme-path-row" title="点击选择保存文件夹" style="cursor:pointer;">
          <span class="tal-path-k">保存到</span>
          <span class="tal-path-v" id="sme-path-v"></span>
        </div>
        <button id="sme-start" class="tal-btn-primary">开始采集</button>
        <div id="sme-status" class="tal-status" style="margin-top:4px;line-height:1.5;"></div>
      </div>`;
    viewEl.querySelector('#sme-path-row').addEventListener('click', onPickSavePath);
    viewEl.querySelector('#sme-start').addEventListener('click', onStart);
    refreshPathUI();
    refreshPageGate();
  }

  // 不在目标页时按钮灰显（业务拦截层提示）
  function refreshPageGate() {
    const btn = document.getElementById('sme-start');
    if (!btn) return;
    const ok = isSaleManagePage();
    btn.disabled = !ok;
    btn.style.opacity = ok ? '' : '0.5';
    btn.style.cursor = ok ? '' : 'not-allowed';
    if (!ok) setStatus('不能操作：请先进入「销售管理」页面再采集');
    else if ((document.getElementById('sme-status') || {}).textContent?.startsWith('不能操作')) setStatus('');
  }

  function setStatus(msg) {
    const el = document.getElementById('sme-status');
    if (el) el.textContent = msg;
  }

  function setRunning(running) {
    const btn = document.getElementById('sme-start');
    if (!btn) return;
    btn.disabled = running;
    btn.style.opacity = running ? '0.5' : '';
    btn.style.cursor = running ? 'not-allowed' : '';
    btn.textContent = running ? '采集中…' : '开始采集';
  }

  // ── 表格扫描（rowspan 分组：每 SKC 组首行含商品信息格；SKU 行/合计行没有）──
  function collectPageGroups() {
    const trs = Array.from(document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]'));
    const groups = [];
    for (const tr of trs) {
      const info = tr.querySelector('td [class*="main_productInfo"]');
      if (!info) continue; // SKU 行 / 合计行
      const nameEl = info.querySelector('[class*="main_productName"]');
      const pTexts = Array.from(info.querySelectorAll('[class*="main_productInfoGrayContent"] p'))
        .map((p) => p.textContent || '');
      const f = SU.parseInfoFields(pTexts);
      groups.push({ skc: f.skc, skcCode: f.skcCode, spu: f.spu, name: (nameEl ? nameEl.textContent : '').trim() });
    }
    return groups;
  }

  // ── CSV 字节 + 分块保存（同 packing_label savePdf 模式）────────────────────
  function bytesToBase64(u8) {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  function joinWin(dir, name) {
    return dir.replace(/[\\/]+$/, '') + '\\' + name;
  }

  async function saveBytes(path, u8) {
    const CHUNK = 512 * 1024;
    let offset = 0, last = null;
    do {
      const slice = u8.subarray(offset, offset + CHUNK);
      const done = offset + slice.length >= u8.length;
      const r = await sendNative('SAVE_FILE_CHUNK', { path, data: bytesToBase64(slice), offset, done });
      if (!r || !r.success) throw mkErr('read', 'CSV 写入失败：' + ((r && r.error) || '未知'));
      offset += slice.length; last = r;
    } while (offset < u8.length);
    return last;
  }

  // ── 采集编排（Task 2 版：仅当前页；Task 3 扩展为全分页）──────────────────
  async function collectAllPages(onProgress) {
    const seen = new Map(); // Map<SKC, row> 去重
    const groups = collectPageGroups();
    if (!groups.length) throw mkErr('read', '当前页未扫描到任何商品组（表格选择器失效或页面未加载完）');
    for (const g of groups) {
      if (!g.skc) throw mkErr('data', '存在缺少 SKC 字段的商品组（商品名：' + (g.name || '').slice(0, 30) + '…）');
      if (!seen.has(g.skc)) seen.set(g.skc, g);
    }
    onProgress && onProgress({ page: 1, count: seen.size });
    return { rows: Array.from(seen.values()), total: null, pagesScanned: 1 };
  }

  async function onStart() {
    const dir = getSavePath();
    if (!dir) { AS.showToast('不能操作：未选择保存文件夹', 'warn'); return; }
    if (!isSaleManagePage()) { AS.showToast('不能操作：当前不在销售管理页', 'warn'); return; }
    setRunning(true);
    setStatus('采集中…');
    try {
      const { rows, total, pagesScanned } = await collectAllPages(({ page, count }) => {
        setStatus(`采集中…第 ${page} 页，已采 ${count} 个 SKC`);
      });
      const csv = SU.buildCsvText(rows);
      const bytes = new TextEncoder().encode('\uFEFF' + csv); // UTF-8 BOM（Excel 中文兼容）
      const path = joinWin(dir, SU.buildCsvFileName(new Date()));
      await saveBytes(path, bytes);
      let msg = `✅ 完成：${pagesScanned} 页共 ${rows.length} 个 SKC → ${path}`;
      if (total != null && rows.length !== total) {
        msg += `（注意：页面「共有 ${total} 条」与采集数不一致，可能为 SKU 计数，请人工核对）`;
      }
      setStatus(msg);
      AS.showToast(`采集完成：${rows.length} 个 SKC`, 'success');
    } catch (err) {
      setStatus('❌ ' + err.message);
      AS.showToast(err.message, 'error');
    } finally {
      setRunning(false);
    }
  }

  AS.registerFeature({
    id: 'sale_manage_export',
    icon: '📊',
    label: '销售清单导出',
    init() { AS.onPageChange(() => refreshPageGate()); },
    render: renderView,
  });
})();
```

- [ ] **Step 2: 落地 feature.json（index.js 已完整，此时才允许创建）**

创建 `features/sale_manage_export/feature.json`：

```json
{
  "id": "sale_manage_export",
  "icon": "📊",
  "label": "销售清单导出",
  "locked": false,
  "order": 7,
  "content_script": "content/index.js",
  "content_matches": ["https://agentseller.temu.com/*"],
  "host_permissions": ["https://agentseller.temu.com/*"],
  "permissions": ["nativeMessaging"],
  "native_host": "com.temu.label_host",
  "extra_content_scripts": [
    {
      "js": ["content/sme-utils.js"],
      "matches": ["https://agentseller.temu.com/*"],
      "run_at": "document_start"
    }
  ]
}
```

> `content_matches` 显式锁定 agentseller（该域已有 FAB，无新增注入面）；sme-utils.js 走 `document_start` 保证先于 index.js 挂上 `window.__SMEUtils`（同 packing_label naming.js 模式）。

- [ ] **Step 3: 全量 build 验证**

Run: `python3 build/build_extension.py`
Expected: 构建成功；`dist/extension/` 下出现 `features/sale_manage_export/`（或对应拷贝路径）；manifest 的 content_scripts 含 sme-utils.js + index.js 两条且 matches 正确。

Run: `ls dist/extension/ && python3 -c "import json; m=json.load(open('dist/extension/manifest.json')); print(json.dumps(m['content_scripts'], ensure_ascii=False, indent=1))"`
Expected: 能看到 sale_manage_export 的脚本注入条目。

- [ ] **Step 4: 手动冒烟（用户配合）**

提示用户：chrome://extensions reload → 打开销售管理页 → FAB → Hub 出现「📊 销售清单导出」→ 选保存文件夹 → 点「开始采集」→ 当前页 SKC 导出 CSV，Excel 打开核对 4 列无乱码。

- [ ] **Step 5: Commit**

```bash
git add features/sale_manage_export/content/index.js features/sale_manage_export/feature.json
git commit -m "feat(sale_manage_export): feature 骨架 + 单页采集导出 CSV

Why: 先打通端到端链路（UI/扫描/去重/BOM CSV/SAVE_FILE_CHUNK），分页循环下一步接入
What: index.js（panel UI + rowspan 组扫描 + CSV 落盘）+ feature.json（content_matches 锁 agentseller）
Test: build 通过；单页冒烟待真实页面验证"
```

---

### Task 3: 全分页采集（回到第 1 页 → 调大每页条数 → 翻页循环 + 内容签名等待）

**Files:**
- Modify: `features/sale_manage_export/content/index.js`（替换 Task 2 的 `collectAllPages`，并在其上方新增分页辅助函数）

- [ ] **Step 1: 在 `collectPageGroups` 之后、`bytesToBase64` 之前插入分页辅助函数**

```js
  // ── 分页器读取与等待 ──────────────────────────────────────────────────────
  function readTotalCount() {
    const el = document.querySelector('[class*="PGT_totalText"]');
    const m = el && (el.textContent || '').match(/共有\s*(\d+)\s*条/);
    return m ? parseInt(m[1], 10) : null;
  }

  function readActivePage() {
    const el = document.querySelector('[class*="PGT_pagerItemActive"]');
    const n = el ? parseInt((el.textContent || '').trim(), 10) : NaN;
    return isNaN(n) ? null : n;
  }

  function isSpinning() {
    const m = document.querySelector('[class*="Spn_spinningMask"]');
    return !!(m && m.offsetParent !== null); // 遮罩存在且可见才算 loading
  }

  // 页面内容签名：激活页码 | 首组 SKC | 本页组数。翻页/改每页条数后签名必变。
  function pageSignature() {
    const g = collectPageGroups();
    return readActivePage() + '|' + (g[0] ? g[0].skc : '') + '|' + g.length;
  }

  // 等表格内容真正变化（auto_ship #47 同款坑：点了下一页 ≠ 表格已刷新）。
  // 就绪条件：spin 遮罩不可见 且 签名 != prevSig 且 首组 SKC 可读。超时抛读取层错误。
  async function waitTableChange(prevSig, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await U.sleep(200);
      if (isSpinning()) continue;
      const sig = pageSignature();
      if (sig !== prevSig && sig.split('|')[1]) return sig;
    }
    throw mkErr('read', '表格刷新超时（' + timeoutMs + 'ms 内容未变化），采集中止');
  }

  // 回到第 1 页（用户可能停在第 N 页点开始；不回头会漏采前面的页）
  async function gotoFirstPage() {
    if ((readActivePage() || 1) === 1) return;
    const first = Array.from(document.querySelectorAll('[class*="PGT_pagerItem"]'))
      .find((el) => (el.textContent || '').trim() === '1');
    if (!first) throw mkErr('read', '未找到第 1 页页码按钮');
    const prevSig = pageSignature();
    first.click();
    await waitTableChange(prevSig, 15000);
  }

  // 调大每页条数（best-effort）：打开 size select → 在 portal 下拉里选最大数字项 → 写后读校验。
  // 任何一步找不到 DOM → 关闭下拉、返回 {changed:false, reason}，调用方降级按当前条数翻页（不中止）。
  async function maximizePageSize() {
    const sizeSel = document.querySelector('[class*="PGT_sizeChanger"] [data-testid="beast-core-select"]');
    if (!sizeSel) return { changed: false, reason: '未找到每页条数选择器' };
    const input = sizeSel.querySelector('input[data-testid="beast-core-select-htmlInput"]');
    const cur = input ? parseInt(input.value, 10) : NaN;
    const pagRoot = document.querySelector('[data-testid="beast-core-pagination"]');
    const header = sizeSel.querySelector('[data-testid="beast-core-select-header"]');
    if (!header) return { changed: false, reason: '未找到 select header' };
    header.click(); // 打开下拉（选项渲染在 body 末尾 portal）
    // 等候选项：纯数字、可见、且不在分页器内（排除页码 li 1/2/3…）
    let opts = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await U.sleep(150);
      opts = Array.from(document.querySelectorAll('[class*="ST_option"], li'))
        .filter((el) => /^\d+$/.test((el.textContent || '').trim()))
        .filter((el) => el.offsetParent !== null)
        .filter((el) => !(pagRoot && pagRoot.contains(el)));
      if (opts.length) break;
    }
    if (!opts.length) {
      document.body.click(); // 关掉下拉
      return { changed: false, reason: '未找到每页条数下拉选项' };
    }
    const best = opts.reduce((a, b) =>
      parseInt(a.textContent.trim(), 10) >= parseInt(b.textContent.trim(), 10) ? a : b);
    const want = parseInt(best.textContent.trim(), 10);
    if (!isNaN(cur) && want <= cur) { document.body.click(); return { changed: false, reason: '当前已是最大条数' }; }
    const prevSig = pageSignature();
    best.click();
    // 写后读校验（表单自动化铁律）：回读 select 值 == 期望
    const vDeadline = Date.now() + 5000;
    while (Date.now() < vDeadline) {
      await U.sleep(150);
      const v = parseInt((sizeSel.querySelector('input[data-testid="beast-core-select-htmlInput"]') || {}).value, 10);
      if (v === want) break;
      if (Date.now() + 150 >= vDeadline) throw mkErr('data', '每页条数填写后不符，期望「' + want + '」实际「' + v + '」');
    }
    // 等表格按新条数刷新；若结果集小到内容签名不变（如总数 ≤ 原每页数），超时降级继续
    try { await waitTableChange(prevSig, 8000); } catch (e) { console.warn('[SME] 改条数后表格签名未变化，按已校验值继续：', e.message); }
    return { changed: true, size: want };
  }
```

- [ ] **Step 2: 用全分页版替换 Task 2 的 `collectAllPages`**

```js
  // ── 采集编排（全分页：回第 1 页 → 调大条数 → 扫页/去重/翻页直到末页）──────
  async function collectAllPages(onProgress) {
    if (!document.querySelector('tr[data-testid="beast-core-table-body-tr"]')) {
      throw mkErr('read', '未找到结果表格（请先执行查询并等待结果加载）');
    }
    if (!document.querySelector('[data-testid="beast-core-pagination"]')) {
      throw mkErr('read', '未找到分页器');
    }
    const total = readTotalCount();
    const sizeR = await maximizePageSize();
    if (!sizeR.changed) console.warn('[SME] 每页条数未调整：', sizeR.reason);
    await gotoFirstPage();

    const seen = new Map(); // Map<SKC, row> 去重（防表格未刷新重复扫）
    let pagesScanned = 0;
    for (let guard = 0; guard < 500; guard++) {
      const page = readActivePage() || pagesScanned + 1;
      const groups = collectPageGroups();
      if (!groups.length) throw mkErr('read', '第 ' + page + ' 页未扫描到任何商品组（表格选择器失效或页面异常）');
      for (const g of groups) {
        if (!g.skc) throw mkErr('data', '第 ' + page + ' 页存在缺少 SKC 字段的商品组（商品名：' + (g.name || '').slice(0, 30) + '…）');
        if (!seen.has(g.skc)) seen.set(g.skc, g);
      }
      pagesScanned += 1;
      onProgress && onProgress({ page, count: seen.size });
      const next = document.querySelector('[data-testid="beast-core-pagination-next"]');
      if (!next) throw mkErr('read', '未找到下一页按钮');
      if (/PGT_disabled/.test(next.className)) break; // 末页
      const prevSig = pageSignature();
      next.click();
      await waitTableChange(prevSig, 15000);
    }
    return { rows: Array.from(seen.values()), total, pagesScanned };
  }
```

- [ ] **Step 3: 单测回归 + build**

Run: `node --test features/sale_manage_export/tests/ && python3 build/build_extension.py`
Expected: 单测全过；build 成功。

- [ ] **Step 4: 手动端到端验证（用户配合，对照 spec 第 8 节验证清单）**

提示用户 reload 扩展后在真实页面跑：
1. 全量（310 条 / 31 页）：观察状态区页码推进、完成后 CSV 行数 == 页面 SKC 组数；console 留意「共有 N 条」语义（SKC or SKU 计数）。
2. 带搜索条件的小结果集。
3. 单页结果（next 一开始就 disabled）。
4. Excel 打开：无乱码、含逗号商品名不串列、无重复 SKC。

- [ ] **Step 5: Commit**

```bash
git add features/sale_manage_export/content/index.js
git commit -m "feat(sale_manage_export): 全分页采集（调大每页条数 + 内容签名等待 + SKC 去重）

Why: 覆盖所有分页且不重复是核心需求；翻页后必须等内容真正变化（auto_ship #47 同款坑）
What: maximizePageSize（写后读校验+降级）/ gotoFirstPage / waitTableChange（签名轮询）/ collectAllPages 全分页版
Test: 单测回归过；build 过；端到端待真实页面验证"
```

---

### Task 4: feature CLAUDE.md + 收尾验证

**Files:**
- Create: `features/sale_manage_export/CLAUDE.md`

- [ ] **Step 1: 写 feature 文档**

创建 `features/sale_manage_export/CLAUDE.md`：

```markdown
# sale_manage_export Feature

> 顶层架构见项目根 `CLAUDE.md`。本文档只覆盖本 feature 细节。

## 作用

销售管理页（`https://agentseller.temu.com/stock/fully-mgt/sale-manage/main`）一键采集
结果表格**所有分页**的 SKC / SKC货号 / SPU / 商品名称（SKC 粒度），按 SKC 去重后导出
UTF-8 BOM CSV（`销售管理清单_YYYYMMDD_HHMMSS.csv`）到预设文件夹。

## 文件

- `content/sme-utils.js` — 纯函数（CSV 转义 / 字段解析 / 文件名），双导出，document_start 注入挂 `window.__SMEUtils`
- `content/index.js` — panel UI + 表格扫描 + 分页循环 + SAVE_FILE_CHUNK 落盘
- `tests/sme-utils.test.js` — `node --test`

## 表格 DOM 关键事实

- Beast UI 表格，class 带版本 hash（`_5-120-1`）→ selector 一律 `data-testid` / `class*=` 前缀。
- rowspan 分组：每 SKC 组 = 首行（含商品信息格，四字段都在这）+ N 个 SKU 行 + 1 个「合计」行（无商品信息格，扫描时自然跳过）。
- 标准分页器（非虚拟滚动）：`beast-core-pagination`；末页 next 含 `PGT_disabled`。

## 采集流程与坑

1. 回第 1 页（用户可能停在第 N 页点开始）。
2. `maximizePageSize`：best-effort 调大每页条数，写后读校验；下拉选项在 body portal，
   过滤「纯数字 + 可见 + 不在分页器内」防止误点页码；失败降级按当前条数翻页。
3. 逐页 `collectPageGroups` → `Map<SKC,row>` 去重 → 点 next → `waitTableChange`。
4. **翻页后必须等内容签名（激活页|首组SKC|组数）变化**，spin 遮罩消失不够（auto_ship #47 同款坑）。
5. 任一页 0 组 / 缺 SKC 字段 → 立即中止不写文件；错误文案分「读取失败/数据校验/不能操作」三层。
6. 「共有 N 条」与采集 SKC 数不一致时只提示不硬校验（N 可能为 SKU 计数）。

## native host 用法（不新增 action）

`PICK_FOLDER`（保存目录，localStorage `smeSavePath`）+ `SAVE_FILE_CHUNK`（512KB 分块写 CSV）。
```

- [ ] **Step 2: 最终回归**

Run: `node --test features/sale_manage_export/tests/ && python3 build/build_extension.py`
Expected: 全过。

- [ ] **Step 3: Commit**

```bash
git add features/sale_manage_export/CLAUDE.md
git commit -m "docs(sale_manage_export): feature 文档（DOM 事实 + 采集流程坑位）

Why: 沉淀 selector 事实与翻页等待坑，Temu 改版时可快速复核
What: features/sale_manage_export/CLAUDE.md
Test: not run (docs only)"
```

- [ ] **Step 4: 完成后走 superpowers:finishing-a-development-branch**（用户确认端到端验证通过后再提 PR，遵循 shipping-rules 触发词协议）
