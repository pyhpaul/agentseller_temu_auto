// dashboard.js — ES module 入口。装配 store + 源 + 组件，订阅 store 重渲。
// 骨架（topbar/queue-list/overview-bar/step-list/hitl-queue）全量重渲；大脑流增量 append（独立 update）。
// 数据源：storage-source（真实 chrome.storage）+ ws-source（本 Plan mock，Plan 3 换真实 WS）。
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

// HITL 动作占位：本 Plan 仅 toast 提示，真实 message→background 回路留后续
function onHitlAction(kind, hitl) {
  console.log('[dashboard] HITL action（占位，回路待 Plan）：', kind, hitl?.id);
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

// 启动数据源：storage-source 接真实 chrome.storage；ws-source 本 Plan mock 回放大脑流
startStorageSource(store);
startWsSource(store);
