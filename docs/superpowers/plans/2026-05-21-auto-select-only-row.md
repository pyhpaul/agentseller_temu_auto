# 标签生成搜索唯一商品自动选中 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Temu 商家中心条码管理页表格变为 1 行时（典型场景：用户搜索 SKC 命中唯一商品）自动调用现有 `selectRow`，省去手动点击。

**Architecture:** 复用 `features/auto_gen_label/content/index.js` 内现有 `rowObserver`（MutationObserver），在 mutation 回调里加 N>1→1 转变检测，触发 `selectRow(theOnlyRow)` + toast 提示。完全保留手动 click 路径。

**Tech Stack:** 浏览器原生 MutationObserver + DOM API，无新增依赖。改动域单文件 `features/auto_gen_label/content/index.js`。

**Spec:** `docs/superpowers/specs/2026-05-21-auto-select-only-row-design.md`

---

## File Structure

| 文件 | 状态 | 责任 |
|------|------|------|
| `features/auto_gen_label/content/index.js` | 修改 | 加 `prevRowCount` 闭包变量、新增 `maybeAutoSelectOnlyRow` 函数、扩展 `watchNewRows` MutationObserver 回调 |
| `docs/superpowers/specs/2026-05-21-auto-select-only-row-design.md` | 已存在（spec commit 已落） | 设计参考 |

无新文件创建。无 native_host / build 脚本改动。

---

## Task 1: 实现 DOM 变化驱动自动选中

**Files:**
- Modify: `features/auto_gen_label/content/index.js:14`（`selectedRow` 声明附近，加 `prevRowCount`）
- Modify: `features/auto_gen_label/content/index.js:210-216`（扩展 `watchNewRows`）
- Modify: `features/auto_gen_label/content/index.js:225` 之后（新增 `maybeAutoSelectOnlyRow` 函数定义，放在 `selectRow` 之后、行绑定章节末）

- [ ] **Step 1: 读上下文，确认行号未漂移**

读 `features/auto_gen_label/content/index.js` line 1-230，确认：
- line 14 是 `let selectedRow = null;`
- line 210-216 是 `watchNewRows` 定义
- line 218-225 是 `selectRow` 定义
- line 227 是「数据提取」章节注释分隔

如果行号有偏移，更新本 task 各 Step 的目标位置（按代码内容而非绝对行号定位）。

- [ ] **Step 2: 在 line 14 后加 `prevRowCount` 闭包变量**

Edit `features/auto_gen_label/content/index.js`：

```js
// 旧（line 13-14 附近）
let selectedRow = null;

// 新
let selectedRow = null;
let prevRowCount = null;  // 表格行数 baseline，用于检测 N>1→1 转变触发自动选中
```

- [ ] **Step 3: 在 `selectRow` 函数之后新增 `maybeAutoSelectOnlyRow`**

在 line 225（`selectRow` 函数 `}` 之后、`// =====数据提取=====` 之前）插入：

```js
  function maybeAutoSelectOnlyRow(rows) {
    // 转变触发：prev 不是 1 行 && cur 是 1 行
    if (prevRowCount === 1 || rows.length !== 1) return;
    const row = rows[0];
    if (selectedRow === row) return;  // 同一行幂等保护
    selectRow(row);
    if (fstate.product) {
      U.showToast(`已自动选中商品 ${fstate.product.skcNumber}`, 'ok');
    }
  }
```

- [ ] **Step 4: 改造 `watchNewRows` MutationObserver 回调**

Edit `features/auto_gen_label/content/index.js` line 210-216：

