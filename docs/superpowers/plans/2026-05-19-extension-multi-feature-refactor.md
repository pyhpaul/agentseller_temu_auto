# Extension 多 Feature 架构重构 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `auto_gen_label/` 内的 chrome 插件管理上提到项目根，建立 `core/` 公共骨架 + `<feature>/` 自治目录结构，行为完全保持不变。

**Architecture:** 方案 C — 源码按 feature 集中、`build/build_extension.py` 拼装 `dist/extension/` 供 chrome 加载、`build/dev.py` watch 模式自动同步、`//# sourceURL=` 注入消除调试体验损失。

**Tech Stack:** Python 3 (watchdog) + Chrome MV3 + 现有 JS / Python BarTender SDK。

**Spec:** `docs/superpowers/specs/2026-05-19-extension-multi-feature-architecture-design.md`

**Commit 策略:** 用户要求重构期间不 commit，每个 task 末尾仅做"验证检查点"。所有 task 完成且功能验证通过后，最后一个 task 执行 `git init` + 首个 commit。Task 1 创建文件系统级备份作为零 git 状态下的回滚兜底。

---

## 文件结构（新增/迁移/删除一览）

**新增**：
- `CLAUDE.md`（根，顶层架构）
- `.gitignore`
- `core/manifest.template.json`
- `core/background/service-worker.js`（迁自 `auto_gen_label/extension/background/service-worker.js`）
- `core/content/core.js`（入口装配）
- `core/content/ui.js`（FAB/Panel/Hub）
- `core/content/registry.js`(feature 注册 + onPageChange 分发)
- `core/content/utils.js`（公共工具）
- `core/popup/popup.html` `popup.js`（迁自原 popup）
- `core/icons/*`（迁自原 icons）
- `auto_gen_label/feature.json`
- `auto_gen_label/content/index.js`（从原 content-script.js 抽取 feature 业务）
- `auto_gen_label/CLAUDE.md`（继承并补充）
- `build/build_extension.py`
- `build/dev.py`
- `build/package_all.py`
- `build/requirements-dev.txt`

**平移（mv，不改内容）**：
- `auto_gen_label/extension/native_host/*` → 已在 `auto_gen_label/native_host/`，无需动（注：当前 native_host 已在 feature 根，扩展期间确认即可）
- `auto_gen_label/extension/build/*` → 已在 `auto_gen_label/build/`，确认即可
- 根目录辅料（`*.txt`、`*.png`、`*.log`）→ `auto_gen_label/samples/`

**删除（迁移完成后）**：
- `auto_gen_label/extension/`（整个目录，内容被分散到 `core/` 和 `auto_gen_label/content/`）

---

## Task 列表

- [ ] Task 1: 备份与新目录骨架
- [ ] Task 2: 搬运静态资产（icons / popup / 辅料）
- [ ] Task 3: 确认 native_host / build 位置
- [ ] Task 4: 写 manifest.template.json
- [ ] Task 5: 写 build_extension.py（v1，仅 core 拷贝）
- [ ] Task 6: 搬迁 background service-worker
- [ ] Task 7: 写 feature.json + 扩展 build_extension.py 支持扫描
- [ ] Task 8: 抽取 core/content/utils.js
- [ ] Task 9: 抽取 core/content/ui.js
- [ ] Task 10: 写 core/content/registry.js
- [ ] Task 11: 写 core/content/core.js 入口
- [ ] Task 12: 写 auto_gen_label/content/index.js（feature 业务全迁）
- [ ] Task 13: build_extension.py 注入 sourceURL
- [ ] Task 14: 写 build/dev.py（watch 模式）
- [ ] Task 15: 写 build/package_all.py
- [ ] Task 16: 写顶层 CLAUDE.md 与 feature CLAUDE.md
- [ ] Task 17: 删除旧路径
- [ ] Task 18: 功能验证（Phase 1/2/3 + sourceURL + 部署）
- [ ] Task 19: git init + 首个 commit

---

## Task 1: 备份与新目录骨架

**目标**：在动手前做一次文件系统级备份（零 git 状态下的回滚兜底），并创建新结构的空目录。

**Files:**
- Create: `../agentseller_temu_backup_20260519/`（完整副本）
- Create: `core/`, `core/background/`, `core/content/`, `core/popup/`, `core/icons/`
- Create: `auto_gen_label/content/`, `auto_gen_label/samples/`
- Create: `build/`
- Create: `dist/`

- [ ] **Step 1: 创建项目副本（在项目同级目录）**

```bash
cp -r /home/linux_dev/projects/agentseller_temu /home/linux_dev/projects/agentseller_temu_backup_20260519
ls -la /home/linux_dev/projects/agentseller_temu_backup_20260519/
```

Expected: 看到与当前 `agentseller_temu/` 完全相同的内容。

- [ ] **Step 2: 创建新目录骨架（项目根 cd 后执行）**

```bash
cd /home/linux_dev/projects/agentseller_temu
mkdir -p core/background core/content core/popup core/icons
mkdir -p auto_gen_label/content auto_gen_label/samples
mkdir -p build dist
```

- [ ] **Step 3: 写 .gitignore**

```bash
cat > .gitignore <<'EOF'
# 构建产物
dist/

# Python
__pycache__/
*.pyc
*.pyo
*.egg-info/

# IDE
.vscode/
.idea/

# 日志
*.log

# 系统
.DS_Store
Thumbs.db
EOF
```

- [ ] **Step 4: 验证检查点**

```bash
ls /home/linux_dev/projects/agentseller_temu/
ls /home/linux_dev/projects/agentseller_temu/core/
```

Expected: 根目录新增 `core/ build/ dist/ .gitignore`；`core/` 下有 4 个空子目录；备份存在且完整。

---

## Task 2: 搬运静态资产（icons / popup / 辅料）

**目标**：把不需要拆代码的资产搬到新位置（保留旧位置直到 Task 17 才删）。

**Files:**
- Copy: `auto_gen_label/extension/icons/*` → `core/icons/`
- Copy: `auto_gen_label/extension/popup/popup.html` → `core/popup/popup.html`
- Copy: `auto_gen_label/extension/popup/popup.js` → `core/popup/popup.js`
- Move: 根目录辅料 → `auto_gen_label/samples/`

- [ ] **Step 1: 搬 icons（cp 而非 mv，保留旧位置直到 Task 17）**

```bash
cd /home/linux_dev/projects/agentseller_temu
cp auto_gen_label/extension/icons/icon16.png  core/icons/
cp auto_gen_label/extension/icons/icon48.png  core/icons/
cp auto_gen_label/extension/icons/icon128.png core/icons/
```

- [ ] **Step 2: 搬 popup**

```bash
cp auto_gen_label/extension/popup/popup.html core/popup/popup.html
cp auto_gen_label/extension/popup/popup.js   core/popup/popup.js
```

- [ ] **Step 3: 移辅料到 samples/（用 mv，根目录这些文件不再保留）**

```bash
mv auto_gen_label/background.png                       auto_gen_label/samples/
mv auto_gen_label/barcode.txt                          auto_gen_label/samples/
mv auto_gen_label/compliant-live-photos.txt            auto_gen_label/samples/
mv auto_gen_label/html.txt                             auto_gen_label/samples/
mv auto_gen_label/information-supplementation.txt      auto_gen_label/samples/
mv auto_gen_label/information-supplementation-edit.txt auto_gen_label/samples/
mv auto_gen_label/rocket-drawer.txt                    auto_gen_label/samples/
mv auto_gen_label/rocket-drawer2.txt                   auto_gen_label/samples/
mv auto_gen_label/temu_label_host.log                  auto_gen_label/samples/
```

- [ ] **Step 4: 验证检查点**

```bash
ls core/icons/ core/popup/ auto_gen_label/samples/
ls auto_gen_label/ | grep -E '\.(txt|png|log)$'
```

Expected: 
- `core/icons/` 有 3 个 png
- `core/popup/` 有 popup.html + popup.js
- `auto_gen_label/samples/` 含全部辅料
- `auto_gen_label/` 根下不再有 *.txt / *.png / *.log

---

## Task 3: 确认 native_host / build 位置

**目标**：当前 `auto_gen_label/native_host/` 和 `auto_gen_label/build/` 已在 feature 根（spec §3 要求的位置），本 task 只确认并修正个别路径。

**Files:**
- Verify: `auto_gen_label/native_host/main.py` 等 8 个文件
- Verify: `auto_gen_label/build/build.bat`、`package.bat`
- Adjust if needed: `auto_gen_label/build/build.bat` 内引用源码的相对路径

- [ ] **Step 1: 确认目录就位**

```bash
ls auto_gen_label/native_host/
ls auto_gen_label/build/
```

Expected: 
- native_host/ 含 main.py / bartender_handler.py / file_dialog.py / com.temu.label_host.json / install.bat / dev_install.bat / requirements.txt / resources/
- build/ 含 build.bat / package.bat

- [ ] **Step 2: 检查 build.bat 内引用的路径**

```bash
cat auto_gen_label/build/build.bat auto_gen_label/build/package.bat
```

记录两个文件中的所有相对路径引用（特别是引用 `extension/` 的部分），看是否需要在 Task 17 删除旧 extension 之后改成新路径（如 `../../core/` 或 `../../dist/extension/`）。

- [ ] **Step 3: 验证检查点**

`auto_gen_label/native_host/` 和 `auto_gen_label/build/` 内容不变；记录 build.bat / package.bat 内需要调整的路径清单，留待 Task 15 在 `package_all.py` 中统一处理。

---

## Task 4: 写 manifest.template.json

