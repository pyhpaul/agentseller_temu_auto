# image_search_1688 集成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将独立的 1688 以图搜图扩展以标准 feature 形式集成进 agentseller_temu，触发方式改为点击 Hub 图标。

**Architecture:** 新增 `image_search_1688/` feature 目录；扩展构建系统支持 `content_matches`（主 content script 注入域）和 `extra_content_scripts`（独立静态 content script 块）两个新字段；扩展 service worker 处理截图消息链。

**Tech Stack:** MV3 Chrome Extension、Python 构建脚本、纯 JS（非 ESM）content scripts

---

## 文件变更地图

| 文件 | 操作 | 职责 |
|------|------|------|
| `build/build_extension.py` | 修改 | 支持 `content_matches` / `extra_content_scripts`；新增辅助函数 |
| `core/manifest.template.json` | 修改 | 占位符改名（`__CONTENT_MATCHES__`），保持向后兼容 |
| `core/background/service-worker.js` | 修改 | 添加 IMG_SEARCH_* 消息处理器 + 工具函数 |
| `image_search_1688/feature.json` | 新建 | feature 元数据，声明新字段 |
| `image_search_1688/content/index.js` | 新建 | 注册 feature，渲染「开始截图」按钮 |
| `image_search_1688/content/overlay.js` | 新建 | 截图框选覆盖层（适配自原项目） |
| `image_search_1688/content/overlay.css` | 新建 | 覆盖层样式（直接复制） |
| `image_search_1688/content/injector.js` | 新建 | 1688 页自动注入截图（适配自原项目） |
| `image_search_1688/CLAUDE.md` | 新建 | feature 文档 |
| `tests/test_build.py` | 新建 | 构建辅助函数单元测试 |

---

## Task 1：为 build_extension.py 新功能编写测试

**Files:**
- Create: `tests/test_build.py`

- [ ] **Step 1：创建 tests/ 目录并写测试文件**

```bash
mkdir -p /home/linux_dev/projects/agentseller_temu/tests
```

内容写入 `tests/test_build.py`：

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
from build_extension import collect_content_matches, collect_extra_content_scripts


def test_content_matches_defaults_to_host_permissions():
    features = [{'host_permissions': ['https://seller.temu.com/*', 'https://*.temu.com/*']}]
    result = collect_content_matches(features)
    assert result == sorted(['https://seller.temu.com/*', 'https://*.temu.com/*'])


def test_content_matches_overrides_with_empty_list():
    # image_search_1688 模式：host_permissions 有 1688，但 content_matches 明确为空
    features = [
        {'host_permissions': ['https://seller.temu.com/*']},
        {'host_permissions': ['https://*.1688.com/*'], 'content_matches': []},
    ]
    result = collect_content_matches(features)
    assert result == ['https://seller.temu.com/*']


def test_content_matches_multiple_features_merged():
    features = [
        {'host_permissions': ['https://seller.temu.com/*']},
        {'host_permissions': ['https://*.temu.com/*']},
    ]
    result = collect_content_matches(features)
    assert 'https://seller.temu.com/*' in result
    assert 'https://*.temu.com/*' in result
    assert result == sorted(result)  # 已排序


def test_extra_content_scripts_resolves_paths():
    features = [{
        'id': 'image_search_1688',
        '_dir': Path('/fake/dir'),
        'extra_content_scripts': [{
            'matches': ['https://s.1688.com/*', 'https://*.1688.com/imgsearch/*'],
            'js': ['content/injector.js'],
            'run_at': 'document_idle',
        }]
    }]
    result = collect_extra_content_scripts(features)
    assert len(result) == 1
    assert result[0]['js'] == ['features/image_search_1688/content/injector.js']
    assert result[0]['matches'] == ['https://s.1688.com/*', 'https://*.1688.com/imgsearch/*']
    assert result[0]['run_at'] == 'document_idle'


def test_extra_content_scripts_empty_when_absent():
    features = [{'id': 'auto_gen_label', '_dir': Path('/fake')}]
    result = collect_extra_content_scripts(features)
    assert result == []


if __name__ == '__main__':
    test_content_matches_defaults_to_host_permissions()
    test_content_matches_overrides_with_empty_list()
    test_content_matches_multiple_features_merged()
    test_extra_content_scripts_resolves_paths()
    test_extra_content_scripts_empty_when_absent()
    print('All tests passed.')
```

- [ ] **Step 2：确认测试当前失败（函数尚未存在）**

```bash
cd /home/linux_dev/projects/agentseller_temu && python tests/test_build.py
```

预期：`ImportError: cannot import name 'collect_content_matches' from 'build_extension'`

---

## Task 2：扩展 build_extension.py

**Files:**
- Modify: `build/build_extension.py`

- [ ] **Step 1：在 `build_extension.py` 中添加两个辅助函数**

在 `scan_features()` 函数之后（约第 61 行），添加：

```python
def collect_content_matches(features):
    """聚合各 feature 的 content_matches（缺省回退到 host_permissions），结果排序去重。"""
    return sorted({
        m
        for f in features
        for m in f.get('content_matches', f.get('host_permissions', []))
    })


def collect_extra_content_scripts(features):
    """收集所有 feature 的 extra_content_scripts，将 js 路径补全为 features/<id>/<path>。"""
    result = []
    for f in features:
        for ecs in f.get('extra_content_scripts', []):
            ecs_copy = dict(ecs)
            ecs_copy['js'] = [f'features/{f["id"]}/{js}' for js in ecs_copy.get('js', [])]
            result.append(ecs_copy)
    return result
