/**
 * meow-memory v2 — 按窗口空闲整理（dream）。
 *
 * 用户拍板（2026-08-15 原始设计 + 2026-08-19 改版）：
 * - 每个 session 窗口由它自己的主 agent 整理：只发本窗口（source_session）建立的
 *   七层记忆（soul/user/project/fact/lesson/topic/rules），对着自己的完整对话上下文整理。
 * - 2026-08-19 改版（用户拍板）：① 不再按 project 逐轮——所有 project 混在同一轮，
 *   用【project：xxx】小标题分段，最后一段【project：无项目 - 全局信息，或缺少项目标签】；
 *   ② 分轮：第 1 轮=原子记忆（project/fact/lesson/rules/soul/user，不含 topic），
 *   第 2 轮=topic 记忆（空也发，回顾对话建新 topic）；2026-08-22 加第 3 轮=项目总结
 *   （本窗口涉及具体项目时追加：调 memory_project 复查并精简成新的项目长期记忆，
 *   被取代的旧条目归档）；轮数动态，消息显示"第 N/M 组"；③ 记忆范围=本窗口
 *   建立的 ∪ 本窗口提取过的（sessions/<id>.json 的 injected+searched）；④ 条目展示
 *   绝对时间戳（最后更新时间）；组内排序 project → level → 创建时间不变。
 * - T = dream 开始前窗口最后一轮正常对话时间（先记死）；收尾时该窗口所有条目
 *   updated_at = T（"记忆时间戳"=最后更新时间），windows 表 last_dream_time = T。
 * - 判定：窗口最后事件时间 > 24h 前 且 > 上次 dream 时间 → 需要 dream。
 * - 触发（用户拍板 2026-08-19）：窗口空闲 ≥ idleMinutes（默认 3 小时）即允许触发，
 *   替代原夜间窗口（00:00–07:00）；但当前时间处于峰时抑制时段（北京时间
 *   09:00–12:00、14:00–18:00，API 峰谷电价峰时，及各自开始前 15 分钟）时不触发，
 *   等峰时结束后的下一个检查周期自然触发。进行中的 dream 不打断，只挡新启动；
 *   手动 memory_dream 不受峰时抑制。
 * - 串行：同一时刻只有一个进行中的 dream 任务；旧窗口（进程重启后无 live agent）
 *   会尝试从 session persistence 恢复 agent 再照常 dream（2026-09-01 用户拍板：
 *   符合条件就自动触发，不需要人碰窗口；恢复失败只记日志降级，绝不新建会话）。
 *
 * 冲突处理：memory_search 返回 top-k 后按 updated_at 重排 + 顶部提示；
 * agent 据"记忆时间戳"判断新旧（工具层乐观锁留待迭代）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, projectList, type Level, type MemoryRow } from './db.js'
import { appendDelegateMarker, resolveSubagents, resolveWorkspace, startDelegateSubagent, DREAM_DELEGATE_MARKER, type AgentOptionsSpec, type DelegateLogger } from './delegate.js'
import { fillTemplate, keyedValue, resolveSlotText } from './prompt-loader.js'
import { readSeen, readWritten } from './inject.js'
import { workspaceOf } from './tools.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'meow-memory' }

// ── delegate（fork 子代理执行体，delegate.dream 开启时启用） ─────────────────
//
// steer 版 dream 的组推进由主会话 turn-stopping 驱动（dream 轮消息落主 log）；
// delegate 版把执行体换成 fork 子代理：每组一个子代理（播种主会话全部已完成
// turn，零写主 log），done 回调链式推进下一组。DB 租约状态机（claim/CAS 推进/
// 过期补收尾）完全复用，只换"执行体 + 驱动源"。

/** dream 组执行体：收到一条组消息，负责把它交给模型跑完（steer 或子代理）。 */
export type DreamLaunchFn = (msg: { content?: ReadonlyArray<{ type?: string; text?: string }> }, sessionId: string, ws: string, groupIdx: number, groupsTotal: number) => void

export interface DreamDelegateEnv {
  logger: DelegateLogger
  /**
   * 插件 ctx：subagents/workspace 不在 apply 期固化（那时服务尚未启动，同步解析
   * 抛 without inject / 拿 undefined）——消费点每次现场解析（运行期服务已就绪）。
   */
  ctx: unknown
  signal: AbortSignal
  /** dream 组防重入集合（键=`${sessionId}:dream`）。 */
  inFlight: Set<string>
  modelSpec?: AgentOptionsSpec
}

let dreamDelegateEnv: DreamDelegateEnv | null = null

/** 设置 delegate 环境（applyInner 在 delegate.dream 开启时调用；null=回到 steer）。 */
export function setDreamDelegateEnv(env: DreamDelegateEnv | null): void {
  dreamDelegateEnv = env
}

/** dream 消息识别标记（turn-stopping 推进判定用）。 */
export const DREAM_MARKER = '[meow-memory-dream]'

/** 会话短 id：剥掉 "session-" 前缀再取前 8 位（日志/落库展示用，可辨识窗口）。 */
export function shortSessionId(sid: string): string {
  return (sid.startsWith('session-') ? sid.slice(8) : sid).slice(0, 8)
}

/** 同步文件日志：进程崩溃也不丢（崩溃点定位用）。 */
function dreamLog(ws: string, dir: string, msg: string): void {
  try {
    appendFileSync(join(ws, dir, 'dream-debug.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志失败不阻塞 */
  }
}

// ── 分组与快照 ──────────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<Level, number> = { project: 0, topic: 1, fact: 2, lesson: 3, rules: 4, soul: 5, user: 6 }

export interface DreamGroup {
  name: string // project 名；'' = 无项目标签
  rows: MemoryRow[]
}

/** 一轮 = 一种记忆类型（原子 / topic / 项目总结）。 */
export interface DreamRound {
  kind: 'atomic' | 'topic' | 'project-summary'
  groups: DreamGroup[]
  /** 仅 project-summary 轮：本窗口涉及的项目名清单（AI 逐个调 memory_project 复查）。 */
  projects?: string[]
}

/** 绝对时间戳（UTC 分钟级，与封存时间戳一致）。 */
function formatTime(t: number): string {
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ')
}

/** 按 project 分组（组内 project→level→创建时间；"全局"/未标记归无项目段放最后；多值（逗号分隔）归第一个项目段）。 */
function groupByProject(rows: MemoryRow[]): DreamGroup[] {
  const byProject = new Map<string, MemoryRow[]>()
  for (const r of rows) {
    const list = projectList(r.project)
    const key = list.length > 0 ? list[0] : ''
    if (!byProject.has(key)) byProject.set(key, [])
    byProject.get(key)!.push(r)
  }
  for (const list of byProject.values()) {
    list.sort((a, b) => {
      const l = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
      if (l !== 0) return l
      return a.created_at - b.created_at
    })
  }
  return [...byProject.entries()]
    .sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])))
    .map(([name, rows]) => ({ name, rows }))
}

