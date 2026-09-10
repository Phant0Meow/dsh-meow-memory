/**
 * meow-memory v2 测试（无 LLM、无 harness）。
 * 部分 1：模块级（db / migrate / inject / reflect / bm25）。
 * 部分 2：apply 级（mock ctx：工具注册、pre-step 注入、turn-stopping 反思、disabled）。
 * 用法：node test.mjs（先 build）
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  fillTemplate,
  getMemoryGuide,
  getPromptLang,
  keyedValue,
  resolveSlotText,
  setPromptLang,
  MemoryDb,
  memoryDbPath,
  getDb,
  closeAllDbs,
  migrateLegacy,
  buildInjection,
  buildHitInjection,
  buildReinjection,
  buildReflectMessage,
  markProjectQueried,
  readProjectQueried,
  isReinjectPending,
  MAX_REINJECT_WRITTEN,
  newId,
  projectCovers,
  projectLabel,
  projectList,
  isGlobalProject,
  globalProjectMarker,
  relativeTime,
  collectDreamRounds,
  buildDreamMessage,
  windowNeedsDream,
  startWindowDream,
  resumeAndDream,
  dreamSweepOnce,
  isSubagentAgent,
  advanceDream,
  abortDream,
  recoverInterruptedDream,
  dreamCommandDefinition,
  findSimilar,
  markInjected,
  markSearched,
  markAccessed,
  markWritten,
  releaseSeen,
  readSeen,
  readWritten,
  getCurrentProject,
  setCurrentProject,
  hourInTimeZone,
  minutesInTimeZone,
  isDreamSuppressed,
  collectDreamStates,
  sessionEventsOf,
} from './lib/index.js'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`FAIL  ${name} ${detail}`) }
}

// ═══════════════════════ 部分 1：模块级 ═══════════════════════

const ws = mkdtempSync(join(tmpdir(), 'mm-test-'))
const db = new MemoryDb(memoryDbPath(ws))

// db CRUD
const s1 = db.insert({ level: 'soul', content: '我是用户的长期协作伙伴，重事实轻客套。', importance: 3 })
check('soul insert uuid', s1.id.length === 36)
db.insert({ level: 'user', content: '用户偏好中文交流，先备份再改代码。' })
db.insert({ level: 'project', content: 'femGen 集成 dsh 插件的设计定稿', project: 'femwa', title: 'femGen 集成' })
db.insert({ level: 'fact', content: 'Node v22 自带 node:sqlite 可用', project: 'dsh' })
db.insert({ level: 'lesson', content: '每轮注入没意义，模型能看见上下文', corrected: 1 })
db.insert({ level: 'topic', content: '【起因】重构记忆插件【经过】设计讨论【结果】未定', title: 'meow-memory 重构', goal: '让记忆插件 v2 上线' })
check('six levels insert', db.count('soul') === 1 && db.count('user') === 1 && db.count('project') === 1 &&
  db.count('fact') === 1 && db.count('lesson') === 1 && db.count('topic') === 1 && db.count('rules') === 0)
const found = db.findById(s1.id)
check('findById cross-table', found?.level === 'soul' && found.row.content.includes('长期协作'))
check('lesson corrected flag', db.list('lesson')[0].corrected === 1)
check('topic goal stored', db.list('topic')[0].goal === '让记忆插件 v2 上线')
check('project name stored', db.list('project')[0].project === 'femwa')
check('update status', db.update('topic', db.list('topic')[0].id, { status: 'stale' }) &&
  db.list('topic', { status: 'stale' }).length === 1)
check('findById miss', db.findById('nope') === undefined)
const byPrefix = db.findById(s1.id.slice(0, 8))
check('findById prefix match', byPrefix?.level === 'soul' && byPrefix.row.id === s1.id)
const topicId = db.list('topic')[0].id
check('update by prefix', db.update('topic', topicId.slice(0, 8), { status: 'active' }) &&
  db.list('topic', { status: 'active' }).length === 1)

// ── dream v2 数据层：时间前缀 id / 新列 / status 检索语义 / windows ────────
check('newId time-prefixed', /^[0-9a-z]{9}-/.test(newId()) && newId().length === 36)
const early = newId(Date.now() - 1000)
const late = newId(Date.now())
check('newId order = creation order', early < late)
const p1 = db.insert({ level: 'project', content: '项目目标概述', project: 'femwa', subcategory: 'overview' })
check('subcategory stored', db.findById(p1.id)?.row.subcategory === 'overview')
check('updated_at default now', db.findById(p1.id)?.row.updated_at !== null)
const beforeUp = db.findById(p1.id)?.row.updated_at ?? 0
db.update('project', p1.id, { importance: 2 })
check('update refreshes updated_at', (db.findById(p1.id)?.row.updated_at ?? 0) >= beforeUp)
const todo = db.insert({ level: 'project', content: '待办事项', project: 'femwa', subcategory: 'todo' })
db.update('project', todo.id, { status: 'stale' })
check('todo stale NOT in active list', db.list('project', { status: 'active' }).some((r) => r.id === todo.id) === false)
check('todo stale IS searchable (done)', db.listSearchable('project').some((r) => r.id === todo.id))
const factStale = db.insert({ level: 'fact', content: '过时事实', project: 'dsh' })
db.update('fact', factStale.id, { status: 'stale' })
check('non-todo stale NOT searchable', db.listSearchable('fact').some((r) => r.id === factStale.id) === false)

// 旧 UUID 升级重排 + dream_at 列迁移（并入 updated_at 后删除）
const wsUp = mkdtempSync(join(tmpdir(), 'mm-up-'))
const dbUp = new MemoryDb(memoryDbPath(wsUp))
const legacyId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
dbUp.db.exec('ALTER TABLE fact ADD COLUMN dream_at INTEGER')
dbUp.db.prepare(`INSERT INTO fact (id, title, content, importance, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at, dream_at, project) VALUES (?, NULL, '旧条目', 1, '[]', 'active', NULL, 0, 1000, 1000, NULL, 5000, 'dsh')`).run(legacyId)
dbUp.close()
const dbUp2 = new MemoryDb(memoryDbPath(wsUp)) // 重新打开触发 upgrade
const upgraded = dbUp2.db.prepare('SELECT id, updated_at FROM fact').get()
check('legacy id re-ordered', upgraded.id !== legacyId && /^[0-9a-z]{9}-/.test(upgraded.id))
check('dream_at merged into updated_at', upgraded.updated_at === 5000)
const dreamCols = dbUp2.db.prepare('PRAGMA table_info(fact)').all().map((c) => c.name)
check('dream_at column dropped', !dreamCols.includes('dream_at'))
const tcols = dbUp2.db.prepare('PRAGMA table_info(topic)').all().map((c) => c.name)
check('topic.project column added', tcols.includes('project'))
check('topic insert with project', dbUp2.insert({ level: 'topic', content: '话题', title: 't', project: 'femwa' }).project === 'femwa')
dbUp2.close()

// windows 表
const dbW = new MemoryDb(memoryDbPath(ws))
dbW.touchWindow('win-1', ws, 1000)
dbW.touchWindow('win-1', ws, 2000)
check('window touch max time', dbW.getWindow('win-1')?.last_event_time === 2000)
check('window needs dream (no dream yet)', windowNeedsDream({ last_event_time: Date.now(), last_dream_time: null }))
// 冷却期（2026-09-05）：dream 收尾后 6h 内即使有新活动也不重复自动 dream
// （防"标记失败/意外刷新 last_event_time"类 bug 重复烧钱；error 重试不受影响——
// releaseDream 不写 last_dream_time，走 last_dream_time=null 路径）
check('window no dream (cooldown: new chat within 6h after dream)', windowNeedsDream({ last_event_time: Date.now(), last_dream_time: Date.now() - 1000 }) === false)
check('window needs dream (cooldown expired: new chat 7h after dream)', windowNeedsDream({ last_event_time: Date.now() - 1000, last_dream_time: Date.now() - 7 * 3600_000 }))
check('window no dream (dream after chat)', windowNeedsDream({ last_event_time: Date.now(), last_dream_time: Date.now() + 1000 }) === false)
check('window no dream (older than 24h)', windowNeedsDream({ last_event_time: Date.now() - 25 * 3600_000, last_dream_time: null }) === false)

// dream_skip 跳过表（v0.16.0：会话菜单「跳过梦境整理记忆」toggle 的持久层）
check('dreamSkip off by default', dbW.isDreamSkipped('win-1') === false && dbW.listDreamSkips().length === 0)
dbW.setDreamSkip('win-1', true)
dbW.setDreamSkip('win-2', true)
check('dreamSkip set + list', dbW.isDreamSkipped('win-1') === true && dbW.isDreamSkipped('win-2') === true &&
  dbW.listDreamSkips().sort().join(',') === 'win-1,win-2')
dbW.setDreamSkip('win-1', true) // 幂等重复 set
check('dreamSkip idempotent set', dbW.listDreamSkips().length === 2)
dbW.setDreamSkip('win-1', false)
check('dreamSkip clear', dbW.isDreamSkipped('win-1') === false && dbW.listDreamSkips().join(',') === 'win-2')
dbW.setDreamSkip('win-absent', false) // 对未标记会话清除不抛
check('dreamSkip clear absent no-op', dbW.listDreamSkips().join(',') === 'win-2')
dbW.setDreamSkip('win-2', false)

// dream 抢占与收尾（租约：防重复 dream，跨进程/重启后状态一致）
const LEASE = 60_000
check('claimDream succeeds first', dbW.claimDream('win-1', 'o1', 1000, LEASE) === true)
check('claimDream second fails (active lease)', dbW.claimDream('win-1', 'o2', 1000, LEASE) === false)
check('isDreamPending true', dbW.isDreamPending('win-1') === true)
check('getDreamLease reads owner/idx/T', (() => { const l = dbW.getDreamLease('win-1'); return l !== null && l.owner === 'o1' && l.group_idx === 0 && l.T === 1000 })())
dbW.finishDream('win-1', 3000)
check('finishDream clears lease', dbW.isDreamPending('win-1') === false && dbW.getDreamLease('win-1') === null)
check('finishDream sets last_dream_time', dbW.getWindow('win-1')?.last_dream_time === 3000)
check('claimDream succeeds after finish', dbW.claimDream('win-1', 'o3', 1000, LEASE) === true)
check('claim on missing window creates row', dbW.claimDream('win-missing', 'o4', 1000, LEASE) === true &&
  dbW.getDreamLease('win-missing')?.owner === 'o4')
dbW.finishDream('win-missing', 0)
dbW.finishDream('win-1', 0)
// 租约过期后可被重新抢占（模拟主人死亡）
dbW.claimDream('win-1', 'o5', 1000, LEASE)
dbW.db.prepare('UPDATE windows SET dream_progress_at = ? WHERE session_id = ?').run(Date.now() - 2 * LEASE, 'win-1')
check('claimDream reclaims expired lease', dbW.claimDream('win-1', 'o6', 2000, LEASE) === true)
check('getDreamLease reads reclaimed owner/T', (() => { const l = dbW.getDreamLease('win-1'); return l !== null && l.owner === 'o6' && l.T === 2000 })())
// releaseDream（2026-09-05 error 重试语义）：只清租约，last_dream_time 不动
dbW.finishDream('win-1', 5000)
dbW.claimDream('win-1', 'o7', 1000, LEASE)
dbW.releaseDream('win-1')
check('releaseDream clears lease', dbW.isDreamPending('win-1') === false && dbW.getDreamLease('win-1') === null)
check('releaseDream keeps last_dream_time', dbW.getWindow('win-1')?.last_dream_time === 5000)
dbW.finishDream('win-1', 0)

// 全局检查门：minIntervalMs 内只有一个调用方通过（防多实例/多定时器叠加重复检查）
check('check gate passes first', dbW.claimCheckGate(0) === true)
check('check gate blocks within interval', dbW.claimCheckGate(86_400_000) === false)
check('check gate passes after interval', dbW.claimCheckGate(0) === true)

// v0.23.1：进程重启后 agent-missing 窗口从 persistence 恢复 agent → dream 自动触发（不需要人碰窗口）
{
  const cfgR = { enabled: true, idleMinutes: 180, checkMinutes: 15, suppressWindows: [], suppressLeadMinutes: 15, timeZone: 'Asia/Shanghai', rulesReviewDays: 2 }
  const wsR = mkdtempSync(join(tmpdir(), 'mm-resume-'))
  const dbR = getDb(wsR, '.dsh-meow')
  const widR = 'win-resume-1'
  dbR.touchWindow(widR, wsR, Date.now() - 4 * 3600_000) // 空闲 4h，need=true
  dbR.insert({ level: 'fact', content: '恢复后要整理的记忆', project: 'dsh', source_session: widR, created_at: 100 })
  const steered = []
  const resumedAgent = { session: { header: { id: widR } }, steer: (m) => steered.push(m) }
  // mock 对齐现行契约：resume 在 agents service 本体（service.resume(options)），
  // factory 槽是 { target } 包装、其上无 resume（src/dream.ts resumeAndDream 实证）。
  const ctxR = { get: (name) => (name === 'agents' ? { resume: async () => resumedAgent } : undefined) }
  await resumeAndDream(ctxR, widR, wsR, '.dsh-meow', undefined, cfgR)
  check('resume: agent restored → dream started (steered + lease)', steered.length === 1 && dbR.getDreamLease(widR) !== null)

  const wsR2 = mkdtempSync(join(tmpdir(), 'mm-resume-fail-'))
  const dbR2 = getDb(wsR2, '.dsh-meow')
  const widR2 = 'win-resume-2'
  dbR2.touchWindow(widR2, wsR2, Date.now() - 4 * 3600_000)
  dbR2.insert({ level: 'fact', content: '恢复失败窗口的记忆', project: 'dsh', source_session: widR2, created_at: 100 })
  const ctxR2 = { get: (name) => (name === 'agents' ? { resume: async () => { throw new Error('session file gone') } } : undefined) }
  await resumeAndDream(ctxR2, widR2, wsR2, '.dsh-meow', undefined, cfgR)
  check('resume: failure degrades silently (no lease, no throw)', dbR2.getDreamLease(widR2) === null)

  const wsR3 = mkdtempSync(join(tmpdir(), 'mm-resume-dedup-'))
  const dbR3 = getDb(wsR3, '.dsh-meow')
  const widR3 = 'win-resume-3'
  dbR3.touchWindow(widR3, wsR3, Date.now() - 4 * 3600_000)
  dbR3.insert({ level: 'fact', content: '防重入窗口的记忆', project: 'dsh', source_session: widR3, created_at: 100 })
  let resumeCalls = 0
  let releaseResume
  const gate = new Promise((r) => { releaseResume = r })
  const ctxR3 = { get: (name) => (name === 'agents' ? { resume: async () => { resumeCalls++; await gate; return resumedAgent } } : undefined) }
  const p1 = resumeAndDream(ctxR3, widR3, wsR3, '.dsh-meow', undefined, cfgR)
  const p2 = resumeAndDream(ctxR3, widR3, wsR3, '.dsh-meow', undefined, cfgR)
  releaseResume()
  await Promise.all([p1, p2])
  check('resume: in-flight dedup (single resume call)', resumeCalls === 1)

  // not-found 退避（2026-09-05）：跨实例/已删除窗口的 resume 永久失败，6h 内不再重试
  const wsR4 = mkdtempSync(join(tmpdir(), 'mm-resume-backoff-'))
  const dbR4 = getDb(wsR4, '.dsh-meow')
  const widR4 = 'win-resume-backoff-1'
  dbR4.touchWindow(widR4, wsR4, Date.now() - 4 * 3600_000)
  dbR4.insert({ level: 'fact', content: 'not-found 退避窗口的记忆', project: 'dsh', source_session: widR4, created_at: 100 })
  let resumeCalls4 = 0
  const ctxR4 = { get: (name) => (name === 'agents' ? { resume: async () => { resumeCalls4++; throw new Error('session "win-resume-backoff-1" not found') } } : undefined) }
  await resumeAndDream(ctxR4, widR4, wsR4, '.dsh-meow', undefined, cfgR)
  check('resume: not-found degrades silently (no lease)', dbR4.getDreamLease(widR4) === null && resumeCalls4 === 1)
  await resumeAndDream(ctxR4, widR4, wsR4, '.dsh-meow', undefined, cfgR)
  check('resume: not-found backed off (no retry within window)', resumeCalls4 === 1)
  dbR4.close()
  rmSync(wsR4, { recursive: true, force: true })
}

// 递归 dream 修复（2026-09-05 猫猫拍板）：delegate fork 的子代理会话会进 windows 表，
// 但 dream 只归主窗口——dream 子代理→再进表→再被 dream，depth 无限套娃（真机实证
// 8fbc5d59→2f47c15b→63dad87b）。自动扫描跳过 origin=subagent；手动路径不受影响。
{
  // 判定函数口径（与 index.ts 注入链同源）：origin 权威 + depth 双保险；parentSession 不参与
  check('isSubagentAgent: origin=subagent → true', isSubagentAgent({ session: { header: { origin: 'subagent' } } }) === true)
  check('isSubagentAgent: depth>0 without origin → true', isSubagentAgent({ session: { header: { delegationDepth: 2 } } }) === true)
  check('isSubagentAgent: main session (no origin/depth) → false', isSubagentAgent({ session: { header: { id: 'x' } } }) === false)
  check('isSubagentAgent: GUI fork main session (parentSession only) → false', isSubagentAgent({ session: { header: { id: 'x', parentSession: 'p' } } }) === false)
  check('isSubagentAgent: missing header → false', isSubagentAgent({}) === false)

  const cfgS = { enabled: true, idleMinutes: 180, checkMinutes: 15, suppressWindows: [], suppressLeadMinutes: 15, timeZone: 'Asia/Shanghai', rulesReviewDays: 2 }
  const wsS = mkdtempSync(join(tmpdir(), 'mm-subagent-'))
  const dbS = getDb(wsS, '.dsh-meow')
  const widS = 'win-subagent-1'
  dbS.touchWindow(widS, wsS, Date.now() - 4 * 3600_000) // 空闲 4h，need=true
  dbS.insert({ level: 'fact', content: '子代理窗口的记忆', project: 'dsh', source_session: widS, created_at: 100 })

  // ① sweep 单轮：live agent 是子代理 → 不 start，且窗口进缓存（下轮连 agent 都不取）
  const subAgent = { session: { header: { id: widS, origin: 'subagent', delegationDepth: 1 } }, steer: () => {} }
  let getS = 0
  const ctxS = { get: (name) => (name === 'agents' ? { get: () => { getS++; return subAgent } } : undefined) }
  const winIndexS = new Map([[widS, wsS]])
  dreamSweepOnce(ctxS, cfgS, '.dsh-meow', winIndexS)
  check('sweep: subagent window not dreamed (no lease)', dbS.getDreamLease(widS) === null)
  // ② 缓存命中：第二轮不再取 agent（无 resume/无重复判定开销）
  dreamSweepOnce(ctxS, cfgS, '.dsh-meow', winIndexS)
  check('sweep: subagent cache hit (agent fetched only once)', getS === 1)

  // ③ resume 链：resume 成功但 header.origin=subagent → 不 start
  const widS2 = 'win-subagent-2'
  dbS.touchWindow(widS2, wsS, Date.now() - 4 * 3600_000)
  dbS.insert({ level: 'fact', content: '子代理恢复窗口的记忆', project: 'dsh', source_session: widS2, created_at: 100 })
  const ctxS2 = { get: (name) => (name === 'agents' ? { resume: async () => ({ session: { header: { id: widS2, origin: 'subagent' } } }) } : undefined) }
  await resumeAndDream(ctxS2, widS2, wsS, '.dsh-meow', undefined, cfgS)
  check('resume: subagent restored but not dreamed (no lease)', dbS.getDreamLease(widS2) === null)

  // ③b resume 链：resume resolve 但 agent 无可用 header（真机实测=子代理会话的 resume
  // 行为，主会话恒返回完整 agent）→ 不 start 且标缓存，下轮 sweep 直接跳过
  const widS2b = 'win-subagent-2b'
  dbS.touchWindow(widS2b, wsS, Date.now() - 4 * 3600_000)
  dbS.insert({ level: 'fact', content: '不可恢复句柄窗口的记忆', project: 'dsh', source_session: widS2b, created_at: 100 })
  let resumeCalls2b = 0
  const ctxS2b = { get: (name) => (name === 'agents' ? { resume: async () => { resumeCalls2b++; return undefined } } : undefined) }
  await resumeAndDream(ctxS2b, widS2b, wsS, '.dsh-meow', undefined, cfgS)
  check('resume: unusable agent not dreamed (no lease)', dbS.getDreamLease(widS2b) === null)
  const winIndexS2b = new Map([[widS2b, wsS]])
  dreamSweepOnce(ctxS, cfgS, '.dsh-meow', winIndexS2b)
  check('resume: unusable agent cached (sweep skips without resume)', resumeCalls2b === 1)

  // ④ 主窗口不受影响：同库主窗口 agent（无 origin）正常 start
  const widS3 = 'win-main-1'
  dbS.touchWindow(widS3, wsS, Date.now() - 4 * 3600_000)
  dbS.insert({ level: 'fact', content: '主窗口的记忆', project: 'dsh', source_session: widS3, created_at: 100 })
  const mainAgent = { session: { header: { id: widS3 } }, steer: () => {} }
  dreamSweepOnce({ get: (name) => (name === 'agents' ? { get: () => mainAgent } : undefined) }, cfgS, '.dsh-meow', new Map([[widS3, wsS]]))
  check('sweep: main window still dreamed (lease held)', dbS.getDreamLease(widS3) !== null)

  // ⑤ 手动路径豁免：startWindowDream 直呼（/dream、memory_dream 走这里）不被判定拦截
  const steeredS = []
  const manualAgent = { session: { header: { id: widS, origin: 'subagent' } }, steer: (m) => steeredS.push(m) }
  startWindowDream({ get: () => undefined }, manualAgent, wsS, '.dsh-meow')
  check('manual startWindowDream not blocked for subagent', steeredS.length === 1)

  dbS.close()
  rmSync(wsS, { recursive: true, force: true })
}

// dream 分轮结构：原子（project/fact/lesson）/ topic / 项目总结；本窗口建立 ∪ 提取过的记忆；project 小标题
const wsD = mkdtempSync(join(tmpdir(), 'mm-dream-'))
const dbD = new MemoryDb(memoryDbPath(wsD))
const wid = 'win-dream-1'
dbD.insert({ level: 'project', content: '概述', project: 'dsh', subcategory: 'overview', source_session: wid, created_at: 100 })
dbD.insert({ level: 'lesson', content: '坑1', project: 'dsh', source_session: wid, created_at: 300 })
dbD.insert({ level: 'fact', content: '事实1', project: 'dsh', source_session: wid, created_at: 200, keywords: ['事实', '测试'] })
dbD.insert({ level: 'topic', content: '话题内容', title: '话题X', project: 'dsh', source_session: wid, created_at: 150 })
dbD.insert({ level: 'fact', content: '无项目事实', source_session: wid, created_at: 400 })
dbD.insert({ level: 'project', content: '其他项目条目', project: 'femwa', source_session: wid, created_at: 50 })
dbD.insert({ level: 'soul', content: 'soul 条目', source_session: wid, created_at: 1 })
dbD.insert({ level: 'user', content: 'user 条目', source_session: wid, created_at: 2 })
dbD.insert({ level: 'rules', content: '项目规则', project: 'dsh', source_session: wid, created_at: 350 })
// 其他窗口建立、本窗口提取过的 → 应纳入；本窗口没提取过的其他窗口记忆 → 不应出现
const otherFact = dbD.insert({ level: 'fact', content: '提取过的事实', project: 'dsh', source_session: 'win-other', created_at: 500 })
const otherTopic = dbD.insert({ level: 'topic', content: '提取过的话题', title: '外来话题', project: 'femwa', source_session: 'win-other', created_at: 600 })
dbD.insert({ level: 'fact', content: '没提取过的', project: 'meow-eyes', source_session: 'win-other2', created_at: 700 })
markInjected(wsD, wid, [otherFact.id, otherTopic.id], '.dsh-meow') // 模拟本窗口提取记录（injected）
const rounds = collectDreamRounds(dbD, wid, wsD, '.dsh-meow')
check('dream rounds: 3 (atomic + topic + project-summary)', rounds.length === 3 && rounds[0].kind === 'atomic' && rounds[1].kind === 'topic' && rounds[2].kind === 'project-summary', `got ${JSON.stringify(rounds.map((r) => r.kind))}`)
check('project-summary round lists window projects sorted', JSON.stringify(rounds[2].projects) === JSON.stringify(['dsh', 'femwa']), `got ${JSON.stringify(rounds[2].projects)}`)
check('atomic groups: dsh, femwa, unlabeled last', rounds[0].groups.map((g) => g.name).join(',') === 'dsh,femwa,', `got ${rounds[0].groups.map((g) => g.name).join(',')}`)
const dshGroup = rounds[0].groups.find((g) => g.name === 'dsh')
check('atomic level order project→fact→lesson→rules', dshGroup !== undefined && dshGroup.rows.map((r) => r.level).join(',') === 'project,fact,fact,lesson,rules')
check('atomic time order within level', dshGroup !== undefined && dshGroup.rows.filter((r) => r.level === 'fact').map((r) => r.content).join(',') === '事实1,提取过的事实')
check('atomic excludes topic', rounds[0].groups.every((g) => g.rows.every((r) => r.level !== 'topic')))
check('soul/user/rules included in atomic round', rounds[0].groups.some((g) => g.rows.some((r) => r.level === 'soul')) && rounds[0].groups.some((g) => g.rows.some((r) => r.level === 'user')) && rounds[0].groups.some((g) => g.rows.some((r) => r.level === 'rules')) && rounds[0].groups.some((g) => g.rows.some((r) => r.level === 'rules' && r.project === 'dsh')))
check('seen rows included, unseen other-window rows excluded', rounds[0].groups.some((g) => g.rows.some((r) => r.content === '提取过的事实')) && !rounds.some((rd) => rd.groups.some((g) => g.rows.some((r) => r.content === '没提取过的'))))
check('topic round: only topic, own + seen included', rounds[1].groups.every((g) => g.rows.every((r) => r.level === 'topic')) && rounds[1].groups.some((g) => g.rows.some((r) => r.title === '话题X')) && rounds[1].groups.some((g) => g.rows.some((r) => r.title === '外来话题')))
const dreamMsg0 = buildDreamMessage(dbD, wid, 5000, rounds, 0)
const d0 = dreamMsg0.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
check('dream round0 marker + title', d0.includes('[meow-memory-dream]') && d0.includes('第 1/3 组 - 原子记忆条目'))
check('dream round0 project headings', d0.includes('【project：dsh】') && d0.includes('【project：femwa】') && d0.includes('【project：无项目 - 全局信息，或缺少项目标签】'))
check('dream round0 T label + timestamp rule', d0.includes('本窗口记忆封存时间戳：1970-01-01 00:00') && d0.includes('时间戳规则') && d0.includes('**最后更新**'))
check('dream round0 judgement + rules', d0.includes('如何判断该更新') && d0.includes('project标签是否准确') && d0.includes('importance') && d0.includes('拆分成多条') && d0.includes('本组整理完成'))
check('dream round0 row full id + absolute timestamps', /\[fact [a-z0-9]{9}-[a-z0-9]{26} \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/.test(d0))
check('dream round0 rows carry keywords line', d0.includes('关键词: 事实, 测试') && d0.includes('关键词: （无）'))
check('dream round0 excludes topic rows', !d0.includes('话题X') && !d0.includes('外来话题'))

// v0.17.0：accessed（memory_read 查阅留痕）进第一轮清单；rules 防 churn 时间过滤
const readFact = dbD.insert({ level: 'fact', content: '查阅过的事实', project: 'dsh', source_session: 'win-other3', created_at: 800 })
markAccessed(wsD, wid, [readFact.id], '.dsh-meow')
const roundsAcc = collectDreamRounds(dbD, wid, wsD, '.dsh-meow')
check('accessed rows included in round1', roundsAcc[0].groups.some((g) => g.rows.some((r) => r.content === '查阅过的事实')))
check('seen set = injected(2)+accessed(1), nothing else tracked', readSeen(wsD, wid, '.dsh-meow').size === 3)
const oldRule = dbD.insert({ level: 'rules', content: '陈年旧规则', project: 'dsh', source_session: wid })
dbD.db.prepare('UPDATE rules SET updated_at = ? WHERE id = ?').run(Date.now() - 3 * 86_400_000, oldRule.id)
dbD.insert({ level: 'rules', content: '新鲜规则', project: 'dsh', source_session: wid })
const roundsFiltered = collectDreamRounds(dbD, wid, wsD, '.dsh-meow') // 默认 rulesReviewDays=2
check('stale rule excluded by default 2d filter', !roundsFiltered[0].groups.some((g) => g.rows.some((r) => r.content === '陈年旧规则')))
check('fresh rule still included', roundsFiltered[0].groups.some((g) => g.rows.some((r) => r.content === '新鲜规则')))
const roundsNoFilter = collectDreamRounds(dbD, wid, wsD, '.dsh-meow', 0)
check('rules filter off with 0', roundsNoFilter[0].groups.some((g) => g.rows.some((r) => r.content === '陈年旧规则')))
const dreamMsg1 = buildDreamMessage(dbD, wid, 5000, rounds, 1)
const d1 = dreamMsg1.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
check('dream round1 topic title + guide', d1.includes('第 2/3 组 - topic记忆条目') && d1.includes('topic记忆更新指导') && d1.includes('拆分') && d1.includes('本组整理完成'))
check('dream round1 has topic rows, no atomic', d1.includes('话题X') && d1.includes('外来话题') && !d1.includes('事实1'))
// 第 3 轮=项目总结（用户拍板 2026-08-22）：不带条目列表，AI 自己调 memory_project 复查并精简
const dreamMsg2 = buildDreamMessage(dbD, wid, 5000, rounds, 2)
const d2 = dreamMsg2.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
check('dream round2 summary title + projects', d2.includes('第 3/3 组 - 项目总结') && d2.includes('本组涉及的项目：dsh、femwa'))
check('dream round2 memory_project flow + rules', d2.includes('请再次使用 memory_project 工具') && d2.includes('长期记忆') && d2.includes('每一条里面只讲一个要点') && d2.includes('已被你的新总结取代') && d2.includes('status=archived') && d2.includes('本组整理完成'))
check('dream round2 has no entry list', !d2.includes('【本组记忆】') && !d2.includes('事实1'))
dbD.close()

// topic 轮默认触发：窗口无任何记忆也发（空 topic 轮提示 AI 回顾建新 topic）
const wsE = mkdtempSync(join(tmpdir(), 'mm-drem-'))
const dbE = new MemoryDb(memoryDbPath(wsE))
const eRounds = collectDreamRounds(dbE, 'win-e', wsE, '.dsh-meow')
check('empty window still gets topic round', eRounds.length === 1 && eRounds[0].kind === 'topic' && eRounds[0].groups.length === 0)
const eMsg = buildDreamMessage(dbE, 'win-e', 5000, eRounds, 0)
const et = eMsg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
check('empty topic round hints new topic creation', et.includes('第 1/1 组 - topic记忆条目') && et.includes('很可能就是一个新topic'))
dbE.close()

// startWindowDream 抢占 + advanceDream 收尾 + 补收尾 + abortDream（租约链路）
const wsClaim = mkdtempSync(join(tmpdir(), 'mm-claim-'))
const dbClaim = new MemoryDb(memoryDbPath(wsClaim))
dbClaim.touchWindow('win-claim', wsClaim, Date.now())
const agentClaim = { session: { header: { id: 'win-claim', cwd: wsClaim } }, steer: () => {} }
// topic 轮默认触发：无记忆窗口也启动（空 topic 轮让 AI 回顾建新 topic）
check('startWindowDream: no memories still starts (topic round)', startWindowDream({}, agentClaim, wsClaim, '.dsh-meow') === true)
check('lease set while running', dbClaim.getDreamLease('win-claim') !== null)
advanceDream(agentClaim, '.dsh-meow') // 仅 topic 轮 → 收尾
check('advanceDream finishes (only topic round)', dbClaim.getDreamLease('win-claim') === null)
check('advanceDream sets last_dream_time', dbClaim.getWindow('win-claim')?.last_dream_time !== null)
dbClaim.insert({ level: 'fact', content: '待整理的记忆', source_session: 'win-claim' })
check('startWindowDream: ok', startWindowDream({}, agentClaim, wsClaim, '.dsh-meow') === true)
check('startWindowDream: second rejected while running', startWindowDream({}, agentClaim, wsClaim, '.dsh-meow') === false)
check('lease set while running', dbClaim.getDreamLease('win-claim') !== null)
advanceDream(agentClaim, '.dsh-meow') // 原子轮完成 → 推进到 topic 轮
check('advanceDream advances to topic round', dbClaim.getDreamLease('win-claim')?.group_idx === 1)
advanceDream(agentClaim, '.dsh-meow') // topic 轮完成 → 收尾
check('advanceDream finishes after topic round', dbClaim.getDreamLease('win-claim') === null)
check('advanceDream sets last_dream_time', dbClaim.getWindow('win-claim')?.last_dream_time !== null)
check('startWindowDream: ok again after finish', startWindowDream({}, agentClaim, wsClaim, '.dsh-meow') === true)
// 模拟中断：start 后不 advance（如同进程崩溃/重载），租约过期后补收尾恢复
dbClaim.db.prepare('UPDATE windows SET dream_progress_at = ? WHERE session_id = ?').run(Date.now() - 2 * 30 * 60_000, 'win-claim')
const nRecover = recoverInterruptedDream(dbClaim, 'win-claim', wsClaim, '.dsh-meow')
check('recoverInterruptedDream clears lease', dbClaim.getDreamLease('win-claim') === null && dbClaim.getWindow('win-claim')?.last_dream_time !== null && nRecover >= 0)
// abortDream 立即收尾（用户中止）
dbClaim.insert({ level: 'fact', content: '中止用记忆', source_session: 'win-claim' })
dbClaim.touchWindow('win-claim', wsClaim, Date.now())
startWindowDream({}, agentClaim, wsClaim, '.dsh-meow')
abortDream(agentClaim, '.dsh-meow')
check('abortDream finalizes immediately', dbClaim.getDreamLease('win-claim') === null && dbClaim.getWindow('win-claim')?.last_dream_time !== null)
dbClaim.close()

// steer 抛错兜底（2026-09-10，dsh 0.1.5 实测事故回归）：0.1.5 起 agent 的 inbox
// 从内存对象改成 session projection，投影未激活时 steer 直接抛
// "cannot read inbox state: its projection registration is not active"；
// dream 调用点在 setInterval 里，未捕获异常会把整个 dsh 进程带走。
// 修复=safeSteer 兜底 + 释放租约 + 返回 false（下个周期自然重试）。
const wsSteerFail = mkdtempSync(join(tmpdir(), 'mm-steer-fail-'))
const dbSteerFail = new MemoryDb(memoryDbPath(wsSteerFail))
dbSteerFail.touchWindow('win-steer-fail', wsSteerFail, Date.now())
dbSteerFail.insert({ level: 'fact', content: 'steer 兜底用例', source_session: 'win-steer-fail' })
const agentThrows = {
  session: { header: { id: 'win-steer-fail', cwd: wsSteerFail } },
  steer: () => {
    throw new Error('agent "win-steer-fail" cannot read inbox state: its projection registration is not active')
  },
}
check('startWindowDream: steer throw → returns false, does not crash', startWindowDream({}, agentThrows, wsSteerFail, '.dsh-meow') === false)
check('startWindowDream: steer throw → lease released for retry', dbSteerFail.getDreamLease('win-steer-fail') === null)
const steeredSteerOk = []
const agentSteerOk = { session: { header: { id: 'win-steer-fail', cwd: wsSteerFail } }, steer: (m) => steeredSteerOk.push(m) }
check(
  'startWindowDream: normal steer still starts after a failed attempt',
  startWindowDream({}, agentSteerOk, wsSteerFail, '.dsh-meow') === true && steeredSteerOk.length === 1,
)
dbSteerFail.close()

// 跨实例推进（原「孤儿收尾」）：状态在 DB 租约，任何实例的 turn-stopping 都能推进/收尾
const wsOrphan = mkdtempSync(join(tmpdir(), 'mm-orphan-'))
const dbOrphan = new MemoryDb(memoryDbPath(wsOrphan))
dbOrphan.touchWindow('win-orphan', wsOrphan, Date.now())
dbOrphan.insert({ level: 'fact', content: '孤儿窗口的记忆', source_session: 'win-orphan' })
dbOrphan.claimDream('win-orphan', 'residual-fiber', Date.now(), 60_000) // 模拟残留 fiber start 写了租约
advanceDream({ session: { header: { id: 'win-orphan', cwd: wsOrphan } } }, '.dsh-meow') // 原子轮 → topic 轮
advanceDream({ session: { header: { id: 'win-orphan', cwd: wsOrphan } } }, '.dsh-meow') // topic 轮 → 收尾
check('orphan dream finalized by advanceDream', dbOrphan.getDreamLease('win-orphan') === null &&
  dbOrphan.getWindow('win-orphan')?.last_dream_time !== null)
// 多轮推进：原子轮 → topic 轮 → 项目总结轮——advanceDream 逐轮 steer，最后一轮收尾
dbOrphan.insert({ level: 'fact', content: '第二组记忆', source_session: 'win-orphan', project: 'p2' })
dbOrphan.insert({ level: 'topic', content: '孤儿话题内容', title: '孤儿T', source_session: 'win-orphan' })
dbOrphan.touchWindow('win-orphan', wsOrphan, Date.now())
let steeredMsg = null
const agent2 = { session: { header: { id: 'win-orphan', cwd: wsOrphan } }, steer: (m) => { steeredMsg = m } }
startWindowDream({}, agent2, wsOrphan, '.dsh-meow')
check('lease group_idx 0 after start', dbOrphan.getDreamLease('win-orphan')?.group_idx === 0)
advanceDream(agent2, '.dsh-meow')
check('advanceDream advances to topic round + steers', dbOrphan.getDreamLease('win-orphan')?.group_idx === 1 && steeredMsg !== null)
advanceDream(agent2, '.dsh-meow')
const steeredText = steeredMsg !== null && Array.isArray(steeredMsg?.content) ? steeredMsg.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : ''
check('advanceDream advances to project-summary round (p2)', dbOrphan.getDreamLease('win-orphan')?.group_idx === 2 && steeredText.includes('本组涉及的项目：p2'))
advanceDream(agent2, '.dsh-meow')
check('advanceDream finalizes after last round', dbOrphan.getDreamLease('win-orphan') === null)
dbOrphan.close()


// ── recall 增强：find_similar / seen 排除 ───────────────────────────────────
const wsR = mkdtempSync(join(tmpdir(), 'mm-recall-'))
const dbR = new MemoryDb(memoryDbPath(wsR))
dbR.insert({ level: 'fact', content: '3081 端口是喵版 dsh 的 web 服务', project: 'dsh', source_session: 'win-a' })
dbR.insert({ level: 'fact', content: '3081 端口运行喵版 dsh web 服务', project: 'dsh', source_session: 'win-b' })
dbR.insert({ level: 'fact', content: '今天天气不错适合散步', project: 'dsh', source_session: 'win-c' })
dbR.insert({ level: 'fact', content: '本窗口自己写的事实', project: 'dsh', source_session: 'win-a' })
const sims = findSimilar('3081 端口是喵版 dsh 的 web 服务', [
  { id: 'b', level: 'fact', title: null, content: '3081 端口运行喵版 dsh web 服务', keywords: [], importance: 1, created_at: Date.now() },
  { id: 'c', level: 'fact', title: null, content: '今天天气不错适合散步', keywords: [], importance: 1, created_at: Date.now() },
], 5)
check('findSimilar ranks duplicate higher', sims.length === 1 && sims[0].id === 'b', `got ${JSON.stringify(sims)}`)
check('findSimilar similarity > 0.5 for near-duplicate', sims[0].similarity > 0.5, `got ${sims[0].similarity}`)

// seen 记录：markSearched 后 readSeen 合并 injected+searched
markSearched(wsR, 'win-a', ['seen-id-1'], '.dsh-meow')
const seenSet = readSeen(wsR, 'win-a', '.dsh-meow')
check('readSeen after markSearched', seenSet.has('seen-id-1'))
check('readSeen empty for other session', readSeen(wsR, 'win-b', '.dsh-meow').size === 0)

// accessed（v0.17.0）：memory_read 查阅留痕——进 dream 清单；压缩释放保留 accessed
markInjected(wsR, 'win-a', ['inj-id-1'], '.dsh-meow')
markAccessed(wsR, 'win-a', ['read-id-1'], '.dsh-meow')
check('readSeen includes accessed', readSeen(wsR, 'win-a', '.dsh-meow').has('read-id-1'))
releaseSeen(wsR, 'win-a', '.dsh-meow')
const released = JSON.parse(readFileSync(join(wsR, '.dsh-meow', 'sessions', 'win-a.json'), 'utf8'))
check('releaseSeen keeps accessed, clears injected/searched',
  released.accessed.includes('read-id-1') && released.injected.length === 0 && released.searched.length === 0 &&
  !readSeen(wsR, 'win-a', '.dsh-meow').has('inj-id-1') && !readSeen(wsR, 'win-a', '.dsh-meow').has('seen-id-1') &&
  readSeen(wsR, 'win-a', '.dsh-meow').has('read-id-1'))
dbR.close()

// ── 会话列表 dream 图标：collectDreamStates 全量判定（dreamed / dreaming 双态） ─
const wsIcon = mkdtempSync(join(tmpdir(), 'mm-icon-'))
const dbIcon = new MemoryDb(memoryDbPath(wsIcon))
dbIcon.touchWindow('s-dreamed', wsIcon, Date.now() - 1000)
dbIcon.finishDream('s-dreamed', Date.now() - 500) // dream 过且之后无活动
dbIcon.touchWindow('s-active', wsIcon, Date.now() - 3000)
dbIcon.finishDream('s-active', Date.now() - 2000)
dbIcon.touchWindow('s-active', wsIcon, Date.now() - 1000) // dream 后有新活动
dbIcon.touchWindow('s-nodream', wsIcon, Date.now()) // 从未 dream
dbIcon.touchWindow('s-dreaming', wsIcon, Date.now() - 4000)
dbIcon.claimDream('s-dreaming', 'owner-test', Date.now() - 3000, 30 * 60_000) // dream 进行中（活跃租约）
const iconStates = collectDreamStates([{ id: 'any', cwd: wsIcon }])
check('dream-states: dreamed/dreaming split', JSON.stringify(iconStates) === JSON.stringify({ dreamed: ['s-dreamed'], dreaming: ['s-dreaming'] }), JSON.stringify(iconStates))
const wsNoDb = mkdtempSync(join(tmpdir(), 'mm-nodb-'))
const iconStates2 = collectDreamStates([{ id: 'any', cwd: wsNoDb }])
check('dream-states: workspace without memory db skipped (no db created)', iconStates2.dreamed.length === 0 && iconStates2.dreaming.length === 0 && !existsSync(join(wsNoDb, '.dsh-meow', 'memory.db')))
dbIcon.close()

// ── dream 时区（用户系统是美区时间，抑制时段必须按 Asia/Shanghai 算） ───────
const midnightUtc = new Date('2026-08-15T00:00:00.000Z')
check('hourInTimeZone Shanghai at UTC midnight = 8', hourInTimeZone('Asia/Shanghai', midnightUtc) === 8)
check('hourInTimeZone UTC at UTC midnight = 0', hourInTimeZone('UTC', midnightUtc) === 0)
check('minutesInTimeZone Shanghai at UTC midnight = 480', minutesInTimeZone('Asia/Shanghai', midnightUtc) === 480)
check('minutesInTimeZone Shanghai 09:23 = 563', minutesInTimeZone('Asia/Shanghai', new Date('2026-08-15T01:23:00.000Z')) === 563)

// ── dream 峰时抑制（用户拍板 2026-08-19：空闲≥3h 允许触发；北京时间
//    09:00–12:00 / 14:00–18:00（API 峰谷电价峰时）及各自前 15 分钟不触发） ──
const suppressCfg = {
  enabled: true,
  idleMinutes: 180,
  checkMinutes: 15,
  suppressWindows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
  suppressLeadMinutes: 15,
  timeZone: 'Asia/Shanghai',
}
const sup = (iso) => isDreamSuppressed(suppressCfg, new Date(iso))
check('suppress: 08:44 allowed (before lead)', sup('2026-08-15T00:44:00.000Z') === false)
check('suppress: 08:45 blocked (15min lead)', sup('2026-08-15T00:45:00.000Z') === true)
check('suppress: 09:00 blocked (peak start)', sup('2026-08-15T01:00:00.000Z') === true)
check('suppress: 11:59 blocked (peak end-1min)', sup('2026-08-15T03:59:00.000Z') === true)
check('suppress: 12:00 allowed (peak over)', sup('2026-08-15T04:00:00.000Z') === false)
check('suppress: 13:44 allowed (before lead)', sup('2026-08-15T05:44:00.000Z') === false)
check('suppress: 13:45 blocked (15min lead)', sup('2026-08-15T05:45:00.000Z') === true)
check('suppress: 17:59 blocked (peak end-1min)', sup('2026-08-15T09:59:00.000Z') === true)
check('suppress: 18:00 allowed (peak over)', sup('2026-08-15T10:00:00.000Z') === false)
check('suppress: 00:00 allowed (midnight)', sup('2026-08-15T16:00:00.000Z') === false)
check('suppress: lead 0 disables lead-in', isDreamSuppressed({ ...suppressCfg, suppressLeadMinutes: 0 }, new Date('2026-08-15T00:45:00.000Z')) === false)
check('suppress: invalid window skipped', isDreamSuppressed({ ...suppressCfg, suppressWindows: [{ start: 'xx', end: 'yy' }] }, new Date('2026-08-15T01:00:00.000Z')) === false)

// migrate
const ws2 = mkdtempSync(join(tmpdir(), 'mm-mig-'))
mkdirSync(join(ws2, '.dsh-meow'), { recursive: true })
const legacy = [
  '# PROJECT.md — 项目记忆',
  '',
  '> 说明头',
  '',
  '**用户 GitHub：Phant0Meow，就是 FemWA 作者本人（meow@example.com）**',
  '作为长期协作伙伴，我应该重事实轻客套，先计划后动手。',
  '',
  '## 重要事实与决定 (fact)',
  '- 3081 已于 2026-08-14 重启（DSH_HOME=dsh-home）',
  '- 另一个事实',
  '',
  '## 纠错与教训 (mistake)',
  '- 被用户纠正：每轮注入没意义',
  '',
  '## 用户原话 (user_said)',
  '- "用户说：femGen 是可视化生成剧本的，重点是画图→生成剧本"',
  '',
  '## 关键细节 (detail)',
  '- dsh 子 agent API：ctx.subagents.start(spawn)',
  '',
  '## 用户偏好 (preference)',
  '- 改 dsh 原文前先备份',
].join('\n')
writeFileSync(join(ws2, '.dsh-meow', 'PROJECT.md'), legacy, 'utf8')
const db2 = new MemoryDb(memoryDbPath(ws2))
const n = migrateLegacy(db2, ws2)
check('migrate count', n === 8, `got ${n}`)
check('migrate renames file', existsSync(join(ws2, '.dsh-meow', 'PROJECT.md.imported')))
check('migrate original gone', !existsSync(join(ws2, '.dsh-meow', 'PROJECT.md')))
check('core ai line → soul', db2.list('soul').length === 1 && db2.list('soul')[0].content.includes('长期协作伙伴'))
check('core user info → user', db2.list('user').some((u) => u.content.includes('Phant0Meow')))
check('preference → user', db2.list('user').some((u) => u.content.includes('先备份')))
check('mistake → lesson corrected', db2.list('lesson').length === 1 && db2.list('lesson')[0].corrected === 1)
check('user_said → project femwa', db2.list('project').some((p) => p.project === 'femwa' && p.content.includes('femGen')))
check('detail → project dsh', db2.list('project').some((p) => p.project === 'dsh' && p.content.includes('subagents')))
check('plain fact → fact', db2.list('fact').length === 2 && db2.list('fact').some((f) => f.content.includes('3081')))
check('migrate idempotent', migrateLegacy(db2, ws2) === null)

// inject + sessions/ 去重（命中检索按新语义：未锚定只搜全局；这里先锚定 dsh 模拟干活中的会话）
setCurrentProject(ws2, 'test-session-1', 'dsh', '.dsh-meow')
db2.insert({ level: 'fact', content: '3081 端口是喵版 dsh', project: 'dsh', created_at: Date.now() })
db2.insert({ level: 'soul', content: '我是用户的长期协作伙伴。', created_at: Date.now() })
// listProjectNames：四表 project 列并集（只挂 fact 的项目名也出现）
db2.insert({ level: 'fact', content: '猫眼视觉服务', project: 'meow-eyes', created_at: Date.now() })
check('project names union includes fact-only project', db2.listProjectNames().includes('meow-eyes'))
check('project names sorted', JSON.stringify(db2.listProjectNames()) === JSON.stringify(['dsh', 'femwa', 'meow-eyes']))
db2.insert({ level: 'fact', content: '全局标记条目', project: '全局', created_at: Date.now() })
check('project names exclude 全局 marker', !db2.listProjectNames().includes('全局'))
db2.insert({ level: 'fact', content: '多项目条目', project: 'meow-fold,meow-smooth', created_at: Date.now() })
check('project names expand multi-value', db2.listProjectNames().includes('meow-fold') && db2.listProjectNames().includes('meow-smooth'))
// 导引 topic 带 project 归属
db2.insert({ level: 'topic', content: '【起因】x【经过】y【结果】z', title: '记忆插件重构', project: 'meow-memory', created_at: Date.now() })
const inj = buildInjection(db2, ws2, 'test-session-1', '3081 现在什么状态？', { hitTopK: 3 }, '.dsh-meow')
check('injection produced', inj !== null)
if (inj) {
  check('injection blocks', inj.text.includes('===== 长期记忆 =====') && inj.text.includes('【关于user】') &&
    inj.text.includes('【记忆导引】'))
  check('injection first line flush-left', inj.text.startsWith('===== 长期记忆 ====='))
  check('injection guide three lines', inj.text.includes('需要时用 memory_search 检索（必须传 query 检索词，不能空查）、memory_read 读取。') &&
    inj.text.includes('当有项目相关任务时，应先用 memory_project 查项目全景（记得带上项目名，不能空参）') &&
    inj.text.includes('用户的所有 project：'))
  check('injection no topic/project title list', !inj.text.includes('- topic:') && !inj.text.includes('- project:'))
  check('injection has no legacy prompt separator', !inj.text.includes('===== 长期记忆结束 =====') && !inj.text.includes('本轮用户prompt：'))
  check('injection tool name fixed', !inj.text.includes('memory_recall') && inj.text.includes('memory_search'))
  check('sessions file written', readFileSync(join(ws2, '.dsh-meow', 'sessions', 'test-session-1.json'), 'utf8').includes(inj.injectedIds[0]))
}
const inj2 = buildInjection(db2, ws2, 'test-session-1', '3081 又怎么了？', { hitTopK: 3 }, '.dsh-meow')
check('dedup same session', inj2 === null || !inj2.text.includes('3081 端口是喵版 dsh'))
// 首轮不命中（只注入长期记忆）；命中链路从第二轮起（buildHitInjection）
setCurrentProject(ws2, 'test-session-2', 'dsh', '.dsh-meow')
const inj3 = buildHitInjection(db2, ws2, 'test-session-2', '3081 又怎么了？', { hitTopK: 3 }, '.dsh-meow')
check('new session gets hits', inj3 !== null && inj3.text.includes('3081 端口是喵版 dsh'))
// reflect 消息（独立库：topic 归 dream，反思不含 topic 规则）
const ws3 = mkdtempSync(join(tmpdir(), 'mm-reflect-'))
const db3 = new MemoryDb(memoryDbPath(ws3))
db3.insert({ level: 'topic', content: '【起因】重构记忆插件【经过】设计讨论【结果】未定', title: 'meow-memory 重构', goal: '让记忆插件 v2 上线' })
const msg = buildReflectMessage(ws3, '我们讨论一下猫眼插件的模型部署', '.dsh-meow')
const txt = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
check('reflect message sections', txt.includes('记忆反思任务') && txt.includes('【一】') && txt.includes('【二】') && txt.includes('【三】'))
check('reflect update rules', txt.includes('信息已经过时') && txt.includes('标 stale') && txt.includes('关键词不准'))
check('reflect project list + new project check', txt.includes('已有的 project') && txt.includes('请添加新 project 的记忆'))
check('reflect keywords 8-13 + guidance', txt.includes('8-13') && txt.includes('反向思考') && txt.includes('level和标签'))
check('reflect no topic rules (topic moved to dream)', !txt.includes('目标句') && !txt.includes('相关话题底稿') && !txt.includes('宽泛名'))

// 空库 → 注入 null
const ws4 = mkdtempSync(join(tmpdir(), 'mm-empty-'))
const db4 = new MemoryDb(memoryDbPath(ws4))
check('no memory → null', buildInjection(db4, ws4, 'x', 'hi') === null)

// ═══════════════════════ 部分 2：apply 级 ═══════════════════════

function makeCtx(subagents) {
  const tools = []
  const handlers = {}
  const effects = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: console.error },
    tools: { register: (t) => tools.push(t) },
    on: (name, fn) => { handlers[name] = fn },
    effect: (fn) => { effects.push(fn); return () => {} },
    subagents: subagents ?? { start: () => { throw new Error('subagents not expected in tests') } },
  }
  return { ctx, tools, handlers, effects }
}

const { ctx, tools, handlers } = makeCtx()
await apply(ctx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh' })
check('seven tools registered', tools.length === 7 && ['memory_remember', 'memory_search', 'memory_find_similar', 'memory_read', 'memory_update', 'memory_dream', 'memory_project']
  .every((name) => tools.some((t) => t.name === name)), `got ${tools.map((t) => t.name).join(',')}`)

// memory_dream 工具入口：子代理会话拒绝（与 /dream 命令守卫同语义——fork 播种父
// 会话 turn，工具 schema 对子代理可见，误调在此拦下，不进 windows 表不留痕迹）。
// 底层 startWindowDream 的手动豁免不受影响（见上方"manual startWindowDream"用例）。
{
  const wsT = mkdtempSync(join(tmpdir(), 'mm-dream-tool-'))
  const dbT = getDb(wsT, '.dsh-meow')
  const dreamToolT = tools.find((t) => t.name === 'memory_dream')
  const subExec = { agent: { session: { header: { cwd: wsT, id: 'win-subagent-tool', origin: 'subagent' } } } }
  const rSubTool = await dreamToolT.execute({}, subExec)
  check('memory_dream tool rejects subagent session', rSubTool.ok === false && rSubTool.note.includes('子代理'), JSON.stringify(rSubTool))
  check('memory_dream tool reject leaves no window/lease', dbT.getWindow('win-subagent-tool') === undefined && dbT.getDreamLease('win-subagent-tool') === null)
  const mainExec = { agent: { session: { header: { cwd: wsT, id: 'win-main-tool' } }, steer: () => {} } }
  const rMainTool = await dreamToolT.execute({}, mainExec)
  check('memory_dream tool allows main window (dream starts, topic round)', rMainTool.ok === true && dbT.getDreamLease('win-main-tool') !== null, JSON.stringify(rMainTool))
  dbT.finishDream('win-main-tool', Date.now()) // 清理：收尾不留悬挂租约
  dbT.close()
  rmSync(wsT, { recursive: true, force: true })
}

// 返回结果引导语：search 的 note 与 read 的渲染文本都提示可去聊天记录搜更多细节
const searchTool = tools.find((t) => t.name === 'memory_search')
const execCtx = { agent: { session: { header: { cwd: ws, id: 't-search' } } } }
const searchResult = await searchTool.execute({ query: '随便' }, execCtx)
check('search note hints chat log', searchResult.note.includes('如果你确实需要更多细节，可以直接去聊天记录里搜索相关关键词'))
check('search hits carry real updated_at', searchResult.hits.every((h) => h.updated_at > 0))
// search project/status 逗号多选（OR 语义）
db.insert({ level: 'fact', content: '多选测试甲 独特内容', project: 'dsh', created_at: Date.now() })
db.insert({ level: 'fact', content: '多选测试乙 独特内容', project: 'femwa', created_at: Date.now() })
const sMulti = await searchTool.execute({ query: '多选测试', project: 'dsh,femwa' }, execCtx)
check('search project multi-select OR', sMulti.hits.some((h) => h.project === 'dsh') && sMulti.hits.some((h) => h.project === 'femwa'))
const sSingle = await searchTool.execute({ query: '多选测试', project: 'dsh' }, execCtx)
check('search project single filter', sSingle.hits.every((h) => h.project === 'dsh' || h.project === '全局' || h.project === null || h.project === ''))
const sStatus = await searchTool.execute({ query: '多选测试', status: 'archived,stale' }, execCtx)
check('search status multi-select no throw', Array.isArray(sStatus.hits))
const searchRender = searchTool.output.render({}, { note: '', hits: [{ level: 'fact', id: '0msum4ifx-bf3a-0000000000000000000000', project: 'dsh', content: 'x', keywords: ['dream', '机制'], updated_at: Date.now() - 2 * 86_400_000 }] })
check('search shows keywords + relative time, no content', searchRender.some((b) => b.text.includes('[dsh : fact]') && b.text.includes('关于：dream, 机制') && b.text.includes('2 天前') && !b.text.includes('记忆时间戳')))

// search 5+5 分段（用户拍板 2026-08-19）：前 5 条无脑取（不排除已见/本 session 建立的），
// 第 6 名起绕开已见（injected+searched）补齐。分数相同时排名稳定=插入序。
const wsSplit = mkdtempSync(join(tmpdir(), 'mm-split-'))
const dbSplit = new MemoryDb(memoryDbPath(wsSplit))
for (let i = 1; i <= 12; i++) {
  dbSplit.insert({ level: 'fact', content: `分段检索测试 内容${i} 特异性词${i}`, project: 'dsh', source_session: i === 5 || i === 12 ? 's-split' : 'win-other' })
}
const splitRows = dbSplit.list('fact')
const sid = (n) => splitRows[n - 1].id // 排名 = 插入序（BM25 分数相同）
markInjected(wsSplit, 's-split', [sid(1), sid(2)], '.dsh-meow')
markSearched(wsSplit, 's-split', [sid(6), sid(7)], '.dsh-meow')
const splitCtx = { agent: { session: { header: { cwd: wsSplit, id: 's-split' } } } }
const sp = await searchTool.execute({ query: '分段检索测试', project: 'dsh', k: 10 }, splitCtx)
const spIds = new Set(sp.hits.map((h) => h.id))
check('search 5+5: default k=10 returns 10 hits', sp.hits.length === 10, `got ${sp.hits.length}`)
check('search top5 blind includes seen (injected) entries', spIds.has(sid(1)) && spIds.has(sid(2)))
check('search rank6+ skips seen entries (6,7 excluded)', !spIds.has(sid(6)) && !spIds.has(sid(7)))
check('search blind includes this-session memory', spIds.has(sid(5)))
check('search fresh includes this-session unseen memory', spIds.has(sid(12)))
check('search 5+5 exact result set', JSON.stringify([...spIds].sort()) === JSON.stringify([1, 2, 3, 4, 5, 8, 9, 10, 11, 12].map(sid).sort()))
const spSeen = readSeen(wsSplit, 's-split', '.dsh-meow')
check('search marks all returned ids as searched', [...spIds].every((id) => spSeen.has(id)))
// 未标记（project null）条目：能检索且输出 project=''（不触发输出校验失败）
dbSplit.insert({ level: 'fact', content: '分段检索测试 未标记条目 特异性词u', project: null, source_session: 'win-other' })
const spNull = await searchTool.execute({ query: '未标记条目', project: 'dsh' }, splitCtx)
check('search unmarked row returns project=""', spNull.hits.length >= 1 && spNull.hits[0].project === '')
// k<5：全盲取（无 fresh 段）
const sp3 = await searchTool.execute({ query: '分段检索测试', project: 'dsh', k: 3 }, splitCtx)
check('search k=3: blind only', sp3.hits.length === 3 && sp3.hits.some((h) => h.id === sid(1)))
check('search description mentions 5+5 rule', searchTool.description.includes('前 5 条按相关度无脑取') && searchTool.description.includes('绕开已注入/已检索'))
dbSplit.close()
const readTool = tools.find((t) => t.name === 'memory_read')
const readNotFound = readTool.output.render({}, { found: false })
check('read not-found hints chat log', readNotFound[0].text.includes('聊天记录里搜索相关关键词'))
const readFound = readTool.output.render({}, { found: true, level: 'fact', title: 't', content: 'c', status: 'active' })
check('read found hints chat log', readFound[0].text.includes('聊天记录里搜索相关关键词'))

// memory_update 支持 keywords 手动修正（AI 主动提取/纠偏）
const updateTool = tools.find((t) => t.name === 'memory_update')
const updCtx = { agent: { session: { header: { cwd: ws, id: 't-upd' } } } }
const kwId = db.insert({ level: 'fact', content: '测试关键词修正', project: 'dsh', id: newId(1_700_000_000_000) }).id
const upRes = await updateTool.execute({ id: kwId.slice(0, 8), keywords: ['关键词甲', '关键词乙'] }, updCtx)
check('update keywords ok', upRes.ok === true)
const kwRow = db.findById(kwId)
check('update keywords applied', JSON.stringify(kwRow.row.keywords) === JSON.stringify(['关键词甲', '关键词乙']))
const upEmpty = await updateTool.execute({ id: kwId.slice(0, 8), keywords: [] }, updCtx)
check('update keywords [] keeps unchanged', upEmpty.ok === true && JSON.stringify(db.findById(kwId).row.keywords) === JSON.stringify(['关键词甲', '关键词乙']))
const up5 = await updateTool.execute({ id: kwId.slice(0, 8), importance: 5 }, updCtx)
check('update importance unbounded (no clamp)', up5.ok === true && db.findById(kwId).row.importance === 5)

// project 多值（逗号分隔）：包含判断 / 显示标签
check('projectCovers multi-value includes', projectCovers('dsh,femwa', 'femwa') === true && projectCovers('dsh,femwa', 'meow-eyes') === false)
check('projectCovers global/null covers all', projectCovers('全局', 'dsh') === true && projectCovers(null, 'dsh') === true)
check('projectLabel multi-value/global/unmarked', projectLabel('dsh,femwa') === 'dsh/femwa' && projectLabel('全局') === '全局' && projectLabel(null) === '未标记')

// 全局标记随语言包（labels.md 的 project.global）：英文包里模型写的是 "global"
check('global marker: zh pack', globalProjectMarker() === '全局' && isGlobalProject('全局') && !isGlobalProject('global'))
check('global marker: en pack recognizes its own word', (() => {
  setPromptLang('en')
  try { return globalProjectMarker() === 'global' && isGlobalProject('global') } finally { setPromptLang('zh') }
})())
check('global marker: en pack still recognizes legacy 全局 rows', (() => {
  setPromptLang('en')
  try { return isGlobalProject('全局') && projectCovers('全局', 'dsh') && projectLabel('全局') === 'global' } finally { setPromptLang('zh') }
})())
check('global marker: tolerates case and whitespace', (() => {
  setPromptLang('en')
  try { return isGlobalProject('Global') && isGlobalProject(' global ') && !isGlobalProject('globals') } finally { setPromptLang('zh') }
})())
check('global marker: en global is not a project name', (() => {
  setPromptLang('en')
  try { return projectList('global').length === 0 && projectCovers('global', 'dsh') && projectLabel('global') === 'global' } finally { setPromptLang('zh') }
})())
check('global marker: real project names untouched under en', (() => {
  setPromptLang('en')
  try { return projectList('dsh, femwa').join('|') === 'dsh|femwa' && !projectCovers('dsh', 'femwa') } finally { setPromptLang('zh') }
})())

// 注入正文里的框架词（labels.md）：zh 输出与外置前逐字节一致，en 走英文包
check('framework words: zh output unchanged', relativeTime(Date.now() - 5 * 60_000) === '5 分钟前' && relativeTime(null) === '无时间戳' && projectLabel(null) === '未标记')
check('framework words: en pack renders english', (() => {
  setPromptLang('en')
  try { return relativeTime(Date.now() - 5 * 60_000) === '5 min ago' && relativeTime(null) === 'no timestamp' && projectLabel(null) === 'unlabeled' } finally { setPromptLang('zh') }
})())
// memory_update 刷新记忆时间戳（updated_at = 最后更新时间）
const beforeTs = db.findById(kwId).row.updated_at
await new Promise((r) => setTimeout(r, 5))
const upTs = await updateTool.execute({ id: kwId.slice(0, 8), content: '测试关键词修正（时间戳刷新）' }, updCtx)
const afterTs = db.findById(kwId).row.updated_at
check('update refreshes memory timestamp', upTs.ok === true && afterTs !== null && (beforeTs === null || afterTs > beforeTs) && afterTs > Date.now() - 60_000)

// memory_remember 读回确认：返回实际存储结果（关键词/项目归属），模型知道干了什么
const rememberTool = tools.find((t) => t.name === 'memory_remember')
const remRes = await rememberTool.execute({ content: '读回确认测试关键词', level: 'fact', project: 'dsh', keywords: ['读回', '确认', '测试'], importance: 2 }, updCtx)
check('remember returns keywords', Array.isArray(remRes.keywords) && remRes.keywords.length > 0, JSON.stringify(remRes))
check('remember returns project', remRes.project === 'dsh')
check('remember render shows result', rememberTool.output.render({}, remRes)[0].text.includes('关键词：'))
// remember 四必填：缺失逐个报错并引导重填
const missP = await rememberTool.execute({ content: '缺参测试', level: 'fact' }, updCtx).catch((e) => String(e?.message ?? e))
check('remember requires project', missP.includes('project 参数必填'))
const missK = await rememberTool.execute({ content: '缺参测试', level: 'fact', project: 'dsh' }, updCtx).catch((e) => String(e?.message ?? e))
check('remember requires keywords', missK.includes('keywords 参数必填'))
const missI = await rememberTool.execute({ content: '缺参测试', level: 'fact', project: 'dsh', keywords: ['缺参', '测试'] }, updCtx).catch((e) => String(e?.message ?? e))
check('remember requires importance', missI.includes('importance 参数必填'))

// 压缩信号释放 seen：compaction 事件 → sessions 文件清空 → 记忆可再次命中
const wsSeen = mkdtempSync(join(tmpdir(), 'mm-seen-'))
const dbSeen = new MemoryDb(memoryDbPath(wsSeen))
dbSeen.insert({ level: 'fact', content: '压缩后应能重新命中的记忆', project: 'dsh', source_session: 'win-other' })
markSearched(wsSeen, 's-comp', ['fake-id-1'], '.dsh-meow')
check('seen marked before compaction', readSeen(wsSeen, 's-comp', '.dsh-meow').size === 1)
await handlers['session/event']({ id: 's-comp', header: { cwd: wsSeen } }, { type: 'compaction/summary', time: Date.now() })
check('seen released after compaction', readSeen(wsSeen, 's-comp', '.dsh-meow').size === 0)
const searchCtx2 = { agent: { session: { header: { cwd: wsSeen, id: 's-comp' } } } }
const reHit = await searchTool.execute({ query: '重新命中', project: 'dsh' }, searchCtx2)
check('search re-hits after compaction', reHit.hits.some((h) => h.content.includes('压缩后应能重新命中')))
dbSeen.close()

// ── 压缩重注入（v0.21.0）：查阅留痕 / compaction/end 置待办 / buildReinjection ──
const wsReinj = mkdtempSync(join(tmpdir(), 'mm-reinj-'))
const dbReinj = new MemoryDb(memoryDbPath(wsReinj))
dbReinj.insert({ level: 'soul', content: '重注入测试 soul 条目' })
dbReinj.insert({ level: 'user', content: '重注入测试 user 条目' })
dbReinj.insert({ level: 'project', content: 'femwa 项目重注入全景条目', project: 'femwa', subcategory: 'overview' })
const reinjProjectTool = tools.find((t) => t.name === 'memory_project')
const reinjProjCtx = { agent: { session: { header: { cwd: wsReinj, id: 's-reinj' } } } }
await reinjProjectTool.execute({ project: 'femwa' }, reinjProjCtx)
check('memory_project records projectsQueried', JSON.stringify(readProjectQueried(wsReinj, 's-reinj', '.dsh-meow')) === JSON.stringify(['femwa']))
await reinjProjectTool.execute({ project: '全局' }, reinjProjCtx)
check('memory_project 全局 not recorded', JSON.stringify(readProjectQueried(wsReinj, 's-reinj', '.dsh-meow')) === JSON.stringify(['femwa']))
// markProjectQueried：多项目拆分 / 去重最近优先 / 上限淘汰 / 全局过滤
markProjectQueried(wsReinj, 's-lru', 'x, y', '.dsh-meow')
check('markProjectQueried splits multi-project param', JSON.stringify(readProjectQueried(wsReinj, 's-lru', '.dsh-meow')) === JSON.stringify(['x', 'y']))
markProjectQueried(wsReinj, 's-lru2', 'a', '.dsh-meow')
markProjectQueried(wsReinj, 's-lru2', 'b', '.dsh-meow')
markProjectQueried(wsReinj, 's-lru2', '全局', '.dsh-meow')
check('markProjectQueried skips 全局', JSON.stringify(readProjectQueried(wsReinj, 's-lru2', '.dsh-meow')) === JSON.stringify(['a', 'b']))
markProjectQueried(wsReinj, 's-lru2', 'a', '.dsh-meow')
check('markProjectQueried moves repeat to end', JSON.stringify(readProjectQueried(wsReinj, 's-lru2', '.dsh-meow')) === JSON.stringify(['b', 'a']))
for (let i = 2; i <= 9; i++) markProjectQueried(wsReinj, 's-lru2', `p${i}`, '.dsh-meow')
const lruList = readProjectQueried(wsReinj, 's-lru2', '.dsh-meow')
check('markProjectQueried caps at MAX_REINJECT_PROJECTS', lruList.length === 8 && !lruList.includes('a') && !lruList.includes('b'))
// buildReinjection：无可注入内容 → null（空库 + 项目全空）
const wsReinjNull = mkdtempSync(join(tmpdir(), 'mm-reinj-null-'))
const dbReinjNull = new MemoryDb(memoryDbPath(wsReinjNull))
check('reinjection null when nothing to inject', buildReinjection(dbReinjNull, wsReinjNull, 's-x', ['nope'], {}, '.dsh-meow') === null)
check('reinjection null with empty project list', buildReinjection(dbReinjNull, wsReinjNull, 's-x', [], {}, '.dsh-meow') === null)
dbReinjNull.close()
// compaction/end 成功（无 error）→ 置待办；releaseSeen 保留 projectsQueried/reinjectPending
await handlers['session/event']({ id: 's-reinj', header: { cwd: wsReinj } }, { type: 'compaction/summary', time: Date.now() })
await handlers['session/event']({ id: 's-reinj', header: { cwd: wsReinj } }, { type: 'compaction/end', time: Date.now(), data: { compactionId: 'c1', turn: null } })
check('compaction/end success arms reinjection', isReinjectPending(wsReinj, 's-reinj', '.dsh-meow') === true)
check('releaseSeen keeps projectsQueried for reinjection', JSON.stringify(readProjectQueried(wsReinj, 's-reinj', '.dsh-meow')) === JSON.stringify(['femwa']))
await handlers['session/event']({ id: 's-reinj2', header: { cwd: wsReinj } }, { type: 'compaction/end', time: Date.now(), data: { compactionId: 'c2', turn: null, error: 'provider failed' } })
check('compaction/end with error does not arm', isReinjectPending(wsReinj, 's-reinj2', '.dsh-meow') === false)

// ── 写痕迹（v0.23.0）：memory_remember/memory_update 落库记 written；LRU / releaseSeen 保留 ──
const wsWritten = mkdtempSync(join(tmpdir(), 'mm-written-'))
const dbWritten = new MemoryDb(memoryDbPath(wsWritten))
const rememberToolW = tools.find((t) => t.name === 'memory_remember')
const updateToolW = tools.find((t) => t.name === 'memory_update')
const writtenCtx = { agent: { session: { header: { cwd: wsWritten, id: 's-w' } } } }
const r1 = await rememberToolW.execute({ content: '本会话新建的记忆条目', project: 'femwa', keywords: ['新建', '记忆', '测试', '压缩', '重注入', '回放', '痕迹', '条目'], importance: 1 }, writtenCtx)
check('remember insert records written', readWritten(wsWritten, 's-w', '.dsh-meow').includes(r1.id))
const r2 = await rememberToolW.execute({ content: '本会话新建的记忆条目', project: 'femwa', keywords: ['新建', '记忆', '测试', '压缩', '重注入', '回放', '痕迹', '条目'], importance: 2 }, writtenCtx)
check('remember merge records written', r2.merged === true && r2.id === r1.id && readWritten(wsWritten, 's-w', '.dsh-meow').includes(r2.id))
const r3 = await updateToolW.execute({ id: r1.id, importance: 3 }, writtenCtx)
check('update success records written', r3.ok === true && readWritten(wsWritten, 's-w', '.dsh-meow').includes(r1.id))
const r4 = await updateToolW.execute({ id: 'nonexistent-id-xxxx', importance: 1 }, writtenCtx)
check('update not-found does not record', r4.ok === false && readWritten(wsWritten, 's-w', '.dsh-meow').length === 1)
await updateToolW.execute({ id: r1.id, keywords: [] }, writtenCtx) // 空 patch = 不更新
check('empty patch update does not change written', readWritten(wsWritten, 's-w', '.dsh-meow').length === 1)
markWritten(wsWritten, 's-wlru', ['a', 'b'], '.dsh-meow')
markWritten(wsWritten, 's-wlru', ['a'], '.dsh-meow')
check('markWritten moves repeat to end', JSON.stringify(readWritten(wsWritten, 's-wlru', '.dsh-meow')) === JSON.stringify(['b', 'a']))
for (let i = 0; i < MAX_REINJECT_WRITTEN + 3; i++) markWritten(wsWritten, 's-wlru2', [`w${i}`], '.dsh-meow')
const wlru = readWritten(wsWritten, 's-wlru2', '.dsh-meow')
check('markWritten caps at MAX_REINJECT_WRITTEN', wlru.length === MAX_REINJECT_WRITTEN && !wlru.includes('w0') && wlru.includes(`w${MAX_REINJECT_WRITTEN + 2}`))
markWritten(wsWritten, 's-wrel', ['keepme'], '.dsh-meow')
await handlers['session/event']({ id: 's-wrel', header: { cwd: wsWritten } }, { type: 'compaction/summary', time: Date.now() })
check('releaseSeen keeps written for reinjection', readWritten(wsWritten, 's-wrel', '.dsh-meow').includes('keepme'))

// 第三块构造：active 回放 / 归档跳过 / 快照与全景去重 / 按库最新数据 / db-only 并集
const wsW3 = mkdtempSync(join(tmpdir(), 'mm-reinj-written-'))
const dbW3 = new MemoryDb(memoryDbPath(wsW3))
dbW3.insert({ level: 'soul', content: 'W3 快照 soul 条目' })
const wSoul = dbW3.insert({ level: 'soul', content: 'W3 快照与本块重复的 soul 条目' })
const wSelf = dbW3.insert({ level: 'fact', content: '本会话自己存的 fact 原文', project: 'femwa', source_session: 's-w3' })
const wOther = dbW3.insert({ level: 'lesson', content: '别的窗口建、本会话更新的 lesson 原文', source_session: 's-other' })
const wArch = dbW3.insert({ level: 'fact', content: '本会话存了又归档的条目', source_session: 's-w3' })
dbW3.update(wArch.level, wArch.id, { status: 'archived' })
const wProj = dbW3.insert({ level: 'project', content: 'W3 全景里会出现的 project 条目', project: 'femwa', subcategory: 'overview' })
const wFresh = dbW3.insert({ level: 'fact', content: '写入时的旧原文', source_session: 's-w3' })
markWritten(wsW3, 's-w3', [wSelf.id, wOther.id, wArch.id, wProj.id, wSoul.id, wFresh.id], '.dsh-meow')
dbW3.update('fact', wFresh.id, { content: '更新后的最新原文' })
const w3Reinj = buildReinjection(dbW3, wsW3, 's-w3', ['femwa'], {}, '.dsh-meow')
const countOccurrences = (s, sub) => s.split(sub).length - 1
check('reinjection includes written section', w3Reinj !== null && w3Reinj.text.includes('【本会话写过的记忆】'))
check('written replays session-created entry', w3Reinj.text.includes('本会话自己存的 fact 原文'))
check('written replays foreign entry updated this session', w3Reinj.text.includes('别的窗口建、本会话更新的 lesson 原文'))
check('written replays latest db content', w3Reinj.text.includes('更新后的最新原文') && !w3Reinj.text.includes('写入时的旧原文'))
check('written skips archived', !w3Reinj.text.includes('本会话存了又归档的条目'))
check('written dedups against snapshot', countOccurrences(w3Reinj.text, 'W3 快照与本块重复的 soul 条目') === 1)
check('written dedups against project panorama', countOccurrences(w3Reinj.text, 'W3 全景里会出现的 project 条目') === 1)
const wDbOnly = dbW3.insert({ level: 'fact', content: '仅库痕迹的条目也能回放', source_session: 's-w3' }) // 不 markWritten
const w3Reinj2 = buildReinjection(dbW3, wsW3, 's-w3', [], {}, '.dsh-meow')
check('written union covers db source_session entries', w3Reinj2 !== null && w3Reinj2.text.includes('仅库痕迹的条目也能回放'))
dbW3.close()

// 插件注入轮（反思/dream steer 消息轮）内的事件不刷新窗口活跃度（防 dream 反复触发）
const wsWin = mkdtempSync(join(tmpdir(), 'mm-win-'))
const evtHandler = handlers['session/event']
const sessWin = { id: 's-win', header: { cwd: wsWin } }
const tPlugin = Date.now()
await evtHandler(sessWin, { type: 'turn/start', time: tPlugin })
await evtHandler(sessWin, { type: 'user/message', time: tPlugin + 1, data: { source: { kind: 'plugin', plugin: 'meow-memory' }, content: [{ type: 'text', text: '[meow-memory-dream] x' }] } })
await evtHandler(sessWin, { type: 'assistant/message', time: tPlugin + 2, data: { message: { content: [{ type: 'text', text: 'ok' }] } } })
await evtHandler(sessWin, { type: 'turn/end', time: tPlugin + 3, data: { reason: { kind: 'completed' } } })
check('plugin turn does not touch window', getDb(wsWin, '.dsh-meow').getWindow('s-win') === undefined)
// 用户消息正常刷新活跃度（新 turn 重置标记后）
const tUser = Date.now() + 10_000
await evtHandler(sessWin, { type: 'turn/start', time: tUser })
await evtHandler(sessWin, { type: 'user/message', time: tUser + 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } })
check('user message touches window', getDb(wsWin, '.dsh-meow').getWindow('s-win')?.last_event_time === tUser + 1)

// memory_project：项目完整注入段落（用户拍板规格：全量/分组/排序/已完成 5 条）
const projectTool = tools.find((t) => t.name === 'memory_project')
const projCtx = { agent: { session: { header: { cwd: ws, id: 't-proj' } } } }
const t0 = Date.now()
db.insert({ level: 'project', content: 'overview 旧条目', project: 'femwa', subcategory: 'overview', updated_at: t0 })
db.insert({ level: 'project', content: 'overview 新条目', project: 'femwa', subcategory: 'overview', updated_at: t0 + 1000 })
db.insert({ level: 'project', content: '决策条目', project: 'femwa', subcategory: 'decisions' })
db.insert({ level: 'project', content: 'todo 进行中 A', project: 'femwa', subcategory: 'todo' })
db.insert({ level: 'project', content: 'todo 进行中 B', project: 'femwa', subcategory: 'todo' })
db.insert({ level: 'project', content: 'todo 无时间戳已完成', project: 'femwa', subcategory: 'todo', status: 'stale' })
for (let i = 1; i <= 7; i++) {
  db.insert({ level: 'project', content: `已完成事项 ${i}`, project: 'femwa', subcategory: 'todo', status: 'stale', updated_at: t0 + i * 1000 })
}
db.insert({ level: 'project', content: '已归档条目', project: 'femwa', subcategory: 'overview', status: 'archived' })
const pj = await projectTool.execute({ project: 'femwa' }, projCtx)
check('project 段落含项目名', pj.text.startsWith('【项目：femwa】'))
check('project rows carry full id + absolute timestamp + content line', /\[femwa : project\] \[[a-z0-9]{9}-[a-z0-9]{26}\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} \[.+\]\noverview 旧条目/.test(pj.text))
check('project 分组标题齐全', pj.text.includes('项目概述') && pj.text.includes('技术决策') && pj.text.includes('项目进度'))
check('project overview 旧→新排序', pj.text.indexOf('overview 旧条目') < pj.text.indexOf('overview 新条目'))
check('project archived 排除', !pj.text.includes('已归档条目'))
check('todo 已完成只取 updated_at 最近 5 条', pj.text.includes('已完成事项 3') && !pj.text.includes('已完成事项 1') && !pj.text.includes('已完成事项 2'))
check('todo 已完成按旧→新展示', pj.text.indexOf('已完成事项 3') < pj.text.indexOf('已完成事项 7'))
check('todo 无时间戳已完成排除', !pj.text.includes('无时间戳已完成'))
check('todo To do list 全量', pj.text.includes('todo 进行中 A') && pj.text.includes('todo 进行中 B'))
check('todo 已完成在 To do 之前', pj.text.indexOf('已完成：') < pj.text.indexOf('To do list：'))
const pjEmpty = await projectTool.execute({ project: 'nope' }, projCtx)
check('project 空项目提示', pjEmpty.text.includes('暂无记忆条目'))

// rules 层：全局高 importance 注入首轮、其余检索/项目段落
db.insert({ level: 'rules', content: '全局铁律：绝不删除文件只标 archived', project: null, importance: 2 })
db.insert({ level: 'rules', content: '全局琐碎规则走检索', project: null, importance: 1 })
db.insert({ level: 'rules', content: '项目特定规则不全局注入', project: 'femwa', importance: 2 })
db2.insert({ level: 'rules', content: '规则注入测试专用', project: null, importance: 2, created_at: Date.now() })
db2.insert({ level: 'topic', content: '【起因】规则注入测试话题【经过】x【结果】y', title: '规则注入测试话题', project: 'meow-memory', created_at: Date.now() })
const injR = buildInjection(db2, ws2, 'test-session-3', '规则注入测试', { hitTopK: 3 }, '.dsh-meow')
check('rules global high-importance injected', injR !== null && injR.text.includes('【设计原则】') && injR.text.includes('规则注入测试专用'))
check('rules low-importance not injected', injR !== null && !injR.text.includes('全局琐碎规则走检索'))
check('rules project-specific not injected globally', injR !== null && !injR.text.includes('项目特定规则不全局注入'))
// 命中链路（第二轮起）覆盖 rules/topic：低 importance rules 等关键词命中
setCurrentProject(ws2, 's-hit', 'meow-memory', '.dsh-meow')
const hitR = buildHitInjection(db2, ws2, 's-hit', '规则注入测试', { hitTopK: 3 }, '.dsh-meow')
check('keyword hit covers rules', hitR !== null && hitR.text.includes('规则注入测试专用'))
check('keyword hit covers topic', hitR !== null && hitR.text.includes('规则注入测试话题'))

// 当前 project 锚定：工具调用带 project → 状态更新；命中检索限定"全局+当前项目"
const anchorCtx = { agent: { session: { header: { cwd: ws2, id: 's-anchor' } } } }
check('no anchor before tools', getCurrentProject(ws2, 's-anchor', '.dsh-meow') === null)
const remAnc = await rememberTool.execute({ content: '锚定测试记忆', level: 'fact', project: 'femwa', keywords: ['锚定', '测试'], importance: 2 }, anchorCtx)
check('remember anchors project', remAnc.ok === true && getCurrentProject(ws2, 's-anchor', '.dsh-meow') === 'femwa')
await searchTool.execute({ query: '锚定', project: 'meow-memory' }, anchorCtx)
check('search re-anchors project', getCurrentProject(ws2, 's-anchor', '.dsh-meow') === 'meow-memory')
await projectTool.execute({ project: 'dsh' }, anchorCtx)
check('memory_project anchors project', getCurrentProject(ws2, 's-anchor', '.dsh-meow') === 'dsh')
// 锚定后命中：全局 + 当前项目；未锚定只全局（命中链路）
await projectTool.execute({ project: 'femwa' }, anchorCtx)
db2.insert({ level: 'fact', content: 'femwa 专有命中词', project: 'femwa', created_at: Date.now() })
const hitAnc = buildHitInjection(db2, ws2, 's-anchor', 'femwa 专有命中词', { hitTopK: 3 }, '.dsh-meow')
check('anchored hit includes current project', hitAnc !== null && hitAnc.text.includes('femwa 专有命中词'))
const hitNoAnc = buildHitInjection(db2, ws2, 's-no-anchor', 'femwa 专有命中词', { hitTopK: 3 }, '.dsh-meow')
check('unanchored hit excludes project-only', hitNoAnc === null || !hitNoAnc.text.includes('femwa 专有命中词'))

// 命中基于 keywords 而非全文：content 含词但 keywords 不含 → 不命中（防噪音）
const noiseId = db2.insert({ level: 'fact', content: '这段话的全文里出现了测试两个字但关键词是别的', project: null }).id
db2.update('fact', noiseId, { keywords: ['别的', '无关'] })
const hitNoise = buildHitInjection(db2, ws2, 's-noise', '测试', { hitTopK: 3 }, '.dsh-meow')
check('hit uses keywords not full text', hitNoise === null || !hitNoise.text.includes('这段话的全文里出现了测试两个字'))
const hitKw = buildHitInjection(db2, ws2, 's-kw', '别的无关', { hitTopK: 3 }, '.dsh-meow')
check('hit matches keywords', hitKw !== null && hitKw.text.includes('这段话的全文里出现了测试两个字'))
// 命中打分：LLM 关键词（多字词 bigram 化）可命中；虚词不产生命中
db2.insert({ level: 'fact', content: 'LLM 关键词测试条目', project: null, keywords: ['记忆插件', '命中链路', '打分函数'] })
const hitLlm = buildHitInjection(db2, ws2, 's-llm', '记忆插件命中', { hitTopK: 3 }, '.dsh-meow')
check('hit matches llm keywords', hitLlm !== null && hitLlm.text.includes('LLM 关键词测试条目'))
const hitVoid = buildHitInjection(db2, ws2, 's-void', '好的谢谢', { hitTopK: 3 }, '.dsh-meow')
check('void words produce no hit', hitVoid === null || !hitVoid.text.includes('LLM 关键词测试条目'))
// importance 权重：3 星优先于 1 星（同关键词）
const impLow = db2.insert({ level: 'fact', content: '低重要度条目', project: null, importance: 1, keywords: ['权重对比'] }).id
const impHigh = db2.insert({ level: 'fact', content: '高重要度条目', project: null, importance: 3, keywords: ['权重对比'] }).id
const hitImp = buildHitInjection(db2, ws2, 's-imp', '权重对比', { hitTopK: 3 }, '.dsh-meow')
check('importance boosts score', hitImp !== null && hitImp.text.indexOf('高重要度条目') < hitImp.text.indexOf('低重要度条目'))
db2.update('fact', impLow, { status: 'archived' })
db2.update('fact', impHigh, { status: 'archived' })
// 覆盖率：多关键词条目靠单词碰瓷分低（被少关键词条目压过）
db2.insert({ level: 'fact', content: '单词聚焦条目', project: null, keywords: ['唯一词'] })
const hitCover = buildHitInjection(db2, ws2, 's-cover', '唯一词', { hitTopK: 3 }, '.dsh-meow')
check('coverage favors focused entry', hitCover !== null && hitCover.text.includes('单词聚焦条目') && !hitCover.text.includes('LLM 关键词测试条目'))
// 不检索本 session 建立的记忆（它们在上下文里，无需命中）
const selfId = db2.insert({ level: 'fact', content: '本窗口刚写的独有命中词', project: null, source_session: 's-self' }).id
const hitSelf = buildHitInjection(db2, ws2, 's-self', '独有命中词', { hitTopK: 3 }, '.dsh-meow')
check('hit excludes own-session memory', hitSelf === null || !hitSelf.text.includes('本窗口刚写的独有命中词'))
db2.update('fact', selfId, { status: 'archived' })
// 命中条目带记忆时间戳（updated_at 相对时间）
const datedId = db2.insert({ level: 'fact', content: '带时间戳的命中条目', project: null, updated_at: Date.now() - 2 * 86_400_000 }).id
const hitDated = buildHitInjection(db2, ws2, 's-dated', '时间戳命中', { hitTopK: 3 }, '.dsh-meow')
check('hit shows unmarked prefix + full id + absolute/relative timestamps', hitDated !== null && hitDated.text.includes('[未标记 : fact]') && hitDated.text.includes('2 天前') && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(hitDated.text))
db2.update('fact', datedId, { status: 'archived' })
const searchRules = await searchTool.execute({ query: '全局铁律' }, projCtx)
check('search default scope includes rules', searchRules.hits.some((h) => h.content.includes('全局铁律')))
db.insert({ level: 'rules', content: 'femwa 设计铁律：语法错误必须报错', project: 'femwa', importance: 2 })
const pjRules = await projectTool.execute({ project: 'femwa' }, projCtx)
check('project rules injected in paragraph', pjRules.text.includes('设计原则') && pjRules.text.includes('语法错误必须报错'))

// system prompt 手册：宿主有 systemPrompt 服务 → 注册 order 130 的静态 section；无 → 静默跳过
const guideCtx = makeCtx()
const sections = []
guideCtx.ctx.get = (name) => (name === 'systemPrompt' ? { section: (s) => sections.push(s) } : undefined)
await apply(guideCtx.ctx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh' })
check('guide section registered', sections.length === 1 && sections[0].name === 'meow-memory:guide' &&
  sections[0].order === 130 && sections[0].text === getMemoryGuide(), `got ${JSON.stringify(sections)}`)
check('guide covers all seven tools', ['memory_remember', 'memory_search', 'memory_find_similar', 'memory_read', 'memory_update', 'memory_dream', 'memory_project']
  .every((n) => getMemoryGuide().includes(n)))
check('guide has no {{variable}} refs', !getMemoryGuide().includes('{{'))

// prompt 文案外置（v0.19.0）：键值槽位取用 + 占位符填充 + $ 序列安全 + 缺参/缺键报错
check('prompt loader: keyed labels/tools lookup', (() => {
  try {
    return keyedValue('labels', 'dream.title') === '记忆整理任务（dream）' && keyedValue('tools', 'memory_remember.param.level') === '记忆层级，默认 fact。'
  } catch { return false }
})())
check('prompt loader: missing key throws', (() => { try { keyedValue('labels', 'nope.missing'); return false } catch { return true } })())
check('prompt loader: fillTemplate is $-sequence safe', fillTemplate('a {x} b', { x: '$&$1$`' }) === 'a $&$1$` b')
check('prompt loader: reflect slot requires projectList param', (() => { try { resolveSlotText('reflect'); return false } catch { return true } })())
check('prompt loader: reflect fills projectList', resolveSlotText('reflect', { projectList: 'X / Y' }).includes('project：X / Y'))
check('prompt loader: dream-atomic carries parallel-call note', resolveSlotText('dream-atomic', { list: '' }).includes('一轮可调用多个工具'))

// promptLang（v0.19.0）：进程级语言状态；v0.20.0 起 BM25 分词语言无关（类别路由）；
// en 语言包（PR #6）：en 模式产出后追加英语归一化（停用词+Porter），分词主干仍语言无关
import { tokenize, stemEn, search } from './lib/index.js'
const withLang = (lang, fn) => { setPromptLang(lang); try { return fn() } finally { setPromptLang('zh') } }
const toks = (lang, text) => withLang(lang, () => JSON.stringify(tokenize(text)))
check('prompt loader: tokenize language-independent (cjk bigram under en too)', (() => {
  setPromptLang('en')
  try { return JSON.stringify(tokenize('hello 世界 foo_bar 2024')) === JSON.stringify(['hello', '世界', 'foo', 'bar', '2024']) } finally { setPromptLang('zh') }
})())
check('prompt loader: zh tokenize keeps bigram', (() => {
  setPromptLang('zh')
  try { return JSON.stringify(tokenize('世界 hello')) === JSON.stringify(['世界', 'hello']) } finally { setPromptLang('zh') }
})())
check('prompt loader: getPromptLang defaults zh', getPromptLang() === 'zh')
// v0.20.0 分词（类别路由）：CJK（汉字+假名）bigram / \p{L}\p{N} 整词 / 符号丢弃 / NFKC / surrogate 安全
check('tokenize: mixed zh+latin, single han dropped', JSON.stringify(tokenize('用BM25打分')) === JSON.stringify(['bm25', '打分']))
check('tokenize: han+kana cross-class verb', JSON.stringify(tokenize('行く')) === JSON.stringify(['行く']))
check('tokenize: katakana run keeps prolonged mark', JSON.stringify(tokenize('東京タワー')) === JSON.stringify(['東京', '京タ', 'タワ', 'ワー']))
check('tokenize: accented latin whole words', JSON.stringify(tokenize('café naïve')) === JSON.stringify(['café', 'naïve']))
check('tokenize: cyrillic + hangul whole words', JSON.stringify(tokenize('привет 한국어')) === JSON.stringify(['привет', '한국어']))
check('tokenize: NFKC fullwidth latin/digits', JSON.stringify(tokenize('ＢＭ２５')) === JSON.stringify(['bm25']))
check('tokenize: NFKC halfwidth katakana voiced', JSON.stringify(tokenize('ﾃﾞｰﾓ')) === JSON.stringify(['デー', 'ーモ']))
check('tokenize: ext-B surrogate-pair han bigram', JSON.stringify(tokenize('𠀀𠀁')) === JSON.stringify(['𠀀𠀁']))
check('tokenize: emoji/punct dropped, comma/space split words', JSON.stringify(tokenize('好👍！hello, world')) === JSON.stringify(['hello', 'world']))

// en 分词（PR #6 语言包贡献）：共享类别路由产出后追加英语归一化（停用词过滤 + Porter 词干还原）
check('en tokenize: stopwords dropped', toks('en', 'the quick brown fox') === JSON.stringify(['quick', 'brown', 'fox']))
check('en tokenize: plural and singular collapse', toks('en', 'caches') === toks('en', 'cache'))
check('en tokenize: inflection collapses', toks('en', 'running') === toks('en', 'run'))
check('en tokenize: apostrophe fragment dropped', toks('en', "the user's middle name") === JSON.stringify(['user', 'middl', 'name']))
check('en tokenize: digits and mixed tokens untouched', toks('en', 'sha256 v0.19.0 2024') === JSON.stringify(['sha256', 'v0', '19', '0', '2024']))
check('en tokenize: all-stopword text yields nothing', toks('en', 'is it the same as that') === '[]')
check('en tokenize: region suffix maps to base language', toks('en-US', 'caches') === toks('en', 'cache'))
check('zh tokenize: region suffix maps to base language', toks('zh-CN', '世界') === JSON.stringify(['世界']))
check('en tokenize: baseline languages keep raw words', toks('ja', 'the caches') === JSON.stringify(['the', 'caches']))
check('stemEn: Porter canonical cases', [
  ['caresses', 'caress'], ['ponies', 'poni'], ['cats', 'cat'], ['agreed', 'agre'], ['motoring', 'motor'],
  ['hopping', 'hop'], ['filing', 'file'], ['happy', 'happi'], ['sky', 'sky'], ['relational', 'relat'],
  ['vietnamization', 'vietnam'], ['hopefulness', 'hope'], ['electrical', 'electr'], ['adjustment', 'adjust'],
  ['adoption', 'adopt'], ['generalizations', 'gener'], ['oscillators', 'oscil'], ['rate', 'rate'], ['roll', 'roll'],
].every(([w, want]) => stemEn(w) === want))
check('en retrieval: inflected query still hits the stored entry', withLang('en', () => {
  const docs = [
    { id: 'a', level: 'fact', title: null, content: 'BM25 keyword retrieval degrades when memories are stored in another language', keywords: ['retrieval', 'tokenizer', 'language'], importance: 1, created_at: 0, updated_at: Date.now() },
    { id: 'b', level: 'fact', title: null, content: 'The espresso machine is descaled monthly', keywords: ['espresso', 'machine', 'descale'], importance: 1, created_at: 0, updated_at: Date.now() },
  ]
  const hits = search('do tokenizers matter?', docs, { k: 2 })
  return hits.length === 1 && hits[0].id === 'a'
}))

const events = {
  userMsg: (text, source = { kind: 'user' }) => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source } }),
  assistantWithTool: (name) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c1', name, arguments: '{}' }] } } }),
  assistantText: (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }),
  turnStart: () => ({ type: 'turn/start', data: {} }),
}

// pre-step 注入
const preStep = handlers['agent/pre-step']
check('pre-step registered', typeof preStep === 'function')
const agentA = { session: { header: { cwd: ws, id: 'apply-session-1' }, events: [] }, steer: () => {} }
const decisionA = await preStep(
  { agent: agentA, messages: [{ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }] }),
)
check('pre-step inserts independent snapshot', decisionA.kind === 'enter' && decisionA.messages.length === 2 &&
  decisionA.messages[0].content[0].text.includes('===== 长期记忆 =====') &&
  decisionA.messages[0].source.kind === 'plugin' && decisionA.messages[0].source.plugin === 'meow-memory' &&
  decisionA.messages[0].source.form === 'snapshot' && decisionA.messages[0].source.sections.length === 2 &&
  decisionA.messages[0].source.sections[0].name === '__meta__' &&
  JSON.parse(decisionA.messages[0].source.sections[0].text).kind === 'initial' &&
  decisionA.messages[0].source.sections[1].name === '长期记忆' &&
  decisionA.messages[0].source.sections[1].text === decisionA.messages[0].content[0].text)
check('first user message remains pristine', decisionA.messages[1].source.kind === 'user' &&
  decisionA.messages[1].content.length === 1 && decisionA.messages[1].content[0].text === '你好')
check('snapshot has no legacy prompt separator', !decisionA.messages[0].content[0].text.includes('本轮用户prompt：'))

// 回归（真机 2026-08-16）：首条用户消息与插件通知同批到达（messages[0].source.kind='plugin'，
// 如 user-approval 的 policy 变更通知）→ 快照必须仍注入到真实用户消息上，且命中链路不得在首轮触发。
const notifAgent = { session: { header: { cwd: ws, id: 'apply-session-notif' }, events: [] }, steer: () => {} }
const notifMsg = { content: [{ type: 'text', text: 'The approval policy changed from "ask" to "never" (changed by the user).' }], source: { kind: 'plugin', plugin: 'user-approval' } }
const notifUserMsg = { content: [{ type: 'text', text: '首条带通知的消息' }], source: { kind: 'user' } }
const decisionNotif = await preStep(
  { agent: notifAgent, messages: [notifMsg, notifUserMsg], turn: 1, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [notifMsg, notifUserMsg] }),
)
check('snapshot is inserted before first user despite leading plugin notice',
  decisionNotif.kind === 'enter' &&
  decisionNotif.messages[0].content.length === 1 && // 通知消息原样保留
  decisionNotif.messages[0] === notifMsg &&
  decisionNotif.messages[1].source.kind === 'plugin' &&
  decisionNotif.messages[1].source.form === 'snapshot' &&
  decisionNotif.messages[1].content[0].text.includes('===== 长期记忆 =====') &&
  !decisionNotif.messages[1].content[0].text.includes('可能相关的记忆，仅供参考：') &&
  decisionNotif.messages[2] === notifUserMsg && decisionNotif.messages[2].content[0].text === '首条带通知的消息')

// 恢复会话（进程重启后，日志已有历史用户消息）：快照不重复注入，命中链路照跑（第 N 条消息）
const resumeAgent = { session: { header: { cwd: ws, id: 'apply-session-resume' }, events: [events.userMsg('之前')] }, steer: () => {} }
setCurrentProject(ws, 'apply-session-resume', 'dsh', '.dsh-meow')
const resumeMsg = { content: [{ type: 'text', text: '测试关键词' }], source: { kind: 'user' } }
const decisionResume = await preStep(
  { agent: resumeAgent, messages: [resumeMsg], turn: 2, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [resumeMsg] }),
)
check('resumed session skips first snapshot, hit chain inserts independent snapshot', decisionResume.messages.length === 2 &&
  decisionResume.messages[0].source.form === 'snapshot' &&
  decisionResume.messages[0].content[0].text.includes('可能相关的记忆，仅供参考：') &&
  !decisionResume.messages[0].content[0].text.includes('===== 长期记忆 =====') &&
  decisionResume.messages[1] === resumeMsg && decisionResume.messages[1].content[0].text === '测试关键词')

// alpha.4 形态（Session.events 属性移除，ownEvents() 函数提供事件流）：
// 恢复会话的快照不重复注入、命中链路照跑——与 events 数组形态行为一致。
const alphaAgent = { session: { header: { cwd: ws, id: 'apply-session-alpha4' }, ownEvents: () => [events.userMsg('之前')] }, steer: () => {} }
setCurrentProject(ws, 'apply-session-alpha4', 'dsh', '.dsh-meow')
const alphaMsg = { content: [{ type: 'text', text: '测试关键词' }], source: { kind: 'user' } }
const decisionAlpha = await preStep(
  { agent: alphaAgent, messages: [alphaMsg], turn: 2, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [alphaMsg] }),
)
check('ownEvents-only session: resume skips snapshot, hit chain inserts independent snapshot', decisionAlpha.messages.length === 2 &&
  decisionAlpha.messages[0].source.form === 'snapshot' &&
  decisionAlpha.messages[0].content[0].text.includes('可能相关的记忆，仅供参考：') &&
  !decisionAlpha.messages[0].content[0].text.includes('===== 长期记忆 =====') &&
  decisionAlpha.messages[1] === alphaMsg && decisionAlpha.messages[1].content[0].text === '测试关键词')

// sessionEventsOf 兼容层单元测试：ownEvents() 优先 → events 回退 → 缺失 fail-closed
check('sessionEventsOf prefers ownEvents()', sessionEventsOf({ ownEvents: () => [1, 2], events: [9] }).length === 2)
check('sessionEventsOf falls back to events array', sessionEventsOf({ events: [1, 2, 3] }).length === 3)
check('sessionEventsOf fail-closed on missing both', sessionEventsOf({}).length === 0)
check('sessionEventsOf fail-closed on undefined session', sessionEventsOf(undefined).length === 0)

// 同会话第二次 pre-step（Set 命中）→ 零开销放行，不再注入（回归：防重复注入膨胀上下文）
const decisionA2 = await preStep(
  { agent: agentA, messages: [{ content: [{ type: 'text', text: '第二条消息' }], source: { kind: 'user' } }], turn: 2, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '第二条消息' }], source: { kind: 'user' } }] }),
)
check('no re-injection on second pre-step', decisionA2.messages[0].content.length === 1 &&
  decisionA2.messages[0].content[0].text === '第二条消息')

// 命中链路（独立于首轮注入）：每条用户消息都检索命中（top-K），seen 去重
setCurrentProject(ws, 'apply-session-1', 'dsh', '.dsh-meow')
const agentA3 = { session: { header: { cwd: ws, id: 'apply-session-1' }, events: [] }, steer: () => {} }
const decisionA3 = await preStep(
  { agent: agentA3, messages: [{ content: [{ type: 'text', text: '测试关键词' }], source: { kind: 'user' } }], turn: 3, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '测试关键词' }], source: { kind: 'user' } }] }),
)
check('per-message hit inserts independent snapshot', decisionA3.messages.length === 2 &&
  decisionA3.messages[0].source.kind === 'plugin' && decisionA3.messages[0].source.form === 'snapshot' &&
  decisionA3.messages[0].content[0].text.includes('可能相关的记忆，仅供参考：') &&
  !decisionA3.messages[0].content[0].text.includes('本轮用户prompt：') &&
  decisionA3.messages[0].content[0].text.includes('测试关键词修正') &&
  decisionA3.messages[1].source.kind === 'user' && decisionA3.messages[1].content[0].text === '测试关键词')
const decisionA4 = await preStep(
  { agent: agentA3, messages: [{ content: [{ type: 'text', text: '测试关键词' }], source: { kind: 'user' } }], turn: 4, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '测试关键词' }], source: { kind: 'user' } }] }),
)
check('seen dedup on repeated message', decisionA4.messages[0].content.length === 1)
// 工具轮（无用户消息）不触发命中
const decisionA5 = await preStep(
  { agent: agentA3, messages: [{ content: [{ type: 'tool-call', id: 'c', name: 'x', arguments: '{}' }], source: { kind: 'assistant' } }], turn: 4, step: 2, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'tool-call', id: 'c', name: 'x', arguments: '{}' }], source: { kind: 'assistant' } }] }),
)
check('tool step skips hit chain', decisionA5.messages.length === 1 && decisionA5.messages[0].content.length === 1)

// 压缩重注入（v0.21.0）：pending 会话的用户消息轮 → 注入快照+项目全景；不跑命中链路；pending 清除
const reinjAgent = { session: { header: { cwd: wsReinj, id: 's-reinj' }, events: [events.userMsg('更早')] }, steer: () => {} }
const reinjMsg = { content: [{ type: 'text', text: '压缩后的第一条消息' }], source: { kind: 'user' } }
const dReinj = await preStep(
  { agent: reinjAgent, messages: [reinjMsg], turn: 9, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [reinjMsg] }),
)
check('post-compaction reinjection injects snapshot + projects', dReinj.kind === 'enter' &&
  dReinj.messages.length === 2 &&
  dReinj.messages[0].source.kind === 'plugin' && dReinj.messages[0].source.form === 'snapshot' &&
  dReinj.messages[0].content[0].text.includes('===== 长期记忆 =====') &&
  dReinj.messages[0].content[0].text.includes('【会话已压缩】') &&
  dReinj.messages[0].content[0].text.includes('【项目：femwa】') &&
  dReinj.messages[0].content[0].text.includes('femwa 项目重注入全景条目') &&
  !dReinj.messages[0].content[0].text.includes('本轮用户prompt：') &&
  dReinj.messages[1] === reinjMsg && dReinj.messages[1].content[0].text === '压缩后的第一条消息')
check('reinjection preserves user text', dReinj.messages[1].content[0].text === '压缩后的第一条消息')
check('reinjection does not run hit chain', !dReinj.messages[0].content[0].text.includes('可能相关的记忆，仅供参考：'))
check('reinjection clears pending', isReinjectPending(wsReinj, 's-reinj', '.dsh-meow') === false)
check('reinjection re-marks snapshot ids as injected', readSeen(wsReinj, 's-reinj', '.dsh-meow').size >= 2)
// 下一轮恢复正常：无重复重注入，命中链路照跑（库内无 fact/lesson → 无命中、无注入）
const dReinj2 = await preStep(
  { agent: reinjAgent, messages: [{ content: [{ type: 'text', text: '压缩后的第二条消息' }], source: { kind: 'user' } }], turn: 10, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '压缩后的第二条消息' }], source: { kind: 'user' } }] }),
)
check('turn after reinjection back to normal', dReinj2.messages[0].content.length === 1)
// pending 置位但工具轮（无用户消息）→ 不注入、不清待办
await handlers['session/event']({ id: 's-reinj3', header: { cwd: wsReinj } }, { type: 'compaction/end', time: Date.now(), data: { compactionId: 'c3', turn: null } })
const reinjAgent3 = { session: { header: { cwd: wsReinj, id: 's-reinj3' }, events: [] }, steer: () => {} }
const dToolPending = await preStep(
  { agent: reinjAgent3, messages: [{ content: [{ type: 'tool-call', id: 'c2', name: 'x', arguments: '{}' }], source: { kind: 'assistant' } }], turn: 2, step: 2, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'tool-call', id: 'c2', name: 'x', arguments: '{}' }], source: { kind: 'assistant' } }] }),
)
check('pending kept on tool-only step, no injection', dToolPending.messages[0].content.length === 1 && isReinjectPending(wsReinj, 's-reinj3', '.dsh-meow') === true)
// 子代理不参与压缩重注入
await handlers['session/event']({ id: 's-reinj4', header: { cwd: wsReinj } }, { type: 'compaction/end', time: Date.now(), data: { compactionId: 'c4', turn: null } })
const reinjAgentSub = { session: { header: { cwd: wsReinj, id: 's-reinj4', origin: 'subagent' }, events: [] }, steer: () => {} }
const dSubPending = await preStep(
  { agent: reinjAgentSub, messages: [{ content: [{ type: 'text', text: '子代理消息' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '子代理消息' }], source: { kind: 'user' } }] }),
)
check('no reinjection for subagent, pending kept', dSubPending.messages[0].content.length === 1 && isReinjectPending(wsReinj, 's-reinj4', '.dsh-meow') === true)
// 第三块 apply 级：pending + 本会话写过的记忆 → 注入含【本会话写过的记忆】段；written id 记入 injected
await handlers['session/event']({ id: 's-reinj5', header: { cwd: wsReinj } }, { type: 'compaction/end', time: Date.now(), data: { compactionId: 'c5', turn: null } })
const reinjRemember = tools.find((t) => t.name === 'memory_remember')
const reinjRememberCtx = { agent: { session: { header: { cwd: wsReinj, id: 's-reinj5' } } } }
const rReinj5 = await reinjRemember.execute({ content: '压缩前本会话写入的记忆', project: 'femwa', keywords: ['压缩', '写入', '记忆', '回放', '第三块', '重注入', '痕迹', '测试'], importance: 1 }, reinjRememberCtx)
const reinjAgent5 = { session: { header: { cwd: wsReinj, id: 's-reinj5' }, events: [] }, steer: () => {} }
const dReinj5 = await preStep(
  { agent: reinjAgent5, messages: [{ content: [{ type: 'text', text: '第三块测试' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '第三块测试' }], source: { kind: 'user' } }] }),
)
check('reinjection includes written section (apply)', dReinj5.kind === 'enter' &&
  dReinj5.messages[0].content[0].text.includes('【本会话写过的记忆】') &&
  dReinj5.messages[0].content[0].text.includes('压缩前本会话写入的记忆'))
check('written ids re-marked as injected (apply)', readSeen(wsReinj, 's-reinj5', '.dsh-meow').has(rReinj5.id))
dbReinj.close()

// 首次设置引导（v0.19.0）：promptLang 未配置 → 插件生效后第一条真实用户消息注入
// 设置任务；seen（accessed '__welcomeGuide__'）记账 → 同会话不重复；显式配置 → 永久短路。
const wsGuide = mkdtempSync(join(tmpdir(), 'mm-guide-'))
const { ctx: guideApplyCtx, handlers: guideHandlers } = makeCtx()
await apply(guideApplyCtx, { enabled: true, projectDir: '.dsh-meow' }) // 不传 promptLang = 未配置
const guidePreStep = guideHandlers['agent/pre-step']
const guideAgent = { session: { header: { cwd: wsGuide, id: 'guide-session-1' }, events: [events.userMsg('更早的话')] }, steer: () => {} }
const guideMsg = { content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }
const dGuide1 = await guidePreStep(
  { agent: guideAgent, messages: [guideMsg], turn: 2, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [guideMsg] }),
)
check('welcome guide injected as independent notice when promptLang unset', dGuide1.messages.length === 2 &&
  dGuide1.messages[0].source.kind === 'plugin' &&
  dGuide1.messages[0].source.form === 'notice' &&
  typeof dGuide1.messages[0].source.summary === 'string' && dGuide1.messages[0].source.summary.length > 0 &&
  dGuide1.messages[0].source.memory === undefined &&
  dGuide1.messages[0].source.sections === undefined &&
  dGuide1.messages[0].content[0].text.includes('【meow-memory 首次设置】') &&
  dGuide1.messages[0].content[0].text.includes('恭喜') &&
  dGuide1.messages[0].content[0].text.includes('不要以 system prompt') &&
  dGuide1.messages[0].content[0].text.includes('promptLang') &&
  dGuide1.messages[1] === guideMsg && dGuide1.messages[1].content[0].text === '继续')
check('welcome guide recorded via accessed pseudo-id', readSeen(wsGuide, 'guide-session-1', '.dsh-meow').has('__welcomeGuide__'))
const dGuide2 = await guidePreStep(
  { agent: guideAgent, messages: [{ content: [{ type: 'text', text: '再继续' }], source: { kind: 'user' } }], turn: 3, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '再继续' }], source: { kind: 'user' } }] }),
)
check('welcome guide not re-injected same session', dGuide2.messages[0].content.length === 1)
const { ctx: zhSetCtx, handlers: zhSetHandlers } = makeCtx()
await apply(zhSetCtx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh' })
const zhAgent = { session: { header: { cwd: wsGuide, id: 'zh-set-session' }, events: [events.userMsg('x')] }, steer: () => {} }
const zhMsg = { content: [{ type: 'text', text: 'y' }], source: { kind: 'user' } }
const dZhSet = await zhSetHandlers['agent/pre-step'](
  { agent: zhAgent, messages: [zhMsg], turn: 2, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [zhMsg] }),
)
check('welcome guide skipped when promptLang explicitly set', dZhSet.messages[0].content.length === 1)

// 已有历史 → 不注入
const agentB = { session: { header: { cwd: ws, id: 's2' }, events: [events.userMsg('之前')] }, steer: () => {} }
const decisionB = await preStep(
  { agent: agentB, messages: [{ content: [{ type: 'text', text: '再问' }], source: { kind: 'user' } }], turn: 2, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '再问' }], source: { kind: 'user' } }] }),
)
check('no injection with history', decisionB.messages[0].content.length === 1)

// 子代理（origin === 'subagent'，dsh 权威标记）→ 不注入
const agentC = { session: { header: { cwd: ws, id: 's3', parentSession: 'x', origin: 'subagent' }, events: [] }, steer: () => {} }
const decisionC = await preStep(
  { agent: agentC, messages: [{ content: [{ type: 'text', text: '嗨' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '嗨' }], source: { kind: 'user' } }] }),
)
check('no injection for subagent', decisionC.messages[0].content.length === 1)

// 回归（真机 2026-08-17）：GUI fork/续写的主会话有 parentSession 但无 origin——不是子代理，必须注入
const agentFork = { session: { header: { cwd: ws, id: 's-fork', parentSession: 's-parent' }, events: [] }, steer: () => {} }
const forkMsg = { content: [{ type: 'text', text: 'fork 会话的首条消息' }], source: { kind: 'user' } }
const decisionFork = await preStep(
  { agent: agentFork, messages: [forkMsg], turn: 1, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [forkMsg] }),
)
check('fork session (parentSession without origin) still injects', decisionFork.kind === 'enter' &&
  decisionFork.messages.length === 2 &&
  decisionFork.messages[0].source.form === 'snapshot' &&
  decisionFork.messages[0].content[0].text.includes('===== 长期记忆 =====') &&
  decisionFork.messages[1] === forkMsg && decisionFork.messages[1].content[0].text === 'fork 会话的首条消息')

// turn-stopping 反思（单任务内连续工具 step ≥7 才触发——用户拍板语义）
const stopping = handlers['agent/turn-stopping']
check('turn-stopping registered', typeof stopping === 'function')

// 单 turn 内 7 个连续工具 step → 触发
const sevenSteps = [events.turnStart(), events.userMsg('干活'), ...Array.from({ length: 7 }, () => events.assistantWithTool('bash'))]
const steered = []
const agentD = { session: { header: { cwd: ws, id: 's4' }, events: sevenSteps }, steer: (m) => steered.push(m) }
stopping({ agent: agentD, turn: 1, signal: new AbortController().signal })
check('steer after 7 consecutive tool steps', steered.length === 1 && steered[0].content.some((b) => b.type === 'text' && b.text.includes('记忆反思')))

// alpha.4 形态：事件流由 ownEvents() 提供，反射链路必须等价（7 步触发）。
const steeredA4 = []
const agentA4 = { session: { header: { cwd: ws, id: 's4a' }, ownEvents: () => sevenSteps }, steer: (m) => steeredA4.push(m) }
stopping({ agent: agentA4, turn: 1, signal: new AbortController().signal })
check('alpha.4 ownEvents session steers after 7 consecutive tool steps', steeredA4.length === 1 && steeredA4[0].content.some((b) => b.type === 'text' && b.text.includes('记忆反思')))

// 单步工具调用 → 不触发
const steered1 = []
const agentD1 = { session: { header: { cwd: ws, id: 's4b' }, events: [events.turnStart(), events.userMsg('干活'), events.assistantWithTool('bash'), events.assistantText('完成')] }, steer: (m) => steered1.push(m) }
stopping({ agent: agentD1, turn: 1, signal: new AbortController().signal })
check('no steer on single tool step', steered1.length === 0)

// 6 步 → 不触发
const sixSteps = [events.turnStart(), events.userMsg('干活'), ...Array.from({ length: 6 }, () => events.assistantWithTool('bash'))]
const steered6 = []
const agentD6 = { session: { header: { cwd: ws, id: 's4c' }, events: sixSteps }, steer: (m) => steered6.push(m) }
stopping({ agent: agentD6, turn: 1, signal: new AbortController().signal })
check('no steer on 6 tool steps', steered6.length === 0)

// 跨 turn 不算：前面 turn 的工具不累计进当前 turn
const acrossTurns = [events.turnStart(), events.userMsg('干活1'), events.assistantWithTool('bash'), events.turnStart(), events.userMsg('干活2'), events.assistantWithTool('bash')]
check('consecutiveToolSteps only current turn', (await import('./lib/index.js')).consecutiveToolSteps(acrossTurns) === 1)

// consecutiveToolSteps 单元测试
const { consecutiveToolSteps } = await import('./lib/index.js')
check('consecutiveToolSteps counts 7', consecutiveToolSteps(sevenSteps) === 7)
check('consecutiveToolSteps counts 1', consecutiveToolSteps([events.turnStart(), events.userMsg('x'), events.assistantWithTool('bash')]) === 1)
check('consecutiveToolSteps chat turn = 0', consecutiveToolSteps([events.turnStart(), events.userMsg('闲聊'), events.assistantText('嗯')]) === 0)
check('consecutiveToolSteps resets at memory_ tool', consecutiveToolSteps([
  events.turnStart(), events.userMsg('干活'),
  events.assistantWithTool('bash'), events.assistantWithTool('bash'),
  events.assistantWithTool('memory_remember'),
  events.assistantWithTool('bash'), events.assistantWithTool('bash'),
]) === 2)
check('consecutiveToolSteps counts parallel calls', consecutiveToolSteps([
  events.turnStart(), events.userMsg('干活'),
  { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'p1', name: 'bash', arguments: '{}' }, { type: 'tool-call', id: 'p2', name: 'grep', arguments: '{}' }] } } },
]) === 2)

const steered2 = []
const agentE = { session: { header: { cwd: ws, id: 's5' }, events: [events.turnStart(), events.userMsg('你好'), events.assistantText('你好呀')] }, steer: (m) => steered2.push(m) }
stopping({ agent: agentE, turn: 1, signal: new AbortController().signal })
check('no steer on chat turn', steered2.length === 0)

const steered3 = []
const agentF = { session: { header: { cwd: ws, id: 's6' }, events: [events.turnStart(), events.userMsg('记住'), events.assistantWithTool('memory_remember')] }, steer: (m) => steered3.push(m) }
stopping({ agent: agentF, turn: 1, signal: new AbortController().signal })
check('no steer after memory_ tool', steered3.length === 0)

// ═══════════════════════ delegate（fork 子代理执行体） ═══════════════════════

// parseModelSpec 单元：'provider/model' / 'model' / 空
const { parseModelSpec, validateConfigUserLayer, mergeConfigLayer, CONFIG_DEFAULTS, factoryDefaultOf } = await import('./lib/index.js')
check('parseModelSpec splits provider/model', JSON.stringify(parseModelSpec('prov/main')) === JSON.stringify({ provider: 'prov', model: 'main' }))
check('parseModelSpec model-only keeps provider inherited', JSON.stringify(parseModelSpec('solo')) === JSON.stringify({ model: 'solo' }))
check('parseModelSpec blank → undefined', parseModelSpec('') === undefined && parseModelSpec(undefined) === undefined && parseModelSpec('  ') === undefined)

// ── 设置页数据层：mergeConfigLayer（user 层字段级覆盖+子对象浅合并）/ validateConfigUserLayer ──
{
  const patch = { enabled: true, hitTopK: 2, dream: { enabled: true, idleMinutes: 180, timeZone: 'UTC' }, delegate: { model: '' } }
  const merged = mergeConfigLayer(patch, { hitTopK: 5, dream: { idleMinutes: 60 } })
  check('settings merge: top-level field overridden', merged.hitTopK === 5 && merged.enabled === true)
  check('settings merge: dream sub-fields shallow-merged (patch keys kept)', merged.dream.enabled === true && merged.dream.idleMinutes === 60 && merged.dream.timeZone === 'UTC')
  check('settings merge: untouched groups pass through', JSON.stringify(merged.delegate) === JSON.stringify(patch.delegate))
  check('settings merge: undefined user layer returns patch', mergeConfigLayer(patch, undefined) === patch)
  // YAML 空段（`meow-memory:` 后无内容）= null：typeof null === 'object' 会漏过类型判断，
  // Object.entries(null) 抛 TypeError 崩 applyInner——必须直通 patch 层。
  check('settings merge: null user layer (empty YAML section) returns patch', mergeConfigLayer(patch, null) === patch)
  check('settings validate: valid layer passes', (validateConfigUserLayer({ enabled: false, promptLang: 'en', dream: { idleMinutes: 60, suppressWindows: [{ start: '09:00', end: '12:00' }] }, delegate: { model: 'prov/m' } }), true))
  const bad = (v) => {
    try { validateConfigUserLayer(v); return false } catch { return true }
  }
  check('settings validate: bool/type violations rejected', bad({ enabled: 'yes' }) && bad({ hitTopK: 'many' }) && bad({ dream: { timeZone: 8 } }) && bad({ delegate: { model: 7 } }))
  check('settings validate: bad suppressWindows rejected', bad({ dream: { suppressWindows: [{ start: '9点', end: '12点' }] } }) && bad({ dream: { suppressWindows: '09:00-12:00' } }))
  // v0.24：delegate.reflect/dream 已移除——历史 settings.yaml user 层残留键宽容（忽略不报错）
  check('settings validate: legacy delegate.reflect/dream keys tolerated', !bad({ delegate: { reflect: false, dream: true, model: '' } }))

  // 出厂默认的单一来源（defaults.ts）：host 的 config 兜底与 client 设置页「恢复默认」共用。
  // 2026-09-10 猫猫拍板：恢复默认 = 回到插件出厂默认，不再是 patch 装配基线。
  check('factory default: delegate.model 出厂默认=空串（=主模型）', factoryDefaultOf({ key: 'model', sub: 'delegate' }) === '')
  check('factory default: top-level scalars', factoryDefaultOf({ key: 'hitTopK' }) === 2 && factoryDefaultOf({ key: 'enabled' }) === true && factoryDefaultOf({ key: 'projectDir' }) === '.dsh-meow')
  check('factory default: dream sub-keys', factoryDefaultOf({ key: 'idleMinutes', sub: 'dream' }) === 180 && factoryDefaultOf({ key: 'rulesReviewDays', sub: 'dream' }) === CONFIG_DEFAULTS.dream.rulesReviewDays)
  check('factory default: array value equals CONFIG_DEFAULTS', JSON.stringify(factoryDefaultOf({ key: 'suppressWindows', sub: 'dream' })) === JSON.stringify(CONFIG_DEFAULTS.dream.suppressWindows))
  check('factory default: promptLang 缺席=未设置语义', factoryDefaultOf({ key: 'promptLang' }) === undefined)
  check('factory default: 未知 sub/key → undefined', factoryDefaultOf({ key: 'nope', sub: 'dream' }) === undefined && factoryDefaultOf({ key: 'enabled', sub: 'nope' }) === undefined)
}

// 反思永远 steer（v0.24 拍板：独立执行移除，配置了 model 也不 fork）
{
  const calls = []
  const d = makeCtx({ start: (name, req) => { calls.push({ name, req }); return { id: 'c', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} } } })
  await apply(d.ctx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh', delegate: { model: 'prov/main' } })
  const dSteered = []
  d.handlers['agent/turn-stopping']({ agent: { session: { header: { cwd: ws, id: 's-steer-always' }, events: sevenSteps }, steer: (m) => dSteered.push(m) } }, { turn: 1, signal: new AbortController().signal })
  check('reflect: always steered even with model configured', dSteered.length === 1 && dSteered[0].content.some((b) => b.type === 'text' && b.text.includes('记忆反思')))
  check('reflect: fork subagents never started', calls.length === 0)
}

// 换模型（v0.24）：agent/request waterfall 在反思/梦境轮覆盖 provider/model，其余请求放行
{
  const d = makeCtx()
  await apply(d.ctx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh', delegate: { model: 'prov/main' } })
  const reqHandler = d.handlers['agent/request']
  check('model override: agent/request waterfall registered when model set', typeof reqHandler === 'function')
  const seed = async () => ({ provider: 'base', model: 'base-model' })
  // 反思轮（turn 内带 [meow-memory-reflect] 指令消息）→ 覆盖
  const reflectEvents = [events.turnStart(), { type: 'user/message', data: { content: [{ type: 'text', text: '[meow-memory-reflect] 反思任务' }] } }]
  const out1 = await reqHandler({ agent: { session: { header: { cwd: ws, id: 's-ovr-1' }, events: reflectEvents } }, turn: 1, step: 1, signal: new AbortController().signal }, seed)
  check('model override: reflect turn swaps provider+model', out1.provider === 'prov' && out1.model === 'main', JSON.stringify(out1))
  // 梦境轮 → 覆盖
  const dreamEvents = [events.turnStart(), { type: 'user/message', data: { content: [{ type: 'text', text: '[meow-memory-dream] 梦境整理' }] } }]
  const out2 = await reqHandler({ agent: { session: { header: { cwd: ws, id: 's-ovr-2' }, events: dreamEvents } }, turn: 2, step: 1, signal: new AbortController().signal }, seed)
  check('model override: dream turn swaps model', out2.provider === 'prov' && out2.model === 'main')
  // 普通对话轮 → 原样放行（自动换回主模型的形态）
  const out3 = await reqHandler({ agent: { session: { header: { cwd: ws, id: 's-ovr-3' }, events: [events.turnStart(), events.userMsg('你好')] } }, turn: 3, step: 1, signal: new AbortController().signal }, seed)
  check('model override: normal turn untouched', out3.provider === 'base' && out3.model === 'base-model')
  // 用户消息引用标记文本 → 不误伤（source.kind='user' 绝不判 marker）
  const out4 = await reqHandler({ agent: { session: { header: { cwd: ws, id: 's-ovr-4' }, events: [events.turnStart(), events.userMsg('帮我看看 [meow-memory-dream] 这个标记是什么')] } }, turn: 4, step: 1, signal: new AbortController().signal }, seed)
  check('model override: user-quoted marker not overridden', out4.provider === 'base' && out4.model === 'base-model')
  // 子代理请求 → 不覆盖
  const out5 = await reqHandler({ agent: { session: { header: { cwd: ws, id: 's-ovr-5', origin: 'subagent' }, events: reflectEvents } }, turn: 5, step: 1, signal: new AbortController().signal }, seed)
  check('model override: subagent request untouched', out5.provider === 'base' && out5.model === 'base-model')
  // 未配置模型 → 完全不注册 waterfall（零开销路径）
  const d2 = makeCtx()
  await apply(d2.ctx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh' })
  check('model override: no model → no waterfall registered', d2.handlers['agent/request'] === undefined)
}

// isMemoryTaskTurn 单元：跨 turn 边界（marker 只认当前 turn，上一轮的 marker 不残留）
{
  const { isMemoryTaskTurn } = await import('./lib/index.js')
  const prevTurnReflect = [events.turnStart(), { type: 'user/message', data: { content: [{ type: 'text', text: '[meow-memory-reflect] 上一轮反思' }] } }, { type: 'turn/end', data: {} }, events.turnStart(), events.userMsg('新一轮正常对话')]
  check('isMemoryTaskTurn: marker from previous turn does not leak', isMemoryTaskTurn(prevTurnReflect) === false)
  check('isMemoryTaskTurn: no turn/start → false', isMemoryTaskTurn([{ type: 'user/message', data: { content: [{ type: 'text', text: '[meow-memory-dream] x' }] } }]) === false)
}

// ═══════════════════════ /dream 用户命令（dsh 命令平面） ═══════════════════════

// 定义形状 + handler 全路径。语义=手动触发：直接 startWindowDream，不吃峰时抑制/空闲检查。
{
  const def = dreamCommandDefinition({ logger: { info: () => {}, warn: () => {}, error: () => {} } }, '.dsh-meow')
  check('/dream command shape', def.name === 'dream' && typeof def.description === 'string' && def.description.length > 0)

  // 成功路径：本窗口有记忆 → steer 发出第 1 组 + 租约建立 + success 文案
  const wsCmd = mkdtempSync(join(tmpdir(), 'mm-cmd-'))
  const dbCmd = getDb(wsCmd, '.dsh-meow')
  dbCmd.insert({ level: 'fact', content: '/dream 命令测试条目 特异词zz', project: 'dsh', source_session: 's-cmd' })
  const steeredC = []
  const agentC = { session: { header: { cwd: wsCmd, id: 's-cmd' } }, steer: (m) => steeredC.push(m) }
  const r1 = await def.handler({ agent: agentC })
  check('/dream starts window dream', r1.kind === 'success' && r1.text.includes('已触发'), JSON.stringify(r1))
  check('/dream steers round 1 with marker', steeredC.length === 1 && JSON.stringify(steeredC[0]).includes('[meow-memory-dream]'))
  check('/dream claims lease', dbCmd.getDreamLease('s-cmd') !== null)
  // 占用中：第二次调用 → error 且不重复 steer
  const r2 = await def.handler({ agent: agentC })
  check('/dream busy → error', r2.kind === 'error' && r2.text.includes('进行中'), JSON.stringify(r2))
  check('/dream busy no extra steer', steeredC.length === 1)
  abortDream(agentC, '.dsh-meow')

  // 空窗口：topic 轮恒触发（回顾建新）→ 也成功启动（与 memory_dream 工具行为一致）
  const wsEmpty = mkdtempSync(join(tmpdir(), 'mm-cmd-empty-'))
  const dbEmpty = getDb(wsEmpty, '.dsh-meow')
  dbEmpty.touchWindow('s-empty', wsEmpty, Date.now())
  const steeredE = []
  const agentE2 = { session: { header: { cwd: wsEmpty, id: 's-empty' } }, steer: (m) => steeredE.push(m) }
  const rNone = await def.handler({ agent: agentE2 })
  check('/dream empty window still starts (topic round)', rNone.kind === 'success' && steeredE.length === 1, JSON.stringify(rNone))
  abortDream(agentE2, '.dsh-meow')

  // 守卫：子代理会话拒绝
  const rSub = await def.handler({ agent: { session: { header: { cwd: wsCmd, id: 's-sub', origin: 'subagent', parentSession: 's-cmd' } } } })
  check('/dream rejects subagent', rSub.kind === 'error' && rSub.text.includes('主会话'), JSON.stringify(rSub))
  // 守卫：无 cwd
  const rNoWs = await def.handler({ agent: { session: { header: { id: 's-nows' } } } })
  check('/dream requires cwd', rNoWs.kind === 'error' && rNoWs.text.includes('工作区'), JSON.stringify(rNoWs))
  // 守卫：无会话 id
  const rNoId = await def.handler({ agent: { session: { header: { cwd: wsCmd } } } })
  check('/dream requires session id', rNoId.kind === 'error' && rNoId.text.includes('会话 id'), JSON.stringify(rNoId))
  // 守卫：invocation.agent 缺失
  const rNoAgent = await def.handler({})
  check('/dream requires agent', rNoAgent.kind === 'error', JSON.stringify(rNoAgent))

  getDb(wsCmd, '.dsh-meow').close() // 显式关库：Windows 下 WAL 句柄未释放会挡住 rmSync（EBUSY）
  getDb(wsEmpty, '.dsh-meow').close()
  rmSync(wsCmd, { recursive: true, force: true })
  rmSync(wsEmpty, { recursive: true, force: true })
}

// 注册接线：commands 服务就绪时 apply 自动注册 /dream（ctx.effect 包装，disposer 收集）
{
  const registeredC = []
  const disposers = []
  const { ctx: ctxCmd } = makeCtx()
  ctxCmd.get = (name) => name === 'commands'
    ? { register: (def) => { registeredC.push(def); return () => {} } }
    : undefined
  ctxCmd.effect = (fn) => {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return d
  }
  await apply(ctxCmd, { enabled: true })
  check('/dream auto-registered via commands service', registeredC.length === 1 && registeredC[0].name === 'dream',
    JSON.stringify(registeredC.map((d) => d.name)))
}


// disabled
const { ctx: ctxOff, tools: toolsOff, handlers: handlersOff } = makeCtx()
await apply(ctxOff, { enabled: false })
check('disabled registers nothing', toolsOff.length === 0 && Object.keys(handlersOff).length === 0)

db.close(); db2.close(); db3.close(); db4.close()
dbW.close()
closeAllDbs()
rmSync(ws, { recursive: true, force: true })
rmSync(ws2, { recursive: true, force: true })
rmSync(ws3, { recursive: true, force: true })
rmSync(ws4, { recursive: true, force: true })
rmSync(wsUp, { recursive: true, force: true })
rmSync(wsD, { recursive: true, force: true })
rmSync(wsR, { recursive: true, force: true })
rmSync(wsIcon, { recursive: true, force: true })
rmSync(wsNoDb, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
