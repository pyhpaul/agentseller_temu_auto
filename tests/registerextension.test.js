const { test } = require('node:test');
const assert = require('node:assert');

function loadRegistry() {
  const win = { __AgentSellerUtils: { showToast() {} }, __AgentSellerUI: {} };
  global.window = win;
  global.location = { href: 'https://seller.temu.com/' };
  global.history = { pushState() {}, replaceState() {} };
  global.chrome = { runtime: { id: 'x', sendMessage: async () => ({ success: true }) } };
  delete require.cache[require.resolve('../core/content/registry.js')];
  require('../core/content/registry.js');
  return win;
}

test('registerExtension 注册后 getExtensions 可取', () => {
  const win = loadRegistry();
  win.AgentSeller.registerExtension({ id: 'automation', panelButtons: [{ id: 'm', label: '监控' }] });
  const exts = win.__AgentSellerRegistry.getExtensions();
  assert.strictEqual(exts.length, 1);
  assert.strictEqual(exts[0].id, 'automation');
});

test('registerExtension 缺 id 抛错', () => {
  const win = loadRegistry();
  assert.throws(() => win.AgentSeller.registerExtension({}), /缺少 id/);
});

test('openMonitor 已从公开 API 移除', () => {
  const win = loadRegistry();
  assert.strictEqual(win.AgentSeller.openMonitor, undefined);
});

test('collectPanelButtons 聚合所有 extension 的按钮', () => {
  const win = loadRegistry();
  win.AgentSeller.registerExtension({ id: 'a', panelButtons: [{ id: 'b1', label: 'B1' }] });
  win.AgentSeller.registerExtension({ id: 'c', panelButtons: [{ id: 'b2', label: 'B2' }] });
  const btns = win.__AgentSellerRegistry.collectPanelButtons();
  assert.deepStrictEqual(btns.map(b => b.id), ['b1', 'b2']);
});

test('collectPanelButtons 对无 panelButtons 的 extension 返回空', () => {
  const win = loadRegistry();
  win.AgentSeller.registerExtension({ id: 'no-btn' });
  assert.deepStrictEqual(win.__AgentSellerRegistry.collectPanelButtons(), []);
});

test('getOverlays 聚合 extension 的 overlays', () => {
  const win = loadRegistry();
  win.AgentSeller.registerExtension({ id: 'a', overlays: [{ match: () => true }] });
  win.AgentSeller.registerExtension({ id: 'b' });
  assert.strictEqual(win.__AgentSellerRegistry.getOverlays().length, 1);
});
