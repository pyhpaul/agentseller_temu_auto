// ── auto-reload-on-installer-update ── 扩展自检 + 自动 reload ───────────────
// chrome 不监控 unpacked 扩展文件变化，员工装新版 installer 后 chrome 仍跑旧版。
// 本段在 SW 实例化时（每次唤醒）调 native host 读磁盘 marker，磁盘版本 > 当前
// 加载版本 → chrome.runtime.reload() 自我重载（chrome 唯一允许扩展自我重载的 API）。
// silent fail：native host 未注册 / 旧 EXE / marker 缺失都不阻断业务。
importScripts('version-cmp.js');   // 加载 cmpVersion（双模式纯逻辑模块）

async function checkInstalledVersion() {
  let port;
  try {
    port = chrome.runtime.connectNative('com.temu.label_host');
    const res = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 3000);
      port.onMessage.addListener(m => { clearTimeout(t); resolve(m); });
      port.onDisconnect.addListener(() => { clearTimeout(t); reject(new Error('disconnected')); });
      port.postMessage({ action: 'get_installed_version' });
    });
    if (!res?.success || !res.version) return;
    const clean = v => String(v).split('-')[0].trim();   // 截 rc/dev 后缀，与 normalize_manifest_version 等价
    const installed = clean(res.version);
    const loaded = clean(chrome.runtime.getManifest().version);
    if (cmpVersion(installed, loaded) > 0) {
      console.log(`[auto-reload] 磁盘 v${installed} > 加载 v${loaded}，自动 reload`);
      chrome.runtime.reload();
    }
  } catch { /* native host 未注册 / 旧 EXE / marker 缺失 / 超时 → silent，不影响业务 */ }
  finally { try { port?.disconnect(); } catch {} }
}
checkInstalledVersion();   // SW 实例化即跑（顶层模式，与 enableSessionStorageAccess 一致）
chrome.runtime.onStartup.addListener(checkInstalledVersion);
chrome.runtime.onInstalled.addListener(checkInstalledVersion);
// ── end auto-reload-on-installer-update ──────────────────────────────────────

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

  if (msg.type === 'OPEN_MONITOR') {
    const url = chrome.runtime.getURL('dashboard/dashboard.html');
    // 已开则聚焦，未开则新建独立窗口（popup 型，可置顶盯盘）。失败兜底退化为 tab。
    (async () => {
      try {
        const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup', 'normal'] });
        for (const w of wins) {
          const hit = (w.tabs || []).find(t => t.url === url);
          if (hit) {
            await chrome.windows.update(w.id, { focused: true });
            sendResponse({ success: true, focused: true });
            return;
          }
        }
        await chrome.windows.create({ url, type: 'popup', width: 1280, height: 860 });
        sendResponse({ success: true, created: true });
      } catch (e) {
        try { await chrome.tabs.create({ url }); sendResponse({ success: true, fallbackTab: true }); }
        catch (e2) { sendResponse({ success: false, error: String(e2?.message || e2) }); }
      }
    })();
    return true;
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
const CPO_DXM_INDEX_URL = 'https://www.dianxiaomi.com/web/dxmCommodityProduct/index';
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

    // 保存后确保落到 index 看新增 SKU：先轮询 ~8s 等店小秘处理完（自己离开 add 页）；
    // 然后若 tab 不在 index，就【强制关掉 add tab + 新开 index tab】——比 in-page 导航稳，
    // 绕开未保存守卫与店小秘自身路由的竞争。
    for (let i = 0; i < 40; i++) {                 // 40 × 200ms = 8s
      await new Promise(r => setTimeout(r, 200));
      const t = await chrome.tabs.get(tDxm.id).catch(() => null);
      if (!t || !/openAddModal/.test(t.url || '')) break;   // tab 没了 / 店小秘自己跳走
    }
    const fin = await chrome.tabs.get(tDxm.id).catch(() => null);
    if (!fin || !/dxmCommodityProduct\/index/.test(fin.url || '')) {
      if (fin) await cpoCloseTab(tDxm.id);         // 抑制 beforeunload 后关掉 add tab
      await chrome.tabs.create({ url: CPO_DXM_INDEX_URL, active: true });
    }

    await cpoSetPhase1({ status: 'done', step: 3, label: '已自动填写并提交保存', collected });
  } catch (e) {
    for (const id of tmpTabs) { chrome.tabs.remove(id).catch(() => {}); }
    await cpoSetPhase1({ status: 'error', label: String(e?.message || e) });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'CPO_START') return;            // 只接管 CPO_START；其余命令是 bg→content
  if (!msg.data) { sendResponse({ ok: false, error: '缺少启动参数' }); return; }
  cpoRun(msg.data);                                // 异步跑，进度写 storage；不阻塞 ack
  sendResponse({ ok: true });
});

