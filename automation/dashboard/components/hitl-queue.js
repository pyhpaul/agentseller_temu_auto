// hitl-queue.js — ④ 人工介入面板（操作中心）。按 HITL 类型条件渲染可交互控件 + error 态 + 中止按钮。
// 操作回路：按钮 onClick → onAction(act, {getField})，dashboard.js 经 buildHitlMessage 映射成 WF_* 发送。
// 复用 window.__AS_OVERLAY_VIEW__ 纯逻辑（isReviewHitl/hasSuggestion/mergeSuggestion）。
import { h, icon } from './dom.js';

function kvRows(keyValues) {
  const out = [];
  for (const [k, v] of Object.entries(keyValues || {})) {
    out.push(h('span', { class: 'k' }, k));
    out.push(h('span', { class: 'v' }, String(v)));
  }
  return out;
}

// 动作按钮：cls 配色（ok/edit/no），act 动作名，getField 闭包读输入框
function actBtn(cls, ic, text, act, onAction, getField) {
  return h('div', { class: 'btn ' + cls, onClick: () => onAction && onAction(act, { getField }) }, [icon(ic), ' ' + text]);
}

// 回填型字段控件（输入框 + 🧠提议预填）
function fillRows(hitl, view) {
  const rows = [];
  if (view.hasSuggestion(hitl)) {
    const sug = hitl.suggestion;
    rows.push(h('div', { class: 'suggest-note' }, [
      icon('ic-brain'),
      ' 大脑建议（请核对）' + (sug.reason ? '：' + sug.reason : '') +
      (typeof sug.confidence === 'number' ? `（信心 ${sug.confidence}）` : ''),
    ]));
  }
  const merged = view.mergeSuggestion(hitl.fields, hitl.suggestion);
  merged.forEach(f => {
    const labelText = (f.label || f.key) + (f.required ? ' *' : '') + (f.suggestedValue ? ' 🧠' : '');
    let input;
    if (f.fieldType === 'select' && Array.isArray(f.options)) {
      input = h('select', { class: 'fill-input', id: 'dash-fill-' + f.key },
        f.options.map(o => h('option', o === f.suggestedValue ? { value: o, selected: 'selected' } : { value: o }, o)));
    } else {
      input = h('input', {
        class: 'fill-input', id: 'dash-fill-' + f.key,
        type: f.fieldType === 'number' ? 'number' : 'text',
        value: f.suggestedValue || '', placeholder: f.label || f.key,
      });
    }
    rows.push(h('div', { class: 'fill-row' }, [h('label', { class: 'fill-label' }, labelText), input]));
  });
  return rows;
}

// HITL 卡：按类型分支（复核 / 回填 / 纯确认）
function hitlCard(wf, locText, onAction, view, mountEl) {
  const hitl = wf.hitl;
  const getField = (key) => {
    const el = mountEl.querySelector('#dash-fill-' + key);
    return el ? el.value : '';
  };
  const head = h('div', { class: 'h' }, [
    h('span', {}, [icon('ic-alert')]),
    h('span', { class: 'act' }, hitl.action || '待确认'),
    h('span', { class: 'loc' }, locText),
  ]);
  // 复核型（不可逆 hold）
  if (view.isReviewHitl(hitl)) {
    const body = [head];
    if (hitl.reason) body.push(h('div', { class: 'review-reason' }, hitl.reason));
    if (Array.isArray(hitl.concerns) && hitl.concerns.length) {
      body.push(h('ul', { class: 'concerns' }, hitl.concerns.map(c => h('li', {}, String(c)))));
    }
    body.push(h('div', { class: 'hitl-acts' }, [
      actBtn('ok', 'ic-check', '确认提交', 'approve', onAction, getField),
      actBtn('no', 'ic-x', '中止', 'reject', onAction, getField),
    ]));
    return h('div', { class: 'hitl-card review' }, body);
  }
  // 回填型（editable + fields）
  if (hitl.editable && Array.isArray(hitl.fields) && hitl.fields.length) {
    return h('div', { class: 'hitl-card fill' }, [
      head,
      ...fillRows(hitl, view),
      h('div', { class: 'hitl-acts' }, [
        actBtn('ok', 'ic-check', '提交', 'submit', onAction, getField),
        actBtn('edit', 'ic-refresh', '重新建议', 'refresh', onAction, getField),
        actBtn('no', 'ic-x', '拒绝', 'reject', onAction, getField),
      ]),
    ]);
  }
  // 纯确认型
  return h('div', { class: 'hitl-card confirm' }, [
    head,
    h('div', { class: 'kv' }, kvRows(hitl.keyValues)),
    h('div', { class: 'hitl-acts' }, [
      actBtn('ok', 'ic-check', '确认完成', 'confirm', onAction, getField),
      actBtn('no', 'ic-x', '拒绝', 'reject', onAction, getField),
    ]),
  ]);
}

