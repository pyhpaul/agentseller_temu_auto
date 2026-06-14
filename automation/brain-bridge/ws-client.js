// core/background/ws-client.js — bg WebSocket 客户端架子（连大脑 localhost）。spec §4.2/§4.3。
// 架子（2-2c-2）：连接/重连/保活/消息路由结构就位；**不自启**（startWsClient 留 Plan 3 调）。
// 不传 RUN_STEP 业务（未注册 handler 即 stub-log）；真实调度 + SW 回收风险留 Plan 3（spec §4.3）。
// release：随 background/ 进包，但 SW 顶层不调 startWsClient → 沉睡 dead code 无害（同 OPEN_MONITOR）。
// 双模式：SW importScripts 挂 self.__AS_WS__；node require 测纯逻辑（nextReconnectDelay/encode）。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.__AS_WS__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WS_URL = 'ws://localhost:8787';   // 占位；Plan 3 对齐大脑 server 端口（与 dashboard ws-source 同）
  const PING_INTERVAL_MS = 25000;          // PING 保活间隔（spec §4.3 尽力保活，不替代恢复语义）
  const MAX_RECONNECT_DELAY_MS = 30000;

  // 重连退避：指数 1s→2s→4s… 封顶 30s（纯逻辑，可 node 测）
  function nextReconnectDelay(attempt) {
    return Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS);
  }

  // WS 消息封装 {type,data}（spec §4.2）
  function encode(type, data) {
    return JSON.stringify({ type, data: data || {} });
  }

  // 创建 WS 客户端。opts: {url, handlers:{<type>:fn(data,send)}, onStatus:fn('live'|'reconnecting'|'offline')}
  function createWsClient(opts = {}) {
    const url = opts.url || WS_URL;
    const handlers = opts.handlers || {};
    const onStatus = opts.onStatus || (() => {});

    let ws = null, attempt = 0, pingTimer = null, reconnectTimer = null, closed = false;

    function _clearTimers() {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    }
    function _scheduleReconnect() {
      if (closed || reconnectTimer) return;
      onStatus('reconnecting');
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, nextReconnectDelay(attempt++));
    }
    function connect() {
      if (closed) return;
      let sock;
      try { sock = new WebSocket(url); }
      catch (e) { console.warn('[ws] 构造失败，将重连', e); _scheduleReconnect(); return; }
      ws = sock;
      sock.onopen = () => {
        attempt = 0; onStatus('live');
        send('HELLO', { role: 'bg', v: 1 });   // 握手（spec §4.2）
        pingTimer = setInterval(() => send('PING', {}), PING_INTERVAL_MS);
      };
      sock.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { console.debug('[ws] 非法消息忽略', e); return; }
        const h = handlers[msg.type];
        if (h) h(msg.data, send);
        else if (msg.type !== 'PONG') console.log('[ws] 未处理消息（架子 stub，Plan 3 注册 handler）', msg.type);
      };
      sock.onclose = () => { _clearTimers(); onStatus('offline'); _scheduleReconnect(); };
      sock.onerror = () => { console.warn('[ws] 连接错误（onclose 将接管重连）'); };
    }
    function send(type, data) {
      if (ws && ws.readyState === 1) { ws.send(encode(type, data)); return true; }
      return false;   // 未连上：调用方自行决定（架子阶段恒 false）
    }
    function close() {
      closed = true; _clearTimers();
      if (ws) { try { ws.close(); } catch (e) { console.debug('[ws] close 忽略', e); } }
    }
    return { connect, send, close };
  }

  // 显式启动（Plan 3 在合适时机调，如 WF_START）；架子阶段 SW 顶层不调 → release 沉睡无害
  function startWsClient(opts) {
    const client = createWsClient(opts);
    client.connect();
    return client;
  }

  return { createWsClient, startWsClient, nextReconnectDelay, encode, WS_URL };
});