```

- [ ] **Step 2：添加 `copy_extra_cs_assets` 函数**

在 `copy_feature_assets()` 之后添加：

```python
def copy_extra_cs_assets(features):
    """拷贝 extra_content_scripts 引用的 js 文件到 dist/extension/features/<id>/。"""
    for f in features:
        src_dir = f['_dir']
        for ecs in f.get('extra_content_scripts', []):
            for js_path in ecs.get('js', []):
                src = src_dir / js_path
                dst = DIST / 'features' / f['id'] / js_path
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                rel = src.relative_to(ROOT)
                _inject_source_url(dst, str(rel))
                print(f'[build] extra cs: {rel} → dist/extension/features/{f["id"]}/{js_path}')
```

- [ ] **Step 3：更新 `render_manifest` 使用新字段**

将 `render_manifest` 函数中的以下两行：

```python
    template['permissions'] = permissions
    template['host_permissions'] = host_permissions
    content_scripts_js = (
        ['content/utils.js', 'content/ui.js', 'content/registry.js', 'content/core.js']
        + [f'features/{f["id"]}/{f["content_script"]}' for f in sorted(features, key=lambda x: x.get('order', 999))]
    )

    template['permissions'] = permissions
    template['host_permissions'] = host_permissions
    template['content_scripts'][0]['matches'] = host_permissions
    template['content_scripts'][0]['js'] = content_scripts_js
```

替换为：

```python
    content_script_matches = collect_content_matches(features)
    extra_cs = collect_extra_content_scripts(features)
    content_scripts_js = (
        ['content/utils.js', 'content/ui.js', 'content/registry.js', 'content/core.js']
        + [f'features/{f["id"]}/{f["content_script"]}' for f in sorted(features, key=lambda x: x.get('order', 999))]
    )

    template['permissions'] = permissions
    template['host_permissions'] = host_permissions
    template['content_scripts'][0]['matches'] = content_script_matches
    template['content_scripts'][0]['js'] = content_scripts_js
    for ecs in extra_cs:
        template['content_scripts'].append(ecs)
```

- [ ] **Step 4：更新 `build_all` 调用 `copy_extra_cs_assets`**

将 `build_all` 函数中的：

```python
def build_all():
    clean_dist()
    copy_core_assets()
    features = scan_features()
    copy_feature_assets(features)
    render_manifest(features=features)
    print(f'[build] done → {DIST}')
```

替换为：

```python
def build_all():
    clean_dist()
    copy_core_assets()
    features = scan_features()
    copy_feature_assets(features)
    copy_extra_cs_assets(features)
    render_manifest(features=features)
    print(f'[build] done → {DIST}')
```

- [ ] **Step 5：运行测试，确认全部通过**

```bash
cd /home/linux_dev/projects/agentseller_temu && python tests/test_build.py
```

预期输出：`All tests passed.`

- [ ] **Step 6：提交**

```bash
git add build/build_extension.py tests/test_build.py
git commit -m "feat(build): 支持 content_matches 和 extra_content_scripts 字段

Why: 需要将 1688 域名加入 host_permissions 供 SW scripting 使用，
     同时不让 AgentSeller FAB 注入 1688 页面；
     extra_content_scripts 支持 injector.js 静态加载到 1688 搜索页。

What: 新增 collect_content_matches / collect_extra_content_scripts /
      copy_extra_cs_assets 三个辅助函数；render_manifest 使用 content_matches
      而非 host_permissions 作为主 content_scripts.matches；向后兼容。

