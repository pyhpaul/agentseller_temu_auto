// ws-source.js — 血肉源：连真实大脑 WS（ws://localhost:8787），收 BRAIN_EVENT / HITL_DETAIL 喂 store。
// 连不上 → 灯标 offline + 延时重连（不回放 mock）。
// 取消 mock 降级的原因：真实链路测试要求不被假数据混淆——连上即真实大脑流，连不上即 offline 空态，
// 连接状态一眼可辨。startWsSource 签名不变。

const WS_URL = 'ws://localhost:8787';   // 对齐大脑 server 端口（与 bg ws-client 同）
const RECONNECT_DELAY_MS = 5000;        // 连不上后重连间隔

export function startWsSource(store) {
  let ws = null, reconnectTimer = null, stopped = false;

  function connect() {
    if (stopped) return;
    let sock;
    try { sock = new WebSocket(WS_URL); }
    catch (e) { console.warn('[ws-source] 构造失败', e); fallback(); return; }
    ws = sock;
    sock.onopen = () => {
      store.setWsStatus('live');
      sock.send(JSON.stringify({ type: 'HELLO', data: { role: 'dash', v: 1 } }));   // 握手（spec §4.2）
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { console.debug('[ws-source] 非法消息忽略', e); return; }
      if (msg.type === 'BRAIN_EVENT') store.appendBrainEvent(msg.data);
      else if (msg.type === 'HITL_DETAIL') store.setHitlDetail(msg.data);
    };
    sock.onclose = () => { if (!stopped) fallback(); };
    sock.onerror = () => { console.debug('[ws-source] 连接错误（onclose 接管重连）'); };
  }

  // 连不上：灯标 offline + 延时重连（不回放 mock）
  function fallback() {
    store.setWsStatus('offline');
    if (!reconnectTimer && !stopped) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_DELAY_MS);
    }
  }

  connect();

  return () => {   // 停止句柄
    stopped = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(); } catch (e) { console.debug('[ws-source] close 忽略', e); } }
  };
}
