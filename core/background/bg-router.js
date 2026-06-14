// core/background/bg-router.js — bg 命令前缀路由（纯逻辑，可 node --test）
// feature background handler + automation bg 入口都经 register(prefix, fn) 注册；
// route 按注册顺序首个匹配（精确 type 或 type.startsWith(prefix)）分发，未匹配返回 false。
(function (root) {
  'use strict';
  function makeBgRouter() {
    const handlers = [];  // [{ prefix, fn }]，注册顺序即优先级
    return {
      register(prefix, fn) {
        if (typeof prefix !== 'string' || typeof fn !== 'function') {
          throw new Error('bg-router.register: 需要 (string, function)');
        }
        if (prefix.length === 0) throw new Error('bg-router.register: prefix 不能为空串（会拦截所有消息）');
        handlers.push({ prefix, fn });
      },
      route(msg, sender, sendResponse) {
        const type = msg && msg.type;
        if (typeof type !== 'string') return false;
        for (const { prefix, fn } of handlers) {
          if (type === prefix || type.startsWith(prefix)) {
            return fn(msg, sender, sendResponse);
          }
        }
        return false;
      },
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { makeBgRouter };
  else root.__AS_BG_ROUTER__ = { makeBgRouter };   // SW world: self.__AS_BG_ROUTER__
})(typeof self !== 'undefined' ? self : this);
