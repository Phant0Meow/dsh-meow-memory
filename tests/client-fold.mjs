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
const { computeFoldGroups, foldLabel, toolCallDetail, blocksToText, computeInjectionGroups, formatInjectionClock, memoryTurnNumbers, setUiLocaleForTest } = await import(modUrl)

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
  // callId 按 key 唯一（宿主契约：callId 是调用身份，并行调用各不相同；
  // #85 起计数按 callId 去重，夹具共用一个 id 会被误去重）
  const root = name === null
    ? { kind: 'tool-result', callId: key, call: null, content: [] }
    : { callId: key, name, argsRaw: '{}', turn: 1, step: 1, time: 0, subCalls: [] }
  return { key, kind: 'tool-call', location: loc, data: { root } }
}
function snapshot(order, nodes, getTurn) {
  return {
    chat: {
      order,
      nodes: { get: (k) => nodes.get(k), values: () => nodes.values() },
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
  check('范围含反思段全部节点', g.keys.length === 6)
  // 独立 memory 轮（prompt 即 turn 首节点，followup 形状）：该轮自己的 turn-tail 一并折叠
  check('独立轮：范围含 turn-tail（整轮都是 memory 的）', g.keys.includes('tail-1'))
  check('remember 计数 = 2', g.rememberCount === 2)
  check('update 计数 = 1', g.updateCount === 1)
  check('status = done', g.status === 'done')
}

// ---- 2. 排除 user/steering + 起点之后切片 ----
console.log('=== 2. 排除 user/steering、只取起点之后 ===')
{
  const nodes = new Map([
    ['user-0', userNode('user-0', turnLoc(5))],
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(5))],
    ['asst-1', assistantNode('asst-1', turnLoc(5), 'settled')],
    ['steer-1', steeringNode('steer-1', turnLoc(5))],
    ['tail-1', { key: 'tail-1', kind: 'turn-tail', location: turnLoc(5), data: { turn: 5 } }],
  ])
  // 真共享轮：user 消息与反思 prompt 同在 turn 5、且在 prompt 之前——0.2.x 键序
  // 扫描按节点真实 location 归轮（比旧 getTurn 更准），切片从锚点起、排除 user/steering。
  const s = snapshot(
    ['user-0', 'ctx-1', 'asst-1', 'steer-1', 'tail-1'],
    nodes,
    (t) => t === 5 ? ['user-0', 'ctx-1', 'asst-1', 'steer-1', 'tail-1'] : [],
  )
  const [g] = computeFoldGroups(s)
  check('范围排除起点之前的 user-0', !g.keys.includes('user-0'))
  check('范围排除 steering', !g.keys.includes('steer-1'))
  check('范围含 asst-1', g.keys.includes('asst-1'))
  check('共享轮：范围排除 turn-tail（正常轮工作汇报的操作行，保持可见）', !g.keys.includes('tail-1'))
  check('group 起点 ctx-1 在内', g.keys.includes('ctx-1'))
}

