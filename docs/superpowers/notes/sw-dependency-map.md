# service-worker.js 跨段引用 + helper 归属分析

> 前置依赖分析笔记。目标文件：`core/background/service-worker.js`（1066 行）。
> 用途：1066 行大杂烩拆三处（core / `features/<id>/background/` / `automation/`）前定符号归属，
> **核心风险**：automation(orchestrator) 反向依赖 feature(CPO) 的内部函数，搬开后违反单向依赖。
> 只读分析，未改任何源码。生成于 2026-06-13。

---

## 0. 关键发现（先看这个）

1. **唯一的硬代码跨段反向依赖（automation → CPO）**：`orchNavigateAndWait`（orchestrator 段，L706-719）
   在 **L708** 调用 `cpoWaitTabComplete`（CPO 段，L340）。这是拆分后会断的真引用。
   → `cpoWaitTabComplete` 是与具体 feature 无关的通用 tab 工具，被 CPO(7 处) + orchestrator(1 处) 两段共用，
   **必须提升到 core**（`core/background/tab-utils.js`，挂 `self.AgentSellerBg.util.waitTabComplete`）。

2. **adapter 调 `cpoRun` / `cpoRun2`（L773 / L785）也是 automation→feature 耦合**，但这是「调 feature 的公开入口」，
   不是「偷用 feature 内部 helper」。CPO adapter（`orchAdapterCreateSku` / `orchAdapterCreatePo`）本质是
   **automation 侧的 CPO 桥接器**，归属 automation 没问题；但它必须有办法触发 CPO 的编排（见 §4 决策）。

3. **onMessage 不是一个巨型 listener，是 4 个独立注册**：L133 / L452 / L629 / L1031。
   - L133 → core（native 透传 + OPEN_MONITOR + IMG_SEARCH_*，混了三类归属，**需按分支拆**）
   - L452（CPO_START）→ create_purchase_order
   - L629（CPO_START_PHASE2）→ create_purchase_order
   - L1031（WF_*）→ automation
   这比 brief 说的「单一巨型 if-else」结构更干净：CPO / orchestrator 各自带 listener，搬走时整块带走即可。
   **只有 L133 这个 listener 混了归属**，需按分支拆（见 §6）。

4. **`nativePort` 状态被 onMessage(L133) 的 GET_STATUS 分支引用（L223）**：native 连接层(L105-131) 与
   core onMessage 透传块同属 core，不构成跨边界问题，但拆 core 内部时这两块要一起留。

---

## 1. 段边界表（确切起止行号）

| # | 段 | 起 | 止 | 边界标记 | 归属去向 |
|---|----|----|----|---------|---------|
| 1 | auto-reload-on-installer-update | 1 | 32 | `// ── auto-reload …` / `// ── end …` | **core** |
| 2 | image_search_1688 helpers/常量 | 34 | 103 | `// ── image_search_1688 …` / `// ── end …` | **image_search**（搬 `features/image_search_1688/background/`） |
| 3 | native host 连接层 | 105 | 131 | 无标记（L104 空行 / L132 空行夹着） | **core** |
| 4 | onMessage listener #1（透传+monitor+img） | 133 | 322 | 无标记（紧跟 native 段后） | **混合**：core 透传 + OPEN_MONITOR→automation + IMG_SEARCH_*→image_search（见 §6） |
| 5 | create_purchase_order（P1+P2，含各自 listener） | 324 | 635 | `// ── create_purchase_order …` / `// ── end …` | **cpo**（搬 `features/create_purchase_order/background/`） |
| 6 | orchestrator | 637 | 1065 | `// ── orchestrator …` / `// ── end …` | **automation**（搬 `automation/`） |

注：第 4 段 onMessage 无注释边界，物理上夹在 native(131) 与 CPO(324) 之间；其内部分支归属各异，是拆分时唯一需要「拆开一个 listener」的地方。其余段（CPO/orchestrator）各自带独立 listener，可整块搬。

---

## 2. 符号归属表（每个顶层 const/let/function/importScripts）

### 段 1 · auto-reload（1-32）→ core

| 符号 | 行 | 类型 | 归属 |
|------|----|----|------|
| `importScripts('version-cmp.js')` | 6 | importScripts | core |
| `checkInstalledVersion` | 8 | async function | core |
| `checkInstalledVersion()` 顶层调用 + onStartup/onInstalled 注册 | 29-31 | 副作用 | core |

### 段 2 · image_search helpers（34-103）→ image_search

