/**
 * meow-memory v2 — 喵版跨会话记忆插件（host 端）。
 *
 * 设计（2026-08-15 与用户拍板）：
 * - SQLite 结构化存储（node:sqlite，宿主同款），每 level 一表：
 *   soul / user / project / fact / lesson / topic / rules；id=时间前缀（排序=创建顺序）。
 * - 注入：会话开头 soul/user 全量 + 记忆导引（project/topic 标题列表，正文自取）
 *   + 第一条用户消息关键词命中 fact/lesson 短条目；无每轮注入。
 * - 去重：.dsh-meow/sessions/<sessionId>.json 记录本会话注入过的 memory id。
 * - 工具：memory_remember / memory_search / memory_read / memory_update
 *   + memory_dream（手动整理本窗口）。
 * - 反思：干过活的 turn 结束后引导模型记忆——【一】新记忆（project 列表/纠正/偏好）、
 *   【二】更新判断（含关键词不准反推）、【三】通用要求（subcategory/关键词 8-13/importance）；
 *   topic 归 dream 轮处理（用户拍板 2026-08-19）。
 * - dream：按窗口空闲整理（用户拍板 2026-08-19：空闲 ≥3h 即允许，替代原夜间窗口；
 *   北京时间峰时 09:00–12:00 / 14:00–18:00 及前 15 分钟抑制不触发）——每个窗口由
 *   自己的主 agent 整理自己建立/提取过的记忆，分轮处理（原子记忆 project/fact/lesson
 *   → topic 记忆 → 项目总结，2026-08-22 加第三轮），project 小标题分段；
 *   updated_at 封存（"记忆时间戳"=最后更新时间）；串行；旧窗口不碰。
 * - 迁移：首次打开库时把旧 PROJECT.md 导入 SQLite，文件改名 .imported 留底。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { closeAllDbs, getDb, memoryDbPath } from './db.js'
import {
  abortDream,
  advanceDream,
  DEFAULT_RULES_REVIEW_DAYS,
  DREAM_MARKER,
  dreamCommandDefinition,
  dreamTool,
  noteActivity,
  registerLiveAgent,
  scheduleDream,
  shortSessionId,
  type DreamConfig,
} from './dream.js'
import { buildHitInjection, buildInjection, buildReinjection, clearReinjectPending, isReinjectPending, markAccessed, markReinjectPending, markSearched, readProjectQueried, readSeen, readInjected, releaseSeen } from './inject.js'
import { migrateLegacy } from './migrate.js'
import { buildReflectMessage, consecutiveToolSteps, PLUGIN_SOURCE, REFLECT_MARKER, scanTurn } from './reflect.js'
import { registerMemoryTools } from './tools.js'
import { resolveSlotText, setPromptLang } from './prompt-loader.js'

/** 首次欢迎引导的 seen 记账 id（accessed 通道，非真实记忆 id；releaseSeen 不清除）。 */
const WELCOME_GUIDE_SEEN_ID = '__welcomeGuide__'
import { collectDreamStates, DreamStateBroadcast } from './dream-signal.js'

export const name = 'meow-memory'

/** tools 是硬依赖（注册 memory_*）；systemPrompt 为可选服务（ctx.get 兜底）。 */
export const inject = ['tools']

/** 把动态记忆作为独立上下文消息交给模型，不改写人类 user 消息。 */
function createMemorySnapshotMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'meow-memory',
      form: 'snapshot',
      sections: [{ name: '长期记忆', text }],
    },
  })
}

/**
 * 记忆系统静态手册 —— 挂进 system prompt（order 130 = 工具指南区间末尾，
 * 紧随各 tool:* 说明（100–116）之后，与工具说明列在一起）。
 * 文本恒定、不随会话变化 → 前缀稳定，KV 缓存友好；动态记忆内容（soul/user/
 * 导引/命中）仍走首条消息注入。文案与 tools.ts 的工具 schema 保持一致。
 */
/** system prompt 手册（文案外置 v0.19.0）：prompts/zh/system-guide.md，运行时读取——
 *  改 md 文件下一次 apply / 热重载后生效，无需改代码。文本恒定、不随会话变化 →
 *  前缀稳定，KV 缓存友好；动态记忆内容（soul/user/导引/命中）仍走首条消息注入。
 *  文案与 tools.md 的工具 schema 保持一致。
 */
export function getMemoryGuide(): string {
  return resolveSlotText('system-guide')
}

