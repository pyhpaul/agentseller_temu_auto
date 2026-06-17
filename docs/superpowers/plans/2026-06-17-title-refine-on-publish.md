# 标题润色（发布检查环节）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 或 superpowers:executing-plans 逐 task 实现。步骤用 checkbox。

**Goal:** 发布检查环节加 LLM 标题润色（措辞独特化降重），复用 brain 文本模型，HITL 确认后写回店小秘标题框 + 写后读 + 重跑 title 规则。

**Architecture:** brain 加 `refiner.py`（仿 filler.py）+ server.py 路由新帧 `TITLE_REFINE_REQUEST/SUGGEST`；check_and_publish content 加润色入口（读标题→请求→HITL 对比→写回）。MVP 先 feature panel 手动入口，自动化 await-check 入口后置 task。

**Tech Stack:** brain（Python WS，dev-only）、check_and_publish content（JS IIFE）、pytest + node --check。

**Spec:** `docs/superpowers/specs/2026-06-17-title-refine-on-publish-design.md`

**关键纠正:** `protocol.py` 的 encode/decode 是通用的（帧类型=字符串，无枚举注册），新帧**不改 protocol.py**。

**不变量（每 task 守住）:** brain 离线/挂/无有效改写 → 退回原标题（不编造、不阻断发布）；唯一写回入口是人工确认后的 capApplyTitle；润色结果必须重跑 title 规则通过才写回；release 隔离不破（brain dev-only，无 ws 则润色禁用态）。

---

## 文件结构

| 文件 | 责任 | 改动 |
|------|------|------|
| `brain/refiner.py`（新） | 调模型改写标题 + jsonx 容错 + 退回原标题兜底 | 新建，仿 filler.py |
| `brain/server.py` | WS 路由 | 加 `TITLE_REFINE_REQUEST` 分支 + `_handle_title_refine_request` |
| `tests/test_brain_refiner.py`（新） | refiner 单测 | 新建 |
| `tests/test_brain_server.py` | server 路由单测 | 加 title refine 路由用例 |
| `features/check_and_publish/content/index.js` | 润色入口 + 写回 + 重跑规则 | 加 capRefineTitle/capApplyTitle + panel 按钮 |

protocol.py **不改**。dashboard brain-stream 渲染 BRAIN_EVENT 是通用的（kind+text），新 kind `refine` 自动显示，无需改（Task 2 末顺手确认）。

---

## Task 1: brain/refiner.py — 标题润色

**Files:**
- Create: `brain/refiner.py`
- Test: `tests/test_brain_refiner.py`

- [ ] **Step 1: 写失败测试**

`tests/test_brain_refiner.py`：

```python
# tests/test_brain_refiner.py — 标题润色单测。安全红线：模型挂/垃圾/无 refined → 退回原标题（不编造）。
from brain.refiner import refine_title
from brain.model import MockModel

ORIG = "Wireless Bluetooth Earbuds Noise Cancelling"


def test_parses_refined():
    m = MockModel(canned='{"refined":"Noise-Cancelling Wireless Bluetooth Earphones","changes":"语序+同义","confidence":0.8}')
    out = refine_title(ORIG, {}, m)
    assert out["refined"] == "Noise-Cancelling Wireless Bluetooth Earphones"
    assert out["confidence"] == 0.8


def test_codefenced_parse():
    m = MockModel(canned='```json\n{"refined":"BT Earbuds ANC Wireless","changes":"r"}\n```')
    assert refine_title(ORIG, {}, m)["refined"] == "BT Earbuds ANC Wireless"


def test_model_exception_returns_original():
    class Boom:
        def decide(self, m, tools=None):
            raise RuntimeError("down")
    out = refine_title(ORIG, {}, Boom())
    assert out["refined"] == ORIG          # 退回原标题，不编造
    assert out["confidence"] == 0.0


def test_garbage_returns_original():
    assert refine_title(ORIG, {}, MockModel(canned="I cannot help"))["refined"] == ORIG


def test_no_refined_field_returns_original():
    # 默认 MockModel 产诊断式 {"action":...}，无 refined → 退回原标题
    assert refine_title(ORIG, {}, MockModel())["refined"] == ORIG


def test_empty_original():
    out = refine_title("", {}, MockModel())
    assert out["refined"] == ""
    assert out["confidence"] == 0.0


def test_only_string_refined_accepted():
    # refined 非字符串（如数字）→ 退回原标题
    m = MockModel(canned='{"refined":123,"changes":"x"}')
    assert refine_title(ORIG, {}, m)["refined"] == ORIG
```