/** dream 记忆范围（用户拍板 2026-08-19，v0.17.0 扩展）：本窗口建立的 ∪ 本窗口
 *  提取过的（sessions/<id>.json：注入 injected + 检索 searched + 查阅 accessed）。
 *  分轮：第 1 轮=原子记忆（project/fact/lesson/rules/soul/user，不含 topic），空则跳过；
 *  第 2 轮=topic 记忆**默认触发**（用户拍板 2026-08-19：空也发——AI 回顾对话历史，
 *  可能有新 topic 要创建）；第 3 轮=项目总结（用户拍板 2026-08-22，本窗口涉及具体项目
 *  时追加——调 memory_project 复查并精简成新的项目长期记忆，被取代的旧条目归档）。
 *  rules 防 churn（测评 2026-08-25）：updated_at 距今超 rulesReviewDays 天的稳定
 *  准则不进第 1 轮清单（0=不过滤）——每轮重审是低价值劳动且易诱发无意义 update；
 *  全局高 importance rules 每会话首轮都在注入，真矛盾会被当场 update、updated_at
 *  刷新后自动回到审查队列。 */
export function collectDreamRounds(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  workspace: string,
  dir = '.dsh-meow',
  rulesReviewDays: number = DEFAULT_RULES_REVIEW_DAYS,
): DreamRound[] {
  // 清单范围 = 本窗口建立（source_session）∪ 注入/检索/查阅（seen）∪ 写过（written，
  // v0.23.0——经 memory_project 全景看到条目后 update 它，不落任何旧痕迹（全景刻意不标记），
  // written 补上这个漏记口子：凡本窗口写工具落库过的条目必进复查清单）。
  const seen = new Set([...readSeen(workspace, sessionId, dir), ...readWritten(workspace, sessionId, dir)])
  const atomic: MemoryRow[] = []
  const topic: MemoryRow[] = []
  for (const level of ['project', 'fact', 'lesson', 'rules', 'soul', 'user'] as const) {
    for (const r of db.list(level)) {
      if (!(r.source_session === sessionId || seen.has(r.id))) continue
      if (level === 'rules' && rulesReviewDays > 0 && Date.now() - r.updated_at > rulesReviewDays * 86_400_000) continue
      atomic.push(r)
    }
  }
  for (const r of db.list('topic')) {
    if (r.source_session === sessionId || seen.has(r.id)) topic.push(r)
  }
  const rounds: DreamRound[] = []
  if (atomic.length > 0) rounds.push({ kind: 'atomic', groups: groupByProject(atomic) })
  rounds.push({ kind: 'topic', groups: groupByProject(topic) }) // topic 轮默认触发（空轮也让 AI 回顾建新 topic）
  // 第 3 轮=项目总结：项目集合=候选条目 project 并集（projectList 自动排除 全局/未标记；
  // db.list 不筛状态，前序轮归档不会让轮数中途变化）。没碰过任何项目就不发这一轮。
  const projects = new Set<string>()
  for (const r of [...atomic, ...topic]) for (const p of projectList(r.project)) projects.add(p)
  if (projects.size > 0) rounds.push({ kind: 'project-summary', groups: [], projects: [...projects].sort() })
  return rounds
}

/** 单条目展示行（原文视图）：元数据头 + 完整 id + 绝对时间戳 + 关键词行。
 *  关键词标签文案由调用方传入（labels.md：dream.row.keywordsLabel / dream.row.none）。 */
function formatRow(r: MemoryRow, kwLabel: string, noneLabel: string): string {
  const head = r.content.replace(/\s+/g, ' ').trim()
  const meta = [r.level]
  if (r.level === 'project' && r.subcategory) meta.push(r.subcategory)
  if (r.title) meta.push(`《${r.title}》`)
  if (r.status !== 'active') meta.push(r.status)
  meta.push(`${r.id} ${formatTime(r.updated_at)}`) // 完整 id + 绝对时间戳（最后更新时间）
  // 关键词行：AI 要核查/重写关键词（判断 6），必须先把现有关键词给它看。
  const kw = (r.keywords ?? []).filter((k) => typeof k === 'string' && k.length > 0)
  const kwLine = kw.length > 0 ? kw.join(', ') : noneLabel
  return `- [${meta.join(' ')}] ${head}\n  ${kwLabel} ${kwLine}`
}

/** 第 2 轮（topic）与第 1/3 轮的指导文案已外置（v0.19.0）：prompts/zh/dream-topic.md /
 *  dream-atomic.md / dream-project-summary.md，改文件下一次 dream 即生效。 */

/** 构造一轮 dream 指令消息（各轮共用头部：封存时间戳 + 时间戳规则）。 */
export function buildDreamMessage(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  T: number,
  rounds: DreamRound[],
  idx: number,
): ReturnType<typeof createUserMessage> {
  const round = rounds[idx]
  const lbl = (key: string, params?: Record<string, string>): string => fillTemplate(keyedValue('labels', key), params)
  const lines: string[] = [
    `${DREAM_MARKER} ${lbl('dream.title')}`,
    '',
    ...resolveSlotText('dream-header', {
      timestamp: formatTime(T),
      idx: String(idx + 1),
      total: String(rounds.length),
      roundKind: lbl(`dream.round.${round.kind}`),
    }).split('\n'),
    '',
  ]
  if (round.kind === 'project-summary') {
    // 项目总结轮：不带条目列表——AI 自己逐个调 memory_project 看当前项目描述（用户拍板 2026-08-22）。
    lines.push(...resolveSlotText('dream-project-summary', { projects: (round.projects ?? []).join('、') }).split('\n'))
  } else {
    const kwLabel = lbl('dream.row.keywordsLabel')
    const noneLabel = lbl('dream.row.none')
    const groupsText = round.groups
      .map((g) => {
        const name = g.name === '' ? lbl('dream.groupUnlabeled') : g.name
        return `${lbl('dream.groupHeader', { name })}\n${g.rows.map((r) => formatRow(r, kwLabel, noneLabel)).join('\n')}`
      })
      .join('\n\n')
    // 列表块：有组 = 空行+组文本（组间空行）；空轮（topic 默认触发）= 换行+提示（对应指导 2）。
    const listBlock = round.groups.length === 0 ? `\n${lbl('dream.topic.empty')}` : `\n\n${groupsText}`
    lines.push(...resolveSlotText(round.kind === 'topic' ? 'dream-topic' : 'dream-atomic', { list: listBlock }).split('\n'))
  }
  return createUserMessage({ content: [{ type: 'text', text: lines.join('\n') }], source: PLUGIN_SOURCE })
}