// ── 性能诊断（perf.log，固定位置 ~/.dsh-meow/perf.log；卡死时查数据） ────────
// 模块级计数器：模块只初始化一次；apply 每次执行 +1——若日志里 apply 编号异常
// 跳跃/重复，说明 apply 被多次调用（handler 叠加）。事件计数看事件吞吐。
const PERF_LOG = join(homedir(), '.dsh-meow', 'perf.log')
let applyCount = 0
let evtCount = 0
let perfBoot = Date.now()
let lastPerfLog = Date.now()
function perf(msg: string): void {
  try {
    mkdirSync(dirname(PERF_LOG), { recursive: true })
    appendFileSync(PERF_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志失败不阻塞 */
  }
}
/** 事件吞吐统计：每 5 秒落一条（同步追加，不阻塞）。 */
function perfEvent(): void {
  evtCount++
  const now = Date.now()
  if (now - lastPerfLog >= 5000) {
    const elapsed = (now - perfBoot) / 1000
    perf(`evt total=${evtCount} elapsed=${elapsed.toFixed(1)}s rate=${(evtCount / Math.max(elapsed, 0.001)).toFixed(1)}/s`)
    lastPerfLog = now
  }
}

export const Config = z.object({
  /** 总开关：false 时注入、反思、工具全部停用。 */
  enabled: z.boolean().default(true),
  /** 记忆目录（相对工作区）。 */
  projectDir: z.string().default('.dsh-meow'),
  /** 关键词命中条数上限（fact/lesson/rules/topic 短条目，每条用户消息命中注入）。 */
  hitTopK: z.number().min(0).max(10).default(2),
  /** 导引标题截断长度。 */
  titleMax: z.number().min(10).max(200).default(40),
  /** 是否在 ReAct 任务结束后自动注入反思。 */
  reflect: z.boolean().default(true),
  /** 单任务内连续工具 step 达到该值才在结束时触发反思（用户拍板：react ≥7 轮）。 */
  reflectTurns: z.number().min(1).max(50).default(7),
  /** 首次打开库时自动迁移旧 PROJECT.md。 */
  autoMigrate: z.boolean().default(true),
  /** prompt 语言（prompts/<lang>/ 语言包目录名）：决定注入/反思/dream 文案、工具
   *  描述与 BM25 分词的语言。**首次使用建议显式配置**——记忆条目语言必须与 BM25
   *  关键词语言一致，否则检索匹配率崩（详见 README）。zh=内置默认；en 等社区语言包
   *  放 lib/prompts/（随包）或 homedir/.dsh-meow/prompts/（实例覆盖，可只覆盖部分槽位）。
   *  不设置（undefined）：运行时按 zh 跑，且插件生效后的第一条真实用户消息会注入
   *  「首次设置」引导任务（AI 判断用户语言并完成配置，每会话至多提醒一次）。 */
  promptLang: z.string().required(false),
  /** 空闲整理（dream）。 */
  dream: z
    .object({
      enabled: z.boolean().default(true),
      /** 窗口空闲多少分钟后允许 dream（用户拍板 2026-08-19：3 小时）。 */
      idleMinutes: z.number().min(1).default(180),
      /** 抑制时段（目标时区，"HH:MM" 起止）：这些时段内不触发 dream。 */
      suppressWindows: z
        .array(z.object({ start: z.string(), end: z.string() }))
        .default([{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }]),
      /** 每个抑制时段开始前追加的不触发分钟数（峰时前 15 分钟也不触发）。 */
      suppressLeadMinutes: z.number().min(0).max(120).default(15),
      checkMinutes: z.number().min(1).default(15),
      // 用户系统是美区时间（隐私设置），抑制时段按中国时区计算
      timeZone: z.string().default('Asia/Shanghai'),
      /** rules 防 churn（测评 2026-08-25）：updated_at 距今超该天数的稳定准则不进 dream 第 1 轮清单；0=不过滤。 */
      rulesReviewDays: z.number().min(0).default(DEFAULT_RULES_REVIEW_DAYS),
    })
    .default({}),
})

interface ResolvedConfig {
  enabled: boolean
  projectDir: string
  hitTopK: number
  titleMax: number
  reflect: boolean
  reflectTurns: number
  autoMigrate: boolean
  /** undefined = 用户未配置（首次设置引导的触发信号）；运行时语言兜底 zh。 */
  promptLang: string | undefined
  dream: DreamConfig
}

function resolveConfig(config: unknown): ResolvedConfig {
  const c = (config ?? {}) as Partial<ResolvedConfig>
  const d = (c.dream ?? {}) as Partial<DreamConfig>
  return {
    enabled: c.enabled ?? true,
    projectDir: c.projectDir ?? '.dsh-meow',
    hitTopK: c.hitTopK ?? 2,
    titleMax: c.titleMax ?? 40,
    reflect: c.reflect ?? true,
    reflectTurns: c.reflectTurns ?? 7,
    autoMigrate: c.autoMigrate ?? true,
    promptLang: typeof c.promptLang === 'string' && c.promptLang.trim() ? c.promptLang.trim() : undefined,
    dream: {
      enabled: d.enabled ?? true,
      idleMinutes: d.idleMinutes ?? 180,
      suppressWindows: d.suppressWindows ?? [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
      suppressLeadMinutes: d.suppressLeadMinutes ?? 15,
      checkMinutes: d.checkMinutes ?? 15,
      timeZone: d.timeZone ?? 'Asia/Shanghai',
      rulesReviewDays: d.rulesReviewDays ?? DEFAULT_RULES_REVIEW_DAYS,
    },
  }
}

interface SessionHeaderLike {
  cwd?: string
  id?: string
  parentSession?: unknown
  /** 子代理权威标记（dsh：origin === 'subagent'）；GUI fork 的会话只有 parentSession 无 origin。 */
  origin?: unknown
}

/** 工作区 = 会话 cwd（项目根）；目录名 projectDir 单独下传给各模块（防双拼）。 */
function workspaceOfAgent(agent: { session?: { header?: SessionHeaderLike } }): string | null {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

function sessionIdOfAgent(agent: { session?: { header?: SessionHeaderLike } }): string {
  const id = agent?.session?.header?.id
  return typeof id === 'string' && id.length > 0 ? id : 'unknown'
}

/** 本 turn 是否为 dream 轮（事件流里存在 meow-memory 的 dream 指令消息）。 */
function wasDreamTurn(events: readonly unknown[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { source?: { kind?: string; plugin?: string }; content?: Array<{ type?: string; text?: string }> } }
    if (e?.type === 'turn/start') break
    if (e?.type === 'user/message' && e.data?.source?.kind === 'plugin' && e.data.source.plugin === 'meow-memory') {
      if ((e.data.content ?? []).some((b) => b.type === 'text' && b.text?.includes(DREAM_MARKER))) return true
    }
  }
  return false
}

/** 最近一个 turn/end 的 reason.kind（aborted/interrupted 表示用户停止，不反思不推进）。 */
function lastTurnEndReason(events: readonly unknown[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { reason?: { kind?: string } } }
    if (e?.type === 'turn/start') break
    if (e?.type === 'turn/end' && typeof e.data?.reason?.kind === 'string') return e.data.reason.kind
  }
  return null
}

/** apply 包装：错误落盘（homedir/.dsh-meow/apply-error.log），排查 fiber 启动失败。 */
export async function apply(ctx: Context, config: unknown): Promise<void> {
  try {
    return await applyInner(ctx, config)
  } catch (e) {
    try {
      const errFile = join(homedir(), '.dsh-meow', 'apply-error.log')
      mkdirSync(dirname(errFile), { recursive: true })
      appendFileSync(errFile, `[${new Date().toISOString()}] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
    } catch {
      /* 日志失败忽略 */
    }
    throw e
  }
}

async function applyInner(ctx: Context, config: unknown): Promise<void> {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) {
    ctx.logger.info('meow-memory: disabled by config')
    return
  }
  // prompt 语言（实例常量）：setPromptLang 一次，loader/bm25 内部取用——链路零透传。
  // 必须先于工具注册（tools.md 描述也吃这个语言）。未配置时运行时兜底 zh。
  setPromptLang(resolved.promptLang ?? 'zh')
  applyCount++
  perf(`apply #${applyCount} pid=${process.pid}`)
  loadWindowIndex(resolved.projectDir) // 恢复窗口索引（热重载/重启后旧窗口不失联）
  perf(`window-index restored ${windowIndex.size} windows`)

  // 工具注册 + disposer 收集：热重载/重启时旧 fiber 的工具必须注销，
  // 否则新 apply 重复注册同名工具会抛异常 → apply 中断 → 工具/手册/pre-step 全失效
  // （真机踩坑 2026-08-17：04:35 配置变更触发的 reload 后首轮注入消失）。
  const toolDisposers: Array<() => void> = []
  registerMemoryTools((t) => {
    const dispose = ctx.tools.register(t)
    if (typeof dispose === 'function') toolDisposers.push(dispose)
  }, resolved.projectDir)
  // 会话列表"已 dream"小月牙信号（用户拍板 2026-08-19）：dream 开始推 dreaming、
  // 完成推 dreamed、有新活动推 active。
  const broadcast = new DreamStateBroadcast(ctx.logger)
  const signalDreamState = (sessionId: string, state: 'dreaming' | 'dreamed'): void => broadcast.broadcast(sessionId, state)
  const disposeDreamTool = ctx.tools.register(dreamTool(ctx, resolved.projectDir, signalDreamState, resolved.dream.rulesReviewDays))
  if (typeof disposeDreamTool === 'function') toolDisposers.push(disposeDreamTool)
  ctx.logger.info('meow-memory: memory_remember/search/read/update + memory_dream registered')

  // 记忆系统手册挂进 system prompt（静态文本 → KV 缓存友好；order 130 = 工具指南区间末尾，
  // 与各 tool:* 说明（100–116）列在一起，不独占开头）。
  // systemPrompt 是可选服务（别的 profile 可能没加载 dsh-system-prompt），取不到就跳过。
  const sp = (ctx as { get?: (name: string) => unknown }).get?.('systemPrompt') as
    | { section?: (section: { name: string; order: number; text: string }) => unknown }
    | undefined
  sp?.section?.({ name: 'meow-memory:guide', order: 130, text: getMemoryGuide() })

  // 窗口表：只处理低频事件类型（流式 assistant/chunk 每块一个事件，绝不逐块写库）。
  // 节流：同一窗口 5 秒内最多落库一次（内存记 lastWrite，事件循环零阻塞）。
  // 插件注入轮（反思/dream 的 steer 消息轮）内的事件不刷新 last_event_time：
  // dream 轮自身事件会推后窗口活跃度 → 收尾后 last_dream_time < last_event_time
  // → 窗口永远"需要 dream"，配合中断/多进程场景造成反复 dream。
  const lastWindowWrite = new Map<string, number>()
  const isPluginTurn = new Map<string, boolean>() // sid -> 本 turn 是否为 meow-memory 插件轮
  ctx.on('session/event', (session: { id?: string; header?: SessionHeaderLike }, event: { time?: number; type?: string; data?: unknown }) => {
    perfEvent()
    noteActivity()
    const t = event?.type
    const sid = session?.id
    const cwd = session?.header?.cwd
    // 压缩信号：会话历史被压缩（内容已不在上下文）→ 释放本会话已见记录，
    // 允许之前注入/检索过的记忆被再次命中提取。
    if (t === 'compaction/summary' || t === 'compaction/start') {
      if (typeof sid === 'string' && typeof cwd === 'string') {
        releaseSeen(cwd, sid, resolved.projectDir)
        ctx.logger.info(`meow-memory: compaction signal, released seen memory for session ${shortSessionId(sid)}`)
      }
      return
    }
    // 压缩成功落地（compaction/end 无 error = 表层已替换，v0.21.0）：置重注入待办——
    // 下一个含真实用户消息的 pre-step 重新注入「长期记忆快照 + 本会话查阅过的项目全景」。
    // /compact 手动压缩与 token 压力自动压缩走同一生命周期，都覆盖。
    // 带 error 的 end = 压缩失败、表层未变（原上下文还在），不打标记。
    if (t === 'compaction/end') {
      const err = (event.data as { error?: unknown } | undefined)?.error
      if ((err === undefined || err === null || err === '') && typeof sid === 'string' && typeof cwd === 'string') {
        markReinjectPending(cwd, sid, resolved.projectDir)
        ctx.logger.info(`meow-memory: compaction finished, memory re-injection armed for session ${shortSessionId(sid)}`)
      }
      return
    }
    if (typeof sid === 'string') {
      if (t === 'turn/start') {
        isPluginTurn.set(sid, false) // 新轮重置
        return
      }
      if (t === 'user/message') {
        const src = (event.data as { source?: { kind?: string; plugin?: string; form?: string } } | undefined)?.source
        if (src?.kind === 'plugin' && src.plugin === 'meow-memory' && src.form !== 'snapshot') {
          isPluginTurn.set(sid, true) // 反思/dream 指令轮
          return // 指令消息本身也不刷新活跃度
        }
      }
      if (isPluginTurn.get(sid)) return // 插件轮内：不 touchWindow
    }
    if (t !== 'user/message' && t !== 'turn/end' && t !== 'assistant/message' && t !== 'tool/result') return
    if (typeof sid !== 'string' || typeof cwd !== 'string' || typeof event?.time !== 'number') return
    const now = Date.now()
    const last = lastWindowWrite.get(sid) ?? 0
    if (now - last < 5000) return // 节流：5 秒内同窗口只写一次
    lastWindowWrite.set(sid, now)
    const db = getDb(cwd, resolved.projectDir)
    db.touchWindow(sid, cwd, event.time)
    // dream 状态信号：该会话有新活动 → 若曾 dream 过，推 active（去月亮；client 幂等忽略）。
    const win = db.getWindow(sid)
    if (win !== undefined && win.last_dream_time !== null) broadcast.broadcast(sid, 'active')
    windowIndex.set(sid, cwd)
    persistWindowIndex() // 窗口索引落盘（热重载/重启后恢复）
  })

  // 1) 注入：首轮快照（soul/user/设计原则/导引，仅一次）+ 命中链路（第二条起每条真实用户消息都跑）。
  // 首轮判定（真机踩坑 2026-08-16）：不能看 decision.messages[0]——首条用户消息可能与
  // 插件通知消息同批到达（如 user-approval 的 policy 变更通知，source.kind='plugin'），
  // messages[0] 未必是用户消息。正确判定 = 本会话日志里还没有任何 user/message
  // （harness 在 pre-step 之后才 append 当前消息，首条消息时日志必为空）+ 消息列表里
  // 存在真实用户消息（source.kind === 'user'）。
  // 首条消息：只注入长期记忆快照，绝不跑命中链路（用户拍板：命中从第二轮起）。
  // 进程重启后恢复的会话：日志已有 user/message → 视为首轮已注入，只走命中链路。
  const firstUserHandled = new Set<string>()
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<unknown> => {
    const t0 = Date.now()
    const decision = await next()
    if (decision === undefined || decision.kind !== 'enter' || signal.aborted) return decision
    if (decision.messages.length === 0) return decision
    // 子代理不注入（origin === 'subagent'，dsh 权威标记）：它们的 prompt 由父代理提供
    // （如 dsh-femwa 的角色上下文）。注意不能只看 parentSession——GUI fork/续写的
    // 主会话也有 parentSession（真机踩坑 2026-08-17：fca10feb 被误判为子代理导致注入全失效）。
    if (agent.session.header.origin === 'subagent') return decision
    registerLiveAgent(agent)
    const sid = sessionIdOfAgent(agent)
    const ws = workspaceOfAgent(agent)

    // 真实用户消息（跳过插件通知等，source.kind='plugin' 的进不来）。
    const userMsgs = decision.messages.filter((m) => m.source?.kind === 'user')
    if (userMsgs.length === 0) return decision // 工具轮/纯插件消息：不注入

    // 压缩重注入（v0.21.0）：compaction/end 成功后置位的待办——下一个含真实用户
    // 消息的请求在消息前注入「长期记忆快照 + 本会话此前查阅过的项目全景」，然后清待办。
    // 本轮不跑命中链路（等同新首轮：快照先行，命中从下一轮起）。待办置位但无可注入
    // 内容（库空且项目全空）也一并清除，避免每个用户消息轮空转重查。
    if (ws && isReinjectPending(ws, sid, resolved.projectDir)) {
      const lastUser = userMsgs[userMsgs.length - 1]
      const db = getDb(ws, resolved.projectDir)
      const reinj = buildReinjection(db, ws, sid, readProjectQueried(ws, sid, resolved.projectDir), {
        hitTopK: resolved.hitTopK,
        titleMax: resolved.titleMax,
      }, resolved.projectDir)
      clearReinjectPending(ws, sid, resolved.projectDir)
      if (reinj !== null) {
        const rewritten = [...decision.messages]
        rewritten.splice(rewritten.indexOf(lastUser), 0, createMemorySnapshotMessage(reinj.text))
        ctx.logger.info(`meow-memory: post-compaction memory re-injected (${reinj.text.length} chars)`)
        return { ...decision, messages: rewritten }
      }
      return decision
    }

    // 首条用户消息（本进程内每个会话只判定一次）。
    if (!firstUserHandled.has(sid)) {
      firstUserHandled.add(sid)
      let priorUser = 0
      for (const e of agent.session.events) {
        const evt = e as { type?: string; data?: { source?: { kind?: string } } }
        if (evt?.type === 'user/message' && evt.data?.source?.kind !== 'plugin') priorUser++
      }
      if (ws) {
        try {
          appendFileSync(join(ws, resolved.projectDir, 'dream-debug.log'), `[${new Date().toISOString()}] pre-step first pid=${process.pid} sid=${shortSessionId(sid)} priorUser=${priorUser} userMsgs=${userMsgs.length}\n`)
        } catch { /* 日志失败不阻塞 */ }
      }
      if (priorUser === 0) {
        // 会话首条消息：只注入长期记忆快照，不跑命中链路。
        if (ws) {
          const firstUser = userMsgs[0]
          const db = getDb(ws, resolved.projectDir)
          if (resolved.autoMigrate && existsSync(join(ws, resolved.projectDir, 'PROJECT.md'))) {
            const n = migrateLegacy(db, ws, resolved.projectDir)
            if (n !== null) ctx.logger.info(`meow-memory: migrated legacy PROJECT.md → SQLite (${n} entries)`)
          }
          const firstText = firstUser.content
            .filter((b: { type?: string; text?: string }) => b.type === 'text' && typeof b.text === 'string')
            .map((b: { text?: string }) => b.text ?? '')
            .join(' ')
          const injected = buildInjection(db, ws, sid, firstText, {
            hitTopK: resolved.hitTopK,
            titleMax: resolved.titleMax,
          }, resolved.projectDir)
          if (injected) {
            const rewritten = [...decision.messages]
            rewritten.splice(rewritten.indexOf(firstUser), 0, createMemorySnapshotMessage(injected.text))
            ctx.logger.info(`meow-memory: inserted memory snapshot (${injected.text.length} chars) before first user message`)
            return { ...decision, messages: rewritten }
          }
        }
        return decision // 首条消息：不跑命中链路（首轮只注入长期记忆）
      }
      // 恢复的会话（日志已有历史消息）：首轮快照由上个进程注入过，只走命中链路。
    }

    // 首次设置引导（v0.19.0）：promptLang 未配置时，在插件生效后的第一条含真实用户
    // 消息的请求前注入设置任务（AI 只依据用户消息判断语言 → 改 patch → 热重载）。
    // 记账 = sessions/<id>.json 的 accessed 痕迹 '__welcomeGuide__'（per-session 至多一次；
    // accessed 不被 releaseSeen 清除，上下文压缩后不会重注入；配置生效后 promptLang
    // 有值 → 本分支永久短路）。首轮消息不进这里（首轮分支上方已 return——装插件场景
    // 会话早已过首轮，且首轮用户往往还没好好说话，判断语言不可靠）。
    if (resolved.promptLang === undefined && ws) {
      const seen = readSeen(ws, sid, resolved.projectDir)
      if (!seen.has(WELCOME_GUIDE_SEEN_ID)) {
        const lastUser = [...decision.messages].reverse().find((m) => m.source?.kind === 'user')
        if (lastUser !== undefined) {
          markAccessed(ws, sid, [WELCOME_GUIDE_SEEN_ID], resolved.projectDir)
          const guide = resolveSlotText('welcome-guide', { homePath: homedir() })
          const rewritten = decision.messages.map((m) => m === lastUser
            ? { ...m, content: [{ type: 'text', text: guide }, ...m.content] }
            : m)
          ctx.logger.info('meow-memory: first-run lang guide injected (promptLang unset)')
          return { ...decision, messages: rewritten }
        }
      }
    }

    // 命中链路（从第二条用户消息起）：每条含真实用户消息的请求都跑关键词检索命中
    // （top-K）。工具轮/子步骤的请求消息不含真实用户消息 → 不触发；
    // 命中 id 记入已见，不再重复。
    if (ws) {
      const lastUser = [...decision.messages].reverse().find((m) => m.source?.kind === 'user')
      if (lastUser !== undefined) {
        const text = lastUser.content
          .filter((b: { type?: string; text?: string }) => b.type === 'text' && typeof b.text === 'string')
          .map((b: { text?: string }) => b.text ?? '')
          .join(' ')
        const db = getDb(ws, resolved.projectDir)
        const hit = buildHitInjection(db, ws, sid, text, {
          hitTopK: resolved.hitTopK,
          titleMax: resolved.titleMax,
        }, resolved.projectDir)
        try {
          appendFileSync(join(ws, resolved.projectDir, 'dream-debug.log'), `[${new Date().toISOString()}] hit-chain pid=${process.pid} sid=${shortSessionId(sid)} text=${text.slice(0, 40).replace(/\n/g, ' ')} hit=${hit === null ? 'null' : 'yes'}\n`)
        } catch { /* 日志失败不阻塞 */ }
        if (hit !== null) {
          const rewritten = [...decision.messages]
          rewritten.splice(rewritten.indexOf(lastUser), 0, createMemorySnapshotMessage(hit.text))
          return { ...decision, messages: rewritten }
        }
      }
      if (Date.now() - t0 > 10) perf(`pre-step hit ${Date.now() - t0}ms sid=${shortSessionId(sid)}`) // 热路径超 10ms 有鬼
    }
    return decision
  })

  // 2) turn 结束：dream 轮推进 / 自动反思。
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const t0 = Date.now()
    if (agent.session.header.origin === 'subagent') return // 子代理不参与（origin 权威判定）
    registerLiveAgent(agent)
    const endReason = lastTurnEndReason(agent.session.events)
    const dreamTurn = wasDreamTurn(agent.session.events)
    const wsTs = workspaceOfAgent(agent)
    const sidTs = sessionIdOfAgent(agent)
    if (wsTs) {
      try {
        appendFileSync(join(wsTs, resolved.projectDir, 'dream-debug.log'), `[${new Date().toISOString()}] turn-stopping pid=${process.pid} sid=${shortSessionId(sidTs)} reason=${endReason ?? 'none'} wasDream=${dreamTurn}\n`)
      } catch { /* 日志失败不阻塞 */ }
    }
    // 用户按停止（aborted/interrupted）：不反思、不推进下一组；但 dream 轮必须立即收尾，
    // 否则 DB 租约残留，窗口要等租约过期（30min）才能再 dream。
    if (endReason === 'aborted' || endReason === 'interrupted') {
      if (dreamTurn) abortDream(agent, resolved.projectDir, signalDreamState)
      return
    }
    if (dreamTurn) {
      advanceDream(agent, resolved.projectDir, signalDreamState, resolved.dream.rulesReviewDays) // dream 轮：推进下一组或收尾（含孤儿收尾）
      return
    }

    if (!resolved.reflect) return
    const ws = workspaceOfAgent(agent)
    if (!ws) return
    const { sawToolCall, lastToolName, sawReflect, turnText } = scanTurn(agent.session.events)
    if (sawReflect) return // 本 turn 已反思过（含反思轮自身结束）
    if (!sawToolCall) return // 纯聊天轮，不反思
    if (lastToolName !== undefined && lastToolName.startsWith('memory_')) return // 已主动记忆
    if (consecutiveToolSteps(agent.session.events) < resolved.reflectTurns) return // 单任务内连续工具 step 不足
    const message = buildReflectMessage(ws, turnText, resolved.projectDir)
    agent.steer(message)
    if (Date.now() - t0 > 20) perf(`turn-stopping slow ${Date.now() - t0}ms`)
    ctx.logger.info(`meow-memory: reflect steered after ${resolved.reflectTurns}+ tool turns`)
  })

  // 3) 空闲整理（按窗口；windowIndex 记录 sessionId → workspace）。
  const stopDream = scheduleDream(ctx, resolved.dream, resolved.projectDir, windowIndex, signalDreamState)
  ctx.logger.info(
    `meow-memory: dream scheduled (idle ${resolved.dream.idleMinutes}m, suppress ${resolved.dream.suppressWindows.map((w) => `${w.start}-${w.end}`).join(' ')} lead ${resolved.dream.suppressLeadMinutes}m, every ${resolved.dream.checkMinutes}m, tz ${resolved.dream.timeZone}, rules review ${resolved.dream.rulesReviewDays}d)`,
  )

  // 4) 会话列表"已 dream"图标数据面（仿 meow-eyes describe 路由，webServer 可选服务）：
  //    - GET /meow-memory/dreamed-sessions：全量快照（client 挂载/重连时拉一次）；
  //    - GET /meow-memory/dream-events：SSE 长连接，dream 完成/新活动时推送增量信号（事件驱动，无轮询）。
  // webServer 服务可能晚于本插件就绪（fiber 并发启动竞态——实测 3080 重启后 apply 时
  // webServer 未注册 → 路由缺失、SPA fallback 接管；热重载时代服务早已就绪无此问题）。
  // 修复：立即尝试；未就绪则每 1s 重试（最多 20 次）；dispose 时清理定时器。
  // 注册挂 ctx.effect：fiber dispose 时自动注销（super-injector 热重载契约——裸注册在
  // 热重载时残留路由 → 下次 apply duplicate 报错）。
  const routeDisposers: Array<() => void> = []
  let routeTimer = 0
  const tryRegisterDreamRoutes = (attempt: number): void => {
    const ws = (ctx as { get?: (name: string) => unknown }).get?.('webServer') as
      | { register?: (route: { kind: 'exact'; path: string; handler: (req: unknown, res: unknown) => void }) => () => void }
      | undefined
    if (ws !== undefined && typeof ws.register === 'function') {
      const registerOne = (route: { kind: 'exact'; path: string; handler: (req: unknown, res: unknown) => void }): void => {
        try {
          routeDisposers.push(ctx.effect(() => ws.register(route)))
        } catch (e) {
          ctx.logger.warn(`meow-memory: route ${route.path} 注册失败: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      registerOne({
        kind: 'exact',
        path: '/meow-memory/dreamed-sessions',
        handler: (_req, res) => {
          void (async () => {
            try {
              const sessionPersistence = (ctx as { get?: (name: string) => unknown }).get?.('sessionPersistence') as
                | { list?: () => Promise<Array<{ id: string; cwd?: string }>> }
                | undefined
              const sessions = typeof sessionPersistence?.list === 'function' ? await sessionPersistence.list() : []
              const states = collectDreamStates(sessions, resolved.projectDir)
              writeJson(res, 200, { sessionIds: states.dreamed, dreamingIds: states.dreaming })
            } catch (e) {
              writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
          })()
        },
      })
      registerOne({
        kind: 'exact',
        path: '/meow-memory/dream-events',
        handler: (req, res) => broadcast.handle(req as never, res as never),
      })
      // 跳过自动 dream（v0.16.0，侧边栏会话菜单 toggle 的数据面）：
      //    - GET  /meow-memory/skip-dreams → { sessionIds }（全部已知工作区合并去重）；
      //    - POST /meow-memory/skip-dreams { sessionId, skip } → { ok, skipped }，
      //      写库后经既有 SSE 通道推 skip/unskip（同实例多标签页即时同步；
      //      跨实例浏览器标签靠重连对账补齐——与 dream 图标同一限制）。
      registerOne({
        kind: 'exact',
        path: '/meow-memory/skip-dreams',
        handler: (req, res) => {
          void (async () => {
            try {
              if ((req as { method?: string }).method === 'POST') {
                const body = await readJsonBody(req) as { sessionId?: unknown; skip?: unknown }
                const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
                const skip = body.skip === true
                if (sessionId.length === 0) return writeJson(res, 400, { ok: false, error: 'sessionId required' })
                const ws = await resolveWorkspaceForSession(ctx, sessionId)
                if (ws === null) return writeJson(res, 404, { ok: false, error: 'unknown session (no workspace)' })
                getDb(ws, resolved.projectDir).setDreamSkip(sessionId, skip)
                broadcast.broadcast(sessionId, skip ? 'skip' : 'unskip')
                ctx.logger.info(`meow-memory: dream skip ${skip ? 'on' : 'off'} for ${shortSessionId(sessionId)}`)
                return writeJson(res, 200, { ok: true, skipped: skip })
              }
              const workspaces = new Set<string>()
              for (const [, w] of windowIndex) {
                if (typeof w === 'string' && w.length > 0) workspaces.add(w)
              }
              const ids = new Set<string>()
              for (const w of workspaces) {
                if (!existsSync(memoryDbPath(w, resolved.projectDir))) continue // 无记忆库不新建（collectDreamStates 同款）
                try {
                  for (const id of getDb(w, resolved.projectDir).listDreamSkips()) ids.add(id)
                } catch {
                  /* 单工作区库损坏：跳过 */
                }
              }
              writeJson(res, 200, { sessionIds: [...ids] })
            } catch (e) {
              writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
          })()
        },
      })
      ctx.logger.info('meow-memory: dreamed-sessions snapshot + dream-events SSE + skip-dreams routes registered')
      return
    }
    if (attempt < 20) {
      routeTimer = setTimeout(() => tryRegisterDreamRoutes(attempt + 1), 1000) as unknown as number
    } else {
      ctx.logger.warn('meow-memory: webServer 服务 20s 内未就绪，会话列表 dream 图标数据路由未注册')
    }
  }
  tryRegisterDreamRoutes(0)

  // 5) 用户命令 /dream（dsh 命令平面，可选服务）：输入框敲 /dream 手动唤起本窗口
  //    dream，斜杠菜单经 commands.list 自动列出（零客户端改动）。commands 服务可能
  //    晚于本插件就绪（fiber 并发启动竞态，同 webServer 路由）→ 立即尝试 + 每 1s
  //    重试（最多 20 次）；注册挂 ctx.effect：热重载/dispose 自动注销（裸注册在
  //    热重载时残留 → 下次 apply duplicate 报错）。
  const commandDisposers: Array<() => void> = []
  let commandTimer = 0
  const tryRegisterDreamCommand = (attempt: number): void => {
    const commands = (ctx as { get?: (name: string) => unknown }).get?.('commands') as
      | { register?: (definition: unknown) => unknown }
      | undefined
    if (commands !== undefined && typeof commands.register === 'function') {
      try {
        commandDisposers.push(ctx.effect(() => commands.register(dreamCommandDefinition(ctx, resolved.projectDir, signalDreamState, resolved.dream.rulesReviewDays))))
        ctx.logger.info('meow-memory: /dream user command registered')
      } catch (e) {
        ctx.logger.warn(`meow-memory: /dream 命令注册失败: ${e instanceof Error ? e.message : String(e)}`)
      }
      return
    }
    if (attempt < 20) {
      commandTimer = setTimeout(() => tryRegisterDreamCommand(attempt + 1), 1000) as unknown as number
    } else {
      ctx.logger.warn('meow-memory: commands 服务 20s 内未就绪，/dream 用户命令未注册（memory_dream 工具不受影响）')
    }
  }
  tryRegisterDreamCommand(0)

  ctx.on('dispose', () => {
    for (const dispose of toolDisposers) {
      try {
        dispose()
      } catch {
        /* 注销失败不阻塞 */
      }
    }
    for (const dispose of routeDisposers) {
      try {
        dispose()
      } catch {
        /* 注销失败不阻塞 */
      }
    }
    for (const dispose of commandDisposers) {
      try {
        dispose()
      } catch {
        /* 注销失败不阻塞 */
      }
    }
    clearTimeout(routeTimer)
    clearTimeout(commandTimer)
    stopDream()
    broadcast.dispose()
    try {
      closeAllDbs()
    } catch {
      /* 关库失败不阻塞清理链 */
    }
  })
}

/** 统一 JSON 响应（路由用）。 */
function writeJson(res: unknown, status: number, body: unknown): void {
  try {
    const r = res as { writeHead?: (code: number, headers: Record<string, string>) => void; end?: (chunk?: string) => void }
    r.writeHead?.(status, { 'content-type': 'application/json' })
    r.end?.(JSON.stringify(body))
  } catch {
    /* 响应失败不抛 */
  }
}

/** 读 POST JSON body（64KB 上限；空 body = {}）。 */
function readJsonBody(req: unknown, maxBytes = 65_536): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const r = req as { on?: (ev: string, cb: (chunk?: unknown) => void) => void }
    const chunks: Buffer[] = []
    let size = 0
    r.on?.('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buf.length
      if (size > maxBytes) {
        reject(new Error('request body too large'))
        return
      }
      chunks.push(buf)
    })
    r.on?.('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    r.on?.('error', (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))))
  })
}

/**
 * 解析会话 → 工作区：先查 windowIndex（模块级 sid→cwd 索引，apply 时已从
 * 文件+windows 表恢复）；查不到再用 sessionPersistence.list() 按 cwd 兜底
 * （覆盖从未产生过事件的全新会话），命中顺手回填索引。
 * 都找不到返回 null（该会话不属于任何已知工作区，无法定位其记忆库）。
 */
async function resolveWorkspaceForSession(ctx: Context, sessionId: string): Promise<string | null> {
  const direct = windowIndex.get(sessionId)
  if (typeof direct === 'string' && direct.length > 0) return direct
  try {
    const sp = (ctx as { get?: (name: string) => unknown }).get?.('sessionPersistence') as
      | { list?: () => Promise<Array<{ id: string; cwd?: string }>> }
      | undefined
    const sessions = typeof sp?.list === 'function' ? await sp.list() : []
    const hit = sessions.find((s) => s.id === sessionId)
    if (hit && typeof hit.cwd === 'string' && hit.cwd.length > 0) {
      windowIndex.set(sessionId, hit.cwd)
      persistWindowIndex()
      return hit.cwd
    }
  } catch {
    /* sessionPersistence 不可用 */
  }
  return null
}

// ── 模块级窗口索引（sessionId → workspace） ────────────────────────────────
// 持久化到 homedir/.dsh-meow/window-index.json：热重载/重启会重置模块级 Map，
// 若不恢复则旧窗口（reload 后无新事件）从 dream 检查中失联——有记忆也不 dream。
// 恢复后 agent 经 ctx.agents（AgentRegistry，harness 进程级）获取，不受插件 reload 影响。

const windowIndex = new Map<string, string>()
const WINDOW_INDEX_FILE = join(homedir(), '.dsh-meow', 'window-index.json')

/** apply 时恢复窗口索引：①文件（上次落盘）→ workspace 集合；②每个已知 workspace
 *  的 windows 表（DB 持久化，含 reload 前全部窗口）补全——旧窗口（reload 后无新
 *  事件、文件里没有）也能恢复，不会从 dream 检查中失联。 */
function loadWindowIndex(dir = '.dsh-meow'): void {
  const workspaces = new Set<string>()
  try {
    const merged = JSON.parse(readFileSync(WINDOW_INDEX_FILE, 'utf8')) as Record<string, unknown>
    for (const [sid, ws] of Object.entries(merged)) {
      if (typeof ws === 'string' && ws.length > 0) {
        windowIndex.set(sid, ws)
        workspaces.add(ws)
      }
    }
  } catch {
    /* 无文件/损坏 */
  }
  for (const ws of workspaces) {
    try {
      for (const w of getDb(ws, dir).listWindows()) {
        if (typeof w.workspace === 'string' && w.workspace.length > 0) windowIndex.set(w.session_id, w.workspace)
      }
    } catch {
      /* 该 workspace 库不可用：跳过 */
    }
  }
}

/** 窗口索引落盘（读-合并-写，低频事件驱动；失败不阻塞）。 */
function persistWindowIndex(): void {
  try {
    mkdirSync(dirname(WINDOW_INDEX_FILE), { recursive: true })
    let merged: Record<string, string> = {}
    try {
      merged = JSON.parse(readFileSync(WINDOW_INDEX_FILE, 'utf8')) as Record<string, string>
    } catch {
      /* 首次写入 */
    }
    for (const [sid, ws] of windowIndex) merged[sid] = ws
    writeFileSync(WINDOW_INDEX_FILE, JSON.stringify(merged), 'utf8')
  } catch {
    /* 持久化失败不阻塞 */
  }
}

// re-export 供测试/调试/其他插件
export { PLUGIN_SOURCE, REFLECT_MARKER }
export { collectDreamStates } from './dream-signal.js'
export { MemoryDb, memoryDbPath, getDb, closeAllDbs, LEVELS, newId, PROJECT_SUBCATEGORIES, projectList, projectCovers, projectLabel, relativeTime, isGlobalProject, globalProjectMarker, GLOBAL_PROJECT_CANON } from './db.js'
export { migrateLegacy } from './migrate.js'
export { buildHitInjection, buildInjection, buildReinjection, buildProjectSectionText, readSeen, markSearched, markAccessed, readInjected, markInjected, markProjectQueried, readProjectQueried, markReinjectPending, clearReinjectPending, isReinjectPending, MAX_REINJECT_PROJECTS, sessionsFile, getCurrentProject, setCurrentProject, releaseSeen } from './inject.js'
export { buildReflectMessage, consecutiveToolSteps, scanTurn } from './reflect.js'
export { tokenize, stemEn, search, findSimilar, topicDrift, recencyWeight } from './bm25.js'
export { fillTemplate, keyedValue, resolveSlotText, setPromptLang, getPromptLang, DEFAULT_LANG, SLOTS } from './prompt-loader.js'
export { collectDreamRounds, buildDreamMessage, windowNeedsDream, DREAM_MARKER, noteActivity, hourInTimeZone, minutesInTimeZone, isDreamSuppressed, startWindowDream, advanceDream, abortDream, recoverInterruptedDream, dreamCommandDefinition } from './dream.js'
