# HITL 回填打通 L3 端到端 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:executing-plans 逐 Task 执行（inline）。Steps 用 checkbox 跟踪。

**Goal:** 激活 3 个回填型 HITL（步2 collect_dxm 填 `skc`、步5 compare_1688 填 `url1688`、步6 order_1688 填 `orderNo1688`），打通 Plan 2/3 自动化流水线 L3 端到端数据流——让下游 AUTO 步（gen_label/create_sku/create_po）拿到所需 product 字段。

**Architecture:** 写回机制已 ready——AUTO 步 `engine.js:84` `Object.assign(w.product, pickProduct(res.result))`、HITL 步 `orchHitlConfirm` 同样调 `pickProduct` 写回 product。唯一缺口 = `engine.buildHitl` 的 `editable` 恒 false（7 个 HITL 步共用纯确认摘要、不带回填元数据）→ overlay 回填控件是 dead branch。本刀按步给元数据激活：steps.js 加 `hitlSpec` 字段（同 target 透传模式）→ engine.buildHitl 读 `step.hitlSpec` 条件化 editable + fields → overlay 多字段渲染/收集/校验（纯逻辑抽 overlay-view.js 可测，DOM 留 overlay.js）。**纯 core 改动，不碰任何 feature。**

**Tech Stack:** JS（UMD 模块 + node --test 纯逻辑单测）。

**首版边界（用户 2026-06-13 拍板）:** 一 SKC 一 SKU——product 单值契约（skc/url1688/orderNo1688 各单值）够用。多变种不同 1688 货源/订单（per-SKU 数组契约）留后续刀。HITL 回填首版人工填（spec §9「回填=人工 overlay」；大脑推断回填值留后续 spec §12）。

---

## File Structure

- `core/background/orchestrator/steps.js` — STEP_DEFS 步2/5/6 加 `hitlSpec` + buildInitialWorkflow 透传 hitlSpec
- `core/background/orchestrator/engine.js` — buildHitl 读 step.hitlSpec 条件化
- `core/content/overlay-view.js` — 加 buildFillResult + validateFill 纯逻辑
- `core/content/overlay.js` — renderBody editable 分支多字段渲染 + bindActions confirm 接校验（DOM，不单测）
- `tests/orchestrator-engine.test.js` — buildHitl 按步 editable/fields 用例
- `tests/overlay-view.test.js` — buildFillResult/validateFill 用例

---

### Task 1: steps.js hitlSpec + engine.buildHitl 条件化

**Files:**
- Modify: `core/background/orchestrator/steps.js`
- Modify: `core/background/orchestrator/engine.js:36-44`
- Test: `tests/orchestrator-engine.test.js`

- [ ] **Step 1: 写失败测试（engine.buildHitl 按步 editable/fields）**

加到 `tests/orchestrator-engine.test.js`（require 已有 engine；buildHitl 是 engine export）：

```javascript
const { buildHitl } = require('../core/background/orchestrator/engine.js');

test('buildHitl：带 hitlSpec.fields 的步 → editable=true + fields', () => {
  const step = { id: 'compare_1688', label: '1688比价核价',
    hitlSpec: { fields: [{ key: 'url1688', label: '1688 货源链接', fieldType: 'text', required: true }] } };
  const h = buildHitl(step);
  assert.strictEqual(h.editable, true);
  assert.strictEqual(h.fields.length, 1);
  assert.strictEqual(h.fields[0].key, 'url1688');
});

test('buildHitl：无 hitlSpec 的纯确认步 → editable=false + fields 空', () => {
  const h = buildHitl({ id: 'select_product', label: '选品' });
  assert.strictEqual(h.editable, false);
  assert.deepStrictEqual(h.fields, []);
});

test('buildHitl：hitlSpec.fields 空数组 → editable=false', () => {
  const h = buildHitl({ id: 'x', label: 'x', hitlSpec: { fields: [] } });
  assert.strictEqual(h.editable, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/orchestrator-engine.test.js`
Expected: FAIL（buildHitl 现返回 editable:false 恒、无 fields 字段）

- [ ] **Step 3: 改 engine.buildHitl（engine.js:36-44）**

