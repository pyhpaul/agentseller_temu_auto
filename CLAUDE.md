# AgentSeller for Temu — 多 Feature Chrome 插件

## Project Overview

Chrome 插件 + Python Native Host 组合，自动化 Temu 商家中心的多项操作。
架构层级：**公共骨架（FAB / Panel / Hub / Native Messaging）+ 多个独立 feature**。
当前 feature：`auto_gen_label`（标签生成 + 合规填写 + 标签主图插入）。

## Architecture

```
agentseller_temu/
├── core/                            # 公共骨架源码
│   ├── manifest.template.json       # MV3 manifest 模板（含 __PERMISSIONS__/__HOST_PERMISSIONS__/__CONTENT_SCRIPTS__ 占位符）
│   ├── background/service-worker.js # native port 管理 + 消息透传路由
│   ├── content/
│   │   ├── utils.js                 # 公共工具（挂 window.__AgentSellerUtils）
│   │   ├── ui.js                    # FAB / Panel / Hub UI 构建（挂 window.__AgentSellerUI）
│   │   ├── registry.js              # feature 注册中心 + window.AgentSeller 公开 API
│   │   └── core.js                  # 装配入口（manifest 内排在最后一个 core 文件）
│   ├── popup/{popup.html, popup.js}
│   └── icons/icon{16,48,128}.png
├── native_host/                     # 顶层共享 Python Native Host（所有 feature 共用唯一 host com.temu.label_host）
│   ├── main.py                      # 薄入口：Native Messaging 协议 IO + DISPATCH 表按 action 分发
│   ├── file_ops.py                  # 通用文件能力 + 文件/文件夹对话框（read/write_file_chunk / pick_file / pick_folder）
│   ├── handlers/                    # feature 专属、依赖重的 handler
│   │   └── bartender.py             # auto_gen_label 专属 generate_label（pythonnet + BarTender，Windows-only，惰性 import）
│   ├── com.temu.label_host.json     # native messaging host manifest（含 PLACEHOLDER）
│   ├── install.bat / dev_install.bat# 部署期 / 开发期注册到 HKCU
│   ├── requirements.txt
│   ├── resources/                   # 静态资源（background.png 等）
│   └── build/build.bat              # PyInstaller 打 TemuLabelHost.exe（输出落 native_host/）
├── features/                        # 所有 feature 集中在此目录下
│   └── <feature>/                   # 每个 feature 一个自治子目录（如 auto_gen_label/）
│       ├── feature.json             # feature 元数据
│       ├── content/index.js         # feature 业务代码
│       ├── samples/                 # 调试辅料（DOM 抓取、日志样本等）
│       └── CLAUDE.md                # feature 自己的文档
├── build/                           # 顶层构建脚本
│   ├── build_extension.py           # 全量构建：扫 features/*/feature.json + 拷文件 + 拼 manifest → dist/extension/
│   ├── dev.py                       # watch 模式（日常开发跑这个）
│   ├── package_all.py               # 串联：extension dist + native_host EXE + 员工部署包
│   ├── inject_version.py            # CI 用：从 git tag 解析版本号写入 installer.iss
│   └── requirements-dev.txt         # watchdog
├── .github/workflows/
│   └── build-windows.yml            # CI：tag 触发 windows-latest 打包 + 出 release
└── dist/                            # 构建产物（gitignored）
    ├── extension/                   # chrome 加载点
    └── TemuLabel_Setup/             # 员工部署包（含 extension + EXE + install.bat）
```

## Feature 注册契约

每个 feature 根目录放 `feature.json`：

```json
{
  "id": "auto_gen_label",
  "icon": "🚀",
  "label": "标签生成",
  "locked": false,
  "order": 1,
  "content_script": "content/index.js",
  "host_permissions": ["https://seller.temu.com/*", "https://*.temu.com/*"],
  "permissions": ["nativeMessaging"],
  "native_host": "com.temu.label_host"
}
```

