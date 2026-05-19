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
├── <feature>/                       # 每个 feature 一个自治目录（当前：auto_gen_label/）
│   ├── feature.json                 # feature 元数据
│   ├── content/index.js             # feature 业务代码
│   ├── native_host/                 # 本地资源端（如该 feature 需要）
│   ├── build/                       # feature 内部构建（如 PyInstaller 打 EXE）
│   ├── samples/                     # 调试辅料（DOM 抓取、日志样本等）
│   └── CLAUDE.md                    # feature 自己的文档
├── build/                           # 顶层构建脚本
│   ├── build_extension.py           # 全量构建：扫 feature.json + 拷文件 + 拼 manifest → dist/extension/
│   ├── dev.py                       # watch 模式（日常开发跑这个）
│   ├── package_all.py               # 串联：extension dist + native_host EXE + 员工部署包
│   └── requirements-dev.txt         # watchdog
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
| `native_host` | 关联 native host 名（可选） |

**当前 feature 列表**：用 `ls */feature.json` 自查（不在此文档硬列，避免多 worktree 并行加 feature 时冲突）。

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
};
```

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

## Build Commands

```
# 首次配置（一次性）
pip install -r build/requirements-dev.txt      # 仅装 watchdog
python build/build_extension.py                # 全量构建 → dist/extension/
# chrome://extensions → 加载已解压扩展程序 → dist/extension/

# 日常开发
python build/dev.py                            # 启动 watch；改源码自动同步到 dist
# 改完后切 chrome → 点扩展卡片右下角 reload → 看效果

# 出员工部署包
python build/package_all.py                    # 含 extension + EXE + install.bat（Windows 上跑）
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

   "core 不够用"的信号：
   - 需要新的全局 utility
   - 需要新的 native action 路由类型
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
   - 建 `<your_feature>/` 目录 + `feature.json` + `content/index.js`
   - 跑 `python build/dev.py` 开始调试
   - feature 内部改动不会和其它 feature worktree 冲突

**反模式**：跳过第 2-3 步，在 feature 分支内同时改 core 和 feature 代码。会让 core 改动被夹带在 feature PR 里，其他 worktree 拿不到 core 升级。

## Worktree 物理注意点

1. **每个 worktree 各自的 dist/**：`dist/` 是 gitignored，物理隔离。Chrome 一次只能加载一个 `dist/extension/`，谁要调试就让 chrome 指向谁的 worktree。
2. **Native host 注册表是全局的**：Windows 注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\<host_name>` 只能指向一个 EXE。多 worktree 同时调试 native_host 需协调（跑各自的 `dev_install.bat` 切换）。这是 Chrome Native Messaging 的限制，与架构无关。
3. **多个 `dev.py` 同时运行无冲突**：watchdog 不占端口。

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
| `GET_STATUS` | 查 native port 连接状态 |

新加 action 时同时改 `core/background/service-worker.js` 和 `<feature>/native_host/main.py` 的 handle 分发。

## Deployment

员工机器一键安装包：跑 `build/package_all.py` 出 `dist/TemuLabel_Setup/`，内含：

```
TemuLabel_Setup/
├── TemuLabelHost.exe         # PyInstaller 单文件
├── install.bat               # 注册 Native Host 到 HKCU 注册表
├── com.temu.label_host.json
└── extension/                # 用户 chrome 加载这个
```

Release 版会自动把 feature 内 `const TAL_DEBUG = true;` 替换为 `false;`（关闭调试面板）。

## 关键文档

- 设计 spec：`docs/superpowers/specs/2026-05-19-extension-multi-feature-architecture-design.md`
- 实施 plan：`docs/superpowers/plans/2026-05-19-extension-multi-feature-refactor.md`
- 各 feature 实现细节：见各自 `<feature>/CLAUDE.md`