**目标**：基于现有 `auto_gen_label/extension/manifest.json` 改造为模板，留出 `{{...}}` 占位符供构建脚本填充。

**Files:**
- Create: `core/manifest.template.json`

- [ ] **Step 1: 写模板文件**

```bash
cat > core/manifest.template.json <<'EOF'
{
  "manifest_version": 3,
  "name": "AgentSeller for Temu",
  "version": "1.0.0",
  "description": "Temu 商家中心自动化（多 feature 插件）",
  "permissions": "__PERMISSIONS__",
  "host_permissions": "__HOST_PERMISSIONS__",
  "background": {
    "service_worker": "background/service-worker.js"
  },
  "content_scripts": [
    {
      "matches": "__HOST_PERMISSIONS__",
      "js": "__CONTENT_SCRIPTS__",
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "AgentSeller for Temu",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  }
}
EOF
```

**说明**：占位符是字符串 `"__PERMISSIONS__"`、`"__HOST_PERMISSIONS__"`、`"__CONTENT_SCRIPTS__"`，由 `build_extension.py` 替换为 JSON 数组。这种"字符串占位 + 后处理替换"的方式比 jinja 简单，无新增依赖。

- [ ] **Step 2: 验证检查点**

```bash
python3 -c "import json; json.load(open('core/manifest.template.json'))"
```

Expected: 不报错（合法 JSON）。

---

## Task 5: 写 build_extension.py（v1，仅 core 拷贝）

**目标**：构建脚本最小可用版 —— 把 `core/` 内容拷到 `dist/extension/`，先不处理 feature 扫描。Task 7 再扩展。

**Files:**
- Create: `build/build_extension.py`

- [ ] **Step 1: 写最小构建脚本**

```bash
cat > build/build_extension.py <<'PYEOF'
"""
build_extension.py — 把 core/ 和 features 内容聚合到 dist/extension/。
v1：仅 core 资产拷贝；feature 扫描在 Task 7 加入。
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / 'core'
DIST = ROOT / 'dist' / 'extension'


def clean_dist():
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True, exist_ok=True)


def copy_core_assets():
    """拷贝 core/{background,content,popup,icons} → dist/extension/{...}"""
    for sub in ['background', 'content', 'popup', 'icons']:
        src = CORE / sub
        if not src.exists():
            continue
        dst = DIST / sub
        shutil.copytree(src, dst)
        print(f'[build] {sub}/ → dist/extension/{sub}/  ({sum(1 for _ in dst.rglob("*") if _.is_file())} files)')


def render_manifest(features=None):
    """读模板 → 替换占位符 → 写 dist/extension/manifest.json。
    v1 features=None，仅写 core 的 content_scripts 占位（空数组）。
    """
    features = features or []
    template = json.loads((CORE / 'manifest.template.json').read_text(encoding='utf-8'))

    permissions = sorted({'nativeMessaging', *(p for f in features for p in f.get('permissions', []))})
    host_permissions = sorted({h for f in features for h in f.get('host_permissions', [])})
    content_scripts_js = (
        ['content/core.js']  # core 入口固定排第一
        + [f'features/{f["id"]}/{f["content_script"]}' for f in sorted(features, key=lambda x: x.get('order', 999))]
    )

    template['permissions'] = permissions
    template['host_permissions'] = host_permissions
    template['content_scripts'][0]['matches'] = host_permissions
    template['content_scripts'][0]['js'] = content_scripts_js

    (DIST / 'manifest.json').write_text(json.dumps(template, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[build] manifest.json generated  ({len(features)} features, {len(content_scripts_js)} content scripts)')


def build_all():
    clean_dist()
    copy_core_assets()
    render_manifest(features=[])
    print(f'[build] done → {DIST}')


if __name__ == '__main__':
    build_all()
PYEOF
```

- [ ] **Step 2: 跑一次验证基础链路**

```bash
cd /home/linux_dev/projects/agentseller_temu
python3 build/build_extension.py
```

Expected 输出：
```
[build] popup/ → dist/extension/popup/  (2 files)
[build] icons/ → dist/extension/icons/  (3 files)
[build] manifest.json generated  (0 features, 1 content scripts)
[build] done → /home/linux_dev/projects/agentseller_temu/dist/extension
```

注意：此时 `background/` 和 `content/` 还没东西（Task 6/8-11 才填），所以不会被拷贝；manifest 也只列了 `content/core.js`，文件不存在没关系（chrome 加载会报错，但本 task 不验证 chrome 加载）。

- [ ] **Step 3: 验证 dist 结构**

```bash
find dist/extension -type f
```

Expected: `dist/extension/{manifest.json, popup/popup.html, popup/popup.js, icons/icon16.png, icons/icon48.png, icons/icon128.png}`。

---

## Task 6: 搬迁 background service-worker

**目标**：把 `auto_gen_label/extension/background/service-worker.js` 原样搬到 `core/background/`（内容已经是按 action 透传的通用消息路由，不需要改）。

**Files:**
- Copy: `auto_gen_label/extension/background/service-worker.js` → `core/background/service-worker.js`

- [ ] **Step 1: 复制文件**

```bash
cp auto_gen_label/extension/background/service-worker.js core/background/service-worker.js
```

- [ ] **Step 2: 重新构建并验证**

```bash
python3 build/build_extension.py
find dist/extension/background -type f
```

Expected: `dist/extension/background/service-worker.js` 存在。

- [ ] **Step 3: 验证检查点**

```bash
diff auto_gen_label/extension/background/service-worker.js core/background/service-worker.js
```

Expected: 输出为空（两文件相同）。

---

## Task 7: 写 feature.json + 扩展 build_extension.py 支持扫描

**目标**：给 `auto_gen_label/` 写 `feature.json`，扩展构建脚本扫描 `*/feature.json` 并拷贝 feature 的 content_script。

**Files:**
- Create: `auto_gen_label/feature.json`
- Modify: `build/build_extension.py`（新增 `scan_features()` 和 `copy_feature_assets()`）

- [ ] **Step 1: 写 auto_gen_label/feature.json**

```bash
cat > auto_gen_label/feature.json <<'EOF'
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
EOF
```

- [ ] **Step 2: 扩展 build_extension.py 加入 feature 扫描**

修改 `build/build_extension.py`，在 `copy_core_assets` 函数后追加：

```python
SKIP_DIRS = {'core', 'build', 'dist', 'docs', '__pycache__', '.git'}


def scan_features():
    """扫描 <ROOT>/*/feature.json，返回 feature 元数据列表。"""
    features = []
    for entry in sorted(ROOT.iterdir()):
        if not entry.is_dir() or entry.name in SKIP_DIRS or entry.name.startswith('.'):
            continue
        fjson = entry / 'feature.json'
        if not fjson.exists():
            continue
        meta = json.loads(fjson.read_text(encoding='utf-8'))
        meta['_dir'] = entry  # 内部字段，记录源目录
        features.append(meta)
        print(f'[build] discovered feature: {meta["id"]}')
    return features


def copy_feature_assets(features):
    """拷贝每个 feature 的 content_script 到 dist/extension/features/<id>/"""
    for f in features:
        src_dir = f['_dir']
        src_script = src_dir / f['content_script']
        dst_script = DIST / 'features' / f['id'] / f['content_script']
        dst_script.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_script, dst_script)
        rel = src_script.relative_to(ROOT)
        print(f'[build] {rel} → dist/extension/features/{f["id"]}/{f["content_script"]}')
```

并把 `build_all` 改为：

```python
def build_all():
    clean_dist()
    copy_core_assets()
    features = scan_features()
    copy_feature_assets(features)
    render_manifest(features=features)
    print(f'[build] done → {DIST}')
```

- [ ] **Step 3: 创建占位 content/index.js**

为了让 Task 7 的构建能跑通（Task 12 才填实际内容），先建一个空文件：

```bash
echo "// placeholder; filled in Task 12" > auto_gen_label/content/index.js
```

- [ ] **Step 4: 跑构建并验证**

```bash
python3 build/build_extension.py
cat dist/extension/manifest.json
```

Expected manifest.json 关键字段：
- `permissions`: `["nativeMessaging"]`
- `host_permissions`: `["https://*.temu.com/*", "https://seller.temu.com/*"]`
- `content_scripts[0].js`: `["content/core.js", "features/auto_gen_label/content/index.js"]`

Expected dist 结构新增 `dist/extension/features/auto_gen_label/content/index.js`。

---

## Task 8: 抽取 core/content/utils.js

**目标**：从 `auto_gen_label/extension/content/content-script.js` 抽取真正通用的工具函数到 `core/content/utils.js`，挂到 `window.AgentSeller.utils`。

**抽取清单**（含原行号，便于定位）：

| 函数 | 原行号 |
|------|--------|
| `sleep` | 842 |
| `ensureExtensionAlive` | 844-847 |
| `waitForEl` | 875-889 |
| `normText` | 891 |
| `findByText` | 893-897 |
| `setInputValue` | 899-905 |
| `showToast` | 1153-1175 |
| `makeDraggable` | 1875-1898 |

**Files:**
- Create: `core/content/utils.js`

- [ ] **Step 1: 用 Read 工具读取原文件以上行号区间，逐函数粘贴到新文件**

不要手动重新打代码，用 Read 拿到精确文本（含原 4 空格缩进，去掉外层 IIFE 缩进即可）。

新文件结构：

