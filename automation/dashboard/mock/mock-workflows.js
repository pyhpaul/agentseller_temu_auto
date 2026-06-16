// mock/mock-workflows.js — dev-only UI 测试 fixture。生成 N 个多样 workflow 灌 store 测搜索/筛选/分页。
// 不碰真实 storage、不连 WS、不伪装运行状态（区别于已删的 WS 大脑流 mock 回放）。release 不装配 automation→天然无。
const STEP_DEFS = [
  ['select_product', '选品'], ['collect_dxm', '店小秘采集建品'], ['publish', '合规预检+发布'],
  ['get_return_price', '获取返单价'], ['compare_1688', '1688比价核价'], ['confirm_declare_price', '确认申报价格'],
  ['order_1688', '1688下单'], ['gen_label', '货号+标签+合规+标签图'], ['create_sku', '建店小秘SKU'],
  ['create_po', '创建采购单'], ['wait_payment', '等财务付款'], ['wait_arrival', '等到货'],
  ['pack_label', '打印打包标签'], ['ship', '确认发货'],
];
const STATUSES = ['pending', 'running', 'paused', 'error', 'done', 'aborted'];

function mockSteps(cursor, wfStatus) {
  return STEP_DEFS.map(([id, label], i) => ({
    id, label,
    status: i < cursor ? 'done'
      : i === cursor ? (wfStatus === 'done' ? 'done' : wfStatus === 'paused' ? 'paused' : 'running')
      : 'pending',
  }));
}

export function buildMockBatch(n) {
  const workflows = [];
  for (let i = 0; i < n; i++) {
    const status = STATUSES[i % STATUSES.length];
    const cursor = i % 14;
    // 走过 ⑥ confirm_declare_price（index 5）的才给 grossMargin（模拟核价过的）
    const grossMargin = cursor > 5 ? ((i % 9) * 5 + 5) / 100 : null;   // 0.05~0.45
    workflows.push({
      id: 'mock_' + i,
      product: { label: '测试商品 ' + (i + 1), grossMargin },
      status, cursor, steps: mockSteps(cursor, status),
      updatedAt: 1000 + i, hitl: null, tmpTabs: [],
    });
  }
  return {
    schemaVersion: 1,
    batch: { id: 'mock_batch', createdAt: 1000, activeWorkflowId: workflows[0] ? workflows[0].id : null, workflows },
  };
}