// ---- 2.5 独立轮 vs 共享轮（2026-09-10 followup 双形状）----
console.log('=== 2.5 独立轮折叠 turn-tail / 共享轮保留 turn-tail ===')
{
  // 独立轮：prompt 是 turn 首节点（host followup，0.1.5 新会话形状）
  const nodesA = new Map([
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(7))],
    ['tool-1', toolNode('tool-1', turnLoc(7), 'memory_remember')],
    ['tail-1', { key: 'tail-1', kind: 'turn-tail', location: turnLoc(7), data: { turn: 7 } }],
  ])
  const sA = snapshot(['ctx-1', 'tool-1', 'tail-1'], nodesA, (t) => t === 7 ? ['ctx-1', 'tool-1', 'tail-1'] : [])
  const [gA] = computeFoldGroups(sA)
  check('独立轮：tail 在折叠范围内（横条下方无残留 footer）', gA.keys.includes('tail-1') && gA.keys.length === 3)
}
{
  // 共享轮：prompt 之前有正常轮节点（旧会话数据 / 宿主回退 steer 的形状）
  const nodesB = new Map([
    ['user-0', userNode('user-0', turnLoc(3))],
    ['asst-0', assistantNode('asst-0', turnLoc(3), 'settled')],
    ['ctx-1', contextNode('ctx-1', DREAM, turnLoc(3))],
    ['tool-1', toolNode('tool-1', turnLoc(3), 'memory_remember')],
    ['tail-1', { key: 'tail-1', kind: 'turn-tail', location: turnLoc(3), data: { turn: 3 } }],
  ])
  const sB = snapshot(
    ['user-0', 'asst-0', 'ctx-1', 'tool-1', 'tail-1'],
    nodesB,
    (t) => t === 3 ? ['user-0', 'asst-0', 'ctx-1', 'tool-1', 'tail-1'] : [],
  )
  const [gB] = computeFoldGroups(sB)
  check('共享轮：正常轮 asst-0 不折叠', !gB.keys.includes('asst-0'))
  check('共享轮：tail 不折叠（正常轮的操作行）', !gB.keys.includes('tail-1'))
  check('共享轮：memory 段照常折叠', gB.keys.includes('ctx-1') && gB.keys.includes('tool-1'))
}
{
  // memoryTurnNumbers（2026-09-10 导航条隐藏用）：含 reflect/dream prompt 的 turn 集合
  const nodesD = new Map([
    ['user-1', userNode('user-1', turnLoc(2))],
    ['ctx-r', contextNode('ctx-r', REFLECT, turnLoc(2))],
    ['asst-1', assistantNode('asst-1', turnLoc(2), 'settled')],
    ['ctx-d0', contextNode('ctx-d0', DREAM, turnLoc(5))],
    ['ctx-d1', contextNode('ctx-d1', DREAM, turnLoc(5))],
    ['user-9', userNode('user-9', turnLoc(9))],
    ['asst-9', assistantNode('asst-9', turnLoc(9), 'settled')],
  ])
  const sD = snapshot(
    ['user-1', 'ctx-r', 'asst-1', 'ctx-d0', 'ctx-d1', 'user-9', 'asst-9'],
    nodesD,
    () => [],
  )
  const turnsD = memoryTurnNumbers(sD)
  check('memoryTurnNumbers：reflect turn 入集合', turnsD.has(2))
  check('memoryTurnNumbers：dream 多 prompt 同 turn 去重', turnsD.has(5) && [...turnsD].filter((t) => t === 5).length === 1)
  check('memoryTurnNumbers：正常轮不进集合', !turnsD.has(9) && turnsD.size === 2)
  check('memoryTurnNumbers：无 chat 快照返回空集', memoryTurnNumbers(undefined).size === 0)
}
{
  // 同轮同任务合并（2026-09-10）：dream 三组连在一个独立 turn 里 → 只出一根横条
  const nodesC = new Map([
    ['ctx-g0', contextNode('ctx-g0', DREAM, turnLoc(9))],
    ['tool-g0', toolNode('tool-g0', turnLoc(9), 'memory_remember')],
    ['ctx-g1', contextNode('ctx-g1', DREAM, turnLoc(9))],
    ['tool-g1', toolNode('tool-g1', turnLoc(9), 'memory_remember')],
    ['ctx-g2', contextNode('ctx-g2', DREAM, turnLoc(9))],
    ['asst-g2', assistantNode('asst-g2', turnLoc(9), 'settled')],
    ['tail-g', { key: 'tail-g', kind: 'turn-tail', location: turnLoc(9), data: { turn: 9 } }],
  ])
  const sC = snapshot(
    ['ctx-g0', 'tool-g0', 'ctx-g1', 'tool-g1', 'ctx-g2', 'asst-g2', 'tail-g'],
    nodesC,
    (t) => t === 9 ? ['ctx-g0', 'tool-g0', 'ctx-g1', 'tool-g1', 'ctx-g2', 'asst-g2', 'tail-g'] : [],
  )
  const groupsC = computeFoldGroups(sC)
  check('dream 三组同轮：只出一根横条', groupsC.length === 1)
  const gC = groupsC[0]
  check('合并组锚在首个 prompt', gC.id === 'ctx-g0')
  check('合并组覆盖全部三组的节点', gC.keys.includes('ctx-g2') && gC.keys.includes('tool-g1') && gC.keys.length === 7)
  check('合并组计数跨组累计（remember=2）', gC.rememberCount === 2)
  check('合并组含 turn-tail（独立轮）', gC.keys.includes('tail-g'))
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
  // 文案经 i18n 层（跟随 DSH 语言设置）：先锁 zh 保持历史断言，再补 en / pt-br。
  setUiLocaleForTest('zh')
  check('新增记忆 3 条', foldLabel({ ...base, rememberCount: 3 }, false) === '▸ 记忆反思 · 新增记忆 3 条')
  check('无需记忆', foldLabel(base, false) === '▸ 记忆反思 · 无需记忆')
  check('running', foldLabel({ ...base, status: 'running' }, false) === '▸ 记忆反思进行中…')
  check('已更新 2 条', foldLabel({ ...base, updateCount: 2 }, false) === '▸ 记忆反思 · 已更新 2 条')
  check('dream 新增', foldLabel({ ...base, variant: 'dream', rememberCount: 1 }, true) === '▾ 记忆梦境任务 · 新增记忆 1 条')
  check('中断', foldLabel({ ...base, status: 'interrupted' }, false) === '▸ 记忆反思已中断')
  // issue #20（用户拍板 2026-09-20）：dream 运行中横条要提示"插话会拼进本轮"；
  // 反思运行中不带提示。文案同样走 i18n 层。
  check('dream running 提示插话', foldLabel({ ...base, variant: 'dream', status: 'running' }, false) === '▸ 记忆梦境任务进行中…（插话会拼进本轮）')
  check('reflect running 无提示', foldLabel({ ...base, status: 'running' }, false) === '▸ 记忆反思进行中…')
  setUiLocaleForTest('en')
  check('en 新增记忆 3 条', foldLabel({ ...base, rememberCount: 3 }, false) === '▸ Memory reflection · 3 memories added')
  check('en 无需记忆', foldLabel(base, false) === '▸ Memory reflection · nothing to save')
  check('en dream 中断', foldLabel({ ...base, variant: 'dream', status: 'interrupted' }, false) === '▸ Memory dream task interrupted')
  check('en dream running 提示插话', foldLabel({ ...base, variant: 'dream', status: 'running' }, false) === '▸ Memory dream task in progress… (your message joins this turn)')
  check('en reflect running 无提示', foldLabel({ ...base, status: 'running' }, false) === '▸ Memory reflection in progress…')
  setUiLocaleForTest('pt-br')
  check('pt-br 新增记忆 3 条', foldLabel({ ...base, rememberCount: 3 }, false) === '▸ Reflexão de memória · 3 memórias adicionadas')
  check('pt-br running', foldLabel({ ...base, status: 'running' }, false) === '▸ Reflexão de memória em andamento…')
  check('pt-br dream running 提示插话', foldLabel({ ...base, variant: 'dream', status: 'running' }, false) === '▸ Consolidação ociosa de memória (dream) em andamento… (mensagem entra nesta rodada)')
  setUiLocaleForTest('zh')
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
  setUiLocaleForTest('zh')
  check('同天 → HH:mm', formatInjectionClock(mk(2026, 7, 23, 9, 5), now) === '09:05')
  check('同天 → HH:mm 补零', formatInjectionClock(mk(2026, 7, 23, 15, 0), now) === '15:00')
  check('今年非今天 → M月D日 HH:mm', formatInjectionClock(mk(2026, 0, 2, 8, 30), now) === '1月2日 08:30')
  check('跨年 → Y年M月D日 HH:mm', formatInjectionClock(mk(2025, 11, 31, 23, 59), now) === '2025年12月31日 23:59')
  setUiLocaleForTest('en')
  check('en 今年非今天 → M/D HH:mm', formatInjectionClock(mk(2026, 0, 2, 8, 30), now) === '1/2 08:30')
  check('en 跨年 → Y/M/D HH:mm', formatInjectionClock(mk(2025, 11, 31, 23, 59), now) === '2025/12/31 23:59')
  setUiLocaleForTest('pt-br')
  check('pt-br 今年非今天 → D/M HH:mm', formatInjectionClock(mk(2026, 0, 2, 8, 30), now) === '2/1 08:30')
  check('pt-br 跨年 → D/M/Y HH:mm', formatInjectionClock(mk(2025, 11, 31, 23, 59), now) === '31/12/2025 23:59')
  setUiLocaleForTest('zh')
}

