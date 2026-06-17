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
checkInstalledVersion();   // SW 实例化即跑（顶层模式，无需等事件）
chrome.runtime.onStartup.addListener(checkInstalledVersion);
chrome.runtime.onInstalled.addListener(checkInstalledVersion);
// ── end auto-reload-on-installer-update ──────────────────────────────────────


const NATIVE_HOST = 'com.temu.label_host';

// ── bg-router ── 数据化 bg 命令路由注册表 ────────────────────────────────────────
// feature/automation 的 bg 段通过 self.AgentSellerBg.registerHandler(prefix, fn) 注册命令处理器，
// 无需硬编码进 core SW。automation/bg-entry.js 经此注册 WF_*（编排器）+ OPEN_MONITOR（监控窗口）；
// core SW 保留的硬编码分支 = native 透传（其余 feature bg 经 registerHandler 注册，不硬编码）。
// 多 listener 并存（MV3 支持）：router 对未注册前缀返回 false，硬编码分支照常工作，互不干扰。
importScripts('bg-router.js');                     // 提供 self.__AS_BG_ROUTER__
const _asBgRouter = self.__AS_BG_ROUTER__.makeBgRouter();
self.AgentSellerBg = { registerHandler: (prefix, fn) => _asBgRouter.register(prefix, fn) };
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => _asBgRouter.route(msg, sender, sendResponse));
// 通用 tab 工具（self.AgentSellerBg.util.waitTabComplete）：被 CPO handler + automation orchestrator 共用，
// 故提到 core/background/。须在 AgentSellerBg 创建之后 importScripts（tab-utils 挂 AgentSellerBg.util）。
importScripts('tab-utils.js');
// ── end bg-router ─────────────────────────────────────────────────────────────

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
    const { skcNumber, skcSku, skuSku, barcodePngB64, templatePath, outputDir, widthRatio } = msg.data;

    sendToNativeHost({
      action: 'generate_label',
      skc_number: skcNumber,
      skc_sku: skcSku,
      sku_sku: skuSku,
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

  if (msg.type === 'OPEN_FOLDER') {
    sendToNativeHost({
      action: 'open_folder',
      path: msg.data.path
    })
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'OPTIMIZE_IMAGE') {
    sendToNativeHost({
      action: 'optimize_image',
      imageUrl: msg.data.imageUrl,
      options: msg.data.options || {}
    })
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({ connected: nativePort !== null });
  }
});
