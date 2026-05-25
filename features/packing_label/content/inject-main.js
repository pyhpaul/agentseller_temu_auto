// 运行在 page MAIN world（feature.json: world:"MAIN", run_at:"document_start"）。
// 职责：① 捕获 application/pdf blob 字节 ② 拦截该 blob iframe 的打印预览。
// 仅在 isolated 侧开启「捕获模式」时介入；关闭时页面原行为不变。
(function () {
  'use strict';
  if (window.__PL_INJECTED__) return;
  window.__PL_INJECTED__ = true;

  let captureMode = false;
  let pendingCtxId = null;

  // isolated → main 控制消息
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__pl !== 'ctrl') return;
    if (e.data.action === 'start') { captureMode = true; pendingCtxId = e.data.ctxId ?? null; }
    else if (e.data.action === 'setCtx') { pendingCtxId = e.data.ctxId ?? null; }
    else if (e.data.action === 'stop') { captureMode = false; pendingCtxId = null; }
  });

  // ① 捕获 PDF blob 字节
  const origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const url = origCreate(obj);
    try {
      if (captureMode && obj instanceof Blob && obj.type === 'application/pdf') {
        const ctxId = pendingCtxId;
        obj.arrayBuffer()
          .then((buf) => window.postMessage({ __pl: 'pdf', ctxId, bytes: buf }, '*', [buf]))
          .catch((err) => window.postMessage({ __pl: 'pdferr', ctxId, error: String(err) }, '*'));
      }
    } catch (_) { /* 捕获失败不影响页面原流程 */ }
    return url;
  };

  // ② 拦截打印预览：页面 <iframe src=blob:> + iframe.contentWindow.print() 弹预览。
  // hook createElement，对 iframe 抢先注册 capture 阶段 load 监听器置空 print（先于页面 onload 执行）。
  const origCreateEl = Document.prototype.createElement;
  Document.prototype.createElement = function (tagName, ...rest) {
    const el = origCreateEl.call(this, tagName, ...rest);
    try {
      if (captureMode && String(tagName).toLowerCase() === 'iframe') {
        el.addEventListener('load', function () {
          try { if (el.contentWindow) el.contentWindow.print = function () {}; } catch (_) {}
        }, { capture: true, once: true });
      }
    } catch (_) {}
    return el;
  };
})();