Test: python tests/test_build.py → All tests passed."
```

---

## Task 3：更新 manifest.template.json

**Files:**
- Modify: `core/manifest.template.json`

- [ ] **Step 1：将占位符改名以明确语义**

将 `core/manifest.template.json` 中 `content_scripts[0].matches` 的值从 `"__HOST_PERMISSIONS__"` 改为 `"__CONTENT_MATCHES__"`：

```json
{
  "manifest_version": 3,
  "name": "AgentSeller for Temu",
  "version": "1.0.0",
  "description": "Temu 商家中心自动化（多 feature 插件）",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5GWRs9dvggQAWIUieST3g2+OVxxht+f0DfL0nlwjfoQd1F2WA8P7sNNGlggD/7IqjHxK+GP9ZJ+kaS92rWfSH9PXr2J/eJeAV91b8NHzQlXIFoikBxXxYWRVw+UUNmiSVbt9X6As4KhWoJICr5aEHQbR5yCIhsPSb9uqUGsyfHW4ifXIgmzBUpgouU7SSCDI0sgtMn4PuTiO66ZeOmsLTagOcFyeNzTAvos8XkLmPmhsxho06tQsSxG/Yi8DwO8xNdCPGIhs+p8/6jNek2jPFElAcwbsA6kNWNfo9L1VI1zIdPJ9EAKhMug7l+XWM/w5HQe0rZeAdCt88/JF4xvKZwIDAQAB",
  "permissions": "__PERMISSIONS__",
  "host_permissions": "__HOST_PERMISSIONS__",
  "background": {
    "service_worker": "background/service-worker.js"
  },
  "content_scripts": [
    {
      "matches": "__CONTENT_MATCHES__",
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
```

- [ ] **Step 2：提交**

```bash
git add core/manifest.template.json
git commit -m "chore(manifest): 占位符 __HOST_PERMISSIONS__ → __CONTENT_MATCHES__

Why: 语义隔离；content_scripts.matches 现由 content_matches 字段控制，
     不再等同于 host_permissions。

Test: not run (模板改名，构建逻辑在 Task 2 已验证)"
```

---

## Task 4：创建 feature 目录骨架和 feature.json

**Files:**
- Create: `image_search_1688/feature.json`

- [ ] **Step 1：创建目录**

```bash
mkdir -p /home/linux_dev/projects/agentseller_temu/image_search_1688/content
```

- [ ] **Step 2：写 feature.json**

内容写入 `image_search_1688/feature.json`：

```json
{
  "id": "image_search_1688",
  "icon": "🔍",
  "label": "1688搜图",
  "locked": false,
  "order": 2,
  "content_script": "content/index.js",
  "content_matches": [],
  "host_permissions": ["https://*.1688.com/*"],
  "permissions": ["activeTab", "scripting", "storage", "notifications", "clipboardWrite"],
  "extra_content_scripts": [
    {
      "matches": ["https://s.1688.com/*", "https://*.1688.com/imgsearch/*"],
      "js": ["content/injector.js"],
      "run_at": "document_idle"
    }
  ]
}
```

- [ ] **Step 3：验证构建能识别新 feature**

```bash
cd /home/linux_dev/projects/agentseller_temu && python build/build_extension.py 2>&1 | grep -E "discovered|error|Error"
```

预期：`[build] discovered feature: image_search_1688`（会因为 content/index.js 还不存在而报错，属正常）

- [ ] **Step 4：提交**

```bash
git add image_search_1688/feature.json
git commit -m "feat(image_search_1688): 新增 feature 目录和 feature.json

Why: 声明 feature 元数据；content_matches:[] 确保 1688 不注入主 content scripts；
     extra_content_scripts 声明 injector.js 静态加载到 1688 搜索页。

Test: not run (content scripts 尚未创建)"
```

---

## Task 5：添加 overlay.css 和 overlay.js

**Files:**
- Create: `image_search_1688/content/overlay.css`
- Create: `image_search_1688/content/overlay.js`

- [ ] **Step 1：写 overlay.css（直接复制原项目）**

内容写入 `image_search_1688/content/overlay.css`：

```css
#__1688_overlay_root__ {
  position: fixed; inset: 0;
  z-index: 2147483647;
  cursor: crosshair;
  user-select: none;
}
#__1688_overlay_root__ .mask {
  position: absolute; inset: 0;
  background: rgba(0, 0, 0, 0.4);
}
#__1688_overlay_root__ .selection {
  position: absolute;
  box-sizing: border-box;
  border: 1px solid #ff6a00;
  background: transparent;
  box-shadow: 0 0 0 9999px rgba(0,0,0,0.4);
}
#__1688_overlay_root__ .toolbar {
  position: absolute;
  display: flex; gap: 4px;
  padding: 6px;
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 4px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.15);
  font: 12px -apple-system, sans-serif;
}
#__1688_overlay_root__ .toolbar button {
  cursor: pointer;
  padding: 4px 10px;
  border: 1px solid #ddd;
  background: #fafafa;
  border-radius: 3px;
  font: inherit;
}
#__1688_overlay_root__ .toolbar button.primary {
  background: #ff6a00; color: #fff; border-color: #ff6a00;
}
#__1688_overlay_root__ .toast {
  position: absolute; top: 16px; left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.75); color: #fff;
  padding: 6px 12px; border-radius: 4px;
  font: 12px -apple-system, sans-serif;
}
```

- [ ] **Step 2：写 overlay.js（适配自原项目：MSG 常量改为 IMG_SEARCH_* 前缀）**

内容写入 `image_search_1688/content/overlay.js`：

```js
(() => {
  if (window.__img_search_overlay_loaded__) return;
  window.__img_search_overlay_loaded__ = true;

  const MSG_START    = 'IMG_SEARCH_START';
  const MSG_REGION   = 'IMG_SEARCH_CAPTURE_REGION';
  const MSG_CANCEL   = 'IMG_SEARCH_CANCEL';
  const MSG_TOO_LARGE = 'IMG_SEARCH_TOO_LARGE';
  const MIN_SIZE = 10;

  let root = null;
  let selectionEl = null;
  let toolbarEl = null;
  let toastTimer = null;
  let start = null;
  let rect = null;

  function ensureRoot() {
    if (root) return;
    root = document.createElement('div');
    root.id = '__1688_overlay_root__';

    const mask = document.createElement('div');
    mask.className = 'mask';
    root.appendChild(mask);

    document.documentElement.appendChild(root);

    root.addEventListener('mousedown', onMouseDown, true);
    root.addEventListener('mousemove', onMouseMove, true);
    root.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function tearDown() {
    const orphan = document.getElementById('__1688_overlay_root__');
    if (orphan) orphan.remove();
    document.removeEventListener('keydown', onKeyDown, true);
    root = selectionEl = toolbarEl = null;
    start = rect = null;
    if (toastTimer) clearTimeout(toastTimer);
  }

  function onMouseDown(e) {
    if (toolbarEl && toolbarEl.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    if (toolbarEl) { toolbarEl.remove(); toolbarEl = null; }
    start = { x: e.clientX, y: e.clientY };
    if (!selectionEl) {
      selectionEl = document.createElement('div');
      selectionEl.className = 'selection';
      root.appendChild(selectionEl);
    }
    updateSelection(start.x, start.y, 0, 0);
  }

  function onMouseMove(e) {
    if (!start) return;
    e.preventDefault(); e.stopPropagation();
    const x = Math.min(start.x, e.clientX);
    const y = Math.min(start.y, e.clientY);
    const w = Math.abs(e.clientX - start.x);
    const h = Math.abs(e.clientY - start.y);
    updateSelection(x, y, w, h);
  }

  function onMouseUp(e) {
    if (toolbarEl && toolbarEl.contains(e.target)) return;
    if (!start) return;
    e.preventDefault(); e.stopPropagation();
    start = null;
    if (!rect || rect.w < MIN_SIZE || rect.h < MIN_SIZE) {
      if (selectionEl) { selectionEl.remove(); selectionEl = null; }
      rect = null;
      showToast('选区太小，请重新框选');
      return;
    }
    showToolbar();
  }

  function updateSelection(x, y, w, h) {
    rect = { x, y, w, h };
    selectionEl.style.left = x + 'px';
    selectionEl.style.top = y + 'px';
    selectionEl.style.width = w + 'px';
    selectionEl.style.height = h + 'px';
  }

  function showToolbar() {
    toolbarEl = document.createElement('div');
    toolbarEl.className = 'toolbar';
    toolbarEl.innerHTML = `
      <button class="primary" data-act="search">搜索 1688</button>
      <button data-act="reselect">重选</button>
      <button data-act="cancel">取消</button>
    `;
    positionToolbar();
    root.appendChild(toolbarEl);
    toolbarEl.addEventListener('click', onToolbarClick, true);
  }

  function positionToolbar() {
    const TB_W = 200, TB_H = 36, MARGIN = 6;
    const vw = window.innerWidth, vh = window.innerHeight;
    const candidates = [
      { left: rect.x + rect.w + MARGIN, top: rect.y + rect.h + MARGIN },
      { left: rect.x + rect.w + MARGIN, top: rect.y - TB_H - MARGIN },
      { left: rect.x - TB_W - MARGIN, top: rect.y + rect.h + MARGIN },
      { left: rect.x - TB_W - MARGIN, top: rect.y - TB_H - MARGIN },
    ];
    const fit = candidates.find(c =>
      c.left >= 0 && c.top >= 0 && c.left + TB_W <= vw && c.top + TB_H <= vh
    ) || { left: Math.max(0, vw - TB_W - MARGIN), top: Math.max(0, vh - TB_H - MARGIN) };
    toolbarEl.style.left = fit.left + 'px';
    toolbarEl.style.top = fit.top + 'px';
  }

  function onToolbarClick(e) {
    e.preventDefault(); e.stopPropagation();
    const act = e.target.dataset?.act;
    if (act === 'search') confirmSearch();
    else if (act === 'reselect') resetSelection();
    else if (act === 'cancel') cancel();
  }

  function resetSelection() {
    if (toolbarEl) { toolbarEl.remove(); toolbarEl = null; }
    if (selectionEl) { selectionEl.remove(); selectionEl = null; }
    rect = null;
  }

  function cancel() {
    chrome.runtime.sendMessage({ type: MSG_CANCEL });
    tearDown();
  }

  function confirmSearch() {
    const payload = {
      type: MSG_REGION,
      rect: { ...rect },
      dpr: window.devicePixelRatio || 1,
    };
    tearDown();
    chrome.runtime.sendMessage(payload);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter' && rect) { e.preventDefault(); confirmSearch(); }
    else if ((e.key === 'r' || e.key === 'R') && rect) { e.preventDefault(); resetSelection(); }
  }

  function showToast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    root.appendChild(t);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 1500);
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === MSG_START) ensureRoot();
    if (m?.type === MSG_TOO_LARGE) showToast('图片过大，请缩小选区');
  });

  ensureRoot();
})();
```

- [ ] **Step 3：提交**

```bash
git add image_search_1688/content/overlay.css image_search_1688/content/overlay.js
git commit -m "feat(image_search_1688): 添加截图覆盖层 overlay.css + overlay.js

