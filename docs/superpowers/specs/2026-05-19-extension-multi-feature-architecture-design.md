# Extension 多 Feature 架构重构 — 设计文档

- 日期：2026-05-19
- 范围：把 `auto_gen_label/` 内的 chrome 插件管理上提到项目根，建立"公共骨架 + 多 feature"的可扩展架构
- 状态：设计稿，待 review

---

## 1. 背景与现状

当前项目根目录下只有一个 `auto_gen_label/` 目录，里面同时承载了：

- `extension/` — Chrome MV3 插件（manifest、background service worker、content script、popup、icons）
- `native_host/` — Python 本地资源操作端（BarTender SDK、文件对话框）
- `build/` — 打包脚本
- 一批调试辅料（`html.txt` / `*.txt` / `background.png` / `*.log` 等）

`extension/content/content-script.js` 单文件 1900 行，内部已经实现了 FAB（浮动图标）、Panel、Hub 视图、Feature 视图、`FEATURES` 注册表，并把 `auto_gen_label` 这一个 feature 内部的 3 个 Phase（标签生成、合规信息填写、标签主图插入）混在同一个文件里。

**问题**：

1. 公共骨架（FAB/Panel/Hub/Native Messaging）和 feature 业务代码物理上混在一起，新加 feature 必然在主文件内追加代码，扩展性差
2. `FEATURES` 数组和 content script 单文件结构导致多 feature 并行开发**必然产生 git 冲突**
3. 顶层目录缺少架构性 CLAUDE.md，所有项目信息都在 feature 内部

---

## 2. 设计目标

1. **公共服务层抽出**：FAB / Panel / Hub / 消息路由 / 通用 utils 从 feature 中剥离，由顶层维护
2. **Feature 自治**：每个 feature 一个根目录文件夹，包含 chrome 端代码 + 本地资源端（如需要）+ 构建脚本 + 调试辅料 + 文档
3. **添加新 feature = 新建一个目录**：无需修改公共骨架、无需手改 manifest、无需在中心注册表登记
4. **多 feature 并行开发尽量 0 冲突**：通过约定式注册和构建产物隔离消除中心化资源
5. **调试体验不下降**：相比当前架构（chrome 直接加载 extension/），DevTools 的源码路径和断点体验必须等价
6. **文档分层**：顶层 CLAUDE.md 描述架构和工作流，每个 feature 自带 CLAUDE.md 描述自身实现细节

---

## 3. 整体目录结构

```
agentseller_temu/
├── CLAUDE.md                        # 顶层架构 / 工作流 / 构建命令
├── .gitignore                       # 包含 dist/
├── core/                            # 公共骨架源码
│   ├── manifest.template.json       # manifest 模板，构建时填充
│   ├── background/
│   │   └── service-worker.js        # native port 管理 + 消息路由（action 透传）
│   ├── content/
│   │   ├── core.js                  # 入口，初始化骨架并暴露 window.AgentSeller
│   │   ├── ui.js                    # FAB / Panel / Hub UI 构建
│   │   ├── registry.js              # feature 注册 API
│   │   └── utils.js                 # 公共工具（见 §6）
│   ├── popup/
│   │   ├── popup.html
│   │   └── popup.js
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── auto_gen_label/                  # feature 1：自治目录
│   ├── CLAUDE.md                    # 本 feature 文档（Phase 1/2/3、BarTender SDK、Temu 选择器）
│   ├── feature.json                 # feature 元数据（见 §5）
│   ├── content/
│   │   └── index.js                 # 业务（registerFeature 调用 + Phase 1/2/3 流程）
│   ├── native_host/                 # 本地资源操作端
│   │   ├── main.py
│   │   ├── bartender_handler.py
│   │   ├── file_dialog.py
│   │   ├── com.temu.label_host.json
│   │   ├── install.bat
│   │   ├── dev_install.bat
│   │   ├── requirements.txt
│   │   └── resources/
│   ├── build/                       # feature 内部构建（PyInstaller 打 EXE）
│   │   ├── build.bat
│   │   └── package.bat
│   └── samples/                     # 调试辅料（从原根目录迁入）
│       ├── html.txt
│       ├── barcode.txt
│       ├── compliant-live-photos.txt
│       ├── information-supplementation.txt
│       ├── information-supplementation-edit.txt
│       ├── rocket-drawer.txt
│       ├── rocket-drawer2.txt
│       ├── background.png
│       └── temu_label_host.log
├── build/                           # 顶层构建脚本
│   ├── build_extension.py           # 全量构建：扫 feature.json + 拷文件 + 拼 manifest → dist
│   ├── dev.py                       # watch 模式（日常开发只跑这个）
│   ├── package_all.py               # 串联：构建 extension dist + 调 feature 内 build.bat + 出员工部署包
│   └── requirements-dev.txt         # watchdog
└── dist/                            # 构建产物（gitignored）
    └── extension/                   # chrome 加载点
```

