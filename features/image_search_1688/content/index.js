(function () {
  'use strict';

  window.AgentSeller.registerFeature({
    id: 'image_search_1688',
    icon: '🔍',
    label: '1688搜图',
    locked: false,
    order: 2,
    init() {},
    render(viewEl) {
      viewEl.innerHTML = '';

      const btn = document.createElement('button');
      btn.className = 'tal-action-btn';
      btn.textContent = '开始截图';

      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '截图中…';
        try {
          const resp = await chrome.runtime.sendMessage({ type: 'IMG_SEARCH_START' });
          if (!resp?.ok) {
            window.AgentSeller.showToast(
              '截图启动失败：' + (resp?.reason || resp?.error || '未知'),
              'error'
            );
          }
        } catch (e) {
          window.AgentSeller.showToast('截图启动失败：' + e.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = '开始截图';
        }
      });

      viewEl.appendChild(btn);

      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:11px;color:#aaa;text-align:center;margin-top:6px;line-height:1.4;';
      hint.textContent = '在页面拖选截图区域，自动跳转 1688 搜图';
      viewEl.appendChild(hint);
    },
  });
})();
