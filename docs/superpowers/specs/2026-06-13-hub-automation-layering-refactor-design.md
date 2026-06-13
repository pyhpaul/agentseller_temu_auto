# Hub / Automation 分层重构设计

- **状态**：设计已逐点确认，待用户 review 后转实施计划
- **日期**：2026-06-13
- **分支**：`feature/hub-automation-layering`
- **类型**：L3 架构重构（结构搬迁 + 同源技术债清理）
- **硬约束**：不影响现有 8 个 feature 的功能；不破坏 feature 目录自治设计

## 决策摘要（6 项，均经用户确认）

| # | 决策点 | 选择 |
|---|--------|------|
| 1 | 分离模型 | 分层·单向依赖（单仓单 extension，core 纯净 / automation 单向依赖 / features 不动） |
| 2 | 重构范围 | 结构搬迁 + 清理同源技术债（执行时分阶段，搬迁与清理 commit 分离） |
| 3 | 接入机制 | `registerExtension` 单一声明式清单（core 对扩展开放的唯一契约点） |
| 4 | feature bg 段归属 | 搬进 `features/<id>/background/`（feature.json 新增可选 `background` 字段，向后兼容） |
| 5 | CPO 状态存储 | CPO 保留独立 `cpo_state` namespace，不反向依赖 automation contract |
| 6 | 执行顺序 | 搬迁 → 验证行为不变 → 清理 → 用户跑 Chrome e2e（与欠的 automation e2e 合流） |

---

## 1. 背景与问题

项目当前并存两套体系，处于"双向开发"状态、互相耦合：

- **插件 Hub**：8 个 feature（auto_gen_label / price_declare / check_and_publish / packing_label / create_purchase_order / auto_ship / sale_manage_export / image_search_1688），每个自治（`feature.json` + `content/index.js` + `CLAUDE.md`），经 `window.AgentSeller` API 轻耦合到 core，共享单一 native host。**需继续迭代**。
- **自动化系统**：Hub 的"编排升级层"，复用 8 个 feature 当执行单元（hybrid 架构：bg 确定性编排器 + 外部 Python LLM 大脑/WebSocket + 分级 HITL + 监控 dashboard）。Plan 1/2/3 已全合 main，**仅差 Chrome e2e 验证**。**需升级优化**。

二者并非对等的"两个版本"，而是**上下两层**：automation 依赖 hub/feature 的执行能力。因此"完全物理剥离"会断掉复用、制造重复工作——本设计的目标不是剥离，而是**降耦合 + 目录清晰 + 职责单一**。

**目标**：core 纯净（不反向感知 automation）、automation 单向依赖、feature 目录设计不被破坏；满足单一职责、开闭原则、可维护性、可扩展性。

## 2. 现状耦合诊断

真正的耦合**不在 `features/`（那层很干净，零 feature 间依赖），全部集中在 `core/`**：

| 耦合点 | 位置 | 问题 |
|--------|------|------|
| service-worker.js 一文混 7 职责 | `core/background/service-worker.js`（1066 行） | auto-reload(1–32) + image_search 编排(34–103) + native 透传(105–322) + CPO Phase1/2(324–635) + orchestrator(637–1065) + WS。改一处易动十处。 |
| automation 代码寄生 core | `core/{dashboard/,contract.js,content/overlay*.js,background/orchestrator/,background/ws-client.js}` | hub 公共骨架的家里塞满 automation 专属代码。 |
| 隔离靠发版补丁 | `build/package_all.py` 3 个 strip 函数 + `core/content/ui.js` isDev 守卫 + `registry.js` openMonitor | windows 权限 / CSP / 监控按钮 / OPEN_MONITOR 都是 automation 专属却塞进公共层，发版逐个删。脆弱、易漏。 |
| overlay 硬编码契约常量 | `core/content/overlay.js` | 自定义 `STORAGE_KEY` 而非 import `contract.js`，重复定义。 |
| CPO 双编排并存 | `cpoRun/cpoRun2` 写 `cpo_state` ↔ orchestrator adapter 又调 `cpoRun` | 两套触发逻辑、两套错误结构（`{status,label}` vs `StepError{category,code,...}`）。 |