// error 卡：分层错误 + 重试(recoverable)/转人工
const CAT_LABEL = { read: '读取', validate: '校验', business: '业务' };
function errorCard(wf, locText, onAction) {
  const step = (wf.steps || [])[wf.cursor] || {};
  const err = step.error || {};
  const cat = err.category || 'error';
  const noField = () => '';
  const body = [
    h('div', { class: 'h' }, [
      h('span', {}, [icon('ic-alert')]),
      h('span', { class: 'act err ' + cat }, `[${CAT_LABEL[cat] || cat}] ${err.message || '步骤失败'}`),
      h('span', { class: 'loc' }, locText),
    ]),
  ];
  const acts = [];
  if (err.recoverable) acts.push(actBtn('edit', 'ic-refresh', '重试', 'retry', onAction, noField));
  acts.push(actBtn('no', 'ic-x', '转人工', 'reject', onAction, noField));
  body.push(h('div', { class: 'hitl-acts' }, acts));
  return h('div', { class: 'hitl-card error' }, body);
}

// 终态卡（done/aborted）：删除 + 重启三档（重头 / 从当前步 / 任意步下拉）
function finishedCard(wf, onAction) {
  const steps = wf.steps || [];
  const stTxt = wf.status === 'done' ? '已完成' : '已中止';
  const cursor = wf.cursor || 0;
  const sel = h('select', { class: 'fill-input restart-step', id: 'dash-restart-step' },
    steps.map((s, i) => h('option', i === cursor ? { value: String(i), selected: 'selected' } : { value: String(i) }, `${i + 1}. ${s.label}`)));
  const readStep = () => {
    const el = document.getElementById('dash-restart-step');
    return el ? (parseInt(el.value, 10) || 0) : 0;
  };
  return h('div', { class: 'hitl-card finished' }, [
    h('div', { class: 'h' }, [
      h('span', {}, [icon(wf.status === 'done' ? 'ic-check' : 'ic-slash')]),
      h('span', { class: 'act' }, stTxt),
      h('span', { class: 'loc' }, `${steps.filter(s => s.status === 'done').length}/${steps.length} 步`),
    ]),
    h('div', { class: 'restart-row' }, [
      h('div', { class: 'btn ok', onClick: () => onAction && onAction('restart', { fromStep: 0 }) }, [icon('ic-refresh'), ' 重头开始']),
      h('div', { class: 'btn edit', onClick: () => onAction && onAction('restart', { fromStep: cursor }) }, [icon('ic-refresh'), ` 从第${cursor + 1}步`]),
    ]),
    h('div', { class: 'restart-row' }, [
      sel,
      h('div', { class: 'btn edit', onClick: () => onAction && onAction('restart', { fromStep: readStep() }) }, '从选定步'),
    ]),
    h('div', { class: 'hitl-acts' }, [
      h('div', { class: 'btn no', onClick: () => { if (window.confirm('彻底删除该记录？无法恢复')) onAction && onAction('delete', {}); } }, [icon('ic-x'), ' 删除记录']),
    ]),
  ]);
}

export function renderHitlQueue(mountEl, workflow, onAction) {
  const view = window.__AS_OVERLAY_VIEW__;
  const wf = workflow;
  const isPaused = !!(wf && wf.status === 'paused' && wf.hitl);
  const isError = !!(wf && wf.status === 'error');
  const isRunning = !!(wf && wf.status === 'running');
  const isActive = isPaused || isError || isRunning;                       // 可中止
  const isFinished = !!(wf && (wf.status === 'done' || wf.status === 'aborted'));
  const count = (isPaused || isError) ? 1 : 0;
  const head = h('div', { class: 'panel-head' }, [
    icon('ic-pause'), ' 人工介入',
    h('span', { style: 'margin-left:5px;color:var(--st-paused)' }, `(${count})`),
    // 中止：仅 running/paused/error（终态不可中止，改显示删除/重启）
    isActive ? h('div', {
      class: 'btn no abort-btn', style: 'margin-left:auto',
      onClick: () => onAction && onAction('abort', { getField: () => '' }),
    }, [icon('ic-x'), ' 中止批次']) : null,
  ]);
  let locText = '';
  if (wf && typeof wf.cursor === 'number' && wf.cursor >= 0) {
    const cur = (wf.steps || [])[wf.cursor];
    if (cur) locText = `步骤${wf.cursor + 1} · ${cur.label}`;
  }
  let body;
  if (isPaused) body = hitlCard(wf, locText, onAction, view, mountEl);
  else if (isError) body = errorCard(wf, locText, onAction);
  else if (isFinished) body = finishedCard(wf, onAction);
  else if (isRunning) body = h('div', { class: 'hitl-empty' }, `运行中 · ${locText || '推进中'}`);
  else body = h('div', { class: 'hitl-empty' }, '暂无待确认，流程自动推进中');
  mountEl.replaceChildren(h('div', { class: 'panel hitl' }, [head, body]));
}
