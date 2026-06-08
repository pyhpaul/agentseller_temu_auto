# 自动化监控 Dashboard 落地 Implementation Plan（Plan 1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把原型 `ui-prototype/dashboard.html`（深色盯盘单文件）落地成扩展内可独立打开的多文件 dashboard 页：接真实 `chrome.storage.local['as_workflow_state']` 骨架 + mock 回放大脑流血肉，组件只认 store，Hub 加「打开监控」入口。**本 Plan 是 spec §8 实现优先级的第 1-2 步**（静态壳 + 接 storage），WS 大脑/编排/feature 改造留 Plan 3。

**Architecture:** dashboard 是扩展页（`chrome-extension://<id>/dashboard/dashboard.html`），用原生 ES module（`<script type="module">`）加载，**不走 content_scripts 字符串拼接注入**。数据层 `store.js` 合并两路源：`storage-source`（订阅真实 `as_workflow_state` + `onChanged`，骨架，全量重渲）+ `ws-source`（**本 Plan 用 mock-data 回放**大脑流事件 + HITL 详情，真实 WS client 留 Plan 3，血肉增量 append）。组件订阅 store、纯渲染。视觉 100% 沿用原型的深色 tokens / 状态色 / SVG sprite / 字体 / 交互。

**Tech Stack:** 原生 ES module（扩展页原生支持 `import`，无打包器）、Chrome MV3（`chrome.storage.local` + `chrome.runtime.getURL` + `chrome.windows.create`）、`manifest.template.json` 加 `content_security_policy.extension_pages`、`build_extension.py`（Python 拷贝 + sourceURL 注入 + core 级 manifest 字段注入）、`node:test` 纯逻辑单测（store 合并 / schemaVersion 兜底 / append 限流）。

**Spec:** `docs/superpowers/specs/2026-06-08-automation-monitor-and-data-contract-design.md`（§4.1 storage 契约 / §5 视觉规范 / §6.1 HITL / §7 集成点 / §8 实现优先级 + 组件拆分建议）。

**视觉真源:** `ui-prototype/dashboard.html` —— tokens / 状态色 / SVG sprite / DOM 结构 / 交互全部从这里拆。本 Plan 把它拆成 spec §8 建议的多文件结构，**视觉零变更**。

**关键契约差异（务必落实）：** 原型那一帧用「step `run` + `tag.hitl`」隐式绕过表达 HITL 暂停；spec §4.1 / §6.1 要求**显式**用 `step.status==='paused'` 渲染 HITL 标记。本 Plan 的 step-list 组件按 `status==='paused'` 渲染橙色「待确认」标记 + 暂停图标，**不复刻原型的 run+tag 隐式约定**。

---

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `core/manifest.template.json` | MV3 manifest 模板 | 加 `content_security_policy.extension_pages`（放行 `connect-src ws://localhost:* wss://localhost:*`） |
| `build/build_extension.py` | 全量构建 | 加 `copy_dashboard_assets()`（拷 `core/dashboard/` + 各 .js sourceURL 注入）；`render_manifest` 透传模板 CSP 段 |
| `core/dashboard/dashboard.html` | dashboard 扩展页骨架（SVG sprite + 静态布局壳） | **新建** |
| `core/dashboard/dashboard.css` | 深色 tokens（`:root`）+ 全部组件样式（从原型 `<style>` 拆出） | **新建** |
| `core/dashboard/dashboard.js` | ES module 入口：建 store、装配组件、订阅渲染 | **新建** |
| `core/dashboard/state/store.js` | 数据层：合并 storage 骨架 + ws 血肉，订阅/发布；schemaVersion 兜底；大脑流 append 限流 | **新建** |
| `core/dashboard/state/storage-source.js` | 订阅 `chrome.storage.local['as_workflow_state']` + `onChanged`，缺失初始化空 batch（骨架源） | **新建** |
| `core/dashboard/state/ws-source.js` | **本 Plan = mock**：从 mock-data 回放大脑流 + HITL 详情喂 store（真实 WS client 留 Plan 3） | **新建** |
| `core/dashboard/mock/mock-data.js` | mock 骨架 batch + 大脑流事件序列 + HITL 详情（开发态渲染验证用） | **新建** |
| `core/dashboard/components/topbar.js` | 顶栏：brand / batch 标签 / WS 灯 / 置顶 / 刷新 | **新建** |
| `core/dashboard/components/queue-list.js` | L1 队列侧栏：进行中/待处理/已完成分组 + workflow 卡 | **新建** |
| `core/dashboard/components/overview-bar.js` | ① 流程总览条：商品名 / badge / ids / 节点 track | **新建** |
| `core/dashboard/components/step-list.js` | ② 环节列表：按 `step.status` 渲染（含 `paused` HITL 显式标记） | **新建** |
| `core/dashboard/components/brain-stream.js` | ③ 大脑实时流：blain 事件增量 append + kind 着色 | **新建** |
| `core/dashboard/components/hitl-queue.js` | ④ HITL 待确认：keyValues / 复核结论 / 确认改拒绝按钮（本 Plan 仅渲染） | **新建** |
| `core/dashboard/components/error-chip.js` | step error 三分层 chip（read/validate/business）渲染辅助 | **新建** |
| `core/dashboard/components/dom.js` | 共享 DOM 小工具（`h()` 建元素 + `icon()` 引 sprite + `esc()` 转义） | **新建** |
| `core/dashboard/contract.js` | storage 契约常量（STORAGE_KEY / SCHEMA_VERSION / 空 batch 工厂 / 状态枚举） | **新建** |
| `core/content/registry.js` | feature 注册 + AgentSeller API | 加 `openMonitor()`（`chrome.windows.create` 打开 dashboard.html 独立窗口） |
| `core/content/ui.js` | FAB / Panel / Hub UI | Hub 网格上方加「打开监控」入口按钮，调 `AgentSeller.openMonitor()` |
| `tests/dashboard-store.test.js` | `node --test`：store 骨架+血肉合并 / schemaVersion 兜底 / 大脑流 append 限流 | **新建** |
| `CLAUDE.md`（项目根） | 项目文档 | Architecture 段加 `core/dashboard/` 结构 + Core API 加 `openMonitor` |

**依赖顺序**：Task 1（manifest/CSP + build 地基，无依赖）→ Task 2（contract.js + store + 单测，纯逻辑 TDD）→ Task 3（mock-data + storage-source + ws-source 三个源喂 store）→ Task 4（dom.js + 静态 dashboard.html/css 壳）→ Task 5（组件渲染：topbar/queue-list/overview-bar）→ Task 6（组件渲染：step-list/brain-stream/hitl-queue/error-chip）→ Task 7（dashboard.js 装配 + 接 storage-source 真实源）→ Task 8（Hub 入口 + openMonitor）→ Task 9（文档收尾）。

**纯逻辑 vs UI 验证分工**：store / schemaVersion 兜底 / append 限流走 `node --test`（Task 2、Task 7 各加用例）；UI 渲染走「`python3 build/build_extension.py` 构建 → chrome 加载 dist → 打开 dashboard 看 mock 渲染」手动验证（Task 4-8 末尾）。**不为纯 UI 硬凑单测。**

---

## Task 1: manifest CSP + build 地基（dashboard 目录拷贝 + sourceURL 注入）

**目的：** 让扩展页能发 `ws://localhost:*`（默认 CSP `connect-src 'self'` 会拦死，Plan 3 需要）；让 `build_extension.py` 把 `core/dashboard/` 整目录拷进 dist 并给各 .js 注 sourceURL。先打地基，后续 Task 才有地方放文件。

**Files:**
- Modify: `core/manifest.template.json`
- Modify: `build/build_extension.py`

- [ ] **Step 1: manifest 模板加 CSP extension_pages**

编辑 `core/manifest.template.json`，在 `"action"` 块**之后**加 `content_security_policy` 段（注意前一行 `}` 后补逗号）。改 `"action"` 块结尾的 `}` 为 `},` 并追加：

```json
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src 'self' ws://localhost:* wss://localhost:*"
  }
```

> 说明：`script-src 'self'` 是 MV3 扩展页默认值，显式写出以便后续维护；`connect-src` 放行 localhost WS（Plan 3 的 ws-source 用），`'self'` 保留让 `chrome.storage` / runtime 通道不受影响。本 Plan 不发 WS，但 CSP 必须先就位，否则 Plan 3 一上 WS 就被默认 CSP 拦。

- [ ] **Step 2: 构建验证模板 CSP 透传**

`render_manifest` 是 `json.loads(template)` 后改字段再 `json.dumps` 写出，未知字段（如新加的 `content_security_policy`）会**原样透传**——无需改 `render_manifest` 逻辑。先跑一次确认透传无误：

Run: `python3 build/build_extension.py && python3 -c "import json; m=json.load(open('dist/extension/manifest.json')); print(m.get('content_security_policy'))"`

Expected: 打印 `{'extension_pages': "script-src 'self'; object-src 'self'; connect-src 'self' ws://localhost:* wss://localhost:*"}`（证明模板 CSP 段已透传到 dist manifest）。

- [ ] **Step 3: build_extension.py 加 dashboard 目录拷贝函数**

编辑 `build/build_extension.py`。在 `copy_core_assets()` 函数**之后**新增 `copy_dashboard_assets()`：

```python
def copy_dashboard_assets():
    """拷贝 core/dashboard/ 整个子树 → dist/extension/dashboard/，并给各 .js 注 sourceURL。
    dashboard 是 ES module 扩展页，不走 content_scripts 注入，故与 copy_core_assets 的
    background/content/popup/icons 分开处理（那批是 content script + popup 资产）。
    """
    src = CORE / 'dashboard'
    if not src.exists():
        return
    dst = DIST / 'dashboard'
    shutil.copytree(src, dst)
    for js in dst.rglob('*.js'):
        rel_to_root = (src / js.relative_to(dst)).relative_to(ROOT)
        _inject_source_url(js, str(rel_to_root))
    n = sum(1 for _ in dst.rglob('*') if _.is_file())
    print(f'[build] dashboard/ → dist/extension/dashboard/  ({n} files)')
```

- [ ] **Step 4: 在 build_all() 挂上 copy_dashboard_assets**

编辑 `build/build_extension.py` 的 `build_all()`，在 `copy_core_assets()` 之后、`emit_build_info()` 之前插入一行：

```python
def build_all():
    clean_dist()
    copy_core_assets()
    copy_dashboard_assets()
    emit_build_info()
    features = scan_features()
    copy_feature_assets(features)
    copy_extra_cs_assets(features)
    render_manifest(features=features)
    print(f'[build] done → {DIST}')
```

- [ ] **Step 5: 建占位 dashboard 文件验证拷贝管线**

为让 build 此刻可验证（`copytree` 空目录也行，但要确认 .js sourceURL 注入），临时建最小占位文件 `core/dashboard/dashboard.js`：

```javascript
// placeholder — 由后续 Task 替换为真正的 ES module 入口
console.log('[dashboard] placeholder');
```

Run: `python3 build/build_extension.py && tail -1 dist/extension/dashboard/dashboard.js`

Expected: build 打印 `[build] dashboard/ → dist/extension/dashboard/  (1 files)`，且 `tail` 输出 `//# sourceURL=core/dashboard/dashboard.js`（证明拷贝 + sourceURL 注入生效）。

- [ ] **Step 6: commit**

