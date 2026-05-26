# 创建采购单 Feature — Phase 1 设计

> 日期：2026-05-26
> Feature ID：`create_purchase_order`
> 范围：**仅 Phase 1**（temu + 1688 取数 → 店小秘建商品 SKU）。Phase 2（店小秘创建采购订单）动作待定，后续单独立 spec。

## 1. 背景与目标

把「在店小秘新建一个商品 SKU」这件原本要在 3 个网站之间手工来回复制粘贴的事自动化。

Phase 1 的产出是：在店小秘仓库商品管理页用一组从 temu + 1688 自动采集的数据，建好一个商品 SKU。这是 Phase 2「创建采购订单」的前置数据准备。

### 用户输入（Phase 1 只用前两个）
| 输入 | Phase 1 用途 |
|------|------|
| `SKC编码` | 在 temu 商品列表页按「商品ID查询=SKC」查询定位商品 |
| `1688商品url` | 取商品标题（中文名称）、提取 serial（识别码）、作来源URL |
| `1688订单号` | **Phase 1 不使用**，留给 Phase 2 |

### 非目标（Phase 1 不做）
- 不创建采购订单（Phase 2）
- 不调用 native host（纯 DOM + tab 编排，无文件/BarTender 能力）
- 不做 reload 跨刷新续跑的复杂状态机（见 §4 状态说明）

## 2. 控制模型（已与用户确认）

- **不让用户盯着页面点来点去**：扩展全自动跑完取数，临时 tab 用完即关。
- **分步 + 单一关键 checkpoint**：取数与填表全自动；唯一人工介入点是数据填进店小秘 add 页后、**点保存前**停下来让用户在该页核对、确认后才保存。
- 起点固定：**temu 商品列表页**（`https://agentseller.temu.com/goods/list`）打开 Hub 输入 → 点「开始」。

## 3. 架构：background 编排者（本项目新模式）

### 决策
现有所有 feature 的 background（`core/background/service-worker.js`）只是 native messaging 透传哑管道，业务逻辑全在 content script。本 feature **首次把真正的编排逻辑放进 background**。

理由：需求是「开一个 tab → 抓完数据 → 关掉 → 下一步」的线性跨 tab 序列。只有 background service worker 跨 tab 存活、能开/关 tab、能收各 content script 回传的数据。把这套逻辑塞进 content script 并用 storage 续跑（被否决的替代方案 B）正是用户明确要避免的「太复杂的状态机」。

### 职责划分
```
content script (temu list) ──START{skc,url1688}──▶ background orchestrator
                                                      │ 线性 async 序列
                                                      │ 内存持 collectedData
                                                      │ 镜像一份到 chrome.storage 当安全网
   ┌──────────────────────┬──────────────────────────┼───────────────────────┬──────────────────────┐
   ▼ 后台开 tab            ▼ 命令原 tab                ▼ 监听自动新开 tab       ▼ 开 tab 并聚焦
 1688 商品页            temu list (用户原 tab)        temu edit 页            店小秘 add 页
 抓标题 → 关tab          查SKC→读货号→点编辑           抓预览图url → 关tab      填表 → 停在保存前
```

- **background**：编排大脑。线性 `await` 序列，逐步 `chrome.tabs.create` / 等待就绪 / `sendMessage` 发命令 / 收数据 / `chrome.tabs.remove`。内存持 `collectedData`，每步更新后镜像 `chrome.storage.local`（仅作崩溃安全网，不做完整 reload 续跑）。
- **content script（各域）**：只暴露「命令处理器」，不自驱。收到 bg 命令 → 在本页执行 DOM 操作 → 回传结果。
- **UI / 进度**：Hub 面板在 temu 原 tab 上显示进度；终态核对发生在店小秘 add tab（用户在该页直接看填好的表单、点保存）。

### tab 生命周期
| tab | 由谁开 | 命运 |
|-----|--------|------|
| temu list | 用户原有 | 保留（用户起点） |
| 1688 商品页 | bg `tabs.create({active:false})` 后台开 | 抓完标题即 `tabs.remove` |
| temu edit | 点编辑后 temu 自动新开 | 抓完预览图即 `tabs.remove` |
| 店小秘 add | bg `tabs.create` 并聚焦 | 保留（终态核对 + 保存） |

