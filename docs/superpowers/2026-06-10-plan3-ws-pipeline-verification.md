# Plan 3 第一刀 WS 端到端管道 — 验证说明

> 配套 plan `docs/superpowers/plans/2026-06-10-plan3-ws-pipeline.md`、spec `docs/superpowers/specs/2026-06-10-plan3-llm-brain-design.md`。
> 本刀 = **管道结构就位**：大脑 server 可起 / bg 可连可上报 / dashboard 可收可显 / 协议对齐 / 降级保留。

## 一、自动化验证（已跑，可复现）

| 项 | 命令 | 结果 |
|----|------|------|
| protocol 编解码单测 | `python3 -m pytest tests/test_brain_protocol.py -v` | 7 passed |
| server 集成单测（PING→PONG / STEP_RESULT→BRAIN_EVENT broadcast） | `python3 -m pytest tests/test_brain_server.py -v` | 2 passed |
| 全量 Python 回归 | `python3 -m pytest tests/` | 29 passed |
| 全量 JS 回归 | `node --test tests/*.test.js` | 64 pass / 0 fail |
| bg SW + ws-client 语法 | `node --check core/background/service-worker.js && node --check core/background/ws-client.js` | exit 0 |
| dev build 不回归 | `python3 build/build_extension.py` | 8 features / 14 content scripts |
| server 启动冒烟 | `timeout -s INT 2 python3 -m brain` | 打印 `starting...`→`stopped.`，无报错 |

> ⚠ JS 测试命令必须用 `node --test tests/*.test.js`（不是整目录；整目录会把 pytest `.py` 当 JS 解析失败）。
> ⚠ websockets 装在 PEP 668 externally-managed 环境需 `pip install -r brain/requirements.txt --break-system-packages`。

## 二、chrome 端到端冒烟（留「大脑一起验」，本刀不强跑）

前置：`pip install -r brain/requirements.txt --break-system-packages`；`python3 build/build_extension.py`。

1. **起大脑**：`python3 -m brain` → 打印 `brain WS server starting on ws://localhost:8787 ...`
2. **bg 连上**：`chrome://extensions` reload 扩展 → 打开 SW console（扩展卡片「Service Worker」链接）应见 `[orch-ws] live`（ws-client 自启连上大脑）
3. **dashboard 灯 live**：Hub「打开监控」开 dashboard → 顶栏 WS 灯应变 **live**（不再 mock 回放；ws-source onopen 发 `HELLO{role:dash}`）
4. **STEP_RESULT → BRAIN_EVENT**：SW console 跑一条 workflow（`orchStartWorkflow({label:'测试'})`，或用 PR #55 验证手册的 `verifyStep(cursor)`）→ dashboard 大脑流应**增量**出现 `step <id> → <status>` 的 `log` 类 BRAIN_EVENT
5. **降级验证**：关 server（Ctrl-C）→ SW console `[orch-ws]` 状态转 offline/重连；dashboard 灯回 **offline** + 恢复 mock 回放（ws-source `onclose→fallback`）

## 三、本刀边界 / 下一刀

本刀只做**单向上报 + broadcast 的管道连通**，**不含**：模型抽象层 / 诊断器 / error hook / overlay 启动入口 / STATE_PATCH 回填。

- **下一刀（第二刀）**：诊断器 + error hook + STATE_PATCH 闭环（self-heal）—— spec §6。
- **发版隔离待办**（Plan 3 合 main / 发版前必处理）：bg ws-client 自启破坏了 Plan 2「release ws 沉睡」，员工机无大脑会一直退避重连（无害但不该有）。处理类比 dashboard 剥离：`package_all.py` 加 strip 移除 `startWsClient(...)` 自启行 / 注入 dev 守卫。spec §12。
