# check_and_publish Feature

> 顶层架构（公共骨架 / feature 注册契约 / Core API）见项目根 `CLAUDE.md`。本文档只覆盖本 feature 的实现细节。

## 概述

- **Feature ID**: `check_and_publish`
- **作用**: 店小秘 ERP 商品编辑页的合规预检 + 模拟发布。检查通过后用户二次确认才触发店小秘原生「发布」按钮下拉 → 立即发布
- **触发域名**: `*.dianxiaomi.com`（URL 含 `edit` 才放行检查动作）
- **触发动作**: FAB → Hub → ✅ 检查与发布 → 点「检查并发布」按钮

## feature.json

```json
{
  "id": "check_and_publish",
  "icon": "✅",
  "label": "检查与发布",
  "order": 3,
  "content_script": "content/index.js",
  "host_permissions": ["https://www.dianxiaomi.com/*", "https://*.dianxiaomi.com/*"],
  "content_matches": ["https://www.dianxiaomi.com/*", "https://*.dianxiaomi.com/*"],
  "permissions": ["storage"]
}
```

显式声明 `content_matches` 防止 FAB 注入污染（项目记忆：缺省时会回退到 host_permissions，导致 FAB 出现在不该出现的页面）。

## 目录结构

```
check_and_publish/
├── feature.json
├── CLAUDE.md                  # 本文件
├── content/
│   └── index.js               # 单文件 IIFE：词库 + DOM + 规则 + 调度 + 发布 + Panel
└── samples/                   # 规则数据源 + DOM 抓取
    ├── total_dom.txt          # 店小秘编辑页整页 DOM
    ├── 标题.docx               # 违禁词清单（标题/描述共用）
    ├── 产品描述.docx           # 同源
    ├── 敏感属性.docx           # 暂未使用（用户暂不开放检测）
    ├── 类目.docx               # 暂未使用
    ├── 规则.txt                # 腾讯文档链接（个人整理，未抓取）
    └── 官方规则汇总.md          # 店小秘官方 + WebSearch 综合规则参考
```

## content/index.js 内部组织

单文件 IIFE，按职责分段（出现顺序）：

1. **常量与词库**：`BASE_FORBIDDEN` / `MARKETING_FORBIDDEN` / `CN_PUNCT_RE` / `CJK_RE` / `MULTIPACK_INDICATORS` / `IMG_MIN_SIZE` / `VARIATION_MAX`
2. **DOM 取值层**：`isEditPage` / `findRequiredFormItems` / `isRequiredItemEmpty` / `findVariationTableRequiredEmpties` / 各字段 getter
3. **规则辅助**：`matchWords`（≤4 字符英文词加 `\b` 边界保护，避免「ins」误中「instructions」）
4. **规则注册表**：`RULES` 数组（见下表）
5. **调度器**：`collectFields` / `runChecks` / `bucketize`
6. **Panel 状态机**：`idle → failed/passed → publishing → done`
7. **用户交互**：`onCheck` / `onPublish`（含 URL 检测、`clickPublishImmediate`）
8. **注册**：`window.AgentSeller.registerFeature(...)`

## 规则注册表（11 条）

新增检查类型只需在 `RULES` 数组追加一条 `{id, name, field, severity, check(ctx)}`。

| # | id | severity | 数据源 |
|---|----|---|---|
| 1 | `title_length` | block | DOM `maxlength=250` + 店小秘官方 |
| 2 | `title_forbidden` | block | `samples/标题.docx` |
| 3 | `description_forbidden` | block | 同上（共用） |
| 4 | `required_fields_empty` | block | `.ant-form-item-required` × 9 + 变种表 `<th><span class="required">` |
| 5 | `chinese_punctuation` | block | 店小秘官方（含中文标点导致发布失败） |
| 6 | `title_should_english` | block | 店小秘官方 |
| 7 | `sku_no_chinese` | block | 店小秘官方 + `input[name="variationSku"]` |
| 8 | `variation_count_le_20` | block | 店小秘官方 |
| 9 | `forbidden_words_marketing` | block | WebSearch（免费/秒杀/sale/discount 等） |
| 10 | `multipack_should_indicate` | warn | 多变种时标题应含 pcs/pack/set 等 |
| 11 | `image_carousel_size` | warn | 店小秘官方（≥800×800, 1:1）— 信号源 naturalWidth 可能是缩略图，保 warn |