```javascript
  // HITL step → workflow.hitl 摘要。带 hitlSpec.fields 的步为回填型（editable+fields），否则纯确认。
  // recovery 的 hitl 在 engine recover 内直接构造、不走这（其 editable=false 语义不变）。
  function buildHitl(step) {
    const spec = step.hitlSpec || null;
    const fields = (spec && Array.isArray(spec.fields)) ? spec.fields : [];
    return {
      action: step.label, stepId: step.id,
      keyValues: {}, reviewedBrief: '',
      editable: fields.length > 0,
      fieldType: null, options: null,   // 保留兼容（recovery 直构造不依赖这两）
      fields,
      targetUrl: (step.target && step.target.url) || null,
      status: 'pending',
    };
  }
```

- [ ] **Step 4: 改 steps.js——步2/5/6 加 hitlSpec + buildInitialWorkflow 透传**

STEP_DEFS 里给步2/5/6 加 `hitlSpec`（步2 collect_dxm 行、步5 compare_1688 行、步6 order_1688 行）：

```javascript
    { id: 'collect_dxm',      label: '店小秘采集建品',        type: 'hitl', feature: null,                   reversible: null,  domain: 'dianxiaomi.com',
      hitlSpec: { fields: [
        { key: 'skc',   label: 'SKC（采集后创建，唯一）', fieldType: 'text', required: true },
        { key: 'spuId', label: 'SPU ID（可选）',          fieldType: 'text', required: false },
      ] } },
```
```javascript
    { id: 'compare_1688',     label: '1688比价核价',          type: 'hitl', feature: null,                   reversible: null,  domain: '1688.com',
      hitlSpec: { fields: [{ key: 'url1688', label: '1688 货源链接', fieldType: 'text', required: true }] } },
```
```javascript
    { id: 'order_1688',       label: '1688下单',              type: 'hitl', feature: null,                   reversible: null,  domain: '1688.com',
      hitlSpec: { fields: [{ key: 'orderNo1688', label: '1688 订单号', fieldType: 'text', required: true }] } },
```

buildInitialWorkflow 的 steps.map 加 hitlSpec 透传（同 target）：

```javascript
      steps: STEP_DEFS.map(d => ({
        id: d.id, label: d.label, feature: d.feature, type: d.type,
        reversible: d.reversible, domain: d.domain, target: d.target || null,
        hitlSpec: d.hitlSpec || null,
        status: 'pending', startedAt: null, endedAt: null,
        result: null, brainBrief: '(确定性)', note: null, committing: false, error: null, retryCount: 0,
      })),
```

- [ ] **Step 5: 跑测试确认通过 + commit**

Run: `node --test tests/orchestrator-engine.test.js`
Expected: PASS（含新 3 用例）

```bash
git add core/background/orchestrator/steps.js core/background/orchestrator/engine.js tests/orchestrator-engine.test.js
git commit -m "$(cat <<'EOF'
feat(orchestrator): HITL 回填元数据——步2/5/6 hitlSpec + buildHitl 条件化

Why: engine.buildHitl 的 editable 恒 false 让 overlay 回填控件成 dead branch，
  HITL 卡点无法回填 skc/url1688/orderNo1688，下游 AUTO 步缺数据→L3 端到端断。
What: steps.js 给步2 collect_dxm(skc)/步5 compare_1688(url1688)/步6 order_1688(orderNo1688)
  加 hitlSpec.fields 元数据（同 target 透传）；buildHitl 读 step.hitlSpec 条件化 editable+fields。
  首版一 SKC 一 SKU、单值契约。纯 core 不碰 feature。
Test: node --test tests/orchestrator-engine.test.js → 含新 3 用例全过

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: overlay-view.js buildFillResult + validateFill

**Files:**
- Modify: `core/content/overlay-view.js`
- Test: `tests/overlay-view.test.js`

- [ ] **Step 1: 写失败测试**

加到 `tests/overlay-view.test.js`（解构加 buildFillResult, validateFill）：

```javascript
const { buildFillResult, validateFill } = require('../core/content/overlay-view.js');

const FIELDS = [
  { key: 'url1688', label: '1688 链接', fieldType: 'text', required: true },
  { key: 'qty', label: '数量', fieldType: 'number', required: false },
];

test('buildFillResult：按 fields 收集，trim 文本、number 转数字', () => {
  const r = buildFillResult(FIELDS, k => ({ url1688: '  https://x.1688.com/a  ', qty: '12' }[k]));
  assert.strictEqual(r.url1688, 'https://x.1688.com/a');
  assert.strictEqual(r.qty, 12);
});

