# Plan 2/3 自动化流水线 chrome 端到端验证清单（L3 打通后）

> 适用：Plan 2 骨架 + Plan 3 大脑 + HITL 回填全部合 main（main `29fa61e`）后的完整端到端验证。
> 配套旧手册 `docs/superpowers/2026-06-10-plan2-chrome-verification-checklist.md`（Plan 2 副作用风险表）；本清单补 L3 打通后的 HITL 回填交互 + 大脑 WS。
> ⚠️ **硬约束：本清单全绿前不推 tag 发版**（orchestrator/overlay/ws-client/大脑进 release 但 dev-only 沉睡，验证前发版会带未验沉睡代码）。

## 0. 前置准备

```bash
# 1) 构建（WSL/项目根）
python3 build/build_extension.py            # 预期 8 features / 15 content scripts

# 2) 起大脑进程（Plan 3 验证用；不起则大脑离线、自动降级为纯确定性 + 人工 HITL）
pip install -r brain/requirements.txt --break-system-packages   # 首次（websockets，PEP 668 需此 flag）
python3 -m brain                            # 前台跑，监听 ws://localhost:8787；Ctrl-C 停
#   可选真模型：先设环境变量再起 —— BRAIN_LLM_BASE_URL / BRAIN_LLM_API_KEY / BRAIN_LLM_MODEL
#   默认 MockModel（规则式，不发真 API，够验链路）
```

3) Chrome：`chrome://extensions` → 加载/reload `dist/extension/` → 业务页 panel 标题栏 `dev:<ts>` 确认是新版。
4) 打开任一 Temu 商家中心业务页（overlay 注入在业务页）。

> 调试入口：SW console（`chrome://extensions` → 扩展 → service worker「检查」）可直接调 `orchStartWorkflow` / `orchEngine` / `orchHitlConfirm` / 读 `chrome.storage.local`（`orchStartWorkflow`/`orchEngine`/`orchQueue`/`ORCH` 都是 SW 顶层 const）。

---

## L0 纯逻辑回归（已绿，无需 chrome，先跑确认基线）

```bash
node --test tests/*.test.js          # 预期 87 pass（⚠ 必须 *.test.js，整目录会把 pytest .py 当 JS 失败）
python3 -m pytest tests/             # 预期 51 pass
```

---

## L1 浮层 + HITL 回填交互（零副作用，最安全，先验）

业务页右下角 overlay：

1. **启动入口**：无 active workflow + dev → 显示「▶ 开始流水线」按钮（release 不显示=发版隔离）。
2. **WF_START**：点按钮 → 填商品 label → 「开始」→ overlay 切「编排进度 1/13」。空 label 点开始 → 不发（输入框重聚焦）。
3. **步2 collect_dxm 回填 skc**（HITL 回填核心）：推进到步2 paused → overlay 弹「SKC（采集后创建，唯一）*」+「SPU ID（可选）」输入框。
   - 填 skc → 「确认完成」→ cursor 推进；SW console 验 `(await chrome.storage.local.get('as_workflow_state')).as_workflow_state.batch.workflows[0].product.skc` === 填的值。
   - **required 校验**：skc 留空点确认 → `alert「SKC… 必填」`拦截、不推进。
4. **步5 compare_1688 回填 url1688 + 格式校验**：
   - 填非 1688 链接（如 `https://taobao.com/x`）点确认 → `alert「1688 链接格式不对（应含 1688.com）」`拦截。
   - 填合法 `url1688`（含 1688.com）→ 确认 → `product.url1688` 写入。
5. **步6 order_1688 回填 orderNo1688** → 确认 → `product.orderNo1688` 写入。
6. **error 分层 chip**（手搭）：SW console 设当前 step `error:{category:'read',recoverable:true}` + `wf.status='error'` → overlay 显示分层 chip（read 紫/validate 黄/business 红）+ recoverable→[重试]。

> L1 全程不碰真实业务页 DOM、不触发 feature，纯验浮层 + 回填 + storage 链路。

---

## L2 各 AUTO adapter 隔离真跑（部分不可逆，按风险排序）

SW console 构造单步 workflow + 设 cursor + `orchEngine.advance`，逐个验 adapter（详见旧手册 L2 + 各刀验证文档 snippet）：

| adapter | 风险 | 验证方式 |
|---------|------|---------|
| **pack_label** | 可逆（重打无害）| 先验，安全：有待打单 → 真打 PDF 落盘 |
| **ship** | 🔴 强不可逆（真出货）| 安全路径：发货页**无待发货单**时 advance → `NO_PENDING` done，不发货验链路；真发货需测试单 + 授权 |
| **gen_label** | 🔴 不可逆（真提交合规 + 传标签图）| 测试商品 + 授权；先 L1 直测 content `AGL_GEN_LABEL` |
| **publish** | 🔴 不可逆（真发布到 Temu 审核）| 测试商品 + 授权；店小秘编辑页 |
| create_sku / create_po | 🔴 强不可逆（建 SKU + 创采购单）| 测试单 + 验后作废 |

---

## L3 完整端到端（L3 数据流已通——本次重点）

从 WF_START 起，逐 HITL 卡点回填 + AUTO 步自动跑，验证**数据流渐进填充 + 下游 adapter 拿到回填数据**：

1. WF_START → 步1 选品（纯确认）→ 步2 collect_dxm 回填 **skc** → 步3 publish（AUTO，真发布）→ 步4 返单价（纯确认）→ 步5 compare_1688 回填 **url1688** → 步6 order_1688 回填 **orderNo1688** → 步7 gen_label（AUTO，用 product.skc）→ 步8 create_sku（用 url1688）→ 步9 create_po（用 orderNo1688）→ 步10 付款 → 步11 到货 → 步12 pack_label → 步13 ship。
2. **验证点**：每个 AUTO 步前 `product` 已含上游回填字段（步7 前有 skc、步8 前有 url1688、步9 前有 orderNo1688）；缺字段 → adapter hard error（不会误跑）。
3. ⚠️ **真跑全程不可逆**（真发布 + 真建 SKU/采购单 + 真发货）→ 必须**测试商品 + 明确授权 + 验后作废**。首版「一 SKC 一 SKU」。

---

## L4 dashboard + 大脑 WS（Plan 3）

1. Hub「打开监控」→ dashboard 独立窗口（或地址栏 `chrome-extension://<id>/dashboard/dashboard.html`）。
2. **大脑起**（`python3 -m brain`）→ dashboard WS 连接灯 **live**；**大脑停** → 降级（灯灭/mock 回放）。
3. **bg 按需连**：dev 起大脑后，WF_START 时 bg 经 orchEnsureWs 连大脑（onopen 自动 HELLO{role:bg}+PING）。
4. **诊断 self-heal**：AUTO 步 read 类错误 → bg 上报 STEP_RESULT → 大脑诊断（瞬时→retry / 结构性→escalate，两红线）→ STATE_PATCH 回 bg → applyDiagnosis 落地。dashboard 大脑流显示 diagnose 事件。

---

## 验证完成判定

- L0 绿（自动化基线）+ L1 绿（浮层/回填零副作用）+ L2 各 adapter 隔离通过 + L3 至少 1 条测试商品完整端到端 + L4 大脑连接/降级/诊断可见。
- 通过后才解除「不推 tag」硬约束 → 可发 rc / 正式 tag（员工发版仍走 dashboard 剥离的 release 路径）。