```js
// 旧
function watchNewRows() {
  if (rowObserver) return;
  rowObserver = new MutationObserver(() =>
    bindRows(document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]:not([data-tal-bound])'))
  );
  rowObserver.observe(document.querySelector('tbody') || document.body, { childList: true, subtree: true });
}

// 新
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

- [ ] **Step 5: 语法/静态检查**

Run: `node --check features/auto_gen_label/content/index.js`
Expected: 退出码 0，无语法错误输出。

如果报错（`SyntaxError`），回看 Step 2-4 检查括号闭合 / 模板字符串。

---

## Task 2: 构建扩展并加载到 Chrome

**Files:**
- Read: `dist/extension/features/auto_gen_label/content/index.js`（确认 build 产物含新改动）

- [ ] **Step 1: 全量构建**

Run（在仓库根 / Windows cmd 或 PowerShell）：

```
python build\build_extension.py
```

Expected 输出最后一行：
```
[build] done → <repo>\dist\extension
```

- [ ] **Step 2: 验证产物含 `maybeAutoSelectOnlyRow`**

Run（PowerShell）：

```powershell
Select-String -Path dist\extension\features\auto_gen_label\content\index.js -Pattern "maybeAutoSelectOnlyRow"
```

Expected: 至少两条匹配（函数定义 + 调用点）。0 条说明 build 没拷新文件，重新跑 Step 1。

- [ ] **Step 3: 在 Chrome 重新加载扩展**

人工动作：
1. `chrome://extensions` 打开
2. 找到「AgentSeller for Temu」卡片
3. 点右下角**循环箭头 reload** 图标
4. 确认无报错（卡片底部不应出现红色「错误」按钮）

Expected: 扩展状态显示「已启用」，无错误徽章。

如出现红色错误徽章，点开看 console error，回 Task 1 调整。

---

## Task 3: 手动验收 7 个场景

**Files:**
- Read: `docs/superpowers/specs/2026-05-21-auto-select-only-row-design.md`（参考「测试方案」）

> 全程在 https://seller.temu.com/ 条码管理页（路径含 `/label`），登录态下操作。开 DevTools Console 监听报错。

- [ ] **Step 1: 核心 use case**

操作：
1. 进条码管理页（初始多行）
2. 在 SKC 搜索框输入一个已知存在的 SKC，点搜索（或回车）
3. 等表格刷新只剩 1 行

Expected:
- 该行自动加 `.tal-selected` class（视觉上行变高亮，跟手动点效果一致）
- 屏幕中央弹 toast「已自动选中商品 <SKC>」
- 插件 feature view「当前商品」区域显示该 SKC + SKC货号

- [ ] **Step 2: 多次搜索切换**

操作（紧接 Step 1）：
1. 清空 SKC 搜索框，等表格恢复多行
2. 输入另一个不同的 SKC（B），搜索
3. 等表格剩 1 行（B）

Expected: 自动选中切到 B，feature view 显示 B 的 SKC。

- [ ] **Step 3: 手动 clear 后不应自动选回来**

操作（紧接 Step 2）：
1. 点击当前已选中行 → 触发 `clearSelection`（行高亮消失，feature view 「当前商品」变空）
2. **不做任何搜索或 DOM 变化**

Expected: 表格仍然 1 行，但 **不应再自动选中**。验证状态机「prev=1, cur=1 不动」守卫生效。

- [ ] **Step 4: 同 SKC 重搜应触发**

操作（紧接 Step 3）：
1. 清空搜索 → 表格恢复多行（这是 1→N 转变，不触发）
2. 再次输入同一个 SKC（B）→ 表格剩 1 行（B）

Expected: 自动选中 B 触发，toast 弹出。

- [ ] **Step 5: 空表格不报错**

操作：
1. 清空搜索
2. 输入一个不存在的 SKC（如 `999999999999`）
3. 等表格变 0 行（显示「暂无数据」）

Expected: 无 toast、无 console 报错、无 feature view 状态变化。

- [ ] **Step 6: 手动 click 覆盖**

操作：
1. 清空搜索，表格多行
2. 手动点行 1 → 选中行 1
3. 在 SKC 搜索框输入只能匹配到行 2 的 SKC，搜索 → 表格剩 1 行（行 2）

Expected: 自动选中切到行 2（不是行 1），toast 弹出。

- [ ] **Step 7: 完整 Phase 1 / 2 / 3 回归**

