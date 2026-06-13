# 商品编号体系规范（v1.0）

本文档统一项目所有 feature 对 Temu 商品编号体系的理解和使用规范。目的是防止跨 feature 编号混淆、多 SKU 场景处理不当、以及数据一致性问题。

---

## 核心编号定义

### SKC ID（数字）
- **含义**：Seller Commodity Code 商品编码的ID部分，纯数字
- **唯一性**：商品唯一（一个 SKC ID 对应一个商品）
- **来源**：Temu 商家中心表格「SKC」列
- **例**：`12345`
- **特点**：
  - 在表格中可能出现多次（同商品的多个 SKU）
  - 与 SPU ID 一一对应（Temu 商品 ↔ 店小秘商品的映射）

### SKC货号（字母数字混合）
- **含义**：SKC 的货号部分，由数字+字母组成
- **唯一性**：商品唯一（但一个商品可有多个 SKU 货号）
- **来源**：Temu 商家中心表格「SKC货号」列
- **例**：`CLI319`（基础部分）
- **特点**：
  - 包含商品型号/分类信息（可人类识别）
  - 当表格含 SKU 属性列时，可能是 `CLI319-White-2pcs` 的形式（见下文「SKU货号」）

### SKU货号（SKC货号 + 属性）
- **含义**：具体商品变体的完整编号，包括颜色/尺寸等属性
- **唯一性**：商品变体唯一（一个 SKC 可对应多个 SKU 货号）
- **来源**：同「SKC货号」列，或通过多列组合（SKC货号 + 颜色/尺寸等）
- **例**：`CLI319-White-2pcs`、`CLI319-Black-3pcs`
- **特点**：
  - 可能含"-"分隔符（货号-属性1-属性2-...）
  - `split('-')[0]` 是 SKC货号基础部分

### SPU ID（数字）
- **含义**：Supply Unit ID，采购单位ID，店小秘/Temu 后端商品标识
- **唯一性**：商品唯一（与 SKC ID 一一对应）
- **来源**：Temu 商家中心表格「SPU ID」列、或通过 Temu API 查询
- **例**：`67890`
- **特点**：
  - 用于跨系统查询（Temu ↔ 店小秘、Temu ↔ 1688）
  - Phase 2 "实拍图"页面用 SPU 定位商品行

---

## 平台术语映射

| 概念 | Temu 叫法 | 店小秘叫法 | 1688叫法 |
|------|----------|----------|---------|
| 商品 | SKC ID + SKC货号 | 商品 | - |
| 商品变体 | SKU货号（含属性） | SKU | 商品变种 |
| 采购单位 | SPU ID | SPU | - |
| 主图/详情等资产 | 绑定 SKC | 绑定商品 | 绑定商品 |
| 标签 | 按 SKU 货号生成 | - | - |
| 采购单据 | 按 SKC（PO 号） | - | - |

---

## 各 Feature 使用规范

### auto_gen_label
**用途**：标签生成工作流

**使用的编号**：SKC ID / SKC货号 / SKU货号 / SPU ID

**关键流程**：
1. **Phase 1（条码管理页）**：按 SKC ID 选商品行 → 逐个 SKU 生成条码标签
2. **Phase 2 Step 1（实拍图页）**：通过 SKC ID 查询获得 SPU ID
3. **Phase 2 Step 2/3（合规信息页）**：按 SPU ID 定位编辑对象
4. **Phase 3（主图上传）**：按 SKU 货号匹配标签文件并上传

**多SKU处理**：
- 同一 SKC 的多个 SKU 可一次性全选
- 每个 SKU 生成独立的标签文件（文件夹 `{skc_id}-{skc_sku_base}`，文件 `{skc_sku}.jpeg`）
- Phase 2 从第一个商品启动；其他商品标签在 Phase 3 上传

**防护装置**：
- Phase 2 Step 1：轮询等"含 SPU 结果行恰好 1 行"，防止 SKC→SPU 错配
- Phase 3：drawer 内二次确认 SPU ID == 目标，防止点错行

---

### auto_ship
**用途**：发货单自动化

**使用的编号**：SKC ID

**关键流程**：
1. 按 SKC ID 扫描发货单表格
2. 判断同 SKC 的所有发货单是否已处理

**多SKU处理**：不支持（表格一行一单）

**已知问题**：中间态下同 SKC 不同发货单会漏扫（未根本解决）

---

### check_and_publish
**用途**：新品合规预检

**使用的编号**：SKU货号

**关键流程**：
1. 从 `input[name="variationSku"]` 提取 SKU 值
2. 检查是否含中文/中文标点

**多SKU处理**：支持（逐个 SKU 检查）

---

### create_purchase_order
**用途**：创建采购单

**使用的编号**：SKC ID / SKC货号 / SPU ID / SKU货号

**关键流程**：
1. **Phase 1（Temu 列表）**：按 SKC ID 定位商品行 → 提取 SKU 货号 + SPU ID
2. **店小秘编辑页**：通过 SPU ID 拼 URL 打开
3. **新品配对**：搜 SKU 货号匹配店小秘的商品
4. **待到货页**：用 PO 号搜（不再用 SKU 货号）

**多SKU处理**：支持（编辑页多 SKU 时优先本框预览图）

**防护装置**：
- 表头有 rowspan/colspan，用 `cpoLeafColIndex` 动态算「SKU货号」列索引
- SKC ID/SPU ID 通过正则 `SKCID[:：]?(\d+)` 提取

---

### price_declare
**用途**：商品调价同步

