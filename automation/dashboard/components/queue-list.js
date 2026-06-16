// queue-list.js — L1 队列侧栏：接收已过滤+分页的 workflow 列表，扁平渲染 wf-card + 分页控件。
// 过滤/分页在 dashboard.js（filterWorkflows + paginate）；本组件只渲染结果。点 card 切 activeWorkflowId。
import { h, icon } from './dom.js';

const ST_DOT = {
  pending: 'var(--st-pending)', running: 'var(--st-running)', paused: 'var(--st-paused)',
  error: 'var(--st-error)', done: 'var(--st-done)', aborted: 'var(--st-skipped)',
};
const ST_TEXT = {
  pending: '待处理', running: '运行中', paused: '待确认',
  error: '出错', done: '已完成', aborted: '已中止',
};

function miniBar(steps) {
  return h('div', { class: 'mini-bar' }, steps.map(s =>
    h('i', { class: s.status === 'done' ? 'done' : (s.status === 'running' || s.status === 'paused') ? 'run' : '' })));
}

function wfCard(w, activeId, onSelect) {
  const steps = w.steps || [];
  const doneCount = steps.filter(s => s.status === 'done').length;
  return h('div', {
    class: 'wf-card' + (w.id === activeId ? ' active' : ''),
    onClick: () => onSelect(w.id),
  }, [
    h('div', { class: 'name' }, w.product?.label || w.id),
    h('div', { class: 'meta' }, [
      h('span', { class: 'st' }, [
        h('span', { class: 'd', style: 'background:' + (ST_DOT[w.status] || ST_DOT.pending) }),
        ST_TEXT[w.status] || w.status,
      ]),
      h('span', {}, `环节 ${doneCount}/${steps.length}`),
    ]),
    miniBar(steps),
  ]);
}

function pager(page, totalPages, total, onPageChange) {
  return h('div', { class: 'pager' }, [
    h('button', { class: 'pg-btn', disabled: page <= 1 ? 'disabled' : null,
      onClick: () => { if (page > 1) onPageChange(page - 1); } }, '‹'),
    h('span', { class: 'pg-info' }, `${page}/${totalPages}`),
    h('button', { class: 'pg-btn', disabled: page >= totalPages ? 'disabled' : null,
      onClick: () => { if (page < totalPages) onPageChange(page + 1); } }, '›'),
    h('span', { class: 'pg-total' }, `共 ${total}`),
  ]);
}

// paged = { items, page, totalPages, total }（dashboard 传入已过滤分页结果）
export function renderQueueList(mountEl, paged, activeId, onSelect, onPageChange) {
  const { items, page, totalPages, total } = paged;
  const body = items.length
    ? items.map(w => wfCard(w, activeId, onSelect))
    : [h('div', { class: 'side-empty' }, '无匹配商品')];
  mountEl.replaceChildren(h('div', { class: 'queue-flat' }, [
    ...body,
    pager(page, totalPages, total, onPageChange),
  ]));
}
