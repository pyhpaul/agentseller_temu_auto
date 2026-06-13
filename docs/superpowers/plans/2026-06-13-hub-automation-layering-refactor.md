# Hub / Automation 分层重构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把寄生在 `core/` 里的 automation 系统（orchestrator/dashboard/overlay/ws-client/contract）抽到独立顶层 `automation/`，core 经单一 `registerExtension` 契约对其开放、零反向引用；feature 的 bg 编排段归位各自 `features/<id>/background/`；并清理 CPO 双编排技术债——全程不影响现有 8 feature 功能。

**Architecture:** 三层单向依赖（`core` 纯净 ← `features` ← `automation`）。core service-worker 提供 `self.AgentSellerBg.registerHandler(prefix, fn)` 数据化路由 + native 透传 + auto-reload；feature/automation 的 bg 脚本经 build 注入 SW 末尾 importScripts 并自注册命令处理器。release 不装配 `automation/` → 一切自动消失，取代全部 strip/isDev 补丁。

**Tech Stack:** Vanilla JS（MV3 content script + service worker，无构建打包）；Python（`build_extension.py`/`package_all.py` 装配 + `pytest` 单测）；`node --test`（JS 纯逻辑单测）。

**验证哲学（对应"功能不被影响"硬约束）：**
- **feature content scripts 字节 diff**：6 个纯 content feature + CPO/image_search 的 `content/index.js` 搬迁阶段不改一字 → dist 产物字节级一致 = 铁证。
- **service-worker 拆分**：因跨文件引用，逻辑等价但非字节等价 → 靠现有 orchestrator 单测 + 新增路由单测 + Chrome 冒烟。
- **manifest 回归**：dev manifest 装配等价；release manifest 与 `main` 基线零差异。
- 每个搬迁 Task 自带验证步，不留到最后。Chrome 冒烟/e2e 由用户执行（agent 进不了登录态 Temu）。

---

## 文件结构总览

**新建：**
- `automation/`（顶层目录）— 移入 dashboard/overlay/orchestrator/ws-client/contract + 新建 `register.js`、`manifest.fragment.json`
- `features/create_purchase_order/background/handler.js` — CPO bg 段归位
- `features/image_search_1688/background/handler.js` — image_search bg 段归位
- `tests/core-bg-registry.test.js` — bgRegistry 路由等价单测
- `tests/registextension.test.js` — registerExtension 注册表单测
- `tests/build-assembly.test.py` — build 装配（automation 开关 + feature background + fragment 合并）单测

**修改：**
- `core/content/registry.js` — +`registerExtension`/extensions 注册表，−`openMonitor`
- `core/content/ui.js` — `buildPanel` 改遍历 `panelButtons` 渲染，−`#tal-open-monitor` 硬编码（含 CSS）
- `core/background/service-worker.js` — −image_search/−CPO/−orchestrator/−OPEN_MONITOR 段，+`AgentSellerBg` 注册表 + 数据化路由
- `core/manifest.template.json` — −`windows`/−CSP（移至 automation fragment）
- `build/build_extension.py` — 装配 automation/（可关）+ feature `background` 字段 + fragment 合并 + SW importScripts 注入
- `build/package_all.py` — 删 3 个 strip 函数 + 调用，改为 build 期 `--no-automation`
- `features/{create_purchase_order,image_search_1688}/feature.json` — +`background` 字段
- 根 `CLAUDE.md` + 受影响 feature 的 `CLAUDE.md`

**不动（铁证不变）：** `features/` 下 6 个纯 content feature 全部；CPO/image_search 的 `content/index.js`；`brain/`；`native_host/`。

---

## 阶段 0：行为基线与依赖分析

### Task 0.1: 建立行为基线快照

**Files:**
- Create: `/tmp/refactor-baseline/`（临时，不进 git）

- [ ] **Step 1: 在重构起点 build 一份基线 dist**

Run:
```bash
cd /home/linux_dev/projects/agentseller_temu
git stash list && git status --short   # 确认在 feature/hub-automation-layering 且干净
python3 build/build_extension.py
```
Expected: `[build] done → .../dist/extension`，无报错。

- [ ] **Step 2: 快照基线产物（文件指纹 + manifest + content_scripts 顺序）**

Run:
```bash
mkdir -p /tmp/refactor-baseline
# 每个产物 js 的 sha256（用于阶段1 后比对 feature content 是否字节不变）
( cd dist/extension && find . -name '*.js' -type f -exec sha256sum {} \; | sort ) > /tmp/refactor-baseline/dist-js-sha.txt
# manifest 全文 + content_scripts 顺序
cp dist/extension/manifest.json /tmp/refactor-baseline/manifest.dev.json
python3 -c "import json;m=json.load(open('dist/extension/manifest.json'));print('\n'.join(j for cs in m['content_scripts'] for j in cs['js']))" > /tmp/refactor-baseline/content-scripts-order.txt
wc -l /tmp/refactor-baseline/dist-js-sha.txt
```
Expected: `dist-js-sha.txt` 含数十行 sha256；`manifest.dev.json` 与 `content-scripts-order.txt` 生成成功。

- [ ] **Step 3: 快照 release manifest 基线（与 main 零差异的回归基准）**

Run:
```bash
# 阶段1 完成后，release manifest 必须与此基线一致
python3 build/package_all.py 2>/dev/null || true   # Linux 上 EXE/installer 步会警告跳过，不影响 extension 产物
cp dist/TemuLabel_Setup/extension/manifest.json /tmp/refactor-baseline/manifest.release.json 2>/dev/null && echo "release manifest 快照 OK" || echo "package_all 未产出 release extension（检查）"
```
Expected: `release manifest 快照 OK`。

- [ ] **Step 4: 记录现有测试全绿基线**

Run:
```bash
node --test tests/*.test.js 2>&1 | tail -5
python3 -m pytest tests/ -q 2>&1 | tail -5
```
Expected: JS 21 用例 pass、Python 19 用例 pass。记下确切数字，阶段1/2 后不得低于此。

- [ ] **Step 5: 不提交**（基线在 /tmp，纯参照物）。本 Task 无 commit。

### Task 0.2: service-worker 跨段引用分析

**Files:**
- Read: `core/background/service-worker.js`（全 1066 行）
- Create: `docs/superpowers/notes/sw-dependency-map.md`

- [ ] **Step 1: 读完整 service-worker.js，标注每个顶层 const/function 的归属段**

按段分类（行号边界以实际读取为准）：auto-reload(1-32) / image_search helpers(34-103) / native 连接(105-131) / onMessage listener(133-322) / CPO(324-635) / orchestrator(637-1065)。

- [ ] **Step 2: 列出跨段引用（拆分风险点）**

已知样本（须在 notes 中补全）：
- `orchNavigateAndWait`（orchestrator 段）调 `cpoWaitTabComplete`（CPO 段）→ **共享 helper**，需归 core 或 automation 通用层，不能让 automation 反向依赖 CPO。
- onMessage listener（单一巨型 if-else）混 native 透传 + `OPEN_MONITOR`(automation) + `IMG_SEARCH_*`(image_search) → 拆为 core 透传分支 + 各模块注册的 handler。

- [ ] **Step 3: 为每个跨段共享 helper 定归属**

判定规则：被 ≥2 段用且与具体 feature 无关的工具（如等 tab complete）→ `core`（SW 提供为 `self.AgentSellerBg.util` 或保留为 SW 内通用函数）；仅 automation 用 → automation；仅单 feature 用 → 该 feature background。产出归属表写入 notes。

