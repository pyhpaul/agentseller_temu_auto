# packing_label Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在跨境后台「待仓库收货」页，勾选发货批次行后一键连续打印选中行下所有商品的打包标签，每张 PDF 静默保存到预设文件夹、命名 `承运商_单号_数量件_贴标自提.pdf`。

**Architecture:** 三层——main world content script（`inject-main.js`）hook `URL.createObjectURL` 捕获 PDF blob 字节 + 拦掉 blob iframe 的打印预览；isolated content script（`index.js`）驱动批量串行流程并经 `SAVE_FILE_CHUNK` 写盘；共享顶层 `native_host/` 负责写文件（已就绪）。纯命名函数拆到 `naming.js` 走 node 单测。

**Tech Stack:** Chrome MV3 content scripts（vanilla JS, IIFE + `window.AgentSeller` core API）、Native Messaging、Python native host、Node 内置 test runner（`node --test`）做纯函数单测。

设计依据：`docs/superpowers/specs/2026-05-25-packing-label-feature-design.md`

---

## Open Issues 的决议（spec §13）

1. **撞名去重**：放 **isolated 侧**，用现有 `READ_FILE_SIZE` 探测目标路径是否存在，存在则递增 `_2`/`_3` 直到不存在。**不改 native host**。
2. **打印拦截兜底**：实现 `Document.prototype.createElement` 的 iframe `load` capture 监听器置空 `contentWindow.print`。Task 2 先做最小验证；若真实页面拦不住，退化为"预览弹出但字节已存盘"（不丢数据），不再加更激进手段。
3. **捕获超时**：点打印后等 `8000ms`，超时判该商品"未捕获到 PDF"，计入失败明细、继续下一个。

## File Structure

| 文件 | 责任 | 注入方式 |
|------|------|---------|
| `features/packing_label/content/naming.js` | 纯函数：物流单号拆分、文件名构造、非法字符清洗（双用途 browser/node 导出） | isolated extra_content_script，`run_at:"document_start"`（早于 index.js） |
| `features/packing_label/content/inject-main.js` | main world：捕获 application/pdf blob 字节 + 拦截 blob iframe 打印 | extra_content_script，`world:"MAIN"`、`run_at:"document_start"` |
| `features/packing_label/content/index.js` | isolated：registerFeature + 预设路径 UI + 批量串行引擎 | feature.json `content_script`（主入口，document_idle） |
| `features/packing_label/tests/naming.test.js` | naming.js 的 node 单测 | — |
| `features/packing_label/feature.json` | 元数据 + content_script + extra_content_scripts + 权限 | **最后创建**（content script 齐全前不建，否则破坏全量 build） |
| `features/packing_label/CLAUDE.md` | feature 文档 | — |

> samples 已在 `features/packing_label/samples/`。native_host **不动**（复用共享 `SAVE_FILE_CHUNK`、`READ_FILE_SIZE`）。

---

## Task 1: naming.js 纯命名函数（TDD，node 单测）

**Files:**
- Create: `features/packing_label/content/naming.js`
- Test: `features/packing_label/tests/naming.test.js`

- [ ] **Step 1: 写失败测试**

`features/packing_label/tests/naming.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseTrackingInfo, sanitizeSegment, buildBaseFileName } = require('../content/naming.js');

test('parseTrackingInfo: 中文逗号拆分承运商/单号', () => {
  assert.deepStrictEqual(
    parseTrackingInfo('极兔速递，JT0023769813149'),
    { carrier: '极兔速递', trackingNo: 'JT0023769813149' }
  );
});

test('parseTrackingInfo: 英文逗号同样支持', () => {
  assert.deepStrictEqual(
    parseTrackingInfo('韵达快递,313024122184033'),
    { carrier: '韵达快递', trackingNo: '313024122184033' }
  );
});

test('parseTrackingInfo: 缺单号段返回空串', () => {
  assert.deepStrictEqual(parseTrackingInfo('极兔速递'), { carrier: '极兔速递', trackingNo: '' });
});

test('sanitizeSegment: 去 Windows 非法文件名字符', () => {
  assert.strictEqual(sanitizeSegment('JT/00:1*?"<>|'), 'JT001');
});

test('buildBaseFileName: 完整拼接 + 后缀', () => {
  assert.strictEqual(
    buildBaseFileName({ carrier: '极兔速递', trackingNo: 'JT0023769813149', qty: '20件' }),
    '极兔速递_JT0023769813149_20件_贴标自提.pdf'
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test features/packing_label/tests/naming.test.js`
Expected: FAIL（`Cannot find module '../content/naming.js'`）