// ── dream 任务状态（串行：同一时刻一个） ───────────────────────────────────

/** dream 租约：进行中任务的权威状态（落库，替换旧的模块级 currentDream + dream_pending 布尔）。
 *  owner/progress_at 组合成「租约」——progress_at 超时 = 主人已死，可补收尾；
 *  group_idx / T 落库后，推进/收尾不再依赖任何模块内存，跨实例、热重载、中止都安全。 */
interface DreamLease {
  owner: string
  started_at: number
  progress_at: number
  group_idx: number
  T: number
}

/** 租约超时：心跳按「组」刷新，LEASE 必须 > 单组最长处理时间。 */
const DREAM_LEASE_MS = 30 * 60_000
export { DREAM_LEASE_MS }

const liveAgents = new Map<string, unknown>() // sessionId -> 顶层 agent（live 引用）

export function registerLiveAgent(agent: { session?: { header?: { id?: string; parentSession?: unknown } } }): void {
  const id = agent.session?.header?.id
  if (typeof id === 'string' && id.length > 0) liveAgents.set(id, agent)
}

/** 生成本次 dream 的 owner token（pid + 随机后缀，仅诊断用；推进/收尾不校验 owner）。 */
function newDreamOwner(): string {
  return `${process.pid}:${Math.random().toString(36).slice(2, 10)}`
}

/** 自动 dream 重复触发冷却期：dream 收尾后 6h 内，即使 last_event_time 被意外事件
 *  刷新（打点/压缩重注入/未来未知 bug），也绝不重复自动 dream。2026-09-05 猫猫拍板
 *  （原话大意：dream 轮之后标记失败、后面重复 dream 是最大烧钱风险，50 元 token 血训）
 *  ——他的方案是"检查会话最后一轮是否 memory 插件触发"，等价防御用 db 现成字段
 *  （last_dream_time）实现，免读会话文件。代价：用户真实活动后的自动 dream 最多
 *  推迟到收尾+6h（保守取舍）。手动触发不经此判定；error 重试不受影响
 *  （releaseDream 不写 last_dream_time）。 */
export const DREAM_RETRIGGER_COOLDOWN_MS = 6 * 3600_000

/** 扫描判定：窗口需要 dream 吗？ */
export function windowNeedsDream(w: { last_event_time: number; last_dream_time: number | null }, now = Date.now()): boolean {
  if (now - w.last_event_time > 24 * 3600_000) return false // 超过 24h 的旧窗口不碰
  const lastDream = w.last_dream_time ?? 0
  if (lastDream >= w.last_event_time) return false // 已 dream 过（收尾后无新活动）
  if (lastDream > 0 && now - lastDream < DREAM_RETRIGGER_COOLDOWN_MS) return false // 冷却期内不重复
  return true
}

/** dream 状态信号回调：'dreaming' = dream 开始（租约抢占成功），'dreamed' = 整理完成/收尾。 */
export type DreamStateCallback = (sessionId: string, state: 'dreaming' | 'dreamed') => void

/**
 * 启动一个窗口的 dream（第 0 组）。agent 必须是该窗口的 live 顶层 agent。
 * 返回 false 表示无法启动（已有任务在跑 / 别处（含其他进程）正在 dream / 无记忆可整理）。
 * 防重复：DB 原子抢占 dream 租约（跨进程/重启一致）——抢占失败即不 start；
 * 抢占成功后即使本进程崩溃/被重载，下个检查周期也会按过期租约补收尾而不是重复 start。
 * 执行体：delegate 环境已设置（delegate.dream=true）时走 fork 子代理（launch 闭包，
 * done 回调链式推进），否则 steer 主会话（旧行为）。
 */
export function startWindowDream(ctx: Context, agent: { session?: { header?: { id?: string } } }, workspace: string, dir = '.dsh-meow', onDreamState?: DreamStateCallback, rulesReviewDays: number = DEFAULT_RULES_REVIEW_DAYS): boolean {
  const sessionId = agent.session?.header?.id
  if (!sessionId) return false
  const db = getDb(workspace, dir)
  const rounds = collectDreamRounds(db, sessionId, workspace, dir, rulesReviewDays)
  if (rounds.length === 0) {
    // 无本窗口记忆（建立的 ∪ 提取过的都无）：也推进 last_dream_time（= 本窗口无可整理），避免 need=true 恒成立、每轮空扫到 24h
    db.finishDream(sessionId, Date.now())
    dreamLog(workspace, dir, `dream skip-empty sid=${shortSessionId(sessionId)}`)
    onDreamState?.(sessionId, 'dreamed')
    return false
  }
  const win = db.getWindow(sessionId)
  // claimDream 的 INSERT OR IGNORE 会给新窗口行造出 last_event_time=0 哨兵，这里兜底 0
  const T = win && win.last_event_time > 0 ? win.last_event_time : Date.now()
  if (!db.claimDream(sessionId, newDreamOwner(), T, DREAM_LEASE_MS)) return false // 别处活跃租约未过期
  onDreamState?.(sessionId, 'dreaming')
  const msg = buildDreamMessage(db, sessionId, T, rounds, 0)
  const launch = delegateLaunchFor(agent, dir, onDreamState, rulesReviewDays)
  if (launch !== undefined) {
    launch(msg, sessionId, workspace, 0, rounds.length)
    // 主会话打点（delegate 模式整理不进主 log，恢复位置锚点；不触发 turn）
    appendDelegateMarker(agent, 'dream')
    dreamLog(workspace, dir, `dream start delegated pid=${process.pid} session=${shortSessionId(sessionId)} rounds=${rounds.length} T=${T}`)
  } else {
    ;(agent as { steer?: (m: unknown) => void }).steer?.(msg)
    dreamLog(workspace, dir, `dream start pid=${process.pid} session=${shortSessionId(sessionId)} rounds=${rounds.length} T=${T}`)
  }
  return true
}

