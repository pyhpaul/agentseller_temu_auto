// 列表切页纯函数。UMD 双模式（node 单测 + 浏览器 window.__AS_DASH_PAGINATE__）。
// 返回 {items, page, totalPages, total}；page 越界钳制、空列表 totalPages=1。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.__AS_DASH_PAGINATE__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function paginate(list, page, pageSize) {
    const arr = Array.isArray(list) ? list : [];
    const size = pageSize > 0 ? pageSize : 20;
    const total = arr.length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const p = Math.min(Math.max(1, (page | 0) || 1), totalPages);
    const start = (p - 1) * size;
    return { items: arr.slice(start, start + size), page: p, totalPages, total };
  }
  return { paginate };
});