---

## 4. 设计哲学

**核心矛盾**：MV3 manifest 强制 chrome 端资产必须物理位于 extension root 之下，不能引用上一级目录。但一个 feature 又同时包含 chrome 端代码、native 端代码、构建脚本、调试辅料和文档。

**解法**：源码按 feature 语义集中，构建脚本把每个 feature 的 chrome 部分聚合到 `dist/extension/` 供 chrome 加载。

**取舍**：
- 引入构建步骤（成本）
- 换得"feature = 一个目录"的物理自治 + 多人并行 0 冲突的工程收益（收益）
- 通过 `dev.py` watch 模式 + `//# sourceURL=` 注入消除调试体验损失

---

## 5. Feature 注册契约 — 约定式扫描

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

**字段语义**：

| 字段 | 含义 |
|------|------|
| `id` | feature 唯一标识；必须等于目录名 |
| `icon` / `label` | Hub 网格里展示的图标和文字 |
| `locked` | 占位（开发中），Hub 里灰显不可点 |
| `order` | Hub 网格排序权重，升序排列 |
| `content_script` | 相对 feature 目录的业务 content script 路径 |
| `host_permissions` | 该 feature 需要的 host 权限，构建时聚合去重写入 manifest |
| `permissions` | 该 feature 需要的 chrome permission，构建时聚合去重 |
| `native_host` | 该 feature 关联的 native host 名（可选，决定 service worker 路由） |

**构建脚本约定**：`build/build_extension.py` 扫描 `<root>/*/feature.json`（排除 `core/` `build/` `dist/` `docs/`），收集所有 feature 后：

1. 复制 `<feature>/<content_script>` → `dist/extension/features/<id>/<content_script>`
2. 把 `core/content/*.js` 和各 feature 的 `<content_script>` 按顺序写入 `manifest.content_scripts[0].js[]`（core 在前，feature 按 `order` 升序）
3. 聚合所有 `host_permissions` / `permissions` 去重写入 manifest
4. 复制 `core/{background, popup, icons}` → `dist/extension/{background, popup, icons}`
5. 基于 `core/manifest.template.json` 渲染最终 `dist/extension/manifest.json`

**新增 feature 流程**：

```
mkdir my_new_feature
echo '{...}' > my_new_feature/feature.json
mkdir my_new_feature/content
touch my_new_feature/content/index.js
# 构建脚本下一次扫描自动接管
```

不需要修改公共骨架、不需要手改 manifest、不需要登记中心注册表。

---

## 6. Core ↔ Feature 通信契约

`core/content/core.js` 在 chrome content script 的 isolated world 暴露全局 API（注册到 `window.AgentSeller`）：

```js
window.AgentSeller = {
  registerFeature({ id, icon, label, locked, init, render }),
  onPageChange(cb),                       // 注册 URL 变化监听，cb(href) 在 history hook 触发时调用
  showToast(msg, type),                   // 全屏短暂 toast
  utils: {
    sleep,
    ensureExtensionAlive,
    waitForEl,
    makeDraggable,
    normText,
    findByText,
    setInputValue,
  },
  sendNative(action, data),               // 透传到 service worker → native host
};
```

`setStatus` 操作的是 feature view 内的 `#tal-status` 元素，归 feature 内部实现，不上提到 core。

**Feature 内部状态归 feature 自己管**：当前 `state.product`（选中商品 SKC）只有 `auto_gen_label` 一个 feature 用，放到 feature 内部模块管理即可，core 不提供 product API。如果未来出现多 feature 共享商品上下文的需求，再上提到 core。

**Feature 注册示例**（`auto_gen_label/content/index.js`）：

```js
window.AgentSeller.registerFeature({
  id: 'auto_gen_label',
  icon: '🚀',
  label: '标签生成',
  init(ctx) {
    // 监听页面变化、绑定行点击、注册 history hook 等长期任务
  },
  render(viewEl, ctx) {
    // 用户从 Hub 点进本 feature 时被调用
    // 渲染 feature view、绑定按钮、刷新状态
  },
});
```

**加载顺序保证**：`manifest.content_scripts[0].js[]` 由构建脚本生成时，core 的 js 文件**总是排在所有 feature 之前**，保证 `window.AgentSeller` 在 feature 脚本执行时已经就绪。

