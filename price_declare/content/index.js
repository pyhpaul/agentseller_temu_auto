// price_declare feature — 合并自 dom-utils / selectors / storage / actions / engine / panel / content
// 内部使用 window.TPD 命名空间，外部通过 window.AgentSeller.registerFeature 注册到 Hub

// ─── dom-utils.js ───────────────────────────────────────────────────────────
;(function () {
  const TPD = (window.TPD = window.TPD || {})

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  function randomDelay(min, max, multiplier = 1) {
    const lo = Math.min(min, max)
    const hi = Math.max(min, max)
    const base = lo + Math.random() * (hi - lo)
    return Math.round(base * multiplier)
  }

  function nativeSetValue(el, text) {
    const proto =
      el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function waitFor(predicate, { timeout = 5000, root = null } = {}) {
    return new Promise((resolve, reject) => {
      if (predicate()) return resolve(true)
      const target = root || document.body
      let done = false
      const finish = (fn, arg) => {
        if (done) return
        done = true
        observer.disconnect()
        clearTimeout(timer)
        fn(arg)
      }
      const observer = new MutationObserver(() => {
        try {
          if (predicate()) finish(resolve, true)
        } catch (e) {
          finish(reject, e)
        }
      })
      observer.observe(target, { childList: true, subtree: true, attributes: true })
      const timer = setTimeout(() => finish(reject, new Error('waitFor timeout')), timeout)
    })
  }

  function nowTs() {
    return Date.now()
  }

  TPD.sleep = sleep
  TPD.randomDelay = randomDelay
  TPD.nativeSetValue = nativeSetValue
  TPD.waitFor = waitFor
  TPD.nowTs = nowTs
})()

// ─── selectors.js ────────────────────────────────────────────────────────────
;(function () {
  const TPD = (window.TPD = window.TPD || {})

  const ROW_SEL = 'tr[data-testid="beast-core-table-body-tr"]'
  const ROW_LINK_SEL = 'a[data-testid="beast-core-button-link"]'
  const MODAL_SEL = '[data-testid="beast-core-modal-innerWrapper"]'
  const PAGINATION_SEL = '[data-testid="beast-core-pagination"]'
  const REASON_TEXTAREA_SEL = 'textarea[placeholder="请输入不调整原因"]'
  const RADIO_GROUP_SEL = '[data-testid="beast-core-radioGroup"]'
  const NEXT_PAGE_SEL = '[data-testid="beast-core-pagination-next"]'

  function findNoAdjustLink(row) {
    const links = row.querySelectorAll(ROW_LINK_SEL)
    for (const a of links) {
      const span = a.querySelector('span')
      if (span && span.textContent.trim() === '不调整') return a
    }
    return null
  }

  function findPendingRows() {
    const rows = document.querySelectorAll(ROW_SEL)
    return [...rows].filter((r) => !!findNoAdjustLink(r))
  }

  function readHJD(row) {
    const tds = row.querySelectorAll('td')
    if (tds.length < 2) return null
    const div = tds[1].querySelector('div')
    return div ? div.textContent.trim().split(/\s+/)[0] : null
  }

  function findActiveModal() {
    const modals = document.querySelectorAll(MODAL_SEL)
    const list = [...modals]
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m.offsetParent !== null || m.getClientRects().length > 0) return m
    }
    return list[list.length - 1] || null
  }

  function detectModalType(modal) {
    if (!modal) return 'unknown'
    if (modal.querySelector(REASON_TEXTAREA_SEL)) return 'single'
    if (modal.textContent.includes('多个待确认调价单')) return 'multi'
    return 'unknown'
  }

  function findReasonTextarea(modal) {
    return modal ? modal.querySelector(REASON_TEXTAREA_SEL) : null
  }

  function findConfirmButton(modal) {
    if (!modal) return null
    const btns = modal.querySelectorAll('button')
    for (const b of btns) {
      const sp = b.querySelector('span')
      if (sp && sp.textContent.trim() === '确认') return b
    }
    return null
  }

  function findRadioGroups(modal) {
    if (!modal) return []
    return [...modal.querySelectorAll(RADIO_GROUP_SEL)]
  }

  function findNoAdjustRadio(group) {
    const labels = group.querySelectorAll('label')
    for (const lb of labels) {
      const txt = lb.querySelector('[class*="RD_textWrapper"]')
      const useTxt = (txt ? txt.textContent : lb.textContent).trim()
      if (useTxt === '不调整') return lb
    }
    return null
  }

  function readPaginationState() {
    const root = document.querySelector(PAGINATION_SEL)
    if (!root) return { current: 1, hasNext: false, totalText: '' }
    const active = root.querySelector('[class*="PGT_pagerItemActive"]')
    const current = active ? Number(active.textContent.trim()) || 1 : 1
    const nextLi = root.querySelector(NEXT_PAGE_SEL)
    const nextDisabled = nextLi && [...nextLi.classList].some((c) => /disabled/i.test(c))
    const hasNext = !!nextLi && !nextDisabled
    const totalEl = root.querySelector('[class*="PGT_totalText"]')
    return {
      current,
      hasNext,
      totalText: totalEl ? totalEl.textContent.trim() : ''
    }
  }

  function findNextPageButton() {
    const root = document.querySelector(PAGINATION_SEL)
    return root ? root.querySelector(NEXT_PAGE_SEL) : null
  }

  function findTabByLabel(label) {
    const items = document.querySelectorAll('[data-testid="beast-core-tab-itemLabel"]')
    for (const el of items) {
      const text = el.textContent.trim()
      const stripped = text.replace(/\(\d+\)\s*$/, '').trim()
      if (stripped === label) {
        return el.closest('[data-testid="beast-core-tab-itemLabel-wrapper"]') || el.parentElement
      }
    }
    return null
  }

  function isTabActive(tabWrapper) {
    if (!tabWrapper) return false
    return [...tabWrapper.classList].some((c) => /TAB_active/.test(c))
  }

  function readPendingTabCount() {
    const items = document.querySelectorAll('[data-testid="beast-core-tab-itemLabel"]')
    for (const el of items) {
      const text = el.textContent.trim()
      const m = text.match(/^待卖家确认\((\d+)\)\s*$/)
      if (m) return Number(m[1])
    }
    return null
  }

  TPD.selectors = {
    findPendingRows,
    findNoAdjustLink,
    readHJD,
    findActiveModal,
    detectModalType,
    findReasonTextarea,
    findConfirmButton,
    findRadioGroups,
    findNoAdjustRadio,
    readPaginationState,
    findNextPageButton,
    findTabByLabel,
    isTabActive,
    readPendingTabCount
  }
})()

