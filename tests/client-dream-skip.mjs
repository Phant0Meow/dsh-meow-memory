/**
 * client-dream-skip 纯逻辑测试（v0.30.0 三档门控 + 面板交互，issue #38/#28）：
 * participationState / participationLabel（状态汇总与文案）/
 * captureSessionIdFromTarget（会话行操作区捕获 + fiber 读 id）/
 * retitleLeaf（克隆项文案叶子替换）/ injectSkipItem（启动项注入 + 面板打开回调）。
 * 运行：node tests/client-dream-skip.mjs（内部 esbuild 打包源码保证与 src 同步）。
 */
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: ['src/client-dream-skip.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})
const code = new TextDecoder().decode(outputFiles[0].contents)
const modUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const { participationState, participationLabel, captureSessionIdFromTarget, retitleLeaf, injectSkipItem, resolveMenuSessionId, SESSION_ROW_SEL, MENU_OPEN_ROW_SEL, SKIP_ITEM_ATTR, setUiLocaleForTest } = await import(modUrl)

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`FAIL  ${name} ${detail}`) }
}

// ── participationState（三档组合 → 状态名；预设给专名，混合给 custom） ──────────
const OFF = { dream: false, inject: false, write: false }
check('state: all off → active', participationState(OFF) === 'active')
check('state: all on → exited', participationState({ dream: true, inject: true, write: true }) === 'exited')
check('state: inject only → readonly', participationState({ dream: false, inject: true, write: false }) === 'readonly')
check('state: dream only → noConsolidation', participationState({ dream: true, inject: false, write: false }) === 'noConsolidation')
check('state: write only → noWrite', participationState({ dream: false, inject: false, write: true }) === 'noWrite')
check('state: mixed → custom', participationState({ dream: true, inject: true, write: false }) === 'custom' &&
  participationState({ dream: false, inject: true, write: true }) === 'custom')

// ── participationLabel（主文案 + 状态后缀；三语；active 无后缀） ───────────────
setUiLocaleForTest('zh')
check('label: zh active = main only', participationLabel(OFF) === '记忆参与')
check('label: zh exited suffix', participationLabel({ dream: true, inject: true, write: true }) === '记忆参与 · 已退出')
setUiLocaleForTest('en')
check('label: en readonly suffix', participationLabel({ dream: false, inject: true, write: false }) === 'Memory participation · Do not disturb')
check('label: en noWrite suffix', participationLabel({ dream: false, inject: false, write: true }) === 'Memory participation · Writes off')
setUiLocaleForTest('pt-br')
check('label: pt-br exited suffix', participationLabel({ dream: true, inject: true, write: true }) === 'Participação de memória · Encerrada')
setUiLocaleForTest('zh')

// ── captureSessionIdFromTarget（与 v0.18.0 协议一致） ────────────────────────
function fakeRow(fiberKey) {
  const row = {}
  if (fiberKey !== null) row['__reactFiber$abc123'] = { return: { key: fiberKey } }
  row.closest = (sel) => (sel.includes('sessionRow') ? row : null)
  return row
}
function fakeTarget({ hasActions = true, rowFiber = 'session-abc' } = {}) {
  const row = fakeRow(rowFiber)
  return {
    closest: (sel) => {
      if (sel.includes('rowActions')) return hasActions ? {} : null
      if (sel.includes('sessionRow')) return row
      return null
    },
  }
}
check('capture from ellipsis target', captureSessionIdFromTarget(fakeTarget()) === 'session-abc')
check('capture null for row body (no rowActions)', captureSessionIdFromTarget(fakeTarget({ hasActions: false })) === null)
check('capture null for non-element target', captureSessionIdFromTarget(null) === null &&
  captureSessionIdFromTarget('text') === null)
check('capture null when row has no fiber', captureSessionIdFromTarget(fakeTarget({ rowFiber: null })) === null)

// ── retitleLeaf ───────────────────────────────────────────────────────────────
{
  const menuItem = { children: [{ children: [], textContent: 'old' }], textContent: 'old' }
  check('retitle replaces last non-empty leaf', retitleLeaf(menuItem, '记忆参与 · 已退出') === true &&
    menuItem.children[0].textContent === '记忆参与 · 已退出')
  const empty = { children: [{ children: [], textContent: '  ' }], textContent: '' }
  check('retitle returns false when no leaf has text', retitleLeaf(empty, 'x') === false)
}

