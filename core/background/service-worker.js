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
const CPO_DXM_ADD_URL = 'https://www.dianxiaomi.com/web/dxmCommodityProduct/openAddModal?type=0&editOrCopy=0';
const CPO_CMD_TIMEOUT   = 20000;   // 单条命令往返超时
const CPO_READY_RETRIES = 25;      // 等 content 就绪重试次数（每次 200ms ≈ 5s）

// 写 cpo_state.phase1（单一状态源；content 各 tab 靠 storage.onChanged 同步显示）
function cpoSetPhase1(patch) {
  return chrome.storage.local.get('cpo_state').then(({ cpo_state }) => {
    const cur = cpo_state || {};
    const p1 = { status: 'idle', step: 0, label: '', collected: {}, ...(cur.phase1 || {}), ...patch };
    return chrome.storage.local.set({ cpo_state: { ...cur, phase1: p1, updatedAt: Date.now() } });
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

// 关 tab 前往 MAIN world 注入抑制 beforeunload（编辑页有「未保存」守卫，
// 直接 remove 会弹「退出后修改取消」确认框阻塞流程）。capture 阶段 stopImmediatePropagation
// 让页面自身的 beforeunload 监听器不执行 → 不弹框。
async function cpoCloseTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        window.onbeforeunload = null;
        window.addEventListener('beforeunload', e => { e.stopImmediatePropagation(); delete e.returnValue; }, true);
      },
    });
  } catch (_) { /* 注入失败也继续尝试关 */ }
  await chrome.tabs.remove(tabId);
}

// 主编排序列（Phase 1）。进度全部写 cpo_state.phase1，各 tab 面板靠 storage.onChanged 同步
async function cpoRun({ url1688, skc, skuNo, spuId }) {
  const serial = url1688.match(/\/offer\/(\d+)/)?.[1] || null;
  if (!serial) { await cpoSetPhase1({ status: 'error', label: '1688商品url 无法提取 serial' }); return; }
  if (!skuNo || !String(skuNo).trim()) { await cpoSetPhase1({ status: 'error', label: '该商品需先维护货号' }); return; }
  if (!spuId) { await cpoSetPhase1({ status: 'error', label: '未读到 SPU ID（无法定位编辑页）' }); return; }

  const collected = { skc, url1688, serial, title: '', skuNo: String(skuNo).trim(), previewUrl: '', spuId };
  const tmpTabs = [];   // 临时 tab，出错时统一回收
  try {
    // 新 workflow：整体重置 cpo_state（phase1 running + phase2 归零）——这就是「上次状态」的清理时机
    await chrome.storage.local.set({
      cpo_state: { phase1: { status: 'running', step: 1, label: '读取 1688 标题', collected }, phase2: { status: 'idle' }, updatedAt: Date.now() },
    });

    // 步骤1：后台开 1688 → 抓标题 → 关（仅取 document.title，不需渲染，后台即可）
    const t1688 = await chrome.tabs.create({ url: url1688, active: false });
    tmpTabs.push(t1688.id);
    await cpoWaitTabComplete(t1688.id);
    const r1 = await cpoSendCommand(t1688.id, 'CPO_READ_1688_TITLE');
    collected.title = r1.title;
    await cpoCloseTab(t1688.id); tmpTabs.splice(tmpTabs.indexOf(t1688.id), 1);
    await cpoSetPhase1({ step: 2, label: '打开编辑页、读取预览图', collected });

    // 步骤2：用 SPU ID 构造编辑页 URL【前台 active】打开 → 抓预览图 → 关
    // 前台原因：编辑页 SKU 信息框/预览图在后台 tab 不渲染（实测）；且让用户看到运行过程
    const editUrl = `https://agentseller.temu.com/goods/edit?from=productList&productId=${spuId}`;
    const tEdit = await chrome.tabs.create({ url: editUrl, active: true });
    tmpTabs.push(tEdit.id);
    await cpoWaitTabComplete(tEdit.id);
    const r2 = await cpoSendCommand(tEdit.id, 'CPO_GRAB_PREVIEW');
    collected.previewUrl = r2.previewUrl;
    await cpoCloseTab(tEdit.id); tmpTabs.splice(tmpTabs.indexOf(tEdit.id), 1);
    await cpoSetPhase1({ step: 3, label: '店小秘填表并保存', collected });

    // 步骤3：开店小秘「添加单个SKU」页（前台）→ 填表 → 自动保存
    const tDxm = await chrome.tabs.create({ url: CPO_DXM_ADD_URL, active: true });
    await cpoWaitTabComplete(tDxm.id);
    await cpoSendCommand(tDxm.id, 'CPO_FILL_DXM', { collected });

    await cpoSetPhase1({ status: 'done', step: 3, label: '已自动填写并提交保存', collected });
  } catch (e) {
    for (const id of tmpTabs) { chrome.tabs.remove(id).catch(() => {}); }
    await cpoSetPhase1({ status: 'error', label: String(e?.message || e) });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'CPO_START') return;            // 只接管 CPO_START；其余命令是 bg→content
  cpoRun(msg.data);                                // 异步跑，进度写 storage；不阻塞 ack
  sendResponse({ ok: true });
});
// ── end create_purchase_order ────────────────────────────────────────────────
