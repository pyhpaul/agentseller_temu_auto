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

  async function onStart() { /* Task 7 实现批量引擎 */ setStatus('（引擎未实现）'); }

  AS.registerFeature({
    id: 'packing_label',
    icon: '🏷️',
    label: '打包标签',
    init() { AS.onPageChange(() => {}); },
    render: renderView,
  });
})();
