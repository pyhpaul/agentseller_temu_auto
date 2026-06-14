# HITL 回填的模型提议（通用通道）设计

> automation 大脑后续刀。在已合 main 的「确定性骨架 + 大脑诊断 self-heal（Plan 3）」之上，给大脑加**第二个判断点**：为回填型 HITL 步**提议**回填值，人工复核确认。spec §12「HITL 回填的模型决策：首版人工 overlay；后续大脑从上下文推断回填值」的落地。

## 背景与关系

- **Plan 2/3（已合 main）**：13 步确定性编排骨架 + 大脑诊断器（出错 self-heal，read 类智能重试 / 两红线）+ 回填型 HITL 浮层（人工输入 skc/url1688/orderNo1688）。
- **本刀**：大脑从「只诊断出错」扩展到「也提议 HITL 回填值」。两个判断点（diagnose / fill-suggest）都**不驱动流程**——确定性引擎照常 advance，大脑只在 pause 点辅助。
- **前提风险**：roadmap 注「后续刀需 chrome e2e 验证基础」。e2e 尚未跑。设计/实现是 pre-e2e 安全的（不进 release、不碰 feature），但真跑前应补 e2e。

## 当前回填机制（人工版，本刀的改造对象）

3 个回填型 HITL 步带 `hitlSpec.fields`（`automation/orchestrator/steps.js`）：

| 步 | 字段 | domain | 下游 AUTO 步消费 |
|----|------|--------|------------------|
| 步2 collect_dxm | `skc`(必) + `spuId`(选) | dianxiaomi.com | 步7 gen_label 用 skc |
| 步5 compare_1688 | `url1688`(必) | 1688.com | 步8 create_sku 用 url1688 |
| 步6 order_1688 | `orderNo1688`(必) | 1688.com | 步9 create_po 用 orderNo1688 |

`engine.buildHitl(step)` → `editable: fields.length>0` + `fields`；overlay 渲染输入框；人工填 → `WF_HITL_CONFIRM{result}` → `orchHitlConfirm` → `Object.assign(wf.product, pickProduct(result))`。大脑当前完全不碰。

## 成功标准

回填型 HITL 步 pause 时，大脑（在线 + 真模型）从「workflow 上下文 + 当前步页面快照」**提议**回填值，overlay 预填该值 + 标「🧠 建议」+ 理由；人工核对/改/确认后才落 product。大脑离线 / 提议为空 → 完全退回现状（纯人工填）。**全程人工确认门不变，大脑永不自动 confirm、永不直接写 product。**

## 三条安全不变量（贯穿，不破）

1. **人工确认门是唯一落 product 的闸**：suggestion 只是 overlay 预填，人工必须过目 + 点确认才 `Object.assign(product)`。守数据正确性铁律（人工仍做写后读 / 身份确认）——填错不会静默进下游不可逆步。
2. **大脑绝不编造**：无页面数据 / 模型挂 / 解析不出合法提议 → 空 values + 低 confidence → 退回纯人工填。宁可不提议，不可瞎填。
3. **发版隔离**：改动只在 `brain/`（dev-only Python）+ `automation/`（overlay/bg-entry，dev-only 装配）；**不碰 `core/` 和任何 feature**。release 不装配 automation → 天然无此功能。

## 架构

新增 `filler` 组件（`brain/filler.py`），与 `diagnoser.py` **并列、解耦**——大脑两个判断点各一个模块，server 按消息类型分发。filler 复用 `jsonx.extract_decision` 的容错解析思路（剥围栏 / 抓平衡块 / 真垃圾→空）。

### 进程拓扑（在 Plan 3 基础上加一条消息对）

```
回填步 pause → bg 抓上下文 ──FILL_REQUEST──> 大脑 server ──> filler ──> 模型
   overlay 预填 <──写 hitl.suggestion── bg <──FILL_SUGGEST{values,reason,confidence}──
   人工核对/改/确认 ──WF_HITL_CONFIRM──> product（门不变）
```

## 组件划分

| 文件 | 改动 | 职责 / 接口 |
|------|------|------------|
| `brain/filler.py`（新） | `suggest(step_id, fields, context, model) -> {"values":{k:v}, "reason":str, "confidence":float}` | 按 fields spec + context 构造 prompt 调模型；jsonx 容错解析；模型挂/不确定 → `{"values":{}, "reason":..., "confidence":0}`（空提议，不编造） |
| `brain/server.py` | 加 `FILL_REQUEST` 路由 | → `asyncio.to_thread(suggest,...)` → 回 `FILL_SUGGEST` + 广播 `suggest` 类 BRAIN_EVENT（dashboard 可见）；外包 try 兜底空提议 |
| `brain/registry.py` | 可选：`describe_field(step_id, key)` | 给 filler 的 prompt 补字段语义（如 url1688=1688 货源链接），让模型懂在填什么 |
| `automation/bg-entry.js` | 回填步 pause 钩子 + FILL_SUGGEST handler + WF_FILL_REFRESH 分支 + 快照助手 | ①pause 回填步且大脑在线 → `orchRequestFillSuggest`（抓上下文 + FILL_REQUEST，按需连同 orchEnsureWs）②ws handlers 加 `FILL_SUGGEST`：写 `wf.hitl.suggestion`（**不碰 product**）③现有 `registerHandler('WF_',...)` 加 `WF_FILL_REFRESH` 分支 → 重跑 `orchRequestFillSuggest`④`orchCapturePageSnapshot(domain)`：按 domain query tab → executeScript 取 `document.body.innerText` 截断到 ~6000 字符（抓不到返回 null） |
| `automation/overlay/overlay-view.js` | 纯逻辑助手 | `mergeSuggestion(fields, suggestion) -> [{...field, suggestedValue, ...}]`；`hasSuggestion(hitl)`；可 node 测 |
| `automation/overlay/overlay.js` | 渲染 | 有 `hitl.suggestion` 时字段 input `value` 预填 suggestedValue + 字段旁「🧠 建议（请核对）」badge + 顶部显 reason/confidence；加「🔄 重新建议」按钮发 `WF_FILL_REFRESH`。无 suggestion → 现状（空输入） |