// ── Phase 2：创建现有订单跨 tab 编排 ──
const CPO_DXM_PO_ADD_URL = 'https://www.dianxiaomi.com/web/purchasing/order/add?pageType=2&isAlibaba=1&isPaste=1';
const CPO_DXM_WAIT_URL  = 'https://www.dianxiaomi.com/web/purchasing/order/waitArrival';

// 写 cpo_state.phase2（单一状态源；各 tab 面板靠 storage.onChanged 同步）
function cpoSetPhase2(patch) {
  return chrome.storage.local.get('cpo_state').then(({ cpo_state }) => {
    const cur = cpo_state || {};
    const p2 = { status: 'idle', step: 0, label: '', collected2: {}, ...(cur.phase2 || {}), ...patch };
    return chrome.storage.local.set({ cpo_state: { ...cur, phase2: p2, updatedAt: Date.now() } });
  });
}

// add→edit：「获取1688订单」成功后店小秘跳 edit（同 tab 导航或新弹 tab 都覆盖）→ edit tabId
function cpoWaitEditTab(addTabId, timeout = 30000) {
  const pred = u => /\/purchasing\/order\/edit/.test(u);
  let cleanup = () => {};
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('获取1688订单后未跳转到采购单编辑页')); }, timeout);
    function onUpdated(id, info, tab) {
      const url = (tab && tab.url) || info.url || '';
      if (url && pred(url) && tab.status === 'complete' && (id === addTabId || tab.openerTabId === addTabId)) {
        cleanup(); resolve(id);
      }
    }
    cleanup = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
  return { promise, cancel: () => cleanup() };
}

// 半自动确认框：等用户在 edit 页点「确认保存」/「取消」。三路兜底防 cpoRun2 悬挂：
// ① 用户点击 → sendMessage resolve；② edit tab 被关 → onRemoved 立即按 cancelled；
// ③ 通道异常 / 5min 超时兜底（远超人工核对时长，仅防极端导航绕过守卫导致永久挂起）
function cpoConfirmSave(editTabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(r);
    };
    const onRemoved = (id) => { if (id === editTabId) finish({ cancelled: true }); };
    const timer = setTimeout(() => finish({ cancelled: true }), 300000);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.sendMessage(editTabId, { type: 'CPO_P2_CONFIRM_SAVE', data: {} })
      .then(r => finish(r || {}))
      .catch(() => finish({ cancelled: true }));
  });
}

// 在 originTabId 右侧新开 tab（流程 tab 紧邻触发页，不堆到标签栏末尾）
async function cpoCreateTabNextTo(url, originTabId) {
  const opts = { url, active: true };
  if (originTabId != null) {
    try {
      const o = await chrome.tabs.get(originTabId);
      opts.index = o.index + 1;
      opts.openerTabId = originTabId;
    } catch (e) { /* origin tab 已关，退化为默认末尾位置 */ }
  }
  return chrome.tabs.create(opts);
}

// error 退出时把焦点切回触发页（点「开始」的 tab），不留用户停在残破/空白页
function cpoFocusOrigin(originTabId) {
  if (originTabId != null) chrome.tabs.update(originTabId, { active: true }).catch(() => {});
}