## 3. 目标架构：三层单向依赖

```
brain/  (Python 大脑, 独立进程)  ◄──WS──►  automation/
                                              │
core/ ◄──────── features/ ◄─────────────────┘
  ▲                 │  (依赖 core API)        (单向依赖 core API + 读 feature 状态)
  └─────────────────┘
```

依赖方向（箭头 = "依赖于"，**禁止反向**）：

- `core/` → 不依赖任何上层。**零 automation 引用、零 feature 硬编码**。
- `features/<id>/` → 依赖 `core`（经 `window.AgentSeller`）。feature 间零依赖。
- `automation/` → 依赖 `core`（经 `registerExtension` + 公开 API）+ 单向读 feature 的可编程入口/状态。**feature 不反向依赖 automation**。
- `brain/`（Python）↔ `automation/`（WS），独立进程，不动。
- `native_host/`（Python）共享，不动。

目标目录树：

```
core/                       hub 公共骨架（纯净）
├ background/
│  └ service-worker.js      native 透传路由 + auto-reload + 扩展点注册/路由
├ content/
│  ├ registry.js            window.AgentSeller（+ registerExtension，− openMonitor）
│  ├ ui.js                  Panel 渲染 extension 声明的 panelButtons（− isDev 硬编码）
│  ├ utils.js / core.js     不动
├ popup/ icons/
└ manifest.template.json    仅 hub 必需权限（nativeMessaging + storage）

features/                   8 feature
├ auto_gen_label/ ...       6 个纯 content feature：完全不动
├ create_purchase_order/
│  ├ feature.json           + "background": "background/handler.js"
│  ├ content/index.js
│  └ background/handler.js  ← cpoRun/cpoRun2 搬入（单一可编程入口）
└ image_search_1688/
   ├ feature.json           + "background": "background/handler.js"
   └ background/handler.js  ← image_search bg 段搬入

automation/                 ← 新顶层，单向依赖 core/features
├ register.js               唯一接入点：registerExtension({...})
├ manifest.fragment.json    windows 权限 + CSP + dashboard 扩展页声明
├ orchestrator/             engine / steps / state-machine / recovery / mutation-queue
├ brain-bridge/ws-client.js
├ dashboard/                (从 core/dashboard 整体搬来)
├ overlay/                  (从 core/content/overlay*.js 搬来)
└ contract.js               (从 core/contract.js 搬来)

brain/   native_host/       不动
```

## 4. 核心机制

### 4.1 registerExtension 接入契约

core 在 `registry.js` 新增 `registerExtension`，作为 hub 对"重系统扩展"开放的**唯一契约点**（与 `registerFeature` 平行）：

```js
// automation/register.js（automation 的唯一接入入口）
window.AgentSeller.registerExtension({
  id: 'automation',
  panelButtons: [{ id: 'open-monitor', icon: '📊', label: '打开监控', onClick }],
  bgHandlers:   { 'WF_': orchHandler, 'OPEN_MONITOR': openMonitorHandler }, // 前缀路由
  overlays:     [{ match: isTemuSellerPage, mount, unmount }],              // HITL 浮层
});
```

core 侧职责（**只认契约，不认 automation**）：

- `registry.js`：维护 `extensions` 注册表；暴露给 `ui.js` / service-worker 读取。
- `ui.js`：遍历所有 extension 的 `panelButtons` 渲染进 Panel（取代当前硬编码的 `__monitorBtn`）。
- `service-worker.js`：收集所有 extension 的 `bgHandlers`，按 type 前缀路由（取代当前硬编码的 `OPEN_MONITOR` / `WF_*` 分支）。
- content 侧 `overlays`：由 core 在页面变化时调 `match` 决定 mount/unmount（取代当前 overlay 自挂载逻辑里散落的 isDev 判断）。

