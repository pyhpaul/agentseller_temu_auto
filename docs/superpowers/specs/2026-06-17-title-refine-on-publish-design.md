# 标题润色（发布检查环节）设计文档

> 日期：2026-06-17
> 状态：设计待 review
> 范围：check_and_publish feature + brain（dev-only 大脑）；主图优化是独立子项目，另出 spec。

## 1. 背景与问题

铺货模式下，同一源商品被多个店铺采集上架，店小秘采集建品时标题通常**直接抄源商品标题**（或机翻）。结果：店小秘编辑页里待发布的标题与源/同款高度雷同 → Temu 对标题相似度判重/降权。需在**发布检查环节**加「标题润色」：把标题措辞独特化，降低与源的重复度，同时保持核心卖点、关键词、合规、长度。

**check_and_publish 现状**（feature 已有）：店小秘编辑页合规预检（12 规则）+ 两段发布。标题靠 `input[maxlength="250"]` **只读取值**（`title_length` 规则），无编辑能力。brain 已是文本 LLM（glm-4-flash / OpenAICompatModel），可复用做改写。

## 2. 降重策略的诚实边界

「避免与源商品重复度过高」——理想是拿"别家/源标题"做相似度比对后改写。但：
- **别家店铺标题无法获取**（不爬同款）；
- 源标题本身：店小秘采集后，当前编辑页标题**≈源标题**（铺货抄源）。

因此可行的代理目标 = **改写当前标题使其措辞独特化**（同义替换 / 语序重组 / 卖点突出 / 去套话），让它不再是"大家都从同源抄来的标准措辞"。改写前后的当前标题对比即降重证据。

> ⚠ 假设：当前编辑页标题 ≈ 源标题（铺货抄源）。**若店小秘采集时已改写过标题**，则当前标题非源标题，精确降重需补 `collect_dxm` 捕获源标题落 `product.sourceTitle` 的数据流——本期不做，标为待确认风险。本期润色输入 = 当前编辑页标题。

## 3. 目标 / 非目标

**目标**
- 发布检查环节能对当前标题做 LLM 润色（措辞独特化降重），保持卖点/关键词/英文/≤250/无中文标点/无营销违禁词。
- 润色结果人工确认（原 vs 润色对比）后才写回标题框，写后读校验。
- 润色写回后**重跑 title 类规则**，确保润色没引入新违规。

**非目标**
- 主图优化（独立子项目）。
- 精确"与别家标题相似度比对"（无法获取别家标题）。
- `collect_dxm` 捕获源标题数据流（本期假设当前标题≈源标题）。
- 全自动无人确认改标题（标题是发布关键字段，必须 HITL）。

## 4. 架构

```
[check_and_publish content]  读当前标题
        │ (经 SW 转发)
        ▼
[bg]  TITLE_REFINE_REQUEST ──ws──▶ [brain] refiner.py 调 OpenAICompatModel 改写
        ◀────────────────────────  TITLE_REFINE_SUGGEST {refined, changes, confidence}
        │
        ▼
[HITL]  原标题 vs 润色标题对比 → 人工：采用 / 编辑后采用 / 放弃
        │ 采用
        ▼
[content]  写回 input[maxlength=250] + 写后读校验 → 重跑 title 类规则
```

| 层 | 职责 | 改动 |
|---|---|---|
| `brain/protocol.py` | WS 帧枚举 | 加 `TITLE_REFINE_REQUEST` / `TITLE_REFINE_SUGGEST` |
| `brain/refiner.py`（新） | 调模型改写标题 + 容错解析 | 复用 `model.decide()` + `jsonx` |
| `brain/server.py` | WS 路由 | 加 `_handle_title_refine_request` 分支 + broadcast BRAIN_EVENT |
| `check_and_publish content` | 读标题 / 发请求 / 写回 + 写后读 + 重跑规则 | 加润色入口 + 写回逻辑 |
| 触发入口 | feature panel 手动 + 自动化 publish await-check 增强 | 见 §6 |

**为何 brain 而非 native_host**：纯文本改写是 brain 本职（已有文本模型）。主图才需 native_host（图像二进制+外部 API）。

## 5. brain refiner 设计

`refine_title(original, constraints, model) → { refined, changes, confidence }`：
- prompt：给原标题 + 约束（保留核心品类词与关键卖点、英文、≤250 字符、禁中文标点、禁营销违禁词如 free/sale/best），要求"换措辞/调语序/重组，使其与原始表述显著不同但语义等价"。
- 输出走 `jsonx` 容错解析（弱模型兜底）。
- **弱模型约束给结构非 prompt**：模型输出后由 content 端**确定性重跑 title 规则**校验（长度/英文/标点/违禁词）——不合格的润色建议直接标记不可用、提示重试，绝不让违规标题写回（呼应项目「约束给结构」教训）。
- MockModel 兜底：离线给规则式改写（如加同义后缀/调词序），保证 demo 不依赖真模型。