// ─── storage.js ──────────────────────────────────────────────────────────────
;(function () {
  const TPD = (window.TPD = window.TPD || {})
  const KEY = 'tpd_state'

  const DEFAULT_SETTINGS = {
    reason: '已提交活动，没有利润',
    refreshEvery: 'page',
    stopOnError: true,
    delayMultiplier: 1.0,
    maxPerSession: 300,
    panelCollapsed: false
  }

  let contextDeadWarned = false

  function isContextValid() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id
    } catch (e) {
      return false
    }
  }

  function warnContextDead() {
    if (contextDeadWarned) return
    contextDeadWarned = true
    console.warn('[TPD] 扩展上下文已失效（扩展被重新加载过）。请 F5 刷新当前页面。')
  }

  function isContextInvalidatedError(err) {
    return /context invalidated/i.test(String(err && err.message || err))
  }

  function defaults() {
    return {
      mode: 'IDLE',
      stats: {
        success: 0,
        failed: 0,
        processedSinceRefresh: 0,
        totalProcessed: 0,
        sessionStart: 0
      },
      settings: { ...DEFAULT_SETTINGS },
      snapshot: {
        beforeReloadCount: null,
        reloadRetries: 0
      },
      lastTouchedAt: 0,
      lastAction: null,
      reloadReason: null
    }
  }

  function deepMerge(target, patch) {
    if (!patch || typeof patch !== 'object') return target
    const out = { ...target }
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && target[k] !== null) {
        out[k] = deepMerge(target[k], v)
      } else {
        out[k] = v
      }
    }
    return out
  }

  async function loadState() {
    if (!isContextValid()) {
      warnContextDead()
      return defaults()
    }
    try {
      const raw = await chrome.storage.local.get([KEY])
      const persisted = raw[KEY]
      if (!persisted) return defaults()
      return deepMerge(defaults(), persisted)
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        warnContextDead()
        return defaults()
      }
      throw err
    }
  }

  async function saveState(patch) {
    if (!isContextValid()) {
      warnContextDead()
      return defaults()
    }
    try {
      const cur = await loadState()
      const next = deepMerge(cur, patch || {})
      if (!patch || patch.lastTouchedAt === undefined) {
        next.lastTouchedAt = Date.now()
      }
      await chrome.storage.local.set({ [KEY]: next })
      return next
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        warnContextDead()
        return defaults()
      }
      throw err
    }
  }

  async function reset() {
    if (!isContextValid()) {
      warnContextDead()
      return
    }
    try {
      await chrome.storage.local.remove(KEY)
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        warnContextDead()
        return
      }
      throw err
    }
  }

  async function shouldAutoResume() {
    const st = await loadState()
    if (st.mode !== 'RUNNING') return false
    if (st.lastAction !== 'reload') return false
    if (!st.lastTouchedAt) return false
    if (Date.now() - st.lastTouchedAt > 60_000) return false
    return true
  }

  TPD.storage = {
    KEY,
    DEFAULT_SETTINGS,
    defaults,
    loadState,
    saveState,
    reset,
    shouldAutoResume
  }
})()