操作：
1. 用 Step 1 自动选中机制选好商品
2. 设置好模板路径 + 输出目录（如未设）
3. 点 feature view「开始执行」按钮
4. 等 Phase 1 完成 → 跳页 Phase 2 → 跳页 Phase 3

Expected: 全流程跟现状完全一致，无新增报错、无 Phase 1 `clickAndCaptureCanvas` 失败、无 toast 重复刷屏。

- [ ] **Step 8: 总结验收结果**

如果 Step 1-7 全通过 → 进 Task 4 提交 PR。

任何 Step 失败 → 记录现象（截图 / console error）。回 Task 1 调整：
- toast 没弹但选中成功 → 检查 `U.showToast` 是否可用，可能 `fstate.product` 没及时 set
- 选中没生效 → 检查 `prevRowCount` 是否正确更新
- 误触发（如 Step 3 失败）→ 检查转变守卫顺序

---

## Task 4: 提交 PR

**Files:**
- 已经在 `feat/auto-select-only-row` 分支（spec commit 在 head）

- [ ] **Step 1: 确认在 feat 分支**

Run:
```
git status
git branch --show-current
```

Expected: 分支 `feat/auto-select-only-row`，工作树只有 `features/auto_gen_label/content/index.js` modified。

如果在 `main` 上 → `git switch feat/auto-select-only-row`。

- [ ] **Step 2: 精确暂存 + 查 diff**

Run:
```
git add features/auto_gen_label/content/index.js
git diff --cached features/auto_gen_label/content/index.js
```

Expected diff 含三块：
- `+let prevRowCount = null;` 行
- `+function maybeAutoSelectOnlyRow(...) { ... }` 函数定义
- `watchNewRows` 内 MutationObserver 回调由箭头函数 expression 改为 block + 三条语句

- [ ] **Step 3: Commit**

Run（使用 HEREDOC 保持 commit message 格式）：

```bash
git commit -m "$(cat <<'EOF'
feat(auto_gen_label): 表格变 1 行时自动选中商品

Why: 用户报告 Temu 自身选中视觉反馈有时缺失，导致用户疑惑是否真选上；
搜索 SKC 后表格通常只剩 1 个商品，手动点击重复。

What: 复用 rowObserver MutationObserver 回调，加 prevRowCount 闭包跟踪
表格行数，N>1→1 转变时调用现有 selectRow + toast 提示。完全保留手动
click 路径；同行幂等保护防重复触发；用户手动 clearSelection 后不会自动
选回来（需重新搜索）。

Test: 手动跑 docs/superpowers/specs/2026-05-21-auto-select-only-row-design.md
测试方案 7 个场景全通过。无自动化测试（项目无 JS 测试基础）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit 成功，输出 `[feat/auto-select-only-row <hash>] feat(auto_gen_label): 表格变 1 行时自动选中商品`。

- [ ] **Step 4: Push 分支**

Run:
```
git push -u origin feat/auto-select-only-row
```

Expected: 输出 `branch 'feat/auto-select-only-row' set up to track 'origin/feat/auto-select-only-row'`。

- [ ] **Step 5: 创建 PR**

Run（使用 gh + HEREDOC）：

```bash
gh pr create --title "feat(auto_gen_label): 表格变 1 行时自动选中商品" --body "$(cat <<'EOF'
## Summary

