// packing_label：待仓库收货页批量打印商品打包标签 → 静默保存到预设文件夹。
(function () {
  'use strict';
  const AS = window.AgentSeller;
  const U = AS.utils;
  const sendNative = AS.sendNative;
  const LS_PATH = 'plSavePath';
  const PL_DIAG = false; // 诊断日志开关（调试时置 true）

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
      <div class="tal-card" style="display:flex;flex-direction:column;gap:14px;">
        <div class="tal-path-row" id="pl-path-row" title="点击选择保存文件夹" style="cursor:pointer;">
          <span class="tal-path-k">保存到</span>
          <span class="tal-path-v" id="pl-path-v"></span>
        </div>
        <button id="pl-start" class="tal-btn-primary">开始打印选中商品</button>
        <div id="pl-status" class="tal-status" style="margin-top:4px;line-height:1.5;"></div>
      </div>`;
    viewEl.querySelector('#pl-path-row').addEventListener('click', onPickSavePath);
    viewEl.querySelector('#pl-start').addEventListener('click', onStart);
    refreshPathUI();
  }

  function setStatus(msg) {
    const el = document.getElementById('pl-status');
    if (el) el.textContent = msg;
  }

  function ctrl(action) {
    window.postMessage({ __pl: 'ctrl', action }, '*');
  }

  // 点打印 + 捕获 PDF：先注册监听再点击，避免 PDF 生成早于监听注册而丢消息。
  // 串行处理（一次只在途一个商品），捕获到的下一个 pdf 即当前商品，无需 ctxId 关联。
  async function printAndCapture(btn, timeoutMs) {
    let resolveFn, rejectFn, done = false, timer;
    const captured = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    function finish() { done = true; window.removeEventListener('message', onMsg); clearTimeout(timer); }
    function onMsg(e) {
      if (e.source !== window || !e.data || done) return;
      if (e.data.__pl === 'pdf') { finish(); resolveFn(e.data.bytes); }
      else if (e.data.__pl === 'pdferr') { finish(); rejectFn(new Error(e.data.error)); }
    }
    window.addEventListener('message', onMsg);        // ① 先注册监听
    timer = setTimeout(() => { finish(); rejectFn(new Error('未捕获到标签 PDF（超时）')); }, timeoutMs);
    btn.click();                                       // ② 再点击
    handleConfirmIfPresent(2000).catch(() => {});      // ③ 后台处理可选 confirm，不阻塞捕获（监听已就位）
    return captured;
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
        if (PL_DIAG) console.log('[PL-DIAG] confirm 弹窗已处理（勾选+继续打印）');
        return true;
      }
      await U.sleep(150);
    }
    if (PL_DIAG) console.log('[PL-DIAG] confirm 未出现（超时跳过）');
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

  // 商品去重 key：备货单号/发货单号/包裹单号（虚拟列表重渲染时防重复打）。
  function productKey(tr) {
    const t = tr.textContent || '';
    const m = t.match(/WB\d+/) || t.match(/FH\d+/) || t.match(/PC\d+/);
    return m ? m[0] : '';
  }

  // 当前 DOM 里选中分组下每个商品 → {btn, key, trackingRaw（分组级物流单号）, qty（商品级发货数量）}
  function collectPrintTargets() {
    const trs = Array.from(document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]'));
    const targets = [];
    let group = null;
    for (const tr of trs) {
      const cb = tr.querySelector('[data-testid="beast-core-checkbox"] input[type="checkbox"]');
      if (cb) group = { checked: cb.checked, tracking: extractTrackingRaw(tr) }; // 分组首行
      if (!group || !group.checked) continue;
      const btn = findProductPrintBtn(tr);
      if (!btn) continue;
      targets.push({ btn, key: productKey(tr), trackingRaw: group.tracking, qty: extractQty(tr) });
    }
    return targets;
  }

  // 读页面「已选：N」数量（class 带 hash，用 class 前缀匹配 + 文字回退，稳健）。
  // 返回数字；读不到返回 null。
  function getSelectedCount() {
    const numEl = document.querySelector('[class*="chooseNum"]');
    if (numEl) {
      const n = parseInt((numEl.textContent || '').trim(), 10);
      if (!isNaN(n)) return n;
    }
    const box = Array.from(document.querySelectorAll('[class*="choose"]')).find((e) => /已选/.test(e.textContent || ''));
    if (box) { const m = (box.textContent || '').match(/已选[：:]\s*(\d+)/); if (m) return parseInt(m[1], 10); }
    return null;
  }

  // 虚拟列表滚动容器：从行向上找可滚动祖先（不依赖 hash class）。
  function findScrollContainer() {
    let n = document.querySelector('tr[data-testid="beast-core-table-body-tr"]');
    while (n) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 20) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // 运行态：运行中按钮变灰禁用，结束恢复高亮可点。
  function setRunning(running) {
    const btn = document.getElementById('pl-start');
    if (!btn) return;
    btn.disabled = running;
    btn.style.opacity = running ? '0.5' : '';
    btn.style.cursor = running ? 'not-allowed' : '';
    btn.textContent = running ? '打印中…' : '开始打印选中商品';
  }

  // 居中确认弹框，返回 Promise<boolean>（确认 true / 取消 false）。
  function plConfirm(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:8px;padding:22px 24px;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,0.25);font-size:14px;color:#333;line-height:1.6;';
      const msg = document.createElement('div');
      msg.textContent = message;
      msg.style.cssText = 'white-space:pre-wrap;margin-bottom:18px;';
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
      const cancel = document.createElement('button');
      cancel.textContent = '取消';
      cancel.style.cssText = 'padding:6px 18px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;font-size:14px;';
      const ok = document.createElement('button');
      ok.textContent = '确认';
      ok.style.cssText = 'padding:6px 18px;border:none;border-radius:4px;background:#fb7701;color:#fff;cursor:pointer;font-size:14px;';
      function close(val) { overlay.remove(); resolve(val); }
      cancel.onclick = () => close(false);
      ok.onclick = () => close(true);
      overlay.onclick = (e) => { if (e.target === overlay) close(false); };
      btns.append(cancel, ok);
      box.append(msg, btns);
      overlay.append(box);
      document.body.appendChild(overlay);
      ok.focus();
    });
  }

  // ── 滚动扫描批量引擎（虚拟列表：从顶滚到底，边滚边处理可见选中商品，按 key 去重）──────
  async function onStart() {
    const dir = getSavePath();
    if (!dir) { AS.showToast('请先设置保存文件夹', 'warn'); return; }

    // 开始前确认已选数量
    const selCount = getSelectedCount();
    if (selCount === 0) { AS.showToast('请先勾选要打印的商品', 'warn'); return; }
    const msg = selCount == null
      ? '未能读取页面已选数量，仍要开始打印吗？\n\n（会自动滚动列表逐个打印并保存到预设文件夹）'
      : `当前已选中 ${selCount} 个商品，确认开始打印？\n\n（会自动滚动列表逐个打印并保存到预设文件夹）`;
    if (!(await plConfirm(msg))) return;

    setRunning(true);
    ctrl('start');
    const container = findScrollContainer();
    const processed = new Set();
    let ok = 0; const fails = [];
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
          setStatus(`打印中…已完成 ${ok}${fails.length ? `，失败 ${fails.length}` : ''}`);
          if (PL_DIAG) console.log(`[PL-DIAG] >>> key=${t.key} qty="${t.qty}" track="${t.trackingRaw}"`);
          try {
            const info = window.__PLNaming.parseTrackingInfo(t.trackingRaw);
            const baseName = window.__PLNaming.buildBaseFileName({ carrier: info.carrier, trackingNo: info.trackingNo, qty: t.qty });
            const bytes = await printAndCapture(t.btn, 8000);
            const path = await resolveUniquePath(dir, baseName);
            await savePdf(path, bytes);
            ok += 1;
          } catch (err) {
            if (PL_DIAG) console.log('[PL-DIAG] 失败', t.key, err.message);
            fails.push(`${t.key || '?'}(${t.qty || '?'}): ${err.message}`);
          }
          await U.sleep(250);
        } else {
          const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
          if (atBottom) { idleAtBottom += 1; if (idleAtBottom >= 2) break; } else { idleAtBottom = 0; }
          container.scrollTop += Math.max(150, Math.round(container.clientHeight * 0.5));
          await U.sleep(450); // 等虚拟列表重渲染
        }
      }
    } finally {
      ctrl('stop');
      setRunning(false);
      if (PL_DIAG) console.log('[PL-DIAG] === 完成 处理 key 数:', processed.size, '成功:', ok, '失败:', fails.length);
    }
    const total = ok + fails.length;
    if (total === 0) {
      setStatus('没有可打印的选中商品');
      AS.showToast('没有可打印的选中商品', 'warn');
    } else if (fails.length) {
      console.warn('[PL] 失败明细:', fails);
      setStatus(`完成：成功 ${ok}，失败 ${fails.length}（见 console）｜保存到 ${dir}`);
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