- [ ] **Step 3: 实现 naming.js**

`features/packing_label/content/naming.js`:

```js
// 纯函数：物流单号拆分 + 文件名构造 + 非法字符清洗。
// 双用途：浏览器挂 window.__PLNaming；node 测试用 module.exports。
(function () {
  'use strict';

  // "极兔速递，JT0023769813149" → {carrier, trackingNo}。支持中/英文逗号，只取前两段。
  function parseTrackingInfo(raw) {
    const text = String(raw == null ? '' : raw).trim();
    const parts = text.split(/[，,]/).map((s) => s.trim());
    return { carrier: parts[0] || '', trackingNo: parts[1] || '' };
  }

  // 去 Windows 非法文件名字符 \ / : * ? " < > | 及控制字符。
  function sanitizeSegment(s) {
    return String(s == null ? '' : s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim();
  }

  // {carrier, trackingNo, qty} → "承运商_单号_数量件_贴标自提.pdf"
  function buildBaseFileName({ carrier, trackingNo, qty }) {
    const segs = [carrier, trackingNo, qty, '贴标自提'].map(sanitizeSegment);
    return segs.join('_') + '.pdf';
  }

  const api = { parseTrackingInfo, sanitizeSegment, buildBaseFileName };
  if (typeof window !== 'undefined') window.__PLNaming = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test features/packing_label/tests/naming.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add features/packing_label/content/naming.js features/packing_label/tests/naming.test.js
git commit -m "feat(packing_label): naming 纯函数（单号拆分/文件名构造/清洗）+ node 单测"
```

---

## Task 2: inject-main.js（main world 捕获 + 打印拦截）— 最高风险，最先做最小验证

**Files:**
- Create: `features/packing_label/content/inject-main.js`

- [ ] **Step 1: 实现 inject-main.js**

`features/packing_label/content/inject-main.js`:

```js
// 运行在 page MAIN world（feature.json: world:"MAIN", run_at:"document_start"）。
// 职责：① 捕获 application/pdf blob 字节 ② 拦截该 blob iframe 的打印预览。
// 仅在 isolated 侧开启「捕获模式」时介入；关闭时页面原行为不变。
(function () {
  'use strict';
  if (window.__PL_INJECTED__) return;
  window.__PL_INJECTED__ = true;

  let captureMode = false;
  let pendingCtxId = null;

  // isolated → main 控制消息
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__pl !== 'ctrl') return;
    if (e.data.action === 'start') { captureMode = true; pendingCtxId = e.data.ctxId ?? null; }
    else if (e.data.action === 'setCtx') { pendingCtxId = e.data.ctxId ?? null; }
    else if (e.data.action === 'stop') { captureMode = false; pendingCtxId = null; }
  });

  // ① 捕获 PDF blob 字节
  const origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const url = origCreate(obj);
    try {
      if (captureMode && obj instanceof Blob && obj.type === 'application/pdf') {
        const ctxId = pendingCtxId;
        obj.arrayBuffer()
          .then((buf) => window.postMessage({ __pl: 'pdf', ctxId, bytes: buf }, '*', [buf]))
          .catch((err) => window.postMessage({ __pl: 'pdferr', ctxId, error: String(err) }, '*'));
      }
    } catch (_) { /* 捕获失败不影响页面原流程 */ }
    return url;
  };

  // ② 拦截打印预览：页面 <iframe src=blob:> + iframe.contentWindow.print() 弹预览。
  // hook createElement，对 iframe 抢先注册 capture 阶段 load 监听器置空 print（先于页面 onload 执行）。
  const origCreateEl = Document.prototype.createElement;
  Document.prototype.createElement = function (tagName, ...rest) {
    const el = origCreateEl.call(this, tagName, ...rest);
    try {
      if (captureMode && String(tagName).toLowerCase() === 'iframe') {
        el.addEventListener('load', function () {
          try { if (el.contentWindow) el.contentWindow.print = function () {}; } catch (_) {}
        }, { capture: true, once: true });
      }
    } catch (_) {}
    return el;
  };
})();
```

