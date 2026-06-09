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
| dashboard 运行时结构 + 发版隔离机制 + openMonitor API | 根 `CLAUDE.md`「监控 dashboard」段 +「dashboard 发版隔离」段 |
| UI 视觉真源(自包含单文件,浏览器可直接开) | `ui-prototype/dashboard.html` |

## Plan 进度

| Plan | 范围 | 状态 |
|------|------|------|
| **Plan 1** | dashboard 落地:监控 UI + 数据层(store 合并 storage 骨架 + mock WS 血肉)+ 接真实 `as_workflow_state` + Hub 入口 | ✅ 代码完成 · Chrome 端到端验证 OK(2026-06-09)· 合入 main |
| **Plan 2** | storage 写入层 + 业务页就地 HITL 浮层(只读 storage,绕 CSP) | 待写 spec/plan |
| **Plan 3** | WebSocket client(扩展 background ↔ localhost WS)+ 大脑事件端到端 + MV3 SW 保活实测 | 待写 spec/plan |
| **Plan 4** | 编排大脑(外部 Claude Agent SDK 进程)+ 现有 feature 改造为「可调用工具」 | 待写 spec/plan |

> Plan 2-4 范围为暂定方向,以后续各自 spec 为准。

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