| 符号 | 行 | 类型 | 归属 |
|------|----|----|------|
| `IMG_SEARCH_URL` | 35 | const | image_search |
| `IMG_PAYLOAD_KEY` | 36 | const | image_search |
| `IMG_MAX_BYTES` | 37 | const | image_search |
| `isImgSearchCapturing` | 39 | let（可变状态） | image_search |
| `imgSearchSourceTabId` | 40 | let（可变状态） | image_search |
| `enableSessionStorageAccess` | 42 | function + onInstalled/onStartup/顶层调用(47-49) | image_search（注：当前服务 img payload 经 storage.session 传 1688 tab；属 image_search 资产） |
| `imgCropImage` | 51 | async function | image_search |
| `imgSetPayload` | 73 | async function | image_search |
| `imgEstimateBytes` | 79 | function | image_search |
| `imgNotify` | 84 | async function | image_search |
| `chrome.tabs.onRemoved`/`onUpdated` 监听（重置 capturing 标志） | 97-102 | 副作用 | image_search |

### 段 3 · native 连接层（105-131）→ core

| 符号 | 行 | 类型 | 归属 |
|------|----|----|------|
| `NATIVE_HOST` | 105 | const | core |
| `nativePort` | 107 | let（可变状态） | core |
| `connectNativeHost` | 109 | function | core |
| `sendToNativeHost` | 114 | function | **core**（被 onMessage 透传块 8 处调用；feature 经 message 透传，**不**直接调；留 core 正确） |

### 段 4 · onMessage listener #1（133-322）→ 见 §6 分支归属

| 符号 | 行 | 类型 | 归属 |
|------|----|----|------|
| `chrome.runtime.onMessage.addListener(...)` #1 | 133 | 副作用（事件注册） | 拆分：core 透传分支留 core；OPEN_MONITOR→automation；IMG_SEARCH_*→image_search |

### 段 5 · create_purchase_order（324-635）→ cpo

| 符号 | 行 | 类型 | 归属 |
|------|----|----|------|
| `CPO_DXM_ADD_URL` | 325 | const | cpo |
| `CPO_DXM_INDEX_URL` | 326 | const | cpo |
| `CPO_CMD_TIMEOUT` | 327 | const | cpo |
| `CPO_READY_RETRIES` | 328 | const | cpo |
| `cpoSetPhase1` | 331 | function | cpo |
| `cpoWaitTabComplete` | 340 | function | **⚠ 提升 core**（见 §3/§4，CPO+orchestrator 共用） |
| `cpoSendCommand` | 354 | async function | cpo（注：与 orchestrator 的 `orchSendStepCommand` 是近重复，但协议不同——见 §3.B） |
| `cpoCloseTab` | 377 | async function | cpo（仅 CPO 段用；orchestrator L704 仅注释提及，非调用） |
| `cpoRun` | 392 | async function（P1 主编排） | cpo（被 orchestrator adapter L773 调，见 §3/§4 决策） |
| `chrome.runtime.onMessage.addListener(...)` #2（CPO_START） | 452 | 副作用 | cpo |
| `CPO_DXM_PO_ADD_URL` | 460 | const | cpo |
| `CPO_DXM_WAIT_URL` | 461 | const | cpo |
| `cpoSetPhase2` | 464 | function | cpo |
| `cpoWaitEditTab` | 473 | function | cpo |
| `cpoConfirmSave` | 493 | function | cpo |
| `cpoCreateTabNextTo` | 513 | async function | cpo |
| `cpoFocusOrigin` | 526 | function | cpo |
| `cpoRun2` | 532 | async function（P2 主编排） | cpo（被 orchestrator adapter L785 调，见 §3/§4 决策） |
| `chrome.runtime.onMessage.addListener(...)` #3（CPO_START_PHASE2） | 629 | 副作用 | cpo |

### 段 6 · orchestrator（637-1065）→ automation

