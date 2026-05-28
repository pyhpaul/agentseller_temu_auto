// auto_ship：发货单列表「待装箱发货」tab 自动发货编排（纯 content-script 单页）。
(function () {
  'use strict';
  const AS = window.AgentSeller;
  const U = AS.utils;
  const L = window.__AutoShipLogic;
  const SK_AUTO_CONFIRM = 'auto_ship_auto_confirm'; // chrome.storage.local 键

  const SHIP_LIST_RE = /seller\.kuajingmaihuo\.com\/main\/order-manager\/shipping-list/;
  function isShipListPage(href) { return SHIP_LIST_RE.test(href || location.href); }

  // ── 运行态（内存；SPA 不整页 reload，够用）──
  const run = {
    active: false,        // 主循环进行中
    stopRequested: false, // 用户点了停止
    autoConfirm: false,   // 镜像 storage 开关
  };

  // ── storage 开关 ──
  async function loadAutoConfirm() {
    try {
      const o = await chrome.storage.local.get(SK_AUTO_CONFIRM);
      run.autoConfirm = !!o[SK_AUTO_CONFIRM];
    } catch (_) { run.autoConfirm = false; }
    return run.autoConfirm;
  }
  async function saveAutoConfirm(v) {
    run.autoConfirm = !!v;
    try { await chrome.storage.local.set({ [SK_AUTO_CONFIRM]: run.autoConfirm }); } catch (_) {}
  }

  // ── UI ──
  function renderView(viewEl) {
    viewEl.innerHTML = `
      <div class="tal-card">
        <div class="tal-card-title">自动发货</div>
        <label class="as-toggle" style="display:flex;align-items:center;gap:8px;margin:8px 0;cursor:pointer">
          <input type="checkbox" id="as-auto-confirm">
          <span>自动确认发货（关：逐单弹窗确认；开：全自动直接确认发货）</span>
        </label>
        <div style="display:flex;gap:8px;margin:8px 0">
          <button id="as-start" class="tal-btn-primary">开始</button>
          <button id="as-stop" class="tal-btn" disabled>停止</button>
        </div>
        <div id="as-progress" class="tal-status" style="white-space:pre-line"></div>
        <div id="as-summary" class="tal-status" style="white-space:pre-line;margin-top:6px"></div>
      </div>`;
    const cb = viewEl.querySelector('#as-auto-confirm');
    cb.checked = run.autoConfirm;
    cb.addEventListener('change', () => saveAutoConfirm(cb.checked));
    viewEl.querySelector('#as-start').addEventListener('click', onStart);
    viewEl.querySelector('#as-stop').addEventListener('click', onStop);
  }

  function setProgress(msg) { const el = document.getElementById('as-progress'); if (el) el.textContent = msg || ''; }
  function setSummary(msg) { const el = document.getElementById('as-summary'); if (el) el.textContent = msg || ''; }
  function setRunningUI(running) {
    const s = document.getElementById('as-start'); const t = document.getElementById('as-stop');
    if (s) s.disabled = running; if (t) t.disabled = !running;
  }

  // ════════ DOM 适配层 A：tab / 扫描 / 行定位 / 读取（据 samples/table_and_tabs.txt 真实 DOM）════════
  const SEL = {
    bodyRow: '[data-testid="beast-core-table-body-tr"]',
    checkbox: '[data-testid="beast-core-checkbox"]',
    tabLabel: '[data-testid="beast-core-tab-itemLabel"]',
    scrollContainer: '[class*="contentContainer"]',
    btnLink: '[data-testid="beast-core-button-link"]',
  };
  const TAB_PENDING = '待装箱发货';
  const TAB_RECEIVED = '待仓库收货';

  // ── 错误分层标记（spec §9）──
  function markRead(err) { err._cat = 'read'; return err; }
  function markData(err) { err._cat = 'data'; return err; }
  function markBiz(err) { err._cat = 'biz'; return err; }

  // ── 行 / 单元格 ──
  function bodyRows() { return Array.from(document.querySelectorAll(SEL.bodyRow)); }
  function rowCells(tr) { return Array.from(tr.querySelectorAll(':scope > td')); }
  function rowCheckbox(tr) { return tr.querySelector(SEL.checkbox); }

  // 发货单号：td[1] 内首个无子元素纯文本 div（如 FH2605284051650）
  function readOrderNo(tr) {
    const cell = rowCells(tr)[1];
    if (!cell) return '';
    const box = cell.querySelector('[data-testid="beast-core-box"]') || cell;
    const leaf = Array.from(box.querySelectorAll('div')).find((d) => d.children.length === 0 && /\S/.test(d.textContent));
    if (leaf) return leaf.textContent.trim();
    const m = U.normText(cell.textContent).match(/^([A-Za-z0-9]{6,})/);
    return m ? m[1] : '';
  }
  // 发货仓库：td[3]「发货信息」列，「发货仓库：」label 后内层 div 第一个 span
  function readWarehouseName(tr) {
    const cell = rowCells(tr)[3];
    if (!cell) return '';
    const label = Array.from(cell.querySelectorAll('span')).find((s) => U.normText(s.textContent).startsWith('发货仓库'));
    if (label && label.parentElement) {
      const valSpan = label.parentElement.querySelector('div span');
      if (valSpan) return valSpan.textContent.trim();
    }
    const m = U.normText(cell.textContent).match(/发货仓库[:：]\s*([\s\S]*?)(?:更换|收货仓库|$)/);
    return m ? m[1].trim() : '';
  }
  // 包裹号：td[4]。空值=「打印打包标签后展示」→ 返回 ''；有值=PC2605285400438
  function readPackageNo(tr) {
    const cell = rowCells(tr)[4];
    if (!cell) return '';
    const t = U.normText(cell.textContent);
    if (t.includes('打印打包标签后展示')) return '';
    const m = t.match(/([A-Z]{2}\d{6,})/);
    return m ? m[1] : t;
  }

  // ── 滚动容器（页面级；无滚动则 null，一次性枚举）──
  function getScrollContainer() {
    const el = document.querySelector(SEL.scrollContainer);
    if (el && el.scrollHeight > el.clientHeight + 5) return el;
    return null;
  }

  // ── 滚动扫描：枚举当前活表格所有发货单号（去重）──
  async function scanOrderNos() {
    const found = [];
    const collect = () => { for (const tr of bodyRows()) { const no = readOrderNo(tr); if (no) found.push(no); } };
    const sc = getScrollContainer();
    if (!sc) { collect(); return L.dedupOrderNos(found); }
    sc.scrollTop = 0; await U.sleep(300); collect();
    let lastTop = -1, stable = 0;
    while (stable < 2) {
      sc.scrollTop = Math.min(sc.scrollTop + sc.clientHeight * 0.8, sc.scrollHeight);
      await U.sleep(300); collect();
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
      if (sc.scrollTop === lastTop || atBottom) stable += 1; else stable = 0;
      lastTop = sc.scrollTop;
    }
    return L.dedupOrderNos(found);
  }

  // ── 定位发货单（一行一单；滚动到渲染为止）。返回 {orderNo, tr, checkbox} | null ──
  function tryFindRow(orderNo) {
    for (const tr of bodyRows()) {
      if (readOrderNo(tr) === orderNo) return { orderNo, tr, checkbox: rowCheckbox(tr) };
    }
    return null;
  }
  async function findRow(orderNo) {
    const sc = getScrollContainer();
    if (!sc) return tryFindRow(orderNo);
    sc.scrollTop = 0; await U.sleep(250);
    let r = tryFindRow(orderNo); if (r) return r;
    let lastTop = -1;
    while (true) {
      sc.scrollTop = Math.min(sc.scrollTop + sc.clientHeight * 0.8, sc.scrollHeight);
      await U.sleep(250);
      r = tryFindRow(orderNo); if (r) return r;
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
      if (sc.scrollTop === lastTop || atBottom) break;
      lastTop = sc.scrollTop;
    }
    return null;
  }

  // ── in-page tab ──
  function tabLabels() { return Array.from(document.querySelectorAll(SEL.tabLabel)); }
  function getActiveTabText() {
    const el = tabLabels().find((t) => /active/i.test(t.className)
      || /active/i.test((t.parentElement && t.parentElement.className) || ''));
    return el ? U.normText(el.textContent) : '';
  }
  function isOnPendingTab() { return getActiveTabText().includes(TAB_PENDING); }
  async function clickTab(text) {
    const el = tabLabels().find((t) => U.normText(t.textContent) === text);
    if (!el) throw markRead(new Error(`读取失败：未找到 tab「${text}」`));
    el.click();
    await U.waitForEl(SEL.bodyRow, 8000).catch(() => {});
    await U.sleep(400);
  }
  async function ensureOnPendingTab() { if (!isOnPendingTab()) await clickTab(TAB_PENDING); }
  async function refreshViaTabSwitch() {
    await clickTab(TAB_RECEIVED); await U.sleep(600);
    await clickTab(TAB_PENDING); await U.sleep(600);
  }

  // ════════ OFF 模式逐单确认框（可拖动，不超时）════════
  // 返回 Promise<boolean>：true=确认发货，false=取消（关编辑页跳过）。
  function askConfirmShip(orderNo) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;z-index:2147483600;left:50%;top:120px;transform:translateX(-50%);'
        + 'background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.2);'
        + 'width:340px;font-size:14px;color:#222';
      ov.innerHTML = `
        <div class="as-confirm-head" style="padding:10px 14px;cursor:move;background:#f5f5f5;border-radius:8px 8px 0 0;font-weight:600">确认发货？</div>
        <div style="padding:14px">
          <div>发货单号：<b>${orderNo}</b></div>
          <div style="color:#888;margin-top:6px">点「确认发货」将真实出货（不可逆）；点「取消」关闭编辑页、跳过本单。</div>
          <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">
            <button id="as-c-cancel" class="tal-btn">取消</button>
            <button id="as-c-ok" class="tal-btn-primary">确认发货</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      try { U.makeDraggable(ov, ov.querySelector('.as-confirm-head')); } catch (_) {}
      const done = (v) => { try { ov.remove(); } catch (_) {} resolve(v); };
      ov.querySelector('#as-c-ok').addEventListener('click', () => done(true));
      ov.querySelector('#as-c-cancel').addEventListener('click', () => done(false));
    });
  }

  // 引擎在 Task 5/7/8 实现；此处占位避免引用未定义。
  async function onStart() { setProgress('（引擎未实现）'); }
  function onStop() { run.stopRequested = true; }

  AS.registerFeature({
    id: 'auto_ship',
    icon: '📦',
    label: '自动发货',
    init() { loadAutoConfirm(); AS.onPageChange(() => {}); },
    render: renderView,
  });
})();