/**
 * 推进：本窗口有进行中 dream → 下一组或收尾。
 * 状态完全从 DB 租约读：跨实例、热重载残留、中止都不影响推进正确性。
 * 推进按「sessionId + 租约未过期」判定，不校验 owner（owner 只用于抢占判断 + 诊断）。
 * 执行体：launch 提供时把组消息交给它（delegate 链式推进），否则 steer 主会话
 * （steer 版由 turn-stopping 驱动进入；delegate 版由子代理 done 回调驱动进入）。
 */
export function advanceDream(agent: unknown, dir = '.dsh-meow', onDreamState?: DreamStateCallback, rulesReviewDays: number = DEFAULT_RULES_REVIEW_DAYS, launch?: DreamLaunchFn): void {
  const sessionId = (agent as { session?: { header?: { id?: string } } })?.session?.header?.id
  const ws = (agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd
  if (typeof sessionId !== 'string' || typeof ws !== 'string' || ws.length === 0) return
  const db = getDb(ws, dir)
  const lease = db.getDreamLease(sessionId)
  if (lease === null) return // 无进行中 dream（已收尾/未开始）：不动

  if (Date.now() - lease.progress_at > DREAM_LEASE_MS) {
    // 租约过期 = 主人已死：补收尾（不再推进），防止窗口永久 need=true 反复 start
    recoverInterruptedDream(db, sessionId, ws, dir)
    dreamLog(ws, dir, `advanceDream expired-recover sid=${shortSessionId(sessionId)}`)
    onDreamState?.(sessionId, 'dreamed')
    return
  }

  const rounds = collectDreamRounds(db, sessionId, ws, dir, rulesReviewDays) // 重查：前序轮 archive/merge 已落地
  const nextIdx = lease.group_idx + 1
  if (nextIdx < rounds.length) {
    // CAS 推进：多实例同收 turn-stopping 时只有一个成功，其余跳过
    if (db.advanceDreamLease(sessionId, lease.group_idx, DREAM_LEASE_MS)) {
      const msg = buildDreamMessage(db, sessionId, lease.T, rounds, nextIdx)
      if (launch !== undefined) {
        launch(msg, sessionId, ws, nextIdx, rounds.length)
        dreamLog(ws, dir, `dream group ${nextIdx + 1}/${rounds.length} delegated`)
      } else {
        ;(agent as { steer?: (m: unknown) => void }).steer?.(msg)
        dreamLog(ws, dir, `dream group ${nextIdx + 1}/${rounds.length} steered`)
      }
    }
    return
  }
  // 最后一轮完成 → 收尾
  finalizeDream(db, sessionId, ws, dir, lease.T, 'done', rounds.length, onDreamState)
}

/**
 * 构造 delegate 模式的组执行体闭包：每组起一个 fork 子代理，done 回调里推进下一组
 * （stopReason=completed）或按中止收尾（组未完成）。delegate 环境未设置时返回
 * undefined（调用方回退 steer）。
 */
function delegateLaunchFor(agent: unknown, dir: string, onDreamState?: DreamStateCallback, rulesReviewDays: number = DEFAULT_RULES_REVIEW_DAYS): DreamLaunchFn | undefined {
  const env = dreamDelegateEnv
  if (env === null) return undefined
  return (msg, sessionId, ws, groupIdx, groupsTotal) => {
    const text = (msg?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('')
    const outcome = startDelegateSubagent(env.logger, resolveSubagents(env.ctx), {
      parent: agent,
      promptText: text,
      label: `meow-memory dream ${groupIdx + 1}/${groupsTotal}`,
      modelSpec: env.modelSpec,
      signal: env.signal,
      inFlight: env.inFlight,
      sessionKey: `${sessionId}:dream`,
      workspace: resolveWorkspace(env.ctx),
      done: (r) => {
        if (r.stopReason === 'completed') {
          // 推进下一组（launch 重新解析 delegate 环境——热重载后旧闭包不残留）
          advanceDream(agent, dir, onDreamState, rulesReviewDays, delegateLaunchFor(agent, dir, onDreamState, rulesReviewDays))
        } else if (r.stopReason === 'error') {
          // 执行失败（LLM/网络瞬态故障，如 2026-09-05 凌晨 open.bigmodel.cn 连接抖动
          // 吞掉整夜 5 个窗口的 dream）：只清租约**不封存**，last_dream_time 不动，
          // 下个检查周期 windowNeedsDream 仍成立即自动重试。不发 'dreamed' 信号——
          // client 状态由 db 快照轮询推导，呼吸灯随下次轮询自然熄灭。
          const db = getDb(ws, dir)
          if (db.getDreamLease(sessionId) !== null) {
            db.releaseDream(sessionId)
            dreamLog(ws, dir, `dream failed session=${shortSessionId(sessionId)} group=${groupIdx + 1}/${groupsTotal} stop=${String(r.stopReason)} -> lease released, retry next check`)
            env.logger.warn(`meow-memory: dream group ${groupIdx + 1}/${groupsTotal} failed (${r.stopReason}) — lease released for retry`)
          }
        } else {
          // 用户中止/被停止（aborted/interrupted 等）：立即收尾（组未完成，按 aborted 语义封存已写条目）
          const db = getDb(ws, dir)
          const lease = db.getDreamLease(sessionId)
          if (lease !== null) {
            finalizeDream(db, sessionId, ws, dir, lease.T, 'aborted', lease.group_idx + 1, onDreamState)
            env.logger.warn(`meow-memory: dream group ${groupIdx + 1}/${groupsTotal} ended (${r.stopReason}) — window dream finalized`)
          }
        }
      },
    })
    if (outcome === 'unavailable') {
      // 服务不可用回退 steer：不回退则组消息静默丢失（既不子代理也不进主会话，
      // 卡到租约过期补收尾——组内容永远没人整理）。'in-flight' 保持静默跳过（防重入）。
      ;(agent as { steer?: (m: unknown) => void }).steer?.(msg)
      dreamLog(ws, dir, `dream group ${groupIdx + 1}/${groupsTotal} steered (delegate unavailable fallback)`)
    }
  }
}

/** 收尾：封存全部条目（updated_at=T）+ 清租约 + 记 last_dream_time。失败不阻塞（日志兜底）。 */
function finalizeDream(db: ReturnType<typeof getDb>, sessionId: string, workspace: string, dir: string, T: number, reason: 'done' | 'aborted', groupsCount: number, onDreamState?: DreamStateCallback): void {
  try {
    const stamped = db.stampDream(sessionId, T)
    db.finishDream(sessionId, Date.now())
    db.logDream(
      `window dream ${reason}: ${shortSessionId(sessionId)} groups=${groupsCount} stamped=${stamped} T=${new Date(T).toISOString()}`,
      { before: undefined, after: undefined },
    )
    dreamLog(workspace, dir, `dream ${reason} session=${shortSessionId(sessionId)} groups=${groupsCount} stamped=${stamped}`)
    onDreamState?.(sessionId, 'dreamed')
  } catch (e) {
    dreamLog(workspace, dir, `dream ${reason} finish error: ${String(e)}`)
  }
}

/** dream 轮被用户停止（aborted/interrupted）：立即收尾，不再推进下一组。
 *  与旧 currentDream 不同——这里没有会卡死的内存态，收尾后 DB 租约即清。 */
export function abortDream(agent: unknown, dir = '.dsh-meow', onDreamState?: DreamStateCallback): void {
  const sessionId = (agent as { session?: { header?: { id?: string } } })?.session?.header?.id
  const ws = (agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd
  if (typeof sessionId !== 'string' || typeof ws !== 'string' || ws.length === 0) return
  const db = getDb(ws, dir)
  const lease = db.getDreamLease(sessionId)
  if (lease === null) return // 没有进行中 dream
  finalizeDream(db, sessionId, ws, dir, lease.T, 'aborted', lease.group_idx + 1, onDreamState)
}

// ── 工具：memory_dream（手动触发本窗口 dream） ─────────────────────────────

export function dreamTool(ctx: Context, dir = '.dsh-meow', onDreamState?: DreamStateCallback, rulesReviewDays: number = DEFAULT_RULES_REVIEW_DAYS): ToolDefinition {
  return {
    name: 'memory_dream',
    description: keyedValue('tools', 'memory_dream.description'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok?: boolean; note?: unknown }
        return [{ type: 'text' as const, text: v.ok ? `🧠 dream 已安排。${String(v.note ?? '')}` : `dream 未启动：${String(v.note ?? '')}` }]
      },
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_dream: 无法确定工作区（会话无 cwd）')
      if (!exec.agent) throw new Error('memory_dream: 无法确定当前 agent')
      if (isSubagentAgent(exec.agent)) {
        // 子代理没有独立记忆窗口：写记忆归属父窗口，dream 也归父窗口（2026-09-05
        // 猫猫拍板"主窗口主 session 负责 dream"）。delegate dream fork 的子代理
        // 误调本工具（fork 播种父会话 turn，工具 schema 可见）在此拦下，不进
        // windows 表不留 dream 痕迹。/dream 命令同款守卫见 dreamCommandDefinition。
        return { ok: false, note: '当前是子代理会话，没有独立的记忆窗口；记忆整理归父窗口负责，无需（也不能）在此触发 dream。' }
      }
      const ok = startWindowDream(ctx, exec.agent, workspace, dir, onDreamState, rulesReviewDays)
      if (ok) return { ok, note: '整理任务已在后台启动，会话流中的任务气泡会显示进度与完成状态。' }
      const sessionId = exec.agent.session?.header?.id
      const lease = typeof sessionId === 'string' ? getDb(workspace, dir).getDreamLease(sessionId) : null
      return {
        ok,
        note: lease !== null
          ? '本窗口已有 dream 任务在进行中（或待补收尾）。'
          : '本窗口没有需要整理的记忆。',
      }
    },
    presentCall(): { card: 'generic'; title: string; kind: 'write' } {
      return { card: 'generic', title: 'memory_dream: 整理本窗口记忆', kind: 'write' }
    },
  }
}

// ── 用户命令 /dream（dsh 命令平面） ─────────────────────────────────────────

/** dsh 命令平面（宿主 @deepseek-ai/dsh-commands）的最小结构视图：只声明本插件
 *  用到的成员，不 import 该包（保持零运行时依赖；实际类型由宿主运行时满足）。 */
interface DreamCommandAgent {
  session?: { header?: { id?: string; cwd?: string; origin?: unknown } }
}

export interface DreamCommandDefinition {
  readonly name: 'dream'
  readonly description: string
  readonly handler: (invocation: { agent?: DreamCommandAgent }) =>
    | { kind: 'success'; text?: string }
    | { kind: 'error'; text: string }
    | Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
}

/**
 * /dream 用户命令定义（手动唤起本窗口 dream）：与 memory_dream 工具同语义——直接
 * startWindowDream，不吃峰时抑制、不吃空闲检查。结果映射：启动成功 → success；
 * 子代理会话 / 无 cwd / 无会话 id / 租约占用 / 无可整理记忆 → error（UI 按
 * command-error 明确提示未启动原因，不会把 /dream 发给模型）。
 * 注册由 index.ts 负责（ctx.get('commands') 可选服务 + 就绪重试 + ctx.effect 清理）。
 */
export function dreamCommandDefinition(ctx: Context, dir = '.dsh-meow', onDreamState?: DreamStateCallback, rulesReviewDays: number = DEFAULT_RULES_REVIEW_DAYS): DreamCommandDefinition {
  return {
    name: 'dream',
    description: '手动唤起一次记忆整理（dream）：逐轮回顾本窗口建立/提取过的跨会话记忆并封存。与 memory_dream 工具相同，手动触发不受峰时抑制。',
    handler(invocation) {
      const agent = invocation?.agent
      if (!agent) return { kind: 'error', text: '/dream 无法确定当前窗口的会话。' }
      const header = agent.session?.header
      if (header?.origin === 'subagent') {
        return { kind: 'error', text: '/dream 只能在主会话使用：子代理没有独立的记忆窗口。' }
      }
      const workspace = typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : null
      if (workspace === null) {
        return { kind: 'error', text: '/dream 无法确定当前窗口的工作区（会话无 cwd）。' }
      }
      if (typeof header?.id !== 'string' || header.id.length === 0) {
        return { kind: 'error', text: '/dream 无法确定当前窗口的会话 id。' }
      }
      const ok = startWindowDream(ctx, agent, workspace, dir, onDreamState, rulesReviewDays)
      if (ok) return { kind: 'success', text: '🧠 dream 已触发：整理任务已在后台运行，会话流中的任务气泡会显示进度与完成状态。' }
      const lease = getDb(workspace, dir).getDreamLease(header.id)
      return lease !== null
        ? { kind: 'error', text: '本窗口已有 dream 任务在进行中（或待补收尾），未重复启动。' }
        : { kind: 'error', text: '本窗口没有需要整理的记忆（本窗口建立/提取过的记忆为空）。' }
    },
  }
}

/** 补收尾被打断的 dream（start 过但没 done：进程重启/热重载/跨进程打断）。
 *  视为已完成：封存该窗口条目 + 清 pending + 记 last_dream_time——不再重复 start。
 *  @returns 封存（stamped）的条目数。 */
export function recoverInterruptedDream(db: ReturnType<typeof getDb>, sessionId: string, workspace: string, dir = '.dsh-meow'): number {
  const lease = db.getDreamLease(sessionId)
  const w = db.getWindow(sessionId)
  const T = lease ? lease.T : w && w.last_event_time > 0 ? w.last_event_time : Date.now()
  const stamped = db.stampDream(sessionId, T)
  db.finishDream(sessionId, Date.now())
  db.logDream(
    `window dream recovered (interrupted): ${shortSessionId(sessionId)} stamped=${stamped} T=${new Date(T).toISOString()}`,
    { before: undefined, after: undefined },
  )
  dreamLog(workspace, dir, `dream recovered session=${shortSessionId(sessionId)} stamped=${stamped}`)
  return stamped
}

// ── 定时器 ──────────────────────────────────────────────────────────────────

export interface DreamConfig {
  enabled: boolean
  /** 窗口空闲多少分钟后允许 dream（用户拍板 2026-08-19：3 小时 = 180 分钟）。 */
  idleMinutes: number
  checkMinutes: number
  /** 抑制时段（目标时区，"HH:MM-HH:MM"）：这些时段内不触发 dream。
   *  默认=API 峰谷电价峰时（09:00–12:00、14:00–18:00）。 */
  suppressWindows: Array<{ start: string; end: string }>
  /** 每个抑制时段开始前追加的不触发分钟数（峰时前 15 分钟也不触发）。 */
  suppressLeadMinutes: number
  /** 抑制时段按此时区计算（默认 Asia/Shanghai——用户系统是美区时间，系统时区会算错）。 */
  timeZone: string
  /** rules 防 churn：updated_at 距今超该天数的稳定准则不进 dream 第 1 轮清单（0=不过滤，默认 2）。 */
  rulesReviewDays: number
}

/** rulesReviewDays 的单一默认来源：zod schema / resolveConfig 兜底 / 各运行时函数默认参数
 *  统一引用此处——改默认值只动这一行。 */
export const DEFAULT_RULES_REVIEW_DAYS = 2

/** 取指定时区的当前小时（Intl 支持；无效时区回退系统时区）。 */
export function hourInTimeZone(timeZone: string, date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).formatToParts(date)
    const h = parts.find((p) => p.type === 'hour')?.value
    if (h !== undefined) return parseInt(h, 10) % 24
  } catch {
    /* 无效时区 */
  }
  return date.getHours()
}