| 符号 | 行 | 类型 | 归属 |
|------|----|----|------|
| `importScripts('../contract.js', 'orchestrator/steps.js', …state-machine/recovery/mutation-queue/engine)` | 641 | importScripts | automation |
| `importScripts('ws-client.js')` | 651 | importScripts | automation |
| `orchWsClient` | 657 | let（可变状态） | automation |
| `orchEnsureWs` | 658 | function | automation |
| `ORCH`（contract/steps/mq/engine 聚合对象） | 673 | const | automation |
| `orchRead` | 681 | function | automation |
| `orchWrite` | 685 | function | automation |
| `orchQueue` | 689 | const | automation |
| `orchStubStepRunner` | 693 | async function | automation |
| `orchNavigateAndWait` | 706 | async function | **automation**（但内部 L708 调 `cpoWaitTabComplete`——见 §3/§4） |
| `orchSendStepCommand` | 723 | async function | automation |
| `orchPollState` | 743 | async function | automation |
| `orchMarkCommitting` | 760 | function | automation |
| `orchAdapterCreateSku` | 770 | async function | automation（CPO 桥接器，调 `cpoRun`） |
| `orchAdapterCreatePo` | 781 | async function | automation（CPO 桥接器，调 `cpoRun2`） |
| `orchAdapterPackLabel` | 794 | async function | automation |
| `orchAdapterShip` | 826 | async function | automation |
| `orchAdapterGenLabel` | 850 | async function | automation |
| `orchAdapterPublish` | 898 | async function | automation |
| `ORCH_ADAPTERS`（注册表） | 930 | const | automation |
| `orchRealStepRunner` | 941 | async function | automation |
| `orchEngine` | 946 | const | automation |
| `orchRecoverAll` + 顶层调用(972) | 963 | async function + 副作用 | automation |
| `orchWfSeq` | 975 | let | automation |
| `orchGenId` | 976 | function | automation |
| `orchStartWorkflow` | 978 | async function | automation |
| `orchHitlConfirm` | 991 | async function | automation |
| `orchSetAborted` | 1005 | async function | automation |
| `orchRetry` | 1019 | async function | automation |
| `chrome.runtime.onMessage.addListener(...)` #4（WF_*） | 1031 | 副作用 | automation |

---

## 3. 跨段引用清单（最关键 · 逐条）

### A. orchestrator(automation) → CPO（**反向依赖，必须处理**）

| # | A 段符号（行） | 引用 B 段符号（定义行） | 性质 |
|---|----------------|------------------------|------|
| A1 | `orchNavigateAndWait` L706 内 **L708** | `cpoWaitTabComplete` L340（CPO 段） | **硬代码调用** —— 拆分后会断。`cpoWaitTabComplete` 是通用 tab 工具，应提升 core。 |
| A2 | `orchAdapterCreateSku` L770 内 **L773** | `cpoRun` L392（CPO 段，P1 主编排） | 硬代码调用 —— adapter 触发 CPO 编排。属「调 feature 公开入口」，但仍是 automation→feature 耦合。 |
| A3 | `orchAdapterCreatePo` L781 内 **L785** | `cpoRun2` L532（CPO 段，P2 主编排） | 硬代码调用 —— 同 A2。 |
| A4 | `orchAdapterCreateSku` L774 / `orchAdapterCreatePo` L786 | `cpo_state`（storage key，CPO 私有） | **数据耦合**：adapter 读 `chrome.storage.local['cpo_state'].phaseN` 桥接回 engine。storage key 是运行时字符串，拆分后不「断」，但 automation 依赖了 CPO 的私有 storage 契约。 |
| A5 | 注释 L704 | 文字提及 `cpoCloseTab` | 仅注释，**非调用**，无需处理（但说明作者已知 scripting 权限是 CPO 引入的）。 |
| A6 | 注释 L755 / L769 | 文字提及 `cpoRun`/`cpoRun2`/`cpo_state` | 仅注释，无需处理。 |

> A1 是「偷用内部 helper」型反向依赖（最该消除）。A2/A3/A4 是「automation 桥接 feature」型——
> 设计上 automation 需要能编排 CPO，这层耦合无法靠「提升 helper」消除，只能靠**接口/消息**解耦（见 §4 决策 D3）。

### B. orchestrator 内的「近重复」helper（非跨段，但拆分相关）

`orchSendStepCommand`(L723) 与 CPO 的 `cpoSendCommand`(L354) 是**功能近重复**（都做「向 tab 发命令 + content
未就绪重试」），但**协议不同**：cpoSendCommand 私有约定 `resp.ok===false → throw`；orchSendStepCommand 不解读、
原样返回交 adapter。**两者独立、互不引用**，各归各段（cpo / automation），**不应强行合并**（合并会改变 CPO 的错误语义）。
列此条仅防拆分时误判为「重复要去重」。

### C. image_search ↔ CPO ↔ orchestrator（已核实：无其他跨段引用）