| 字段 | 含义 |
|------|------|
| `id` | feature 唯一标识；必须等于目录名 |
| `icon` / `label` | Hub 网格图标和文字 |
| `locked` | 占位（开发中），Hub 灰显不可点 |
| `order` | Hub 网格排序权重，升序 |
| `content_script` | 相对 feature 目录的业务 content script |
| `host_permissions` / `permissions` | 构建时聚合去重写入 manifest |
| `native_host` | 信息性字段：所有 feature 共用唯一 core host `com.temu.label_host`（顶层 `native_host/`）。当前 build / package 脚本**不读此字段**，仅作文档标注 |

**当前 feature 列表**：用 `ls features/*/feature.json` 自查（不在此文档硬列，避免多 worktree 并行加 feature 时冲突）。

## Core API（feature 业务可调用）

`window.AgentSeller`（由 `core/content/registry.js` 注入，在 feature 脚本执行前已就绪）：

```js
window.AgentSeller = {
  registerFeature({ id, icon, label, locked, init, render }),
  onPageChange(cb),                       // 注册 URL 变化监听
  showToast(msg, type),                   // 全屏 toast
  utils: {                                // 公共工具集
    sleep, ensureExtensionAlive, waitForEl, normText,
    findByText, setInputValue, showToast, makeDraggable,
  },
  sendNative(action, data),               // 透传到 service worker → native host
  openFeature(fid),                       // 程序化展开 Panel + 切到指定 feature view（reload 自动续跑场景常用）
};
```

**构建信息注入**：build 时 `build_extension.py` 生成 `dist/extension/content/build-info.js`，注入 `window.__AS_BUILD_INFO__ = { ts, isDev: true, version: 'dev' }`。Panel 标题栏：
- `isDev=true`：显示 `dev:<ts>` 灰色小字（判断 Chrome 是否真 reload 了新版）
- `isDev=false` + `version`：显示 `v<version>`（员工自助查当前装的版本号）

`package_all.py` 在 release 时双重 string replace：`isDev: true → false` + `version: 'dev' → '<MyAppVersion>'`（从 `deploy/installer.iss` 读取，CI 流程下该值已被 `inject_version.py` 改成 tag 版本号）。

**manifest.json version 注入**：`chrome://extensions` 扩展卡片显示的版本号来自 `dist/extension/manifest.json` 的 `version` 字段。`manifest.template.json` 硬编码 `1.0.0`，`build_extension.py` 直接透传 —— 所以 **dev 阶段卡片恒显 1.0.0**（dev 无版本号语义，靠 panel 的 `dev:<ts>` 区分）。release 时 `package_all.py` 的 `_set_manifest_version_for_release()` 从 `installer.iss` 读 `MyAppVersion`，经 `normalize_manifest_version()` 清洗后写入 manifest。

> ⚠️ **版本号显示有两条独立链路**（build-info → panel 标题栏；manifest → 扩展卡片），都只在 release 路径注入、互不依赖。**改动任一处版本号逻辑时必须同步另一处**，否则会重现「panel 显示新版本但扩展卡片停在 1.0.0」这类不一致。
>
> Chrome manifest `version` 只接受 **1-4 段点分整数、禁止后缀**；`MyAppVersion` 的 `-rc.N` / `-dev.sha` / `-N-gsha` 后缀会让扩展加载失败，故 `normalize_manifest_version()` 截首个 `-` 之前并校验。副作用：rc 包卡片显示去后缀版本（如 `1.2.3`），panel 仍显示完整 `v1.2.3-rc.4`，此为 Chrome 硬限制，rc 不发员工故可接受。

Feature 注册示例（feature 内部）：

```js
window.AgentSeller.registerFeature({
  id: 'my_feature',
  icon: '🚀',
  label: '功能名',
  init() {
    window.AgentSeller.onPageChange((href) => { /* 页面变化处理 */ });
  },
  render(viewEl) { /* 渲染 feature view */ },
});
```

`setStatus` / 商品状态等具体 feature 状态归 feature 内部实现，不在 core API。

## 工作流约定（开发 → PR → 发版）

> **通用三路径协议 + 触发词约定见 `~/.claude/rules/shipping-rules.md`**「Three Execution Paths」/「User Trigger Words」/「Hard Bans on Autonomous Escalation」/「Release Tag Decision Protocol」段。本节只写本项目特有的具体命令和细节。

### 本地验证路径（最常用）

用户说「本地验证一下」/「快速测试」/「先本地跑跑」等触发词时：