```js
// core/content/utils.js — 公共工具集，挂载到 window.AgentSeller.utils
(function () {
  'use strict';

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function ensureExtensionAlive() {
    if (!chrome?.runtime?.id) throw new Error('插件已重载，请刷新页面后重试');
  }

  function waitForEl(selector, root = document, timeout = 12000) {
    /* 从原 875-889 行粘贴 */
  }

  function normText(s) { return (s || '').replace(/\s/g, ''); }

  function findByText(selector, text, root = document) {
    /* 从原 893-897 行粘贴 */
  }

  function setInputValue(el, value) {
    /* 从原 899-905 行粘贴 */
  }

  function showToast(msg, type = 'info') {
    /* 从原 1153-1175 行粘贴 */
  }

  function makeDraggable(el, handle, onDragEnd) {
    /* 从原 1875-1898 行粘贴 */
  }

  // 暴露：AgentSeller 全局对象由 core.js 创建，本文件先挂到全局命名空间，core.js 装配时收集
  window.__AgentSellerUtils = {
    sleep, ensureExtensionAlive, waitForEl, normText,
    findByText, setInputValue, showToast, makeDraggable,
  };
})();
```

**实施提示**：

- 这些函数除了 `showToast` 内部用 `setTimeout` 自管理 DOM 创建外，全部自包含无外部依赖，直接粘贴即可
- `showToast` 内部不依赖任何 feature 状态，可以原样搬

- [ ] **Step 2: 跑构建验证**

```bash
python3 build/build_extension.py
ls dist/extension/content/
```

Expected: `dist/extension/content/utils.js` 存在。

- [ ] **Step 3: 在浏览器手动验证（轻量）**

跑一次完整构建后 chrome 加载 `dist/extension/`（即使 content/core.js 还不存在，chrome 加载会报错但能 reload），打开 Temu 任意页面 DevTools console:

```js
window.__AgentSellerUtils?.sleep
```

Expected: 返回 function；如果 chrome 因 manifest 引用了不存在的 `content/core.js` 而拒绝加载，跳过 Step 3，等 Task 11 之后再做完整验证。

- [ ] **Step 4: 验证检查点**

`core/content/utils.js` 文件存在，所有列出的函数都已包含且与原文件代码一致；构建脚本能成功把它拷贝到 dist。

---

## Task 9: 抽取 core/content/ui.js

**目标**：从原 content-script.js 抽取 FAB / Panel / Hub UI 构建逻辑到 `core/content/ui.js`。这部分操作的 DOM 元素 ID 都是公共的（`#tal-fab`、`#tal-panel`、`#tal-hub-view`、`#tal-feature-view`、`#tal-titlebar`、`#tal-feature-grid` 等），与具体 feature 无关。

**抽取清单**（含原行号）：

| 函数 | 原行号 |
|------|--------|
| `injectStyles` | 32-181 |
| `buildFab` | 186-194 |
| `buildPanel` | 199-236 |
| `showHub` | 241-262 |
| `showFeature` | 264-280 |
| `hidePanelToFab` | 282-286 |
| `positionPanelAtFab` | 288-305 |
| `syncPanelBottom` | 307-318 |

**外部依赖**：
- `makeDraggable`（已在 utils.js）
- `state.view` / `state.feature` / `panelTargetBottom`（这些是模块内状态，搬到 ui.js 内部作为闭包变量即可）
- `FEATURES` 数组 → 改为从 registry 取（Task 10 引入 `window.AgentSeller.getFeatures()`）
- `showFeature` 调用 `renderFeature(fid)` —— 这是 feature 业务，ui.js 改为调用 `registry.renderFeature(fid)`（Task 10 提供）

**Files:**
- Create: `core/content/ui.js`

- [ ] **Step 1: 写文件骨架**

```js
// core/content/ui.js — FAB / Panel / Hub UI 构建
(function () {
  'use strict';

  const state = {
    view: 'fab',     // 'fab' | 'hub' | 'feature'
    feature: null,
  };
  let panelTargetBottom = null;

  function injectStyles() {
    /* 从原 32-181 行粘贴：完整 <style> 内容（含 #tal-fab、#tal-panel、.tal-titlebar、.tal-feature-grid、.tal-action-btn 等全部 CSS） */
  }

  function buildFab() {
    /* 从原 186-194 行粘贴，注意 makeDraggable 改为 window.__AgentSellerUtils.makeDraggable */
  }

  function buildPanel() {
    /* 从原 199-236 行粘贴：注意以下两处修改 */
    /*   - FEATURES.forEach(...) 改为 window.__AgentSellerRegistry.getFeatures().forEach(...) */
    /*   - card.addEventListener('click', () => showFeature(f.id)) 不变 */
    /*   - makeDraggable 改用 window.__AgentSellerUtils.makeDraggable */
  }

  function showHub(fromFab = false) { /* 原 241-262 */ }
  function showFeature(fid) {
    /* 原 264-280，把 renderFeature(fid) 改为 window.__AgentSellerRegistry.renderFeature(fid) */
  }
  function hidePanelToFab() { /* 原 282-286 */ }
  function positionPanelAtFab() { /* 原 288-305 */ }
  function syncPanelBottom() { /* 原 307-318 */ }

  // 让 hub 在 feature 注册时刷新（registry 调用）
  function refreshHub() {
    const grid = document.getElementById('tal-feature-grid');
    if (!grid) return;
    grid.innerHTML = '';
    window.__AgentSellerRegistry.getFeatures().forEach(f => {
      const card = document.createElement('div');
      card.className = 'tal-feature-card' + (f.locked ? ' tal-feature-locked' : '');
      card.title = f.locked ? '开发中' : f.label;
      card.innerHTML = `<span class="tal-ficon">${f.icon}</span><span class="tal-flabel">${f.label}</span>`;
      if (!f.locked) card.addEventListener('click', () => showFeature(f.id));
      grid.appendChild(card);
    });
  }

  window.__AgentSellerUI = {
    init() { injectStyles(); buildFab(); buildPanel(); },
    showHub, showFeature, hidePanelToFab, refreshHub,
    getState: () => state,
  };
})();
```

**实施提示**：
- `injectStyles` 的 CSS 内容 150 行整段粘贴，不需要拆
- `buildPanel` 里原本的 `FEATURES.forEach` 循环挪到 `refreshHub`，`buildPanel` 仅建外壳（titlebar + 空 grid + hub-view 容器 + feature-view 容器）
- 因为 feature 在 buildPanel 后才注册，refreshHub 在 registry.registerFeature 内被调用一次

- [ ] **Step 2: 跑构建验证**

```bash
python3 build/build_extension.py
ls dist/extension/content/
```

Expected: `dist/extension/content/ui.js` 存在。

- [ ] **Step 3: 验证检查点**

完整 chrome 加载验证留到 Task 11 之后。本 task 只验证文件存在 + 大致 grep 关键字符串：

```bash
grep -c 'function injectStyles' core/content/ui.js
grep -c 'function buildFab'     core/content/ui.js
grep -c 'function buildPanel'   core/content/ui.js
grep -c 'function showHub'      core/content/ui.js
grep -c 'function showFeature'  core/content/ui.js
```

Expected: 每个都输出 1。

---

## Task 10: 写 core/content/registry.js

**目标**：实现 feature 注册中心 + onPageChange 分发。它是 core 和 feature 之间的唯一耦合点。

**职责**：
- 维护 features 数组（无序，由 feature 的 `order` 字段决定 hub 网格顺序）
- 提供 `registerFeature(def)` 入口
- 维护 `renderFeature(fid)` 反查表（feature 注册时把 `render` 函数登记进来）
- 维护 page change 监听器列表，hookHistory 触发时遍历回调
- 暴露 `window.AgentSeller` 公开 API

**Files:**
- Create: `core/content/registry.js`

- [ ] **Step 1: 写完整文件**

```js
// core/content/registry.js — feature 注册中心 + 页面变化分发 + AgentSeller API
(function () {
  'use strict';

  const features = [];                  // [{id, icon, label, locked, order, init, render}]
  const featureById = new Map();
  const pageChangeListeners = [];

  function registerFeature(def) {
    if (!def || !def.id) throw new Error('registerFeature: 缺少 id');
    if (featureById.has(def.id)) {
      console.warn('[AgentSeller] feature 已注册，跳过:', def.id);
      return;
    }
    features.push(def);
    featureById.set(def.id, def);
    features.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

    // 触发 feature.init（feature 在 init 里通常注册 onPageChange / 绑定行点击等长期任务）
    if (typeof def.init === 'function') {
      try { def.init({}); } catch (e) { console.error(`[${def.id}] init 异常`, e); }
    }

    // 刷新 hub UI
    if (window.__AgentSellerUI?.refreshHub) window.__AgentSellerUI.refreshHub();
  }

  function renderFeature(fid) {
    const def = featureById.get(fid);
    if (!def) return;
    const viewEl = document.getElementById('tal-feature-view');
    if (!viewEl) return;
    if (typeof def.render === 'function') {
      try { def.render(viewEl, {}); } catch (e) { console.error(`[${fid}] render 异常`, e); }
    }
  }

  function getFeatures() { return features.slice(); }

  function onPageChange(cb) { pageChangeListeners.push(cb); }

  function dispatchPageChange() {
    const href = location.href;
    pageChangeListeners.forEach(cb => {
      try { cb(href); } catch (e) { console.error('[AgentSeller] pageChange 回调异常', e); }
    });
  }

  function hookHistory() {
    const wrap = fn => function (...args) { fn.apply(this, args); setTimeout(dispatchPageChange, 300); };
    history.pushState    = wrap(history.pushState.bind(history));
    history.replaceState = wrap(history.replaceState.bind(history));
    window.addEventListener('popstate', () => setTimeout(dispatchPageChange, 300));
  }

  async function sendNative(action, data) {
    if (!chrome?.runtime?.id) throw new Error('插件已重载，请刷新页面后重试');
    const resp = await chrome.runtime.sendMessage({ type: action, data });
    if (!resp?.success) throw new Error(resp?.error || `${action} 失败`);
    return resp.result;
  }

  // 暴露 registry 内部接口给 ui.js 使用
  window.__AgentSellerRegistry = { getFeatures, renderFeature, dispatchPageChange, hookHistory };

  // 公开 API：feature 业务代码使用
  window.AgentSeller = {
    registerFeature,
    onPageChange,
    showToast: (...args) => window.__AgentSellerUtils.showToast(...args),
    utils: null,  // 由 core.js 在初始化时填入
    sendNative,
  };
})();
```