// Phase 2 主编排：创建现有订单 → 通过审核 → 待到货定位 → 停在申请付款前
// 新开独立 tab 跑全流程，不复用触发方 tab；originTabId 仅用于「新 tab 定位」+「error 切回」
async function cpoRun2({ orderNo1688, autoSave = true, repurchase = false, warehouse = 'default' }, originTabId = null) {
  const { cpo_state } = await chrome.storage.local.get('cpo_state');
  const p1 = (cpo_state && cpo_state.phase1) || {};
  // skuNo 来源分叉：新品用 Phase 1 采集值 + 强校验 phase1 done；复购跳过 phase1，skuNo 留空
  let skuNo = '';                        // 新品才用; 复购下 skuNo 留空 (handler 应判 repurchase 字段, 不要用 skuNo 是否为空)
  if (!repurchase) {
    skuNo = ((p1.collected && p1.collected.skuNo) || '').trim();
    if (p1.status !== 'done') { await cpoSetPhase2({ status: 'error', label: '请先完成 Phase 1 添加SKU' }); return; }
    if (!skuNo) { await cpoSetPhase2({ status: 'error', label: 'Phase 1 未采集到 SKU货号' }); return; }
  }
  if (!orderNo1688 || !orderNo1688.trim()) { await cpoSetPhase2({ status: 'error', label: '1688订单号不能为空' }); return; }
  const order = orderNo1688.trim();

  const collected2 = { poNo: '', orderNo1688: order };
  const tmpTabs = [];   // 临时 tab，出错统一回收（待到货页除外；当前 draft tab 也不回收）
  try {
    await cpoSetPhase2({ status: 'running', step: 1, label: '导航到创建采购单页', collected2 });

    // step1：新开 tab 导航到 add 页（绕开 dropdown；Ant Design Vue isTrusted 检查阻止 programmatic click）
    const addTabId = (await cpoCreateTabNextTo(CPO_DXM_PO_ADD_URL, originTabId)).id;
    await cpoWaitTabComplete(addTabId);
    tmpTabs.push(addTabId);

    // step2-3：add 选账号+填单号+获取；弹窗分流（bg 主导）
    await cpoSetPhase2({ step: 2, label: '填写1688账号与订单号、获取订单', collected2 });
    await cpoWaitTabComplete(addTabId);
    const editWaiter = cpoWaitEditTab(addTabId);            // 先挂 edit 监听（注册时序）
    const editTabP = editWaiter.promise.catch(() => null);  // 超时返回 null
    let exists = false;
    try {
      const r = await cpoSendCommand(addTabId, 'CPO_P2_ADD_FETCH', { orderNo1688: order });
      if (r && r.ok === false) {
        const err = new Error(r.error || 'ADD_FETCH 失败');
        err._handlerError = true;   // 标记：是 handler 逻辑失败，不是导航通道销毁
        throw err;
      }
      exists = !!(r && r.exists);
    } catch (e) {
      if (e._handlerError) { editWaiter.cancel(); throw e; }
      // 其余异常 = content 通道销毁（tab 跳转到 edit 是正常路径），靠 editTabP 接管
      // 常见措辞：receiving end / channel closed / disconnected / back/forward cache / message channel
    }
    if (exists) {
      editWaiter.cancel();          // 已入库不跳 edit，主动清理 edit 监听（避免 30s 孤儿监听）
      await cpoCloseTab(addTabId);
      cpoFocusOrigin(originTabId);
      await cpoSetPhase2({ status: 'error', label: '当前输入的1688订单号已入库', collected2 });
      return;
    }

    // step3→4：接管 edit tab
    await cpoSetPhase2({ step: 3, label: '进入采购单编辑页', collected2 });
    const editTabId = await editTabP;
    if (!editTabId) throw new Error('获取1688订单后未跳转到采购单编辑页');
    tmpTabs.push(editTabId);
    await cpoWaitTabComplete(editTabId);

    // step4：edit 填采购人员/收货仓库 + 配对商品
    await cpoSetPhase2({ step: 4, label: '填采购人员/收货仓库、配对商品', collected2 });
    await cpoSendCommand(editTabId, 'CPO_P2_EDIT_FILL', { skuNo, repurchase, warehouse });

    // step5：半自动模式（autoSave=false）先弹可拖动确认框，等用户核对后再保存
    // 用 chrome.tabs.sendMessage 直发（不走 cpoSendCommand：那有 20s 超时 + retry，会打断/重复弹窗）
    if (!autoSave) {
      await cpoSetPhase2({ step: 5, label: '请核对采购信息，在弹窗点「确认保存」', collected2 });
      const confirm = await cpoConfirmSave(editTabId);   // 含 tab 关闭/超时兜底，不会永久悬挂
      if (confirm && confirm.cancelled) {
        await cpoSetPhase2({ status: 'error', label: '已取消自动保存，请在采购单页手动核对并保存', collected2 });
        return;   // 正常退出不回收 tab，edit 页留给用户接管
      }
    }
    // step5：保存并通过审核 → 抓成功弹窗提采购单号
    await cpoSetPhase2({ step: 5, label: '保存并通过审核', collected2 });
    const rSave = await cpoSendCommand(editTabId, 'CPO_P2_EDIT_SAVE');
    collected2.poNo = rSave.poNo;
    await cpoSetPhase2({ step: 5, label: '已通过审核，采购单 ' + rSave.poNo, collected2 }); // 同 step 二次更新：显示审核结果（故意，非笔误）

    // step6：开待到货页搜索定位（新开 tab + 关 edit tab，避免 edit 未保存守卫阻塞 update + 残留）
    await cpoSetPhase2({ step: 6, label: '打开待到货页、搜索定位商品', collected2 });
    await cpoCloseTab(editTabId); tmpTabs.splice(tmpTabs.indexOf(editTabId), 1);
    const tWait = await cpoCreateTabNextTo(CPO_DXM_WAIT_URL, originTabId);
    await cpoWaitTabComplete(tWait.id);
    const rWait = await cpoSendCommand(tWait.id, 'CPO_P2_WAIT_SEARCH', { poNo: collected2.poNo });
    // tWait 待到货页保留给用户提交付款申请，不加入 tmpTabs、不回收

    // step7：done。申请付款弹窗已自动打开则提示提交；降级路径（按钮/弹窗没找到）提示手动点
    const doneLabel = rWait && rWait.paymentModalOpened
      ? '已打开申请付款弹窗，请核对金额后点「提交申请」'
      : '已定位采购单，请手动点「申请付款」完成';
    await cpoSetPhase2({ status: 'done', step: 7, label: doneLabel, collected2 });
  } catch (e) {
    for (const id of tmpTabs) { chrome.tabs.remove(id).catch(() => {}); }
    cpoFocusOrigin(originTabId);
    await cpoSetPhase2({ status: 'error', label: String(e?.message || e), collected2 });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'CPO_START_PHASE2') return;     // 只接管 CPO_START_PHASE2
  if (!msg.data) { sendResponse({ ok: false, error: '缺少启动参数' }); return; }
  cpoRun2(msg.data, _sender.tab?.id ?? null);       // 新开独立 tab；传触发方 tab 仅供新 tab 定位 + error 切回
  sendResponse({ ok: true });
});
// ── end create_purchase_order ────────────────────────────────────────────────

