// auto_gen_label/content/index.js — feature 业务：标签生成（含 Phase 1/2/3）
(function () {
  'use strict';

  const U = window.AgentSeller.utils;
  const sendNative = window.AgentSeller.sendNative;
  const onPageChange = window.AgentSeller.onPageChange;

  // 调试开关：dev 保持 true；package.bat 打包 release 时替换为 false
  const TAL_DEBUG = true;

  // ── feature 内部状态 ──
  const fstate = { product: null };  // { skcNumber, skcSku }
  let rowObserver = null;
  let clickDelegationBound = false;  // document 级 click 委托是否已绑定（幂等保护）

  // ═══════════════════════════════════════════════════════════════════════════
  // 页面判断
  // ═══════════════════════════════════════════════════════════════════════════
  function isBarcodeManagementPage() {
    const p = location.pathname;
    return p.startsWith('/goods/label') || p.includes('barcode') || p.includes('goods-barcode');
  }
  function isCompliantLivePhotosPage() {
    return location.pathname.includes('/govern/compliant-live-photos');
  }
  function isComplianceInfoPage() {
    return location.pathname.includes('/govern/information-supplementation');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 路径设置
  // ═══════════════════════════════════════════════════════════════════════════
  function getPaths() {
    return {
      templatePath: localStorage.getItem('talTemplatePath') || '',
      outputDir:    localStorage.getItem('talOutputDir')    || '',
    };
  }

  function refreshPathsUI() {
    const { templatePath, outputDir } = getPaths();
    const tv = document.getElementById('tal-path-template-v');
    const ov = document.getElementById('tal-path-output-v');
    if (tv) {
      if (templatePath) {
        tv.textContent = templatePath;
        tv.classList.remove('tal-path-empty');
        tv.title = templatePath;
      } else {
        tv.textContent = '点击选择...';
        tv.classList.add('tal-path-empty');
        tv.title = '';
      }
    }
    if (ov) {
      if (outputDir) {
        ov.textContent = outputDir;
        ov.classList.remove('tal-path-empty');
        ov.title = outputDir;
      } else {
        ov.textContent = '点击选择...';
        ov.classList.add('tal-path-empty');
        ov.title = '';
      }
    }
  }

  async function onPickTemplate() {
    try {
      U.ensureExtensionAlive();
      const result = await sendNative('PICK_FILE', {
        title: '选择 BarTender 模板',
        filetypes: [['BarTender 模板', '*.btw']],
      });
      if (result?.success && result.path) {
        localStorage.setItem('talTemplatePath', result.path);
        refreshPathsUI();
        refreshProductUI();
      }
    } catch (err) {
      setStatus(`选择模板失败: ${err.message}`, 'err');
    }
  }

  async function onPickOutputDir() {
    try {
      U.ensureExtensionAlive();
      const result = await sendNative('PICK_FOLDER', {
        title: '选择标签输出文件夹',
      });
      if (result?.success && result.path) {
        localStorage.setItem('talOutputDir', result.path);
        refreshPathsUI();
        refreshProductUI();
      }
    } catch (err) {
      setStatus(`选择文件夹失败: ${err.message}`, 'err');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 状态栏（feature view 内的 #tal-status）
  // ═══════════════════════════════════════════════════════════════════════════
  function setStatus(text, type = '') {
    const el = document.getElementById('tal-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'tal-status ' + type;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 商品状态
  // ═══════════════════════════════════════════════════════════════════════════
  function getWidthRatio() {
    const input = document.getElementById('tal-debug-ratio');
    if (input) {
      const v = parseFloat(input.value);
      if (v > 0 && v <= 1) return v;
    }
    const stored = parseFloat(localStorage.getItem('talWidthRatio') || '');
    return (stored > 0 && stored <= 1) ? stored : 0.45;
  }

  function setProduct(product) {
    fstate.product = product;
    refreshProductUI();
    if (product) setStatus('已选商品，可执行流程');
  }

  function clearSelection() {
    // 先清 product 再刷 highlight：findRowBySkc(null) 会 return null，refreshRowHighlight 全清 .tal-selected
    setProduct(null);
    refreshRowHighlight();
  }

  function refreshProductUI() {
    const empty = document.getElementById('tal-product-empty');
    const info  = document.getElementById('tal-product-info');
    if (!empty) return;
    if (!fstate.product) {
      empty.style.display = 'block';
      if (info) info.style.display = 'none';
    } else {
      empty.style.display = 'none';
      if (info) {
        info.style.display = 'block';
        document.getElementById('tal-val-sku').textContent = fstate.product.skcSku;
        document.getElementById('tal-val-skc').textContent = fstate.product.skcNumber;
      }
    }
    // 标签文件行
    const labelPng = localStorage.getItem('talLabelPng');
    const labelRow = document.getElementById('tal-label-row');
    const labelVal = document.getElementById('tal-val-label');
    if (labelRow && labelVal) {
      if (labelPng) {
        labelVal.textContent = labelPng.split('\\').pop().split('/').pop();
        labelRow.style.display = 'flex';
      } else {
        labelRow.style.display = 'none';
      }
    }
    // 执行按钮
    const btn = document.getElementById('tal-btn-auto');
    if (!btn) return;
    const { templatePath, outputDir } = getPaths();
    const pathsMissing = !templatePath || !outputDir;
    const productMissing = !fstate.product;
    const wrongPage = !isBarcodeManagementPage();
    const disabled = pathsMissing || productMissing || wrongPage;
    btn.disabled = disabled;
    const dbgBtn = document.getElementById('tal-btn-debug');
    if (dbgBtn) dbgBtn.disabled = disabled;

    if (disabled) {
      const status = document.getElementById('tal-status');
      // 不覆盖已有错误/成功提示
      if (status && !status.classList.contains('err') && !status.classList.contains('ok')) {
        if (pathsMissing)        setStatus('请先设置模板路径和输出目录');
        else if (productMissing) setStatus(wrongPage ? '' : '请点击商品行选择');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 行绑定
  // ═══════════════════════════════════════════════════════════════════════════
  function waitForTableThenBind() {
    // event delegation + body subtree observer 都不依赖表格已 mount，立即启动（内部幂等）
    setupRowClickDelegation();
    watchNewRows();
  }

  function setupRowClickDelegation() {
    if (clickDelegationBound) return;
    clickDelegationBound = true;
    // 在 document 上绑一个全局 click listener（event delegation），
    // 避免 React 复用/替换 row 节点时 listener 丢失（旧 bindRows 用 attribute
    // idempotency 不可靠的根因修复）
    document.addEventListener('click', e => {
      const row = e.target.closest('tr[data-testid="beast-core-table-body-tr"]');
      if (!row) return;
      if (e.target.closest('a, button')) return;
      const data = extractRowData(row);
      if (!data) { setStatus('未能读取该行数据', 'err'); return; }
      if (!data.skcSku) { setStatus('该商品没有 SKC货号，标签生成需要 SKC货号，请选择其他商品', 'err'); return; }
      if (data.skcNumber === fstate.product?.skcNumber) clearSelection();
      else selectRow(data);
    });
  }

  function watchNewRows() {
    if (rowObserver) return;
    rowObserver = new MutationObserver(() => {
      // 每次 mutation 同步视觉：React 重新渲染 row 时自动恢复 .tal-selected
      // 这是手动选中能在 React 重渲后保持视觉一致的关键
      refreshRowHighlight();
    });
    // attach 到 document.body 而非 tbody，避免 React 替换整个 tbody 时 observer 失效
    rowObserver.observe(document.body, { childList: true, subtree: true });
  }

  function selectRow(product) {
    setProduct(product);
    refreshRowHighlight();
  }

  function refreshRowHighlight() {
    // tal-selected 是本 feature 专属 class（tal- 前缀 = Temu Auto Label 命名空间），其他 feature 不应共用
    document.querySelectorAll('tr.tal-selected').forEach(r => r.classList.remove('tal-selected'));
    const row = findRowBySkc(fstate.product?.skcNumber);
    if (row) row.classList.add('tal-selected');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 数据提取
  // ═══════════════════════════════════════════════════════════════════════════
  function getColumnIndex(text) {
    const ths = document.querySelectorAll('th[data-testid="beast-core-table-th"]');
    for (let i = 0; i < ths.length; i++) if (ths[i].textContent.trim() === text) return i + 1;
    return -1;
  }

  function extractRowData(row) {
    // SKC货号 列对部分单 SKU 商品本身为空，故只用 SKC 判定 row 是否可读
    // 业务拦截（无 SKC货号 不能打标签）在调用方做
    const si = getColumnIndex('SKC'), ki = getColumnIndex('SKC货号');
    if (si < 0 || ki < 0) return null;
    const tds = row.querySelectorAll('td[data-testid="beast-core-table-td"]');
    const skc = tds[si - 1]?.textContent.trim();
    const skcSku = tds[ki - 1]?.textContent.trim();
    return skc ? { skcNumber: skc, skcSku: skcSku || '' } : null;
  }

  function findRowBySkc(skc) {
    if (!skc) return null;
    const rows = document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]');
    for (const row of rows) {
      if (extractRowData(row)?.skcNumber === skc) return row;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1：标签生成
  // ═══════════════════════════════════════════════════════════════════════════
  async function onRunAllPhases() {
    const row = findRowBySkc(fstate.product?.skcNumber);
    if (!fstate.product || !row) return;
    const { templatePath, outputDir } = getPaths();
    if (!templatePath || !outputDir) {
      setStatus('模板路径或输出目录未设置', 'err');
      return;
    }
    const btn = document.getElementById('tal-btn-auto');
    btn.disabled = true;
    try {
      // Phase 1：生成标签
      setStatus('① 正在捕获条码...', 'loading');
      const { barcodePngB64, skcNumber } = await clickAndCaptureCanvas(row);
      setStatus('① 标签生成中，请稍候...', 'loading');
      U.ensureExtensionAlive();
      const result = await sendNative('PROCESS_LABEL', {
        skcNumber: skcNumber || fstate.product.skcNumber,
        skcSku: fstate.product.skcSku,
        barcodePngB64,
        templatePath,
        outputDir,
        widthRatio: getWidthRatio(),
      });
      if (!result?.success) throw new Error(result?.error || '标签生成失败');
      const outputPng = result?.output_png;
      if (outputPng) {
        localStorage.setItem('talLabelPng', outputPng);
        localStorage.setItem('talLabelSkc', fstate.product.skcNumber || '');
        refreshProductUI();
      }
      setStatus('① 标签生成完成 ✓，启动合规填写...', 'ok');
      await U.sleep(800);

      // Phase 2：合规填写
      setCFlow({
        active: true, step: 1,
        skcNumber: fstate.product.skcNumber,
        skcSku: fstate.product.skcSku,
        spuId: null,
        continueToPhase3: true,
      });
      window.location.href = '/govern/compliant-live-photos'; // window.open('/govern/compliant-live-photos', '_blank');
    } catch (err) {
      setStatus(`出错: ${err.message}`, 'err');
      btn.disabled = false;
    }
  }

  // 调试：只跑 Phase 1（标签生成），用当前调试栏 ratio
  async function onRunPhase1Only() {
    const row = findRowBySkc(fstate.product?.skcNumber);
    if (!fstate.product || !row) return;
    const { templatePath, outputDir } = getPaths();
    if (!templatePath || !outputDir) {
      setStatus('模板路径或输出目录未设置', 'err');
      return;
    }
    const ratio = getWidthRatio();
    const btn = document.getElementById('tal-btn-debug');
    btn.disabled = true;
    try {
      setStatus(`调试：捕获条码（ratio=${ratio}）...`, 'loading');
      const { barcodePngB64, skcNumber } = await clickAndCaptureCanvas(row);
      setStatus('调试：标签生成中...', 'loading');
      U.ensureExtensionAlive();
      const result = await sendNative('PROCESS_LABEL', {
        skcNumber: skcNumber || fstate.product.skcNumber,
        skcSku: fstate.product.skcSku,
        barcodePngB64,
        templatePath,
        outputDir,
        widthRatio: ratio,
      });
      if (!result?.success) throw new Error(result?.error || '标签生成失败');
      const outputPng = result?.output_png;
      if (outputPng) {
        localStorage.setItem('talLabelPng', outputPng);
        localStorage.setItem('talLabelSkc', fstate.product.skcNumber || '');
        refreshProductUI();
      }
      setStatus(`调试完成 ✓ ratio=${ratio}`, 'ok');
    } catch (err) {
      setStatus(`调试出错: ${err.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Canvas 捕获
  // ═══════════════════════════════════════════════════════════════════════════
  function findViewBarcodeBtn(row) {
    return Array.from(row.querySelectorAll('a[data-testid="beast-core-button-link"]'))
      .find(a => a.textContent.trim() === '查看条码') || null;
  }

  async function clickAndCaptureCanvas(row) {
    const btn = findViewBarcodeBtn(row);
    if (!btn) throw new Error('未找到「查看条码」按钮');

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        // 重试前关闭旧 modal，重置状态
        Array.from(document.querySelectorAll('[data-testid="beast-core-modal-body"] button'))
          .find(b => b.textContent.trim() === '取消')?.click();
        await U.sleep(800);
      }
      btn.click();
      const canvas = await waitForBarcodeCanvas();
      await waitForCanvasRendered(canvas);
      const bitmap = await createImageBitmap(canvas);
      const temp = document.createElement('canvas');
      temp.width = bitmap.width; temp.height = bitmap.height;
      temp.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close();

      // 兜底验证：捕获完成后再次确认含黑色条纹（避免捕获瞬间 canvas 处于过渡状态）
      const stats = computeCanvasStats(temp);
      console.log(`[TAL][canvas] 捕获完成 (try ${attempt}/${MAX_ATTEMPTS}) light=${stats.light.toFixed(2)} dark=${stats.dark.toFixed(2)}`);
      if (stats.dark > 0.05 && stats.light > 0.3) {
        const barcodePngB64 = temp.toDataURL('image/png');
        const skcNumber = extractSkcFromModal();
        Array.from(document.querySelectorAll('[data-testid="beast-core-modal-body"] button'))
          .find(b => b.textContent.trim() === '取消')?.click();
        return { barcodePngB64, skcNumber };
      }
      console.warn(`[TAL][canvas] 捕获结果不达标（缺黑条纹），第 ${attempt} 次重试`);
    }
    throw new Error('条码捕获失败：3 次都未获得含黑色条纹的图像，请重试');
  }

  function waitForBarcodeCanvas(timeout = 12000) {
    return U.waitForEl('[data-testid="beast-core-modal-body"] #canvas', document, timeout)
      .catch(() => { throw new Error('等待条码 canvas 超时'); });
  }

  // 统计 canvas 中央区域的白色/黑色像素占比
  function computeCanvasStats(canvas) {
    try {
      const ctx = canvas.getContext('2d');
      const sampleW = Math.min(canvas.width, 300);
      const sampleH = Math.min(canvas.height, 80);
      const x = Math.max(0, Math.floor((canvas.width  - sampleW) / 2));
      const y = Math.max(0, Math.floor((canvas.height - sampleH) / 2));
      const data = ctx.getImageData(x, y, sampleW, sampleH).data;
      let light = 0, dark = 0, total = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a === 0) continue;
        total++;
        if (r > 200 && g > 200 && b > 200) light++;
        else if (r < 100 && g < 100 && b < 100) dark++;
      }
      return { light: total ? light / total : 0, dark: total ? dark / total : 0, total };
    } catch {
      return { light: 0, dark: 0, total: 0 };
    }
  }

  // 轮询 canvas 像素：必须同时检测到白色底色（>30%）+ 黑色条纹（>5%）才算绘制完成
  // 二次确认避免恰好捕获到绘制中间瞬间
  async function waitForCanvasRendered(canvas, timeout = 10000) {
    // 起步先等一小段，避免 canvas 刚出现时 width=0 / 默认空
    await U.sleep(500);
    const deadline = Date.now() + timeout;
    let lastStats = { dark: 0, light: 0 };
    while (Date.now() < deadline) {
      if (canvas.width > 0 && canvas.height > 0) {
        const stats = computeCanvasStats(canvas);
        lastStats = stats;
        if (stats.dark > 0.05 && stats.light > 0.3) {
          await U.sleep(250);
          // 二次确认：再采样一次，确保黑条纹没消失
          const stats2 = computeCanvasStats(canvas);
          if (stats2.dark > 0.05 && stats2.light > 0.3) {
            console.log(`[TAL][canvas] 渲染就绪 light=${stats2.light.toFixed(2)} dark=${stats2.dark.toFixed(2)}`);
            return;
          }
        }
      }
      await U.sleep(200);
    }
    throw new Error(`条码 canvas 未渲染完整（${timeout/1000}s 超时，最后 dark=${lastStats.dark.toFixed(2)} light=${lastStats.light.toFixed(2)}）`);
  }

  function extractSkcFromModal() {
    for (const item of document.querySelectorAll(
      '[data-testid="beast-core-modal-body"] .label-value-module__label-value___1wVkH'
    )) {
      if (item.querySelector('.label-value-module__label___KfYA4')?.textContent.trim() === 'SKC')
        return item.querySelector('.label-value-module__value___1tP0A')?.textContent.trim() || '';
    }
    return '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 合规信息 Phase 2 — 流程状态（localStorage，跨 tab 同 origin 持久化）
  // ═══════════════════════════════════════════════════════════════════════════
  function getCFlow() {
    try { return JSON.parse(localStorage.getItem('talCFlow') || 'null'); } catch { return null; }
  }
  function setCFlow(d) { localStorage.setItem('talCFlow', JSON.stringify(d)); }
  function clearCFlow() { localStorage.removeItem('talCFlow'); }

  // 分块读取文件，返回 Uint8Array（每块独立 base64 解码后拼接字节，避免 base64 padding 问题）
  async function readFileChunked(path) {
    U.ensureExtensionAlive();
    const sizeResult = await sendNative('READ_FILE_SIZE', { path });
    if (!sizeResult?.success) throw new Error(sizeResult?.error || '获取文件大小失败');
    const size = sizeResult.size;
    const CHUNK = 524288;
    const out = new Uint8Array(size);
    let written = 0;
    for (let offset = 0; offset < size; offset += CHUNK) {
      U.ensureExtensionAlive();
      const r = await sendNative('READ_FILE_CHUNK', { path, offset, length: CHUNK });
      if (!r?.success || typeof r.data !== 'string') {
        throw new Error(r?.error || '读取文件分块失败');
      }
      const byteStr = atob(r.data);
      for (let i = 0; i < byteStr.length; i++) out[written + i] = byteStr.charCodeAt(i);
      written += byteStr.length;
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 2 Rocket UI 工具
  // ═══════════════════════════════════════════════════════════════════════════

  // 通过 input id 找父级 .rocket-select 容器
  function rocketSelectById(id) {
    return document.getElementById(id)?.closest('.rocket-select') || null;
  }

  // 在 root 内通过 label 文本找 form-item 容器（精确匹配优先，去 *、:、：）
  // Rocket Design 的真实类名是 rocket-form-field-item（注意有 "field" 在中间）
  function findFormItemByLabel(labelText, root = document) {
    const target = U.normText(labelText).replace(/[*：:]/g, '');
    const labels = Array.from(root.querySelectorAll('label'));
    const FORM_ITEM = '.rocket-form-field-item, .rocket-form-item, [class*="rocket-form-field-item"]:not([class*="rocket-form-field-item-"])';
    for (const lbl of labels) {
      if (U.normText(lbl.textContent).replace(/[*：:]/g, '') === target) {
        const item = lbl.closest(FORM_ITEM);
        if (item) return item;
      }
    }
    for (const lbl of labels) {
      if (lbl.textContent.includes(labelText)) {
        const item = lbl.closest(FORM_ITEM);
        if (item) return item;
      }
    }
    return null;
  }

  // 找 .rocket-select 容器：id 优先，label fallback（去 form-item 内取）
  function findSelectFlexible(id, labelText, root = document) {
    const byId = id ? rocketSelectById(id) : null;
    if (byId) return byId;
    const item = labelText ? findFormItemByLabel(labelText, root) : null;
    return item?.querySelector('.rocket-select') || null;
  }

  // ─── Section 分组动态识别框架（Phase 2 drawer 用） ────────────────────────
  // drawer 内 section 有两种形态：
  //   a) 独立 section：<div id="数字"> 内含 border-left header（标题在自己内部）
  //   b) 分组 section：外层 border-left header（如「韩国公示信息」）+ 后续多个 <div id="数字">

  // 找独立 section：其内部第一个 border-left header 文本含 title
  function findSectionByOwnTitle(drawer, title) {
    const sections = Array.from(drawer.querySelectorAll('div[id]'))
      .filter(s => /^\d+$/.test(s.id));
    for (const sec of sections) {
      const titleDiv = sec.querySelector(':scope > div[style*="border-left"]');
      if (titleDiv && titleDiv.textContent.includes(title)) return sec;
    }
    return null;
  }

  // 找分组 header：border-left header 且不在任何数字 id section 内
  function findGroupHeader(drawer, title) {
    const headers = Array.from(drawer.querySelectorAll('div[style*="border-left"]'));
    for (const h of headers) {
      if (!h.textContent.includes(title)) continue;
      const parentSection = h.closest('div[id]');
      if (!parentSection || !/^\d+$/.test(parentSection.id)) return h;
    }
    return null;
  }

  // 取分组下所有数字 id section（按文档顺序，从 groupTitle header 之后到下一个 group header 之前）
  function getSectionsInGroup(drawer, groupTitle) {
    const startHeader = findGroupHeader(drawer, groupTitle);
    if (!startHeader) return [];
    const groupHeaders = Array.from(drawer.querySelectorAll('div[style*="border-left"]'))
      .filter(h => {
        const sec = h.closest('div[id]');
        return !sec || !/^\d+$/.test(sec.id);
      });
    const idx = groupHeaders.indexOf(startHeader);
    const endHeader = idx >= 0 ? groupHeaders[idx + 1] : null;
    const sections = Array.from(drawer.querySelectorAll('div[id]'))
      .filter(s => /^\d+$/.test(s.id));
    return sections.filter(sec => {
      const after = !!(startHeader.compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING);
      const before = !endHeader || !!(endHeader.compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_PRECEDING);
      return after && before;
    });
  }

  // 列出 section 内所有有 label 的 form-item（含 select / text input / checkbox 等的判定）
  function getFormItemsWithLabel(section) {
    const result = [];
    const seen = new Set();
    const items = Array.from(section.querySelectorAll('.rocket-form-field-item'));
    for (const item of items) {
      const lblEl = item.querySelector('label');
      if (!lblEl) continue;
      const text = U.normText(lblEl.textContent).replace(/[*：:]/g, '');
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push({
        label: text,
        formItem: item,
        isSelect: !!item.querySelector('.rocket-select'),
        isTextInput: !!item.querySelector('input.rocket-input, input[class*="rocket-input"], textarea.rocket-input, textarea[class*="rocket-input"]'),
      });
    }
    return result;
  }

  // 应用一条字段规则到 sectionRoot 范围内
  // field: { label, mode: 'ifEmpty'|'ensure', value, kind: 'select'|'text', waitBefore, waitAfter }
  async function applyFieldRule(field, sectionRoot, ctx) {
    if (field.waitBefore) await U.sleep(field.waitBefore);
    let value = field.value;
    if (value === '__SKC_SKU__') value = ctx.skcSku;

    if (field.kind === 'text') {
      const item = findFormItemByLabel(field.label, sectionRoot);
      const input = item?.querySelector('input.rocket-input, input[class*="rocket-input"], textarea.rocket-input, textarea[class*="rocket-input"]');
      if (!input) { console.warn('[TAL][rule] text input 未找到:', field.label); return; }
      if (field.mode === 'ensure') {
        input.focus();
        U.setInputValue(input, String(value));
      } else if (input.value?.trim()) {
        console.log('[TAL][rule] 已有值，跳过:', field.label);
      } else {
        input.focus();
        U.setInputValue(input, value);
      }
    } else {
      const item = findFormItemByLabel(field.label, sectionRoot);
      const container = item?.querySelector('.rocket-select');
      if (!container) { console.warn('[TAL][rule] select 未找到:', field.label); return; }
      if (field.mode === 'ensure') await ensureSelected(container, value, field.label);
      else await selectIfEmpty(container, value, field.label);
    }

    if (field.waitAfter) await U.sleep(field.waitAfter);
  }

  // Phase 2 合规填写白名单（按 section 分组）
  const SECTION_RULES_PHASE2 = [
    { type: 'single', title: '加州 65 号提案', fields: [
      { label: '警示类型', mode: 'ensure', value: '无需警示' },
    ] },
    { type: 'single', title: '欧盟负责人', fields: [
      { label: '欧盟负责人', mode: 'ensure', value: 0 },
    ] },
    { type: 'single', title: '制造商信息', fields: [
      { label: '制造商信息', mode: 'ensure', value: 0 },
    ] },
    { type: 'single', title: '土耳其负责人', fields: [
      { label: '土耳其负责人', mode: 'ensure', value: 0 },
    ] },
    // 该 section 不是 label-based form-item，而是嵌套 table：
    //   外层列「商品规格」(multiple-select) 选完后才会解锁内层 5 列
    //   内层列：材质分类 / 材料名称 / 它是否含有一次性塑料 / 包装类型 / 包装材料重量
    // 走专用 handler 'packagingTable'，按列头文本匹配列索引取 td 内控件
    { type: 'single', title: '包装材料信息收集', handler: 'packagingTable', fields: [
      // 商品规格是 multiple-select，handler 内特殊处理为 ifEmpty（不破坏商家可能已选的多个规格）
      { label: '商品规格', mode: 'ifEmpty', value: 0, kind: 'select', scope: 'outer' },
      // 内层字段：handler 内多轮扫描 + 强制 clear+重选；mode 仅用作语义标识
      { label: '材质分类', mode: 'ensure', value: '塑料', kind: 'select', scope: 'inner', waitAfter: 800 },
      { label: '材料名称', mode: 'ensure', value: '可生物降解的 PLA/PHA/PHB', kind: 'select', scope: 'inner' },
      { label: '一次性塑料', mode: 'ensure', value: '否', kind: 'select', scope: 'inner' },
      { label: '包装类型', mode: 'ensure', value: '软包装', kind: 'select', scope: 'inner' },
      { label: '包装材料重量', mode: 'ensure', value: '10', kind: 'text', scope: 'inner' },
    ] },
    // 单 section 但内部所有 select 都填 NA（border-left header 在数字 id section 内部）
    { type: 'single', title: '制造商属性', autoFillNA: true },
    // 分组 header（border-left header 在数字 id section 外，统领其后多个数字 id section）
    { type: 'group', title: '韩国公示信息', autoFillNA: true },
    { type: 'group', title: '其他合规信息', autoFillNA: true, exceptions: [
      { label: '商品识别码', mode: 'ensure', value: '__SKC_SKU__', kind: 'text' },
    ] },
  ];

  // 单次尝试填一个内层字段（select 或 text）：
  //   - 当前 disabled → return false（等下一轮）
  //   - 可填 → 强制覆盖（select 已有值先 clear 再重选，确保 change 触发下游解锁；text 直接 setInputValue）→ return true
  async function tryFillPackagingInnerField(field, td) {
    if (field.kind === 'text') {
      const input = td.querySelector('input.rocket-input, input[class*="rocket-input"], textarea.rocket-input, textarea[class*="rocket-input"]');
      if (!input) { console.warn('[TAL][rule] text input 未找到:', field.label); return false; }
      if (input.disabled) return false;
      input.focus();
      U.setInputValue(input, String(field.value));
      return true;
    }
    const ctn = td.querySelector('.rocket-select');
    if (!ctn) { console.warn('[TAL][rule] select 未找到:', field.label); return false; }
    if (ctn.classList.contains('rocket-select-disabled')) return false;
    if (rocketSelectHasValue(ctn)) {
      const clearBtn = ctn.querySelector('.rocket-select-clear');
      if (clearBtn) {
        clearBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        clearBtn.click();
        await U.sleep(400);
      }
    }
    await safeSelect(ctn, field.value, field.label);
    await U.sleep(300);
    return true;
  }

  // 「包装材料信息收集」专用 handler：嵌套 table 结构，按列头定位列索引取 td 内控件
  // 内层 5 字段级联依赖（实际顺序未知，可能 text→select 反向），用多轮扫描兜底：
  // 每轮跳过 disabled 字段，能填的就填，下一轮再扫描已解锁字段，直到全部完成或多轮无进展
  async function applyPackagingMaterialSection(section, ctx, fields) {
    const outerField = fields.find(f => f.scope === 'outer');
    const innerFields = fields.filter(f => f.scope === 'inner');

    if (outerField) {
      const outerSelect = section.querySelector('.rocket-select');
      if (!outerSelect) { console.warn('[TAL][rule] 商品规格 select 未找到'); return; }
      // 商品规格是 multiple-select，业务上不强制覆盖（保留商家可能已选的多个规格）
      await selectIfEmpty(outerSelect, outerField.value, outerField.label);
    }

    const trs = Array.from(section.querySelectorAll('tr'));
    const headerTr = trs.find(tr => tr.querySelector('th') && tr.textContent.includes('材质分类'));
    if (!headerTr) { console.warn('[TAL][rule] 内层表头未找到（材质分类列缺失）'); return; }
    const headerTexts = Array.from(headerTr.querySelectorAll('th')).map(th => U.normText(th.textContent));

    const headerIdx = trs.indexOf(headerTr);
    let dataTr = null;
    for (let i = headerIdx + 1; i < trs.length; i++) {
      const tr = trs[i];
      if (tr.getAttribute('aria-hidden') === 'true') continue;
      if (tr.querySelector('td')) { dataTr = tr; break; }
    }
    if (!dataTr) { console.warn('[TAL][rule] 内层数据行未找到'); return; }
    const dataTds = Array.from(dataTr.querySelectorAll(':scope > td'));

    const tasks = innerFields.map(f => {
      const colIdx = headerTexts.findIndex(t => t.includes(f.label));
      return { f, colIdx, td: colIdx >= 0 ? dataTds[colIdx] : null, done: false };
    });
    for (const t of tasks) {
      if (t.colIdx < 0) { console.warn(`[TAL][rule] 内层列未找到: ${t.f.label}`); t.done = true; }
      else if (!t.td) { console.warn(`[TAL][rule] 内层数据 td 不存在: ${t.f.label}`); t.done = true; }
    }

    const MAX_ROUNDS = 6;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      let progress = false;
      for (const t of tasks) {
        if (t.done) continue;
        if (t.f.waitBefore && round === 1) await U.sleep(t.f.waitBefore);
        const ok = await tryFillPackagingInnerField(t.f, t.td);
        if (ok) {
          t.done = true;
          progress = true;
          console.log(`[TAL][rule] inner 完成 [round ${round}]: ${t.f.label}`);
          if (t.f.waitAfter) await U.sleep(t.f.waitAfter);
        }
      }
      if (tasks.every(t => t.done)) break;
      if (!progress) {
        const remaining = tasks.filter(t => !t.done).map(t => t.f.label);
        console.warn(`[TAL][rule] round ${round} 无进展，等 800ms 后重试，剩余:`, remaining);
        await U.sleep(800);
      }
    }
    const pending = tasks.filter(t => !t.done).map(t => t.f.label);
    if (pending.length) console.warn('[TAL][rule] 包装材料 inner 字段最终未完成:', pending);
  }

  // 对 section 内所有 select 字段填 NA（用于 autoFillNA 类规则 + 兜底）
  async function autoFillSectionNA(sec, ctx, exceptions) {
    for (const item of getFormItemsWithLabel(sec)) {
      const ex = exceptions?.find(e => e.label === item.label);
      if (ex) {
        await applyFieldRule(ex, sec, ctx);
      } else if (item.isSelect) {
        await applyFieldRule({ label: item.label, mode: 'ensure', value: ctx.NA }, sec, ctx);
      }
    }
  }

  // 应用整套 Phase 2 规则 + 兜底
  // 白名单跑完后扫描 drawer 内未被任何 rule 命中的数字 id section，统一按 autoFillNA 处理
  async function applyPhase2Rules(drawer, ctx) {
    const handledSecIds = new Set();

    for (const rule of SECTION_RULES_PHASE2) {
      if (rule.type === 'single') {
        const sec = findSectionByOwnTitle(drawer, rule.title);
        if (!sec) { console.warn(`[TAL][step3] section "${rule.title}" 未找到，跳过`); continue; }
        console.log(`[TAL][step3] section "${rule.title}" (id=${sec.id})`);
        handledSecIds.add(sec.id);
        if (rule.handler === 'packagingTable') {
          await applyPackagingMaterialSection(sec, ctx, rule.fields);
          continue;
        }
        if (rule.autoFillNA) {
          await autoFillSectionNA(sec, ctx, rule.exceptions);
          continue;
        }
        for (const field of rule.fields) {
          await applyFieldRule(field, sec, ctx);
        }
      } else if (rule.type === 'group') {
        const sections = getSectionsInGroup(drawer, rule.title);
        console.log(`[TAL][step3] group "${rule.title}" 含 ${sections.length} section: [${sections.map(s => s.id).join(',')}]`);
        for (const sec of sections) {
          handledSecIds.add(sec.id);
          await autoFillSectionNA(sec, ctx, rule.exceptions);
        }
      }
    }

    // 兜底：drawer 内所有未被白名单命中的数字 id section 统一 autoFillNA
    const allSections = Array.from(drawer.querySelectorAll('div[id]')).filter(s => /^\d+$/.test(s.id));
    const unhandled = allSections.filter(s => !handledSecIds.has(s.id));
    for (const sec of unhandled) {
      const titleEl = sec.querySelector(':scope > div[style*="border-left"]');
      const title = titleEl ? U.normText(titleEl.textContent).slice(0, 40) : `id=${sec.id}`;
      console.log(`[TAL][step3] 兜底 autoFillNA: "${title}" (id=${sec.id})`);
      await autoFillSectionNA(sec, ctx);
    }
  }

  // 点击 Rocket Design Select 并选择选项（字符串文本 或 数字下标）
  async function rocketSelect(container, optionTextOrIndex) {
    if (!container) throw new Error('rocket-select 容器为 null');
    // 等待 disabled 解除（最多 5 秒）
    for (let i = 0; i < 25; i++) {
      if (!container.classList.contains('rocket-select-disabled')) break;
      await U.sleep(200);
    }
    const trigger = container.querySelector('.rocket-select-selector');
    if (!trigger) throw new Error('找不到 .rocket-select-selector');

    // 若已经 open 先点击关闭，再重新打开，确保下拉刷新
    if (container.classList.contains('rocket-select-open')) {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      trigger.click();
      await U.sleep(300);
    }
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    trigger.click();

    // 轮询等待下拉出现（不依赖 hidden 类，用 computedStyle 判断可见性）
    let dropdown = null;
    for (let i = 0; i < 25; i++) {
      await U.sleep(200);
      for (const d of document.querySelectorAll('.rocket-select-dropdown')) {
        const cs = window.getComputedStyle(d);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const items = d.querySelectorAll('.rocket-select-item-option');
        if (items.length > 0) { dropdown = d; break; }
      }
      if (dropdown) break;
    }
    if (!dropdown) throw new Error('下拉菜单未出现（等待 5s 超时）');

    const opts = Array.from(dropdown.querySelectorAll('.rocket-select-item-option'));
    const target = typeof optionTextOrIndex === 'number'
      ? opts[optionTextOrIndex]
      : opts.find(o => U.normText(o.textContent).includes(U.normText(optionTextOrIndex)));
    if (!target) throw new Error(`选项不存在: ${optionTextOrIndex}`);
    target.click();
    await U.sleep(300);

    // 多选下拉选完后不会自动收起，按 Escape 关闭
    if (container.classList.contains('rocket-select-open')) {
      const searchInput = container.querySelector('input');
      searchInput?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })
      );
      await U.sleep(300);
      // 仍未关闭则点击 body 关闭
      if (container.classList.contains('rocket-select-open')) {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await U.sleep(200);
      }
    }
  }

  // 安全 select（失败仅 warn，不中断流程）
  async function safeSelect(el, option, fieldName) {
    try { await rocketSelect(el, option); }
    catch (e) { console.warn(`[TAL] ${fieldName} 选择失败:`, e.message); }
  }

  // 检查 rocket-select 容器当前是否有值（单选/多选均支持）
  function rocketSelectHasValue(container) {
    if (!container) return false;
    const isMultiple = container.classList.contains('rocket-select-multiple');
    if (isMultiple) {
      return container.querySelectorAll(
        '.rocket-select-selection-overflow-item:not(.rocket-select-selection-overflow-item-suffix)'
      ).length > 0;
    }
    const cur = container.querySelector('.rocket-select-selection-item')?.textContent.trim();
    return !!(cur && cur !== '请选择' && cur.length > 0);
  }

  // 列出多选 tag 文本
  function getMultiSelectTags(container) {
    return Array.from(container.querySelectorAll(
      '.rocket-select-selection-overflow-item:not(.rocket-select-selection-overflow-item-suffix)'
    )).map(t => U.normText(t.textContent));
  }

  // 清空多选下拉的所有已选 tag —— 逐个点击 tag 的 remove 按钮
  async function removeAllSelectedTags(container) {
    for (let safety = 0; safety < 30; safety++) {
      const tags = container.querySelectorAll(
        '.rocket-select-selection-overflow-item:not(.rocket-select-selection-overflow-item-suffix)'
      );
      if (!tags.length) return true;
      const tag = tags[0];
      const closer =
        tag.querySelector('.rocket-select-selection-item-remove') ||
        tag.querySelector('[class*="item-remove"]') ||
        tag.querySelector('[class*="anticon-close"]') ||
        tag.querySelector('[aria-label*="移除"], [aria-label*="删除"], [aria-label*="close"]');
      if (!closer) {
        console.warn('[TAL] 未找到 tag 的 remove 按钮，无法清空多选');
        return false;
      }
      closer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      closer.click();
      await U.sleep(200);
    }
    return false;
  }

  // 强制将下拉值改为目标值（字符串文本或数字下标）；当前已是目标则跳过；多选会先清空再选
  // 数字下标无法预先确定目标文本（要打开 dropdown 才能看 options），所以始终先清空再按下标选
  async function ensureSelected(container, option, fieldName) {
    if (!container) { console.warn('[TAL] 未找到字段:', fieldName); return; }
    const isMultiple = container.classList.contains('rocket-select-multiple');

    if (typeof option === 'number') {
      if (isMultiple) {
        if (getMultiSelectTags(container).length > 0) {
          const cleared = await removeAllSelectedTags(container);
          if (!cleared) console.warn(`[TAL] ${fieldName} 旧值未完全清空，继续尝试`);
        }
      } else if (rocketSelectHasValue(container)) {
        const clearBtn = container.querySelector('.rocket-select-clear');
        if (clearBtn) {
          clearBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          clearBtn.click();
          await U.sleep(400);
        }
      }
      for (let attempt = 1; attempt <= 2; attempt++) {
        await safeSelect(container, option, fieldName);
        await U.sleep(300);
        if (rocketSelectHasValue(container)) return;
        console.warn(`[TAL] ${fieldName} 按下标 ${option} 第 ${attempt} 次未生效，重试`);
      }
      console.warn(`[TAL] ${fieldName} 按下标 ${option} 重试后仍未选上`);
      return;
    }

    const targetNorm = U.normText(option);

    if (isMultiple) {
      const matchTarget = () => {
        const tags = getMultiSelectTags(container);
        return tags.length === 1 && tags[0].includes(targetNorm);
      };
      if (matchTarget()) {
        console.log('[TAL] 已是目标值，跳过:', fieldName);
        return;
      }
      // 旧值存在或包含其他值 → 全部清空
      if (getMultiSelectTags(container).length > 0) {
        const cleared = await removeAllSelectedTags(container);
        if (!cleared) console.warn(`[TAL] ${fieldName} 旧值未完全清空，继续尝试选择`);
      }
      for (let attempt = 1; attempt <= 2; attempt++) {
        await safeSelect(container, option, fieldName);
        await U.sleep(300);
        if (matchTarget()) return;
        console.warn(`[TAL] ${fieldName} 设置为「${option}」未生效，第 ${attempt} 次重试`);
      }
      console.warn(`[TAL] ${fieldName} 重试后仍未改成目标值「${option}」`);
      return;
    }

    // 单选
    const matchTarget = () => {
      const cur = container.querySelector('.rocket-select-selection-item')?.textContent.trim();
      return cur ? U.normText(cur).includes(targetNorm) : false;
    };
    if (matchTarget()) {
      console.log('[TAL] 已是目标值，跳过:', fieldName);
      return;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      await safeSelect(container, option, fieldName);
      await U.sleep(300);
      if (matchTarget()) return;
      console.warn(`[TAL] ${fieldName} 改为「${option}」未生效，第 ${attempt} 次重试`);
    }
    console.warn(`[TAL] ${fieldName} 重试后仍未改成目标值「${option}」`);
  }

  // 若字段已有值则跳过，避免 toggle 撤销；选完后验证未生效会重试 1 次
  async function selectIfEmpty(container, option, fieldName) {
    if (!container) { console.warn('[TAL] 未找到字段:', fieldName); return; }
    if (rocketSelectHasValue(container)) {
      console.log('[TAL] 已有值，跳过:', fieldName); return;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      await safeSelect(container, option, fieldName);
      await U.sleep(300);
      if (rocketSelectHasValue(container)) return;
      console.warn(`[TAL] ${fieldName} 选完后仍为空，第 ${attempt} 次重试`);
    }
    console.warn(`[TAL] ${fieldName} 重试后仍未选上，请人工检查`);
  }

  // 若 text input 已有内容则跳过
  const FIELD_SELECTOR = 'input.rocket-input, input[class*="rocket-input"], textarea.rocket-input, textarea[class*="rocket-input"]';

  // id 优先找 input；找不到再用 fieldName 当 label 走 form-item fallback
  async function fillTextIfEmpty(inputId, value, fieldName, root = document) {
    let input = inputId ? document.getElementById(inputId) : null;
    if (!input && fieldName) {
      const item = findFormItemByLabel(fieldName, root);
      input = item?.querySelector(FIELD_SELECTOR);
    }
    if (!input) { console.warn('[TAL] 未找到 input:', inputId, fieldName); return; }
    if (input.value?.trim()) { console.log('[TAL] 已有值，跳过:', fieldName); return; }
    input.focus();
    U.setInputValue(input, value);
  }

  // 通过 label 在 form-item 容器内填写 input/textarea
  async function fillInputByLabel(labelText, value, root = document) {
    const item = findFormItemByLabel(labelText, root);
    if (!item) { console.warn('[TAL] 未找到 form-item:', labelText); return; }
    const field = item.querySelector(FIELD_SELECTOR);
    if (!field) { console.warn('[TAL] form-item 内未找到输入框:', labelText); return; }
    if (field.value?.trim()) { console.log('[TAL] 已有值，跳过:', labelText); return; }
    field.focus();
    U.setInputValue(field, value);
  }

  // 构建 rowspan/colspan-aware 的列映射
  // 返回 colMap[rowIdx][colIdx] = 该列在该行真实承载的 td 元素（rowspan 占位行也指向源 td）
  function buildRowspanColMap(rows, totalCols) {
    const rowspanState = new Array(totalCols).fill(null);  // 列 → 剩余跨行数 + 源 td
    return rows.map(row => {
      const map = new Array(totalCols).fill(null);
      let col = 0;
      let tdIdx = 0;
      const tds = Array.from(row.children).filter(c => c.tagName === 'TD');
      while (col < totalCols) {
        // 先消费 rowspan 残余
        if (rowspanState[col]) {
          map[col] = rowspanState[col].td;
          rowspanState[col].remain--;
          if (rowspanState[col].remain <= 0) rowspanState[col] = null;
          col++;
          continue;
        }
        const td = tds[tdIdx++];
        if (!td) break;
        const rs = parseInt(td.getAttribute('rowspan') || '1', 10);
        const cs = parseInt(td.getAttribute('colspan') || '1', 10);
        for (let c = 0; c < cs && col + c < totalCols; c++) {
          map[col + c] = td;
          if (rs > 1) rowspanState[col + c] = { td, remain: rs - 1 };
        }
        col += cs;
      }
      return map;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 2 主流程
  // ═══════════════════════════════════════════════════════════════════════════
  async function onStartCompliance() {
    if (!fstate.product) return;
    setCFlow({
      active: true, step: 1,
      skcNumber: fstate.product.skcNumber,
      skcSku: fstate.product.skcSku,
      spuId: null,
    });
    window.location.href = '/govern/compliant-live-photos'; // window.open('/govern/compliant-live-photos', '_blank');
  }

  // ── Step 1：实拍图页面 — 用 SKC 查 SPU ───────────────────────────────────
  async function checkAndRunStep1() {
    const flow = getCFlow();
    if (!flow?.active || flow.step !== 1) return;
    await U.sleep(2000);
    try { await runStep1(flow); }
    catch (e) { U.showToast('步骤1失败: ' + e.message, 'err'); clearCFlow(); }
  }

  async function runStep1(flow) {
    U.showToast('步骤 1/3：查询 SPU...', 'info');

    // 先等类型下拉出现，再选 SKC（skcIdStr 在选类型之后才会渲染）
    await U.waitForEl('input#goodsSearchType', document, 12000);
    await U.sleep(400);
    const typeSelect = rocketSelectById('goodsSearchType');
    if (!typeSelect) throw new Error('未找到搜索类型下拉');
    const curVal = typeSelect.querySelector('.rocket-select-selection-item')?.textContent.trim();
    if (curVal !== 'SKC') {
      await rocketSelect(typeSelect, 'SKC');
      await U.sleep(600);
    }

    // 选完 SKC 后输入框才出现
    await U.waitForEl('input#skcIdStr', document, 8000);
    await U.sleep(300);
    const skcInput = document.getElementById('skcIdStr');
    if (!skcInput) throw new Error('未找到 skcIdStr 输入框');
    skcInput.focus();
    U.setInputValue(skcInput, flow.skcNumber);
    await U.sleep(300);

    // 点击查询（"查 询" normText 后匹配 "查询"）
    const searchBtn = U.findByText('button', '查询');
    if (!searchBtn) throw new Error('未找到查询按钮');
    searchBtn.click();
    await U.sleep(2500);

    // 提取 SPU（页面结构：<span>SPU：</span>9201662325）
    const spuId = extractSpuFromPage();
    if (!spuId) throw new Error('未找到 SPU（查询结果为空？）');

    U.showToast(`找到 SPU: ${spuId}，开新标签继续...`, 'info');
    setCFlow({ ...flow, step: 2, spuId });
    await U.sleep(800);
    window.location.href = '/govern/information-supplementation'; // window.open('/govern/information-supplementation', '_blank');
  }

  function extractSpuFromPage() {
    // 优先：<span>SPU：</span>xxx 结构
    const spuSpan = Array.from(document.querySelectorAll('span'))
      .find(s => s.textContent.trim().startsWith('SPU'));
    if (spuSpan) {
      const m = spuSpan.parentElement?.textContent.match(/SPU[：:]\s*(\d+)/);
      if (m) return m[1];
    }
    // 兜底：全页可见文字
    const m = document.body.innerText.match(/SPU[：:]\s*(\d+)/);
    return m ? m[1] : null;
  }

  // ── Step 2：合规信息列表页 — 查询 + 点编辑 ───────────────────────────────
  async function checkAndRunStep2or3() {
    const flow = getCFlow();
    if (!flow?.active) return;
    await U.sleep(2000);
    if (flow.step === 2) {
      try { await runStep2(flow); }
      catch (e) { U.showToast('步骤2失败: ' + e.message, 'err'); clearCFlow(); clearImgFlow(); }
    } else if (flow.step === 3) {
      try { await runStep3(getCFlow()); }
      catch (e) { U.showToast('步骤3失败: ' + e.message, 'err'); clearCFlow(); clearImgFlow(); }
    }
  }

  async function runStep2(flow) {
    U.showToast('步骤 2/3：查询合规信息...', 'info');
    await U.waitForEl('input#spuId', document, 12000);
    await U.sleep(500);

    // 填 SPU ID（id=spuId）
    const spuInput = document.getElementById('spuId');
    if (!spuInput) throw new Error('未找到 spuId 输入框');
    spuInput.focus();
    U.setInputValue(spuInput, flow.spuId);
    await U.sleep(300);

    // 点查询（"查 询" → normText "查询"）
    const queryBtn = U.findByText('button', '查询');
    if (!queryBtn) throw new Error('未找到查询按钮');
    queryBtn.click();
    await U.sleep(1500);

    // 强校验：表格"商品信息"列必须显示目标 SPU 的行；未匹配自动重新查询
    const matchedRow = await ensureQueryMatchesSpu(flow.spuId);
    if (!matchedRow) throw new Error(`查询结果未匹配目标 SPU=${flow.spuId}（重试 3 次仍失败）`);

    // 在匹配行内查找编辑按钮，避免误点其他行
    const editBtn = Array.from(matchedRow.querySelectorAll('button.rocket-btn-link, a.rocket-btn-link'))
      .find(el => el.textContent.trim() === '编辑');
    if (!editBtn) throw new Error('匹配行内未找到编辑按钮');

    setCFlow({ ...flow, step: 3 });
    // 部分场景 click() 不触发，mousedown 兜底
    editBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    editBtn.click();

    // 等待 drawer 真正打开；不打开则重试 click 一次
    let drawer = await waitForDrawerOpen(8000);
    if (!drawer) {
      console.warn('[TAL] 首次 click 编辑按钮后 drawer 未打开，重试');
      editBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      editBtn.click();
      drawer = await waitForDrawerOpen(8000);
    }
    if (!drawer) throw new Error('点击编辑按钮后 drawer 未打开');
    await U.sleep(500);
    await runStep3(getCFlow());
  }

  // 等待 drawer body 可见且内部有 form 元素；返回 drawer body 或 null
  async function waitForDrawerOpen(timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const d of document.querySelectorAll('.rocket-drawer-body')) {
        const cs = window.getComputedStyle(d);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (d.querySelector('.rocket-select, input, textarea')) return d;
      }
      await U.sleep(200);
    }
    return null;
  }

  // 等待 drawer 内所有 div[id=数字] section 内部 form 控件都渲染好
  // drawer 是分阶段渲染：section 容器先出现 → 内部 select/input 后渲染
  async function waitForAllSectionsRendered(drawer, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const sections = Array.from(drawer.querySelectorAll('div[id]'))
        .filter(s => /^\d+$/.test(s.id));
      if (sections.length === 0) { await U.sleep(300); continue; }
      const notReady = sections.filter(s =>
        !s.querySelector('label, .rocket-select, .rocket-input, .rocket-checkbox-group')
      );
      if (notReady.length === 0) {
        console.log(`[TAL] 所有 ${sections.length} 个 section 已渲染`);
        return true;
      }
      await U.sleep(300);
    }
    const sections = Array.from(drawer.querySelectorAll('div[id]'))
      .filter(s => /^\d+$/.test(s.id));
    const notReady = sections.filter(s =>
      !s.querySelector('label, .rocket-select, .rocket-input, .rocket-checkbox-group')
    );
    console.warn(`[TAL] section 渲染等待超时：${notReady.map(s => s.id).join(',')} 仍未就绪，继续`);
    return false;
  }

  // 在表格中查找"商品信息"列含目标 SPU 的行；找不到返回 null
  function findRowBySpu(spuId) {
    const headers = document.querySelectorAll(
      'thead th, .rocket-table-thead th, [class*="table-thead"] th, [class*="table-header"] th'
    );
    let colIdx = -1;
    headers.forEach((th, i) => {
      if (U.normText(th.textContent).includes('商品信息')) colIdx = i;
    });
    if (colIdx < 0) return null;

    const rows = document.querySelectorAll(
      'tbody tr, .rocket-table-tbody tr, [class*="table-tbody"] tr'
    );
    const target = String(spuId);
    for (const row of rows) {
      const cell = row.querySelectorAll('td')[colIdx];
      if (!cell) continue;
      const m = cell.textContent.match(/SPU[：:]\s*(\d+)/);
      if (m && m[1] === target) return row;
    }
    return null;
  }

  // 轮询等待表格刷新出目标 SPU 行
  async function waitForRowBySpu(spuId, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const row = findRowBySpu(spuId);
      if (row) return row;
      await U.sleep(300);
    }
    return null;
  }

  // 重试查询直到表格匹配目标 SPU；返回匹配行或 null
  async function ensureQueryMatchesSpu(spuId, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const row = await waitForRowBySpu(spuId, 6000);
      if (row) {
        if (attempt > 1) console.log(`[TAL] 重试第 ${attempt} 次后匹配到 SPU=${spuId}`);
        return row;
      }
      console.warn(`[TAL] 未匹配 SPU=${spuId}，第 ${attempt}/${maxAttempts} 次重新查询`);
      const spuInput = document.getElementById('spuId');
      if (spuInput) {
        spuInput.focus();
        U.setInputValue(spuInput, String(spuId));
        await U.sleep(300);
      }
      U.findByText('button', '查询')?.click();
      await U.sleep(1500);
    }
    return null;
  }

  // ── Step 3：填写编辑 drawer 表单 ─────────────────────────────────────────
  async function runStep3(flow) {
    U.showToast('步骤 3/3：填写合规信息...', 'info');

    // 等 drawer 出现 + 所有 section 内部字段都渲染完
    const drawer = await waitForDrawerOpen(15000);
    if (!drawer) throw new Error('drawer 未打开（15s 超时）');
    await waitForAllSectionsRendered(drawer, 20000);

    // 简化诊断日志：列出每个 section 的状态
    const sections = Array.from(drawer.querySelectorAll('div[id]'))
      .filter(s => /^\d+$/.test(s.id));
    sections.forEach(s => {
      const title = s.firstElementChild?.textContent.trim().slice(0, 30) || '';
      const tag = s.querySelector('.rocket-tag')?.textContent.trim() || '无 tag';
      console.log(`[TAL][section] id=${s.id} 状态=「${tag}」 标题="${title}"`);
    });

    await U.sleep(500);

    // 按 SECTION_RULES_PHASE2 白名单循环填写（section 分组 + 内部 label 动态识别）
    await applyPhase2Rules(drawer, { skcSku: flow.skcSku, NA: '该项目不适用该产品' });

    await U.sleep(500);
    const confirmBtn = U.findByText('button', '确认');
    if (!confirmBtn) throw new Error('未找到确认按钮');
    confirmBtn.click();

    await U.sleep(1500);
    const continueToPhase3 = flow.continueToPhase3;

    // 等 drawer 关闭
    for (let i = 0; i < 25; i++) {
      if (!document.querySelector('.rocket-drawer-body')) break;
      await U.sleep(200);
    }

    if (!continueToPhase3) {
      clearCFlow();
      U.showToast('② 合规填写完成 ✓', 'ok');
      return;
    }

    // Phase 3 前置：检查列表中"商品合规信息"列每行是否均为"上传成功"
    U.showToast('② 已提交，校验上传状态...', 'info');
    await U.sleep(1200);
    const uploadOk = await checkComplianceColumnAllSuccess(flow.spuId);
    if (!uploadOk) {
      clearCFlow();
      U.showToast('②❌ 商品合规信息上传失败，请人工处理', 'err');
      return;
    }

    clearCFlow();
    U.showToast('② 合规填写完成 ✓，启动主图上传...', 'ok');

    const labelPng = localStorage.getItem('talLabelPng');
    const skcNumber = flow.skcNumber;
    if (labelPng && skcNumber) {
      await U.sleep(800);
      setImgFlow({ active: true, skcNumber, skcSku: flow.skcSku, spuId: flow.spuId, labelPngPath: labelPng });
      window.location.href = '/govern/compliant-live-photos'; // window.open('/govern/compliant-live-photos', '_blank');
    } else {
      U.showToast('③ 标签文件不存在，请重新执行完整流程', 'err');
    }
  }

  // Phase 3 前置：重新查询 SPU，扫描"商品合规信息"列每行是否均含"上传成功"
  // 兼容 Rocket Design 的 div table（rocket-table-row / rocket-table-cell）和原生 table
  // 加了详细日志和延时，方便 Console 排查实际 DOM 结构
  async function checkComplianceColumnAllSuccess(spuId) {
    // 1. 重新查询，确保表格是最新状态
    const spuInput = document.getElementById('spuId');
    if (spuInput && spuId) {
      spuInput.focus();
      U.setInputValue(spuInput, spuId);
      await U.sleep(300);
      U.findByText('button', '查询')?.click();
      await U.sleep(2500);
    }

    // 2. 定位"商品合规信息"列表头
    const headerCellCandidates = document.querySelectorAll(
      'thead th, ' +
      '.rocket-table-thead th, ' +
      '[class*="rocket-table-thead"] [class*="rocket-table-cell"], ' +
      '[class*="rocket-table-thead"] [class*="rocket-table-th"], ' +
      '[role="columnheader"]'
    );
    let headerCell = null;
    for (const th of headerCellCandidates) {
      if (U.normText(th.textContent).includes('商品合规信息')) { headerCell = th; break; }
    }
    if (!headerCell) {
      console.warn('[TAL][校验] 未找到"商品合规信息"列表头');
      return false;
    }
    const colIdx = Array.from(headerCell.parentElement?.children || []).indexOf(headerCell);
    if (colIdx < 0) {
      console.warn('[TAL][校验] 列 idx 计算失败');
      return false;
    }

    // 3. 找数据行 + 构建 rowspan-aware 列映射
    const tbody = headerCell.closest('table')?.querySelector('tbody');
    const rowCandidates = tbody
      ? Array.from(tbody.querySelectorAll(':scope > tr'))
      : [];
    const totalCols = headerCell.parentElement?.children.length || 0;
    const colMap = buildRowspanColMap(rowCandidates, totalCols);

    const PLACEHOLDER = /^[-—\s]*$|^n\/a$/i;
    const dataRows = [];
    rowCandidates.forEach((row, i) => {
      const cell = colMap[i]?.[colIdx];
      if (!cell) return;
      const txt = U.normText(cell.textContent);
      if (!txt || PLACEHOLDER.test(txt)) return;
      dataRows.push({ row, cell, txt });
    });

    console.log(`[TAL][校验] colIdx=${colIdx} 候选行=${rowCandidates.length} 数据行=${dataRows.length}`);
    if (!dataRows.length) {
      console.warn('[TAL][校验] 没有任何有数值的行');
      return false;
    }

    const FAIL_STATES = ['待上传', '上传失败', '上传中', '审核中', '审核失败', '未提交', '草稿', '待审核'];
    // 这两行的合规状态不参与判断（按业务要求允许其保持非"上传成功"也可进 Phase 3）
    const SKIP_NAMES = ['韩国公示信息', '其他合规信息'];
    let checked = 0, skipped = 0;
    for (const { txt } of dataRows) {
      if (SKIP_NAMES.some(name => txt.includes(name))) {
        console.log(`[TAL][校验] 跳过校验行: ${txt}`);
        skipped++;
        continue;
      }
      const hit = FAIL_STATES.find(s => txt.includes(s));
      if (hit) {
        console.warn(`[TAL][校验] 行状态命中失败态「${hit}」:`, txt);
        return false;
      }
      if (!txt.includes('上传成功')) {
        console.warn('[TAL][校验] 行状态非"上传成功":', txt);
        return false;
      }
      checked++;
    }
    console.log(`[TAL][校验] ✓ 所有受检行 "上传成功"（${checked} 条受检 / ${skipped} 条跳过 / 共 ${dataRows.length}）`);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 主图插入 Phase 3
  // ═══════════════════════════════════════════════════════════════════════════

  // ── 流程状态 ──────────────────────────────────────────────────────────────
  function getImgFlow() {
    try { return JSON.parse(localStorage.getItem('talImgFlow') || 'null'); } catch { return null; }
  }
  function setImgFlow(d) { localStorage.setItem('talImgFlow', JSON.stringify(d)); }
  function clearImgFlow() { localStorage.removeItem('talImgFlow'); }

  async function onStartImageUpload() {
    if (!fstate.product) return;
    const labelPng = localStorage.getItem('talLabelPng');
    if (!labelPng) return;
    setImgFlow({
      active: true,
      skcNumber: fstate.product.skcNumber,
      skcSku: fstate.product.skcSku,
      labelPngPath: labelPng,
    });
    window.location.href = '/govern/compliant-live-photos'; // window.open('/govern/compliant-live-photos', '_blank');
  }

  // ── 页面检测 & 触发 ────────────────────────────────────────────────────────
  async function checkAndRunImgUpload() {
    const flow = getImgFlow();
    if (!flow?.active) return;
    await U.sleep(2000);
    try { await runImgSearch(flow); }
    catch (e) { U.showToast('主图上传失败: ' + e.message, 'err'); clearImgFlow(); }
  }

  // ── 搜索商品并点修改按钮 ─────────────────────────────────────────────────
  async function runImgSearch(flow) {
    U.showToast('主图插入：搜索商品...', 'info');
    await U.waitForEl('input#goodsSearchType', document, 12000);
    await U.sleep(400);

    // 确保类型选 SKC
    const typeSelect = rocketSelectById('goodsSearchType');
    if (typeSelect) {
      const cur = typeSelect.querySelector('.rocket-select-selection-item')?.textContent.trim();
      if (cur !== 'SKC') {
        await rocketSelect(typeSelect, 'SKC');
        await U.sleep(600);
      }
    }

    await U.waitForEl('input#skcIdStr', document, 8000);
    await U.sleep(300);
    const skcInput = document.getElementById('skcIdStr');
    if (!skcInput) throw new Error('未找到 skcIdStr 输入框');
    skcInput.focus();
    U.setInputValue(skcInput, flow.skcNumber);
    await U.sleep(300);

    const searchBtn = U.findByText('button', '查询');
    if (!searchBtn) throw new Error('未找到查询按钮');
    searchBtn.click();
    await U.sleep(1500);

    // 强校验：表格"商品信息"列必须显示目标 SPU 的行；未匹配自动重新查询
    if (!flow.spuId) throw new Error('imgFlow 缺少 spuId，无法校验商品身份');
    const matchedRow = await ensureQueryMatchesSpu(flow.spuId);
    if (!matchedRow) throw new Error(`查询结果未匹配目标 SPU=${flow.spuId}（重试 3 次仍失败）`);

    // 在匹配行内查找「修改」或「上传」按钮，避免误点其他行
    const actionBtn = Array.from(matchedRow.querySelectorAll('button.rocket-btn-link, a.rocket-btn-link'))
      .find(el => el.textContent.trim() === '修改' || el.textContent.trim() === '上传');
    if (!actionBtn) throw new Error('匹配行内未找到修改/上传按钮');

    actionBtn.click();

    // 等待修改 drawer 打开
    await U.sleep(2000);
    await runImgUpload(flow);
  }

  // ── 在 drawer 内上传标签图 ───────────────────────────────────────────────
  async function runImgUpload(flow) {
    U.showToast('主图插入：读取标签文件...', 'info');

    try { await U.waitForEl('.rocket-drawer-body', document, 10000); } catch { /* 继续 */ }
    await U.sleep(600);

    // 通过 Native Host 分块读取标签图（避免单消息超过 Chrome Native Messaging 1MB 上限）
    const bytes = await readFileChunked(flow.labelPngPath);
    const filename = flow.labelPngPath.split(/[\\/]/).pop() || 'label.png';

    U.showToast('主图插入：定位标签图槽位...', 'info');
    const uploaded = await uploadToLabelSlots(bytes, filename);
    if (!uploaded) throw new Error('未找到可上传的标签图位置');

    // 等待上传组件处理文件
    await U.sleep(1500);

    const submitBtn = U.findByText('button', '上传并识别');
    console.log('[TAL] 上传并识别按钮:', submitBtn ? '已找到，准备点击' : '未找到');
    if (!submitBtn) throw new Error('未找到「上传并识别」按钮');
    submitBtn.click();
    console.log('[TAL] 上传并识别已点击');

    await U.sleep(1000);
    clearImgFlow();
    U.showToast('③ 主图上传完成 ✓', 'ok');
  }

  // 找所有「标签图」类型上传按钮，优先空白槽位（计数为 0），全有则上传全部
  async function uploadToLabelSlots(bytes, filename) {
    const allBtns = Array.from(document.querySelectorAll('.rocket-upload[role="button"]'));
    const labelBtns = allBtns.filter(btn =>
      Array.from(btn.querySelectorAll('span'))
        .some(s => s.childElementCount === 0 && s.textContent.trim() === '标签图')
    );
    console.log('[TAL] 标签图 upload 按钮数量:', labelBtns.length);
    if (!labelBtns.length) return false;

    // 空白槽位：计数器为 (0/N)
    const emptyBtns = labelBtns.filter(btn => {
      const m = btn.textContent.match(/\((\d+)\/\d+\)/);
      return !m || parseInt(m[1]) === 0;
    });
    const targets = emptyBtns.length > 0 ? emptyBtns : labelBtns;
    console.log('[TAL] 目标槽位数量:', targets.length, '(空白:', emptyBtns.length, ')');

    for (const btn of targets) {
      const fileInput = btn.querySelector('input[type="file"]');
      if (fileInput) {
        console.log('[TAL] 注入文件到 input:', fileInput.id || '(无id)');
        await injectFileToInput(fileInput, bytes, filename);
      }
    }
    return true;
  }

  function mimeFromName(filename) {
    const ext = (filename || '').toLowerCase().split('.').pop();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    return 'image/png';
  }

  // 将字节数据注入 input[type=file] 并触发上传
  async function injectFileToInput(fileInput, bytes, filename) {
    const mime = mimeFromName(filename);
    const blob = new Blob([bytes], { type: mime });
    const file = new File([blob], filename, { type: mime, lastModified: Date.now() });
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await U.sleep(500);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Feature view 渲染
  // ═══════════════════════════════════════════════════════════════════════════
  function renderAutoGenLabel(viewEl) {
    viewEl.innerHTML = `
      <div class="tal-card">
        <div class="tal-card-title">当前设置</div>
        <div class="tal-path-row" id="tal-path-template" title="点击选择 BarTender 模板">
          <span class="tal-path-k">模板</span>
          <span class="tal-path-v" id="tal-path-template-v"></span>
        </div>
        <div class="tal-path-row" id="tal-path-output" title="点击选择输出文件夹">
          <span class="tal-path-k">输出</span>
          <span class="tal-path-v" id="tal-path-output-v"></span>
        </div>
      </div>
      <div class="tal-card">
        <div class="tal-card-title">当前商品</div>
        <div class="tal-product-empty" id="tal-product-empty">
          ${isBarcodeManagementPage() ? '请点击商品行选择' : '请导航到条码管理页'}
        </div>
        <div id="tal-product-info" style="display:none">
          <div class="tal-kv"><span class="tal-k">SKC货号</span><span id="tal-val-sku" class="tal-v"></span></div>
          <div class="tal-kv"><span class="tal-k">SKC</span><span id="tal-val-skc" class="tal-v"></span></div>
          <div class="tal-kv" id="tal-label-row" style="display:none">
            <span class="tal-k">标签文件</span><span id="tal-val-label" class="tal-v"></span>
          </div>
          <button class="tal-clear-btn" id="tal-clear">× 清除选择</button>
        </div>
      </div>
      <button class="tal-action-btn" id="tal-btn-auto" disabled>开始执行</button>
      ${TAL_DEBUG ? `
      <div class="tal-card">
        <div class="tal-card-title">调试</div>
        <div class="tal-debug-row">
          <span class="tal-k">标签缩放比例</span>
          <input type="number" id="tal-debug-ratio" min="0.1" max="1" step="0.01" value="${getWidthRatio()}">
        </div>
        <button class="tal-action-btn tal-debug-btn" id="tal-btn-debug" disabled>仅生成标签（调试）</button>
      </div>` : ''}
      <div class="tal-status" id="tal-status"></div>
    `;
    document.getElementById('tal-btn-auto').addEventListener('click', onRunAllPhases);
    document.getElementById('tal-clear').addEventListener('click', clearSelection);
    document.getElementById('tal-path-template').addEventListener('click', onPickTemplate);
    document.getElementById('tal-path-output').addEventListener('click', onPickOutputDir);
    if (TAL_DEBUG) {
      document.getElementById('tal-btn-debug').addEventListener('click', onRunPhase1Only);
      document.getElementById('tal-debug-ratio').addEventListener('change', e => {
        const v = parseFloat(e.target.value);
        if (v > 0 && v <= 1) localStorage.setItem('talWidthRatio', String(v));
      });
    }
    refreshPathsUI();
    refreshProductUI();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 注册到 core
  // ═══════════════════════════════════════════════════════════════════════════
  window.AgentSeller.registerFeature({
    id: 'auto_gen_label',
    icon: '🚀',
    label: '标签生成',
    locked: false,
    init() {
      onPageChange(() => {
        if (isBarcodeManagementPage())     waitForTableThenBind();
        if (isCompliantLivePhotosPage())   { checkAndRunStep1(); checkAndRunImgUpload(); }
        if (isComplianceInfoPage())        checkAndRunStep2or3();
        const uiState = window.__AgentSellerUI?.getState?.();
        if (uiState?.view === 'feature' && uiState.feature === 'auto_gen_label') {
          refreshProductUI();
          const el = document.getElementById('tal-product-empty');
          if (el) el.textContent = isBarcodeManagementPage() ? '请点击商品行选择' : '请导航到条码管理页';
        }
      });
    },
    render(viewEl) {
      renderAutoGenLabel(viewEl);
    },
  });
})();