- [ ] **Step 2: 语法检查**

Run: `node --check features/packing_label/content/inject-main.js`
Expected: 无输出（exit 0）

- [ ] **Step 3: 最小手动验证（Windows + 真实页面）**

> 此时 feature.json 还没建，inject-main 不会自动注入。先用 Console 手测拦截+捕获是否成立——这是整个 feature 可行性的关键闸门。

在 shipping-list 页 Console 粘贴 inject-main.js 内容（去掉 IIFE 外层即可直接跑 hook），再粘：
```js
window.postMessage({ __pl: 'ctrl', action: 'start', ctxId: 'test1' }, '*');
window.addEventListener('message', (e) => { if (e.data && e.data.__pl === 'pdf') console.log('[PL] 捕获到 PDF bytes:', e.data.bytes.byteLength, 'ctxId=', e.data.ctxId); });
```
然后点一个商品「打印商品打包标签」走到 confirm/打印。
**期望**：Console 打出 `[PL] 捕获到 PDF bytes: ~600000 ctxId= test1`，且**打印预览不弹出**。

- [ ] **Step 4: 记录验证结果**

- 若捕获 ✓ 且预览不弹 ✓ → 继续。
- 若捕获 ✓ 但预览仍弹 → 接受退化（字节已存盘），在 CLAUDE.md 记已知限制，继续。
- 若捕获 ✗ → 停下，回 spec §6 重新分析（不要继续后续 task）。

- [ ] **Step 5: 提交**

```bash
git add features/packing_label/content/inject-main.js
git commit -m "feat(packing_label): main world PDF blob 捕获 + 打印预览拦截"
```

---

## Task 3: index.js 骨架 + 预设路径 UI

**Files:**
- Create: `features/packing_label/content/index.js`

- [ ] **Step 1: 写 index.js 骨架（注册 + feature view + 预设路径）**

`features/packing_label/content/index.js`:

```js
// packing_label：待仓库收货页批量打印商品打包标签 → 静默保存到预设文件夹。
(function () {
  'use strict';
  const AS = window.AgentSeller;
  const U = AS.utils;
  const sendNative = AS.sendNative;
  const LS_PATH = 'plSavePath';

  function isShippingListPage(href) {
    return /seller\.kuajingmaihuo\.com\/main\/order-manager\/shipping-list/.test(href || location.href);
  }

  function getSavePath() { return localStorage.getItem(LS_PATH) || ''; }
  function setSavePath(p) { localStorage.setItem(LS_PATH, p || ''); }

  async function onPickSavePath() {
    const r = await sendNative('PICK_FOLDER', { title: '选择标签保存文件夹' });
    if (r && r.success && r.path) { setSavePath(r.path); refreshPathUI(); }
  }

  function refreshPathUI() {
    const el = document.getElementById('pl-path-v');
    if (el) el.textContent = getSavePath() || '(未设置)';
  }

  function renderView(viewEl) {
    viewEl.innerHTML = `
      <div class="tal-card">
        <div class="tal-card-title">打包标签</div>
        <div class="tal-path-row" id="pl-path-row" title="点击选择保存文件夹">
          <span class="tal-path-k">保存到</span>
          <span class="tal-path-v" id="pl-path-v"></span>
        </div>
        <button id="pl-start" class="tal-btn-primary">开始打印选中商品</button>
        <div id="pl-status" class="tal-status"></div>
      </div>`;
    viewEl.querySelector('#pl-path-row').addEventListener('click', onPickSavePath);
    viewEl.querySelector('#pl-start').addEventListener('click', onStart);
    refreshPathUI();
  }

  function setStatus(msg) {
    const el = document.getElementById('pl-status');
    if (el) el.textContent = msg;
  }

  async function onStart() { /* Task 7 实现 */ setStatus('（引擎未实现）'); }

  AS.registerFeature({
    id: 'packing_label',
    icon: '🏷️',
    label: '打包标签',
    init() { AS.onPageChange(() => {}); },
    render: renderView,
  });
})();
```