**注意 sendNative 的语义**：透传 `chrome.runtime.sendMessage` 到 service worker，service worker 再透传到 native host。所以 action 参数对应 service-worker.js 里的 `msg.type`（如 `PROCESS_LABEL`、`PICK_FILE`、`READ_FILE_CHUNK`）。feature 不直接知道 native host 协议细节，统一走 sendNative。

- [ ] **Step 2: 跑构建验证**

```bash
python3 build/build_extension.py
ls dist/extension/content/
```

Expected: `dist/extension/content/registry.js` 存在。

- [ ] **Step 3: 验证检查点**

```bash
grep -c 'function registerFeature' core/content/registry.js
grep -c 'function onPageChange'    core/content/registry.js
grep -c 'window.AgentSeller'       core/content/registry.js
```

Expected: 每个 ≥ 1。

---

## Task 11: 写 core/content/core.js 入口

**目标**：装配 core 的 5 个文件，确保加载顺序正确：
1. utils.js 先挂 `window.__AgentSellerUtils`
2. ui.js 挂 `window.__AgentSellerUI`
3. registry.js 挂 `window.__AgentSellerRegistry` 和 `window.AgentSeller`
4. core.js 把 `AgentSeller.utils = __AgentSellerUtils`，调 `UI.init()` 和 `registry.hookHistory()`
5. feature 脚本最后执行，调用 `AgentSeller.registerFeature(...)`

但 chrome manifest 的 `content_scripts.js[]` 是按数组顺序逐文件执行，所以**构建脚本必须保证 core 内 4 个文件的顺序**：`utils.js → ui.js → registry.js → core.js`，然后才是各 feature 的 content_script。

**Files:**
- Create: `core/content/core.js`
- Modify: `build/build_extension.py`（修正 `render_manifest` 的 `content_scripts_js` 列表）

- [ ] **Step 1: 写 core.js**

```js
// core/content/core.js — 装配入口（manifest 内 content_scripts 列表的最后一个 core 文件）
(function () {
  'use strict';

  // 把 utils 暴露到公开 API
  window.AgentSeller.utils = window.__AgentSellerUtils;

  // 初始化 UI 骨架
  window.__AgentSellerUI.init();

  // 启动页面变化分发
  window.__AgentSellerRegistry.hookHistory();

  // 用 setTimeout(0) 让所有 feature 脚本（在本文件之后由 chrome 顺序执行）
  // 完成 registerFeature 调用后，再触发首次页面变化分发。
  // 不用 Promise.resolve().then —— microtask 在 chrome content scripts 之间
  // 是否清空不保证；setTimeout 0 排到 macrotask，必然在所有 content scripts
  // 同步执行结束后触发。
  setTimeout(() => {
    window.__AgentSellerRegistry.dispatchPageChange();
  }, 0);

  console.log('[AgentSeller] core ready');
})();
```

- [ ] **Step 2: 修正 build_extension.py 的 core 加载顺序**

打开 `build/build_extension.py`，把 `render_manifest` 函数里：

```python
content_scripts_js = (
    ['content/core.js']  # core 入口固定排第一
    + [f'features/{f["id"]}/{f["content_script"]}' for f in sorted(features, key=lambda x: x.get('order', 999))]
)
```

替换为：

```python
content_scripts_js = (
    ['content/utils.js', 'content/ui.js', 'content/registry.js', 'content/core.js']
    + [f'features/{f["id"]}/{f["content_script"]}' for f in sorted(features, key=lambda x: x.get('order', 999))]
)
```

- [ ] **Step 3: 重新构建并验证 manifest**

```bash
python3 build/build_extension.py
python3 -c "import json; m = json.load(open('dist/extension/manifest.json')); print(m['content_scripts'][0]['js'])"
```

Expected 输出：
```
['content/utils.js', 'content/ui.js', 'content/registry.js', 'content/core.js', 'features/auto_gen_label/content/index.js']
```

- [ ] **Step 4: Chrome 加载 + 半功能验证**

把 `dist/extension/` 加载到 chrome（开发者模式 → 加载已解压扩展程序）。打开任意 Temu 页面（`https://seller.temu.com/`），验证：

1. 右下角出现 📦 FAB（来自 ui.js 的 `buildFab`）
2. Ctrl + 点击 FAB → 出现 Panel，hub 视图标题 "📦 Temu Auto Label"
3. **Hub 网格当前为空**（auto_gen_label/content/index.js 还是占位，未注册 feature），这是预期状态
4. Console 看到 `[AgentSeller] core ready`

- [ ] **Step 5: 验证检查点**

FAB + Panel + 空 hub 可见；console 无 `Uncaught` 报错（warning 可忽略）。

---

## Task 12: 写 auto_gen_label/content/index.js（feature 业务全迁）

**目标**：把原 `content-script.js` 1900 行中**所有非 core 部分**搬到 `auto_gen_label/content/index.js`，顶层调用 `window.AgentSeller.registerFeature(...)`。

**抽取分组与原行号**：

| 分组 | 函数 | 原行号 |
|------|------|--------|
| 全局状态（feature 内部） | `state` (product 部分), `selectedRow`, `rowObserver` | 8-14 |
| 调试开关 | `TAL_DEBUG` | 5 |
| 路径设置 | `getPaths`, `refreshPathsUI`, `onPickTemplate`, `onPickOutputDir` | 442-510 |
| 状态栏 | `setStatus` | 512-517 |
| 商品状态 | `setProduct`, `clearSelection`, `refreshProductUI`, `getWidthRatio` | 519-529, 323-370, 432-440 |
| 页面判断 | `isBarcodeManagementPage`, `isCompliantLivePhotosPage`, `isComplianceInfoPage` | 534-537, 827-832 |
| 页面变化分发（改造） | 原 `onPageChange` 的整段逻辑 | 539-549 |
| 行绑定 | `waitForTableThenBind`, `bindRows`, `watchNewRows`, `selectRow` | 561-597 |
| 数据提取 | `getColumnIndex`, `extractRowData` | 602-614 |
| Feature view 渲染 | `renderFeature` 内 `if (fid === 'auto')` 分支整段（注意函数名改为 `renderAutoGenLabel`） | 375-430 |
| Phase 1 主流程 | `onRunAllPhases`, `onRunPhase1Only` | 619-712 |
| Phase 1 Canvas 捕获 | `findViewBarcodeBtn`, `clickAndCaptureCanvas`, `waitForBarcodeCanvas`, `computeCanvasStats`, `waitForCanvasRendered`, `extractSkcFromModal` | 717-820 |
| Phase 2 流程状态 | `getCFlow`, `setCFlow`, `clearCFlow` | 835-839 |
| Phase 2 文件读取 | `readFileChunked` | 849-873 |
| Phase 2 Rocket UI 工具 | `rocketSelectById`, `findFormItemByLabel`, `findSelectFlexible`, `findSectionByOwnTitle`, `findGroupHeader`, `getSectionsInGroup`, `getFormItemsWithLabel`, `applyFieldRule`, `applyPhase2Rules`, `rocketSelect`, `safeSelect`, `rocketSelectHasValue`, `getMultiSelectTags`, `removeAllSelectedTags`, `ensureSelected`, `selectIfEmpty`, `fillTextIfEmpty`, `fillInputByLabel`, `buildRowspanColMap` | 908-1721 散布 |
| Phase 2 主流程 | `onStartCompliance`, `checkAndRunStep1`, `runStep1`, `extractSpuFromPage`, `checkAndRunStep2or3`, `runStep2`, `waitForDrawerOpen`, `waitForAllSectionsRendered`, `findRowBySpu`, `waitForRowBySpu`, `ensureQueryMatchesSpu`, `runStep3`, `checkComplianceColumnAllSuccess` | 1178-1549 |
| Phase 3 流程 | `getImgFlow`, `setImgFlow`, `clearImgFlow`, `onStartImageUpload`, `checkAndRunImgUpload`, `runImgSearch`, `runImgUpload`, `uploadToLabelSlots`, `mimeFromName`, `injectFileToInput` | 1723-1873 |

**Files:**
- Modify: `auto_gen_label/content/index.js`（替换 Task 7 占位）

- [ ] **Step 1: 用 Read 工具完整读 `auto_gen_label/extension/content/content-script.js` 几个关键区间**

```
Read 1-30        # 顶部状态 + 初始化
Read 322-440     # 商品 UI + renderFeature
Read 442-560     # 路径设置 + 状态栏 + 页面判断 + pageChange
Read 561-820     # 行绑定 + 数据提取 + Phase 1
Read 822-1175    # Phase 2 工具集 + 文件读取
Read 1178-1549   # Phase 2 主流程
Read 1551-1730   # Phase 2 剩余工具 + 表格 helper
Read 1723-1873   # Phase 3 全部
```

- [ ] **Step 2: 用以下骨架填充 `auto_gen_label/content/index.js`**

