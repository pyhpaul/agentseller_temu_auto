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

  // 引擎在 Task 7/8 实现；此处占位避免引用未定义。
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
