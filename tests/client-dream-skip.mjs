/**
 * client-dream-skip 纯逻辑测试：skipLabel（文案翻转）/ captureSessionIdFromTarget
 * （会话行操作区捕获 + fiber 读 id）/ retitleLeaf（克隆项文案叶子替换）。
 * 运行：node tests/client-dream-skip.mjs（构建后；内部 esbuild 打包源码保证与 src 同步）。
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
const { skipLabel, captureSessionIdFromTarget, retitleLeaf, setMenuIcon, injectSkipItem, resolveMenuSessionId, SESSION_ROW_SEL, MENU_OPEN_ROW_SEL, SKIP_ITEM_ATTR } = await import(modUrl)

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`FAIL  ${name} ${detail}`) }
}

// ── skipLabel ────────────────────────────────────────────────────────────────
check('label unskipped', skipLabel(false) === '跳过梦境整理记忆')
check('label skipped', skipLabel(true) === '取消跳过梦境整理记忆')

// ── captureSessionIdFromTarget ───────────────────────────────────────────────
// fake 行：带 React fiber 属性 + return 链上第一个带 key 的 fiber（readSessionId 协议）。
// closest(sel)：rowActions 查询返回操作区桩，sessionRow 查询返回行自身。
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

// ── retitleLeaf ──────────────────────────────────────────────────────────────
// 节点桩：叶子（无 children）有固定文本；父节点文本=子节点拼接；set 写 _text 优先返回。
function node(children, text) {
  return {
    children: children ?? [],
    _text: undefined,
    get textContent() {
      if (this._text !== undefined) return this._text
      if (this.children.length === 0) return text ?? ''
      return this.children.map((c) => c.textContent).join('')
    },
    set textContent(v) { this._text = v },
  }
}
const iconLeaf = node(null, '')
const labelLeaf = node(null, '重命名')
const menuItem = node([iconLeaf, labelLeaf])
check('retitle replaces last non-empty leaf', retitleLeaf(menuItem, '跳过梦境整理记忆') === true &&
  labelLeaf.textContent === '跳过梦境整理记忆' && iconLeaf.textContent === '')
check('retitle returns false when no leaf has text', (() => {
  const empty1 = node(null, '')
  const blank2 = node(null, '   ')
  return retitleLeaf(node([empty1, blank2]), 'x') === false && blank2.textContent === '   '
})())

// ── 选择器语义（2026-08-26 根因回归）─────────────────────────────────────────
// 行类按 clsx 顺序拼接（sessionRow, selected, menuOpen…），`[class$=]` 对整个
// class 属性串做结尾匹配——选中行/菜单打开行必然失配，导致注入时灵时不灵。
check('session row selector uses substring match (not end match)', SESSION_ROW_SEL.includes('[class*="_sessionRow"]') && !SESSION_ROW_SEL.includes('class$='))
check('menuOpen row selector uses substring match', MENU_OPEN_ROW_SEL.includes('[class*="_menuOpen"]'))
// issue #8 回归：工作区行（projectRow）同样是 role="treeitem" 且共用 _menuOpen
// 类——menuOpen 锚点必须叠加 _sessionRow 约束，否则工作区菜单被误当会话菜单。
check('menuOpen anchor is constrained to session rows (issue #8)', MENU_OPEN_ROW_SEL.includes('[class*="_sessionRow"]'))

// ── resolveMenuSessionId：menuOpen 行优先；无 menuOpen 会话行一律不注入 ──────
function fakeDoc(openRow) {
  return { querySelector: (sel) => (sel === MENU_OPEN_ROW_SEL ? openRow : null) }
}
const fiberRow = { '__reactFiber$abc': { key: 'sess-open', return: null } }
check('resolve: menuOpen row wins with its fiber key', resolveMenuSessionId(fakeDoc(fiberRow), 'fallback') === 'sess-open')
// issue #8 回归：工作区菜单开着 = 页面上没有 menuOpen 的会话行。即便 1.5s 窗口内
// 刚点过某个会话的 …（captured 有值），也绝不能把该会话 id 注进工作区菜单。
check('resolve: workspace menu open (no session menuOpen row) → null even with captured sid',
  resolveMenuSessionId(fakeDoc(null), 'captured') === null)
check('resolve: null when neither anchor available', resolveMenuSessionId(fakeDoc(null), null) === null)
check('resolve: unreadable menuOpen row falls back to captured sid', resolveMenuSessionId(fakeDoc({}), 'captured') === 'captured')

// ── setMenuIcon（v0.18.0 用户实测纠正）：图标画「点击后将变成的状态」──────────
// 未跳过（当前=false）→ 标签「跳过…」→ 配斜杠月牙（点下去静音）；
// 已跳过（当前=true）→ 标签「取消跳过…」→ 配实心月牙（点下去恢复）。
function fakeItemWithSvg() {
  const svg = { outerHTML: 'old' }
  return {
    svg,
    querySelector(sel) { return sel === 'svg' ? svg : null },
  }
}
const itemUnskipped = fakeItemWithSvg()
setMenuIcon(itemUnskipped, false)
check('menu icon: unskipped row gets slash moon (target state)', itemUnskipped.svg.outerHTML.includes('<mask'))
const itemSkipped = fakeItemWithSvg()
setMenuIcon(itemSkipped, true)
check('menu icon: skipped row gets plain moon (target state)', itemSkipped.svg.outerHTML.includes('<path') && !itemSkipped.svg.outerHTML.includes('<mask'))
const itemNoSvg = { querySelector: () => null }
check('menu icon: no svg template stays text-only', (() => { setMenuIcon(itemNoSvg, false); return true })())

// ── injectSkipItem：幂等 + 容器复用防串味 ────────────────────────────────────
// 菜单项模板桩：node() 提供文本叶子协议；克隆体同构（简化 cloneNode）。
function fakeMenuItem(labelText) {
  const iconLeaf = node(null, '')
  const labelLeaf = node(null, labelText)
  const btn = Object.assign(node([iconLeaf, labelLeaf]), {
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return this.attrs[k] ?? null },
    removeAttribute() {},
    remove() { this.removed = true },
    addEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    cloneNode() { return fakeMenuItem(labelText) }, // 克隆体同构
  })
  btn.labelLeaf = labelLeaf
  return btn
}
function fakeMenu(existingItems) {
  const template = fakeMenuItem('重命名')
  const appended = []
  return {
    template,
    appended,
    existingItems,
    querySelector(sel) { return sel === '[role="menuitem"]' ? template : null },
    querySelectorAll(sel) { return sel.includes(SKIP_ITEM_ATTR) ? existingItems : [] },
    appendChild(el) { appended.push(el) },
  }
}
const noopHost = { onToggle() {} }
// 同会话已注入 → 幂等放弃
const itemA = fakeMenuItem('旧')
itemA.setAttribute(SKIP_ITEM_ATTR, 'true')
itemA.setAttribute('data-meow-session-id', 'A')
const menuSameSid = fakeMenu([itemA])
check('inject idempotent: same-sid item present → no-op', injectSkipItem(menuSameSid, 'A', noopHost) === null && menuSameSid.appended.length === 0 && itemA.removed !== true)
// 别会话残留 → 拆掉重注（portal 容器复用串味防护）
const menuStale = fakeMenu([itemA])
const injected = injectSkipItem(menuStale, 'B', noopHost)
check('inject stale: foreign-sid item removed and fresh one bound to B', itemA.removed === true && menuStale.appended.length === 1 && injected.getAttribute('data-meow-session-id') === 'B')
check('inject fresh item carries skip attr + default label', injected.attrs[SKIP_ITEM_ATTR] === 'true' && injected.labelLeaf.textContent === '跳过梦境整理记忆')
// 空菜单正常注入
const menuEmpty = fakeMenu([])
check('inject empty menu appends one item', injectSkipItem(menuEmpty, 'C', noopHost) !== null && menuEmpty.appended.length === 1)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