### 4.2 目录级装配隔离（取代全部 strip/isDev 补丁）

分层 + 单向依赖最大的红利：**release 不构建 `automation/` → 一切接入自动消失**，无需任何运行时守卫或发版剥离。

| 现状（散落补丁） | 重构后 |
|---|---|
| `package_all.py` 3 个 strip 函数 | **全删**。build 不扫 `automation/` → 产物天然不含 |
| `ui.js` isDev 守卫 + 硬编码监控按钮 | **全删**。release 无人调 `registerExtension` → 无按钮 |
| `registry.js` 的 `openMonitor` | **全删**。降为 automation `bgHandlers` 的一条 |
| `overlay*.js` 散落 isDev 判断 | **全删**。overlay 整体在 automation/，dev-only 由目录决定 |

> **"release manifest 与 main 零差异"从"3 个 strip 函数维护"变为"build 不扫 automation/ 目录"——由结构保证，不再是补丁。**

> 注：`build-info.js` 的 `isDev`（用于 panel 标题栏 `dev:<ts>` vs `v<version>` 版本号显示）与 automation **无关，保留不动**。本次删除的仅是 automation 监控按钮 / 浮层的 isDev 守卫——它们改由"`automation/` 目录是否被装配"决定。

dev 构建：`build_extension.py` 检测到 `automation/` 存在 → 装配其 content 入口（`register.js` + overlay）进 content_scripts、bg 入口进 service-worker、合并 `manifest.fragment.json`、拷 dashboard 扩展页。
release 构建：`package_all.py` 跳过 `automation/`（或 build 加 `--no-automation` 开关）→ 产物即纯 hub。

### 4.3 manifest 拆分

| 权限/配置 | 归属 | 理由 |
|---|---|---|
| `nativeMessaging` | hub 核心 manifest.template.json | feature 普遍依赖 |
| `storage` | hub 核心 | CPO（hub feature）写 `cpo_state` 需要；非 automation 专属 |
| `windows` | `automation/manifest.fragment.json` | 仅 OPEN_MONITOR → `chrome.windows.create` 用 |
| CSP `connect-src ws://localhost:*` | `automation/manifest.fragment.json` | 仅 dashboard ws-source 用 |
| dashboard 扩展页（web_accessible / 入口） | `automation/manifest.fragment.json` | automation 专属 |

build 合并逻辑：基础 = hub template；若装配 automation/ 则深合并 fragment（权限并集去重、CSP 覆盖）。与现有"feature permissions 聚合"同机制，复用 `render_manifest`。

## 5. service-worker.js 1066 行 → 去向

| 现状段 | 行号 | 去向 | 机制 |
|---|---|---|---|
| auto-reload | 1–32 | **留 core** | 通用，独立 |
| native 透传路由 | 105–322 | **留 core** | hub 核心，不动 |
| 扩展点注册/路由 | （新增） | **留 core** | 收集 extension.bgHandlers + feature bg handler，按前缀路由 |
| image_search 编排 | 34–103 | → `features/image_search_1688/background/handler.js` | feature bg 段 |
| CPO Phase1/2 | 324–635 | → `features/create_purchase_order/background/handler.js` | feature bg 段 + 合一（§7.1） |
| orchestrator | 637–1065 | → `automation/orchestrator/` + `automation/register.js` | extension.bgHandlers 注册 WF_* |
| ws-client | importScripts | → `automation/brain-bridge/ws-client.js` | automation 内部 |

拆后 core service-worker.js 只剩 3 类职责，且**路由表数据化**（不再硬编码 `if (msg.type === 'OPEN_MONITOR')` 这类 automation/feature 专属分支）：

```js
// core/background/service-worker.js（拆后骨架）
import/registerHandlers from auto-reload          // 通用
nativePassthroughRouter(PROCESS_LABEL/READ_FILE…) // hub 核心透传
const bgRegistry = new Map()                       // 扩展点注册表
self.AgentSellerBg = { registerHandler(prefix, fn) {…} }  // feature/extension 调用
chrome.runtime.onMessage → 按 prefix 查 bgRegistry 分发  // 数据化路由
```

