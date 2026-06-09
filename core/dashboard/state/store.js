// dashboard 数据层：合并骨架（storage 全量）+ 血肉（ws 增量）。组件只读 store、订阅变更。
// 纯逻辑、无 DOM、无 chrome API（源在 storage-source/ws-source 接入），便于 node 单测。
// 双模式：node module.exports + 浏览器 window.__AS_DASH_STORE__。
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require : null);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.__AS_DASH_STORE__ = api;
})(typeof self !== 'undefined' ? self : this, function (nodeRequire) {
  'use strict';

  // 取 contract：node 走 require；浏览器走全局（contract.js 先于 store.js 加载）
  const contract = nodeRequire
    ? nodeRequire('../../contract.js')
    : (typeof window !== 'undefined' ? window.__AS_DASH_CONTRACT__ : self.__AS_DASH_CONTRACT__);
  const { emptyBatch, normalizeSkeleton } = contract;

  const DEFAULT_MAX_BRAIN_EVENTS = 500;   // 大脑流上限，超出丢最旧（spec §9.2 storage 写频/内存防膨胀）

  function createStore(opts = {}) {
    const maxBrainEvents = opts.maxBrainEvents || DEFAULT_MAX_BRAIN_EVENTS;

    const state = {
      skeleton: emptyBatch(),   // 骨架（storage）：全量替换
      brainEvents: [],          // 血肉（ws）：增量 append + 限流
      hitlDetail: null,         // 血肉（ws）：当前 HITL 详情，按 hitlId 覆盖
      wsStatus: 'offline',      // 'live' | 'reconnecting' | 'offline'（顶栏 WS 灯；本 Plan mock 恒 'offline'）
    };

    const subs = new Set();
    function notify() {
      for (const cb of subs) {
        try { cb(state); } catch (e) { console.error('[dash-store] 订阅回调异常', e); }
      }
    }

    return {
      getState() { return state; },

      subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },

      // 骨架全量替换（storage-source 每次 onChanged 调用）；非法值兜底空 batch
      setSkeleton(raw) {
        state.skeleton = normalizeSkeleton(raw);
        notify();
      },

      // 大脑流增量 append + 限流（ws-source / mock 喂）；超上限丢最旧
      appendBrainEvent(ev) {
        state.brainEvents.push(ev);
        if (state.brainEvents.length > maxBrainEvents) {
          state.brainEvents.splice(0, state.brainEvents.length - maxBrainEvents);
        }
        notify();
      },

      // HITL 详情按 hitlId 覆盖（ws-source / mock 喂）
      setHitlDetail(detail) {
        state.hitlDetail = detail;
        notify();
      },

      setWsStatus(status) {
        state.wsStatus = status;
        notify();
      },
    };
  }

  return { createStore };
});