```js
// auto_gen_label/content/index.js — feature 业务：标签生成（含 Phase 1/2/3）
(function () {
  'use strict';

  const U = window.AgentSeller.utils;            // sleep / waitForEl / makeDraggable / normText / findByText / setInputValue / showToast / ensureExtensionAlive
  const sendNative = window.AgentSeller.sendNative;
  const onPageChange = window.AgentSeller.onPageChange;

  const TAL_DEBUG = true;  // package.bat 打包 release 时替换为 false

  // ── feature 内部状态 ──────────────────────────────────────────────────────
  const fstate = { product: null };  // { skcNumber, skcSku }
  let selectedRow = null;
  let rowObserver = null;

  // ── 调用 utils 时改为 U.sleep / U.waitForEl 等 ────────────────────────────
  //    所有原 sleep(...) → U.sleep(...)
  //    所有原 ensureExtensionAlive() → U.ensureExtensionAlive()
  //    所有原 waitForEl(...) → U.waitForEl(...)
  //    所有原 chrome.runtime.sendMessage({...}) 调用：
  //      - 对 PROCESS_LABEL / PICK_FILE / PICK_FOLDER / READ_FILE_SIZE / READ_FILE_CHUNK 等：
  //        改为 await sendNative('PROCESS_LABEL', {...}) 并直接拿 result（sendNative 已剥 success/result 包装）

  // ── 页面判断 ──────────────────────────────────────────────────────────────
  function isBarcodeManagementPage() { /* 原 534-537 */ }
  function isCompliantLivePhotosPage() { /* 原 827-829 */ }
  function isComplianceInfoPage() { /* 原 830-832 */ }

  // ── 路径设置（localStorage 持久化） ───────────────────────────────────────
  function getPaths()              { /* 原 443-448 */ }
  function refreshPathsUI()        { /* 原 450-476 */ }
  async function onPickTemplate()  { /* 原 478-493，sendMessage → sendNative */ }
  async function onPickOutputDir() { /* 原 495-510，sendMessage → sendNative */ }

  // ── 状态栏（feature view 内的 #tal-status） ───────────────────────────────
  function setStatus(text, type = '') { /* 原 512-517 */ }

  // ── 商品状态 ──────────────────────────────────────────────────────────────
  function getWidthRatio()         { /* 原 432-440 */ }
  function setProduct(p)           { /* 原 519-523 */ }
  function clearSelection()        { /* 原 525-529 */ }
  function refreshProductUI()      { /* 原 323-370，注意 state.product → fstate.product */ }

  // ── 行绑定 ────────────────────────────────────────────────────────────────
  function waitForTableThenBind(timeout = 15000) { /* 原 561-569 */ }
  function bindRows(rows)          { /* 原 571-580 */ }
  function watchNewRows()          { /* 原 582-588 */ }
  function selectRow(row)          { /* 原 590-597 */ }

  // ── 数据提取 ──────────────────────────────────────────────────────────────
  function getColumnIndex(text)    { /* 原 602-606 */ }
  function extractRowData(row)     { /* 原 608-614 */ }

  // ── Phase 1：标签生成 ─────────────────────────────────────────────────────
  async function onRunAllPhases()  { /* 原 619-669，注意 sendMessage→sendNative */ }
  async function onRunPhase1Only() { /* 原 672-712，同上 */ }
  function findViewBarcodeBtn(row) { /* 原 717-720 */ }
  async function clickAndCaptureCanvas(row) { /* 原 722-756 */ }
  function waitForBarcodeCanvas(timeout = 12000) { /* 原 758-761，依赖 U.waitForEl */ }
  function computeCanvasStats(canvas)            { /* 原 764-784 */ }
  async function waitForCanvasRendered(canvas, timeout = 10000) { /* 原 788-810 */ }
  function extractSkcFromModal()   { /* 原 812-820 */ }

  // ── Phase 2 流程状态 + 文件读取 ──────────────────────────────────────────
  function getCFlow()   { /* 原 835-837 */ }
  function setCFlow(d)  { /* 原 838 */ }
  function clearCFlow() { /* 原 839 */ }
  async function readFileChunked(path) { /* 原 849-873，sendMessage→sendNative */ }

  // ── Phase 2 Rocket UI 工具 ────────────────────────────────────────────────
  function rocketSelectById(id)                   { /* 原 908-912 */ }
  function findFormItemByLabel(labelText, root = document) { /* 原 914-932 */ }
  function findSelectFlexible(id, labelText, root = document) { /* 原 934-945 */ }
  function findSectionByOwnTitle(drawer, title)   { /* 原 947-956 */ }
  function findGroupHeader(drawer, title)         { /* 原 958-967 */ }
  function getSectionsInGroup(drawer, groupTitle) { /* 原 969-987 */ }
  function getFormItemsWithLabel(section)         { /* 原 989-1010 */ }
  async function applyFieldRule(field, sectionRoot, ctx) { /* 原 1011-1062 */ }
  async function applyPhase2Rules(drawer, ctx)    { /* 原 1063-1088 */ }
  async function rocketSelect(container, optionTextOrIndex) { /* 原 1090-1146 */ }
  async function safeSelect(el, option, fieldName)         { /* 原 1147-1151 */ }
  function rocketSelectHasValue(container)        { /* 原 1581-1592 */ }
  function getMultiSelectTags(container)          { /* 原 1594-1599 */ }
  async function removeAllSelectedTags(container) { /* 原 1601-1623 */ }
  async function ensureSelected(container, option, fieldName)   { /* 原 1625-1675 */ }
  async function selectIfEmpty(container, option, fieldName)    { /* 原 1677-1693 */ }
  async function fillTextIfEmpty(inputId, value, fieldName, root = document) { /* 原 1695-1706 */ }
  async function fillInputByLabel(labelText, value, root = document) { /* 原 1708-1721 */ }
  function buildRowspanColMap(rows, totalCols)    { /* 原 1550-1579 */ }

  // ── Phase 2 主流程 ────────────────────────────────────────────────────────
  async function onStartCompliance()           { /* 原 1178-1188 */ }
  async function checkAndRunStep1()            { /* 原 1190-1196 */ }
  async function runStep1(flow)                { /* 原 1198-1235 */ }
  function extractSpuFromPage()                { /* 原 1237-1249 */ }
  async function checkAndRunStep2or3()         { /* 原 1251-1262 */ }
  async function runStep2(flow)                { /* 原 1264-1308 */ }
  async function waitForDrawerOpen(timeout = 12000)      { /* 原 1310-1323，依赖 U.waitForEl */ }
  async function waitForAllSectionsRendered(drawer, timeout = 20000) { /* 原 1325-1348 */ }
  function findRowBySpu(spuId)                 { /* 原 1350-1372 */ }
  async function waitForRowBySpu(spuId, timeout = 6000)  { /* 原 1374-1383 */ }
  async function ensureQueryMatchesSpu(spuId, maxAttempts = 3) { /* 原 1385-1404 */ }
  async function runStep3(flow)                { /* 原 1406-1473 */ }
  async function checkComplianceColumnAllSuccess(spuId)  { /* 原 1475-1548 */ }

  // ── Phase 3 流程 ──────────────────────────────────────────────────────────
  function getImgFlow()  { /* 原 1723-1725 */ }
  function setImgFlow(d) { /* 原 1726 */ }
  function clearImgFlow(){ /* 原 1727 */ }
  async function onStartImageUpload()    { /* 原 1729-1741 */ }
  async function checkAndRunImgUpload()  { /* 原 1743-1750 */ }
  async function runImgSearch(flow)      { /* 原 1752-1796 */ }
  async function runImgUpload(flow)      { /* 原 1798-1825 */ }
  async function uploadToLabelSlots(bytes, filename) { /* 原 1827-1852 */ }
  function mimeFromName(filename)        { /* 原 1854-1859 */ }
  async function injectFileToInput(fileInput, bytes, filename) { /* 原 1861-1873 */ }

  // ── Feature view 渲染 ────────────────────────────────────────────────────
  function renderAutoGenLabel(viewEl) {
    /* 把原 renderFeature 中 if (fid === 'auto') 分支的 view.innerHTML 整段粘贴 */
    /* 然后绑定按钮：
       - tal-btn-auto → onRunAllPhases
       - tal-clear → clearSelection
       - tal-path-template → onPickTemplate
       - tal-path-output → onPickOutputDir
       - TAL_DEBUG 时：tal-btn-debug → onRunPhase1Only，tal-debug-ratio change → localStorage.setItem
    */
    refreshPathsUI();
    refreshProductUI();
  }

  // ── 注册到 core ───────────────────────────────────────────────────────────
  window.AgentSeller.registerFeature({
    id: 'auto_gen_label',
    icon: '🚀',
    label: '标签生成',
    locked: false,
    init() {
      // 注册页面变化分发：包含原 onPageChange (539-549) 的所有动作
      onPageChange(() => {
        if (isBarcodeManagementPage())     waitForTableThenBind();
        if (isCompliantLivePhotosPage())   { checkAndRunStep1(); checkAndRunImgUpload(); }
        if (isComplianceInfoPage())        checkAndRunStep2or3();
        // feature 视图中刷新按钮状态和提示文字
        const uiState = window.__AgentSellerUI?.getState?.();
        if (uiState?.view === 'feature' && uiState.feature === 'auto_gen_label') {
          refreshProductUI();
          const el = document.getElementById('tal-product-empty');
          if (el) el.textContent = isBarcodeManagementPage() ? '请点击商品行选择' : '请导航到条码管理页';
        }
      });
    },
    render(viewEl) {
      renderAutoGenLabel(viewEl);
    },
  });
})();
```

