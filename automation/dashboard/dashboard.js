// dashboard.js — ES module 入口。装配 store + 源 + 组件，订阅 store 重渲。
// 骨架（topbar/queue-list/overview-bar/step-list/hitl-queue）全量重渲；大脑流增量 append（独立 update）。
// 数据源：storage-source（真实 chrome.storage）+ ws-source（先连真实 WS，连不上降级 mock 回放）。
import { renderTopbar } from './components/topbar.js';
import { renderQueueList } from './components/queue-list.js';
import { renderOverviewBar } from './components/overview-bar.js';
import { renderStepList } from './components/step-list.js';
import { createBrainStream } from './components/brain-stream.js';
import { renderHitlQueue } from './components/hitl-queue.js';
import { startStorageSource } from './state/storage-source.js';
import { startWsSource } from './state/ws-source.js';

const { createStore } = window.__AS_DASH_STORE__;
const { selectActiveWorkflow } = window.__AS_DASH_SELECT__;

const store = createStore();

// L2 content 布局骨架：① overview-bar 满宽 + l2-cols 两列（左 step-list，右 brain-stream + hitl-queue）。
// 这些挂载点只建一次；组件每次重渲只替换各自挂载点内部。
const contentEl = document.getElementById('content');
const overviewMount = document.createElement('div');
const stepMount = document.createElement('div');
const brainMount = document.createElement('div');
const hitlMount = document.createElement('div');

const rCol = document.createElement('div');
rCol.className = 'r-col';
rCol.style.cssText = 'display:flex;flex-direction:column;gap:14px';
rCol.append(brainMount, hitlMount);

const l2cols = document.createElement('div');
l2cols.className = 'l2-cols';
l2cols.append(stepMount, rCol);

contentEl.append(overviewMount, l2cols);

// 启动入口（自动化操作集中在 dashboard；业务页 overlay 不再常驻空态入口、不挡 hub）。
// label 必填 → 发 WF_START 给 SW（automation/bg-entry 的 WF_ handler 起编排，与原 overlay 启动同消息）。
(function mountStartBar() {
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid #30363d';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '商品 label（必填）';
  input.style.cssText = 'flex:0 0 280px;padding:6px 10px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;font:13px sans-serif';
  const btn = document.createElement('button');
  btn.textContent = '▶ 开始流水线';
  btn.style.cssText = 'padding:6px 14px;background:#1f6feb;color:#fff;border:none;border-radius:6px;cursor:pointer;font:13px sans-serif';
  const msg = document.createElement('span');
  msg.style.cssText = 'font-size:12px;color:#8b949e';
  function start() {
    const label = (input.value || '').trim();
    if (!label) { input.focus(); msg.textContent = 'label 必填'; return; }
    try {
      chrome.runtime.sendMessage({ type: 'WF_START', data: { label } });
      input.value = ''; msg.textContent = '已发起：' + label;
    } catch (e) { msg.textContent = '发起失败：' + ((e && e.message) || e); }
  }
  btn.addEventListener('click', start);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  bar.append(input, btn, msg);
  const app = document.getElementById('app');
  app.insertBefore(bar, app.querySelector('.main'));
})();

// 大脑流是有状态组件（增量 append），建一次实例
const brainStream = createBrainStream(brainMount);

// 选中态（环节行 / 大脑流条点击高亮）——本地 UI 态，不进 store
let selectedStepId = null;

// 切 activeWorkflowId：本 Plan 单 workflow，点击仅切本地视图（真实写 storage→bg 留后续）
function onSelectWorkflow(id) {
  store.getState().skeleton.batch.activeWorkflowId = id;
  renderAll(store.getState());
}

function onSelectStep(id) {
  selectedStepId = id;
  renderStepList(stepMount, selectActiveWorkflow(store.getState().skeleton.batch), selectedStepId, onSelectStep);
}

// HITL 动作 → WF_* 回路：buildHitlMessage 映射后 sendMessage；回填校验失败 alert 提示。
// onAction(act, {getField}) 由 hitl-queue 按钮触发；getField 闭包读 dashboard 输入框值（dashboard.js 不碰 DOM）。
function onHitlAction(act, payload) {
  const wf = selectActiveWorkflow(store.getState().skeleton.batch);
  if (!wf) return;
  const view = window.__AS_OVERLAY_VIEW__;
  const getField = (payload && payload.getField) || (() => '');
  const msg = window.__AS_DASH_HITL_ACTION__.buildHitlMessage(act, wf, getField, view, payload || {});
  if (msg.error) { window.alert(msg.error.map(e => e.msg).join('\n')); return; }
  try { chrome.runtime.sendMessage(msg); }
  catch (e) { console.warn('[dashboard] HITL 发送失败', e); }
}

// 全量重渲骨架部分（topbar/queue/overview/step/hitl）；大脑流独立 update（增量）
function renderAll(state) {
  const wf = selectActiveWorkflow(state.skeleton.batch);
  renderTopbar(document.getElementById('topbar'), state);
  renderQueueList(document.getElementById('queue-list'), state, onSelectWorkflow);
  renderOverviewBar(overviewMount, wf);
  renderStepList(stepMount, wf, selectedStepId, onSelectStep);
  renderHitlQueue(hitlMount, wf, onHitlAction);
  brainStream.update(state);
}

// 订阅 store：任一变更触发重渲
store.subscribe(renderAll);

// 首屏渲染（store 初始为空 batch，先渲空态，源接入后再重渲）
renderAll(store.getState());

// 启动数据源：storage-source 接真实 chrome.storage；ws-source 先尝试真实 WS、连不上降级 mock 回放大脑流
startStorageSource(store);
startWsSource(store);
