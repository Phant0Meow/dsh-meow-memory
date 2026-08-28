/**
 * client-dream-icon 纯逻辑测试：readSessionId（React fiber key 读取）/
 * applyDreamIcons（状态槽位替换 + 三态幂等）/ mergeIconStates（v0.18.0 三态优先级）。
 * 运行：node tests/client-dream-icon.mjs（构建后；内部 esbuild 打包源码保证与 src 同步）。
 */
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: ['src/client-dream-icon.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})
const code = new TextDecoder().decode(outputFiles[0].contents)
const modUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const { readSessionId, applyDreamIcons, mergeIconStates, makeSkipMoonSvg, SESSION_ROWS_SEL, DREAM_ICON_ATTR, DREAMING_ATTR, SKIPPED_ATTR } = await import(modUrl)

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`FAIL  ${name} ${detail}`) }
}

// ── document stub：applyDreamIcons 里 createElement('span') 用 ──────────────
globalThis.document = {
  createElement: () => {
    const el = {
      attrs: {},
      innerHTML: '',
      setAttribute(k, v) { this.attrs[k] = String(v) },
      getAttribute(k) { return this.attrs[k] ?? null },
      hasAttribute(k) { return Object.hasOwn(this.attrs, k) },
      remove() { if (this._container) this._container.children = this._container.children.filter((c) => c !== this) },
    }
    return el
  },
}

/** 我们图标的三个标记属性（applyDreamIcons 的 OR 选择器全量包含）。 */
const MEOW_ICON_ATTRS = ['data-meow-dreamed', 'data-meow-dreaming', 'data-meow-skip-dream']

/** 在 children 里按逗号选择器找我们的图标（模拟 querySelector 的多属性 OR 语义）。 */
function findIcon(children, sel) {
  return children.find((el) =>
    MEOW_ICON_ATTRS.some((a) => sel.includes(a) && el.attrs?.[a] === 'true'),
  ) ?? null
}

/** 造一个状态槽位 fake（16×20 slot：children + querySelector + replaceChildren）。 */
function fakeSlot(initial = []) {
  const slot = {
    children: [],
    querySelector(sel) { return findIcon(slot.children, sel) },
    replaceChildren(...els) {
      slot.children = []
      for (const el of els) { el._container = slot; slot.children.push(el) }
    },
    remove() {},
  }
  for (const el of initial) {
    el._container = slot
    el.remove = () => { slot.children = slot.children.filter((c) => c !== el) }
    slot.children.push(el)
  }
  return slot
}

/** 造一个会话行 fake（挂 React fiber；含状态槽位；无槽位时用 hasSlot=false）。 */
function fakeRow(fiber, { slotChildren = [], hasSlot = true } = {}) {
  const row = { firstChild: null, children: [] }
  if (fiber !== null) row['__reactFiber$abc123'] = fiber
  row.slot = hasSlot ? fakeSlot(slotChildren) : null
  row.querySelector = (sel) => {
    if (sel === '[class$="_slot"]') return row.slot
    if (MEOW_ICON_ATTRS.some((a) => sel.includes(a))) {
      if (row.slot !== null) {
        const inSlot = findIcon(row.slot.children, sel)
        if (inSlot !== null) return inSlot
      }
      return findIcon(row.children, sel)
    }
    return null
  }
  row.insertBefore = (node, _ref) => {
    node._container = row
    node.remove = () => { row.children = row.children.filter((c) => c !== node) }
    row.children.unshift(node)
    row.firstChild = node
  }
  return row
}

// ── readSessionId：React fiber key 读取 ──────────────────────────────────────
// 行选择器必须子串匹配：选中/菜单打开行带尾随类，结尾匹配会失配丢图标（v0.18.0）。
check('row selector uses substring match (selected/menuOpen rows survive)', SESSION_ROWS_SEL.includes('[class*="_sessionRow"]') && !SESSION_ROWS_SEL.includes('class$='))
check('readSessionId: direct fiber key', readSessionId(fakeRow({ key: 'session-1', return: null })) === 'session-1')
check('readSessionId: skips empty key up the chain', readSessionId(fakeRow({ key: '', return: { key: 'session-2', return: null } })) === 'session-2')
// dsh 真实结构：行 div fiber（无 key）→ SessionNodeItem fiber（key=session id）→ 组 div fiber（key=workspace id）
const dshChain = {
  key: null, return: {
    key: 'session-x', return: { key: 'workspace-y', return: null },
  },
}
check('readSessionId: real dsh chain returns session key (before workspace key)', readSessionId(fakeRow(dshChain)) === 'session-x')
check('readSessionId: no fiber property → null', readSessionId(fakeRow(null)) === null)
check('readSessionId: chain without any string key → null', readSessionId(fakeRow({ key: 42, return: { key: null, return: null } })) === null)

