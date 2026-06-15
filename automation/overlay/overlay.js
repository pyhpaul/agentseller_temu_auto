// automation/overlay/overlay.js — 业务页进度浮层（只读）。spec §5.3。
// 降级只读（dashboard 操作中心化后）：overlay 不再承担任何 HITL 操作，操作全在监控 dashboard。
// 唯一职责＝读 chrome.storage.local['as_workflow_state'] → 显示「当前第几步 / 状态」，不发任何 message、不连 WS。
(function () {
  'use strict';
  // STORAGE_KEY 读 contract（单一真源，build 把 contract.js 作为 content script 注入在 overlay 前）；字面量兜底防未注入。
  const STORAGE_KEY = (window.__AS_DASH_CONTRACT__ && window.__AS_DASH_CONTRACT__.STORAGE_KEY) || 'as_workflow_state';
  const TOTAL_STEPS = 13;
  let root = null;
  const VIEW = window.__AS_OVERLAY_VIEW__;     // 视图决策纯逻辑（overlay-view.js，content 顺序保证先加载）

  function injectStyles() {
    if (document.getElementById('as-overlay-style')) return;
    const s = document.createElement('style');
    s.id = 'as-overlay-style';
    // 深色 token 对齐 dashboard :root；right/bottom 避开 FAB（FAB 在 bottom:28px right:28px，本体高 ~52px → 顶边 ~80px）
    s.textContent = `
      #as-overlay { position: fixed; right: 16px; bottom: 80px; z-index: 2147483646;
        width: 280px; font: 13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;
        background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 10px;
        box-shadow: 0 8px 28px rgba(0,0,0,.5); padding: 12px; display: none; }
      #as-overlay.show { display: block; }
      .aso-progress { font-size: 12px; color: #8b949e; margin-bottom: 8px; }
      .aso-step { font-weight: 600; color: #58a6ff; }
      .aso-hint { font-size: 12px; color: #8b949e; }
      .aso-err { background: #2d1518; border: 1px solid #f85149; color: #ff7b72;
        padding: 6px 8px; border-radius: 6px; margin: 6px 0; font-size: 12px; }`;
    document.head.appendChild(s);
  }

  function ensureRoot() {
    if (root && document.body.contains(root)) return root;
    root = document.createElement('div');
    root.id = 'as-overlay';
    document.body.appendChild(root);
    return root;
  }
  function hide() { if (root) root.classList.remove('show'); }

  // 降级只读：paused → 提示去面板操作；error → 分层错误只读；running → 仅进度条
  function renderBody(wf, step) {
    if (wf.status === 'paused') {
      return `<div class="aso-hint">⏳ 等待人工处理（请在监控面板操作）</div>`;
    }
    if (wf.status === 'error') {
      const err = step.error || {};
      // 错误三分层（spec/debugging-rules 铁律）：read=读取/选择器、validate=数据校验、business=业务拦截
      const catColor = { read: '#bc8cff', validate: '#d29922', business: '#f85149' }[err.category] || '#f85149';
      return `<div class="aso-err" style="border-color:${catColor};color:${catColor};">[${err.category || 'error'}] ${err.message || '步骤失败'}</div>` +
        `<div class="aso-hint">请在监控面板处理</div>`;
    }
    return '';   // running 仅进度条
  }

  function render(batch) {
    const decision = VIEW.decideOverlayView(batch, window.__AS_BUILD_INFO__);
    if (decision.view === 'hidden') { hide(); return; }   // 无 active workflow → 业务页不显示（启动入口在 dashboard）
    // 'active'：有运行中 workflow → 进度 / 状态提示（只读）
    const wf = decision.workflow;
    injectStyles();
    const el = ensureRoot();
    const step = wf.steps[wf.cursor] || {};
    let html = `<div class="aso-progress">编排进度 <b>${wf.cursor + 1}/${TOTAL_STEPS}</b> · <span class="aso-step">${step.label || ''}</span></div>`;
    html += renderBody(wf, step);
    el.innerHTML = html;
    el.classList.add('show');
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) render(changes[STORAGE_KEY].newValue);
  });

  function init() {
    chrome.storage.local.get(STORAGE_KEY, obj => render(obj[STORAGE_KEY] || null));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