// ── orchestrator ── 确定性编排器 bg 接线（Plan 2-2a）─────────────────────────
// Plan 2-1 纯逻辑核心（steps/state-machine/recovery/mutation-queue/engine）接真实 chrome。
// 发版（D2）：importScripts 纯定义无副作用；唯一触发源是浮层「开始」(2-2c,isDev 守卫,release 不注入)，
// 故 release 无人发 WF_START；恢复对空 storage noop → orchestrator 在 release 沉睡无副作用。
importScripts(
  '../contract.js',
  'orchestrator/steps.js',
  'orchestrator/state-machine.js',
  'orchestrator/recovery.js',
  'orchestrator/mutation-queue.js',
  'orchestrator/engine.js',
);

const ORCH = {
  contract: self.__AS_DASH_CONTRACT__,
  steps: self.__AS_ORCH_STEPS__,
  mq: self.__AS_ORCH_MQ__,
  engine: self.__AS_ORCH_ENGINE__,
};

// storage 读写适配：read 经 normalizeSkeleton 兜底（缺失/损坏→emptyBatch）；write 整 skeleton
function orchRead() {
  const { STORAGE_KEY, normalizeSkeleton } = ORCH.contract;
  return chrome.storage.local.get(STORAGE_KEY).then(r => normalizeSkeleton(r[STORAGE_KEY]));
}
function orchWrite(skeleton) {
  return chrome.storage.local.set({ [ORCH.contract.STORAGE_KEY]: skeleton });
}

const orchQueue = ORCH.mq.makeMutationQueue(orchRead, orchWrite);

// stub stepRunner（2-2a）：模拟 auto 步成功，让骨架端到端可验证。
// 2-2b 换真实：导航 tab → waitForEl(step.target.readySignal) → 调 feature 命令 → 收结构化回报。
async function orchStubStepRunner(step) {
  await new Promise(r => setTimeout(r, 300));   // 模拟耗时
  console.log(`[orch-stub] 自动步「${step.label}」(feature=${step.feature}) 模拟完成`);
  return { status: 'done', result: { stub: step.id, feature: step.feature }, error: null };
}

// ── 通用 adapter 基建（无命令处理器 feature 接入；后续 ship/gen_label 复用）──────────────
// CPO 自管 tab、adapter 直接 await；其余 feature 无处理器,adapter 要主动:
// 导航 tab(orchNavigateAndWait)→ 发命令(orchSendStepCommand)→ 长任务轮询 storage 终态(orchPollState)。