- [ ] **Step 4: Commit 分析笔记**

```bash
git add docs/superpowers/notes/sw-dependency-map.md
git commit -m "docs(refactor): service-worker 跨段引用分析 + helper 归属表

Why: 1066 行 SW 段间有跨引用(orchestrator 调 cpoWaitTabComplete),拆分前须定归属避免反向依赖
What: 标注 6 段边界 + 列全跨段共享 helper + 按规则定归属(core/automation/feature)
Test: not run (分析笔记)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## 阶段 1：纯结构搬迁（零行为变更）

> **World 边界澄清**（关键）：`registerExtension`（content world，注册 `panelButtons`/`overlays`）与 `self.AgentSellerBg.registerHandler`（service-worker world，注册 bg 命令处理器）**分属两个隔离的 world，是两个机制**。spec §4.1 的 `bgHandlers` 字段在实现上落到 SW 侧。监控按钮 onClick 在 content 发 `OPEN_MONITOR` 消息 → SW 侧 handler 处理。

### Task 1.1: SW 数据化路由（`bg-router` 纯逻辑 + `AgentSellerBg` 注册表）

**Files:**
- Create: `core/background/bg-router.js`
- Create: `tests/core-bg-router.test.js`
- Modify: `core/background/service-worker.js`（顶部加注册表；从 onMessage listener 删 `OPEN_MONITOR`/`IMG_SEARCH_*` 分支——这些搬走，见 Task 1.4/1.5）

- [ ] **Step 1: 写失败测试 `tests/core-bg-router.test.js`**

```js
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
  assert.deepStrictEqual(calls, ['exact']);  // 先注册的精确项先命中
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/core-bg-router.test.js`
Expected: FAIL — `Cannot find module '../core/background/bg-router.js'`。

- [ ] **Step 3: 写 `core/background/bg-router.js`（纯逻辑，不依赖 chrome）**

```js
// core/background/bg-router.js — bg 命令前缀路由（纯逻辑，可 node --test）
// feature background handler + automation bg 入口都经 register(prefix, fn) 注册；
// route 按注册顺序首个匹配（精确 type 或 type.startsWith(prefix)）分发，未匹配返回 false。
(function (root) {
  'use strict';
  function makeBgRouter() {
    const handlers = [];  // [{ prefix, fn }]，注册顺序即优先级
    return {
      register(prefix, fn) {
        if (typeof prefix !== 'string' || typeof fn !== 'function') {
          throw new Error('bg-router.register: 需要 (string, function)');
        }
        handlers.push({ prefix, fn });
      },
      route(msg, sender, sendResponse) {
        const type = msg && msg.type;
        if (typeof type !== 'string') return false;
        for (const { prefix, fn } of handlers) {
          if (type === prefix || type.startsWith(prefix)) {
            return fn(msg, sender, sendResponse);
          }
        }
        return false;
      },
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { makeBgRouter };
  else root.__AS_BG_ROUTER__ = { makeBgRouter };   // SW world: self.__AS_BG_ROUTER__
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/core-bg-router.test.js`
Expected: PASS — 6/6。

- [ ] **Step 5: 在 service-worker.js 接线 `AgentSellerBg` 注册表 + 路由 listener**

在 `core/background/service-worker.js` 顶部（NATIVE_HOST 定义后、原 onMessage listener 前）加：
```js
importScripts('bg-router.js');                     // 提供 self.__AS_BG_ROUTER__
const __asBgRouter = self.__AS_BG_ROUTER__.makeBgRouter();
self.AgentSellerBg = { registerHandler: (prefix, fn) => __asBgRouter.register(prefix, fn) };
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => __asBgRouter.route(msg, sender, sendResponse));
```
**关键**：原 native 透传 listener（`PROCESS_LABEL`…`GET_STATUS`，134-224 行）**一字不改**保留——它与新 router listener 并存（MV3 多 listener），各处理各的。仅从原 listener **删除** `OPEN_MONITOR`(226-248) 与 `IMG_SEARCH_*`(250-321) 两块（搬走，Task 1.4/1.5 用 `registerHandler` 重注册）。

- [ ] **Step 6: 提交（此时 OPEN_MONITOR/IMG_SEARCH 暂时失效，下个 Task 恢复——故本 commit 不单独冒烟）**

```bash
git add core/background/bg-router.js tests/core-bg-router.test.js core/background/service-worker.js
git commit -m "feat(core): SW 数据化 bg 路由注册表 (AgentSellerBg.registerHandler)

Why: 1066 行 SW 的 onMessage 硬编码 OPEN_MONITOR/IMG_SEARCH/WF 分支,automation/feature 段无法解耦
What: 新增 bg-router 纯逻辑(前缀路由,6 单测) + SW 挂 self.AgentSellerBg 注册表 + 并存 router listener;native 透传 listener 原样保留,仅移出 OPEN_MONITOR/IMG_SEARCH 分支(下个 Task 经 registerHandler 恢复)
Test: node --test tests/core-bg-router.test.js (6/6 pass)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.2: registry `registerExtension` + ui `panelButtons` 渲染

**Files:**
- Modify: `core/content/registry.js`（+`registerExtension`/`getExtensions`，−`openMonitor`）
- Modify: `core/content/ui.js`（`buildPanel` 遍历 panelButtons；移除 `#tal-open-monitor` 硬编码 + 其 CSS）
- Create: `tests/registerextension.test.js`

- [ ] **Step 1: 写失败测试 `tests/registerextension.test.js`**

registry.js 是 IIFE 挂 `window`，测试需在 node 模拟最小 window。提取注册表逻辑为可测：本测试验证「注册后 getExtensions 返回、panelButtons 聚合、缺 id 抛错」。

```js
const { test } = require('node:test');
const assert = require('node:assert');

// 最小 window/document 桩，加载 registry IIFE
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/registerextension.test.js`
Expected: FAIL（`registerExtension` 未定义 / `openMonitor` 仍在）。

- [ ] **Step 3: 改 `core/content/registry.js`**

在 `pageChangeListeners` 旁加 `const extensions = [];`。新增函数：
```js
  function registerExtension(def) {
    if (!def || !def.id) throw new Error('registerExtension: 缺少 id');
    extensions.push(def);
    if (window.__AgentSellerUI?.refreshPanelButtons) window.__AgentSellerUI.refreshPanelButtons();
  }
  function getExtensions() { return extensions.slice(); }
  function collectPanelButtons() { return extensions.flatMap(e => e.overlays ? (e.panelButtons || []) : (e.panelButtons || [])); }
  function getOverlays() { return extensions.flatMap(e => e.overlays || []); }
```
（`collectPanelButtons` 简化为 `return extensions.flatMap(e => e.panelButtons || []);`）

`window.__AgentSellerRegistry` 追加 `getExtensions, collectPanelButtons, getOverlays`。
`window.AgentSeller`：加 `registerExtension,`；**删除** `openMonitor` 整块（89-99 行）。

- [ ] **Step 4: 改 `core/content/ui.js`（buildPanel 数据化 panelButtons）**

`buildPanel` 内：删 `__asDev`/`__monitorBtn`（192-193）。把 HTML 模板里 `${__monitorBtn}`（202）改为 `<div id="tal-ext-buttons"></div>`。删事件绑定（229-230）。新增渲染函数并在 buildPanel 末尾调用：
```js
  function refreshPanelButtons() {
    const host = document.getElementById('tal-ext-buttons');
    if (!host || !window.__AgentSellerRegistry?.collectPanelButtons) return;
    host.innerHTML = '';
    window.__AgentSellerRegistry.collectPanelButtons().forEach(btn => {
      const el = document.createElement('div');
      el.className = 'tal-ext-btn';
      el.id = btn.id ? `tal-extbtn-${btn.id}` : '';
      el.innerHTML = `${btn.icon || ''} ${btn.label || ''}`.trim();
      if (typeof btn.onClick === 'function') el.addEventListener('click', () => btn.onClick());
      host.appendChild(el);
    });
  }
```
`window.__AgentSellerUI` 追加 `refreshPanelButtons,`。

CSS：把 `#tal-open-monitor`（81-89）整块**移除**——按钮样式改由 automation 在自己的 overlay.css/注入样式提供，或用通用 `.tal-ext-btn`。为零视觉回归，把原 `#tal-open-monitor` 的规则**改名**为 `.tal-ext-btn` 保留在 ui.js（通用扩展按钮样式，无 automation 语义，可留 core）。

- [ ] **Step 5: 运行确认通过**

Run: `node --test tests/registerextension.test.js`
Expected: PASS — 4/4。

- [ ] **Step 6: 提交**

```bash
git add core/content/registry.js core/content/ui.js tests/registerextension.test.js
git commit -m "feat(core): registerExtension 契约 + ui panelButtons 数据化渲染

Why: openMonitor/监控按钮 isDev 硬编码在 core registry/ui,automation 无法解耦接入
What: registry 加 registerExtension/getExtensions/collectPanelButtons,删 openMonitor;ui buildPanel 改遍历 collectPanelButtons 渲染(.tal-ext-btn 通用样式),删 #tal-open-monitor 硬编码;4 单测
Test: node --test tests/registerextension.test.js (4/4 pass)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.3: 新建 `automation/` 顶层并 git mv 资产

**Files:**
- Create: `automation/`（目录）
- Move（`git mv` 保历史）：`core/dashboard/`→`automation/dashboard/`；`core/contract.js`→`automation/contract.js`；`core/content/overlay.js`+`overlay-view.js`→`automation/overlay/`；`core/background/orchestrator/`→`automation/orchestrator/`；`core/background/ws-client.js`→`automation/brain-bridge/ws-client.js`

- [ ] **Step 1: git mv 资产到 automation/**

```bash
cd /home/linux_dev/projects/agentseller_temu
mkdir -p automation/overlay automation/brain-bridge
git mv core/dashboard automation/dashboard
git mv core/contract.js automation/contract.js
git mv core/content/overlay.js automation/overlay/overlay.js
git mv core/content/overlay-view.js automation/overlay/overlay-view.js
git mv core/background/orchestrator automation/orchestrator
git mv core/background/ws-client.js automation/brain-bridge/ws-client.js
git status --short | head -30
```
Expected: 一组 `R`（rename）条目，无 `D`+`A` 拆分（确认 git 识别为移动）。

- [ ] **Step 2: 此刻构建会断**（SW 仍 importScripts 旧路径、build 仍找 core/dashboard）——预期，Task 1.4/1.7 修复。先不 build。

- [ ] **Step 3: 暂不提交**，与 Task 1.4 接入代码一起提交（避免中间不可构建状态单独成 commit）。

### Task 1.4: automation 接入（content `register.js` + SW `bg-entry.js` + manifest fragment）

**Files:**
- Create: `automation/register.js`（content world：registerExtension）
- Create: `automation/bg-entry.js`（SW world：importScripts orchestrator + 注册 OPEN_MONITOR/WF handler）
- Create: `automation/manifest.fragment.json`
- Modify: `core/background/service-worker.js`（删 orchestrator 接线 637-1065 + OPEN_MONITOR；已在 1.1 删 OPEN_MONITOR）

- [ ] **Step 1: 把 SW 的 orchestrator 接线整体搬入 `automation/bg-entry.js`**

将 `core/background/service-worker.js` 第 637-1065 行（`// ── orchestrator ──` 整段）剪切到 `automation/bg-entry.js`。改动点：
- importScripts 路径改相对 automation/：`importScripts('contract.js', 'orchestrator/steps.js', …, 'orchestrator/engine.js')`；`importScripts('brain-bridge/ws-client.js')`。
- 段内原本监听 `WF_*` 的 `chrome.runtime.onMessage.addListener`（若有）改为 `self.AgentSellerBg.registerHandler('WF_', (msg, sender, sendResponse) => { … })`。
- 文件末尾追加 OPEN_MONITOR handler（从 SW 原 226-248 搬来的逻辑）：
```js
self.AgentSellerBg.registerHandler('OPEN_MONITOR', (msg, sender, sendResponse) => {
  const url = chrome.runtime.getURL('dashboard/dashboard.html');
  (async () => {
    try {
      const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup', 'normal'] });
      for (const w of wins) {
        const hit = (w.tabs || []).find(t => t.url === url);
        if (hit) { await chrome.windows.update(w.id, { focused: true }); sendResponse({ success: true, focused: true }); return; }
      }
      await chrome.windows.create({ url, type: 'popup', width: 1280, height: 860 });
      sendResponse({ success: true, created: true });
    } catch (e) {
      try { await chrome.tabs.create({ url }); sendResponse({ success: true, fallbackTab: true }); }
      catch (e2) { sendResponse({ success: false, error: String(e2?.message || e2) }); }
    }
  })();
  return true;
});
```
> dashboard URL 仍是 `dashboard/dashboard.html`（automation 装配时 dashboard 拷到 dist 根 `dashboard/`，见 Task 1.7），故 `getURL` 路径不变。

- [ ] **Step 2: 写 `automation/register.js`（content world 接入）**

```js
// automation/register.js — automation 接入 hub（content world）。仅当 automation/ 被装配时存在。
(function () {
  'use strict';
  if (!window.AgentSeller?.registerExtension) return;   // core 未就绪兜底
  window.AgentSeller.registerExtension({
    id: 'automation',
    panelButtons: [{
      id: 'open-monitor', icon: '📊', label: '打开监控',
      onClick: async () => {
        if (!chrome?.runtime?.id) { window.__AgentSellerUtils?.showToast('插件已重载，请刷新页面后重试', 'err'); return; }
        try {
          const resp = await chrome.runtime.sendMessage({ type: 'OPEN_MONITOR' });
          if (!resp?.success) throw new Error(resp?.error || '打开监控失败');
        } catch (e) { window.__AgentSellerUtils?.showToast('打开监控失败：' + (e?.message || e), 'err'); }
      },
    }],
    // overlay 的 mount/unmount 由 overlay.js 自挂载（搬迁阶段保持其原自驱逻辑），此处不重复接管。
  });
})();
```
> **搬迁阶段策略**：overlay.js 原本是独立 content script、自带页面匹配 + 挂载逻辑。本阶段**不重构 overlay 的挂载方式**（零行为变更），只随目录搬到 `automation/overlay/`，由 build 装配为 content script（顺序与原 manifest 一致）。overlay 接入 `registerExtension.overlays` 的统一化留作后续优化，不在本次范围。

- [ ] **Step 3: 写 `automation/manifest.fragment.json`**

```json
{
  "permissions": ["windows"],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src 'self' ws://localhost:* wss://localhost:*"
  }
}
```
> `storage` 不在 fragment——它留 core（CPO 这个 hub feature 也用，见 §4.3）。fragment 只含 automation 独占的 `windows` + CSP。

- [ ] **Step 4: 删 SW 中已搬走的段**

确认 `core/background/service-worker.js` 已无 orchestrator 接线（637-1065）、无 OPEN_MONITOR（1.1 已删）、无 `importScripts('../contract.js')`/`orchestrator/*`/`ws-client.js`（随段搬走）。SW 现在只剩：auto-reload + image_search helpers（待 1.5 搬）+ native 连接/透传 + bg-router 接线 + CPO（待 1.6 搬）。

- [ ] **Step 5: 提交（automation 抽离 + 接入，构建仍需 1.7 build 适配才能跑）**

```bash
git add automation/ core/background/service-worker.js core/content/overlay.js core/content/overlay-view.js core/dashboard core/contract.js core/background/orchestrator core/background/ws-client.js
git commit -m "refactor(automation): 抽离 automation 到顶层 + registerExtension 接入

Why: orchestrator/dashboard/overlay/ws-client/contract 寄生 core,需单向依赖解耦
What: git mv 五类资产到 automation/;SW orchestrator 接线搬 automation/bg-entry.js(改 importScripts 路径 + registerHandler 注册 WF_/OPEN_MONITOR);新增 register.js(content 接入监控按钮) + manifest.fragment.json(windows+CSP);SW 删已搬段
Test: not run (构建待 Task 1.7 适配;纯搬迁逻辑不变)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.5: image_search bg 段归位 feature

**Files:**
- Create: `features/image_search_1688/background/handler.js`
- Modify: `core/background/service-worker.js`（删 image_search helpers 34-103 + IMG_SEARCH_* 250-321）
- Modify: `features/image_search_1688/feature.json`（+`background`）

- [ ] **Step 1: 搬 image_search 代码到 feature background**

把 SW 第 34-103 行（image_search helpers：`imgCropImage`/`imgNotify`/`imgEstimateBytes`/`imgSetPayload`/状态变量 `isImgSearchCapturing`/`imgSearchSourceTabId`/常量 `IMG_MAX_BYTES`/`IMG_SEARCH_URL` 等）+ 第 250-321 行（`IMG_SEARCH_START`/`CANCEL`/`CAPTURE_REGION`/`INJECTION_RESULT` 分支）整体移到 `features/image_search_1688/background/handler.js`，包裹为：
```js
// features/image_search_1688/background/handler.js — image_search 跨 tab 编排(SW world)
(function () {
  'use strict';
  /* …搬入的 helpers + 状态变量… */
  self.AgentSellerBg.registerHandler('IMG_SEARCH_', (msg, sender, sendResponse) => {
    if (msg.type === 'IMG_SEARCH_START') { /* …原逻辑… */ return true; }
    if (msg.type === 'IMG_SEARCH_CANCEL') { /* … */ return; }
    if (msg.type === 'IMG_SEARCH_CAPTURE_REGION') { /* … */ return true; }
    if (msg.type === 'IMG_SEARCH_INJECTION_RESULT') { /* … */ return; }
  });
})();
```
> 原各分支函数体**一字不改**，仅从 if-else 链改为单 handler 内 if 分发（前缀 `IMG_SEARCH_` 命中后内部按精确 type 分流）。

- [ ] **Step 2: feature.json 加 background 字段**

`features/image_search_1688/feature.json` 加 `"background": "background/handler.js"`。

- [ ] **Step 3: 提交**

```bash
git add features/image_search_1688/ core/background/service-worker.js
git commit -m "refactor(image_search): bg 编排段归位 features/image_search_1688/background/

Why: feature 的跨 tab 编排逻辑寄生 core SW,应随 feature 自治(职责单一)
What: imgCropImage 等 helpers + IMG_SEARCH_* 分支搬 background/handler.js,经 registerHandler('IMG_SEARCH_') 注册(函数体不变);feature.json +background 字段
Test: not run (Chrome 冒烟在 Task 1.9)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.6: CPO bg 段归位 feature + 共享 helper 提升 core

**Files:**
- Create: `features/create_purchase_order/background/handler.js`
- Create: `core/background/tab-utils.js`（共享 helper，依 Task 0.2 归属表）
- Modify: `core/background/service-worker.js`（删 CPO 段 324-635）
- Modify: `features/create_purchase_order/feature.json`（+`background`）

- [ ] **Step 1: 按 Task 0.2 归属表，把被 automation 复用的通用 tab helper 提到 core**

已知 `cpoWaitTabComplete`（等 tab complete）被 orchestrator（automation）的 `orchNavigateAndWait` 调用 → 提升到 `core/background/tab-utils.js`，挂 `self.AgentSellerBg.util.waitTabComplete`（函数体一字不改）。SW 顶部 `importScripts('tab-utils.js')`。CPO handler 与 automation/bg-entry 改调 `self.AgentSellerBg.util.waitTabComplete`。
> 完整待提升清单以 Task 0.2 的 notes 归属表为准；判定规则：被 ≥2 段用且 feature 无关 → core。

- [ ] **Step 2: 搬 CPO 段到 feature background**

SW 第 324-635 行（`// ── create_purchase_order ──` 段，含 `cpoRun`/`cpoRun2`/CPO helpers/`CPO_*` 分支）整体移到 `features/create_purchase_order/background/handler.js`，包裹 IIFE + `self.AgentSellerBg.registerHandler('CPO_', …)`。被提升的 helper（如 `cpoWaitTabComplete`）改引用 `self.AgentSellerBg.util.waitTabComplete`。**其余函数体不变**（cpo_state 写法、CPO 私有协议、错误结构本阶段全部保留——合一留阶段 2）。

- [ ] **Step 3: feature.json 加 background 字段**

`features/create_purchase_order/feature.json` 加 `"background": "background/handler.js"`。

- [ ] **Step 4: 提交**

```bash
git add features/create_purchase_order/ core/background/tab-utils.js core/background/service-worker.js
git commit -m "refactor(cpo): bg 编排段归位 feature + 共享 tab helper 提升 core

Why: CPO 编排寄生 core SW;cpoWaitTabComplete 被 automation 复用形成跨段引用,需提 core 避免 automation 反向依赖 feature
What: cpoRun/cpoRun2/CPO_* 搬 background/handler.js(经 registerHandler('CPO_'),函数体不变,合一留阶段2);通用 waitTabComplete 提 core/background/tab-utils.js;feature.json +background
Test: not run (Chrome 冒烟在 Task 1.9)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.7: build_extension.py 装配改造（automation 可关 + feature background + fragment）

**装配映射（automation/feature 源 → dist 布局，复现 importScripts/script 相对路径）：**

| 源 | dist 目标 | 引用方 / 相对路径 |
|---|---|---|
| `automation/bg-entry.js` | `dist/background/automation-bg-entry.js` | SW 末尾 `importScripts('automation-bg-entry.js')` |
| `automation/orchestrator/` | `dist/background/orchestrator/` | bg-entry `importScripts('orchestrator/*')` |
| `automation/brain-bridge/ws-client.js` | `dist/background/ws-client.js` | bg-entry `importScripts('ws-client.js')` |
| `automation/contract.js` | `dist/contract.js` | bg-entry `importScripts('../contract.js')`；dashboard `'../contract.js'` |
| `automation/dashboard/` | `dist/dashboard/` | 扩展页 |
| `automation/overlay/overlay-view.js` | `dist/content/overlay-view.js` | content_scripts（registry 后、core 前） |
| `automation/overlay/overlay.js` | `dist/content/overlay.js` | content_scripts（overlay-view 后） |
| `automation/register.js` | `dist/content/automation-register.js` | content_scripts（core 后） |
| `features/<id>/background/handler.js` | `dist/features/<id>/background/handler.js` | SW 末尾 `importScripts('../features/<id>/background/handler.js')` |

> bg-entry 装配到 `dist/background/` 与原 SW 同级 → 其 `importScripts` 路径**与原 SW 完全一致**（`'../contract.js'`/`'orchestrator/*'`/`'ws-client.js'`），源码内无需改路径。

**Files:**
- Modify: `build/build_extension.py`

- [ ] **Step 1: 改 `copy_dashboard_assets` / `copy_core_root_files` —— 不再从 core 拷 dashboard/contract**

删 `copy_dashboard_assets`（dashboard 移 automation）；删 `copy_core_root_files` 里 `contract.js`（移 automation）。这两个改由 `assemble_automation` 处理。

- [ ] **Step 2: 新增 `assemble_automation`**

```python
AUTOMATION = ROOT / 'automation'

def assemble_automation(with_automation: bool):
    """装配 automation/ 到 dist（dev 默认 True；release 传 False → 跳过，产物纯 hub）。
    返回 content_scripts 注入位 + manifest fragment；automation/ 不存在亦跳过（幂等）。"""
    if not with_automation or not AUTOMATION.exists():
        print('[build] automation/ 未装配（release 或目录缺失）')
        return {'pre_core': [], 'post_core': [], 'fragment': {}}
    # bg 资产 → dist/background/（与 SW 同级，复现 importScripts 相对路径）
    (DIST / 'background').mkdir(parents=True, exist_ok=True)
    shutil.copy2(AUTOMATION / 'bg-entry.js', DIST / 'background' / 'automation-bg-entry.js')
    shutil.copytree(AUTOMATION / 'orchestrator', DIST / 'background' / 'orchestrator')
    shutil.copy2(AUTOMATION / 'brain-bridge' / 'ws-client.js', DIST / 'background' / 'ws-client.js')
    shutil.copy2(AUTOMATION / 'contract.js', DIST / 'contract.js')
    shutil.copytree(AUTOMATION / 'dashboard', DIST / 'dashboard')
    # overlay + register → dist/content/
    for name in ['overlay-view.js', 'overlay.js']:
        shutil.copy2(AUTOMATION / 'overlay' / name, DIST / 'content' / name)
    shutil.copy2(AUTOMATION / 'register.js', DIST / 'content' / 'automation-register.js')
    # 注 sourceURL
    for js in [DIST / 'background' / 'automation-bg-entry.js', DIST / 'contract.js',
               DIST / 'content' / 'overlay-view.js', DIST / 'content' / 'overlay.js',
               DIST / 'content' / 'automation-register.js',
               *(DIST / 'background' / 'orchestrator').rglob('*.js'), DIST / 'background' / 'ws-client.js',
               *(DIST / 'dashboard').rglob('*.js')]:
        # 源相对路径尽力还原（dashboard/orchestrator 子树用 automation 前缀）
        _inject_source_url(js, 'automation/' + js.name)
    fragment = json.loads((AUTOMATION / 'manifest.fragment.json').read_text(encoding='utf-8'))
    print('[build] automation/ 已装配（dashboard + orchestrator + overlay + register + fragment）')
    return {'pre_core': ['content/overlay-view.js', 'content/overlay.js'],
            'post_core': ['content/automation-register.js'], 'fragment': fragment}
```

- [ ] **Step 3: 新增 `assemble_feature_backgrounds` + SW importScripts 注入**

```python
def assemble_feature_backgrounds(features, with_automation):
    """拷 feature 的 background handler → dist，并在 dist SW 末尾追加 importScripts（feature bg + automation bg-entry）。"""
    sw = DIST / 'background' / 'service-worker.js'
    lines = []
    for f in features:
        bg = f.get('background')
        if not bg:
            continue
        src = f['_dir'] / bg
        if not src.exists():
            raise FileNotFoundError(f'[build] feature background not found: {src}')
        dst = DIST / 'features' / f['id'] / bg
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        _inject_source_url(dst, str(src.relative_to(ROOT)))
        lines.append(f"importScripts('../features/{f['id']}/{bg}');")
        print(f'[build] feature bg: {src.relative_to(ROOT)} → importScripts')
    if with_automation and AUTOMATION.exists():
        lines.append("importScripts('automation-bg-entry.js');")
    if lines:
        body = sw.read_text(encoding='utf-8').rstrip()
        sw.write_text(body + '\n\n// ── assembled bg (build-injected) ──\n' + '\n'.join(lines) + '\n', encoding='utf-8')
```

- [ ] **Step 4: 改 `render_manifest` —— 去 overlay 硬编码、插 automation、合并 fragment**

```python
def render_manifest(features=None, automation=None):
    features = features or []
    automation = automation or {'pre_core': [], 'post_core': [], 'fragment': {}}
    template = json.loads((CORE / 'manifest.template.json').read_text(encoding='utf-8'))
    fragment = automation['fragment']

    # storage 留 core（CPO 这个 hub feature 也用 cpo_state）；windows/CSP 仅 automation fragment 带入
    permissions = sorted({'nativeMessaging', 'storage',
                          *fragment.get('permissions', []),
                          *(p for f in features for p in f.get('permissions', []))})
    host_permissions = sorted({h for f in features for h in f.get('host_permissions', [])})
    content_script_matches = collect_content_matches(features)
    extra_cs = collect_extra_content_scripts(features)

    # core 基础链（不再硬编码 overlay）→ 插 automation pre_core（registry 后 core 前）→ core → post_core
    core_js = ['content/build-info.js', 'content/utils.js', 'content/ui.js', 'content/registry.js']
    core_js += automation['pre_core']            # overlay-view, overlay（automation 装配时）
    core_js += ['content/core.js']
    core_js += automation['post_core']           # automation-register（automation 装配时）
    content_scripts_js = core_js + [f'features/{f["id"]}/{f["content_script"]}'
                                    for f in sorted(features, key=lambda x: x.get('order', 999))]

    template['permissions'] = permissions
    template['host_permissions'] = host_permissions
    template['content_scripts'][0]['matches'] = content_script_matches
    template['content_scripts'][0]['js'] = content_scripts_js
    for ecs in extra_cs:
        template['content_scripts'].append(ecs)
    if fragment.get('content_security_policy'):
        template['content_security_policy'] = fragment['content_security_policy']

    (DIST / 'manifest.json').write_text(json.dumps(template, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[build] manifest.json generated  ({len(features)} features, {len(content_scripts_js)} content scripts, automation={"on" if automation["fragment"] else "off"})')
```

- [ ] **Step 5: 改 `build_all` 接 `with_automation` 开关**

```python
def build_all(with_automation: bool = True):
    clean_dist()
    copy_core_assets()
    emit_build_info()
    features = scan_features()
    copy_feature_assets(features)
    copy_extra_cs_assets(features)
    automation = assemble_automation(with_automation)
    assemble_feature_backgrounds(features, with_automation)
    render_manifest(features=features, automation=automation)
    print(f'[build] done → {DIST}  (automation={"on" if with_automation else "off"})')
```
并删 `build_all` 里原 `copy_core_root_files()` / `copy_dashboard_assets()` 调用（已移除/改装配）。`core/manifest.template.json` 同步删 `windows` 与 `content_security_policy`（移至 fragment）。

- [ ] **Step 6: dev build 验证装配正确**

Run:
```bash
python3 build/build_extension.py
# SW 末尾有注入的 importScripts
tail -8 dist/extension/background/service-worker.js
# automation bg 资产就位
ls dist/extension/background/automation-bg-entry.js dist/extension/contract.js dist/extension/dashboard/dashboard.html
# content_scripts 顺序：overlay-view/overlay 在 registry 后 core 前
python3 -c "import json;m=json.load(open('dist/extension/manifest.json'));print('\n'.join(m['content_scripts'][0]['js']))"
```
Expected: SW 末尾含 `importScripts('../features/create_purchase_order/background/handler.js')`、`importScripts('../features/image_search_1688/background/handler.js')`、`importScripts('automation-bg-entry.js')`；automation 资产存在；content_scripts 为 `build-info,utils,ui,registry,overlay-view,overlay,core,automation-register,<features…>`。

- [ ] **Step 7: feature content 字节不变（铁证）**

Run:
```bash
( cd dist/extension && find . -name '*.js' -type f -exec sha256sum {} \; | sort ) > /tmp/refactor-after.txt
# 6 纯 content feature + CPO/image_search 的 content/index.js 的 sha 应与基线一致
for f in auto_gen_label price_declare check_and_publish packing_label sale_manage_export auto_ship create_purchase_order image_search_1688; do
  b=$(grep "features/$f/content/index.js" /tmp/refactor-baseline/dist-js-sha.txt | awk '{print $1}')
  a=$(grep "features/$f/content/index.js" /tmp/refactor-after.txt | awk '{print $1}')
  [ -n "$a" ] && [ "$b" = "$a" ] && echo "OK  $f content 字节不变" || echo "DIFF $f  (base=$b after=$a)"
done
```
Expected: 8 行全 `OK`（content/index.js 一字未动）。

- [ ] **Step 8: 提交**

```bash
git add build/build_extension.py core/manifest.template.json
git commit -m "build: automation 可关装配 + feature background importScripts + fragment 合并

Why: automation 抽离后 build 需按目录装配(dev 装/release 跳),取代硬编码 overlay+strip 补丁
What: assemble_automation(可关) 拷 bg/dashboard/overlay/register 复现 importScripts 路径;assemble_feature_backgrounds 注入 SW importScripts;render_manifest 去 overlay 硬编码+插 automation+合并 fragment(windows/CSP);build_all 加 with_automation 开关;template 删 windows/CSP
Test: dev build OK,content_scripts 顺序正确,8 feature content/index.js 字节不变

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.8: package_all.py 删 strip 补丁 → release 走 `with_automation=False`

**Files:**
- Modify: `build/package_all.py`（删 3 strip 函数 + 调用；release build 不装配 automation）

- [ ] **Step 1: release 构建关 automation**

`package_all.py` 的 `main()` 第 243 行 `build_all()` 改为 `build_all(with_automation=False)`。

- [ ] **Step 2: 删 3 个 strip 函数及其调用**

删 `_strip_dashboard_for_release`(126-146)、`_strip_windows_permission_for_release`(149-166)、`_strip_csp_for_release`(169-187) 三个函数定义；删 `main()` 中 267-269 三行调用。`_disable_build_info_for_release`（isDev/version 版本号注入）**保留不动**（与 automation 无关）。

- [ ] **Step 3: release 产物验证（与基线对比，确认预期 diff）**

Run:
```bash
python3 build/package_all.py 2>/dev/null || true
echo "=== release manifest diff vs 基线 ==="
diff <(python3 -c "import json;print(json.dumps(json.load(open('/tmp/refactor-baseline/manifest.release.json')),sort_keys=True,indent=2,ensure_ascii=False))") \
     <(python3 -c "import json;print(json.dumps(json.load(open('dist/TemuLabel_Setup/extension/manifest.json')),sort_keys=True,indent=2,ensure_ascii=False))") || true
ls dist/TemuLabel_Setup/extension/dashboard 2>/dev/null && echo "FAIL: dashboard 泄漏 release" || echo "OK: release 无 dashboard"
```
Expected diff（**预期、合理**）：release manifest 相比基线 **移除** `content/overlay-view.js`+`content/overlay.js`（automation HITL 浮层，本就不该泄漏 release）；其余 `windows`/CSP/dashboard 仍如基线一样不在 release。无非预期差异。

- [ ] **Step 4: 提交**

```bash
git add build/package_all.py
git commit -m "build: 删 3 个 release strip 补丁,改 with_automation=False 结构隔离

Why: dashboard/windows/CSP strip + overlay 泄漏 release 是补丁式隔离;automation 抽离后 release 不装配即天然纯净
What: package_all release build 走 with_automation=False;删 _strip_dashboard/windows/csp 三函数及调用;_disable_build_info(版本号)保留
Test: release 产物无 dashboard/overlay/windows/CSP(diff 仅移除 overlay,预期改进)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.9: 阶段 1 全量验证（行为不变锚定）

**Files:** 无（验证 + 阶段标记）

- [ ] **Step 1: 全单测**

Run: `node --test tests/*.test.js && python3 -m pytest tests/ -q`
Expected: JS ≥ 21+10（原 21 + 新 bg-router 6 + registerExtension 4）pass；Python ≥ 19 pass（build 装配单测在 Task 待补，或并入此处）。0 失败。

- [ ] **Step 2: dev 产物完整性 + feature 字节不变**（重跑 Task 1.7 Step 6-7）

Expected: content_scripts 顺序正确；8 个 feature `content/index.js` 字节不变。

- [ ] **Step 3: release 产物 diff 仅预期项**（重跑 Task 1.8 Step 3）

Expected: 仅移除 overlay，无非预期差异。

- [ ] **Step 4: Chrome 冒烟（⚠ 用户执行）**

提供给用户的冒烟清单（dev build + `chrome://extensions` reload 后）：
1. 6 个纯 content feature：FAB→Hub→各 feature view 能开、核心按钮在（auto_gen_label/price_declare/check_and_publish/packing_label/sale_manage_export/auto_ship）。
2. **image_search_1688**：截图选区 → 开 1688 搜图 tab（跨 tab 编排，bg 段已搬）。
3. **create_purchase_order**：跑一次 SKU 生成或采购单（跨 tab 编排，bg 段已搬）。
4. **监控按钮**：Panel 顶 `📊 打开监控` 在（dev）、点击开 dashboard 独立窗口。
5. **HITL 浮层**：automation 浮层在 Temu 页正常起（overlay 已搬 automation）。

- [ ] **Step 5: 阶段 1 完成标记**（无单独 commit；前述 Task 已各自 commit）。确认 `git log --oneline` 阶段 1 各 commit 在位。

## 阶段 2：行为清理（同源技术债）

> ⚠ 本阶段引入有意行为变更，每个 Task 后必须验证；CPO 相关变更须由用户跑 Chrome e2e。

### Task 2.1: CPO 双编排合一（单一命令入口 + adapter 单向映射）

**Files:**
- Modify: `core/background/bg-router.js`（+`invokeFeatureCommand`）
- Modify: `tests/core-bg-router.test.js`（+invokeFeatureCommand 用例）
- Modify: `automation/orchestrator/`（adapter 改发命令 + 读 cpo_state 映射，不再直调 cpoRun）

- [ ] **Step 1: 写失败测试（invokeFeatureCommand）**

加入 `tests/core-bg-router.test.js`：
```js
test('invokeFeatureCommand: handler 同步 sendResponse → resolve', async () => {
  const { makeBgRouter } = require('../core/background/bg-router.js');
  const r = makeBgRouter();
  r.register('CPO_', (msg, sender, sendResponse) => { sendResponse({ ok: true, echo: msg.type }); });
  // 模拟 AgentSellerBg.invokeFeatureCommand 用 route 实现
  const invoke = (type, data) => new Promise((resolve, reject) => {
    let settled = false;
    const ret = r.route({ type, data }, { internal: true }, (resp) => { settled = true; resolve(resp); });
    if (ret !== true && !settled) reject(new Error('no handler'));
  });
  const resp = await invoke('CPO_START_PO', { x: 1 });
  assert.deepStrictEqual(resp, { ok: true, echo: 'CPO_START_PO' });
});

test('invokeFeatureCommand: 无 handler → reject', async () => {
  const { makeBgRouter } = require('../core/background/bg-router.js');
  const r = makeBgRouter();
  const invoke = (type) => new Promise((resolve, reject) => {
    let settled = false;
    const ret = r.route({ type }, { internal: true }, () => { settled = true; resolve(); });
    if (ret !== true && !settled) reject(new Error('no handler'));
  });
  await assert.rejects(() => invoke('NOPE_X'), /no handler/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/core-bg-router.test.js`
Expected: 2 个新用例 FAIL（invokeFeatureCommand 逻辑未在 SW 接线侧实现）。

- [ ] **Step 3: 在 SW 接线加 `invokeFeatureCommand`**

`core/background/service-worker.js` 的 `self.AgentSellerBg` 定义处补：
```js
self.AgentSellerBg = {
  registerHandler: (prefix, fn) => __asBgRouter.register(prefix, fn),
  invokeFeatureCommand: (type, data) => new Promise((resolve, reject) => {
    let settled = false;
    const ret = __asBgRouter.route({ type, data }, { internal: true }, (resp) => { settled = true; resolve(resp); });
    if (ret !== true && !settled) reject(new Error('invokeFeatureCommand: 无 handler 处理 ' + type));
  }),
};
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/core-bg-router.test.js`
Expected: 全 PASS（含 2 新用例）。

- [ ] **Step 5: adapter 改用命令入口 + 读 cpo_state 映射**

在 `automation/orchestrator/`（CPO 相关 adapter 处，原直调 `cpoRun`/`cpoRun2` 的位置）改为：
```js
// 经命令入口调 CPO（单一路径，与 Panel 手动同入口）；CPO 内部仍写 cpo_state、不知 as_workflow_state
async function orchAdapterCreatePo(step, ctx) {
  await self.AgentSellerBg.invokeFeatureCommand('CPO_START_PO', cpoArgsFrom(ctx));
  const { cpo_state } = await chrome.storage.local.get('cpo_state');
  const ph = cpo_state?.phase2;
  if (!ph || ph.status === 'error') return { status: 'error', result: null, error: translateCpoError(ph) };  // 翻译见 Task 2.3
  return { status: 'done', result: { poNo: ph.poNo /* 按 cpo_state 实际字段映射 */ }, error: null };
}
```
（`orchAdapterCreateSku` 同构，调 `CPO_START_SKU`、读 `cpo_state.phase1`。`cpoArgsFrom`/字段名以 CPO handler 实际命令协议为准。）**删除 adapter 内对 `cpoRun`/`cpoRun2` 的直接函数调用**——这是"双编排"的根，删后 CPO 仅剩命令入口一条路径。

> **避免前向引用**：本 Task 先内联 `translateCpoError` 最简版，保证提交即可运行：
> ```js
> const translateCpoError = p => ({ category: 'business', code: 'CPO_BUSINESS', message: (p && p.label) || 'CPO 执行失败', recoverable: false });
> ```
> Task 2.3 再替换为按文案分类（read/validate/business）的版本 + 单测。

- [ ] **Step 6: 提交**

```bash
git add core/background/bg-router.js core/background/service-worker.js tests/core-bg-router.test.js automation/orchestrator/
git commit -m "refactor(automation): CPO 合一为单一命令入口 + adapter 单向映射 cpo_state

Why: CPO 双编排(独立 handler + adapter 直调 cpoRun)两套路径;按决策5 CPO 不反向依赖 automation contract
What: 加 invokeFeatureCommand(经 bgRegistry 路由,2 单测);adapter 改发 CPO_ 命令并读 cpo_state 映射进 step.result,删直调 cpoRun;CPO 内部 cpo_state 写法不变
Test: node --test tests/core-bg-router.test.js pass

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.2: overlay STORAGE_KEY 改读 contract（消除硬编码）

**Files:**
- Modify: `build/build_extension.py`（`assemble_automation` 的 pre_core 加 `contract.js` content 注入）
- Modify: `automation/overlay/overlay.js`（读 `window.__AS_DASH_CONTRACT__.STORAGE_KEY`）

- [ ] **Step 1: contract 注入 content world**

`assemble_automation` 返回的 `pre_core` 改为 `['contract.js', 'content/overlay-view.js', 'content/overlay.js']`（contract.js 是 UMD，作为 content script 注入会挂 `window.__AS_DASH_CONTRACT__`；引用 dist 根那份，无需复制）。确认顺序：contract 在 overlay 前。

- [ ] **Step 2: overlay 读 contract 常量**

`automation/overlay/overlay.js` 删硬编码 `const STORAGE_KEY = 'as_workflow_state';`，改：
```js
const STORAGE_KEY = (window.__AS_DASH_CONTRACT__ && window.__AS_DASH_CONTRACT__.STORAGE_KEY) || 'as_workflow_state';
```
（保留字面量兜底，防 contract 未注入时崩溃。）

- [ ] **Step 3: dev build 验证 overlay 仍读到 key**

Run:
```bash
python3 build/build_extension.py
python3 -c "import json;m=json.load(open('dist/extension/manifest.json'));js=m['content_scripts'][0]['js'];print(js);assert js.index('contract.js')<js.index('content/overlay.js'),'contract 须在 overlay 前'"
```
Expected: content_scripts 含 `contract.js` 且在 overlay 前；断言通过。

- [ ] **Step 4: 提交**

```bash
git add build/build_extension.py automation/overlay/overlay.js
git commit -m "refactor(automation): overlay STORAGE_KEY 改读 contract,消除硬编码重复定义

Why: overlay 硬编码 STORAGE_KEY 与 contract.js 重复(§7.2)
What: assemble_automation 把 contract.js 注入 content world(overlay 前);overlay 读 window.__AS_DASH_CONTRACT__.STORAGE_KEY(字面量兜底)
Test: dev build content_scripts contract 在 overlay 前

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.3: 错误结构在 adapter 翻译层统一（按决策 5）

**Files:**
- Modify: `automation/orchestrator/`（加 `translateCpoError`）

> 决策 5：CPO 保持私有错误结构（`{status,label}`），**不返回 automation 的 StepError**（那会反向依赖 contract）。统一在 automation adapter 的翻译层做——CPO↔content 私有协议不动，`features/create_purchase_order/content/index.js` 不改。

- [ ] **Step 1: adapter 加 CPO→StepError 翻译**

在 `automation/orchestrator/`（adapter 旁）加：
```js
// CPO 私有错误 {status:'error', label} → automation StepError{category,code,message,recoverable}
function translateCpoError(phase) {
  const label = (phase && phase.label) || 'CPO 执行失败';
  // 按 label 文案归类到 contract.ERROR_CATEGORY（read/validate/business）；默认 business
  const category = /未找到|读取|超时/.test(label) ? 'read'
                 : /为空|不合法|不符|校验/.test(label) ? 'validate' : 'business';
  return { category, code: 'CPO_' + category.toUpperCase(), message: label, recoverable: category === 'read' };
}
```
错误分层遵循项目 debugging 铁律（read/validate/business 三层）。

- [ ] **Step 2: 单测翻译映射**

加 `tests/cpo-error-translate.test.js`（若 translateCpoError 可独立 require；否则并入 orchestrator 单测），覆盖三类 label → 正确 category。
```js
test('read 类 label → read category', () => {
  assert.strictEqual(translateCpoError({ label: '未找到目标行' }).category, 'read');
});
test('validate 类 → validate', () => {
  assert.strictEqual(translateCpoError({ label: '采购人员填写后不符' }).category, 'validate');
});
test('其余 → business', () => {
  assert.strictEqual(translateCpoError({ label: '状态不允许下单' }).category, 'business');
});
```

- [ ] **Step 3: 运行测试**

Run: `node --test tests/cpo-error-translate.test.js`
Expected: PASS 3/3。

- [ ] **Step 4: 提交**

```bash
git add automation/orchestrator/ tests/cpo-error-translate.test.js
git commit -m "refactor(automation): CPO 错误在 adapter 翻译层统一为 StepError(决策5)

Why: 错误结构需统一,但 CPO 不应反向依赖 automation contract(决策5)
What: adapter 加 translateCpoError(CPO 私有 {status,label} → StepError,按文案归 read/validate/business);CPO↔content 私有协议不动
Test: node --test tests/cpo-error-translate.test.js (3/3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.4: 阶段 2 验证（单测全绿 + 用户 e2e）

- [ ] **Step 1: 全单测**

Run: `node --test tests/*.test.js && python3 -m pytest tests/ -q`
Expected: 0 失败；总数 ≥ 阶段 1 基线 + 新增。

- [ ] **Step 2: dev build + feature content 字节检查**

Run: Task 1.7 Step 6-7。注：CPO 的 `content/index.js` 仍应字节不变（决策 5 下 content 不改）；automation/orchestrator 改了（adapter），不在 feature 字节检查范围。
Expected: 8 feature content/index.js 字节不变。

- [ ] **Step 3: ⚠ 用户跑 automation Chrome e2e**

按 `docs/superpowers/2026-06-13-l3-chrome-e2e-checklist.md`：起 `python3 -m brain` + 真实商品 + 授权，跑通编排（重点验证 CPO 合一后 create_sku/create_po 两步经命令入口 + cpo_state 映射进 as_workflow_state 正常、dashboard 实时反映、HITL 浮层回填）。
Expected: e2e 清单全过。**此步是阶段 2 的发版门槛，未过不交付。**

- [ ] **Step 4: 阶段 2 完成标记**（前述 Task 已 commit）。

## 阶段 3：文档同步 + 交付

### Task 3.1: 文档同步

**Files:**
- Modify: 根 `CLAUDE.md`、`features/{create_purchase_order,image_search_1688}/CLAUDE.md`、本 plan、spec 回填

- [ ] **Step 1: 根 `CLAUDE.md` 更新**

- 架构图：加 `automation/` 顶层 + 三层单向依赖说明；`core/` 标注"纯净、零 automation 引用"。
- feature 注册契约表：加 `background`（可选，feature 的 SW 命令处理器）字段说明。
- service-worker 职责段：改为"native 透传 + auto-reload + `AgentSellerBg` 数据化路由注册表"；feature/automation bg 经 build importScripts 注入。
- 发版隔离段：删"3 个 strip 函数"描述，改为"release 走 `build_all(with_automation=False)` → 不装配 `automation/` → 天然无 dashboard/overlay/windows/CSP"。
- registerExtension 写进 Core API 段（与 registerFeature 平行）。

- [ ] **Step 2: feature CLAUDE.md 更新**

`create_purchase_order/CLAUDE.md` + `image_search_1688/CLAUDE.md`：加"bg 编排在 `background/handler.js`，经 `self.AgentSellerBg.registerHandler` 注册命令"段。CPO 补"合一后单一命令入口，automation adapter 经 invokeFeatureCommand 调用 + 读 cpo_state 映射"。

- [ ] **Step 3: 回填 spec（3 处实现澄清）**

`docs/superpowers/specs/2026-06-13-hub-automation-layering-refactor-design.md`：
1. §4.1：补 world 边界（registerExtension=content / AgentSellerBg.registerHandler=SW 两机制）。
2. §4.2/§2：把"release 与 main 零差异"改为"release 相比 main **移除 overlay content scripts**（本就泄漏的 automation 痕迹），其余零差异——更干净"。
3. §7.3：错误统一改为"**automation adapter 翻译层**（CPO 保留私有错误，不反向依赖 contract）"。
- 状态改"已实施"。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md features/create_purchase_order/CLAUDE.md features/image_search_1688/CLAUDE.md docs/superpowers/
git commit -m "docs: 同步 hub/automation 分层重构(架构图/feature background/发版隔离/spec 回填)

Why: 重构改了 core API/SW 职责/发版机制/feature 契约,文档需同步真源
What: CLAUDE.md 加 automation 层+background 字段+AgentSellerBg+with_automation 发版;feature CLAUDE.md 加 bg 段;spec 回填 world 边界/overlay release 差异/错误翻译层
Test: not run (文档)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3.2: 交付 PR

- [ ] **Step 1: 推分支 + 自检 diff**

Run:
```bash
git log --oneline main..HEAD          # 阶段 1/2/3 commit 齐整
git diff --stat main..HEAD | tail -5
```

- [ ] **Step 2: `/review` 审 PR diff（按 shipping-rules）**，处理意见。

- [ ] **Step 3: 开 PR**

```bash
git push -u origin feature/hub-automation-layering
gh pr create --title "refactor: hub/automation 分层解耦（三层单向依赖 + 技术债清理）" --body "见 spec/plan；阶段 1 零行为变更(产物字节 diff 锚定)，阶段 2 行为清理(CPO 合一)需 e2e。🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 4: 报告 PR URL**，等用户 merge 指令（不自作主张 merge）。

---

## 验证矩阵总览（功能不被影响）

| 对象 | 手段 | Task |
|---|---|---|
| 6 纯 content feature + CPO/image_search 的 content/index.js | dist 产物 sha256 字节 diff | 1.7/1.9/2.4 |
| bg 路由 / registerExtension / invokeFeatureCommand / 错误翻译 | node --test 单测 | 1.1/1.2/2.1/2.3 |
| build 装配（顺序/importScripts/fragment） | dist 布局 + manifest 断言 | 1.7 |
| release 与基线 | manifest diff（仅预期移除 overlay） | 1.8 |
| 跨 tab 编排 / 监控 / 浮层 / 端到端 | Chrome 冒烟 + automation e2e（⚠ 用户） | 1.9/2.4 |




