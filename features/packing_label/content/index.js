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
      const r = await sendNative('SAVE_FILE_CHUNK', { path, data: bytesToBase64(slice), offset, done });
      if (!r || !r.success) throw new Error((r && r.error) || '保存失败');
      offset += slice.length; last = r;
    }
    return last;
  }

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

  // ── 商品枚举 ──────────────────────────────────────────────────────────────
  // 表格 rowspan 分组结构：一个物流分组 = 含 checkbox 的首 tr + 后续无 checkbox 的同组 tr，
  // 每个 tr 对应一个商品。分组级单元格（checkbox / 物流单号 / 分组操作列）用 rowspan 合并在首 tr。

  function extractTrackingRaw(tr) {
    const spans = Array.from(tr.querySelectorAll('a[data-testid="beast-core-button-link"] span'));
    const hit = spans.find((s) => /[，,]/.test(s.textContent) && /[A-Za-z0-9]{6,}/.test(s.textContent));
    return hit ? hit.textContent.trim() : '';
  }

  function extractQty(tr) {
    const m = (tr.textContent || '').match(/发货数量：?\s*(\d+件)/);
    return m ? m[1] : '';
  }

  // 商品级「打印商品打包标签」按钮：排除分组级操作列（含「运单」）和 disabled。
  function findProductPrintBtn(tr) {
    return Array.from(tr.querySelectorAll('a[data-testid="beast-core-button-link"]'))
      .filter((a) => { const s = a.querySelector('span'); return s && s.textContent.trim() === '打印商品打包标签'; })
      .filter((a) => !a.hasAttribute('disabled'))
      .filter((a) => { const td = a.closest('td'); return td && !td.textContent.includes('运单'); })[0] || null;
  }

  // 选中分组下每个商品 → {btn, trackingRaw（分组级物流单号）, qty（商品级发货数量）}
  function collectPrintTargets() {
    const trs = Array.from(document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]'));
    const targets = [];
    let group = null;
    for (const tr of trs) {
      const cb = tr.querySelector('[data-testid="beast-core-checkbox"] input[type="checkbox"]');
      if (cb) { group = { checked: cb.checked, tracking: extractTrackingRaw(tr) }; } // 分组首行
      if (!group || !group.checked) continue;
      const btn = findProductPrintBtn(tr);
      if (!btn) continue;
      targets.push({ btn, trackingRaw: group.tracking, qty: extractQty(tr) });
    }
    return targets;
  }

  // ── 批量串行引擎 ─────────────────────────────────────────────────────────────
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
          await handleConfirmIfPresent(2500);          // 可选 confirm
          const bytes = await awaitPdfCapture(ctxId, 8000);
          const path = await resolveUniquePath(dir, baseName);
          await savePdf(path, bytes);
          ok += 1;
        } catch (err) {
          fails.push(`#${i + 1}(${t.qty || '?'}): ${err.message}`);
        }
        await U.sleep(300);
      }
    } finally {
      ctrl('stop');
    }
    if (fails.length) {
      console.warn('[PL] 失败明细:', fails);
      setStatus(`完成：成功 ${ok}/${targets.length}，失败 ${fails.length}（见 console）｜保存到 ${dir}`);
      AS.showToast(`成功 ${ok}，失败 ${fails.length}（看 console）`, 'warn');
    } else {
      setStatus(`✅ 全部完成：${ok} 个已存到 ${dir}`);
      AS.showToast(`全部完成：${ok} 个`, 'success');
    }
  }

  AS.registerFeature({
    id: 'packing_label',
    icon: '🏷️',
    label: '打包标签',
    init() { AS.onPageChange(() => {}); },
    render: renderView,
  });
})();
