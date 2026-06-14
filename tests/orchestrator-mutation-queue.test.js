// tests/orchestrator-mutation-queue.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { makeMutationQueue } = require('../automation/orchestrator/mutation-queue.js');

// 模拟异步 storage：read/write 各有延迟，制造交错机会
function fakeStore(initial) {
  let val = initial;
  return {
    read: () => new Promise(r => setTimeout(() => r(val), 5)),
    write: (v) => new Promise(r => setTimeout(() => { val = v; r(); }, 5)),
    peek: () => val,
  };
}

test('串行化：两个并发 enqueue 不交错（后者看到前者的写）', async () => {
  const store = fakeStore({ n: 0 });
  const q = makeMutationQueue(store.read, store.write);
  await Promise.all([
    q.enqueue(cur => ({ n: cur.n + 1 })),
    q.enqueue(cur => ({ n: cur.n + 1 })),
  ]);
  assert.strictEqual(store.peek().n, 2);   // 若交错（lost-update）会是 1
});

test('字段级合并：mutator 只改一个字段，其他字段保留', async () => {
  const store = fakeStore({ a: 1, b: 2 });
  const q = makeMutationQueue(store.read, store.write);
  await q.enqueue(cur => ({ ...cur, a: 9 }));
  assert.deepStrictEqual(store.peek(), { a: 9, b: 2 });
});

test('mutator 返回 undefined → 跳过 write（只读不写）', async () => {
  let writes = 0;
  const q = makeMutationQueue(async () => ({ n: 1 }), async () => { writes++; });
  await q.enqueue(() => undefined);
  assert.strictEqual(writes, 0);
});

test('enqueue 返回的 promise 解析为 mutator 结果', async () => {
  const store = fakeStore({ n: 0 });
  const q = makeMutationQueue(store.read, store.write);
  const res = await q.enqueue(cur => ({ n: cur.n + 5 }));
  assert.deepStrictEqual(res, { n: 5 });
});

test('一个 mutator 抛错不卡死队列（后续仍执行）', async () => {
  const store = fakeStore({ n: 0 });
  const q = makeMutationQueue(store.read, store.write);
  await q.enqueue(() => { throw new Error('boom'); }).catch(() => {});
  await q.enqueue(cur => ({ n: cur.n + 1 }));
  assert.strictEqual(store.peek().n, 1);
});
