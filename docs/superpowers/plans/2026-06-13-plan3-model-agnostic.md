# Plan 3 第四刀：model-agnostic 验证 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:executing-plans 逐 Task 执行（inline）。Steps 用 checkbox 跟踪。

**Goal:** 用一个实现机制完全不同的玩具第二适配器（内联 `ScriptedModel`）跑通同一批诊断用例，证明诊断器对 LLM 后端实现无感（model-agnostic，spec §10/§11.1）。

**Architecture:** `brain/diagnoser.py` 的 `diagnose(step_error, context, model)` 已只依赖 `model.decide(messages)` 接口、不依赖具体模型类（`tests/test_brain_diagnoser.py` 的内联 `BoomModel` 已证可接任意实现）。本刀**不改 `brain/` 生产代码**，新增 `tests/test_brain_model_agnostic.py`：内联一个与 `MockModel`（if-else 规则式）实现机制不同的 `ScriptedModel`（数据驱动关键词映射），对同一批 `StepError` 用例跑 `diagnose()`，两类断言——(1) 安全红线/三分层优先于模型（任意适配器都挡不住 escalate）；(2) read 未触红线时诊断器忠实透传模型决策（同语义换适配器同结果、模型说 retry 就 retry，证明 read 决策来自模型而非诊断器硬编码）。玩具适配器内联测试域（无生产价值，同 `BoomModel` 先例），不污染 `brain/`。

**Tech Stack:** Python（裸 `assert` 函数，pytest 收集），零三方依赖。

**范围决策（用户 2026-06-13 AskUserQuestion 拍板）：** 第二适配器用「玩具 ScriptedModel」而非真实 Anthropic 家——纯证 `decide` 接口可插拔，不引入未验证的真实后端生产代码。OpenAICompatModel 仍零单测（真 API 解析逻辑）留 e2e / 后续，本刀不碰（不在所选范围）。

---

### Task 1: model-agnostic 验证测试

**Files:**
- Create: `tests/test_brain_model_agnostic.py`

- [ ] **Step 1: 写验证测试（含内联 ScriptedModel）**

```python
# tests/test_brain_model_agnostic.py — model-agnostic 验证（spec §10/§11.1）。
# 命题：诊断器对 LLM 后端「实现」无感。diagnose() 只依赖 model.decide(messages) 接口，
# 不依赖具体模型类。本测试用两个实现机制完全不同的适配器（MockModel if-else 规则 /
# 内联 ScriptedModel 数据驱动关键词映射）跑同一批诊断用例，证明「换模型只改适配器」：
#   (1) 安全红线/三分层优先于模型——任意适配器（含说 retry 的）都挡不住 escalate；
#   (2) read 未触红线时诊断器忠实透传模型决策——同语义换适配器同结果、模型说 retry 就 retry，
#       证明 read 决策来自模型（可插拔）而非诊断器硬编码。
# 玩具适配器内联测试域（无生产价值，同 test_brain_diagnoser.py 的 BoomModel 先例），不污染 brain/。
from brain.diagnoser import diagnose, MAX_RETRY
from brain.model import MockModel


class ScriptedModel:
    """玩具第二适配器：数据驱动关键词映射（区别于 MockModel 的硬编码 if-else）。
    取最后一条 user 消息（避开 system 提示文案污染），按 rules 顺序匹配子串、命中即返回。
    机制与 MockModel / OpenAICompatModel 都不同，仅需满足 decide(messages, tools=None)->str 契约。"""

    def __init__(self, rules, default='{"action":"escalate","reason":"no-match"}'):
        self._rules = rules          # [(substr, response_json_str)]
        self._default = default

    def decide(self, messages, tools=None):
        users = [m.get("content", "") for m in (messages or []) if m.get("role") == "user"]
        text = (users[-1] if users else "").lower()
        for substr, response in self._rules:
            if substr.lower() in text:
                return response
        return self._default


def _err(category="read", recoverable=True, message="waitForEl timeout", code="X"):
    return {"category": category, "code": code, "message": message, "recoverable": recoverable}


# 两个实现机制不同的适配器，配成对同一 read 用例语义一致（瞬时→retry / 结构性→escalate）。
def _mock():
    return MockModel()   # if-else：看末条 content 是否含 timeout / 超时


def _scripted():
    return ScriptedModel(rules=[("timeout", '{"action":"retry","reason":"transient"}'),
                                ("超时",    '{"action":"retry","reason":"transient"}')],
                         default='{"action":"escalate","reason":"structural"}')


ADAPTERS = [("mock", _mock), ("scripted", _scripted)]


# ---- (1) 安全红线 / 三分层优先于模型：任意适配器都 escalate ----

def test_irreversible_escalates_across_adapters():
    # 红线 1：recoverable=false。即便用例含 timeout（适配器倾向 retry），仍强制 escalate。
    for name, make in ADAPTERS:
        d = diagnose(_err(recoverable=False, message="timeout"), {"retryCount": 0}, make())
        assert d["action"] == "escalate", name


def test_retry_limit_escalates_across_adapters():
    # 红线 2：retryCount 达上限。即便含 timeout，仍 escalate。
    for name, make in ADAPTERS:
        d = diagnose(_err(message="timeout"), {"retryCount": MAX_RETRY}, make())
        assert d["action"] == "escalate", name


def test_non_read_escalates_across_adapters():
    # 三分层：validate / business 不调模型，任意适配器都 escalate。
    for name, make in ADAPTERS:
        for cat in ("validate", "business"):
            d = diagnose(_err(category=cat, message="timeout"), {"retryCount": 0}, make())
            assert d["action"] == "escalate", (name, cat)


# ---- (2) read 未触红线：诊断器忠实透传模型决策（换适配器同语义同结果） ----

def test_read_transient_retry_across_adapters():
    for name, make in ADAPTERS:
        d = diagnose(_err(message="waitForEl timeout 10s"), {"retryCount": 0}, make())
        assert d["action"] == "retry", name


def test_read_structural_escalate_across_adapters():
    for name, make in ADAPTERS:
        d = diagnose(_err(message="selector not found", code="NOT_FOUND"), {"retryCount": 0}, make())
        assert d["action"] == "escalate", name


# ---- (2b) 透传证明：read 用例本会判 escalate，强制两适配器说 retry → 诊断 retry ----
#       证明 read 决策来自模型（可插拔），诊断器不偷藏硬编码 escalate。

def test_diagnoser_passes_through_model_verdict():
    err = _err(message="selector not found", code="NOT_FOUND")   # 规则式默认会 escalate
    models = [
        ("mock", MockModel(canned='{"action":"retry","reason":"forced"}')),
        ("scripted", ScriptedModel(rules=[("selector", '{"action":"retry","reason":"forced"}')])),
    ]
    for name, model in models:
        d = diagnose(err, {"retryCount": 0}, model)
        assert d["action"] == "retry", name
```