```
git add core/manifest.template.json build/build_extension.py core/dashboard/dashboard.js
git commit -m "$(cat <<'EOF'
feat(dashboard): manifest CSP + build 地基（dashboard 目录拷贝 + sourceURL 注入）

Why: dashboard 扩展页发 ws://localhost 会被默认 CSP connect-src 'self' 拦死（Plan 3 需要）；build_extension.py 无 dashboard 目录拷贝分支。先打地基。
What: manifest.template.json 加 content_security_policy.extension_pages 放行 localhost WS；build_extension.py 加 copy_dashboard_assets() 拷 core/dashboard/ + 各 .js sourceURL 注入，挂进 build_all。
Test: python3 build/build_extension.py；确认 dist manifest 含 CSP 段、dashboard.js 末尾有 sourceURL 注释。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: contract 常量 + store 数据层（纯逻辑 TDD）

**目的：** store 是组件唯一数据源，合并骨架（storage）+ 血肉（ws）两路。本 Task 只做**纯逻辑**：契约常量、空 batch 工厂、schemaVersion 兜底、骨架替换全量、大脑流 append 限流。无 DOM、无 chrome API（源在 Task 3 接入），便于 `node --test`。双模式导出（`export` + `module.exports`）让浏览器 ES module 和 node 单测都能用。

**Files:**
- Create: `core/dashboard/contract.js`
- Create: `core/dashboard/state/store.js`
- Create: `tests/dashboard-store.test.js`

- [ ] **Step 1: 写失败测试**

新建 `tests/dashboard-store.test.js`：

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../core/dashboard/state/store.js');
const { SCHEMA_VERSION, emptyBatch } = require('../core/dashboard/contract.js');

function sampleBatch() {
  return {
    schemaVersion: SCHEMA_VERSION,
    batch: {
      id: 'B-1', createdAt: 1, activeWorkflowId: 'w1',
      workflows: [{
        id: 'w1', product: { label: '保温杯', spuId: '6821042', skc: 'C04A8', skuNo: 'SK99021' },
        status: 'running', cursor: 3, startedAt: 1, updatedAt: 2,
        steps: [{ id: 'gen_label', label: '标签生成', feature: 'auto_gen_label', status: 'done' }],
        hitl: null,
      }],
    },
  };
}

test('emptyBatch: 返回合法空骨架（schemaVersion + 空 workflows）', () => {
  const e = emptyBatch();
  assert.strictEqual(e.schemaVersion, SCHEMA_VERSION);
  assert.deepStrictEqual(e.batch.workflows, []);
  assert.strictEqual(e.batch.activeWorkflowId, null);
});

test('setSkeleton: 合法骨架整体替换，getState().skeleton 反映新值', () => {
  const s = createStore();
  s.setSkeleton(sampleBatch());
  assert.strictEqual(s.getState().skeleton.batch.workflows.length, 1);
  assert.strictEqual(s.getState().skeleton.batch.workflows[0].cursor, 3);
});

test('setSkeleton: schemaVersion 缺失 → 兜底为空 batch（不裸展开 undefined）', () => {
  const s = createStore();
  s.setSkeleton({ foo: 'bar' });
  assert.deepStrictEqual(s.getState().skeleton.batch.workflows, []);
  assert.strictEqual(s.getState().skeleton.schemaVersion, SCHEMA_VERSION);
});

test('setSkeleton: schemaVersion 低于当前 → 兜底为空 batch', () => {
  const s = createStore();
  s.setSkeleton({ schemaVersion: 0, batch: { workflows: [{ id: 'x' }] } });
  assert.deepStrictEqual(s.getState().skeleton.batch.workflows, []);
});

test('setSkeleton: null/undefined 输入 → 兜底为空 batch', () => {
  const s = createStore();
  s.setSkeleton(null);
  assert.deepStrictEqual(s.getState().skeleton.batch.workflows, []);
  s.setSkeleton(undefined);
  assert.deepStrictEqual(s.getState().skeleton.batch.workflows, []);
});

test('appendBrainEvent: 大脑流增量 append（不整体替换），保序', () => {
  const s = createStore();
  s.appendBrainEvent({ workflowId: 'w1', stepId: 'gen_label', kind: 'review', text: 'a', ts: 1 });
  s.appendBrainEvent({ workflowId: 'w1', stepId: 'gen_label', kind: 'log', text: 'b', ts: 2 });
  const ev = s.getState().brainEvents;
  assert.strictEqual(ev.length, 2);
  assert.strictEqual(ev[0].text, 'a');
  assert.strictEqual(ev[1].text, 'b');
});

test('appendBrainEvent: 超过上限时丢最旧（限流，保留最近 N 条）', () => {
  const s = createStore({ maxBrainEvents: 3 });
  for (let i = 0; i < 5; i++) s.appendBrainEvent({ kind: 'log', text: String(i), ts: i });
  const ev = s.getState().brainEvents;
  assert.strictEqual(ev.length, 3);
  assert.deepStrictEqual(ev.map(e => e.text), ['2', '3', '4']);
});

test('setHitlDetail: 血肉 HITL 详情按 hitlId 存，getState().hitlDetail 反映', () => {
  const s = createStore();
  s.setHitlDetail({ hitlId: 'h1', action: '申请付款', valueDiff: [], risk: 'low' });
  assert.strictEqual(s.getState().hitlDetail.hitlId, 'h1');
});

test('subscribe: 任一变更触发订阅回调；unsubscribe 后不再触发', () => {
  const s = createStore();
  let n = 0;
  const off = s.subscribe(() => { n++; });
  s.setSkeleton(sampleBatch());
  s.appendBrainEvent({ kind: 'log', text: 'x', ts: 1 });
  assert.strictEqual(n, 2);
  off();
  s.appendBrainEvent({ kind: 'log', text: 'y', ts: 2 });
  assert.strictEqual(n, 2);
});

test('subscribe: 回调抛错不影响 store 内部状态与其他订阅者', () => {
  const s = createStore();
  let good = 0;
  s.subscribe(() => { throw new Error('boom'); });
  s.subscribe(() => { good++; });
  s.setSkeleton(sampleBatch());
  assert.strictEqual(good, 1);
  assert.strictEqual(s.getState().skeleton.batch.workflows.length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/dashboard-store.test.js`
Expected: FAIL —— `Cannot find module '../core/dashboard/state/store.js'`（文件尚未创建）。

- [ ] **Step 3: 实现 contract.js**

新建 `core/dashboard/contract.js`：

```javascript
// dashboard ↔ storage 契约常量 + 空骨架工厂。双模式：浏览器 ES module export + node 单测 module.exports。
// 真源是 spec §4.1（chrome.storage.local['as_workflow_state']）。store / storage-source 共用本文件，
// 避免「STORAGE_KEY 字符串散落多处、改一处漏一处」。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;          // node 单测
  if (typeof window !== 'undefined') window.__AS_DASH_CONTRACT__ = api;                // 浏览器全局兜底
  root.__AS_DASH_CONTRACT_FACTORY__ = factory;                                        // 便于 ES export 重用
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'as_workflow_state';
  const SCHEMA_VERSION = 1;

  // status / kind / error.category 枚举（与 spec §4.1 / §5.3 对齐；组件渲染按这些值映射 class）
  const WORKFLOW_STATUS = ['pending', 'running', 'paused', 'error', 'done', 'aborted'];
  const STEP_STATUS = ['pending', 'running', 'paused', 'done', 'error', 'skipped'];
  const BRAIN_KIND = ['review', 'diagnose', 'selfheal', 'log'];
  const ERROR_CATEGORY = ['read', 'validate', 'business'];

  // 空骨架：schemaVersion 缺失/过低/损坏时重置成它，避免裸展开 batch.workflows[].steps[] 时 undefined（spec §4.1 初始化/迁移）
  function emptyBatch() {
    return {
      schemaVersion: SCHEMA_VERSION,
      batch: { id: null, createdAt: null, activeWorkflowId: null, workflows: [] },
    };
  }

  // 校验并归一化外部读到的 storage 值：合法返回原值，非法（缺 schemaVersion / 版本过低 / 结构坏）返回 emptyBatch()
  function normalizeSkeleton(raw) {
    if (!raw || typeof raw !== 'object') return emptyBatch();
    if (raw.schemaVersion !== SCHEMA_VERSION) return emptyBatch();
    if (!raw.batch || !Array.isArray(raw.batch.workflows)) return emptyBatch();
    return raw;
  }

  return {
    STORAGE_KEY, SCHEMA_VERSION,
    WORKFLOW_STATUS, STEP_STATUS, BRAIN_KIND, ERROR_CATEGORY,
    emptyBatch, normalizeSkeleton,
  };
});
```

> **加载策略（关键，统一全 Plan）：** `contract.js` 与 `store.js` 是 **UMD 经典脚本**（node `require` + 浏览器挂 `window.__AS_DASH_CONTRACT__` / `window.__AS_DASH_STORE__` 全局），**不是 ES module**——这样同一文件既能被 `node --test` `require`，又能在浏览器用全局，无需 `import`/`export` 双语法冲突。`mock-data.js`、`storage-source.js`、`ws-source.js`、`components/*`、`dashboard.js` 是 **ES module**（`<script type="module">`，spec §8 要求 dashboard.js 走 ES module），它们通过 `window.__AS_DASH_*` 全局读 contract/store，不 `import` contract/store。dashboard.html 的 `<head>` 里**先**用 `<script src="contract.js"></script>` + `<script src="state/store.js"></script>`（经典脚本，同步执行挂全局），**再** `<script type="module" src="dashboard.js"></script>`（module 默认 defer，在经典脚本后执行，全局已就绪）——见 Task 4。

- [ ] **Step 4: 实现 store.js**

新建 `core/dashboard/state/store.js`：

```javascript
// dashboard 数据层：合并骨架（storage 全量）+ 血肉（ws 增量）。组件只读 store、订阅变更。
// 纯逻辑、无 DOM、无 chrome API（源在 storage-source/ws-source 接入），便于 node 单测。
// 双模式：node module.exports + 浏览器 window.__AS_DASH_STORE__。
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require : null);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.__AS_DASH_STORE__ = api;
})(typeof self !== 'undefined' ? self : this, function (nodeRequire) {
  'use strict';

  // 取 contract：node 走 require；浏览器走全局（contract.js 先于 store.js 加载）
  const contract = nodeRequire
    ? nodeRequire('../contract.js')
    : (typeof window !== 'undefined' ? window.__AS_DASH_CONTRACT__ : self.__AS_DASH_CONTRACT__);
  const { emptyBatch, normalizeSkeleton } = contract;

  const DEFAULT_MAX_BRAIN_EVENTS = 500;   // 大脑流上限，超出丢最旧（spec §9.2 storage 写频/内存防膨胀）

  function createStore(opts = {}) {
    const maxBrainEvents = opts.maxBrainEvents || DEFAULT_MAX_BRAIN_EVENTS;

    const state = {
      skeleton: emptyBatch(),   // 骨架（storage）：全量替换
      brainEvents: [],          // 血肉（ws）：增量 append + 限流
      hitlDetail: null,         // 血肉（ws）：当前 HITL 详情，按 hitlId 覆盖
      wsStatus: 'offline',      // 'live' | 'reconnecting' | 'offline'（顶栏 WS 灯；本 Plan mock 恒 'offline'）
    };

    const subs = new Set();
    function notify() {
      for (const cb of subs) {
        try { cb(state); } catch (e) { console.error('[dash-store] 订阅回调异常', e); }
      }
    }

    return {
      getState() { return state; },

      subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },

      // 骨架全量替换（storage-source 每次 onChanged 调用）；非法值兜底空 batch
      setSkeleton(raw) {
        state.skeleton = normalizeSkeleton(raw);
        notify();
      },

      // 大脑流增量 append + 限流（ws-source / mock 喂）；超上限丢最旧
      appendBrainEvent(ev) {
        state.brainEvents.push(ev);
        if (state.brainEvents.length > maxBrainEvents) {
          state.brainEvents.splice(0, state.brainEvents.length - maxBrainEvents);
        }
        notify();
      },

      // HITL 详情按 hitlId 覆盖（ws-source / mock 喂）
      setHitlDetail(detail) {
        state.hitlDetail = detail;
        notify();
      },

      setWsStatus(status) {
        state.wsStatus = status;
        notify();
      },
    };
  }

  return { createStore };
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/dashboard-store.test.js`
Expected: PASS —— 所有用例 0 失败（覆盖空 batch 工厂 / setSkeleton 合法替换 / schemaVersion 三类兜底 / append 保序 + 限流 / setHitlDetail / subscribe + unsubscribe + 回调抛错隔离）。

- [ ] **Step 6: commit**

```
git add core/dashboard/contract.js core/dashboard/state/store.js tests/dashboard-store.test.js
git commit -m "$(cat <<'EOF'
feat(dashboard): contract 常量 + store 数据层（纯逻辑 TDD）

Why: store 是组件唯一数据源，需合并骨架（storage 全量）+ 血肉（ws 增量）；schemaVersion 兜底防裸展开 undefined（spec §4.1）；大脑流须限流防内存膨胀。
What: contract.js（STORAGE_KEY/SCHEMA_VERSION/枚举/emptyBatch/normalizeSkeleton，UMD 双模式）；store.js（createStore：setSkeleton 全量替换 + 非法兜底、appendBrainEvent 限流、setHitlDetail、subscribe 回调隔离）。
Test: node --test tests/dashboard-store.test.js 全通过（空 batch/schemaVersion 三类兜底/append 保序限流/订阅隔离）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 三个数据源（mock-data + storage-source + ws-source mock）

**目的：** store 的喂数据侧。`mock-data.js` 把原型那一帧的数据（保温杯 batch + 8 步 + 大脑流 6 条 + HITL 详情）固化成符合 spec §4.1 契约的对象。`storage-source.js` 订阅真实 `chrome.storage.local['as_workflow_state']` + `onChanged` → `store.setSkeleton`（**接真实 storage**，缺失时初始化空 batch）。`ws-source.js` 本 Plan **是 mock**：定时回放 mock-data 的大脑流事件 + 推 HITL 详情（真实 WS client 留 Plan 3）。三者皆 ES module，读 `window.__AS_DASH_*` 全局。

**Files:**
- Create: `core/dashboard/mock/mock-data.js`
- Create: `core/dashboard/state/storage-source.js`
- Create: `core/dashboard/state/ws-source.js`

- [ ] **Step 1: mock-data.js（契约化的原型数据）**

新建 `core/dashboard/mock/mock-data.js`。**严格按 spec §4.1 字段结构**，数据取自原型那一帧（保温杯，cursor 指向第 4 步「创建采购单」，该步 `status='paused'` 显式表达 HITL——**不复刻原型的 run+tag 隐式约定**）：

```javascript
// mock-data.js — 开发态渲染验证用。骨架严格符合 spec §4.1 契约；血肉（大脑流/HITL详情）模拟 ws 推送。
// 数据取自 ui-prototype/dashboard.html 那一帧（保温杯）。关键：第4步用 status='paused' 显式表达 HITL（spec §4.1/§6.1），
// 不复刻原型 run+tag 隐式约定。
export const MOCK_SKELETON = {
  schemaVersion: 1,
  batch: {
    id: 'B-2406',
    createdAt: Date.parse('2026-03-08T14:22:00'),
    activeWorkflowId: 'w1',
    workflows: [
      {
        id: 'w1',
        product: { label: '中正科技保温杯 350ml', spuId: '6821042', skc: 'C04A8', skuNo: 'SK99021' },
        status: 'paused',
        cursor: 3,                  // 0-based，指向第 4 步「创建采购单」
        startedAt: Date.parse('2026-03-08T14:18:00'),
        updatedAt: Date.parse('2026-03-08T14:22:03'),
        steps: [
          { id: 'gen_label', label: '标签生成', feature: 'auto_gen_label', status: 'done', brainBrief: 'review:pass', result: { spuId: '6821042', labelPng: 'label.png' } },
          { id: 'img_search', label: '1688搜图', feature: 'image_search_1688', status: 'done', brainBrief: 'review:pass' },
          { id: 'check_publish', label: '检查与发布', feature: 'check_and_publish', status: 'done', brainBrief: 'review:pass' },
          { id: 'create_po', label: '创建采购单', feature: 'create_purchase_order', status: 'paused', brainBrief: 'selfheal:重试成功', result: { poNo: 'PO240308021' } },
          { id: 'price_declare', label: '价格不调整', feature: 'price_declare', status: 'pending' },
          { id: 'packing_label', label: '打包标签', feature: 'packing_label', status: 'pending' },
          { id: 'auto_ship', label: '自动发货', feature: 'auto_ship', status: 'pending' },
          { id: 'sale_export', label: '销售清单导出', feature: 'sale_manage_export', status: 'skipped', note: '本批不导出' },
        ],
        hitl: {
          id: 'h1',
          action: '申请付款',
          keyValues: { '金额': '¥128.00', '收货仓库': '中正科技仓', '供应商': '义乌恒达贸易' },
          reviewedBrief: '金额与采购单 PO240308021 一致，仓库匹配收货地，建议确认',
          editable: ['金额', '收货仓库'],
          fieldType: { '金额': 'number', '收货仓库': 'select', '供应商': 'readonly' },
          options: { '收货仓库': ['中正科技仓', '义乌中转仓', '杭州仓'] },
          status: 'pending',
        },
      },
    ],
  },
};