// ─── actions.js ──────────────────────────────────────────────────────────────
;(function () {
  const TPD = (window.TPD = window.TPD || {})
  const { waitFor, nativeSetValue, randomDelay, sleep } = TPD
  const S = TPD.selectors

  async function clickNoAdjust(row) {
    const a = S.findNoAdjustLink(row)
    if (!a) throw new Error('RowVanished: 不调整 link not found')
    a.click()
  }

  async function waitModalAppear({ timeout = 6000 } = {}) {
    await waitFor(
      () => {
        const m = S.findActiveModal()
        return !!m && S.detectModalType(m) !== 'unknown'
      },
      { timeout }
    )
    return S.findActiveModal()
  }

  async function waitModalClose(modal, { timeout = 6000 } = {}) {
    const closed = await waitFor(
      () => {
        if (!modal.isConnected) return true
        if (modal.offsetParent === null && modal.getClientRects().length === 0) return true
        return false
      },
      { timeout }
    ).then(() => true).catch(() => false)

    if (!closed) {
      // 弹窗超时未关闭（可能服务器拒绝了重复操作），发 Escape 尝试关闭
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(randomDelay(400, 700))
    }
  }

  async function fillReason(modal, text, { multiplier = 1 } = {}) {
    const ta = S.findReasonTextarea(modal)
    if (!ta) throw new Error('TextareaMissing')
    nativeSetValue(ta, text)
    await sleep(randomDelay(120, 250, multiplier))
    if (ta.value !== text) nativeSetValue(ta, text)
  }

  async function selectAllNoAdjust(modal, { multiplier = 1 } = {}) {
    const groups = S.findRadioGroups(modal)
    if (groups.length === 0) throw new Error('NoRadioGroups')
    for (const g of groups) {
      const label = S.findNoAdjustRadio(g)
      if (!label) throw new Error('NoAdjustRadioMissing')
      const input = label.querySelector('input[type="radio"]')
      if (input) input.click()
      else label.click()
      await sleep(randomDelay(120, 280, multiplier))
    }
  }

  async function clickConfirm(modal) {
    const btn = S.findConfirmButton(modal)
    if (!btn) throw new Error('ConfirmButtonMissing')
    if (btn.disabled) throw new Error('ButtonDisabled')
    btn.click()
  }

  async function reloadPage() {
    location.reload()
  }

  async function clickNextPage() {
    const li = S.findNextPageButton()
    if (!li) throw new Error('NextPageMissing')
    li.click()
  }

  function robustClick(el) {
    if (!el) return
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    } catch (e) {
      try { el.click() } catch (_) { /* swallow — caller will detect via isTabActive */ }
    }
  }

  async function ensureTargetTab(label, { multiplier = 1, timeout = 15000 } = {}) {
    let tab = S.findTabByLabel(label)
    if (!tab) {
      try {
        await waitFor(() => !!S.findTabByLabel(label), { timeout })
      } catch (e) {
        throw new Error('TabNotFound: ' + label)
      }
      tab = S.findTabByLabel(label)
    }
    if (S.isTabActive(tab)) return
    robustClick(tab)
    await sleep(randomDelay(300, 600, multiplier))
    if (S.isTabActive(tab)) {
      await waitListReady({ timeout: 10000 })
      return
    }
    const inner = tab.querySelector('[data-testid="beast-core-tab-itemLabel"]')
    if (inner) {
      robustClick(inner)
      await sleep(randomDelay(300, 600, multiplier))
    }
    if (!S.isTabActive(tab)) {
      throw new Error('TabClickIneffective: ' + label)
    }
    await waitListReady({ timeout: 10000 })
  }

  async function waitListReady({ timeout = 15000 } = {}) {
    await waitFor(
      () => {
        const rows = S.findPendingRows()
        const pg = document.querySelector('[data-testid="beast-core-pagination"]')
        if (rows.length > 0) return true
        if (pg && /共有\s*0\s*条/.test(pg.textContent)) return true
        return false
      },
      { timeout }
    )
  }

  async function refreshListByTabSwitch({ multiplier = 1 } = {}) {
    const detourLabels = ['价格申报中', '成功', '失败']
    let detourTab = null
    for (const label of detourLabels) {
      const t = S.findTabByLabel(label)
      if (t && !S.isTabActive(t)) { detourTab = t; break }
    }
    if (!detourTab) throw new Error('NoDetourTab')
    robustClick(detourTab)
    await sleep(randomDelay(500, 900, multiplier))
    await ensureTargetTab('待卖家确认', { multiplier })
  }

  TPD.actions = {
    clickNoAdjust,
    waitModalAppear,
    waitModalClose,
    fillReason,
    selectAllNoAdjust,
    clickConfirm,
    reloadPage,
    clickNextPage,
    ensureTargetTab,
    waitListReady,
    refreshListByTabSwitch
  }
})()

