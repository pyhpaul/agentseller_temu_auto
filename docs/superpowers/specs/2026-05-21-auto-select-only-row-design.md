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

---

# 方案 A++ 补丁（2026-05-21 update 2）

## 缘起

A+ 实施后用户 WSL 端验收暴露两个新 bug：

**复现路径（稳定）**：
1. 表格多商品
2. 手动点击商品 A 选中（fstate.product = A）
3. 长按选中商品 B 的 SKC 文本（拖拽 / 双击）→ **必然提示「未能读取该行数据」**
4. 此后搜索任何 SKC（表格变 1 行）→ **无法自动选中**、**手动点击也无效**、**feature view「当前商品」残留旧数据**

## 诊断证据（Console 实测）

在「bug 锁死」状态下：

```
listener count on current row: 3
[0] function tn(){}                          ← Temu 自己的空 listener
[1] (Temu React 包装的 listener)             ← Temu 自己的
[2] (Temu React 包装的 listener)             ← Temu 自己的

→ 我们 content script 的 click handler 完全不在 row 上！

但 row.getAttribute('data-tal-bound') === '1'   ← bindRows 看 attribute 跳过补绑
fstate.product.skcNumber === 82301884773       ← 旧选中残留
extractRowData(currentRow) === { skcNumber: 53735174727 } ← 当前 row SKC 是新的
```

## 根因（两个独立 bug 复合锁死）

### Bug A++.1：`bindRows` attribute idempotency 不可靠

`bindRows` 用 `if (row.getAttribute('data-tal-bound')) return;` 做去重。但 React reconcile 表格时，会出现 **attribute 保留但 listener 丢失**的状态：
- React 复用 / 移动 row 节点：`data-tal-bound` attribute 跟节点一起被保留
- 但 listener 在节点替换/移动过程中被 React 清除（具体机制由 Temu 的 React 实现决定，可能是 React 在 unmount 旧节点时调用了 `removeEventListener`，也可能是节点本身被换成新节点但 attribute 字符串通过 innerHTML 路径复制）

结果：bindRows 看 attribute='1' 跳过补绑 → row 上永远只剩 Temu 自己的 listener → 我们的 click handler 不触发 → 手动点击 row 无反应。

### Bug A++.2：`extractRowData` 在 td 延迟态返回 null + `prevRowCount` 状态机锁死

Temu 搜索过渡态：row 节点已 mount 但 td 文本尚未填好（loading）。此时 mutation 触发：

1. `maybeAutoSelectOnlyRow` 跑 → `extractRowData` 返回 null（td 文本是空）
2. `selectRow` 走 `setStatus('未能读取该行数据', 'err')` 错误分支，`setProduct` 没调用，`fstate.product` 不更新
3. **但 `watchNewRows` callback 末尾无条件 `prevRowCount = rows.length` 设为 1**
4. 之后 mutation（td 填好那次）`maybeAutoSelectOnlyRow` 看 `prevRowCount === 1` 守卫拦截，永不重试
5. 锁死状态：`fstate.product` 留着旧 SKC（A）、row 没视觉高亮、自动选不触发

「长按数据」触发 click event 也会走到 `maybeAutoSelectOnlyRow` 路径（mouseup → click event → DOM mutation → callback），加剧 race。

## A++ 方案：2 处改动

### 1. 改 `bindRows` 为 document 级 event delegation

**删 `bindRows` 函数**和所有 `data-tal-bound` attribute 逻辑。改在 feature init 时给 `document` 绑一个全局 click listener，运行时通过 `e.target.closest()` 定位 row：

```js
function setupRowClickDelegation() {
  if (clickDelegationBound) return;
  clickDelegationBound = true;
  document.addEventListener('click', e => {
    const row = e.target.closest('tr[data-testid="beast-core-table-body-tr"]');
    if (!row) return;
    if (e.target.closest('a, button')) return;
    const data = extractRowData(row);
    if (!data) { setStatus('未能读取该行数据', 'err'); return; }
    if (data.skcNumber === fstate.product?.skcNumber) clearSelection();
    else selectRow(row);
  });
}
```

`clickDelegationBound` 是闭包 boolean，确保只绑一次（content script 重复 init 也只绑 1 个 listener）。

**优势**：
- listener attach 在 `document` 上，永远不会被 React 替换/丢失
- 不需要 attribute idempotency check
- 节省 N 个 row listener → 1 个全局 listener
- React 怎么折腾表格 DOM 都无影响