// 大脑流事件序列（ws-source mock 定时回放；增量 append 进 store）。kind ∈ review|diagnose|selfheal|log
export const MOCK_BRAIN_EVENTS = [
  { workflowId: 'w1', stepId: 'check_publish', kind: 'review',   text: '步骤3 SKU 校验通过，SPU 与目标一致', ts: Date.parse('2026-03-08T14:21:02'), anchor: '#3' },
  { workflowId: 'w1', stepId: 'create_po',     kind: 'log',      text: '打开采购单页，填充 SPU / 数量 / 供应商', ts: Date.parse('2026-03-08T14:21:25'), anchor: '#4' },
  { workflowId: 'w1', stepId: 'create_po',     kind: 'diagnose', text: '付款页金额 ¥128，与采购单核对…匹配', ts: Date.parse('2026-03-08T14:21:40'), anchor: '#4' },
  { workflowId: 'w1', stepId: 'create_po',     kind: 'selfheal', text: 'selector .pay-btn 失效，fallback 第 2 选择器命中', ts: Date.parse('2026-03-08T14:21:55'), anchor: '#4' },
  { workflowId: 'w1', stepId: 'create_po',     kind: 'log',      text: '写入 poNo=PO240308021', ts: Date.parse('2026-03-08T14:22:01'), anchor: '#4' },
  { workflowId: 'w1', stepId: 'create_po',     kind: 'review',   text: '付款前复核：金额 / 仓库 / 供应商一致，提交人工确认', ts: Date.parse('2026-03-08T14:22:03'), anchor: '#4' },
];

// HITL 详情（ws-source mock 推；对齐 spec §4.2 HITL_DETAIL）
export const MOCK_HITL_DETAIL = {
  hitlId: 'h1',
  action: '申请付款',
  fullReview: '金额与采购单 PO240308021 一致，仓库匹配收货地，供应商为历史合作方，建议确认。',
  valueDiff: [
    { field: '金额', current: '¥128.00', proposed: '¥128.00' },
    { field: '收货仓库', current: '中正科技仓', proposed: '中正科技仓' },
  ],
  risk: 'low',
};
```

- [ ] **Step 2: storage-source.js（接真实 chrome.storage）**

新建 `core/dashboard/state/storage-source.js`。**这是接真实 storage 的核心**：首读 + onChanged 订阅，缺失时**纯内存兜底渲染空态、不写回 storage**（§2.3 铁律：前端只读，`as_workflow_state` 的初始化由 background 负责）。`store.setSkeleton` 内部已做 `normalizeSkeleton`，故 schemaVersion 校验在 store 侧统一兜底。

```javascript
// storage-source.js — 订阅真实 chrome.storage.local['as_workflow_state']，喂 store 骨架。
// 缺失时纯内存兜底（emptyBatch）渲染空态，不写回 storage（§2.3：前端只读，初始化由 background 负责）。
const { STORAGE_KEY, emptyBatch } = window.__AS_DASH_CONTRACT__;

// 把读到的值灌进 store；store.setSkeleton 内部 normalizeSkeleton 已兜底非法值
function pushToStore(store, raw) {
  store.setSkeleton(raw);
}

export function startStorageSource(store) {
  // 首读：缺失 → 纯内存空骨架渲染空态（绝不写 storage，前端只读，符合 §2.3）
  chrome.storage.local.get(STORAGE_KEY).then((res) => {
    const raw = res[STORAGE_KEY];
    pushToStore(store, raw === undefined ? emptyBatch() : raw);
  }).catch((e) => {
    console.error('[storage-source] 首读失败', e);
    pushToStore(store, emptyBatch());   // 读失败也给空骨架，组件渲染空态而非崩
  });

  // onChanged 订阅：background 后续每次写 as_workflow_state 都全量重灌（骨架全量重渲）
  const onChanged = (changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    pushToStore(store, changes[STORAGE_KEY].newValue);
  };
  chrome.storage.onChanged.addListener(onChanged);

  return () => chrome.storage.onChanged.removeListener(onChanged);   // 停止订阅句柄
}
```

- [ ] **Step 3: ws-source.js（本 Plan = mock 回放）**

新建 `core/dashboard/state/ws-source.js`。本 Plan **不连真实 WS**，用 mock-data 定时回放大脑流（模拟实时 append）+ 一次性推 HITL 详情。真实 WS client（连大脑、握手、心跳、断线降级）**留 Plan 3 替换本文件 export 的实现，签名不变**。

```javascript
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
```

- [ ] **Step 4: build 验证（无单测，纯前端源）**

这三个文件 storage-source/ws-source 依赖 chrome API / DOM 全局，不走 node 单测（mock-data 是纯数据、storage-source 是 chrome.storage 副作用、ws-source 是定时器）。先确认 build 拷贝它们无误：

Run: `python3 build/build_extension.py && ls dist/extension/dashboard/mock/ dist/extension/dashboard/state/`

Expected: `dist/extension/dashboard/mock/` 含 `mock-data.js`；`dist/extension/dashboard/state/` 含 `store.js storage-source.js ws-source.js`（证明子目录递归拷贝生效）。

- [ ] **Step 5: commit**

```
git add core/dashboard/mock/mock-data.js core/dashboard/state/storage-source.js core/dashboard/state/ws-source.js
git commit -m "$(cat <<'EOF'
feat(dashboard): 三个数据源（mock-data + storage-source 接真实 storage + ws-source mock）

Why: store 需喂数据。骨架接真实 chrome.storage.local['as_workflow_state']；血肉本 Plan 用 mock 回放（真实 WS 留 Plan 3）。
What: mock-data.js（契约化原型数据，第4步 status='paused' 显式表达 HITL）；storage-source.js（首读+onChanged，缺失初始化空 batch 写回）；ws-source.js（定时回放大脑流+推 HITL 详情，Plan 3 替换实现签名不变）。
Test: python3 build/build_extension.py；确认 dashboard/mock 与 state 子目录文件递归拷贝到 dist。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: dom 工具 + 静态壳（dashboard.html + dashboard.css）

**目的：** 搭起可加载的扩展页骨架：SVG sprite（14 图标，从原型原样搬）、布局壳（顶栏 + L1 队列 + L2 详情挂载点）、全部深色 tokens + 组件样式（从原型 `<style>` 拆到 dashboard.css，**视觉零变更**）。`dom.js` 提供 `h()`（建元素）+ `icon()`（引 sprite `<use>`）+ `esc()`（文本转义防 XSS），后续组件全用它。本 Task 后 dashboard 能打开看到「空壳 + tokens 生效」（组件挂载点空）。

**Files:**
- Create: `core/dashboard/components/dom.js`
- Create: `core/dashboard/dashboard.html`
- Create: `core/dashboard/dashboard.css`

- [ ] **Step 1: dom.js（共享 DOM 工具，ES module）**

新建 `core/dashboard/components/dom.js`：

```javascript
// dom.js — 共享 DOM 构建工具，组件全用它。无依赖。
// h(): 建元素（tag.class#id + props + children）；icon(): 引 SVG sprite <use>；esc(): 文本转义。
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;   // 仅限内部可信内容（如 sprite use），外部文本走 text/children
    else el.setAttribute(k, v);
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

// 引 SVG sprite 图标：icon('ic-check', 'spin') → <svg class="ic spin"><use href="#ic-check"/></svg>
export function icon(symbolId, extraClass = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ic' + (extraClass ? ' ' + extraClass : ''));
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + symbolId);
  svg.appendChild(use);
  return svg;
}

// 文本转义（用于把 store 里的字符串安全插入 innerHTML 场景；优先用 textContent/children，本函数兜底）
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
```

- [ ] **Step 2: dashboard.html（壳 + SVG sprite + 加载顺序）**

新建 `core/dashboard/dashboard.html`。SVG sprite 的 14 个 `<symbol>` **从原型 `ui-prototype/dashboard.html` 第 217-232 行原样复制**（ic-box/brain/alert/check/loader/circle/slash/x/pause/pencil/refresh/pin/chevron/plus）。`<head>` 加载顺序：CSS → 经典脚本 contract/store（挂全局）→ module dashboard.js。挂载点 id 与组件对齐。

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AgentSeller · 自动化监控</title>
<link rel="stylesheet" href="dashboard.css">
<!-- contract/store 是 UMD 经典脚本，同步执行挂 window.__AS_DASH_*，必须先于 module dashboard.js -->
<script src="contract.js"></script>
<script src="state/store.js"></script>
<!-- dashboard.js 是 ES module（默认 defer，在经典脚本后执行） -->
<script type="module" src="dashboard.js"></script>
</head>
<body>
<svg width='0' height='0' style='position:absolute' aria-hidden='true'><defs>
<symbol id='ic-box' viewBox='0 0 24 24'><path d='M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z'/><path d='m3.3 7 8.7 5 8.7-5'/><path d='M12 22V12'/></symbol>
<symbol id='ic-brain' viewBox='0 0 24 24'><path d='m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z'/></symbol>
<symbol id='ic-alert' viewBox='0 0 24 24'><path d='m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z'/><path d='M12 9v4'/><path d='M12 17h.01'/></symbol>
<symbol id='ic-check' viewBox='0 0 24 24'><path d='M20 6 9 17l-5-5'/></symbol>
<symbol id='ic-loader' viewBox='0 0 24 24'><path d='M12 2v4M16.2 7.8l2.9-2.9M18 12h4M16.2 16.2l2.9 2.9M12 18v4M4.9 19.1l2.9-2.9M2 12h4M4.9 4.9l2.9 2.9'/></symbol>
<symbol id='ic-circle' viewBox='0 0 24 24'><circle cx='12' cy='12' r='9'/></symbol>
<symbol id='ic-slash' viewBox='0 0 24 24'><circle cx='12' cy='12' r='9'/><path d='M8 12h8'/></symbol>
<symbol id='ic-x' viewBox='0 0 24 24'><path d='M18 6 6 18M6 6l12 12'/></symbol>
<symbol id='ic-pause' viewBox='0 0 24 24'><path d='M9 5v14M15 5v14'/></symbol>
<symbol id='ic-pencil' viewBox='0 0 24 24'><path d='M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'/></symbol>
<symbol id='ic-refresh' viewBox='0 0 24 24'><path d='M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M3 21v-5h5'/></symbol>
<symbol id='ic-pin' viewBox='0 0 24 24'><path d='M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'/></symbol>
<symbol id='ic-chevron' viewBox='0 0 24 24'><path d='m6 9 6 6 6-6'/></symbol>
<symbol id='ic-plus' viewBox='0 0 24 24'><path d='M5 12h14M12 5v14'/></symbol>
</defs></svg>
<div id="app">
  <header class="topbar" id="topbar"><!-- topbar 组件渲染 --></header>
  <div class="main">
    <aside class="sidebar" id="queue-list"><!-- queue-list 组件渲染 --></aside>
    <section class="content" id="content"><!-- overview-bar + l2-cols 组件渲染 --></section>
  </div>
