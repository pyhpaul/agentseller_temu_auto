# image_search_1688 集成设计

**日期**：2026-05-20  
**状态**：草稿

---

## 背景

`image_search_1688` 是一个已独立实现的 Chrome 扩展，功能是：在任意网页框选截图后，自动跳转 1688 以图搜图并注入截图。原触发方式为 `Alt+S` 快捷键或 popup 点击。

本文档描述将其作为新 feature 集成进 `agentseller_temu` 多 feature 插件架构，并改为**点击 Hub 图标触发**的设计方案。

---

## 目标

1. 将 `image_search_1688` 以标准 feature 形式注册到 AgentSeller Hub。
2. 用户在 Temu 页面打开 Hub → 点击「1688搜图」图标 → 框选截图 → 自动在新 tab 搜索。
3. 不破坏现有 `auto_gen_label` feature 的任何行为。
4. 构建系统扩展向后兼容，现有 feature 无需改动。

---

## 架构概览

```
Temu 页面（content scripts 运行）
  └── Hub 图标点击
        └── content/index.js → sendMessage({ type: 'IMG_SEARCH_START' })
              └── service-worker.js
                    ├── scripting.insertCSS(overlay.css) → Temu tab
                    ├── scripting.executeScript(overlay.js) → Temu tab
                    │
                    │   用户框选区域
                    │
                    ├── ← CAPTURE_REGION { rect, dpr }
                    ├── captureVisibleTab → cropImage → setPayload(session storage)
                    └── tabs.create(1688 搜索页)

1688 搜索页（injector.js 静态 content script）
  └── 读取 session storage payload → 找 file input → 注入图片 → 触发搜索
```

---

## 触发方式变更

| 原方式 | 新方式 |
|--------|--------|
| `Alt+S` 快捷键 / popup 按钮 | Hub 面板内「🔍 1688搜图」图标点击 |

取消快捷键和 popup 依赖；feature 的 `render()` 函数渲染一个「开始截图」按钮，点击后向 service worker 发送 `IMG_SEARCH_START` 消息。

---

## 新增文件

```
image_search_1688/
├── feature.json
├── content/
│   ├── index.js        # 注册 feature；render "开始截图" 按钮
│   ├── overlay.js      # 截图框选覆盖层（适配自原 src/content/overlay.js）
│   ├── overlay.css     # 覆盖层样式（直接复制）
│   └── injector.js     # 1688 页自动注入截图（适配自原 src/content/injector.js）
└── CLAUDE.md
```

### feature.json

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

**字段说明：**

- `content_matches: []`：此 feature 不向主 content_scripts 块添加新的注入域（feature 的 index.js 跟随 auto_gen_label 的 Temu 域名被注入）。
- `host_permissions`：1688 域名；service worker 需要此权限才能向 1688 tab 执行 scripting。
- `extra_content_scripts`：声明 injector.js 静态加载到 1688 搜索页，独立于主 content_scripts 块。

### content/index.js

职责：
1. 调用 `window.AgentSeller.registerFeature(...)` 注册到 Hub。
2. `render(viewEl)` 渲染「开始截图」按钮。
3. 按钮点击时发送 `{ type: 'IMG_SEARCH_START' }` 给 service worker；按钮在截图进行中禁用，收到响应后恢复。

### content/overlay.js

从原 `src/content/overlay.js` 适配：
- 去掉 ESM `import`，改为内联常量（`MSG_START_CAPTURE` 等字符串直接写死）。
- 消息类型前缀改为 `IMG_SEARCH_*`，避免与其他 feature 冲突。
- 其余逻辑（鼠标框选、工具栏、Esc 取消）保持不变。

### content/overlay.css

直接从原 `src/content/overlay.css` 复制，不改动。

### content/injector.js

从原 `src/content/injector.js` 适配：
- 去掉 ESM `import`，内联 `isExpired`、`pickFileInput`、常量（`STORAGE_KEY`、`TTL_MS` 等）。
- 逻辑不变：读 session storage payload → 等 file input → 注入 blob → 触发搜索按钮。

---

## 修改现有文件

### core/background/service-worker.js

新增内容（在现有 native messaging 逻辑后追加）：

**1. 初始化**

```js
// session storage 对 content script 开放（injector.js 需要读取）
function enableSessionStorageAccess() {
  chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
  }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(enableSessionStorageAccess);
chrome.runtime.onStartup.addListener(enableSessionStorageAccess);
enableSessionStorageAccess();
```

**2. 内联工具函数**

```js
// cropImage(fullDataUrl, rect, dpr) → Promise<dataUrl>
// setPayload(dataUrl) → 写入 chrome.storage.session
// estimateDataUrlBytes(dataUrl) → number
```

这些函数从原 `background.js` 直接移植，去掉 ESM export 语法。

**3. 消息处理器（追加到现有 onMessage listener）**

