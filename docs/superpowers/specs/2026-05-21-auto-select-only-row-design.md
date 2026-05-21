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

---

# 方案 A+ 重构（2026-05-21 update）

## 缘起

初版方案落地 commit `c7b6638` 后用户 Windows 端验收暴露：
- 「自动选中后 row 不高亮」、「Phase 1 跑不通」、「手动点击也无法选中」
- 现象一致：从用户视角"一直无法选中"，从代码视角 `fstate.product` 实际已被 set，但 `.tal-selected` 和 `selectedRow` 引用都指向不存在的旧 DOM 节点

## 诊断证据（Console 实测）

在搜索 SKC=82301884773 后表格剩 1 行的状态下：

```
1) data-tal-bound: null               ← bindRows 没绑过这一行
2) total rows: 1
3) tal-selected after click: false    ← 点击没触发我们 handler
4) class 列表: TB_tr_5-120-1 ...      ← React + CSS module 命名
5) feature view SKC: 82301884773      ← fstate.product 已设
6) findRowBySkc 反向寻址 → 找到当前 mounted row ✓
7) 手动给 row 加 .tal-selected → 行立即视觉高亮 ✓
8) 当前 mounted row 内能拿到「查看条码」按钮 ✓
9) 模拟 bindRows 给 row 绑 click handler → 手动点击触发 + SKC 提取 + 视觉同步全部 work ✓
```

## 根因（两个潜伏 bug，初版方案未覆盖）

### Bug 1：`rowObserver` 锁在旧 tbody DOM 引用上

```js
rowObserver.observe(document.querySelector('tbody') || document.body, ...);
```

初次 `watchNewRows` attach 在当时的 tbody。Temu 是 React 应用，搜索后会**整体替换 tbody 节点**（旧 tbody unmount、新 tbody mount）。observer 仍 attach 在已 detach 的旧 tbody，对新 tbody 内的 row 添加事件**无感知**。

后果：`bindRows` 不会触发，新 row 永远 `data-tal-bound: null`，click handler 没绑 → 手动点击无响应、`maybeAutoSelectOnlyRow` 也不会被回调。

### Bug 2：`selectedRow` 引用 detached row 节点

即使 observer 正常工作触发了一次 `selectRow`，React 在短时间内会做多次 re-render（典型 React 行为），先出现的 row A 被 unmount，新 row B 替换。`selectRow` 给 A 加的 `.tal-selected` class 跟 detached 的 A 一起脱离 DOM tree。`selectedRow = A` 也指向 detached 节点。

后果：
- 用户视觉看不到行高亮（class 在 detached A 上）
- `clickAndCaptureCanvas(selectedRow)` 在 detached A 内找「查看条码」按钮失败 → Phase 1 跑不通

## 方案 A+：4 处改动

### 1. observer attach 改 `document.body`（修复 Bug 1）

```js
function watchNewRows() {
  if (rowObserver) return;
  rowObserver = new MutationObserver(() => {
    bindRows(document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]:not([data-tal-bound])'));
    const rows = document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]');
    refreshRowHighlight();
    maybeAutoSelectOnlyRow(rows);
    prevRowCount = rows.length;
  });
  // 改为 body：永不 detach；subtree:true 覆盖任何子树变化
  rowObserver.observe(document.body, { childList: true, subtree: true });
}
```

性能：`document.body` subtree 比 tbody subtree 监听范围大，但 MutationObserver 是 native API + callback 内只跑 querySelectorAll + 极少 DOM 操作，实测 Temu 商家中心页面 DOM 活跃度可接受。如未来出 perf 问题，再加 throttle / 限定 closest container，YAGNI。

### 2. `selectedRow` → SKC 间接寻址（修复 Bug 2）

**删除** `let selectedRow = null;` 模块变量。`fstate.product.skcNumber` 是唯一 source of truth。

**新增 `findRowBySkc(skc)`**：

```js
function findRowBySkc(skc) {
  if (!skc) return null;
  const rows = document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]');
  for (const row of rows) {
    if (extractRowData(row)?.skcNumber === skc) return row;
  }
  return null;
}
```

`selectRow` 简化为「提取 SKC + setProduct + 同步视觉」，不再存 row 引用：

```js
function selectRow(row) {
  const product = extractRowData(row);
  if (!product) { setStatus('未能读取该行数据', 'err'); return; }
  setProduct(product);
  refreshRowHighlight();
}
```

`clearSelection` 简化：

```js
function clearSelection() {
  setProduct(null);
  refreshRowHighlight();
}
```

`onRunAllPhases` / `onRunPhase1Only` / `clickAndCaptureCanvas` 调用点改为：

