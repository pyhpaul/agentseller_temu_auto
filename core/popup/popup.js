const statusEl = document.getElementById('status');

chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
  if (chrome.runtime.lastError || !res) {
    setStatus('无法连接 Service Worker', 'err');
    return;
  }
  setStatus(res.connected ? 'Native Host 已连接 ✓' : '等待页面操作...', res.connected ? 'ok' : '');
});

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = cls;
}
