# CPO 复购模式简化 设计 spec

> 日期：2026-06-01
> 上游 spec：`2026-05-29-create-purchase-order-repurchase-mode-design.md`（v1.2.0 复购模式初版）
> 目标：把复购流程从「填 SKU 货号 + 走配对」进一步简化为「只填 1688 订单号 + 只选采购人员（含仓库）」，并把「待到货页搜索定位」从 SKU 货号切到采购单号。

## 1. 背景与动机

v1.2.0（2026-05-29）落地复购模式：跳过 ①Phase 1（手填 SKU 货号 + 1688 订单号），直接跑 Phase 2 完整流程（取订单 → 仓库 → **配对 SKU** → 采购人员 → 保存通过审核 → 待到货页搜 skuNo 定位）。

实际使用发现：复购的商品店小秘里 SKU 档案已建好，**进入 Phase 2 后店小秘自身的"获取 1688 订单"已经把商品载入待保存的采购单**——再走一次"填 SKU 货号 + 配对商品"是冗余操作，浪费操作员时间。最小化后复购编辑页只需要"采购人员"和"收货仓库"两个人工选择即可。

## 2. 范围

### In Scope
- UI：店小秘页 ②区面板移除「SKU 货号」输入框
- 校验：复购 `validatePhase2` 分支只校验 `orderNo1688` 非空
- Phase 2 编辑页（CPO_P2_EDIT_FILL）：复购跳过「配对商品」，只跑「收货仓库 → 采购人员」
- 待到货页搜索定位（CPO_P2_WAIT_SEARCH）：**新品 + 复购统一**用 `poNo` + 切搜索类型 tag 到「采购单号」
- 状态：`collected2` 字段从 `{poNo, orderNo1688, skuNo}` 改为 `{poNo, orderNo1688}`，复购模式不再回填 SKU 货号
- 单测：4 例复购 `validatePhase2` 用例改造

### Out of Scope
- 新品 Phase 2 的编辑页流程（仓库 + 配对 + 采购人员 + 保存）**完全不动**——仅 WAIT_SEARCH 一处与复购统一
- Phase 1（添加 SKU）逻辑完全不动
- v1.2.0 与 v1.2.2 之间的复购流程不并存——直接替换

## 3. 决策记录

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 收货仓库还选不选？ | **继续选「中正科技仓」+ 写后读校验** | 保留现有，避免店小秘默认值漂移导致后端校验失败 |
| 待到货页搜索定位 | **改用 PO 号（新品 + 复购统一）** | PO 号唯一性强、与编辑页保存返回的 `poNo` 直接关联，不必维护 skuNo |
| UI 处理 | **「商品复购」开关 + 1688 订单号；删 SKU 货号框** | 极简，让员工立即看到「复购只需 1 个输入」 |
| 与现有复购关系 | **直接替换** | 简化版是更优解；员工装 v1.2.2 后复购默认走新流程，无并存复杂度 |
| 实施风格 | **方案 A：原地替换** | 改动散落但每处直观；分叉只 1 处；YAGNI |

> 设计权衡：方案 B（独立 handler `CPO_P2_EDIT_FILL_SIMPLE`）会增加 1 个 message type 协议成本，而新品/复购两路径分叉只 1 处，不值得分裂；方案 C（步骤数组编排器）属过度抽象，YAGNI。

## 4. 架构

不引入新组件、不改协议。沿用 v1.2.0 的「background 编排者 + content 命令处理器 + chrome.storage.local 单一状态源」架构。

**改动定位（6 处）**：

```
features/create_purchase_order/
├── cpo-logic.js
│   └── validatePhase2()                 ① 复购分支删 skuNo 必填，只校验 orderNo1688
│
├── content/index.js
│   ├── renderState()                    ② 删 skuInput 相关回填/锁定逻辑
│   ├── ②区 panel render                 ③ 删 SKU 货号 input DOM；点开始时不再传 skuNo
│   ├── CPO_P2_EDIT_FILL handler         ④ 复购模式（无 skuNo 入参）跳过配对：仓库 → 采购人员
│   └── CPO_P2_WAIT_SEARCH handler       ⑤ 入参从 skuNo 改 poNo + 切搜索类型 tag 到「采购单号」
│
└── tests/cpo-logic.test.js              ⑥ 改 4 例复购 validatePhase2 用例

core/background/service-worker.js
└── cpoRun2()                            ⑦ 复购分支不读手填 skuNo；CPO_P2_WAIT_SEARCH 传 poNo
```

## 5. 数据流

### v1.2.0 复购（现状，将被替换）
```
UI 输入 { skuNo, orderNo1688 } → cpoRun2(repurchase:true, skuNo)
  → collected2 = { poNo:'', orderNo1688, skuNo }
  → EDIT_FILL({skuNo})  → 仓库 + 配对(skuNo) + 采购人员
  → SAVE → extractPoNo → collected2.poNo
  → WAIT_SEARCH({skuNo})  → 切搜索类型「商品SKU」→ 搜 skuNo
```

### v1.2.2 复购（新）
```
UI 输入 { orderNo1688 } → cpoRun2(repurchase:true)       // 不传 skuNo
  → collected2 = { poNo:'', orderNo1688 }                // 无 skuNo 字段
  → EDIT_FILL({})  → 仓库 + 采购人员                      // 跳配对
  → SAVE → extractPoNo → collected2.poNo
  → WAIT_SEARCH({poNo})  → 切搜索类型「采购单号」→ 搜 poNo
```

