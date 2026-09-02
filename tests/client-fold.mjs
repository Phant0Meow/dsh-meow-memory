/**
 * client-fold 纯逻辑测试：computeFoldGroups / foldLabel。
 * 运行：node tests/client-fold.mjs（构建后；内部 esbuild 打包源码保证与 src 同步）。
 */
import { build } from 'esbuild'

// 现场 bundle src/client-fold.ts（纯函数模块，无 DOM/react 依赖）→ 内存加载。
const { outputFiles } = await build({
  entryPoints: ['src/client-fold.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})
const code = new TextDecoder().decode(outputFiles[0].contents)
const modUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const { computeFoldGroups, foldLabel, toolCallDetail, blocksToText, computeInjectionGroups, formatInjectionClock } = await import(modUrl)

// ---- mock 快照 ----
function turnLoc(turn) {
  return { kind: 'turn', turn: { turn } }
}
function stepLoc(turn, step) {
  return { kind: 'step', turn: { turn }, step: { step } }
}
function contextNode(key, text, loc, source = { kind: 'plugin', plugin: 'meow-memory' }) {
  return {
    key, kind: 'context', location: loc,
    data: { source, content: [{ type: 'text', text }] },
  }
}
function userNode(key, loc, content, time) {
  return {
    key, kind: 'user', location: loc,
    data: { source: { kind: 'user' }, ...(content ? { content } : {}), ...(time === undefined ? {} : { time }) },
  }
}
function steeringNode(key, loc) {
  return { key, kind: 'steering', location: loc, data: {} }
}
function assistantNode(key, loc, status) {
  return { key, kind: 'assistant', location: loc, data: { status } }
}
function toolNode(key, loc, name) {
  const root = name === null
    ? { kind: 'tool-result', callId: 'c', call: null, content: [] }
    : { callId: 'c', name, argsRaw: '{}', turn: 1, step: 1, time: 0, subCalls: [] }
  return { key, kind: 'tool-call', location: loc, data: { root } }
}
function snapshot(order, nodes, getTurn) {
  return {
    chat: {
      order,
      nodes: { get: (k) => nodes.get(k) },
      locations: { getTurn: (t) => getTurn(t) ?? [] },
    },
  }
}

let failures = 0
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`)
  if (!cond) failures++
}

const REFLECT = '[meow-memory-reflect]\n反思 prompt...'
const DREAM = '[meow-memory-dream]\n整理指令...'

// ---- 1. 识别 + 范围 + 计数（RunningToolCall 形态） ----
console.log('=== 1. 反思轮识别/范围/计数 ===')
{
  const nodes = new Map([
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(5))],
    ['asst-1', assistantNode('asst-1', turnLoc(5), 'settled')],
    ['tool-1', toolNode('tool-1', turnLoc(5), 'memory_remember')],
    ['tool-2', toolNode('tool-2', turnLoc(5), 'memory_remember')],
    ['tool-3', toolNode('tool-3', turnLoc(5), 'memory_update')],
    ['tail-1', { key: 'tail-1', kind: 'turn-tail', location: turnLoc(5), data: { turn: 5 } }],
  ])
  const s = snapshot(
    ['ctx-1', 'asst-1', 'tool-1', 'tool-2', 'tool-3', 'tail-1'],
    nodes,
    (t) => t === 5 ? ['ctx-1', 'asst-1', 'tool-1', 'tool-2', 'tool-3', 'tail-1'] : [],
  )
  const groups = computeFoldGroups(s)
  check('识别出一个组', groups.length === 1)
  const g = groups[0]
  check('组 id = 起点 key', g.id === 'ctx-1')
  check('变体 = reflect', g.variant === 'reflect')
  check('范围含反思段全部节点', g.keys.length === 5)
  check('范围排除 turn-tail（操作行保持可见）', !g.keys.includes('tail-1'))
  check('remember 计数 = 2', g.rememberCount === 2)
  check('update 计数 = 1', g.updateCount === 1)
  check('status = done', g.status === 'done')
}

// ---- 2. 排除 user/steering + 起点之后切片 ----
console.log('=== 2. 排除 user/steering、只取起点之后 ===')
{
  const nodes = new Map([
    ['user-0', userNode('user-0', turnLoc(4))],
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(5))],
    ['asst-1', assistantNode('asst-1', turnLoc(5), 'settled')],
    ['steer-1', steeringNode('steer-1', turnLoc(5))],
    ['tail-1', { key: 'tail-1', kind: 'turn-tail', location: turnLoc(5), data: { turn: 5 } }],
  ])
  // getTurn(5) 把 user-0 也算进去（异常数据），应被"起点之后"切片排除
  const s = snapshot(
    ['user-0', 'ctx-1', 'asst-1', 'steer-1', 'tail-1'],
    nodes,
    (t) => t === 5 ? ['user-0', 'ctx-1', 'asst-1', 'steer-1', 'tail-1'] : [],
  )
  const [g] = computeFoldGroups(s)
  check('范围排除起点之前的 user-0', !g.keys.includes('user-0'))
  check('范围排除 steering', !g.keys.includes('steer-1'))
  check('范围含 asst-1', g.keys.includes('asst-1'))
  check('范围排除 turn-tail（正常轮与反思轮共用，保持可见）', !g.keys.includes('tail-1'))
  check('group 起点 ctx-1 在内', g.keys.includes('ctx-1'))
}

// ---- 3. 状态：running / interrupted ----
console.log('=== 3. 状态判定 ===')
{
  const mk = (status) => {
    const nodes = new Map([
      ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(5))],
      ['asst-1', assistantNode('asst-1', turnLoc(5), status)],
    ])
    return computeFoldGroups(snapshot(['ctx-1', 'asst-1'], nodes, () => ['ctx-1', 'asst-1']))[0]
  }
  check('running', mk('running').status === 'running')
  check('interrupted', mk('interrupted').status === 'interrupted')
  check('settled → done', mk('settled').status === 'done')
}

// ---- 4. dream 变体 + unresolved 跳过 + 非 meow-memory 不管 ----
console.log('=== 4. dream / unresolved / 外来 context ===')
{
  const nodes = new Map([
    ['ctx-d', contextNode('ctx-d', DREAM, turnLoc(6))],
    ['ctx-x', { key: 'ctx-x', kind: 'context', location: turnLoc(7), data: { source: { kind: 'plugin', plugin: 'compact' }, content: [] } }],
    ['ctx-u', contextNode('ctx-u', REFLECT, { kind: 'unresolved' })],
  ])
  const s = snapshot(['ctx-d', 'ctx-x', 'ctx-u'], nodes, (t) => t === 6 ? ['ctx-d'] : [])
  const groups = computeFoldGroups(s)
  check('只有 dream 组', groups.length === 1 && groups[0].variant === 'dream')
}

// ---- 5. ToolResultNode 形态计数（窗口截断） ----
console.log('=== 5. tool-result 形态计数 ===')
{
  const nodes = new Map([
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(5))],
    ['tool-1', toolNode('tool-1', turnLoc(5), null)], // call 为 null（窗口截断）
    ['tool-2', { key: 'tool-2', kind: 'tool-call', location: turnLoc(5), data: { root: { kind: 'tool-result', callId: 'c', call: { name: 'memory_remember', argsRaw: '{}' }, content: [] } } }],
  ])
  const s = snapshot(['ctx-1', 'tool-1', 'tool-2'], nodes, () => ['ctx-1', 'tool-1', 'tool-2'])
  const [g] = computeFoldGroups(s)
  check('截断 call=null 不计，窗口内 call 正常计', g.rememberCount === 1 && g.updateCount === 0)
}

// ---- 6. 文案 ----
console.log('=== 6. foldLabel 文案 ===')
{
  const base = { id: 'x', variant: 'reflect', keys: [], rememberCount: 0, updateCount: 0, status: 'done' }
  check('新增记忆 3 条', foldLabel({ ...base, rememberCount: 3 }, false) === '▸ 记忆反思 · 新增记忆 3 条')
  check('无需记忆', foldLabel(base, false) === '▸ 记忆反思 · 无需记忆')
  check('running', foldLabel({ ...base, status: 'running' }, false) === '▸ 记忆反思进行中…')
  check('已更新 2 条', foldLabel({ ...base, updateCount: 2 }, false) === '▸ 记忆反思 · 已更新 2 条')
  check('dream 新增', foldLabel({ ...base, variant: 'dream', rememberCount: 1 }, true) === '▾ 记忆梦境任务 · 新增记忆 1 条')
  check('中断', foldLabel({ ...base, status: 'interrupted' }, false) === '▸ 记忆反思已中断')
}

// ---- 7. 并行 tool-call 各自成节点（反思轮真实形态） ----
console.log('=== 7. 并行 memory_remember 计数 ===')
{
  const nodes = new Map([
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(5))],
    ['asst-1', assistantNode('asst-1', turnLoc(5), 'settled')],
    ['tool-a', toolNode('tool-a', turnLoc(5), 'memory_remember')],
    ['tool-b', toolNode('tool-b', turnLoc(5), 'memory_remember')],
    ['tool-c', toolNode('tool-c', turnLoc(5), 'memory_remember')],
    ['tool-d', toolNode('tool-d', turnLoc(5), 'memory_search')],
    ['asst-2', assistantNode('asst-2', turnLoc(5), 'settled')],
  ])
  const s = snapshot(
    ['ctx-1', 'asst-1', 'tool-a', 'tool-b', 'tool-c', 'tool-d', 'asst-2'],
    nodes,
    () => ['ctx-1', 'asst-1', 'tool-a', 'tool-b', 'tool-c', 'tool-d', 'asst-2'],
  )
  const [g] = computeFoldGroups(s)
  check('并行 3 次 remember 全数到', g.rememberCount === 3)
  check('memory_search 不计', g.updateCount === 0)
  check('文案显示新增 3 条', foldLabel(g, false).includes('新增记忆 3 条'))
}

// ---- 8. 异常快照防护：节点缺 location 不抛（GitHub issue #2 回归） ----
console.log('=== 8. 缺 location 防护 ===')
{
  // 无 location 的 meow-memory context 节点（旧运行时/异常快照可能吐出），
  // 且排在正常节点之前：修复前 turnOf() 读 location.kind 直接炸掉整轮渲染。
  const badCtx = {
    key: 'bad-ctx', kind: 'context',
    data: { source: { kind: 'plugin', plugin: 'meow-memory' }, content: [{ type: 'text', text: REFLECT }] },
  }
  const nodes = new Map([
    ['bad-ctx', badCtx],
    ['ctx-1', contextNode('ctx-1', DREAM, turnLoc(6))],
    ['asst-1', assistantNode('asst-1', turnLoc(6), 'settled')],
  ])
  const s = snapshot(['bad-ctx', 'ctx-1', 'asst-1'], nodes, (t) => t === 6 ? ['ctx-1', 'asst-1'] : [])
  let groups
  try {
    groups = computeFoldGroups(s)
    check('缺 location 不抛异常（issue #2）', true)
  } catch {
    check('缺 location 不抛异常（issue #2）', false)
  }
  check('坏点之后的正常 dream 组不受影响', groups?.length === 1 && groups[0].variant === 'dream')
  check('缺 location 的组被跳过=不折叠保持可见', !groups?.some((g) => g.id === 'bad-ctx'))
}

// ---- 9. 注入折叠：新独立 snapshot + 结构化元数据 + 英文 i18n + 旧 user 前缀兼容 ----
console.log('=== 9. computeInjectionGroups ===')
{
  const SNAPSHOT_FIRST = '===== 长期记忆 =====\n【关于你】x'
  const SNAPSHOT_HIT = '可能相关的记忆，仅供参考：\n[fact:abc] 内容'
  const EN_FIRST = '===== LONG-TERM MEMORY =====\n【About You】x'
  const EN_HIT = 'Possibly relevant memories, for reference only:\n[fact:abc] Content'
  const LEGACY_FIRST = `${SNAPSHOT_FIRST}\n===== 长期记忆结束 =====\n\n本轮用户prompt：\n\n旧会话你好`
  const LEGACY_HIT = `${SNAPSHOT_HIT}\n------\n本轮用户prompt：\n\n旧会话再问一句`
  // en 旧格式分隔符 = labels en inject.promptLabel 实际值（"This turn's user prompt:"），非猜测值
  const LEGACY_EN_FIRST = `${EN_FIRST}\n===== END OF LONG-TERM MEMORY =====\n\nThis turn's user prompt:\n\nHello legacy`
  const PLAIN = '普通消息没有注入'
  const snapshotSource = (text, meta) => ({
    kind: 'plugin', plugin: 'meow-memory', form: 'snapshot',
    memory: meta,
    sections: [{ name: '长期记忆', text }],
  })
  const nodes = new Map([
    ['ctx-first', contextNode('ctx-first', SNAPSHOT_FIRST, turnLoc(1), snapshotSource(SNAPSHOT_FIRST, { kind: 'initial', ids: ['s1'] }))],
    ['u-first', userNode('u-first', turnLoc(1), [{ type: 'text', text: '你好' }], 1755900000000)],
    ['ctx-hit', contextNode('ctx-hit', SNAPSHOT_HIT, turnLoc(2), snapshotSource(SNAPSHOT_HIT, { kind: 'hit', ids: ['f1'] }))],
    ['u-hit', userNode('u-hit', turnLoc(2), [{ type: 'text', text: '再问一句' }])],
    ['ctx-en-first', contextNode('ctx-en-first', EN_FIRST, turnLoc(3), snapshotSource(EN_FIRST, { kind: 'initial', ids: ['s2'] }))],
    ['ctx-en-hit', contextNode('ctx-en-hit', EN_HIT, turnLoc(4), snapshotSource(EN_HIT, { kind: 'hit', ids: ['f2'] }))],
    ['u-legacy-first', userNode('u-legacy-first', turnLoc(5), [{ type: 'text', text: LEGACY_FIRST }], 1755900000000)],
    ['u-legacy-hit', userNode('u-legacy-hit', turnLoc(6), [{ type: 'text', text: LEGACY_HIT }])],
    ['u-legacy-en', userNode('u-legacy-en', turnLoc(7), [{ type: 'text', text: LEGACY_EN_FIRST }])],
    ['u-plain', userNode('u-plain', turnLoc(8), [{ type: 'text', text: PLAIN }])],
    ['u-img', userNode('u-img', turnLoc(9), [{ type: 'text', text: LEGACY_HIT }, { type: 'image', attachment: {} }])],
    ['ctx-other', contextNode('ctx-other', SNAPSHOT_FIRST, turnLoc(10), { kind: 'plugin', plugin: 'other', form: 'snapshot', sections: [] })],
    ['ctx-welcome', contextNode('ctx-welcome', '【meow-memory 首次设置】', turnLoc(11), { kind: 'plugin', plugin: 'meow-memory', form: 'notice', memory: { kind: 'welcome' }, sections: [] })],
  ])
  const order = ['ctx-first', 'u-first', 'ctx-hit', 'u-hit', 'ctx-en-first', 'ctx-en-hit', 'u-legacy-first', 'u-legacy-hit', 'u-legacy-en', 'u-plain', 'u-img', 'ctx-other', 'ctx-welcome']
  const s = snapshot(order, nodes, () => [])
  const injs = computeInjectionGroups(s)
  check('识别 7 个注入组（中文 2 + 英文 2 + 旧格式 3）', injs.length === 7)
  const first = injs.find((g) => g.id === 'ctx-first')
  check('独立首轮 snapshot kind=first', first?.kind === 'first')
  check('独立 snapshot 不重建 user 气泡', first?.userText === undefined && first?.time === undefined)
  check('独立 snapshot 文本无旧分隔符', first?.injectedText === SNAPSHOT_FIRST && !first?.injectedText.includes('本轮用户prompt：'))
  const hit = injs.find((g) => g.id === 'ctx-hit')
  check('独立命中 snapshot kind=hit', hit?.kind === 'hit' && hit?.injectedText === SNAPSHOT_HIT)
  const enFirst = injs.find((g) => g.id === 'ctx-en-first')
  check('英文模式独立首轮 snapshot kind=first', enFirst?.kind === 'first' && enFirst?.injectedText === EN_FIRST)
  const enHit = injs.find((g) => g.id === 'ctx-en-hit')
  check('英文模式独立命中 snapshot kind=hit', enHit?.kind === 'hit' && enHit?.injectedText === EN_HIT)
  const legacyFirst = injs.find((g) => g.id === 'u-legacy-first')
  check('旧首轮 userText/time 兼容', legacyFirst?.userText === '旧会话你好' && legacyFirst?.time === 1755900000000)
  check('旧首轮 injectedText 保留分隔标记', legacyFirst?.injectedText.includes('===== 长期记忆 =====') && legacyFirst?.injectedText.includes('本轮用户prompt：'))
  const legacyHit = injs.find((g) => g.id === 'u-legacy-hit')
  check('旧命中 userText 兼容', legacyHit?.kind === 'hit' && legacyHit?.userText === '旧会话再问一句')
  const legacyEn = injs.find((g) => g.id === 'u-legacy-en')
  check('英文旧格式 userText 兼容', legacyEn?.kind === 'first' && legacyEn?.userText === 'Hello legacy')
  check('带图旧消息/其他插件/welcome notice 不折叠', !injs.some((g) => g.id === 'u-img' || g.id === 'ctx-other' || g.id === 'ctx-welcome'))
  check('记忆 snapshot 不被误识别为反思轮', computeFoldGroups(s).length === 0)
}

// ---- 10. 注入消息时钟（对齐 dsh formatMessageClock 规则） ----
console.log('=== 10. formatInjectionClock ===')
{
  const now = new Date(2026, 7, 23, 15, 0).getTime() // 2026-08-23 15:00 本地
  const mk = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime()
  check('同天 → HH:mm', formatInjectionClock(mk(2026, 7, 23, 9, 5), now) === '09:05')
  check('同天 → HH:mm 补零', formatInjectionClock(mk(2026, 7, 23, 15, 0), now) === '15:00')
  check('今年非今天 → M月D日 HH:mm', formatInjectionClock(mk(2026, 0, 2, 8, 30), now) === '1月2日 08:30')
  check('跨年 → Y年M月D日 HH:mm', formatInjectionClock(mk(2025, 11, 31, 23, 59), now) === '2025年12月31日 23:59')
}

console.log(failures === 0 ? '\nALL CLIENT-FOLD TESTS PASSED ✅' : `\n${failures} FAILURES ❌`)
process.exit(failures === 0 ? 0 : 1)