Why: 截图框选 UI；适配自原独立项目，消息常量改为 IMG_SEARCH_* 前缀避免冲突。

Test: not run (浏览器 UI 组件，需手动验证)"
```

---

## Task 6：添加 injector.js

**Files:**
- Create: `image_search_1688/content/injector.js`

- [ ] **Step 1：写 injector.js（适配自原项目：消息类型改为 IMG_SEARCH_INJECTION_RESULT）**

内容写入 `image_search_1688/content/injector.js`：

```js
(() => {
  if (window.__img_search_injector_loaded__) return;
  window.__img_search_injector_loaded__ = true;
  const TAG = '[agentseller/img-search/injector]';

  function pickFileInput(doc) {
    const selectors = [
      'input[type=file][accept*="image"]:not([disabled])',
      'input[type=file]:not([disabled])',
    ];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function isExpired(ts, now, ttlMs) {
    if (ts == null) return true;
    return now - ts >= ttlMs;
  }

  const TTL_MS = 10_000;
  const STORAGE_KEY = 'imagePayload';
  const WAIT_INPUT_MS = 8000;

  async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return await res.blob();
  }

  function waitForFileInput(timeoutMs) {
    return new Promise((resolve) => {
      const existing = pickFileInput(document);
      if (existing) return resolve(existing);
      const obs = new MutationObserver(() => {
        const el = pickFileInput(document);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  async function injectFile(input, blob) {
    const file = new File([blob], `image-${Date.now()}.png`, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function isSearchTrigger(el) {
    const text = (el.textContent || '').trim();
    if (!text || text.length > 10) return false;
    return text === '搜索图片' || text === '开始搜索' || /^搜索.{0,4}$/.test(text);
  }

  const BUTTON_SELECTOR = [
    '.copy-image-container .search-btn',
    '.copy-image-container [data-tracker="pasteImagePreview"]',
    '[data-tracker="pasteImagePreview"]',
  ].join(',');

  function waitForSearchButton(timeoutMs) {
    return new Promise((resolve) => {
      const scan = () =>
        Array.from(document.querySelectorAll(BUTTON_SELECTOR))
          .find(isSearchTrigger) || null;
      const found = scan();
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const f = scan();
        if (f) { obs.disconnect(); resolve(f); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  function simulateClick(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function waitForPreviewReady(timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        const img = document.querySelector('.copy-image img, .preview-image img, [class*="preview"] img');
        const ready = img && img.src && img.src.length > 32 && img.complete && img.naturalWidth > 0;
        if (ready) { clearInterval(tick); resolve(true); }
        else if (Date.now() - t0 > timeoutMs) { clearInterval(tick); resolve(false); }
      }, 50);
    });
  }

  async function showToast(text, action) {
    const root = document.createElement('div');
    root.style.cssText = `
      position: fixed; top: 24px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; background: rgba(0,0,0,0.85); color: #fff;
      padding: 10px 16px; border-radius: 6px;
      font: 13px -apple-system, sans-serif; display: flex; gap: 12px; align-items: center;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    `;
    const span = document.createElement('span');
    span.textContent = text;
    root.appendChild(span);
    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.style.cssText = `
        cursor: pointer; padding: 4px 10px; border: 1px solid #fff;
        background: transparent; color: #fff; border-radius: 4px; font: inherit;
      `;
      btn.addEventListener('click', () => { root.remove(); action.onClick(); });
      root.appendChild(btn);
    }
    document.body.appendChild(root);
    setTimeout(() => root.remove(), 5000);
  }

  async function copyToClipboard(blob) {
    const item = new ClipboardItem({ 'image/png': blob });
    await navigator.clipboard.write([item]);
  }

  async function fallbackToClipboard(payload, reason) {
    let blob;
    try {
      blob = await dataUrlToBlob(payload.dataUrl);
    } catch (e) {
      await showToast('图片数据已失效，请重新截图。');
      return;
    }
    try {
      await copyToClipboard(blob);
      await chrome.storage.session.remove(STORAGE_KEY);
      await showToast('自动上传失败，已复制图片，请在搜索框按 Ctrl+V 粘贴。', {
        label: '重试',
        onClick: () => run(),
      });
    } catch (e) {
      await showToast('请点击 1688 页面后再点重试。', {
        label: '重试',
        onClick: () => run(),
      });
    }
    chrome.runtime.sendMessage({ type: 'IMG_SEARCH_INJECTION_RESULT', ok: false, reason });
  }

  async function run() {
    let payload;
    try {
      const obj = await chrome.storage.session.get(STORAGE_KEY);
      payload = obj[STORAGE_KEY];
    } catch (e) {
      console.warn(TAG, 'storage.get failed:', e);
      await showToast('扩展无法读取截图数据：' + e.message);
      return;
    }
    if (!payload) { console.log(TAG, 'no payload, exit'); return; }
    if (isExpired(payload.ts, Date.now(), TTL_MS)) {
      console.log(TAG, 'payload expired, exit');
      return;
    }
    if (location.pathname.includes('/punish') || location.search.includes('x5secdata')) {
      console.warn(TAG, 'punish page detected, fallback to clipboard');
      try {
        const blob = await dataUrlToBlob(payload.dataUrl);
        await copyToClipboard(blob);
        await chrome.storage.session.remove(STORAGE_KEY);
        await showToast('1688 触发风控，请完成验证后重新截图（图片已复制到剪贴板）。');
      } catch (e) {
        await showToast('1688 触发风控，请完成验证后重新截图。');
      }
      chrome.runtime.sendMessage({ type: 'IMG_SEARCH_INJECTION_RESULT', ok: false, reason: 'punish-page' });
      return;
    }
    console.log(TAG, 'payload ok, waiting file input');
    const input = await waitForFileInput(WAIT_INPUT_MS);
    if (!input) {
      console.warn(TAG, 'no file input within', WAIT_INPUT_MS, 'ms');
      await fallbackToClipboard(payload, 'no-input');
      return;
    }
    try {
      const blob = await dataUrlToBlob(payload.dataUrl);
      await injectFile(input, blob);
      const [btn, previewReady] = await Promise.all([
        waitForSearchButton(5000),
        waitForPreviewReady(5000),
      ]);
      if (btn) {
        console.log(TAG, 'preview ready:', previewReady, '→ clicking:', btn);
        simulateClick(btn);
      } else {
        console.warn(TAG, 'search button not found within 5000 ms');
      }
      await chrome.storage.session.remove(STORAGE_KEY);
      chrome.runtime.sendMessage({
        type: 'IMG_SEARCH_INJECTION_RESULT',
        ok: true,
        reason: btn ? 'clicked' : 'no-button',
      });
    } catch (e) {
      console.warn(TAG, 'inject failed:', e);
      await fallbackToClipboard(payload, String(e));
    }
  }

  run();
})();
```

- [ ] **Step 2：提交**

```bash
git add image_search_1688/content/injector.js
git commit -m "feat(image_search_1688): 添加 1688 页自动注入脚本 injector.js

Why: 在 1688 搜索页读取 session storage 截图数据，自动注入到搜索框并触发搜索。
     适配自原独立项目，消息类型改为 IMG_SEARCH_INJECTION_RESULT。

Test: not run (需浏览器环境 + 完整流程验证)"
```

---

## Task 7：创建 content/index.js（feature 注册）

**Files:**
- Create: `image_search_1688/content/index.js`

- [ ] **Step 1：写 content/index.js**

内容写入 `image_search_1688/content/index.js`：

```js
(function () {
  'use strict';

  window.AgentSeller.registerFeature({
    id: 'image_search_1688',
    icon: '🔍',
    label: '1688搜图',
    locked: false,
    order: 2,
    init() {},
    render(viewEl) {
      viewEl.innerHTML = '';

      const btn = document.createElement('button');
      btn.className = 'tal-action-btn';
      btn.textContent = '开始截图';

      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '截图中…';
        try {
          const resp = await chrome.runtime.sendMessage({ type: 'IMG_SEARCH_START' });
          if (!resp?.ok) {
            window.AgentSeller.showToast(
              '截图启动失败：' + (resp?.reason || resp?.error || '未知'),
              'error'
            );
          }
        } catch (e) {
          window.AgentSeller.showToast('截图启动失败：' + e.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = '开始截图';
        }
      });

      viewEl.appendChild(btn);

      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:11px;color:#aaa;text-align:center;margin-top:6px;line-height:1.4;';
      hint.textContent = '在页面拖选截图区域，自动跳转 1688 搜图';
      viewEl.appendChild(hint);
    },
  });
})();
```

- [ ] **Step 2：提交**

```bash
git add image_search_1688/content/index.js
git commit -m "feat(image_search_1688): 添加 feature 注册脚本 content/index.js

Why: 在 AgentSeller Hub 注册「1688搜图」图标；点击后向 service worker 发 IMG_SEARCH_START。

Test: not run (需构建后在浏览器验证 Hub 显示)"
```

---

## Task 8：扩展 service-worker.js

**Files:**
- Modify: `core/background/service-worker.js`

- [ ] **Step 1：在文件顶部（`const NATIVE_HOST` 之前）添加图片搜索常量和工具函数**

在 `core/background/service-worker.js` 第 1 行之前插入：

```js
// ── image_search_1688 ── 图片搜索常量和工具函数 ──────────────────────────────
const IMG_SEARCH_URL         = 'https://s.1688.com/youyuan/index.htm';
const IMG_PAYLOAD_KEY        = 'imagePayload';
const IMG_PAYLOAD_TTL_MS     = 10_000;
const IMG_MAX_BYTES          = 4 * 1024 * 1024;
let   isImgSearchCapturing   = false;

function enableSessionStorageAccess() {
  chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
  }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(enableSessionStorageAccess);
chrome.runtime.onStartup.addListener(enableSessionStorageAccess);
enableSessionStorageAccess();

async function imgCropImage(fullDataUrl, rect, dpr) {
  const sx = Math.round(rect.x * dpr);
  const sy = Math.round(rect.y * dpr);
  const sw = Math.round(rect.w * dpr);
  const sh = Math.round(rect.h * dpr);
  const blob = await (await fetch(fullDataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const outBlob = await canvas.convertToBlob({ type: 'image/png' });
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(outBlob);
    });
  } finally {
    bitmap.close();
  }
}

async function imgSetPayload(dataUrl) {
  await chrome.storage.session.set({
    [IMG_PAYLOAD_KEY]: { dataUrl, ts: Date.now() },
  });
}

function imgEstimateBytes(dataUrl) {
  const i = dataUrl.indexOf(',');
  return i < 0 ? 0 : Math.floor(dataUrl.slice(i + 1).length * 0.75);
}

async function imgNotify(message) {
  await chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: '1688 以图搜图',
    message,
  });
}

chrome.tabs.onRemoved.addListener(() => { isImgSearchCapturing = false; });
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === 'loading') isImgSearchCapturing = false;
});
// ── end image_search_1688 ────────────────────────────────────────────────────