// ---- 11. 生产者 source 形态：当前形态与退役形态必须同判 ----
// dsh 0.1.7 起新写入用 plugin:meow-memory（v4 拒绝退役的 plugin kind），
// 历史会话经迁移器改写后也是同一形态；两种形态都必须被识别，否则读旧会话会丢折叠。
console.log('=== 11. source 形态兼容 ===')
{
  const mk = (source) => {
    const nodes = new Map([
      ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(1), source)],
      ['asst-1', assistantNode('asst-1', turnLoc(1), 'settled')],
      ['tail-1', { key: 'tail-1', kind: 'turn-tail', location: turnLoc(1), data: { turn: 1 } }],
    ])
    return snapshot(['ctx-1', 'asst-1', 'tail-1'], nodes, (t) => t === 1 ? ['ctx-1', 'asst-1', 'tail-1'] : [])
  }
  const current = computeFoldGroups(mk({ kind: 'plugin:meow-memory' }))
  const retired = computeFoldGroups(mk({ kind: 'plugin', plugin: 'meow-memory' }))
  check('当前形态（plugin:meow-memory）识别为反思轮', current.length === 1 && current[0].variant === 'reflect')
  check('退役形态（plugin + 插件名）识别为反思轮', retired.length === 1 && retired[0].variant === 'reflect')
  check('两种形态折叠结果一致', JSON.stringify(current) === JSON.stringify(retired))
  check('别的插件的 source 不误判', computeFoldGroups(mk({ kind: 'plugin', plugin: 'other-plugin' })).length === 0)
  check('无关 kind 不误判', computeFoldGroups(mk({ kind: 'user' })).length === 0)
}

