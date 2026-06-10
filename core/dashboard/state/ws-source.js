// ws-source.js — 血肉源。架子（2-2c-2）：尝试真实 WS 连接（连大脑 localhost）；
// 连不上 → 降级回 mock 回放（保留 dev 大脑流渲染验证）+ 灯标 offline + 延时重连。
// 真实端到端（大脑 server + RUN_STEP 调度业务）留 Plan 3（spec §4.3/§6.3）。startWsSource 签名不变。
import { MOCK_BRAIN_EVENTS, MOCK_HITL_DETAIL } from '../mock/mock-data.js';

const WS_URL = 'ws://localhost:8787';   // 占位；Plan 3 对齐大脑 server 端口（与 bg ws-client 同）
const REPLAY_INTERVAL_MS = 1200;        // mock 大脑流回放间隔（连不上时降级用）
const RECONNECT_DELAY_MS = 5000;        // 降级后重连间隔

export function startWsSource(store) {
  let ws = null, mockTimer = null, reconnectTimer = null, stopped = false;

  function startMockReplay() {
    if (mockTimer) return;   // 已在回放
    let i = 0;
    mockTimer = setInterval(() => {
      if (i >= MOCK_BRAIN_EVENTS.length) {
        clearInterval(mockTimer); mockTimer = null;
        store.setHitlDetail(MOCK_HITL_DETAIL);   // 回放完推 HITL 详情
        return;
      }
      store.appendBrainEvent(MOCK_BRAIN_EVENTS[i]); i++;
    }, REPLAY_INTERVAL_MS);
  }
  function stopMockReplay() { if (mockTimer) { clearInterval(mockTimer); mockTimer = null; } }

  function connect() {
    if (stopped) return;
    let sock;
    try { sock = new WebSocket(WS_URL); }
    catch (e) { console.warn('[ws-source] 构造失败，降级 mock', e); fallback(); return; }
    ws = sock;
    sock.onopen = () => {
      store.setWsStatus('live'); stopMockReplay();
      sock.send(JSON.stringify({ type: 'HELLO', data: { role: 'dash', v: 1 } }));   // 握手（spec §4.2）
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { console.debug('[ws-source] 非法消息忽略', e); return; }
      if (msg.type === 'BRAIN_EVENT') store.appendBrainEvent(msg.data);
      else if (msg.type === 'HITL_DETAIL') store.setHitlDetail(msg.data);
    };
    sock.onclose = () => { if (!stopped) fallback(); };
    sock.onerror = () => { console.debug('[ws-source] 连接错误（onclose 接管降级）'); };
  }

  // 降级：灯标 offline + mock 回放（保留 dev 验证）+ 延时重连
  function fallback() {
    store.setWsStatus('offline');
    startMockReplay();
    if (!reconnectTimer && !stopped) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_DELAY_MS);
    }
  }

  connect();

  return () => {   // 停止句柄
    stopped = true;
    stopMockReplay();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(); } catch (e) { console.debug('[ws-source] close 忽略', e); } }
  };
}