### 新品 Phase 2（一并改：仅 WAIT_SEARCH 一处）
```
EDIT_FILL 仍走完整 3 步（仓库 + 配对 + 采购人员）
WAIT_SEARCH 入参从 skuNo 改为 poNo
搜索类型 tag 从「商品SKU」改为「采购单号」
其他步骤完全不变
```

### 状态模型变化

| 字段 | v1.2.0 | v1.2.2 | 备注 |
|------|--------|--------|------|
| `collected2.poNo` | string | string | 不变 |
| `collected2.orderNo1688` | string | string | 不变 |
| `collected2.skuNo` | **复购模式有** | **删除字段** | 升级后旧 cpo_state 残留字段会被新代码忽略 |
| `phase1.collected.skuNo` | 仅新品 | 仅新品 | 不变 |

`renderState` 中读 `c2.skuNo` 的逻辑全部删除——复购模式 UI 上不再有 SKU 货号框，无需回填；新品模式仍读 `p1.collected.skuNo` 回填 SKU 货号框。

## 6. 错误处理

沿用项目铁律：**读取 / 校验 / 业务**三层分类。新增 / 变化的错误点：

| 步骤 | 失败类型 | 文案 |
|------|---------|------|
| `validatePhase2` 复购 orderNo1688 空 | **校验** | 数据校验：1688订单号不能为空（复购模式） |
| EDIT_FILL 仓库 / 采购人员写后读不符 | **校验** | 数据校验：收货仓库 / 采购人员填写后不符，期望「X」实际「Y」（沿用现有） |
| WAIT_SEARCH 切「采购单号」tag 找不到 | **读取** | 读取失败：待到货页搜索类型「采购单号」未找到 |
| WAIT_SEARCH 搜 PO 后无结果 | **业务**（不阻断 done） | toast「未搜到商品行，请手动核对」+ `return { ok: true, found: false }` |

**关键设计**：搜不到结果不阻断 done——采购单号已经从审核弹窗解析到 `c2.poNo`，定位失败只是 UI 体验降级，不算业务失败。沿用 v1.2.0 现有策略。

## 7. 测试策略

### 单元层（`tests/cpo-logic.test.js`，`node --test`）
- 改：现有 4 例复购 `validatePhase2` 用例——删 skuNo 必填断言、加 orderNo1688 唯一必填断言
- 加：「复购 + 空 orderNo1688」→ 应失败，给「订单号不能为空」消息
- 加：「复购 + 非空 orderNo1688」→ 应通过（不再要求 skuNo）

### 集成层（联调，真实 dianxiaomi.com）

1. **DOM 假设验证（实施第一步，先于改代码）**：手动到待到货页 → console dump `.d-tag-group-item` 全部 tag 文字 → 确认有「采购单号」tag、记录可能命名变体（「采购单号」/「采购单 号」/英文等）→ 给搜索类型切换代码用
2. **复购冒烟**：UI 勾「商品复购」+ 填 1688 订单号 → 开始 → edit 页只跑 2 步（仓库 + 采购人员）→ 保存通过审核 → 待到货页用 PO 号搜 → 定位 → 进入「申请付款」前
3. **新品回归**：不勾复购，正常 Phase 1 + Phase 2 全流程 → 配对仍执行 → 待到货页用 PO 号搜（**新品也变了的点**）→ 定位成功
4. **失败场景**：复购填错 1688 订单号（add 页报错）/ 复购填的订单号已存在（「已存在」弹窗分流报错）

## 8. 边缘场景 & 已知风险

| 场景 | 处理 |
|------|------|
| 员工装 v1.2.2 后没手动 reload 扩展 | v1.2.1 起已有「扩展自检 + 自动 reload」，v1.2.1 → v1.2.2 升级路径**救得了**（不同于 v1.2.0 → v1.2.1） |
| 升级时正在跑的复购流程 | 被 `chrome.runtime.reload()` 打断、状态丢失——员工重跑（与 v1.2.1 一致） |
| 待到货页"采购单号"搜索类型不存在 | 实施 plan Task 1 强制先 dump 验证；若不存在 → 暂停 + 回 brainstorming 改方案（可能改为「打开待到货页不搜」） |
| 新品流程也改了 WAIT_SEARCH | **非纯复购改动**，PR 文案明示「新品 Phase 2 待到货页搜索 key 也从 skuNo 切到 poNo」 |
| `collected2.skuNo` 旧字段残留 | 升级后旧 cpo_state 残留字段被新代码忽略；清流程或新流程时自然覆盖 |

## 9. Done 定义

- ✓ 4 例单测全过
- ✓ 复购冒烟从开始到「申请付款」前全链路通
- ✓ 新品回归冒烟通过（PO 搜索定位在新品流程也生效）
- ✓ 失败场景文案符合分层
- ✓ 待到货页 DOM 假设已通过实际 dump 验证

## 10. 升级语义

- **版本号**：v1.2.2（PATCH，沿用 shipping-rules：PATCH 类小修复可以直接正式 tag）
- **回滚**：发现严重问题可回 v1.2.1；员工降级靠 Inno Setup 覆盖装 v1.2.1 installer
- **风险评级**：低——改动局限在 cpo Phase 2 一处分支，配对取消是简化操作不引入新外部依赖
