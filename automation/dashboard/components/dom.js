// dom.js — 共享 DOM 构建工具，组件全用它。无依赖。
// h(): 建元素（tag.class#id + props + children）；icon(): 引 SVG sprite <use>；esc(): 文本转义。
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    // ⚠️ XSS：html prop 仅限内部可信静态字符串（如 sprite '<use href="..."/>'）。
    // 禁止传 store/外部数据——外部文本走 children（createTextNode 安全）或先 esc() 再拼。
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v);
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c == null || c === false) continue;
    el.appendChild(
      typeof c === 'string' || typeof c === 'number'
        ? document.createTextNode(String(c))
        : c,
    );
  }
  return el;
}

// 引 SVG sprite 图标：icon('ic-check', 'spin') → <svg class="ic spin"><use href="#ic-check"/></svg>
export function icon(symbolId, extraClass = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ic' + (extraClass ? ' ' + extraClass : ''));
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + symbolId);
  svg.appendChild(use);
  return svg;
}

// 文本转义（用于把 store 里的字符串安全插入 innerHTML 场景；优先用 textContent/children，本函数兜底）
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