- [ ] **Step 2: 跑测试验证失败**

Run: `python3 -m pytest tests/test_brain_refiner.py -q`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 brain/refiner.py**

```python
# brain/refiner.py — 标题润色（措辞独特化降重，大脑文本判断点）。spec 2026-06-17。
# 调模型改写标题 → jsonx 容错解析 → {refined, changes, confidence}。
# 安全：模型挂/解析不出/无有效 refined → 退回原标题（不编造劣质标题，对齐 filler 不编造哲学）；
# 合规校验在 content 端确定性重跑 title 规则（约束给结构），brain 只生成。
import logging

from brain.jsonx import extract_decision

_log = logging.getLogger("brain.refiner")


def refine_title(original, constraints, model):
    """original: 原标题 str；constraints: {maxLen,...} 提示用 dict。
    返回 {"refined": str, "changes": str, "confidence": float}。退回 = refined==original。"""
    original = (original or "").strip()
    if not original:
        return {"refined": "", "changes": "原标题为空", "confidence": 0.0}
    try:
        raw = model.decide(_build_messages(original, constraints or {}))
    except Exception as e:
        _log.warning("标题润色模型调用失败: %s: %s", type(e).__name__, str(e)[:200])
        return {"refined": original, "changes": "模型不可用，保留原标题", "confidence": 0.0}
    obj = extract_decision(raw)
    if not isinstance(obj, dict):
        return {"refined": original, "changes": "无法解析，保留原标题", "confidence": 0.0}
    refined = obj.get("refined")
    if not isinstance(refined, str) or not refined.strip():
        return {"refined": original, "changes": "无有效改写，保留原标题", "confidence": 0.0}
    conf = obj.get("confidence")
    confidence = float(conf) if isinstance(conf, (int, float)) and not isinstance(conf, bool) else 0.0
    return {"refined": refined.strip(), "changes": str(obj.get("changes") or ""), "confidence": confidence}


def _build_messages(original, constraints):
    max_len = constraints.get("maxLen", 250)
    return [
        {"role": "system", "content":
            "你是跨境电商标题优化助手。把商品标题改写得与原始表述显著不同但语义等价，"
            "用于降低与同源铺货商品的重复度。要求：保留核心品类词与关键卖点；纯英文；"
            "不超过 {} 字符；禁中文标点；禁营销违禁词（free/sale/best/discount 等）。"
            "只回 JSON：{{\"refined\":\"<新标题>\",\"changes\":\"<改动简述>\",\"confidence\":0~1}}。"
            "无法可靠改写就把 refined 设为原标题。".format(max_len)},
        {"role": "user", "content": "原标题：{}".format(original)},
    ]
```

- [ ] **Step 4: 跑测试验证通过**

Run: `python3 -m pytest tests/test_brain_refiner.py -q`
Expected: PASS（7 用例）

- [ ] **Step 5: Commit**

```bash
git add brain/refiner.py tests/test_brain_refiner.py
git commit -m "feat(brain): 加 refiner 标题润色（措辞独特化降重，退回原标题兜底）"
```

---

## Task 2: brain/server.py — 路由 TITLE_REFINE_REQUEST

**Files:**
- Modify: `brain/server.py`（import + handler 分支 + handler 函数）
- Test: `tests/test_brain_server.py`

- [ ] **Step 1: 写失败测试**

`tests/test_brain_server.py` 末尾加（仿现有 fill/review 路由测试模式；用收集 send 的 fake websocket）：

