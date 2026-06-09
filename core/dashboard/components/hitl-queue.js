// hitl-queue.js — ④ HITL 待确认。读 workflow.hitl（storage 骨架，含 editable/fieldType/options）。
// 本 Plan 仅渲染卡（keyValues + 复核结论 + 确认/改/拒绝按钮）；确认/改/拒绝的真实 message→background 回路留后续。
import { h, icon } from './dom.js';

function kvRows(keyValues) {
  const out = [];
  for (const [k, v] of Object.entries(keyValues || {})) {
    out.push(h('span', { class: 'k' }, k));
    out.push(h('span', { class: 'v' }, String(v)));
  }
  return out;
}

function hitlCard(hitl, locText, onAction) {
  return h('div', { class: 'hitl-card' }, [
    h('div', { class: 'h' }, [
      h('span', {}, [icon('ic-alert')]),
      h('span', { class: 'act' }, hitl.action || '待确认'),
      h('span', { class: 'loc' }, locText),
    ]),
    h('div', { class: 'kv' }, kvRows(hitl.keyValues)),
    hitl.reviewedBrief
      ? h('div', { class: 'review-note' }, [
          h('span', { class: 'ai' }, [icon('ic-brain'), ' 复核']),
          h('span', {}, hitl.reviewedBrief),
        ])
      : null,
    h('div', { class: 'hitl-acts' }, [
      h('div', { class: 'btn ok', onClick: () => onAction && onAction('confirm', hitl) }, [icon('ic-check'), ' 确认']),
      h('div', { class: 'btn edit', onClick: () => onAction && onAction('modify', hitl) }, [icon('ic-pencil'), ' 改']),
      h('div', { class: 'btn no', onClick: () => onAction && onAction('reject', hitl) }, [icon('ic-x'), ' 拒绝']),
    ]),
  ]);
}

export function renderHitlQueue(mountEl, workflow, onAction) {
  const hitl = workflow && workflow.hitl;
  const count = hitl ? 1 : 0;
  const head = h('div', { class: 'panel-head' }, [
    icon('ic-pause'), ' HITL 待确认',
    h('span', { style: 'margin-left:5px;color:var(--st-paused)' }, `(${count})`),
  ]);
  // 定位文案：cursor 指向的 step seq + label
  let locText = '';
  if (workflow && typeof workflow.cursor === 'number' && workflow.cursor >= 0) {
    const steps = workflow.steps || [];
    const cur = steps[workflow.cursor];
    if (cur) locText = `步骤${workflow.cursor + 1} · ${cur.label}`;
  }
  const body = hitl
    ? hitlCard(hitl, locText, onAction)
    : h('div', { class: 'hitl-empty' }, '暂无待确认，流程自动推进中');
  mountEl.replaceChildren(h('div', { class: 'panel hitl' }, [head, body]));
}
