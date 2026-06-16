// filter-bar.js — 商品列表过滤栏：搜索框 + 状态 chips（常驻）+ 折叠面板（步骤下拉 + 利润率区间）。
// onChange(newCriteria, newUiState) 通知 dashboard；dashboard 持 criteria/uiState，本组件每次全量重建。
// 搜索框焦点：重建会丢焦点，渲染末尾若原焦点在搜索框则 restore（光标置回原位）。
import { h, icon } from './dom.js';

const STATUS_OPTS = [
  { v: 'pending', t: '待处理' }, { v: 'running', t: '运行中' }, { v: 'paused', t: '待确认' },
  { v: 'error', t: '出错' }, { v: 'done', t: '已完成' }, { v: 'aborted', t: '已中止' },
];

export function renderFilterBar(mountEl, criteria, uiState, stepOptions, onChange) {
  const c = criteria;
  const emit = (patch) => onChange(Object.assign({}, c, patch), uiState);
  const emitUi = (patch) => onChange(c, Object.assign({}, uiState, patch));

  // 重建前记录搜索框焦点状态（contains 判当前 active 是否本组件搜索框）
  const ae = document.activeElement;
  const hadFocus = ae && ae.classList && ae.classList.contains('flt-search') && mountEl.contains(ae);
  const caret = hadFocus ? ae.selectionStart : null;

  const search = h('input', {
    class: 'flt-search', type: 'text', placeholder: '🔍 搜索商品名', value: c.text || '',
    onInput: (e) => emit({ text: e.target.value }),
  });

  const allActive = !c.statuses || c.statuses.length === 0;
  const chips = [
    h('div', { class: 'flt-chip' + (allActive ? ' on' : ''), onClick: () => emit({ statuses: [] }) }, '全部'),
    ...STATUS_OPTS.map(o => {
      const on = (c.statuses || []).includes(o.v);
      return h('div', { class: 'flt-chip' + (on ? ' on' : ''), onClick: () => {
        const set = new Set(c.statuses || []);
        on ? set.delete(o.v) : set.add(o.v);
        emit({ statuses: [...set] });
      } }, o.t);
    }),
  ];

  const moreCount = (c.stepId ? 1 : 0) + ((c.marginMin != null || c.marginMax != null) ? 1 : 0);
  const toggle = h('div', { class: 'flt-more', onClick: () => emitUi({ panelOpen: !uiState.panelOpen }) },
    [icon('ic-chevron'), ` 更多筛选 (${moreCount})`]);

  const children = [search, h('div', { class: 'flt-chips' }, chips), toggle];

  if (uiState.panelOpen) {
    const stepSel = h('select', { class: 'flt-step', onChange: (e) => emit({ stepId: e.target.value || null }) },
      [h('option', { value: '' }, '全部步骤'),
       ...(stepOptions || []).map(s => h('option', s.id === c.stepId ? { value: s.id, selected: 'selected' } : { value: s.id }, s.label))]);
    const mMin = h('input', { class: 'flt-margin', type: 'number', placeholder: 'min',
      value: c.marginMin != null ? String(c.marginMin) : '',
      onInput: (e) => emit({ marginMin: e.target.value === '' ? null : Number(e.target.value) }) });
    const mMax = h('input', { class: 'flt-margin', type: 'number', placeholder: 'max',
      value: c.marginMax != null ? String(c.marginMax) : '',
      onInput: (e) => emit({ marginMax: e.target.value === '' ? null : Number(e.target.value) }) });
    children.push(h('div', { class: 'flt-panel' }, [
      h('div', { class: 'flt-row' }, ['步骤 ', stepSel]),
      h('div', { class: 'flt-row' }, ['利润率 ', mMin, ' ~ ', mMax, ' %']),
    ]));
  }

  mountEl.replaceChildren(h('div', { class: 'filter-bar' }, children));

  if (hadFocus) { search.focus(); if (caret != null) try { search.setSelectionRange(caret, caret); } catch (e) {} }
}