> CSS class（`tal-card`/`tal-path-row`/`tal-btn-primary` 等）复用 core/auto_gen_label 已有样式；若样式缺失，实现时在 view 内联 style 即可，不阻断功能。

- [ ] **Step 2: 语法检查**

Run: `node --check features/packing_label/content/index.js`
Expected: exit 0

- [ ] **Step 3: 提交**

```bash
git add features/packing_label/content/index.js
git commit -m "feat(packing_label): index.js 骨架 + 预设保存路径 UI"
```

---

## Task 4: index.js — main world 消息桥 + 捕获等待

**Files:**
- Modify: `features/packing_label/content/index.js`（在 IIFE 内、`registerFeature` 调用之前加）

- [ ] **Step 1: 加捕获模式控制 + 等待函数**

在 `onStart` 上方插入：

```js
  function ctrl(action, ctxId) {
    window.postMessage({ __pl: 'ctrl', action, ctxId: ctxId ?? null }, '*');
  }

  // 等 main world 回传指定 ctxId 的 PDF 字节（ArrayBuffer），超时 reject。
  function awaitPdfCapture(ctxId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        reject(new Error('未捕获到标签 PDF（超时）'));
      }, timeoutMs);
      function onMsg(e) {
        if (e.source !== window || !e.data) return;
        if (e.data.__pl === 'pdf' && e.data.ctxId === ctxId) {
          clearTimeout(timer); window.removeEventListener('message', onMsg); resolve(e.data.bytes);
        } else if (e.data.__pl === 'pdferr' && e.data.ctxId === ctxId) {
          clearTimeout(timer); window.removeEventListener('message', onMsg); reject(new Error(e.data.error));
        }
      }
      window.addEventListener('message', onMsg);
    });
  }
```

- [ ] **Step 2: 语法检查**

Run: `node --check features/packing_label/content/index.js`
Expected: exit 0

- [ ] **Step 3: 提交**

```bash
git add features/packing_label/content/index.js
git commit -m "feat(packing_label): main world 消息桥 + PDF 捕获等待（带超时）"
```

---

## Task 5: index.js — 分块保存 + 撞名去重

**Files:**
- Modify: `features/packing_label/content/index.js`

- [ ] **Step 1: 加 base64、分块写、去重路径解析**

