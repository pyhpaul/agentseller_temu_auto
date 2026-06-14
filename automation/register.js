// automation/register.js — automation 接入 hub（content world）。仅当 automation/ 被装配时注入。
(function () {
  'use strict';
  if (!window.AgentSeller?.registerExtension) return;
  window.AgentSeller.registerExtension({
    id: 'automation',
    panelButtons: [{
      id: 'open-monitor', icon: '📊', label: '打开监控',
      onClick: async () => {
        if (!chrome?.runtime?.id) { window.__AgentSellerUtils?.showToast('插件已重载，请刷新页面后重试', 'err'); return; }
        try {
          const resp = await chrome.runtime.sendMessage({ type: 'OPEN_MONITOR' });
          if (!resp?.success) throw new Error(resp?.error || '打开监控失败');
        } catch (e) { window.__AgentSellerUtils?.showToast('打开监控失败：' + (e?.message || e), 'err'); }
      },
    }],
  });
})();