### 命令清单（content script 处理器）
| 命令 | 目标域 | 入参 | 回传 |
|------|--------|------|------|
| `CPO_READ_1688_TITLE` | 1688 | — | `{title}` |
| `CPO_QUERY_SKC_GET_NO` | temu | `{skc}` | `{skuNo}` 或 `{empty:true}` |
| `CPO_GRAB_PREVIEW` | temu edit | — | `{previewUrl}` |
| `CPO_FILL_DXM` | 店小秘 | `collectedData` | `{filled:true}`（填完停手，不点保存） |

> 命令前缀 `CPO_`（create_purchase_order）与现有 service-worker action（`PROCESS_LABEL` 等）区隔；这些是 bg→content 的内部命令，不进现有 native action 路由表。

## 4. 状态与数据

### collectedData（bg 内存 + storage 镜像）
```
{
  skc:        string,   // 用户输入
  url1688:    string,   // 用户输入
  title:      string,   // 步骤1：1688 商品标题
  skuNo:      string,   // 步骤2：temu 列表 SKU货号
  previewUrl: string,   // 步骤3：temu edit 预览图url
  serial:     string,   // 从 url1688 提取
}
```
- storage key：`cpo_state`（单 key，含 `status: idle|running|awaiting_save|error` + `collectedData` + `step`）。
- **不做 reload 续跑**：phase1 整段流程数秒级，service worker 在连续 tab 操作/消息往返期间保持存活；storage 镜像仅用于崩溃后能查到「上次跑到哪/收了什么」与避免脏状态，不重建半截流程。

### serial 提取 + 识别码
- serial：`url1688` 匹配 `/offer/(\d+)\.html/` 取捕获组。
- 识别码：`` `${serial}-${skuNo}` ``。
- 提取失败（url 不含 offer id）→ 中止并报「1688商品url 格式异常，无法提取 serial」（数据校验类文案）。

## 5. 线性流程（详细）

| 步 | 页面 | 动作 | 产出 / 中止条件 |
|----|------|------|----------------|
| 0 | temu list | Hub 输入 `skc` + `url1688`，点「开始」；bg 校验 url 能提取 serial | `skc`, `url1688`, `serial` |
| 1 | 1688 商品页（后台 tab） | 抓商品标题 | `title`；抓不到 → 中止报「1688标题读取失败（可能未登录/页面未渲染）」（读取失败类） |
| 2 | temu list（原 tab） | 商品ID查询切「SKC」→ 填 `skc` → 点查询 → 等列表 → 定位 SKC 行 → 读 SKU货号 | `skuNo`；行未找到 → 中止报「未找到 SKC 对应商品」（读取/选择器类）；货号为空 → 中止报「该商品需先维护货号」（数据校验类） |
| 3 | temu edit（自动新 tab） | 点编辑进编辑页 → SKU信息框定位预览图 → 复制预览图url | `previewUrl`；抓不到 → 中止报「预览图url 读取失败」（读取类） |
| 4 | 店小秘 add 页 | bg 开页并聚焦 → `CPO_FILL_DXM` 填全部 card（见 §6）→ **status=awaiting_save，停手**；用户在该页核对 → 点保存 | 填表完成；用户点保存后 status=idle |

## 6. 店小秘 add 页字段映射

目标页：点「添加商品」→「添加单个SKU」→ `https://www.dianxiaomi.com/web/dxmCommodityProduct/openAddModal?...`

| card / 字段 | 值 | 备注 |
|------|------|------|
| 基础信息：商品SKU | `skuNo` | 三框同填 |
| 基础信息：英文名称 | `skuNo` | |
| 基础信息：平台SKU | `skuNo` | |
| 基础信息：中文名称 | `title` | 1688 商品标题 |
| 基础信息：识别码 | `${serial}-${skuNo}` | |
| 来源URL card | `url1688` | |
| 图片信息 card | `previewUrl` | 点「选择图片」→ 下拉选「网络图片」→ 弹窗输入 url → 点确定 |
| 人员信息 card | 当前店铺 user-name | 所有下拉选 DOM 中显示的 user-name |