**实施关键点**：

1. **整段粘贴策略**：每个函数从原文件 Read 出精确文本，把外层 IIFE 缩进减一级（4 空格 → 2 空格或保留原样均可），保持函数体内逻辑不变。
2. **依赖替换**：
   - `sleep(...)` → `U.sleep(...)`
   - `ensureExtensionAlive()` → `U.ensureExtensionAlive()`
   - `waitForEl(...)` → `U.waitForEl(...)`（含原 `waitForBarcodeCanvas` `waitForDrawerOpen` 内的调用）
   - `normText / findByText / setInputValue / showToast / makeDraggable` → `U.xxx`
3. **chrome.runtime.sendMessage 改造**：
   - 原模式：`const resp = await chrome.runtime.sendMessage({ type: 'X', data: {...} }); if (!resp.success) throw; if (!resp.result?.success) throw resp.result?.error;`
   - 新模式：`const result = await sendNative('X', {...});`（sendNative 已剥外层 success 包装，并把 `!result.success` 也抛出）
   - 但有些调用读取 `result.path` / `result.size` / `result.data`，要确认 sendNative 返回的就是 native_host 返回的 dict 本体（registry.js Task 10 实现：`return resp.result;` 对应 service-worker.js 的 `sendResponse({ success: true, result })`，所以 `result` 就是 native_host 的 dict 本体，含 `success` 字段）
   - 所以 feature 代码内仍需检查 `if (!result.success) throw new Error(result.error)` —— 这是 native_host 自报的失败
4. **state → fstate**：原 content-script.js 顶部的 `state` 既有 view/feature（移到 core ui.js 的内部 state）也有 product（保留在 feature 内的 fstate）。本 task 内所有 `state.product` 替换为 `fstate.product`。`state.view` `state.feature` 改用 `window.__AgentSellerUI.getState().view/feature`。
5. **TAL_DEBUG**：常量保留，package.bat 在打包 release 时仍需替换它。

- [ ] **Step 3: 跑构建**

```bash
python3 build/build_extension.py
wc -l auto_gen_label/content/index.js
```

Expected: index.js 约 1500-1700 行（去掉原文件里的 core 部分约 200 行）。

- [ ] **Step 4: Chrome 加载完整验证**

Chrome reload 扩展 → 打开 Temu 条码管理页 → 验证：

1. FAB 出现 → Ctrl+Click → Hub 出现 "🚀 标签生成" 卡片
2. 点卡片 → feature view 显示路径设置、商品空状态、状态栏
3. 点商品行 → 商品被选中、商品卡填充
4. 点"开始执行" → Phase 1 启动（捕获条码 → 调 native → 生成标签）
5. Phase 1 完成后自动跳转 `/govern/compliant-live-photos`，Phase 2 启动
6. Phase 2 完成后 Phase 3 启动

- [ ] **Step 5: 验证检查点**

至少 Phase 1 跑通（PDF + PNG 文件产出）；Phase 2/3 因依赖具体页面状态，做冒烟级验证（启动流程、不报 `Uncaught` 异常即可，完整验证留到 Task 18）。

---

## Task 13: build_extension.py 注入 sourceURL

**目标**：每个 .js 文件拷贝到 dist 时在文件**末尾**追加 `//# sourceURL=<src 相对路径>` 注释，DevTools 显示源码路径。

**为什么放在末尾**：sourceURL 注释规范允许出现在文件任意位置，放末尾不破坏原有的 `(function(){...})()` IIFE 包装的首行可读性。

**Files:**
- Modify: `build/build_extension.py`

- [ ] **Step 1: 添加注入函数**

在 `build/build_extension.py` 顶部 imports 之后添加：

```python
def _inject_source_url(dst_file: Path, src_rel: str):
    """在 .js 文件末尾追加 //# sourceURL=<src_rel> 注释。"""
    if dst_file.suffix != '.js':
        return
    content = dst_file.read_text(encoding='utf-8')
    if '//# sourceURL=' in content:
        return  # 幂等
    dst_file.write_text(content.rstrip() + f'\n//# sourceURL={src_rel}\n', encoding='utf-8')
```

- [ ] **Step 2: 在 copy_core_assets 中调用**

```python
def copy_core_assets():
    for sub in ['background', 'content', 'popup', 'icons']:
        src = CORE / sub
        if not src.exists():
            continue
        dst = DIST / sub
        shutil.copytree(src, dst)
        # 注入 sourceURL
        for js in dst.rglob('*.js'):
            rel_to_root = (CORE / sub / js.relative_to(dst)).relative_to(ROOT)
            _inject_source_url(js, str(rel_to_root))
        print(f'[build] {sub}/ → dist/extension/{sub}/  ({sum(1 for _ in dst.rglob("*") if _.is_file())} files)')
```

- [ ] **Step 3: 在 copy_feature_assets 中调用**

```python
def copy_feature_assets(features):
    for f in features:
        src_dir = f['_dir']
        src_script = src_dir / f['content_script']
        dst_script = DIST / 'features' / f['id'] / f['content_script']
        dst_script.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_script, dst_script)
        rel_to_root = src_script.relative_to(ROOT)
        _inject_source_url(dst_script, str(rel_to_root))
        print(f'[build] {rel_to_root} → dist/extension/features/{f["id"]}/{f["content_script"]}')
```

- [ ] **Step 4: 跑构建并验证**

```bash
python3 build/build_extension.py
tail -3 dist/extension/content/core.js
tail -3 dist/extension/features/auto_gen_label/content/index.js
```

Expected: 末尾分别看到
```
//# sourceURL=core/content/core.js
```
```
//# sourceURL=auto_gen_label/content/index.js
```

- [ ] **Step 5: Chrome 验证**

Chrome reload 扩展 → 打开 Temu 页面 → DevTools Sources 面板：

Expected: 文件树里看到的不是 `dist/extension/...` 而是 `core/content/...` 和 `auto_gen_label/content/index.js`。

---

## Task 14: 写 build/dev.py（watch 模式）

**目标**：用 watchdog 监听源目录，文件变更增量同步到 dist；feature.json 变化时重新生成 manifest。

**Files:**
- Create: `build/dev.py`
- Create: `build/requirements-dev.txt`

- [ ] **Step 1: 写 requirements-dev.txt**

```bash
cat > build/requirements-dev.txt <<'EOF'
watchdog>=3.0.0
EOF
```

- [ ] **Step 2: 安装 watchdog**

```bash
pip install -r build/requirements-dev.txt
```

- [ ] **Step 3: 写 dev.py**

```bash
cat > build/dev.py <<'PYEOF'
"""
dev.py — watch 模式：监听源目录，增量同步到 dist/extension/。
启动时先全量构建一次，之后只同步变化的文件。
"""
import sys
import time
import shutil
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_extension import (
    ROOT, CORE, DIST, build_all, scan_features, render_manifest, _inject_source_url
)


def _src_to_dst(src_path: Path):
    """把源路径映射到 dist 路径。返回 None 表示忽略。"""
    try:
        rel = src_path.relative_to(ROOT)
    except ValueError:
        return None
    parts = rel.parts
    if not parts:
        return None
    # core/sub/... → dist/extension/sub/...
    if parts[0] == 'core' and len(parts) >= 3 and parts[1] != 'manifest.template.json':
        return DIST / Path(*parts[1:])
    # core/manifest.template.json → 需要重新生成 manifest（不直接拷贝）
    # <feature>/content/... → dist/extension/features/<feature>/content/...
    if len(parts) >= 3 and parts[1] == 'content':
        feature_id = parts[0]
        return DIST / 'features' / feature_id / Path(*parts[1:])
    return None


def _on_change(src_path: Path):
    rel = src_path.relative_to(ROOT)
    # feature.json 变化：重生 manifest
    if src_path.name == 'feature.json' or src_path.name == 'manifest.template.json':
        features = scan_features()
        render_manifest(features=features)
        print(f'[manifest] 检测到 {rel} 变化，重生 manifest.json')
        return
    dst = _src_to_dst(src_path)
    if not dst:
        return
    if src_path.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_path, dst)
        if dst.suffix == '.js':
            _inject_source_url(dst, str(rel))
        print(f'[sync] {rel} → {dst.relative_to(ROOT)}')
    else:
        if dst.exists():
            dst.unlink()
            print(f'[sync] 删除 {dst.relative_to(ROOT)}')


class Handler(FileSystemEventHandler):
    def on_modified(self, event):
        if not event.is_directory:
            _on_change(Path(event.src_path))

    def on_created(self, event):
        if not event.is_directory:
            _on_change(Path(event.src_path))

    def on_deleted(self, event):
        if not event.is_directory:
            _on_change(Path(event.src_path))


def main():
    print('[dev] 启动初始构建...')
    build_all()
    print('[watch] monitoring: core/, */content/, */feature.json')
    print(f'[watch] chrome 请加载 {DIST}，修改源码会自动同步')

    obs = Observer()
    handler = Handler()
    # 监听 core/
    obs.schedule(handler, str(CORE), recursive=True)
    # 监听每个 feature 目录
    for f in scan_features():
        obs.schedule(handler, str(f['_dir']), recursive=True)
    obs.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        obs.stop()
    obs.join()


if __name__ == '__main__':
    main()
PYEOF
```

- [ ] **Step 4: 运行测试**

启动 dev.py：

```bash
python3 build/dev.py
```

