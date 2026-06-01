// auto_ship：发货单列表「待装箱发货」tab 自动发货编排（纯 content-script 单页）。
(function () {
  'use strict';
  const AS = window.AgentSeller;
  const U = AS.utils;
  const L = window.__AutoShipLogic;
  const SK_AUTO_CONFIRM = 'auto_ship_auto_confirm'; // chrome.storage.local 键

  const SHIP_LIST_RE = /seller\.kuajingmaihuo\.com\/main\/order-manager\/shipping-list/;
  function isShipListPage(href) { return SHIP_LIST_RE.test(href || location.href); }

  // ── 运行态（内存；SPA 不整页 reload，够用）──
  // processed/统计跨「开始」与多次「单步执行」累积；reload 重置。
  const run = {
    active: false,        // 正在处理中（开始或单步）
    autoConfirm: false,   // 镜像 storage 开关
    processed: new Set(), // 已处理发货单号（去重）
    shipped: 0,
    skippedLocal: 0,
    fails: [],
    total: 0,             // 初始扫描的发货单总数（动态取最大，不减）
  };

  // ── storage 开关 ──
  async function loadAutoConfirm() {
    try {
      const o = await chrome.storage.local.get(SK_AUTO_CONFIRM);
      run.autoConfirm = !!o[SK_AUTO_CONFIRM];
    } catch (_) { run.autoConfirm = false; }
    return run.autoConfirm;
  }
  async function saveAutoConfirm(v) {
    run.autoConfirm = !!v;
    try { await chrome.storage.local.set({ [SK_AUTO_CONFIRM]: run.autoConfirm }); } catch (_) {}
  }

  // ── UI ──
  function renderView(viewEl) {
    viewEl.innerHTML = `
      <div class="tal-card">
        <label class="as-toggle" style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="as-auto-confirm">
          <span>自动确认发货</span>
        </label>
        <div style="color:#888;font-size:12px;line-height:1.5;margin:4px 0 10px 24px">关：逐单弹窗确认<br>开：全自动直接确认发货</div>
        <div style="display:flex;gap:8px;margin:8px 0">
          <button id="as-start" class="tal-btn-primary">开始（全部）</button>
          <button id="as-step" class="tal-btn">单步执行</button>
        </div>
        <div id="as-progress" class="tal-status" style="white-space:pre-line"></div>
        <div id="as-summary" class="tal-status" style="white-space:pre-line;margin-top:6px"></div>
      </div>`;
    const cb = viewEl.querySelector('#as-auto-confirm');
    cb.checked = run.autoConfirm;
    cb.addEventListener('change', () => saveAutoConfirm(cb.checked));
    viewEl.querySelector('#as-start').addEventListener('click', onStart);
    viewEl.querySelector('#as-step').addEventListener('click', onStep);
  }

  function setProgress(msg) { const el = document.getElementById('as-progress'); if (el) el.textContent = msg || ''; }
  function setSummary(msg) { const el = document.getElementById('as-summary'); if (el) el.textContent = msg || ''; }
  function setButtonsEnabled(enabled) {
    const s = document.getElementById('as-start'); const t = document.getElementById('as-step');
    if (s) s.disabled = !enabled; if (t) t.disabled = !enabled;
  }
  function showSummary() {
    setSummary(L.summarize({ shipped: run.shipped, skippedLocal: run.skippedLocal, fails: run.fails }));
  }

  // ════════ DOM 适配层 A：tab / 扫描 / 行定位 / 读取（据 samples/table_and_tabs.txt 真实 DOM）════════
  const SEL = {
    bodyRow: '[data-testid="beast-core-table-body-tr"]',
    checkbox: '[data-testid="beast-core-checkbox"]',
    tabLabel: '[data-testid="beast-core-tab-itemLabel"]',
    scrollContainer: '[class*="contentContainer"]',
    btnLink: '[data-testid="beast-core-button-link"]',
  };
  const TAB_PENDING = '待装箱发货';
  const TAB_RECEIVED = '待仓库收货';

  // ── 错误分层标记（spec §9）──
  function markRead(err) { err._cat = 'read'; return err; }
  function markData(err) { err._cat = 'data'; return err; }
  function markBiz(err) { err._cat = 'biz'; return err; }

  // ── 行 / 单元格 ──
  function bodyRows() { return Array.from(document.querySelectorAll(SEL.bodyRow)); }
  function rowCells(tr) { return Array.from(tr.querySelectorAll(':scope > td')); }
  function rowCheckbox(tr) { return tr.querySelector(SEL.checkbox); }

  // 发货单号：td[1] 内首个无子元素纯文本 div（如 FH2605284051650）
  function readOrderNo(tr) {
    const cell = rowCells(tr)[1];
    if (!cell) return '';
    const box = cell.querySelector('[data-testid="beast-core-box"]') || cell;
    const leaf = Array.from(box.querySelectorAll('div')).find((d) => d.children.length === 0 && /\S/.test(d.textContent));
    if (leaf) return leaf.textContent.trim();
    const m = U.normText(cell.textContent).match(/^([A-Za-z0-9]{6,})/);
    return m ? m[1] : '';
  }
  // 发货仓库：td[3]「发货信息」列。整列文本正则提取「发货仓库：」到「更换/收货仓库」之间
  // （dump 验证：DOM 结构 label.parentElement.querySelector('div span') 会误中 label 自身，故只用 regex）
  function readWarehouseName(tr) {
    const cell = rowCells(tr)[3];
    if (!cell) return '';
    const m = U.normText(cell.textContent).match(/发货仓库[:：]\s*([\s\S]*?)(?:更换|收货仓库|$)/);
    return m ? m[1].trim() : '';
  }
  // 包裹号：td[4]。空值=「打印打包标签后展示」→ 返回 ''；有值=PC2605285400438
  function readPackageNo(tr) {
    const cell = rowCells(tr)[4];
    if (!cell) return '';
    const t = U.normText(cell.textContent);
    if (t.includes('打印打包标签后展示')) return '';
    const m = t.match(/([A-Z]{2}\d{6,})/);
    return m ? m[1] : t;
  }

  // ── 滚动容器（页面级；无滚动则 null，一次性枚举）──
  function getScrollContainer() {
    const el = document.querySelector(SEL.scrollContainer);
    if (el && el.scrollHeight > el.clientHeight + 5) return el;
    return null;
  }

  // ── 滚动扫描：枚举当前活表格所有发货单号（去重）──
  async function scanOrderNos() {
    const found = [];
    const collect = () => { for (const tr of bodyRows()) { const no = readOrderNo(tr); if (no) found.push(no); } };
    const sc = getScrollContainer();
    if (!sc) { collect(); return L.dedupOrderNos(found); }
    sc.scrollTop = 0; await U.sleep(300); collect();
    let lastTop = -1, stable = 0;
    while (stable < 2) {
      sc.scrollTop = Math.min(sc.scrollTop + sc.clientHeight * 0.8, sc.scrollHeight);
      await U.sleep(300); collect();
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
      if (sc.scrollTop === lastTop || atBottom) stable += 1; else stable = 0;
      lastTop = sc.scrollTop;
    }
    return L.dedupOrderNos(found);
  }

  // ── 定位发货单（一行一单；滚动到渲染为止）。返回 {orderNo, tr, checkbox} | null ──
  function tryFindRow(orderNo) {
    for (const tr of bodyRows()) {
      if (readOrderNo(tr) === orderNo) return { orderNo, tr, checkbox: rowCheckbox(tr) };
    }
    return null;
  }
  async function findRow(orderNo) {
    const sc = getScrollContainer();
    if (!sc) return tryFindRow(orderNo);
    sc.scrollTop = 0; await U.sleep(250);
    let r = tryFindRow(orderNo); if (r) return r;
    let lastTop = -1;
    while (true) {
      sc.scrollTop = Math.min(sc.scrollTop + sc.clientHeight * 0.8, sc.scrollHeight);
      await U.sleep(250);
      r = tryFindRow(orderNo); if (r) return r;
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
      if (sc.scrollTop === lastTop || atBottom) break;
      lastTop = sc.scrollTop;
    }
    return null;
  }

  // ── in-page tab ──
  function tabLabels() { return Array.from(document.querySelectorAll(SEL.tabLabel)); }
  function getActiveTabText() {
    const el = tabLabels().find((t) => /active/i.test(t.className)
      || /active/i.test((t.parentElement && t.parentElement.className) || ''));
    return el ? U.normText(el.textContent) : '';
  }
  function isOnPendingTab() { return getActiveTabText().includes(TAB_PENDING); }
  async function clickTab(text) {
    const el = tabLabels().find((t) => U.normText(t.textContent) === text);
    if (!el) throw markRead(new Error(`读取失败：未找到 tab「${text}」`));
    el.click();
    await U.waitForEl(SEL.bodyRow, 8000).catch(() => {});
    await U.sleep(400);
  }
  async function ensureOnPendingTab() { if (!isOnPendingTab()) await clickTab(TAB_PENDING); }
  async function refreshViaTabSwitch() {
    await clickTab(TAB_RECEIVED); await U.sleep(600);
    await clickTab(TAB_PENDING); await U.sleep(600);
  }

  // ════════ DOM 适配层 B：选中 + 操作按钮 + 弹窗/编辑页动作（含写后读校验）════════
  // 行内动作据 samples row dump 确定；弹窗动作用文字匹配（Beast 弹窗按钮文字稳定），
  // 编辑页字段(包装方式/箱数)标注联调验证——Task 11 若不命中据 EDIT_PAGE 现场 dump 修正。

  // ── 弹窗助手 ──
  // 优先 beast-core-modal-inner（弹窗主体，含完整内容），取最后一个=最上层。
  // 不能用 [class*="MDL_"] 宽候选：querySelectorAll 顺序下 c[last] 会落到空的 MDL_overflowGradient（dump 教训）。
  function topModal() {
    const inners = document.querySelectorAll('[data-testid="beast-core-modal-inner"]');
    if (inners.length) return inners[inners.length - 1];
    const c = document.querySelectorAll('[data-testid="beast-core-modal-innerWrapper"],[role="dialog"]');
    return c.length ? c[c.length - 1] : null;
  }
  function isVisible(el) { return !!(el && el.getClientRects().length); }
  // Popover/Popconfirm 容器（Beast 二次确认走 popover，非 modal——见 samples/first_ship_small_modal.txt）
  function topPopover() {
    const pops = Array.from(document.querySelectorAll('[class*="popoverContent"]')).filter(isVisible);
    return pops.length ? pops[pops.length - 1] : null;
  }
  // Drawer 容器（装箱发货编辑页走 drawer，非 modal/popover——见 samples/edit_page.txt）
  function topDrawer() {
    const d = Array.from(document.querySelectorAll('[data-testid="beast-core-drawer-content"]')).filter(isVisible);
    return d.length ? d[d.length - 1] : null;
  }
  function editScope() { return topDrawer() || document; }
  async function waitEditGone(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    while (Date.now() < deadline) { if (!topDrawer()) return true; await U.sleep(150); }
    return false;
  }
  function findClickableByText(scope, text) {
    const root = scope || document;
    const nodes = Array.from(root.querySelectorAll(
      'button,[data-testid="beast-core-button"],a,[data-testid="beast-core-button-link"],span,[class*="link"],[class*="Link"]'
    ));
    return nodes.find((n) => U.normText(n.textContent) === text)
      || nodes.find((n) => U.normText(n.textContent).includes(text)) || null;
  }
  // 在最上层弹窗内点击文字命中元素（texts 数组兜底文案差异）；超时报读取失败。
  async function clickModalText(texts, timeoutMs) {
    const arr = Array.isArray(texts) ? texts : [texts];
    const deadline = Date.now() + (timeoutMs || 6000);
    while (Date.now() < deadline) {
      const modal = topModal();
      if (modal) for (const text of arr) {
        const el = findClickableByText(modal, text);
        if (el) { el.click(); return text; }
      }
      await U.sleep(150);
    }
    throw markRead(new Error(`读取失败：弹窗内未找到「${arr.join('/')}」`));
  }

  // ── 选中行 checkbox（写后读：勾选后回读 checked）──
  function rowChecked(checkbox) {
    const i = checkbox && checkbox.querySelector('input[type="checkbox"]');
    return (i && i.checked) || (checkbox && checkbox.getAttribute('data-checked') === 'true');
  }
  // ── 当前操作行整行高亮（视觉反馈）──
  function ensureHighlightStyle() {
    if (document.getElementById('as-hl-style')) return;
    const s = document.createElement('style');
    s.id = 'as-hl-style';
    s.textContent = 'tr.as-active-row, tr.as-active-row > td '
      + '{ background-color: #fff3cd !important; box-shadow: inset 3px 0 0 0 #ff6800; }';
    (document.head || document.documentElement).appendChild(s);
  }
  function clearRowHighlight() {
    document.querySelectorAll('tr.as-active-row').forEach((el) => el.classList.remove('as-active-row'));
  }
  function highlightRow(tr) {
    ensureHighlightStyle();
    clearRowHighlight();
    if (!tr) return;
    tr.classList.add('as-active-row');
    // 滚动到可视区中央，让用户看清当前处理行（居中后该行在视口内，虚拟滚动不回收，row.tr 引用仍有效）
    try { tr.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
  }

  // 取消除 except 外所有已勾选行。「批量装箱发货」按所有选中行操作，选中前必须清掉
  // 上一单残留选中（尤其取消未发货的单 checkbox 仍勾着），否则两单一起被操作而失败。
  async function clearOtherSelections(except) {
    const checked = bodyRows().map((tr) => rowCheckbox(tr))
      .filter((cb) => cb && cb !== except && rowChecked(cb));
    for (const cb of checked) { cb.click(); await U.sleep(80); }
  }
  async function selectRow(row) {
    const cb = row.checkbox;   // cb 是 label[data-testid="beast-core-checkbox"]
    if (!cb) throw markRead(new Error(`读取失败：发货单 ${row.orderNo} 未找到 checkbox`));
    await clearOtherSelections(cb);   // 先清其它选中，确保批量装箱发货只操作当前单
    // dump 验证：input.click() 无效，label.click() 才触发 React onChange（data-checked/input.checked 同步更新）
    if (!rowChecked(cb)) { cb.click(); await U.sleep(200); }
    if (!rowChecked(cb)) throw markData(new Error(`数据校验：发货单 ${row.orderNo} 勾选后未选中`));
  }

  // ── 操作列按钮（一行一单，在 row.tr 内找）──
  function clickRowBtn(row, text) {
    const cell = rowCells(row.tr)[6] || row.tr;            // 操作列 td[6]
    const links = Array.from(cell.querySelectorAll(SEL.btnLink))
      .filter((a) => !a.hasAttribute('disabled'));
    const el = links.find((a) => U.normText(a.textContent) === text)
      || links.find((a) => U.normText(a.textContent).includes(text));
    if (!el) throw markRead(new Error(`读取失败：发货单 ${row.orderNo} 操作列未找到「${text}」`));
    el.click();
  }
  async function clickPrintPackLabel(row) { clickRowBtn(row, '打印商品打包标签'); }

  // ── 弹窗②：先发货后打印（在 PRINT_CONFIRM modal 正文，用 topModal）──
  async function clickFirstShipThenPrint() { await clickModalText('先发货后打印', 6000); }
  // ── 弹窗③：小弹窗确认（是 Popover 非 modal，用 topPopover）──
  async function confirmSmallModal() {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const pop = topPopover();
      if (pop) {
        const btn = findClickableByText(pop, '确认') || findClickableByText(pop, '确定');
        if (btn) { btn.click(); return; }
      }
      await U.sleep(150);
    }
    throw markRead(new Error('读取失败：未找到「先发货后打印」二次确认弹窗的确认按钮'));
  }

  // ── 等包裹号刷新（中途切 tab 刷新一次；超时报业务错）──
  async function waitPackageNo(orderNo, timeoutMs) {
    const total = timeoutMs || 15000;
    const start = Date.now();
    let refreshed = false;
    while (Date.now() - start < total) {
      const r = await findRow(orderNo);
      if (r && L.isValidPackageNo(readPackageNo(r.tr))) return readPackageNo(r.tr);
      if (!refreshed && Date.now() - start > total / 2) { refreshed = true; await refreshViaTabSwitch(); }
      await U.sleep(800);
    }
    throw markBiz(new Error(`业务：包裹号超时未生成（发货单 ${orderNo}）`));
  }

  // ── 批量装箱发货（页面级按钮，选中才可点）+ 弹窗④去装箱发货 ──
  function isBtnDisabled(btn) {
    return btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true'
      || /disabled/i.test(btn.className) || /disabled/i.test((btn.closest('[class*="BTN_"]') || {}).className || '');
  }
  async function clickBatchShip(orderNo) {
    // 选中态→按钮可点需 React 重渲染，轮询等 enabled（非固定 sleep，避免慢机器时序竞争）
    const deadline = Date.now() + 3000;
    let btn = null;
    while (Date.now() < deadline) {
      btn = findClickableByText(document, '批量装箱发货');
      if (btn && !isBtnDisabled(btn)) { btn.click(); return; }
      await U.sleep(150);
    }
    if (!btn) throw markRead(new Error('读取失败：未找到「批量装箱发货」按钮'));
    throw markBiz(new Error(`业务：发货单 ${orderNo} 选中后「批量装箱发货」3s 内未变可点`));
  }
  // 确认窗是 modal；若已勾「30天内不再提醒」则不弹、直接出编辑页 drawer → 容错跳过
  async function confirmBatchShipModal() {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (topDrawer()) return;                       // 已直接进编辑页（确认窗被跳过）
      const modal = topModal();
      if (modal) { const btn = findClickableByText(modal, '去装箱发货'); if (btn) { btn.click(); return; } }
      await U.sleep(150);
    }
    if (topDrawer()) return;
    throw markRead(new Error('读取失败：未出现「去装箱发货」确认或装箱发货编辑页'));
  }

  // ── 编辑页（Drawer）填写：包装方式 radio + 箱数 input，按 form-item id 精确定位 + 写后读校验 ──
  async function selectPackType(label) {
    const scope = editScope();
    const formItem = scope.querySelector('#packagingType') || scope;
    const radios = Array.from(formItem.querySelectorAll('[data-testid="beast-core-radio"]'));
    const radio = radios.find((r) => {
      const t = r.querySelector('[class*="textWrapper"]') || r;
      return U.normText(t.textContent) === label;
    });
    if (!radio) throw markRead(new Error(`读取失败：编辑页未找到包装方式「${label}」`));
    radio.click();                                   // radio 是 label，label.click 才触发（同 checkbox）
    await U.sleep(300);
    const ok = radio.getAttribute('data-checked') === 'true' || /RD_active|RDG_active/.test(radio.className);
    if (!ok) throw markData(new Error(`数据校验：包装方式填写后不符，期望「${label}」`));
  }
  async function fillBoxCount(want) {
    const scope = editScope();
    const formItem = scope.querySelector('#expressPackageNum') || scope;
    const input = formItem.querySelector('input[data-testid="beast-core-inputNumber-htmlInput"]')
      || formItem.querySelector('input[placeholder*="箱"]') || formItem.querySelector('input');
    if (!input) throw markRead(new Error('读取失败：编辑页未找到「发货总箱/包数」输入框'));
    U.setInputValue(input, String(want));
    await U.sleep(200);
    if (String(input.value).trim() !== String(want)) {
      throw markData(new Error(`数据校验：发货箱数填写后不符，期望「${want}」实际「${input.value}」`));
    }
  }
  // ── 预约取货时间（timePicker）：填完箱数后 Temu 自动补日期，时间需手选（默认 18:00）──
  // input readonly 不能 setInputValue，必须点开下拉 portal 选时/分。
  // 下拉 portal 挂 document 级（不在 drawer 内）；时/分各一个 ul，li 文字=数值，cIL_disabled 不可选。
  // 多重兜底打开下拉：点 input → suffix 时钟图标 → 容器，直到 hh 列表出现。
  async function openTimeDropdown(input, tp) {
    const targets = [input, tp.querySelector('[data-testid="beast-core-input-suffix"]'), tp];
    for (const target of targets) {
      if (!target) continue;
      target.click();
      await U.sleep(300);
      if (document.querySelector('ul[data-testid="beast-core-timePicker-list-hh"]')) return true;
    }
    return false;
  }
  // 点下拉时/分列表里文字命中且未 disabled 的 li；轮询等待（选时后分钟列表异步刷新可选项）。
  async function clickTimeListItem(which, text) {
    const sel = `ul[data-testid="beast-core-timePicker-list-${which}"]`;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const ul = document.querySelector(sel);          // portal 在 document 级，不在 drawer 内
      if (ul) {
        const li = Array.from(ul.querySelectorAll('li'))
          .find((x) => U.normText(x.textContent) === text && !/disabled/i.test(x.className));
        if (li) { li.click(); return true; }
      }
      await U.sleep(150);
    }
    return false;
  }
  async function fillPickupTime(hhmm) {
    const want = String(hhmm);                          // '18:00'
    const [hh, mm] = want.split(':');
    const scope = editScope();
    // 1. 等填箱数后日期被 Temu 自动补上（时间选择器随之可点）：日期 input 有值即视为就绪
    const dateDeadline = Date.now() + 6000;
    while (Date.now() < dateDeadline) {
      const di = scope.querySelector('#expectPickUpGoodsDate input[data-testid="beast-core-datePicker-htmlInput"]');
      if (di && String(di.value).trim()) break;
      await U.sleep(200);
    }
    // 2. 定位时间输入框
    const tp = scope.querySelector('#expectPickUpGoodsTime [data-testid="beast-core-timePicker-input"]');
    const input = tp && tp.querySelector('input[data-testid="beast-core-timePicker-html-input"]');
    if (!input) throw markRead(new Error('读取失败：编辑页未找到「预约取货时间」时间输入框'));
    if (String(input.value).startsWith(want)) return;   // 已是目标值，幂等跳过
    // 3. 点开下拉 → 选时 → 选分（选时后分钟列表才刷新可选项）
    if (!await openTimeDropdown(input, tp)) throw markRead(new Error('读取失败：预约取货时间下拉未弹出'));
    if (!await clickTimeListItem('hh', hh)) throw markRead(new Error(`读取失败：取货时间「时」下拉无可选「${hh}」`));
    await U.sleep(300);
    if (!await clickTimeListItem('mm', mm)) throw markRead(new Error(`读取失败：取货时间「分」下拉无可选「${mm}」`));
    await U.sleep(300);
    // 4. 写后读校验（无「确定」按钮，选完即回填 input；可能回填 18:00 或 18:00:00，用 startsWith 兼容）
    if (!String(input.value).startsWith(want)) {
      throw markData(new Error(`数据校验：预约取货时间填写后不符，期望「${want}」实际「${input.value}」`));
    }
  }
  async function fillEditPage() {
    // 等 drawer 渲染出 packagingType（status=complete ≠ 组件渲染完）
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { const d = topDrawer(); if (d && d.querySelector('#packagingType')) break; await U.sleep(200); }
    await U.sleep(300);
    await selectPackType('箱子和袋子');
    await fillBoxCount('1');
    await fillPickupTime('18:00');                       // 箱数填完后日期自动补、时间需手选 18:00
  }

  // ── 确认发货 / 关闭编辑页（drawer footer）──
  // 点完编辑页「确认发货」后 Temu 还会弹 popover 二次确认（标题「确认装箱完毕并发货？」），
  // 必须点 popover 里的「确认」才真发货——联调实测确认，与「先发货后打印」popover 同类容器但文案/语境不同。
  async function clickConfirmShip() {
    const scope = editScope();
    const footer = scope.querySelector('[class*="footer"]') || scope;
    const btn = findClickableByText(footer, '确认发货') || findClickableByText(scope, '确认发货');
    if (!btn) throw markRead(new Error('读取失败：编辑页未找到「确认发货」按钮'));
    btn.click();
    await confirmShipPopover();
  }
  // 「确认装箱完毕并发货？」二次确认 popover。错误文案与 confirmSmallModal 分开（错误分层铁律：
  // 两个步骤分别报错，调试时不混淆——避免「确认发货失败」被误诊成「先发货后打印失败」）。
  async function confirmShipPopover() {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const pop = topPopover();
      if (pop) {
        const btn = findClickableByText(pop, '确认') || findClickableByText(pop, '确定');
        if (btn) { btn.click(); return; }
      }
      await U.sleep(150);
    }
    throw markRead(new Error('读取失败：未出现「确认装箱完毕并发货」二次确认弹窗'));
  }
  async function closeEditPage() {
    const scope = editScope();
    if (scope === document) return;                  // 没有 drawer，无需关
    const footer = scope.querySelector('[class*="footer"]');
    const btn = (footer && findClickableByText(footer, '取消'))
      || scope.querySelector('[data-testid="beast-core-icon-close"]');
    if (btn) btn.click();
    await waitEditGone(5000);
  }

  // ════════ OFF 模式逐单确认框（可拖动，不超时）════════
  // 返回 Promise<boolean>：true=确认发货，false=取消（关编辑页跳过）。
  function askConfirmShip(orderNo) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;z-index:2147483600;left:50%;top:120px;transform:translateX(-50%);'
        + 'background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.2);'
        + 'width:340px;font-size:14px;color:#222';
      ov.innerHTML = `
        <div class="as-confirm-head" style="padding:10px 14px;cursor:move;background:#f5f5f5;border-radius:8px 8px 0 0;font-weight:600">确认发货？</div>
        <div style="padding:14px">
          <div>发货单号：<b>${orderNo}</b></div>
          <div style="color:#888;margin-top:6px">点「确认发货」将真实出货（不可逆）；点「取消」关闭编辑页、跳过本单。</div>
          <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">
            <button id="as-c-cancel" class="tal-btn">取消</button>
            <button id="as-c-ok" class="tal-btn-primary">确认发货</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      try { U.makeDraggable(ov, ov.querySelector('.as-confirm-head')); } catch (_) {}
      const done = (v) => { try { ov.remove(); } catch (_) {} resolve(v); };
      ov.querySelector('#as-c-ok').addEventListener('click', () => done(true));
      ov.querySelector('#as-c-cancel').addEventListener('click', () => done(false));
    });
  }

  // ════════ 单发货单状态机（spec §5）════════
  // 返回 { orderNo, kind, shipped }；kind ∈ local|shipped|cancelled。
  // 失败抛带 _cat 的错误，由主循环捕获。
  async function processOrder(orderNo) {
    let row = await findRow(orderNo);
    if (!row) throw markRead(new Error(`读取失败：未定位到发货单 ${orderNo} 的行`));
    highlightRow(row.tr);                              // 整行高亮当前操作单

    // 1. 本地仓跳过
    if (L.isLocalWarehouse(readWarehouseName(row.tr))) {
      return { orderNo, kind: 'local', shipped: false };
    }

    // 2. 包裹号：没有才走「打印打包标签 → 先发货后打印 → 小弹窗确认 → 等包裹号」
    if (!L.isValidPackageNo(readPackageNo(row.tr))) {
      await selectRow(row);
      await clickPrintPackLabel(row);
      await clickFirstShipThenPrint();
      await confirmSmallModal();
      await waitPackageNo(orderNo, 15000);
    }

    // 3. 重新定位（包裹号刷新后行可能重排）→ 选中 → 批量装箱发货 → 去装箱发货
    row = await findRow(orderNo);
    if (!row) throw markRead(new Error(`读取失败：等包裹号后未定位到发货单 ${orderNo}`));
    highlightRow(row.tr);                              // 行重排后重新高亮
    await selectRow(row);
    await clickBatchShip(orderNo);
    await confirmBatchShipModal();

    // 4. 编辑页填写（写后读校验在适配层内）
    await fillEditPage();

    // 5. 确认发货门控
    const confirmed = run.autoConfirm ? true : await askConfirmShip(orderNo);
    if (confirmed) {
      await clickConfirmShip();
      await U.sleep(800);                     // 让 SPA 切到待仓库收货
      return { orderNo, kind: 'shipped', shipped: true };
    }
    await closeEditPage();
    return { orderNo, kind: 'cancelled', shipped: false };
  }

  // ════════ 主循环（spec §6）════════
  function catLabel(cat) { return cat === 'data' ? '校验' : cat === 'biz' ? '业务' : '读取'; }

  // 取下一个未处理发货单号 + 更新 run.total；本轮无 → 切 tab 刷新再确认一次（防刷新延迟脏数据）。
  async function scanForPick() {
    await ensureOnPendingTab();                        // 每次都先切回待装箱发货 tab
    let live = await scanOrderNos();
    let remaining = live.filter((no) => !run.processed.has(no));
    if (!remaining.length) {
      await refreshViaTabSwitch();
      live = await scanOrderNos();
      remaining = live.filter((no) => !run.processed.has(no));
    }
    run.total = Math.max(run.total, run.processed.size + remaining.length);
    return remaining[0] || null;
  }

  // 处理一个发货单（切回待装箱发货 tab + 取下一个未处理 + 处理 + 记账 + 去重）。
  // 返回处理的 orderNo，或 null（已无待处理单）。单步/全自动共用。
  async function stepOnce() {
    const orderNo = await scanForPick();              // 内部先切回待装箱发货 tab
    if (!orderNo) return null;
    setProgress(`正在处理第 ${run.processed.size + 1} / 共 ${run.total} 个\n当前发货单：${orderNo}`);
    try {
      const r = await processOrder(orderNo);
      if (r.kind === 'local') run.skippedLocal += 1;
      else if (r.kind === 'shipped') run.shipped += 1;
      // cancelled：不计 shipped，仍算已处理
    } catch (err) {
      run.fails.push({ orderNo, step: catLabel(err && err._cat), reason: (err && err.message) || String(err) });
      console.warn('[auto_ship] 单失败:', orderNo, err);
      try { await closeEditPage(); } catch (_) {}      // 清残留弹窗，避免污染下一单
    }
    run.processed.add(orderNo);
    return orderNo;
  }

  function resetRunStats() { run.processed = new Set(); run.shipped = 0; run.skippedLocal = 0; run.fails = []; run.total = 0; }

  // 「开始（全部）」：从头全自动处理所有未处理发货单。
  async function onStart() {
    if (run.active) return;
    if (!isShipListPage()) { AS.showToast('请在发货单列表页使用', 'warn'); return; }
    run.active = true; setButtonsEnabled(false);
    resetRunStats(); setSummary('');
    await loadAutoConfirm();                            // 取最新开关
    try {
      while (true) { const done = await stepOnce(); if (!done) break; }
      setProgress('已完成');
    } catch (err) {
      console.error('[auto_ship] 全自动异常:', err);
      setProgress('异常终止：' + ((err && err.message) || err));
    } finally {
      run.active = false; setButtonsEnabled(true); clearRowHighlight(); showSummary();
      AS.showToast(`自动发货结束：确认发货 ${run.shipped} / 跳过本地仓 ${run.skippedLocal} / 失败 ${run.fails.length}`,
        run.fails.length ? 'warn' : 'success');
    }
  }

  // 「单步执行」：只处理一个发货单（processed 跨多次单步累积去重）；每次都先切回待装箱发货 tab。
  async function onStep() {
    if (run.active) return;
    if (!isShipListPage()) { AS.showToast('请在发货单列表页使用', 'warn'); return; }
    run.active = true; setButtonsEnabled(false);
    await loadAutoConfirm();
    try {
      const done = await stepOnce();
      // 单步处理完保留当前行高亮（让用户看清刚处理的是哪单）；下次单步/开始时 highlightRow 自动切换。
      // 仅「已无待处理单」才清；异常时也保留高亮指示出错行。
      if (!done) { clearRowHighlight(); setProgress('已无待处理发货单'); AS.showToast('已无待处理发货单', 'success'); }
      else { setProgress(`已处理：${done}（${run.processed.size}/${run.total}）`); }
      showSummary();
    } catch (err) {
      console.error('[auto_ship] 单步异常:', err);
      setProgress('异常：' + ((err && err.message) || err));
    } finally {
      run.active = false; setButtonsEnabled(true);
    }
  }

  AS.registerFeature({
    id: 'auto_ship',
    icon: '📦',
    label: '自动发货',
    init() { loadAutoConfirm(); AS.onPageChange(() => {}); },
    render: renderView,
  });
})();
