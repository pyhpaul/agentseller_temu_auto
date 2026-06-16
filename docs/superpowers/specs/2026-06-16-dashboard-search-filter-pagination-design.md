# Dashboard 商品搜索 + 多维筛选 + 分页 设计

**状态**：设计已确认（2026-06-16），待实现
**背景**：automation dashboard 商品规模化 backlog 第①项

## 1. 动机

automation dashboard 的 `queue-list` 全量渲染 `batch.workflows`、按状态分三组，无搜索筛选。商品过几十个就难用——找不到目标商品、全量重渲卡顿。本设计做**搜索 + 多维筛选 + 分页**解决列表可用性。

存储上限（`chrome.storage.local` 默认 10MB，临界约 1000–2000 商品）不是近忧，不在本设计范围（见 backlog 的 done 归档 / unlimitedStorage 项）。

## 2. 范围

**做**：商品名文本搜索 + 多维筛选（状态 / 当前步骤 / 利润率区间）+ 扁平分页 + dev-only mock fixture（测列表规模）。

**不做（YAGNI / backlog 其他项）**：done workflow 归档、`unlimitedStorage` 权限、虚拟滚动（分页已足够）。

## 3. 架构：单元划分

筛选是**纯 UI 状态，不进 store**（store 是 storage 数据骨架的镜像，掺 UI 状态会污染数据层）。职责隔离为纯函数 + 独立组件：

| 单元 | 文件 | 职责 | 可测 |
|------|------|------|------|
| `filterWorkflows(workflows, criteria)` | `automation/dashboard/state/filter-workflows.js`（UMD 双模式） | AND 叠加过滤，返回 workflow 子集 | node 单测 |
| `paginate(list, page, pageSize)` | `automation/dashboard/state/paginate.js`（UMD 双模式） | 切页，返回 `{items, page, totalPages, total}` | node 单测 |
| `renderFilterBar(mountEl, criteria, onChange)` | `automation/dashboard/components/filter-bar.js` | 搜索框 + 状态 chips + 折叠面板 UI，产出 criteria | DOM 组件（人工验证） |
| queue-list 改造 | `automation/dashboard/components/queue-list.js` | **扁平列表**（去 groupWorkflows）+ 分页控件 | DOM 组件 |
| mock fixture | `automation/dashboard/mock/mock-workflows.js`（dev-only） | 生成 N 个假 workflow 灌 store 测 UI | — |
| 协调 | `automation/dashboard/dashboard.js` | 持局部 `filterCriteria` + `page` state，串联过滤→分页→渲染 | — |

## 4. 数据契约：criteria

```js
criteria = {
  text: '',          // 商品名搜索关键词
  statuses: [],      // 选中的状态数组（空 = 全部）
  stepId: null,      // 当前所处步骤 id（null = 不过滤）
  marginMin: null,   // 利润率下限（百分比数值，如 20 表示 20%）
  marginMax: null,   // 利润率上限
}
```

初始（无过滤）：`{ text:'', statuses:[], stepId:null, marginMin:null, marginMax:null }`。

## 5. 过滤语义（`filterWorkflows`，AND 叠加）

对每个 workflow，所有非空条件都命中才保留：

- **text**：`w.product.label` 子串匹配，**不区分大小写**；空串 = 不过滤。label 为空的 workflow 在有 text 时不匹配。
- **statuses**：`statuses.includes(w.status)`；空数组 = 全部状态（不过滤）。
- **stepId**：当前 cursor step 的 id == stepId，即 `w.steps[w.cursor]?.id === stepId`；null = 不过滤。
- **marginMin/marginMax**：对 `w.product.grossMargin`（存的是小数，如 0.35）换算百分比后比较。**仅对已走到 ⑥ 确认、有 grossMargin 的 workflow 生效**；设了区间但 grossMargin 为 null 的 workflow **算不匹配（排除）**。单边可空（只设 min 或只设 max）。

返回过滤后的数组（不改原数组）。

## 6. 渲染流 + 分页

```
workflows
  → filterWorkflows(workflows, criteria)
  → 排序：updatedAt 倒序（最近活动在前；updatedAt 缺省排末尾）
  → paginate(sorted, page, PAGE_SIZE=20)
  → 扁平 wfCard 列表 + 分页控件「‹ page/totalPages ›  共 total」
```

- `PAGE_SIZE = 20`（常量）。
- `page` state 在 dashboard.js；**criteria 任何变化 → page 重置为 1**。
- `paginate` 越界钳制：page 超出 totalPages 时取末页；空列表 totalPages = 1、items = []。
- 过滤后无匹配 → 列表区显示「无匹配商品」空态。
- **状态不再分组**：去掉 `groupWorkflows`，扁平渲染 wfCard；每张卡仍显示状态点 + 文字（现有 wfCard 已有）。选中态（activeWorkflowId 高亮）不变。

## 7. UI 布局

queue-list 顶部加过滤栏（`filter-bar.js`）：

- **常驻**：搜索框（text，input 事件防抖可选）+ 状态 chips（`[全部]` + 6 状态：待处理/运行中/待确认/出错/已完成/已中止，多选；`[全部]` 与具体状态互斥清空）
- **折叠「更多筛选 (N)」**（N = 激活的折叠内条件数）：步骤下拉（14 步选一）+ 利润率区间 `[min]~[max]%` 两个 number 输入
- 过滤栏下方是分页扁平列表 + 底部分页控件。

## 8. mock fixture（dev-only，纯 UI 测试）

**边界**：这是纯前端 UI 测试 fixture，**不碰真实 storage、不连 WS、不伪装运行状态**（区别于已删除的 WS 大脑流 mock 回放）。

- `mock/mock-workflows.js`：导出 `buildMockBatch(n)`，生成 n 个多样化 mock workflow——不同 label、覆盖全部 6 状态、不同 cursor（散布 14 步）、部分带 grossMargin（模拟走过 ⑥ 的）。
- 触发：dashboard URL 加 `?mock=50` → dashboard.js 检测参数 → `store.setSkeleton(buildMockBatch(50))` 灌入，**纯内存替换，不写 chrome.storage、不启 storage-source/ws-source**。
- release 不装配 `automation/` → 天然无此模块。

## 9. 测试

- `filterWorkflows` 单测：每维度单独命中/不命中 + 多维 AND 组合 + 空 criteria 返回全部 + 边界（grossMargin null 被区间排除 / text 大小写不敏感 / label 为空 / 无 steps 兜底不崩 / stepId 对 cursor step）。
- `paginate` 单测：页数计算 / page 越界钳制到末页 / 空列表（totalPages=1, items=[]）/ pageSize 边界 / 恰好整除。
- `filter-bar.js` / `queue-list.js` 是 DOM 组件，按现有约定不单测；靠 mock fixture（`?mock=50`）人工验证搜索/筛选/分页/空态。

## 10. 非目标

- 不做 done workflow 归档、不加 unlimitedStorage（backlog 其他项，独立推进）。
- 不做跨字段排序 UI（固定 updatedAt 倒序）。
- 不做筛选条件持久化（刷新 dashboard 重置为无过滤）。
- 不改 store / storage / 数据骨架契约（纯 UI 层增量）。
