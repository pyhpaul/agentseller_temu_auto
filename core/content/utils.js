// core/content/utils.js — 公共工具集，挂载到 window.__AgentSellerUtils
(function () {
  'use strict';

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function ensureExtensionAlive() {
    if (!chrome?.runtime?.id) throw new Error('插件已重载，请刷新页面后重试');
  }

  function waitForEl(selector, root = document, timeout = 12000) {
    return new Promise((resolve, reject) => {
      const target = root === document ? document.body : root;
      const found = target.querySelector(selector);
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const el = target.querySelector(selector);
        if (el) { cleanup(); resolve(el); }
      });
      const timer = setTimeout(() => { cleanup(); reject(new Error(`超时: ${selector}`)); }, timeout);
      function cleanup() { obs.disconnect(); clearTimeout(timer); }
      obs.observe(target, { childList: true, subtree: true });
    });
  }

  function normText(s) { return (s || '').replace(/\s/g, ''); }

  function findByText(selector, text, root = document) {
    const norm = normText(text);
    return Array.from(root.querySelectorAll(selector))
      .find(el => normText(el.textContent).includes(norm)) || null;
  }

  function setInputValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function showToast(msg, type = 'info') {
    let t = document.getElementById('tal-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'tal-toast';
      Object.assign(t.style, {
        position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
        zIndex: '999999', padding: '10px 24px', borderRadius: '6px',
        fontSize: '13px', fontFamily: '-apple-system,sans-serif',
        boxShadow: '0 4px 14px rgba(0,0,0,.22)', maxWidth: '420px',
        textAlign: 'center', transition: 'opacity .3s', pointerEvents: 'none',
      });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = type === 'err' ? '#ff4d4f' : type === 'ok' ? '#52c41a' : '#1677ff';
    t.style.color = '#fff';
    t.style.display = 'block';
    t.style.opacity = '1';
    if (type === 'ok') setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => { t.style.display = 'none'; }, 300);
    }, 3000);
  }

  function makeDraggable(el, handle, onDragEnd) {
    let ox, oy, ol, ot;
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button') && e.target.id !== 'tal-fab') return;
      const r = el.getBoundingClientRect();
      ox = e.clientX; oy = e.clientY; ol = r.left; ot = r.top;
      el.style.right = 'auto'; el.style.bottom = 'auto';
      el.style.left = ol + 'px'; el.style.top = ot + 'px';
      let dragged = false;
      const move = e => {
        dragged = true;
        el.style.left = Math.max(0, Math.min(ol + e.clientX - ox, window.innerWidth  - el.offsetWidth))  + 'px';
        el.style.top  = Math.max(0, Math.min(ot + e.clientY - oy, window.innerHeight - el.offsetHeight)) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (dragged && typeof onDragEnd === 'function') onDragEnd();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      e.preventDefault();
    });
  }

  // 暴露
  window.__AgentSellerUtils = {
    sleep, ensureExtensionAlive, waitForEl, normText,
    findByText, setInputValue, showToast, makeDraggable,
  };
})();
