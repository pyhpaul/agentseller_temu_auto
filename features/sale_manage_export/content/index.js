// sale_manage_export：销售管理页（agentseller.temu.com/stock/fully-mgt/sale-manage）
// 采集表格所有分页的 SKC/SKC货号/SPU/商品名称 → CSV 写入预设文件夹。
(function () {
  'use strict';
  const AS = window.AgentSeller;
  const U = AS.utils;
  const sendNative = AS.sendNative;
  const SU = window.__SMEUtils;   // sme-utils.js（document_start 注入）
  const LS_PATH = 'smeSavePath';

  function isSaleManagePage(href) {
    return /agentseller\.temu\.com\/stock\/fully-mgt\/sale-manage/.test(href || location.href);
  }

  // ── 错误分层（debugging-rules 错误文案铁律）─────────────────────────────
  function mkErr(kind, msg) {
    const prefix = { read: '读取失败', data: '数据校验', biz: '不能操作', write: '写入失败' }[kind] || '错误';
    return new Error(prefix + '：' + msg);
  }

  // ── 保存路径（同 packing_label：localStorage + PICK_FOLDER）──────────────
  function getSavePath() { return localStorage.getItem(LS_PATH) || ''; }
  function setSavePath(p) { localStorage.setItem(LS_PATH, p || ''); }

  async function onPickSavePath() {
    const r = await sendNative('PICK_FOLDER', { title: '选择 CSV 保存文件夹' });
    if (r && r.success && r.path) { setSavePath(r.path); refreshPathUI(); }
  }

  function refreshPathUI() {
    const el = document.getElementById('sme-path-v');
    if (el) el.textContent = getSavePath() || '(未设置)';
  }

  // ── Panel UI ─────────────────────────────────────────────────────────────
  function renderView(viewEl) {
    viewEl.innerHTML = `
      <div class="tal-card" style="display:flex;flex-direction:column;gap:14px;">
        <div class="tal-path-row" id="sme-path-row" title="点击选择保存文件夹" style="cursor:pointer;">
          <span class="tal-path-k">保存到</span>
          <span class="tal-path-v" id="sme-path-v"></span>
        </div>
        <button id="sme-start" class="tal-btn-primary">开始采集</button>
        <div id="sme-status" class="tal-status" style="margin-top:4px;line-height:1.5;"></div>
      </div>`;
    viewEl.querySelector('#sme-path-row').addEventListener('click', onPickSavePath);
    viewEl.querySelector('#sme-start').addEventListener('click', onStart);
    refreshPathUI();
    refreshPageGate();
  }

  // 不在目标页时按钮灰显（业务拦截层提示）
  function refreshPageGate() {
    const btn = document.getElementById('sme-start');
    if (!btn) return;
    const ok = isSaleManagePage();
    btn.disabled = !ok;
    btn.style.opacity = ok ? '' : '0.5';
    btn.style.cursor = ok ? '' : 'not-allowed';
    if (!ok) setStatus('不能操作：请先进入「销售管理」页面再采集');
    else if ((document.getElementById('sme-status') || {}).textContent?.startsWith('不能操作')) setStatus('');
  }

  function setStatus(msg) {
    const el = document.getElementById('sme-status');
    if (el) el.textContent = msg;
  }

  function setRunning(running) {
    const btn = document.getElementById('sme-start');
    if (!btn) return;
    btn.disabled = running;
    btn.style.opacity = running ? '0.5' : '';
    btn.style.cursor = running ? 'not-allowed' : '';
    btn.textContent = running ? '采集中…' : '开始采集';
  }

  // ── 表格扫描（rowspan 分组：每 SKC 组首行含商品信息格；SKU 行/合计行没有）──
  function collectPageGroups() {
    const trs = Array.from(document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]'));
    const groups = [];
    for (const tr of trs) {
      const info = tr.querySelector('td [class*="main_productInfo"]');
      if (!info) continue; // SKU 行 / 合计行
      const nameEl = info.querySelector('[class*="main_productName"]');
      const pTexts = Array.from(info.querySelectorAll('[class*="main_productInfoGrayContent"] p'))
        .map((p) => p.textContent || '');
      const f = SU.parseInfoFields(pTexts);
      groups.push({ skc: f.skc, skcCode: f.skcCode, spu: f.spu, name: (nameEl ? nameEl.textContent : '').trim() });
    }
    return groups;
  }

  // ── 分页器读取与等待 ──────────────────────────────────────────────────────
  function readTotalCount() {
    const el = document.querySelector('[class*="PGT_totalText"]');
    const m = el && (el.textContent || '').match(/共有\s*(\d+)\s*条/);
    return m ? parseInt(m[1], 10) : null;
  }

  function readActivePage() {
    const el = document.querySelector('[class*="PGT_pagerItemActive"]');
    const n = el ? parseInt((el.textContent || '').trim(), 10) : NaN;
    return isNaN(n) ? null : n;
  }

  // 表格内容签名：首组 SKC | 末组 SKC | 组数。**只看表格数据，不含页码**——
  // 点 next 后激活页码立即变、数据 4-5s 后才到（端到端实测），含页码的签名会提前放行，
  // 导致扫到旧数据（重复采集）。相邻页 SKC 集合必不同，内容变化才是数据就绪的真信号。
  function pageSignature() {
    const g = collectPageGroups();
    return (g[0] ? g[0].skc : '') + '|' + (g.length ? g[g.length - 1].skc : '') + '|' + g.length;
  }

  // 等表格内容真正变化（auto_ship #47 同款坑：点了下一页 ≠ 表格已刷新）。
  // 就绪条件：签名 != prevSig 且 首组 SKC 可读。超时抛读取层错误。
  // 注意：不能用 Spn_spinningMask 判 loading——该 mask 节点常驻 DOM 且恒为 display:block
  //（端到端实测，静止时也"可见"），用它做门槛会让签名比较永远不执行。
  async function waitTableChange(prevSig, timeoutMs, ctx) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await U.sleep(200);
      const sig = pageSignature();
      if (sig !== prevSig && sig.split('|')[0]) return sig;
    }
    throw mkErr('read', '表格刷新超时（' + timeoutMs + 'ms 内容未变化' + (ctx ? '，' + ctx : '') + '），采集中止');
  }

  // 点「下一页」并确认真的前进了一页。点了 ≠ 生效：上一轮刷新尾声 Beast 会吞点击
  // （端到端实测：单点死等 15s 超时，手动补点即翻页）→ 写后读 + 退避重试。
  async function clickNextAndWait(curPage) {
    const ATTEMPTS = 3;
    let lastErr = null;
    for (let i = 0; i < ATTEMPTS; i++) {
      const next = document.querySelector('[data-testid="beast-core-pagination-next"]');
      if (!next) throw mkErr('read', '未找到下一页按钮');
      const prevSig = pageSignature();
      next.click();
      let changed = true;
      try {
        await waitTableChange(prevSig, 8000, '第 ' + curPage + ' 页翻下一页后（第 ' + (i + 1) + ' 次点击）');
      } catch (e) {
        changed = false; lastErr = e;
        console.warn('[SME] 第 ' + (i + 1) + ' 次点击下一页未生效，重试：', e.message);
      }
      if (changed) {
        // 防跳页：迟到的上次点击 + 本次点击都生效会跳过一页，漏采比失败更糟，必须中止
        const now = readActivePage();
        if (now != null && now > curPage + 1) {
          throw mkErr('data', '翻页跳过了第 ' + (curPage + 1) + ' 页（当前第 ' + now + ' 页），为防漏采中止，请重新采集');
        }
        return;
      }
    }
    throw lastErr;
  }

  // 回到第 1 页（用户可能停在第 N 页点开始；不回头会漏采前面的页）。
  // 点击同样可能被刷新尾声吞掉 → 重试；落到第 1 页由循环头条件确认。
  async function gotoFirstPage() {
    for (let i = 0; i < 3; i++) {
      if ((readActivePage() || 1) === 1) return;
      const first = Array.from(document.querySelectorAll('[class*="PGT_pagerItem"]'))
        .find((el) => (el.textContent || '').trim() === '1');
      if (!first) throw mkErr('read', '未找到第 1 页页码按钮');
      const prevSig = pageSignature();
      first.click();
      try {
        await waitTableChange(prevSig, 8000, '回第 1 页时（第 ' + (i + 1) + ' 次点击）');
        return;
      } catch (e) {
        console.warn('[SME] 回第 1 页点击未生效，重试：', e.message);
      }
    }
    if ((readActivePage() || 1) !== 1) {
      throw mkErr('read', '回第 1 页失败（3 次点击后仍在第 ' + readActivePage() + ' 页）');
    }
  }

  // 调大每页条数（best-effort）：打开 size select → 在 portal 下拉里选最大数字项 → 写后读校验。
  // 任何一步找不到 DOM → 关闭下拉、返回 {changed:false, reason}，调用方降级按当前条数翻页（不中止）。
  async function maximizePageSize() {
    const sizeSel = document.querySelector('[class*="PGT_sizeChanger"] [data-testid="beast-core-select"]');
    if (!sizeSel) return { changed: false, reason: '未找到每页条数选择器' };
    const input = sizeSel.querySelector('input[data-testid="beast-core-select-htmlInput"]');
    const cur = input ? parseInt(input.value, 10) : NaN;
    const pagRoot = document.querySelector('[data-testid="beast-core-pagination"]');
    const header = sizeSel.querySelector('[data-testid="beast-core-select-header"]');
    if (!header) return { changed: false, reason: '未找到 select header' };
    header.click(); // 打开下拉（选项渲染在 body 末尾 portal）
    // 等候选项：纯数字、可见、且不在分页器内（排除页码 li 1/2/3…）
    let opts = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await U.sleep(150);
      opts = Array.from(document.querySelectorAll('[class*="ST_option"], li'))
        .filter((el) => /^\d+$/.test((el.textContent || '').trim()))
        .filter((el) => el.offsetParent !== null)
        .filter((el) => !(pagRoot && pagRoot.contains(el)));
      if (opts.length) break;
    }
    if (!opts.length) {
      document.body.click(); // 关掉下拉
      return { changed: false, reason: '未找到每页条数下拉选项' };
    }
    const best = opts.reduce((a, b) =>
      parseInt(a.textContent.trim(), 10) >= parseInt(b.textContent.trim(), 10) ? a : b);
    const want = parseInt(best.textContent.trim(), 10);
    if (!isNaN(cur) && want <= cur) { document.body.click(); return { changed: false, reason: '当前已是最大条数' }; }
    const prevSig = pageSignature();
    best.click();
    // 写后读校验（表单自动化铁律）：回读 select 值 == 期望
    const vDeadline = Date.now() + 5000;
    while (Date.now() < vDeadline) {
      await U.sleep(150);
      const v = parseInt((sizeSel.querySelector('input[data-testid="beast-core-select-htmlInput"]') || {}).value, 10);
      if (v === want) break;
      if (Date.now() + 150 >= vDeadline) throw mkErr('data', '每页条数填写后不符，期望「' + want + '」实际「' + v + '」');
    }
    // 等表格按新条数刷新；若结果集小到内容签名不变（如总数 ≤ 原每页数），超时降级继续
    try { await waitTableChange(prevSig, 8000, '调整每页条数后'); } catch (e) { console.warn('[SME] 改条数后表格签名未变化，按已校验值继续：', e.message); }
    return { changed: true, size: want };
  }

  // ── CSV 字节 + 分块保存（同 packing_label savePdf 模式）────────────────────
  function bytesToBase64(u8) {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  function joinWin(dir, name) {
    return dir.replace(/[\\/]+$/, '') + '\\' + name;
  }

  async function saveBytes(path, u8) {
    const CHUNK = 512 * 1024;
    let offset = 0, last = null;
    do {
      const slice = u8.subarray(offset, offset + CHUNK);
      const done = offset + slice.length >= u8.length;
      const r = await sendNative('SAVE_FILE_CHUNK', { path, data: bytesToBase64(slice), offset, done });
      if (!r || !r.success) throw mkErr('write', 'CSV 落盘失败：' + ((r && r.error) || '未知'));
      offset += slice.length; last = r;
    } while (offset < u8.length);
    return last;
  }

  // ── 采集编排（全分页：回第 1 页 → 调大条数 → 扫页/去重/翻页直到末页）──────
  async function collectAllPages(onProgress) {
    if (!document.querySelector('tr[data-testid="beast-core-table-body-tr"]')) {
      throw mkErr('read', '未找到结果表格（请先执行查询并等待结果加载）');
    }
    if (!document.querySelector('[data-testid="beast-core-pagination"]')) {
      throw mkErr('read', '未找到分页器');
    }
    const total = readTotalCount();
    const sizeR = await maximizePageSize();
    if (!sizeR.changed) console.warn('[SME] 每页条数未调整：', sizeR.reason);
    await gotoFirstPage();

    const seen = new Map(); // Map<SKC, row> 去重（防表格未刷新重复扫）
    let pagesScanned = 0;
    let rawGroups = 0;
    for (let guard = 0; guard < 500; guard++) {
      const page = readActivePage() || pagesScanned + 1;
      const groups = collectPageGroups();
      if (!groups.length) throw mkErr('read', '第 ' + page + ' 页未扫描到任何商品组（表格选择器失效或页面异常）');
      rawGroups += groups.length;
      for (const g of groups) {
        if (!g.skc) throw mkErr('data', '第 ' + page + ' 页存在缺少 SKC 字段的商品组（商品名：' + (g.name || '').slice(0, 30) + '…）');
        if (!seen.has(g.skc)) seen.set(g.skc, g);
      }
      pagesScanned += 1;
      onProgress && onProgress({ page, count: seen.size });
      const next = document.querySelector('[data-testid="beast-core-pagination-next"]');
      if (!next) throw mkErr('read', '未找到下一页按钮');
      if (/PGT_disabled/.test(next.className)) break; // 末页
      await clickNextAndWait(page);
    }
    if (pagesScanned >= 500) console.warn('[SME] 翻页 guard 上限触顶（500 页），结果可能未覆盖全部分页');
    return { rows: Array.from(seen.values()), total, pagesScanned, rawGroups };
  }

  async function onStart() {
    const dir = getSavePath();
    if (!dir) { AS.showToast('不能操作：未选择保存文件夹', 'warn'); return; }
    if (!isSaleManagePage()) { AS.showToast('不能操作：当前不在销售管理页', 'warn'); return; }
    setRunning(true);
    setStatus('采集中…');
    try {
      const { rows, total, pagesScanned, rawGroups } = await collectAllPages(({ page, count }) => {
        setStatus(`采集中…第 ${page} 页，已采 ${count} 个 SKC`);
      });
      const csv = SU.buildCsvText(rows);
      const bytes = new TextEncoder().encode('\uFEFF' + csv); // UTF-8 BOM（Excel 中文兼容）
      const path = joinWin(dir, SU.buildCsvFileName(new Date()));
      await saveBytes(path, bytes);
      let msg = `✅ 完成：${pagesScanned} 页共 ${rows.length} 个 SKC → ${path}`;
      if (rawGroups !== rows.length) {
        msg += `（跨页重复 ${rawGroups - rows.length} 个 SKC 已去重）`;
      }
      if (total != null && rows.length !== total) {
        msg += `（注意：页面「共有 ${total} 条」与采集数不一致，可能为 SKU 计数，请人工核对）`;
      }
      setStatus(msg);
      AS.showToast(`采集完成：${rows.length} 个 SKC`, 'success');
    } catch (err) {
      setStatus('❌ ' + err.message);
      AS.showToast(err.message, 'error');
    } finally {
      setRunning(false);
    }
  }

  AS.registerFeature({
    id: 'sale_manage_export',
    icon: '📊',
    label: '销售清单导出',
    init() { AS.onPageChange(() => refreshPageGate()); },
    render: renderView,
  });
})();