```js
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

  // 用 READ_FILE_SIZE 探测：不存在即可用；存在则 _2/_3… 递增。
  async function resolveUniquePath(dir, baseName) {
    const dot = baseName.lastIndexOf('.');
    const stem = dot >= 0 ? baseName.slice(0, dot) : baseName;
    const ext = dot >= 0 ? baseName.slice(dot) : '';
    let candidate = baseName, n = 1;
    for (let guard = 0; guard < 999; guard++) {
      const r = await sendNative('READ_FILE_SIZE', { path: joinWin(dir, candidate) });
      if (!r || !r.success) return joinWin(dir, candidate); // 不存在 → 用它
      n += 1;
      candidate = stem + '_' + n + ext;
    }
    return joinWin(dir, stem + '_' + Date.now() + ext); // 极端兜底
  }

  // 分块写（512KB/块，base64 膨胀后 < Native Messaging 1MB 限制）
  async function savePdf(path, arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const CHUNK = 512 * 1024;
    if (u8.length === 0) {
      const r = await sendNative('SAVE_FILE_CHUNK', { path, data: '', offset: 0, done: true });
      if (!r || !r.success) throw new Error((r && r.error) || '保存失败');
      return r;
    }
    let offset = 0, last = null;
    while (offset < u8.length) {
      const slice = u8.subarray(offset, offset + CHUNK);
      const done = offset + slice.length >= u8.length;
      const r = await sendNative('SAVE_FILE_CHUNK', {
        path, data: bytesToBase64(slice), offset, done,
      });
      if (!r || !r.success) throw new Error((r && r.error) || '保存失败');
      offset += slice.length; last = r;
    }
    return last;
  }
```

- [ ] **Step 2: 语法检查**

Run: `node --check features/packing_label/content/index.js`
Expected: exit 0

- [ ] **Step 3: 提交**

```bash
git add features/packing_label/content/index.js
git commit -m "feat(packing_label): 分块写盘 + READ_FILE_SIZE 撞名去重"
```

---

## Task 6: index.js — confirm 弹窗处理（自动勾选 + 继续打印）

**Files:**
- Modify: `features/packing_label/content/index.js`

> ⚠️ 选择器需对照运行时 DOM 确认（spec §7）。confirm 弹窗里：checkbox `[data-testid="beast-core-checkbox"]`（文字「30天内不再提醒」，状态 `data-checked`），确认按钮 `[data-testid="beast-core-button"]` 内 span 文字「继续打印」。**实现时先 dump 一次真实 confirm 弹窗 DOM 校验**（confirm_window.txt 是「补打」变体，首次弹窗文案可能不同但结构一致）。

- [ ] **Step 1: 加 confirm 处理**

```js
  function findActiveModal() {
    const wraps = document.querySelectorAll('[data-testid="beast-core-modal-innerWrapper"], [data-testid="beast-core-modal-inner"]');
    return wraps.length ? wraps[wraps.length - 1] : null;
  }

  function findContinueBtn(scope) {
    const root = scope || document;
    return Array.from(root.querySelectorAll('[data-testid="beast-core-button"]'))
      .find((b) => { const s = b.querySelector('span'); return s && s.textContent.trim() === '继续打印'; }) || null;
  }

  // 在 timeoutMs 内等 confirm 弹窗；出现则勾「30天不再提醒」+ 点「继续打印」，返回 true；没弹返回 false。
  async function handleConfirmIfPresent(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const modal = findActiveModal();
      const btn = modal && findContinueBtn(modal);
      if (btn) {
        const cb = modal.querySelector('[data-testid="beast-core-checkbox"]');
        if (cb && cb.getAttribute('data-checked') === 'false') {
          const input = cb.querySelector('input[type="checkbox"]') || cb;
          input.click();
          await U.sleep(80);
        }
        btn.click();
        return true;
      }
      await U.sleep(150);
    }
    return false; // 没弹（已勾过 30 天）
  }
```

- [ ] **Step 2: 语法检查**

Run: `node --check features/packing_label/content/index.js`
Expected: exit 0

- [ ] **Step 3: 提交**

```bash
git add features/packing_label/content/index.js
git commit -m "feat(packing_label): confirm 弹窗自动勾选+继续打印（可选弹窗）"
```

---

## Task 7: index.js — 商品枚举 + 批量串行引擎

**Files:**
- Modify: `features/packing_label/content/index.js`（替换 Task 3 的占位 `onStart`）

