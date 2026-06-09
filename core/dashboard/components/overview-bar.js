// overview-bar.js — ① 流程总览条：商品名 + status badge + 进度% + ids + 节点 track。
// 节点 track 按 step 序渲染，done/run(=running 或 cursor 指向) class，paused 步加暂停 ptag。
import { h, icon } from './dom.js';

// workflow.status → badge class + 图标 + 文案
const BADGE = {
  running:  { cls: 'running', ic: 'ic-loader', text: '运行中' },
  paused:   { cls: 'paused',  ic: 'ic-pause',  text: '待确认' },
  done:     { cls: 'done',    ic: 'ic-check',  text: '已完成' },
  error:    { cls: 'error',   ic: 'ic-alert',  text: '出错' },
  pending:  { cls: 'pending', ic: 'ic-circle', text: '待开始' },
  aborted:  { cls: 'error',   ic: 'ic-x',      text: '已中止' },
};

function pct(steps) {
  if (!steps.length) return 0;
  const done = steps.filter(s => s.status === 'done').length;
  return Math.round(done / steps.length * 100);
}

// 节点 class：done→done；running 或 paused（cursor 指向的进行中步）→ run；其余无
function nodeClass(step) {
  if (step.status === 'done') return 'node done';
  if (step.status === 'running' || step.status === 'paused') return 'node run';
  return 'node';
}

function node(step, idx) {
  const cls = nodeClass(step);
  const dotChildren = step.status === 'done'
    ? [icon('ic-check')]
    : [String(idx + 1)];
  const children = [h('div', { class: 'dot' }, dotChildren)];
  if (step.status === 'paused') children.push(h('span', { class: 'ptag' }, [icon('ic-pause')]));
  children.push(h('div', { class: 'lbl' }, step.label));
  return h('div', { class: cls }, children);
}

export function renderOverviewBar(mountEl, workflow) {
  if (!workflow) {
    mountEl.replaceChildren(h('div', { class: 'l2-empty' }, '暂无进行中的流程（多商品规划中）'));
    return;
  }
  const steps = workflow.steps || [];   // 兜底：防 background 半初始化 workflow（无 steps）让监控白屏
  const b = BADGE[workflow.status] || BADGE.pending;
  const p = workflow.product || {};
  mountEl.replaceChildren(
    h('div', { class: 'panel overview' }, [
      h('div', { class: 'ttl' }, [
        h('span', { class: 'pname' }, p.label || workflow.id),
        h('span', { class: 'badge ' + b.cls }, [icon(b.ic), ` ${b.text} · ${pct(steps)}%`]),
      ]),
      h('div', { class: 'ids', style: 'margin-bottom:18px' }, [
        h('span', {}, ['SPU ', h('b', {}, p.spuId || '—')]),
        h('span', {}, ['SKC ', h('b', {}, p.skc || '—')]),
        h('span', {}, ['SKU ', h('b', {}, p.skuNo || '—')]),
      ]),
      h('div', { class: 'track' }, steps.map((s, i) => node(s, i))),
    ]),
  );
}
