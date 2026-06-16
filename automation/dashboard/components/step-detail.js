// step-detail.js — 选中步详情面板。点环节列表任意步（含已完成的上一步）→ 显示该步产物/状态/报错/指引。
// 数据全来自 step（result/error/guide/status/timing），不引入新状态源；selectedStepId 为空则清空（收起）。
import { h } from './dom.js';

const ST_LABEL = {
  done: '已完成', running: '运行中', paused: '待确认',
  pending: '待执行', error: '出错', skipped: '已跳过',
};

function fmtTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); } catch (_) { return String(ts); }
}

// 产物 key-values（对象值 JSON 串化，避免 [object Object]）
function kvRows(obj) {
  return Object.entries(obj || {}).map(([k, v]) =>
    h('div', { class: 'sd-kv' }, [
      h('span', { class: 'sd-k' }, k),
      h('span', { class: 'sd-v' }, typeof v === 'object' ? JSON.stringify(v) : String(v)),
    ]));
}

export function renderStepDetail(mountEl, workflow, selectedStepId, onClose) {
  if (!workflow || !selectedStepId) { mountEl.replaceChildren(); return; }
  const step = (workflow.steps || []).find(s => s.id === selectedStepId);
  if (!step) { mountEl.replaceChildren(); return; }

  const inner = [
    h('div', { class: 'sd-status' }, '状态：' + (ST_LABEL[step.status] || step.status)),
  ];
  if (step.guide) inner.push(h('div', { class: 'hitl-guide' }, '📋 操作指引：' + step.guide));

  // 产物
  const result = step.result && Object.keys(step.result).length ? step.result : null;
  inner.push(h('div', { class: 'sd-sec' }, '产物'));
  if (result) inner.push(...kvRows(result));
  else inner.push(h('div', { class: 'sd-empty' }, step.status === 'done' ? '（该步无产物字段）' : '（尚未产出）'));

  // 报错（若有）
  if (step.error) {
    inner.push(h('div', { class: 'sd-sec err' }, '报错'));
    inner.push(h('div', { class: 'sd-err' }, '[' + (step.error.category || '') + '] ' + (step.error.message || '')));
  }

  // 耗时
  inner.push(h('div', { class: 'sd-time' }, '开始 ' + fmtTime(step.startedAt) + ' · 结束 ' + fmtTime(step.endedAt)));

  const head = h('div', { class: 'panel-head' }, [
    h('span', {}, '🔎 步骤详情 · ' + step.label),
    h('div', { class: 'btn no', style: 'margin-left:auto', onClick: () => onClose && onClose() }, '↩ 返回人工介入'),
  ]);
  mountEl.replaceChildren(
    h('div', { class: 'panel step-detail' }, [head, h('div', { class: 'panel-body sd' }, inner)]),
  );
}