```js
async function onRunAllPhases() {
  const row = findRowBySkc(fstate.product?.skcNumber);
  if (!fstate.product || !row) return;
  ...
  const { barcodePngB64, skcNumber } = await clickAndCaptureCanvas(row);
  ...
}
```

click handler 内同行幂等判断改为 SKC 比对：

```js
row.addEventListener('click', e => {
  if (e.target.closest('a, button')) return;
  const data = extractRowData(row);
  if (data?.skcNumber === fstate.product?.skcNumber) clearSelection();
  else selectRow(row);
});
```

### 3. 新增 `refreshRowHighlight()`（视觉同步）

```js
function refreshRowHighlight() {
  document.querySelectorAll('tr.tal-selected').forEach(r => r.classList.remove('tal-selected'));
  const row = findRowBySkc(fstate.product?.skcNumber);
  if (row) row.classList.add('tal-selected');
}
```

调用点：
- `setProduct` 内（fstate 变化后立即同步）
- `watchNewRows` mutation callback 内（Temu 重渲后自动恢复）
- `selectRow` / `clearSelection` 内（显式触发）

### 4. `maybeAutoSelectOnlyRow` 加 active feature 守卫

```js
function maybeAutoSelectOnlyRow(rows) {
  // 仅在 feature view 切到 auto_gen_label 时才自动选 + toast，
  // 避免用户在 Hub / 别的 feature 下搜索就被弹「已自动选中」toast
  const uiState = window.__AgentSellerUI?.getState?.();
  if (uiState?.view !== 'feature' || uiState?.feature !== 'auto_gen_label') return;

  if (prevRowCount === 1 || rows.length !== 1) return;
  const row = rows[0];
  // 同 SKC 幂等保护（基于值，不再依赖 row 引用）
  if (fstate.product?.skcNumber === extractRowData(row)?.skcNumber) return;
  selectRow(row);
  if (fstate.product) {
    U.showToast(`已自动选中商品 ${fstate.product.skcNumber}`, 'ok');
  }
}
```

注意：`bindRows` 和 `selectRow`（manual click 路径）保持 feature-agnostic（用户主动点 row 是明确意图，不应被守卫拦）。仅 auto-select 在 inactive 时不触发。

## Bug 自然消失对照

| 旧 bug | 旧行为 | 新行为 |
|--------|--------|--------|
| Bug 1：observer 锁旧 tbody | 新 row 不绑 click handler、自动选不触发 | observer attach body，永不失效 |
| Bug 2：selectedRow 指 detached row | tal-selected 残留旧节点、Phase 1 找不到「查看条码」按钮 | findRowBySkc 每次取当前 mounted row；refreshRowHighlight 每次 mutation 同步 |
| Bug 3：跨 feature toast 干扰 | feature view 没切到本 feature 也会弹 toast | maybeAutoSelectOnlyRow 加 active 守卫 |

## 跟原章节的关系

原章节的状态机不变量（N>1→1 转变触发、同行幂等、用户 clear 后不自动选回）**全部保留语义**，只是同行幂等的判断方式从 row 引用比较改为 SKC 比较。

原章节的「边界情况」表中「`selectedRow` 是旧 DOM 节点」这一行变成历史问题，方案 A+ 下不再可能（不存 row 引用）。

## 更新后的测试方案

在原 7 个手动场景之上**新增**：

8. **跨 feature 隔离**：进条码管理页，FAB 显示 Hub（feature view 没切到 auto_gen_label）→ 搜索 SKC → 表格剩 1 行 → **不应弹 toast**、fstate 可设可不设（实施细节决定）
9. **observer 长期稳定性**：进页面 → 等 30 秒（让 Temu 有机会做 background re-render）→ 搜索 SKC → 自动选中 + 视觉高亮仍正常
10. **Phase 1 跑通**：自动选中 + 完整 Phase 1（不再 fail on detached row）

原 7 场景维持不变（场景 1-7）。

## 影响范围

| 文件 | 改动 |
|------|------|
| `features/auto_gen_label/content/index.js` | ~50 行净增（删 `selectedRow` 变量 + 4 个新函数/重写 + 多处调用点改 `findRowBySkc`） |
| 测试方案 | 加 3 个新场景 |

## 提交策略调整

原 spec 写「1 个 commit」。A+ 方案改动多，分 2 个 commit 更易 review：

- 已有 commit `c7b6638`：初版自动选中（保留作历史）
- 新 commit：`refactor(auto_gen_label): selectedRow 改 SKC 间接寻址，observer 改 body 修复 detached row bug`

PR 合入时 squash 成单 commit 进 main，commit message 用 spec 的 Why/What/Test 结构。