// 导航到 url(前台 active 防失焦不渲染)→ 等 tab complete → executeScript 轮询 readySignal → 返回 tabId
// ⚠ readySignal 检查依赖 manifest host_permissions 含目标域(scripting 权限 CPO cpoCloseTab 已在用);
//   executeScript 失败(权限/页面未就绪)→ false 继续轮询,超时才抛——content handler 首行 waitForEl 再兜一层。
async function orchNavigateAndWait(url, readySignal, { tabTimeoutMs = 30000, readyTimeoutMs = 30000 } = {}) {
  const tab = await chrome.tabs.create({ url, active: true });
  await cpoWaitTabComplete(tab.id, tabTimeoutMs);
  if (!readySignal) return tab.id;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    const hit = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: sel => !!document.querySelector(sel), args: [readySignal],
    }).then(arr => !!(arr && arr[0] && arr[0].result)).catch(() => false);
    if (hit) return tab.id;
    await new Promise(res => setTimeout(res, 300));
  }
  throw new Error('readySignal 超时: ' + readySignal);
}

// 向 tab 发命令(content 未就绪重试)。不套 CPO 的 resp.ok===false→throw(CPO 私有协议),
// 直接返回 resp 由 adapter 自行解读({ok,started}/{status,...})。timeoutMs 可配(ship 单单长)。
async function orchSendStepCommand(tabId, type, data, { timeoutMs = 30000, retries = 25 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(tabId, { type, data }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('命令超时: ' + type)), timeoutMs)),
      ]);
    } catch (e) {
      lastErr = e;
      if (!/Receiving end does not exist|Could not establish connection/.test(String(e?.message || e))) throw e;
      await new Promise(r => setTimeout(r, 200));   // content 还没注入,等等再试
    }
  }
  throw lastErr || new Error('命令无法送达: ' + type);
}

// 轮询 chrome.storage.local[key] 到终态(status==='done'|'error')。fire-forget 长任务用:
// content 自驱跑、SW 只观察 storage(不受单条 message 通道/SW 5min await 限)。
// onTick 给需要的 feature 在中途标 committing(pack_label 可逆不用)。超时返回 error 终态。
async function orchPollState(key, { timeoutMs, intervalMs = 2000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const obj = (await chrome.storage.local.get(key))[key] || {};
    if (onTick) await onTick(obj);
    if (obj.status === 'done' || obj.status === 'error') return obj;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { status: 'error', code: 'POLL_TIMEOUT', message: key + ' 轮询超时' };
}

// ── CPO adapter（create_sku / create_po）─────────────────────────────────────
// CPO 自管 tab（cpoRun/cpoRun2 内部 chrome.tabs.create）：adapter 不导航/不 waitForEl，
// 直接 await（两者 async、await 到终态才返回、done/error 都写 cpo_state.phaseN 正常返回不 throw），
// 再读 cpo_state 桥接回 engine 的 {status,result,error}。cpo_state(CPO 私有)与 as_workflow_state(编排器)并存。

// 标记/清除当前 cursor step 的 committing（不可逆提交点保护，spec §4.2/§7；走 orchQueue 串行化）
function orchMarkCommitting(workflowId, value) {
  return orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf) return undefined;
    wf.steps[wf.cursor].committing = value;
    return skeleton;
  });
}

// create_sku（Phase1，△半可逆）：product → CPO_START 入参（cpoRun 内部校验 serial/skuNo/spuId）→ 读 phase1
async function orchAdapterCreateSku(step, wf) {
  const { url1688, skc, skuNo, spuId } = (wf && wf.product) || {};
  if (!url1688) return { status: 'error', error: { category: 'validate', code: 'MISSING_URL1688', message: '缺 1688 链接（比价/下单步未回填 url1688）', recoverable: false } };
  await cpoRun({ url1688, skc, skuNo, spuId });
  const { cpo_state } = await chrome.storage.local.get('cpo_state');
  const p1 = (cpo_state && cpo_state.phase1) || {};
  if (p1.status === 'done') return { status: 'done', result: { skuNo: (p1.collected && p1.collected.skuNo) || skuNo || null }, error: null };
  return { status: 'error', error: { category: 'business', code: 'CPO_P1_FAILED', message: p1.label || '建店小秘 SKU 失败', recoverable: false } };
}

// create_po（Phase2，✗强不可逆）：committing 包裹 → product.orderNo1688 → CPO_START_PHASE2(autoSave 全自动) → 读 phase2
async function orchAdapterCreatePo(step, wf) {
  const orderNo1688 = (wf && wf.product && wf.product.orderNo1688) || '';
  if (!orderNo1688) return { status: 'error', error: { category: 'validate', code: 'MISSING_ORDER_NO', message: '缺 1688 订单号（下单步未回填 orderNo1688）', recoverable: false } };
  await orchMarkCommitting(wf.id, true);   // 不可逆提交点前标记；正常路径 engine 收尾清 committing，回收路径留 true→恢复转人工
  await cpoRun2({ orderNo1688, autoSave: true, repurchase: false, warehouse: 'default' }, null);
  const { cpo_state } = await chrome.storage.local.get('cpo_state');
  const p2 = (cpo_state && cpo_state.phase2) || {};
  if (p2.status === 'done') return { status: 'done', result: { poNo: (p2.collected2 && p2.collected2.poNo) || null }, error: null };
  return { status: 'error', error: { category: 'business', code: 'CPO_P2_FAILED', message: p2.label || '创建采购单失败', recoverable: false } };
}