- feature bg handler（CPO/image_search）经 `self.AgentSellerBg.registerHandler('CPO_', fn)` 注册。
- automation 的 `bgHandlers`（`WF_` / `OPEN_MONITOR`）经 `registerExtension` → core 转注册进同一 `bgRegistry`。
- **automation 调 feature 经命令名、不 import feature 内部**：core 暴露 `invokeFeatureCommand(cmd, data)`，automation adapter 用它调 CPO（单向 automation → core → feature）。

## 6. feature 契约的向后兼容扩展

feature.json 新增**可选**字段 `background`（相对 feature 目录的 bg 脚本路径）：

```json
{ "id": "create_purchase_order", ..., "background": "background/handler.js" }
```

- build（`build_extension.py`）：扫到 `background` 字段则把该脚本 importScripts 进 service-worker（或拷入 dist 并登记）。
- **向后兼容**：6 个无此字段的 feature **零改动**；只是新增一个可选约定——是扩展，不是破坏。
- feature bg 脚本约定：顶部 `self.AgentSellerBg.registerHandler(prefix, fn)` 挂命令处理器；纯命令响应、不自驱（与现状 content 命令处理器模式一致）。
- 文档同步：根 `CLAUDE.md` feature 注册契约表补 `background` 字段说明 + 各 feature 自己的 `CLAUDE.md`。

## 7. 技术债清理（范围 B，阶段 2 执行）

### 7.1 CPO 双编排合一（按决策 5：cpo_state 保留）

**现状**：`cpoRun` 写 `cpo_state`（独立 message handler 触发）+ orchestrator adapter 又调 `cpoRun` 写 `as_workflow_state`，两套触发 + 两套错误。

**合一后**（CPO 完全不知道 `as_workflow_state`）：

```
Panel 手动按钮 ┐
               ├─→ CPO 单一 bg handler（features/create_purchase_order/background/）
orch adapter   ┘     └ 内部仅写 cpo_state（自治），返回结构化结果
                          ▲
                          │ orch adapter（automation/）经 invokeFeatureCommand 调
                          └─→ 读 cpo_state 的 result → 映射进 as_workflow_state.step.result
```

- **消除的"双"**：不再有"独立 handler 逻辑"与"adapter 内重复调用逻辑"两套；收敛为 feature 侧单一入口，两个调用方共用。
- **storage 仍两 key**（决策 5）：`cpo_state`（CPO 自治）+ `as_workflow_state`（automation 编排）。职责清晰，CPO 对 automation 零反向依赖。
- 映射（读 cpo_state → 填 step.result）是 **automation adapter 的单向职责**，在 `automation/orchestrator/` 内。

### 7.2 overlay STORAGE_KEY

overlay 随 contract 同搬入 `automation/`，直接 `import { STORAGE_KEY } from '../contract.js'`，删除硬编码常量。

### 7.3 错误结构统一

CPO bg handler 返回 `StepError{category, code, message, recoverable}`（对齐 orchestrator/contract 的错误契约），取代 `{status, label}`。错误分层（read/validate/business）遵循项目 debugging 铁律。

## 8. 执行顺序与验证策略（决策 6）

### 阶段 1 — 纯结构搬迁（零行为变更，safe-refactor）

动作：搬 `automation/` 到新顶层；拆 service-worker（feature bg 段 → `features/<id>/background/`，orchestrator → `automation/`）；新增 `registerExtension`（core）+ `automation/register.js`，**行为等价**地接管监控按钮 / WF 路由 / OPEN_MONITOR / overlay；build 适配（扫 automation/ + feature `background` 字段 + manifest fragment 合并）；删 3 strip 函数 + isDev 守卫。

**禁止**：任何逻辑改动。每个搬动的函数体一字不改，只换位置 + 改"如何被注册/调用"。