```python
import asyncio
from brain import server
from brain.protocol import decode
from brain.model import MockModel


class _FakeWS:
    def __init__(self):
        self.sent = []
    async def send(self, msg):
        self.sent.append(msg)


def test_title_refine_request_returns_suggest():
    server._model = MockModel(canned='{"refined":"New Title ANC Earbuds","changes":"语序","confidence":0.7}')
    ws = _FakeWS()
    asyncio.run(server._handle_title_refine_request(ws, {
        "workflowId": "w1", "stepId": "publish", "original": "Old Title Earbuds", "constraints": {},
    }))
    # 收到 TITLE_REFINE_SUGGEST（回 bg）+ BRAIN_EVENT（给 dashboard 的 broadcast，本测无 dash 连接故只验 send）
    types = [decode(m)[0] for m in ws.sent]
    assert "TITLE_REFINE_SUGGEST" in types
    suggest = next(decode(m)[1] for m in ws.sent if decode(m)[0] == "TITLE_REFINE_SUGGEST")
    assert suggest["refined"] == "New Title ANC Earbuds"
    assert suggest["original"] == "Old Title Earbuds"


def test_title_refine_exception_falls_back_to_original():
    class Boom:
        def decide(self, m, tools=None):
            raise RuntimeError("down")
    server._model = Boom()
    ws = _FakeWS()
    asyncio.run(server._handle_title_refine_request(ws, {
        "workflowId": "w1", "stepId": "publish", "original": "Keep This", "constraints": {},
    }))
    suggest = next(decode(m)[1] for m in ws.sent if decode(m)[0] == "TITLE_REFINE_SUGGEST")
    assert suggest["refined"] == "Keep This"   # 兜底退回原标题，不阻断
    server._model = MockModel()                # 复位，免污染其他用例
```

- [ ] **Step 2: 跑测试验证失败**

Run: `python3 -m pytest tests/test_brain_server.py -q`
Expected: FAIL（`_handle_title_refine_request` 不存在）

- [ ] **Step 3: 实现（server.py）**

import 段加：
```python
from brain.refiner import refine_title
```

`handler()` 路由加分支（在 REVIEW_REQUEST 分支后）：
```python
            elif mtype == "TITLE_REFINE_REQUEST":
                await _handle_title_refine_request(websocket, data)
```

加 handler 函数（仿 _handle_fill_request）：
```python
async def _handle_title_refine_request(websocket, data):
    """TITLE_REFINE_REQUEST → refiner 润色 → TITLE_REFINE_SUGGEST 回 bg + refine 类 BRAIN_EVENT。
    fail-safe：refiner 任何抛点兜底退回原标题（不编造、不阻断发布）。to_thread 防阻塞模型冻结。"""
    original = data.get("original") or ""
    try:
        result = await asyncio.to_thread(
            refine_title, original, data.get("constraints") or {}, _model)
    except Exception as e:
        result = {"refined": original, "changes": "润色异常兜底（{}），保留原标题".format(type(e).__name__), "confidence": 0.0}
    await _broadcast_dashboards(_brain_event(
        data, "refine", "润色：{}".format(result["changes"])))
    try:
        await websocket.send(encode("TITLE_REFINE_SUGGEST", {
            "requestId": data.get("requestId"),   # 透传供 bg 请求-响应配对（Task 4）
            "workflowId": data.get("workflowId"), "stepId": data.get("stepId"),
            "original": original, "refined": result["refined"],
            "changes": result["changes"], "confidence": result["confidence"],
        }))
    except Exception:
        pass
```

- [ ] **Step 4: 跑测试验证通过 + 全量 brain 回归**

Run: `python3 -m pytest tests/ -q`
Expected: PASS（92 + 新增 ~9 用例全绿）

- [ ] **Step 5: 顺手确认 dashboard brain-stream 认识 kind='refine'**

看 `automation/dashboard/components/brain-stream.js`：若它对 kind 做了白名单/图标映射，给 `refine` 加一条（标题润色图标/标签）；若是通用渲染（text+kind 直接显示）则无需改。**只读确认，必要才改。**

- [ ] **Step 6: Commit**

```bash
git add brain/server.py tests/test_brain_server.py
git commit -m "feat(brain): server 路由 TITLE_REFINE_REQUEST → refiner → SUGGEST（兜底退回原标题）"
```

---

## Task 3: check_and_publish content — 润色入口 + 写回 + 重跑规则

**Files:**
- Modify: `features/check_and_publish/content/index.js`（润色核心 + panel 按钮 + 写后读 + 重跑 title 规则）

content 改动靠 e2e + `node --check`（DOM/跨进程逻辑单测覆盖不到）。

- [ ] **Step 1: 加润色核心函数**

在 publish/onPublish 逻辑附近加（`getTitleField` 已存在，复用）：

