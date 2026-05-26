// create_purchase_order —— 创建采购单 Phase 1
// 跑在 temu/1688/店小秘 三域：注册 feature + 输入 UI + 进度面板 + bg 命令处理器。
(function () {
  'use strict';

  const L = window.__CPOLogic;                 // Task 1 的纯逻辑（document_start 已挂）
  const U = window.AgentSeller.utils;          // sleep/waitForEl/findByText/setInputValue
  const FID = 'create_purchase_order';

  // ── 进度面板状态（只在起点 temu tab 有意义，其它域不渲染进度） ──
  let progressEl = null;
  function setProgress(text, kind = 'info') {
    if (!progressEl) return;
    progressEl.textContent = text;
    progressEl.style.color = kind === 'error' ? '#ff4d4f' : kind === 'done' ? '#52c41a' : '#666';
  }

  // ── feature 注册 + Hub 输入 UI ──
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
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

      const skcInput = document.createElement('input');
      skcInput.placeholder = 'SKC编码';
      skcInput.className = 'tal-input';
      skcInput.style.cssText = 'padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;';

      const urlInput = document.createElement('input');
      urlInput.placeholder = '1688商品url';
      urlInput.className = 'tal-input';
      urlInput.style.cssText = skcInput.style.cssText;

      const btn = document.createElement('button');
      btn.className = 'tal-action-btn';
      btn.textContent = '开始';

      progressEl = document.createElement('div');
      progressEl.style.cssText = 'font-size:12px;color:#666;line-height:1.5;min-height:18px;';

      btn.addEventListener('click', async () => {
        const skc = skcInput.value.trim();
        const url1688 = urlInput.value.trim();
        const v = L.validateInputs({ skc, url1688 });   // 本地先校验，避免无谓启动
        if (!v.ok) { setProgress(v.error, 'error'); return; }
        btn.disabled = true;
        setProgress('启动中…');
        try {
          const resp = await chrome.runtime.sendMessage({ type: 'CPO_START', data: { skc, url1688 } });
          if (!resp?.ok) { setProgress(resp?.error || '启动失败', 'error'); btn.disabled = false; }
        } catch (e) {
          setProgress('启动失败：' + e.message, 'error');
          btn.disabled = false;
        }
      });

      wrap.append(skcInput, urlInput, btn, progressEl);
      viewEl.appendChild(wrap);
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
    choose.click();
    try { await U.waitForEl('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item, .ant-dropdown-menu-item', document, 4000); } catch {}
    const net = U.findByText('.ant-dropdown-menu-item, .ant-dropdown-menu-title-content', '网络图片');
    if (!net) return { ok: false, error: '未找到「网络图片」菜单项' };
    net.click();
    let input;
    try { input = await U.waitForEl('.ant-modal-content input, .ant-modal input', document, 5000); }
    catch { return { ok: false, error: '网络图片弹窗未出现' }; }
    U.setInputValue(input, url);
    await U.sleep(150);
    const okBtn = U.findByText('.ant-modal-footer .ant-btn-primary, .ant-modal-footer button', '确定')
               || document.querySelector('.ant-modal-footer .ant-btn-primary');
    if (!okBtn) return { ok: false, error: '网络图片弹窗未找到「确定」' };
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
    const selects = Array.from(card.querySelectorAll('.ant-select'));
    let filled = 0;
    for (const sel of selects) {
      (sel.querySelector('.ant-select-selector') || sel).click();
      await U.sleep(250);
      const opt = U.findByText('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', userName)
               || U.findByText('.ant-select-item-option', userName);
      if (opt) { opt.click(); filled++; }
      await U.sleep(150);
    }
    return { filled, total: selects.length };
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

    // 用户已手动查询好该 SKC，列表已显示结果；定位行 + 读 SKU货号 + SPU ID
    //（SPU ID = 编辑页 productId；bg 据此直接构造编辑页 URL，避开「编辑」链接的弹窗拦截）
    CPO_READ_SKU_NO: async ({ skc }) => {
      const row = await cpoFindSkcRow(skc);
      if (!row) return { ok: false, error: `未找到 SKC 对应商品行（${skc}），请先在列表查询该 SKC` };
      return { ok: true, skuNo: cpoReadSkuNoFromRow(row), spuId: cpoReadSpuIdFromRow(row) };
    },

    CPO_GRAB_PREVIEW: async () => {
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

      // 人员信息：卡内所有下拉选 user-name（卡找不到则跳过，交用户保存前手动补）
      const person = await cpoFillPersonnel();

      return { ok: true, filled: true, person };
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // 进度推送（起点 tab 接收，无需回 response）
    if (msg.type === 'CPO_PROGRESS') { setProgress(`步骤${msg.step}：${msg.label}`); return; }
    if (msg.type === 'CPO_DONE')     { setProgress('已填好，请在店小秘页核对后保存', 'done'); return; }
    if (msg.type === 'CPO_ERROR')    { setProgress(`步骤${msg.step}失败：${msg.message}`, 'error'); return; }

    const h = handlers[msg.type];
    if (!h) return;                                  // 非本 feature 命令，放行
    h(msg.data).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;                                     // 异步通道
  });
})();
