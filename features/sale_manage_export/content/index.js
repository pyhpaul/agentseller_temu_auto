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
    const prefix = { read: '读取失败', data: '数据校验', biz: '不能操作' }[kind] || '错误';
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
      if (!r || !r.success) throw mkErr('read', 'CSV 写入失败：' + ((r && r.error) || '未知'));
      offset += slice.length; last = r;
    } while (offset < u8.length);
    return last;
  }

  // ── 采集编排（Task 2 版：仅当前页；Task 3 扩展为全分页）──────────────────
  async function collectAllPages(onProgress) {
    const seen = new Map(); // Map<SKC, row> 去重
    const groups = collectPageGroups();
    if (!groups.length) throw mkErr('read', '当前页未扫描到任何商品组（表格选择器失效或页面未加载完）');
    for (const g of groups) {
      if (!g.skc) throw mkErr('data', '存在缺少 SKC 字段的商品组（商品名：' + (g.name || '').slice(0, 30) + '…）');
      if (!seen.has(g.skc)) seen.set(g.skc, g);
    }
    onProgress && onProgress({ page: 1, count: seen.size });
    return { rows: Array.from(seen.values()), total: null, pagesScanned: 1 };
  }

  async function onStart() {
    const dir = getSavePath();
    if (!dir) { AS.showToast('不能操作：未选择保存文件夹', 'warn'); return; }
    if (!isSaleManagePage()) { AS.showToast('不能操作：当前不在销售管理页', 'warn'); return; }
    setRunning(true);
    setStatus('采集中…');
    try {
      const { rows, total, pagesScanned } = await collectAllPages(({ page, count }) => {
        setStatus(`采集中…第 ${page} 页，已采 ${count} 个 SKC`);
      });
      const csv = SU.buildCsvText(rows);
      const bytes = new TextEncoder().encode('\uFEFF' + csv); // UTF-8 BOM（Excel 中文兼容）
      const path = joinWin(dir, SU.buildCsvFileName(new Date()));
      await saveBytes(path, bytes);
      let msg = `✅ 完成：${pagesScanned} 页共 ${rows.length} 个 SKC → ${path}`;
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