## WS 协议子集（在 Plan 3 已有上加一对）

| 消息 | 方向 | data |
|------|------|------|
| `FILL_REQUEST` | bg → 大脑 | `{workflowId, stepId, fields:[{key,label,fieldType,required}], context:{product, recentSteps, pageSnapshot}}` |
| `FILL_SUGGEST` | 大脑 → bg | `{workflowId, stepId, values:{key:val}, reason, confidence}` |

`protocol.py` 编解码不变（已是泛 `{type,data}`）。`registerHandler` 侧：bg-entry 的 ws handlers 加 `FILL_SUGGEST`（与现有 `STATE_PATCH` 并列）。

## 数据流（propose → verify）

1. workflow advance 到回填型 HITL 步 → engine `pause-hitl` → `buildHitl`（现有，editable+fields）→ 写 storage。
2. **新增**：bg 检测到 pause 的是回填型步（`hitl.editable && hitl.fields.length`）且大脑在线 → `orchEnsureWs` + `orchRequestFillSuggest(wf)`：
   - 抓上下文：`product`（已填字段）+ `recentSteps`（近几步 id/status）+ `pageSnapshot`（按 `step.domain` query tab → `body.innerText` 截断到 ~6000 字符，抓不到则省略）。
   - 发 `FILL_REQUEST`。
3. 大脑 server 收 `FILL_REQUEST` → `to_thread(filler.suggest)` → 模型按字段 + 上下文产出 `{values, reason, confidence}` → 回 `FILL_SUGGEST` + 广播 `suggest` BRAIN_EVENT。
4. bg `FILL_SUGGEST` handler：经 orchQueue 串行化写 `wf.hitl.suggestion = {values, reason, confidence}`（**只写 hitl，不碰 product**）→ storage 变更。
5. overlay `storage.onChanged` 重渲：字段预填 `suggestion.values[key]` + 🧠badge + reason；人工核对/改/确认 → 现有 `WF_HITL_CONFIRM{result}` → product（门不变）。
6. 「🔄 重新建议」：人工点 → `WF_FILL_REFRESH{workflowId}` → bg 重跑 `orchRequestFillSuggest`。

## 触发方式

- **自动**：回填步 pause 时 bg 自动发 FILL_REQUEST（大脑在线）。提议在人工看 overlay 时已预填好，最顺。
- **手动兜底**：overlay「🔄 重新建议」按钮（首版抓快照那刻页面可能还没就绪 / 人工想换提议时用）。

## 错误处理 / 降级

- 大脑离线 / FILL_SUGGEST 超时 / 空 values → overlay 字段空 = 现状纯人工流，**不阻塞**。
- 页面快照抓取失败（无匹配 tab / executeScript 报错）→ 省略快照，filler 仅凭 workflow 上下文（提议弱但安全）。
- filler 模型异常 / 解析不出 → 空提议（不变量2），server 仍回 FILL_SUGGEST（空），bg 写空 suggestion → overlay 不预填。
- ⚠️ 默认 MockModel 产不出真提议（它是诊断规则式）；filler 的 MockModel 行为 = 返回空提议 → 退回纯人工。真提议需配 `BRAIN_LLM_*` 真模型。

## 字段无关性

通道字段无关：任何带 `hitlSpec.fields` + `domain` 的回填步自动受益。步2/5/6 现有 3 步**无需逐个改 steps.js** 即可拿到提议（通用快照喂模型）。每字段的**精确结构化抓取器**（如 1688 比价候选解析）是后续优化，按需加，不在本刀。

## 测试策略

- `brain/filler.py` 单测：mock 模型返回围栏/散文包裹的合法提议 → 正确解析 values；模型抛 / 返回垃圾 / 空 → **空提议（不变量2 红线测试，绝不编造）**；缺 required 字段的提议 → 也照样返回（人工补，不在 filler 拦）。
- `brain/server.py` 集成：FILL_REQUEST → FILL_SUGGEST 真 socket 往返（同现有 test_brain_server 风格）；filler 抛 → server 兜底空提议不崩。
- `automation/overlay/overlay-view.js` 单测：`mergeSuggestion` 预填值正确、无 suggestion → 字段无 suggestedValue（现状不变）；`hasSuggestion` 边界。
- bg 上下文整形 / 快照截断的纯逻辑可抽函数测；快照抓取（chrome scripting）+ 端到端留 chrome e2e。
- 安全回归：product 只经 WF_HITL_CONFIRM 更新（现有 orchHitlConfirm 不变）；suggestion 写 hitl 不写 product。

## 范围边界（YAGNI）

**做**：通用 propose→verify 管道（FILL_REQUEST/SUGGEST + filler + overlay 预填 + 通用快照）+ 自动触发 + 手动重试 + 安全降级。

**不做（后续刀）**：每字段精确结构化抓取器 / 模型自填自跑 / 分级自主（可逆自填、不可逆复核）/ 可偏离编排 / 多变种 per-SKU 提议 / suggestion 持久化历史。

## 待后续 / 未定

- filler 的 confidence 怎么用（首版仅展示，不据此自动决策；将来可设阈值下才提议）。
- 页面快照粒度（首版 body.innerText 截断；将来可按 domain 给精确选择器范围）。
- 多字段步（步2 skc+spuId）的提议：首版一次性提议所有 fields，人工逐个核对。