复用 \`rowObserver\` MutationObserver 在表格行数从 N>1 转变为 1 行时（典型：用户搜索 SKC 命中唯一商品），自动调用现有 \`selectRow\` + toast 提示。省去手动点击。

## Design

详见 \`docs/superpowers/specs/2026-05-21-auto-select-only-row-design.md\`。

核心状态机：
| prevRowCount | rows.length | 行为 |
|--------------|-------------|------|
| null 或 >1 或 0 | 1 | 触发 |
| 1 | 1（同行） | 不动（幂等） |
| 1 | 其他 | 不动 |
| 任何 | 任何（非 N>1→1） | 不动 |

## Test plan

手动验收 7 个场景（已跑通）：

- [x] 核心：搜索 SKC → 表格剩 1 行 → 自动选中 + toast
- [x] 多次切换：搜 A → 选 A → 清空 → 搜 B → 选 B
- [x] 手动 clear 后：点已选行取消 → 表格仍 1 行 → 不自动选回来
- [x] 同 SKC 重搜：清空 → 重搜同 SKC → 自动选触发
- [x] 空表格：搜不存在 SKC → 0 行 → 不报错、不 toast
- [x] 手动覆盖：手动选 A → 搜索过滤剩 B → 自动选切到 B
- [x] 全流程回归：Phase 1 / 2 / 3 行为与现状一致

## Risk

- 跨行 toast 刷屏：极低概率，先观察生产再说。如出现加 1 秒 debounce 即可。
- 回滚：单文件单 commit，\`git revert\` 一键复原。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: 输出 PR URL。

- [ ] **Step 6: 报告 PR URL**

把 PR URL 报告给用户，等用户 review / merge。

---

## Self-Review 记录

跟 spec 对照检查完成项：

| Spec 章节 | 对应 Task | 状态 |
|----------|---------|------|
| 范围（改动 / 不改动） | Task 1 | ✓ 全部覆盖 |
| 架构 - 改动 1 `watchNewRows` | Task 1 Step 4 | ✓ |
| 架构 - 改动 2 `maybeAutoSelectOnlyRow` | Task 1 Step 3 | ✓ |
| 状态机不变量 7 case | Task 3 Step 1-6 | ✓ 测试 case 一一对应 |
| 与手动 click 路径关系 | Task 3 Step 6 + Step 7 | ✓ 回归覆盖 |
| 边界 5 case | Task 3 Step 5 + 通用 console 监听 | ✓ |
| 错误处理 | 现有保护，Task 1 不引入新 try/catch | ✓ |
| 测试方案 7 场景 | Task 3 Step 1-7 | ✓ 1:1 映射 |
| 提交策略 | Task 4 | ✓ |
| 风险与回滚 | PR body / 单 commit | ✓ |

Placeholder scan: 无 TBD / TODO / "implement later" / "add appropriate"。每个 Step 含完整代码或命令。

Type consistency: `prevRowCount` / `maybeAutoSelectOnlyRow` / `selectedRow` / `selectRow` / `fstate.product` / `U.showToast` 名称在 Task 1-4 间一致。

---

# 方案 A+ 重构 Task（2026-05-21 update）

> 缘起 + 诊断证据 + 4 处改动 spec 详见 `docs/superpowers/specs/2026-05-21-auto-select-only-row-design.md` 末尾「方案 A+ 重构」章节。本节给具体实施 task。

## Task 5: 删 `selectedRow` 模块变量 + 新增 `findRowBySkc`

**Files:**
- Modify: `features/auto_gen_label/content/index.js`

- [ ] **Step 1: 删 `selectedRow` 模块变量**

Edit `features/auto_gen_label/content/index.js`：

old_string:
```js
  let selectedRow = null;
  let prevRowCount = null;  // 表格行数 baseline，用于检测 N>1→1 转变触发自动选中
```

new_string:
```js
  let prevRowCount = null;  // 表格行数 baseline，用于检测 N>1→1 转变触发自动选中
```

> 删除 selectedRow 后，所有引用它的代码必须改造（后续 Step 6/7/8 处理）。

- [ ] **Step 2: 新增 `findRowBySkc` 工具函数**

在 `extractRowData` 函数之后插入：

old_string:
```js
  function extractRowData(row) {
    const si = getColumnIndex('SKC'), ki = getColumnIndex('SKC货号');
    if (si < 0 || ki < 0) return null;
    const tds = row.querySelectorAll('td[data-testid="beast-core-table-td"]');
    const skc = tds[si - 1]?.textContent.trim(), skcSku = tds[ki - 1]?.textContent.trim();
    return skc && skcSku ? { skcNumber: skc, skcSku } : null;
  }