- image_search 段(34-103) 引用 cpo*/orch*/ORCH：**无**（grep 确认）。
- CPO 段(324-635) 引用 orch*/img*/ORCH：**无**（grep 确认）。
- orchestrator 段(637-1065) 引用 img*/isImgSearch*/enableSessionStorage：**无**（grep 确认）。
→ 三个 feature/automation 段彼此干净，**唯一脏点是 §3.A 的 orchestrator→CPO**。

### D. 各段 → native 连接层（留 core，标出）

| # | 引用方 | 被引用 | 说明 |
|---|--------|--------|------|
| D1 | onMessage #1(L133) 的 8 个透传分支（L137/153/160/167/179/192/203/213） | `sendToNativeHost` L114 | 同属 core，无跨边界问题。 |
| D2 | onMessage #1 的 GET_STATUS 分支 **L223** | `nativePort` L107（读 `nativePort !== null`） | 同属 core。拆 core 内部时 native 连接块(105-131)与透传 onMessage 块要一起留。 |

> feature 业务**不直接**调 `sendToNativeHost`——它们经 `window.AgentSeller.sendNative` → message → core onMessage 透传。
> 所以 native 层留 core、feature 搬走后仍能用 native 能力，**零影响**。

---

## 4. 共享 helper 归属判定 + 需提升 core 清单

判定规则（来自任务）：
- 被 ≥2 段用 且与具体 feature 无关 → **core**；
- 仅 automation 用 → automation；
- 仅单个 feature 用 → 该 feature。

### 逐个共享符号判定

| 符号 | 用它的段 | 与 feature 相关性 | 判定 | 理由 |
|------|---------|------------------|------|------|
| `cpoWaitTabComplete` (L340) | CPO(7 处)+orchestrator(1 处, L708) | 无关（纯「等 tab status==='complete'」通用 tab 工具，无 CPO 业务） | **→ core** | 满足「≥2 段 + feature 无关」。提到 `core/background/tab-utils.js`，挂 `self.AgentSellerBg.util.waitTabComplete`。CPO 与 orchestrator 都改调它。这是消除 §3.A1 反向依赖的**直接手段**。 |
| `sendToNativeHost` (L114) | 仅 core onMessage 透传块 | 无关（通用 native IO） | **留 core** | 实际只被 core 内部用（feature 经 message 透传）。本就在 core，无需动。 |
| `nativePort` (L107) | 仅 core（native 块 + GET_STATUS L223） | core 基础设施 | **留 core** | 同上。 |
| `cpoRun` / `cpoRun2` (L392/L532) | CPO 自身 listener + orchestrator adapter(L773/L785) | **强相关 CPO**（P1/P2 业务编排） | **→ cpo** | 与具体 feature 强绑（serial/skuNo/spuId/订单号），不满足「feature 无关」，**不提升 core**。automation 对它的依赖靠接口解耦（见下 D3）。 |
| `orchSendStepCommand` (L723) | 仅 orchestrator | automation 通用 | **→ automation** | 仅 automation 用。虽与 cpoSendCommand 近重复，但协议不同、不合并（§3.B）。 |
| `orchNavigateAndWait`/`orchPollState`/`orchMarkCommitting` | 仅 orchestrator | automation 通用 | **→ automation** | 仅 automation 用。注意 `orchNavigateAndWait` 改调提升后的 `core util.waitTabComplete`（替掉 L708 的 cpoWaitTabComplete）。 |

### ★ 需提升到 core 的 helper 清单（Task 1.6 直接输入）

> **只有 1 个**符号满足「≥2 段共用 + feature 无关」的硬提升条件：

| 提升符号 | 现位置 | 建议落点 | 建议导出 | 改调点 |
|---------|--------|---------|---------|--------|
| `cpoWaitTabComplete` → 重命名 `waitTabComplete` | service-worker.js L340 | `core/background/tab-utils.js`（新建） | `self.AgentSellerBg.util.waitTabComplete`（挂全局，classic 脚本，先于其他 bg 段加载） | CPO 段 7 处（L409/420/428/552/557/587/613）+ orchestrator `orchNavigateAndWait` L708 |

提升后：
- CPO 段 `cpoWaitTabComplete` 定义删除，7 处调用改 `self.AgentSellerBg.util.waitTabComplete`（或 import）。
- orchestrator L708 改同名调用 → **§3.A1 反向依赖消除**。
- 加载顺序：`tab-utils.js` 须排在 CPO bg 与 automation bg **之前**（与 contract.js / version-cmp.js 同属「先挂全局的 classic 基建」）。

