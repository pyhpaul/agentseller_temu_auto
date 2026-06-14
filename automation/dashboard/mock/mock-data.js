// mock-data.js — 开发态渲染验证用。骨架严格符合 spec §4.1 契约；血肉（大脑流/HITL详情）模拟 ws 推送。
// 数据取自 ui-prototype/dashboard.html 那一帧（保温杯）。关键：第4步用 status='paused' 显式表达 HITL（spec §4.1/§6.1），
// 不复刻原型 run+tag 隐式约定。
export const MOCK_SKELETON = {
  schemaVersion: 1,
  batch: {
    id: 'B-2406',
    createdAt: Date.parse('2026-03-08T14:22:00'),
    activeWorkflowId: 'w1',
    workflows: [
      {
        id: 'w1',
        product: { label: '中正科技保温杯 350ml', spuId: '6821042', skc: 'C04A8', skuNo: 'SK99021' },
        status: 'paused',
        cursor: 3,                  // 0-based，指向第 4 步「创建采购单」
        startedAt: Date.parse('2026-03-08T14:18:00'),
        updatedAt: Date.parse('2026-03-08T14:22:03'),
        steps: [
          { id: 'gen_label', label: '标签生成', feature: 'auto_gen_label', status: 'done', brainBrief: 'review:pass', result: { spuId: '6821042', labelPng: 'label.png' } },
          { id: 'img_search', label: '1688搜图', feature: 'image_search_1688', status: 'done', brainBrief: 'review:pass' },
          { id: 'check_publish', label: '检查与发布', feature: 'check_and_publish', status: 'done', brainBrief: 'review:pass' },
          { id: 'create_po', label: '创建采购单', feature: 'create_purchase_order', status: 'paused', brainBrief: 'selfheal:重试成功', result: { poNo: 'PO240308021' } },
          { id: 'price_declare', label: '价格不调整', feature: 'price_declare', status: 'pending' },
          { id: 'packing_label', label: '打包标签', feature: 'packing_label', status: 'pending' },
          { id: 'auto_ship', label: '自动发货', feature: 'auto_ship', status: 'pending' },
          { id: 'sale_export', label: '销售清单导出', feature: 'sale_manage_export', status: 'skipped', note: '本批不导出' },
        ],
        hitl: {
          id: 'h1',
          action: '申请付款',
          keyValues: { '金额': '¥128.00', '收货仓库': '中正科技仓', '供应商': '义乌恒达贸易' },
          reviewedBrief: '金额与采购单 PO240308021 一致，仓库匹配收货地，建议确认',
          editable: ['金额', '收货仓库'],
          fieldType: { '金额': 'number', '收货仓库': 'select', '供应商': 'readonly' },
          options: { '收货仓库': ['中正科技仓', '义乌中转仓', '杭州仓'] },
          status: 'pending',
        },
      },
    ],
  },
};

// 大脑流事件序列（ws-source mock 定时回放；增量 append 进 store）。kind ∈ review|diagnose|selfheal|log
export const MOCK_BRAIN_EVENTS = [
  { workflowId: 'w1', stepId: 'check_publish', kind: 'review',   text: '步骤3 SKU 校验通过，SPU 与目标一致', ts: Date.parse('2026-03-08T14:21:02'), anchor: '#3' },
  { workflowId: 'w1', stepId: 'create_po',     kind: 'log',      text: '打开采购单页，填充 SPU / 数量 / 供应商', ts: Date.parse('2026-03-08T14:21:25'), anchor: '#4' },
  { workflowId: 'w1', stepId: 'create_po',     kind: 'diagnose', text: '付款页金额 ¥128，与采购单核对…匹配', ts: Date.parse('2026-03-08T14:21:40'), anchor: '#4' },
  { workflowId: 'w1', stepId: 'create_po',     kind: 'selfheal', text: 'selector .pay-btn 失效，fallback 第 2 选择器命中', ts: Date.parse('2026-03-08T14:21:55'), anchor: '#4' },
  { workflowId: 'w1', stepId: 'create_po',     kind: 'log',      text: '写入 poNo=PO240308021', ts: Date.parse('2026-03-08T14:22:01'), anchor: '#4' },
  { workflowId: 'w1', stepId: 'create_po',     kind: 'review',   text: '付款前复核：金额 / 仓库 / 供应商一致，提交人工确认', ts: Date.parse('2026-03-08T14:22:03'), anchor: '#4' },
];

// HITL 详情（ws-source mock 推；对齐 spec §4.2 HITL_DETAIL）
export const MOCK_HITL_DETAIL = {
  hitlId: 'h1',
  action: '申请付款',
  fullReview: '金额与采购单 PO240308021 一致，仓库匹配收货地，供应商为历史合作方，建议确认。',
  valueDiff: [
    { field: '金额', current: '¥128.00', proposed: '¥128.00' },
    { field: '收货仓库', current: '中正科技仓', proposed: '中正科技仓' },
  ],
  risk: 'low',
};
