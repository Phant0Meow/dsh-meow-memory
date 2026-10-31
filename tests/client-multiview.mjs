/** #89: use a real DOM/MutationObserver, not a selector stub that can hide cross-view writes. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const { outputFiles } = await build({
  stdin: {
    contents: `export { mountMemoryFoldView } from './src/client.ts';
      export { computeFoldGroups, computeInjectionGroups, memoryTurnNumbers } from './src/client-fold.ts';
      export { startDelegateStateSync } from './src/client-delegate-notice.ts';
      export { pollDreamEventsOnce } from './src/client-dream-events.ts';
      export { setUiLocaleForTest } from './src/i18n/index.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
  // The controller under test is DOM-only. React hooks must never run in this test.
  plugins: [{ name: 'unused-react', setup(b) {
    b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'unused-react', sideEffects: false }))
    b.onLoad({ filter: /.*/, namespace: 'unused-react' }, () => ({ contents:
      `const unused = () => { throw new Error('Unexpected React hook in DOM controller'); };
       export { unused as createElement, unused as useCallback, unused as useEffect,
         unused as useLayoutEffect, unused as useMemo, unused as useRef, unused as useState };` }))
  } }],
})
const api = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'))
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, MutationObserver: dom.window.MutationObserver,
  CSS: { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`) },
})
const wait = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms))
const query = (root, selector) => root.querySelector(selector)
const foldBody = root => query(root, '[data-meow-memory-body]')
const injAnchor = root => query(root, '[data-meow-injection-anchor]')
const noticeLabel = root => query(root, '[data-meow-delegate-bubble]')?.textContent
const hidden = row => row.hasAttribute('data-meow-memory-folded')
let syncDispose
const panes = []
let checks = 0
function check(name, fn) { fn(); checks++; console.log(`PASS: ${name}`) }

function pane(prefix, { shared = false, fallback = false, parent = document.body, empty = false } = {}) {
  const root = document.createElement('section')
  root.setAttribute('data-conversation-scroll', '')
  parent.append(root)
  const flow = document.createElement('div')
  flow.setAttribute('data-chat-flow', '')
  root.append(flow)
  const composer = document.createElement('div')
  composer.setAttribute('data-composer-seat', '')
  composer.innerHTML = '<span data-meow-memory-dock style="display:none"></span>'
  root.append(composer)
  const nodes = new Map()
  const rows = {}
  const key = name => `${shared ? 'shared' : prefix}-${name}`
  const add = (name, turn, kind, data, text) => {
    const id = key(name)
    nodes.set(id, { key: id, kind, location: { kind: 'turn', turn: { turn } }, data })
    if (!(fallback && name === 'injection')) {
      const row = document.createElement('div')
      row.setAttribute('data-chat-flow-key', id)
      row.setAttribute('data-chat-turn', String(turn))
      row.textContent = text
      flow.append(row)
      rows[name] = row
    }
  }
  const context = (text, meta) => ({
    content: [{ type: 'text', text }], time: Date.now(),
    source: { kind: 'plugin:meow-memory', memory: meta },
  })
  if (!empty) {
    add('injection', 1, 'context', context(`${prefix} memory`, { kind: 'initial' }), `${prefix} injection`)
    add('user', 1, 'user', { source: { kind: 'user' } }, `${prefix} question`)
    add('reflect', 2, 'context', context('[meow-memory-reflect]', { kind: 'reflect' }), `${prefix} reflection`)
    add('answer', 2, 'assistant', { status: 'settled', blocks: [] }, `${prefix} answer`)
    add('notice', 3, 'context', context('【记忆整理标记】', { kind: 'dream-marker', sessionId: prefix }), `${prefix} dream`)
  }
  const nav = document.createElement('nav')
  nav.style.setProperty('--turn-rail-inset', '10px')
  nav.innerHTML = '<div style="display:flex"><button aria-label="Turn 2"></button></div>'
  root.append(nav)
  const p = { root, flow, rows, nodes, key, nav, reads: 0, expanded: new Set(), injExpanded: new Set() }
  p.read = () => {
    p.reads++
    const snapshot = { chat: { order: [...p.nodes.keys()], nodes: p.nodes } }
    return {
      snapshot, groups: api.computeFoldGroups(snapshot), injGroups: api.computeInjectionGroups(snapshot),
      memTurns: api.memoryTurnNumbers(snapshot), expanded: p.expanded, injExpanded: p.injExpanded,
      toggle(id) { p.expanded.has(id) ? p.expanded.delete(id) : p.expanded.add(id); p.view.apply() },
      toggleInj(id) { p.injExpanded.has(id) ? p.injExpanded.delete(id) : p.injExpanded.add(id); p.view.apply() },
    }
  }
  p.view = api.mountMemoryFoldView(root, p.read)
  panes.push(p)
  return p
}

try {
  api.setUiLocaleForTest('en')
  const a = pane('main')
  const b = pane('side')
  await wait()
  check('two conversations keep their own injection/fold/delegate bars', () => {
    for (const p of [a, b]) {
      assert.equal(p.flow.querySelectorAll('[data-meow-injection-anchor]').length, 1)
      assert.equal(injAnchor(p.root).getAttribute('data-meow-injection-anchor'), p.key('injection'))
      assert.ok(foldBody(p.root)); assert.match(noticeLabel(p.root), /in progress/)
    }
  })

  // #93：PTC 会话里宿主给聊天流设两级 data-chat-flow 容器（属性值空串），旧实现
  // querySelectorAll 全匹配 → 每层各插一次横条（报告者实测一份内容最多 7 份、
  // 13 个锚点只有 2 个唯一 id）。作用域化后 chatFlows 只保留最外层容器：
  // 内层零锚点、外层无重复。
  const ptc = pane('ptc')
  const innerFlow = document.createElement('div')
  innerFlow.setAttribute('data-chat-flow', '')
  innerFlow.setAttribute('data-step-process-content', '')
  ptc.flow.append(innerFlow)
  const innerFlow2 = document.createElement('div')
  innerFlow2.setAttribute('data-chat-flow', '')
  innerFlow2.setAttribute('data-step-process-content', '')
  ptc.flow.append(innerFlow2)
  await wait()
  check('nested same-view flow containers get no duplicate bars (#93)', () => {
    assert.equal(ptc.flow.querySelectorAll('[data-meow-injection-anchor]').length, 1)
    assert.equal(innerFlow.querySelectorAll('[data-meow-injection-anchor]').length, 0)
    assert.equal(innerFlow2.querySelectorAll('[data-meow-injection-anchor]').length, 0)
    assert.equal(ptc.flow.querySelectorAll('[data-meow-memory-anchor]').length, 1)
    assert.equal(innerFlow.querySelectorAll('[data-meow-memory-anchor]').length, 0)
    assert.equal(innerFlow2.querySelectorAll('[data-meow-memory-anchor]').length, 0)
  })
  let mutations = 0
  const watch = new MutationObserver(records => { mutations += records.length })
  watch.observe(document.body, { childList: true, characterData: true, subtree: true })
  await wait(400)
  check('no self-sustaining mutations after initial rendering', () => assert.equal(mutations, 0))
  watch.disconnect()
  const bReads = b.reads
  a.rows.user.append(' streaming')
  await wait()
  check('sibling streaming does not wake the other observer', () => assert.equal(b.reads, bReads))

  const plain = pane('plain', { empty: true })
  plain.flow.innerHTML = '<div data-chat-turn="1">ordinary message</div>'
  const fallback = pane('fallback', { fallback: true })
  await wait()
  check('legacy turn fallback stays inside its own view and leaves user row visible', () => {
    assert.ok(injAnchor(fallback.root)); assert.equal(hidden(fallback.rows.user), false)
    assert.equal(injAnchor(plain.root), null)
    assert.equal(query(plain.nav, 'div').style.display, 'flex')
  })

  const x = pane('fork-a', { shared: true })
  const y = pane('fork-b', { shared: true })
  query(x.root, '[data-meow-memory-anchor] > button').click()
  check('expanding a shared key populates only the clicked view', () => {
    assert.match(foldBody(x.root).textContent, /fork-a answer/)
    assert.equal(foldBody(y.root).style.display, 'none')
    assert.equal(foldBody(y.root).textContent, '')
  })
  query(y.root, '[data-meow-memory-anchor] > button').click()
  check('each view has its own clone signature and contents', () => {
    assert.match(foldBody(y.root).textContent, /fork-b answer/)
    assert.doesNotMatch(foldBody(y.root).textContent, /fork-a/)
  })
  x.rows.answer.firstChild.data = 'fork-a streaming tail'
  await wait()
  check('text-node streaming refreshes only the matching expanded card', () => {
    assert.match(foldBody(x.root).textContent, /streaming tail/)
    assert.doesNotMatch(foldBody(y.root).textContent, /streaming tail/)
  })
  query(x.root, '[data-meow-memory-anchor] > button').click()
  check('collapse does not collapse a shared key in another view', () => {
    assert.equal(foldBody(x.root).style.display, 'none')
    assert.equal(foldBody(y.root).style.display, 'block')
  })
  // A rebuilt empty card with unchanged source text must not reuse the old card's cache.
  query(y.root, '[data-meow-memory-anchor]').remove()
  await wait()
  check('recreated expanded card is repopulated even when source text is unchanged', () =>
    assert.match(foldBody(y.root).textContent, /fork-b answer/))

  const detail = document.createElement('div')
  detail.setAttribute('data-chat-flow', '')
  detail.innerHTML = '<div data-chat-turn="1">nested thinking detail</div>'
  y.flow.append(detail)
  await wait()
  check('thinking/tool detail flows are not treated as additional conversations', () => {
    assert.equal(detail.querySelector('[data-meow-injection-anchor]'), null)
    assert.equal(detail.textContent, 'nested thinking detail')
  })

  const nested = pane('nested', { shared: true, parent: x.flow })
  await wait()
  check('nested conversation is excluded from parent flow operations', () => {
    assert.equal(nested.flow.querySelectorAll('[data-meow-injection-anchor]').length, 1)
    assert.equal(foldBody(nested.root).style.display, 'none')
    assert.equal(nested.rows.user.textContent, 'nested question')
  })
  const preserved = nested.flow.innerHTML
  x.view.dispose()
  await wait()
  check('unmount restores only its own rows, navigation and bars', () => {
    assert.equal(nested.flow.innerHTML, preserved)
    assert.equal(hidden(x.rows.reflect), false)
    assert.equal(query(x.nav, 'div').style.display, 'flex')
    assert.equal(x.rows.notice.hasAttribute('data-meow-delegate-hidden'), false)
  })

  // Empty snapshot on the same DOM represents session switching / compaction.
  a.nodes = new Map()
  a.view.apply()
  check('switching to an empty snapshot restores rows and navigation without touching others', () => {
    assert.equal(injAnchor(a.root), null)
    assert.equal(hidden(a.rows.injection), false)
    assert.equal(hidden(a.rows.reflect), false)
    assert.equal(query(a.nav, 'div').style.display, 'flex')
    assert.ok(injAnchor(b.root))
  })
  // Chat -> trajectory -> chat: the stable scroll root outlives the flow.
  b.flow.remove()
  await wait()
  b.flow = document.createElement('div')
  b.flow.setAttribute('data-chat-flow', '')
  for (const row of Object.values(b.rows)) b.flow.append(row.cloneNode(true))
  b.root.prepend(b.flow)
  await wait()
  check('replacing the message flow is detected without observing document.body', () => {
    assert.ok(injAnchor(b.root)); assert.ok(foldBody(b.root))
  })
  api.setUiLocaleForTest('zh')
  check('locale replay updates all mounted views with their own state', () => {
    assert.match(noticeLabel(b.root), /进行中/)
    assert.match(noticeLabel(y.root), /进行中/)
    assert.equal(query(x.flow, ':scope > [data-meow-delegate-anchor]'), null)
  })

  let states = { sessionIds: [], dreamingIds: ['side', 'fork-b'] }
  globalThis.fetch = async url => ({ ok: true, json: async () => url.endsWith('/skip-dreams') ? { sessionIds: [] } : states })
  syncDispose = api.startDelegateStateSync()
  await wait()
  states = { sessionIds: ['side'], dreamingIds: ['fork-b'] }
  await api.pollDreamEventsOnce()
  check('background state changes recompute each view rather than replaying the last groups', () => {
    assert.match(noticeLabel(b.root), /已完成/)
    assert.match(noticeLabel(y.root), /进行中/)
    assert.equal(injAnchor(a.root), null)
  })
  const readsBefore = x.reads
  api.setUiLocaleForTest('en')
  states = { sessionIds: ['side', 'fork-b'], dreamingIds: [] }
  await api.pollDreamEventsOnce()
  await wait()
  check('disposed view is unsubscribed from state/locale/mutation replay', () => assert.equal(x.reads, readsBefore))
  check('remaining view still receives state updates', () => assert.match(noticeLabel(y.root), /completed/))

  // Final idle period includes open cards, nested panes and background replay.
  mutations = 0
  watch.observe(document.body, { childList: true, characterData: true, subtree: true })
  await wait(400)
  check('all replay paths converge to an idle DOM', () => assert.equal(mutations, 0))
  watch.disconnect()
  console.log(`\nALL ${checks} MULTIVIEW CHECKS PASSED`)
} finally {
  syncDispose?.()
  for (const p of panes) p.view.dispose()
  dom.window.close()
}