`check(ctx)` 返回形态：
- `{ pass: true }` — 通过
- `{ pass: false, reason, hits? }` — 阻断/警告（含命中词）
- `{ pass: true, skipped: true, reason }` — 字段未识别，跳过

## 关键 DOM 策略

### 标题
`input.ant-input-sm[maxlength="250"]` — maxlength=250 是稳定锚点；页面有两个候选（中文标题 + 英文标题），取第一个 = 当前编辑中的主标题。

### 描述（不完美）
DOM 上**无 `contenteditable` 节点** — 描述靠模态编辑器渲染，未打开模态时 4 层 fallback 都取不到，规则 skipped。这是店小秘产品设计决定，绕不开。

### 必填字段（双机制）
| 机制 | 选择器 | 实现 |
|---|---|---|
| 主表 9 个字段 | `.ant-form-item-required` | `isRequiredItemEmpty` 按控件类型判空（Upload / Ant Select / radio/checkbox / input/textarea） |
| 变种表列必填 | `<th><span class="required">` | `findVariationTableRequiredEmpties` 用 `th.cellIndex` → 同 table 数据行 `tr.cells[colIndex]` → `isCellFilled` 判空 |

变种表是普通 HTML table（VxeTable 只是 CSS 主题，cellIndex 可用）。

### 发布按钮 + 下拉
- 触发：`button.btn-green` 含「发布」文本，**完整鼠标事件序列**（mouseenter → mouseover → mousedown → mouseup → click），覆盖 hover/click 两种 trigger
- 菜单项：`.ant-dropdown-menu-item[title="立即发布"]`（页面 portal 到 body 多个 dropdown，**过滤 `display !== 'none'` 的那个**，避免点到隐藏菜单项）

### 中文标点
不含 Unicode 弯引号 `""''`（U+201C/201D/2018/2019）— 视觉近似 ASCII 直引号，来源是 smart quotes 自动转换，跟"中文输入法"无关；如实测 Temu 也拒收再单独加规则。

## 新增规则工作流

1. 把规则记到 `samples/官方规则汇总.md`（含来源链接）
2. `content/index.js` 顶部加词库常量（如需要）
3. 加 DOM getter 到 `collectFields`（如需要新字段）
4. 在 `RULES` 数组 push 一条 `{id, name, field, severity, check(ctx)}`
5. `python build/dev.py` watch 同步 → chrome 扩展卡片 reload → 实测

## 已知限制

- **描述字段读取**：模态未打开则 skipped（DOM 限制）
- **图片尺寸信号源不稳**：`naturalWidth` 可能是缩略图尺寸而非原图
- **Hub 在所有匹配域名显示 4 个 feature**：项目级现状，本 feature 用 `isEditPage()` 在点击时 toast 提示用户域名/页面不对

## 后续扩展候选

详见 `samples/官方规则汇总.md` 的「未落地的规则」段：
- 描述模态打开后的字段检测（单模块 < 500、模块数 ≤ 50、描述总长）
- 轮播图数量 ≤ 10、文件大小 ≤ 2M
- 视频/说明书 PDF 规则
- 弯引号专项规则（待实测确认）
- 壳膜类专项（标题必须含 `for iPhone`）— 需要类目识别
- Temu 后台审核驳回反馈 → 自动加规则

## 调试

```bash
python build/dev.py    # watch 同步源 → dist
# chrome 加载 dist/extension/ → 店小秘编辑页 → FAB → Hub → ✅
```

取值层问题：DevTools console 跑 `document.querySelectorAll('input[maxlength="250"]')` 等手动验证选择器。
发布失败：看 Toast 错误文案 — 找不到按钮 / 下拉未展开 / 找不到「立即发布」分别对应不同选择器问题。