1. `python3 build/build_extension.py` 全量构建到 `dist/extension/`
2. 提示用户去 `chrome://extensions` 点扩展卡片右下角 reload
3. 用户在 Temu 商家中心验证；panel 标题栏右上角 `dev:<ts>` 灰色小字可确认 Chrome 是否真 reload 了新版
4. **不开 PR、不推 tag、不触发 CI**

如果改动只在某个 feature 内，且 watchdog 已装，可推荐 `python3 build/dev.py` watch 模式自动同步。但通常一次性 build 更稳。

### PR 路径

用户验证通过说「提 PR」/「提交」时：

1. `git switch -c feature/<topic>` 或 `fix/<topic>`
2. 精确暂存（不要 `git add .`），commit message 走 `<type>(<scope>): <summary>` + Why/What/Test
3. `git push -u origin <branch>` + `gh pr create`
4. 用户说「merge」→ `gh pr merge <N> --squash --delete-branch` + `git fetch + switch main + pull --ff-only`

### Release 路径（推 tag 触发 CI）

用户说「发版」/「打 tag」时：

1. **必须先看上次 tag**：`git tag --sort=-v:refname | head -3`
2. **本项目 tag 规则**：
   - `vMAJOR.MINOR.PATCH` 正式发布（员工部署）
   - `vX.Y.Z-rc.N` CI 端到端验证用（**不发员工**——Inno Setup 升级识别只看数字段，带后缀会让员工机器升级时弹「已安装相同版本」）
   - 首发版本从 `v1.0.1` 起步（现有员工注册表 DisplayVersion 都是 1.0.0）
3. **风险改动 / MAJOR / MINOR 强制先推 rc**；PATCH 类小修复可以直接推正式 tag
4. `git tag vX.Y.Z && git push origin vX.Y.Z`
5. `gh run watch <id> --exit-status`（后台监控 CI），跑完把 release URL 直接发给用户

完整 tag 命名规则 + 升级语义见 `生产环境使用指导.md` A.7。

### Agent 主动提醒边界

- 本地验证通过 → 问一次「本地 OK 了，要开 PR 吗？」
- PR merged → 问一次「要打 tag 发版吗？」
- 用户说「暂不」/「下次」 → 不再追问

## Build Commands

```
# 首次配置（一次性）
pip install -r build/requirements-dev.txt      # 仅装 watchdog
python build/build_extension.py                # 全量构建 → dist/extension/
# chrome://extensions → 加载已解压扩展程序 → dist/extension/

# 日常开发
python build/dev.py                            # 启动 watch；改源码自动同步到 dist
# 改完后切 chrome → 点扩展卡片右下角 reload → 看效果

# 出员工部署包（Windows 上跑；部署细节见 Deployment 段）
python build/package_all.py                    # extension + EXE + install.bat + Inno Setup 一键 installer
```

`build_extension.py` 同时给每个 .js 文件末尾注入 `//# sourceURL=<src 相对路径>`，DevTools 的 Sources 面板和 console 日志按源码路径展示，调试体验与"chrome 直接加载源目录"等价。

## 新增 Feature 标准工作流（worktree 友好）

> **重要**：开新 feature **之前**按这个顺序走，避免后续 worktree 互相冲突。

1. **Pull main**
   ```
   git fetch origin --prune
   git switch main
   git pull --ff-only origin main
   ```

2. **评估 core API 是否覆盖你的需求**
   检查 `core/content/registry.js`（`window.AgentSeller`）、`core/content/utils.js`、`core/background/service-worker.js` 是否够用。
   **native 能力看顶层共享 `native_host/`（main.py 的 `DISPATCH` + file_ops.py），不要自建 feature-local native_host**；缺通用 action 时扩展共享层，feature 专属重依赖 handler 放 `native_host/handlers/`。

   "core 不够用"的信号：
   - 需要新的全局 utility
   - 需要新的 native action 路由类型（在共享 `native_host/` 加，不在 feature 内）
   - 需要在 Hub 上加新交互
   - 需要 `registerFeature` 接受新字段

3. **如果 core 需要扩展，先做 core PR**
   - 开 `feature/core-<purpose>` 分支
   - 只改 core，不带 feature 业务
   - PR 合入 main
   - **然后才进入下一步**