// ── packing_label adapter（pack_label,可逆无 committing）─────────────────────
// 无处理器 feature:adapter 主动 导航→等就绪→发命令(fire-forget)→轮询 pl_state。复用通用 helper。
async function orchAdapterPackLabel(step, wf) {
  const target = step.target || {};
  const url = target.url || 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list';
  // 1. 清旧 pl_state(防读到上次残留终态)
  await chrome.storage.local.set({ pl_state: { status: 'idle', updatedAt: Date.now() } });
  // 2. 导航 + 等就绪(前台 active 防失焦不渲染)
  let tabId;
  try {
    tabId = await orchNavigateAndWait(url, target.readySignal, { readyTimeoutMs: 30000 });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'PACK_NAV_FAILED', message: '打包标签页打不开或未就绪:' + String(e?.message || e), recoverable: true } };
  }
  // 3. 发命令(fire-forget:content 立即 ack started,后台自驱跑)
  let ack;
  try {
    ack = await orchSendStepCommand(tabId, 'PL_START_BATCH', {});
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'PACK_CMD_FAILED', message: '打包命令未送达:' + String(e?.message || e), recoverable: true } };
  }
  if (ack && ack.started === false) {
    return { status: 'error', error: { category: 'validate', code: 'PACK_NO_TARGET', message: ack.error || '无可打印的待打包商品', recoverable: false } };
  }
  // 4. 轮询 pl_state 终态(content 自驱跑完写,不受 SW 5min await 限)
  const st = await orchPollState('pl_state', { timeoutMs: 8 * 60 * 1000, intervalMs: 3000 });
  if (st.status === 'done') {
    return { status: 'done', result: { savedCount: st.ok || 0, saveDir: st.saveDir || null, files: st.files || [], failedCount: st.failedCount || 0 }, error: null };
  }
  return { status: 'error', error: { category: st.errorCategory || 'business', code: st.code || 'PACK_BATCH_FAILED', message: st.error || st.message || '打包标签失败', recoverable: false } };
}

// ── auto_ship adapter（ship,✗强不可逆）─────────────────────────────────────
// 无处理器 feature:adapter 导航→等就绪→committing 包裹→直接回报(单单 30-60s,非 fire-forget)。
async function orchAdapterShip(step, wf) {
  const target = step.target || {};
  const url = target.url || 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list';
  let tabId;
  try {
    tabId = await orchNavigateAndWait(url, target.readySignal, { readyTimeoutMs: 30000 });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'SHIP_NAV_FAILED', message: '发货页打不开或未就绪:' + String(e?.message || e), recoverable: true } };
  }
  // ★强不可逆提交点:发命令前标 committing(粗粒度取安全;正常 engine 收尾清,回收留 true→转人工不自动重发)
  await orchMarkCommitting(wf.id, true);
  let resp;
  try {
    resp = await orchSendStepCommand(tabId, 'AUTO_SHIP_RUN_ONE', {}, { timeoutMs: 180000, retries: 25 });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'SHIP_CMD_FAILED', message: '发货命令未送达:' + String(e?.message || e), recoverable: false } };
  }
  // content 回 {status,result,error},直接透传给 engine(advance 据 status 落地、清 committing)
  return resp || { status: 'error', error: { category: 'read', code: 'SHIP_NO_RESP', message: '发货命令无响应', recoverable: false } };
}

