// core/background/orchestrator/mutation-queue.js
// storage 写入串行化队列：read→mutate→write 串行，防多触发源交错 lost-update。spec §2.3。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.__AS_ORCH_MQ__ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function makeMutationQueue(read, write) {
    let chain = Promise.resolve();
    function enqueue(mutator) {
      const run = chain.then(async () => {
        const cur = await read();
        const next = await mutator(cur);          // mutator 负责字段级合并并返回新值
        if (next !== undefined) await write(next);
        return next;
      });
      // 链不因单个 mutator 抛错而断（吞错只为保持链活；调用方仍能从 run 拿到 rejection）
      chain = run.catch(() => {});
      return run;
    }
    return { enqueue };
  }

  return { makeMutationQueue };
});
