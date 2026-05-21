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