> 候选但**不**提升：`cpoSendCommand` / `orchSendStepCommand`（近重复但各段私有协议、各只 1 段用，提升会被迫统一语义，
> 违反「只重构不改行为」——留各段。若后续想 DRY，应作为**独立行为变更**评审，不在本次纯结构搬迁里做。）

### D3. automation→CPO 编排耦合（A2/A3/A4）的处理建议（非本笔记强约束，供拆分决策）

`cpoRun`/`cpoRun2` 留 cpo 段后，automation 的 CPO adapter 仍需触发它们。两条路：
- **(推荐·最小行为风险) automation 经消息触发**：adapter 发 `CPO_START` / `CPO_START_PHASE2`（CPO listener 已存在，L452/L629），
  再轮询 `cpo_state` 读结果。完全走现有 message 边界，automation 不直接 import CPO 代码 → 单向依赖成立。
  代价：adapter 当前是 `await cpoRun(...)` 直调拿同步完成信号，改 message 后要轮询 cpo_state 终态（`orchPollState` 已具备此能力）。
- **(次选) 保留直调但承认耦合**：把 `cpoRun`/`cpoRun2` 视为 CPO 对外导出的「编排 API」，automation import。
  仍是 automation→feature 方向依赖，违反 brief 的单向原则，**不建议**。

> 此项是**行为/架构决策**，超出「纯结构搬迁」范围，建议放到「阶段2：行为清理」或单独对齐，不在阶段1 顺手改。
> 阶段1 只需做 §4★ 的 `cpoWaitTabComplete` 提升（纯结构、零行为变更）即可让代码可编译/可加载。

---

## 5. importScripts 清单（拆分时的加载顺序约束）

| importScripts | 行 | 当前路径（相对 SW=core/background/） | 归属 | 拆分后注意 |
|---------------|----|--------------------------------------|------|-----------|
| `version-cmp.js` | 6 | `core/background/version-cmp.js` | core（auto-reload 用 cmpVersion） | 留 core |
| `../contract.js` | 641 | `core/contract.js` | automation 用（但物理在 core/） | automation 段引 `self.__AS_DASH_CONTRACT__`；搬 automation 后路径要相应调整 |
| `orchestrator/steps.js`,`state-machine.js`,`recovery.js`,`mutation-queue.js`,`engine.js` | 641 | `core/background/orchestrator/*` | automation | 整个 `orchestrator/` 目录随 automation 搬 |
| `ws-client.js` | 651 | `core/background/ws-client.js` | automation | 随 automation 搬 |

> 提升 `cpoWaitTabComplete` 后，需新增 `importScripts('tab-utils.js')`（或等价），排在 §4★ 说的最前面。

---

## 6. onMessage 分支清单（L133 listener #1，按分支归属）

> ⚠ L133 是 **4 个 onMessage listener 中唯一混了归属的**。CPO(L452/L629) 与 orchestrator(L1031) 的 listener
> 各自单一归属，整块随段搬即可，不在此表。

| msg.type | 行（if 起） | 归属 | 说明 |
|----------|------------|------|------|
| `PROCESS_LABEL` | 134 | **core**（native 透传） | → `sendToNativeHost('generate_label')` |
| `READ_FILE` | 152 | **core**（native 透传） | → read_file |
| `READ_FILE_SIZE` | 159 | **core**（native 透传） | → read_file_size |
| `READ_FILE_CHUNK` | 166 | **core**（native 透传） | → read_file_chunk |
| `SAVE_FILE_CHUNK` | 178 | **core**（native 透传） | → write_file_chunk |
| `PICK_FILE` | 191 | **core**（native 透传） | → pick_file |
| `PICK_FOLDER` | 202 | **core**（native 透传） | → pick_folder |
| `OPEN_FOLDER` | 212 | **core**（native 透传） | → open_folder |
| `GET_STATUS` | 222 | **core**（native 状态） | 读 `nativePort !== null`（同步 sendResponse，**无 return true**） |
| `OPEN_MONITOR` | 226 | **→ automation**（dashboard 是监控系统资产） | `chrome.windows.create` 开 dashboard.html 独立窗口。dev-only（isDev 守卫，release 剥离 windows 权限）。归 automation/dashboard。 |
| `IMG_SEARCH_START` | 250 | **→ image_search** | 注入 overlay.css/js + 起截图；读写 `isImgSearchCapturing`/`imgSearchSourceTabId`，调 `imgNotify` |
| `IMG_SEARCH_CANCEL` | 280 | **→ image_search** | 重置 `isImgSearchCapturing`（同步，无 return true） |
| `IMG_SEARCH_CAPTURE_REGION` | 286 | **→ image_search** | `captureVisibleTab` + `imgCropImage`/`imgEstimateBytes`/`imgSetPayload`/`imgNotify`，开 1688 tab |
| `IMG_SEARCH_INJECTION_RESULT` | 317 | **→ image_search** | 注入结果回报（同步，无 return true） |