// ── auto_gen_label adapter（gen_label,✗强不可逆·跨页自驱）─────────────────────
// content 跨 4 页自驱、SW 无法 await：fire-forget+轮询 agl_state（同 pack_label）。
// committing 用 onTick 在 content 报告"合规提交"阶段标（比 ship 发命令前粗标精准）。
async function orchAdapterGenLabel(step, wf) {
  const target = step.target || {};
  const url = target.url || 'https://seller.temu.com/goods/label';
  // 1. 清旧 agl_state(防读到上次残留终态)
  await chrome.storage.local.remove('agl_state');
  // 2. 导航条码页 + 等表格行就绪(前台 active 防失焦不渲染)
  let tabId;
  try {
    tabId = await orchNavigateAndWait(url, target.readySignal, { readyTimeoutMs: 30000 });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'AGL_NAV_FAILED', message: '条码管理页打不开或未就绪:' + String(e?.message || e), recoverable: true } };
  }
  // 3. 发命令(fire-forget:content 立即 ack started,后台跑 Phase1+跨页自驱)
  let ack;
  try {
    ack = await orchSendStepCommand(tabId, 'AGL_GEN_LABEL', { skc: (wf && wf.product && wf.product.skc) || null });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'AGL_CMD_FAILED', message: '标签生成命令未送达:' + String(e?.message || e), recoverable: true } };
  }
  if (ack && ack.started === false) {
    const reasonMap = {
      NO_PATHS: '模板/输出路径未配置(请先在 feature view 设置一次,localStorage 持久)',
      NO_SKC: '缺 SKC(product.skc 为空,上游 HITL 未回填)',
      ROW_NOT_FOUND: '条码管理页未找到该 SKC 对应商品行',
      NO_SKC_SKU: '该商品无 SKC货号,无法生成标签',
    };
    return { status: 'error', error: { category: 'validate', code: 'AGL_NOT_STARTED', message: reasonMap[ack.reason] || ('未启动:' + ack.reason), recoverable: true } };
  }
  // 4. 轮询 agl_state 终态;onTick 在 content 报 committing 阶段时一次性标记
  let committed = false;
  const st = await orchPollState('agl_state', {
    timeoutMs: 10 * 60 * 1000, intervalMs: 3000,
    onTick: async (obj) => {
      if (!committed && obj && obj.phase === 'committing') {
        await orchMarkCommitting(wf.id, true);
        committed = true;
      }
    },
  });
  if (st.status === 'done') {
    return { status: 'done', result: st.result || {}, error: null };
  }
  return { status: 'error', error: { category: st.category || 'read', code: st.code || 'AGL_FAILED', message: st.message || '标签生成流程失败', recoverable: true } };
}

// ── check_and_publish adapter（publish,✗不可逆·复用上游编辑页 tab）──────────────
// 数据流死结:wf.product 无店小秘商品 URL 锚点 → 不导航,query 找 collect_dxm 留的编辑页 tab。
// 直接回报(检查+发布同 tab,无跨页);committing 发命令前粗标(检查 block 也转人工=填表缺口本需人工)。
async function orchAdapterPublish(step, wf) {
  // 1. 找上游编辑页 tab(url 含 dianxiaomi + edit;不导航,无 URL 锚点)
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: '*://*.dianxiaomi.com/*' });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'PUBLISH_TAB_QUERY_FAILED', message: 'tab 查询失败:' + String(e?.message || e), recoverable: true } };
  }
  const editTab = (tabs || []).find(t => /edit/i.test(t.url || ''));
  if (!editTab) {
    return { status: 'error', error: { category: 'read', code: 'PUBLISH_NO_EDIT_TAB', message: '未找到店小秘编辑页 tab(collect_dxm 后请保持编辑页打开)', recoverable: true } };
  }
  // 2. 激活编辑页 tab(前台防 Ant dropdown 后台 tab 不展开)
  try {
    await chrome.tabs.update(editTab.id, { active: true });
    await new Promise(res => setTimeout(res, 500));
  } catch (e) {
    console.warn('[orch][publish] 激活编辑页 tab 失败,继续尝试', e);
  }
  // 3. ★不可逆提交点:发命令前标 committing(粗粒度;检查 block 也标→恢复转人工=填表本需人工,无副作用)
  await orchMarkCommitting(wf.id, true);
  // 4. 发命令,直接回报(检查+发布同 tab,无跨页/无 storage)
  let resp;
  try {
    resp = await orchSendStepCommand(editTab.id, 'CAP_PUBLISH', {}, { timeoutMs: 60000 });
  } catch (e) {
    return { status: 'error', error: { category: 'read', code: 'PUBLISH_CMD_FAILED', message: '发布命令未送达:' + String(e?.message || e), recoverable: false } };
  }
  return resp || { status: 'error', error: { category: 'read', code: 'PUBLISH_NO_RESP', message: '发布命令无响应', recoverable: false } };
}

// adapter 注册表：按 step.id 分发（cpo 一 feature 两步，必须 id 粒度）。未接入 AUTO 步 → stub fallback。
const ORCH_ADAPTERS = {
  create_sku: orchAdapterCreateSku,
  create_po: orchAdapterCreatePo,
  pack_label: orchAdapterPackLabel,
  ship: orchAdapterShip,
  gen_label: orchAdapterGenLabel,
  publish: orchAdapterPublish,
};

