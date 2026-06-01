# 扩展自检 + 自动 reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 员工装新 installer 后扩展自动应用（无需手动 `chrome://extensions` reload）。

**Architecture:** 三方协作 —— installer 装完写 `{app}\installed_version.txt` marker → native host 加 `get_installed_version` action 读 marker → SW 启动时自检对比 `chrome.runtime.getManifest().version`，磁盘版本更高即 `chrome.runtime.reload()` 自我重载。silent 模式（员工无感）。

**Tech Stack:** Inno Setup Pascal Script、Python（native host）、Chrome MV3 service worker（classic + importScripts）、`node:test` 纯逻辑单测。

**Spec:** `docs/superpowers/specs/2026-05-31-extension-auto-reload-on-installer-update-design.md`

**关键限制（务必知晓）：** v1.1.1 → v1.2.0 这次升级救不了（v1.1.1 已发出无自检代码，员工仍需手动 reload 一次）。**v1.2.1 起对未来所有升级生效**。本计划落地后用 v1.2.1 tag 发版。

---

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `core/background/version-cmp.js` | 纯逻辑版本号比较（双模式：`self.cmpVersion` + `module.exports`） | **新建** |
| `tests/version-cmp.test.js` | `node --test` 纯逻辑单测 | **新建** |
| `core/background/service-worker.js` | SW 编排 + 现有钩子 | 顶部 `importScripts('version-cmp.js')` + 加 `checkInstalledVersion` + 3 处触发 |
| `native_host/main.py` | Native messaging 入口 + DISPATCH 路由 | 加 `_get_installed_version` 函数 + DISPATCH 一行 |
| `deploy/installer.iss` | Inno Setup 安装脚本 | `[Code] CurStepChanged` ssDone 分支顶部加 `SaveStringToFile` 写 marker |
| `CLAUDE.md`（项目根） | 项目级文档 | Deployment 段加「扩展自检 + 自动 reload 机制」小节 |

**依赖顺序**：Task 1 纯逻辑（无依赖）→ Task 2 SW（依赖 Task 1 的 version-cmp.js）→ Task 3 native host（独立但 SW 自检会调它）→ Task 4 installer（独立）→ Task 5 收尾。

---

## Task 1: 纯逻辑 `cmpVersion` 模块（TDD）

**Files:**
- Create: `core/background/version-cmp.js`
- Create: `tests/version-cmp.test.js`

- [ ] **Step 1: 写失败测试**

新建 `tests/version-cmp.test.js`：

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { cmpVersion } = require('../core/background/version-cmp.js');