```

- [ ] **Step 2：将 onMessage 监听器的 `_sender` 改为 `sender`**

将第 29 行：

```js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
```

改为：

```js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
```

- [ ] **Step 3：在 onMessage 监听器末尾（`}` 之前）添加图片搜索消息处理器**

在最后一个 `if (msg.type === 'GET_STATUS') { ... }` 之后，`});` 之前插入：

```js
  if (msg.type === 'IMG_SEARCH_START') {
    if (isImgSearchCapturing) {
      sendResponse({ ok: false, reason: 'already-capturing' });
      return;
    }
    const tab = sender.tab;
    if (!tab) { sendResponse({ ok: false, reason: 'no-tab' }); return; }
    isImgSearchCapturing = true;
    (async () => {
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ['features/image_search_1688/content/overlay.css'],
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['features/image_search_1688/content/overlay.js'],
        });
        await chrome.tabs.sendMessage(tab.id, { type: 'IMG_SEARCH_START' });
        sendResponse({ ok: true });
      } catch (e) {
        isImgSearchCapturing = false;
        await imgNotify('该页面禁止注入脚本，截图无法启动。');
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'IMG_SEARCH_CANCEL') {
    isImgSearchCapturing = false;
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'IMG_SEARCH_CAPTURE_REGION') {
    (async () => {
      try {
        const { rect, dpr } = msg;
        const fullDataUrl = await chrome.tabs.captureVisibleTab(
          sender.tab.windowId, { format: 'png' }
        );
        const cropped = await imgCropImage(fullDataUrl, rect, dpr);
        if (imgEstimateBytes(cropped) > IMG_MAX_BYTES) {
          await chrome.tabs.sendMessage(sender.tab.id, { type: 'IMG_SEARCH_TOO_LARGE' }).catch(() => {});
          await imgNotify('图片过大，请缩小选区后重试。');
          sendResponse({ ok: false, error: 'too_large' });
          return;
        }
        await imgSetPayload(cropped);
        await chrome.tabs.create({ url: IMG_SEARCH_URL, openerTabId: sender.tab.id });
        sendResponse({ ok: true });
      } catch (e) {
        await imgNotify('截图失败：' + (e?.message ?? '未知错误'));
        sendResponse({ ok: false, error: String(e) });
      } finally {
        isImgSearchCapturing = false;
      }
    })();
    return true;
  }

  if (msg.type === 'IMG_SEARCH_INJECTION_RESULT') {
    if (!msg.ok) console.warn('[AgentSeller/img-search] 注入失败：', msg.reason);
    sendResponse({ ok: true });
    return;
  }
