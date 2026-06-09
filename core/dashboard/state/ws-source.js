// ws-source.js — 血肉源。本 Plan = MOCK：定时回放 mock-data 大脑流 + 推 HITL 详情。
// 真实 WS client（连大脑 localhost / HELLO 握手 / PING-PONG / 断线降级）留 Plan 3 替换本实现，startWsSource 签名不变。
import { MOCK_BRAIN_EVENTS, MOCK_HITL_DETAIL } from '../mock/mock-data.js';

const REPLAY_INTERVAL_MS = 1200;   // 每条大脑流间隔（模拟实时到达，便于肉眼看 append 效果）

export function startWsSource(store) {
  // mock 模式：WS 灯标 offline（本 Plan 无真实连接；Plan 3 接真实 WS 后改 'live'/'reconnecting'）
  store.setWsStatus('offline');

  let i = 0;
  const timer = setInterval(() => {
    if (i >= MOCK_BRAIN_EVENTS.length) {
      clearInterval(timer);
      store.setHitlDetail(MOCK_HITL_DETAIL);   // 大脑流回放完 → 推 HITL 详情（模拟复核完触发人工确认）
      return;
    }
    store.appendBrainEvent(MOCK_BRAIN_EVENTS[i]);
    i++;
  }, REPLAY_INTERVAL_MS);

  return () => clearInterval(timer);   // 停止回放句柄
}