**Service worker 路由**：core 的 `service-worker.js` 收到 `chrome.runtime.sendMessage` 时，根据消息的 `type` 字段查表分发：

- `PICK_FILE` / `PICK_FOLDER` / `READ_FILE_CHUNK` 等 native action 透传到指定 native host
- `PROCESS_LABEL` 等 feature 专有 action 也透传，feature 在 `feature.json` 里声明 `native_host` 字段以决定走哪个 host

第一阶段所有 action 共用 `com.temu.label_host` 一个 native host。未来如果有 feature 需要独立 native host，core service worker 已经具备分发能力。

---

## 7. 构建与 Watch 链路

### 7.1 首次配置（一次性）

```
pip install -r build/requirements-dev.txt    # 仅装 watchdog
python build/build_extension.py              # 全量构建一次，生成 dist/extension/
# 然后在 chrome://extensions 加载已解压扩展程序 → 选 dist/extension/
```

### 7.2 日常开发

```
python build/dev.py
```

`dev.py` 启动时：

1. 调一次 `build_extension.build_all()` 全量构建
2. 启动 watchdog 监听 `core/` 和 `*/feature.json` `*/content/`
3. 文件变更时增量同步到对应 `dist/extension/` 路径
4. 检测到 `feature.json` 变化或 feature 目录增删时，重新生成 `manifest.json`

**控制台输出示例**：

```
[build] core/ → dist/extension/  (5 files)
[build] auto_gen_label/ → dist/extension/features/auto_gen_label/  (1 file)
[build] manifest.json generated  (1 feature, 2 content scripts)
[watch] monitoring: core/, auto_gen_label/
[watch] chrome 请加载 dist/extension/，修改源码会自动同步

[sync] auto_gen_label/content/index.js → dist/.../index.js  (132ms)
[sync] core/content/core.js → dist/extension/content/core.js  (98ms)
[manifest] 检测到 feature.json 变化，重生 manifest.json
```

用户修改源码 → 切到 chrome → 点扩展卡片右下角 reload → 看效果。**最后一步是 chrome 自身限制**，所有架构都绕不过。

### 7.3 一次性构建（CI / 出包）

```
python build/build_extension.py
```

幂等，可以反复跑。

### 7.4 员工部署包

```
python build/package_all.py
```

串联：

1. `build_extension.py` 出 `dist/extension/`
2. 调 `auto_gen_label/build/build.bat` 打 `TemuLabelHost.exe`
3. 拷贝到 `dist/TemuLabel_Setup/`（extension + EXE + install.bat）

`auto_gen_label/build/build.bat` 和 `package.bat` 内部逻辑保留，仅由顶层串联调度。

---

## 8. 调试体验保障

构建脚本和 watch 同步时，**在每个被复制的 .js 文件开头自动注入** `//# sourceURL=<src 相对路径>` 注释。

效果：DevTools Sources 面板和 console.log 行号显示的都是源码路径，而不是 dist 路径：

| 不注入 | 注入后 |
|--------|--------|
| `dist/extension/features/auto_gen_label/content/index.js:512` | `auto_gen_label/content/index.js:512` |
| `dist/extension/content/core.js:88` | `core/content/core.js:88` |

DevTools 的"在 Sources 里看到的源码树"和"console 里的报错堆栈"都会按源码路径展示。断点行号一致，**和方案 A（chrome 直接加载源目录）的调试体验等价**。

唯一差别是修改源码后多一次自动 sync（用户无感知，平均 < 200ms），chrome reload 这一步两个方案都需要。

---

## 9. 辅料文件归宿

当前根目录下的调试辅料统一迁移到 `auto_gen_label/samples/`：

- `html.txt`（Temu 页面 DOM 抓取样本）
- `barcode.txt`、`compliant-live-photos.txt`、`information-supplementation*.txt`、`rocket-drawer*.txt`（DOM 片段，对应 Phase 1-3 调试参考）
- `background.png`
- `temu_label_host.log`（运行日志样本）

这些只对 auto_gen_label feature 的开发有意义，应该跟着 feature 走，未来其他 feature 不会污染它们。

---

## 10. CLAUDE.md 拆分

### 10.1 顶层 `CLAUDE.md`

涵盖：

- 项目定位
- 整体架构（公共骨架 + feature 模式的总体描述）
- 目录结构总览
- Feature 注册契约（feature.json 字段表）
- Core API 契约（window.AgentSeller 接口）
- 构建命令（`dev.py` / `build_extension.py` / `package_all.py`）
- 开发工作流（含 worktree 并行规则，见 §11）
- 部署说明（员工机器一键安装）

