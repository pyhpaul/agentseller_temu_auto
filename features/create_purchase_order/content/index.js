// create_purchase_order —— 创建采购单 Phase 1
// 跑在 temu/1688/店小秘 三域：注册 feature + 输入 UI + 进度面板 + bg 命令处理器。
(function () {
  'use strict';

  const L = window.__CPOLogic;                 // Task 1 的纯逻辑（document_start 已挂）
  const U = window.AgentSeller.utils;          // sleep/waitForEl/findByText/setInputValue
  const FID = 'create_purchase_order';

  const STATE_KEY = 'cpo_state';

  // ── 页面判定 ──
  function isListPage() { return location.href.includes('agentseller.temu.com/goods/list'); }
  function isDxmPage() { return location.href.includes('dianxiaomi.com'); }

  // ── 商品选择状态（temu 列表页点选行） ──
  let selectedSkc = '';

  function highlightRow(row) {
    // 整行高亮：给每个 td 上背景色（!important 盖过 Temu sticky 单元格白底；
    // 仅 outline 会被 sticky 列白底遮住，只剩上下边）
    document.querySelectorAll('tr.cpo-selected-row').forEach(r => {
      r.classList.remove('cpo-selected-row');
      r.querySelectorAll(':scope > td').forEach(td => td.style.removeProperty('background-color'));
    });
    if (row) {
      row.classList.add('cpo-selected-row');
      row.querySelectorAll(':scope > td').forEach(td => td.style.setProperty('background-color', '#e6f4ff', 'important'));
    }
  }

  // ── 面板引用（render 填入；refreshFromStorage / storage.onChanged 更新） ──
  const ui = { startBtn: null, urlInput: null, localMsg: null, p1Status: null, p1Data: null,
               p2Status: null, p2Data: null, p2Btn: null, orderInput: null, p2Msg: null,
               poOutput: null, poBox: null, autoSaveChk: null,
               repurchaseChk: null, p1Section: null };

  function setLocalMsg(text, kind = 'info') {
    if (!ui.localMsg) return;
    ui.localMsg.textContent = text || '';
    ui.localMsg.style.color = kind === 'error' ? '#ff4d4f' : '#666';
  }

  function setP2Msg(text, kind = 'info') {
    if (!ui.p2Msg) return;
    ui.p2Msg.textContent = text || '';
    ui.p2Msg.style.color = kind === 'error' ? '#ff4d4f' : '#666';
  }

  function statusText(p) {
    if (!p || !p.status || p.status === 'idle') return '未开始';
    if (p.status === 'running') return '进行中（' + (p.label || ('步骤' + (p.step || ''))) + '）';
    if (p.status === 'done') return '✅ ' + (p.label || '已完成');
    if (p.status === 'error') return '❌ ' + (p.label || '失败');
    return p.status;
  }

  // 从 cpo_state 渲染两个 phase 的状态（跨 tab 共享：任何页面打开面板都能看到）
  function renderState(state) {
    const p1 = (state && state.phase1) || {};
    const p2 = (state && state.phase2) || {};
    if (ui.p1Status) ui.p1Status.textContent = '状态：' + statusText(p1);
    if (ui.p1Data) {
      const c = p1.collected || {};
      ui.p1Data.textContent = (c.skuNo || c.title)
        ? '货号 ' + (c.skuNo || '-') + ' ｜ 标题 ' + (c.title || '-').slice(0, 16) + ' ｜ 识别码 ' + (c.serial ? c.serial + '-' + c.skuNo : '-')
        : '';
    }
    if (ui.p2Status) ui.p2Status.textContent = '状态：' + statusText(p2);
    const c2 = p2.collected2 || {};
    const p2Done = p2.status === 'done' && c2.poNo;
    if (ui.p2Data) {
      // 状态区输出采购单号（纯文本，供与下方只读框比对）
      ui.p2Data.textContent = p2Done
        ? '制作成功 采购单号：' + c2.poNo + ' ｜ 1688订单：' + (c2.orderNo1688 || '-')
        : '';
    }
    if (ui.poOutput && ui.poBox) {
      // 只读框：成功后显示采购单号供选中复制；非完成态清空隐藏（连同「采购单号：」label 整行 poBox）
      ui.poOutput.value = p2Done ? c2.poNo : '';
      ui.poBox.style.display = p2Done ? 'flex' : 'none';
    }
    // 复购态（持久化在 cpo_state.repurchase）：驱动 checkbox / ①区灰显
    const repurchase = !!(state && state.repurchase);
    if (ui.repurchaseChk) ui.repurchaseChk.checked = repurchase;

    // 完成锁定：phase2 done 即锁（覆盖复购——复购无 phase1 done，不能再依赖 bothDone）
    const locked = p2.status === 'done' && !!c2.orderNo1688;
    if (ui.orderInput) {
      // 用 readOnly 自身判断「上次是否锁定」——从锁定态解除（清除/新流程）时清空回填值、恢复可输入
      if (locked) {
        ui.orderInput.value = c2.orderNo1688;
        ui.orderInput.readOnly = true;
        ui.orderInput.style.background = '#f7f7f7';
      } else if (ui.orderInput.readOnly) {
        ui.orderInput.value = '';
        ui.orderInput.readOnly = false;
        ui.orderInput.style.background = '';
      }
    }
    // ①区灰显：仅店小秘页 + 复购模式（Temu 列表页不灰，否则用户既取消不了复购、又用不了①区 → 死锁）
    if (ui.p1Section) {
      const dim = repurchase && isDxmPage();
      ui.p1Section.style.opacity = dim ? '0.45' : '';
      ui.p1Section.style.pointerEvents = dim ? 'none' : '';
    }
    lastP1Done = (p1.status === 'done');
    recomputeP2Btn();
  }

  function refreshFromStorage() {
    chrome.storage.local.get(STATE_KEY).then(o => renderState(o[STATE_KEY]));
  }

  // 跨 tab 订阅：任何 tab 改了 cpo_state，已打开的面板实时刷新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATE_KEY]) renderState(changes[STATE_KEY].newValue);
  });

  // temu 列表页委托点击：点商品整行 → 高亮 + 记录 SKC + 启用「开始」
  document.addEventListener('click', (e) => {
    if (!isListPage()) return;
    const row = e.target.closest('[data-testid="beast-core-table-body-tr"]');
    if (!row) return;
    if (e.target.closest('a,button,input,[data-testid="beast-core-checkbox"]')) return;  // 不抢行内原有交互
    const m = row.textContent.replace(/\s/g, '').match(/SKCID[:：]?(\d+)/);
    if (!m) return;
    selectedSkc = m[1];
    highlightRow(row);
    if (ui.startBtn) ui.startBtn.disabled = false;
    setLocalMsg('已选中 SKC ' + selectedSkc);
  }, true);

  // 发起 Phase 1（仅 temu 列表页）：从选中行读 skc/货号/SPU ID → CPO_START
  let cpoStarting = false;   // 重入守卫：防止 await 校验期间双击触发两条并行编排
  async function onStartPhase1() {
    if (cpoStarting) return;
    if (!selectedSkc) { setLocalMsg('请先在列表点选一个商品', 'error'); return; }
    cpoStarting = true;
    if (ui.startBtn) ui.startBtn.disabled = true;   // 同步禁用，先于下面的 async 校验
    let started = false;
    try {
      // 先校验商品本身（货号 → SPU ID），再校验 1688 url —— 货号缺失是更根本的拦截，应先提示
      const row = await cpoFindSkcRow(selectedSkc);
      if (!row) { setLocalMsg('选中的商品行已消失，请重新点选', 'error'); return; }
      const skuNo = cpoReadSkuNoFromRow(row);
      const spuId = cpoReadSpuIdFromRow(row);
      if (!skuNo) { setLocalMsg('该商品需先维护货号', 'error'); return; }
      if (!spuId) { setLocalMsg('未读到 SPU ID（无法定位编辑页）', 'error'); return; }
      const url1688 = (ui.urlInput && ui.urlInput.value || '').trim();
      const v = L.validateInputs({ skc: selectedSkc, url1688 });
      if (!v.ok) { setLocalMsg(v.error, 'error'); return; }
      setLocalMsg('启动中…');
      const resp = await chrome.runtime.sendMessage({ type: 'CPO_START', data: { url1688, skc: selectedSkc, skuNo, spuId } });
      if (!resp?.ok) setLocalMsg(resp?.error || '启动失败', 'error');
      else { setLocalMsg(''); started = true; }   // ack 成功后清临时消息，让 p1Status 接管显示进度
    } catch (e) {
      setLocalMsg('启动失败：' + e.message, 'error');
    } finally {
      cpoStarting = false;
      // 成功启动后保持禁用（流程在跑，避免误触并行重跑）；未启动则恢复供重试
      if (!started && ui.startBtn) ui.startBtn.disabled = false;
    }
  }

  // ②区按钮启用：phase1 done + 在店小秘页 + 输入框有值。lastP1Done 由 renderState 更新
  let lastP1Done = false;
  function recomputeP2Btn() {
    if (!ui.p2Btn) return;
    const orderVal = (ui.orderInput && ui.orderInput.value || '').trim();
    const locked = !!(ui.orderInput && ui.orderInput.readOnly);   // 流程完成锁定态：禁用，引导先清除再开新单
    const repurchase = !!(ui.repurchaseChk && ui.repurchaseChk.checked);
    if (repurchase) {
      // 复购：去掉 phase1 依赖，只要求填 1688订单号
      ui.p2Btn.disabled = locked || !(isDxmPage() && orderVal);
    } else {
      ui.p2Btn.disabled = locked || !(lastP1Done && isDxmPage() && orderVal);
    }
  }

  // 发起 Phase 2（仅店小秘页）：校验 → CPO_START_PHASE2
  let cpoStarting2 = false;   // 重入守卫
  async function onStartPhase2() {
    if (cpoStarting2) return;
    cpoStarting2 = true;                              // 提前置位，覆盖 await 校验窗口（对齐①区）
    if (ui.p2Btn) ui.p2Btn.disabled = true;          // 同步禁用，先于下面的 async 校验
    let started = false;
    try {
      const orderNo1688 = (ui.orderInput && ui.orderInput.value || '').trim();
      const repurchase = !!(ui.repurchaseChk && ui.repurchaseChk.checked);
      const o = await chrome.storage.local.get(STATE_KEY);
      const p1Done = !!(o[STATE_KEY] && o[STATE_KEY].phase1 && o[STATE_KEY].phase1.status === 'done');
      const v = L.validatePhase2({ orderNo1688, phase1Done: p1Done, repurchase });
      if (!v.ok) { setP2Msg(v.error, 'error'); return; }   // finally 会复位守卫+恢复按钮
      setP2Msg('启动中…');
      const autoSave = ui.autoSaveChk ? ui.autoSaveChk.checked : true;
      const resp = await chrome.runtime.sendMessage({ type: 'CPO_START_PHASE2', data: { orderNo1688, autoSave, repurchase } });
      if (!resp?.ok) setP2Msg(resp?.error || '启动失败', 'error');
      else { setP2Msg(''); started = true; }   // ack 成功后清临时消息，让 p2Status 接管显示进度
    } catch (e) {
      setP2Msg('启动失败：' + e.message, 'error');
    } finally {
      cpoStarting2 = false;
      if (!started) recomputeP2Btn();                // 启动成功则保持禁用（流程在跑）
    }
  }

  // 切换复购态：写持久化 cpo_state.repurchase（storage.onChanged → renderState 统一刷新
  // checkbox / ①区灰显，单一数据源驱动）
  async function onToggleRepurchase() {
    const o = await chrome.storage.local.get(STATE_KEY);
    const st = o[STATE_KEY] || {};
    st.repurchase = !!(ui.repurchaseChk && ui.repurchaseChk.checked);
    st.updatedAt = Date.now();
    await chrome.storage.local.set({ [STATE_KEY]: st });
  }

  // 清除当前流程数据：两个 phase 未全部完成时先确认，避免误清未完成的工作
  async function onClear() {
    const o = await chrome.storage.local.get(STATE_KEY);
    const st = o[STATE_KEY];
    const p1 = (st && st.phase1) || {};
    const p2 = (st && st.phase2) || {};
    const c = p1.collected || {};
    const c2 = p2.collected2 || {};
    // hasData 覆盖 phase1 + phase2 + 复购态 + 用户手填 input —— 任一非空都算"有数据可清"
    // （v1.2.2：复购模式跳过 phase1，hasData 不能只看 phase1 否则复购流程清不掉）
    const urlVal = (ui.urlInput && ui.urlInput.value || '').trim();
    const orderVal = (ui.orderInput && ui.orderInput.value || '').trim();
    const repurchase = !!(st && st.repurchase);
    const hasData = (p1.status && p1.status !== 'idle') || c.skuNo || c.title
                 || (p2.status && p2.status !== 'idle') || c2.poNo || c2.orderNo1688
                 || repurchase || urlVal || orderVal;
    if (!hasData) { U.showToast('当前无流程数据', 'info'); return; }
    const bothDone = p1.status === 'done' && p2.status === 'done';
    if (!bothDone && !window.confirm('当前采购单流程尚未全部完成，确认清除已采集的数据？')) return;
    await doClear();
  }

  async function doClear() {
    await chrome.storage.local.remove(STATE_KEY);
    selectedSkc = '';
    highlightRow(null);
    if (ui.startBtn) ui.startBtn.disabled = true;
    // 清 UI 上用户手填的 input value（storage 清干净后 DOM 也要同步——renderState 只在"曾 readOnly"时清，未锁定态的手填值会留存）
    if (ui.urlInput) ui.urlInput.value = '';
    if (ui.orderInput && !ui.orderInput.readOnly) ui.orderInput.value = '';
    // 兜底清 ①②区临时消息（启动中…/校验错误/启动失败）——p1Status / p2Status / 采集摘要由 renderState 据 storage 自然 reset
    setLocalMsg('');
    setP2Msg('');
    U.showToast('已清除当前采购单流程数据', 'ok');
  }

  // ── feature 注册 + Hub UI（两区：① 添加SKU / ② 创建采购单） ──
  window.AgentSeller.registerFeature({
    id: FID,
    icon: '🛒',
    label: '创建采购单',
    locked: false,
    order: 5,
    init() {},
    render(viewEl) {
      viewEl.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;font-size:12px;';

      // ===== ① 添加SKU（Temu 发起） =====
      // 包一层容器 ui.p1Section：复购模式时整块灰显（仅店小秘页，见 renderState）
      ui.p1Section = document.createElement('div');
      ui.p1Section.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
      const h1 = document.createElement('div');
      h1.style.cssText = 'font-weight:600;color:#1677ff;';
      h1.textContent = '① 添加SKU';
      ui.p1Status = document.createElement('div');
      ui.p1Status.style.cssText = 'color:#666;';
      ui.p1Data = document.createElement('div');
      ui.p1Data.style.cssText = 'color:#888;font-size:11px;line-height:1.4;';
      ui.p1Section.append(h1, ui.p1Status, ui.p1Data);

      if (isListPage()) {
        const hint = document.createElement('div');
        hint.style.cssText = 'color:#666;line-height:1.4;';
        hint.textContent = '点选商品（整行高亮），填 1688 链接后开始';
        ui.urlInput = document.createElement('input');
        ui.urlInput.placeholder = '1688商品url';
        ui.urlInput.style.cssText = 'padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;';
        ui.startBtn = document.createElement('button');
        ui.startBtn.className = 'tal-action-btn';
        ui.startBtn.textContent = '开始添加SKU';
        ui.startBtn.disabled = !selectedSkc;
        ui.startBtn.addEventListener('click', onStartPhase1);
        ui.localMsg = document.createElement('div');
        ui.localMsg.style.cssText = 'font-size:11px;color:#666;min-height:16px;';
        ui.p1Section.append(hint, ui.urlInput, ui.startBtn, ui.localMsg);
      } else {
        const note = document.createElement('div');
        note.style.cssText = 'color:#999;font-size:11px;';
        note.textContent = '（在 Temu 商家中心商品列表发起）';
        ui.p1Section.append(note);
      }
      wrap.append(ui.p1Section);

      const hr = document.createElement('div');
      hr.style.cssText = 'border-top:1px dashed #ddd;margin:4px 0;';
      wrap.append(hr);

      // ===== 复购开关（①②之间，仅店小秘页）：勾选 = 跳过①、只填1688订单号跑② =====
      if (isDxmPage()) {
        const repRow = document.createElement('label');
        repRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:#333;cursor:pointer;line-height:1.4;font-weight:600;';
        ui.repurchaseChk = document.createElement('input');
        ui.repurchaseChk.type = 'checkbox';
        ui.repurchaseChk.addEventListener('change', onToggleRepurchase);
        repRow.append(ui.repurchaseChk, document.createTextNode('商品复购（跳过①添加SKU，直接填1688订单号）'));
        wrap.append(repRow);
      }

      // ===== ② 创建采购单（店小秘发起；新品需 Phase 1 完成，复购直接填1688订单号） =====
      const h2 = document.createElement('div');
      h2.style.cssText = 'font-weight:600;color:#1677ff;';
      h2.textContent = '② 创建采购单';
      ui.p2Status = document.createElement('div');
      ui.p2Status.style.cssText = 'color:#666;';
      ui.p2Data = document.createElement('div');
      ui.p2Data.style.cssText = 'color:#888;font-size:11px;line-height:1.4;';
      wrap.append(h2, ui.p2Status, ui.p2Data);

      if (isDxmPage()) {
        const hint2 = document.createElement('div');
        hint2.style.cssText = 'color:#666;line-height:1.4;';
        hint2.textContent = '新品需先完成①添加SKU；复购直接填1688订单号即可';
        ui.orderInput = document.createElement('input');
        ui.orderInput.placeholder = '1688订单号';
        ui.orderInput.style.cssText = 'flex:1;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;';
        ui.orderInput.addEventListener('input', recomputeP2Btn);
        const orderRow = document.createElement('div');
        orderRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const orderLabel = document.createElement('span');
        orderLabel.textContent = '1688订单号：';
        orderLabel.style.cssText = 'font-size:12px;color:#666;white-space:nowrap;';
        orderRow.append(orderLabel, ui.orderInput);
        // 自动保存开关：勾选=到「保存，并通过审核」自动点；不勾=弹可拖动确认框等用户核对后再点
        const saveChkLabel = document.createElement('label');
        saveChkLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:#666;cursor:pointer;line-height:1.4;';
        ui.autoSaveChk = document.createElement('input');
        ui.autoSaveChk.type = 'checkbox';
        ui.autoSaveChk.checked = false;   // 默认不勾选：先弹确认框让用户核对，确认后再保存
        saveChkLabel.append(ui.autoSaveChk, document.createTextNode('自动点击「保存，并通过审核」（取消勾选则弹窗等你核对确认）'));
        ui.p2Btn = document.createElement('button');
        ui.p2Btn.className = 'tal-action-btn';
        ui.p2Btn.textContent = '开始创建采购单';
        ui.p2Btn.disabled = true;
        ui.p2Btn.addEventListener('click', onStartPhase2);
        ui.p2Msg = document.createElement('div');
        ui.p2Msg.style.cssText = 'font-size:11px;color:#666;min-height:16px;';
        // 采购单号只读输出框（制作成功后显示）：readOnly 防手误改动，用户自行选中复制
        ui.poBox = document.createElement('div');
        ui.poBox.style.cssText = 'display:none;align-items:center;gap:6px;';
        const poLabel = document.createElement('span');
        poLabel.textContent = '采购单号：';
        poLabel.style.cssText = 'font-size:12px;color:#666;white-space:nowrap;';
        ui.poOutput = document.createElement('input');
        ui.poOutput.readOnly = true;
        ui.poOutput.style.cssText = 'flex:1;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;background:#f7f7f7;';
        ui.poBox.append(poLabel, ui.poOutput);
        wrap.append(hint2, orderRow, saveChkLabel, ui.p2Btn, ui.poBox, ui.p2Msg);
      } else {
        const note2 = document.createElement('div');
        note2.style.cssText = 'color:#999;font-size:11px;line-height:1.4;';
        note2.textContent = '（在店小秘页发起；需先完成①添加SKU）';
        wrap.append(note2);
      }

      // 清除按钮（两 phase 未全部完成时弹确认，避免误清）
      const clearBtn = document.createElement('button');
      clearBtn.textContent = '🗑 清除当前流程';
      clearBtn.style.cssText = 'margin-top:10px;padding:6px 12px;font-size:12px;color:#ff4d4f;background:#fff;border:1px solid #ff4d4f;border-radius:4px;cursor:pointer;align-self:stretch;';
      clearBtn.addEventListener('click', onClear);
      wrap.append(clearBtn);

      viewEl.appendChild(wrap);
      refreshFromStorage();
    },
  });

  // ── temu 列表页辅助（据 samples/temu_goods_list.txt 真实 DOM） ──

  // 等结果行渲染，定位 SKC ID 含 skc 的数据行；优先在 SKC ID 单元格精确匹配
  async function cpoFindSkcRow(skc) {
    try { await U.waitForEl('[data-testid="beast-core-table-body-tr"], tbody tr', document, 8000); }
    catch { return null; }
    await U.sleep(300);   // 给 React 渲染留余量
    const rows = document.querySelectorAll('[data-testid="beast-core-table-body-tr"], tbody tr');
    return Array.from(rows).find(r => {
      const idEls = r.querySelectorAll('.product-info_idContent__iDukx, [class*="idContent"]');
      const inSkcCell = Array.from(idEls).some(e => /SKC\s*ID/.test(e.textContent) && e.textContent.includes(skc));
      return inSkcCell || r.textContent.includes(skc);
    }) || null;
  }

  // 按表头文本动态算「SKU货号」列的 leaf 列索引（表头有 rowspan/colspan，硬数列号会错）
  function cpoLeafColIndex(headerText) {
    const tr = document.querySelector('thead tr');
    if (!tr) return -1;
    let idx = 0;
    for (const th of tr.children) {
      const colspan = parseInt(th.getAttribute('colspan') || '1', 10);
      if (U.normText(th.textContent).includes(U.normText(headerText))) return idx;
      idx += colspan;
    }
    return -1;
  }

  // 读行内「SKU货号」列值；"-" 或空 → 返回 ''（视为未维护货号，交 bg 判 abort）
  function cpoReadSkuNoFromRow(row) {
    const idx = cpoLeafColIndex('SKU货号');
    if (idx < 0) return '';
    const cell = row.querySelectorAll(':scope > td')[idx];
    if (!cell) return '';
    const txt = cell.textContent.replace(/\s/g, '');
    return (txt === '-' || txt === '') ? '' : txt;
  }

  // 读行内 SPU ID（= 编辑页 productId，用于 bg 直接构造编辑页 URL）
  function cpoReadSpuIdFromRow(row) {
    const m = row.textContent.replace(/\s/g, '').match(/SPUID[:：]?(\d+)/);
    return m ? m[1] : '';
  }

  // ── 店小秘 add 页辅助（据 samples/dxm_add_form.txt 真实 DOM；店小秘用 Ant Design） ──

  function cpoSetById(id, val) {
    const el = document.getElementById(id);
    if (el) U.setInputValue(el, val);
    return !!el;
  }
  function cpoSetByPh(phSub, val) {
    const el = document.querySelector(`input[placeholder*="${phSub}"]`);
    if (el) U.setInputValue(el, val);
    return !!el;
  }

  // 图片信息：「选择图片」(ant-dropdown) → 「网络图片」→ 弹窗填 url → 「确定」
  async function cpoAddNetworkImage(url) {
    const choose = U.findByText('button,.ant-btn,a', '选择图片');
    if (!choose) return { ok: false, error: '未找到「选择图片」按钮' };
    // 「选择图片」是 hover 触发的 ant-dropdown（实测 click 打不开），用鼠标悬停事件展开
    const trigger = choose.closest('.ant-dropdown-trigger') || choose;
    ['pointerover', 'mouseover', 'mouseenter'].forEach(n =>
      trigger.dispatchEvent(new MouseEvent(n, { bubbles: true, view: window })));
    // 店小秘是 Ant Design Vue：菜单项是 <div class="item">网络图片</div>，非 .ant-dropdown-menu-item
    try { await U.waitForEl('.ant-dropdown .item, .dropdown .item', document, 4000); } catch {}
    const net = U.findByText('.ant-dropdown .item, .dropdown .item, div.item', '网络图片');
    if (!net) return { ok: false, error: '未找到「网络图片」菜单项' };
    net.click();
    // 网络图片弹窗：url 是 textarea（非 input），确认按钮是「添加」（非「确定」）
    let input;
    try { input = await U.waitForEl('textarea[placeholder*="图片URL"], .ant-modal-content textarea', document, 5000); }
    catch { return { ok: false, error: '网络图片弹窗未出现' }; }
    U.setInputValue(input, url);
    await U.sleep(150);
    const modal = input.closest('.ant-modal-content') || document;
    const okBtn = U.findByText('button', '添加', modal) || modal.querySelector('.ant-btn-primary');
    if (!okBtn) return { ok: false, error: '网络图片弹窗未找到「添加」按钮' };
    okBtn.click();
    await U.sleep(400);
    return { ok: true };
  }

  // 人员信息卡：卡内所有 ant-select 选当前店铺 user-name
  // 安全约束：必须限定在「人员信息」卡内；卡找不到则【不填】（绝不全表填，避免写错仓库/分类下拉）
  async function cpoFillPersonnel() {
    const userName = (document.querySelector('.user-name, [class*="user-name"]')?.textContent || '').trim();
    if (!userName) return { filled: 0, reason: 'no-username' };
    const card = Array.from(document.querySelectorAll('div,section,fieldset'))
      .filter(e => /人员信息/.test(e.textContent) && e.querySelectorAll('.ant-select').length > 0)
      .sort((a, b) => a.textContent.length - b.textContent.length)[0];
    if (!card) return { filled: 0, reason: 'no-person-card' };
    const want = U.normText(userName);
    const selects = Array.from(card.querySelectorAll('.ant-select'));
    let filled = 0;
    for (const sel of selects) {
      const combo = sel.querySelector('input');
      (sel.querySelector('.ant-select-selector') || sel).click();
      // 锁定该 select 自己的下拉（combo 的 aria-controls 指向 rc_select_N_list）
      const listId = combo && (combo.getAttribute('aria-controls') || combo.getAttribute('aria-owns'));
      let opt = null;
      for (let i = 0; i < 30 && !opt; i++) {            // 轮询 ~3s 等选项渲染（固定 sleep 对后续下拉不够）
        await U.sleep(100);
        const scoped = listId && document.getElementById(listId)?.closest('.ant-select-dropdown');
        const scopes = scoped
          ? [scoped]
          : Array.from(document.querySelectorAll('.ant-select-dropdown')).filter(d => d.getBoundingClientRect().height > 0);
        for (const s of scopes) {
          // 精确匹配可见选项 textContent（隐藏 a11y 选项 textContent 为空，自动排除）
          opt = Array.from(s.querySelectorAll('[role="option"], .ant-select-item-option'))
            .find(o => U.normText(o.textContent) === want);
          if (opt) break;
        }
      }
      if (opt) { opt.click(); filled++; }
      await U.sleep(250);                                // 等下拉收起再开下一个
    }
    return { filled, total: selects.length };
  }

  // 找标签文本对应的 ant-select（同 form-item 内含 .ant-select 的最小容器）
  function cpoFindSelectByLabel(labelText) {
    const want = U.normText(labelText);
    const item = Array.from(document.querySelectorAll('.ant-form-item, .form-item, .ant-row, .ant-col'))
      .filter(el => U.normText(el.textContent).includes(want) && el.querySelector('.ant-select'))
      .sort((a, b) => a.textContent.length - b.textContent.length)[0];
    return item ? item.querySelector('.ant-select') : null;
  }

  // 选 ant-select 中匹配 want 的选项（采购人员/收货仓库用）→ 成功 true
  // 关键：大列表（采购人员）是搜索型下拉，打开后可见选项 .ant-select-item-option 不渲染，
  // 必须在 dropdown 内搜索框输入关键字才触发渲染/过滤；且匹配只能用可见项的 title——
  // 隐藏 a11y listbox 的 [role="option"] textContent 是数字 ID（如 1966019）、用户名在 aria-label，会误判
  async function cpoSelectOptionByText(sel, want) {
    const combo = sel.querySelector('input');
    (sel.querySelector('.ant-select-selector') || sel).click();
    const listId = combo && (combo.getAttribute('aria-controls') || combo.getAttribute('aria-owns'));
    const target = U.normText(want);
    let typed = false;
    for (let i = 0; i < 30; i++) {
      await U.sleep(100);
      const scoped = listId && document.getElementById(listId)?.closest('.ant-select-dropdown');
      const scopes = scoped ? [scoped]
        : Array.from(document.querySelectorAll('.ant-select-dropdown')).filter(d => d.getBoundingClientRect().height > 0);
      for (const s of scopes) {
        // 搜索型下拉：输入关键字触发选项渲染（仅输一次，输完等渲染）
        const searchInput = s.querySelector('.search-input input, input[placeholder*="搜索"]');
        if (searchInput && !typed) { U.setInputValue(searchInput, want); typed = true; await U.sleep(300); }
        // 只匹配可见选项；title 优先（textContent 可能含尾空格 / 隐藏 listbox 是数字 ID）
        const opt = Array.from(s.querySelectorAll('.ant-select-item-option'))
          .find(o => U.normText(o.getAttribute('title') || o.textContent) === target);
        if (opt) { opt.click(); return true; }
      }
    }
    return false;
  }

  // 读 ant-select 当前选中文本（写后读校验用）。title 优先：文本被 CSS 截断时 textContent 带省略号、title 是完整值
  function cpoReadSelectValue(sel) {
    const item = sel && sel.querySelector('.ant-select-selection-item');
    return U.normText((item && (item.getAttribute('title') || item.textContent)) || '');
  }

  // 写后读：ant-select 选 want 后回读确认实际选中 === want。失败返回带「期望/实际」的诊断错误，不静默
  async function cpoSelectAndVerify(sel, want, fieldName) {
    await cpoSelectOptionByText(sel, want);
    await U.sleep(200);
    const actual = cpoReadSelectValue(sel);
    if (actual !== U.normText(want)) {
      return { ok: false, error: `数据校验：${fieldName}填写后不符，期望「${want}」实际「${actual || '（空）'}」` };
    }
    return { ok: true };
  }

  // 配对商品弹窗：点「配对商品」/「更换配对」→ 填货号搜索 → 点「选择」→ 处理可能的确认弹窗
  async function cpoPairProduct(skuNo) {
    const normSku = U.normText(skuNo);
    // 找「配对商品」或「更换配对」（span.link，不是 button）
    const pairBtn = Array.from(document.querySelectorAll('span.link'))
      .find(el => ['配对商品', '更换配对'].includes(el.textContent.trim()));
    if (!pairBtn) return { ok: false, error: '未找到「配对商品」按钮（确保采购单行已展开）' };
    pairBtn.click();
    // 等 product-ref-modal 的 ant-modal-body 出现
    let modalBody = null;
    for (let i = 0; i < 30 && !modalBody; i++) {
      await U.sleep(200);
      const el = document.querySelector('.product-ref-modal .ant-modal-body');
      if (el && el.getBoundingClientRect().height > 0) modalBody = el;
    }
    if (!modalBody) return { ok: false, error: '配对弹窗未出现' };
    // 搜索类型「商品SKU」tag 默认 active，无需切换
    // 填搜索内容（input[name="tableSearchInput"]）
    const kwInput = modalBody.querySelector('input[name="tableSearchInput"]');
    if (!kwInput) return { ok: false, error: '配对弹窗：未找到搜索输入框（name=tableSearchInput）' };
    U.setInputValue(kwInput, skuNo);
    await U.sleep(150);
    // 点搜索（button[type="submit"]）
    const searchBtn = modalBody.querySelector('button[type="submit"]');
    if (!searchBtn) return { ok: false, error: '配对弹窗：未找到搜索按钮' };
    searchBtn.click();
    // 等结果行，找 SKU 匹配项的「选择」按钮
    // 表格两列布局：每行 4 td（info1, 选择1, info2, 选择2）；SKU 在 .no-new-line2:not(.gray-c)
    let selBtn = null;
    for (let i = 0; i < 30 && !selBtn; i++) {
      await U.sleep(200);
      for (const row of modalBody.querySelectorAll('table.in-table tbody tr.content')) {
        const cells = row.querySelectorAll('td');
        for (let k = 0; k < cells.length - 1; k += 2) {
          const skuEl = cells[k]?.querySelector('.no-new-line2:not(.gray-c)');
          if (skuEl && U.normText(skuEl.textContent) === normSku) {
            selBtn = cells[k + 1]?.querySelector('span.link');
            break;
          }
        }
        if (selBtn) break;
      }
    }
    if (!selBtn) return { ok: false, error: `配对弹窗：未找到 SKU「${skuNo}」的配对结果（请确认货号已建档）` };
    selBtn.click();
    // 等可能的「确认要更换配对关系」弹窗（已有配对时出现）
    await U.sleep(500);
    const confirmModal = Array.from(document.querySelectorAll('.ant-modal-content'))
      .find(m => m.getBoundingClientRect().height > 0 && m.textContent.includes('确认要更换配对关系'));
    if (confirmModal) {
      // 选「修改所有草稿箱」选项（value=1）
      const allOpt = Array.from(confirmModal.querySelectorAll('label.ant-radio-wrapper'))
        .find(l => l.textContent.includes('修改所有'));
      allOpt?.click();
      await U.sleep(150);
      const confirmBtn = Array.from(confirmModal.querySelectorAll('button'))
        .find(b => b.textContent.trim() === '确认');
      if (!confirmBtn) return { ok: false, error: '配对：确认弹窗未找到「确认」按钮' };
      confirmBtn.click();
    }
    // 填写后检查：配对弹窗在「选择」(+确认)后应自动关闭，关闭=配对已提交生效；未关=被必填/报错挡住
    let modalClosed = false;
    for (let i = 0; i < 20; i++) {
      await U.sleep(150);
      const m = document.querySelector('.product-ref-modal');
      if (!m || m.getBoundingClientRect().height === 0) { modalClosed = true; break; }
    }
    if (!modalClosed) return { ok: false, error: '数据校验：配对弹窗点「选择」后未关闭，配对可能未生效' };
    return { ok: true };
  }

  // ── bg → content 命令处理器（temu 列表/编辑 + 1688 + 店小秘 填表） ──
  const handlers = {
    CPO_READ_1688_TITLE: async () => {
      // 风控/验证页早退（参考 image_search_1688 injector）
      if (location.pathname.includes('/punish') || location.search.includes('x5secdata')) {
        return { ok: false, error: '1688 触发风控/验证页，请先在浏览器完成验证' };
      }
      // 实测：1688 详情页 og:title 常缺失、h1 是【店铺名】不可用；
      // 商品标题最稳来源是 document.title 去掉「 - 阿里巴巴 / 1688.com」后缀（取全标题，不缩短）。
      const strip = t => (t || '').replace(/\s*[-_|]\s*(阿里巴巴|1688).*$/i, '').trim();
      let title = '';
      for (let i = 0; i < 20; i++) {                 // 等 title 稳定，避开加载中占位
        title = strip(document.title);
        if (title && title !== '阿里巴巴' && title.length > 3) break;
        await U.sleep(200);
      }
      if (title && title !== '阿里巴巴') return { ok: true, title };
      // 退路：og:title（个别页面有）
      const og = document.querySelector('meta[property="og:title"]')?.content?.trim();
      if (og) return { ok: true, title: og };
      return { ok: false, error: '1688标题读取失败（可能未登录/页面未渲染）' };
    },

    CPO_GRAB_PREVIEW: async () => {
      U.showToast('创建采购单：正在读取预览图…', 'info');
      // 等编辑页渲染出预览图组件
      try { await U.waitForEl('img.preview-image_img__LvHNP', document, 10000); } catch {}
      // 定位「SKU 信息」框（标题中间有空格，用 normText 忽略空格匹配）
      const label = Array.from(document.querySelectorAll('*'))
        .find(el => el.children.length <= 1 && U.normText(el.textContent) === 'SKU信息');
      let box = label;
      for (let i = 0; box && i < 12 && box.parentElement; i++) {
        box = box.parentElement;
        if (box.querySelector('img.preview-image_img__LvHNP')) break;
      }
      // SKU 框内预览图（class preview-image_img；条码图 sku-bar-code-title_tagImg 自动排除）
      // 必须限定在 SKU 框内：页面顶部「商品轮播图」也是 preview-image_img，但那不是该 SKU 的图
      const img = box?.querySelector('img.preview-image_img__LvHNP');
      const previewUrl = img?.currentSrc || img?.src || '';
      if (!previewUrl) return { ok: false, error: '预览图url 读取失败（SKU信息框未找到预览图）' };
      return { ok: true, previewUrl };   // 原样返回 src（含 imageMogr2 缩略参数，用户要 300x）
    },
    CPO_FILL_DXM: async ({ collected }) => {
      const f = L.mapDxmFields(collected);
      U.showToast('创建采购单：正在填写商品信息…', 'info');
      // 等表单渲染（#proSku 是基础信息第一个文本框）
      try { await U.waitForEl('#proSku', document, 12000); }
      catch { return { ok: false, error: '店小秘添加表单未渲染（#proSku 未出现）' }; }

      // 文本字段（id/placeholder 据真实 DOM 确认）
      cpoSetById('proSku', f.spuSku);            // 商品SKU
      cpoSetById('proNameEn', f.enName);         // 英文名称
      cpoSetByPh('平台销售SKU', f.platformSku);   // 平台SKU（无 id，按 placeholder）
      cpoSetById('proName', f.cnName);           // 中文名称 = 1688 标题
      cpoSetById('proSbm', f.idCode);            // 识别码 = serial-skuNo
      cpoSetById('SOURCE_URL', f.sourceUrl);     // 来源URL

      // 图片信息：选择图片 → 网络图片 → 弹窗填 url → 确定
      const pic = await cpoAddNetworkImage(f.imageUrl);
      if (!pic.ok) return pic;

      // 人员信息：卡内所有下拉选 user-name（卡找不到则跳过）
      const person = await cpoFillPersonnel();
      if (person && person.total && person.filled < person.total) {
        U.showToast('部分人员下拉未自动选中，请在店小秘核对', 'error');
      }

      // 取消勾选「保存成功，继续创建下一条」→ 保存后跳回 index 列表页看到新 SKU
      // （勾选状态下保存会停留在 add 页清空重填）。两处复选框联动，checked 守卫避免反复 toggle
      Array.from(document.querySelectorAll('.ant-checkbox-wrapper, label'))
        .filter(w => /继续创建/.test(w.textContent))
        .forEach(w => { const cb = w.querySelector('input[type="checkbox"]'); if (cb && cb.checked) w.click(); });

      // 自动点保存（用户已确认改全自动）。保存按钮是橙色 btn-orange 的「保存」
      U.showToast('信息已填好，正在保存…', 'info');
      await U.sleep(300);
      const saveBtn = Array.from(document.querySelectorAll('.ant-btn, button'))
        .find(b => b.textContent.trim() === '保存' && /orang/.test(b.className))
        || U.findByText('.ant-btn, button', '保存');
      if (!saveBtn) {
        U.showToast('未找到保存按钮，请手动保存', 'error');
        return { ok: false, error: '未找到保存按钮，请手动保存' };   // 让 bg 标 error，不误标已保存
      }
      saveBtn.click();
      U.showToast('创建采购单：已提交保存', 'ok');
      return { ok: true, filled: true, person, saved: true };
    },

    CPO_P2_ADD_FETCH: async ({ orderNo1688 }) => {
      // isPaste=1 模式：无「1688账号」下拉，直接填订单号 + 点获取
      // 等 Vue 表单渲染（tab.status=complete 后组件仍需额外时间挂载）
      try { await U.waitForEl('textarea[placeholder*="1688订单号"]', document, 10000); }
      catch { return { ok: false, error: '1688订单号输入框 10s 内未渲染，表单未就绪' }; }
      // a) 填 1688订单号 —— textarea placeholder「填写1688订单号，多订单号请用回车键分隔」
      const orderInput = document.querySelector('textarea[placeholder*="1688订单号"], textarea[placeholder*="订单号"]');
      if (!orderInput) return { ok: false, error: '未找到「1688订单」输入框' };
      U.setInputValue(orderInput, orderNo1688);
      await U.sleep(150);
      // b) 点「获取1688订单」（warn-btn）
      const fetchBtn = U.findByText('button, .ant-btn', '获取1688订单');
      if (!fetchBtn) return { ok: false, error: '未找到「获取1688订单」按钮' };
      fetchBtn.click();
      // d) 轮询「已存在」弹窗（业务拦截）；未出现则 exists:false（bg 靠 edit 跳转监听接管）
      //    弹窗精确结构待补 dump，先用鲁棒关键词 + 可见性检测
      for (let i = 0; i < 25; i++) {                 // ~5s
        await U.sleep(200);
        const dlg = Array.from(document.querySelectorAll('.ant-modal, .ant-modal-confirm, .modal'))
          .find(d => d.getBoundingClientRect().height > 0 && /已存在|不能重复添加|已完成/.test(d.textContent));
        if (dlg) {
          const closeBtn = U.findByText('.ant-modal button, .modal button', '关闭')
            || dlg.querySelector('.ant-modal-close, .ant-modal-close-x')
            || Array.from(dlg.querySelectorAll('button, .ant-btn')).find(b => /关闭|知道了|确定/.test(b.textContent));
          closeBtn?.click();
          return { ok: true, exists: true };
        }
      }
      return { ok: true, exists: false };
    },

    CPO_P2_EDIT_FILL: async ({ skuNo, repurchase }) => {
      U.showToast('创建采购单：填写采购信息…', 'info');
      // 等 edit 页 Vue 表单渲染（收货仓库 d-selector 是渲染完成的标志）
      try { await U.waitForEl('label[title="收货仓库"], div.d-selector', document, 12000); }
      catch { return { ok: false, error: 'edit 页收货仓库下拉 12s 内未渲染，表单未就绪' }; }
      // a) 收货仓库选「中正科技仓」（新品+复购都跑）
      const whSel = cpoFindSelectByLabel('收货仓库');
      if (!whSel) return { ok: false, error: '业务拦截：未找到「收货仓库」下拉' };
      const whR = await cpoSelectAndVerify(whSel, '中正科技仓', '收货仓库');
      if (!whR.ok) return whR;
      // b) 配对商品——仅新品模式跑（复购模式店小秘已有 SKU 档案、获取订单时自动载入，无需配对）
      //    顺序关键：必须在采购人员【之前】——配对的「修改所有草稿箱」确认会重置采购人员，
      //    若先选采购人员会被配对覆盖（实测踩坑，曾误判为「采购人员没填对」）
      if (!repurchase) {
        const pair = await cpoPairProduct(skuNo);
        if (!pair.ok) return pair;
      }
      // c) 采购人员选当前登录用户（读 .user-name，选项为 "ZQCHAO1" 等用户名格式）
      //    新品下放配对后（配对的「修改所有草稿箱」确认会重置采购人员），复购下放仓库后
      const userName = (document.querySelector('.user-name, [class*="user-name"]')?.textContent || '').trim();
      const buyerSel = cpoFindSelectByLabel('采购人员');
      if (!buyerSel) return { ok: false, error: '业务拦截：未找到「采购人员」下拉' };
      if (!userName) return { ok: false, error: '读取失败：未读到当前登录用户名（.user-name 为空）' };
      const buyerR = await cpoSelectAndVerify(buyerSel, userName, '采购人员');
      if (!buyerR.ok) return buyerR;
      return { ok: true };
    },

    // 半自动模式：弹可拖动确认框，等用户核对页面已填信息后点「确认保存」/「取消」
    // 可拖动（不带遮罩）让用户能把框拖开、查看采购单页所有字段。Promise 直到用户点击才 resolve
    CPO_P2_CONFIRM_SAVE: async () => {
      return new Promise((resolve) => {
        document.getElementById('cpo-confirm-box')?.remove();
        const box = document.createElement('div');
        box.id = 'cpo-confirm-box';
        box.style.cssText = 'position:fixed;top:80px;right:30px;z-index:2147483647;width:300px;background:#fff;border:1px solid #1677ff;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.2);font-size:13px;color:#333;';
        const bar = document.createElement('div');
        bar.style.cssText = 'padding:8px 12px;background:#1677ff;color:#fff;border-radius:8px 8px 0 0;cursor:move;font-weight:600;';
        bar.textContent = '核对采购信息（可拖动）';
        const body = document.createElement('div');
        body.style.cssText = 'padding:12px;line-height:1.6;';
        body.innerHTML = '请核对采购单页的<b>采购人员 / 收货仓库 / 配对商品</b>，确认无误后点「确认保存」，将自动点击「保存，并通过审核」。';
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;padding:0 12px 12px;';
        const okBtn = document.createElement('button');
        okBtn.textContent = '确认保存';
        okBtn.style.cssText = 'flex:1;padding:7px;border:none;border-radius:4px;background:#1677ff;color:#fff;cursor:pointer;font-size:13px;';
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'flex:1;padding:7px;border:1px solid #ddd;border-radius:4px;background:#fff;color:#666;cursor:pointer;font-size:13px;';
        const finish = (result) => { box.remove(); resolve(result); };
        okBtn.addEventListener('click', () => finish({ ok: true }));
        cancelBtn.addEventListener('click', () => finish({ ok: true, cancelled: true }));
        btnRow.append(okBtn, cancelBtn);
        box.append(bar, body, btnRow);
        document.body.appendChild(box);
        U.makeDraggable(box, bar);
      });
    },

    CPO_P2_EDIT_SAVE: async () => {
      // 等保存按钮出现（防止 EDIT_FILL 与 SAVE 之间极短时序竞争）
      try { await U.waitForEl('.ant-btn', document, 5000); }
      catch { return { ok: false, error: '读取失败：edit 页保存按钮 5s 内未就绪' }; }
      // 点「保存，并通过审核」（注意文案含逗号）
      const saveBtn = U.findByText('button, .ant-btn', '保存，并通过审核')
        || U.findByText('button, .ant-btn', '保存并通过审核');
      if (!saveBtn) return { ok: false, error: '读取失败：未找到「保存，并通过审核」按钮' };
      U.showToast('创建采购单：正在保存并通过审核…', 'info');
      saveBtn.click();
      // 等成功弹窗（含「操作成功」或「采购单」关键字）
      let text = '';
      for (let i = 0; i < 30; i++) {                   // ~6s
        await U.sleep(200);
        const dlg = Array.from(document.querySelectorAll(
          '.ant-modal, .ant-modal-confirm, .ant-message, .ant-notification, .modal'))
          .find(d => d.getBoundingClientRect().height > 0 && /操作成功|采购单/.test(d.textContent));
        if (dlg) { text = dlg.textContent || ''; break; }
      }
      if (!text) return { ok: false, error: '业务拦截：未捕获到审核成功弹窗（保存可能被必填项拦截）' };
      const poNo = L.extractPoNo(text);
      if (!poNo) return { ok: false, error: '数据校验：审核弹窗未解析出采购单号。原文：' + text.slice(0, 120) };
      return { ok: true, poNo };
    },

    CPO_P2_WAIT_SEARCH: async ({ poNo }) => {
      // 等待待到货页 Vue 渲染完成（tab.status=complete ≠ Vue 组件就绪）
      try { await U.waitForEl('#searchValue, input[name="tableSearchInput"]', document, 10000); }
      catch { return { ok: false, error: '读取失败：待到货页搜索框 10s 内未渲染，表单未就绪' }; }

      // 切搜索类型为「采购单号」（v1.2.2 起新品+复购统一用 PO 号搜；默认通常已 active）
      // 注意：页面有 43 个 .d-tag-group-item（多组筛选 tag），但「采购单号」全局唯一
      const typeTag = Array.from(document.querySelectorAll('.d-tag-group-item'))
        .find(t => U.normText(t.textContent) === '采购单号');
      if (!typeTag) {
        return { ok: false, error: '读取失败：待到货页搜索类型「采购单号」未找到' };
      }
      if (!typeTag.classList.contains('active')) { typeTag.click(); await U.sleep(150); }

      // 搜索内容：input#searchValue（name=tableSearchInput）
      const kwInput = document.querySelector('#searchValue, input[name="tableSearchInput"]');
      if (!kwInput) return { ok: false, error: '读取失败：待到货页未找到搜索内容输入框' };
      U.setInputValue(kwInput, poNo);
      await U.sleep(150);

      // 搜索按钮：限定在搜索框容器内取 submit（避开高级搜索区的「搜索」）
      const scope = kwInput.closest('.search-container-main, .searchContainer') || document;
      const searchBtn = scope.querySelector('button[type="submit"]') || U.findByText('button, .ant-btn', '搜索', scope);
      if (!searchBtn) return { ok: false, error: '读取失败：待到货页未找到搜索按钮' };
      searchBtn.click();

      // 等 vxe-table 出结果（有数据行 + 无「暂无数据」空态）
      let found = false;
      for (let i = 0; i < 25; i++) {     // ~5s
        await U.sleep(200);
        const rows = document.querySelectorAll('.vxe-body--row');
        const emptyShown = Array.from(document.querySelectorAll('.vxe-table--empty-block, .empty-container'))
          .some(e => e.getBoundingClientRect().height > 0 && /暂无数据/.test(e.textContent));
        if (rows.length > 0 && !emptyShown) { found = true; break; }
      }
      U.showToast(found ? '已定位采购单，请手动点「申请付款」' : '未搜到采购单行，请手动核对', found ? 'ok' : 'error');
      return { ok: true, found };       // 搜不到不阻断 done（PO 号已从审核弹窗取得）
    },
  };

  // bg → content 命令分发（进度改由 chrome.storage.onChanged 驱动，不再走消息）
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const h = handlers[msg.type];
    if (!h) return;                                  // 非本 feature 命令，放行
    h(msg.data).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;                                     // 异步通道
  });
})();