/** 取指定时区的当前分钟（0-1439，日内的分钟数；无效时区回退系统时区）。
 *  峰时抑制按分钟粒度判断（含 lead 前推，小时粒度不够）。 */
export function minutesInTimeZone(timeZone: string, date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(date)
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? 'NaN', 10)
    const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? 'NaN', 10)
    if (!Number.isNaN(h) && !Number.isNaN(m)) return (h % 24) * 60 + m
  } catch {
    /* 无效时区 */
  }
  const d = new Date(date)
  return d.getHours() * 60 + d.getMinutes()
}

/** 解析 "HH:MM" → 日内分钟数；非法返回 null。 */
function parseMinute(hhmm: string): number | null {
  const mm = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!mm) return null
  const h = parseInt(mm[1], 10)
  const m = parseInt(mm[2], 10)
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return h * 60 + m
}

/** 当前时刻是否处于 dream 抑制时段（用户拍板 2026-08-19）：
 *  suppressWindows 内（默认北京时间 09:00–12:00、14:00–18:00，API 峰谷电价峰时），
 *  以及每个峰时开始前 suppressLeadMinutes 分钟（默认 15）——此时不触发 dream，
 *  等峰时结束后的下一个检查周期自然触发。支持跨午夜时段（start > end）。 */
export function isDreamSuppressed(cfg: DreamConfig, date = new Date()): boolean {
  const m = minutesInTimeZone(cfg.timeZone, date)
  const lead = Math.max(0, Math.floor(cfg.suppressLeadMinutes))
  for (const w of cfg.suppressWindows) {
    const start = parseMinute(w.start)
    const end = parseMinute(w.end)
    if (start === null || end === null || start === end) continue // 非法/空时段跳过
    const from = (start - lead + 1440) % 1440
    if (from === end) return true // lead 覆盖整天
    if (from < end) {
      if (m >= from && m < end) return true
    } else if (m >= from || m < end) {
      return true // 前推或时段跨午夜
    }
  }
  return false
}

