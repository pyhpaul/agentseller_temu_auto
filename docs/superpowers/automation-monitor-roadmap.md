# 全自动化「上架→发货」方案 — 进度与工作流隔离

> 本文件是本方案的**进度真源 + 协作约定**。
> 设计细节见 spec,单 Plan 执行步骤见对应 plan,运行时结构/发版隔离机制见根 `CLAUDE.md`。
> 跨会话的 agent memory 仅作快速提要,**有冲突以本文件为准**。

## 方案一句话

把现有离散 feature 串成「商品上架 → 发货」全自动流水线,引入 LLM agent 当大脑。
架构 = **hybrid:确定性骨架 + LLM 判断点介入**(否决纯 LLM 端到端 / 纯确定性)。
依据:任务全是 WRITE 类、现有踩平 DOM 坑的确定性代码是资产、跑真实登录浏览器天然绕过登录/2FA/CAPTCHA。

## 文档导航

| 内容 | 位置 |
|------|------|
| 设计 spec(架构 / 数据契约 / UI 规范 / 集成点 / 待对齐风险) | `docs/superpowers/specs/2026-06-08-automation-monitor-and-data-contract-design.md` |
| Plan 1 实施清单(9 Task / 55 Step / DoD) | `docs/superpowers/plans/2026-06-08-dashboard-monitor-landing.md` |
| Plan 2 spec(确定性编排骨架:13 步 + 状态机 + HITL) | `docs/superpowers/specs/2026-06-09-automation-orchestrator-deterministic-skeleton-design.md` |
| Plan 3 spec(model-agnostic LLM 大脑) | `docs/superpowers/specs/2026-06-10-plan3-llm-brain-design.md` |
| Plan 3 各刀 plan + 验证说明 | `docs/superpowers/plans/2026-06-1*-plan3-*.md` + `docs/superpowers/2026-06-1*-plan3-*-verification.md` |
| HITL 回填 plan + 验证 | `docs/superpowers/plans/2026-06-13-orchestrator-hitl-fill-l3.md` + `docs/superpowers/2026-06-13-hitl-fill-l3-verification.md` |
| **chrome e2e 验证清单(L0-L4,当前待跑)** | `docs/superpowers/2026-06-13-l3-chrome-e2e-checklist.md` |
| dashboard 运行时结构 + 发版隔离机制 + openMonitor API | 根 `CLAUDE.md`「监控 dashboard」段 +「dashboard 发版隔离」段 |
| UI 视觉真源(自包含单文件,浏览器可直接开) | `ui-prototype/dashboard.html` |

## Plan 进度

