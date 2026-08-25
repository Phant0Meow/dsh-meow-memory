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
const { skipLabel, captureSessionIdFromTarget, retitleLeaf, SKIP_ITEM_ATTR, SKIP_MENU_ATTR } = await import(modUrl)

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

check('marker attrs exported', SKIP_ITEM_ATTR === 'data-meow-skip-item' && SKIP_MENU_ATTR === 'data-meow-skip-sid')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
