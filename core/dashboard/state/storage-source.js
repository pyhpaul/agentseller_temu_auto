// storage-source.js — 订阅真实 chrome.storage.local['as_workflow_state']，喂 store 骨架。
// 缺失时纯内存兜底（emptyBatch）渲染空态，不写回 storage（§2.3：前端只读，初始化由 background 负责）。
const { STORAGE_KEY, emptyBatch } = window.__AS_DASH_CONTRACT__;

// 把读到的值灌进 store；store.setSkeleton 内部 normalizeSkeleton 已兜底非法值
function pushToStore(store, raw) {
  store.setSkeleton(raw);
}

export function startStorageSource(store) {
  // 首读：缺失 → 纯内存空骨架渲染空态（绝不写 storage，前端只读，符合 §2.3）
  chrome.storage.local.get(STORAGE_KEY).then((res) => {
    const raw = res[STORAGE_KEY];
    pushToStore(store, raw === undefined ? emptyBatch() : raw);
  }).catch((e) => {
    console.error('[storage-source] 首读失败', e);
    pushToStore(store, emptyBatch());   // 读失败也给空骨架，组件渲染空态而非崩
  });

  // onChanged 订阅：background 后续每次写 as_workflow_state 都全量重灌（骨架全量重渲）
  const onChanged = (changes, area) => {
    if (area !== 'local' || !(STORAGE_KEY in changes)) return;
    pushToStore(store, changes[STORAGE_KEY].newValue);
  };
  chrome.storage.onChanged.addListener(onChanged);

  return () => chrome.storage.onChanged.removeListener(onChanged);   // 停止订阅句柄
}