</div>
</body>
</html>
```

- [ ] **Step 3: dashboard.css 第一段（tokens + base + 布局 + 顶栏）**

新建 `core/dashboard/dashboard.css`。**从原型 `<style>`（第 8-214 行）拆出，视觉零变更。** 先写 tokens / base / 布局 / 顶栏段（对应原型第 8-72 行）：

```css
:root{
  /* 背景层次（深色盯盘） */
  --bg-0:#0d1117; --bg-1:#161b22; --bg-2:#1c2128; --bg-3:#21262d;
  --border:#30363d; --border-muted:#21262d;
  /* 文字 */
  --text-0:#e6edf3; --text-1:#8b949e; --text-2:#6e7681;
  /* 强调 */
  --accent:#58a6ff; --accent-dim:rgba(88,166,255,.14);
  /* 状态色（深底跳色） */
  --st-done:#3fb950; --st-running:#58a6ff; --st-pending:#6e7681;
  --st-error:#f85149; --st-skipped:#484f58; --st-paused:#d29922;
  /* 大脑流 kind */
  --k-review:#58a6ff; --k-diagnose:#e3b341; --k-selfheal:#bc8cff; --k-log:#6e7681;
  /* 错误三分层（paused橙 / validate黄 已分离，解决橙过载） */
  --err-read:#db61a2; --err-validate:#e3b341; --err-business:#f85149;
  /* 尺寸 */
  --radius:10px; --radius-sm:6px; --radius-xs:4px;
  --font:"Segoe UI","Microsoft YaHei UI","PingFang SC",-apple-system,BlinkMacSystemFont,system-ui,"Noto Sans SC",sans-serif;
  --mono:"Cascadia Mono","SF Mono","JetBrains Mono",Consolas,ui-monospace,monospace;
  --shadow:0 1px 0 rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.2);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:var(--font); font-size:17px; line-height:1.55; letter-spacing:.005em;
  color:var(--text-0); background:var(--bg-0);
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  text-rendering:optimizeLegibility; font-variant-numeric:tabular-nums;
}
.mono,.batch,.ids,.kv .v,.bevent .ts,.step .seq,.brief,.loc{font-feature-settings:"tnum" 1,"cv05" 1}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:var(--bg-3);border-radius:6px;border:2px solid var(--bg-0)}
::-webkit-scrollbar-thumb:hover{background:#3a4350}
.ic{width:1em;height:1em;display:inline-block;vertical-align:-.14em;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.ic.spin{animation:spin 1.4s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── 布局 ── */
#app{display:grid;grid-template-rows:auto 1fr;height:100vh;overflow:hidden}
.main{display:grid;grid-template-columns:248px 1fr;height:100%;overflow:hidden}

/* ── 顶栏 ── */
.topbar{
  display:flex;align-items:center;gap:14px;height:48px;padding:0 16px;
  background:linear-gradient(180deg,#1b2230,#161b22);
  border-bottom:1px solid var(--border);
}
.topbar .brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:18px}
.topbar .brand .logo{
  width:22px;height:22px;border-radius:6px;display:grid;place-items:center;
  background:linear-gradient(135deg,var(--accent),#388bfd);font-size:17px;box-shadow:0 0 0 1px rgba(88,166,255,.3)
}
.topbar .batch{
  color:var(--text-1);font-size:16px;font-family:var(--mono);
  padding:3px 8px;background:var(--bg-3);border-radius:var(--radius-xs);border:1px solid var(--border)
}
.topbar .spacer{flex:1}
.topbar .ctl{
  display:flex;align-items:center;gap:6px;height:30px;padding:0 10px;font-size:16px;color:var(--text-1);
  background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;transition:.15s
}
.topbar .ctl:hover{background:var(--bg-3);color:var(--text-0);border-color:#3a4350}
.ws-dot{width:8px;height:8px;border-radius:50%;background:var(--st-done);box-shadow:0 0 8px var(--st-done)}
.ws-dot.live{animation:pulse 2s infinite}
.ws-dot.reconnecting{background:var(--st-paused);box-shadow:0 0 8px var(--st-paused)}
.ws-dot.offline{background:var(--st-error);box-shadow:0 0 8px var(--st-error)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
```

> 注：相比原型，仅**新增** `.ws-dot.reconnecting` / `.ws-dot.offline` 两个状态色 class（原型只有绿色 `.live`，spec §6.4 要求绿/黄/红三态）。其余逐字符与原型一致。

下一段 CSS 在本 Task Step 4 继续追加（同一文件）。

- [ ] **Step 4: dashboard.css 第二段（队列侧栏 + L2 卡片 + 总览条 + 环节 + 大脑流 + HITL + 交互）**

继续编辑 `core/dashboard/dashboard.css`，**在 Step 3 内容末尾追加**（对应原型第 74-214 行，逐字符照搬，视觉零变更）：

```css
/* ── 侧栏 / 内容 ── */
.sidebar{background:var(--bg-1);border-right:1px solid var(--border);overflow-y:auto;padding:12px}
.content{overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}

/* ── L1 队列侧栏 ── */
.side-group{margin-bottom:12px}
.side-group-title{
  display:flex;align-items:center;gap:6px;font-size:15px;color:var(--text-2);
  text-transform:uppercase;letter-spacing:.04em;margin:2px 2px 8px;font-weight:600
}
.side-group-title .count{margin-left:auto;font-family:var(--mono)}
.wf-card{
  position:relative;padding:10px 12px;border-radius:var(--radius-sm);cursor:pointer;
  background:var(--bg-2);border:1px solid var(--border);margin-bottom:8px;transition:.15s
}
.wf-card:hover{border-color:#3a4350}
.wf-card.active{background:var(--accent-dim);border-color:var(--accent)}
.wf-card.active::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.wf-card .name{font-weight:600;font-size:17px;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-card .meta{display:flex;align-items:center;gap:10px;font-size:15px;color:var(--text-1)}
.wf-card .st{display:inline-flex;align-items:center;gap:4px}
.wf-card .st .d{width:7px;height:7px;border-radius:50%}
.mini-bar{display:flex;gap:2px;margin-top:8px}
.mini-bar i{height:3px;flex:1;border-radius:2px;background:var(--bg-3)}
.mini-bar i.done{background:var(--st-done)}
.mini-bar i.run{background:var(--st-running)}
.side-empty{padding:9px;text-align:center;font-size:15px;color:var(--text-2);border:1px dashed var(--border-muted);border-radius:var(--radius-sm)}
.side-new{
  margin-top:4px;padding:9px;text-align:center;font-size:16px;color:var(--text-2);
  border:1px dashed var(--border);border-radius:var(--radius-sm);cursor:not-allowed;opacity:.55
}

/* ── L2 通用卡片 ── */
.panel{background:var(--bg-1);border:1px solid var(--border);border-radius:var(--radius)}
.panel-head{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--border-muted);font-size:16px;font-weight:600;color:var(--text-1)}
.panel-head .tools{margin-left:auto;display:flex;gap:6px}
.chip-btn{font-size:15px;color:var(--text-2);padding:2px 8px;border:1px solid var(--border);border-radius:var(--radius-xs);cursor:pointer;background:var(--bg-2)}
.chip-btn:hover{color:var(--text-0);border-color:#3a4350}
.l2-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}

/* ── ① 流程总览条 ── */
.overview{padding:16px 24px}
.overview .ttl{display:flex;align-items:center;gap:14px;margin-bottom:14px}
.overview .pname{font-size:24px;font-weight:700;letter-spacing:-.01em}
.overview .ids{display:flex;gap:16px;font-size:16px;color:var(--text-2);font-family:var(--mono)}
.overview .ids b{color:var(--text-1);font-weight:500}
.badge{margin-left:auto;font-size:18px;font-weight:600;padding:6px 15px;border-radius:20px}
.badge.paused{color:var(--st-paused);background:rgba(210,153,34,.14);border:1px solid rgba(210,153,34,.32)}
.badge.running{color:var(--st-running);background:var(--accent-dim);border:1px solid rgba(88,166,255,.32)}
.badge.done{color:var(--st-done);background:rgba(63,185,80,.14);border:1px solid rgba(63,185,80,.32)}
.badge.error{color:var(--st-error);background:rgba(248,81,73,.14);border:1px solid rgba(248,81,73,.32)}
.track{display:flex;align-items:flex-start}
.node{flex:1;display:flex;flex-direction:column;align-items:center;position:relative}
.node .dot{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-size:18px;z-index:1;
  background:var(--bg-3);border:2px solid var(--st-pending);color:var(--text-2)}
.node.done .dot{background:var(--st-done);border-color:var(--st-done);color:#0d1117}
.node.run .dot{background:var(--st-running);border-color:var(--st-running);color:#0d1117;box-shadow:0 0 0 4px var(--accent-dim);animation:pulse 1.8s infinite}
.node .lbl{font-size:16px;color:var(--text-1);margin-top:11px;text-align:center;line-height:1.3}
.node.done .lbl,.node.run .lbl{color:var(--text-1)}
.node .ptag{position:absolute;top:-6px;left:calc(50% + 8px);font-size:15px}
.node::before{content:"";position:absolute;top:15px;left:-50%;width:100%;height:3px;background:var(--border)}
.node:first-child::before{display:none}
.node.done::before,.node.run::before{background:var(--st-done)}

/* ── ② 环节列表 ── */
.steps .panel-body{display:flex;flex-direction:column}
.step{display:flex;align-items:center;gap:9px;padding:6px 14px;border-bottom:1px solid var(--border-muted);font-size:16px}
.step:last-child{border-bottom:none}
.step .ico{width:16px;text-align:center;font-size:16px;flex-shrink:0}
.step.done .ico{color:var(--st-done)}
.step.run{background:rgba(88,166,255,.06)}
.step.run .ico{color:var(--st-running)}
.step.pending .ico{color:var(--st-pending)}
.step.paused{background:rgba(210,153,34,.07)}
.step.paused .ico{color:var(--st-paused)}
.step.error{background:rgba(248,81,73,.07)}
.step.error .ico{color:var(--st-error)}
.step.skip{opacity:.5}
.step .seq{color:var(--text-2);font-family:var(--mono);font-size:15px;width:12px}
.step .nm{color:var(--text-0)}
.step.pending .nm,.step.skip .nm{color:var(--text-1)}
.step .right{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:15px;color:var(--text-2)}
.step .brief b{color:var(--k-selfheal);font-weight:500}
.tag{font-size:14px;padding:2px 7px;border-radius:var(--radius-xs);white-space:nowrap}
.tag.hitl{color:var(--st-paused);background:rgba(210,153,34,.14);border:1px solid rgba(210,153,34,.3)}
.tag.prod{color:var(--accent);background:var(--accent-dim);cursor:pointer}
.err-chip{font-size:14px;padding:2px 7px;border-radius:var(--radius-xs);white-space:nowrap}
.err-chip.read{color:var(--err-read);background:rgba(219,97,162,.14);border:1px solid rgba(219,97,162,.32)}
.err-chip.validate{color:var(--err-validate);background:rgba(227,179,65,.14);border:1px solid rgba(227,179,65,.32)}
.err-chip.business{color:var(--err-business);background:rgba(248,81,73,.14);border:1px solid rgba(248,81,73,.32)}

/* ── ③ 大脑实时流 ── */
.brain{display:flex;flex-direction:column;max-height:300px}
.brain .panel-body{flex:1;overflow-y:auto;padding:4px 0}
.bevent{display:flex;gap:9px;padding:5px 14px;font-size:16px;border-left:2px solid transparent}
.bevent .ts{color:var(--text-2);font-family:var(--mono);font-size:14px;flex-shrink:0;padding-top:1px}
.bevent .body{color:var(--text-1)}
.bevent .kind{font-weight:600;margin-right:5px}
.bevent .anchor{color:var(--text-2);font-family:var(--mono);font-size:14px;margin-left:5px;cursor:pointer}
.bevent.review{border-left-color:var(--k-review)} .bevent.review .kind{color:var(--k-review)}
.bevent.diagnose{border-left-color:var(--k-diagnose)} .bevent.diagnose .kind{color:var(--k-diagnose)}
.bevent.selfheal{border-left-color:var(--k-selfheal)} .bevent.selfheal .kind{color:var(--k-selfheal)}
.bevent.log{border-left-color:var(--border-muted)} .bevent.log .kind{color:var(--k-log)} .bevent.log .body{color:var(--text-2)}
.brain .foot{padding:7px 14px;border-top:1px solid var(--border-muted);font-size:15px;color:var(--text-2);display:flex;align-items:center;gap:6px}
.brain .foot .live{width:6px;height:6px;border-radius:50%;background:var(--st-done);animation:pulse 1.6s infinite}

/* ── ④ HITL 待确认 ── */
.hitl{border-color:rgba(210,153,34,.4)}
.hitl>.panel-head{color:var(--st-paused);background:rgba(210,153,34,.07)}
.hitl-card{margin:12px 14px;border:1px solid rgba(210,153,34,.42);border-radius:var(--radius-sm);background:rgba(210,153,34,.05);animation:breathe 2.6s infinite}
@keyframes breathe{0%,100%{box-shadow:0 0 0 0 rgba(210,153,34,0)}50%{box-shadow:0 0 0 3px rgba(210,153,34,.12)}}
.hitl-card .h{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border-muted);font-weight:600}
.hitl-card .h .act{color:var(--st-paused)}
.hitl-card .h .loc{margin-left:auto;font-size:15px;color:var(--text-2);font-family:var(--mono)}
.kv{padding:8px 12px;display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:16px}
.kv .k{color:var(--text-2)}
.kv .v{color:var(--text-0);font-family:var(--mono)}
.review-note{padding:9px 12px;font-size:15px;color:var(--text-1);border-top:1px dashed var(--border-muted);display:flex;gap:6px;line-height:1.45}
.review-note .ai{color:var(--k-review);flex-shrink:0}
.hitl-acts{display:flex;gap:8px;padding:8px 12px 10px}
.btn{flex:1;padding:8px;border-radius:var(--radius-sm);font-size:16px;font-weight:600;cursor:pointer;border:1px solid transparent;text-align:center;transition:.15s}
.btn.ok{background:var(--st-done);color:#06210f}
.btn.ok:hover{filter:brightness(1.12)}
.btn.edit{background:var(--bg-3);color:var(--text-0);border-color:var(--border)}
.btn.edit:hover{border-color:#3a4350}
.btn.no{background:transparent;color:var(--st-error);border-color:rgba(248,81,73,.4)}
.btn.no:hover{background:rgba(248,81,73,.1)}
.hitl-empty{margin:12px 14px;padding:14px;text-align:center;font-size:15px;color:var(--text-2);border:1px dashed var(--border-muted);border-radius:var(--radius-sm)}

/* ── L2 空态 ── */
.l2-empty{padding:40px 16px;text-align:center;color:var(--text-2);font-size:16px}

/* ── 交互：hover 浮动 + 点击选中高亮 ── */
.wf-card{transition:transform .16s,box-shadow .16s,background .16s,border-color .16s}
.wf-card:hover{transform:translateY(-4px);box-shadow:0 14px 32px rgba(0,0,0,.55),0 0 28px rgba(88,166,255,.4);background:var(--bg-3);border-color:#79c0ff}
.wf-card.active:hover{background:var(--accent-dim);border-color:var(--accent)}
.step{cursor:pointer;transition:background .13s,box-shadow .13s}
.step:hover{background:rgba(88,166,255,.22)}
.step.sel{background:var(--accent-dim);box-shadow:inset 3px 0 0 var(--accent)}
.bevent{transition:background .13s;cursor:pointer}
.bevent:hover{background:rgba(88,166,255,.18)}
.bevent.sel{background:rgba(88,166,255,.1);box-shadow:inset 2px 0 0 var(--accent)}
.chip-btn,.ctl{transition:transform .15s,background .15s,color .15s,border-color .15s}
.chip-btn:hover,.ctl:hover{transform:translateY(-2px);border-color:#4a5568}
.btn{transition:transform .15s,filter .15s,background .15s,border-color .15s,box-shadow .15s}
.btn:hover{transform:translateY(-2px)}
.btn.ok:hover{box-shadow:0 5px 14px rgba(63,185,80,.32)}
.tag.prod{transition:transform .15s,background .15s}
.tag.prod:hover{transform:translateY(-1px);background:rgba(88,166,255,.22)}
.panel{transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
.panel:hover{transform:translateY(-6px);border-color:#79c0ff;background:#1b2436;box-shadow:0 22px 50px rgba(0,0,0,.6),0 0 0 1px #79c0ff,0 0 44px rgba(88,166,255,.55),inset 0 0 32px rgba(88,166,255,.1)}
.hitl:hover{border-color:#e0a93b;background:#2a2418;box-shadow:0 22px 50px rgba(0,0,0,.6),0 0 0 1px #e0a93b,0 0 44px rgba(210,153,34,.6),inset 0 0 32px rgba(210,153,34,.12)}
```

> 相比原型**新增**（spec 契约要求，非视觉变更）：`.badge.running/.done/.error`（原型只有 paused，契约有多状态）、`.step.paused`（spec §4.1 显式 paused 态）、`.err-chip.read/validate/business`（spec §6.2 三分层 chip）、`.hitl-empty`/`.l2-empty`（spec §6.3 空态）。其余逐字符照搬原型。

- [ ] **Step 5: 删占位、改用真壳，build 验证静态加载**

删掉 Task 1 Step 5 建的占位 `core/dashboard/dashboard.js` 内容——它会在 Task 7 写成真入口；本 Task 先让它保持占位但能加载（dashboard.html 已 `<script type="module" src="dashboard.js">`，占位文件存在即可，不报 404）。构建：

Run: `python3 build/build_extension.py && ls dist/extension/dashboard/ dist/extension/dashboard/components/`

Expected: `dist/extension/dashboard/` 含 `dashboard.html dashboard.css dashboard.js contract.js`；`components/` 含 `dom.js`（证明壳 + 工具拷贝到位）。

- [ ] **Step 6: 手动验证（壳 + tokens 生效）**

动作：chrome `chrome://extensions` reload 扩展 → 地址栏打开 `chrome-extension://<扩展ID>/dashboard/dashboard.html`（扩展 ID 在扩展卡片上）。

Expected：页面深色背景（`#0d1117`）、顶栏 48px 高占位（内容空，组件未渲染）、左侧 248px 侧栏占位、右侧详情区空。**无报错**（F12 Console 无红）。此刻组件挂载点为空属正常（组件在 Task 5-7 渲染）。

- [ ] **Step 7: commit**

```
git add core/dashboard/components/dom.js core/dashboard/dashboard.html core/dashboard/dashboard.css
git commit -m "$(cat <<'EOF'
feat(dashboard): dom 工具 + 静态壳（dashboard.html + dashboard.css）

Why: 搭可加载扩展页骨架，深色 tokens + 全组件样式从原型拆到 dashboard.css（视觉零变更）；组件需共享 h()/icon()/esc() 工具。
What: dom.js（h/icon/esc，ES module）；dashboard.html（SVG sprite 14 图标 + 布局壳 + 加载顺序 contract/store 经典脚本先于 module dashboard.js）；dashboard.css（原型 :root tokens + 全组件样式，新增 ws-dot 三态/badge 多态/step.paused/err-chip 三分层/空态 class）。
Test: python3 build/build_extension.py 后 chrome 打开 dashboard.html，深色壳渲染、Console 无报错。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 组件渲染（topbar + queue-list + overview-bar）

**目的：** 第一批纯渲染组件。每个组件是 ES module，export `render(mountEl, state)`，从 store state 读数据全量重渲（清空挂载点重建）。本 Task 后 dashboard 顶栏 / L1 队列 / ① 流程总览条按 mock 骨架渲染。组件用 `dom.js` 的 `h()`/`icon()`，读 `state.skeleton.batch` 与 `state.wsStatus`。

**Files:**
- Create: `core/dashboard/components/topbar.js`
- Create: `core/dashboard/components/queue-list.js`
- Create: `core/dashboard/components/overview-bar.js`

约定（全组件统一）：
- `render(mountEl, state)`：`mountEl.replaceChildren(...)` 全量重渲（骨架全量重渲，spec §8）。
- 取「当前 workflow」= `batch.workflows.find(w => w.id === batch.activeWorkflowId)`，无则取首个，再无则 null（渲染空态）。
- 状态 → class 映射用 `STATUS_CLASS` 常量表，避免散落 if/else。

- [ ] **Step 1: topbar.js**

新建 `core/dashboard/components/topbar.js`：

```javascript
// topbar.js — 顶栏：brand / 批次标签 / WS 灯 / 置顶 / 刷新。读 state.skeleton.batch + state.wsStatus。
import { h, icon } from './dom.js';

// WS 灯三态文案（spec §6.4：绿连接/黄重连/红断开）
const WS_LABEL = { live: '实时', reconnecting: '重连中', offline: '离线' };

function fmtBatchLabel(batch) {
  if (!batch || !batch.id) return '无批次';
  const t = batch.createdAt ? new Date(batch.createdAt) : null;
  const time = t ? `${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '';
  return `批次 #${batch.id}${time ? ' · ' + time : ''}`;
}

export function renderTopbar(mountEl, state) {
  const batch = state.skeleton.batch;
  const ws = state.wsStatus || 'offline';

  mountEl.replaceChildren(
    h('div', { class: 'brand' }, [
      h('span', { class: 'logo' }, [icon('ic-box')]),
      'AgentSeller 自动化监控',
    ]),
    h('span', { class: 'batch' }, fmtBatchLabel(batch)),
    h('div', { class: 'spacer' }),
    h('div', { class: 'ctl' }, [
      h('span', { class: 'ws-dot ' + ws + (ws === 'live' ? ' live' : '') }),
      WS_LABEL[ws] || '离线',
    ]),
    h('div', { class: 'ctl', onClick: () => window.__AS_DASH_TOGGLE_PIN && window.__AS_DASH_TOGGLE_PIN() }, [icon('ic-pin'), ' 置顶']),
    h('div', { class: 'ctl', onClick: () => location.reload() }, [icon('ic-refresh'), ' 刷新']),
  );
}
```

- [ ] **Step 2: queue-list.js**

新建 `core/dashboard/components/queue-list.js`：

```javascript
// queue-list.js — L1 队列侧栏：按 workflow.status 分「进行中/待处理/已完成」三组，渲染 wf-card。
// 点 card 切 activeWorkflowId（发回调，dashboard.js 接管重渲）。本 Plan mock 仅 1 个 workflow。
import { h, icon } from './dom.js';

// status → 侧栏状态点颜色 + 中文（spec §5.3 状态色板）
const ST_DOT = {
  pending: 'var(--st-pending)', running: 'var(--st-running)', paused: 'var(--st-paused)',
  error: 'var(--st-error)', done: 'var(--st-done)', aborted: 'var(--st-skipped)',
};
const ST_TEXT = {
  pending: '待处理', running: '运行中', paused: '待确认',
  error: '出错', done: '已完成', aborted: '已中止',
};

// 分组：进行中(running/paused/error) / 待处理(pending) / 已完成(done/aborted)
function groupWorkflows(workflows) {
  const active = [], todo = [], finished = [];
  for (const w of workflows) {
    if (w.status === 'pending') todo.push(w);
    else if (w.status === 'done' || w.status === 'aborted') finished.push(w);
    else active.push(w);
  }
  return { active, todo, finished };
}

function miniBar(steps) {
  return h('div', { class: 'mini-bar' }, steps.map(s =>
    h('i', { class: s.status === 'done' ? 'done' : (s.status === 'running' || s.status === 'paused') ? 'run' : '' })));
}

function wfCard(w, activeId, onSelect) {
  const doneCount = w.steps.filter(s => s.status === 'done').length;
  return h('div', {
    class: 'wf-card' + (w.id === activeId ? ' active' : ''),
    onClick: () => onSelect(w.id),
  }, [
    h('div', { class: 'name' }, w.product?.label || w.id),
    h('div', { class: 'meta' }, [
      h('span', { class: 'st' }, [
        h('span', { class: 'd', style: 'background:' + (ST_DOT[w.status] || ST_DOT.pending) }),
        ST_TEXT[w.status] || w.status,
      ]),
      h('span', {}, `环节 ${doneCount}/${w.steps.length}`),
    ]),
    miniBar(w.steps),
  ]);
}

function group(title, count, dotColor, cards) {
  const titleChildren = [];
  if (dotColor) titleChildren.push(h('span', { class: 'd', style: `width:7px;height:7px;border-radius:50%;background:${dotColor};display:inline-block` }));
  titleChildren.push(title + ' ');
  titleChildren.push(h('span', { class: 'count' }, String(count)));
  return h('div', { class: 'side-group' }, [
    h('div', { class: 'side-group-title' }, titleChildren),
    ...(cards.length ? cards : [h('div', { class: 'side-empty' }, '暂无')]),
  ]);
}

export function renderQueueList(mountEl, state, onSelect) {
  const workflows = state.skeleton.batch.workflows || [];
  const activeId = state.skeleton.batch.activeWorkflowId;
  const { active, todo, finished } = groupWorkflows(workflows);

  mountEl.replaceChildren(
    group('进行中', active.length, 'var(--st-running)', active.map(w => wfCard(w, activeId, onSelect))),
    group('待处理', todo.length, null, todo.map(w => wfCard(w, activeId, onSelect))),
    group('已完成', finished.length, null, finished.map(w => wfCard(w, activeId, onSelect))),
    h('div', { class: 'side-new' }, [icon('ic-plus'), ' 新建流程（规划中）']),
  );
}
```

- [ ] **Step 3: overview-bar.js**

新建 `core/dashboard/components/overview-bar.js`：

```javascript
// overview-bar.js — ① 流程总览条：商品名 + status badge + 进度% + ids + 节点 track。
// 节点 track 按 step 序渲染，done/run(=running 或 cursor 指向) class，paused 步加暂停 ptag。
import { h, icon } from './dom.js';

// workflow.status → badge class + 图标 + 文案
const BADGE = {
  running:  { cls: 'running', ic: 'ic-loader', text: '运行中' },
  paused:   { cls: 'paused',  ic: 'ic-pause',  text: '待确认' },
  done:     { cls: 'done',    ic: 'ic-check',  text: '已完成' },
  error:    { cls: 'error',   ic: 'ic-alert',  text: '出错' },
  pending:  { cls: 'running', ic: 'ic-circle', text: '待开始' },
  aborted:  { cls: 'error',   ic: 'ic-x',      text: '已中止' },
};

function pct(steps) {
  if (!steps.length) return 0;
  const done = steps.filter(s => s.status === 'done').length;
  return Math.round(done / steps.length * 100);
}

// 节点 class：done→done；running 或 paused（cursor 指向的进行中步）→ run；其余无
function nodeClass(step) {
  if (step.status === 'done') return 'node done';
  if (step.status === 'running' || step.status === 'paused') return 'node run';
  return 'node';
}

function node(step, idx) {
  const cls = nodeClass(step);
  const dotChildren = step.status === 'done'
    ? [icon('ic-check')]
    : [String(idx + 1)];
  const children = [h('div', { class: 'dot' }, dotChildren)];
  if (step.status === 'paused') children.push(h('span', { class: 'ptag' }, [icon('ic-pause')]));
  children.push(h('div', { class: 'lbl' }, step.label));
  return h('div', { class: cls }, children);
}

export function renderOverviewBar(mountEl, workflow) {
  if (!workflow) {
    mountEl.replaceChildren(h('div', { class: 'l2-empty' }, '暂无进行中的流程（多商品规划中）'));
    return;
  }
  const b = BADGE[workflow.status] || BADGE.pending;
  const p = workflow.product || {};
  mountEl.replaceChildren(
    h('div', { class: 'panel overview' }, [
      h('div', { class: 'ttl' }, [
        h('span', { class: 'pname' }, p.label || workflow.id),
        h('span', { class: 'badge ' + b.cls }, [icon(b.ic), ` ${b.text} · ${pct(workflow.steps)}%`]),
      ]),
      h('div', { class: 'ids', style: 'margin-bottom:18px' }, [
        h('span', {}, ['SPU ', h('b', {}, p.spuId || '—')]),
        h('span', {}, ['SKC ', h('b', {}, p.skc || '—')]),
        h('span', {}, ['SKU ', h('b', {}, p.skuNo || '—')]),
      ]),
      h('div', { class: 'track' }, workflow.steps.map((s, i) => node(s, i))),
    ]),
  );
}
```

- [ ] **Step 4: build + 手动验证（顶栏 + 队列 + 总览条）**

> 注：这三个组件要等 Task 7 的 dashboard.js 装配才会真正挂上页面。本 Task 末尾**先只验证 build 拷贝**，渲染效果在 Task 7 统一手动验证（避免在装配前空跑）。

Run: `python3 build/build_extension.py && ls dist/extension/dashboard/components/`

Expected: `components/` 含 `dom.js topbar.js queue-list.js overview-bar.js`。

- [ ] **Step 5: commit**

```
git add core/dashboard/components/topbar.js core/dashboard/components/queue-list.js core/dashboard/components/overview-bar.js
git commit -m "$(cat <<'EOF'
feat(dashboard): topbar + queue-list + overview-bar 组件（纯渲染）

Why: 第一批组件，读 store 骨架全量重渲顶栏/L1 队列/① 流程总览条。
What: topbar.js（brand/批次标签/WS 灯三态/置顶/刷新）；queue-list.js（按 status 分进行中/待处理/已完成三组渲 wf-card，点击切 activeWorkflowId）；overview-bar.js（商品名/status badge/进度%/ids/节点 track，paused 步加暂停 ptag）。
Test: python3 build/build_extension.py 拷贝到位；渲染效果在 Task 7 装配后统一验证。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 组件渲染（step-list + error-chip + brain-stream + hitl-queue）

**目的：** 第二批组件，含本 Plan 最关键的契约落实点：step-list **按 `step.status==='paused'` 显式渲染 HITL 标记**（不复刻原型 run+tag 隐式约定）。brain-stream 做**增量 append**（spec §8：骨架全量重渲、大脑流增量 append）。error-chip 按 `error.category` 三分层渲染。hitl-queue 渲染 ④ 待确认卡（本 Plan 仅渲染，确认/改/拒绝的真实 message 回路留后续）。

**Files:**
- Create: `core/dashboard/components/error-chip.js`
- Create: `core/dashboard/components/step-list.js`
- Create: `core/dashboard/components/brain-stream.js`
- Create: `core/dashboard/components/hitl-queue.js`

- [ ] **Step 1: error-chip.js（三分层错误 chip）**

新建 `core/dashboard/components/error-chip.js`：

```javascript
// error-chip.js — step error 三分层 chip（spec §6.2）。read 紫红 / validate 黄 / business 红。
// category 是路由字段（spec §4.1）。视觉权重 business > validate > read（介入紧迫度）。
import { h } from './dom.js';

const CAT_LABEL = { read: '读取', validate: '校验', business: '业务' };

// 返回 chip 元素；error 为 null 返回 null（调用方过滤）
export function errorChip(error) {
  if (!error || !error.category) return null;
  const cat = error.category;
  const msg = error.message ? String(error.message) : '';
  const short = msg.length > 24 ? msg.slice(0, 24) + '…' : msg;
  return h('span', {
    class: 'err-chip ' + cat,
    title: msg + (error.suggestion ? '\n建议：' + error.suggestion : ''),
  }, `${CAT_LABEL[cat] || cat}${short ? '：' + short : ''}`);
}
```

- [ ] **Step 2: step-list.js（含 paused 显式 HITL 标记）**

新建 `core/dashboard/components/step-list.js`：

```javascript
// step-list.js — ② 环节列表。按 step.status 渲染行 class + 图标。
// 关键契约（spec §4.1/§6.1）：status==='paused' 显式渲染 HITL 橙标记 + 暂停图标，不复刻原型 run+tag 隐式约定。
import { h, icon } from './dom.js';
import { errorChip } from './error-chip.js';

// status → { 行 class, 图标 symbol, 图标是否旋转 }
const ST = {
  done:    { cls: 'done',    ic: 'ic-check',  spin: false },
  running: { cls: 'run',     ic: 'ic-loader', spin: true },
  paused:  { cls: 'paused',  ic: 'ic-pause',  spin: false },
  pending: { cls: 'pending', ic: 'ic-circle', spin: false },
  error:   { cls: 'error',   ic: 'ic-alert',  spin: false },
  skipped: { cls: 'skip',    ic: 'ic-slash',  spin: false },
};

// 右侧附加块：brainBrief（selfheal 高亮）/ 产物 tag / HITL 待确认 tag / error chip / skipped note
function rightBlock(step) {
  const items = [];
  // brainBrief：'selfheal:...' 把 selfheal 前缀加粗（原型 .brief b 着 selfheal 色）
  if (step.brainBrief) {
    const m = /^selfheal[:：]?(.*)$/.exec(step.brainBrief);
    if (m) items.push(h('span', { class: 'brief' }, [h('b', {}, 'selfheal'), '·' + m[1].trim()]));
    else items.push(h('span', { class: 'brief' }, step.brainBrief));
  }
  // 产物 tag（有 result 且非空时可点开看，本 Plan 仅展示，不绑展开）
  if (step.result && Object.keys(step.result).length) {
    items.push(h('span', { class: 'tag prod' }, ['产物 ', icon('ic-chevron')]));
  }
  // 显式 HITL 标记：status==='paused' → 橙「待确认」tag（契约要求，非原型 run+tag）
  if (step.status === 'paused') {
    items.push(h('span', { class: 'tag hitl' }, [icon('ic-pause'), ' 待确认']));
  }
  // error chip（三分层）
  const chip = errorChip(step.error);
  if (chip) items.push(chip);
  // skipped note（原型「已跳过 · 本批不导出」）
  if (step.status === 'skipped' && step.note) {
    items.push(h('span', {}, '已跳过 · ' + step.note));
  }
  return items.length ? h('div', { class: 'right' }, items) : null;
}

function stepRow(step, idx, selectedId, onSelect) {
  const meta = ST[step.status] || ST.pending;
  const children = [
    h('span', { class: 'ico' }, [icon(meta.ic, meta.spin ? 'spin' : '')]),
    h('span', { class: 'seq' }, String(idx + 1)),
    h('span', { class: 'nm' }, step.label),
  ];
  const right = rightBlock(step);
  if (right) children.push(right);
  return h('div', {
    class: 'step ' + meta.cls + (step.id === selectedId ? ' sel' : ''),
    onClick: () => onSelect && onSelect(step.id),
  }, children);
}

export function renderStepList(mountEl, workflow, selectedStepId, onSelect) {
  if (!workflow) { mountEl.replaceChildren(); return; }
  mountEl.replaceChildren(
    h('div', { class: 'panel steps' }, [
      h('div', { class: 'panel-head' }, '📋 环节列表'),
      h('div', { class: 'panel-body' }, workflow.steps.map((s, i) => stepRow(s, i, selectedStepId, onSelect))),
    ]),
  );
}
```

- [ ] **Step 3: brain-stream.js（增量 append）**

新建 `core/dashboard/components/brain-stream.js`。**与其他组件不同：不全量重渲，而是增量 append 新事件**（spec §8 大脑流增量 append）。组件维护「已渲染数量」游标，只 append store.brainEvents 中超出游标的新条目；自动滚到底。

```javascript
// brain-stream.js — ③ 大脑实时流。增量 append（不全量重渲）：维护已渲染游标，只追加新事件，自动滚底。
// kind ∈ review|diagnose|selfheal|log，对应 .bevent.<kind> 着色（spec §5.3）。
import { h, icon } from './dom.js';

function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function beventRow(ev) {
  const body = [h('span', { class: 'kind' }, ev.kind)];
  body.push(ev.text || '');
  if (ev.anchor) body.push(h('span', { class: 'anchor' }, ev.anchor));
  return h('div', { class: 'bevent ' + (ev.kind || 'log') }, [
    h('span', { class: 'ts' }, fmtTs(ev.ts)),
    h('div', { class: 'body' }, body),
  ]);
}

// 创建组件实例：首次建固定外壳（panel-head/body/foot），返回 update(state) 做增量 append。
// dashboard.js 对大脑流调 update（增量），不调全量 render。
export function createBrainStream(mountEl) {
  const bodyEl = h('div', { class: 'panel-body' });
  const panel = h('div', { class: 'panel brain' }, [
    h('div', { class: 'panel-head' }, [
      icon('ic-brain'), ' 大脑实时流',
      h('div', { class: 'tools' }, [
        h('span', { class: 'chip-btn' }, [icon('ic-pause'), ' 自动滚动']),
        h('span', { class: 'chip-btn' }, '折叠 log'),
      ]),
    ]),
    bodyEl,
    h('div', { class: 'foot' }, [h('span', { class: 'live' }), '实时接收中…']),
  ]);
  mountEl.replaceChildren(panel);

  let rendered = 0;   // 已渲染条数游标
  function update(state) {
    const events = state.brainEvents || [];
    // store 限流可能裁掉最旧条目导致 events 变短：若 rendered 超过当前长度（裁剪过），重建
    if (rendered > events.length) { bodyEl.replaceChildren(); rendered = 0; }
    for (let i = rendered; i < events.length; i++) bodyEl.appendChild(beventRow(events[i]));
    rendered = events.length;
    bodyEl.scrollTop = bodyEl.scrollHeight;   // 自动滚底
  }
  return { update };
}
```

- [ ] **Step 4: hitl-queue.js（④ 待确认卡）**

新建 `core/dashboard/components/hitl-queue.js`：

```javascript
// hitl-queue.js — ④ HITL 待确认。读 workflow.hitl（storage 骨架，含 editable/fieldType/options）。
// 本 Plan 仅渲染卡（keyValues + 复核结论 + 确认/改/拒绝按钮）；确认/改/拒绝的真实 message→background 回路留后续。
import { h, icon } from './dom.js';

function kvRows(keyValues) {
  const out = [];
  for (const [k, v] of Object.entries(keyValues || {})) {
    out.push(h('span', { class: 'k' }, k));
    out.push(h('span', { class: 'v' }, String(v)));
  }
  return out;
}

function hitlCard(hitl, locText, onAction) {
  return h('div', { class: 'hitl-card' }, [
    h('div', { class: 'h' }, [
      h('span', {}, [icon('ic-alert')]),
      h('span', { class: 'act' }, hitl.action || '待确认'),
      h('span', { class: 'loc' }, locText),
    ]),
    h('div', { class: 'kv' }, kvRows(hitl.keyValues)),
    hitl.reviewedBrief
      ? h('div', { class: 'review-note' }, [
          h('span', { class: 'ai' }, [icon('ic-brain'), ' 复核']),
          h('span', {}, hitl.reviewedBrief),
        ])
      : null,
    h('div', { class: 'hitl-acts' }, [
      h('div', { class: 'btn ok', onClick: () => onAction && onAction('confirm', hitl) }, [icon('ic-check'), ' 确认']),
      h('div', { class: 'btn edit', onClick: () => onAction && onAction('modify', hitl) }, [icon('ic-pencil'), ' 改']),
      h('div', { class: 'btn no', onClick: () => onAction && onAction('reject', hitl) }, [icon('ic-x'), ' 拒绝']),
    ]),
  ]);
}

export function renderHitlQueue(mountEl, workflow, onAction) {
  const hitl = workflow && workflow.hitl;
  const count = hitl ? 1 : 0;
  const head = h('div', { class: 'panel-head' }, [
    icon('ic-pause'), ' HITL 待确认',
    h('span', { style: 'margin-left:5px;color:var(--st-paused)' }, `(${count})`),
  ]);
  // 定位文案：cursor 指向的 step seq + label
  let locText = '';
  if (workflow && typeof workflow.cursor === 'number' && workflow.cursor >= 0) {
    const cur = workflow.steps[workflow.cursor];
    if (cur) locText = `步骤${workflow.cursor + 1} · ${cur.label}`;
  }
  const body = hitl
    ? hitlCard(hitl, locText, onAction)
    : h('div', { class: 'hitl-empty' }, '暂无待确认，流程自动推进中');
  mountEl.replaceChildren(h('div', { class: 'panel hitl' }, [head, body]));
}
```

- [ ] **Step 5: build 验证拷贝**

Run: `python3 build/build_extension.py && ls dist/extension/dashboard/components/`

Expected: `components/` 含全部 8 个组件 `dom.js error-chip.js step-list.js brain-stream.js hitl-queue.js topbar.js queue-list.js overview-bar.js`。

- [ ] **Step 6: commit**

```
git add core/dashboard/components/error-chip.js core/dashboard/components/step-list.js core/dashboard/components/brain-stream.js core/dashboard/components/hitl-queue.js
git commit -m "$(cat <<'EOF'
feat(dashboard): step-list/brain-stream/hitl-queue/error-chip 组件

Why: 第二批组件含最关键契约落实——step-list 按 status==='paused' 显式渲 HITL 标记（不复刻原型 run+tag 隐式约定）；大脑流增量 append（spec §8）。
What: error-chip.js（read/validate/business 三分层 chip）；step-list.js（status→class/图标，paused 显式 HITL tag，error chip，skipped note）；brain-stream.js（createBrainStream 固定外壳 + update 增量 append + 自动滚底 + 限流裁剪重建）；hitl-queue.js（④ 待确认卡，keyValues/复核/确认改拒绝按钮，空态）。
Test: python3 build/build_extension.py 拷贝 8 组件到位；渲染在 Task 7 装配后验证。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: dashboard.js 装配 + 接真实 storage（含 selectActiveWorkflow 纯逻辑单测）

**目的：** ES module 入口，把 store + 三个源 + 全部组件接起来：建 store、建 L2 content 布局骨架（overview-bar 满宽 + l2-cols 两列）、订阅 store 全量重渲、启动 storage-source（真实）+ ws-source（mock）。补「选当前 workflow」纯逻辑 helper 的单测（这是唯一值得单测的 dashboard.js 逻辑，UI 渲染走手动验证）。本 Task 后 dashboard 完整渲染 mock + 大脑流逐条 append。

**Files:**
- Create: `core/dashboard/components/select-active.js`（纯逻辑 helper，便于单测）
- Modify: `core/dashboard/dashboard.js`（占位 → 真入口）
- Modify: `tests/dashboard-store.test.js`（加 selectActiveWorkflow 用例）

- [ ] **Step 1: 写 selectActiveWorkflow 失败测试**

在 `tests/dashboard-store.test.js` **末尾追加**（同文件，复用已 require 的 test/assert）：

```javascript
const { selectActiveWorkflow } = require('../core/dashboard/components/select-active.js');

test('selectActiveWorkflow: 按 activeWorkflowId 命中', () => {
  const batch = { activeWorkflowId: 'w2', workflows: [{ id: 'w1' }, { id: 'w2' }] };
  assert.strictEqual(selectActiveWorkflow(batch).id, 'w2');
});
test('selectActiveWorkflow: activeWorkflowId 无效 → 退化取首个', () => {
  const batch = { activeWorkflowId: 'nope', workflows: [{ id: 'w1' }, { id: 'w2' }] };
  assert.strictEqual(selectActiveWorkflow(batch).id, 'w1');
});
test('selectActiveWorkflow: 空 workflows → null', () => {
  assert.strictEqual(selectActiveWorkflow({ activeWorkflowId: null, workflows: [] }), null);
});
test('selectActiveWorkflow: batch 缺失 → null（不抛）', () => {
  assert.strictEqual(selectActiveWorkflow(null), null);
  assert.strictEqual(selectActiveWorkflow(undefined), null);
  assert.strictEqual(selectActiveWorkflow({}), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/dashboard-store.test.js`
Expected: FAIL —— `Cannot find module '../core/dashboard/components/select-active.js'`。

- [ ] **Step 3: 实现 select-active.js（UMD 双模式）**

新建 `core/dashboard/components/select-active.js`。**与组件不同，这是 UMD 双模式**（既被 node require 单测，又被 ES module dashboard.js 用）——故挂全局而非 `export`，dashboard.js 通过 `window.__AS_DASH_SELECT__` 读：

```javascript
// select-active.js — 从 batch 选「当前 workflow」。UMD 双模式（node 单测 require + 浏览器全局）。
// 规则：先按 activeWorkflowId 命中；无效则退化取首个；空则 null（spec：起步单 workflow，数组留位）。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.__AS_DASH_SELECT__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function selectActiveWorkflow(batch) {
    if (!batch || !Array.isArray(batch.workflows) || batch.workflows.length === 0) return null;
    const byId = batch.workflows.find(w => w.id === batch.activeWorkflowId);
    return byId || batch.workflows[0];
  }
  return { selectActiveWorkflow };
});
```

> 加载：dashboard.html 的 `<head>` 经典脚本区**追加** `<script src="components/select-active.js"></script>`（在 contract/store 之后、module dashboard.js 之前）。本 Task Step 5 改 dashboard.html。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/dashboard-store.test.js`
Expected: PASS —— 含原 store 用例 + 4 条 selectActiveWorkflow 用例（命中/退化/空/缺失不抛），全部 0 失败。

- [ ] **Step 5: dashboard.html 追加 select-active 经典脚本**

编辑 `core/dashboard/dashboard.html`，在 `<script src="state/store.js"></script>` 后加一行：

```html
<script src="components/select-active.js"></script>
```

（使 `window.__AS_DASH_SELECT__` 在 module dashboard.js 执行前就绪。）

- [ ] **Step 6: 实现 dashboard.js（真入口，替换占位）**

覆盖 `core/dashboard/dashboard.js`：

```javascript
// dashboard.js — ES module 入口。装配 store + 源 + 组件，订阅 store 重渲。
// 骨架（topbar/queue-list/overview-bar/step-list/hitl-queue）全量重渲；大脑流增量 append（独立 update）。
// 数据源：storage-source（真实 chrome.storage）+ ws-source（本 Plan mock，Plan 3 换真实 WS）。
import { renderTopbar } from './components/topbar.js';
import { renderQueueList } from './components/queue-list.js';
import { renderOverviewBar } from './components/overview-bar.js';
import { renderStepList } from './components/step-list.js';
import { createBrainStream } from './components/brain-stream.js';
import { renderHitlQueue } from './components/hitl-queue.js';
import { startStorageSource } from './state/storage-source.js';
import { startWsSource } from './state/ws-source.js';

const { createStore } = window.__AS_DASH_STORE__;
const { selectActiveWorkflow } = window.__AS_DASH_SELECT__;

const store = createStore();

// L2 content 布局骨架：① overview-bar 满宽 + l2-cols 两列（左 step-list，右 brain-stream + hitl-queue）。
// 这些挂载点只建一次；组件每次重渲只替换各自挂载点内部。
const contentEl = document.getElementById('content');
const overviewMount = document.createElement('div');
const stepMount = document.createElement('div');
const brainMount = document.createElement('div');
const hitlMount = document.createElement('div');

const rCol = document.createElement('div');
rCol.className = 'r-col';
rCol.style.cssText = 'display:flex;flex-direction:column;gap:14px';
rCol.append(brainMount, hitlMount);

const l2cols = document.createElement('div');
l2cols.className = 'l2-cols';
l2cols.append(stepMount, rCol);

contentEl.append(overviewMount, l2cols);

// 大脑流是有状态组件（增量 append），建一次实例
const brainStream = createBrainStream(brainMount);

// 选中态（环节行 / 大脑流条点击高亮）——本地 UI 态，不进 store
let selectedStepId = null;

// 切 activeWorkflowId：本 Plan 单 workflow，点击仅切本地视图（真实写 storage→bg 留后续）
function onSelectWorkflow(id) {
  store.getState().skeleton.batch.activeWorkflowId = id;
  renderAll(store.getState());
}

function onSelectStep(id) {
  selectedStepId = id;
  renderStepList(stepMount, selectActiveWorkflow(store.getState().skeleton.batch), selectedStepId, onSelectStep);
}

// HITL 动作占位：本 Plan 仅 toast 提示，真实 message→background 回路留后续
function onHitlAction(kind, hitl) {
  console.log('[dashboard] HITL action（占位，回路待 Plan）：', kind, hitl?.id);
}

// 全量重渲骨架部分（topbar/queue/overview/step/hitl）；大脑流独立 update（增量）
function renderAll(state) {
  const wf = selectActiveWorkflow(state.skeleton.batch);
  renderTopbar(document.getElementById('topbar'), state);
  renderQueueList(document.getElementById('queue-list'), state, onSelectWorkflow);
  renderOverviewBar(overviewMount, wf);
  renderStepList(stepMount, wf, selectedStepId, onSelectStep);
  renderHitlQueue(hitlMount, wf, onHitlAction);
  brainStream.update(state);
}

// 订阅 store：任一变更触发重渲
store.subscribe(renderAll);

// 首屏渲染（store 初始为空 batch，先渲空态，源接入后再重渲）
renderAll(store.getState());

// 启动数据源：storage-source 接真实 chrome.storage；ws-source 本 Plan mock 回放大脑流
startStorageSource(store);
startWsSource(store);
```

- [ ] **Step 7: build + 手动验证（完整 mock 渲染）**

> **注意**：storage-source 接真实 `chrome.storage.local['as_workflow_state']`，初次为空 → 渲空态（队列空、L2「暂无进行中的流程」）。要看到 mock 骨架渲染，**临时**在 chrome dashboard 页 Console 灌入 mock 骨架（或在本 Task 验证期把 dashboard.js 的 `startStorageSource(store)` 临时改成灌 mock——但更稳的是 Console 灌）。验证步骤：

1. Run: `python3 build/build_extension.py`
2. chrome `chrome://extensions` reload 扩展 → 打开 `chrome-extension://<ID>/dashboard/dashboard.html`。
3. 此刻应渲**空态**（顶栏「无批次」+ WS 灯红「离线」+ 队列三组「暂无」+ L2「暂无进行中的流程」）。**这验证了 storage-source 真实接入 + 空 batch 兜底**。
4. 在该页 F12 Console 执行（灌 mock 骨架进真实 storage，触发 onChanged → 全量重渲）：
   ```js
   const m = await import('./mock/mock-data.js');
   chrome.storage.local.set({ as_workflow_state: m.MOCK_SKELETON });
   ```

Expected（灌入后）：
- 顶栏：brand「AgentSeller 自动化监控」+「批次 #B-2406 · 03/08 14:22」+ WS 灯红「离线」（mock 模式）。
- 队列：进行中(1) 一张「中正科技保温杯 350ml」卡（橙点「待确认」+「环节 3/8」+ mini-bar 3 绿 1 蓝），待处理(0)/已完成(0)「暂无」。
- ① 总览条：商品名 24px + 橙 badge「待确认 · 38%」+ SPU/SKC/SKU + 8 节点 track（前 3 绿勾、第 4 蓝圈带暂停 ptag、5-8 灰）。
- ② 环节列表：1-3 绿勾 + review:pass；**第 4 行橙底 paused、暂停图标、「待确认」橙 tag、selfheal·重试成功 brief、产物 tag**（关键：这是 status==='paused' 显式渲染，不是 run+tag）；5-7 灰 pending；第 8 行 skip 半透「已跳过 · 本批不导出」。
- ③ 大脑流：6 条事件**逐条 append**（每 1.2s 一条，肉眼可见增量），kind 着色（review 蓝 / log 灰 / diagnose 黄 / selfheal 紫），自动滚底；回放完底部「实时接收中…」。
- ④ HITL：橙描边呼吸卡，「申请付款」+「步骤4 · 创建采购单」+ 金额/收货仓库/供应商 kv + 复核结论 + 确认/改/拒绝按钮。
- 交互：环节行 hover 蓝、点击蓝底选中；大脑流条同理；卡片/面板 hover 抬升辉光。
- Console 无报错。

> 验证后**清掉测试数据**（避免污染）：Console 执行 `chrome.storage.local.remove('as_workflow_state')`。

- [ ] **Step 8: commit**

```
git add core/dashboard/components/select-active.js core/dashboard/dashboard.js core/dashboard/dashboard.html tests/dashboard-store.test.js
git commit -m "$(cat <<'EOF'
feat(dashboard): dashboard.js 装配 + 接真实 storage（select-active 单测）

Why: 把 store + 三个源 + 全部组件接起来；storage-source 接真实 chrome.storage.local['as_workflow_state']，ws-source 本 Plan mock 回放大脑流。
What: select-active.js（selectActiveWorkflow，UMD 双模式 + 4 单测）；dashboard.js（建 L2 布局骨架、订阅 store 全量重渲骨架 + 大脑流增量 update、启动真实 storage 源 + mock ws 源、选中态本地管理）；dashboard.html 追加 select-active 经典脚本。
Test: node --test tests/dashboard-store.test.js 全通过；chrome 打开 dashboard 先渲空态（验证真实 storage 接入），Console 灌 mock 后完整渲染 + 大脑流逐条 append。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Hub 入口（openMonitor → 独立窗口打开 dashboard）

**目的：** Hub 加「打开监控」入口，点击在独立窗口打开 dashboard.html（spec §7：`chrome.runtime.getURL`，可拉独立窗口置顶）。content script 不能直接调 `chrome.windows.create`，故走「content → runtime message `OPEN_MONITOR` → service worker `chrome.windows.create`」（与现有 message 模式一致）。在 `AgentSeller` API 加 `openMonitor()`，ui.js Hub 网格上方加按钮。

**Files:**
- Modify: `core/background/service-worker.js`（加 `OPEN_MONITOR` 处理）
- Modify: `core/content/registry.js`（`AgentSeller.openMonitor`）
- Modify: `core/content/ui.js`（Hub 加「打开监控」按钮 + 样式）

- [ ] **Step 1: service-worker.js 加 OPEN_MONITOR 处理**

编辑 `core/background/service-worker.js`。在**第一个** `chrome.runtime.onMessage.addListener`（含 `PROCESS_LABEL` 那个，约 133 行）内部、`GET_STATUS` 分支之后，加 `OPEN_MONITOR` 分支：

```javascript
  if (msg.type === 'OPEN_MONITOR') {
    const url = chrome.runtime.getURL('dashboard/dashboard.html');
    // 已开则聚焦，未开则新建独立窗口（popup 型，可置顶盯盘）。失败兜底退化为 tab。
    (async () => {
      try {
        const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup', 'normal'] });
        for (const w of wins) {
          const hit = (w.tabs || []).find(t => t.url === url);
          if (hit) {
            await chrome.windows.update(w.id, { focused: true });
            sendResponse({ success: true, focused: true });
            return;
          }
        }
        await chrome.windows.create({ url, type: 'popup', width: 1280, height: 860 });
        sendResponse({ success: true, created: true });
      } catch (e) {
        try { await chrome.tabs.create({ url }); sendResponse({ success: true, fallbackTab: true }); }
        catch (e2) { sendResponse({ success: false, error: String(e2?.message || e2) }); }
      }
    })();
    return true;
  }
```

> 说明：先扫已有窗口避免重复开多个 dashboard；`type:'popup'` 是无地址栏的独立窗口（盯盘场景，可单独置顶）；任何失败兜底为普通 tab，保证「打开监控」不会点了没反应。

- [ ] **Step 2: registry.js 加 openMonitor**

编辑 `core/content/registry.js`，在 `window.AgentSeller = { ... }` 对象内（`openHub` 之后）加 `openMonitor`：

```javascript
    // 打开监控 dashboard（独立窗口）。content 不能直接 chrome.windows.create，
    // 发 OPEN_MONITOR 给 service worker 处理（SW 跨窗口存活、有 windows 权限）。
    openMonitor: async () => {
      if (!chrome?.runtime?.id) { window.__AgentSellerUtils.showToast('插件已重载，请刷新页面后重试', 'err'); return; }
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'OPEN_MONITOR' });
        if (!resp?.success) throw new Error(resp?.error || '打开监控失败');
      } catch (e) {
        window.__AgentSellerUtils.showToast('打开监控失败：' + (e?.message || e), 'err');
      }
    },
```

- [ ] **Step 3: ui.js Hub 加「打开监控」按钮样式**

编辑 `core/content/ui.js` 的 `injectStyles()`，在 `/* Hub 视图 */` 段（`#tal-hub-view { padding:12px; }` 之后）加按钮样式：

```css
      /* Hub「打开监控」入口 */
      #tal-open-monitor {
        width:100%; padding:8px 0; margin-bottom:10px;
        border:1px solid #30363d; border-radius:8px; cursor:pointer;
        background:linear-gradient(135deg,#1c2128,#161b22); color:#58a6ff;
        font-size:12px; font-weight:600; display:flex; align-items:center;
        justify-content:center; gap:6px; transition:background .15s,border-color .15s;
      }
      #tal-open-monitor:hover { background:#21262d; border-color:#58a6ff; }
```

- [ ] **Step 4: ui.js buildPanel 注入按钮 + 绑定**

编辑 `core/content/ui.js` 的 `buildPanel()`，把 `#tal-hub-view` 的 innerHTML 改为在网格**上方**加按钮（找到 `<div id="tal-hub-view">` 那段模板）：

```javascript
      <div id="tal-hub-view">
        <div id="tal-open-monitor">📊 打开监控面板</div>
        <div class="tal-feature-grid" id="tal-feature-grid"></div>
      </div>
```

并在 `buildPanel()` 内绑定点击（在 `panel.querySelector('#tal-close')...` 那批绑定附近加）：

```javascript
    panel.querySelector('#tal-open-monitor').addEventListener('click', () => {
      window.AgentSeller.openMonitor();
    });
```

- [ ] **Step 5: build + 手动验证（Hub 入口打开 dashboard）**

1. Run: `python3 build/build_extension.py`
2. chrome reload 扩展 → 打开任一已授权站点（如 `https://seller.temu.com/...`），点右下 FAB 展开 Hub。
3. Hub 网格上方应有蓝色「📊 打开监控面板」按钮，点击。

Expected：
- 弹出独立窗口（1280×860，无地址栏 popup）显示 dashboard（空态，因真实 storage 无数据）。
- 再点一次「打开监控面板」→ 聚焦已有窗口，**不重复开**第二个。
- Console 无报错；FAB/Hub 原有功能不受影响。

- [ ] **Step 6: commit**

```
git add core/background/service-worker.js core/content/registry.js core/content/ui.js
git commit -m "$(cat <<'EOF'
feat(dashboard): Hub 加「打开监控」入口（独立窗口打开 dashboard）

Why: spec §7 要求 Hub 加监控入口，chrome.runtime.getURL 打开 dashboard 可拉独立窗口。content 不能直接 chrome.windows.create，走 message→SW。
What: service-worker.js 加 OPEN_MONITOR（扫已有窗口去重→聚焦/新建 popup→失败兜底 tab）；registry.js AgentSeller.openMonitor（发 OPEN_MONITOR + 错误 toast）；ui.js Hub 网格上方加「打开监控面板」按钮 + 样式 + 绑定。
Test: python3 build/build_extension.py 后 Hub 点按钮弹独立窗口开 dashboard；二次点击聚焦不重复开。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: 文档收尾 + 全量验证

**目的：** 把 dashboard 落地写进项目文档（结构 + Core API），跑全量单测 + 全量 build 做最终验证。

**Files:**
- Modify: `CLAUDE.md`（项目根）

- [ ] **Step 1: CLAUDE.md Architecture 段加 dashboard 结构**

编辑项目根 `CLAUDE.md`，在 Architecture 的目录树 `core/` 块内（`├── popup/...` 与 `└── icons/...` 之间）加 dashboard 子树说明：

```
│   ├── dashboard/                   # 监控 dashboard 扩展页（ES module，独立窗口打开；非 content script 注入）
│   │   ├── dashboard.{html,css,js}  # 壳 + 深色 tokens(:root) + ES module 装配入口
│   │   ├── contract.js              # storage 契约常量(STORAGE_KEY/SCHEMA_VERSION/emptyBatch/normalizeSkeleton，UMD 双模式)
│   │   ├── state/{store,storage-source,ws-source}.js  # store 合并骨架(storage)+血肉(ws)；storage-source 接真实 as_workflow_state；ws-source 当前 mock
│   │   ├── components/*.js           # topbar/queue-list/overview-bar/step-list/brain-stream/hitl-queue/error-chip/dom/select-active
│   │   └── mock/mock-data.js         # 开发态渲染验证用 mock 骨架 + 大脑流 + HITL 详情
```

- [ ] **Step 2: CLAUDE.md Core API 段加 openMonitor + storage 契约提示**

编辑 `CLAUDE.md` 的 Core API（`window.AgentSeller`）代码块，在 `openHub(),` 后加一行：

```js
  openMonitor(),                          // 独立窗口打开监控 dashboard（发 OPEN_MONITOR 给 SW）
```

并在该段末尾补一段说明（紧跟 `openHub` 那行注释之后的段落）：

```markdown
**监控 dashboard（自动化监控系统 Plan 1）**：`core/dashboard/` 是独立扩展页（`chrome-extension://<id>/dashboard/dashboard.html`），ES module 加载，深色盯盘 UI（视觉真源 `ui-prototype/dashboard.html`）。数据层 `store.js` 合并两路：`storage-source` 订阅真实 `chrome.storage.local['as_workflow_state']`（spec §4.1 权威骨架，background 唯一写入）+ `ws-source`（当前 mock 回放大脑流，真实 WS client 留 Plan 3）。组件只认 store、骨架全量重渲、大脑流增量 append。`manifest.template.json` 的 `content_security_policy.extension_pages` 放行 `connect-src ws://localhost:*` 供 Plan 3 用。契约/优先级见 `docs/superpowers/specs/2026-06-08-automation-monitor-and-data-contract-design.md`。
```

- [ ] **Step 3: 全量单测**

Run: `node --test tests/`
Expected: PASS —— `tests/version-cmp.test.js` + `tests/dashboard-store.test.js` 全部用例 0 失败（dashboard-store 覆盖 store 合并/schemaVersion 三类兜底/append 保序限流/订阅隔离/selectActiveWorkflow 命中退化空缺失）。

- [ ] **Step 4: 全量 build 冒烟**

Run: `python3 build/build_extension.py && python3 -c "import json,sys; m=json.load(open('dist/extension/manifest.json')); assert m.get('content_security_policy',{}).get('extension_pages'), 'CSP missing'; import os; assert os.path.exists('dist/extension/dashboard/dashboard.html'), 'dashboard.html missing'; assert os.path.exists('dist/extension/dashboard/components/step-list.js'), 'step-list missing'; print('[smoke] OK: CSP + dashboard 文件齐')"`

Expected: build 成功 + 打印 `[smoke] OK: CSP + dashboard 文件齐`（manifest 含 CSP、dashboard.html 与组件已拷贝）。

- [ ] **Step 5: 既有 build 测试不回归**

Run: `python3 -m pytest tests/test_build.py -q` （若项目用 pytest）或 `python3 tests/test_build.py`
Expected: 既有 build 单测全过（确认 dashboard 拷贝逻辑未破坏原 core/feature 构建）。**若 test_build.py 不识别 dashboard，属正常**（它测 core/feature 路径，dashboard 是新增独立子树）——只要不报错即可。

- [ ] **Step 6: commit**

```
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(dashboard): CLAUDE.md 记录 dashboard 结构 + openMonitor API + storage 契约

Why: dashboard 落地后需在项目文档登记结构与 Core API，便于后续 worktree/agent onboard。
What: Architecture 目录树加 core/dashboard/ 子树；Core API 加 openMonitor + 监控 dashboard 段（数据层两路源/CSP/契约 spec 指引）。
Test: node --test tests/ 全过；python3 build/build_extension.py 冒烟（CSP + dashboard 文件齐）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 验证总览（Definition of Done）

本 Plan 完成的判据：

- [ ] `node --test tests/` 全过（store 合并 / schemaVersion 三类兜底 / 大脑流 append 保序+限流 / 订阅隔离 / selectActiveWorkflow）。
- [ ] `python3 build/build_extension.py` 成功，dist manifest 含 `content_security_policy.extension_pages`，`dist/extension/dashboard/` 含完整多文件结构。
- [ ] chrome 打开 `dashboard/dashboard.html`：空 storage 时渲空态（验证真实 storage 接入 + 空 batch 兜底）；Console 灌 mock 骨架后完整渲染 ①②③④，**第 4 步 status==='paused' 显式渲 HITL 橙标记**，大脑流逐条 append。
- [ ] Hub「打开监控面板」按钮弹独立窗口开 dashboard，二次点击聚焦不重复开。
- [ ] 视觉与 `ui-prototype/dashboard.html` 一致（深色 tokens / 状态色 / sprite 图标 / 交互 hover+选中）。

---

## 已知设计点与待 Plan 3 衔接（实现者须知）

> 这些**不在本 Plan 范围**，但实现时按此预留，避免 Plan 3 返工。

1. **storage 写入方向**：本 Plan dashboard **只读** `as_workflow_state`（storage-source 订阅）。storage-source 首读缺失时写回空 batch 是**唯一例外**（初始化兜底）。spec §2.3 铁律「storage 唯一写入者 = background」——HITL 确认/改/拒绝的真实写入（`hitl.status` + 转大脑）走 message→background，**本 Plan 的 hitl-queue 按钮只占位 console.log**，Plan 3 接 background 回路。不要在本 Plan 让组件直接写 storage。

2. **ws-source 是 mock，签名即契约**：`startWsSource(store)` 当前定时回放 mock-data。Plan 3 换成真实 WS client（连大脑 localhost / `HELLO` 握手 / `PING-PONG` 心跳 / 断线 `setWsStatus('reconnecting'/'offline')` 降级 / 收 `BRAIN_EVENT`→`appendBrainEvent` / 收 `HITL_DETAIL`→`setHitlDetail`），**保持 `startWsSource(store)` 签名 + 喂 store 的方法不变**，组件零改动。

3. **CSP 已就位但本 Plan 不发 WS**：`connect-src ws://localhost:*` 是给 Plan 3 的。本 Plan 任何代码都不连 WS，WS 灯恒「离线」。

4. **大脑流限流双层**：store 侧 `maxBrainEvents`（默认 500，丢最旧）+ brain-stream 组件侧裁剪后重建。spec §9.2 提到 storage 写频限流——本 Plan 大脑流走 ws-source 不写 storage，**不触发 storage 限流**；Plan 3 若把大脑流摘要也落 storage（`step.brainBrief`）需另做节流。

5. **schemaVersion 兜底在 store 集中**：`normalizeSkeleton` 在 contract.js、被 `store.setSkeleton` 调用。storage-source 不重复校验。Plan 3 若加 schema 迁移（v1→v2），改 contract.js 一处。

6. **选中态是本地 UI 态**：`selectedStepId` 在 dashboard.js 局部变量，不进 store、不持久化。刷新即重置——符合盯盘场景（spec 无要求持久化选中）。

7. **本 Plan 未做的 spec 板块**（明确留后续，避免误判遗漏）：浮层（mini-progress / hitl-popup，spec §3.1/§7，Plan 4）、真实 WS（Plan 3）、background WS client + RUN_STEP 调度（Plan 3）、SW 回收 + step 恢复语义（spec §4.3，Plan 3 must-resolve）、HITL「改」编辑态表单（spec §6.1，随 Plan 3 message 回路一起）。