> ⚠️ **行→商品 DOM 嵌套需先 dump 真实页面确认**（whole_page.txt 未完整暴露每行内多商品的嵌套）。实现第一步：在选中行场景下 dump 5-10 个真实商品块，确认：选中行如何判定（首列 checkbox checked）、每行内每个商品块如何定位、商品块内「发货数量」与「打印商品打包标签」按钮、以及该行「物流单号」取值节点。下面是策略骨架，选择器按 dump 落实。

- [ ] **Step 1: 加枚举 + 引擎，替换 onStart**

```js
  // 选中行下、未 disabled 的「打印商品打包标签」按钮 + 命名信息。
  // 选择器对照运行时 DOM 落实（见本 task 提示）。
  function collectPrintTargets() {
    const targets = [];
    // 选中行：首列 checkbox 勾选的行。按运行时 DOM 用合适的行容器选择器。
    const rows = Array.from(document.querySelectorAll('tr')).filter((tr) => {
      const cb = tr.querySelector('[data-testid="beast-core-checkbox"] input[type="checkbox"]');
      return cb && cb.checked;
    });
    for (const row of rows) {
      // 行内物流单号：「物流单号：」后的 <a data-testid="beast-core-button-link"> 文本
      const trackingRaw = extractTrackingRaw(row);
      // 行内每个商品块（含发货数量 + 打印按钮）
      const printBtns = Array.from(row.querySelectorAll('a[data-testid="beast-core-button-link"]'))
        .filter((a) => { const s = a.querySelector('span'); return s && s.textContent.trim() === '打印商品打包标签'; })
        .filter((a) => !a.hasAttribute('disabled'));
      for (const btn of printBtns) {
        const qty = extractQtyForButton(btn); // 形如 "20件"
        targets.push({ btn, trackingRaw, qty });
      }
    }
    return targets;
  }

  function extractTrackingRaw(row) {
    const links = Array.from(row.querySelectorAll('a[data-testid="beast-core-button-link"] span'));
    const hit = links.find((s) => /[，,]/.test(s.textContent) && /\d{6,}/.test(s.textContent));
    return hit ? hit.textContent.trim() : '';
  }

  function extractQtyForButton(btn) {
    // 从按钮所在商品块向上找含「发货数量：」的容器，取其后的 "NN件"
    let node = btn;
    for (let i = 0; i < 6 && node; i++) {
      const m = (node.textContent || '').match(/发货数量：?\s*(\d+件)/);
      if (m) return m[1];
      node = node.parentElement;
    }
    return '';
  }

  async function onStart() {
    const dir = getSavePath();
    if (!dir) { AS.showToast('请先设置保存文件夹', 'warn'); return; }
    const targets = collectPrintTargets();
    if (!targets.length) { AS.showToast('没有可打印的选中商品', 'warn'); return; }

    ctrl('start');
    let ok = 0; const fails = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const ctxId = 'pl-' + Date.now() + '-' + i;
        setStatus(`打印中 ${i + 1}/${targets.length}…`);
        try {
          const info = window.__PLNaming.parseTrackingInfo(t.trackingRaw);
          const baseName = window.__PLNaming.buildBaseFileName({
            carrier: info.carrier, trackingNo: info.trackingNo, qty: t.qty,
          });
          ctrl('setCtx', ctxId);
          t.btn.click();
          await handleConfirmIfPresent(2500);       // 可选 confirm
          const bytes = await awaitPdfCapture(ctxId, 8000);
          const path = await resolveUniquePath(dir, baseName);
          await savePdf(path, bytes);
          ok += 1;
        } catch (err) {
          fails.push(`#${i + 1}: ${err.message}`);
        }
        await U.sleep(300); // 两次打印间留缓冲
      }
    } finally {
      ctrl('stop');
    }
    setStatus(`完成：成功 ${ok}/${targets.length}` + (fails.length ? `；失败 ${fails.length}` : ''));
    if (fails.length) { console.warn('[PL] 失败明细:', fails); AS.showToast(`成功 ${ok}，失败 ${fails.length}（看 console）`, fails.length ? 'warn' : 'success'); }
    else { AS.showToast(`全部完成：${ok} 个`, 'success'); }
  }
