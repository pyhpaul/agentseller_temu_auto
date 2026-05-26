// ── image_search_1688 ── 图片搜索常量和工具函数 ──────────────────────────────
const IMG_SEARCH_URL         = 'https://s.1688.com/youyuan/index.htm';
const IMG_PAYLOAD_KEY        = 'imagePayload';
const IMG_MAX_BYTES          = 4 * 1024 * 1024;

let   isImgSearchCapturing   = false;
let   imgSearchSourceTabId   = null;

function enableSessionStorageAccess() {
  chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
  }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(enableSessionStorageAccess);
chrome.runtime.onStartup.addListener(enableSessionStorageAccess);
enableSessionStorageAccess();

async function imgCropImage(fullDataUrl, rect, dpr) {
  const sx = Math.round(rect.x * dpr);
  const sy = Math.round(rect.y * dpr);
  const sw = Math.round(rect.w * dpr);
  const sh = Math.round(rect.h * dpr);
  const blob = await (await fetch(fullDataUrl)).blob();
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

chrome.tabs.onRemoved.addListener(() => { isImgSearchCapturing = false; });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && tabId === imgSearchSourceTabId) {
    isImgSearchCapturing = false;
  }
});
// ── end image_search_1688 ────────────────────────────────────────────────────

const NATIVE_HOST = 'com.temu.label_host';

let nativePort = null;

function connectNativeHost() {
  nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort.onDisconnect.addListener(() => { nativePort = null; });
}

function sendToNativeHost(msg) {
  return new Promise((resolve, reject) => {
    if (!nativePort) connectNativeHost();

    function onDisconnect() {
      reject(new Error('Native host 已断开：' + (chrome.runtime.lastError?.message || '')));
    }

    nativePort.onDisconnect.addListener(onDisconnect);
    nativePort.onMessage.addListener(function handler(response) {
      nativePort.onMessage.removeListener(handler);
      nativePort.onDisconnect.removeListener(onDisconnect);
      resolve(response);
    });

    nativePort.postMessage(msg);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PROCESS_LABEL') {
    const { skcNumber, skcSku, barcodePngB64, templatePath, outputDir, widthRatio } = msg.data;

    sendToNativeHost({
      action: 'generate_label',
      skc_number: skcNumber,
      skc_sku: skcSku,
      barcode_png_b64: barcodePngB64,
      template_path: templatePath,
      output_dir: outputDir,
      width_ratio: widthRatio
    })
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));

    return true;
  }

  if (msg.type === 'READ_FILE') {
    sendToNativeHost({ action: 'read_file', path: msg.data.path })
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'READ_FILE_SIZE') {
    sendToNativeHost({ action: 'read_file_size', path: msg.data.path })
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'READ_FILE_CHUNK') {
    sendToNativeHost({
      action: 'read_file_chunk',
      path: msg.data.path,
      offset: msg.data.offset,
      length: msg.data.length
    })
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'SAVE_FILE_CHUNK') {
    sendToNativeHost({
      action: 'write_file_chunk',
      path: msg.data.path,
      data: msg.data.data,
      offset: msg.data.offset,
      done: msg.data.done
    })
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'PICK_FILE') {
    sendToNativeHost({
      action: 'pick_file',
      title: msg.data.title,
      filetypes: msg.data.filetypes
    })
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'PICK_FOLDER') {
    sendToNativeHost({
      action: 'pick_folder',
      title: msg.data.title
    })
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({ connected: nativePort !== null });
  }

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

// ── create_purchase_order ── Phase 1 跨 tab 编排 ───────────────────────────────
const CPO_DXM_INDEX_URL = 'https://www.dianxiaomi.com/web/dxmCommodityProduct/index';
const CPO_CMD_TIMEOUT   = 20000;   // 单条命令往返超时
const CPO_READY_RETRIES = 25;      // 等 content 就绪重试次数（每次 200ms ≈ 5s）

function cpoSetState(patch) {
  return chrome.storage.local.get('cpo_state').then(({ cpo_state }) => {
    const next = { status: 'idle', step: 0, collectedData: {}, ...(cpo_state || {}), ...patch };
    return chrome.storage.local.set({ cpo_state: next });
  });
}

// 等 tab 加载完成（status==='complete'）
function cpoWaitTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('tab 加载超时')); }, timeout);
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') { cleanup(); resolve(); }
    }
    function cleanup() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); }
    chrome.tabs.onUpdated.addListener(onUpdated);
    // 兜底：可能已 complete
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') { cleanup(); resolve(); } }).catch(() => {});
  });
}

// 等某个 tab 的 URL 满足 predicate（处理「点击后同 tab 跳转或新开 tab」两种）→ 返回 tabId
function cpoWaitForUrl(predicate, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('未等到目标页面')); }, timeout);
    function onUpdated(tabId, info, tab) {
      const url = info.url || tab.url || '';
      if (url && predicate(url) && tab.status === 'complete') { cleanup(); resolve(tabId); }
    }
    function cleanup() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// 向 tab 发命令，content 未就绪（Receiving end does not exist）时重试
