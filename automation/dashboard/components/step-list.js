// step-list.js — ② 环节列表。按 step.status 渲染行 class + 图标。
// 关键契约（spec §4.1/§6.1）：status==='paused' 显式渲染 HITL 橙标记 + 暂停图标，不复刻原型 run+tag 隐式约定。
import { h, icon } from './dom.js';
import { errorChip } from './error-chip.js';

// status → { 行 class, 图标 symbol, 图标是否旋转 }
const ST = {
  done:    { cls: 'done',    ic: 'ic-check',  spin: false },
  running: { cls: 'run',     ic: 'ic-loader', spin: true },
  paused:  { cls: 'paused',  ic: 'ic-pause',  spin: false },
  pending: { cls: 'pending', ic: 'ic-circle', spin: false },
  error:   { cls: 'error',   ic: 'ic-alert',  spin: false },
  skipped: { cls: 'skip',    ic: 'ic-slash',  spin: false },
};

// 右侧附加块：brainBrief（selfheal 高亮）/ 产物 tag / HITL 待确认 tag / error chip / skipped note
function rightBlock(step) {
  const items = [];
  // brainBrief：'selfheal:...' 把 selfheal 前缀加粗（原型 .brief b 着 selfheal 色）
  if (step.brainBrief) {
    const m = /^selfheal[:：]?(.*)$/.exec(step.brainBrief);
    if (m) items.push(h('span', { class: 'brief' }, [h('b', {}, 'selfheal'), '·' + m[1].trim()]));
    else items.push(h('span', { class: 'brief' }, step.brainBrief));
  }
  // 产物 tag（有 result 且非空时可点开看，本 Plan 仅展示，不绑展开）
  if (step.result && Object.keys(step.result).length) {
    items.push(h('span', { class: 'tag prod' }, ['产物 ', icon('ic-chevron')]));
  }
  // 显式 HITL 标记：status==='paused' → 橙「待确认」tag（契约要求，非原型 run+tag）
  if (step.status === 'paused') {
    items.push(h('span', { class: 'tag hitl' }, [icon('ic-pause'), ' 待确认']));
  }
  // error chip（三分层）
  const chip = errorChip(step.error);
  if (chip) items.push(chip);
  // skipped note（原型「已跳过 · 本批不导出」）
  if (step.status === 'skipped' && step.note) {
    items.push(h('span', {}, '已跳过 · ' + step.note));
  }
  return items.length ? h('div', { class: 'right' }, items) : null;
}

function stepRow(step, idx, selectedId, onSelect) {
  const meta = ST[step.status] || ST.pending;
  const children = [
    h('span', { class: 'ico' }, [icon(meta.ic, meta.spin ? 'spin' : '')]),
    h('span', { class: 'seq' }, String(idx + 1)),
    h('span', { class: 'nm' }, step.label),
  ];
  const right = rightBlock(step);
  if (right) children.push(right);
  return h('div', {
    class: 'step ' + meta.cls + (step.id === selectedId ? ' sel' : ''),
    onClick: () => onSelect && onSelect(step.id),
  }, children);
}

export function renderStepList(mountEl, workflow, selectedStepId, onSelect) {
  if (!workflow) { mountEl.replaceChildren(); return; }
  const steps = workflow.steps || [];   // 兜底：防 background 半初始化 workflow（无 steps）让监控白屏
  mountEl.replaceChildren(
    h('div', { class: 'panel steps' }, [
      h('div', { class: 'panel-head' }, '📋 环节列表'),
      h('div', { class: 'panel-body' }, steps.map((s, i) => stepRow(s, i, selectedStepId, onSelect))),
    ]),
  );
}