test('cmpVersion: 高版本 > 低版本', () => {
  assert.strictEqual(cmpVersion('1.3.0', '1.2.0') > 0, true);
  assert.strictEqual(cmpVersion('2.0.0', '1.9.9') > 0, true);
});
test('cmpVersion: 相等', () => {
  assert.strictEqual(cmpVersion('1.2.0', '1.2.0'), 0);
  assert.strictEqual(cmpVersion('1.0.0', '1.0.0'), 0);
});
test('cmpVersion: 低版本 < 高版本', () => {
  assert.strictEqual(cmpVersion('1.2.0', '1.3.0') < 0, true);
});
test('cmpVersion: 段数不等（短补 0）', () => {
  assert.strictEqual(cmpVersion('1.2', '1.2.0'), 0);
  assert.strictEqual(cmpVersion('1.2', '1.2.1') < 0, true);
  assert.strictEqual(cmpVersion('1.3', '1.2.9') > 0, true);
});
test('cmpVersion: NaN 段算 0（安全降级）', () => {
  assert.strictEqual(cmpVersion('1.x.0', '1.0.0'), 0);
  assert.strictEqual(cmpVersion('abc', 'def'), 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/version-cmp.test.js`
Expected: FAIL —— `Cannot find module '../core/background/version-cmp.js'`（文件尚未创建）。

- [ ] **Step 3: 实现 `version-cmp.js`**

新建 `core/background/version-cmp.js`：

```javascript
// 纯逻辑版本号比较。双模式：浏览器 SW 用 importScripts 拿 self.cmpVersion；node 单测 require module.exports。
// 安全降级：段含 NaN（如 '1.x.0'）按 0 处理，确保异常不抛、最坏返回 0（不 reload）。
(function () {
  'use strict';

  function cmpVersion(a, b) {
    const sa = String(a == null ? '' : a).split('.').map(Number);
    const sb = String(b == null ? '' : b).split('.').map(Number);
    const n = Math.max(sa.length, sb.length);
    for (let i = 0; i < n; i++) {
      const va = Number.isFinite(sa[i]) ? sa[i] : 0;
      const vb = Number.isFinite(sb[i]) ? sb[i] : 0;
      const d = va - vb;
      if (d !== 0) return d;
    }
    return 0;
  }

  if (typeof self !== 'undefined') self.cmpVersion = cmpVersion;
  if (typeof module !== 'undefined' && module.exports) module.exports = { cmpVersion };
})();
```

- [ ] **Step 4: 跑测试确认全过**

Run: `node --test tests/version-cmp.test.js`
Expected: PASS —— 5 个测试用例全过、0 失败。

- [ ] **Step 5: 提交**

```bash
git add core/background/version-cmp.js tests/version-cmp.test.js
git commit -m "$(cat <<'EOF'
feat(core): 纯逻辑 cmpVersion 模块 + TDD 单测

Why: SW 自检需要对比磁盘 marker 版本与 chrome 加载版本，nahg 抽到独立
双模式模块（self + module.exports），供 SW importScripts + node:test 共用。
What: core/background/version-cmp.js 提供 cmpVersion（语义化版本数字段比较，
NaN 安全降级到 0）；tests/version-cmp.test.js 5 例用例（高/等/低/段数不等/NaN）。
Test: node --test tests/version-cmp.test.js 全过（5/5）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

> **Build 已确认**：`build_extension.py` 的 `copy_core_assets` 用 `shutil.copytree` 拷整目录，`core/background/version-cmp.js` 自动落到 `dist/extension/background/version-cmp.js`，**无需改 build 脚本**。

---

## Task 2: SW 加 `checkInstalledVersion` + importScripts

**Files:**
- Modify: `core/background/service-worker.js`（顶部新增整段，紧邻 image_search 段之上）

**无纯逻辑单测**：依赖 chrome.* API，靠 Task 5 端到端验证（手动改 marker 文件 + SW console 跑 checkInstalledVersion 触发 reload）。本 task 只保证代码改对（语法 + build）。

- [ ] **Step 1: SW 顶部插入 auto-reload 段**

把 `core/background/service-worker.js` 第 1 行：

```javascript
// ── image_search_1688 ── 图片搜索常量和工具函数 ──────────────────────────────
```

替换为（在它之前插入完整新段）：

```javascript
// ── auto-reload-on-installer-update ── 扩展自检 + 自动 reload ───────────────
// chrome 不监控 unpacked 扩展文件变化，员工装新版 installer 后 chrome 仍跑旧版。
// 本段在 SW 实例化时（每次唤醒）调 native host 读磁盘 marker，磁盘版本 > 当前
// 加载版本 → chrome.runtime.reload() 自我重载（chrome 唯一允许扩展自我重载的 API）。
// silent fail：native host 未注册 / 旧 EXE / marker 缺失都不阻断业务。
importScripts('version-cmp.js');   // 加载 cmpVersion（双模式纯逻辑模块）

async function checkInstalledVersion() {
  let port;
  try {
    port = chrome.runtime.connectNative('com.temu.label_host');
    const res = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 3000);
      port.onMessage.addListener(m => { clearTimeout(t); resolve(m); });
      port.onDisconnect.addListener(() => { clearTimeout(t); reject(new Error('disconnected')); });
      port.postMessage({ action: 'get_installed_version' });
    });
    if (!res?.success || !res.version) return;
    const clean = v => String(v).split('-')[0].trim();   // 截 rc/dev 后缀，与 normalize_manifest_version 等价
    const installed = clean(res.version);
    const loaded = clean(chrome.runtime.getManifest().version);
    if (cmpVersion(installed, loaded) > 0) {
      console.log(`[auto-reload] 磁盘 v${installed} > 加载 v${loaded}，自动 reload`);
      chrome.runtime.reload();
    }
  } catch { /* native host 未注册 / 旧 EXE / marker 缺失 / 超时 → silent，不影响业务 */ }
  finally { try { port?.disconnect(); } catch {} }
}
checkInstalledVersion();   // SW 实例化即跑（顶层模式，与 enableSessionStorageAccess 一致）
chrome.runtime.onStartup.addListener(checkInstalledVersion);
chrome.runtime.onInstalled.addListener(checkInstalledVersion);
// ── end auto-reload-on-installer-update ──────────────────────────────────────

// ── image_search_1688 ── 图片搜索常量和工具函数 ──────────────────────────────
```

> **关键设计**：
> - 新段放 SW 文件最顶（image_search 段之前），与 image_search 段隔离。`importScripts` 必须在 SW 顶层、所有用 `cmpVersion` 的代码之前。
> - `chrome.runtime.onStartup` / `onInstalled` 现有 listener 是 `enableSessionStorageAccess`（image_search 段内）；本段新增 listener 与之共存（chrome 多 listener 并发调）。
> - 短连接 port 独立于现有业务 native port，3s 超时兜底，结束即 disconnect。

- [ ] **Step 2: 静态语法 + 构建**

Run: `node --check core/background/service-worker.js && python3 build/build_extension.py 2>&1 | tail -3`
Expected: `service-worker.js 语法 OK` + `[build] done → ...`，无报错。

- [ ] **Step 3: 确认 dist 包含 version-cmp.js + SW 顶部 importScripts**

Run:
```bash
ls -la dist/extension/background/
grep -n "importScripts\|checkInstalledVersion" dist/extension/background/service-worker.js | head -5
```
Expected: `dist/extension/background/version-cmp.js` 存在；SW 顶部第一行附近能看到 `importScripts('version-cmp.js')` 和 `async function checkInstalledVersion`。

- [ ] **Step 4: 提交**

```bash
git add core/background/service-worker.js
git commit -m "$(cat <<'EOF'
feat(core): SW 加扩展自检 + chrome.runtime.reload() 自动重载

Why: chrome 不监控 unpacked 扩展文件变化，员工装新 installer 后必须手动
chrome reload。本次给 SW 加自检：每次实例化调 native host 读磁盘 marker，
磁盘版本 > 加载版本即 chrome.runtime.reload() 自我重载。
What: SW 顶部新增「auto-reload-on-installer-update」段，importScripts
version-cmp.js + 加 checkInstalledVersion + 3 处触发（顶层 + onStartup
+ onInstalled）。silent fail 兜底所有异常路径（native host 未注册 / 旧
EXE / marker 缺失 / 超时）不影响业务。
Test: node --check 语法 OK + build 构建成功 + dist 含 version-cmp.js；
端到端验证见 Task 5

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: native host `get_installed_version` action

**Files:**
- Modify: `native_host/main.py`（import os + 新增函数 + DISPATCH 加一行）

- [ ] **Step 1: 加 import os**

把 `native_host/main.py` 第 9-12 行：

```python
import sys
import json
import struct
import logging
```

替换为：

```python
import os
import sys
import json
import struct
import logging
```

- [ ] **Step 2: 加 `_get_installed_version` 函数**

把 `native_host/main.py` 第 39-42 行（`_generate_label` 函数定义）：

```python
def _generate_label(msg: dict) -> dict:
    """auto_gen_label 专属，惰性 import bartender（依赖 pythonnet + BarTender，Windows-only）。"""
    from handlers import bartender
    return bartender.handle(msg)
```

替换为（在 `_generate_label` 之后加新函数）：

```python
def _generate_label(msg: dict) -> dict:
    """auto_gen_label 专属，惰性 import bartender（依赖 pythonnet + BarTender，Windows-only）。"""
    from handlers import bartender
    return bartender.handle(msg)


def _get_installed_version(_msg: dict) -> dict:
    """读 EXE 同目录的 installed_version.txt，返回 installer 写入的版本号。

    供扩展 SW 自检 + 自动 reload 用：磁盘 marker 版本 > chrome 加载版本时
    调 chrome.runtime.reload() 应用新版（chrome 不监控 unpacked 扩展文件变化）。
    PyInstaller 打包后 sys.argv[0] 是 EXE 路径，dirname 即 installer 安装目录 {app}\\；
    开发期直跑 main.py 时 dirname 是 native_host/，无 marker 文件，返回 marker_missing
    （SW 端 catch silent，开发期不会自动 reload，符合预期）。
    """
    try:
        exe_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
        marker = os.path.join(exe_dir, 'installed_version.txt')
        if not os.path.exists(marker):
            return {'success': False, 'error': 'marker_missing'}
        with open(marker, 'r', encoding='utf-8') as f:
            return {'success': True, 'version': f.read().strip()}
    except Exception as e:
        return {'success': False, 'error': str(e)}
```

- [ ] **Step 3: DISPATCH 表加一行**

把 `native_host/main.py` 第 47-55 行：

```python
DISPATCH = {
    'generate_label': _generate_label,
    'pick_file': file_ops.pick_file,
    'pick_folder': file_ops.pick_folder,
    'read_file': file_ops.read_file,
    'read_file_size': file_ops.read_file_size,
    'read_file_chunk': file_ops.read_file_chunk,
    'write_file_chunk': file_ops.write_file_chunk,
}
```

替换为：

```python
DISPATCH = {
    'generate_label': _generate_label,
    'get_installed_version': _get_installed_version,
    'pick_file': file_ops.pick_file,
    'pick_folder': file_ops.pick_folder,
    'read_file': file_ops.read_file,
    'read_file_size': file_ops.read_file_size,
    'read_file_chunk': file_ops.read_file_chunk,
    'write_file_chunk': file_ops.write_file_chunk,
}
```

- [ ] **Step 4: 自测 `_get_installed_version` 两种场景**

Run:
```bash
cd native_host && python3 -c "
import main
import os, tempfile, sys

# 场景 1: marker 不存在 → success:false marker_missing
# 临时把 sys.argv[0] 指向无 marker 的目录
sys.argv[0] = '/tmp/no_such_exe'
r1 = main._get_installed_version({})
print('场景1 marker 不存在:', r1)
assert r1 == {'success': False, 'error': 'marker_missing'}, r1

# 场景 2: marker 存在 → success:true version=内容
with tempfile.TemporaryDirectory() as d:
    fake_exe = os.path.join(d, 'TemuLabelHost.exe')
    open(fake_exe, 'w').close()
    with open(os.path.join(d, 'installed_version.txt'), 'w', encoding='utf-8') as f:
        f.write('1.3.0\n')
    sys.argv[0] = fake_exe
    r2 = main._get_installed_version({})
    print('场景2 marker 存在:', r2)
    assert r2 == {'success': True, 'version': '1.3.0'}, r2

print('--- _get_installed_version OK ---')
" && cd ..
```
Expected: 两个场景断言通过，输出 `--- _get_installed_version OK ---`。

- [ ] **Step 5: 提交**

```bash
git add native_host/main.py
git commit -m "$(cat <<'EOF'
feat(native_host): 加 get_installed_version action

Why: SW 自检 + 自动 reload 需要读磁盘 installer 写入的版本 marker 对比
chrome 加载版本。
What: native_host/main.py 加 _get_installed_version 函数（读 EXE 同目录
installed_version.txt）+ DISPATCH 注册。开发期直跑 main.py 时 dirname 是
native_host/、无 marker，返回 marker_missing（SW 端 catch silent，符合预期）。
Test: python -c 自测两种场景（marker 存在返回 version，缺失返回 marker_missing）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: installer 写 marker

**Files:**
- Modify: `deploy/installer.iss`（`[Code] CurStepChanged` ssDone 分支顶部加 SaveStringToFile）

**无法在 Linux 验证**：Inno Setup ISCC.exe 仅 Windows 可跑，本 task 改完只 grep 确认改动落地。**真正端到端验证靠 v1.2.1 推 tag 后 CI 打包 + Windows 装包看 marker 文件**（Task 5 提示用户）。

- [ ] **Step 1: 在 CurStepChanged ssDone 分支顶部加 SaveStringToFile**

把 `deploy/installer.iss` 第 109-112 行（`ssDone` 分支开头）：

```pascal
  if CurStep = ssDone then
  begin
    ExtensionDir := ExpandConstant('{app}\extension');
    Msg :=
```

替换为：

```pascal
  if CurStep = ssDone then
  begin
    // 写版本 marker：扩展 SW 启动时调 native host 读这个文件，对比 chrome 加载版本，
    // 磁盘 > 加载 → chrome.runtime.reload() 自动应用（chrome 不监控 unpacked 扩展文件变化）。
    // 必须先于引导对话框写入（员工万一立刻 chrome reload，自检逻辑要能拿到正确值）。
    SaveStringToFile(ExpandConstant('{app}\installed_version.txt'),
                     '{#MyAppVersion}', False);

    ExtensionDir := ExpandConstant('{app}\extension');
    Msg :=
```

> **关键**：`{#MyAppVersion}` 可能含 rc 后缀（如 `1.3.0-rc.1`）；marker 文件保存原值，SW 端 `clean(v).split('-')[0]` 清洗后比较。`SaveStringToFile` 的第三参数 `False` = overwrite 模式（每次装包都覆盖写入）。

- [ ] **Step 2: 确认改动落地**

Run: `grep -n "installed_version\|SaveStringToFile" deploy/installer.iss`
Expected: 至少 2 行 —— `SaveStringToFile(...installed_version.txt...)` 和注释里的 `installed_version`。

- [ ] **Step 3: 提交**

```bash
git add deploy/installer.iss
git commit -m "$(cat <<'EOF'
feat(installer): 写 installed_version.txt marker 供扩展自检

Why: chrome 不监控 unpacked 扩展文件变化，扩展 SW 需要读磁盘 marker 对比
chrome 加载版本决定是否 chrome.runtime.reload() 自动应用新版。
What: installer.iss [Code] CurStepChanged ssDone 分支顶部加 SaveStringToFile，
把 MyAppVersion（可能含 rc 后缀，SW 端清洗）写到 {app}\installed_version.txt。
位置在引导对话框之前，确保员工万一立刻 chrome reload 时自检能拿到正确值。
Test: not run (ISCC.exe 仅 Windows 可跑，Linux 上 grep 确认改动落地；
端到端验证在 v1.2.1 tag CI 打包后 Windows 装包看 marker)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 端到端验证 + 文档

**Files:**
- Verify: `dist/extension/` 完整性
- Modify: `CLAUDE.md`（项目根）—— Deployment 段加「扩展自检 + 自动 reload」小节

- [ ] **Step 1: 本地 build 后 dist 完整性核对**

Run:
```bash
python3 build/build_extension.py 2>&1 | tail -3
echo "=== dist 顶部含 version-cmp.js ==="
ls dist/extension/background/
echo "=== SW 顶部段标记 ==="
head -5 dist/extension/background/service-worker.js
echo "=== SW importScripts + checkInstalledVersion 命中 ==="
grep -nE "importScripts|checkInstalledVersion|cmpVersion" dist/extension/background/service-worker.js | head -8
```
Expected:
- `[build] done → ...`
- `dist/extension/background/` 含 `service-worker.js` + `version-cmp.js`
- SW 第 1 行是 `// ── auto-reload-on-installer-update ──...`
- grep 命中 `importScripts('version-cmp.js')` + `async function checkInstalledVersion` + `cmpVersion(installed, loaded)`

- [ ] **Step 2: 更新项目根 `CLAUDE.md` Deployment 段**

把 `CLAUDE.md` 中：

```
Release 版会自动把 feature 内 `const TAL_DEBUG = true;` 替换为 `false;`（关闭调试面板）。
```

替换为（保留原行，在它之后追加新小节）：

```markdown
Release 版会自动把 feature 内 `const TAL_DEBUG = true;` 替换为 `false;`（关闭调试面板）。

### 扩展自检 + 自动 reload（v1.2.1 起生效）

Chrome 不监控 unpacked 扩展文件变化 —— 员工装新 installer 后 chrome 仍跑旧版扩展，必须手动 `chrome://extensions` 卡片点 reload 才能应用。漏做即 bug（v1.2.0 复购模式漏 reload 即真实事故）。

**自动 reload 三方协作**：
1. **installer**（`deploy/installer.iss` `[Code] CurStepChanged ssDone`）：装完写 `{app}\installed_version.txt` = `{#MyAppVersion}`。
2. **native host**（`native_host/main.py` 的 `_get_installed_version` action）：读 EXE 同目录的 marker 文件返回版本号。
3. **service worker**（`core/background/service-worker.js` 顶部「auto-reload-on-installer-update」段）：SW 实例化时 + onStartup + onInstalled 三处触发 `checkInstalledVersion`，调 native host 拿 marker → 与 `chrome.runtime.getManifest().version` 对比（两边都 `split('-')[0]` 清洗 rc 后缀）→ 磁盘 > 加载即 `chrome.runtime.reload()` 自我重载。

**关键限制**：
- v1.2.1 起的版本才有自检代码；**v1.1.1 → v1.2.0 这次升级救不了**（员工仍需手动 reload 一次）。
- silent fail 兜底所有异常（native host 未注册 / 旧 EXE 不识别 action / marker 缺失 / 超时），不影响业务。
- reload 极小概率打断进行中的 feature 任务，状态都在 `chrome.storage.local` 不丢，员工重试即可。

**纯逻辑单测**：`tests/version-cmp.test.js`（`node --test`）覆盖 `cmpVersion` 边界（高/等/低/段数不等/NaN 降级）。

**详见**：spec `docs/superpowers/specs/2026-05-31-extension-auto-reload-on-installer-update-design.md`；plan `docs/superpowers/plans/2026-05-31-extension-auto-reload-on-installer-update.md`。
```

- [ ] **Step 3: 提交文档**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: CLAUDE.md 补「扩展自检 + 自动 reload」机制说明

Why: 沉淀 installer / native host / SW 三方协作的关键设计 + 限制（v1.2.1
起生效，v1.1.1→v1.2.0 救不了），供后续维护参考。
What: Deployment 段末追加新小节，覆盖三方角色、清洗规则、silent fail
策略、单测位置、限制。
Test: not run (文档)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: 提示用户下一步（不在 plan 内执行）**

dist 完整性核对通过 + 文档落地后，剩余的真实验证只能等 v1.2.1 推 tag 后在 Windows 端做：
1. 推 `v1.2.1` tag → CI 打包出 `TemuLabelSetup-1.2.1.exe`。
2. 员工装 v1.2.1（首次升级仍需手动 chrome reload —— 已知限制）。
3. 装好后到 `chrome://extensions` 卡片「Service worker」检查，控制台跑 `checkInstalledVersion()` 验证不报错；查看 `{app}\installed_version.txt` 内容是 `1.2.1`。
4. 后续推任意 `v1.x.y` tag 测试，员工装包后**无需任何操作**，扩展会在下次 SW 唤醒时自动 reload 应用新版。

---

## 完成定义

- `node --test tests/version-cmp.test.js` 全过（5/5）。
- `node --check core/background/service-worker.js` 语法 OK。
- `python3 build/build_extension.py` 构建成功，dist 含 `background/version-cmp.js` + SW 顶部 importScripts。
- `native_host/main.py` 的 `_get_installed_version` python -c 自测两种场景通过。
- `deploy/installer.iss` `SaveStringToFile` 改动落地（grep 确认）。
- `CLAUDE.md` 补 auto-reload 机制说明。
- 五个 commit 落在 `feature/extension-auto-reload` 分支。
- 后续走 PR 流程（用户触发）→ merge → 推 `v1.2.1` tag 发版（用户触发）。

**v1.2.1 发版后续验证**（不在本 plan 范围）：员工装包 + chrome reload（这次仍需手动）→ 跑 `checkInstalledVersion()` 验证。再下一次升级起对所有员工自动生效。
