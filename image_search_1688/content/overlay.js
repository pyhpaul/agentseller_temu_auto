(() => {
  if (window.__img_search_overlay_loaded__) return;
  window.__img_search_overlay_loaded__ = true;

  const MSG_START    = 'IMG_SEARCH_START';
  const MSG_REGION   = 'IMG_SEARCH_CAPTURE_REGION';
  const MSG_CANCEL   = 'IMG_SEARCH_CANCEL';
  const MSG_TOO_LARGE = 'IMG_SEARCH_TOO_LARGE';
  const MIN_SIZE = 10;

  let root = null;
  let selectionEl = null;
  let toolbarEl = null;
  let toastTimer = null;
  let start = null;
  let rect = null;

  function ensureRoot() {
    if (root) return;
    root = document.createElement('div');
    root.id = '__1688_overlay_root__';

    const mask = document.createElement('div');
    mask.className = 'mask';
    root.appendChild(mask);

    document.documentElement.appendChild(root);

    root.addEventListener('mousedown', onMouseDown, true);
    root.addEventListener('mousemove', onMouseMove, true);
    root.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function tearDown() {
    const orphan = document.getElementById('__1688_overlay_root__');
    if (orphan) orphan.remove();
    document.removeEventListener('keydown', onKeyDown, true);
    root = selectionEl = toolbarEl = null;
    start = rect = null;
    if (toastTimer) clearTimeout(toastTimer);
    window.__img_search_overlay_loaded__ = false;
  }

  function onMouseDown(e) {
    if (toolbarEl && toolbarEl.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    if (toolbarEl) { toolbarEl.remove(); toolbarEl = null; }
    start = { x: e.clientX, y: e.clientY };
    if (!selectionEl) {
      selectionEl = document.createElement('div');
      selectionEl.className = 'selection';
      root.appendChild(selectionEl);
    }
    updateSelection(start.x, start.y, 0, 0);
  }

  function onMouseMove(e) {
    if (!start) return;
    e.preventDefault(); e.stopPropagation();
    const x = Math.min(start.x, e.clientX);
    const y = Math.min(start.y, e.clientY);
    const w = Math.abs(e.clientX - start.x);
    const h = Math.abs(e.clientY - start.y);
    updateSelection(x, y, w, h);
  }

  function onMouseUp(e) {
    if (toolbarEl && toolbarEl.contains(e.target)) return;
    if (!start) return;
    e.preventDefault(); e.stopPropagation();
    start = null;
    if (!rect || rect.w < MIN_SIZE || rect.h < MIN_SIZE) {
      if (selectionEl) { selectionEl.remove(); selectionEl = null; }
      rect = null;
      showToast('选区太小，请重新框选');
      return;
    }
    showToolbar();
  }

  function updateSelection(x, y, w, h) {
    rect = { x, y, w, h };
    selectionEl.style.left = x + 'px';
    selectionEl.style.top = y + 'px';
    selectionEl.style.width = w + 'px';
    selectionEl.style.height = h + 'px';
  }

  function showToolbar() {
    toolbarEl = document.createElement('div');
    toolbarEl.className = 'toolbar';
    toolbarEl.innerHTML = `
      <button class="primary" data-act="search">搜索 1688</button>
      <button data-act="reselect">重选</button>
      <button data-act="cancel">取消</button>
    `;
    positionToolbar();
    root.appendChild(toolbarEl);
    toolbarEl.addEventListener('click', onToolbarClick, true);
  }

  function positionToolbar() {
    const TB_W = 200, TB_H = 36, MARGIN = 6;
    const vw = window.innerWidth, vh = window.innerHeight;
    const candidates = [
      { left: rect.x + rect.w + MARGIN, top: rect.y + rect.h + MARGIN },
      { left: rect.x + rect.w + MARGIN, top: rect.y - TB_H - MARGIN },
      { left: rect.x - TB_W - MARGIN, top: rect.y + rect.h + MARGIN },
      { left: rect.x - TB_W - MARGIN, top: rect.y - TB_H - MARGIN },
    ];
    const fit = candidates.find(c =>
      c.left >= 0 && c.top >= 0 && c.left + TB_W <= vw && c.top + TB_H <= vh
    ) || { left: Math.max(0, vw - TB_W - MARGIN), top: Math.max(0, vh - TB_H - MARGIN) };
    toolbarEl.style.left = fit.left + 'px';
    toolbarEl.style.top = fit.top + 'px';
  }

  function onToolbarClick(e) {
    e.preventDefault(); e.stopPropagation();
    const act = e.target.dataset?.act;
    if (act === 'search') confirmSearch();
    else if (act === 'reselect') resetSelection();
    else if (act === 'cancel') cancel();
  }

  function resetSelection() {
    if (toolbarEl) { toolbarEl.remove(); toolbarEl = null; }
    if (selectionEl) { selectionEl.remove(); selectionEl = null; }
    rect = null;
  }

  function cancel() {
    chrome.runtime.sendMessage({ type: MSG_CANCEL });
    tearDown();
  }

  function confirmSearch() {
    const payload = {
      type: MSG_REGION,
      rect: { ...rect },
      dpr: window.devicePixelRatio || 1,
    };
    tearDown();
    chrome.runtime.sendMessage(payload);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter' && rect) { e.preventDefault(); confirmSearch(); }
    else if ((e.key === 'r' || e.key === 'R') && rect) { e.preventDefault(); resetSelection(); }
  }

  function showToast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    root.appendChild(t);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 1500);
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === MSG_START) ensureRoot();
    if (m?.type === MSG_TOO_LARGE) showToast('图片过大，请缩小选区');
  });

  ensureRoot();
})();