async function cpoSendCommand(tabId, type, data) {
  let lastErr;
  for (let i = 0; i < CPO_READY_RETRIES; i++) {
    try {
      const resp = await Promise.race([
        chrome.tabs.sendMessage(tabId, { type, data }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('命令超时: ' + type)), CPO_CMD_TIMEOUT)),
      ]);
      if (resp && resp.ok === false) throw new Error(resp.error || (type + ' 失败'));
      return resp;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (!/Receiving end does not exist|Could not establish connection/.test(msg)) throw e;
      await new Promise(r => setTimeout(r, 200));   // content 还没注入，等等再试
    }
  }
  throw lastErr || new Error('命令无法送达: ' + type);
}

function cpoNotify(originTabId, type, payload) {
  chrome.tabs.sendMessage(originTabId, { type, ...payload }).catch(() => {});
}

// 主编排序列
async function cpoRun(originTabId, { skc, url1688 }) {
  const serial = url1688.match(/\/offer\/(\d+)/)?.[1] || null;
  if (!serial) {   // bg 侧二次校验（content 已校验，双保险）
    cpoNotify(originTabId, 'CPO_ERROR', { step: 0, message: '1688商品url 无法提取 serial', kind: 'validate' });
    await cpoSetState({ status: 'error', step: 0 });
    return;
  }
  const collected = { skc, url1688, serial, title: '', skuNo: '', previewUrl: '' };
  const tmpTabs = [];   // 临时 tab，出错时统一回收
  try {
    await cpoSetState({ status: 'running', step: 1, collectedData: collected });

    // 步骤1：后台开 1688 → 抓标题 → 关
    cpoNotify(originTabId, 'CPO_PROGRESS', { step: 1, label: '读取 1688 标题' });
    const t1688 = await chrome.tabs.create({ url: url1688, active: false });
    tmpTabs.push(t1688.id);
    await cpoWaitTabComplete(t1688.id);
    const r1 = await cpoSendCommand(t1688.id, 'CPO_READ_1688_TITLE');
    collected.title = r1.title;
    await chrome.tabs.remove(t1688.id); tmpTabs.splice(tmpTabs.indexOf(t1688.id), 1);
    await cpoSetState({ step: 2, collectedData: collected });

    // 步骤2：起点 temu 列表查 SKC 读货号
    cpoNotify(originTabId, 'CPO_PROGRESS', { step: 2, label: '查询 SKC、读取 SKU货号' });
    const r2 = await cpoSendCommand(originTabId, 'CPO_QUERY_SKC_GET_NO', { skc });
    if (!r2.skuNo || !String(r2.skuNo).trim()) {
      cpoNotify(originTabId, 'CPO_ERROR', { step: 2, message: '该商品需先维护货号', kind: 'validate' });
      await cpoSetState({ status: 'error', step: 2 });
      return;
    }
    collected.skuNo = r2.skuNo.trim();
    await cpoSetState({ step: 3, collectedData: collected });

    // 步骤3：点编辑（新开 edit tab）→ 抓预览图 → 关
    cpoNotify(originTabId, 'CPO_PROGRESS', { step: 3, label: '进入编辑页、读取预览图' });
    const editTabP = cpoWaitForUrl(u => u.includes('/goods/edit'));
    await cpoSendCommand(originTabId, 'CPO_CLICK_EDIT', { skc });
    const editTabId = await editTabP;
    tmpTabs.push(editTabId);
    const r3 = await cpoSendCommand(editTabId, 'CPO_GRAB_PREVIEW');
    collected.previewUrl = r3.previewUrl;
    await chrome.tabs.remove(editTabId); tmpTabs.splice(tmpTabs.indexOf(editTabId), 1);
    await cpoSetState({ step: 4, collectedData: collected });

    // 步骤4：开店小秘 index → 进添加单个SKU → 填表（停在保存前）
    cpoNotify(originTabId, 'CPO_PROGRESS', { step: 4, label: '店小秘填表' });
    const tDxm = await chrome.tabs.create({ url: CPO_DXM_INDEX_URL, active: true });
    await cpoWaitTabComplete(tDxm.id);
    const addTabP = cpoWaitForUrl(u => u.includes('openAddModal'));
    await cpoSendCommand(tDxm.id, 'CPO_DXM_OPEN_ADD');
    const addTabId = await addTabP;       // 同 tab 跳转或新开 tab 都覆盖
    await cpoSendCommand(addTabId, 'CPO_FILL_DXM', { collected });

    await cpoSetState({ status: 'awaiting_save', step: 4, collectedData: collected });
    cpoNotify(originTabId, 'CPO_DONE', {});
  } catch (e) {
    // 回收所有未关闭的临时 tab
    for (const id of tmpTabs) { chrome.tabs.remove(id).catch(() => {}); }
    cpoNotify(originTabId, 'CPO_ERROR', { step: '?', message: String(e?.message || e), kind: 'read' });
    await cpoSetState({ status: 'error' });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'CPO_START') return;            // 只接管 CPO_START；其余命令是 bg→content，不在此
  const originTabId = sender.tab?.id;
  if (!originTabId) { sendResponse({ ok: false, error: '无起点 tab' }); return; }
  cpoRun(originTabId, msg.data);                   // 异步跑，不阻塞 ack
  sendResponse({ ok: true });                      // 立即 ack
});
// ── end create_purchase_order ────────────────────────────────────────────────