// ── selectors（issue #8 回归） ────────────────────────────────────────────────
check('session row selector uses substring match (not end match)', SESSION_ROW_SEL.includes('[class*="_sessionRow"]') && !SESSION_ROW_SEL.includes('class$='))
check('menuOpen row selector uses substring match', MENU_OPEN_ROW_SEL.includes('[class*="_menuOpen"]'))
check('menuOpen anchor is constrained to session rows (issue #8)', MENU_OPEN_ROW_SEL.includes('[class*="_sessionRow"]'))

// ── resolveMenuSessionId ──────────────────────────────────────────────────────
function fiberRow(key) { return { __reactFiber$xyz: { return: { key } } } }
function fakeDoc(row) { return { querySelector: () => row } }
check('resolve: menuOpen row wins with its fiber key', resolveMenuSessionId(fakeDoc(fiberRow('sess-open')), 'fallback') === 'sess-open')
check('resolve: workspace menu open (no session menuOpen row) → null even with captured sid',
  resolveMenuSessionId(fakeDoc(null), 'captured') === null)
check('resolve: null when neither anchor available', resolveMenuSessionId(fakeDoc(null), null) === null)
check('resolve: unreadable menuOpen row falls back to captured sid', resolveMenuSessionId(fakeDoc({}), 'captured') === 'captured')

// ── injectSkipItem：注入 + 打开面板回调（v0.30.0：点击不再直接翻转） ───────────
function fakeMenu() {
  const appended = []
  const template = asElement() // cloneNode 等 injectSkipItem 依赖面由元素桩提供
  return {
    appended,
    querySelector: (sel) => (sel === '[role="menuitem"]' ? template : null),
    querySelectorAll: (sel) => (sel.includes('data-meow-skip-item') ? [...appended] : []),
    appendChild: (el) => appended.push(el),
  }
}
/** injectSkipItem 依赖面的最小元素桩（cloneNode/querySelector/attrs/listeners…）。 */
function asElement() {
  const listeners = {}
  const el = {
    removed: false,
    attrs: {},
    children: [{ children: [], textContent: 'native item' }],
    listeners,
    cloneNode() { return asElement() },
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute(k, v) { el.attrs[k] = v },
    getAttribute(k) { return el.attrs[k] ?? null },
    removeAttribute() {},
    remove() { el.removed = true },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn) },
    removeEventListener() {},
    appendChild() {},
    append() {},
    closest: () => null,
    style: {},
  }
  return el
}

{
  const menu = fakeMenu()
  const opened = []
  const item = injectSkipItem(menu, 'A', { onOpen: (sid) => opened.push(sid) })
  check('inject: item appended with attr + bound sid', item !== null && item.attrs[SKIP_ITEM_ATTR] === 'true' && item.attrs['data-meow-session-id'] === 'A')
  check('inject: label carries active state (no suffix)', item.children[0].textContent === '记忆参与')
  const click = (item.listeners.click ?? [])[0]
  check('inject: click handler registered (capture)', typeof click === 'function')
  click({ stopPropagation() {}, preventDefault() {} })
  check('inject: click opens panel (not direct toggle)', opened.length === 1 && opened[0] === 'A')
}
{
  // 幂等/串味回归（与 v0.18.0 同协议）
  const menuSameSid = fakeMenu()
  const first = injectSkipItem(menuSameSid, 'A', { onOpen: () => {} })
  const second = injectSkipItem(menuSameSid, 'A', { onOpen: () => {} })
  check('inject idempotent: same-sid item present → no-op', second === null && menuSameSid.appended.length === 1 && first.removed !== true)

  const menuStale = fakeMenu()
  const stale = asElement()
  stale.attrs[SKIP_ITEM_ATTR] = 'true'
  stale.attrs['data-meow-session-id'] = 'A'
  menuStale.querySelectorAll = (sel) => (sel === `[${SKIP_ITEM_ATTR}]` ? [stale] : [])
  const fresh = injectSkipItem(menuStale, 'B', { onOpen: () => {} })
  check('inject stale: foreign-sid item removed and fresh one bound to B', stale.removed === true && menuStale.appended.length === 1 && fresh.attrs['data-meow-session-id'] === 'B')

  const menuEmpty = { querySelector: () => null, querySelectorAll: () => [], appendChild: () => {} }
  check('inject: template-less menu returns null (retry later)', injectSkipItem(menuEmpty, 'C', { onOpen: () => {} }) === null)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
