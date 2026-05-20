(() => {
  if (window.__img_search_injector_loaded__) return;
  window.__img_search_injector_loaded__ = true;
  const TAG = '[agentseller/img-search/injector]';

  function pickFileInput(doc) {
    const selectors = [
      'input[type=file][accept*="image"]:not([disabled])',
      'input[type=file]:not([disabled])',
    ];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function isExpired(ts, now, ttlMs) {
    if (ts == null) return true;
    return now - ts >= ttlMs;
  }

  const TTL_MS = 10_000;
  const STORAGE_KEY = 'imagePayload';
  const WAIT_INPUT_MS = 8000;

  async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return await res.blob();
  }

  function waitForFileInput(timeoutMs) {
    return new Promise((resolve) => {
      const existing = pickFileInput(document);
      if (existing) return resolve(existing);
      const obs = new MutationObserver(() => {
        const el = pickFileInput(document);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  async function injectFile(input, blob) {
    const file = new File([blob], `image-${Date.now()}.png`, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function isSearchTrigger(el) {
    const text = (el.textContent || '').trim();
    if (!text || text.length > 10) return false;
    return text === '搜索图片' || text === '开始搜索' || /^搜索.{0,4}$/.test(text);
  }

  const BUTTON_SELECTOR = [
    '.copy-image-container .search-btn',
    '.copy-image-container [data-tracker="pasteImagePreview"]',
    '[data-tracker="pasteImagePreview"]',
  ].join(',');

  function waitForSearchButton(timeoutMs) {
    return new Promise((resolve) => {
      const scan = () =>
        Array.from(document.querySelectorAll(BUTTON_SELECTOR))
          .find(isSearchTrigger) || null;
      const found = scan();
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const f = scan();
        if (f) { obs.disconnect(); resolve(f); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  function simulateClick(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function waitForPreviewReady(timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        const img = document.querySelector('.copy-image img, .preview-image img, [class*="preview"] img');
        const ready = img && img.src && img.src.length > 32 && img.complete && img.naturalWidth > 0;
        if (ready) { clearInterval(tick); resolve(true); }
        else if (Date.now() - t0 > timeoutMs) { clearInterval(tick); resolve(false); }
      }, 50);
    });
  }

  async function showToast(text, action) {
    const root = document.createElement('div');
    root.style.cssText = `
      position: fixed; top: 24px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; background: rgba(0,0,0,0.85); color: #fff;
      padding: 10px 16px; border-radius: 6px;
      font: 13px -apple-system, sans-serif; display: flex; gap: 12px; align-items: center;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    `;
    const span = document.createElement('span');
    span.textContent = text;
    root.appendChild(span);
    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.style.cssText = `
        cursor: pointer; padding: 4px 10px; border: 1px solid #fff;
        background: transparent; color: #fff; border-radius: 4px; font: inherit;
      `;
      btn.addEventListener('click', () => { root.remove(); action.onClick(); });
      root.appendChild(btn);
    }
    document.body.appendChild(root);
    setTimeout(() => root.remove(), 5000);
  }

  async function copyToClipboard(blob) {
    const item = new ClipboardItem({ 'image/png': blob });
    await navigator.clipboard.write([item]);
  }

  async function fallbackToClipboard(payload, reason) {
    let blob;
    try {
      blob = await dataUrlToBlob(payload.dataUrl);
    } catch (e) {
      await showToast('图片数据已失效，请重新截图。');
      return;
    }
    try {
      await copyToClipboard(blob);
      await chrome.storage.session.remove(STORAGE_KEY);
      await showToast('自动上传失败，已复制图片，请在搜索框按 Ctrl+V 粘贴。', {
        label: '重试',
        onClick: () => run(),
      });
    } catch (e) {
      await showToast('请点击 1688 页面后再点重试。', {
        label: '重试',
        onClick: () => run(),
      });
    }
    chrome.runtime.sendMessage({ type: 'IMG_SEARCH_INJECTION_RESULT', ok: false, reason });
  }

  async function run() {
    let payload;
    try {
      const obj = await chrome.storage.session.get(STORAGE_KEY);
      payload = obj[STORAGE_KEY];
    } catch (e) {
      console.warn(TAG, 'storage.get failed:', e);
      await showToast('扩展无法读取截图数据：' + e.message);
      return;
    }
    if (!payload) { console.log(TAG, 'no payload, exit'); return; }
    if (isExpired(payload.ts, Date.now(), TTL_MS)) {
      console.log(TAG, 'payload expired, exit');
      return;
    }
    if (location.pathname.includes('/punish') || location.search.includes('x5secdata')) {
      console.warn(TAG, 'punish page detected, fallback to clipboard');
      try {
        const blob = await dataUrlToBlob(payload.dataUrl);
        await copyToClipboard(blob);
        await chrome.storage.session.remove(STORAGE_KEY);
        await showToast('1688 触发风控，请完成验证后重新截图（图片已复制到剪贴板）。');
      } catch (e) {
        await showToast('1688 触发风控，请完成验证后重新截图。');
      }
      chrome.runtime.sendMessage({ type: 'IMG_SEARCH_INJECTION_RESULT', ok: false, reason: 'punish-page' });
      return;
    }
    console.log(TAG, 'payload ok, waiting file input');
    const input = await waitForFileInput(WAIT_INPUT_MS);
    if (!input) {
      console.warn(TAG, 'no file input within', WAIT_INPUT_MS, 'ms');
      await fallbackToClipboard(payload, 'no-input');
      return;
    }
    try {
      const blob = await dataUrlToBlob(payload.dataUrl);
      await injectFile(input, blob);
      const [btn, previewReady] = await Promise.all([
        waitForSearchButton(5000),
        waitForPreviewReady(5000),
      ]);
      if (btn) {
        console.log(TAG, 'preview ready:', previewReady, '→ clicking:', btn);
        simulateClick(btn);
      } else {
        console.warn(TAG, 'search button not found within 5000 ms');
      }
      await chrome.storage.session.remove(STORAGE_KEY);
      chrome.runtime.sendMessage({
        type: 'IMG_SEARCH_INJECTION_RESULT',
        ok: true,
        reason: btn ? 'clicked' : 'no-button',
      });
    } catch (e) {
      console.warn(TAG, 'inject failed:', e);
      await fallbackToClipboard(payload, String(e));
    }
  }

  run();
})();