```

- [ ] **Step 4：提交**

```bash
git add core/background/service-worker.js
git commit -m "feat(core): service worker 添加图片搜索消息处理器

Why: 处理截图框选流程（注入 overlay → 裁切截图 → 写 session storage → 开 1688 tab）；
     enableSessionStorageAccess 让 1688 content script 能读 session storage。

Test: not run (需浏览器完整流程验证)"
```

---

## Task 9：全量构建 + 验证 manifest

**Files:**
- No new files（验证构建产物）

- [ ] **Step 1：全量构建**

```bash
cd /home/linux_dev/projects/agentseller_temu && python build/build_extension.py
```

预期输出（关键行）：
```
[build] discovered feature: auto_gen_label
[build] discovered feature: image_search_1688
[build] extra cs: image_search_1688/content/injector.js → dist/extension/features/image_search_1688/content/injector.js
[build] manifest.json generated  (2 features, 6 content scripts)
[build] done → .../dist/extension
```

- [ ] **Step 2：验证 manifest.json 的关键字段**

```bash
python3 -c "
import json
m = json.load(open('dist/extension/manifest.json'))
cs = m['content_scripts']
print('content_scripts 块数:', len(cs))
print('主块 matches:', cs[0]['matches'])
print('主块 js 数量:', len(cs[0]['js']))
print('主块末尾 js:', cs[0]['js'][-1])
if len(cs) > 1:
    print('injector 块 matches:', cs[1]['matches'])
    print('injector 块 js:', cs[1]['js'])