### 2. `maybeAutoSelectOnlyRow` 内控 `prevRowCount`，失败时不更新

把 `prevRowCount` 更新逻辑从 `watchNewRows` callback 末尾**移到 `maybeAutoSelectOnlyRow` 内部**，由它根据情况决定是否更新：

```js
function maybeAutoSelectOnlyRow(rows) {
  // 守卫 1: feature view 非 auto_gen_label 时不触发，但仍更新 baseline
  const uiState = window.__AgentSellerUI?.getState?.();
  if (uiState?.view !== 'feature' || uiState?.feature !== 'auto_gen_label') {
    prevRowCount = rows.length;
    return;
  }
  // 守卫 2: 非 N>1→1 转变，仅更新 baseline
  if (prevRowCount === 1 || rows.length !== 1) {
    prevRowCount = rows.length;
    return;
  }
  const row = rows[0];
  const newSkc = extractRowData(row)?.skcNumber;
  // td 延迟态：行已挂载但 td 文本未渲染好，**不更新 baseline**，等下次 mutation 重试
  if (!newSkc) return;
  // 守卫 3: 同 SKC 幂等
  if (newSkc === fstate.product?.skcNumber) {
    prevRowCount = rows.length;
    return;
  }
  selectRow(row);
  if (fstate.product) U.showToast(`已自动选中商品 ${fstate.product.skcNumber}`, 'ok');
  prevRowCount = rows.length;
}
```

关键区别：原 A+ 版本无论 `selectRow` 成功失败都更新 `prevRowCount`（更新在 callback 外），新 A++ 在 `extractRowData` 失败时不更新，让下次 mutation 重新评估。

### 3. `watchNewRows` 简化

callback 内删除 `bindRows` 调用 + `prevRowCount = rows.length` 末尾赋值（移到 maybeAutoSelectOnlyRow 内）：

```js
function watchNewRows() {
  if (rowObserver) return;
  rowObserver = new MutationObserver(() => {
    const rows = document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]');
    refreshRowHighlight();
    maybeAutoSelectOnlyRow(rows);
  });
  rowObserver.observe(document.body, { childList: true, subtree: true });
}
```

### 4. `waitForTableThenBind` 简化

不再调 `bindRows`，只调 `setupRowClickDelegation` + `watchNewRows`：

```js
function waitForTableThenBind(timeout = 15000) {
  // event delegation 跟表格存在与否无关，立即绑（幂等）
  setupRowClickDelegation();
  // mutation observer 也立即启动，attach 在 body 永不失效
  watchNewRows();
  // （删去原 setTimeout 轮询逻辑）
}
```

由于 event delegation + body attach 不依赖表格已 mount，可以直接同步启动，不再需要 polling。

## Bug 自然消失对照

| 旧 bug | A+ 现状 | A++ 修复后 |
|--------|--------|----------|
| Bug A++.1：row 上无 listener、手动点无效 | bindRows 看 attr 跳过补绑 | document 全局 listener，永不失效 |
| Bug A++.2：td 延迟态锁死 prevRowCount | 失败仍更新 baseline | 失败不更新，等下次 mutation 重试 |
| 长按选中文本触发 click 误判 | 锁死 + 残留状态 | 全局 delegation 正确识别 + 失败重试 |

## 与原 spec 状态机不变量的关系

A+ spec 的状态机不变量（N>1→1 转变触发、同 SKC 幂等、用户 clear 后不自动选回）**全部保留语义**。区别仅在 `prevRowCount` 更新的时机：
- 原 A+：mutation 末尾无条件更新
- 新 A++：成功 / 已知非触发场景才更新；td 延迟态失败时跳过更新等待重试

## 新增测试场景

加 **场景 11**「长按选中文本不触发误选中」：

操作：表格多行 → 手动选中行 A → 长按 / 拖拽选中行 B 的 SKC 文本（用于复制）→ 不该弹「未能读取该行数据」。

加 **场景 12**「td 延迟态自动重试」：

操作：表格多行 → 搜索 → 表格立即变 1 行但 td 内容延迟 200ms 才填好（如果能复现）→ 自动选中应在 td 填好那次 mutation 触发。

## 影响范围

| 文件 | 改动 |
|------|------|
| `features/auto_gen_label/content/index.js` | -10/+15 行：删 bindRows、改 maybeAutoSelectOnlyRow / watchNewRows / waitForTableThenBind、新增 setupRowClickDelegation |

## 提交策略