// ─── engine.js ───────────────────────────────────────────────────────────────
;(function () {
  const TPD = (window.TPD = window.TPD || {})
  const { sleep: _rawSleep, randomDelay, nowTs, waitFor: _rawWaitFor } = TPD
  const S = TPD.selectors
  const A = TPD.actions
  const ST = TPD.storage

  const MODES = {
    IDLE: 'IDLE',
    RUNNING: 'RUNNING',
    PAUSED: 'PAUSED',
    STEPPING: 'STEPPING',
    STOPPING: 'STOPPING',
    ERROR: 'ERROR'
  }

  const FATAL_ERRORS = new Set(['UnknownModalType', 'CaptchaOrLogout'])

  let state = null
  let listeners = new Set()
  let runningPromise = null

  // stop wake-up 信号：stop() 时 resolve，让 engine 内部的 sleep/waitFor 立即返回
  let _stopWakeResolve = null
  let _stopWake = new Promise(r => { _stopWakeResolve = r })
  function _resetStopWake() { _stopWake = new Promise(r => { _stopWakeResolve = r }) }

  // 可中断的 sleep/waitFor：STOPPING 时被 _stopWake resolve 唤醒，继续执行到 checkpoint()
  function sleep(ms) { return Promise.race([_rawSleep(ms), _stopWake]) }
  function waitFor(predicate, opts) { return Promise.race([_rawWaitFor(predicate, opts), _stopWake]) }

  function emit() {
    for (const l of listeners) {
      try { l(state) } catch (e) { console.warn('TPD listener error', e) }
    }
  }

  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  function log(level, msg, hjd = null) {
    const prefix = hjd ? `[TPD][${hjd}]` : '[TPD]';
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`${prefix} ${msg}`)
    if (!state.log) state.log = []
    state.log.unshift({ t: new Date().toLocaleTimeString('en-GB'), level, msg, hjd })
    state.log = state.log.slice(0, 50)
    emit()
  }

  async function persist(patch = {}) {
    state = await ST.saveState({
      ...patch,
      mode: state.mode,
      stats: state.stats,
      settings: state.settings,
      snapshot: state.snapshot
    })
    emit()
  }

  async function init() {
    state = await ST.loadState()
    if (!state.log) state.log = []
    emit()
  }

  function setMode(m) {
    state.mode = m
    emit()
  }

  async function checkpoint() {
    while (state.mode === MODES.PAUSED) {
      await sleep(150)
    }
    if (state.mode === MODES.STOPPING) {
      const err = new Error('Stopped')
      err.code = 'Stopped'
      throw err
    }
  }

  function classifyError(err) {
    const m = String(err && err.message || err)
    if (err && err.code && FATAL_ERRORS.has(err.code)) return err.code
    if (/^RowVanished/.test(m)) return 'RowVanished'
    if (/^(TextareaMissing|NoRadioGroups|NoAdjustRadioMissing|ConfirmButtonMissing|NextPageMissing)/.test(m)) return 'StructureMissing'
    if (/^ButtonDisabled/.test(m)) return 'ButtonDisabled'
    if (/timeout/i.test(m)) return 'TimeoutError'
    if (/captcha|login|登录|验证/i.test(m)) return 'CaptchaOrLogout'
    return 'Unknown'
  }

  function detectRiskSignals() {
    if (/login|signin|account\/login/i.test(location.pathname)) return 'CaptchaOrLogout'
    const body = document.body ? document.body.textContent : ''
    if (/请重新登录|账户已退出|验证码/.test(body)) return 'CaptchaOrLogout'
    return null
  }

  async function processOneRow(row) {
    const hjd = S.readHJD(row) || '(no-hjd)'
    log('info', '开始处理', hjd)
    await A.clickNoAdjust(row)
    await sleep(randomDelay(800, 1500, state.settings.delayMultiplier))
    const modal = await A.waitModalAppear()
    await checkpoint()
    const type = S.detectModalType(modal)
    if (type === 'single') {
      await A.fillReason(modal, state.settings.reason, { multiplier: state.settings.delayMultiplier })
      await sleep(randomDelay(200, 500, state.settings.delayMultiplier))
      await A.clickConfirm(modal)
      log('info', '单SKU 已确认', hjd)
    } else if (type === 'multi') {
      await A.selectAllNoAdjust(modal, { multiplier: state.settings.delayMultiplier })
      await sleep(randomDelay(200, 500, state.settings.delayMultiplier))
      await A.clickConfirm(modal)
      log('info', '多SKU 已确认', hjd)
    } else {
      const e = new Error('UnknownModalType')
      e.code = 'UnknownModalType'
      throw e
    }
    await A.waitModalClose(modal)
    state.stats.success += 1
    state.stats.processedSinceRefresh += 1
    state.stats.totalProcessed += 1
    log('ok', '✓ 完成', hjd)
  }

  async function fallbackReload(reason) {
    state.snapshot.reloadRetries = 0
    await persist({ lastAction: 'reload', reloadReason: reason })
    await A.reloadPage()
  }

  async function triggerRefresh(reason) {
    state.stats.processedSinceRefresh = 0
    const before = S.readPendingTabCount()
    await persist({ lastAction: 'refresh', reloadReason: reason })

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await A.refreshListByTabSwitch({ multiplier: state.settings.delayMultiplier })
      } catch (err) {
        log('warn', `切 tab 失败 (${err.message || err})，fallback reload`)
        await fallbackReload(reason + '_tab_fail')
        return
      }

      if (before == null) {
        await persist({ lastAction: 'refresh_ok' })
        return
      }

      // 切回来后立即读当前 count：已变小说明服务器已更新，直接继续
      const cur = S.readPendingTabCount()
      if (cur != null && cur < before) {
        log('info', `server list 已同步 (${before} → ${cur})${attempt > 1 ? ' [2/2]' : ''}`)
        await persist({ lastAction: 'refresh_ok' })
        return
      }

      // 数值未变，立即再切一次 tab
      if (attempt < 2) {
        log('warn', `count 未变 (${cur ?? 'null'})，立即再切 tab`)
      }
    }

    // 两次切 tab 后仍未同步，等服务器更新（最多 5s），避免重复处理已确认的行
    log('warn', 'server list 两次切 tab 未同步，等待服务器更新（最多 5s）…')
    await waitFor(
      () => { const cur = S.readPendingTabCount(); return cur != null && cur < before },
      { timeout: 5000 }
    ).then(() => log('info', `server list 最终同步 (→ ${S.readPendingTabCount()})`))
     .catch(() => log('warn', '5s 仍未同步，继续执行'))
    await persist({ lastAction: 'refresh_ok' })
  }

  async function periodicRefreshIfNeeded() {
    const policy = state.settings.refreshEvery
    if (policy === 'page') {
      if (S.findPendingRows().length === 0) {
        await triggerRefresh('page_done')
      }
    } else if (typeof policy === 'number' && policy > 0) {
      if (state.stats.processedSinceRefresh >= policy) {
        await triggerRefresh('periodic')
      }
    }
  }

  async function mainLoop() {
    try {
      await A.waitListReady().catch(() => {})
      while (true) {
        await checkpoint()
        try {
          await A.ensureTargetTab('待卖家确认', { multiplier: state.settings.delayMultiplier })
        } catch (err) {
          log('error', `切换 tab 失败：${err.message || err}`)
          setMode(MODES.PAUSED)
          await persist({ lastAction: 'tab_fail' })
          return
        }
        const risk = detectRiskSignals()
        if (risk) {
          log('error', `风控信号：${risk}，停止`)
          setMode(MODES.ERROR)
          await persist({ lastAction: 'risk_stop' })
          return
        }
        if (state.stats.totalProcessed >= state.settings.maxPerSession) {
          log('warn', `已达单会话上限 ${state.settings.maxPerSession}`)
          setMode(MODES.IDLE)
          await persist({ lastAction: 'max_reached' })
          return
        }
        const rows = S.findPendingRows()
        if (rows.length === 0) {
          // tab badge 仍显示有商品时，DOM 可能还在渲染，等稳定后重试
          const tabCount = S.readPendingTabCount()
          if (tabCount !== null && tabCount > 0) {
            log('info', `DOM 列表为空但 tab 显示 ${tabCount} 条，等待渲染…`)
            await A.waitListReady({ timeout: 8000 }).catch(() => {})
            continue
          }
          const pg = S.readPaginationState()
          if (pg.hasNext) {
            await persist({ lastAction: 'next_page' })
            await A.clickNextPage()
            await sleep(randomDelay(600, 1100, state.settings.delayMultiplier))
            await A.waitListReady().catch(() => {})
            continue
          }
          log('ok', `全部完成 (success=${state.stats.success}, failed=${state.stats.failed})`)
          setMode(MODES.IDLE)
          state.stats.processedSinceRefresh = 0
          await persist({ lastAction: 'done' })
          return
        }

        try {
          await processOneRow(rows[0])
          await persist({ lastAction: 'row_done' })
        } catch (err) {
          if (err && err.code === 'Stopped') throw err  // 让外层 catch 正确处理停止
          const kind = classifyError(err)
          if (kind === 'RowVanished') {
            log('info', '行已消失，跳过')
            await persist({ lastAction: 'row_vanished' })
            continue
          }
          state.stats.failed += 1
          log('error', `✗ ${kind}: ${err.message || err}`)
          await persist({ lastAction: 'row_failed' })
          if (FATAL_ERRORS.has(kind) || state.settings.stopOnError) {
            setMode(MODES.PAUSED)
            await persist({})
            log('warn', '已暂停，等待人工')
            return
          }
          try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          } catch (e) {
            log('warn', `Esc 派发失败：${e.message || e}`)
          }
          await sleep(randomDelay(800, 1500, state.settings.delayMultiplier))
        }

        await checkpoint()
        await periodicRefreshIfNeeded()

        if (state.mode === MODES.STEPPING) {
          setMode(MODES.PAUSED)
          log('info', '单步完成，已暂停')
          await persist({ lastAction: 'step_done' })
          return
        }

        await sleep(randomDelay(400, 900, state.settings.delayMultiplier))
      }
    } catch (err) {
      if (err && err.code === 'Stopped') {
        log('info', '用户停止')
        setMode(MODES.IDLE)
        state.stats.processedSinceRefresh = 0
        await persist({ lastAction: 'stopped' })
        return
      }
      log('error', `未捕获异常：${err.message || err}`)
      setMode(MODES.ERROR)
      await persist({ lastAction: 'crash' })
    }
  }

  async function start() {
    if (runningPromise) return
    const pendingCount = S.readPendingTabCount()
    if (pendingCount === 0) {
      log('ok', '✓ 当前无待处理商品，无需开始')
      return
    }
    if (state.mode === MODES.IDLE) {
      state.stats = ST.defaults().stats
      state.stats.sessionStart = nowTs()
    }
    setMode(MODES.RUNNING)
    await persist({ lastAction: 'start' })
    runningPromise = mainLoop().finally(() => { runningPromise = null })
  }

  function pause() {
    if (state.mode === MODES.RUNNING || state.mode === MODES.STEPPING) {
      setMode(MODES.PAUSED)
    }
  }

  async function step() {
    if (state.mode === MODES.RUNNING) return
    setMode(MODES.STEPPING)
    await persist({ lastAction: 'step' })
    if (!runningPromise) {
      runningPromise = mainLoop().finally(() => { runningPromise = null })
    }
  }

  async function stop() {
    if (runningPromise) {
      setMode(MODES.STOPPING)
      // 唤醒所有正在等待的 sleep/waitFor，让 mainLoop 快速到达 checkpoint()
      if (_stopWakeResolve) { _stopWakeResolve(); _resetStopWake() }
    } else {
      setMode(MODES.IDLE)
      state.stats.processedSinceRefresh = 0
      await persist({ lastAction: 'stopped' })
    }
  }

  async function resetStats() {
    state.stats = ST.defaults().stats
    state.log = []
    await persist({ lastAction: 'reset_stats' })
  }

  async function updateSettings(patch) {
    state.settings = { ...state.settings, ...patch }
    await persist({ lastAction: 'settings' })
  }

  async function autoResumeIfNeeded() {
    if (await ST.shouldAutoResume()) {
      log('info', '刷新后自动续跑')
      try {
        await A.ensureTargetTab('待卖家确认', { multiplier: state.settings.delayMultiplier })
      } catch (e) {
        log('warn', `续跑时切 tab 失败：${e.message || e}（mainLoop 会重试）`)
      }
      await A.waitListReady().catch(() => {})

      const before = state.snapshot && state.snapshot.beforeReloadCount
      if (before != null) {
        const ok = await waitFor(
          () => {
            const cur = S.readPendingTabCount()
            return cur != null && cur < before
          },
          { timeout: 5000 }
        ).then(() => true).catch(() => false)

        if (!ok) {
          const retries = (state.snapshot.reloadRetries || 0) + 1
          const curCount = S.readPendingTabCount()
          if (retries <= 2) {
            log('warn', `server list 未刷新 (count=${curCount} 应 < ${before})，重试 reload ${retries}/2`)
            state.snapshot.reloadRetries = retries
            await persist({ lastAction: 'reload', reloadReason: 'stale_count' })
            await A.reloadPage()
            return
          }
          log('error', `server list 持续 stale (${retries} 次 reload 仍 count=${curCount})，暂停等人工`)
          setMode(MODES.PAUSED)
          state.snapshot.beforeReloadCount = null
          state.snapshot.reloadRetries = 0
          await persist({ lastAction: 'stale_giveup' })
          return
        }

        log('info', `server list 已同步 (${before} → ${S.readPendingTabCount()})`)
        state.snapshot.beforeReloadCount = null
        state.snapshot.reloadRetries = 0
      }

      await persist({ lastAction: 'resumed' })
      await sleep(randomDelay(800, 1500, state.settings.delayMultiplier))
      if (!runningPromise) {
        runningPromise = mainLoop().finally(() => { runningPromise = null })
      }
    } else if (state.mode === MODES.RUNNING) {
      setMode(MODES.IDLE)
      await persist({ lastAction: 'stale_clear' })
    }
  }

  TPD.engine = {
    MODES,
    init,
    subscribe,
    getState: () => state,
    start,
    pause,
    step,
    stop,
    resetStats,
    updateSettings,
    autoResumeIfNeeded
  }
})()