| 消息类型 | 处理 |
|----------|------|
| `IMG_SEARCH_START` | 向 `sender.tab` 注入 overlay.css + overlay.js；设 `isCapturing = true` |
| `IMG_SEARCH_CAPTURE_REGION` | captureVisibleTab → cropImage → 大小校验 → setPayload → tabs.create(1688) |
| `IMG_SEARCH_CANCEL` | `isCapturing = false` |
| `IMG_SEARCH_INJECTION_RESULT` | 记录注入成功/失败日志 |

**4. Tab 状态复位**

```js
chrome.tabs.onRemoved.addListener(() => { isImgSearchCapturing = false; });
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'loading') isImgSearchCapturing = false;
});
```

变量名使用 `isImgSearchCapturing` 避免与未来其他 feature 冲突。

**overlay 文件路径**（dist 后的路径）：
- CSS：`features/image_search_1688/content/overlay.css`
- JS：`features/image_search_1688/content/overlay.js`

### build/build_extension.py

**变更 1：聚合 content_matches（向后兼容）**

```python
# 现有
content_script_matches = host_permissions

# 变更后
content_script_matches = sorted({
    m
    for f in features
    for m in f.get('content_matches', f.get('host_permissions', []))
})
```

`auto_gen_label` 无 `content_matches` 字段 → 回退到 `host_permissions` → 结果与现在完全相同。

**变更 2：处理 extra_content_scripts**

```python
def collect_extra_content_scripts(features):
    result = []
    for f in features:
        for ecs in f.get('extra_content_scripts', []):
            ecs_copy = dict(ecs)
            ecs_copy['js'] = [f'features/{f["id"]}/{js}' for js in ecs_copy.get('js', [])]
            result.append(ecs_copy)
    return result
```

**变更 3：拷贝 extra_content_scripts 引用的文件**

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
                _inject_source_url(dst, str(src.relative_to(ROOT)))
```

CSS 文件同理（`ecs.get('css', [])`）。

**变更 4：render_manifest 追加 extra_content_scripts 块**

```python
extra_cs = collect_extra_content_scripts(features)
template['content_scripts'][0]['matches'] = content_script_matches
for ecs in extra_cs:
    template['content_scripts'].append(ecs)
```

### core/manifest.template.json

将 `content_scripts[0].matches` 占位符从 `"__HOST_PERMISSIONS__"` 改为 `"__CONTENT_MATCHES__"`（逻辑隔离，构建脚本对应填充）。

---

## 消息类型命名

所有图片搜索相关消息使用 `IMG_SEARCH_` 前缀，避免与 native messaging action 及未来其他 feature 消息冲突：

| 常量 | 值 |
|------|----|
| `IMG_SEARCH_START` | `'IMG_SEARCH_START'` |
| `IMG_SEARCH_CAPTURE_REGION` | `'IMG_SEARCH_CAPTURE_REGION'` |
| `IMG_SEARCH_CANCEL` | `'IMG_SEARCH_CANCEL'` |
| `IMG_SEARCH_TOO_LARGE` | `'IMG_SEARCH_TOO_LARGE'` |
| `IMG_SEARCH_INJECTION_RESULT` | `'IMG_SEARCH_INJECTION_RESULT'` |

---

## 数据流：图片 payload

```
service-worker（croppedDataUrl）
    → chrome.storage.session.set({ imagePayload: { dataUrl, ts } })
    → chrome.tabs.create({ url: 'https://s.1688.com/youyuan/index.htm' })

injector.js（在新 1688 tab 中）
    → chrome.storage.session.get('imagePayload')
    → 校验 TTL（10s）
    → 等待 file input（最多 8s，MutationObserver）
    → 注入 File 对象 → dispatch change/input 事件
    → 等待预览图加载 → 模拟点击「搜索」按钮
    → chrome.storage.session.remove('imagePayload')
```

session storage 需在 `onInstalled`/`onStartup` 设置 `TRUSTED_AND_UNTRUSTED_CONTEXTS`，否则 content script 读不到。

---

## 权限变更

| 权限 | 来源 | 说明 |
|------|------|------|
| `scripting` | image_search_1688 | 动态注入 overlay |
| `storage` | image_search_1688 | session storage 传图片 |
| `notifications` | image_search_1688 | 截图失败提示 |
| `clipboardWrite` | image_search_1688 | 注入失败时复制图片到剪贴板作为兜底 |
| `activeTab` | image_search_1688 | 截图时访问当前 tab |
| `https://*.1688.com/*` | image_search_1688 host_permissions | 向 1688 tab 执行 scripting |

`nativeMessaging` 由 `auto_gen_label` 保持，不受影响。

---

## 向后兼容性

| 影响范围 | 结论 |
|----------|------|
| `auto_gen_label` feature | 无变化；feature.json 无需修改 |
| 构建输出（auto_gen_label 部分）| 与现在完全相同 |
| 现有 manifest 结构 | 仅多出一个 extra content_scripts 块；主块 matches 值不变 |
| service-worker.js | 追加新消息处理器；现有 native messaging 逻辑不动 |

---

## 不在本次范围内

- 快捷键支持（去掉 Alt+S，不重新添加）
- popup 入口（沿用现有 AgentSeller popup）
- 1688 页面以外的其他搜图平台
