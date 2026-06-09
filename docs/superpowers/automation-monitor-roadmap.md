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

### 3. 发版零影响(release 与 main 字节级零差异 — 已逐文件核实)
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

### 4. dashboard 转正纳入发版(未来)
删 `package_all.py` 三个剥离调用 + 去 `ui.js` 的 `isDev` 守卫即可(详见根 `CLAUDE.md`「dashboard 发版隔离」段)。

## 待对齐(阻塞真实环节落地,不阻塞 dashboard 本身开发)

业务流真实顺序未对齐 —— 采购排在上架前还是后?「上架」对应哪个 feature?合规填写是否必经环节?
详见 spec §9.1。Plan 2 起涉及真实环节编排时必须先对齐。