/** 进程重启后 liveAgents 清空：对满足 dream 条件的窗口按需恢复 agent。
 *  factory.resume 从 session persistence（jsonl 后端）把已有会话恢复成 live agent，
 *  与 GUI 打开会话同路径；恢复后重验全部条件再 startWindowDream（恢复耗时期间
 *  窗口状态可能已变）。失败只记日志静默降级——绝不 create 新建会话（窗口必然
 *  已有会话文件，恢复失败说明环境异常，宁可本轮不 dream 也不能造空会话）。
 *  resumeInFlight 防重入：恢复是异步的，耗时若跨过检查周期，避免重复 resume。 */
const resumeInFlight = new Set<string>()

/** resume 永久失败退避（进程级）：'session not found' 的窗口短期不会复活——会话文件
 *  不在本实例 home（跨实例窗口：两实例共享 windows 表，3080/3081 互试对方会话必失败；
 *  或已删除会话）。按周期重试纯属浪费+日志刷屏（2026-09-04/05 实测：每周期数十次
 *  'agent-resume-failed session not found'，dream-debug.log 一天 2MB+）。失败后 6h 内
 *  不再尝试本实例 resume；进程重启清零（每轮只多试一次，无害）。 */
const RESUME_BACKOFF_MS = 6 * 3600_000
const resumeFailedAt = new Map<string, number>()