## 6. 触发入口（两个，共享 content 核心）

**核心逻辑**（content）：`capRefineTitle()` = 读标题 → 经 bg 发 TITLE_REFINE_REQUEST → 收建议 → 返回 {original, refined, changes}。写回 `capApplyTitle(value)` = setInputValue + 写后读校验 + 重跑 title 规则。

1. **feature panel 手动**：检查与发布 panel 在「检查」后，若标题存在，显示「润色标题」按钮 → 调 capRefineTitle → 弹原/润色对比 → 采用/编辑/放弃 → capApplyTitle。
2. **自动化 publish await-check 增强**：publish 两段闸的 await-check 阶段，dashboard 卡片加「润色标题」可选动作（WF_TITLE_REFINE）→ bg 找编辑页 tab 发 content 命令 → 结果回 HITL 卡对比 → 确认写回 → 不影响原有 检查/发布 两段流程（润色是 await-check 的旁路增强，不阻断）。

> MVP 可先做入口 1（feature 手动），入口 2 同 spec 但可在 plan 拆后置 task。两入口共用 content 核心 + brain refiner。

## 7. HITL 确认交互

展示：原标题、润色标题、改动摘要（changes）、confidence。人工三选一：
- **采用**：写回 + 写后读 + 重跑 title 规则（通过才算成功）。
- **编辑后采用**：人工微调润色结果再写回（同样重跑规则）。
- **放弃**：不改，保留原标题。

标题是发布关键字段，**无静默写回**（对齐项目「写后读校验」+「不可逆/关键动作人工确认」铁律）。

## 8. 错误分层（对齐 debugging-rules）

| 失败 | 分类 | 文案 |
|---|---|---|
| 标题框找不到 / 非编辑页 | 读取 | `读取失败：未找到标题输入框` |
| brain 离线 / 超时 / transport 失败 | 业务（降级） | `润色不可用：大脑离线，保留原标题`（不阻断发布） |
| 润色结果重跑 title 规则不过 | 数据校验 | `润色结果不合规（<规则>），已弃用建议，请重试或手动改` |
| 写回后读校验不符 | 数据校验 | `标题写入未生效，期望「X」实际「Y」` |

## 9. 不变量 / 向后兼容

- **release 隔离**：brain 是 dev-only（release 无 ws）；润色入口若走 automation 则随 automation 不装配而消失；feature panel 入口在 release 是否保留见 §11 待定。
- **brain 离线退回纯人工**：无 ws → 润色不可用，保留原标题，发布流程照常（守"大脑离线退回纯人工"不变量）。
- **不静默改标题**：唯一写回入口是人工确认后的 capApplyTitle。
- **润色不破坏发布**：润色是检查环节旁路增强，放弃/失败都不影响原有 检查→发布。

## 10. 测试策略

**brain（pytest）**
- `refiner.refine_title`：正常返回结构；jsonx 容错（模型输出脏 JSON）；MockModel 离线兜底给确定性改写。
- `server` 路由：TITLE_REFINE_REQUEST → 调 refiner → 回 TITLE_REFINE_SUGGEST + broadcast BRAIN_EVENT。
- `protocol`：新帧编解码。

**content（纯逻辑可测部分）**
- title 规则重跑：润色结果含违禁词/超长/中文标点 → 判不可用（复用现有 RULES 中 title 类 check，抽出可单测）。

**端到端（人工 gated）**
- feature panel：检查后点润色 → 出原/润色对比 → 采用 → 标题框更新 + 重跑检查通过。
- 润色结果故意含营销词（mock）→ 提示不合规弃用。
- brain 离线 → 润色按钮提示不可用，保留原标题。

## 11. 范围边界 / 待确认

- 本期只做标题润色（文本），主图优化独立 spec（待图像服务选定）。
- **待确认①**：店小秘采集是否改写过源标题（决定要不要补 `product.sourceTitle` 数据流）。本期假设当前标题≈源标题。
- **待确认②**：feature panel 润色入口在 release 是否保留（员工手动润色有价值则保留，纯 dev 增强则随 automation 走）。倾向保留 feature 手动入口（不依赖 brain 时可退化为禁用态）。
- 自动化 await-check 入口（入口 2）可在 plan 拆为后置 task，MVP 先 feature 手动入口。