验证（锚定行为不变）：
- `node --test tests/*.test.js`（21 用例）+ `python3 -m pytest tests/`（19 用例）全过。
- **release build 产物对比**：重构后 `package_all.py` 产物的 `manifest.json` 与重构前一致；dev build 的 content_scripts / importScripts 装配顺序逐一对齐。
- 6 个纯 content feature dev 冒烟（build + Chrome reload + 手点）。
- automation dev 冒烟：监控按钮开 dashboard、HITL 浮层起、WF_START 触发编排——行为不变。

→ 全绿后 commit（阶段 1 独立 commit），锚定"搬迁未改行为"。

### 阶段 2 — 行为清理（同源技术债）

动作：CPO 双编排合一（§7.1）；overlay STORAGE_KEY import（§7.2）；错误结构统一（§7.3）。

验证：
- 单测全过 + CPO/automation 相关用例补充。
- **automation Chrome e2e**：按 `docs/superpowers/2026-06-13-l3-chrome-e2e-checklist.md`，起 `python3 -m brain` + 真实商品 + 授权跑通。
- ⚠️ **e2e 由用户执行**（agent 跑不了：需真实商品、起大脑、人工授权）。阶段 2 代码备好后交付用户跑。这次重构与"欠的 automation e2e"合流——e2e 既验证 automation 又验证重构。

→ 全绿后 commit（阶段 2 独立 commit）。

### 阶段 3 — 文档同步 + 交付

根 `CLAUDE.md`（架构图、feature 契约表加 `background` 字段、service-worker 职责段、发版隔离段）+ 受影响 feature 的 `CLAUDE.md` + 本 spec 状态更新。一个 PR 交付（阶段 1/2/3 commit 分离，便于 review 与回滚定位）。

## 9. 风险与边界

| 风险 | 缓解 |
|---|---|
| automation 未过 e2e，阶段 2 叠加行为变更 | 阶段分离：阶段 1 零行为变更先锚定；行为变更集中阶段 2，单独 e2e |
| 跨 tab 编排（CPO/image_search）消息协议/状态机敏感，拆错断 feature | 阶段 1 只搬位置 + 改注册方式，逻辑零改；产物 diff + 冒烟双验证 |
| build 装配顺序（content_scripts / importScripts）变动致错 | 装配顺序与现状逐一对齐；release manifest 与 main 零差异作为回归基线 |
| core 路由从硬编码改数据化（ui.js/service-worker） | 属行为等价改写，纳入阶段 1 冒烟；保留旧分支行为对照 |
| e2e agent 跑不了 | 明确由用户执行，spec/PR 注明前置（起大脑 + 真实商品 + 授权） |

**行为保持铁律**：阶段 1 任何可观察行为变化都算缺陷（safe-refactor）。阶段 2 的行为变更必须是 §7 清单内、有意为之、经 e2e 验证。

## 10. 范围边界与决策记录

**不在本次范围**（避免 scope 蔓延）：orchestrator 后续刀（可偏离机制 / HITL 回填模型决策 / 不可逆复核 / 完整降级 / playbook 外置数据化 / 生产部署）；多 workflow 并行；`brain/` 内部重构；`native_host/` 改动。

**被否决方案**：

| 方案 | 否决理由 |
|---|---|
| 分离模型 B：automation 收敛为一个 feature | 体量远超普通 feature，撑爆 feature.json 自治设计 |
| 分离模型 C：双构建产物 | 接近"完全剥离"，工作量最大，且不符"不重做很多工作"诉求 |
| 接入机制 X：细粒度 hook 总线 | 单一消费者建通用事件总线 = 过度设计（YAGNI） |
| 接入机制 Z：最小扩展点 + 约定装配 | core 改动虽小但接入点分散，不够集中内聚 |
| CPO 统一到 as_workflow_state | 会让 hub feature（CPO）反向依赖 automation contract，违背单向依赖 |