function resumeBackoffActive(sessionId: string): boolean {
  const at = resumeFailedAt.get(sessionId)
  return at !== undefined && Date.now() - at < RESUME_BACKOFF_MS
}

function markResumeFailed(sessionId: string): void {
  resumeFailedAt.set(sessionId, Date.now())
  if (resumeFailedAt.size <= 512) return
  const now = Date.now()
  for (const [sid, at] of resumeFailedAt) {
    if (now - at >= RESUME_BACKOFF_MS) resumeFailedAt.delete(sid)
  }
}

/** 子代理会话判定（与 index.ts 注入链路同口径）：origin === 'subagent' 为 dsh 权威标记；
 *  delegationDepth > 0 作双保险。不能只看 parentSession——GUI fork/续写的主会话也有
 *  parentSession（2026-08-17 真机踩坑 fca10feb 误判）。 */
export function isSubagentAgent(agent: unknown): boolean {
  const header = (agent as { session?: { header?: { origin?: unknown; delegationDepth?: unknown } } })
    ?.session?.header
  if (header === undefined || header === null) return false
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

/** 已判定不参与自动 dream 的窗口（进程级缓存），两类来源：①origin/depth 判定为
 *  子代理会话；②resume resolve 但 agent 无可用 header（实测=子代理会话：dsh 对 fork
 *  子代理的 resume 返回不可用句柄，主会话 resume 恒返回完整 agent）。dream 只归主
 *  窗口——delegate fork 出的子代理会话虽然会进 windows 表/windowIndex（它们也产生
 *  事件），但不是 dream 目标，否则 dream 子代理→再进表→再被 dream→depth 无限套娃
 *  （2026-09-05 真机实证 8fbc5d59→2f47c15b→63dad87b，猫猫拍板：主窗口主 session
 *  负责 dream）。手动 /dream 与 memory_dream 不经此过滤（手动=明确意愿）。
 *  进程重启清零：每窗口最多多 resume 一次，无害。 */
const autoDreamSkipWindows = new Set<string>()

export async function resumeAndDream(ctx: Context, sessionId: string, workspace: string, dir: string, onDreamState: DreamStateCallback | undefined, cfg: DreamConfig): Promise<void> {
  const log = (msg: string): void => dreamLog(workspace, dir, msg)
  const sid = shortSessionId(sessionId)
  if (resumeInFlight.has(sessionId)) return
  if (resumeBackoffActive(sessionId)) return // not-found 退避期内：静默跳过
  resumeInFlight.add(sessionId)
  try {
    // ⚠️ resume 在 agents service 本体上（service.resume(options) 内部注入 ownerCtx
    // 并委托 factory.target.resume）——factory 槽是 { target } 包装、其上无 resume
    // 方法（dsh-agent lib/index.js 529-561 实证）。首版写 factory.resume 恒 undefined
    // → 全部 agent-missing 窗口 resume 静默失败（真机踩坑 2026-09-04，日志
    // 'agent-resume-unavailable factory=yes'），重启后自动 dream 从未真正恢复过。
    const agentsSvc = (ctx as { get?: (name: string) => unknown }).get?.('agents') as
      | { resume?: (options: { resumeSessionId: string }) => Promise<unknown> }
      | undefined
    if (agentsSvc === undefined || typeof agentsSvc.resume !== 'function') {
      log(`check agent-resume-unavailable sid=${sid} service=${agentsSvc ? 'yes' : 'no'}`)
      return
    }
    const agent = await agentsSvc.resume({ resumeSessionId: sessionId })
    const header = (agent as { session?: { header?: { id?: unknown; origin?: unknown; delegationDepth?: unknown } } })
      ?.session?.header
    if (header === undefined || header === null || typeof header.id !== 'string' || header.id.length === 0) {
      // resume resolve 但 agent 无可用 header——实测=子代理会话（dsh 对 fork 子代理的
      // resume 返回不可用句柄；主会话 resume 恒返回完整 agent，e95f149b 真机实证
      // 2026-09-05）。标缓存：后续周期 sweep 直接跳过，不再反复 resume。
      autoDreamSkipWindows.add(sessionId)
      log(`check resume unusable-agent sid=${sid} -> skip`)
      return
    }
    log(`check agent-resumed sid=${sid}`)
    if (isSubagentAgent(agent)) {
      autoDreamSkipWindows.add(sessionId)
      log(`check resume skip-subagent sid=${sid}`)
      return // 子代理会话不是 dream 目标（dream 只归主窗口）
    }
    const db = getDb(workspace, dir)
    const w = db.getWindow(sessionId)
    if (!w || !windowNeedsDream(w)) return // 恢复期间超 24h / 已 dream 过
    if (Date.now() - w.last_event_time < cfg.idleMinutes * 60_000) return // 恢复期间窗口被碰，空闲不足
    if (db.getDreamLease(sessionId) !== null) return // 恢复期间别处已启动 dream
    startWindowDream(ctx, agent as { session?: { header?: { id?: string } } }, workspace, dir, onDreamState, cfg.rulesReviewDays)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // 'session not found' = 会话文件不在本实例 home（跨实例/已删除）：永久性失败，
    // 记退避止血；其余错误（瞬时异常）不退避，下周期照常重试。
    if (msg.includes('not found')) markResumeFailed(sessionId)
    log(`check agent-resume-failed sid=${sid} err=${msg}`)
  } finally {
    resumeInFlight.delete(sessionId)
  }
}

/** dream 自动扫描单轮（scheduleDream 定时驱动；导出供测试直调）。
 *  峰时抑制/全局检查门在 scheduleDream 里，这里只做窗口遍历与启动。
 *  每轮最多 start 一个窗口（start 成功即返回，剩余下周期继续——清积压限速）。 */
export function dreamSweepOnce(ctx: Context, cfg: DreamConfig, dir: string, windowIndex: Map<string, string>, onDreamState?: DreamStateCallback): void {
  // 已归档会话集合（registry 全局归档；服务不可用时跳过检查）
  const archived = new Set<string>()
  try {
    const reg = (ctx as { get?: (name: string) => unknown }).get?.('workspaceRegistry') as
      | { archivedSessionIds?: readonly string[] }
      | undefined
    for (const id of reg?.archivedSessionIds ?? []) archived.add(id)
  } catch {
    /* workspaceRegistry 不可用：不做归档过滤 */
  }
  for (const [sessionId, workspace] of windowIndex) {
    if (archived.has(sessionId)) continue // 已归档 = 当不存在
    if (autoDreamSkipWindows.has(sessionId)) continue // 子代理/不可恢复窗口：进程级缓存命中，连 agent 都不取
    const db = getDb(workspace, dir)
    // 用户跳过（v0.16.0 侧边栏菜单 toggle）：本窗口不自动 dream。
    // 只挡自动触发——/dream 命令与 memory_dream 工具（手动=明确意愿）不受限；
    // 租约过期补收尾也不受影响（清理语义，防僵尸租约堵死后续手动触发）。
    if (db.isDreamSkipped(sessionId)) continue
    const w = db.getWindow(sessionId)
    if (!w || !windowNeedsDream(w)) continue
    const lease = db.getDreamLease(sessionId)
    dreamLog(workspace, dir, `check sid=${shortSessionId(sessionId)} active=${lease !== null} idle=${Math.round((Date.now() - w.last_event_time) / 1000)}s`)
    // 进行中 dream：只在租约过期（主人已死）时补收尾；活跃则跳过（别处正在 dream）
    if (lease !== null) {
      if (Date.now() - lease.progress_at > DREAM_LEASE_MS) {
        recoverInterruptedDream(db, sessionId, workspace, dir)
        onDreamState?.(sessionId, 'dreamed')
      }
      continue
    }
    // 窗口级 idle（用户拍板：session 最近 idleMinutes 无动作才 dream）：
    // 用 db 持久化的 last_event_time 判定——不受模块实例/热重载影响。
    // （空闲判定完全按窗口自身 last_event_time，与全局/其他窗口活动无关，
    //   避免活跃窗口拖累已空闲窗口导致 dream 永不触发。）
    if (Date.now() - w.last_event_time < cfg.idleMinutes * 60_000) continue
    const agentsSvc = typeof ctx.get === 'function'
      ? (ctx.get('agents') as { get?: (id: unknown) => unknown } | undefined)
      : undefined
    const agent =
      liveAgents.get(sessionId) ??
      (agentsSvc !== undefined && typeof agentsSvc.get === 'function' ? agentsSvc.get(sessionId) : undefined)
    if (!agent) {
      // 进程内无该窗口 agent（重启后 liveAgents 清空）：异步从 persistence 恢复
      // （factory.resume，与 GUI 打开会话同路径）后再 dream——挂着的窗口不因重启
      // 丢 dream 资格（2026-09-01 用户拍板）。fire-and-forget：不阻塞本轮检查，
      // resumeInFlight 防重入，失败静默降级为旧行为（只跳过不 dream）。
      dreamLog(workspace, dir, `check agent-missing sid=${shortSessionId(sessionId)} -> try resume`)
      void resumeAndDream(ctx, sessionId, workspace, dir, onDreamState, cfg)
      continue
    }
    if (isSubagentAgent(agent)) {
      // 子代理会话窗口：不 dream（否则 dream 子代理→再进表→再被 dream 无限递归）。
      // 记入缓存后后续周期在循环顶部直接跳过，不再打 check 日志。
      autoDreamSkipWindows.add(sessionId)
      dreamLog(workspace, dir, `check skip-subagent sid=${shortSessionId(sessionId)}`)
      continue
    }
    const started = startWindowDream(ctx, agent as never, workspace, dir, onDreamState, cfg.rulesReviewDays)
    if (started) return // 一轮一个窗口
  }
}

/** 后台定时检查（全局 setInterval + dispose 清理；cordis 无内置定时器）。
 *  判定纯时间化（用户拍板）：窗口最后发言在 24h 内 且 最后动作不是 dream
 *  （last_dream_time < last_event_time）；不依赖 live agent 存在性。
 *  已归档的会话（workspaceRegistry.archivedSessionIds）视为不存在，不 dream（用户拍板）。
 *  执行时尝试取 agent（liveAgents 或 ctx.agents.get），进程重启后取不到 → 跳过（旧窗口精神）。 */
export function scheduleDream(ctx: Context, cfg: DreamConfig, dir = '.dsh-meow', windowIndex: Map<string, string>, onDreamState?: DreamStateCallback): () => void {
  const timer = setInterval(() => {
    if (!cfg.enabled) return
    // 峰时抑制（用户拍板 2026-08-19）：北京时间 09:00–12:00 / 14:00–18:00
    // （API 峰谷电价峰时）及各自开始前 15 分钟不触发；峰时结束后本周期直接
    // return，等下一个检查周期自然触发。进行中的 dream 不打断。
    if (isDreamSuppressed(cfg)) return
    // 全局检查门（防多实例/多定时器叠加）：60 秒内只有一个实例真正执行检查。
    // 根因：热重载/多 fiber 并存时 dispose 未必清理旧 setInterval → 检查频率
    // 远高于 checkMinutes → 同一窗口被反复 start。用共享库的原子抢占做节流，
    // 与 claimDream（start 幂等）+ recoverInterruptedDream（中断自愈）闭环。
    let gatePassed = false
    for (const [, ws] of windowIndex) {
      if (getDb(ws, dir).claimCheckGate(60_000)) gatePassed = true
      break
    }
    if (!gatePassed) return
    dreamSweepOnce(ctx, cfg, dir, windowIndex, onDreamState)
  }, cfg.checkMinutes * 60_000)
  return () => clearInterval(timer)
}

/** 会话活跃度跟踪（模块级，单进程足够）。 */
let lastActivityAt = Date.now()
export function noteActivity(): void {
  lastActivityAt = Date.now()
}
export function lastActivity(): number {
  return lastActivityAt
}
