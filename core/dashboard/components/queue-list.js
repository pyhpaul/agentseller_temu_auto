// queue-list.js — L1 队列侧栏：按 workflow.status 分「进行中/待处理/已完成」三组，渲染 wf-card。
// 点 card 切 activeWorkflowId（发回调，dashboard.js 接管重渲）。本 Plan mock 仅 1 个 workflow。
import { h, icon } from './dom.js';

// status → 侧栏状态点颜色 + 中文（spec §5.3 状态色板）
const ST_DOT = {
  pending: 'var(--st-pending)', running: 'var(--st-running)', paused: 'var(--st-paused)',
  error: 'var(--st-error)', done: 'var(--st-done)', aborted: 'var(--st-skipped)',
};
const ST_TEXT = {
  pending: '待处理', running: '运行中', paused: '待确认',
  error: '出错', done: '已完成', aborted: '已中止',
};

// 分组：进行中(running/paused/error) / 待处理(pending) / 已完成(done/aborted)
function groupWorkflows(workflows) {
  const active = [], todo = [], finished = [];
  for (const w of workflows) {
    if (w.status === 'pending') todo.push(w);
    else if (w.status === 'done' || w.status === 'aborted') finished.push(w);
    else active.push(w);
  }
  return { active, todo, finished };
}

function miniBar(steps) {
  return h('div', { class: 'mini-bar' }, steps.map(s =>
    h('i', { class: s.status === 'done' ? 'done' : (s.status === 'running' || s.status === 'paused') ? 'run' : '' })));
}

function wfCard(w, activeId, onSelect) {
  const steps = w.steps || [];   // 兜底：防无 steps 崩
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

function group(title, count, dotColor, cards) {
  const titleChildren = [];
  if (dotColor) titleChildren.push(h('span', { class: 'd', style: `width:7px;height:7px;border-radius:50%;background:${dotColor};display:inline-block` }));
  titleChildren.push(title + ' ');
  titleChildren.push(h('span', { class: 'count' }, String(count)));
  return h('div', { class: 'side-group' }, [
    h('div', { class: 'side-group-title' }, titleChildren),
    ...(cards.length ? cards : [h('div', { class: 'side-empty' }, '暂无')]),
  ]);
}

export function renderQueueList(mountEl, state, onSelect) {
  const workflows = state.skeleton.batch.workflows || [];
  const activeId = state.skeleton.batch.activeWorkflowId;
  const { active, todo, finished } = groupWorkflows(workflows);

  mountEl.replaceChildren(
    group('进行中', active.length, 'var(--st-running)', active.map(w => wfCard(w, activeId, onSelect))),
    group('待处理', todo.length, null, todo.map(w => wfCard(w, activeId, onSelect))),
    group('已完成', finished.length, null, finished.map(w => wfCard(w, activeId, onSelect))),
    h('div', { class: 'side-new' }, [icon('ic-plus'), ' 新建流程（规划中）']),
  );
}