// ---- 12. turn-trigger 形态：宿主把被领取的 context 节点改标后仍要折叠 ----
// dsh-client-ui-chat 的 messageDefinition：context 节点 waking=true 时
// buildViewNode 输出 kind='turn-trigger'（界面 chip 文案「收到执行请求」）。
// 反思/dream prompt 走 followup 触发新轮 → 实测恒为该形态；只认 'context'
// 时锚点找不到 → 横条不出现（2026-10-08 本机复现，用户报「整理轮全刷屏」）。
console.log('=== 12. turn-trigger 形态 ===')
{
  const mk = (kind) => {
    const nodes = new Map([
      ['ctx-1', { ...contextNode('ctx-1', REFLECT, turnLoc(1)), kind }],
      ['asst-1', assistantNode('asst-1', turnLoc(1), 'settled')],
      ['tail-1', { key: 'tail-1', kind: 'turn-tail', location: turnLoc(1), data: { turn: 1 } }],
    ])
    return snapshot(['ctx-1', 'asst-1', 'tail-1'], nodes, (t) => t === 1 ? ['ctx-1', 'asst-1', 'tail-1'] : [])
  }
  const trig = computeFoldGroups(mk('turn-trigger'))
  check('turn-trigger 节点识别为反思轮', trig.length === 1 && trig[0].variant === 'reflect')
  check('turn-trigger 折叠范围含本轮 assistant', trig.length === 1 && trig[0].keys.includes('asst-1'))
  check('与 context 形态结果一致', JSON.stringify(trig) === JSON.stringify(computeFoldGroups(mk('context'))))
  const other = mk('turn-trigger')
  other.chat.nodes.get('ctx-1').data = { ...other.chat.nodes.get('ctx-1').data, source: { kind: 'plugin', plugin: 'other' } }
  check('turn-trigger + 别的插件 source 不误判', computeFoldGroups(other).length === 0)
}