> 填完**不点保存**。保存是用户核对后的人工动作（唯一 checkpoint）。

## 7. 错误处理

- **错误文案分层**（项目铁律，避免把数据问题误诊成读取问题）：
  | 类别 | 本 feature 实例 | 文案 |
  |------|------|------|
  | 读取/选择器故障 | 行未找到、预览图抓不到、1688标题抓不到、tab 加载失败 | 「读取失败/未找到 X」+ 在哪一步 |
  | 数据校验 | SKU货号为空、serial 提取失败 | 「X 字段为空/不合法」+ 哪个字段 |
- **临时 tab 回收**：任一步中止时，关闭所有已开的临时 tab（1688 / temu edit），store 置 `idle`。
- **超时**：每步 tab 加载 / 元素出现设合理超时（复用 `utils.waitForEl`），超时即按读取失败中止。

## 8. feature.json（草案）

```json
{
  "id": "create_purchase_order",
  "icon": "🛒",
  "label": "创建采购单",
  "locked": false,
  "order": 5,
  "content_script": "content/index.js",
  "content_matches": [
    "https://agentseller.temu.com/*",
    "https://detail.1688.com/*",
    "https://www.dianxiaomi.com/*"
  ],
  "host_permissions": [
    "https://agentseller.temu.com/*",
    "https://detail.1688.com/*",
    "https://www.dianxiaomi.com/*"
  ],
  "permissions": ["tabs", "storage"]
}
```

- 显式 `content_matches`（含三域）防 FAB 注入污染（项目记忆）。
- FAB/Hub 会在三域出现（项目已知现状）；1688 是纯后台取数 tab，可考虑在 1688 域抑制 FAB（实现期细节，非阻断）。
- 编排逻辑放 background，但 background 是 core 共享文件 —— 需评估是否在 `core/background/service-worker.js` 加 CPO 编排模块，还是 feature 提供一段被 core 引用的编排代码。**这是 Phase 1 落地前要先定的 core 边界问题**（见 §10）。

## 9. 测试策略

- **纯逻辑 TDD（先行）**：
  - serial 正则提取（含异常 url）
  - 识别码拼接
  - 字段映射（collectedData → 店小秘各字段值）
  - collectedData / store 状态结构
- **DOM 交互（手动 + 真实 DOM dump）**：
  - 每个页面选择器**先 dump 真实 DOM**（`samples/`）再写代码（项目铁律：数据/UI 类先看真实结构）
  - selector 优先 `data-testid` / 文本匹配，禁 hash class
  - dev build → chrome reload → 在三域实测线性流程
- **端到端**：用一个真实 SKC + 1688url 跑通到「店小秘填好停在保存前」。

## 10. 落地前待解的 core 边界问题

本 feature 是首个需要 background 编排的 feature。落地前需确认 core 扩展方式（很可能要先开一个 core PR）：

1. background 编排逻辑放哪：`core/background/` 新增模块 vs feature 注入。
2. content script 命令处理器如何注册到 bg→content 的 sendMessage 路由（现有 core 是否有 content 侧消息分发，还是要新建）。
3. bg 开/关 tab + 等 tab 就绪的通用工具是否下沉 core。

> 按项目「新增 Feature 标准工作流」第 2-3 步：若 core 不够用，先做 core PR，再开 feature 分支。Phase 1 实现 plan 应把 core 扩展拆成独立前置任务。

## 11. Phase 2 预告（不在本 spec 范围）

Phase 1 完成后，导航到店小秘订单管理页 `https://www.dianxiaomi.com/web/purchasing/order/draft/manualPurchasing` → 点「创建采购订单」→ 编辑页 `https://www.dianxiaomi.com/web/purchasing/order/add?...` → 后续动作待定。届时会用到 `1688订单号` 输入。Phase 2 单独 brainstorm + spec。