```

- [ ] **Step 2: 语法检查**

Run: `node --check features/packing_label/content/index.js`
Expected: exit 0

- [ ] **Step 3: 提交**

```bash
git add features/packing_label/content/index.js
git commit -m "feat(packing_label): 商品枚举 + 批量串行打印引擎（捕获→去重→存盘）"
```

---

## Task 8: feature.json（最后创建）+ 全量 build 验证

**Files:**
- Create: `features/packing_label/feature.json`

> 现在 3 个 content script 都齐了，才创建 feature.json（CLAUDE.md 反模式：content_script 未齐前建 feature.json 会 hard fail 全量 build）。

- [ ] **Step 1: 写 feature.json**

`features/packing_label/feature.json`:

```json
{
  "id": "packing_label",
  "icon": "🏷️",
  "label": "打包标签",
  "locked": false,
  "order": 5,
  "content_script": "content/index.js",
  "content_matches": ["https://seller.kuajingmaihuo.com/*"],
  "host_permissions": ["https://seller.kuajingmaihuo.com/*"],
  "permissions": ["nativeMessaging", "storage"],
  "native_host": "com.temu.label_host",
  "extra_content_scripts": [
    {
      "js": ["content/naming.js"],
      "matches": ["https://seller.kuajingmaihuo.com/*"],
      "run_at": "document_start"
    },
    {
      "js": ["content/inject-main.js"],
      "matches": ["https://seller.kuajingmaihuo.com/*"],
      "run_at": "document_start",
      "world": "MAIN"
    }
  ]
}
```

> `order:5` 接现有最大 order 之后（实现时 `ls features/*/feature.json` 核对，取最大+1）。`content_matches` 限定本页域名，避免 FAB 注入到其它页（见全局记忆「content_matches 与 host_permissions 分离」）。

- [ ] **Step 2: 全量构建验证**

Run: `python3 build/build_extension.py`
Expected: exit 0，输出含 packing_label 的 content_script + 2 条 extra cs（naming.js、inject-main.js），manifest 生成成功。

- [ ] **Step 3: 校验 manifest 注入正确**

Run: `python3 -c "import json; m=json.load(open('dist/extension/manifest.json')); cs=m['content_scripts']; print('entries:', len(cs)); print([ (e.get('world','ISOLATED'), e.get('run_at'), [j for j in e['js'] if 'packing_label' in j]) for e in cs if any('packing_label' in j for j in e['js']) ])"`
Expected: 能看到一条 `world:"MAIN"` 含 `inject-main.js`、一条 isolated `document_start` 含 `naming.js`、主 entry 含 `index.js`。

- [ ] **Step 4: 提交**

```bash
git add features/packing_label/feature.json
git commit -m "feat(packing_label): feature.json（含 MAIN world inject + naming 注入）"
```

---

## Task 9: CLAUDE.md feature 文档

**Files:**
- Create: `features/packing_label/CLAUDE.md`

- [ ] **Step 1: 写 CLAUDE.md**

`features/packing_label/CLAUDE.md`（要点，按实现实况补全）：

```markdown
# packing_label Feature

> 顶层架构见项目根 CLAUDE.md。本文档只覆盖本 feature 细节。

## 作用
待仓库收货页（seller.kuajingmaihuo.com/main/order-manager/shipping-list）批量打印选中行下
所有商品的打包标签，每张 PDF 静默存到预设文件夹，命名 `承运商_单号_数量件_贴标自提.pdf`。

## 技术核心：拦截 PDF blob，绕过打印对话框
页面点打印 → 构造 application/pdf blob → createObjectURL → <iframe src=blob:> →
contentWindow.print() 弹 Chrome 打印预览（chrome://print，content script 无法控制）。
本 feature 在 MAIN world hook createObjectURL 抓 blob 字节 + 拦掉 iframe 的 print，
字节经 isolated 侧 SAVE_FILE_CHUNK 写预设文件夹。

## 文件
- content/inject-main.js — MAIN world：捕获 + 拦截（document_start）
- content/naming.js — 纯命名函数（isolated, document_start；双 browser/node 导出）
- content/index.js — isolated：UI + 批量串行引擎
- tests/naming.test.js — node 单测

## native host
复用共享 com.temu.label_host 的 SAVE_FILE_CHUNK（写）+ READ_FILE_SIZE（去重探测）。不新增 action。

## 已知限制
（按 Task 2 验证结果填：打印拦截是否 100% 可靠、退化行为等）
```

- [ ] **Step 2: 提交**

```bash
git add features/packing_label/CLAUDE.md
git commit -m "docs(packing_label): feature CLAUDE.md"
```

---

## Task 10: Windows 端到端手动验证

**Files:** 无（验证 task）

> 浏览器 + native host 联调无法在 Linux 自动化，必须 Windows 实测。

- [ ] **Step 1: 构建 + reload**

Run: `python3 build/build_extension.py`，然后 `chrome://extensions` reload 扩展（dev_install 不用重跑——native_host 未动）。

- [ ] **Step 2: 端到端验证**

1. 进 shipping-list「待仓库收货」tab，打开 feature panel「打包标签」view
2. 点「保存到」选一个文件夹（确认 PICK_FOLDER 弹窗正常——若卡死见记忆 [[feedback-native-host-dev-install]] pick 卡死恢复）
3. 勾选 2-3 个发货批次行（含一行多商品的情况）
4. 点「开始打印选中商品」
5. **期望**：无打印预览弹出、无文件保存对话框；预设文件夹出现 `承运商_单号_数量件_贴标自提.pdf`（多商品同名的有 `_2` `_3`）；panel 显示「完成：成功 N/N」

- [ ] **Step 3: 校验文件名 + 内容**

打开保存的 PDF，确认是对应商品的打包标签；文件名承运商/单号/数量正确。

- [ ] **Step 4: 失败路径验证**

故意不设保存文件夹点开始 → 提示「请先设置保存文件夹」；选一个含 disabled 打印按钮的行 → 该商品被跳过不报错。

- [ ] **Step 5: 开 PR**

```bash
git push -u origin feature/packing_label
gh pr create --title "feat: packing_label 打包标签批量打印 feature" --body "<填 Why/What/Test，附 Windows 验证结果截图>"
```

---

## Self-Review（已执行）

- **Spec 覆盖**：§4 架构→Task 2/3/8；§5 数据流→Task 7；§6 捕获+拦截→Task 2；§7 选择器→Task 6/7（标注运行时确认）；§8 命名+路径→Task 1/3/5；§9 native→Task 5；§10 错误分层→Task 7 fails 明细 + 各 task；§11 边界→Task 7（disabled 过滤）+Task 6（confirm 可选）；§12 测试→Task 1 单测 + Task 10 手测；§13 Open Issues→已在顶部决议。
- **Placeholder**：Task 3 的 `onStart` 占位在 Task 7 被替换（已显式说明）；无 TBD/TODO 残留。
- **类型一致**：`ctrl/awaitPdfCapture/savePdf/resolveUniquePath/handleConfirmIfPresent/collectPrintTargets/window.__PLNaming` 跨 task 命名一致；postMessage 协议 `{__pl:'ctrl'|'pdf'|'pdferr', ctxId, ...}` main/isolated 两侧一致。
- **已知不可避免的运行时确认**：行→商品 DOM 嵌套（Task 7）、confirm 弹窗结构（Task 6）的选择器需实现时 dump 真实 DOM 落实——这是 Temu class hash 易变 + 样本未完整暴露所致，已在对应 task 显式标注「先 dump 再写选择器」（符合 debugging-rules）。