**使用的编号**：SPU ID / SKC ID

**关键流程**：
1. 用 `SPU ID:SKC ID` 作 key 判定同步目标
2. 同一 key 的多条调价单共享一个 key，一条拒绝整组脏数据跳过

**多SKU处理**：支持（同 SPU+SKC 的多条调价单共享 key）

**同步信号**：内容签名（表格数据）+ sleep 2000ms 多信号兜底

**已知问题**：后端异步分批处理，可能产生误信号

---

### sale_manage_export
**用途**：销售清单导出采集

**使用的编号**：SKC ID / SKC货号 / SPU ID

**关键流程**：
1. 导出时按 SKC ID 去重（`Map<SKC,row>`）
2. 防跨页重复采集
3. 内容签名：「首组SKC|末组SKC|组数」

**多SKU处理**：支持（rowspan 分组：每 SKC 组 = 首行 + N 个 SKU 行 + 合计行）

**已知问题**：「共有 N 条」显示的是 SKU 计数，采集按 SKC 粒度，两者不一致

---

### image_search_1688 / packing_label
**用途**：图片搜索 / 批量打印标签

**使用的编号**：无直接使用

---

## 多SKU场景最佳实践

### 场景 1：一个商品多个变体（最常见）
**例**：同一商品有白色/黑色两个颜色，各有不同的 SKU 货号

**规范处理**：
1. ✅ 同 SKC ID 的多行可在 UI 同时选中
2. ✅ 遍历生成多个标签文件（各自独立，文件名含变体属性）
3. ✅ Phase 2 从第一个启动，其他通过 Phase 3 按需上传
4. ❌ 不应把多个 SKU 合并成一个文件
5. ❌ 不应选了多 SKU 后只生成第一个的标签

### 场景 2：跨表格重复（多 tab / 虚拟滚动）
**例**：scrolling 导致同一商品出现在表格的不同位置，可能被重复采集

**规范处理**：
1. ✅ 用唯一 key（SKC ID + SKU 货号）去重
2. ✅ 内容签名时忽略 UI 状态（页码/加载动画），只看数据
3. ❌ 不应依赖「行消失」判刷新完成（可能是虚拟滚动）
4. ❌ 不应依赖 mask/loading 图标判状态

### 场景 3：rowspan 分组（sale_manage_export / packing_label）
**例**：一行 SKC 跨 N 个 tr（N = 该 SKC 的 SKU 数）

**规范处理**：
1. ✅ 明确「首行」「SKU行」「合计行」的 rowspan 关系
2. ✅ 按 SKC 分组时考虑 rowspan 跨度（不是简单按相邻 tr）
3. ✅ 采集数据时从 rowspan 首行读，SKU 数据从对应行读
4. ❌ 不应当成普通表格逐行处理

---

## 错误处理与降级

### SKC→SPU 映射失败
**场景**：搜 SKC 查不到 SPU，或结果不唯一

**正确处理**（auto_gen_label Phase 2 Step 1）：
```javascript
轮询等"含目标 SKC 的 SPU 结果行恰好 1 行"，
不唯一/超时 → 报错中止，不退回全局查找
```

**反面例**：
```javascript
// ❌ 错：只要返回任何结果就取第一行
const spu = document.querySelectorAll('tr')[0].textContent;
// ❌ 错：搜不到就随便选一个 SPU（默认值）
// ✅ 正：轮询等恰好 1 行 + 超时报错
```

### SKU货号缺失
**场景**：表格某行无 SKU 货号

**处理优先级**（按严格程度）：
1. 🔴 **中止流程**（auto_gen_label）：需要 SKU 货号生成标签，无法继续
2. 🟡 **降级处理**（create_purchase_order）：能用其他字段补全（如商品名称）
3. 🟢 **日志告警**（price_declare）：缺失不影响当前流程，但告知用户补维护

---

## 版本历史

- **v1.0** (2026-06-12)：
  - 统一 SKC ID / SKC货号 / SKU货号 / SPU ID 定义
  - auto_gen_label 多SKU支持 + 文件命名改进
  - 各 feature 编号使用汇总表
  - 多SKU最佳实践指南

---

## 附录：常见混淆点

| 混淆 | 正确 | 错误 |
|------|------|------|
| SKC货号 vs SKU货号 | SKC货号 = 基础部分（CLI319）；SKU货号 = 完整（CLI319-White-2pcs） | 混用两者，导致文件命名歧义 |
| SKC ID vs SKC货号 | SKC ID 是数字（12345）；SKC货号是字母数字（CLI319） | 用错位置搜索，找不到目标 |
| 一行 = 一个 SKU vs 一行 = 一个 SKC | Temu 表格一行通常 = 一个 SKU（同 SKC 有多行）；rowspan 分组时一行 SKC 跨多行 | 按"一行 = 一个商品"处理，漏扫同 SKC 的其他 SKU |
| 导出数量 vs 采集粒度 | sale_manage_export 导出行数 ≠ 采集 SKC 数（一个 SKC 多行） | 拿导出行数验证采集是否完整（永远不等） |
| Phase 2 的同步信号 | 内容签名（表格数据 hash）| UI 状态（mask、页码、行数） |

---

## 下一步

- [ ] 在 create_purchase_order 补全多 SKU 预览图匹配（v1.2.3+）
- [ ] 沉淀 rowspan 处理工具函数到共享层
- [ ] 其他 feature SKC↔SPU 防护加固（参考 auto_gen_label）
- [ ] auto_ship 中间态漏扫根本解决