// ---- 6. 0.2.x：order 漏节点 / getTurn 键集失配（#53/#58/#72） ----
console.log('=== 6. 0.2.x：order 缺节点、getTurn 失配 ===')
{
  const nodes = new Map([
    ['user-0', userNode('user-0', turnLoc(3))],
    ['asst-0', assistantNode('asst-0', turnLoc(3), 'settled')],
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(4))],
    ['tool-1', toolNode('tool-1', turnLoc(4), 'memory_remember')],
    ['tail-1', { key: 'tail-1', kind: 'turn-tail', location: turnLoc(4), data: { turn: 4 } }],
  ])
  // 0.2.x 实况（探针实证）：注入的 context 节点被 chat-visibility 排除，不在
  // order 里；locations.getTurn 从 order 重建、给出的键集与节点 key 对不上。
  const s = snapshot(['user-0', 'asst-0'], nodes, () => ['turn-4'])
  const groups = computeFoldGroups(s)
  check('order 缺节点时仍能找到反思轮锚点', groups.length === 1 && groups[0].variant === 'reflect')
  check('getTurn 失配时范围仍覆盖本轮（含 memory_remember 计数）',
    groups.length === 1 && groups[0].rememberCount === 1 && groups[0].keys.includes('ctx-1'))
  check('组带 turn（DOM 侧回退落横条用）', groups.length === 1 && groups[0].turn === 4)
  const turns = memoryTurnNumbers(s)
  check('memoryTurnNumbers 也认不在 order 里的节点', turns.size === 1 && turns.has(4))

  const injNodes = new Map([
    ['ctx-hit', {
      key: 'ctx-hit', kind: 'context', location: turnLoc(2),
      data: {
        source: {
          kind: 'plugin', plugin: 'meow-memory', form: 'snapshot',
          sections: [{ name: '__meta__', text: JSON.stringify({ kind: 'hit', ids: [] }) }],
        },
        content: [{ type: 'text', text: '可能相关的记忆，仅供参考：\n- 一条事实' }],
      },
    }],
  ])
  const s2 = snapshot([], injNodes, () => [])
  const inj = computeInjectionGroups(s2)
  check('注入块不在 order 里也能成组', inj.length === 1)
  check('注入组带 turn（0.2.x DOM 侧按 turn 找落点）', inj.length === 1 && inj[0].turn === 2)
}

// ---- 7. 旧宿主 store 无 values()：键序只按 order，行为不变 ----
console.log('=== 7. 旧宿主（nodes 无 values）回归 ===')
{
  const nodes = new Map([
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(5))],
    ['asst-1', assistantNode('asst-1', turnLoc(5), 'settled')],
    ['tool-1', toolNode('tool-1', turnLoc(5), 'memory_remember')],
    ['tail-1', { key: 'tail-1', kind: 'turn-tail', location: turnLoc(5), data: { turn: 5 } }],
  ])
  const s = {
    chat: {
      order: ['ctx-1', 'asst-1', 'tool-1', 'tail-1'],
      nodes: { get: (k) => nodes.get(k) }, // 无 values（0.1.x 旧 store 形状）
      locations: { getTurn: (t) => t === 5 ? ['ctx-1', 'asst-1', 'tool-1', 'tail-1'] : [] },
    },
  }
  const groups = computeFoldGroups(s)
  check('旧宿主：照常识别与计数', groups.length === 1 && groups[0].rememberCount === 1 && groups[0].keys.length === 4)
  check('旧宿主：范围与 getTurn 一致', JSON.stringify(groups[0].keys) === JSON.stringify(['ctx-1', 'asst-1', 'tool-1', 'tail-1']))
}

