// create_purchase_order —— 创建采购单 Phase 1
// 跑在 temu/1688/店小秘 三域：注册 feature + 输入 UI + 进度面板 + bg 命令处理器。
(function () {
  'use strict';

  const L = window.__CPOLogic;                 // Task 1 的纯逻辑（document_start 已挂）
  const U = window.AgentSeller.utils;          // sleep/waitForEl/findByText/setInputValue
  const FID = 'create_purchase_order';

  // ── 进度面板状态（只在起点 temu tab 有意义，其它域不渲染进度） ──
  let progressEl = null;
  function setProgress(text, kind = 'info') {
    if (!progressEl) return;
    progressEl.textContent = text;
    progressEl.style.color = kind === 'error' ? '#ff4d4f' : kind === 'done' ? '#52c41a' : '#666';
  }

  // ── feature 注册 + Hub 输入 UI ──
  window.AgentSeller.registerFeature({
    id: FID,
    icon: '🛒',
    label: '创建采购单',
    locked: false,
    order: 5,
    init() {},
    render(viewEl) {
      viewEl.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

      const skcInput = document.createElement('input');
      skcInput.placeholder = 'SKC编码';
      skcInput.className = 'tal-input';
      skcInput.style.cssText = 'padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;';

      const urlInput = document.createElement('input');
      urlInput.placeholder = '1688商品url';
      urlInput.className = 'tal-input';
      urlInput.style.cssText = skcInput.style.cssText;

      const btn = document.createElement('button');
      btn.className = 'tal-action-btn';
      btn.textContent = '开始';

      progressEl = document.createElement('div');
      progressEl.style.cssText = 'font-size:12px;color:#666;line-height:1.5;min-height:18px;';

      btn.addEventListener('click', async () => {
        const skc = skcInput.value.trim();
        const url1688 = urlInput.value.trim();
        const v = L.validateInputs({ skc, url1688 });   // 本地先校验，避免无谓启动
        if (!v.ok) { setProgress(v.error, 'error'); return; }
        btn.disabled = true;
        setProgress('启动中…');
        try {
          const resp = await chrome.runtime.sendMessage({ type: 'CPO_START', data: { skc, url1688 } });
          if (!resp?.ok) { setProgress(resp?.error || '启动失败', 'error'); btn.disabled = false; }
        } catch (e) {
          setProgress('启动失败：' + e.message, 'error');
          btn.disabled = false;
        }
      });

      wrap.append(skcInput, urlInput, btn, progressEl);
      viewEl.appendChild(wrap);
    },
  });

  // ── bg → content 命令处理器（6 个，Task 4-7 填实现，这里先占位返回 not_implemented） ──
  const handlers = {
    CPO_READ_1688_TITLE: async () => ({ ok: false, error: 'not_implemented: CPO_READ_1688_TITLE' }),
    CPO_QUERY_SKC_GET_NO: async (_data) => ({ ok: false, error: 'not_implemented: CPO_QUERY_SKC_GET_NO' }),
    CPO_CLICK_EDIT: async (_data) => ({ ok: false, error: 'not_implemented: CPO_CLICK_EDIT' }),
    CPO_GRAB_PREVIEW: async () => ({ ok: false, error: 'not_implemented: CPO_GRAB_PREVIEW' }),
    CPO_DXM_OPEN_ADD: async () => ({ ok: false, error: 'not_implemented: CPO_DXM_OPEN_ADD' }),
    CPO_FILL_DXM: async (_data) => ({ ok: false, error: 'not_implemented: CPO_FILL_DXM' }),
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // 进度推送（起点 tab 接收，无需回 response）
    if (msg.type === 'CPO_PROGRESS') { setProgress(`步骤${msg.step}：${msg.label}`); return; }
    if (msg.type === 'CPO_DONE')     { setProgress('已填好，请在店小秘页核对后保存', 'done'); return; }
    if (msg.type === 'CPO_ERROR')    { setProgress(`步骤${msg.step}失败：${msg.message}`, 'error'); return; }

    const h = handlers[msg.type];
    if (!h) return;                                  // 非本 feature 命令，放行
    h(msg.data).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;                                     // 异步通道
  });
})();