// ─── panel.js ────────────────────────────────────────────────────────────────
;(function () {
  const TPD = (window.TPD = window.TPD || {})

  const PANEL_CSS_TEXT = `:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.wrap {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: 340px;
  background: #fff;
  border: 1px solid #d9d9d9;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  z-index: 2147483600;
  font-size: 12px;
  color: #222;
  user-select: none;
}
.wrap.collapsed {
  width: 40px;
  height: 40px;
  overflow: hidden;
  border-radius: 20px;
  cursor: pointer;
}
.wrap.collapsed .body, .wrap.collapsed .head .title, .wrap.collapsed .head .btns { display: none; }
.wrap.collapsed::before {
  content: "T";
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-weight: 700;
  color: #fb7701;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid #eee;
  cursor: move;
}
.head .title { font-weight: 600; color: #333; }
.head .btns button {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  margin-left: 4px;
  color: #666;
}
.section { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
.section:last-child { border-bottom: none; }
.stat-row { display: flex; justify-content: space-between; line-height: 1.6; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.dot.IDLE { background: #999; }
.dot.RUNNING { background: #27ae60; animation: pulse 1.2s infinite; }
.dot.PAUSED { background: #f39c12; }
.dot.STEPPING { background: #2980b9; }
.dot.STOPPING { background: #c0392b; }
.dot.ERROR { background: #c0392b; }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }
.controls { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.controls button {
  padding: 6px 8px;
  border: 1px solid #d9d9d9;
  background: #fafafa;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.controls button:disabled { color: #bbb; cursor: not-allowed; }
.controls button.primary { background: #fb7701; color: #fff; border-color: #fb7701; }
.controls button.primary:disabled { background: #ffd9b5; border-color: #ffd9b5; color: #fff; }
.settings label { display: flex; justify-content: space-between; align-items: center; margin: 4px 0; gap: 8px; }
.settings input[type="text"], .settings select { flex: 1; padding: 3px 6px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; }
.log {
  max-height: 160px;
  overflow-y: auto;
  background: #fafafa;
  border-radius: 6px;
  padding: 6px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.45;
}
.log .item.ok { color: #27ae60; }
.log .item.warn { color: #d68910; }
.log .item.error { color: #c0392b; }
.log .item.info { color: #555; }
`

  let host, root, refs = {}

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v
      else if (k === 'on') for (const [e, h] of Object.entries(v)) node.addEventListener(e, h)
      else if (k === 'html') node.innerHTML = v
      else node.setAttribute(k, v)
    }
    for (const c of children.flat()) {
      if (c == null) continue
      node.append(c.nodeType ? c : document.createTextNode(c))
    }
    return node
  }

  function renderPanel(state) {
    if (!refs.wrap) return
    if (!state || !state.settings || !state.stats) return
    const collapsed = state.settings.panelCollapsed
    refs.wrap.classList.toggle('collapsed', collapsed)
    refs.modeDot.className = `dot ${state.mode}`
    refs.modeText.textContent = state.mode
    const pg = TPD.selectors.readPaginationState()
    refs.pageInfo.textContent = `当前页 ${pg.current}${pg.totalText ? ' | ' + pg.totalText : ''}`
    refs.batch.textContent = `本次已处理: ${state.stats.totalProcessed}`
    refs.success.textContent = `✓ 成功 ${state.stats.success}`
    refs.failed.textContent = `✗ 失败 ${state.stats.failed}`

    const m = state.mode
    refs.btnStart.disabled = m === 'RUNNING' || m === 'STOPPING'
    refs.btnPause.disabled = m !== 'RUNNING' && m !== 'STEPPING'
    refs.btnStep.disabled  = m === 'RUNNING' || m === 'STOPPING'
    refs.btnStop.disabled  = m === 'IDLE'

    refs.reason.value = state.settings.reason
    refs.refreshEvery.value = String(state.settings.refreshEvery)
    refs.stopOnError.checked = !!state.settings.stopOnError
    refs.delayMul.value = String(state.settings.delayMultiplier)

    refs.log.innerHTML = ''
    for (const it of (state.log || [])) {
      const line = el('div', { class: `item ${it.level}` },
        `${it.t} ${it.hjd ? '[' + it.hjd + '] ' : ''}${it.msg}`
      )
      refs.log.append(line)
    }
  }

  function buildDom() {
    host = document.createElement('div')
    host.id = 'tpd-panel-host'
    document.documentElement.append(host)
    root = host.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = PANEL_CSS_TEXT
    root.append(style)

    const head = el('div', { class: 'head' },
      el('span', { class: 'title' }, '⚙ Temu 不调整自动化'),
      el('span', { class: 'btns' },
        el('button', { on: { click: toggleCollapse } }, '─')
      )
    )

    const status = el('div', { class: 'section' },
      el('div', { class: 'stat-row' },
        el('span', {}, el('span', { class: 'dot IDLE' }), el('span', { class: 'mode-text' }, 'IDLE')),
        el('span', { class: 'page-info' }, '当前页 -')
      ),
      el('div', { class: 'stat-row' },
        el('span', { class: 'batch' }, '本次已处理: 0'),
        el('span', { class: 'success' }, '✓ 0'),
        el('span', { class: 'failed' }, '✗ 0')
      )
    )
    refs.modeDot = status.querySelector('.dot')
    refs.modeText = status.querySelector('.mode-text')
    refs.pageInfo = status.querySelector('.page-info')
    refs.batch = status.querySelector('.batch')
    refs.success = status.querySelector('.success')
    refs.failed = status.querySelector('.failed')

    const controls = el('div', { class: 'section controls' },
      refs.btnStart = el('button', { class: 'primary', on: { click: () => TPD.engine.start() } }, '▶ 开始'),
      refs.btnPause = el('button', { on: { click: () => TPD.engine.pause() } }, '⏸ 暂停'),
      refs.btnStep  = el('button', { on: { click: () => TPD.engine.step() } }, '→ 单步'),
      refs.btnStop  = el('button', { on: { click: () => TPD.engine.stop() } }, '■ 停止'),
      el('button', { on: { click: () => TPD.engine.resetStats() } }, '↻ 重置'),
      el('button', { on: { click: toggleCollapse } }, '折叠')
    )

    refs.reason = el('input', { type: 'text', value: '' })
    refs.refreshEvery = (() => {
      const s = el('select', {})
      for (const v of ['page', '1', '3', '5']) {
        s.append(el('option', { value: v }, v === 'page' ? '整页' : v))
      }
      return s
    })()
    refs.stopOnError = el('input', { type: 'checkbox' })
    refs.delayMul = (() => {
      const s = el('select', {})
      for (const v of ['0.5', '1', '1.5', '2', '3']) s.append(el('option', { value: v }, `${v}x`))
      return s
    })()

    const settings = el('div', { class: 'section settings' },
      el('label', {}, '不调整原因', refs.reason),
      el('label', {}, '每 N 条刷新', refs.refreshEvery),
      el('label', {}, '失败时暂停', refs.stopOnError),
      el('label', {}, '延时倍速', refs.delayMul)
    )

    refs.reason.addEventListener('change', () => TPD.engine.updateSettings({ reason: refs.reason.value }))
    refs.refreshEvery.addEventListener('change', () => {
      const v = refs.refreshEvery.value
      TPD.engine.updateSettings({ refreshEvery: v === 'page' ? 'page' : Number(v) })
    })
    refs.stopOnError.addEventListener('change', () => TPD.engine.updateSettings({ stopOnError: refs.stopOnError.checked }))
    refs.delayMul.addEventListener('change', () => TPD.engine.updateSettings({ delayMultiplier: Number(refs.delayMul.value) }))

    refs.log = el('div', { class: 'log' })
    const logSection = el('div', { class: 'section' },
      el('div', {}, '日志（最新 50 条）'),
      refs.log
    )

    refs.wrap = el('div', { class: 'wrap' }, head, status, controls, settings, logSection)
    refs.wrap.addEventListener('click', () => {
      if (refs.wrap.classList.contains('collapsed')) toggleCollapse()
    })
    root.append(refs.wrap)

    makeDraggable(head, refs.wrap)
  }

  function toggleCollapse() {
    const cur = TPD.engine.getState().settings.panelCollapsed
    TPD.engine.updateSettings({ panelCollapsed: !cur })
  }

  function makeDraggable(handle, target) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('button, a, input, select, textarea')) return
      dragging = true
      sx = e.clientX; sy = e.clientY
      const r = target.getBoundingClientRect()
      ox = r.left; oy = r.top
      e.preventDefault()
    })
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return
      const nx = ox + (e.clientX - sx)
      const ny = oy + (e.clientY - sy)
      target.style.left = `${nx}px`
      target.style.top = `${ny}px`
      target.style.right = 'auto'
      target.style.bottom = 'auto'
    })
    document.addEventListener('mouseup', () => { dragging = false })
  }

  function mount() {
    if (host) return
    if (!TPD.engine) {
      console.warn('[TPD] engine not loaded; panel.mount aborted')
      return
    }
    buildDom()
    TPD.engine.subscribe(renderPanel)
    renderPanel(TPD.engine.getState())
  }

  TPD.panel = { mount }
})()