// ---- 13. PTC 子调用计数（#85）：run_code 根 + 递归 subCalls，按 callId 去重 ----
// 宿主形状（dsh-client-ui-conversation records.d.ts 实证）：ToolCallBlock 两变体
// （RunningToolCall / ToolResultNode）都带 subCalls，递归结构、dispatch 序；
// PTC 会话里顶层工具节点恒为 run_code，memory_* 只出现在 subCalls 里。
console.log('=== 13. PTC subCalls 计数 ===')
{
  const sub = (name, callId, subCalls = []) => ({ callId, name, argsRaw: '{}', turn: 5, step: 1, time: 0, subCalls })
  const ptcNode = (key, subCalls) => ({
    key, kind: 'tool-call', location: turnLoc(5),
    data: { root: { callId: key, name: 'run_code', argsRaw: '{}', turn: 5, step: 1, time: 0, subCalls } },
  })
  // 一个 run_code 派出 bash + 2×remember + 1×update（含一层嵌套）
  const nodes = new Map([
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(5))],
    ['tool-rc', ptcNode('tool-rc', [
      sub('bash', 'rc:ptc:1'),
      sub('memory_remember', 'rc:ptc:2'),
      sub('memory_remember', 'rc:ptc:3'),
      sub('memory_update', 'rc:ptc:4'),
      sub('run_code', 'rc:ptc:5', [sub('memory_remember', 'rc:ptc:5:ptc:1')]),
    ])],
    ['tail-1', { key: 'tail-1', kind: 'turn-tail', location: turnLoc(5), data: { turn: 5 } }],
  ])
  const s = snapshot(['ctx-1', 'tool-rc', 'tail-1'], nodes, () => ['ctx-1', 'tool-rc', 'tail-1'])
  const [g] = computeFoldGroups(s)
  check('PTC：子调用 remember 计数（含嵌套层）= 3', g.rememberCount === 3, `got ${g.rememberCount}`)
  check('PTC：子调用 update 计数 = 1', g.updateCount === 1, `got ${g.updateCount}`)
  check('PTC：根 run_code 与非 memory 子调用不计', foldLabel(g, false).includes('新增记忆 3 条'))
}
{
  // callId 去重：同一调用既作顶层根又出现在别的节点 subCalls 里 → 只计一次
  const sub = (name, callId) => ({ callId, name, argsRaw: '{}', turn: 6, step: 1, time: 0, subCalls: [] })
  const nodes = new Map([
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(6))],
    ['tool-top', toolNode('tool-top', turnLoc(6), 'memory_remember')],
    ['tool-rc', {
      key: 'tool-rc', kind: 'tool-call', location: turnLoc(6),
      // 子调用与顶层节点撞同一 callId（异常快照形状）：只计一次
      data: { root: { callId: 'tool-rc', name: 'run_code', argsRaw: '{}', turn: 6, step: 1, time: 0, subCalls: [sub('memory_remember', 'tool-top')] } },
    }],
  ])
  const s = snapshot(['ctx-1', 'tool-top', 'tool-rc'], nodes, () => ['ctx-1', 'tool-top', 'tool-rc'])
  const [g] = computeFoldGroups(s)
  check('PTC：callId 去重（顶层与 subCalls 同 callId 只计一次）', g.rememberCount === 1, `got ${g.rememberCount}`)
}
{
  // ToolResultNode 形态的根（已落定）也带 subCalls：照常下钻
  const nodes = new Map([
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(7))],
    ['tool-rc', {
      key: 'tool-rc', kind: 'tool-call', location: turnLoc(7),
      data: { root: { kind: 'tool-result', callId: 'rc7', call: { name: 'run_code', argsRaw: '{}' }, content: [], subCalls: [{ kind: 'tool-result', callId: 'rc7:ptc:1', call: { name: 'memory_update', argsRaw: '{}' }, content: [] }] } },
    }],
  ])
  const s = snapshot(['ctx-1', 'tool-rc'], nodes, () => ['ctx-1', 'tool-rc'])
  const [g] = computeFoldGroups(s)
  check('PTC：tool-result 根的子调用照常计数', g.updateCount === 1 && g.rememberCount === 0, `got ${g.updateCount}/${g.rememberCount}`)
}
{
  // 异常形状防护：subCalls 非数组 / 子块为 null → 静默跳过不炸（issue #2 同款）
  const nodes = new Map([
    ['ctx-1', contextNode('ctx-1', REFLECT, turnLoc(8))],
    ['tool-bad', { key: 'tool-bad', kind: 'tool-call', location: turnLoc(8), data: { root: { callId: 'b', name: 'run_code', argsRaw: '{}', time: 0, subCalls: null } } }],
    ['tool-bad2', { key: 'tool-bad2', kind: 'tool-call', location: turnLoc(8), data: { root: { callId: 'b2', name: 'run_code', argsRaw: '{}', time: 0, subCalls: [null, 42, { callId: 'ok', name: 'memory_remember', time: 0 }] } } }],
  ])
  const s = snapshot(['ctx-1', 'tool-bad', 'tool-bad2'], nodes, () => ['ctx-1', 'tool-bad', 'tool-bad2'])
  let g
  try {
    ;[g] = computeFoldGroups(s)
    check('PTC：异常 subCalls 形状不抛异常', true)
  } catch {
    check('PTC：异常 subCalls 形状不抛异常', false)
  }
  check('PTC：异常块中的合法子调用仍计数', g?.rememberCount === 1, `got ${g?.rememberCount}`)
}