print('host_permissions:', m['host_permissions'])
print('permissions:', m['permissions'])
"
```

预期输出：
```
content_scripts 块数: 2
主块 matches: ['https://seller.temu.com/*', 'https://*.temu.com/*']
主块 js 数量: 6
主块末尾 js: features/image_search_1688/content/index.js
injector 块 matches: ['https://s.1688.com/*', 'https://*.1688.com/imgsearch/*']
injector 块 js: ['features/image_search_1688/content/injector.js']
host_permissions: ['https://*.1688.com/*', 'https://seller.temu.com/*', 'https://*.temu.com/*']
permissions: ['activeTab', 'clipboardWrite', 'nativeMessaging', 'notifications', 'scripting', 'storage']
```

关键验证点：
- 主块 `matches` **不含** `1688.com`（FAB 不会出现在 1688 页面）
- `content_scripts` 有 2 块（主块 + injector 块）
- `host_permissions` 含 1688（service worker 可以 scripting.executeScript 到 1688 tab）

- [ ] **Step 3：验证 dist 文件完整性**

```bash
ls dist/extension/features/image_search_1688/content/
```

预期：`index.js  injector.js  overlay.css  overlay.js`（其中 overlay.css/js 由 service worker 动态注入，injector.js 由 manifest 静态加载）

等等——overlay.css 和 overlay.js 由 service worker 动态注入，需要在 dist 里存在，但目前构建只拷贝 `content_script` 字段引用的文件和 `extra_content_scripts` 引用的文件，不会自动拷贝 overlay.css/overlay.js。

需在 feature.json 里声明这两个文件，让构建拷贝它们。**修正 feature.json**，在 `extra_content_scripts` 中添加一个仅含 css/js 文件（matches 留空不会实际注入）的条目，或者扩展构建支持 `extra_assets` 字段。

更简单的方案：在 `extra_content_scripts` 的 injector 块旁再加一个条目，专门声明 overlay 文件让构建拷贝：

修改 `image_search_1688/feature.json`，将 `extra_content_scripts` 改为：

```json
"extra_content_scripts": [
  {
    "matches": ["https://s.1688.com/*", "https://*.1688.com/imgsearch/*"],
    "js": ["content/injector.js"],
    "run_at": "document_idle"
  }
],
"extra_assets": ["content/overlay.css", "content/overlay.js"]
```

同时在 `build_extension.py` 的 `copy_extra_cs_assets` 末尾添加对 `extra_assets` 的处理：

```python
def copy_extra_cs_assets(features):
    for f in features:
        src_dir = f['_dir']
        for ecs in f.get('extra_content_scripts', []):
            for js_path in ecs.get('js', []):
                src = src_dir / js_path
                dst = DIST / 'features' / f['id'] / js_path
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                rel = src.relative_to(ROOT)
                _inject_source_url(dst, str(rel))
                print(f'[build] extra cs: {rel} → dist/extension/features/{f["id"]}/{js_path}')
        for asset_path in f.get('extra_assets', []):
            src = src_dir / asset_path
            dst = DIST / 'features' / f['id'] / asset_path
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            rel = src.relative_to(ROOT)
            _inject_source_url(dst, str(rel))
            print(f'[build] extra asset: {rel} → dist/extension/features/{f["id"]}/{asset_path}')
```

更新 `tests/test_build.py` 添加 extra_assets 测试：

```python
def test_extra_assets_field_not_in_extra_content_scripts():
    # extra_assets 不应出现在 manifest 的 content_scripts 里
    features = [{
        'id': 'img',
        '_dir': Path('/fake'),
        'extra_content_scripts': [],
        'extra_assets': ['content/overlay.css', 'content/overlay.js'],
    }]
    result = collect_extra_content_scripts(features)
    assert result == []
