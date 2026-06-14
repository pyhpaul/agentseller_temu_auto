// features/image_search_1688/background/handler.js — image_search 跨 tab 截图编排（SW world）
// 被 build assemble_feature_backgrounds 经 importScripts 装配进 SW；依赖 SW 已提供的 self.AgentSellerBg。
(function () {
  'use strict';

  // ── 常量 ────────────────────────────────────────────────────────────────────
  const IMG_SEARCH_URL  = 'https://s.1688.com/youyuan/index.htm';
  const IMG_PAYLOAD_KEY = 'imagePayload';
  const IMG_MAX_BYTES   = 4 * 1024 * 1024;

  // ── 状态变量 ─────────────────────────────────────────────────────────────────
  let isImgSearchCapturing  = false;
  let imgSearchSourceTabId  = null;

  // ── Session storage 访问级别（content script 读取 imagePayload 需要）──────────
  function enableSessionStorageAccess() {
    chrome.storage.session.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    }).catch(() => {});
  }
  chrome.runtime.onInstalled.addListener(enableSessionStorageAccess);
  chrome.runtime.onStartup.addListener(enableSessionStorageAccess);
  enableSessionStorageAccess();

  // ── Helpers ──────────────────────────────────────────────────────────────────
  // dataURL → Blob 手动解码：扩展 CSP 的 connect-src 不放行 data:，fetch('data:…') 会被拦截
  // （automation 装配带入 CSP 时，SW 内对 data: 的 fetch 被 connect-src 限制 → Failed to fetch）。
  // 纯 base64 解码不发网络请求，不受 CSP 影响，dev/release 都稳。
  function imgDataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const mime = (dataUrl.slice(0, comma).match(/:(.*?);/) || [])[1] || 'image/png';
    const bin = atob(dataUrl.slice(comma + 1));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  async function imgCropImage(fullDataUrl, rect, dpr) {
    const sx = Math.round(rect.x * dpr);
    const sy = Math.round(rect.y * dpr);
    const sw = Math.round(rect.w * dpr);
    const sh = Math.round(rect.h * dpr);
    const blob = imgDataUrlToBlob(fullDataUrl);
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(sw, sh);
      canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
      const outBlob = await canvas.convertToBlob({ type: 'image/png' });
      return await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onloadend = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(outBlob);
      });
    } finally {
      bitmap.close();
    }
  }

  async function imgSetPayload(dataUrl) {
    await chrome.storage.session.set({
      [IMG_PAYLOAD_KEY]: { dataUrl, ts: Date.now() },
    });
  }

  function imgEstimateBytes(dataUrl) {
    const i = dataUrl.indexOf(',');
    return i < 0 ? 0 : Math.floor(dataUrl.slice(i + 1).length * 0.75);
  }

  async function imgNotify(message) {
    try {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: '1688 以图搜图',
        message,
      });
    } catch (e) {
      console.warn('[imgNotify]', e);
    }
  }

  // ── Tab 事件监听（状态自动清理）────────────────────────────────────────────
  chrome.tabs.onRemoved.addListener(() => { isImgSearchCapturing = false; });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && tabId === imgSearchSourceTabId) {
      isImgSearchCapturing = false;
    }
  });

  // ── 消息路由（IMG_SEARCH_* 前缀）────────────────────────────────────────────
  self.AgentSellerBg.registerHandler('IMG_SEARCH_', (msg, sender, sendResponse) => {
    if (msg.type === 'IMG_SEARCH_START') {
      if (isImgSearchCapturing) {
        sendResponse({ ok: false, reason: 'already-capturing' });
        return;
      }
      const tab = sender.tab;
      if (!tab) { sendResponse({ ok: false, reason: 'no-tab' }); return; }
      isImgSearchCapturing = true;
      (async () => {
        try {
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['features/image_search_1688/content/overlay.css'],
          });
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['features/image_search_1688/content/overlay.js'],
          });
          await chrome.tabs.sendMessage(tab.id, { type: 'IMG_SEARCH_START' });
          imgSearchSourceTabId = tab.id;
          sendResponse({ ok: true });
        } catch (e) {
          isImgSearchCapturing = false;
          await imgNotify('该页面禁止注入脚本，截图无法启动。');
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }

    if (msg.type === 'IMG_SEARCH_CANCEL') {
      isImgSearchCapturing = false;
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'IMG_SEARCH_CAPTURE_REGION') {
      const tab = sender.tab;
      if (!tab) { sendResponse({ ok: false, error: 'no-tab' }); return; }
      (async () => {
        try {
          const { rect, dpr } = msg;
          const fullDataUrl = await chrome.tabs.captureVisibleTab(
            tab.windowId, { format: 'png' }
          );
          const cropped = await imgCropImage(fullDataUrl, rect, dpr);
          if (imgEstimateBytes(cropped) > IMG_MAX_BYTES) {
            await chrome.tabs.sendMessage(tab.id, { type: 'IMG_SEARCH_TOO_LARGE' }).catch(() => {});
            await imgNotify('图片过大，请缩小选区后重试。');
            sendResponse({ ok: false, error: 'too_large' });
            return;
          }
          await imgSetPayload(cropped);
          await chrome.tabs.create({ url: IMG_SEARCH_URL, openerTabId: tab.id });
          sendResponse({ ok: true });
        } catch (e) {
          console.error('[img-search] CAPTURE_REGION error:', e);
          await imgNotify('截图失败：' + (e?.message ?? '未知错误'));
          sendResponse({ ok: false, error: String(e) });
        } finally {
          isImgSearchCapturing = false;
          imgSearchSourceTabId = null;
        }
      })();
      return true;
    }

    if (msg.type === 'IMG_SEARCH_INJECTION_RESULT') {
      if (!msg.ok) console.warn('[AgentSeller/img-search] 注入失败：', msg.reason);
      sendResponse({ ok: true });
      return;
    }
  });
})();
