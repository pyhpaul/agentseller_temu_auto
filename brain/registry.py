# brain/registry.py — tool registry 镜像（spec §3 A.3）。静态声明，与 bg adapter/steps.js 对齐。
# 首版供诊断时大脑理解「当前 step 在干什么」；动态同步（HELLO 同步 tool 清单）留后续（spec §12）。
STEP_TOOLS = {
    "publish":    {"feature": "check_and_publish",     "desc": "合规预检+发布到 Temu"},
    "gen_label":  {"feature": "auto_gen_label",        "desc": "货号+标签+合规+标签图"},
    "create_sku": {"feature": "create_purchase_order", "desc": "建店小秘 SKU"},
    "create_po":  {"feature": "create_purchase_order", "desc": "创建采购单"},
    "pack_label": {"feature": "packing_label",         "desc": "打印打包标签"},
    "ship":       {"feature": "auto_ship",             "desc": "确认发货"},
}


def describe_step(step_id):
    """step_id → 人类可读描述（诊断 prompt 用，让模型理解当前 step 语境）。"""
    t = STEP_TOOLS.get(step_id)
    return "{}（{}）".format(step_id, t["desc"]) if t else str(step_id)
