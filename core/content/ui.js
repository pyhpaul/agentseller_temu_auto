// core/content/ui.js — FAB / Panel / Hub UI 构建
(function () {
  'use strict';

  // ── UI 内部状态（搬自原 content-script.js 顶部 state.view/state.feature/panelTargetBottom）
  const state = {
    view: 'fab',     // 'fab' | 'hub' | 'feature'
    feature: null,
  };
  let panelTargetBottom = null;

  function injectStyles() {
    if (document.getElementById('tal-styles')) return;
    const s = document.createElement('style');
    s.id = 'tal-styles';
    s.textContent = `
      /* FAB */
      #tal-fab {
        position:fixed; bottom:28px; right:28px; z-index:999999;
        width:44px; height:44px; border-radius:50%;
        background:#1677ff; color:#fff; border:none;
        font-size:20px; cursor:pointer;
        box-shadow:0 4px 14px rgba(22,119,255,.55);
        display:flex; align-items:center; justify-content:center;
        transition:transform .15s, box-shadow .15s;
        user-select:none;
      }
      #tal-fab:hover { transform:scale(1.08); box-shadow:0 6px 18px rgba(22,119,255,.65); }
      #tal-fab .tal-fab-hint {
        position:absolute; bottom:52px; right:0;
        background:rgba(0,0,0,.7); color:#fff;
        font-size:11px; padding:3px 8px; border-radius:4px;
        white-space:nowrap; pointer-events:none;
        opacity:0; transition:opacity .2s;
      }
      #tal-fab:hover .tal-fab-hint { opacity:1; }

      /* 面板公共 */
      #tal-panel {
        position:fixed; bottom:28px; right:28px; z-index:999999;
        background:#fff; border:1px solid #e4e6ea;
        border-radius:12px; box-shadow:0 8px 28px rgba(0,0,0,.16);
        font-family:-apple-system,sans-serif; font-size:13px;
        user-select:none; display:none; overflow:hidden;
        min-width:200px;
      }

      /* 面板标题栏 */
      .tal-titlebar {
        display:flex; align-items:center; gap:6px;
        padding:9px 12px; background:#1677ff;
        color:#fff; font-weight:600; cursor:grab;
      }
      .tal-titlebar:active { cursor:grabbing; }
      .tal-titlebar-title { flex:1; font-size:13px; }
      .tal-titlebar button {
        background:none; border:none; color:rgba(255,255,255,.8);
        cursor:pointer; font-size:16px; line-height:1; padding:0 2px;
      }
      .tal-titlebar button:hover { color:#fff; }

      /* Hub 视图 */
      #tal-hub-view { padding:12px; }
      .tal-feature-grid {
        display:grid; grid-template-columns:repeat(3,1fr); gap:8px;
      }
      .tal-feature-card {
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        gap:4px; padding:10px 6px; border-radius:8px;
        border:1px solid #e4e6ea; cursor:pointer;
        transition:background .15s, border-color .15s;
        background:#fafafa;
      }
      .tal-feature-card:hover:not(.tal-feature-locked) {
        background:#e8f0fe; border-color:#1677ff;
      }
      .tal-feature-card.tal-feature-locked { opacity:.45; cursor:not-allowed; }
      .tal-feature-card .tal-ficon  { font-size:22px; }
      .tal-feature-card .tal-flabel { font-size:11px; color:#555; text-align:center; }

      /* Feature 视图 */
      #tal-feature-view { padding:10px 12px; min-width:220px; }

      /* 操作按钮 */
      .tal-action-btn {
        width:100%; padding:8px 0; border:none; border-radius:6px;
        cursor:pointer; font-size:13px; font-weight:500;
        background:#1677ff; color:#fff; margin-bottom:8px;
        transition:opacity .15s;
      }
      .tal-action-btn:disabled { opacity:.38; cursor:not-allowed; }
      .tal-action-btn:not(:disabled):hover { opacity:.88; }

      /* 商品卡 */
      .tal-card {
        background:#f7f8fa; border-radius:6px;
        padding:8px 10px; margin-bottom:10px;
      }
      .tal-card-title { font-size:11px; color:#aaa; margin-bottom:5px; }
      .tal-product-empty { color:#ccc; font-size:12px; text-align:center; padding:4px 0; }
      .tal-kv { display:flex; justify-content:space-between; font-size:12px; margin-bottom:2px; }
      .tal-k  { color:#aaa; }
      .tal-v  { font-weight:500; color:#222; max-width:120px; overflow:hidden;
                text-overflow:ellipsis; white-space:nowrap; }
      .tal-clear-btn {
        margin-top:6px; font-size:11px; padding:2px 8px;
        cursor:pointer; border:1px solid #d9d9d9; border-radius:3px;
        background:#fff; color:#999; display:block; width:100%;
      }
      .tal-clear-btn:hover { color:#ff4d4f; border-color:#ff4d4f; }

      /* 路径设置行 */
      .tal-path-row {
        display:flex; justify-content:space-between; align-items:center;
        font-size:12px; padding:4px 6px; margin:0 -6px;
        border-radius:4px; cursor:pointer;
        transition:background .15s;
      }
      .tal-path-row + .tal-path-row { margin-top:2px; }
      .tal-path-row:hover { background:#e8f0fe; }
      .tal-path-row:hover .tal-path-v { color:#1677ff; }
      .tal-path-k { color:#aaa; flex-shrink:0; }
      .tal-path-v {
        font-weight:500; color:#222; max-width:160px;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        direction:rtl; text-align:left;
      }
      .tal-path-v.tal-path-empty { color:#bbb; font-weight:normal; direction:ltr; }

      /* 调试卡片 */
      .tal-debug-row {
        display:flex; justify-content:space-between; align-items:center;
        font-size:12px; margin-bottom:6px;
      }
      .tal-debug-row .tal-k { color:#aaa; }
      .tal-debug-row input[type="number"] {
        width:72px; padding:2px 6px; font-size:12px;
        border:1px solid #d9d9d9; border-radius:3px;
        text-align:right; outline:none;
      }
      .tal-debug-row input[type="number"]:focus { border-color:#1677ff; }
      .tal-debug-btn {
        background:#fa8c16; font-size:12px; padding:6px 0;
        margin-bottom:0;
      }

      /* 状态栏 */
      .tal-status {
        font-size:12px; color:#888; min-height:16px;
        border-top:1px solid #f0f0f0; padding-top:6px;
      }
      .tal-status.ok      { color:#52c41a; }
      .tal-status.err     { color:#ff4d4f; }
      .tal-status.loading { color:#1677ff; }

      /* 行交互 */
      tr[data-tal-bound]:not(.tal-selected):hover td { background:#e8f0fe !important; cursor:pointer; }
      tr.tal-selected td { background:#c2d9ff !important; }
    `;
    document.head.appendChild(s);
  }

  function buildFab() {
    if (document.getElementById('tal-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'tal-fab';
    fab.innerHTML = '📦<span class="tal-fab-hint">点击展开</span>';
    // mousedown 记起始坐标，click 距离 < 5px 才算真点击；否则视为拖动尾随 click，不展开
    let downX = 0, downY = 0;
    fab.addEventListener('mousedown', e => { downX = e.clientX; downY = e.clientY; });
    fab.addEventListener('click', e => {
      if (Math.abs(e.clientX - downX) < 5 && Math.abs(e.clientY - downY) < 5) showHub(true);
    });
    window.__AgentSellerUtils.makeDraggable(fab, fab);
    document.body.appendChild(fab);
  }

  function buildPanel() {
    if (document.getElementById('tal-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'tal-panel';
    panel.innerHTML = `
      <div class="tal-titlebar" id="tal-titlebar">
        <span id="tal-back" style="display:none;cursor:pointer;" title="返回">←</span>
        <span class="tal-titlebar-title" id="tal-titlebar-title">📦 Temu Auto Label</span>
        <button id="tal-close" title="收起">×</button>
      </div>
      <div id="tal-hub-view">
        <div class="tal-feature-grid" id="tal-feature-grid"></div>
      </div>
      <div id="tal-feature-view" style="display:none"></div>
    `;
    document.body.appendChild(panel);
    window.__AgentSellerUtils.makeDraggable(panel, panel.querySelector('#tal-titlebar'), () => {
      panelTargetBottom = panel.getBoundingClientRect().bottom;
    });

    panel.querySelector('#tal-close').addEventListener('click', hidePanelToFab);
    panel.querySelector('#tal-back').addEventListener('click', () => showHub(false));

    // 监听 panel 尺寸变化，自动保持底部对齐 panelTargetBottom
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(syncPanelBottom).observe(panel);
    }
  }

  function showHub(fromFab = false) {
    const panel = document.getElementById('tal-panel');

    if (fromFab) {
      // positionPanelAtFab 内部需要 display:none 状态来量尺寸，必须在 display:block 之前调
      positionPanelAtFab();
    } else {
      // 从 feature 返回 hub：记录当前底部，切换后重新对齐
      const prevBottom = panel.getBoundingClientRect().bottom;
      document.getElementById('tal-hub-view').style.display     = 'block';
      document.getElementById('tal-feature-view').style.display = 'none';
      panel.style.top = Math.max(8, prevBottom - panel.offsetHeight) + 'px';
    }

    document.getElementById('tal-fab').style.display          = 'none';
    document.getElementById('tal-panel').style.display        = 'block';
    document.getElementById('tal-hub-view').style.display     = 'block';
    document.getElementById('tal-feature-view').style.display = 'none';
    document.getElementById('tal-back').style.display         = 'none';
    document.getElementById('tal-titlebar-title').textContent = '📦 Temu Auto Label';
    state.view = 'hub'; state.feature = null;
  }

  function showFeature(fid) {
    const feat  = window.__AgentSellerRegistry.getFeatures().find(f => f.id === fid);
    const panel = document.getElementById('tal-panel');
    // 记录当前面板底部位置，渲染后保持底部不变
    const prevBottom = panel.getBoundingClientRect().bottom;

    document.getElementById('tal-hub-view').style.display     = 'none';
    document.getElementById('tal-feature-view').style.display = 'block';
    document.getElementById('tal-back').style.display         = 'inline';
    document.getElementById('tal-titlebar-title').textContent = `${feat.icon} ${feat.label}`;
    state.view = 'feature'; state.feature = fid;
    window.__AgentSellerRegistry.renderFeature(fid);

    // 重新对齐：顶部 = 旧底部 - 新高度
    const newTop = Math.max(8, prevBottom - panel.offsetHeight);
    panel.style.top = newTop + 'px';
  }

  function hidePanelToFab() {
    document.getElementById('tal-panel').style.display = 'none';
    document.getElementById('tal-fab').style.display   = 'flex';
    state.view = 'fab';
  }

  function positionPanelAtFab() {
    const fab   = document.getElementById('tal-fab');
    const panel = document.getElementById('tal-panel');
    const r = fab.getBoundingClientRect();
    panel.style.visibility = 'hidden';
    panel.style.display    = 'block';
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    panel.style.display    = 'none';
    panel.style.visibility = '';
    const left = Math.max(8, r.right - pw);
    panelTargetBottom = r.bottom;                       // 锚定底部位置 = FAB 底部
    const top  = Math.max(8, panelTargetBottom - ph);
    panel.style.right  = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left   = left + 'px';
    panel.style.top    = top  + 'px';
  }

  // 内容变化时根据 panelTargetBottom 反算 top，保持底部对齐
  function syncPanelBottom() {
    const panel = document.getElementById('tal-panel');
    if (!panel || panel.style.display === 'none' || !panel.offsetHeight) return;
    if (panelTargetBottom === null) return;
    const ph = panel.offsetHeight;
    const maxTop = window.innerHeight - ph - 8;
    const newTop = Math.max(8, Math.min(panelTargetBottom - ph, maxTop));
    if (Math.abs((parseFloat(panel.style.top) || 0) - newTop) > 0.5) {
      panel.style.top = newTop + 'px';
    }
  }

  // 新增函数：feature 注册时由 registry 调用，重建 hub 网格
  function refreshHub() {
    const grid = document.getElementById('tal-feature-grid');
    if (!grid) return;
    grid.innerHTML = '';
    window.__AgentSellerRegistry.getFeatures().forEach(f => {
      const card = document.createElement('div');
      card.className = 'tal-feature-card' + (f.locked ? ' tal-feature-locked' : '');
      card.title = f.locked ? '开发中' : f.label;
      card.innerHTML = `<span class="tal-ficon">${f.icon}</span><span class="tal-flabel">${f.label}</span>`;
      if (!f.locked) card.addEventListener('click', () => showFeature(f.id));
      grid.appendChild(card);
    });
  }

  // 暴露
  window.__AgentSellerUI = {
    init() { injectStyles(); buildFab(); buildPanel(); },
    showHub,
    showFeature,
    hidePanelToFab,
    refreshHub,
    getState: () => state,
  };
})();