4. **开 feature 分支或 worktree**
   ```
   git switch -c feature/<your_feature>
   # 或 worktree:
   git worktree add ../wt-<your_feature> -b feature/<your_feature>
   ```

5. **在 feature 目录内开发**
   - 建 `features/<your_feature>/` 目录 + `feature.json` + `content/index.js`
   - 跑 `python build/dev.py` 开始调试
   - feature 内部改动不会和其它 feature worktree 冲突

**反模式**：跳过第 2-3 步，在 feature 分支内同时改 core 和 feature 代码。会让 core 改动被夹带在 feature PR 里，其他 worktree 拿不到 core 升级。

## 多 Agent 并发开发硬约束

当**第二个及以后**的 agent 在本项目开发时，**必须**先建 worktree，禁止共用同一工作目录。否则一个 agent 的中间状态（如未完成的 `feature.json`）会破坏其他 agent 的 build。

### 启动新 agent 之前的强制步骤

```bash
git fetch origin --prune
git switch main && git pull --ff-only origin main
git worktree add ../wt-<feature_or_task_name> -b feature/<branch_name>
# 在 ../wt-<feature_or_task_name>/ 内启动新 agent
```

### 物理隔离边界

| 项 | 隔离状态 | 说明 |
|----|---------|------|
| 源码 / feature 目录 | ✓ worktree 各自一份 | feature.json / content/*.js 互不可见 |
| `dist/extension/` 输出 | ✓ 各自构建互不覆盖 | `dist/` 是 gitignored |
| `build_extension.py` 扫描范围 | ✓ 只扫本 worktree 的 `features/*/feature.json` | 失败也不连累其他 worktree |
| 多个 `dev.py` 并行 | ✓ 无冲突 | watchdog 不占端口 |
| Chrome Extension 加载点 | ✗ 全局唯一 | 一次只能加载一个 worktree 的 dist，调试时轮流 |
| Windows Native Host 注册表 | ✗ 全局唯一 | native host 现为顶层共享 `native_host/`（所有 feature 共用 `com.temu.label_host`）；`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.temu.label_host` 只能指向一个 EXE，多 worktree 同时调试 native 需轮流跑各自 `native_host/dev_install.bat` |

### 未完成 feature 的提交约束（避免连累他人 build）

- `feature.json` 一旦出现在某目录下，`build_extension.py` 就当生效 feature 处理
- **声明的 `content_script` 文件未建好之前，禁止提前在工作目录创建 `feature.json`**
- 否则任何人（含其他 worktree 的 agent）跑全量 build 都会 hard fail
- 而 `build_extension.py` 每次 build 先 `clean_dist` 清空整个 `dist/`，**失败的 build 会留下空 dist 目录**（连本 worktree 上次成功的产物也没了）
- 安全做法：feature 业务代码完整可跑后，才把 `feature.json` 一并落地

## Native Messaging Protocol

Chrome 插件与 Native Host 之间通过 stdin/stdout 通信：4 字节小端序长度前缀 + UTF-8 JSON。

Feature 业务调用：

```js
const result = await window.AgentSeller.sendNative('PROCESS_LABEL', { ... });
// sendNative 已剥外层 success 包装；result 是 native_host 返回的 dict（含 result.success 字段）
if (!result.success) throw new Error(result.error);
```

Service worker 内的 action 路由清单（`core/background/service-worker.js`）：

| Action (msg.type) | 作用 |
|------|------|
| `PROCESS_LABEL` | BarTender 生成标签 PDF + PNG |
| `PICK_FILE` | 文件选择对话框 |
| `PICK_FOLDER` | 文件夹选择对话框 |
| `READ_FILE` | 读完整文件 base64 |
| `READ_FILE_SIZE` | 取文件大小 |
| `READ_FILE_CHUNK` | 分块读取（>1MB 文件用） |
| `SAVE_FILE_CHUNK` | 分块写文件到任意绝对路径（`READ_FILE_CHUNK` 的反向；入参 path/data(base64)/offset/done，offset=0 截断创建，其余按位置写） |
| `GET_STATUS` | 查 native port 连接状态 |

新加 action 时同时改 `core/background/service-worker.js`（msg.type 路由）和顶层共享 `native_host/`：通用文件能力加到 `native_host/file_ops.py` 并挂进 `main.py` 的 `DISPATCH` 表；feature 专属、依赖重的 handler 放 `native_host/handlers/<feature>.py` 并在 `main.py` 里惰性 import。

### service-worker.js 的两类职责：透传 vs feature 编排

`core/background/service-worker.js` 除上面的「native messaging 透传 / 文件能力路由」外，还可承载 **feature 专属的跨 tab 编排逻辑**——以文件内标记段形式存在（`// ── <feature> ── … // ── end <feature> ──`），`image_search_1688`、`create_purchase_order` 为例。

