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
