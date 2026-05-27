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
               p2Status: null, p2Data: null, p2Btn: null, orderInput: null, p2Msg: null };

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
    if (ui.p2Data) {
      const c2 = p2.collected2 || {};
      ui.p2Data.textContent = (p2.status === 'done' && c2.poNo)
        ? '当前订单信息：' + c2.poNo + '（' + (c2.orderNo1688 || '-') + '）'
        : '';
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
      else started = true;
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
    ui.p2Btn.disabled = !(lastP1Done && isDxmPage() && orderVal);
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
      const o = await chrome.storage.local.get(STATE_KEY);
      const p1Done = !!(o[STATE_KEY] && o[STATE_KEY].phase1 && o[STATE_KEY].phase1.status === 'done');
      const v = L.validatePhase2({ orderNo1688, phase1Done: p1Done });
      if (!v.ok) { setP2Msg(v.error, 'error'); return; }   // finally 会复位守卫+恢复按钮
      setP2Msg('启动中…');
      const resp = await chrome.runtime.sendMessage({ type: 'CPO_START_PHASE2', data: { orderNo1688 } });
      if (!resp?.ok) setP2Msg(resp?.error || '启动失败', 'error');
      else started = true;
    } catch (e) {
      setP2Msg('启动失败：' + e.message, 'error');
    } finally {
      cpoStarting2 = false;
      if (!started) recomputeP2Btn();                // 启动成功则保持禁用（流程在跑）
    }
  }

  // 清除当前流程数据：两个 phase 未全部完成时先确认，避免误清未完成的工作
  async function onClear() {
    const o = await chrome.storage.local.get(STATE_KEY);
    const st = o[STATE_KEY];
    const p1 = (st && st.phase1) || {};
    const p2 = (st && st.phase2) || {};
    const c = p1.collected || {};
    const hasData = (p1.status && p1.status !== 'idle') || c.skuNo || c.title;
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
      const h1 = document.createElement('div');
      h1.style.cssText = 'font-weight:600;color:#1677ff;';
      h1.textContent = '① 添加SKU';
      ui.p1Status = document.createElement('div');
      ui.p1Status.style.cssText = 'color:#666;';
      ui.p1Data = document.createElement('div');
      ui.p1Data.style.cssText = 'color:#888;font-size:11px;line-height:1.4;';
      wrap.append(h1, ui.p1Status, ui.p1Data);

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
        wrap.append(hint, ui.urlInput, ui.startBtn, ui.localMsg);
      } else {
        const note = document.createElement('div');
        note.style.cssText = 'color:#999;font-size:11px;';
        note.textContent = '（在 Temu 商家中心商品列表发起）';
        wrap.append(note);
      }

      const hr = document.createElement('div');
      hr.style.cssText = 'border-top:1px dashed #ddd;margin:4px 0;';
      wrap.append(hr);

      // ===== ② 创建采购单（店小秘发起，需 Phase 1 完成） =====
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
        hint2.textContent = '需先完成①添加SKU；填 1688订单号后开始';
        ui.orderInput = document.createElement('input');
        ui.orderInput.placeholder = '1688订单号';
        ui.orderInput.style.cssText = 'padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;';
        ui.orderInput.addEventListener('input', recomputeP2Btn);
        ui.p2Btn = document.createElement('button');
        ui.p2Btn.className = 'tal-action-btn';
        ui.p2Btn.textContent = '开始创建采购单';
        ui.p2Btn.disabled = true;
        ui.p2Btn.addEventListener('click', onStartPhase2);
        ui.p2Msg = document.createElement('div');
        ui.p2Msg.style.cssText = 'font-size:11px;color:#666;min-height:16px;';
        wrap.append(hint2, ui.orderInput, ui.p2Btn, ui.p2Msg);
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

  // 打开 ant-select 下拉、选第一个可见非空选项（用于唯一项的账号下拉）→ 成功 true
  async function cpoSelectFirstOption(sel) {
    const combo = sel.querySelector('input');
    (sel.querySelector('.ant-select-selector') || sel).click();
    const listId = combo && (combo.getAttribute('aria-controls') || combo.getAttribute('aria-owns'));
    for (let i = 0; i < 30; i++) {
      await U.sleep(100);
      const scoped = listId && document.getElementById(listId)?.closest('.ant-select-dropdown');
      const scopes = scoped ? [scoped]
        : Array.from(document.querySelectorAll('.ant-select-dropdown')).filter(d => d.getBoundingClientRect().height > 0);
      for (const s of scopes) {
        const opt = Array.from(s.querySelectorAll('[role="option"], .ant-select-item-option'))
          .find(o => U.normText(o.textContent));   // 第一个有文本的选项
        if (opt) { opt.click(); return true; }
      }
    }
    return false;
  }

  // 选 ant-select 中 textContent 精确等于 want 的选项（采购人员/收货仓库/搜索类型用）→ 成功 true
  async function cpoSelectOptionByText(sel, want) {
    const combo = sel.querySelector('input');
    (sel.querySelector('.ant-select-selector') || sel).click();
    const listId = combo && (combo.getAttribute('aria-controls') || combo.getAttribute('aria-owns'));
    const target = U.normText(want);
    for (let i = 0; i < 30; i++) {
      await U.sleep(100);
      const scoped = listId && document.getElementById(listId)?.closest('.ant-select-dropdown');
      const scopes = scoped ? [scoped]
        : Array.from(document.querySelectorAll('.ant-select-dropdown')).filter(d => d.getBoundingClientRect().height > 0);
      for (const s of scopes) {
        const opt = Array.from(s.querySelectorAll('[role="option"], .ant-select-item-option'))
          .find(o => U.normText(o.textContent) === target);
        if (opt) { opt.click(); return true; }
      }
    }
    return false;
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
    CPO_P2_DRAFT_CREATE: async () => {
      // 触发器：ant-btn + ant-dropdown-trigger，文字 span「创建采购单」+ icon_down
      const trigger = U.findByText('button.ant-dropdown-trigger, button.ant-btn', '创建采购单');
      if (!trigger) return { ok: false, error: '未找到「创建采购单」按钮' };
      trigger.click();
      // 下拉预渲染（初始隐藏），轮询等「创建现有订单」项【可见】再点
      // （固定 sleep 不可靠且会命中隐藏预渲染项；用可见性过滤，同 Phase 1 cpoFillPersonnel）
      let item = null;
      for (let i = 0; i < 20 && !item; i++) {   // ~2s
        await U.sleep(100);
        item = Array.from(document.querySelectorAll('.ant-dropdown-menu-item'))
          .find(el => U.normText(el.textContent) === '创建现有订单' && el.getBoundingClientRect().height > 0);
      }
      if (!item) return { ok: false, error: '「创建采购单」下拉未展开或无「创建现有订单」项' };
      item.click();   // 店小秘新开 add tab（手动实测为新标签、未拦截），bg cpoCaptureChildTab 捕获
      return { ok: true };
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
      // a) 1688账号下拉选第一项（唯一、与账号绑定 greenworld_绿城）
      const acctSel = cpoFindSelectByLabel('1688账号');
      if (!acctSel) return { ok: false, error: '未找到「1688账号」下拉' };
      if (!(await cpoSelectFirstOption(acctSel))) return { ok: false, error: '「1688账号」下拉无可选项' };
      await U.sleep(200);
      // b) 填 1688订单号 —— 真实 DOM 是 textarea（非 input！）placeholder「填写1688订单号，多订单号请用回车键分隔」
      const orderInput = document.querySelector('textarea[placeholder*="1688订单号"], textarea[placeholder*="订单号"]');
      if (!orderInput) return { ok: false, error: '未找到「1688订单」输入框' };
      U.setInputValue(orderInput, orderNo1688);
      await U.sleep(150);
      // c) 点「获取1688订单」（warn-btn）
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
  };

  // bg → content 命令分发（进度改由 chrome.storage.onChanged 驱动，不再走消息）
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const h = handlers[msg.type];
    if (!h) return;                                  // 非本 feature 命令，放行
    h(msg.data).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;                                     // 异步通道
  });
})();