// ── applyDreamIcons：状态槽位替换 / 三态 / 幂等 ─────────────────────────────
// dreamed：图标进 slot（替换原内容），行级零新增（标题零位移）
const rowDreamed = fakeRow({ key: 'session-a', return: null }, { slotChildren: [{ attrs: {}, remove() {} }] }) // slot 里原有 dsh 状态点
applyDreamIcons(new Map([['session-a', 'dreamed']]), [rowDreamed])
check('apply: dreamed icon goes into slot (replaces dsh dot)', rowDreamed.slot.children.length === 1 && rowDreamed.slot.children[0].attrs[DREAM_ICON_ATTR] === 'true' && rowDreamed.children.length === 0)
check('apply: moon svg inside icon', rowDreamed.slot.children[0].innerHTML.includes('<svg'))
// dreaming：呼吸灯属性 + 替换原内容
const rowDreaming = fakeRow({ key: 'session-b', return: null }, { slotChildren: [{ attrs: {}, remove() {} }] })
applyDreamIcons(new Map([['session-b', 'dreaming']]), [rowDreaming])
check('apply: dreaming icon has breathing attr', rowDreaming.slot.children.length === 1 && rowDreaming.slot.children[0].attrs[DREAMING_ATTR] === 'true' && rowDreaming.slot.children[0].attrs[DREAM_ICON_ATTR] === undefined)
// 幂等：同状态重跑不重建
const iconBefore = rowDreamed.slot.children[0]
applyDreamIcons(new Map([['session-a', 'dreamed']]), [rowDreamed])
check('apply idempotent: same icon element kept', rowDreamed.slot.children[0] === iconBefore)
// 状态切换 dreamed → dreaming：图标属性更新
applyDreamIcons(new Map([['session-a', 'dreaming']]), [rowDreamed])
check('apply: state switch dreamed→dreaming swaps attr', rowDreamed.slot.children[0].attrs[DREAMING_ATTR] === 'true' && rowDreamed.slot.children[0].attrs[DREAM_ICON_ATTR] === undefined)
// 状态消失 → 图标移除（slot 恢复空）
applyDreamIcons(new Map(), [rowDreamed])
check('apply: state gone → icon removed from slot', rowDreamed.slot.children.length === 0)
// 无状态槽位（flat 无状态视图）→ 行首内联
const rowFlat = fakeRow({ key: 'session-f', return: null }, { hasSlot: false })
applyDreamIcons(new Map([['session-f', 'dreamed']]), [rowFlat])
check('apply: no-slot row gets inline icon at row start', rowFlat.children.length === 1 && rowFlat.firstChild === rowFlat.children[0] && rowFlat.children[0].attrs[DREAM_ICON_ATTR] === 'true' && rowFlat.children[0].attrs['data-meow-inline-icon'] === 'true')
// 无 fiber → 不动
const rowNoId = fakeRow(null)
applyDreamIcons(new Map([['whatever', 'dreamed']]), [rowNoId])
check('apply: row without fiber id untouched', rowNoId.slot.children.length === 0 && rowNoId.children.length === 0)
// 非目标行（不在状态表）→ 移除已有图标
const rowStale = fakeRow({ key: 'session-old', return: null }, { slotChildren: [{ attrs: { [DREAM_ICON_ATTR]: 'true' }, remove() {} }] })
applyDreamIcons(new Map(), [rowStale])
check('apply: stale icon removed when not in states', rowStale.slot.children.length === 0)

// ── v0.18.0：skipped 第三态（月牙+斜杠）与 mergeIconStates 优先级 ────────────
check('skip svg: mask cutout + unique mask id per call', (() => {
  const a = makeSkipMoonSvg(); const b = makeSkipMoonSvg()
  return a.includes('<mask') && a.includes('mask="url(#') && a !== b
})())
// skipped：图标进 slot，带 skip 属性与挖缝 SVG
const rowSkipped = fakeRow({ key: 'session-s', return: null }, { slotChildren: [{ attrs: {}, remove() {} }] })
applyDreamIcons(new Map([['session-s', 'skipped']]), [rowSkipped])
check('apply: skipped icon into slot with skip attr', rowSkipped.slot.children.length === 1 && rowSkipped.slot.children[0].attrs[SKIPPED_ATTR] === 'true' && String(rowSkipped.slot.children[0].innerHTML).includes('<mask'))
// 状态切换 dreamed → skipped：属性原地翻转
const rowSwap = fakeRow({ key: 'session-t', return: null }, { slotChildren: [{ attrs: {}, remove() {} }] })
applyDreamIcons(new Map([['session-t', 'dreamed']]), [rowSwap])
applyDreamIcons(new Map([['session-t', 'skipped']]), [rowSwap])
check('apply: dreamed→skipped swaps attr in place', rowSwap.slot.children.length === 1 && rowSwap.slot.children[0].attrs[SKIPPED_ATTR] === 'true' && rowSwap.slot.children[0].attrs[DREAM_ICON_ATTR] === undefined)
// 无槽位行：skipped 也走行首内联
const rowFlatSkip = fakeRow({ key: 'session-fs', return: null }, { hasSlot: false })
applyDreamIcons(new Map([['session-fs', 'skipped']]), [rowFlatSkip])
check('apply: skipped inline icon on flat view', rowFlatSkip.children.length === 1 && rowFlatSkip.children[0].attrs[SKIPPED_ATTR] === 'true')
// 取消跳过 → 图标移除
applyDreamIcons(new Map(), [rowSkipped, rowFlatSkip])
check('apply: skipped icon removed when state gone', rowSkipped.slot.children.length === 0 && rowFlatSkip.children.length === 0)
// mergeIconStates：dreaming > skipped > dreamed
check('merge: dreaming beats skipped', mergeIconStates(new Map([['x', 'dreaming']]), new Set(['x'])).get('x') === 'dreaming')
check('merge: skipped beats dreamed', mergeIconStates(new Map([['y', 'dreamed']]), new Set(['y'])).get('y') === 'skipped')
check('merge: plain skipped stays skipped', mergeIconStates(new Map(), new Set(['z'])).get('z') === 'skipped')
check('merge: untouched session stays absent', !mergeIconStates(new Map([['a', 'dreamed']]), new Set(['z'])).has('w'))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
