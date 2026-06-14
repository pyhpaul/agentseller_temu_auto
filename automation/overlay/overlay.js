// automation/overlay/overlay.js — 业务页 HITL 浮层（只读 storage + 发 message，不连 WS）。spec §5.3。
// 由 automation 装配为 content script（contract 后、registry 后 core 前）；唯一职责=编排消费端：
//   读 chrome.storage.local['as_workflow_state'] → 渲染进度/HITL/error；发 WF_*（绝不写 storage、不连 WS 绕 CSP）。
(function () {
  'use strict';
  // STORAGE_KEY 读 contract（单一真源，build 把 contract.js 作为 content script 注入在 overlay 前）；字面量兜底防未注入。
  const STORAGE_KEY = (window.__AS_DASH_CONTRACT__ && window.__AS_DASH_CONTRACT__.STORAGE_KEY) || 'as_workflow_state';
  const TOTAL_STEPS = 13;
  let root = null;
  const VIEW = window.__AS_OVERLAY_VIEW__;     // 视图决策纯逻辑（overlay-view.js，content 顺序保证先加载）

  function send(type, data) {
    try { chrome.runtime.sendMessage({ type, data }); }
    catch (e) { console.warn('[overlay] sendMessage 失败', e); }
  }

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
      .aso-btn { padding: 6px 12px; margin: 4px 4px 0 0; border-radius: 6px; border: none;
        cursor: pointer; font-size: 12px; }
      .aso-btn-go { background: #1f6feb; color: #fff; }
      .aso-btn-ok { background: #238636; color: #fff; }
      .aso-btn-no { background: #6e7681; color: #fff; }
      .aso-btn-retry { background: #9e6a03; color: #fff; }
      .aso-err { background: #2d1518; border: 1px solid #f85149; color: #ff7b72;
        padding: 6px 8px; border-radius: 6px; margin: 6px 0; font-size: 12px; }
      .aso-field { width: 100%; margin: 6px 0; padding: 6px; box-sizing: border-box;
        background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; }`;
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

  // paused → HITL 弹窗；error → 分层 chip；running → 仅进度条
  function renderBody(wf, step) {
    if (wf.status === 'paused' && wf.hitl) {
      const h = wf.hitl;
      // 标题优先 prompt（engine recover 的 ask-hitl 带 prompt 恢复引导语），回退 action/label
      const title = h.prompt || h.action || step.label || '人工确认';
      let b = `<div style="margin-bottom:6px;">待处理：<b>${title}</b></div>`;
      if (h.keyValues && typeof h.keyValues === 'object' && Object.keys(h.keyValues).length) {
        b += '<div style="font-size:12px;color:#8b949e;margin-bottom:6px;">' +
          Object.entries(h.keyValues).map(([k, v]) => `${k}: ${v}`).join('<br/>') + '</div>';
      }
      // 回填型（editable=true + fields）：按 fields 逐个渲染控件（首版一 SKC 一 SKU，单值）。
      // engine.buildHitl 给带 hitlSpec 的步（步2 skc / 步5 url1688 / 步6 orderNo1688）editable+fields；
      // 纯确认步 editable=false 跳过。recovery 的 hitl editable=false，也不走这。
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
      b += `<div>`;
      const goUrl = h.targetUrl || (step.target && step.target.url);
      if (goUrl) b += `<button class="aso-btn aso-btn-go" data-act="go">前往</button>`;
      b += `<button class="aso-btn aso-btn-ok" data-act="confirm">${h.editable ? '提交' : '确认完成'}</button>`;
      b += `<button class="aso-btn aso-btn-no" data-act="reject">拒绝</button></div>`;
      return b;
    }
    if (wf.status === 'error') {
      const err = step.error || {};
      // 错误三分层（spec/debugging-rules 铁律）：read=读取/选择器、validate=数据校验、business=业务拦截
      const catColor = { read: '#bc8cff', validate: '#d29922', business: '#f85149' }[err.category] || '#f85149';
      let b = `<div class="aso-err" style="border-color:${catColor};color:${catColor};">[${err.category || 'error'}] ${err.message || '步骤失败'}</div><div>`;
      if (err.recoverable) b += `<button class="aso-btn aso-btn-retry" data-act="retry">重试</button>`;
      b += `<button class="aso-btn aso-btn-no" data-act="reject">转人工</button></div>`;
      return b;
    }
    return '';   // running 仅进度条
  }

  function bindActions(el, wf) {
    const step = wf.steps[wf.cursor] || {};
    el.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'go') {
          const url = (wf.hitl && wf.hitl.targetUrl) || (step.target && step.target.url);
          if (url) window.open(url, '_blank');
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
        } else if (act === 'reject') {
          send('WF_HITL_REJECT', { workflowId: wf.id });   // paused=拒绝 / error=转人工，均 abort
        } else if (act === 'retry') {
          send('WF_RETRY', { workflowId: wf.id });
        }
      });
    });
  }

  function render(batch) {
    const decision = VIEW.decideOverlayView(batch, window.__AS_BUILD_INFO__);
    if (decision.view === 'hidden') { hide(); return; }   // 无 active workflow → 业务页不显示（启动入口在 dashboard）
    // 'active'：有运行中 workflow → 进度 / HITL / error
    const wf = decision.workflow;
    injectStyles();
    const el = ensureRoot();
    const step = wf.steps[wf.cursor] || {};
    let html = `<div class="aso-progress">编排进度 <b>${wf.cursor + 1}/${TOTAL_STEPS}</b> · <span class="aso-step">${step.label || ''}</span></div>`;
    html += renderBody(wf, step);
    el.innerHTML = html;
    bindActions(el, wf);
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