// ─── AgentSeller 注册入口 ────────────────────────────────────────────────────
;(function () {
  const TARGET_RE = /\/main\/adjust-price-manage\/order-price/

  let bootstrapped = false
  let tpdViewEl = null  // 当前 Hub feature view 的容器引用

  // 只更新 DOM 里的动态字段，不重建结构
  function updateHubView(state) {
    const el = tpdViewEl
    if (!el || !el.isConnected || !state) return

    const dot = el.querySelector('.tpd-dot')
    const modeText = el.querySelector('.tpd-mode-text')
    if (dot) {
      dot.style.background = { RUNNING: '#27ae60', PAUSED: '#f39c12', STEPPING: '#2980b9', STOPPING: '#c0392b', ERROR: '#c0392b' }[state.mode] || '#999'
      dot.style.animation = state.mode === 'RUNNING' ? 'tpd-pulse 1.2s infinite' : 'none'
    }
    if (modeText) modeText.textContent = state.mode

    const s = state.stats
    const successEl = el.querySelector('.tpd-success')
    const failedEl  = el.querySelector('.tpd-failed')
    const totalEl   = el.querySelector('.tpd-total')
    if (successEl) successEl.textContent = `✓ ${s.success}`
    if (failedEl)  failedEl.textContent  = `✗ ${s.failed}`
    if (totalEl)   totalEl.textContent   = `共 ${s.totalProcessed}`

    const onTargetPage = TARGET_RE.test(location.href)
    const m = state.mode
    const btnStart = el.querySelector('.tpd-btn-start')
    const btnPause = el.querySelector('.tpd-btn-pause')
    const btnStep  = el.querySelector('.tpd-btn-step')
    const btnStop  = el.querySelector('.tpd-btn-stop')
    // 不在目标页时，开始/单步强制禁用
    if (btnStart) btnStart.disabled = !onTargetPage || m === 'RUNNING' || m === 'STOPPING'
    if (btnPause) btnPause.disabled = m !== 'RUNNING' && m !== 'STEPPING'
    if (btnStep)  btnStep.disabled  = !onTargetPage || m === 'RUNNING' || m === 'STOPPING'
    if (btnStop)  btnStop.disabled  = m === 'IDLE'

    // 设置字段只在非焦点时同步，避免打断用户输入
    const reasonInput = el.querySelector('.tpd-reason')
    if (reasonInput && document.activeElement !== reasonInput) reasonInput.value = state.settings.reason
    const refreshEvery = el.querySelector('.tpd-refresh-every')
    if (refreshEvery) refreshEvery.value = String(state.settings.refreshEvery)
    const stopOnError = el.querySelector('.tpd-stop-on-error')
    if (stopOnError) stopOnError.checked = !!state.settings.stopOnError
    const delayMul = el.querySelector('.tpd-delay-mul')
    if (delayMul) delayMul.value = String(state.settings.delayMultiplier)

  }

  function buildHubView(viewEl) {
    const TPD = window.TPD
    viewEl.innerHTML = `
      <style>
        @keyframes tpd-pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        .tpd-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; margin-bottom:8px }
        .tpd-grid button { padding:6px 0; font-size:12px }
        .tpd-settings label { display:flex; justify-content:space-between; align-items:center; font-size:12px; margin:3px 0; gap:8px }
        .tpd-settings input[type=text], .tpd-settings select { flex:1; padding:2px 5px; border:1px solid #ddd; border-radius:4px; font-size:12px }
      </style>
      <div style="font-size:13px;color:#333;padding-bottom:2px">
        <div style="display:flex;align-items:center;gap:7px;padding:6px 0 8px;border-bottom:1px solid #f0f0f0;margin-bottom:8px">
          <span class="tpd-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#999;flex-shrink:0"></span>
          <span class="tpd-mode-text" style="font-weight:600;flex:1">IDLE</span>
          <span class="tpd-success" style="color:#27ae60;font-size:12px">✓ 0</span>
          <span class="tpd-failed"  style="color:#c0392b;font-size:12px;margin:0 4px">✗ 0</span>
          <span class="tpd-total"   style="color:#999;font-size:12px">共 0</span>
        </div>
        <div class="tpd-grid">
          <button class="tal-action-btn tpd-btn-start" style="margin:0;background:#1677ff;color:#fff">▶ 开始</button>
          <button class="tal-action-btn tpd-btn-pause" style="margin:0;background:#fa8c16;color:#fff">⏸ 暂停</button>
          <button class="tal-action-btn tpd-btn-step"  style="margin:0;background:#1677ff;color:#fff">→ 单步</button>
          <button class="tal-action-btn tpd-btn-stop"  style="margin:0;background:#ff4d4f;color:#fff">■ 停止</button>
          <button class="tal-action-btn tpd-btn-reset" style="margin:0;background:#888;color:#fff;grid-column:span 2">↻ 重置统计</button>
        </div>
        <div class="tpd-settings" style="border-top:1px solid #f0f0f0;padding-top:7px;margin-bottom:7px">
          <label><span style="color:#888">不调整原因</span><input class="tpd-reason" type="text"></label>
          <label><span style="color:#888">每N条刷新</span>
            <select class="tpd-refresh-every">
              <option value="page">整页</option>
              <option value="1">1</option><option value="3">3</option><option value="5">5</option>
            </select>
          </label>
          <label><span style="color:#888">失败时暂停</span><input class="tpd-stop-on-error" type="checkbox"></label>
          <label><span style="color:#888">延时倍速</span>
            <select class="tpd-delay-mul">
              <option value="0.5">0.5x</option><option value="1">1x</option>
              <option value="1.5">1.5x</option><option value="2">2x</option><option value="3">3x</option>
            </select>
          </label>
        </div>
        <div style="border-top:1px solid #f0f0f0;padding-top:6px;font-size:11px;color:#bbb">
          日志见 DevTools Console（过滤 [TPD]）
        </div>
      </div>
    `

    const guardTargetPage = (fn) => () => {
      if (!TARGET_RE.test(location.href)) {
        window.AgentSeller.showToast('请先访问商品价格申报', 'err')
        return
      }
      fn()
    }
    viewEl.querySelector('.tpd-btn-start').addEventListener('click', guardTargetPage(() => TPD.engine.start()))
    viewEl.querySelector('.tpd-btn-pause').addEventListener('click', () => TPD.engine.pause())
    viewEl.querySelector('.tpd-btn-step').addEventListener('click',  guardTargetPage(() => TPD.engine.step()))
    viewEl.querySelector('.tpd-btn-stop').addEventListener('click',  () => TPD.engine.stop())
    viewEl.querySelector('.tpd-btn-reset').addEventListener('click', () => TPD.engine.resetStats())

    viewEl.querySelector('.tpd-reason').addEventListener('change', e =>
      TPD.engine.updateSettings({ reason: e.target.value }))
    viewEl.querySelector('.tpd-refresh-every').addEventListener('change', e => {
      const v = e.target.value
      TPD.engine.updateSettings({ refreshEvery: v === 'page' ? 'page' : Number(v) })
    })
    viewEl.querySelector('.tpd-stop-on-error').addEventListener('change', e =>
      TPD.engine.updateSettings({ stopOnError: e.target.checked }))
    viewEl.querySelector('.tpd-delay-mul').addEventListener('change', e =>
      TPD.engine.updateSettings({ delayMultiplier: Number(e.target.value) }))
  }

  async function bootstrap() {
    if (bootstrapped) return
    if (!TARGET_RE.test(location.href)) return
    bootstrapped = true

    const TPD = window.TPD
    if (!TPD || !TPD.engine) {
      console.warn('[price_declare] TPD modules missing; bootstrap aborted')
      return
    }

    await TPD.engine.init()

    // 订阅 engine 状态变化 → 实时刷新 Hub feature view
    TPD.engine.subscribe(updateHubView)

    // 如果用户此时已打开了 price_declare 的 feature view，立即刷新
    const uiState = window.__AgentSellerUI?.getState?.()
    if (uiState?.view === 'feature' && uiState?.feature === 'price_declare') {
      window.__AgentSellerRegistry.renderFeature('price_declare')
    }

    try {
      await TPD.actions.ensureTargetTab('待卖家确认')
    } catch (e) {
      console.warn('[price_declare] ensureTargetTab failed at bootstrap:', e.message || e)
    }
    try {
      await TPD.actions.waitListReady({ timeout: 15000 })
    } catch (e) {
      // 列表未就绪时不阻塞
    }
    await TPD.engine.autoResumeIfNeeded()
  }

  window.AgentSeller.registerFeature({
    id: 'price_declare',
    icon: '💰',
    label: '价格不调整',
    order: 2,
    init() {
      if (document.readyState === 'complete') {
        setTimeout(bootstrap, 800)
      } else {
        window.addEventListener('load', () => setTimeout(bootstrap, 800), { once: true })
      }
      window.AgentSeller.onPageChange(() => {
        if (TARGET_RE.test(location.href) && !bootstrapped) {
          setTimeout(bootstrap, 300)
        }
      })
    },
    render(viewEl) {
      tpdViewEl = viewEl
      const TPD = window.TPD
      const state = TPD?.engine?.getState?.()

      if (!state) {
        // engine 未初始化（还不在目标页面）
        viewEl.innerHTML = `
          <div style="padding:14px;font-size:13px;color:#888;line-height:1.8">
            功能尚未激活，请先访问<br>
            <a href="https://agentseller.temu.com/main/adjust-price-manage/order-price"
               style="color:#fb7701;text-decoration:none;font-size:12px">商品价格申报</a>
          </div>
        `
        return
      }

      buildHubView(viewEl)
      updateHubView(state)
    }
  })
})()