Expected 控制台：
```
[dev] 启动初始构建...
[build] background/ → dist/extension/background/  (1 files)
[build] content/    → dist/extension/content/     (4 files)
[build] popup/      → dist/extension/popup/       (2 files)
[build] icons/      → dist/extension/icons/       (3 files)
[build] discovered feature: auto_gen_label
[build] auto_gen_label/content/index.js → dist/extension/features/auto_gen_label/content/index.js
[build] manifest.json generated  (1 features, 5 content scripts)
[build] done → /home/linux_dev/projects/agentseller_temu/dist/extension
[watch] monitoring: core/, */content/, */feature.json
[watch] chrome 请加载 .../dist/extension，修改源码会自动同步
```

- [ ] **Step 5: 在另一个终端修改文件验证同步**

在 dev.py 运行期间，另开终端：

```bash
echo "// touched $(date)" >> core/content/core.js
```

Expected dev.py 控制台立即输出：
```
[sync] core/content/core.js → dist/extension/content/core.js
```

完成后 `git checkout` 或手动还原 core.js 末尾的 touch 行。

- [ ] **Step 6: 验证检查点**

Ctrl+C 退出 dev.py。dist/ 状态完整，可以重新跑 `python3 build/build_extension.py` 验证幂等。

---

## Task 15: 写 build/package_all.py

**目标**：串联：构建 extension dist → 调 feature 的 build.bat 打 native_host EXE → 拼员工部署包到 `dist/TemuLabel_Setup/`。

**Files:**
- Create: `build/package_all.py`

- [ ] **Step 1: 检查 auto_gen_label/build/build.bat 当前内容**

```bash
cat auto_gen_label/build/build.bat auto_gen_label/build/package.bat
```

记录：
- build.bat 是否引用了 `auto_gen_label/extension/`（如果是，Task 17 删除旧 extension 之后会失效，需要调整）
- package.bat 是否引用了 `auto_gen_label/extension/`

如果有引用：在 Task 17 删除旧 extension 之前，**先**修改 build.bat / package.bat 把 `auto_gen_label/extension/` 改为 `../../dist/extension/`（相对 `auto_gen_label/build/` 的路径）。

- [ ] **Step 2: 写 package_all.py**

```bash
cat > build/package_all.py <<'PYEOF'
"""
package_all.py — 出员工部署包：
1) 跑 build_extension 出 dist/extension/
2) 调 auto_gen_label/build/build.bat 出 TemuLabelHost.exe
3) 拼装 dist/TemuLabel_Setup/{extension, TemuLabelHost.exe, install.bat}
"""
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_extension import ROOT, DIST, build_all

SETUP_DIR = ROOT / 'dist' / 'TemuLabel_Setup'


def main():
    # Step 1: 构建 extension
    print('[package] 1/3 构建 extension dist...')
    build_all()

    # Step 2: 调 feature 内构建脚本（Windows 平台）
    print('[package] 2/3 构建 native_host EXE...')
    build_bat = ROOT / 'auto_gen_label' / 'build' / 'build.bat'
    if not build_bat.exists():
        print(f'[package] 错误：{build_bat} 不存在', file=sys.stderr)
        sys.exit(1)
    # Windows 平台用 cmd.exe；其他平台跳过（仅支持 Windows 部署）
    if sys.platform == 'win32':
        subprocess.check_call(['cmd', '/c', str(build_bat)], cwd=str(build_bat.parent))
    else:
        print('[package] 非 Windows 平台，跳过 EXE 构建（仅在 Windows 上能出可用部署包）')

    # Step 3: 拼装部署包
    print('[package] 3/3 拼装部署包...')
    if SETUP_DIR.exists():
        shutil.rmtree(SETUP_DIR)
    SETUP_DIR.mkdir(parents=True)
    # extension 目录
    shutil.copytree(DIST, SETUP_DIR / 'extension')
    # native_host EXE（约定输出在 auto_gen_label/build/dist/TemuLabelHost.exe，按当前 build.bat 实际产物调整）
    exe_candidates = list((ROOT / 'auto_gen_label' / 'build').glob('**/TemuLabelHost.exe'))
    if exe_candidates:
        shutil.copy2(exe_candidates[0], SETUP_DIR / 'TemuLabelHost.exe')
    else:
        print('[package] 警告：未找到 TemuLabelHost.exe，部署包不完整')
    # install.bat
    install_bat = ROOT / 'auto_gen_label' / 'native_host' / 'install.bat'
    if install_bat.exists():
        shutil.copy2(install_bat, SETUP_DIR / 'install.bat')
    print(f'[package] 完成 → {SETUP_DIR}')


if __name__ == '__main__':
    main()
PYEOF
```

**说明**：

- 实际 `auto_gen_label/build/build.bat` 的 EXE 输出路径取决于现有脚本（PyInstaller 默认在 `dist/`），脚本里用 `glob('**/TemuLabelHost.exe')` 兜底搜索
- 如果脚本路径细节与现状不符，按现状调整 `exe_candidates` 的搜索路径

- [ ] **Step 3: 验证检查点（Linux 上做静态验证，Windows 验证留到 Task 18）**

```bash
python3 build/package_all.py
ls dist/TemuLabel_Setup/
```

Expected: 看到 `extension/` 目录 + 一条"非 Windows 平台跳过 EXE"的告警；`install.bat` 文件已拷入。完整 Windows 部署包验证留到 Task 18。

---

## Task 16: 写顶层 CLAUDE.md 与 feature CLAUDE.md

**目标**：把架构、构建命令、worktree 工作流写到顶层 CLAUDE.md；把现有 auto_gen_label 的实现细节（BarTender SDK、Temu 选择器、Phase 1/2/3 流程）写到 feature CLAUDE.md。

**Files:**
- Create: `CLAUDE.md`（顶层）
- Create: `auto_gen_label/CLAUDE.md`（替换 auto_gen_label/extension 删除时一并消失的旧版）

**注**：原 `auto_gen_label/CLAUDE.md` 在仓库根目录的 `auto_gen_label/` 内，删除旧 extension/ 不会影响它。本 task 是改写它。

- [ ] **Step 1: 写顶层 CLAUDE.md**

内容大纲（实施时直接写入，参考 spec §10.1）：

```markdown
# AgentSeller for Temu — 多 Feature Chrome 插件

## Project Overview
Chrome 插件 + Python Native Host 组合，自动化 Temu 商家中心的各项操作。
公共骨架（FAB / Panel / Hub / 消息路由）+ 多个独立 feature。

## Architecture
- core/ ：公共骨架源码
- <feature>/ ：每个 feature 一个目录（chrome 端 + native 端 + 调试辅料 + 文档）
- build/ ：构建脚本（聚合到 dist/extension/）
- dist/extension/ ：chrome 加载点（构建产物，gitignored）

## Directory Layout
[详细的目录树，对应 spec §3]

## Feature 注册契约
每个 feature 根目录放 feature.json：
[字段说明，对应 spec §5]

## Core API
window.AgentSeller 暴露的接口：
[API 说明，对应 spec §6]

## Build Commands
- python build/build_extension.py — 一次性构建
- python build/dev.py             — watch 模式（日常开发）
- python build/package_all.py     — 出员工部署包

## 新增 Feature 标准工作流（worktree 友好）
[按 spec §11.2 五步走：fetch main / 评估 core API / 必要时先做 core PR / 开 feature 分支 / 在 feature 目录内开发]

## 部署
[员工机器一键安装：跑 install.bat]
```

直接用 Write 工具写完整文件，参考 `docs/superpowers/specs/2026-05-19-extension-multi-feature-architecture-design.md` 的 §3 / §5 / §6 / §11 抽取关键内容。

- [ ] **Step 2: 写 auto_gen_label/CLAUDE.md**

基于原 `auto_gen_label/CLAUDE.md` 重写，加入 feature 元数据和新结构说明：

```markdown
# auto_gen_label Feature

## 概述
Feature ID: auto_gen_label
作用：自动化 Temu 标签生成 + 合规信息填写 + 标签主图插入。

## feature.json 元数据
[列出 feature.json 当前字段]

## 内部组织
- content/index.js ：所有 chrome 端业务（Phase 1/2/3）
- native_host/     ：Python 端，BarTender SDK + 文件对话框
- build/           ：PyInstaller 打 EXE
- samples/         ：DOM 抓取样本，调试用

## Phase 1：标签生成
[继承原 CLAUDE.md 的 BarTender SDK 调用细节、关键枚举、Resolution 构造说明]

## Phase 2：合规信息填写
[新增：现有 content/index.js 中 Phase 2 部分的核心流程概览、Temu Rocket UI 工具集说明]

## Phase 3：标签主图插入
[新增：现有 content/index.js 中 Phase 3 部分的核心流程概览]

## Temu 弹窗结构 / 页面说明
[继承原 CLAUDE.md]

## Native Messaging 协议
[继承原 CLAUDE.md，但注意现在通过 window.AgentSeller.sendNative 调用]

## Native Host 注册
[继承原 CLAUDE.md]

## samples/ 目录说明
- html.txt: Temu 条码管理页 DOM 抓取
- barcode.txt: 条码弹窗 DOM 抓取
- compliant-live-photos.txt / information-supplementation*.txt: Phase 2 页面 DOM 抓取
- rocket-drawer*.txt: Rocket UI Drawer DOM 抓取
- background.png: 标签背景图
- temu_label_host.log: 运行日志样本
```

直接用 Write 工具写完整文件，参考 `auto_gen_label/extension/` 内还能找到的旧 CLAUDE.md 内容（在 `auto_gen_label/CLAUDE.md` 文件里，不是 extension/ 内）。

- [ ] **Step 3: 验证检查点**

```bash
ls CLAUDE.md auto_gen_label/CLAUDE.md
wc -l CLAUDE.md auto_gen_label/CLAUDE.md
```

