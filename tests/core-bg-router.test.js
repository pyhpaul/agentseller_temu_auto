const { test } = require('node:test');
const assert = require('node:assert');
const { makeBgRouter } = require('../core/background/bg-router.js');

test('精确 type 匹配命中 handler', () => {
  const r = makeBgRouter();
  let got = null;
  r.register('OPEN_MONITOR', (msg) => { got = msg.type; return true; });
  const ret = r.route({ type: 'OPEN_MONITOR' }, {}, () => {});
  assert.strictEqual(got, 'OPEN_MONITOR');
  assert.strictEqual(ret, true);
});

test('前缀匹配命中（WF_START → 注册 WF_）', () => {
  const r = makeBgRouter();
  let got = null;
  r.register('WF_', (msg) => { got = msg.type; return true; });
  r.route({ type: 'WF_START' }, {}, () => {});
  assert.strictEqual(got, 'WF_START');
});

test('未匹配返回 false（让其它 listener 处理）', () => {
  const r = makeBgRouter();
  r.register('WF_', () => true);
  assert.strictEqual(r.route({ type: 'PROCESS_LABEL' }, {}, () => {}), false);
});

test('注册顺序优先：先注册者先匹配', () => {
  const r = makeBgRouter();
  const calls = [];
  r.register('IMG_SEARCH_START', () => { calls.push('exact'); return true; });
  r.register('IMG_', () => { calls.push('prefix'); return true; });
  r.route({ type: 'IMG_SEARCH_START' }, {}, () => {});
  assert.deepStrictEqual(calls, ['exact']);
});

test('handler 的返回值透传（true 保持异步通道）', () => {
  const r = makeBgRouter();
  r.register('X_', () => true);
  assert.strictEqual(r.route({ type: 'X_GO' }, {}, () => {}), true);
});

test('非字符串 type 安全跳过', () => {
  const r = makeBgRouter();
  r.register('WF_', () => true);
  assert.strictEqual(r.route({ type: undefined }, {}, () => {}), false);
});

test('register 拒绝空串 prefix（防静默 catch-all）', () => {
  const r = makeBgRouter();
  assert.throws(() => r.register('', () => {}), /不能为空串/);
});

test('register 拒绝非法参数类型', () => {
  const r = makeBgRouter();
  assert.throws(() => r.register(null, () => {}), /需要/);
  assert.throws(() => r.register('X_', 'notfn'), /需要/);
});
