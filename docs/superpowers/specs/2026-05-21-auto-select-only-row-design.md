# 标签生成搜索唯一商品自动选中 — 设计

- **日期**：2026-05-21
- **Feature**：`auto_gen_label`
- **改动文件**：`features/auto_gen_label/content/index.js`（单文件）
- **目标**：当用户在 Temu 商家中心条码管理页搜索 SKC 后表格只剩 1 行时，自动调用 `selectRow` 设置 `fstate.product` + 加 `.tal-selected` class，省去手动点击的步骤
- **背景**：用户报告 Temu 自身的选中视觉反馈有时缺失，加之搜索 SKC 后通常表格唯一一行就是目标商品，手动点击重复且容易让用户疑惑

## 范围

- ✅ 改动 `watchNewRows` 的 MutationObserver 回调，新增「N>1→1」转变检测
- ✅ 新增 `maybeAutoSelectOnlyRow(rows)` 函数
- ✅ 新增 toast 提示「已自动选中商品 SKC=xxx」
- ❌ 不动 `bindRows` / `selectRow` / `clearSelection` / `setProduct` / `refreshProductUI`
- ❌ 不 hook Temu 的搜索按钮 DOM（避免依赖 Temu 改版易碎的选择器）
- ❌ 不加 toggle / 开关让用户控制（YAGNI，跑通后看真实反馈再说）

## 架构与状态机

### 改动 1：扩展 `watchNewRows`（`index.js:210-216`）

```js
let prevRowCount = null;        // 闭包变量，跨 mutation 持久化

function watchNewRows() {
  if (rowObserver) return;
  rowObserver = new MutationObserver(() => {
    const rows = document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]');
    bindRows(document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]:not([data-tal-bound])'));
    maybeAutoSelectOnlyRow(rows);
    prevRowCount = rows.length;
  });
  rowObserver.observe(document.querySelector('tbody') || document.body, { childList: true, subtree: true });
}
```

### 改动 2：新增 `maybeAutoSelectOnlyRow`

```js
function maybeAutoSelectOnlyRow(rows) {
  // 转变触发：prev 不是 1 行 && cur 是 1 行
  if (prevRowCount === 1 || rows.length !== 1) return;
  const row = rows[0];
  if (selectedRow === row) return;            // 同一行幂等保护
  selectRow(row);
  if (fstate.product) {
    U.showToast(`已自动选中商品 ${fstate.product.skcNumber}`, 'ok');
  }
}
```

### 状态机不变量

| `prevRowCount` | `rows.length` | 行为 |
|----------------|--------------|------|
| `null`（首次） | 1 | **触发**自动选中 |
| `null`（首次） | 0 / >1 | 不动 |
| 1 | 1（同一行） | 不动（幂等保护） |
| 1 | 0 / >1 | 不动 |
| >1 或 0 | 1 | **触发**自动选中 |
| 任何 | 任何（不属 N>1→1） | 不动 |

### 与现有手动 click 路径的关系

完全保留 `bindRows` 的 click handler。用户仍可：
- 手动点不同行切换选中（覆盖自动选）
- 手动点已选中行取消（`selectedRow === row ? clearSelection() : selectRow(row)`，line 205）
- 取消后想再让自动选触发 → 重新搜索一次让表格经历 N→1 转变

## 边界情况

| 场景 | 现有保护 | 自动选中行为 |
|------|---------|------------|
| Loading skeleton 占位行 | `tr[data-testid="beast-core-table-body-tr"]` 选择器精确，skeleton 通常用不同 testid | skeleton 不会被算入 rows |
| `td` 内容未渲染好（SKC 为空） | `extractRowData` 内 `skc && skcSku ? {...} : null` | `selectRow` 走 `setStatus(err)` 错误分支，`fstate.product` 未 set → toast 被 `if (fstate.product)` 防住，不刷 |
| `selectedRow` 是旧 DOM 节点（已 unmount） | `===` 比较新旧 row 引用不同 → 幂等保护失效，正常触发 | OK，按预期切到新行 |
| MutationObserver 频繁触发 | rows < 100，遍历开销可忽略 | 不加 throttle / debounce（YAGNI） |
| feature 切走再回 | `prevRowCount` 是 IIFE 闭包变量，feature 切换不重载（content script 仍存活），保留上一次值 | 切回后第一次 mutation 用旧 baseline；只有页面 reload 才会清回 `null` |

## 错误处理

不写新的 try/catch，全部靠现有保护：

- `extractRowData` 返回 `null` → `selectRow` 内 `setStatus('未能读取该行数据', 'err')`，toast 不发 → 自动选中默默失败，不刷屏
- `U.showToast` 未定义（不应发生，core API 必现）→ 由 toast 自身抛错带过，主流程不阻断

## 测试方案（手动验收）

无自动化测试。按优先级手动跑：

1. **核心 use case**：进条码管理页（多行）→ 输入 SKC 搜索 → 表格剩 1 行 → 自动选中 + toast → Phase 1 可直接「开始执行」
2. **多次切换**：搜 A 自动选 → 清空搜索回多行 → 搜 B → 自动选 B（不是 A）
3. **手动 clear 后**：自动选 A → 点已选行取消 → 表格仍 1 行 → **不应自动选回来**（验证 `prevRowCount===1` 守卫）
4. **同 SKC 重搜**：搜 A → 自动选 → 清空 → 再搜 A → 自动选（N→1 转变触发）
5. **空表格**：搜不存在的 SKC → 0 行 → 不报错、不 toast
6. **手动 click 覆盖**：多行 → 手动点行 1 → 用户继续操作让表格过滤变成只剩行 2 → 自动选切到行 2
7. **回归**：不搜索手动点任意行；点已选行取消；Phase 1 / Phase 2 / Phase 3 完整流程 — 行为跟现状完全一致

## 风险与回滚

- **toast 跨行刷屏**：如果 Temu 有意外 mutation 导致频繁 N>1→1 转变（极低概率），toast 会跨行刷。**先观察生产实际情况，不预先优化**。如出现，加 1 秒 debounce 即可。
- **回滚**：单个 commit 单文件，`git revert` 一行命令复原。

## 提交策略

- 分支：`feat/auto-select-only-row`
- 1 个 commit：`feat(auto_gen_label): 表格变 1 行时自动选中商品`
- PR-only 流程，`/review` 审查后合入 main

## 关联

- 实现细节参考：`features/auto_gen_label/CLAUDE.md` Phase 1 章节
- 触发上下文：`features/auto_gen_label/content/index.js` 第 5 节「行绑定 + 数据提取」