```js
// 标题润色：读当前标题 → 经 SW 转发 brain TITLE_REFINE_REQUEST → 收 refined。
// brain 离线/失败 → 退回原标题（不阻断）。返回 {original, refined, changes, available}。
async function capRefineTitle() {
  const t = getTitleField();
  if (!t.el || t.value == null) {
    return { available: false, error: '读取失败：未找到标题输入框' };
  }
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      type: 'CAP_TITLE_REFINE', data: { original: t.value, constraints: { maxLen: 250 } },
    });
  } catch (e) {
    return { available: false, original: t.value, error: '润色不可用：大脑离线，保留原标题' };
  }
  if (!resp || !resp.ok) {
    return { available: false, original: t.value, error: (resp && resp.error) || '润色不可用，保留原标题' };
  }
  return { available: true, original: t.value, refined: resp.refined || t.value, changes: resp.changes || '' };
}

// 写回标题 + 写后读校验 + 重跑 title 类规则（不合规 → 不写回，返回诊断）。
function capApplyTitle(value) {
  const t = getTitleField();
  if (!t.el) return { ok: false, error: '读取失败：未找到标题输入框' };
  U.setInputValue(t.el, value);
  // 写后读校验（对齐项目 DOM 自动化铁律）
  if ((t.el.value || '') !== value) {
    return { ok: false, error: `数据校验：标题写入未生效，期望「${value}」实际「${t.el.value}」` };
  }
  // 重跑 title 类规则（约束给结构：润色结果确定性校验，不合规弃用）
  const ctx = collectFields();
  const titleRuleIds = ['title_length', 'title_forbidden', 'chinese_punctuation', 'title_should_english', 'forbidden_words_marketing'];
  const failed = RULES.filter(r => titleRuleIds.includes(r.id))
    .map(r => ({ id: r.id, name: r.name, res: r.check(ctx) }))
    .filter(x => x.res && x.res.pass === false);
  if (failed.length) {
    return { ok: false, error: `数据校验：润色结果不合规（${failed.map(f => f.name).join('、')}），请重试或手动改` };
  }
  return { ok: true, value };
}
```

⚠ `CAP_TITLE_REFINE` 需在 content 的 SW 转发：SW 收到后 `orchEnsureWs` + 经 ws 发 `TITLE_REFINE_REQUEST`、等 `TITLE_REFINE_SUGGEST` 回，再 sendResponse 给 content。这条 SW 转发链路在 Task 4 与自动化入口一起接（MVP feature 手动也依赖它）。**故 Task 3 与 Task 4 的 SW 转发合并实现**——见 Task 4 Step 1。

- [ ] **Step 2: panel 加「润色标题」按钮**

panel 状态机 `passed`（检查通过）态渲染时，若标题字段存在，加「润色标题」按钮 → onClick 调 capRefineTitle → 弹原/润色对比小面板（采用 / 编辑后采用 / 放弃）→ 采用调 capApplyTitle → 成功提示 + 提示「已改标题，建议重新检查」。具体 DOM 按现有 panel 渲染风格插入。

- [ ] **Step 3: 语法检查**

Run: `node --check features/check_and_publish/content/index.js`
Expected: 无输出（语法 OK）

- [ ] **Step 4: Commit**（与 Task 4 SW 转发一起，见下）

---

## Task 4: SW 转发 CAP_TITLE_REFINE（MVP feature 手动入口依赖）

**Files:**
- Modify: `automation/bg-entry.js`（请求-响应配对 + registerHandler）

放 automation/bg-entry.js（dev-only）：release 不装配 automation → 无 handler → content `sendMessage` 失败 → capRefineTitle 走 catch 退「大脑离线」禁用态。这正是 release 优雅降级（标题润色依赖 brain 本就 dev-only）。

- [ ] **Step 1: 加请求-响应配对 + handler**

```js
// ── 标题润色请求-响应配对（content/dashboard 发起 → ws 往返 brain → 回发起方）──
// 区别于 fire-forget 的 FILL：润色需把 SUGGEST 结果回给发起方，故 requestId 配对 + 超时兜底。
const orchTitlePending = new Map();   // requestId → {resolve, timer}
let orchTitleSeq = 0;
const ORCH_TITLE_TIMEOUT_MS = 20000;

function orchRequestTitleRefine({ original, constraints, workflowId, stepId } = {}) {
  orchEnsureWs();
  if (!orchWsClient) return Promise.resolve({ ok: false, error: '润色不可用：大脑离线，保留原标题' });
  const requestId = 'tr_' + (++orchTitleSeq);
  return new Promise(resolve => {
    const timer = setTimeout(() => { orchTitlePending.delete(requestId); resolve({ ok: false, error: '润色超时：大脑无响应' }); }, ORCH_TITLE_TIMEOUT_MS);
    orchTitlePending.set(requestId, { resolve, timer });
    try {
      orchWsClient.send('TITLE_REFINE_REQUEST', { requestId, original, constraints, workflowId, stepId });
    } catch (e) {
      clearTimeout(timer); orchTitlePending.delete(requestId);
      resolve({ ok: false, error: '润色发送失败：' + String(e?.message || e) });
    }
  });
}
```