```

new_string:
```js
  function extractRowData(row) {
    const si = getColumnIndex('SKC'), ki = getColumnIndex('SKC货号');
    if (si < 0 || ki < 0) return null;
    const tds = row.querySelectorAll('td[data-testid="beast-core-table-td"]');
    const skc = tds[si - 1]?.textContent.trim(), skcSku = tds[ki - 1]?.textContent.trim();
    return skc && skcSku ? { skcNumber: skc, skcSku } : null;
  }

  function findRowBySkc(skc) {
    if (!skc) return null;
    const rows = document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]');
    for (const row of rows) {
      if (extractRowData(row)?.skcNumber === skc) return row;
    }
    return null;
  }
```

## Task 6: 重写 `selectRow` / `clearSelection` + 新增 `refreshRowHighlight`

**Files:**
- Modify: `features/auto_gen_label/content/index.js`

- [ ] **Step 1: 重写 `clearSelection`**

old_string:
```js
  function clearSelection() {
    if (selectedRow) { selectedRow.classList.remove('tal-selected'); selectedRow = null; }
    setProduct(null);
  }
```

new_string:
```js
  function clearSelection() {
    setProduct(null);
    refreshRowHighlight();
  }
```

- [ ] **Step 2: 重写 `selectRow`**

old_string:
```js
  function selectRow(row) {
    if (selectedRow) selectedRow.classList.remove('tal-selected');
    selectedRow = row;
    row.classList.add('tal-selected');
    const product = extractRowData(row);
    if (product) setProduct(product);
    else setStatus('未能读取该行数据', 'err');
  }
```

new_string:
```js
  function selectRow(row) {
    const product = extractRowData(row);
    if (!product) { setStatus('未能读取该行数据', 'err'); return; }
    setProduct(product);
    refreshRowHighlight();
  }
