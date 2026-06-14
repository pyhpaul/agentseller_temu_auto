// brain-stream.js — ③ 大脑实时流。增量 append（不全量重渲）：维护已渲染游标，只追加新事件，自动滚底。
// kind ∈ review|diagnose|selfheal|log，对应 .bevent.<kind> 着色（spec §5.3）。
import { h, icon } from './dom.js';

function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function beventRow(ev) {
  const body = [h('span', { class: 'kind' }, ev.kind)];
  body.push(ev.text || '');
  if (ev.anchor) body.push(h('span', { class: 'anchor' }, ev.anchor));
  return h('div', { class: 'bevent ' + (ev.kind || 'log') }, [
    h('span', { class: 'ts' }, fmtTs(ev.ts)),
    h('div', { class: 'body' }, body),
  ]);
}

// 创建组件实例：首次建固定外壳（panel-head/body/foot），返回 update(state) 做增量 append。
// dashboard.js 对大脑流调 update（增量），不调全量 render。
export function createBrainStream(mountEl) {
  const bodyEl = h('div', { class: 'panel-body' });
  let autoScroll = true;   // 仅用户接近底部时自动滚底；上滚读历史时暂停，避免被新事件/骨架更新打断
  bodyEl.addEventListener('scroll', () => {
    autoScroll = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 40;
  });
  const panel = h('div', { class: 'panel brain' }, [
    h('div', { class: 'panel-head' }, [
      icon('ic-brain'), ' 大脑实时流',
      h('div', { class: 'tools' }, [
        h('span', { class: 'chip-btn', onClick: () => { autoScroll = true; bodyEl.scrollTop = bodyEl.scrollHeight; } }, [icon('ic-pause'), ' 自动滚动']),
        h('span', { class: 'chip-btn' }, '折叠 log'),
      ]),
    ]),
    bodyEl,
    h('div', { class: 'foot' }, [h('span', { class: 'live' }), '实时接收中…']),
  ]);
  mountEl.replaceChildren(panel);

  let rendered = 0;   // 已渲染条数游标
  function update(state) {
    const events = state.brainEvents || [];
    // store.appendBrainEvent 只原地 push/splice（不整体替换引用），故无「等长但内容不同」场景；
    // 仅当限流裁掉最旧条目使 events 变短时 rendered 超出，需清空重建。
    if (rendered > events.length) { bodyEl.replaceChildren(); rendered = 0; }
    for (let i = rendered; i < events.length; i++) bodyEl.appendChild(beventRow(events[i]));
    rendered = events.length;
    if (autoScroll) bodyEl.scrollTop = bodyEl.scrollHeight;   // 仅用户在底部时自动滚，上滚读历史不打断
  }
  return { update };
}
