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
- `js` 路径在 `feature.json` 中始终使用 `/` 分隔符（即使在 Windows 上）