继续在 `feat/auto-select-only-row` 分支累加 commit。新 commit:
`fix(auto_gen_label): event delegation + 失败不更新 prevRowCount 修 React 复用 listener 丢失 + td 延迟态锁死`

PR 最终合入时 squash 三个 commit (`c7b6638` 初版 + A+ refactor + A++ 补丁)。

---

# 决策：撤回「自动选中」功能（2026-05-21 update 3）

## 决策摘要

A++ 实施后用户验收仍然复现「长按选 SKC 后无法选中」bug，多轮调试证明：
**自动选中**这一层引入的复杂度（race condition、prevRowCount 状态机锁死、跨 feature 守卫等）显著大于它带来的便利。用户提议直接撤回这个功能，专注修复**原始 bug**（手动点击商品行有时无法选中）。

接受用户的 pivot。**自动选中相关代码全部删除，但调试过程中发现的核心 bug 修复（event delegation + SKC 间接寻址 + refreshRowHighlight）全部保留**——这些是「手动点击无法选中」原始 bug 的真正治本方案。

## 保留 vs 撤回

| 改动 | 状态 | 理由 |
|------|------|------|
| 删 `selectedRow` 模块变量 + 新增 `findRowBySkc` | ✅ 保留 | A+ 的核心修复：避免 detached row 引用让 `clickAndCaptureCanvas` 找不到「查看条码」按钮 |
| 重写 `selectRow` / `clearSelection`（不存 row 引用） | ✅ 保留 | 同上 |
| 新增 `refreshRowHighlight`（mutation + setProduct 同步） | ✅ 保留 | React 重渲后视觉跟随 `fstate.product` 自动恢复 |
| `watchNewRows` observer attach `document.body` | ✅ 保留 | 修「observer 锁旧 tbody 节点失效」根本 bug |
| `setupRowClickDelegation`（document 级 click delegation） | ✅ 保留 | **修「手动点击无法选中」的核心** — React 替换 row 让 row-level listener 丢失 |
| click handler 同行幂等改 SKC 比较 | ✅ 保留 | 不依赖 row 引用 |
| `waitForTableThenBind` 简化 | ✅ 保留 | event delegation + body observer 不依赖表格已 mount |
| `maybeAutoSelectOnlyRow` 函数 | ❌ 撤回 | 自动选中入口 |
| `prevRowCount` 闭包变量 | ❌ 撤回 | 仅自动选状态机用 |
| toast「已自动选中商品 SKC」 | ❌ 撤回 | 自动选 UI |
| active feature 守卫（仅 maybeAuto... 内用） | ❌ 撤回 | 跟随 maybeAuto... 删 |
| `watchNewRows` callback 内 `maybeAutoSelectOnlyRow` 调用 | ❌ 撤回 | 跟随删 |

## 撤回后的最终行为

- 用户**手动点击商品行**任何时候都能成功选中（document-level delegation 永不失效，extractRowData 失败时给 setStatus 错误提示但仍能重试）
- React 重渲表格不影响选中状态（`refreshRowHighlight` 在每次 mutation 同步 `.tal-selected`、`findRowBySkc` 让 `clickAndCaptureCanvas` 取当前 mounted row）
- 不再有「自动选中」隐性行为；不再弹「已自动选中商品」toast
- 跨 feature 隔离不再是问题（没有自动选中入口就没有跨 feature 触发）

## 测试方案简化

12 场景验收方案撤回。新验收清单：

1. **手动选中核心** — 进条码管理页 → 任意选一行 → 行高亮 + feature view 显示 SKC（多次切换不同行验证视觉跟随）
2. **手动取消** — 点已选中行（非链接区域） → 行高亮消失 + feature view 恢复 placeholder
3. **React 重渲弹性** — 选中行 A → 搜索过滤后表格刷新 → 如果行 A 还在表格中，视觉自动跟随（`.tal-selected` 在新节点上）
4. **Phase 1 实跑** — 选中商品 → 设置模板/输出 → 开始执行 → 完整跑通（验证 `clickAndCaptureCanvas` 用 `findRowBySkc` 取的 row 能正常拿到「查看条码」按钮）
5. **长按选 SKC 文本** — 多行 → 选中 A → 长按拖拽选行 B 的 SKC 文本（用于复制） → **不应误触发任何 selectRow / setStatus 错误**（之前 bug 的原始复现路径）
6. **回归 — Phase 2/3 全流程** — 标签生成后 Phase 2 合规填写 + Phase 3 主图插入跟现状一致

## 提交策略