test('validateFill：required 空 → error', () => {
  const v = validateFill(FIELDS, { url1688: '', qty: 1 });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some(e => e.key === 'url1688'));
});

test('validateFill：url1688 不含 1688.com → error', () => {
  const v = validateFill(FIELDS, { url1688: 'https://taobao.com/x', qty: 1 });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some(e => e.key === 'url1688'));
});

test('validateFill：全合法 → ok', () => {
  const v = validateFill(FIELDS, { url1688: 'https://x.1688.com/a', qty: 1 });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.errors, []);
});

test('validateFill：非必填空字段不报错', () => {
  const v = validateFill(FIELDS, { url1688: 'https://x.1688.com/a', qty: NaN });
  assert.strictEqual(v.ok, true);   // qty 非 required，NaN 不拦
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/overlay-view.test.js`
Expected: FAIL（buildFillResult/validateFill 未定义）

- [ ] **Step 3: 实现（overlay-view.js，加在 normalizeStartLabel 后、return 前）**

```javascript
  // 回填型 HITL：按 fields 从 getValue(key) 收集 result（文本 trim、number 转数字）。
  function buildFillResult(fields, getValue) {
    const out = {};
    (fields || []).forEach(f => {
      const raw = getValue(f.key);
      out[f.key] = f.fieldType === 'number'
        ? Number(raw)
        : (raw == null ? '' : String(raw)).trim();
    });
    return out;
  }

  // 校验回填 result：required 非空 + url1688 基础格式（含 1688.com）。返回 {ok, errors:[{key,msg}]}。
  function validateFill(fields, result) {
    const errors = [];
    (fields || []).forEach(f => {
      const v = result ? result[f.key] : undefined;
      const empty = v == null || v === '' || (f.fieldType === 'number' && Number.isNaN(v));
      if (f.required && empty) {
        errors.push({ key: f.key, msg: (f.label || f.key) + ' 必填' });
      } else if (f.key === 'url1688' && v && !String(v).includes('1688.com')) {
        errors.push({ key: f.key, msg: '1688 链接格式不对（应含 1688.com）' });
      }
    });
    return { ok: errors.length === 0, errors };
  }
```

并在 return 加这两个：`return { activeWorkflow, decideOverlayView, normalizeStartLabel, buildFillResult, validateFill };`

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `node --test tests/overlay-view.test.js`
Expected: PASS（原 8 + 新 5）

```bash
git add core/content/overlay-view.js tests/overlay-view.test.js
git commit -m "$(cat <<'EOF'
feat(overlay): 回填纯逻辑 buildFillResult + validateFill（可 node 测）

Why: 多字段 HITL 回填的收集/校验是纯逻辑，抽到 overlay-view 单测（DOM 留 overlay.js）。
What: buildFillResult 按 fields 收集 result（trim/number 转换）；validateFill 校验 required 非空
  + url1688 基础格式（含 1688.com，填错下游 hard error 值得防）。
Test: node --test tests/overlay-view.test.js → 原 8 + 新 5 全过

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: overlay.js 多字段渲染 + confirm 接校验

**Files:**
- Modify: `core/content/overlay.js`（renderBody editable 分支 65-72 + bindActions confirm 100-108）

> DOM 渲染无 node 单测，靠 overlay-view 单测（Task 2）+ node --check + chrome e2e（Task 4 列步骤）。

- [ ] **Step 1: 改 renderBody 的 editable 分支（overlay.js:65-72）**

把现有单 `#aso-input` 分支换成多字段 `fields[]`：

```javascript
      // 回填型（editable=true + fields）：按 fields 逐个渲染控件（首版一 SKC 一 SKU，单值）。
      if (h.editable && Array.isArray(h.fields) && h.fields.length) {
        h.fields.forEach(f => {
          b += `<div style="margin-top:6px;"><label style="font-size:12px;color:#8b949e;">` +
            `${f.label || f.key}${f.required ? ' <span style="color:#f85149;">*</span>' : ''}</label>`;
          if (f.fieldType === 'select' && Array.isArray(f.options)) {
            b += `<select class="aso-field" id="aso-fill-${f.key}">` +
              f.options.map(o => `<option value="${o}">${o}</option>`).join('') + `</select>`;
          } else {
            b += `<input class="aso-field" id="aso-fill-${f.key}" ` +
              `type="${f.fieldType === 'number' ? 'number' : 'text'}" placeholder="${f.label || f.key}"/>`;
          }
          b += `</div>`;
        });
      }
```

- [ ] **Step 2: 改 bindActions 的 confirm 分支（overlay.js:100-108）**

```javascript
        } else if (act === 'confirm') {
          let result = {};
          if (wf.hitl && wf.hitl.editable && Array.isArray(wf.hitl.fields) && wf.hitl.fields.length) {
            result = VIEW.buildFillResult(wf.hitl.fields, key => {
              const elx = el.querySelector(`#aso-fill-${key}`);
              return elx ? elx.value : '';
            });
            const v = VIEW.validateFill(wf.hitl.fields, result);
            if (!v.ok) { window.alert(v.errors.map(e => e.msg).join('\n')); return; }   // 校验失败不发，提示缺什么
          }
          send('WF_HITL_CONFIRM', { workflowId: wf.id, result });
        }