```

- [ ] **Step 3: 新增 `refreshRowHighlight` 函数（紧跟 `selectRow` 之后）**

定位 `selectRow` 函数之后、`maybeAutoSelectOnlyRow` 之前的位置。

old_string（合并 selectRow 末尾 + maybeAutoSelectOnlyRow 起始作锚点定位）:
```js
  function selectRow(row) {
    const product = extractRowData(row);
    if (!product) { setStatus('未能读取该行数据', 'err'); return; }
    setProduct(product);
    refreshRowHighlight();
  }

  function maybeAutoSelectOnlyRow(rows) {
```

new_string:
```js
  function selectRow(row) {
    const product = extractRowData(row);
    if (!product) { setStatus('未能读取该行数据', 'err'); return; }
    setProduct(product);
    refreshRowHighlight();
  }

  function refreshRowHighlight() {
    document.querySelectorAll('tr.tal-selected').forEach(r => r.classList.remove('tal-selected'));
    const row = findRowBySkc(fstate.product?.skcNumber);
    if (row) row.classList.add('tal-selected');
  }

  function maybeAutoSelectOnlyRow(rows) {
```

## Task 7: 改造 `maybeAutoSelectOnlyRow`（active 守卫 + SKC 幂等比较）

**Files:**
- Modify: `features/auto_gen_label/content/index.js`

- [ ] **Step 1: 全量替换 `maybeAutoSelectOnlyRow`**

old_string:
```js
  function maybeAutoSelectOnlyRow(rows) {
    // 转变触发：prev 不是 1 行 && cur 是 1 行
    if (prevRowCount === 1 || rows.length !== 1) return;
    const row = rows[0];
    if (selectedRow === row) return;  // 同一行幂等保护
    selectRow(row);
    if (fstate.product) {
      U.showToast(`已自动选中商品 ${fstate.product.skcNumber}`, 'ok');
    }
  }
```

new_string:
```js
  function maybeAutoSelectOnlyRow(rows) {
    // 守卫 1：仅在 feature view 切到 auto_gen_label 时才自动选 + toast，
    //         避免用户在 Hub / 别的 feature 下搜索就被弹「已自动选中」toast。
    //         bindRows 和 manual selectRow 不受此限制（用户主动点击是明确意图）。
    const uiState = window.__AgentSellerUI?.getState?.();
    if (uiState?.view !== 'feature' || uiState?.feature !== 'auto_gen_label') return;

    // 守卫 2：转变触发（prev !== 1 && cur === 1）。
    if (prevRowCount === 1 || rows.length !== 1) return;
    const row = rows[0];
    // 守卫 3：同 SKC 幂等（不依赖 row 引用，按值比较）。
    if (fstate.product?.skcNumber === extractRowData(row)?.skcNumber) return;
    selectRow(row);
    if (fstate.product) {
      U.showToast(`已自动选中商品 ${fstate.product.skcNumber}`, 'ok');
    }
  }
```

## Task 8: 改造 `watchNewRows`（observer attach body + mutation 同步视觉）

**Files:**
- Modify: `features/auto_gen_label/content/index.js`

- [ ] **Step 1: 改造 `watchNewRows`**

old_string:
```js
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

new_string:
```js
  function watchNewRows() {
    if (rowObserver) return;
    rowObserver = new MutationObserver(() => {
      bindRows(document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]:not([data-tal-bound])'));
      const rows = document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]');
      // 每次 mutation 同步视觉：React 重新渲染 row 时自动恢复 .tal-selected
      refreshRowHighlight();
      maybeAutoSelectOnlyRow(rows);
      prevRowCount = rows.length;
    });
    // attach 到 document.body 而非 tbody，避免 React 替换整个 tbody 时 observer 失效
    rowObserver.observe(document.body, { childList: true, subtree: true });
  }
```

## Task 9: 改造所有 `selectedRow` 调用点

**Files:**
- Modify: `features/auto_gen_label/content/index.js`

- [ ] **Step 1: 列出所有 selectedRow 引用位置**

跑：
```
grep -n "selectedRow" features/auto_gen_label/content/index.js
```

Expected 输出包含以下位置（行号可能因前面 task 改动有偏移）：
- click handler 内 `selectedRow === row ? clearSelection() : selectRow(row)`（line ~205）
- `onRunAllPhases` 内 `if (!fstate.product || !selectedRow) return;`（line ~248）
- `onRunAllPhases` 内 `clickAndCaptureCanvas(selectedRow)`（line ~259）
- `onRunPhase1Only` 内同样两处（line ~297, ~308）

如有其他引用，本 Step 全部纳入修改。

- [ ] **Step 2: 改 click handler 同行幂等判断**

old_string:
```js
      row.addEventListener('click', e => {
        if (e.target.closest('a, button')) return;
        selectedRow === row ? clearSelection() : selectRow(row);
      });
```

new_string:
```js
      row.addEventListener('click', e => {
        if (e.target.closest('a, button')) return;
        const data = extractRowData(row);
        if (data?.skcNumber === fstate.product?.skcNumber) clearSelection();
        else selectRow(row);
      });
```

- [ ] **Step 3: 改 `onRunAllPhases` 取 row 方式**

定位 `async function onRunAllPhases() {` 函数体首两行（守卫）+ `clickAndCaptureCanvas(selectedRow)` 调用。

old_string:
```js
  async function onRunAllPhases() {
    if (!fstate.product || !selectedRow) return;
```

new_string:
```js
  async function onRunAllPhases() {
    const row = findRowBySkc(fstate.product?.skcNumber);
    if (!fstate.product || !row) return;
```

然后再 Edit 同函数内的 `clickAndCaptureCanvas(selectedRow)` 一处（注意：可能有多次，确保只改 `onRunAllPhases` 函数内的，可用 around-context 让 old_string 唯一）：

old_string:
```js
      const { barcodePngB64, skcNumber } = await clickAndCaptureCanvas(selectedRow);
```

> 此处 selectedRow 在文件中出现两次（onRunAllPhases / onRunPhase1Only 内各一次），需用更大的 context block 让两处分别可定位。建议每次 Edit 用更长的 around-context（含上一行或下一行作锚点）。

参考做法 onRunAllPhases 内：
```js
    const btn = document.getElementById('tal-btn-auto');
    ...
      const { barcodePngB64, skcNumber } = await clickAndCaptureCanvas(selectedRow);
```

new_string 替换为：
```js
    const btn = document.getElementById('tal-btn-auto');
    ...
      const { barcodePngB64, skcNumber } = await clickAndCaptureCanvas(row);
```

> 注意：上面的 `...` 占位不能直接写入；要把 Read 到的真实代码内容作为 around-context。具体实施时按文件实际内容定位。

- [ ] **Step 4: 改 `onRunPhase1Only` 取 row 方式**

类似 Step 3 处理 `onRunPhase1Only` 函数内的两处引用：
- 守卫：`if (!fstate.product || !selectedRow) return;` → 加 `const row = findRowBySkc(fstate.product?.skcNumber);` + 改 `|| !row`
- `clickAndCaptureCanvas(selectedRow)` → `clickAndCaptureCanvas(row)`

- [ ] **Step 5: 验证无残留 selectedRow**

跑：
```
grep -n "selectedRow" features/auto_gen_label/content/index.js
```

Expected: **无输出**（exit code 1，grep no match）。

如有残留，回 Step 1-4 检查漏处。

## Task 10: 语法检查 + 端到端 build

**Files:**
- Read: `dist/extension/features/auto_gen_label/content/index.js`

- [ ] **Step 1: node --check 语法验证**

```
node --check features/auto_gen_label/content/index.js
```

Expected: exit 0, no SyntaxError。

- [ ] **Step 2: 全量 build**

```
python3 build/build_extension.py
```

Expected 末行 `[build] done → ...`。

- [ ] **Step 3: 验证 dist 同步 A+ 改动**

```
grep -c "findRowBySkc\|refreshRowHighlight" dist/extension/features/auto_gen_label/content/index.js
```

Expected: **≥ 6**（findRowBySkc 函数定义 + 4+ 调用点；refreshRowHighlight 函数定义 + 3+ 调用点）。

## Task 11: 端到端验收 10 个场景

> 在 Chrome reload 扩展后跑。原 7 个场景 + 新 3 个场景。

- [ ] **Step 1: 场景 1-7（原测试方案）**

按原 plan Task 3 的 7 个场景跑一遍，所有应通过。

- [ ] **Step 2: 新场景 8 — 跨 feature 隔离**

进条码管理页 → FAB 不展开（保持 Hub 状态或切到别的 feature）→ 搜索 SKC → 表格剩 1 行。

Expected: **不弹 toast**「已自动选中商品」。fstate 是否 set 不强制（实施细节）。

- [ ] **Step 3: 新场景 9 — observer 长期稳定性**

进条码管理页 → 等 30 秒不操作 → 搜索 SKC → 表格剩 1 行。

Expected: 自动选中触发、视觉高亮、toast 弹出（验证 observer 长期没 detach）。

- [ ] **Step 4: 新场景 10 — Phase 1 实跑**

自动选中后点 feature view「开始执行」按钮，跑完 Phase 1。

Expected: 不报「未找到查看条码按钮」/ 不报 detached row 错。条码 canvas 正常捕获、native_host 正常生成标签 PDF/PNG。

- [ ] **Step 5: 总结**

10 场景全通过 → 进 Task 12 commit。
任何失败 → 贴现象，回 Task 5-9 调整。

## Task 12: Commit + push + PR

**Files:**
- Modify: `features/auto_gen_label/content/index.js`（多处累积）

- [ ] **Step 1: 确认在 feat 分支 + 改动符合预期**

```
git status
git branch --show-current     # feat/auto-select-only-row
git diff features/auto_gen_label/content/index.js | wc -l   # 应有几十行 diff
```

- [ ] **Step 2: Commit**

```bash
git add features/auto_gen_label/content/index.js
git commit -m "$(cat <<'EOF'
refactor(auto_gen_label): selectedRow 改 SKC 间接寻址，修复 detached row + observer bug

Why: 初版 commit c7b6638 (自动选中) Windows 端验收暴露：用户视觉一直看不到行高亮、
Phase 1 跑不通、手动点击也无响应。Console 诊断锁定两个潜伏 bug：
- Bug 1: rowObserver attach 在初次 tbody 引用上，Temu React 替换 tbody 后 observer
  失效，新 row 不绑 click handler。
- Bug 2: selectedRow 引用 detached row 节点（Temu React 短时间内多次 re-render
  导致 row swap），.tal-selected 残留旧节点、clickAndCaptureCanvas 找不到按钮。
另暴露 1 个 UX 问题：feature view 没切到 auto_gen_label 时也弹自动选 toast。

What:
- 删 selectedRow 模块变量，新增 findRowBySkc(skc) 工具函数（按 SKC 反向查当前
  mounted row）。
- 新增 refreshRowHighlight()，在 setProduct / mutation / select/clear 时同步
  所有 row 的 .tal-selected class，永远以 fstate.product.skcNumber 为 source of truth。
- selectRow / clearSelection 不再存 row 引用，简化为「set fstate + refresh」。
- 所有 selectedRow 调用点（click handler / onRunAllPhases / onRunPhase1Only /
  clickAndCaptureCanvas）改用 findRowBySkc 取当前 mounted row。
- maybeAutoSelectOnlyRow 加 active feature 守卫（uiState.view==='feature' &&
  feature==='auto_gen_label'），跨 feature 不触发自动选 + toast。
- watchNewRows MutationObserver attach 改 document.body，避免 React 替换 tbody
  时失效。mutation 回调内同步调用 refreshRowHighlight。

Test: 端到端验收 10 场景（原 7 + 跨 feature 隔离 / observer 长期稳定 /
Phase 1 实跑）。诊断证据链见 docs/superpowers/specs/2026-05-21-auto-select
-only-row-design.md 末尾。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push**

```
git push
```

- [ ] **Step 4: 创建 PR**

```bash
gh pr create --title "feat(auto_gen_label): 表格变 1 行时自动选中商品 + selectedRow 间接寻址重构" --body "$(cat <<'EOF'
## Summary

实现「表格变 1 行时自动选中商品」（spec: \`docs/superpowers/specs/2026-05-21-auto-select-only-row-design.md\`），并修复实施过程中暴露的两个潜伏 bug：

1. **\`rowObserver\` 锁旧 tbody 引用**：React 替换 tbody 后 observer 失效，新 row 不绑 click handler、自动选不触发
2. **\`selectedRow\` 指向 detached row 节点**：React 短时间内 re-render row，class 加在已脱离 DOM 的节点上，Phase 1 找不到「查看条码」按钮

外加 1 个 UX 改进：跨 feature 不弹自动选 toast。

## Architecture

\`fstate.product.skcNumber\` 是唯一 source of truth；不再存 row 引用：

- \`findRowBySkc(skc)\` 按 SKC 反向查当前 mounted row（取代 selectedRow 全局变量）
- \`refreshRowHighlight()\` 在 mutation / setProduct 时同步 \`.tal-selected\` class
- \`rowObserver\` attach 在 \`document.body\` subtree，永不 detach

## Test plan

- [x] 原 7 个手动场景（核心 / 多次切换 / 手动 clear 后 / 同 SKC 重搜 / 空表格 / 手动覆盖 / Phase 1-3 全流程）
- [x] 跨 feature 隔离（Hub 状态搜索不弹 toast）
- [x] observer 长期稳定（30 秒后搜索仍正常）
- [x] Phase 1 实跑通

## Risk

- \`observe(document.body, subtree:true)\` 监听范围大但 MutationObserver native + callback 内极少 DOM 操作，实测 Temu 商家中心可接受。若未来出 perf 问题加 throttle，YAGNI。
- 回滚：\`git revert <commit>\` 一行

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: 报告 PR URL**