**何时把逻辑放 background**：feature 需要「跨多个 tab/域名按序操作」（开/关 tab、等加载、发命令、收数据、再下一步）时——只有 service worker 跨 tab 存活。此时模式是：

- **background = 编排大脑**：线性 `await` 序列；进度/状态写 `chrome.storage.local`（单一状态源），不绑定某个 origin tab。
- **content script = 命令处理器**：每页只暴露 `chrome.runtime.onMessage` 命令分发（不自驱），收 bg 命令 → 操作本页 DOM → 回传。
- **面板/UI = 订阅 storage**：`chrome.storage.onChanged` 跨 tab 同步，任何 tab 打开都看到同一份状态。

跨 tab 编排的踩坑与最佳实践（前台渲染 / beforeunload 抑制 / 构造 URL 替代被拦截的 `_blank` 点击 / 关 tab 重开替代 in-page 导航 / Beast UI vs Ant Design Vue 的选择器差异等）见 `features/create_purchase_order/CLAUDE.md`——**做横跨 Temu 商家中心 + 店小秘的新 feature 前必读**。

## Deployment

**首选：CI 自动打包**（`.github/workflows/build-windows.yml`）。推 `v*` tag 触发，windows-latest runner 跑 `inject_version.py` + `package_all.py`，产物作为 GitHub Release 资产；workflow_dispatch 手动触发上传 artifact 不创建 release。版本号由 tag 自动注入 `deploy/installer.iss`。**Tag 命名规则 + 升级语义见 `生产环境使用指导.md` A.7**。

**备用：本地手动打包**（Windows 机器）：跑 `python build/package_all.py`（命令见 [Build Commands](#build-commands) 段）。产物：

- `dist/TemuLabel_Setup/` — 旧版手动部署目录（保留兼容，员工解压后跑 install.bat）
- `dist/TemuLabelSetup.exe` — 新：员工双击单文件，Next/Next/Finish 完成 native host 注册并提示加载 Chrome 扩展（约 30–40 MB）

手动部署目录结构：

```
TemuLabel_Setup/
├── TemuLabelHost.exe         # PyInstaller 单文件
├── install.bat               # 注册 Native Host 到 HKCU 注册表
├── com.temu.label_host.json
└── extension/                # 用户 chrome 加载这个
```

Inno Setup 一键 installer：

- 脚本位置：`deploy/installer.iss`
- 打包人首次需在 Windows 上装 [Inno Setup 6.x](https://jrsoftware.org/isdl.php)（免费）
- 安装后 `ISCC.exe` 默认在 `C:\Program Files (x86)\Inno Setup 6\`，`package_all.py` 自动检测调用
- **Linux 上跑 `package_all.py` 会跳过 setup.exe 这一步并打印警告，其他流程不变**
- installer 在 `[Run]` 段直接用 PowerShell + `reg.exe` 完成 native host 注册（等价于 install.bat 但不调用原 .bat，避免 `pause` 阻塞），Finish 页弹出引导对话框并提供「打开 chrome://extensions」按钮
- 卸载时 `[UninstallRun]` 自动清理 HKCU 注册表项

Release 版会自动把 feature 内 `const TAL_DEBUG = true;` 替换为 `false;`（关闭调试面板）。

## 关键文档

- 设计 spec：`docs/superpowers/specs/2026-05-19-extension-multi-feature-architecture-design.md`
- 实施 plan：`docs/superpowers/plans/2026-05-19-extension-multi-feature-refactor.md`
- 各 feature 实现细节：见各自 `<feature>/CLAUDE.md`