ws handlers（`orchEnsureWs` 的 handlers 对象）加 TITLE_REFINE_SUGGEST：
```js
      TITLE_REFINE_SUGGEST: (data) => {
        const p = orchTitlePending.get(data.requestId);
        if (!p) return;                                  // 超时已 resolve / 无对应 → 忽略
        clearTimeout(p.timer); orchTitlePending.delete(data.requestId);
        p.resolve({ ok: true, original: data.original, refined: data.refined, changes: data.changes, confidence: data.confidence });
      },
```

registerHandler（content 手动入口入口）：
```js
self.AgentSellerBg.registerHandler('CAP_TITLE_REFINE', (msg, _sender, sendResponse) => {
  orchRequestTitleRefine(msg.data || {}).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
```

> 依赖：Task 2 的 `TITLE_REFINE_SUGGEST` 必须**透传 requestId**（已在 Task 2 代码补 `"requestId": data.get("requestId")`）。

- [ ] **Step 2: 语法检查 + 全量回归**

Run: `node --check automation/bg-entry.js && node --test tests/*.test.js`
Expected: 语法 OK；JS 176 pass（SW 转发逻辑靠 e2e）

- [ ] **Step 3: Commit（含 Task 3 content）**

```bash
git add features/check_and_publish/content/index.js automation/bg-entry.js
git commit -m "feat(check_and_publish): 标题润色 feature 手动入口（content 润色+写后读+重跑规则 + SW 转发 brain）"
```

---

## Task 5（后置）: 自动化 publish await-check 润色入口

**Files:** `automation/bg-entry.js`（WF_TITLE_REFINE）+ `automation/dashboard/`（publish 卡动作 + HITL 对比）

**MVP 不做，方向占位**：publish 两段闸 await-check 卡加「润色标题」可选动作 → `WF_TITLE_REFINE` → bg 找编辑页 tab + `orchRequestTitleRefine` 拿 refined → 写 hitl 让 dashboard 卡展示原/润色对比 → 人工确认 → bg 发 content `CAP_APPLY_TITLE` 写回（capApplyTitle）→ 不阻断原 检查/发布 两段流程。

落地前置：dashboard publish 卡组件加对比子 UI + 写回确认动作；bg 加 WF_TITLE_REFINE / CAP_APPLY_TITLE 命令。复用 Task 1-4 的 brain refiner + orchRequestTitleRefine + capApplyTitle。

> 拆后置因：自动化入口涉及 dashboard HITL 卡改造 + 写回命令链，比 feature 手动入口重；MVP 先验证润色核心价值（feature 手动），自动化入口确认有需求再做。

---

## 完成验证清单

- [ ] `python3 -m pytest tests/ -q` 全绿（92 + refiner ~7 + server ~2）
- [ ] `node --test tests/*.test.js` → 176 pass（不破现有）
- [ ] `node --check` brain 无关；bg-entry.js + check_and_publish content 语法 OK
- [ ] `python3 build/build_extension.py` 成功（SW 装配无语法错）
- [ ] 端到端（人工 gated，brain 跑起 + reload）：
  - [ ] 店小秘编辑页检查通过 → 点「润色标题」→ 出原/润色对比 → 采用 → 标题框更新 + 重跑 title 规则通过
  - [ ] 润色结果（mock canned 含营销词）→ capApplyTitle 报「润色结果不合规」弃用
  - [ ] brain 未启动 → 点润色提示「大脑离线，保留原标题」，发布流程照常

## Spec 覆盖自查

| spec 节 | 落地 task |
|---|---|
| §4 brain refiner + TITLE_REFINE 帧 | Task 1 + Task 2 |
| §5 refiner 设计（退回原标题兜底、约束给结构） | Task 1（兜底）+ Task 3（content 重跑规则） |
| §6 触发入口①feature 手动 | Task 3 + Task 4 |
| §6 触发入口②自动化 await-check | Task 5（后置） |
| §7 HITL 原/润色对比确认 | Task 3 Step 2 |
| §8 错误分层 | Task 3（读取/数据校验）+ Task 4（业务降级） |
| §10 测试（refiner/server/protocol + content 重跑） | 各 task Step + 验证清单 |