```

- [ ] **Step 3: 语法检查 + commit**

Run: `node --check core/content/overlay.js`
Expected: exit 0

```bash
git add core/content/overlay.js
git commit -m "$(cat <<'EOF'
feat(overlay): HITL 多字段回填渲染 + 写前校验

Why: 激活回填型 HITL 控件（原单字段 dead branch），步2/5/6 弹多字段输入框收集回填值。
What: renderBody editable 分支按 wf.hitl.fields 逐个渲染控件（required 标 *）；bindActions confirm
  用 overlay-view 的 buildFillResult 收集 + validateFill 校验，失败 alert 不发（提示缺什么）。
Test: node --check overlay.js exit 0；纯逻辑见 overlay-view 单测；DOM 留 chrome e2e

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 回归 + dev build + 验证文档

**Files:**
- Create: `docs/superpowers/2026-06-13-hitl-fill-l3-verification.md`

- [ ] **Step 1: 全量回归**

Run（分开跑）：
- `node --test tests/*.test.js` —— 全量 JS（engine 新 3 + overlay-view 新 5，预期 87 pass）
- `python3 -m pytest tests/` —— 全量 Python 不回归（预期 49）
- `python3 build/build_extension.py` —— dev build 不回归（预期 8 features / 15 cs）

- [ ] **Step 2: 写验证文档**（结果表 + 数据流打通说明 + chrome e2e 步骤 + 首版边界）

chrome e2e 关键步骤（留 task #30 一起验）：步2 collect_dxm paused → overlay 弹 skc/spuId 输入框 → 填 skc → 确认 → cursor 推进 + SW console 验 `product.skc` 已写入；步5 填 url1688（验格式校验：填非 1688 链接被拦）→ create_sku 拿到 url1688；步6 填 orderNo1688 → create_po 拿到。

- [ ] **Step 3: commit**

```bash
git add docs/superpowers/2026-06-13-hitl-fill-l3-verification.md
git commit -m "$(cat <<'EOF'
docs(orchestrator): HITL 回填 L3 验证文档 + 全量回归

Why: 留档 HITL 回填打通 L3 的验证证据 + chrome e2e 步骤 + 首版边界。
What: 验证文档（结果表 + 数据流打通 + chrome e2e 步骤 + 一SKC一SKU 边界）。
Test: node --test tests/*.test.js / pytest / build 全绿（见文档结果表）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

- **覆盖**：3 个回填型 HITL（步2 skc / 步5 url1688 / 步6 orderNo1688）← Task 1 元数据 + Task 3 UI；写回复用现有 pickProduct（无需改）。✓
- **类型一致**：`step.hitlSpec.fields[{key,label,fieldType,required}]` 在 steps.js 定义、engine.buildHitl 读、overlay 渲染、overlay-view 收集/校验，签名一致。✓
- **Placeholder**：各 Task 含完整代码 + 确切命令/期望，无 TBD。✓
- **边界**：一 SKC 一 SKU 单值契约（多变种 per-SKU 留后续）；人工填（大脑推断留后续）；recovery hitl 不走 buildHitl 不受影响。✓
- **发版隔离**：overlay 回填只在 active workflow 的 paused 态触发，release 无 WF_START → 无 workflow → 不触发，沉睡（同 overlay 既有隔离）。✓