**不包含**：具体 feature 的实现细节（如 BarTender SDK 调用、Temu 选择器、Phase 1/2/3 流程），那些归 feature 自己的 CLAUDE.md。

**也不在顶层 CLAUDE.md 硬列 feature 名单**：开发者通过 `ls */feature.json` 查看当前 feature 列表，避免新加 feature 时改顶层 CLAUDE.md 产生冲突。

### 10.2 `auto_gen_label/CLAUDE.md`

继承当前 `auto_gen_label/CLAUDE.md` 的内容（Phase 1 实现、BarTender SDK 调用规约、Temu 弹窗结构、Native Messaging 协议细节、关键依赖），并补充：

- 该 feature 的 `feature.json` 字段说明
- Phase 1/2/3 在 `content/index.js` 内的代码组织
- 本地调试时 native_host 注册方式
- samples/ 目录里各样本文件的用途

---

## 11. Worktree 并行开发规则

### 11.1 冲突面分析

| 资源 | 多 feature 并行时冲突频率 | 原因 |
|------|---------------------------|------|
| `manifest.json` | 0 | 构建产物，gitignored；由 feature.json 聚合生成 |
| Feature 注册表 | 0 | 约定式扫描，无中心数组 |
| `dist/` | 0 | gitignored，每个 worktree 各自构建 |
| `<feature>/` 内部 | 0 | feature 之间物理完全隔离 |
| `core/icons/`、`manifest.template.json` | 0 | 几乎不动 |
| `core/popup/` | 极低 | 公共状态展示，加 feature 不需要改 |
| `core/background/service-worker.js` | 低 | 通用消息路由，feature 不动它 |
| `core/content/*.js` | 中 | 多人同时改公共骨架是真实协调成本，不可消除 |
| 顶层 `CLAUDE.md` | 0 | 不硬列 feature 名单，无需在加 feature 时修改 |
| `<feature>/native_host/` | 0 | 跟 feature 走，其他 feature 不碰 |

**结论**：方案 C 把现有架构最大的并行瓶颈（`FEATURES` 数组 + 单文件 1900 行）和方案 A 的次级瓶颈（手写 manifest）都消除掉。**真实协调点只剩 `core/content/*.js`**。

### 11.2 新增 Feature 的标准工作流（必读）

> 开始一个新 feature **之前**，必须按这个顺序执行：

1. **Step 1：拉取最新 main**
   ```
   git fetch origin --prune
   git switch main
   git pull --ff-only origin main
   ```

2. **Step 2：评估 core API 是否覆盖你的需求**

   检查 `core/content/registry.js` 暴露的 `window.AgentSeller` API、`core/content/utils.js` 公共工具、`core/background/service-worker.js` 消息路由能力是否够用。

   常见的"core 不够用"信号：
   - 你需要新的全局 utility（如新的 DOM 查找工具、新的状态管理）
   - 你需要新的 native action 路由类型
   - 你需要在 Hub UI 上加新的交互元素
   - 你需要 `registerFeature` 接受新的字段（如 `pageMatcher`、`pagesChange` 回调）

3. **Step 3：如果 core 需要扩展，先做 core PR**

   - 开 `feature/core-<purpose>` 分支
   - 只改 core，不带任何 feature 业务代码
   - PR 合入 main
   - **然后才能进入 Step 4**

   **理由**：core 是所有 feature 的共享底座。如果一边开发 feature 一边修 core，并且 main 上同时有其他 worktree 也在改 core，会触发 §11.1 表里"core/content/*.js"那一行的冲突。先把 core 改动合入 main，让其他 worktree 基于新 core 重 rebase，是 plugin 架构的标准协作规约。

4. **Step 4：开 feature 分支**
   ```
   git switch -c feature/<your_feature>
   ```

   或用 worktree：
   ```
   git worktree add ../wt-<your_feature> -b feature/<your_feature>
   ```

5. **Step 5：在 feature 目录内开发**

   - 新建 `<your_feature>/` 目录
   - 写 `feature.json`、`content/index.js`、必要时 `native_host/` 和 `build/`
   - 跑 `python build/dev.py` 即可启动调试
   - feature 内部的所有改动都不会和其它 feature 的 worktree 冲突

**反模式**：跳过 Step 2-3，直接在 feature 分支内同时改 core 和 feature 代码。这会让 core 改动被夹带在 feature PR 里，其他 worktree 长时间得不到 core 升级，回归冲突时分支之间互相 rebase 困难。

