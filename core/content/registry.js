// core/content/registry.js — feature 注册中心 + 页面变化分发 + AgentSeller API
(function () {
  'use strict';

  const features = [];                  // [{id, icon, label, locked, order, init, render}]
  const featureById = new Map();
  const pageChangeListeners = [];

  function registerFeature(def) {
    if (!def || !def.id) throw new Error('registerFeature: 缺少 id');
    if (featureById.has(def.id)) {
      console.warn('[AgentSeller] feature 已注册，跳过:', def.id);
      return;
    }
    features.push(def);
    featureById.set(def.id, def);
    features.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

    // 触发 feature.init（feature 在 init 里通常注册 onPageChange / 绑定行点击等长期任务）
    if (typeof def.init === 'function') {
      try { def.init({}); } catch (e) { console.error(`[${def.id}] init 异常`, e); }
    }

    // 刷新 hub UI
    if (window.__AgentSellerUI?.refreshHub) window.__AgentSellerUI.refreshHub();
  }

  function renderFeature(fid) {
    const def = featureById.get(fid);
    if (!def) return;
    const viewEl = document.getElementById('tal-feature-view');
    if (!viewEl) return;
    if (typeof def.render === 'function') {
      try { def.render(viewEl, {}); } catch (e) { console.error(`[${fid}] render 异常`, e); }
    }
  }

  function getFeatures() { return features.slice(); }

  function onPageChange(cb) { pageChangeListeners.push(cb); }

  function dispatchPageChange() {
    const href = location.href;
    pageChangeListeners.forEach(cb => {
      try { cb(href); } catch (e) { console.error('[AgentSeller] pageChange 回调异常', e); }
    });
  }

  function hookHistory() {
    const wrap = fn => function (...args) { fn.apply(this, args); setTimeout(dispatchPageChange, 300); };
    history.pushState    = wrap(history.pushState.bind(history));
    history.replaceState = wrap(history.replaceState.bind(history));
    window.addEventListener('popstate', () => setTimeout(dispatchPageChange, 300));
  }

  async function sendNative(action, data) {
    if (!chrome?.runtime?.id) throw new Error('插件已重载，请刷新页面后重试');
    const resp = await chrome.runtime.sendMessage({ type: action, data });
    if (!resp?.success) throw new Error(resp?.error || `${action} 失败`);
    return resp.result;
  }

  // 暴露 registry 内部接口给 ui.js 使用
  window.__AgentSellerRegistry = { getFeatures, renderFeature, dispatchPageChange, hookHistory };

  // 公开 API：feature 业务代码使用
  window.AgentSeller = {
    registerFeature,
    onPageChange,
    showToast: (...args) => window.__AgentSellerUtils.showToast(...args),
    utils: null,  // 由 core.js 在初始化时填入
    sendNative,
    // 程序化打开 feature view（reload 后自动续跑场景：feature 主动展开 UI 让用户看到状态）
    openFeature: (fid) => {
      const ui = window.__AgentSellerUI;
      if (!ui) return;
      const view = ui.getState().view;
      if (view === 'fab') ui.showHub(true);  // FAB → 先展开 Panel 到 Hub
      ui.showFeature(fid);                    // 再切到 feature view
    },
  };
})();