继续在 `feat/auto-select-only-row` 分支累加 commit。新 commit:
`refactor(auto_gen_label): 撤回自动选中，保留手动点击稳定性核心修复`

PR squash 最终合入 main 时（约 4 个 commit），最终生效改动是 A+/A++ 中**只保留治 bug 部分**，自动选中部分被本 commit 撤回。PR 标题相应调整：
`fix(auto_gen_label): 修手动点击无法选中商品（event delegation + SKC 间接寻址 + 视觉同步）`

## 分支命名

`feat/auto-select-only-row` 名字已不准确（pivot 后不再有 auto-select 特性）。但分支内已多个 commit 推到 origin，重命名风险大于收益（PR URL 会变），**保留现有分支名**，在 PR 标题/描述里明确实际功能即可。

---

# Virtual Scroll 适配（2026-05-21 update 4）

## 缘起

Pivot 后验收依然复现「未能读取该行数据」：用户描述「**页面刚打开时只有前两个商品可视，前两个怎么选都没问题，第三个之后就报错**」。

这是 Pivot 之前所有调试都没考虑到的根因：**Temu 表格用 virtual scroll / lazy rendering**。

可视区内 row：td 文本立即渲染。
可视区外 row：tr 节点存在于 DOM、testid attribute 存在，但 **td 文本是空的**（占位），等用户滚动到才填好。

`extractRowData(row)` 读 td.textContent → 空字符串 → 返回 null → `selectRow` 走错误分支 `setStatus('未能读取该行数据', 'err')`。

## 修复方案：retry + race protection（不涉及主动滚动）

`selectRow` 改为异步轮询：

```js
let pendingSelectRow = null;       // 模块级闭包变量

function selectRow(row) {
  pendingSelectRow = row;          // 标记当前期待的 row
  const tryExtract = (attemptsLeft) => {
    if (pendingSelectRow !== row) return;       // race 保护：用户已 click 别的 row
    const product = extractRowData(row);
    if (product) {
      pendingSelectRow = null;
      setProduct(product);
      refreshRowHighlight();
      return;
    }
    if (attemptsLeft > 0) {
      setTimeout(() => tryExtract(attemptsLeft - 1), 200);
    } else if (pendingSelectRow === row) {
      pendingSelectRow = null;
      setStatus('未能读取该行数据', 'err');
    }
  };
  tryExtract(5);                   // 5 次 × 200ms = 最多 1 秒等 virtual scroll 填好
}
```

`clearSelection` 内同步清 `pendingSelectRow = null`，避免延迟回写已被取消的选中。

## 行为对照

| 场景 | 旧行为 | 新行为 |
|------|--------|--------|
| 点击可视区内 row（td 有文本） | 同步 selectRow 成功 | 第 1 次 extract 命中，立即 setProduct（**无新增延迟**） |
| 点击可视区外 row（td 占位空文本） | 立即 setStatus error | 200ms 后第 2 次尝试，1s 内大概率拿到数据 |
| 快速切换 row：先点 A 再点 B | A 的 selectRow 抛 error / B 覆盖 | A 的 retry 看 pendingSelectRow !== A 自动放弃，B 接管 |
| 点击 row 后立即点已选行取消 | clearSelection 不影响在跑的 retry | clearSelection 内清 pendingSelectRow，retry 自动放弃 |
| 1 秒后 virtual scroll 仍未填（边界情况） | 同左 | setStatus error，用户重点击 / 滚动到 row 后重点击 |

## 不采用 scrollIntoView 的考量

可选 fallback「点击时主动 `row.scrollIntoView()` 触发 Temu 加载」被用户拒绝：会扰乱用户当前滚动位置。retry 方案对绝大多数场景已足够，1 秒超时后报错给用户主动 fallback 也比强行滚动友好。

## 测试场景调整

简化测试方案的「场景 5 长按选 SKC 文本」改为：

5. **virtual scroll 边界**：进条码管理页 → 滚动表格让多个 row 进入/离开可视区 → 选中不同位置的 row（含初始可视外的）→ 都应能成功选中（可能有 ≤1 秒延迟，期间 feature view 暂不更新，无 toast、无视觉抖动）

## 影响

| 文件 | 改动 |
|------|------|
| `features/auto_gen_label/content/index.js` | +18 行（新增 `pendingSelectRow` 变量 + 重写 `selectRow` + `clearSelection` 内清理） |

## 提交策略

继续在 `feat/auto-select-only-row` 累加 commit:
`fix(auto_gen_label): selectRow 加 retry 适配 virtual scroll td 延迟态`
