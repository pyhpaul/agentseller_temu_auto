// topbar.js — 顶栏：brand / 批次标签 / WS 灯 / 置顶 / 刷新。读 state.skeleton.batch + state.wsStatus。
import { h, icon } from './dom.js';

// WS 灯三态文案（spec §6.4：绿连接/黄重连/红断开）
const WS_LABEL = { live: '实时', reconnecting: '重连中', offline: '离线' };
const WS_DOT_CLS = { live: 'live', reconnecting: 'reconnecting', offline: 'offline' };

function fmtBatchLabel(batch) {
  if (!batch || !batch.id) return '无批次';
  const t = batch.createdAt ? new Date(batch.createdAt) : null;
  const time = t && !isNaN(t.getTime()) ? `${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '';
  return `批次 #${batch.id}${time ? ' · ' + time : ''}`;
}

export function renderTopbar(mountEl, state) {
  const batch = state.skeleton.batch;
  const ws = state.wsStatus || 'offline';

  mountEl.replaceChildren(
    h('div', { class: 'brand' }, [
      h('span', { class: 'logo' }, [icon('ic-box')]),
      'AgentSeller 自动化监控',
    ]),
    h('span', { class: 'batch' }, fmtBatchLabel(batch)),
    h('div', { class: 'spacer' }),
    h('div', { class: 'ctl' }, [
      h('span', { class: 'ws-dot' + (WS_DOT_CLS[ws] ? ' ' + WS_DOT_CLS[ws] : ' offline') }),
      WS_LABEL[ws] || '离线',
    ]),
    h('div', { class: 'ctl', onClick: () => window.__AS_DASH_TOGGLE_PIN && window.__AS_DASH_TOGGLE_PIN() }, [icon('ic-pin'), ' 置顶']),
    h('div', { class: 'ctl', onClick: () => location.reload() }, [icon('ic-refresh'), ' 刷新']),
  );
}