Expected: 两个文件都存在，行数合理（顶层 ~80-120 行，feature 50-150 行）。

---

## Task 17: 删除旧路径

**目标**：迁移已完成，删除 `auto_gen_label/extension/` 整个目录（其内容已搬至 `core/` 和 `auto_gen_label/content/`）。

**Files:**
- Delete: `auto_gen_label/extension/`（整个目录）

- [ ] **Step 1: 最后一次确认所有内容都已迁移**

```bash
diff -r auto_gen_label/extension/icons/      core/icons/         # 应输出空
diff      auto_gen_label/extension/popup/popup.html core/popup/popup.html
diff      auto_gen_label/extension/popup/popup.js   core/popup/popup.js
diff      auto_gen_label/extension/background/service-worker.js core/background/service-worker.js
ls        auto_gen_label/content/index.js
```

Expected 全部输出为空（diff 无差异）+ index.js 存在。

- [ ] **Step 2: Task 3 记录的 build.bat / package.bat 路径调整**

如果 Task 3 Step 2 记录了 `auto_gen_label/build/build.bat` 或 `package.bat` 引用了 `auto_gen_label/extension/`，**现在**修改它们，把 `auto_gen_label/extension/` 改为相应的 `../../dist/extension/` 或其他正确路径（具体取决于 build.bat 当前用法）。

```bash
grep -n 'extension' auto_gen_label/build/build.bat auto_gen_label/build/package.bat
# 如有匹配，按需修改
```

- [ ] **Step 3: 删除旧 extension 目录**

```bash
rm -rf auto_gen_label/extension/
```

- [ ] **Step 4: 重新构建确认无破坏**

```bash
python3 build/build_extension.py
find dist/extension -type f | sort
```

Expected: dist 仍然完整（manifest.json + background/ + content/ + popup/ + icons/ + features/auto_gen_label/content/index.js）。

- [ ] **Step 5: 验证检查点**

```bash
ls auto_gen_label/
```

Expected: `CLAUDE.md  build  content  feature.json  native_host  samples`（无 extension/）。

---

## Task 18: 功能验证（完整）

**目标**：按 spec §13 验证清单逐项确认，全部通过才进入 Task 19 commit。

- [ ] **Step 1: 静态验证**

```bash
python3 build/build_extension.py
python3 -c "
import json
m = json.load(open('dist/extension/manifest.json'))
print('content_scripts.js:', m['content_scripts'][0]['js'])
print('host_permissions:',   m['host_permissions'])
print('permissions:',        m['permissions'])
"
```

Expected:
- content_scripts.js 顺序：`['content/utils.js', 'content/ui.js', 'content/registry.js', 'content/core.js', 'features/auto_gen_label/content/index.js']`
- host_permissions 含 `https://seller.temu.com/*` 和 `https://*.temu.com/*`
- permissions 含 `nativeMessaging`

```bash
# 检查 sourceURL 注入
grep -l 'sourceURL=' dist/extension/content/*.js dist/extension/features/auto_gen_label/content/index.js
```

Expected: 5 个 .js 文件都包含 sourceURL 注释。

- [ ] **Step 2: watch 模式验证**

```bash
python3 build/dev.py &  # 后台运行；或另开终端
sleep 2
echo "// touch $(date)" >> core/content/core.js
sleep 2
tail -2 dist/extension/content/core.js  # 应包含刚追加的注释
# 还原
sed -i '/^\/\/ touch /d' core/content/core.js
kill %1
```

- [ ] **Step 3: Chrome 加载 + UI 验证**

1. `chrome://extensions` → 开发者模式 → 加载已解压扩展程序 → `dist/extension/`
2. 打开 `https://seller.temu.com/`，右下角看到 📦 FAB
3. Ctrl + 点击 FAB → 展开 Hub，看到 "🚀 标签生成" 卡片
4. DevTools Sources 面板：文件树展示成 `auto_gen_label/content/index.js`、`core/content/core.js` 等源码路径，而不是 `dist/...`
5. Console 看到 `[AgentSeller] core ready`，无 `Uncaught` 错误

- [ ] **Step 4: 功能 — Phase 1**

1. 进入 Temu 条码管理页（`/goods/label` 或类似路径）
2. 设置模板路径（点"模板"路径行 → 选 BarTender .btw 文件）
3. 设置输出目录（点"输出"路径行 → 选目录）
4. 点商品行 → 商品卡显示 SKC 和 SKC货号
5. 点"开始执行"→ 状态栏依次显示"捕获条码"、"标签生成中"
6. 输出目录里应生成 `<skcSku>.pdf` 和 `<skcSku>.png` 各 1 个

- [ ] **Step 5: 功能 — Phase 2**

1. Phase 1 完成后会自动跳转 `/govern/compliant-live-photos`
2. 流程自动启动：点击查询、点击编辑、打开 Drawer
3. 字段自动填充（按 applyPhase2Rules 规则）
4. 提交后自动跳转 `/govern/information-supplementation`
5. 合规信息页字段自动填充
6. 流程完成后状态栏显示成功

- [ ] **Step 6: 功能 — Phase 3**

1. Phase 2 完成后 Phase 3 启动（图片搜索 + 上传到 label 槽位）
2. 标签 PNG（Phase 1 生成的）自动上传到指定槽位

- [ ] **Step 7: 部署链路验证（Windows 上做，Linux 跳过）**

```bash
python3 build/package_all.py
ls dist/TemuLabel_Setup/
```

Expected（Windows）：`extension/`、`TemuLabelHost.exe`、`install.bat` 三项齐全。

在干净的 Windows 机器上：跑 `install.bat` → 加载 `extension/` → 重新执行 Step 4 的 Phase 1 流程能跑通。

- [ ] **Step 8: 验证检查点**

以上 7 步全部通过；如有任何一步失败，从备份目录回滚相关文件重新排查，**禁止**为了"看起来跑通"修改测试或绕过验证。

---

## Task 19: git init + 首个 commit

**目标**：所有重构动作完成、功能验证通过，初始化 git 并做第一个 commit。

**Files:**
- Initialize: git repository at project root
- Commit: 所有新结构

- [ ] **Step 1: 初始化 git**

```bash
cd /home/linux_dev/projects/agentseller_temu
git init
git config user.email "yinghuipeng5@gmail.com"
git config user.name "<your-git-username>"
```

- [ ] **Step 2: 确认 .gitignore 生效**

```bash
git status --short | head
```

Expected: 不出现 `dist/`、`__pycache__/`、`*.log` 等被忽略的内容。

- [ ] **Step 3: 全量 add**

```bash
git add CLAUDE.md .gitignore \
        core/ \
        auto_gen_label/CLAUDE.md auto_gen_label/feature.json \
        auto_gen_label/content/ auto_gen_label/native_host/ \
        auto_gen_label/build/ auto_gen_label/samples/ \
        build/ \
        docs/
git status --short
```

Expected: 所有相关文件已暂存，无遗漏。

- [ ] **Step 4: 首个 commit**

```bash
git commit -m "$(cat <<'EOF'
feat(architecture): 多 feature 插件架构落地

Why: 把原 auto_gen_label/ 单 feature 结构升级为「公共骨架 core/ +
     多个独立 feature 目录」的 plugin 架构，支持后续 worktree
     并行开发 feature 0 冲突，且每个 feature 自治（chrome 端 +
     native 端 + 调试辅料 + 文档都在一个目录）。

What:
  - 新增 core/（FAB/Panel/Hub/消息路由/utils 公共骨架）
  - auto_gen_label/ 升级为自治 feature，含 feature.json
  - 新增 build/（build_extension.py / dev.py / package_all.py）
  - chrome 加载点改为构建产物 dist/extension/
  - 1900 行 content-script.js 按职责拆为 utils.js / ui.js /
    registry.js / core.js / features/auto_gen_label/content/index.js
  - 设计文档与实施计划纳入 docs/superpowers/

Test:
  - 静态验证：build_extension.py 全量构建无报错
  - 功能验证：Phase 1/2/3 全部跑通（条码捕获→标签生成→合规填写→主图上传）
  - 调试体验验证：DevTools Sources 面板按源码路径展示
EOF
)"
```

- [ ] **Step 5: 验证检查点**

```bash
git log --oneline
git ls-files | head -20
```

Expected: 看到首个 commit；`git ls-files` 列出的文件不含 dist/ 内容。

- [ ] **Step 6: 清理备份（可选）**

如果 Task 18 全部验证通过且 commit 成功，可以删除 Task 1 创建的备份：

```bash
rm -rf /home/linux_dev/projects/agentseller_temu_backup_20260519
```

或者保留 1-2 周作为兜底。

---

## 自查清单（plan 完整性）

完成后逐项核对：

- [ ] Spec §3 目录结构 → Task 1 创建骨架 + Task 2/3 搬运 + Task 7/12 填充 feature
- [ ] Spec §5 feature.json 契约 → Task 7 写文件 + 构建脚本扫描
- [ ] Spec §6 window.AgentSeller API → Task 10 实现 registry.js
- [ ] Spec §7 构建与 watch 链路 → Task 5/13 build_extension.py + Task 14 dev.py
- [ ] Spec §8 sourceURL 调试体验 → Task 13
- [ ] Spec §9 辅料归宿 → Task 2 Step 3
- [ ] Spec §10 CLAUDE.md 拆分 → Task 16
- [ ] Spec §11 Worktree 工作流 → Task 16 顶层 CLAUDE.md 内含工作流文档
- [ ] Spec §12 不变量（行为保持） → Task 18 功能验证
- [ ] Spec §13 验证计划 → Task 18 三阶段验证
