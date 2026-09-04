/**
 * client-delegate-vanish 纯逻辑测试：isMeowDelegateLabel / computeVanishDecision /
 * indexSubagentDescendantCount / vanishRows / locateLineageRoot / applyTriggerVisibility。
 * 运行：node tests/client-delegate-vanish.mjs（内部 esbuild 打包源码保证与 src 同步）。
 * DOM 部分用手写最小桩（项目无 jsdom，覆盖模块实际用到的接口面）。
 */
import { build } from 'esbuild'

async function bundleSrc(entry) {
  const { outputFiles } = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  })
  const code = new TextDecoder().decode(outputFiles[0].contents)
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}

const {
  isMeowDelegateLabel,
  computeVanishDecision,
  indexSubagentDescendantCount,
  vanishRows,
  locateLineageRoot,
  applyTriggerVisibility,
  applyVanishDom,
} = await bundleSrc('src/client-delegate-vanish.ts')

let failures = 0
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`)
  if (!cond) failures++
}

// ---- 桩：最小元素 ----
function fakeEl({ classes = '', attrs = {}, children = [], parent = null } = {}) {
  const el = {
    className: classes,
    attrs: { ...attrs },
    children,
    parentElement: parent,
    style: {},
    getAttribute(key) {
      return Object.prototype.hasOwnProperty.call(el.attrs, key) ? el.attrs[key] : null
    },
    setAttribute(key, value) {
      el.attrs[key] = String(value)
    },
    removeAttribute(key) {
      delete el.attrs[key]
    },
    contains(node) {
      if (node === null || node === undefined) return false
      for (const child of el.children) {
        if (child === node || child.contains(node)) return true
      }
      return false
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] ?? null
    },
    querySelectorAll(selector) {
      // 只实现模块用到的两种选择器（:scope [class*="_x"]），其余返回空。
      const m = /^:scope \[class\*="(_[^"]+)"\]$/.exec(selector)
      if (m === null) return []
      const needle = m[1]
      const hits = []
      const walk = (list) => {
        for (const child of list) {
          if (typeof child.className === 'string' && child.className.includes(needle)) hits.push(child)
          walk(child.children ?? [])
        }
      }
      walk(el.children)
      return hits
    },
  }
  return el
}

// ---- 1. label 识别 ----
console.log('=== 1. isMeowDelegateLabel ===')
check('reflect label 命中', isMeowDelegateLabel('meow-memory reflect') === true)
check('dream 组 label 命中', isMeowDelegateLabel('meow-memory dream 2/3') === true)
check('aria-label 带后缀命中（行 secondary/metrics）', isMeowDelegateLabel('meow-memory reflect · one-shot · inactive · 1.2k tok') === true)
check('非字符串不命中', isMeowDelegateLabel(undefined) === false && isMeowDelegateLabel(42) === false)
check('用户手动子代理 label 不命中', isMeowDelegateLabel('帮我调研一下 dsh 插件生态') === false)
check('前缀近似串不命中（meow-memoryx）', isMeowDelegateLabel('meow-memoryx 任务') === false)

// ---- 2. 谱系计数 ----
console.log('=== 2. indexSubagentDescendantCount ===')
{
  const byId = {
    root: { id: 'root', origin: undefined },
    child: { id: 'child', origin: 'subagent', parentId: 'root' },
    grand: { id: 'grand', origin: 'subagent', parentId: 'child' },
    other: { id: 'other', origin: 'subagent', parentId: 'another-root' },
  }
  check('root 谱系含子+孙', indexSubagentDescendantCount(byId, 'root') === 2)
  check('无子代理的会话为 0', indexSubagentDescendantCount(byId, 'blank') === 0)
  check('byId 缺省为 0', indexSubagentDescendantCount(undefined, 'root') === 0)
  check('root 缺省为 0', indexSubagentDescendantCount(byId, undefined) === 0)
  const cyclic = { a: { id: 'a', origin: 'subagent', parentId: 'b' }, b: { id: 'b', origin: 'subagent', parentId: 'a' } }
  check('环不炸（返回有限值）', Number.isFinite(indexSubagentDescendantCount(cyclic, 'a')))
}

// ---- 3. 决策矩阵 ----
console.log('=== 3. computeVanishDecision ===')
function catalogOf(state, entriesState, entries) {
  return {
    current: 'root',
    byId: state?.byId,
    subagentsByParent: { root: { state: entriesState, entries } },
  }
}
const MINE = { kind: 'child', id: 's1', label: 'meow-memory reflect', activity: 'inactive' }
const MINE_RUNNING = { kind: 'child', id: 's2', label: 'meow-memory dream 1/2', activity: 'running' }
const OTHER = { kind: 'child', id: 'u1', label: '帮我调研插件生态', activity: 'running' }

check('state 缺省 → fail-open', computeVanishDecision(undefined).known === false)
check('current 缺省 → fail-open', computeVanishDecision({}).known === false)
check('catalog 未加载 → fail-open', computeVanishDecision(catalogOf(undefined, undefined, [])).known === false)
check('catalog loading → fail-open', computeVanishDecision(catalogOf(undefined, 'loading', [])).known === false)
check('catalog error → fail-open', computeVanishDecision(catalogOf(undefined, 'error', [])).known === false)
{
  const d = computeVanishDecision(catalogOf(undefined, 'ready', [MINE, MINE_RUNNING]))
  check('只有我们家（含 running）→ 藏 trigger', d.known === true && d.hideTrigger === true && d.mineCount === 2 && d.othersCount === 0)
}
{
  const d = computeVanishDecision(catalogOf(undefined, 'ready', [MINE, OTHER]))
  check('有别人家 → trigger 保留', d.known === true && d.hideTrigger === false && d.othersCount === 1)
}
{
  const d = computeVanishDecision(catalogOf(undefined, 'ready', []))
  check('空目录 → 不藏（无人可隐）', d.known === true && d.hideTrigger === false && d.mineCount === 0)
}
{
  // 谱系兜底：catalog 只列直接子代，byId 里另有孙辈（非 delegate）→ 不藏。
  const state = catalogOf({ byId: { root: { id: 'root' }, s1: { id: 's1', origin: 'subagent', parentId: 'root' }, grand: { id: 'grand', origin: 'subagent', parentId: 's1' } } }, 'ready', [MINE])
  const d = computeVanishDecision(state)
  check('谱系计数超出条目数（有孙辈）→ trigger 保留', d.hideTrigger === false)
}
{
  // 谱系一致（delegate 无下一代）→ 照常隐藏。
  const state = catalogOf({ byId: { root: { id: 'root' }, s1: { id: 's1', origin: 'subagent', parentId: 'root' } } }, 'ready', [MINE])
  const d = computeVanishDecision(state)
  check('谱系与条目一致 → 藏 trigger', d.hideTrigger === true)
}
{
  // diagnostic 条目（kind!=='child'）不计入。
  const d = computeVanishDecision(catalogOf(undefined, 'ready', [{ kind: 'diagnostic', id: 'x', reason: 'corrupt' }, MINE]))
  check('diagnostic 条目不计入', d.hideTrigger === true && d.mineCount === 1 && d.othersCount === 0)
}

// ---- 4. 行隐藏（DOM 桩） ----
console.log('=== 4. vanishRows ===')
{
  const rows = [
    fakeEl({ attrs: { role: 'treeitem', 'aria-label': 'meow-memory reflect · one-shot · inactive' } }),
    fakeEl({ attrs: { role: 'treeitem', 'aria-label': '帮我调研插件生态 · continuable · running' } }),
    fakeEl({ attrs: { role: 'treeitem' } }),
  ]
  globalThis.document = { querySelectorAll: (sel) => (sel === '[role="treeitem"]' ? rows : []) }
  vanishRows()
  check('delegate 行被隐藏', rows[0].style.display === 'none' && rows[0].getAttribute('data-meow-vanish-row') === '1')
  check('他人行不受影响（未被隐藏）', rows[1].style.display !== 'none' && rows[1].getAttribute('data-meow-vanish-row') === null)
  check('无 aria-label 行不受影响（未被隐藏）', rows[2].style.display !== 'none')
  // 失配恢复：同一行 aria-label 变成别人家（例如官方重渲染）→ 恢复显示。
  rows[0].attrs['aria-label'] = '帮我调研插件生态 · continuable · running'
  vanishRows()
  check('失配行恢复显示', rows[0].style.display === '' && rows[0].getAttribute('data-meow-vanish-row') === null)
  // 幂等：重复应用不抖动。
  rows[0].attrs['aria-label'] = 'meow-memory dream 1/3 · one-shot · running'
  vanishRows()
  const displayAfterFirst = rows[0].style.display
  vanishRows()
  check('重复应用幂等', rows[0].style.display === displayAfterFirst && displayAfterFirst === 'none')
}

// ---- 5. trigger 定位与显隐（DOM 桩） ----
console.log('=== 5. locateLineageRoot / applyTriggerVisibility ===')
{
  const trigger = fakeEl({ classes: 'ZKlsPq_trigger' })
  const rootEl = fakeEl({ classes: 'ZKlsPq_root', children: [trigger] })
  const cell = fakeEl({ children: [rootEl] })
  const sentinel = fakeEl({ attrs: { 'data-meow-vanish': '1' }, parent: cell })
  const found = locateLineageRoot(sentinel)
  check('从哨兵定位到 lineage root', found === rootEl)

  applyTriggerVisibility(found, true)
  check('决策藏 trigger', trigger.style.display === 'none')
  applyTriggerVisibility(found, true)
  check('重复写幂等', trigger.style.display === 'none')
  applyTriggerVisibility(found, false)
  check('决策显 trigger（恢复空串而非 inline）', trigger.style.display === '')
  applyTriggerVisibility(null, true)
  check('root 缺省安全（不炸）', true)

  // switcher trigger 不误中：root 内只有 _switcherTrigger（大写 T）时 querySelector 不命中。
  const switcherOnly = fakeEl({ classes: 'ZKlsPq_root', children: [fakeEl({ classes: 'ZKlsPq_switcherTrigger' })] })
  const cell2 = fakeEl({ children: [switcherOnly] })
  const sentinel2 = fakeEl({ attrs: { 'data-meow-vanish': '1' }, parent: cell2 })
  check('switcher-only 结构定位返回 null（fail-open）', locateLineageRoot(sentinel2) === null)
}

// ---- 6. applyVanishDom 异常安全 ----
console.log('=== 6. applyVanishDom fail-open ===')
{
  const originalDocument = globalThis.document
  globalThis.document = {
    querySelectorAll() {
      throw new Error('boom')
    },
  }
  let warned = false
  const originalWarn = console.warn
  console.warn = () => {
    warned = true
  }
  try {
    applyVanishDom({ known: true, hideTrigger: true, mineCount: 1, othersCount: 0 }, null)
  } finally {
    console.warn = originalWarn
    globalThis.document = originalDocument
  }
  check('DOM 异常不冒泡且告警', warned === true)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