// ---- 14. toolCallDetail 形状容错（#86-②）：任何偏差降级为只显示工具名，绝不抛 ----
console.log('=== 14. toolCallDetail 形状容错 ===')
{
  const det = (block) => {
    try {
      const v = toolCallDetail(block)
      return { ok: true, v }
    } catch (e) {
      return { ok: false, e }
    }
  }
  check('无字段 → 只显示名（不抛）', det({ name: 'bash' }).ok && det({ name: 'bash' }).v === 'bash')
  check('argsRaw undefined → 只显示名', det({ name: 'bash', argsRaw: undefined }).v === 'bash')
  check('argsRaw null → 只显示名', det({ name: 'bash', argsRaw: null }).v === 'bash')
  check('缺 name 缺参数 → 空串', det({}).v === '')
  check('arguments 字符串（wire 形态）→ pretty', det({ name: 'bash', arguments: '{"cmd":"ls"}' }).v.includes('"cmd": "ls"'))
  check('args 对象 → JSON pretty', det({ name: 'bash', args: { cmd: 'ls' } }).v.includes('"cmd": "ls"'))
  check('call.argsRaw 兜底', det({ name: 'bash', call: { argsRaw: '{"a":1}' } }).v.includes('"a": 1'))
  check('root 包装（tool-call 节点整份传入）', det({ name: 'bash', root: { name: 'bash', argsRaw: '{"a":1}' } }).v.includes('"a": 1'))
  check('root.call 兜底（tool-result 形态）', det({ name: 'bash', root: { call: { argsRaw: '{"b":2}' } } }).v.includes('"b": 2'))
  check('合法 argsRaw 仍 pretty（旧行为不变）', det({ name: 'bash', argsRaw: '{"cmd":"ls -la"}' }).v.includes('"cmd": "ls -la"'))
  check('空 argsRaw → 只显示名（旧行为不变）', det({ name: 'bash', argsRaw: '' }).v === 'bash')
  check('非 JSON 字符串原样展示', det({ name: 'bash', argsRaw: 'plain text' }).v === 'bash\nplain text')
  check('name 非字符串 → 忽略', det({ name: 42, argsRaw: '{"a":1}' }).v.includes('"a": 1'))
}

console.log(failures === 0 ? '\nALL CLIENT-FOLD TESTS PASSED ✅' : `\n${failures} FAILURES ❌`)
process.exit(failures === 0 ? 0 : 1)
