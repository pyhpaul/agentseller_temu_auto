// features/listing_optimize/content/index.js
// 独立小工具：店小秘编辑页的「标题润色 + 主图优化」。复用 brain refiner（CAP_TITLE_REFINE）
// + native image_optimize（OPTIMIZE_IMAGE）后端，UI 独立于 check_and_publish 的检查/发布流程。
// DOM 取值层与 check_and_publish 同源（各 feature 独立 content，店小秘 DOM helper 各自持有）。
(function () {
  'use strict';
  const U = window.AgentSeller.utils;
  const showToast = window.AgentSeller.showToast;

  // ─── 店小秘编辑页 DOM 取值 ─────────────────────────────────────────────
  function isEditPage() { return location.href.includes('edit'); }

  function findRequiredFormItems() {
    const items = new Set();
    for (const star of document.querySelectorAll('.ant-form-item-required')) {
      const item = star.closest('.ant-form-item, .ant-row');
      if (item) items.add(item);
    }
    return [...items];
  }

  function findFormItemByLabelText(labelText) {
    for (const item of findRequiredFormItems()) {
      if (item.textContent.includes(labelText)) return item;
    }
    for (const item of document.querySelectorAll('.ant-form-item, .ant-row')) {
      const lbl = item.querySelector('label, .ant-form-item-label');
      if (lbl && lbl.textContent.includes(labelText)) return item;
    }
    return null;
  }

  function getTitleField() {
    // 店小秘 temu/edit：产品标题在 label「产品标题」的 form-item 内（ant-input-sm，无 maxlength）。
    // 区别于「英文标题」(常空) / sourceUrl(供货 URL，maxlength=1000)。用 label 定位最稳。
    const item = findFormItemByLabelText('产品标题');
    const el = item && (item.querySelector('input.ant-input-sm') || item.querySelector('input.ant-input') || item.querySelector('input'));
    return el ? { value: el.value || '', el } : { value: null, el: null };
  }

  function getCarouselImagesField() {
    const item = findFormItemByLabelText('产品轮播图');
    if (!item) return { value: [], el: null };
    const imgs = [...item.querySelectorAll('img')].filter(img => img.naturalWidth > 0);
    return { value: imgs, el: item };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function makeBtn(text, color, onClick) {
    const b = document.createElement('button');
    b.className = 'tal-action-btn';
    if (color) b.style.background = color;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  // ─── 标题润色（走 native host text_refine provider，员工可用；配 LLM_API_KEY 否则 mock 返原标题）──
  async function capRefineTitle() {
    const t = getTitleField();
    if (!t.el || t.value == null) return { available: false, error: '读取失败：未找到标题输入框' };
    let resp;
    try {
      resp = await window.AgentSeller.sendNative('REFINE_TITLE', { original: t.value, constraints: { maxLen: 250 } });
    } catch (e) {
      return { available: false, error: '润色不可用：' + ((e && e.message) || e) + '，保留原标题' };
    }
    if (!resp || !resp.success) return { available: false, error: (resp && resp.error) || '润色不可用，保留原标题' };
    return { available: true, original: t.value, refined: resp.refined || t.value, changes: resp.changes || '' };
  }

  // 写回标题 + 写后读 + 长度硬限校验（深度合规校验交「检查与发布」工具，此处只保 ≤250 硬限）。
  function capApplyTitle(value) {
    const t = getTitleField();
    if (!t.el) return { ok: false, error: '读取失败：未找到标题输入框' };
    if (value.length > 250) return { ok: false, error: `数据校验：标题超 250 字符（当前 ${value.length}）` };
    U.setInputValue(t.el, value);
    if ((t.el.value || '') !== value) {
      return { ok: false, error: `数据校验：标题写入未生效，期望「${value}」实际「${t.el.value}」` };
    }
    return { ok: true };
  }

  async function onRefineTitle(viewEl, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '✨ 润色中…'; }
    const r = await capRefineTitle();
    if (btn) { btn.disabled = false; btn.textContent = '✨ 润色标题'; }
    if (!r.available) { showToast(r.error || '润色不可用', 'err'); return; }
    renderRefineCompare(viewEl, r);
  }

  function renderRefineCompare(viewEl, r) {
    viewEl.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'tal-card';
    card.innerHTML = `<div class="tal-card-title">标题润色（核对后采用）</div>
      <div class="tal-kv"><span class="tal-k">原标题</span></div>
      <div style="font-size:12px;color:#888;margin:2px 0 8px;word-break:break-word;">${escapeHtml(r.original)}</div>
      <div class="tal-kv"><span class="tal-k">润色（可编辑）</span></div>`;
    const ta = document.createElement('textarea');
    ta.value = r.refined; ta.maxLength = 250;
    ta.style.cssText = 'width:100%;min-height:54px;font-size:12px;margin:2px 0 6px;box-sizing:border-box;';
    card.appendChild(ta);
    if (r.changes) {
      const ch = document.createElement('div');
      ch.style.cssText = 'font-size:11px;color:#888;margin-bottom:6px;';
      ch.textContent = '改动：' + r.changes;
      card.appendChild(ch);
    }
    viewEl.appendChild(card);
    viewEl.appendChild(makeBtn('采用并写回', '#1677ff', () => {
      const ap = capApplyTitle((ta.value || '').trim());
      if (!ap.ok) { showToast(ap.error, 'err'); return; }
      showToast('标题已更新（建议走「检查与发布」确认合规）', 'ok');
      renderHome(viewEl);
    }));
    viewEl.appendChild(makeBtn('返回', '#888', () => renderHome(viewEl)));
  }

  // ─── 主图优化（复用 native image_optimize，OPTIMIZE_IMAGE）──────────────────────
  async function capOptimizeImage() {
    const imgs = getCarouselImagesField();
    const first = imgs.value && imgs.value[0];
    if (!first || !first.src) return { available: false, error: '读取失败：未找到主图' };
    let resp;
    try {
      resp = await window.AgentSeller.sendNative('OPTIMIZE_IMAGE', { imageUrl: first.src, options: {} });
    } catch (e) {
      return { available: false, error: '优化不可用：' + ((e && e.message) || e) + '，保留原图' };
    }
    if (!resp || !resp.success) return { available: false, error: (resp && resp.error) || '优化失败，保留原图' };
    return { available: true, originalSrc: first.src, imageB64: resp.image_b64 };
  }

  function b64ToFile(b64, name, mime) {
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: mime });
  }

  // 采用：注入轮播图上传 input + 写后读（append 语义；替换/置首待 e2e dump 店小秘删图 UI）。
  // selector 用「产品轮播图」form-item 内 input[type=file]，靠 e2e 校准。
  async function capApplyImage(imageB64) {
    const item = findFormItemByLabelText('产品轮播图');
    if (!item) return { ok: false, error: '读取失败：未找到产品轮播图区域' };
    const input = item.querySelector('input[type="file"]');
    // 店小秘轮播图上传是「选择图片」弹窗/图片库流程（实测无裸 input[type=file]），File 注入行不通。
    // 自动替换需逆向该上传弹窗（待后续）；先明确报业务约束，不假装成功（对齐错误分层）。
    if (!input) return { ok: false, error: '店小秘轮播图是「选择图片」弹窗流程（无直接上传框），暂不支持自动替换主图；请对照优化图在店小秘手动替换' };
    const prevCount = item.querySelectorAll('img').length;
    const dt = new DataTransfer();
    dt.items.add(b64ToFile(imageB64, 'optimized-main.png', 'image/png'));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 20; i++) {            // 写后读：等轮播图 img 数量增加（最多 ~4s）
      await U.sleep(200);
      if (item.querySelectorAll('img').length > prevCount) return { ok: true };
    }
    return { ok: false, error: '数据校验：主图上传未生效，请重试或手动上传' };
  }

  async function onOptimizeImage(viewEl, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '🖼 优化中…'; }
    const r = await capOptimizeImage();
    if (btn) { btn.disabled = false; btn.textContent = '🖼 优化主图'; }
    if (!r.available) { showToast(r.error || '优化不可用', 'err'); return; }
    renderImageCompare(viewEl, r);
  }

  function renderImageCompare(viewEl, r) {
    viewEl.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'tal-card';
    card.innerHTML = '<div class="tal-card-title">主图优化（核对后采用）</div>';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin:6px 0;';
    const mk = (label, src) => {
      const box = document.createElement('div');
      box.style.cssText = 'flex:1;text-align:center;font-size:11px;color:#888;';
      box.innerHTML = `<div>${label}</div>`;
      const im = document.createElement('img');
      im.src = src;
      im.style.cssText = 'width:100%;max-height:120px;object-fit:contain;border:1px solid #eee;border-radius:4px;margin-top:4px;';
      box.appendChild(im);
      return box;
    };
    row.appendChild(mk('原图', r.originalSrc));
    row.appendChild(mk('优化图', 'data:image/png;base64,' + r.imageB64));
    card.appendChild(row);
    viewEl.appendChild(card);
    viewEl.appendChild(makeBtn('采用并替换', '#1677ff', async () => {
      const ap = await capApplyImage(r.imageB64);
      if (!ap.ok) { showToast(ap.error, 'err'); return; }
      showToast('主图已上传（建议走「检查与发布」确认）', 'ok');
      renderHome(viewEl);
    }));
    viewEl.appendChild(makeBtn('返回', '#888', () => renderHome(viewEl)));
  }

  // ─── 入口 view ───────────────────────────────────────────────────────
  function renderHome(viewEl) {
    viewEl.innerHTML = '';
    if (!isEditPage()) {
      const tip = document.createElement('div');
      tip.className = 'tal-status';
      tip.style.cssText = 'color:#cf1322;background:#fff2f0;border:1px solid #ffccc7;padding:8px 10px;border-radius:6px;font-size:12px;line-height:1.4;';
      tip.textContent = '请在店小秘商品编辑页使用（当前 URL 不含 edit）';
      viewEl.appendChild(tip);
      return;
    }
    const refineBtn = makeBtn('✨ 润色标题', '#1677ff', () => onRefineTitle(viewEl, refineBtn));
    viewEl.appendChild(refineBtn);
    const optimizeBtn = makeBtn('🖼 优化主图', '#1677ff', () => onOptimizeImage(viewEl, optimizeBtn));
    viewEl.appendChild(optimizeBtn);
    const tip = document.createElement('div');
    tip.className = 'tal-status';
    tip.style.cssText = 'color:#888;font-size:11px;margin-top:8px;line-height:1.4;';
    tip.textContent = '润色/优化后建议走「检查与发布」确认合规。';
    viewEl.appendChild(tip);
  }

  window.AgentSeller.registerFeature({
    id: 'listing_optimize',
    icon: '✨',
    label: '标题主图优化',
    render(viewEl) { renderHome(viewEl); },
  });
})();
