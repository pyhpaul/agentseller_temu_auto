// tests/ws-client.test.js — bg WS 客户端架子纯逻辑单测（重连退避 + 消息封装）。
// WebSocket 副作用（connect/onopen/重连定时器）留 chrome / Plan 3 端到端验；本测只覆盖可纯测逻辑。
const { test } = require('node:test');
const assert = require('node:assert');
const ws = require('../core/background/ws-client.js');

test('nextReconnectDelay: 指数退避 1s→2s→4s→8s', () => {
  assert.strictEqual(ws.nextReconnectDelay(0), 1000);
  assert.strictEqual(ws.nextReconnectDelay(1), 2000);
  assert.strictEqual(ws.nextReconnectDelay(2), 4000);
  assert.strictEqual(ws.nextReconnectDelay(3), 8000);
});

test('nextReconnectDelay: 封顶 30s', () => {
  assert.strictEqual(ws.nextReconnectDelay(4), 16000);    // 2^4*1000=16000 < 30000
  assert.strictEqual(ws.nextReconnectDelay(5), 30000);    // 2^5*1000=32000 → 封顶
  assert.strictEqual(ws.nextReconnectDelay(10), 30000);   // 远超 → 封顶
});

test('encode: WS 消息封装 {type,data}', () => {
  assert.strictEqual(ws.encode('PING', {}), '{"type":"PING","data":{}}');
  assert.strictEqual(ws.encode('HELLO', { role: 'bg', v: 1 }), '{"type":"HELLO","data":{"role":"bg","v":1}}');
});

test('encode: data 缺省为空对象', () => {
  assert.strictEqual(ws.encode('PING'), '{"type":"PING","data":{}}');
});