### 拆 L133 listener 的方式

MV3 允许多个 `onMessage.addListener`（本文件已有 4 个，证明可行）。拆分建议：
- **core 保留** PROCESS_LABEL…GET_STATUS（9 个 native 透传/状态分支）的 listener；
- **image_search/background** 新注册一个 listener 处理 IMG_SEARCH_*（4 个分支）+ 带走段 2 的 helpers/常量/可变状态；
- **automation** 把 OPEN_MONITOR 并入其 listener（或单独注册）；
- 拆开后**各 listener 只 `return true` 自己的异步分支**——注意原 listener 里 GET_STATUS/IMG_SEARCH_CANCEL/
  IMG_SEARCH_INJECTION_RESULT 是同步分支（无 return true），拆走后行为不变即可。

> ⚠ 拆分陷阱：原单一 listener 里**前面分支 return true 不影响后面分支**（每个 if 独立 return）。拆成多 listener 后，
> 多个 listener 对同一条 message 都会被调用——只要各 listener 对**不属于自己的 type 不调 sendResponse 也不 return true**
> （现状每个 if 不命中就落空、函数尾隐式 return undefined），并发 listener 互不干扰。保持「不命中 type 就什么都不做」即安全。

---

## 7. 意外发现 / 归属难判定

1. **onMessage 是 4 个独立 listener，不是 1 个**（L133/452/629/1031）。brief 描述的「单一巨型 if-else 133-322」
   只对 listener #1 成立。好消息：CPO/orchestrator 的 listener 各自单一归属，搬走更干净；唯一要「拆开」的是 L133。

2. **`enableSessionStorageAccess`(L42) 归属**：它设 `storage.session` 访问级别，看似通用基建，但**目的纯为
   image_search 的 imgPayload 经 session storage 传给 1688 tab**（IMG_PAYLOAD_KEY 走 storage.session）。
   当前无其他 feature 用 storage.session。判 **image_search**。若未来有第二个 feature 需要 storage.session 的
   TRUSTED_AND_UNTRUSTED 级别，再提升 core。**这是本次唯一「现在归 feature、将来可能提 core」的边界符号**，标注供后续注意。

3. **`cpoSendCommand`(L354) vs `orchSendStepCommand`(L723) 近重复**：功能 80% 重叠但错误协议不同
   （CPO 私有 `resp.ok===false→throw`；orch 原样返回）。**不要在结构搬迁里合并**——合并必改 CPO 错误语义=行为变更。
   各归各段。

4. **A4 数据耦合（automation 读 cpo_state）拆分后不会「断」但违反单向依赖**：`cpo_state` 是字符串 storage key，
   automation adapter 直接 `chrome.storage.local.get('cpo_state')`。代码层不报错，但 automation 依赖了 CPO 私有
   storage 契约。彻底解耦需 CPO adapter 改走 message+轮询（§4.D3）。**属架构决策，建议阶段2 处理，阶段1 先不动**。

5. **`cpoCloseTab`(L377) 只 CPO 段用**：orchestrator L704 仅在注释里提到它（说明 scripting 权限由 CPO 引入），
   **非调用**。所以 cpoCloseTab 干净归 cpo，不提升。

---

## 8. 给后续阶段的最小结论

- **阶段1（纯结构搬迁，零行为变更）必须做的唯一跨段处理**：把 `cpoWaitTabComplete` 提到
  `core/background/tab-utils.js`（`self.AgentSellerBg.util.waitTabComplete`），CPO 7 处 + orchestrator 1 处改调。
  这一步消除 §3.A1，且是纯结构（同一行为、换调用路径）。
- **其余跨段（A2/A3/A4：automation 直调/读 CPO 的 cpoRun/cpoRun2/cpo_state）**属架构耦合，
  消除需改成 message+轮询 = 行为变更，**留阶段2**，阶段1 可暂时让 automation 仍直调（同 worktree/同 SW 内代码可见，
  能编译能跑），但要在阶段1 PR 里**显式标注这是已知遗留单向依赖违规**，阶段2 收口。
- onMessage L133 按 §6 拆 3 路（core 透传 / image_search / automation OPEN_MONITOR）。