```

重新运行测试：

```bash
python tests/test_build.py
```

预期：`All tests passed.`

- [ ] **Step 4：重新提交修正**

```bash
git add build/build_extension.py image_search_1688/feature.json tests/test_build.py
git commit -m "fix(build): 支持 extra_assets 字段，确保 overlay 文件被拷贝到 dist

Why: service worker 动态注入 overlay.css/overlay.js 需要文件在 dist 里存在，
     但这两个文件不通过 content_scripts 静态声明，需要 extra_assets 机制拷贝。

Test: python tests/test_build.py → All tests passed."
```

---

## Task 10：写 CLAUDE.md + 最终提交

**Files:**
- Create: `image_search_1688/CLAUDE.md`

- [ ] **Step 1：写 CLAUDE.md**

内容写入 `image_search_1688/CLAUDE.md`：

```markdown
# image_search_1688 Feature

> 顶层架构见项目根 `CLAUDE.md`。本文档只覆盖本 feature 的实现细节。

## Feature 概述

- **Feature ID**：`image_search_1688`
- **作用**：在 Temu 页面框选截图，自动跳转 1688 以图搜图
- **触发**：Hub 面板 → 点击「🔍 1688搜图」图标 → 点「开始截图」按钮

## 文件结构

```
image_search_1688/
├── feature.json
├── content/
│   ├── index.js       # 注册 feature，渲染「开始截图」按钮
│   ├── overlay.js     # 截图框选覆盖层（动态注入到 Temu tab）
│   ├── overlay.css    # 覆盖层样式（动态注入到 Temu tab）
│   └── injector.js    # 1688 页自动注入截图（静态 content script）
└── CLAUDE.md
```

## 流程

1. 用户点「开始截图」→ `content/index.js` 发 `IMG_SEARCH_START` 给 service worker
2. Service worker 向当前 tab 注入 `overlay.css` + `overlay.js`
3. 用户框选区域 → `overlay.js` 发 `IMG_SEARCH_CAPTURE_REGION { rect, dpr }`
4. Service worker：`captureVisibleTab` → 裁切 → 写 `chrome.storage.session.imagePayload` → 开 1688 tab
5. `injector.js`（在 1688 tab 静默运行）：读 payload → 找 file input → 注入图片 → 触发搜索

## 消息类型

所有消息使用 `IMG_SEARCH_` 前缀：

| 消息 | 方向 | 说明 |
|------|------|------|
| `IMG_SEARCH_START` | content → SW → overlay | 启动截图 |
| `IMG_SEARCH_CAPTURE_REGION` | overlay → SW | 用户确认框选区域 |
| `IMG_SEARCH_CANCEL` | overlay → SW | 用户取消 |
| `IMG_SEARCH_TOO_LARGE` | SW → overlay | 截图超过 4MB |
| `IMG_SEARCH_INJECTION_RESULT` | injector → SW | 注入结果上报 |

## feature.json 特殊字段说明

- `content_matches: []`：不向主 content_scripts 块添加新域，FAB 不出现在 1688 页面
- `host_permissions: ["https://*.1688.com/*"]`：SW 需要此权限向 1688 tab 执行 scripting
- `extra_content_scripts`：injector.js 静态加载到 1688 搜索页（独立于主 content_scripts 块）
- `extra_assets`：overlay.css / overlay.js 由构建拷贝到 dist，供 SW 动态注入使用

## 注意事项

- `chrome.storage.session` 需在 SW 的 `onInstalled`/`onStartup` 调用 `setAccessLevel` 开放给 content script（已在 service-worker.js 中设置）
- 1688 风控页（路径含 `/punish` 或参数含 `x5secdata`）会走剪贴板兜底路径
- `overlay.js` 的 guard 变量是 `window.__img_search_overlay_loaded__`，可安全多次注入
```

- [ ] **Step 2：最终全量构建确认**

```bash
cd /home/linux_dev/projects/agentseller_temu && python build/build_extension.py
```

确认无报错，`dist/extension/features/image_search_1688/content/` 包含 4 个文件：`index.js`, `injector.js`, `overlay.css`, `overlay.js`。

- [ ] **Step 3：最终提交**

```bash
git add image_search_1688/CLAUDE.md
git commit -m "docs(image_search_1688): 添加 feature CLAUDE.md

Test: not run (文档)"
```

---

## 手动验证清单

全量构建并在 Chrome 加载 `dist/extension/` 后，按以下步骤验证：

**验证 1：FAB 不出现在 1688 页面**
- [ ] 打开 `https://s.1688.com/youyuan/index.htm`，确认页面右下角**没有** AgentSeller FAB

**验证 2：Hub 出现「1688搜图」图标**
- [ ] 打开任意 `seller.temu.com` 页面
- [ ] Ctrl+点击 FAB → Hub 面板出现「🔍 1688搜图」图标

**验证 3：截图框选流程**
- [ ] 点击「🔍 1688搜图」→ 点「开始截图」→ 页面出现黑色半透明覆盖层和十字光标
- [ ] 拖选任意区域 → 出现工具栏（搜索 1688 / 重选 / 取消）
- [ ] 点「搜索 1688」→ 自动打开新 1688 tab

**验证 4：1688 页图片自动注入**
- [ ] 新 1688 tab 打开后，图片自动填入搜索框并触发搜索
- [ ] 如自动触发失败，检查 DevTools Console 中 `[agentseller/img-search/injector]` 日志

**验证 5：取消和 Esc**
- [ ] 覆盖层出现后按 Esc → 覆盖层消失，Hub 按钮恢复可点击

**验证 6：auto_gen_label 无回归**
- [ ] 在 Temu 条码管理页，标签生成功能正常（Phase 1/2/3 不受影响）