- [ ] **Step 2: 跑测试，预期全过**

Run: `python3 -m pytest tests/test_brain_model_agnostic.py -v`
Expected: 6 passed（证明诊断器本就 model-agnostic；若 Red 则暴露诊断器对模型实现的隐藏耦合 bug，须先修诊断器再继续）

- [ ] **Step 3: commit**

```bash
git add tests/test_brain_model_agnostic.py
git commit -m "$(cat <<'EOF'
test(plan3): model-agnostic 验证——换适配器跑同一诊断用例证明可换

Why: spec §10/§11.1 要求证明诊断器对 LLM 后端实现无感（换模型只改适配器）。
What: 新增 tests/test_brain_model_agnostic.py，内联玩具 ScriptedModel（数据驱动
  关键词映射，实现机制区别于 MockModel 的 if-else），对同一批 StepError 用例跑
  diagnose()：①安全红线/三分层优先于模型（任意适配器都 escalate）②read 未触红线
  时诊断器忠实透传模型决策（同语义同结果、模型说 retry 就 retry）。不改 brain/ 生产代码。
Test: python3 -m pytest tests/test_brain_model_agnostic.py -v → 6 passed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 全量回归 + 验证文档

**Files:**
- Create: `docs/superpowers/2026-06-13-plan3-model-agnostic-verification.md`

- [ ] **Step 1: 全量回归（Python + JS 不回归 + dev build）**

Run（分开跑，避免合并超时）：
- `python3 -m pytest tests/` —— 全量 Python，预期 brain 旧 + 新 6 全过（核对总数 = 原 43 + 6 = 49）
- `node --test tests/*.test.js` —— 全量 JS 不回归，预期 79 pass（第四刀不动 JS）
- `python3 build/build_extension.py` —— dev build 不回归，预期 8 features / 15 cs

> ⚠ JS 测试命令必须用 `node --test tests/*.test.js`（整目录会把 pytest `.py` 当 JS 解析失败）。

- [ ] **Step 2: 写验证文档** `docs/superpowers/2026-06-13-plan3-model-agnostic-verification.md`

内容含：自动化验证结果表（6 model-agnostic + 全量 Py/JS + dev build）；命题与测试设计说明（两类断言）；范围边界（玩具适配器 / OpenAICompatModel 单测缺口留后续 / e2e 留 task #30）；Plan 3 四刀闭环 + 合 main 前收尾清单（发版隔离总账 + chrome e2e + PR）。

- [ ] **Step 3: commit**

```bash
git add docs/superpowers/2026-06-13-plan3-model-agnostic-verification.md
git commit -m "$(cat <<'EOF'
docs(plan3): 第四刀 model-agnostic 验证文档 + 全量回归

Why: 留档第四刀验证证据 + Plan 3 四刀闭环、合 main 前收尾清单。
What: 验证文档（结果表 + 命题/测试设计 + 边界 + 收尾清单）。
Test: python3 -m pytest tests/ / node --test tests/*.test.js / build_extension.py 全绿（见文档结果表）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

- **Spec 覆盖**：spec §10「model-agnostic 验证：换一个模型适配器跑通同一诊断用例（证明可换）」← Task 1 直接实现；spec §11.1「换模型只改适配器」← 测试命题。✓
- **Placeholder**：Task 1 含完整测试代码、Task 2 列明确命令与期望，无 TBD。✓
- **类型一致**：`diagnose(step_error, context, model)` / `MockModel(canned=...)` / `MAX_RETRY` 均与 `brain/diagnoser.py`、`brain/model.py` 现有签名一致（已读源码核对）。✓
- **边界**：不改 brain/ 生产代码（玩具适配器内联测试），与所选范围一致；OpenAICompatModel 单测缺口明确标注留后续。✓
