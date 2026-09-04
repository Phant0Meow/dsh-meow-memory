/**
 * client-delegate-notice 纯逻辑测试：computeDelegateNotices / delegateNoticeLabelFor。
 * 运行：node tests/client-delegate-notice.mjs（内部 esbuild 打包源码保证与 src 同步）。
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

const { computeDelegateNotices, delegateNoticeLabel, delegateNoticeLabelFor, REFLECT_DELEGATE_MARKER, REFLECT_DONE_DELEGATE_MARKER, DREAM_DELEGATE_MARKER } = await bundleSrc('src/client-delegate-notice.ts')
const { computeFoldGroups, computeInjectionGroups } = await bundleSrc('src/client-fold.ts')

// ---- mock 快照（同 client-fold.mjs 模式） ----
function turnLoc(turn) {
  return { kind: 'turn', turn: { turn } }
}
function contextNode(key, text, source, time) {
  return {
    key, kind: 'context', location: turnLoc(1),
    data: { source, content: [{ type: 'text', text }], ...(time === undefined ? {} : { time }) },
  }
}
function snapshot(order, nodes) {
  return {
    chat: {
      order,
      nodes: { get: (k) => nodes.get(k) },
      locations: { getTurn: () => [] },
    },
  }
}

let failures = 0
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`)
  if (!cond) failures++
}

const REFLECT_SOURCE = { kind: 'plugin', plugin: 'meow-memory', form: 'notice', summary: '记忆反思任务进行中', memory: { kind: 'reflect-marker' } }
const REFLECT_DONE_SOURCE = { kind: 'plugin', plugin: 'meow-memory', form: 'notice', summary: '记忆反思任务已完成', memory: { kind: 'reflect-done-marker' } }
const DREAM_SOURCE = { kind: 'plugin', plugin: 'meow-memory', form: 'notice', summary: '梦境记忆整理任务进行中', memory: { kind: 'dream-marker' } }
const REFLECT_TEXT = `${REFLECT_DELEGATE_MARKER} 记忆反思任务已在后台启动，独立执行不占用本对话上下文。`
const REFLECT_DONE_TEXT = `${REFLECT_DONE_DELEGATE_MARKER} 记忆反思任务已完成，成果已写入记忆库。`
const DREAM_TEXT = `${DREAM_DELEGATE_MARKER} 梦境记忆整理任务已在后台启动，独立执行不占用本对话上下文。`
const FOLD_REFLECT = '[meow-memory-reflect]\n反思 prompt...'
const FOLD_DREAM = '[meow-memory-dream]\n整理指令...'
const INJECT_FIRST = '===== 长期记忆 =====\n【关于你】x'

const NOW = 1_800_000_000_000
const FRESH = NOW - 5 * 60_000 // 5 分钟前（新鲜）
const STALE = NOW - 40 * 60_000 // 40 分钟前（超保鲜窗）

// ---- 1. 机器元数据识别（含 done 与 sessionId） ----
console.log('=== 1. memory.kind 元数据识别 ===')
{
  const nodes = new Map([
    ['ctx-r', contextNode('ctx-r', REFLECT_TEXT, REFLECT_SOURCE)],
    ['ctx-d', contextNode('ctx-d', DREAM_TEXT, DREAM_SOURCE)],
    ['ctx-e', contextNode('ctx-e', REFLECT_DONE_TEXT, REFLECT_DONE_SOURCE)],
    ['ctx-s', contextNode('ctx-s', DREAM_TEXT, { ...DREAM_SOURCE, memory: { kind: 'dream-marker', sessionId: 'session-abc' } })],
  ])
  const s = snapshot(['ctx-r', 'ctx-d', 'ctx-e', 'ctx-s'], nodes)
  const notices = computeDelegateNotices(s, NOW)
  check('识别 4 条打点', notices.length === 4)
  check('reflect-marker → reflect', notices[0]?.variant === 'reflect')
  check('dream-marker → dream', notices[1]?.variant === 'dream')
  check('reflect-done-marker → reflect-done', notices[2]?.variant === 'reflect-done' && notices[2]?.running === false)
  check('sessionId 从 memory 元数据提取', notices[3]?.sessionId === 'session-abc')
  check('无 sessionId 的打点该字段缺省', notices[0]?.sessionId === undefined)
}

// ---- 2. 文本兜底（无 memory 元数据的旧数据） ----
console.log('=== 2. 文本标记兜底 ===')
{
  const noMeta = { kind: 'plugin', plugin: 'meow-memory', form: 'notice' }
  const nodes = new Map([
    ['ctx-r', contextNode('ctx-r', REFLECT_TEXT, noMeta)],
    ['ctx-e', contextNode('ctx-e', REFLECT_DONE_TEXT, noMeta)],
    ['ctx-d', contextNode('ctx-d', DREAM_TEXT, noMeta)],
  ])
  const s = snapshot(['ctx-r', 'ctx-e', 'ctx-d'], nodes)
  const notices = computeDelegateNotices(s, NOW)
  check('无元数据靠文本兜底识别 3 条', notices.length === 3)
  check('兜底变体正确（含 done）', notices[0]?.variant === 'reflect' && notices[1]?.variant === 'reflect-done' && notices[2]?.variant === 'dream')
}

// ---- 3. 排除：非打点节点一律不识别 ----
console.log('=== 3. 排除非打点节点 ===')
{
  const nodes = new Map([
    ['ctx-fold-r', contextNode('ctx-fold-r', FOLD_REFLECT, { kind: 'plugin', plugin: 'meow-memory' })], // 主会话折叠轮（steer）
    ['ctx-fold-d', contextNode('ctx-fold-d', FOLD_DREAM, { kind: 'plugin', plugin: 'meow-memory' })],
    ['ctx-inject', contextNode('ctx-inject', INJECT_FIRST, { kind: 'plugin', plugin: 'meow-memory', form: 'snapshot', memory: { kind: 'initial', ids: ['s1'] } })],
    ['ctx-welcome', contextNode('ctx-welcome', '【meow-memory 首次设置】', { kind: 'plugin', plugin: 'meow-memory', form: 'notice', memory: { kind: 'welcome' } })],
    ['ctx-other', contextNode('ctx-other', REFLECT_TEXT, { kind: 'plugin', plugin: 'other', form: 'notice' })],
    ['ctx-compact', contextNode('ctx-compact', 'compact', { kind: 'plugin', plugin: 'compact' })],
    ['u-plain', { key: 'u-plain', kind: 'user', location: turnLoc(1), data: { source: { kind: 'user' }, content: [{ type: 'text', text: REFLECT_TEXT }] } }],
    ['asst-1', { key: 'asst-1', kind: 'assistant', location: turnLoc(1), data: { status: 'settled' } }],
  ])
  const s = snapshot([...nodes.keys()], nodes)
  const notices = computeDelegateNotices(s, NOW)
  check('折叠轮/注入/welcome/其他插件/user/assistant 全部排除', notices.length === 0)
  check('折叠轮仍被 computeFoldGroups 识别（机制互不干扰）', computeFoldGroups(s).length === 2)
}

// ---- 4. 混合会话互斥 ----
console.log('=== 4. 混合会话互斥 ===')
{
  const nodes = new Map([
    ['ctx-inject', contextNode('ctx-inject', INJECT_FIRST, { kind: 'plugin', plugin: 'meow-memory', form: 'snapshot', memory: { kind: 'initial', ids: ['s1'] } })],
    ['ctx-fold', contextNode('ctx-fold', FOLD_REFLECT, { kind: 'plugin', plugin: 'meow-memory' })],
    ['ctx-marker', contextNode('ctx-marker', REFLECT_TEXT, REFLECT_SOURCE)],
  ])
  const s = snapshot(['ctx-inject', 'ctx-fold', 'ctx-marker'], nodes)
  const notices = computeDelegateNotices(s, NOW)
  check('只识别打点 1 条', notices.length === 1 && notices[0]?.id === 'ctx-marker' && notices[0]?.variant === 'reflect')
  check('打点消息不进折叠组（文本无 [meow-memory-*] marker）', computeFoldGroups(s).length === 1)
}

// ---- 5. reflect 状态配对（触发→完成交替，in-flight 防重入保证） ----
console.log('=== 5. reflect 进行中/已完成配对 ===')
{
  // 场景 A：单条触发（最后一条，新鲜）→ 进行中
  {
    const nodes = new Map([['ctx-r', contextNode('ctx-r', REFLECT_TEXT, REFLECT_SOURCE, FRESH)]])
    const [n] = computeDelegateNotices(snapshot(['ctx-r'], nodes), NOW)
    check('A 单条新鲜触发 → 进行中', n?.running === true)
  }
  // 场景 B：触发 → 完成 → 触发已完成
  {
    const nodes = new Map([
      ['ctx-r1', contextNode('ctx-r1', REFLECT_TEXT, REFLECT_SOURCE, FRESH)],
      ['ctx-e1', contextNode('ctx-e1', REFLECT_DONE_TEXT, REFLECT_DONE_SOURCE, FRESH)],
    ])
    const ns = computeDelegateNotices(snapshot(['ctx-r1', 'ctx-e1'], nodes), NOW)
    check('B 有完成打点 → 触发翻已完成', ns[0]?.running === false)
    check('B 完成打点在输出中（供 apply 隐藏）且 running=false', ns[1]?.variant === 'reflect-done' && ns[1]?.running === false)
  }
  // 场景 C：两次反思，第二个进行中
  {
    const nodes = new Map([
      ['ctx-r1', contextNode('ctx-r1', REFLECT_TEXT, REFLECT_SOURCE, STALE)],
      ['ctx-e1', contextNode('ctx-e1', REFLECT_DONE_TEXT, REFLECT_DONE_SOURCE, STALE)],
      ['ctx-r2', contextNode('ctx-r2', REFLECT_TEXT, REFLECT_SOURCE, FRESH)],
    ])
    const ns = computeDelegateNotices(snapshot(['ctx-r1', 'ctx-e1', 'ctx-r2'], nodes), NOW)
    check('C 第一次反思（有完成+非最后）→ 已完成', ns[0]?.running === false)
    check('C 第二次反思（最后一条，新鲜）→ 进行中', ns[2]?.running === true)
  }
  // 场景 D：最后一条但超保鲜窗（历史回看）→ 已完成
  {
    const nodes = new Map([['ctx-r', contextNode('ctx-r', REFLECT_TEXT, REFLECT_SOURCE, STALE)]])
    const [n] = computeDelegateNotices(snapshot(['ctx-r'], nodes), NOW)
    check('D 最后一条但 40 分钟前 → 已完成', n?.running === false)
  }
  // 场景 E：缺 time（异常数据）保守视为已完成
  {
    const nodes = new Map([['ctx-r', contextNode('ctx-r', REFLECT_TEXT, REFLECT_SOURCE)]])
    const [n] = computeDelegateNotices(snapshot(['ctx-r'], nodes), NOW)
    check('E 无 time → 保守已完成', n?.running === false)
  }
}

// ---- 6. dream 状态（空状态表=未知 → 默认进行中） ----
console.log('=== 6. dream 状态退化 ===')
{
  const nodes = new Map([
    ['ctx-d', contextNode('ctx-d', DREAM_TEXT, DREAM_SOURCE)],
    ['ctx-ds', contextNode('ctx-ds', DREAM_TEXT, { ...DREAM_SOURCE, memory: { kind: 'dream-marker', sessionId: 'session-abc' } })],
  ])
  const s = snapshot(['ctx-d', 'ctx-ds'], nodes)
  const ns = computeDelegateNotices(s, NOW)
  check('空状态表（无 SSE 信息）→ 默认进行中', ns.every((n) => n.running === true))
}

// ---- 7. 畸形节点防护：不抛（issue #2 fail-open 纪律） ----
console.log('=== 7. 畸形节点防护 ===')
{
  const nodes = new Map([
    ['bad-1', { key: 'bad-1', kind: 'context' }], // 无 data
    ['bad-2', { key: 'bad-2', kind: 'context', data: {} }], // 无 source
    ['bad-3', { key: 'bad-3', kind: 'context', data: { source: null } }], // source=null
    ['bad-4', { key: 'bad-4', kind: 'context', data: { source: { kind: 'plugin', plugin: 'meow-memory' } } }], // 无 content
    ['ctx-r', contextNode('ctx-r', REFLECT_TEXT, REFLECT_SOURCE)],
  ])
  const s = snapshot(['bad-1', 'bad-2', 'bad-3', 'bad-4', 'ctx-r'], nodes)
  let notices
  try {
    notices = computeDelegateNotices(s, NOW)
    check('畸形节点不抛异常', true)
  } catch {
    check('畸形节点不抛异常', false)
  }
  check('畸形节点跳过，正常打点仍识别', notices?.length === 1 && notices[0]?.id === 'ctx-r')
}

// ---- 8. 文案（含状态映射） ----
console.log('=== 8. delegateNoticeLabelFor 文案 ===')
{
  check('reflect 进行中', delegateNoticeLabelFor('reflect', true) === '▸ 记忆反思任务进行中……')
  check('reflect 已完成', delegateNoticeLabelFor('reflect', false) === '▸ 记忆反思任务已完成。')
  check('dream 进行中', delegateNoticeLabelFor('dream', true) === '▸ 梦境记忆整理任务进行中……')
  check('dream 已完成', delegateNoticeLabelFor('dream', false) === '▸ 梦境记忆整理任务已完成。')
  check('reflect-done 恒已完成', delegateNoticeLabelFor('reflect-done', true) === '▸ 记忆反思任务已完成。')
  check('对象入口直通', delegateNoticeLabel({ id: 'x', variant: 'dream', running: true }) === '▸ 梦境记忆整理任务进行中……')
}

// ---- 9. marker 常量与 host 端 delegate.ts 逐字一致（复制常量的对账断言） ----
console.log('=== 9. marker 常量对账 ===')
{
  check('REFLECT_DELEGATE_MARKER = 【记忆反思标记】', REFLECT_DELEGATE_MARKER === '【记忆反思标记】')
  check('REFLECT_DONE_DELEGATE_MARKER = 【记忆反思完成标记】', REFLECT_DONE_DELEGATE_MARKER === '【记忆反思完成标记】')
  check('DREAM_DELEGATE_MARKER = 【记忆整理标记】', DREAM_DELEGATE_MARKER === '【记忆整理标记】')
}

// ---- 10. fail-closed：快照无 chat 时降级不打点（PR #11 同款守卫，dsh 0.1.2-alpha.4 形状漂移） ----
console.log('=== 10. chat 缺失 fail-closed ===')
{
  check('snapshot.chat 缺失 → 空数组不抛错', Array.isArray(computeDelegateNotices({}, NOW)) && computeDelegateNotices({}, NOW).length === 0)
  check('chat 缺失时 computeFoldGroups 同款降级（守卫对齐）', computeFoldGroups({}).length === 0 && computeInjectionGroups({}).length === 0)
  check('snapshot 本身 undefined → 空数组不抛错', computeDelegateNotices(undefined, NOW).length === 0)
}

console.log(failures === 0 ? '\nALL DELEGATE-NOTICE TESTS PASSED ✅' : `\n${failures} FAILURES ❌`)
process.exit(failures === 0 ? 0 : 1)