// 真实 stepRunner：dispatch 到 adapter；未接入 step.id 回落 stub（13 步骨架仍端到端可跑）
async function orchRealStepRunner(step, wf) {
  const adapter = ORCH_ADAPTERS[step.id];
  return adapter ? adapter(step, wf) : orchStubStepRunner(step);
}

const orchEngine = ORCH.engine.makeEngine({
  read: orchRead, queue: orchQueue, stepRunner: orchRealStepRunner, now: () => Date.now(),
});

// SW 唤醒恢复：每次 SW 实例化（冷启 / 回收唤醒 / 浏览器启动）即跑。
// 不挂 onStartup——recover 不幂等（rerun 有副作用），靠顶层单次调用覆盖所有实例化场景。
async function orchRecoverAll() {
  try {
    const skeleton = await orchRead();
    const wf = (skeleton.batch.workflows || []).find(w => w.status === 'running');
    if (!wf) return;   // 无 running workflow（release 常态）→ noop
    console.log('[orch] SW 实例化，尝试恢复 workflow', wf.id);
    await orchEngine.recover(wf.id);
  } catch (e) { console.warn('[orch] 恢复失败（不影响其他业务）', e); }
}
orchRecoverAll();

// 编排器消息入口：WF_START（建+跑）/ WF_HITL_CONFIRM（确认推进）/ WF_HITL_REJECT / WF_ABORT
let orchWfSeq = 0;
function orchGenId() { return 'wf_' + Date.now() + '_' + (++orchWfSeq); }

async function orchStartWorkflow(product) {
  const wf = ORCH.steps.buildInitialWorkflow(product, orchGenId);
  wf.status = 'running'; wf.startedAt = Date.now();
  await orchQueue.enqueue(skeleton => {
    if (!skeleton.batch.id) { skeleton.batch.id = 'batch_' + Date.now(); skeleton.batch.createdAt = Date.now(); }
    skeleton.batch.workflows.push(wf);
    skeleton.batch.activeWorkflowId = wf.id;
    return skeleton;
  });
  orchEngine.advance(wf.id).catch(e => console.warn('[orch] advance 异常', e));   // 异步推进，不阻塞 ack
  return wf.id;
}

async function orchHitlConfirm({ workflowId, result }) {
  await orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf || wf.status !== 'paused') return undefined;
    const s = wf.steps[wf.cursor];
    s.status = 'done';
    if (result) { s.result = result; Object.assign(wf.product, ORCH.engine.pickProduct(result)); }
    if (wf.hitl) wf.hitl.status = 'confirmed';
    wf.status = 'running'; wf.updatedAt = Date.now();
    return skeleton;
  });
  orchEngine.advance(workflowId).catch(e => console.warn('[orch] advance 异常', e));   // HITL step 已 done → advance 推进 cursor 到下一步
}

async function orchSetAborted(workflowId, hitlStatus) {
  await orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf) return undefined;
    wf.status = 'aborted';
    if (hitlStatus && wf.hitl) wf.hitl.status = hitlStatus;
    wf.updatedAt = Date.now();
    return skeleton;
  });
}

// 重试：重置当前 cursor step→pending（清 error/committing）+ wf→running + advance（spec §6.2）。
// 仅 recoverable 错误在 overlay 有[重试]入口（error chip 守卫），故清 committing 安全：
// 不可逆步骤失败均 recoverable:false → 无重试入口，不会被本函数重发。
async function orchRetry(workflowId) {
  await orchQueue.enqueue(skeleton => {
    const wf = ORCH.engine.findWorkflow(skeleton, workflowId);
    if (!wf) return undefined;
    const step = wf.steps[wf.cursor];
    if (step) { step.status = 'pending'; step.error = null; step.committing = false; }
    wf.status = 'running'; wf.updatedAt = Date.now();
    return skeleton;
  });
  await orchEngine.advance(workflowId);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'WF_START') {
    orchStartWorkflow(msg.data || {})
      .then(id => sendResponse({ ok: true, workflowId: id }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'WF_HITL_CONFIRM') {
    orchHitlConfirm(msg.data || {})
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'WF_HITL_REJECT') {
    orchSetAborted((msg.data || {}).workflowId, 'rejected')
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'WF_ABORT') {
    orchSetAborted((msg.data || {}).workflowId, null)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'WF_RETRY') {
    orchRetry((msg.data || {}).workflowId)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});
// ── end orchestrator ─────────────────────────────────────────────────────────