| Plan | 范围 | 状态 |
|------|------|------|
| **Plan 1** | dashboard 落地:监控 UI + 数据层(store 合并 storage 骨架 + mock WS 血肉)+ 接真实 `as_workflow_state` + Hub 入口 | ✅ 合入 main(PR #52/#53) · Chrome 端到端验证 OK(2026-06-09) |
| **Plan 2** | 确定性编排骨架:bg 事件驱动状态机串 13 原子步(6 AUTO feature adapter + 7 HITL 人工卡点)+ 业务页 HITL 浮层(只读 storage 绕 CSP)+ WS 架子(不自启) | ✅ 合入 main(PR #54,--no-ff) · chrome e2e 延后到大脑搭完一起验 |
| **Plan 3** | model-agnostic LLM 大脑:WS 端到端管道 + 诊断器 self-heal(两红线+三分层) + overlay WF_START 启动入口 + 换模型验证 + 发版隔离 D(ws 按需连) | ✅ 四刀 + 收尾全合入 main(PR #57,--no-ff) |
| **HITL 回填打通 L3** | 激活回填型 HITL(步2 collect_dxm 填 skc / 步5 compare_1688 填 url1688 / 步6 order_1688 填 orderNo1688)→ 下游 AUTO 步拿到数据,打通端到端数据流 | ✅ 合入 main(PR #58 + 收尾 #59) · 子 agent review APPROVE |
| **大脑智能层扩展(2026-06-14)** | ①接真实模型容错+健壮性加固(jsonx 容错解析/传输瞬时重试/diagnoser 类型守卫/server to_thread,被 #63 随 v1.5.0 带入 main) ②回填提议(#66) ③不可逆复核(#67)。**大脑三判断点 = 诊断 self-heal / 回填提议 / 不可逆复核**,均不驱动流程、仅判断点辅助,大脑离线天然降级 | ✅ 全合入 main · 每刀 brainstorm→spec→plan→subagent-driven · 每任务两段 review + 最终整体 review + 合入前独立 PR review 全 APPROVE(最终 review 各抓 1 真缺陷) · node 117 / pytest 90 · 真模型端到端 e2e 仍人工 gated |

> **当前关卡 = chrome e2e 端到端验证**(task #30,照 `docs/superpowers/2026-06-13-l3-chrome-e2e-checklist.md` 跑,需起大脑 `python3 -m brain` + 测试商品 + 授权)——解锁发版 + 真实链路验证的唯一关卡,⚠ 验证通过前不推 tag。**现覆盖面已扩**:除 Plan2/3 骨架,还需验三判断点的真模型路径(诊断/回填提议/不可逆复核——单测只覆盖纯逻辑,WS 往返/overlay 渲染/三步真实编排只有 e2e 能验真;需配 `BRAIN_LLM_*` 真模型)。**⚠ 已叠 3 大脑刀于未验证骨架,roadmap 建议:下一步优先跑 e2e、勿再叠刀**(尤其可偏离——最危险、spec 说框架成熟后再上)。
> **后续刀**(spec §12,需 chrome e2e 验证基础 + brainstorming + 用户定优先级,勿在未验证基础上盲目摞):多变种 per-SKU 契约、~~大脑回填~~、~~不可逆复核~~、可偏离。
> **接真实模型加固(大脑基础健壮性)已实施**(2026-06-14,plan `docs/superpowers/plans/2026-06-14-brain-realmodel-hardening.md`,被 #63 随 v1.5.0 带入 main):此前 diagnoser 直接 `json.loads(model.decide())`,真实/本地模型脏输出(```围栏```/散文/大小写)解析失败→一律 escalate,self-heal 对真模型几乎永不生效。加固:新增 `brain/jsonx.py` 容错解析(剥围栏/抓平衡块/多决策块歧义→None,**真垃圾仍降级,绝不误读决策**)+ diagnoser 接 jsonx + action 类型守卫 + cause 透出 + model 瞬时类(429/5xx/timeout)有界重试·超界必抛 + 响应防御取值 + server 诊断 `asyncio.to_thread` 不冻结事件循环。**filler/reviewer 两刀复用此 jsonx 容错** —— 是三判断点真模型路径的公共基础。对抗 review 抓修 1 HIGH 回归(非 str action 崩 handler)。三不变量(不可逆永不重试/不确定→escalate/release ws 沉睡)。node/pytest 全绿。
> **不可逆复核已实施**(feature 分支 `feature/irreversible-review`,brainstorm→spec→plan→subagent-driven):大脑第三判断点——不可逆 AUTO 步(reversible===false:publish/gen_label/create_po/ship)执行前复核 product+页面快照→PASS 自动跑/HOLD 暂停转人工(确认提交/中止)。`brain/reviewer.py`(与 diagnoser/filler 并列,**fail-safe→hold 绝不假 PASS 放行不可逆**)+ WS `REVIEW_REQUEST`/`REVIEW_VERDICT` + engine `reviewGate` 钩子(run-auto 拦 adapter 前,阻塞 advance 等 verdict)+ overlay review-HITL(concerns+确认提交+中止)+ bg-entry 请求/响应关联。**降级**:大脑离线/超时/transport 失败→proceed(additive 不回归);**在线复核器失败→hold**(fail-safe)。三不变量(人工是不可逆动作最终授权 / fail-safe / 发版隔离 reviewGate 仅 automation 注入)。单元 node 115 / pytest 90 + 真 brain 进程 REVIEW 通道+fail-safe hold 冒烟。spec/plan:`docs/superpowers/{specs,plans}/2026-06-14-irreversible-review*`。⚠ **真模型端到端(配 BRAIN_LLM_* + chrome)仍人工 gated**,同 chrome e2e。
> **大脑回填(HITL 回填模型提议)已实施**(feature 分支 `feature/hitl-fill-brain-suggestion`,brainstorm→spec→plan→subagent-driven):通用 propose→verify 通道——回填型 HITL 步 pause 时大脑从 workflow 上下文 + 页面快照**提议**回填值,overlay 预填+🧠badge,人工复核确认才落 product(大脑永不自动 confirm/写 product)。`brain/filler.py`(与 diagnoser 并列,空提议红线绝不编造)+ WS `FILL_REQUEST`/`FILL_SUGGEST` + engine `onPaused` 钩子 + overlay 预填 + bg-entry 接线。三不变量(人工门唯一落 product / 绝不编造 / 发版隔离 JS 只动 automation)。单元 node 106 / pytest 79 + 真 brain 进程通道冒烟。spec/plan:`docs/superpowers/{specs,plans}/2026-06-14-hitl-fill-brain-suggestion*`。⚠ **真模型端到端(配 BRAIN_LLM_* + chrome)仍人工 gated**,同 chrome e2e。
> 注:原「Plan 4 = 编排大脑(Claude Agent SDK)」已被 Plan 3 取代——model-agnostic 颠覆「锁定单一家」决策(spec §11.1:编排框架自建模型无关 + LLM 后端可插拔 LiteLLM/OpenAI-compat)。

## 工作流隔离策略(2026-06-09 定)

dashboard 是长期开发任务,与原有 feature 的**日常修改 + 打 tag 发版是两条并行线**。隔离原则,确保 dashboard 调试**永不影响原有插件发版**:

### 1. 分支策略
- **Plan 1 合入 main**;后续 Plan 2/3/4 **各走独立 `feature/` 分支**,做完一个 review 合一个。调试中间态永不进 main → main 始终保持「可随时发版」状态。

### 2. 并行工作目录
- 原有插件的并行优化 **用独立 `git worktree` 从 main 切**,与 dashboard 工作目录物理隔离(见项目 `CLAUDE.md`「多 Agent 并发开发硬约束」)。两条线各自 build 互不覆盖(`dist/` 是 gitignored)。

### 3. 发版零影响(release 与 main 字节级零差异 — 已逐文件核实 + CI 实证)
dashboard 是 **dev-only** 半成品。Plan 1 对 main 的侵入面仅 6 个非测试文件,release 路径下全部无害:

| 文件 | 改动 | release 路径下的实际影响 |
|------|------|------------------------|
| `core/manifest.template.json` | +CSP | `_strip_csp_for_release` 剥掉 → 与 main 零差异 |
| `build/package_all.py` | +三个剥离函数 | 仅 release 跑,幂等,6 个单测护(`test_strip_dashboard.py`) |
| `build/build_extension.py` | +拷 dashboard | 仅 dev build;release 走 package_all 剥离 |
| `core/background/service-worker.js` | +`OPEN_MONITOR` 分支 | 纯新增分支,不动现有路由;触发源(Hub 按钮)dev-only |
| `core/content/registry.js` | +`openMonitor` 方法 | 纯新增 API,无人调用 |
| `core/content/ui.js` | +Hub 入口 | `isDev` 守卫,release(`isDev=false`)按钮不渲染、监听不挂 |

- `package_all.py` 三个剥离函数(均幂等):`_strip_dashboard_for_release`(删 dashboard 目录)+ `_strip_windows_permission_for_release`(manifest 去 windows perm)+ `_strip_csp_for_release`(manifest 去 CSP)。
- service-worker/registry/ui.js 在 release 里是 **dead code**(纯增量分支 + isDev 守卫,现有 feature 加载时不触发)。
- **CI 隔离**:`.github/workflows/build-windows.yml` 触发条件是 `tags: v*` + `workflow_dispatch`,**feature 分支 push 根本不碰 CI**。dashboard 调试期推多少 commit 都不触发发版打包。
- **结论**:原有插件从 main 切 fix 分支改 + 打 tag 发版,产物与 main 基线一致,完全不受 dashboard 影响。
- **CI 实证**(2026-06-09,run 27192669731,workflow_dispatch):build 阶段 dashboard 进 dist(17 files)→ package 阶段三剥离打印全部出现(`dashboard/` 目录 + windows permission + content_security_policy 均移除);产物 ~27MB 与 v1.4.2 基线持平;未创建 release(workflow_dispatch 守卫生效)。理论 + 单测论证已升级为 **CI 实测确认**。

### 4. dashboard 转正纳入发版(未来)
删 `package_all.py` 三个剥离调用 + 去 `ui.js` 的 `isDev` 守卫即可(详见根 `CLAUDE.md`「dashboard 发版隔离」段)。

## 业务流真实顺序(2026-06-09 用户对齐 — 已 resolve)

运营真实流程(用户原话,9 步,**先上架 → 后采购,以返单价驱动比价采购**):

1. **Temu 选品** —— 在 Temu 比对找高潜商品
2. **店小秘采集 + 编辑发布** —— 采集高潜商品信息,编辑后发布(到 Temu)
3. **获取返单价** —— 发布成功后在 Temu 商家中心获取平台返单价
4. **1688 以图搜图比价** —— 根据返单价到 1688 以图搜图找同类商品比价
5. **1688 下单采购** —— 核价通过且符合要求的商品在 1688 下单
6. **维护货号 + 标签 + 合规** —— 在商家中心维护货号、生成标签、填合规信息、上传标签图(**所有商品必经**)
7. **店小秘创建采购单** —— 在店小秘走采购单创建流程
8. **等财务付款** —— 等待财务付款(HITL / 外部)
9. **到货后自动发货** —— 等商品到货后走自动发货

**关键决策(都已拍板)**:
- 顺序 = **先上架后采购**(否决早期"先采购后上架"推测);采购由"返单价 → 1688 比价核价"驱动(步骤 3-5)。
- auto_gen_label 合规填写 + 标签图 = **所有商品必经**(步骤 6,编排里是固定环节,不按品类分支)。
- 首版范围 = **整条端到端**(不先聚焦单段),Plan 2+ 按完整 9 步主线设计编排骨架。

> **待 Plan 2 spec 做实**:9 步 ↔ 现有 feature 的精确映射、缺口环节(步骤 1 选品决策 / 步骤 3 返单价获取 / 步骤 4-5 比价核价+1688 下单 / 步骤 8 付款)的「HITL vs 新建 feature」归属。详见 spec §9.1。
