// check_and_publish/content/index.js
// 店小秘 dianxiaomi.com 商品编辑页：合规检查 + 模拟发布（规则选择器全按店小秘 DOM 建，samples 为证）
// 流程：用户点「检查并发布」→ 跑所有 RULES → block 阻断 / 全过则二次确认 → 点「发布」下拉中的「立即发布」
;(function () {
  'use strict';

  const U = window.AgentSeller.utils;
  const showToast = window.AgentSeller.showToast;
  const TITLE_MAX = 250;

  // ─── 词库 ────────────────────────────────────────────────────────────
  // 来自 samples/标题.docx（与 产品描述.docx 同源），标题/描述共用违禁词
  const BASE_FORBIDDEN = [
    'babys','baby',"children's",'children','childcare','child','kids','kid',
    'newborns','newborn','toddler','school','toys','toy','cartoon','comics',
    'animation','anime','deworming','mosquito repellent','mosquito',
    'insect repellent','fireprotection','chemically protected','velcro',
    'drugs','drug','sexy','sex','fuck','bitch','nipple','diamond','gold',
    'kill','murder','cereal','cotton','dri-fit','thermos','bpa','coke','sprite',
    'eco-friendly','environmental friendly','environmentally friendly',
    'environment protection','environmental protection',
    'energy-saving','energy saving','energy conservation',
    'reduce emissions','reduced emissions','emission reduction',
    'carbon neutral','carbon neutrality','carbon neutralization',
    '100% natural','100%natural','hot sale','anxiety relief','anti-anxiety',
    'stress relief','therapeutic','aromatherapy','against bacteria',
    'antibacterial','prevent bacteria','disease prevent','dust mite proof',
    'anti mite','handmade','shein','facebook','ins','professional use',
    'xinjiang','hotan',
  ];

  // 营销夸大词（来自 WebSearch 综合，warn 级）
  const MARKETING_FORBIDDEN = [
    '免费','秒杀','包邮','限时','限购','抢购','赠品','清仓','打折','超值','特价','疯抢','爆款',
    'sale','discount','clearance','bogo','buy one get one','flash sale','limited time','best price',
  ];

  // 产品分类违禁词（来源：samples/类目.docx）
  // 命中即阻断：选择敏感品类（母婴/儿童/电子/医疗/成人/化妆品/电池/含电产品等）会被 Temu 拒收
  // "手机、智能手机" 在原表里是一项，拆为两个独立词避免 includes 永不命中
  const CATEGORY_FORBIDDEN = [
    '母婴','婴儿','幼儿','男婴','女婴','婴幼儿','新生儿','托儿','儿童','幼童','女童','男童','宝宝','育婴','育儿',
    '童车','奶嘴','温奶器','吸奶器','母乳','孕','哺乳','玩具与游戏','图书','早教','各色美食',
    '充电','电池','电线','电热','电暖','电石','电动','电压','电容','电路','电炸','天线','线缆',
    'SD','USB','GPS','PDA','POS','Wi-Fi','蓝牙','音箱',
    '电容笔','触控笔','手写笔','激光笔','录音笔','数据线','投影仪','扫描仪','显示器','监视器','监控器',
    '摄像机','摄像头','录像机','扬声器','追踪器','适配器','遥控器','演示器','播放器','收发器','传感器',
    '无人机','复印机','传真机','寻呼机','对讲机','交换机','打字机','碎纸机','翻译机','电视机','录音机','麦克风',
    '智能手表','手机','智能手机','电子词典','电子白板','电炖锅','电煎锅','电炖盅','电饭煲',
    '灯','照明','光源','风扇','病','医疗','急救','专业','营养素','成人用品','情趣',
    '皮肤护理','手足护理','唇部护理','眼睛护理','香体剂和止汗剂','穿洞和纹身用品','彩妆','美甲胶水',
    '膏','霜','粉','香水','精华','精油','乳液','保湿','香皂','喷雾','洗发水','护发素','染发剂','显色剂','止汗剂','沐浴露','卸妆液',
    '油漆笔','马克笔','燃油输送与润滑产品','罐装蜡烛',
    '耳饰','耳环','耳钉','女装领带','项链','手链',
  ];

  // 中文标点 — 店小秘官方明确：会导致发布失败（block 级）
  // 不含 Unicode 弯引号 "" ''（U+201C/201D/2018/2019）：视觉近似英文直引号，
  // 来源是 smart quotes 自动转换而非中文输入法；如实测 Temu 也拒收再单独加规则
  const CN_PUNCT_RE = /[，。！？；：、《》（）【】「」『』〈〉〔〕｛｝·～—…￥]/g;
  // 汉字 — 标题建议全英文（warn 级）
  const CJK_RE = /[一-龥]/g;

  // 多件装关键词（多变种时标题应含此类信息）
  // 'pcs' 不要求前边界 — 允许 "50pcs"（\b 在数字 \w 与字母 \w 之间不存在，会误判）
  // 其他词保留 \b — 避免 'set' 误匹配 'asset'、'kit' 误匹配 'kitchen'
  const MULTIPACK_INDICATORS = /pcs\b|\b(packs?|sets?|kits?|pieces?|bundle|count|pairs?)\b/i;

  // 图片尺寸约束（店小秘官方）
  const IMG_MIN_SIZE = 800;
  const VARIATION_MAX = 20;

  // ─── DOM 取值层 ──────────────────────────────────────────────────────
  // 每个 getter 返回 { value, el, source }：value=null 表示字段未识别，规则会 skipped
  function isEditPage() {
    return location.href.includes('edit');
  }

  // 必填表单项识别（13 处 .ant-form-item-required 标记，归约为 9 个独立 form-item）
  function findRequiredFormItems() {
    const items = new Set();
    for (const star of document.querySelectorAll('.ant-form-item-required')) {
      const item = star.closest('.ant-form-item, .ant-row');
      if (item) items.add(item);
    }
    return [...items];
  }

  function getRequiredItemLabel(item) {
    const lbl = item.querySelector('label, .ant-form-item-label');
    return lbl ? lbl.textContent.replace(/[*：:\s]+$/, '').trim() : '';
  }

  // 返回 true=空 / false=已填 / null=无法判断（未知控件）
  function isRequiredItemEmpty(item) {
    // 1) Upload（产品图）— 看是否有已上传 list item
    if (item.querySelector('.ant-upload, [class*="upload"]')) {
      const uploaded = item.querySelectorAll('.ant-upload-list-item, .ant-upload-list-picture-card-container, [class*="upload-list-item"]');
      return uploaded.length === 0;
    }
    // 2) Ant Select — 看 selection-item 是否有文本
    const select = item.querySelector('.ant-select');
    if (select) {
      const sel = select.querySelector('.ant-select-selection-item');
      const text = sel ? (sel.getAttribute('title') || sel.textContent || '').trim() : '';
      return !text;
    }
    // 3) Radio Group
    const radios = item.querySelectorAll('input[type="radio"]');
    if (radios.length) return ![...radios].some(r => r.checked);
    // 4) Checkbox Group
    const cbs = item.querySelectorAll('input[type="checkbox"]');
    if (cbs.length) return ![...cbs].some(c => c.checked);
    // 5) input / textarea
    const input = item.querySelector('input:not([type="hidden"]), textarea');
    if (input) return !(input.value || '').trim();
    return null;
  }

  // 变种表必填列检测（VxeTable 用 <th><span class="required"> 标必填列，
  // 跟主表的 .ant-form-item-required 是两套机制 — 主表是按字段，这里是按列）
  function isCellFilled(cell) {
    const inputs = [...cell.querySelectorAll('input:not([type="hidden"]), textarea')];
    if (inputs.length && inputs.some(el => (el.value || '').trim() !== '')) return true;
    const sel = cell.querySelector('.ant-select-selection-item');
    if (sel && (sel.getAttribute('title') || sel.textContent || '').trim()) return true;
    if (cell.querySelector('.ant-upload-list-item')) return true;
    const img = cell.querySelector('img[src]');
    if (img && img.getAttribute('src')) return true;
    if (inputs.length || cell.querySelector('.ant-select, .ant-upload')) return false;
    return null; // 未知类型
  }

  function findVariationTableRequiredEmpties() {
    const empties = [];
    for (const star of document.querySelectorAll('th span.required')) {
      const th = star.closest('th');
      if (!th) continue;
      const colIndex = th.cellIndex;
      const table = th.closest('table');
      if (!table || colIndex < 0) continue;
      const label = star.textContent.trim();
      const dataRows = [...table.querySelectorAll('tr')].filter(tr =>
        !tr.closest('thead') && tr.cells && tr.cells.length > colIndex
      );
      for (let i = 0; i < dataRows.length; i++) {
        const cell = dataRows[i].cells[colIndex];
        if (!cell) continue;
        if (isCellFilled(cell) === false) {
          empties.push(`变种#${i + 1} · ${label}`);
        }
      }
    }
    return empties;
  }

  function getTitleField() {
    const el = document.querySelector('input.ant-input-sm[maxlength="250"]')
      || document.querySelector('input[maxlength="250"]');
    return el
      ? { value: el.value || '', el, source: 'maxlength=250' }
      : { value: null, el: null, source: null };
  }

  function getDescriptionField() {
    // 1) 富文本可编辑区
    const editable = document.querySelector('[contenteditable="true"]');
    if (editable && (editable.innerText || '').trim()) {
      return { value: editable.innerText, el: editable, source: 'contenteditable' };
    }
    // 2) 隐藏 input / textarea
    const hidden = document.querySelector('input[name="description"], textarea[name="description"]');
    if (hidden) {
      return { value: hidden.value || '', el: hidden, source: 'name=description' };
    }
    // 3) 「编辑描述」按钮附近的预览区
    const editBtn = U.findByText('button, span, a', '编辑描述');
    if (editBtn) {
      const item = editBtn.closest('.ant-form-item, [class*="form-item"]');
      const preview = item?.querySelector('[class*="preview"], [class*="content"], .description-text');
      if (preview) {
        return { value: preview.innerText || '', el: preview, source: '编辑描述-preview' };
      }
    }
    // 4) fallback：取第一个 contenteditable（即使为空）
    if (editable) return { value: '', el: editable, source: 'contenteditable(empty)' };
    return { value: null, el: null, source: null };
  }

  // 取变种表的 variationSku 输入框值数组；此字段即规范定义的「SKU货号」（含属性的变体完整货号）。
  function getVariationSkuField() {
    const els = [...document.querySelectorAll('input[name="variationSku"]')];
    return {
      value: els.map(el => el.value || ''),
      el: els[0] || null,
      source: els.length ? `${els.length} 个 variationSku input` : null,
    };
  }

  function getVariationCountField() {
    const skuCount = document.querySelectorAll('input[name="variationSku"]').length;
    return {
      value: skuCount || null,
      el: null,
      source: skuCount ? `variationSku input × ${skuCount}` : null,
    };
  }

  function findFormItemByLabelText(labelText) {
    for (const item of findRequiredFormItems()) {
      if (item.textContent.includes(labelText)) return item;
    }
    // 退化：在所有 form-item 里找
    for (const item of document.querySelectorAll('.ant-form-item, .ant-row')) {
      const lbl = item.querySelector('label, .ant-form-item-label');
      if (lbl && lbl.textContent.includes(labelText)) return item;
    }
    return null;
  }

  function getCarouselImagesField() {
    const item = findFormItemByLabelText('产品轮播图');
    if (!item) return { value: [], el: null, source: null };
    const imgs = [...item.querySelectorAll('img')].filter(img => img.naturalWidth > 0);
    return { value: imgs, el: item, source: `产品轮播图 × ${imgs.length}` };
  }

  // 产品分类全路径取值：店小秘选完后会把"办公用品 > ... > 末级"渲染到 .category-list 里。
  // ant-select 控件本身只显示末级文本（不含上层），不足以匹配 CATEGORY_FORBIDDEN 里的高层关键词
  function getCategoryField() {
    const list = document.querySelector('.category-list');
    if (list) {
      const text = list.textContent.replace(/\s+/g, ' ').trim();
      if (text) return { value: text, el: list, source: '.category-list' };
    }
    // fallback：仅末级（兼容店小秘未来改 DOM 的情况，至少能匹配末级关键词）
    const label = document.querySelector('label[title="产品分类"]');
    if (!label) return { value: null, el: null, source: null };
    const item = label.closest('.ant-form-item, .ant-row');
    if (!item) return { value: null, el: null, source: null };
    const text = item.textContent.replace(label.textContent, '').replace(/\s+/g, ' ').trim();
    return { value: text, el: item, source: 'label[title="产品分类"] form-item (仅末级)' };
  }

  function findPublishButton() {
    const btns = document.querySelectorAll('button.btn-green');
    for (const b of btns) {
      if (b.textContent.includes('发布')) return b;
    }
    return null;
  }

  function fireMouseSeq(el, types) {
    for (const type of types) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  async function clickPublishImmediate() {
    const btn = findPublishButton();
    if (!btn) throw new Error('找不到「发布」按钮');
    // 完整事件序列：覆盖 hover / click 两种 trigger 模式
    fireMouseSeq(btn, ['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click']);

    // 等可见的「立即发布」菜单项出现
    // dropdown 容器 portal 到 body 末尾，页面可能有 N 个 dropdown，取 display 非 none 的
    const start = Date.now();
    let item = null;
    while (Date.now() - start < 3000) {
      const candidates = document.querySelectorAll('.ant-dropdown-menu-item[title="立即发布"]');
      for (const c of candidates) {
        const dropdown = c.closest('.ant-dropdown');
        if (dropdown && getComputedStyle(dropdown).display !== 'none') {
          item = c;
          break;
        }
      }
      if (item) break;
      await U.sleep(100);
    }
    if (!item) throw new Error('下拉未展开或找不到「立即发布」菜单项');
    fireMouseSeq(item, ['mousedown', 'mouseup', 'click']);
  }

  // ─── 匹配辅助 ────────────────────────────────────────────────────────
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function matchWords(text, words) {
    if (!text || !words?.length) return [];
    const lower = text.toLowerCase();
    return words.filter(w => {
      const wl = w.toLowerCase();
      // 短英文词（≤4 字符）加单词边界，避免「ins」误伤 instructions
      if (wl.length <= 4 && /^[a-z]+$/.test(wl)) {
        return new RegExp(`\\b${escapeRegex(wl)}\\b`).test(lower);
      }
      return lower.includes(wl);
    });
  }

  // ─── 规则注册表 ──────────────────────────────────────────────────────
  // 新增检查类型只需在 RULES 里追加一条。每条 rule 实现：
  //   { id, name, field, severity: 'block' | 'warn',
  //     check(ctx) → { pass, reason?, hits?, skipped?, info? } }
  // pass=false 时：severity='block' → 阻断发布；severity='warn' → 仅提示
  // skipped=true 表示字段未识别，规则未跑（UI 单独归类）
  const RULES = [
    {
      id: 'title_length',
      name: '标题长度',
      field: 'title',
      severity: 'block',
      check(ctx) {
        const t = ctx.fields.title?.value;
        if (t == null) return { pass: true, skipped: true, reason: '未识别到标题字段' };
        if (t.length > TITLE_MAX) {
          return { pass: false, reason: `当前 ${t.length} 字符，超过限制 ${TITLE_MAX}` };
        }
        return { pass: true };
      },
    },
    {
      id: 'title_forbidden',
      name: '标题违禁词',
      field: 'title',
      severity: 'block',
      check(ctx) {
        const t = ctx.fields.title?.value;
        if (t == null) return { pass: true, skipped: true, reason: '未识别到标题字段' };
        const hits = matchWords(t, BASE_FORBIDDEN);
        if (hits.length) return { pass: false, reason: '标题命中违禁词', hits };
        return { pass: true };
      },
    },
    {
      id: 'description_forbidden',
      name: '描述违禁词',
      field: 'description',
      severity: 'block',
      check(ctx) {
        const d = ctx.fields.description?.value;
        if (d == null) return { pass: true, skipped: true, reason: '未识别到描述字段' };
        const hits = matchWords(d, BASE_FORBIDDEN);
        if (hits.length) return { pass: false, reason: '描述命中违禁词', hits };
        return { pass: true };
      },
    },
    {
      id: 'category_forbidden',
      name: '产品分类违禁词',
      field: 'category',
      severity: 'block',
      check(ctx) {
        const c = ctx.fields.category?.value;
        if (c == null) return { pass: true, skipped: true, reason: '未识别到产品分类字段' };
        if (!c) return { pass: true, skipped: true, reason: '产品分类未选择' };
        const hits = matchWords(c, CATEGORY_FORBIDDEN);
        if (hits.length) return { pass: false, reason: '产品分类命中违禁词（敏感品类，Temu 会拒收）', hits };
        return { pass: true };
      },
    },
    {
      id: 'required_fields_empty',
      name: '必填字段空值',
      field: 'required',
      severity: 'block',
      check(ctx) {
        const items = findRequiredFormItems();
        const empties = [];
        let unknown = 0;
        for (const it of items) {
          const e = isRequiredItemEmpty(it);
          if (e === true) empties.push(getRequiredItemLabel(it) || '未命名字段');
          else if (e === null) unknown++;
        }
        // 合并变种表必填列（VxeTable 的 <span class="required"> 标记）
        empties.push(...findVariationTableRequiredEmpties());
        if (!items.length && !empties.length) {
          return { pass: true, skipped: true, reason: '未识别到必填字段' };
        }
        if (empties.length) {
          const note = unknown ? `（另有 ${unknown} 个字段无法判断）` : '';
          return { pass: false, reason: `${empties.length} 个必填字段为空${note}`, hits: empties };
        }
        return { pass: true };
      },
    },
    {
      id: 'chinese_punctuation',
      name: '中文标点',
      field: 'title+description+sku',
      severity: 'block',
      check(ctx) {
        const reports = [];
        const grab = (label, text) => {
          if (!text) return;
          const m = text.match(CN_PUNCT_RE);
          if (m?.length) reports.push(`${label}: ${[...new Set(m)].join(' ')}`);
        };
        grab('标题', ctx.fields.title?.value);
        grab('描述', ctx.fields.description?.value);
        (ctx.fields.variationSku?.value || []).forEach((s, i) => grab(`SKU货号#${i + 1}`, s));
        if (reports.length) {
          return { pass: false, reason: '含中文标点（店小秘官方：会导致发布失败）', hits: reports };
        }
        return { pass: true };
      },
    },
    {
      id: 'title_should_english',
      name: '标题应为英文',
      field: 'title',
      severity: 'block',
      check(ctx) {
        const t = ctx.fields.title?.value;
        if (t == null) return { pass: true, skipped: true, reason: '未识别到标题字段' };
        const m = t.match(CJK_RE);
        if (!m?.length) return { pass: true };
        const unique = [...new Set(m)];
        const sample = unique.slice(0, 10).join('');
        const more = unique.length > 10 ? '…' : '';
        return { pass: false, reason: `含 ${m.length} 个中文字符（建议全英文）`, hits: [sample + more] };
      },
    },
    {
      id: 'sku_no_chinese',
      name: 'SKU货号 不能含中文/中文标点',
      field: 'variationSku',
      severity: 'block',
      check(ctx) {
        const skus = ctx.fields.variationSku?.value || [];
        if (!skus.length) return { pass: true, skipped: true, reason: '未识别到变种 SKU 字段' };
        const violations = skus.filter(s => s.search(CJK_RE) >= 0 || s.search(CN_PUNCT_RE) >= 0);
        if (violations.length) return { pass: false, reason: 'SKU 含中文或中文标点', hits: violations };
        return { pass: true };
      },
    },
    {
      id: 'variation_count_le_20',
      name: '变种数量上限',
      field: 'variationCount',
      severity: 'block',
      check(ctx) {
        const count = ctx.fields.variationCount?.value;
        if (count == null) return { pass: true, skipped: true, reason: '未识别到变种数' };
        if (count > VARIATION_MAX) return { pass: false, reason: `当前变种数 ${count}，超过限制 ${VARIATION_MAX}` };
        return { pass: true };
      },
    },
    {
      id: 'forbidden_words_marketing',
      name: '营销夸大词',
      field: 'title+description',
      severity: 'block',
      check(ctx) {
        const combined = `${ctx.fields.title?.value || ''} ${ctx.fields.description?.value || ''}`;
        if (!combined.trim()) return { pass: true, skipped: true, reason: '标题/描述均未识别' };
        const hits = matchWords(combined, MARKETING_FORBIDDEN);
        if (hits.length) return { pass: false, reason: '命中营销夸大词', hits };
        return { pass: true };
      },
    },
    {
      id: 'multipack_should_indicate',
      name: '多变种应在标题标明数量',
      field: 'title',
      severity: 'warn',
      check(ctx) {
        const t = ctx.fields.title?.value;
        const count = ctx.fields.variationCount?.value;
        if (t == null || !count || count <= 1) return { pass: true };
        if (MULTIPACK_INDICATORS.test(t)) return { pass: true };
        return { pass: false, reason: `${count} 个变种，标题建议含 pcs/pack/set/kit/piece 等数量信息` };
      },
    },
    {
      id: 'image_carousel_size',
      name: '轮播图尺寸',
      field: 'carouselImages',
      severity: 'warn',
      check(ctx) {
        const imgs = ctx.fields.carouselImages?.value || [];
        if (!imgs.length) return { pass: true, skipped: true, reason: '未识别到产品轮播图（或图片未加载完）' };
        const violations = [];
        for (const img of imgs) {
          const w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) continue;
          if (w < IMG_MIN_SIZE || h < IMG_MIN_SIZE) violations.push(`${w}×${h}（小于 ${IMG_MIN_SIZE}×${IMG_MIN_SIZE}）`);
          else if (w !== h) violations.push(`${w}×${h}（非 1:1）`);
        }
        if (violations.length) return { pass: false, reason: '轮播图尺寸不达标', hits: violations };
        return { pass: true };
      },
    },
  ];

  // ─── 调度器 ──────────────────────────────────────────────────────────
  function collectFields() {
    return {
      title: getTitleField(),
      description: getDescriptionField(),
      variationSku: getVariationSkuField(),
      variationCount: getVariationCountField(),
      carouselImages: getCarouselImagesField(),
      category: getCategoryField(),
    };
  }

  function runChecks() {
    const fields = collectFields();
    const ctx = { fields };
    const results = RULES.map(rule => {
      try {
        return { rule, ...rule.check(ctx) };
      } catch (e) {
        return { rule, pass: false, reason: `规则异常：${e.message}` };
      }
    });
    return { fields, results };
  }

  function bucketize(results) {
    const passes = [], blocks = [], warns = [], skippeds = [];
    for (const r of results) {
      if (r.skipped) skippeds.push(r);
      else if (r.pass) passes.push(r);
      else if (r.rule.severity === 'block') blocks.push(r);
      else warns.push(r);
    }
    return { passes, blocks, warns, skippeds };
  }

  // ─── Panel 状态 ──────────────────────────────────────────────────────
  // phase: 'idle' → 'failed'/'passed' → 'publishing' → 'done' → 'idle'
  const state = { phase: 'idle', report: null };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ─── Panel 渲染 ──────────────────────────────────────────────────────
  function renderResultRow(item) {
    const sev = item.skipped ? 'skip' : item.rule.severity;
    const conf = {
      block: { bg: '#fff2f0', border: '#ffccc7', tag: '✗ 阻断', color: '#cf1322' },
      warn:  { bg: '#fff7e6', border: '#ffd591', tag: '⚠ 警告', color: '#d46b08' },
      skip:  { bg: '#f0f5ff', border: '#adc6ff', tag: 'ⓘ 跳过', color: '#2f54eb' },
    }[sev] || { bg: '#fafafa', border: '#e4e6ea', tag: '·', color: '#888' };
    const row = document.createElement('div');
    row.style.cssText = `padding:8px 10px;margin-bottom:6px;border-radius:6px;background:${conf.bg};border:1px solid ${conf.border};`;
    const hits = item.hits
      ? `<br/>命中：<span style="font-family:monospace;color:#d4380d;word-break:break-all;">${item.hits.map(escapeHtml).join('、')}</span>`
      : '';
    row.innerHTML = `<div style="color:${conf.color};font-weight:600;margin-bottom:4px;font-size:12px;">${conf.tag} · ${escapeHtml(item.rule.name)}</div>
      <div style="color:#444;font-size:12px;line-height:1.4;">${escapeHtml(item.reason || '')}${hits}</div>`;
    return row;
  }

  function renderResultList(items) {
    const list = document.createElement('div');
    list.style.cssText = 'max-height:320px;overflow-y:auto;margin-bottom:8px;';
    items.forEach(it => list.appendChild(renderResultRow(it)));
    return list;
  }

  function makeBtn(text, color, onClick, opts = {}) {
    const b = document.createElement('button');
    b.className = 'tal-action-btn';
    if (color) b.style.background = color;
    b.textContent = text;
    if (opts.disabled) {
      b.disabled = true;
      b.style.opacity = '0.5';
      b.style.cursor = 'not-allowed';
    } else {
      b.addEventListener('click', onClick);
    }
    return b;
  }

  // 外部入口：core 切回 feature view 时调用。清掉过期的检查结果，避免用户
  // 看见"填值前"的旧 panel 误以为修没生效。publishing/done 是进行中状态不能打断
  function render(viewEl) {
    if (state.phase === 'failed' || state.phase === 'passed') {
      state.phase = 'idle';
      state.report = null;
    }
    renderInternal(viewEl);
  }

  // 内部刷新入口：onCheck/onPublish/resetAndRender 调用，不复位 state
  function renderInternal(viewEl) {
    viewEl.innerHTML = '';
    if (state.phase === 'idle')       return renderIdle(viewEl);
    if (state.phase === 'failed')     return renderFailed(viewEl);
    if (state.phase === 'passed')     return renderPassed(viewEl);
    if (state.phase === 'publishing') return renderPublishing(viewEl);
    if (state.phase === 'done')       return renderDone(viewEl);
  }

  function renderIdle(viewEl) {
    const editPage = isEditPage();
    viewEl.appendChild(makeBtn('🔍 检查并发布', null, () => onCheck(viewEl), { disabled: !editPage }));
    const tip = document.createElement('div');
    tip.className = 'tal-status';
    if (editPage) {
      tip.textContent = '点按钮开始检查';
    } else {
      tip.style.cssText = 'color:#cf1322;background:#fff2f0;border:1px solid #ffccc7;padding:8px 10px;border-radius:6px;margin-top:8px;font-size:12px;line-height:1.4;';
      tip.textContent = '请在店小秘商品编辑页使用此功能（当前 URL 不含 edit）';
    }
    viewEl.appendChild(tip);
  }

  function renderFailed(viewEl) {
    const { blocks, warns, skippeds } = state.report;
    const head = document.createElement('div');
    head.className = 'tal-card';
    head.innerHTML = `<div class="tal-card-title">检查未通过</div>
      <div class="tal-kv"><span class="tal-k">阻断</span><span class="tal-v">${blocks.length}</span></div>
      <div class="tal-kv"><span class="tal-k">警告</span><span class="tal-v">${warns.length}</span></div>
      <div class="tal-kv"><span class="tal-k">跳过</span><span class="tal-v">${skippeds.length}</span></div>`;
    viewEl.appendChild(head);
    viewEl.appendChild(renderResultList([...blocks, ...warns, ...skippeds]));
    viewEl.appendChild(makeBtn('🔍 重新检查', null, () => onCheck(viewEl)));
    viewEl.appendChild(makeBtn('停止', '#888', () => resetAndRender(viewEl)));
  }

  function renderPassed(viewEl) {
    const { passes, warns, skippeds } = state.report;
    const head = document.createElement('div');
    head.className = 'tal-card';
    const warnRow = warns.length
      ? `<div class="tal-kv"><span class="tal-k">警告</span><span class="tal-v">${warns.length}</span></div>` : '';
    const skipRow = skippeds.length
      ? `<div class="tal-kv"><span class="tal-k">跳过</span><span class="tal-v">${skippeds.length}</span></div>` : '';
    head.innerHTML = `<div class="tal-card-title" style="color:#52c41a;">✓ 检查通过（${passes.length} 项）</div>${warnRow}${skipRow}`;
    viewEl.appendChild(head);
    if (warns.length || skippeds.length) {
      viewEl.appendChild(renderResultList([...warns, ...skippeds]));
    }
    const refineBtn = makeBtn('✨ 润色标题', '#1677ff', () => onRefineTitle(viewEl, refineBtn));
    viewEl.appendChild(refineBtn);
    const optimizeBtn = makeBtn('🖼 优化主图', '#1677ff', () => onOptimizeImage(viewEl, optimizeBtn));
    viewEl.appendChild(optimizeBtn);
    viewEl.appendChild(makeBtn('✓ 确认发布', '#52c41a', () => onPublish(viewEl)));
    viewEl.appendChild(makeBtn('取消', '#888', () => resetAndRender(viewEl)));
  }

  function renderPublishing(viewEl) {
    viewEl.innerHTML = '<div class="tal-card"><div class="tal-status loading">发布中…</div></div>';
  }

  function renderDone(viewEl) {
    viewEl.innerHTML = '<div class="tal-card"><div class="tal-status ok">✓ 已点击「立即发布」</div></div>';
    setTimeout(() => resetAndRender(viewEl), 3000);
  }

  function resetAndRender(viewEl) {
    state.phase = 'idle';
    state.report = null;
    renderInternal(viewEl);
  }

  // ─── 用户交互 ────────────────────────────────────────────────────────
  function onCheck(viewEl) {
    // 静默 guard：按钮在 renderIdle 已 disabled，正常路径走不到这里；保留防御
    if (!isEditPage()) return;
    const { results } = runChecks();
    const buckets = bucketize(results);
    state.report = { ...buckets, all: results };
    state.phase = buckets.blocks.length ? 'failed' : 'passed';
    renderInternal(viewEl);
  }

  async function onPublish(viewEl) {
    state.phase = 'publishing';
    renderInternal(viewEl);
    try {
      await clickPublishImmediate();
      state.phase = 'done';
      showToast('已点击「立即发布」', 'ok');
    } catch (e) {
      showToast('发布失败：' + e.message, 'err');
      state.phase = 'passed';
    }
    renderInternal(viewEl);
  }

  // ─── 标题润色（措辞独特化降重，brain 文本判断点；spec 2026-06-17）────────────
  // 读当前标题 → SW(CAP_TITLE_REFINE) 转发 brain → 收 refined。brain 离线/失败 → 退回原标题（不阻断）。
  async function capRefineTitle() {
    const t = getTitleField();
    if (!t.el || t.value == null) return { available: false, error: '读取失败：未找到标题输入框' };
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'CAP_TITLE_REFINE', data: { original: t.value, constraints: { maxLen: 250 } } });
    } catch (e) {
      return { available: false, original: t.value, error: '润色不可用：大脑离线，保留原标题' };
    }
    if (!resp || !resp.ok) return { available: false, original: t.value, error: (resp && resp.error) || '润色不可用，保留原标题' };
    return { available: true, original: t.value, refined: resp.refined || t.value, changes: resp.changes || '' };
  }

  // 写回标题 + 写后读校验 + 重跑 title 类规则（约束给结构：不合规则弃用，不让违规标题写回）。
  function capApplyTitle(value) {
    const t = getTitleField();
    if (!t.el) return { ok: false, error: '读取失败：未找到标题输入框' };
    U.setInputValue(t.el, value);
    if ((t.el.value || '') !== value) {
      return { ok: false, error: `数据校验：标题写入未生效，期望「${value}」实际「${t.el.value}」` };
    }
    const ctx = { fields: collectFields() };   // 重读 DOM（含刚写回的标题）；ctx 形态对齐 runChecks
    const titleRuleIds = ['title_length', 'title_forbidden', 'chinese_punctuation', 'title_should_english', 'forbidden_words_marketing'];
    const failed = RULES.filter(r => titleRuleIds.includes(r.id))
      .map(r => { try { return { name: r.name, res: r.check(ctx) }; } catch (e) { return { name: r.name, res: { pass: false } }; } })
      .filter(x => x.res && x.res.pass === false && !x.res.skipped);
    if (failed.length) return { ok: false, error: `数据校验：润色结果不合规（${failed.map(f => f.name).join('、')}），请重试或手动改` };
    return { ok: true, value };
  }

  // 润色交互：点按钮 → capRefineTitle → 渲染原/润色对比（可编辑）→ 采用/放弃。
  async function onRefineTitle(viewEl, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '✨ 润色中…'; }
    const r = await capRefineTitle();
    if (btn) { btn.disabled = false; btn.textContent = '✨ 润色标题'; }
    if (!r.available) { showToast(r.error || '润色不可用', 'err'); return; }
    renderRefineCompare(viewEl, r);
  }

  function renderRefineCompare(viewEl, r) {
    const card = document.createElement('div');
    card.className = 'tal-card';
    card.innerHTML = `<div class="tal-card-title">标题润色（核对后采用）</div>
      <div class="tal-kv"><span class="tal-k">原标题</span></div>
      <div style="font-size:12px;color:#888;margin:2px 0 8px;word-break:break-word;">${escapeHtml(r.original)}</div>
      <div class="tal-kv"><span class="tal-k">润色（可编辑）</span></div>`;
    const ta = document.createElement('textarea');
    ta.value = r.refined;
    ta.maxLength = 250;
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
      showToast('标题已更新，已重新检查', 'ok');
      onCheck(viewEl);   // 改了标题 → 重跑全部检查（对比卡随之刷新）
    }));
    viewEl.appendChild(makeBtn('放弃', '#888', () => renderInternal(viewEl)));
  }

  // ─── 主图优化（保留主体换背景降重，走 native host provider；spec 2026-06-17）──────
  // 读轮播图主图 url → sendNative('OPTIMIZE_IMAGE') → 收 image_b64。失败/未接入 → 保留原图（不阻断）。
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

  // 采用：base64 → File → 注入轮播图上传 input + 写后读（等轮播图 img 新增）。
  // ⚠ 注入=新增优化图到轮播图（append 语义）；「替换原主图/置首」需店小秘删图/调序 UI，待 e2e dump DOM 定。
  // selector 用 getCarouselImagesField 同款「产品轮播图」form-item 内 input[type=file]，e2e 校准。
  async function capApplyImage(imageB64) {
    const item = findFormItemByLabelText('产品轮播图');
    if (!item) return { ok: false, error: '读取失败：未找到产品轮播图区域' };
    const input = item.querySelector('input[type="file"]');
    if (!input) return { ok: false, error: '读取失败：未找到轮播图上传控件（待 e2e 校准 selector）' };
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

  // 优化交互：点按钮 → capOptimizeImage → 原/优化图对比 → 采用/放弃。
  async function onOptimizeImage(viewEl, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '🖼 优化中…'; }
    const r = await capOptimizeImage();
    if (btn) { btn.disabled = false; btn.textContent = '🖼 优化主图'; }
    if (!r.available) { showToast(r.error || '优化不可用', 'err'); return; }
    renderImageCompare(viewEl, r);
  }

  function renderImageCompare(viewEl, r) {
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
      showToast('主图已上传，建议重新检查', 'ok');
      onCheck(viewEl);
    }));
    viewEl.appendChild(makeBtn('放弃', '#888', () => renderInternal(viewEl)));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 编排器桥接（orch）：CAP_CHECK（只检查回结构化结果）+ CAP_PUBLISH_EXEC（只发布）。
  // 两段化：检查与发布拆开，dashboard 上人工看检查结果再决定发布（spec 2026-06-16）。
  // 复用 runChecks/bucketize/clickPublishImmediate；手动 Hub 路径(onCheck/onPublish)不受影响。
  // ═══════════════════════════════════════════════════════════════════════════
  async function capHandleCheck() {
    if (!isEditPage()) {
      return { status: 'error', error: { category: 'read', code: 'CAP_NOT_EDIT_PAGE', message: '当前 tab 非店小秘编辑页（URL 不含 edit）', recoverable: true } };
    }
    let buckets;
    try {
      const { results } = runChecks();
      buckets = bucketize(results);
    } catch (e) {
      return { status: 'error', error: { category: 'read', code: 'CAP_CHECK_THREW', message: '合规检查异常：' + ((e && e.message) || e), recoverable: true } };
    }
    // block 是正常检查产出（非 error）→ 回结构化结果，由 bg 判 phase（blocked / await-publish）。
    return {
      status: 'done',
      result: {
        passCount: buckets.passes.length,
        blocks: buckets.blocks.map(b => ({ id: b.rule.id, name: b.rule.name, reason: b.reason || '' })),
        warns: buckets.warns.map(w => ({ id: w.rule.id, name: w.rule.name, reason: w.reason || '' })),
        skippeds: buckets.skippeds.length,
      },
      error: null,
    };
  }

  async function capHandlePublishExec() {
    if (!isEditPage()) {
      return { status: 'error', error: { category: 'read', code: 'CAP_NOT_EDIT_PAGE', message: '当前 tab 非店小秘编辑页（URL 不含 edit）', recoverable: true } };
    }
    try {
      await clickPublishImmediate();
    } catch (e) {
      return { status: 'error', error: { category: 'read', code: 'CAP_PUBLISH_FAILED', message: '立即发布失败：' + ((e && e.message) || e), recoverable: false } };
    }
    return { status: 'done', result: { published: true }, error: null };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    let handler = null;
    if (msg.type === 'CAP_CHECK') handler = capHandleCheck;
    else if (msg.type === 'CAP_PUBLISH_EXEC') handler = capHandlePublishExec;
    else return;
    handler()
      .then(sendResponse)
      .catch((e) => sendResponse({ status: 'error', error: { category: 'read', code: 'CAP_HANDLER_THREW', message: String((e && e.message) || e), recoverable: false } }));
    return true;  // 异步 sendResponse
  });

  // ─── 注册 ────────────────────────────────────────────────────────────
  window.AgentSeller.registerFeature({
    id: 'check_and_publish',
    icon: '✅',
    label: '检查与发布',
    locked: false,
    order: 3,
    init() {
      window.AgentSeller.onPageChange(() => {
        state.phase = 'idle';
        state.report = null;
      });
    },
    render,
  });
})();
