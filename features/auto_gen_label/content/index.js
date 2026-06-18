// auto_gen_label/content/index.js — feature 业务：标签生成（含 Phase 1/2/3）
(function () {
  'use strict';

  const U = window.AgentSeller.utils;
  const sendNative = window.AgentSeller.sendNative;
  const onPageChange = window.AgentSeller.onPageChange;

  // 调试开关：dev 保持 true；package.bat 打包 release 时替换为 false
  const TAL_DEBUG = true;

  // ── feature 内部状态 ──
  const fstate = { products: [] };  // 多SKU：[{ skcNumber(col4), skuId(col5), skcSku(col6), skuSku(col7) }, ...]
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

  // 「生成后自动打开文件夹」开关（feature 面板勾选，localStorage 持久化）
  function shouldOpenFolderAfter() {
    return localStorage.getItem('talOpenFolderAfter') === '1';
  }

  // 勾选时用资源管理器打开标签输出的 SKC 子文件夹。非致命：失败只 warn 不中断主流程。
  // 同 SKC 多 SKU 在同一文件夹，取首个标签的 dirname 即可；多 SKC 仅打开第一个。
  async function maybeOpenOutputFolder(labelPaths) {
    if (!shouldOpenFolderAfter()) return;
    const firstPng = labelPaths?.[0]?.pngPath;
    if (!firstPng) return;
    const folder = firstPng.replace(/[\\/][^\\/]*$/, '');  // 去掉末尾文件名，得 SKC 子文件夹
    try {
      await sendNative('OPEN_FOLDER', { path: folder });
    } catch (e) {
      console.warn('[TAL] 打开输出文件夹失败（非致命）:', e?.message || e);
    }
  }

  function setProducts(products) {
    fstate.products = products || [];
    refreshProductUI();
    if (fstate.products.length > 0) {
      setStatus(`已选 ${fstate.products.length} 个商品，可执行流程`);
    }
  }

  function clearSelection() {
    setProducts([]);
    refreshRowHighlight();
    // 清除选择同时清掉上轮标签文件产物——否则 refreshProductUI 仍从 talLabelPaths 读数量，
    // 清除后 UI 残留「N 个标签已生成」，再次选单 SKU 也会显示上轮多 SKU 的旧数量，
    // 直到下一次生成才覆盖。清除语义 = 回到初始态，故一并清。
    localStorage.removeItem('talLabelPaths');
    localStorage.removeItem('talLabelSkc');
    refreshProductUI();
  }


  function refreshProductUI() {
    const empty = document.getElementById('tal-product-empty');
    const info  = document.getElementById('tal-product-info');
    if (!empty) return;
    if (fstate.products.length === 0) {
      empty.style.display = 'block';
      if (info) info.style.display = 'none';
    } else {
      empty.style.display = 'none';
      if (info) {
        info.style.display = 'block';
        document.getElementById('tal-val-sku').textContent = `${fstate.products.length} 件商品`;
        document.getElementById('tal-val-skc').textContent = fstate.products.map(p => p.skuSku).join(', ');
      }
    }
    // 标签文件行：显示已生成的标签数量
    const labelPaths = JSON.parse(localStorage.getItem('talLabelPaths') || '[]');
    const labelRow = document.getElementById('tal-label-row');
    const labelVal = document.getElementById('tal-val-label');
    if (labelRow && labelVal) {
      if (labelPaths.length > 0) {
        labelVal.textContent = `${labelPaths.length} 个标签已生成`;
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
    const productMissing = fstate.products.length === 0;
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
    // 避免 React 复用/替换 row 节点时 listener 丢失。
    // 约束：一次只能处理同一个 SKC 的多个 SKU（Phase2/3 按 SKC 共享，跨 SKC 没意义）：
    // - 点同一 SKC 的行：toggle 该 SKU（已选取消，未选加入）
    // - 点不同 SKC 的行：清空旧选择，切换到新 SKC（始终保持单一 SKC）
    document.addEventListener('click', e => {
      const row = e.target.closest('tr[data-testid="beast-core-table-body-tr"]');
      if (!row) return;
      if (e.target.closest('a, button')) return;
      const data = extractRowData(row);
      if (!data) { setStatus('未能读取该行数据', 'err'); return; }
      if (!data.skuSku) { setStatus('该商品没有 SKU货号，标签生成需要 SKU货号，请选择其他商品', 'err'); return; }

      const curSkc = fstate.products[0]?.skcNumber;
      if (curSkc && curSkc !== data.skcNumber) {
        // 切换 SKC：清空旧选择，只选中新行（一次只能处理同一 SKC）
        setProducts([data]);
        setStatus(`已切换到 SKC ${data.skcNumber}（一次只能处理同一 SKC，原选择已清除）`, '');
        return;
      }
      // 同一 SKC（或首次选）：按 skuId（行级唯一）toggle 该 SKU 行
      const exists = fstate.products.some(p => p.skuId === data.skuId);
      setProducts(exists
        ? fstate.products.filter(p => p.skuId !== data.skuId)
        : [...fstate.products, data]);
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


  function refreshRowHighlight() {
    // tal-selected 是本 feature 专属 class（tal- 前缀 = Temu Auto Label 命名空间），其他 feature 不应共用
    document.querySelectorAll('tr.tal-selected').forEach(r => r.classList.remove('tal-selected'));
    for (const product of fstate.products) {
      const row = findRowBySku(product.skuId);   // 按 SKU ID 精确定位（多 SKU 同 SKC 多行）
      if (row && !row.classList.contains('tal-selected')) {
        row.classList.add('tal-selected');
      }
    }
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
    // 表格每行 = 一个 SKU。4 个关键列（实测 DOM 确认）：
    //   SKC(SKC ID,数字) / SKU(SKU ID,数字) / SKC货号(SKC 级,同 SKC 各行相同) / SKU货号(SKU 级,各行不同)
    // 用途分工：skuId = 行级唯一区分键（选中/定位行）；skuSku = 文件名+标签序列号；
    //          skcNumber + skcSku = 文件夹 "SKC ID-SKC货号"。
    // 空值占位符 "-" 归一为空。业务拦截（无 SKU货号 不能打标签）在调用方做。
    const si = getColumnIndex('SKC'), ui = getColumnIndex('SKU');
    const kci = getColumnIndex('SKC货号'), kui = getColumnIndex('SKU货号');
    if (si < 0 || ui < 0) return null;
    const tds = row.querySelectorAll('td[data-testid="beast-core-table-td"]');
    const norm = v => { const t = (v || '').trim(); return t === '-' ? '' : t; };
    const skcNumber = tds[si - 1]?.textContent.trim();
    const skuId = tds[ui - 1]?.textContent.trim() || '';
    const skcSku = kci > 0 ? norm(tds[kci - 1]?.textContent) : '';
    const skuSku = kui > 0 ? norm(tds[kui - 1]?.textContent) : '';
    return skcNumber ? { skcNumber, skuId, skcSku, skuSku } : null;
  }

  // 按 SKC ID 找行（返回该 SKC 首行）——仅用于 orch 单 SKU 入口（入参是 skc）
  function findRowBySkc(skc) {
    if (!skc) return null;
    const rows = document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]');
    for (const row of rows) {
      if (extractRowData(row)?.skcNumber === skc) return row;
    }
    return null;
  }

  // 数该 SKC 的 SKU 行数（条码页每行=一个 SKU）——编排护栏用：≥2 则自动链路不处理、转手动
  function countRowsBySkc(skc) {
    if (!skc) return 0;
    let n = 0;
    const rows = document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]');
    for (const row of rows) {
      if (extractRowData(row)?.skcNumber === skc) n++;
    }
    return n;
  }

  // 按 SKU ID 精确找行——多 SKU 场景必须用这个（同 SKC 多行，按 skcNumber 会都命中首行）
  function findRowBySku(skuId) {
    if (!skuId) return null;
    const rows = document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]');
    for (const row of rows) {
      if (extractRowData(row)?.skuId === skuId) return row;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1：标签生成
  // ═══════════════════════════════════════════════════════════════════════════
  async function onRunAllPhases() {
    if (fstate.products.length === 0) return;
    // 防御：选中必须同一 SKC（选择逻辑已保证，这里兜底，理论不触发）
    if (new Set(fstate.products.map(p => p.skcNumber)).size > 1) {
      setStatus('选中商品包含多个 SKC，一次只能处理同一 SKC，请重新选择', 'err');
      return;
    }
    const { templatePath, outputDir } = getPaths();
    if (!templatePath || !outputDir) {
      setStatus('模板路径或输出目录未设置', 'err');
      return;
    }
    const btn = document.getElementById('tal-btn-auto');
    btn.disabled = true;
    try {
      const labelPaths = [];
      const total = fstate.products.length;

      // Phase 1：逐个生成标签（按 SKU ID 精确定位每行，多 SKU 同 SKC 也不会取错行）
      for (let i = 0; i < total; i++) {
        const product = fstate.products[i];
        const row = findRowBySku(product.skuId);
        if (!row) throw new Error(`找不到 SKU ${product.skuSku || product.skuId} 对应的表格行`);

        setStatus(`① 生成标签 (${i + 1}/${total})：正在捕获条码...`, 'loading');
        const { barcodePngB64, skcNumber } = await clickAndCaptureCanvas(row);

        setStatus(`① 生成标签 (${i + 1}/${total})：BarTender处理中...`, 'loading');
        U.ensureExtensionAlive();
        const result = await sendNative('PROCESS_LABEL', {
          skcNumber: skcNumber || product.skcNumber,
          skcSku: product.skcSku,
          skuSku: product.skuSku,
          barcodePngB64,
          templatePath,
          outputDir,
          widthRatio: getWidthRatio(),
        });
        if (!result?.success) throw new Error(result?.error || `标签生成失败: ${product.skuSku}`);

        labelPaths.push({
          skcNumber: product.skcNumber,
          skuId: product.skuId,
          skcSku: product.skcSku,
          skuSku: product.skuSku,
          pngPath: result.output_png,
        });
      }

      // 保存所有标签路径
      localStorage.setItem('talLabelPaths', JSON.stringify(labelPaths));
      localStorage.setItem('talLabelSkc', fstate.products[0].skcNumber || '');
      refreshProductUI();

      setStatus(`① 全部标签生成完成 ✓ (${total} 个)，启动合规填写...`, 'ok');
      await U.sleep(800);

      await maybeOpenOutputFolder(labelPaths);

      // Phase 2：启动第一个商品的合规流程（同 SKC 共享，用任一 SKU 的 skcNumber 即可）
      const first = fstate.products[0];
      setCFlow({
        active: true, step: 1,
        skcNumber: first.skcNumber,
        skcSku: first.skcSku,
        spuId: null,
        continueToPhase3: true,
      });
      // 开新 tab 启动 phase2，保留 phase1（条码管理页）tab 供用户继续操作
      window.open('/govern/compliant-live-photos', '_blank');
    } catch (err) {
      setStatus(`出错: ${err.message}`, 'err');
      btn.disabled = false;
    }
  }

  // 调试：只跑 Phase 1（标签生成），用当前调试栏 ratio，支持多SKU
  async function onRunPhase1Only() {
    if (fstate.products.length === 0) return;
    if (new Set(fstate.products.map(p => p.skcNumber)).size > 1) {
      setStatus('选中商品包含多个 SKC，一次只能处理同一 SKC，请重新选择', 'err');
      return;
    }
    const { templatePath, outputDir } = getPaths();
    if (!templatePath || !outputDir) {
      setStatus('模板路径或输出目录未设置', 'err');
      return;
    }
    const ratio = getWidthRatio();
    const btn = document.getElementById('tal-btn-debug');
    btn.disabled = true;
    try {
      const labelPaths = [];
      const total = fstate.products.length;

      for (let i = 0; i < total; i++) {
        const product = fstate.products[i];
        const row = findRowBySku(product.skuId);
        if (!row) throw new Error(`找不到 SKU ${product.skuSku || product.skuId} 对应的表格行`);

        setStatus(`调试：生成标签 (${i + 1}/${total}, ratio=${ratio})...`, 'loading');
        const { barcodePngB64, skcNumber } = await clickAndCaptureCanvas(row);
        U.ensureExtensionAlive();
        const result = await sendNative('PROCESS_LABEL', {
          skcNumber: skcNumber || product.skcNumber,
          skcSku: product.skcSku,
          skuSku: product.skuSku,
          barcodePngB64,
          templatePath,
          outputDir,
          widthRatio: ratio,
        });
        if (!result?.success) throw new Error(result?.error || `标签生成失败: ${product.skuSku}`);

        labelPaths.push({
          skcNumber: product.skcNumber,
          skuId: product.skuId,
          skcSku: product.skcSku,
          skuSku: product.skuSku,
          pngPath: result.output_png,
        });
      }

      localStorage.setItem('talLabelPaths', JSON.stringify(labelPaths));
      localStorage.setItem('talLabelSkc', fstate.products[0].skcNumber || '');
      refreshProductUI();
      await maybeOpenOutputFolder(labelPaths);
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

    // 轮询等待下拉出现（check-first：直接命中 0ms 而非固定 sleep 200ms 起跳）
    let dropdown = null;
    const dropdownDeadline = Date.now() + 5000;
    while (Date.now() < dropdownDeadline) {
      for (const d of document.querySelectorAll('.rocket-select-dropdown')) {
        const cs = window.getComputedStyle(d);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const items = d.querySelectorAll('.rocket-select-item-option');
        if (items.length > 0) { dropdown = d; break; }
      }
      if (dropdown) break;
      await U.sleep(50);
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
        if (rocketSelectHasValue(container)) return;
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
        if (matchTarget()) return;
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
      if (matchTarget()) return;
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
      if (rocketSelectHasValue(container)) return;
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

  // ── Step 1：实拍图页面 — 用 SKC 查 SPU ───────────────────────────────────
  async function checkAndRunStep1() {
    const flow = getCFlow();
    if (!flow?.active || flow.step !== 1) return;
    try { await runStep1(flow); }
    catch (e) { U.showToast('步骤1失败: ' + e.message, 'err'); aglReportError(aglCatFromMsg(e.message), 'AGL_STEP1_FAILED', e.message); clearCFlow(); }
  }

  // 读当前搜索类型下拉的选中值（SPU / SKC）；供诊断和写后读校验用
  function readSearchType() {
    return document.getElementById('goodsSearchType')?.closest('.rocket-select')
      ?.querySelector('.rocket-select-selection-item')?.textContent.trim();
  }

  // 实拍图页搜索：确保搜索类型切到 SKC，返回就绪的 SKC 输入框。
  // 成功信号 = skcIdStr 输入框就绪（不靠 selection-item 文本，避免"显示 SKC 但输入框未渲染"误判）。
  // 进入页面（尤其新 tab 首屏）时 Rocket Select 可能尚未交互就绪——节点已出现但事件/状态未绑好，
  // 点 trigger 下拉弹不出或选了不生效。每轮：skcIdStr 在就返回，否则非 SKC 就强制选，再短等渲染。
  // ⚠️ typeSelect / readType 必须每轮重新查 live 节点：页面 mallModel 异步初始化会 re-render 整个
  // 搜索表单，旧 .rocket-select 节点被 detach 后，缓存的引用仍读到旧 selection-item（停留在 SKC），
  // 而 document 已是新表单（reset 回 SPU）→ 出现"readType=SKC 但 skcIdStr 永远不存在"的假象，
  // 且 if(readType()!=='SKC') 门控因此跳过重选，5 轮空转后误报。详细 console 日志用于定位执行轨迹。
  async function ensureSkcSearchInput() {
    console.log('[TAL][ensure] 进入 ensureSkcSearchInput');
    await U.waitForEl('input#goodsSearchType', document, 12000);
    // 每次都从 live document 重新取，绝不缓存跨 re-render
    const readType = () => document.getElementById('goodsSearchType')
      ?.closest('.rocket-select')
      ?.querySelector('.rocket-select-selection-item')?.textContent.trim();

    const MAX_TRY = 5;
    for (let i = 1; i <= MAX_TRY; i++) {
      let el = document.getElementById('skcIdStr');
      if (el) { console.log(`[TAL][ensure] 第${i}轮: skcIdStr 已就绪，返回`); return el; }
      const curType = readType();
      console.log(`[TAL][ensure] 第${i}轮: 类型=${curType}, skcIdStr 未现`);
      if (curType !== 'SKC') {
        const typeSelect = rocketSelectById('goodsSearchType');  // 每轮 fresh，避免 detach 节点
        if (!typeSelect) throw new Error('读取失败：未找到搜索类型下拉 (#goodsSearchType)');
        try {
          await rocketSelect(typeSelect, 'SKC');
          console.log(`[TAL][ensure] 第${i}轮: rocketSelect 返回, 类型现在=${readType()}`);
        } catch (e) {
          console.warn(`[TAL][ensure] 第${i}轮: rocketSelect 抛错: ${e.message}`);
        }
      } else {
        console.log(`[TAL][ensure] 第${i}轮: 类型已 SKC，仅等待 skcIdStr 渲染`);
      }
      try {
        el = await U.waitForEl('input#skcIdStr', document, 2500);
        console.log(`[TAL][ensure] 第${i}轮: skcIdStr 就绪，返回`);
        return el;
      } catch {
        console.log(`[TAL][ensure] 第${i}轮: 2.5s 内 skcIdStr 未现，重试`);
      }
    }
    throw new Error(`数据校验：选 SKC 后 skcIdStr 始终未就绪（重试 ${MAX_TRY} 次，最后类型=${readType()}）`);
  }

  // 选 SKC + 填货号 + 写后读校验。页面在选 SKC 后会异步初始化(mallModel)、把搜索表单重置回
  // 默认 SPU 并销毁 skcIdStr——故每轮重新 ensure(选SKC)+填值，回读"类型仍 SKC 且框内值==目标"
  // 才算稳定；被重置就退避重试，给页面异步初始化留时间。
  // 总超时窗口内重试（而非固定次数）：慢网络/慢机器上 mallModel 初始化拖久时，
  // 只要窗口内最终稳定就成功；超时才失败（安全失败：报错中止，不误操作）。
  async function fillSkcAndVerify(skcNumber, timeout = 25000) {
    const want = String(skcNumber);
    const deadline = Date.now() + timeout;
    for (let i = 1; Date.now() < deadline; i++) {
      const input = await ensureSkcSearchInput();
      input.focus();
      U.setInputValue(input, skcNumber);
      await U.sleep(400);
      const type = readSearchType();
      const cur = document.getElementById('skcIdStr');
      const val = cur?.value;
      console.log(`[TAL][step1] 填值第${i}次: 类型=${type}, value=「${val ?? '无框'}」`);
      if (type === 'SKC' && cur && val === want) return;
      console.warn(`[TAL][step1] 第${i}次填值后被重置（类型=${type}），退避后重试`);
      await U.sleep(Math.min(600 + i * 300, 2500));  // 退避递增，单次上限 2.5s
    }
    throw new Error(`数据校验：SKC 搜索框填值在 ${timeout / 1000}s 内反复被页面重置，无法可靠查询`);
  }

  async function runStep1(flow) {
    U.showToast('步骤 1/3：查询 SPU...', 'info');

    // 带重试的查询：每轮 fillSkcAndVerify(确保搜索框值) + 点查询 + 等唯一结果行。
    // 慢刷新 / 请求丢失 / 搜索框被异步重置都在总窗口内自愈；仍坚持"唯一 1 行"防 SKC↔SPU 错配。
    const spuId = await queryAndExtractSpuWithRetry(flow.skcNumber);
    if (!spuId) throw new Error('未找到 SPU（查询结果为空？）');

    U.showToast(`找到 SPU: ${spuId}，跳转继续...`, 'info');
    setCFlow({ ...flow, step: 2, spuId });
    await U.sleep(800);
    window.location.href = '/govern/information-supplementation';
  }

  // 实拍图页查询结果中"含 SPU 的数据行"（搜精确 SKC 应唯一）
  function getSpuResultRows() {
    return Array.from(document.querySelectorAll('tbody tr, .rocket-table-tbody tr, [class*="table-tbody"] tr'))
      .filter(r => /SPU[：:]\s*\d+/.test(r.textContent));
  }

  // 带重试的查询 + 取唯一 SPU：每轮 fillSkcAndVerify + 点查询 + 短窗口等"含 SPU 结果行恰好 1 行"。
  // 页面刷新慢 / 查询请求丢失 / 搜索框被异步重置 → 重新查询，总窗口(默认 45s)内自愈。
  // 始终坚持"唯一 1 行"才取值，不唯一/超时报错——从源头防 SKC↔SPU 错配（绝不抓第一个）。
  async function queryAndExtractSpuWithRetry(skcNumber, totalTimeout = 45000, perAttempt = 12000) {
    const deadline = Date.now() + totalTimeout;
    let attempt = 0, lastRows = [];
    while (Date.now() < deadline) {
      attempt++;
      // 每轮确保搜索框为目标 SKC（fillSkcAndVerify 自带写后读自愈）；短超时避免单轮拖太久
      const fillBudget = Math.min(15000, Math.max(3000, deadline - Date.now()));
      await fillSkcAndVerify(skcNumber, fillBudget);

      const searchBtn = U.findByText('button', '查询');
      if (!searchBtn) throw new Error('未找到查询按钮');
      searchBtn.click();
      console.log(`[TAL][step1] 查询第 ${attempt} 次（剩余 ${Math.round((deadline - Date.now()) / 1000)}s）`);

      // 本轮内轮询等唯一结果行
      const attemptDeadline = Math.min(Date.now() + perAttempt, deadline);
      while (Date.now() < attemptDeadline) {
        const rows = getSpuResultRows();
        lastRows = rows;
        if (rows.length === 1) {
          const m = rows[0].textContent.match(/SPU[：:]\s*(\d+)/);
          if (m) { console.log('[TAL][step1] 唯一结果行 SPU=', m[1]); return m[1]; }
        }
        await U.sleep(300);
      }
      console.log(`[TAL][step1] 第 ${attempt} 次 ${perAttempt / 1000}s 内未出唯一结果行（当前 ${lastRows.length} 行），重新查询`);
    }
    throw new Error(`数据校验：查询 SKC 后 ${totalTimeout / 1000}s 内未刷新出唯一 SPU 结果行（最后 ${lastRows.length} 行），可能页面刷新过慢或该 SKC 查无结果，已中止以防 SKC↔SPU 错配`);
  }

  // ── Step 2：合规信息列表页 — 查询 + 点编辑 ───────────────────────────────
  async function checkAndRunStep2or3() {
    const flow = getCFlow();
    if (!flow?.active) return;
    if (flow.step === 2) {
      try { await runStep2(flow); }
      catch (e) { U.showToast('步骤2失败: ' + e.message, 'err'); aglReportError(aglCatFromMsg(e.message), 'AGL_STEP2_FAILED', e.message); clearCFlow(); clearImgFlow(); }
    } else if (flow.step === 3) {
      try { await runStep3(getCFlow()); }
      catch (e) { U.showToast('步骤3失败: ' + e.message, 'err'); aglReportError(aglCatFromMsg(e.message), 'AGL_STEP3_FAILED', e.message); clearCFlow(); clearImgFlow(); }
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
    // drawer 是 .rocket-drawer-body，footer 是它的兄弟节点（在 .rocket-drawer-wrapper-body 下），
    // 必须 closest 到 .rocket-drawer 整体再向下找 footer
    const confirmBtn = drawer.closest('.rocket-drawer')
      ?.querySelector('.rocket-drawer-footer button.rocket-btn-primary');
    if (!confirmBtn) throw new Error('未找到确认按钮');
    await aglReportPhase('committing');  // 合规提交=首个写数据点；adapter onTick 据此标 committing
    confirmBtn.click();

    const continueToPhase3 = flow.continueToPhase3;

    // 等 drawer 关闭（条件轮询本身吸收 React 处理 click 的延时，无需前置 sleep）
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
      aglReportError('validate', 'AGL_COMPLIANCE_UPLOAD_FAILED', '商品合规信息上传失败，请人工处理');
      clearCFlow();
      U.showToast('②❌ 商品合规信息上传失败，请人工处理', 'err');
      return;
    }

    clearCFlow();
    U.showToast('② 合规填写完成 ✓，启动主图上传...', 'ok');

    const labelPaths = JSON.parse(localStorage.getItem('talLabelPaths') || '[]');
    const skcNumber = flow.skcNumber;
    // 同 SKC 下所有 SKU 的标签：合规/主图槽位按 SKC 共享，Phase 3 把这些标签连续上传到同一组槽位
    const skcLabels = labelPaths.filter(p => p.skcNumber === skcNumber);
    if (skcLabels.length > 0 && skcNumber) {
      await U.sleep(800);
      setImgFlow({
        active: true, skcNumber, skcSku: flow.skcSku, spuId: flow.spuId,
        labelPngPaths: skcLabels.map(p => ({ skcSku: p.skcSku, pngPath: p.pngPath })),
      });
      window.location.href = '/govern/compliant-live-photos';
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

  // ── 页面检测 & 触发 ────────────────────────────────────────────────────────
  async function checkAndRunImgUpload() {
    const flow = getImgFlow();
    if (!flow?.active) return;
    try { await runImgSearch(flow); }
    catch (e) { U.showToast('主图上传失败: ' + e.message, 'err'); aglReportError(aglCatFromMsg(e.message), 'AGL_IMG_FAILED', e.message); clearImgFlow(); }
  }

  // ── 搜索商品并点修改按钮 ─────────────────────────────────────────────────
  async function runImgSearch(flow) {
    U.showToast('主图插入：搜索商品...', 'info');

    if (!flow.spuId) throw new Error('imgFlow 缺少 spuId，无法校验商品身份');

    // 每轮重新选 SKC + 填 skcNumber + 写后读（自愈 mallModel 异步重置），再点查询 + 等目标 SPU 行。
    // ⚠️ 不能复用 ensureQueryMatchesSpu——它重试时回填 #spuId（information-supplementation 页的输入框），
    // 本页(compliant-live-photos)搜索框是 #skcIdStr，#spuId 不存在 → 重试回填被跳过、对着空框连点
    // 查询 → 永远匹配不到。故用与 runStep1 同构的"每轮 fillSkcAndVerify + 查询 + 等行"循环。
    let matchedRow = null;
    const deadline = Date.now() + 30000;
    for (let attempt = 1; !matchedRow && Date.now() < deadline; attempt++) {
      await fillSkcAndVerify(flow.skcNumber);
      const searchBtn = U.findByText('button', '查询');
      if (!searchBtn) throw new Error('未找到查询按钮');
      searchBtn.click();
      await U.sleep(1500);
      matchedRow = await waitForRowBySpu(flow.spuId, 6000);
      if (!matchedRow) console.warn(`[TAL][img] 第 ${attempt} 次查询未匹配 SPU=${flow.spuId}（剩余 ${Math.round((deadline - Date.now()) / 1000)}s）`);
    }
    if (!matchedRow) throw new Error(`数据校验：查询 SKC=${flow.skcNumber} 后 30s 内未匹配目标 SPU=${flow.spuId}（可能页面刷新过慢或该 SKC 查无结果），已中止`);

    // 在匹配行内查找「修改」或「上传」按钮，避免误点其他行
    const actionBtn = Array.from(matchedRow.querySelectorAll('button.rocket-btn-link, a.rocket-btn-link'))
      .find(el => el.textContent.trim() === '修改' || el.textContent.trim() === '上传');
    if (!actionBtn) throw new Error('匹配行内未找到修改/上传按钮');

    // 点击前断言：matchedRow 确实是目标 SPU 行（fail-fast + 可观测；drawer 内 #spuId 再兜底一次）
    const rowSpu = matchedRow.textContent.match(/SPU[：:]\s*(\d+)/)?.[1];
    if (rowSpu !== String(flow.spuId)) {
      throw new Error(`数据校验：待操作商品行 SPU=「${rowSpu || '空'}」与目标=「${flow.spuId}」不符，已中止`);
    }
    console.log(`[TAL] 待操作行确认 SPU=${rowSpu}，点击修改/上传`);

    actionBtn.click();

    // 等待修改 drawer 打开
    await U.sleep(2000);
    await runImgUpload(flow);
  }

  // ── 在 drawer 内上传标签图 ───────────────────────────────────────────────
  async function runImgUpload(flow) {
    U.showToast('主图插入：读取标签文件...', 'info');

    // 必须拿到当前可见的编辑 drawer——未打开则中止，绝不退回列表页全局查找（防错行污染其他商品）
    const drawer = await waitForDrawerOpen(10000);
    if (!drawer) throw new Error('读取失败：标签图编辑抽屉(drawer)未打开，已中止以防误传其他商品');

    // 身份二次确认：drawer 内 SPU ID(div#spuId) 必须 == 目标 SPU。
    // 在 drawer 内查（不用 document，避免撞列表页的 input#spuId）。
    // 兜住 findRowBySpu 未处理 rowspan / 点错行 / 意外打开错误商品 drawer 等任何情况。
    if (flow.spuId) {
      try { await U.waitForEl('#spuId', drawer, 5000); } catch { /* 未渲染则下方按不符中止 */ }
      const drawerSpu = drawer.querySelector('#spuId')?.textContent.trim();
      if (drawerSpu !== String(flow.spuId)) {
        throw new Error(`数据校验：编辑抽屉内 SPU=「${drawerSpu || '空'}」与目标 SPU=「${flow.spuId}」不符，已中止上传以防传错商品`);
      }
      console.log(`[TAL] drawer 身份确认 OK：SPU=${drawerSpu}`);
    }
    await U.sleep(600);

    // 多 SKU：读取该 SKC 下所有标签文件，连续上传到同一组槽位（合规/主图按 SKC 共享）。
    // 兼容旧 imgFlow（残留的单数 labelPngPath 字段）。
    const labelItems = (Array.isArray(flow.labelPngPaths) && flow.labelPngPaths.length)
      ? flow.labelPngPaths
      : (flow.labelPngPath ? [{ skcSku: flow.skcSku, pngPath: flow.labelPngPath }] : []);
    if (!labelItems.length) throw new Error('读取失败：imgFlow 缺少标签文件路径，已中止');

    const files = [];
    for (let i = 0; i < labelItems.length; i++) {
      const item = labelItems[i];
      U.showToast(`主图插入：读取标签 (${i + 1}/${labelItems.length})...`, 'info');
      // 通过 Native Host 分块读取标签图（避免单消息超过 Chrome Native Messaging 1MB 上限）
      const bytes = await readFileChunked(item.pngPath);
      const filename = item.pngPath.split(/[\\/]/).pop() || `label-${i + 1}.png`;
      files.push({ bytes, filename });
    }

    U.showToast('主图插入：定位标签图槽位...', 'info');
    const uploaded = await uploadToLabelSlots(drawer, files);
    if (!uploaded) throw new Error('数据校验：当前编辑抽屉内未找到标签图上传位置');

    // 等待上传组件处理文件
    await U.sleep(1500);

    const submitBtn = U.findByText('button', '上传并识别');
    console.log('[TAL] 上传并识别按钮:', submitBtn ? '已找到，准备点击' : '未找到');
    if (!submitBtn) throw new Error('未找到「上传并识别」按钮');
    submitBtn.click();
    console.log('[TAL] 上传并识别已点击');

    await U.sleep(1000);
    await aglReportDone({ spuId: flow.spuId || null, labelCount: files.length });
    clearImgFlow();
    U.showToast(`③ 主图上传完成 ✓（${files.length} 个标签）`, 'ok');
  }

  // 找「标签图」上传槽位，把所有 SKU 标签注入。
  // ⚠️ 实测确认：drawer 内有【多个独立】标签图槽位（商品主体实拍图区 / 外包装实拍图区 …），
  //    每个区域各一个标签图上传位，都要传同一批 SKU 标签。input 带 multiple（一次多文件）。
  //    曾只取第一个空白槽位 → 只填了商品主体、漏了外包装，故改为遍历所有目标槽位。
  async function uploadToLabelSlots(drawer, files) {
    // 严格限定在当前编辑 drawer 内查找，绝不用 document 全局（否则会命中列表页其他商品行的槽位 → 错行上传）
    const allBtns = Array.from(drawer.querySelectorAll('.rocket-upload[role="button"]'));
    const labelBtns = allBtns.filter(btn =>
      Array.from(btn.querySelectorAll('span'))
        .some(s => s.childElementCount === 0 && s.textContent.trim() === '标签图')
    );
    console.log('[TAL] (drawer 内) 标签图 upload 槽位数量:', labelBtns.length);
    if (!labelBtns.length) return false;

    // 优先所有空白槽位（计数器 (0/N)）；若全部已有图则向全部槽位注入（兜底）
    const emptyBtns = labelBtns.filter(btn => {
      const m = btn.textContent.match(/\((\d+)\/\d+\)/);
      return !m || parseInt(m[1]) === 0;
    });
    const targets = emptyBtns.length > 0 ? emptyBtns : labelBtns;
    console.log(`[TAL] 目标标签图槽位 ${targets.length} 个（空白 ${emptyBtns.length} / 共 ${labelBtns.length}），每个各注入 ${files.length} 个文件`);

    let injected = 0;
    for (const btn of targets) {
      const fileInput = btn.querySelector('input[type="file"]');
      if (!fileInput) continue;
      await injectFilesToInput(fileInput, files);
      await U.sleep(300);   // 让上传组件处理本槽位文件，再注入下一个
      // 写后读校验（项目铁律）：每个槽位都确认 N 个文件进了 input，少传/拒绝立即暴露
      if (fileInput.files.length !== files.length) {
        throw new Error(`数据校验：第 ${injected + 1} 个标签图槽位注入后文件数不符，期望 ${files.length} 实际 ${fileInput.files.length}`);
      }
      injected++;
    }
    console.log(`[TAL] 已向 ${injected} 个标签图槽位各注入 ${files.length} 个标签`);
    return injected > 0;
  }

  function mimeFromName(filename) {
    const ext = (filename || '').toLowerCase().split('.').pop();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    return 'image/png';
  }

  // 将多个文件一次性注入 input[type=file]（multiple）并触发一次 change，等价用户多选上传。
  // files: [{ bytes, filename }, ...]；单文件时数组长度为 1，行为与旧单文件注入一致。
  async function injectFilesToInput(fileInput, files) {
    const dt = new DataTransfer();
    for (const { bytes, filename } of files) {
      const mime = mimeFromName(filename);
      const blob = new Blob([bytes], { type: mime });
      dt.items.add(new File([blob], filename, { type: mime, lastModified: Date.now() }));
    }
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
        <label class="tal-opt-row" for="tal-opt-openfolder" style="display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;font-size:12px;">
          <input type="checkbox" id="tal-opt-openfolder">
          <span>生成后自动打开文件夹</span>
        </label>
      </div>
      <div class="tal-card">
        <div class="tal-card-title">当前商品</div>
        <div class="tal-product-empty" id="tal-product-empty">
          ${isBarcodeManagementPage() ? '点击商品行选择（同一 SKC 的多个 SKU 可连续点选多行，一起生成）' : '请导航到条码管理页'}
        </div>
        <div id="tal-product-info" style="display:none">
          <div class="tal-kv"><span class="tal-k">已选</span><span id="tal-val-sku" class="tal-v"></span></div>
          <div class="tal-kv"><span class="tal-k">SKU货号</span><span id="tal-val-skc" class="tal-v"></span></div>
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
    const openFolderChk = document.getElementById('tal-opt-openfolder');
    if (openFolderChk) {
      openFolderChk.checked = shouldOpenFolderAfter();
      openFolderChk.addEventListener('change', e => {
        localStorage.setItem('talOpenFolderAfter', e.target.checked ? '1' : '0');
      });
    }
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
  // 编排器桥接（orch）：content 跨页自驱、SW adapter 无法 await。
  // 命令入口 fire-forget 启动 Phase1+自驱；三收尾点写 chrome.storage.local['agl_state']；adapter 轮询。
  // gating：talOrch=1 才写（手动点 button 不污染 agl_state）。
  // ═══════════════════════════════════════════════════════════════════════════
  function aglIsOrch() {
    try { return localStorage.getItem('talOrch') === '1'; } catch { return false; }
  }
  function aglClearOrch() {
    try { localStorage.removeItem('talOrch'); } catch (e) { console.warn('[TAL][orch] 清 talOrch 失败', e); }
  }
  // 错误分层：content 既有 throw 用「数据校验:」前缀标 validate，其余按 read（DOM 没找到/超时）。
  function aglCatFromMsg(msg) {
    return /数据校验/.test(String(msg || '')) ? 'validate' : 'read';
  }
  async function aglWriteState(obj) {
    try { await chrome.storage.local.set({ agl_state: { ...obj, updatedAt: Date.now() } }); }
    catch (e) { console.warn('[TAL][orch] 写 agl_state 失败', e); }
  }
  async function aglReportDone(result) {
    if (!aglIsOrch()) return;
    await aglWriteState({ status: 'done', phase: 'done', result: result || {} });
    aglClearOrch();
  }
  async function aglReportError(category, code, message) {
    if (!aglIsOrch()) return;
    await aglWriteState({ status: 'error', phase: 'error', category, code, message: String(message || '') });
    aglClearOrch();
  }
  async function aglReportPhase(phase) {
    if (!aglIsOrch()) return;
    await aglWriteState({ status: 'running', phase });
  }

  // 命令入口：编排器发 AGL_GEN_LABEL 触发。无人选行 → data.skc 反查；路径缺 → 不启动报 reason。
  // fire-forget：立即 ack started；Phase1 后台 IIFE 在条码页跑，done 后 location.href 跳 Phase2，
  // 之后 content 自驱（onPageChange → checkAndRunStep1...），三收尾点写 agl_state。
  async function aglHandleGenLabel(data) {
    const { templatePath, outputDir } = getPaths();
    if (!templatePath || !outputDir) return { ok: true, started: false, reason: 'NO_PATHS' };
    const skc = data && data.skc;
    if (!skc) return { ok: true, started: false, reason: 'NO_SKC' };
    // 护栏：该 SKC 含多个 SKU 变体 → 自动链路暂只支持单 SKU（findRowBySkc 取首行会静默只做首个）
    // → fail-fast 报错转手动 feature（手动模式手选同 SKC 多行可全做）。见 project_multisku_boundary。
    const skuCount = countRowsBySkc(skc);
    if (skuCount > 1) return { ok: true, started: false, reason: 'MULTI_SKU', skuCount };
    const row = findRowBySkc(skc);
    if (!row) return { ok: true, started: false, reason: 'ROW_NOT_FOUND' };
    const rowData = extractRowData(row);
    if (!rowData || !rowData.skuSku) return { ok: true, started: false, reason: 'NO_SKU_SKU' };

    // 清旧自驱状态 + 置 orch gating + 初态
    clearCFlow();
    clearImgFlow();
    try { localStorage.setItem('talOrch', '1'); } catch (e) { console.warn('[TAL][orch] 置 talOrch 失败', e); }
    await aglWriteState({ status: 'running', phase: 'phase1' });

    // fire-forget：Phase1 在条码页同 tab 跑，成功后 location.href 跳转启动 Phase2/3 自驱
    (async () => {
      try {
        const { barcodePngB64, skcNumber } = await clickAndCaptureCanvas(row);
        U.ensureExtensionAlive();
        const result = await sendNative('PROCESS_LABEL', {
          skcNumber: skcNumber || rowData.skcNumber,
          skcSku: rowData.skcSku,
          skuSku: rowData.skuSku,
          barcodePngB64, templatePath, outputDir, widthRatio: getWidthRatio(),
        });
        if (!result?.success) throw new Error(result?.error || '标签生成失败');
        if (result.output_png) {
          // 编排器单 SKU 处理：写当前前先清掉同 SKC 旧条目，避免上一轮残留 SKU 标签
          // 被 Phase3（按 skcNumber filter）当本轮一起上传陈旧文件。
          const labelPaths = JSON.parse(localStorage.getItem('talLabelPaths') || '[]')
            .filter(p => p.skcNumber !== rowData.skcNumber);
          labelPaths.push({ skcNumber: rowData.skcNumber, skuId: rowData.skuId, skcSku: rowData.skcSku, skuSku: rowData.skuSku, pngPath: result.output_png });
          localStorage.setItem('talLabelPaths', JSON.stringify(labelPaths));
          localStorage.setItem('talLabelSkc', rowData.skcNumber || '');
        }
        setCFlow({
          active: true, step: 1,
          skcNumber: rowData.skcNumber, skcSku: rowData.skcSku,
          spuId: null, continueToPhase3: true,
        });
        // 编排无用户手势：location.href 同 tab 跳（非 window.open，避免弹窗拦截）
        window.location.href = '/govern/compliant-live-photos';
      } catch (err) {
        await aglReportError(aglCatFromMsg(err?.message), 'AGL_PHASE1_FAILED', err?.message || err);
      }
    })();

    return { ok: true, started: true };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'AGL_GEN_LABEL') return;
    aglHandleGenLabel(msg.data || {})
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: true, started: false, reason: 'HANDLER_THREW', error: String((e && e.message) || e) }));
    return true;  // 异步 sendResponse
  });

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
          if (el) el.textContent = isBarcodeManagementPage() ? '点击商品行选择（同一 SKC 的多个 SKU 可连续点选多行，一起生成）' : '请导航到条码管理页';
        }
      });
    },
    render(viewEl) {
      renderAutoGenLabel(viewEl);
    },
  });
})();