### 11.3 Worktree 物理注意点

1. **每个 worktree 各自的 dist/**：`dist/` 是 gitignored，每个 worktree 物理隔离。Chrome 一次只能加载一个 `dist/extension/`，调试时让 chrome 指向当前正在调试的 worktree 的 dist/。

2. **Native host 注册表是全局的**：Windows 注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\<host_name>` 只能指向一个 EXE 路径。多 worktree 同时调试 native_host 时需要协调（重新跑对应 worktree 的 `dev_install.bat`）。这是 Chrome Native Messaging 的限制，与架构无关。

3. **多个 `dev.py` 同时运行无冲突**：watchdog 不占端口，纯文件监听，各 worktree 互不干扰。

---

## 12. 不变量（行为保持）

迁移完成后，**用户可见行为必须与当前一致**：

1. Chrome 加载插件后，右下角出现 📦 FAB
2. Ctrl + 点击 FAB → 展开 Hub 视图，看到"🚀 标签生成"网格
3. 点击"标签生成" → 进入 feature view，显示模板/输出路径设置、商品卡片、状态栏、调试卡片
4. 在 Temu 条码管理页选商品行 → 商品卡填充 → 点"开始执行" → Phase 1/2/3 流程依次执行
5. Native Messaging 协议（4 字节长度头 + JSON）保持不变
6. BarTender SDK 调用方式保持不变
7. 员工部署包目录结构保持不变（`TemuLabel_Setup/` 里仍是 extension + EXE + install.bat）

任何行为偏离都视为 bug，不接受"顺手优化"。

---

## 13. 验证计划

迁移完成后，按以下检查表验证：

### 13.1 静态验证

- [ ] `python build/build_extension.py` 全量构建成功，无报错
- [ ] `dist/extension/manifest.json` 内容正确：`content_scripts[0].js[]` 顺序 = `[core 文件们..., features/auto_gen_label/content/index.js]`
- [ ] `dist/extension/manifest.json` 的 `host_permissions` 包含 `https://seller.temu.com/*` 和 `https://*.temu.com/*`
- [ ] 所有 dist 下的 .js 文件首行都有 `//# sourceURL=` 注释
- [ ] `python build/dev.py` 启动成功，修改 `core/content/core.js` 后 dist 同步生效

### 13.2 功能验证

- [ ] Chrome 加载 `dist/extension/`，FAB 出现
- [ ] Ctrl + 点击 FAB 弹出 Hub，看到"🚀 标签生成"
- [ ] DevTools Sources 面板看到的路径是 `auto_gen_label/content/index.js`，不是 `dist/...`
- [ ] 进入 Temu 条码管理页，点商品行能选中
- [ ] 完整跑通 Phase 1（生成标签）→ PDF + PNG 文件产出
- [ ] 完整跑通 Phase 2（合规信息填写）→ 字段填充正确
- [ ] 完整跑通 Phase 3（标签主图插入）→ 图片上传到指定槽位

### 13.3 部署验证

- [ ] `python build/package_all.py` 生成 `dist/TemuLabel_Setup/` 完整目录
- [ ] 在干净 Windows 机器上跑 `install.bat`，加载 extension，跑通 Phase 1

---

## 14. 范围外 / 未来扩展

以下不在本次迁移范围，留待未来按需扩展：

- **多 native host 支持**：当前所有 feature 共用 `com.temu.label_host`。如果未来某 feature 需要独立 native host，core service-worker 已经具备按 `native_host` 字段分发的能力，新加 feature 时声明即可
- **Feature 级 popup**：当前 popup 是全局的状态展示。如果未来某 feature 需要自己的 popup tab，可以扩展 `feature.json` 加 `popup` 字段，构建脚本生成多 tab popup
- **Feature 级 background 逻辑**：当前 service worker 只做消息透传。如果某 feature 需要长期后台任务（如定时轮询），可以扩展为 feature 提供 background handler 模块、core 动态加载
- **Source map**：当前仅注入 `//# sourceURL=`。如果未来需要更精确的源码映射（如行号偏移），可以接入完整 source map
- **Hot reload**：当前需要手动在 chrome 里点扩展 reload。未来可以通过 dev.py 持续 WebSocket 通知 + content script 内的 dev 客户端实现自动 reload，节省一次点击
- **TypeScript / 模块化打包**：当前是手写 JS，构建只做"拷贝 + 注入 sourceURL"。如果代码量大到需要类型系统，可以引入 esbuild / tsc 替换简单拷贝步骤
