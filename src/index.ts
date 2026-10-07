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
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { closeAllDbs, getDb, memoryDbPath } from './db.js'
import { parseModelSpec, REFLECT_DELEGATE_MARKER, REFLECT_DONE_DELEGATE_MARKER, DREAM_DELEGATE_MARKER, type AgentOptionsSpec } from './delegate.js'
import { CONFIG_DEFAULTS } from './defaults.js'
import { activeHomeDir, homeDirPresets, resolveHomeDir, switchHomeDir } from './home-dir.js'
import { ensureV0SessionsMigrated } from './migrate-v0.js'

import {
  abortDream,
  advanceDream,
  DEFAULT_RULES_REVIEW_DAYS,
  DREAM_MARKER,
  dreamCommandDefinition,
  dreamTool,
  disposeDreamHeartbeats,
  handleMemoryTurnFailure,
  noteActivity,
  registerLiveAgent,
  scheduleDream,
  sendMemoryTurn,
  shortSessionId,
  type DreamConfig,
} from './dream.js'
import { buildHitInjection, buildInjection, buildReinjection, clearReinjectPending, isReinjectPending, markAccessed, markReinjectPending, markSearched, readProjectQueried, readSeen, readInjected, releaseSeen } from './inject.js'
import { migrateLegacy } from './migrate.js'
import { buildReflectMessage, consecutiveToolSteps, PLUGIN_SOURCE, REFLECT_MARKER, scanTurn } from './reflect.js'
import { isMeowSource } from './source.js'
import { registerMemoryTools } from './tools.js'
import { resolveSlotText, setPromptLang } from './prompt-loader.js'

/** 首次欢迎引导的 seen 记账 id（accessed 通道，非真实记忆 id；releaseSeen 不清除）。 */
const WELCOME_GUIDE_SEEN_ID = '__welcomeGuide__'
import { collectDreamStates, headerOf, DreamStateBroadcast, type PersistedSessionLike } from './dream-signal.js'

export const name = 'meow-memory'
export const inject = ['tools']

/** 记忆来源机器元数据，供前端与下游消费，解耦于自然语言文本。 */
export interface MemorySourceMeta {
  kind: 'initial' | 'hit' | 'reinjection' | 'welcome'
  ids?: string[]
}

/** v0 会话格式兼容：MemorySourceMeta 编码为 sections 的保留节 __meta__。 */
const META_SECTION_NAME = '__meta__'

function encodeMetaSection(meta: MemorySourceMeta): { name: string; text: string } {
  return { name: META_SECTION_NAME, text: JSON.stringify(meta) }
}

/** 把动态记忆作为独立上下文消息交给模型，不改写人类 user 消息。 */
function createMemorySnapshotMessage(text: string, meta: MemorySourceMeta): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      ...PLUGIN_SOURCE,
      form: 'snapshot',
      sections: [encodeMetaSection(meta), { name: '长期记忆', text }],
    },
  })
}

/** 构造独立的插件通知消息（如首次语言引导），不改写人类 user 消息。
 *  notice form 按 dsh-llm ContextFormed 契约带 summary（折叠行一行摘要，≤120 字符）；
 *  不复用 source.memory 顶层字段（v0.24- 遗留形态，新消息只用 ContextFormed 声明的键），
 *  welcome 类一次性通知的元数据本就无消费者。 */
function createMemoryNoticeMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      ...PLUGIN_SOURCE,
      form: 'notice',
      summary: boundContextSummary(text.replace(/\s+/g, ' ').trim()),
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

// ── 性能诊断（perf.log，全局目录 activeHomeDir()；卡死时查数据） ─────────────
// 模块级计数器：模块只初始化一次；apply 每次执行 +1——若日志里 apply 编号异常
// 跳跃/重复，说明 apply 被多次调用（handler 叠加）。事件计数看事件吞吐。
let applyCount = 0
let evtCount = 0
let perfBoot = Date.now()
let lastPerfLog = Date.now()
function perf(msg: string): void {
  try {
    const file = join(activeHomeDir(), 'perf.log') // 动态取：全局目录热切换后下一笔即落新目录
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`)
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

// ── 主目录日志清扫（48h 保留 + perf.log 大小轮转；用户拍板 2026-09-24） ──────
// 白名单精确点名，绝不 glob 目录——~/.dsh-meow 下还住着 window-index.json、
// migrate-v0-state.json(.bak)、prompts/ 等非日志住户。判定用文件 mtime（append
// 天然维护，恒等于最后一行的时刻，零解析）；双实例共享本目录时，活跃实例持续
// 刷新 mtime，天然防误删活日志。单文件失败（占用/权限）静默跳过，下次启动再试。
const LOG_RETENTION_MS = 48 * 60 * 60 * 1000
const PERF_LOG_ROTATE_BYTES = 5 * 1024 * 1024
const HOME_LOGS = ['perf.log', 'perf.log.old', 'settings-register-error.log', 'apply-error.log']

/** 启动清扫：白名单日志距上次写入超 48h 的删除；perf.log 超 5MB 轮转成 .old
 *  （覆盖上一代，历史保一代）。只在 apply（启动/热重载）时跑——废弃日志只有
 *  进程都停了才会变老，下次启动清扫即完备；disabled 时不跑。dir/now 参数化供
 *  测试隔离（测试绝不触真实全局目录）。返回值交调用方落 perf，自身零副作用日志。 */
export function sweepHomeLogs(dir = activeHomeDir(), now = Date.now()): { swept: string[]; rotated: boolean } {
  const swept: string[] = []
  const cutoff = now - LOG_RETENTION_MS
  for (const name of HOME_LOGS) {
    if (!name.endsWith('.log')) continue // 防御断言：名单误配也只可能是 .log
    try {
      const file = join(dir, name)
      if (statSync(file).mtimeMs < cutoff) {
        unlinkSync(file)
        swept.push(name)
      }
    } catch {
      /* 不存在/占用/权限：跳过 */
    }
  }
  let rotated = false
  try {
    const cur = join(dir, 'perf.log')
    if (statSync(cur).size > PERF_LOG_ROTATE_BYTES) {
      renameSync(cur, join(dir, 'perf.log.old')) // 覆盖上一代（MOVEFILE_REPLACE_EXISTING）
      rotated = true
    }
  } catch {
    /* 不存在（刚被 48h 清掉）/被另一实例占用：跳过，下次启动再轮转 */
  }
  return { swept, rotated }
}

/** homeDirPresets 的启动期快照（模块加载时取一次；异常回空表——meta 缺席只损失
 *  设置页 radio 旁的预设路径显示，绝不弄崩插件加载）。 */
function homeDirPresetsDefault(): Record<string, string> {
  try {
    return homeDirPresets()
  } catch {
    return {}
  }
}

const config = z.object({
  /** 总开关：false 时注入、反思、工具全部停用。 */
  enabled: z.boolean().default(true),
  /** 记忆目录（相对工作区）。 */
  projectDir: z.string().default('.dsh-meow'),
  /** 全局目录（实例级数据家：日志/window-index/prompts 覆盖层/migrate 状态）。
   *  'default'=平台用户主目录 | 'dsh-storage'=<DSH home>/storages/meow-memory |
   *  'plugin-root'=<插件根>/storage | 绝对路径=自定义。''/缺省=默认。
   *  变更即自动迁移旧目录内容（同盘移动/跨盘复制，旧目录绝不自动删）。 */
  homeDir: z.string().required(false),
  /** homeDirPresets（只读 meta，非配置）：三个全局目录预设的实际落点，设置页
   *  radio 旁显示。0.1.7 的 base 视图 = 宿主 resolveConfig(inherited) 后按 schema
   *  键投影——不在 schema 声明的键宿主永远剥掉，cordis.patch.yml 通道也走不通
   * （patch config 会撞设置写入的全等比对死锁，2026-09-25 实证），所以只能住进
   *  schema 默认值，由官方深填机带进 base/value 两视图。默认值在 schema 构建时
   *  取一次：预设落点因机器/安装位置而异、进程内不变（热切换只改 active，不改
   *  预设定义）。不进 CONFIG_DEFAULTS——「恢复默认」绝不能把它当字段写进 user 层；
   *  它也不是设置页 FieldSpec，页面与 resolveConfig 都不读它。 */
  homeDirPresets: z.dict(z.string()).default(homeDirPresetsDefault()),
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
  /** 整理任务的模型（可选换模型）。反思/梦境永远在主窗口执行（steer）——配置了
   *  model 时仅在这两类轮的请求上经 agent/request waterfall 覆盖 provider/model，
   *  轮次结束自动换回主模型；不再提供"独立执行"开关（v0.24 移除）。 */
  delegate: z
    .object({
      /** 反思/梦境轮换用模型：留空 = 全程主模型；'provider/model'（dsh route 格式）
       *  指定 provider+model，'model' 只换 model（provider 继承主会话）。 */
      model: z.string().required(false),
    })
    .default({}),
})

// 0.1.7 设置服务只收录 meta.volatile 的 Config（dsh-settings volatileForm 根检查）：
// 不标记则「喵记忆」标签页永远 unavailable（提示文案会误导性地怪回环连接）。仓内
// schemastery@3.18.1 的解析不含 volatile 逻辑——meta 只是宿主侧标记，config 值保持
// 裸形状（官方新版 .volatile() 会把值包成 .get() 引用），消费端零改动；升级依赖须重验。
Object.assign(config.meta, { volatile: true })

export { config as Config }

// ── 设置页（喵记忆标签页）的数据底座 ──────────────────────────────────────────
//
// installSettingsSection(ctx, SETTINGS_NS, ...) 在 applyInner 最前面调用；标签页
// （client/settings-page.ts）经 settingsScope.bind({namespace}) 读写 user 层，
// applyInner 解析配置时把 user 层字段级合并进 patch config（用户改过的字段以
// 设置页为准）。生效时机=config 在 apply 时解析 → 设置页保存后需热重载/重启插件。

export const SETTINGS_NS = 'meow-memory'

/** 出厂默认值定义已抽到 defaults.ts（host/client 共用，理由见该文件头注释）；
 *  设置页 base（预填层）=出厂默认 + patch 基线，promptLang 刻意缺席=未设置语义。 */
export { CONFIG_DEFAULTS, factoryDefaultOf } from './defaults.js'

/** 单个时间点（suppressWindows 的 start/end）。 */
const TIME_OF_DAY_RE = /^\d{1,2}:\d{2}$/

/**
 * 设置页 user 层的字段级类型校验（RPC 写入走这里，编不过拒写）。
 * 手编 settings.yaml 不经此路径，由 merge 后 resolveConfig 的兜底解析防御。
 */
export function validateConfigUserLayer(value: unknown): void {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('配置必须是对象')
  }
  const v = value as Record<string, unknown>
  const reqBool = (k: string): void => {
    if (v[k] !== undefined && typeof v[k] !== 'boolean') throw new Error(`${k} 必须是布尔`)
  }
  const reqStr = (k: string): void => {
    if (v[k] !== undefined && typeof v[k] !== 'string') throw new Error(`${k} 必须是字符串`)
  }
  const reqNum = (k: string): void => {
    if (v[k] === undefined) return
    if (typeof v[k] !== 'number' || !Number.isFinite(v[k] as number)) throw new Error(`${k} 必须是数字`)
  }
  reqBool('enabled')
  reqStr('projectDir')
  reqStr('homeDir')
  reqNum('hitTopK')
  reqNum('titleMax')
  reqBool('reflect')
  reqNum('reflectTurns')
  reqBool('autoMigrate')
  reqStr('promptLang')
  const d = v.dream
  if (d !== undefined) {
    if (d === null || typeof d !== 'object' || Array.isArray(d)) throw new Error('dream 必须是对象')
    const dd = d as Record<string, unknown>
    if (dd.enabled !== undefined && typeof dd.enabled !== 'boolean') throw new Error('dream.enabled 必须是布尔')
    reqNum('dream.idleMinutes') // 顶层校验器只认顶层键，dream 子键在此手查
    if (dd.idleMinutes !== undefined && (typeof dd.idleMinutes !== 'number' || !Number.isFinite(dd.idleMinutes))) throw new Error('dream.idleMinutes 必须是数字')
    for (const k of ['suppressLeadMinutes', 'checkMinutes', 'rulesReviewDays'] as const) {
      if (dd[k] !== undefined && (typeof dd[k] !== 'number' || !Number.isFinite(dd[k]))) throw new Error(`dream.${k} 必须是数字`)
    }
    if (dd.timeZone !== undefined && typeof dd.timeZone !== 'string') throw new Error('dream.timeZone 必须是字符串')
    if (dd.suppressWindows !== undefined) {
      if (!Array.isArray(dd.suppressWindows)) throw new Error('dream.suppressWindows 必须是数组')
      for (const w of dd.suppressWindows as unknown[]) {
        const win = w as { start?: unknown; end?: unknown }
        if (typeof win !== 'object' || win === null || typeof win.start !== 'string' || typeof win.end !== 'string' || !TIME_OF_DAY_RE.test(win.start) || !TIME_OF_DAY_RE.test(win.end)) {
          throw new Error('dream.suppressWindows 每项必须是 { start: "HH:MM", end: "HH:MM" }')
        }
      }
    }
  }
  const dg = v.delegate
  if (dg !== undefined) {
    if (dg === null || typeof dg !== 'object' || Array.isArray(dg)) throw new Error('delegate 必须是对象')
    const ddg = dg as Record<string, unknown>
    // v0.24 移除 delegate.reflect/dream（独立执行不再可选）；历史 settings.yaml
    // user 层里残留的这两个键只忽略不报错（手编配置宽容，读取方不再消费）。
    if (ddg.model !== undefined && typeof ddg.model !== 'string') throw new Error('delegate.model 必须是字符串')
  }
}

/**
 * 设置页 user 层字段级覆盖 patch config（装配配置=基线）。
 * dream/delegate 子对象做浅合并：用户只改一个子字段不丢 patch 里的其余键。
 */
export function mergeConfigLayer(patch: unknown, user: Record<string, unknown> | undefined): unknown {
  // user === null：YAML 里写成空段（`meow-memory:` 后面没内容）会解析成 null，而
  // typeof null === 'object' 会漏过下面这行，随后 Object.entries(null) 抛 TypeError
  // 直接崩掉 applyInner（插件整块不启动）。防御式直通 patch 层。
  if (user === undefined || user === null || typeof user !== 'object') return patch
  const base = (typeof patch === 'object' && patch !== null ? { ...(patch as Record<string, unknown>) } : {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(user)) {
    if (key === 'dream' || key === 'delegate') {
      // 子对象浅合并：用户只改一个子字段不丢 patch 里的其余键
      const pv = (base[key] ?? {}) as Record<string, unknown>
      const uv = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
      base[key] = { ...pv, ...uv }
    } else {
      base[key] = value
    }
  }
  return base
}

interface ResolvedConfig {
  enabled: boolean
  projectDir: string
  /** 原样透传（'default'|'dsh-storage'|'plugin-root'|绝对路径|undefined）；绝对路径化在 resolveHomeDir。 */
  homeDir: string | undefined
  hitTopK: number
  titleMax: number
  reflect: boolean
  reflectTurns: number
  autoMigrate: boolean
  /** undefined = 用户未配置（首次设置引导的触发信号）；运行时语言兜底 zh。 */
  promptLang: string | undefined
  dream: DreamConfig
  delegate: { modelSpec: AgentOptionsSpec | undefined }
}

function resolveConfig(config: unknown): ResolvedConfig {
  const c = (config ?? {}) as Partial<ResolvedConfig>
  const d = (c.dream ?? {}) as Partial<DreamConfig>
  const dg = (c.delegate ?? {}) as { reflect?: boolean; model?: string }
  return {
    enabled: c.enabled ?? true,
    projectDir: c.projectDir ?? '.dsh-meow',
    homeDir: typeof c.homeDir === 'string' ? c.homeDir : undefined,
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
    delegate: (() => {
      // 反思/梦境永远 steer（主窗口执行，v0.24 拍板）；modelSpec 仅供 agent/request
      // waterfall 在插件轮请求上覆盖模型（轮次结束自动换回主模型）。
      return { modelSpec: parseModelSpec(dg.model) }
    })(),
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

/**
 * 双版本会话事件读取：dsh 0.1.2-alpha.4 重构移除 Session.events 属性，
 * 改为 ownEvents() 方法（返回剔除 fork 继承前缀的本会话事件，与旧版
 * events 语义等价）；旧版仍是数组属性。探测函数形态优先，回退属性，
 * 两者都缺返回空数组（fail-closed：绝不抛 events is not iterable）。
 */
export function sessionEventsOf(session: { events?: readonly unknown[]; ownEvents?: () => readonly unknown[] } | undefined | null): readonly unknown[] {
  if (typeof session?.ownEvents === 'function') {
    const evs = session.ownEvents()
    return Array.isArray(evs) ? evs : []
  }
  const evs = session?.events
  return Array.isArray(evs) ? evs : []
}

/** 本 turn 是否为 dream 轮（事件流里存在 meow-memory 的 dream 指令消息）。 */
function wasDreamTurn(events: readonly unknown[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { source?: { kind?: string; plugin?: string }; content?: Array<{ type?: string; text?: string }> } }
    if (e?.type === 'turn/start') break
    if (e?.type === 'user/message' && isMeowSource(e.data?.source)) {
      if ((e.data.content ?? []).some((b) => b.type === 'text' && b.text?.includes(DREAM_MARKER))) return true
    }
  }
  return false
}

/**
 * 当前 turn 是否为 meow-memory 的反思/梦境轮（换模型覆盖判定，agent/request 用）。
 * 判定口径与事件链的插件消息识别一致：最后一个 turn/start 之后的 user/message 帧，
 * source.kind !== 'user'（用户亲手发的消息绝不判 marker，防引用标记文本误伤）且
 * 文本含 [meow-memory-reflect] / [meow-memory-dream]。steer 指令消息在请求发出前
 * 已落 log（agent-loop：pre-step decision → append user/message → step/buildRequest），
 * 因此请求时判定读到的数据完备；轮次结束不再 steer，下个 turn 无 marker → 自动
 * 换回主模型，无需任何状态清理。
 */
export function isMemoryTaskTurn(events: readonly unknown[]): boolean {
  let startIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if ((events[i] as { type?: string })?.type === 'turn/start') {
      startIdx = i
      break
    }
  }
  if (startIdx < 0) return false
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i] as { type?: string; data?: { source?: { kind?: string }; content?: Array<{ type?: string; text?: string }> } }
    if (e?.type !== 'user/message') continue
    if (e.data?.source?.kind === 'user') continue
    const text = (e.data?.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text ?? '')
      .join(' ')
    if (text.includes(REFLECT_MARKER) || text.includes(DREAM_MARKER)) return true
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
      const errFile = join(activeHomeDir(), 'apply-error.log')
      mkdirSync(dirname(errFile), { recursive: true })
      appendFileSync(errFile, `[${new Date().toISOString()}] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
    } catch {
      /* 日志失败忽略 */
    }
    throw e
  }
}

/** dsh-settings 服务最小形态（新旧两版公共面并集）。 */
interface SettingsScopeLike {
  get: () => unknown
  watch: (cb: () => void) => unknown
}
interface SettingsServiceLike {
  /** dsh 0.1.3+ 服务方法；0.1.2 及以下不存在。 */
  installSection?: (owner: Context, ns: string, schema: unknown, entry: unknown, hooks: Record<string, unknown>) => void
  /** 两版都有：底层命名空间注册（旧 installSettingsSection 内部即调它）。 */
  register?: (ns: string, schema: unknown, options: { base: unknown; validate?: (value: unknown) => void }) => SettingsScopeLike
}

/**
 * 双版本设置区注册：dsh 0.1.2 及以下旧版把 installSettingsSection 作为
 * dsh-settings 的自由函数提供（0.1.5 起已移除，故本插件不能静态 import 它——
 * ESM 缺导出会在模块加载期直接报错）。按「settings 服务是否暴露 installSection
 * 方法」分流，它正好是两版的能力分界：0.1.3+ 有 installSection（走新 API）；
 * 0.1.2 及以下没有（回退，复刻旧 installSettingsSection 的 register 行为）。
 */
function installSettingsSectionCompat(
  settingsCtx: unknown,
  ownerCtx: Context,
  ns: string,
  schema: unknown,
  entry: unknown,
  hooks: {
    validate?: (value: unknown) => void
    setSource: (get: () => unknown) => void
    onChange: () => void
  },
): void {
  const sctx = settingsCtx as {
    settings: SettingsServiceLike
    effect: (fn: () => () => void) => unknown
  }
  const settings = sctx.settings

  // 新版（dsh 0.1.3+）：官方服务方法 installSection。
  if (typeof settings.installSection === 'function') {
    settings.installSection(ownerCtx, ns, schema, entry, hooks as unknown as Record<string, unknown>)
    return
  }

  // 旧版（dsh 0.1.2 及以下）：复刻 installSettingsSection 的 register + effect + watch。
  const register = settings.register
  if (typeof register !== 'function') {
    // 0.1.7+：SettingsForms 已删 installSection/register，设置页由 Config schema 的
    // describe 自动表单渲染，值读写走上方 describe/write 兼容腿——本函数无可注册项，
    // 静默跳过。其余未知宿主：设置页本就不可用，warn 留痕（与注册失败 catch 路径同
    // 口径）。原实现在此 throw，但它落在 inject 回调里、外层 catch 接不住，只会每轮
    // 装配刷一条误导性 error（issue #34：功能其实全部正常），故一律不再抛。
    const proto = Object.getPrototypeOf(settings) as { describe?: unknown } | null
    if (proto !== null && typeof proto.describe === 'function') return
    ownerCtx.logger.warn('meow-memory: settings 服务无 installSection/register（非 0.1.7+ 形态），跳过设置区注册（配置走 patch 层）')
    return
  }
  const scope = register.call(settings, ns, schema, {
    base: entry,
    ...(hooks.validate === undefined ? {} : { validate: hooks.validate }),
  })
  hooks.setSource(() => scope.get())
  sctx.effect(() => () => {
    // fiber 收尾中（值镜像 cordis FiberState：4=DISPOSED / 5=UNLOADING）不再回填。
    const state = (ownerCtx as unknown as { fiber?: { state?: number } }).fiber?.state
    if (state === 4 || state === 5) return
    hooks.setSource(() => entry)
    hooks.onChange()
  })
  hooks.onChange()
  scope.watch(() => {
    const state = (ownerCtx as unknown as { fiber?: { state?: number } }).fiber?.state
    if (state === 4 || state === 5) return
    hooks.onChange()
  })
}

/** 等设置源就绪的上限（issue #21）。真机上 inject 回调最快一个微任务就会跑，
 *  这里给足余量；仅当 settings 服务异常/注册回调始终不回填时才真的等满。 */
const SETTINGS_SOURCE_WAIT_MS = 250

/** 全局目录切换结果落日志（apply 与设置页 onChange 共用口径；跨盘复制带多实例提醒）。 */
function logHomeDirSwitch(ctx: Context, sw: ReturnType<typeof switchHomeDir>): void {
  if (sw.mode === 'copy') {
    ctx.logger.warn(`meow-memory: 全局目录已切换为 ${sw.to}（自 ${sw.from} 复制 ${sw.files} 项）。旧目录保留未删，确认无误后可手动删除；若多个 dsh 实例共享旧目录，请同步修改其他实例的设置`)
  } else if (sw.migrated) {
    ctx.logger.info(`meow-memory: 全局目录已切换为 ${sw.to}（自 ${sw.from} 移动 ${sw.files} 项）`)
  } else if (sw.changed) {
    ctx.logger.info(`meow-memory: 全局目录切换为 ${sw.to}（目标已有内容，直接启用未覆盖）`)
  } else if (sw.mode === 'failed') {
    ctx.logger.warn(`meow-memory: 全局目录切换失败（${sw.error}），继续使用 ${sw.from}`)
  }
}

/** 设置页保存后的全局目录热切换（fire-and-forget，用户拍板 2026-09-24）：搬移可能
 *  跨盘复制（秒级），异步执行不阻塞保存链路；窗口期日志仍落旧目录（毫秒级），无碍。
 *  搬完把新目录的 window-index 账本 merge 进内存。切换失败只留日志，绝不影响保存。 */
function hotSwitchHomeDir(ctx: Context, config: unknown, get: (() => unknown) | undefined): void {
  try {
    const merged = mergeConfigLayer(config, get?.() as Record<string, unknown> | undefined)
    const resolved = resolveConfig(merged)
    const target = resolveHomeDir(resolved.homeDir)
    if (target === activeHomeDir()) return
    void Promise.resolve().then(() => {
      try {
        const sw = switchHomeDir(target)
        logHomeDirSwitch(ctx, sw)
        if (sw.changed) loadWindowIndex(resolved.projectDir ?? '.dsh-meow')
      } catch {
        /* 热切换失败不影响配置保存 */
      }
    })
  } catch {
    /* 解析失败不打扰保存 */
  }
}

async function applyInner(ctx: Context, config: unknown): Promise<void> {
  // ── 设置页命名空间（喵记忆标签页的数据底座）──
  // installSettingsSection 必须先于 resolveConfig，但「先注册」≠「注册时同步回填」——
  // inject 回调是异步的（见下），所以 resolve 之前必须显式等 source 就绪。
  // 三层模型：CONFIG_DEFAULTS（默认）< patch config（0.1.6 手编层，config 参数里已
  // 合成）< 设置页 user 层（标签页改动，字段级覆盖）。
  // 0.1.6 腿：settingsBase 显式合成 CONFIG_DEFAULTS⊕config，作为 register 的 base——
  // patch 手编的值（如 delegate/model）不在 base 里的话标签页显示为空，用户会以为
  // 配置丢了（2026-09-02 实测踩坑）。附加 homeDirPresets（只读 meta）同因：0.1.6 的
  // base 通道只认 register 显式传参。
  // 0.1.7 腿：register 已被宿主删除，base 视图改由宿主拿 Config schema 深填默认值
  // （resolveConfig(inherited)）——预填全部声明进 schema（含 homeDirPresets），这里
  // 不再需要任何手动注入。patch config 段已随全等比对死锁退役（2026-09-25）。
  const settingsBase = { ...mergeConfigLayer(CONFIG_DEFAULTS, config), homeDirPresets: homeDirPresets() } as Record<string, unknown>
  let settingsGet: (() => unknown) | undefined
  // 设置源就绪信号（issue #21）：ctx.inject(deps, cb) 的回调**永远不会同步执行**——它
  // 等价于 ctx.plugin({ inject, apply })，插件体跑在异步启动的子 fiber 里（cordis
  // lib/index.js:1599），依赖是否已就绪都一样。原实现「注册完紧接着下一行读 setSource
  // 回填的 getter」因此必然拿到 undefined：settings.yaml / 设置页的 user 层从未进过
  // resolve，设置页对「影响行为」的字段等于纯展示，连"重启后生效"也不成立。
  // 现在：注册后等 source 就绪再 resolve（等待有界，见 SETTINGS_SOURCE_WAIT_MS）。
  let markSourceReady: (() => void) | undefined
  const sourceReady = new Promise<void>((resolve) => { markSourceReady = resolve })
  let sourceWaitArmed = false
  try {
    // 双版本设置区注册（0.1.2 及以下旧版 / 0.1.3+ 新版）分流见 installSettingsSectionCompat：
    // 新版走 settings.installSection；旧版回退 settings.register 复刻旧自由函数行为。
    // 注册失败（比如 settings 服务未装配）不影响插件本体：
    // 下面 catch 会降级为只走 patch 层配置，设置页标签不可用。
    ctx.inject(['settings'], (settingsCtx: {
      settings: SettingsServiceLike
      effect: (fn: () => () => void) => unknown
    }) => {
      // 服务端 write 取证壳（0.1.7 写入排障 2026-09-25）：settings 服务就绪回调里
      // 实例必然在手——给 write 原型包装取证壳，宿主拒写的原始异常（含 message/栈，
      // 栈定位 configEditor 内具体抛点）落盘 settings-diag.log。仅加日志不改行为。
      // 必须在 installSectionCompat 之前装配：0.1.7 的服务无 installSection/register，
      // compat 会抛「neither」被 cordis 静默吞掉——那本身就是关键诊断信号，也要留痕。
      try {
        const svc = settingsCtx.settings as unknown as Record<string, unknown>
        const proto = Object.getPrototypeOf(svc) as { write?: (...args: unknown[]) => unknown; __writeProbe?: boolean }
        if (proto !== undefined && typeof proto.write === 'function' && proto.__writeProbe !== true) {
          proto.__writeProbe = true
          const rawWrite = proto.write.bind(svc)
          proto.write = (...args: unknown[]) => {
            const result = rawWrite(...args)
            if (result instanceof Promise) {
              return result.catch((e: unknown) => {
                try {
                  const diagFile = join(activeHomeDir(), 'settings-diag.log')
                  mkdirSync(dirname(diagFile), { recursive: true })
                  appendFileSync(diagFile, `[${new Date().toISOString()}] write(ns=${String(args[0])}) rejected: ${e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)}\n`)
                } catch {
                  /* 取证失败忽略 */
                }
                throw e
              })
            }
            return result
          }
        }
      } catch {
        /* 取证壳装配失败忽略 */
      }
      // 宿主 configEditor 侧直接取证（write 的第一道门）：entries 的真实清单
      try {
        const ce = (svc as unknown as { ownerContext?: { configEditor?: { entries?: () => Array<Record<string, unknown>> } } }).ownerContext?.configEditor
        if (ce && typeof ce.entries === 'function') {
          const rows = ce.entries().map((entry) => {
            const o = entry as Record<string, any>
            return {
              id: o.options?.id,
              state: o.fiber?.state,
              parent: o.parent?.tree?.ctx?.fiber?.entry?.id ?? null,
              hasRuntimeConfig: o.fiber?.runtime !== undefined && 'Config' in (o.fiber.runtime as object),
              configRaw: o.options?.config ?? null,
            }
          })
          const diagFile2 = join(activeHomeDir(), 'settings-diag.log')
          mkdirSync(dirname(diagFile2), { recursive: true })
          appendFileSync(diagFile2, `[${new Date().toISOString()}] configEditor entries: ${JSON.stringify(rows)}\n`)
        }
        // edit 取证壳：overridden 拒绝时复算 next/读取 raw 落盘——与合并结果对比差异键
        if (typeof ce.edit === 'function' && (ce as unknown as { __editProbe?: boolean }).__editProbe !== true) {
          ;(ce as unknown as { __editProbe?: boolean }).__editProbe = true
          const origEdit = ce.edit.bind(ce)
          ce.edit = async function (entry: Record<string, any>, change: (raw: any, inherited: any) => unknown) {
            // 成功/失败双向取证：成功 dump 写盘的 next；失败 dump 原始异常（含栈）
            const result = await origEdit(entry, change).catch((e: unknown) => {
              try {
                const f = join(activeHomeDir(), 'settings-diag.log')
                mkdirSync(dirname(f), { recursive: true })
                appendFileSync(f, `[${new Date().toISOString()}] edit THREW ns=${String(entry?.options?.id)}: ${e instanceof Error ? `${e.message}\n${String(e.stack).split('\n').slice(1, 4).join('\n')}` : String(e)}\n`)
              } catch { /* 忽略 */ }
              throw e
            })
            try {
              const f = join(activeHomeDir(), 'settings-diag.log')
              mkdirSync(dirname(f), { recursive: true })
              appendFileSync(f, `[${new Date().toISOString()}] edit OK ns=${String(entry?.options?.id)}\n`)
            } catch { /* 忽略 */ }
            return result
          }
        }
      } catch {
        /* configEditor 不可达：跳过 */
      }
      // 宿主视角的三层配置 dump：SettingsForms.describe 的 meow-memory 视图
      // （value=最终生效 / base=出厂+patch / user=设置页层）。describe 无副作用，
      // 启动即采一次 + 5 秒后再采一次（等 entry 激活）。
      try {
        const svcAny = settingsCtx.settings as unknown as { describe?: () => unknown }
        if (typeof svcAny.describe === 'function') {
          const dumpDescribe = (): void => {
            try {
              const view = svcAny.describe()
              const diagFile = join(activeHomeDir(), 'settings-diag.log')
              mkdirSync(dirname(diagFile), { recursive: true })
              const info = {
                isArray: Array.isArray(view),
                keys: view && typeof view === 'object' && !Array.isArray(view) ? Object.keys(view) : null,
                length: Array.isArray(view) ? view.length : null,
                nsList: Array.isArray(view) ? view.map((row: any) => row?.ns) : null,
              }
              appendFileSync(diagFile, `[${new Date().toISOString()}] describe shape: ${JSON.stringify(info)}\n`)
              const meowRow = Array.isArray(view) ? view.find((row: any) => row?.ns === 'meow-memory') : undefined
              if (meowRow !== undefined) {
                appendFileSync(diagFile, `[${new Date().toISOString()}] meow view: ${JSON.stringify({
                  revision: meowRow.revision,
                  value: meowRow.value,
                  base: meowRow.base,
                  user: meowRow.user,
                })}\n`)
                // volatile 表单认可的字段集=写入白名单的根；homeDir 在不在一看便知
                const schemaObj = meowRow.schema as Record<string, unknown> | undefined
                const schemaKeys = schemaObj && typeof schemaObj === 'object' ? Object.keys(schemaObj) : null
                appendFileSync(diagFile, `[${new Date().toISOString()}] meow schema: ${JSON.stringify({
                  schemaKeys,
                  homeDirDeclared: schemaKeys !== null && schemaKeys.includes('homeDir'),
                  schemaFull: JSON.stringify(schemaObj).slice(0, 3000),
                })}\n`)
              }
            } catch (e) {
              try {
                appendFileSync(join(activeHomeDir(), 'settings-diag.log'), `describe dump err: ${String(e)}\n`)
              } catch {
                /* 忽略 */
              }
            }
          }
          dumpDescribe()
          setTimeout(dumpDescribe, 5000)
        }
      } catch {
        /* dump 失败忽略 */
      }
      // ── 0.1.7 宿主盲区补丁（2026-09-25 radio 冻结案）────────────────────────
      // 0.1.7 的 SettingsForms（无 installSection/register）有三处盲区：
      // ① write 只落盘+发 document-updated，**从不重载 entry**——describe 的 value
      //    恒为 entry 启动时的解析值（entry.fiber.config），user 层（override）却是
      //    新鲜的。设置页 radio（只认已保存镜像值）因此永远停在旧位置；bool/num/str
      //    靠「保存后保留 draft」掩盖了同一冻结（实车 value=user=plugin-root vs
      //    user=default 分裂实证）。→ describe 壳：meow 行现场重算 value=base⊕user。
      // ② installSection 缺席 → base 没有 homeDirPresets，radio 旁看不到实际路径。
      //    → describe 壳顺手注入（只进 base 不进 value：client 只从 base 读预设，
      //    value 要过 configForms 的 schema decode，未知键有 decode 失败风险）。
      // ③ scope.watch 缺席 → onChange 热切换不触发，改 homeDir 只落库不切换。
      //    → write 壳：meow-memory 写入成功后补跑 hotSwitchHomeDir（与 0.1.6
      //    onChange 同语义；get 走 describe 壳的现场合并值，天然含最新 user 层）。
      // 0.1.6（installSection 在）三条原生链路全在，一概不装。壳只动 meow 行、
      // 其他命名空间原样透传；revision/raw 指纹不碰（edit 的写入围栏还要读它）。
      // 壳装配失败退回现状（value 冻结但不崩）。
      if (typeof settingsCtx.settings.installSection !== 'function') {
        try {
          const svcAny = settingsCtx.settings as unknown as Record<string, unknown>
          const proto = Object.getPrototypeOf(svcAny) as Record<string, unknown>
          if (proto !== null && typeof proto.describe === 'function' && proto.__meowValueRefresh !== true) {
            proto.__meowValueRefresh = true
            const rawDescribe = (proto.describe as (...args: unknown[]) => unknown).bind(svcAny)
            proto.describe = (...args: unknown[]): unknown => {
              const rows = rawDescribe(...args) as Array<Record<string, unknown>>
              try {
                if (Array.isArray(rows)) {
                  const row = rows.find((r) => r?.ns === SETTINGS_NS) as
                    | { base?: Record<string, unknown>; user?: Record<string, unknown>; value?: unknown }
                    | undefined
                  if (row !== undefined && row.base !== undefined && row.base !== null && typeof row.base === 'object') {
                    // 幂等：行对象跨多次 describe 复用，必须先剥掉上次注入的 presets
                    // 再合成，否则第二轮 value 就带上了未知键（decode 失败风险）。
                    const cleanBase = { ...row.base }
                    delete cleanBase.homeDirPresets
                    row.base = { ...cleanBase, homeDirPresets: homeDirPresets() }
                    row.value = mergeConfigLayer(cleanBase, row.user as Record<string, unknown> | undefined)
                  }
                }
              } catch {
                /* 修正失败退回宿主原值（冻结但不崩） */
              }
              return rows
            }
            // 0.1.7 的设置源 = describe 壳的现场合并值（base⊕user，含最新 user 层）：
            // resolveConfig 等待与热切换都从这读，等价 0.1.6 的 scope.get()。
            settingsGet = (): unknown => {
              const rows = (svcAny.describe as (...args: unknown[]) => unknown)() as Array<Record<string, unknown>>
              const row = Array.isArray(rows) ? rows.find((r) => r?.ns === SETTINGS_NS) : undefined
              return row?.value
            }
            markSourceReady?.()
          }
          if (proto !== null && typeof proto.write === 'function' && proto.__meowWriteHook !== true) {
            proto.__meowWriteHook = true
            const rawWriteHooked = (proto.write as (...args: unknown[]) => unknown).bind(svcAny)
            proto.write = (...args: unknown[]): unknown => {
              const result = rawWriteHooked(...args)
              if (result instanceof Promise) {
                return result.then((v: unknown) => {
                  if (String(args[0]) === SETTINGS_NS) {
                    ctx.logger.info('meow-memory: 配置已通过设置页更新（重载/重启插件后生效）')
                    hotSwitchHomeDir(ctx, config, settingsGet)
                  }
                  return v
                })
              }
              return result
            }
          }
        } catch {
          /* 盲区补丁装配失败：退回现状（value 冻结），不影响插件启动 */
        }
      }
      installSettingsSectionCompat(settingsCtx, ctx, SETTINGS_NS, z.dict(z.any()), settingsBase, {
        validate: (value: unknown): void => {
          validateConfigUserLayer(value)
        },
        setSource: (get: () => unknown): void => {
          settingsGet = get
          markSourceReady?.() // 回填即就绪：唤醒下面的有界等待
        },
        onChange: (): void => {
          ctx.logger.info('meow-memory: 配置已通过设置页更新（重载/重启插件后生效）')
          // homeDir 热切换（用户拍板 2026-09-24：保存后立即生效，无需重启）——
          // 全局目录消费点全是轻量读写（日志追加/小 JSON/按需读覆盖层），切模块级
          // 状态口即可，dsh 主进程不重启、插件不重载、在跑会话无感知。
          hotSwitchHomeDir(ctx, config, settingsGet)
        },
      })
    })
    sourceWaitArmed = true // inject 已受理才值得等；ctx.inject 不存在时走 catch，不必等
  } catch (e) {
    // 设置服务未装配（别的 profile）不挡插件本体：config 退回 patch 层。
    const msg = `meow-memory: 设置命名空间注册失败（标签页不可用，配置走 patch 层）：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`
    ctx.logger.warn(msg)
    try {
      const regErrFile = join(activeHomeDir(), 'settings-register-error.log')
      mkdirSync(dirname(regErrFile), { recursive: true })
      appendFileSync(regErrFile, `[${new Date().toISOString()}] ${msg}\n`)
    } catch {
      /* 留痕失败忽略 */
    }
  }
  // ── 服务端设置域诊断（0.1.7 写入排障，2026-09-25）：0.1.7 宿主对拒写静默、
  // typert 信封剥 message——从宿主 configEditor 侧直接取证：entries 的 id/归属
  // 节点/fiber 状态/Config 挂载，落 settings-diag.log。0.1.6 无此服务 → inject
  // 挂起不回调，天然跳过。诊断失败绝不影响插件启动。
  try {
    ctx.inject(['configEditor'], (ce: {
      entries: () => Array<{ options?: { id?: unknown }; fiber?: { state?: unknown; runtime?: unknown }; parent?: { tree?: { ctx?: { fiber?: { entry?: { id?: unknown } } } } } }>
    }) => {
      try {
        const rows = ce.entries().map((entry) => ({
          id: entry.options?.id,
          state: entry.fiber?.state,
          parent: entry.parent?.tree?.ctx?.fiber?.entry?.id ?? null,
          hasConfig: entry.fiber?.runtime !== undefined && 'Config' in (entry.fiber.runtime as object),
        }))
        const diagFile = join(activeHomeDir(), 'settings-diag.log')
        mkdirSync(dirname(diagFile), { recursive: true })
        appendFileSync(diagFile, `[${new Date().toISOString()}] configEditor entries: ${JSON.stringify(rows)}\n`)
      } catch {
        /* 诊断失败忽略 */
      }
    })
  } catch {
    /* 无 configEditor 服务（0.1.6）：跳过 */
  }
  // ── 宿主 write 异常落盘（同上排障）：0.1.7 的 settings 服务（SettingsForms）对
  // write 抛错只回 code 不回 message——在同进程内给原型方法包一层取证壳，把原始
  // 异常（含 message/栈，栈可定位 configEditor 内具体抛点）原样落盘。仅加日志不改
  // 行为；settings 服务不存在（0.1.6 老链/未装配）时静默跳过。
  try {
    const settingsSvc = (ctx as unknown as { get?: (name: string) => unknown }).get?.('settings') as
      | { write?: (...args: unknown[]) => unknown }
      | undefined
    const proto = settingsSvc !== undefined ? Object.getPrototypeOf(settingsSvc) as { write?: (...args: unknown[]) => unknown; __writeProbe?: boolean } : undefined
    if (proto !== undefined && typeof proto.write === 'function' && proto.__writeProbe !== true) {
      proto.__writeProbe = true
      const rawWrite = proto.write.bind(settingsSvc)
      proto.write = (...args: unknown[]) => {
        const result = rawWrite(...args)
        if (result instanceof Promise) {
          return result.catch((e: unknown) => {
            try {
              const diagFile = join(activeHomeDir(), 'settings-diag.log')
              mkdirSync(dirname(diagFile), { recursive: true })
              appendFileSync(diagFile, `[${new Date().toISOString()}] write(ns=${String(args[0])}) rejected: ${e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)}\n`)
            } catch {
              /* 取证失败忽略 */
            }
            throw e
          })
        }
        return result
      }
    }
  } catch {
    /* 探针装配失败不影响启动 */
  }
  // 有界等待设置源就绪（issue #21）：真机上回调一个微任务内就跑完，不会真的等到上限；
  // 服务缺失/注册失败时最多等 SETTINGS_SOURCE_WAIT_MS 就继续，绝不挂起。
  if (sourceWaitArmed) {
    await Promise.race([
      sourceReady,
      new Promise<void>((resolve) => { setTimeout(resolve, SETTINGS_SOURCE_WAIT_MS) }),
    ])
  }
  const merged = mergeConfigLayer(config, settingsGet?.() as Record<string, unknown> | undefined)
  const resolved = resolveConfig(merged)
  // ── 全局目录解析+切换（含首迁/回迁）：必须先于 sweep/loadWindowIndex——它们吃新目录。
  // disabled 检查之前执行：插件停用时配置变更也要生效（switchHomeDir 幂等，重复启动无害）。
  logHomeDirSwitch(ctx, switchHomeDir(resolveHomeDir(resolved.homeDir)))
  // 诊断（issue #26）：把「设置源是否赶上」与关键解析值落到启动日志——配置不生效类
  // 报告先看这一行：sourceReady=否 即冷启动竞态（settings 服务晚于等待上限就绪）。
  ctx.logger.info(`meow-memory: config resolved (sourceReady=${settingsGet !== undefined}, enabled=${resolved.enabled}, dream.enabled=${resolved.dream?.enabled ?? 'default'}, promptLang=${resolved.promptLang ?? 'zh'}, projectDir=${resolved.projectDir ?? '.dsh-meow'})`)
  if (!resolved.enabled) {
    ctx.logger.info('meow-memory: disabled by config')
    return
  }
  // prompt 语言（实例常量）：setPromptLang 一次，loader/bm25 内部取用——链路零透传。
  // 必须先于工具注册（tools.md 描述也吃这个语言）。未配置时运行时兜底 zh。
  setPromptLang(resolved.promptLang ?? 'zh')
  applyCount++
  perf(`apply #${applyCount} pid=${process.pid}`)
  const sweptHome = sweepHomeLogs()
  if (sweptHome.swept.length > 0 || sweptHome.rotated) {
    perf(`home-log sweep: ${sweptHome.swept.join(',') || '-'}${sweptHome.rotated ? ' +perf.log->old' : ''}`)
  }
  loadWindowIndex(resolved.projectDir) // 恢复窗口索引（热重载/重启后旧窗口不失联）

  // v0 会话一次性迁移（issue #13）：标记未迁移时体检全部会话并把 source.memory 搬进
  // sections.__meta__，完成后置位 .dsh-meow/migrate-v0-state.json，此后启动直接跳过。
  // fire-and-forget：绝不阻塞 dsh 启动；单文件失败只记日志（用户拍板 2026-09-10）。
  void ensureV0SessionsMigrated(resolved.projectDir, (m) => ctx.logger.info(m)).catch((e: unknown) => {
    ctx.logger.warn(`meow-memory: migrate-v0 failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
  })
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
  // systemPrompt 是可选服务（别的 profile 可能没加载 dsh-system-prompt），且 fiber 并发
  // 启动时可能晚于本插件就绪（与 webServer 路由同款竞态）→ 立即试；未就绪每 1s 重试
  // （最多 20 次，同 tryRegisterDreamCommand 模式）。
  // disposer 必须接住（0.1.2 / 0.1.3+ 的 section() 都返回 cordis effect disposer）：
  // 热重载时 fiber dispose 先注销旧段，否则同名重复 insert 抛错会打断整个 apply。
  // 双版本兼容：不假设返回值形状，typeof 校验后才登记（对旧版零影响）。
  let guideRegistered = false
  let guideTimer = 0
  const tryRegisterGuideSection = (attempt: number): void => {
    if (guideRegistered) return
    const svc = (ctx as { get?: (name: string) => unknown }).get?.('systemPrompt') as
      | { section?: (section: { name: string; order: number; text: string }) => unknown }
      | undefined
    if (svc === undefined || typeof svc.section !== 'function') {
      if (attempt < 20) {
        guideTimer = setTimeout(() => tryRegisterGuideSection(attempt + 1), 1000) as unknown as number
      } else {
        ctx.logger.warn('meow-memory: systemPrompt 服务 20s 内未就绪，记忆手册未挂进 system prompt（memory_* 工具不受影响）')
      }
      return
    }
    try {
      const dispose = svc.section({ name: 'meow-memory:guide', order: 130, text: getMemoryGuide() })
      guideRegistered = true
      if (typeof dispose === 'function') toolDisposers.push(dispose)
      ctx.logger.info('meow-memory: guide section registered into system prompt')
    } catch (e) {
      // 重复名冲突等注册错误：重试无意义（旧代未 dispose 时再试还是撞），记日志放弃。
      ctx.logger.warn(`meow-memory: guide section 注册失败（记忆手册缺失，不影响其余功能）: ${e instanceof Error ? e.message : String(e)}`)
      guideRegistered = true
    }
  }
  tryRegisterGuideSection(0)
  toolDisposers.push(() => clearTimeout(guideTimer))

  // 窗口表：只处理低频事件类型（流式 assistant/chunk 每块一个事件，绝不逐块写库）。
  // 节流：同一窗口 5 秒内最多落库一次（内存记 lastWrite，事件循环零阻塞）。
  // 插件注入轮（反思/dream 的 steer 消息轮）内的事件不刷新 last_event_time：
  // dream 轮自身事件会推后窗口活跃度 → 收尾后 last_dream_time < last_event_time
  // → 窗口永远"需要 dream"，配合中断/多进程场景造成反复 dream。
  const lastWindowWrite = new Map<string, number>()
  const isPluginTurn = new Map<string, boolean>() // sid -> 本 turn 是否为 meow-memory 插件轮
  const turnHadMessage = new Map<string, boolean>() // sid -> 本 turn 是否出现过任何 user/message（#36 裸轮判定：dream 任务被 claim 后未及落盘就装配崩溃的轮，全程零消息）
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
        turnHadMessage.set(sid, false) // 新轮重置（#36 裸轮判定基线）
        return
      }
      if (t === 'user/message') {
        turnHadMessage.set(sid, true) // 任何来源的消息都算（裸轮 = 全程零消息）
        const data = event.data as {
          source?: { kind?: string; plugin?: string; form?: string }
          content?: Array<{ type?: string; text?: string }>
        } | undefined
        const src = data?.source
        // 插件自身消息识别（2026-09-05 扩大：原只认 source.kind='plugin'，漏掉两类——
        // ①steer 模式 dream/reflect 指令消息（agent.steer 的 user 帧无 source，含
        // [meow-memory-dream]/[meow-memory-reflect]）；②delegate 打点（session.append
        // ('user/message') 无 source，含【记忆整理标记】等）——实证打点会 touchWindow
        // 把 last_event_time 顶成 dream 时刻：掩盖真实活跃度，且 error 重试窗口被
        // 反复刷新永不超 24h。用户亲手发的消息（source.kind='user'）绝不判 marker，
        // 防引用标记文本误伤。命中 → 指令/打点：不 touchWindow 不刷新活跃度。
        if (src?.kind !== 'user') {
          const msgText = (data?.content ?? [])
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text ?? '')
            .join(' ')
          if (
            msgText.includes(REFLECT_MARKER) ||
            msgText.includes(DREAM_MARKER) ||
            msgText.includes(REFLECT_DELEGATE_MARKER) ||
            msgText.includes(DREAM_DELEGATE_MARKER) ||
            msgText.includes(REFLECT_DONE_DELEGATE_MARKER)
          ) {
            isPluginTurn.set(sid, true) // 反思/dream 指令轮或打点
            return // 不刷新活跃度
          }
        }
      }
      // dream 轮失败即时处理（issue #36 建议二）：宿主的 agent/turn-stopping 只在
      // 「某个 step 成功完成后」发射（dsh-agent-loop turn 循环内唯一发射点，且发射时
      // 本轮 turn/end 还没落日志），首个 step 之前的失败（空 options 装配抛错、
      // pre-step reject 等）永远走不到那里——turn-stopping 的 error 分支对这类失败是
      // 死代码，租约只能等 6h 心跳封顶后被盖章（静默丢记忆）。turn/end 事件在宿主
      // catch/finally 里必然落盘，用在这里兜底：
      // ① 插件轮 error（消息标记已落盘的 dream/reflect 轮）→ handleMemoryTurnFailure；
      // ② 「裸轮」error（本 turn 全程零 user/message）且有活跃 dream 租约 → 同样处理
      //    （dream 任务被 claim 后未及落盘就装配崩溃的形状；窗口此刻非活跃使用场景，
      //    误判代价仅为提前重试一次）。
      if (t === 'turn/end' && (event.data as { reason?: { kind?: string } } | undefined)?.reason?.kind === 'error') {
        const pluginTurn = isPluginTurn.get(sid) === true
        const nakedTurn = turnHadMessage.get(sid) === false // turn/start 已见、其后零消息
        if ((pluginTurn || nakedTurn) && typeof cwd === 'string' && existsSync(memoryDbPath(cwd, resolved.projectDir))) {
          const outcome = handleMemoryTurnFailure(getDb(cwd, resolved.projectDir), sid, cwd, resolved.projectDir)
          if (outcome !== 'none') broadcast.broadcast(sid, 'active') // 摘掉 dreaming 呼吸灯（重试/封存状态由后续 sweep 表达）
        }
      }
      if (isPluginTurn.get(sid)) return // 插件轮内：不 touchWindow
    }
    if (t !== 'user/message' && t !== 'turn/end' && t !== 'assistant/message' && t !== 'tool/result') return
    // 子代理会话不进窗口表/windowIndex：origin==='subagent'（dsh 权威标记，与注入链
    // 同口径）。子代理的记忆活动按归属语义记父窗口名下，自身不是 dream 目标——否则
    // dream fork 出的子代理会话也成待 dream 窗口，dream→再进表→再 dream 递归套娃
    // （2026-09-05 真机实证 8fbc5d59→2f47c15b→63dad87b，depth 无限增长）。
    // 压缩信号处理在上方，不受此 return 影响。
    if (session?.header?.origin === 'subagent') return
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
  // 热路径 fail-open（2026-09-10）：pre-step 是 async 监听器，插件逻辑抛错会沿
  // agent-loop 传播改变宿主 turn 的错误语义。包装器单独持有 next()——宿主 step
  // 自身的错误原样上抛（abort 语义在内），只有本插件自己的注入/检索失败才吞掉
  // （放弃本轮注入、放行原始 decision，与本插件其余路径的 fail-open 同风格）。
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    try {
      // preStepInject 内部把 decision 当透传黑盒（any）；出口 cast 回宿主形状。
      return (await preStepInject({ agent, signal }, decision)) as typeof decision
    } catch (e) {
      try {
        ctx.logger.warn(`meow-memory: pre-step 注入失败（fail-open 放行原始消息）: ${e instanceof Error ? e.message : String(e)}`)
      } catch { /* 日志失败不阻塞 */ }
      return decision
    }
  })

  // decision 形状来自宿主事件映射，这里透传不重塑（内部只做 kind/messages 只读访问）。
  const preStepInject = async ({ agent, signal }: { agent: any; signal: { aborted: boolean } }, decision: any): Promise<unknown> => {
    const t0 = Date.now()
    if (decision === undefined || decision.kind !== 'enter' || signal.aborted) return decision
    if (decision.messages.length === 0) return decision
    // 子代理不注入（origin === 'subagent'，dsh 权威标记）：它们的 prompt 由父代理提供
    // （如 dsh-femo 的角色上下文）。注意不能只看 parentSession——GUI fork/续写的
    // 主会话也有 parentSession（真机踩坑 2026-08-17：fca10feb 被误判为子代理导致注入全失效）。
    if (agent.session.header.origin === 'subagent') return decision
    registerLiveAgent(agent)
    const sid = sessionIdOfAgent(agent)
    const ws = workspaceOfAgent(agent)

    // 真实用户消息（跳过插件通知等，source.kind='plugin' 的进不来）。
    const userMsgs = decision.messages.filter((m: { source?: { kind?: string } }) => m.source?.kind === 'user')
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
        rewritten.splice(rewritten.indexOf(lastUser), 0, createMemorySnapshotMessage(reinj.text, { kind: 'reinjection', ids: reinj.injectedIds }))
        ctx.logger.info(`meow-memory: post-compaction memory re-injected (${reinj.text.length} chars)`)
        return { ...decision, messages: rewritten }
      }
      return decision
    }

    // 首条用户消息（本进程内每个会话只判定一次）。
    if (!firstUserHandled.has(sid)) {
      firstUserHandled.add(sid)
      let priorUser = 0
      for (const e of sessionEventsOf(agent.session)) {
        const evt = e as { type?: string; data?: { source?: { kind?: string } } }
        if (evt?.type === 'user/message' && evt.data?.source?.kind === 'user') priorUser++
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
            rewritten.splice(rewritten.indexOf(firstUser), 0, createMemorySnapshotMessage(injected.text, { kind: 'initial', ids: injected.injectedIds }))
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
    // 作为独立的插件通知消息注入，不改写人类 user 消息。
    if (resolved.promptLang === undefined && ws) {
      const seen = readSeen(ws, sid, resolved.projectDir)
      if (!seen.has(WELCOME_GUIDE_SEEN_ID)) {
        const lastUser = [...decision.messages].reverse().find((m: { source?: { kind?: string } }) => m.source?.kind === 'user')
        if (lastUser !== undefined) {
          markAccessed(ws, sid, [WELCOME_GUIDE_SEEN_ID], resolved.projectDir)
          const guide = resolveSlotText('welcome-guide', { homePath: homedir() })
          const rewritten = [...decision.messages]
          rewritten.splice(rewritten.indexOf(lastUser), 0, createMemoryNoticeMessage(guide))
          ctx.logger.info('meow-memory: first-run lang guide injected as independent notice (promptLang unset)')
          return { ...decision, messages: rewritten }
        }
      }
    }

    // 命中链路（从第二条用户消息起）：每条含真实用户消息的请求都跑关键词检索命中
    // （top-K）。工具轮/子步骤的请求消息不含真实用户消息 → 不触发；
    // 命中 id 记入已见，不再重复。
    if (ws) {
      const lastUser = [...decision.messages].reverse().find((m: { source?: { kind?: string } }) => m.source?.kind === 'user')
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
          appendFileSync(join(ws, resolved.projectDir, 'dream-debug.log'), `[${new Date().toISOString()}] hit-chain pid=${process.pid} sid=${shortSessionId(sid)} textLen=${text.length} hit=${hit === null ? 'null' : 'yes'}\n`)
        } catch { /* 日志失败不阻塞 */ }
        if (hit !== null) {
          const rewritten = [...decision.messages]
          rewritten.splice(rewritten.indexOf(lastUser), 0, createMemorySnapshotMessage(hit.text, { kind: 'hit', ids: hit.injectedIds }))
          return { ...decision, messages: rewritten }
        }
      }
      if (Date.now() - t0 > 10) perf(`pre-step hit ${Date.now() - t0}ms sid=${shortSessionId(sid)}`) // 热路径超 10ms 有鬼
    }
    return decision
  }

  // 2) turn 结束：dream 轮推进 / 自动反思。
  // 同 pre-step 的 fail-open：同步监听器里抛错（如 advanceDream→steer、DB 读）不允许
  // 改变宿主 turn 收尾语义，吞掉记日志（dream 租约有过期自愈兜底，不会因此卡死）。
  // 反思排队判重（issue #19）：sendMemoryTurn 走 followup 把反思排进「下一轮」，它不在
  // 本 turn 的事件流里，于是 scanTurn().sawReflect 在本 turn 收尾期间恒为 false。0.26.0
  // 起 turn-stopping 在一次收尾窗口内会触发多次（每个 step 收尾、被其它插件 steer 续命
  // 后再触发），每次都再排一条，排 N 条就被后面 N 个 turn 依次消费——真机实测同一反思
  // 连发 4 次，每次都要模型回一句「无需记忆」，白烧 token。
  // 判重键取宿主事件载荷里的 turn（agent/turn-stopping: { agent, turn, signal }）：同一
  // turn 只排一条；反思轮真正跑起来后 sawReflect=true 自然清账；换 turn 键值不同自动放行
  // ——不会像布尔闩那样在「排了却没跑」时永久卡死。载荷无 turn 的宿主退回旧行为。
  const reflectQueuedTurn = new Map<string, number>()
  const MAX_REFLECT_TRACKED = 512

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      turnStoppingCore(agent, turn)
    } catch (e) {
      try {
        ctx.logger.warn(`meow-memory: turn-stopping 处理失败（已忽略）: ${e instanceof Error ? e.message : String(e)}`)
      } catch { /* 日志失败不阻塞 */ }
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- agent 形状来自宿主事件映射，透传不重塑
  const turnStoppingCore = (agent: any, turn?: number): void => {
    const t0 = Date.now()
    if (agent.session.header.origin === 'subagent') return // 子代理不参与（origin 权威判定）
    registerLiveAgent(agent)
    const endReason = lastTurnEndReason(sessionEventsOf(agent.session))
    const dreamTurn = wasDreamTurn(sessionEventsOf(agent.session))
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
      if (endReason === 'error') {
        // steer 模式 dream 轮执行失败（LLM/网络瞬态故障，非用户中止）：释放租约不封存，
        // 下个检查周期自动重试（与 delegate 路径 done 回调的 error 分支同语义，
        // 2026-09-05 教训：封存会让一次断网永久吞掉窗口的 dream）。
        try {
          if (wsTs && sidTs) getDb(wsTs, resolved.projectDir).releaseDream(sidTs)
        } catch { /* 释放失败不阻塞（租约 30min 过期自愈兜底） */ }
        return
      }
      advanceDream(agent, resolved.projectDir, signalDreamState, resolved.dream.rulesReviewDays) // dream 轮：推进下一组或收尾（含孤儿收尾）
      return
    }

    if (!resolved.reflect) return
    const ws = workspaceOfAgent(agent)
    if (!ws) return
    const { sawToolCall, lastToolName, sawReflect, turnText } = scanTurn(sessionEventsOf(agent.session))
    if (sawReflect) {
      reflectQueuedTurn.delete(sidTs) // 本 turn 已反思过（含反思轮自身结束）：排队痕迹用完即清
      return
    }
    // 本 turn 已经排过一条（followup 排在 next-turn，事件流里还看不见）→ 不再重复排（issue #19）
    if (turn !== undefined && reflectQueuedTurn.get(sidTs) === turn) return
    if (!sawToolCall) return // 纯聊天轮，不反思
    if (lastToolName !== undefined && lastToolName.startsWith('memory_')) return // 已主动记忆
    if (consecutiveToolSteps(sessionEventsOf(agent.session)) < resolved.reflectTurns) return // 单任务内连续工具 step 不足
    const message = buildReflectMessage(ws, turnText, resolved.projectDir)
    // 反思任务送主会话独立新轮（v0.24 拍板进主会话；2026-09-10 起走 followup 另起
    // 一轮——steer 延续同 turn 会把 AI 的工作汇报顶成中间步骤，见 sendMemoryTurn）。
    // 换模型由下方 agent/request waterfall 承接——本 turn 带 REFLECT_MARKER 时自动覆盖模型。
    if (sendMemoryTurn(agent, message, ws, resolved.projectDir, `reflect sid=${shortSessionId(sidTs)}`)) {
      if (turn !== undefined) {
        reflectQueuedTurn.set(sidTs, turn)
        // 进程级 Map 兜底上限：只保最近 MAX_REFLECT_TRACKED 个会话（Map 保留插入序）。
        while (reflectQueuedTurn.size > MAX_REFLECT_TRACKED) {
          const oldest = reflectQueuedTurn.keys().next().value
          if (oldest === undefined) break
          reflectQueuedTurn.delete(oldest)
        }
      }
      ctx.logger.info(`meow-memory: reflect sent as standalone turn after ${resolved.reflectTurns}+ tool turns`)
    } else {
      ctx.logger.warn('meow-memory: reflect 发送失败（本轮不反思，下轮重试）')
    }
    if (Date.now() - t0 > 20) perf(`turn-stopping slow ${Date.now() - t0}ms`)
  }

  // 2.5) 整理任务换模型（agent/request waterfall，dsh 官方单请求模型覆盖扩展点）：
  //   配置了 delegate.model 时，本会话「反思轮/梦境轮」的请求把 provider/model 覆盖为
  //   配置值，其余请求（正常对话/工具轮）原样放行——触发前换上、轮次结束自动换回，
  //   无状态：判定=当前 turn 的指令消息是否带 [meow-memory-reflect]/[meow-memory-dream]
  //   文本标记（steer 指令消息在请求前已落 log，agent-loop L554 实证；与 wasDreamTurn/
  //   isPluginTurn 同口径），不存在需要清理的"覆盖中"状态——用户中止/崩溃/热重载
  //   都不留脏覆盖。
  // waterfall 契约：listener 必须 return 最终 config（不改也要透传 next() 结果）。
  if (resolved.delegate.modelSpec !== undefined) {
    const spec = resolved.delegate.modelSpec
    ctx.on('agent/request', async (payload: { agent?: { session?: { header?: SessionHeaderLike } } }, next: () => Promise<unknown>) => {
      const config = await next() as { provider?: string; model?: string }
      const agent = payload?.agent
      // 子代理请求不覆盖（fork 子代理已不再由本插件产生；GUI 手动 fork 的照常放行）
      if (agent === undefined || agent.session?.header?.origin === 'subagent') return config
      if (!isMemoryTaskTurn(sessionEventsOf(agent.session as never))) return config
      ctx.logger.info(`meow-memory: memory task turn → model override ${spec.provider ?? '(inherit)'}/${spec.model ?? ''}`)
      return {
        ...config,
        ...(spec.provider !== undefined ? { provider: spec.provider } : {}),
        ...(spec.model !== undefined ? { model: spec.model } : {}),
      }
    })
    ctx.logger.info(`meow-memory: model override armed for reflect/dream turns (${spec.provider ?? '(inherit)'}/${spec.model ?? ''})`)
  }

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
                | { list?: () => Promise<ReadonlyArray<PersistedSessionLike>> }
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
    disposeDreamHeartbeats() // 热重载不残留 dream 租约心跳定时器
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
      | { list?: () => Promise<ReadonlyArray<PersistedSessionLike>> }
      | undefined
    const sessions = typeof sp?.list === 'function' ? await sp.list() : []
    // 双版本形状（2026-09-10）：0.1.2- 扁平 SessionHeader / 0.1.3+ Snapshot{header}，headerOf 统一取。
    const hit = sessions.map(headerOf).find((h) => h.id === sessionId)
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
// 持久化到全局目录（activeHomeDir()）/window-index.json：热重载/重启会重置模块级
// Map，若不恢复则旧窗口（reload 后无新事件）从 dream 检查中失联——有记忆也不 dream。
// 恢复后 agent 经 ctx.agents（AgentRegistry，harness 进程级）获取，不受插件 reload 影响。

const windowIndex = new Map<string, string>()

/** apply 时恢复窗口索引：①文件（上次落盘）→ workspace 集合；②每个已知 workspace
 *  的 windows 表（DB 持久化，含 reload 前全部窗口）补全——旧窗口（reload 后无新
 *  事件、文件里没有）也能恢复，不会从 dream 检查中失联。indexFile 缺省动态取当前
 *  全局目录——热切换目录后重调本函数即可把新目录的账本 merge 进内存。 */
export function loadWindowIndex(dir = '.dsh-meow', indexFile = join(activeHomeDir(), 'window-index.json')): void {
  const workspaces = new Set<string>()
  try {
    const merged = JSON.parse(readFileSync(indexFile, 'utf8')) as Record<string, unknown>
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
    // 已删除的工作区不复活（issue #27）：目录没了、或从未建过库的，一律跳过——
    // 绝不为「恢复索引」新建目录或空库（collectDreamStates / skip-dreams 同款守卫）。
    // json 里的 sid→workspace 映射不受影响（上面已恢复），只是不去打开它的库。
    if (!existsSync(ws) || !existsSync(memoryDbPath(ws, dir))) continue
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
  const indexFile = join(activeHomeDir(), 'window-index.json')
  try {
    mkdirSync(dirname(indexFile), { recursive: true })
    let merged: Record<string, string> = {}
    try {
      merged = JSON.parse(readFileSync(indexFile, 'utf8')) as Record<string, string>
    } catch {
      /* 首次写入 */
    }
    for (const [sid, ws] of windowIndex) merged[sid] = ws
    writeFileSync(indexFile, JSON.stringify(merged), 'utf8')
  } catch {
    /* 持久化失败不阻塞 */
  }
}

// re-export 供测试/调试/其他插件
export { PLUGIN_SOURCE, REFLECT_MARKER }
export { parseModelSpec, REFLECT_DELEGATE_MARKER, REFLECT_DONE_DELEGATE_MARKER, DREAM_DELEGATE_MARKER } from './delegate.js'
export { collectDreamStates, headerOf, type PersistedSessionLike } from './dream-signal.js'
export { MemoryDb, memoryDbPath, getDb, closeAllDbs, LEVELS, newId, PROJECT_SUBCATEGORIES, projectList, projectCovers, projectLabel, relativeTime, isGlobalProject, isGlobalScope, globalProjectMarker, GLOBAL_PROJECT_CANON, GLOBAL_PROJECT_CANON_EN } from './db.js'
export { migrateLegacy } from './migrate.js'
export { buildHitInjection, buildInjection, buildReinjection, buildProjectSectionText, readSeen, markSearched, markAccessed, readInjected, markInjected, markProjectQueried, readProjectQueried, markWritten, readWritten, markReinjectPending, clearReinjectPending, isReinjectPending, MAX_REINJECT_PROJECTS, MAX_REINJECT_WRITTEN, sessionsFile, getCurrentProject, setCurrentProject, releaseSeen } from './inject.js'
export { buildReflectMessage, consecutiveToolSteps, scanTurn } from './reflect.js'
export { tokenize, stemEn, search, findSimilar, topicDrift, recencyWeight } from './bm25.js'
export { fillTemplate, keyedValue, resolveSlotText, setPromptLang, getPromptLang, DEFAULT_LANG, SLOTS } from './prompt-loader.js'
export { DEFAULT_HOME_DIR, activeHomeDir, setActiveHomeDir, dshHomeDir, pluginRootDir, homeDirPresets, resolveHomeDir, switchHomeDir, type HomeDirSwitch } from './home-dir.js'
export { collectDreamRounds, buildDreamMessage, windowNeedsDream, DREAM_MARKER, noteActivity, hourInTimeZone, minutesInTimeZone, isDreamSuppressed, startWindowDream, resumeAndDream, advanceDream, abortDream, recoverInterruptedDream, handleMemoryTurnFailure, dreamCommandDefinition, isSubagentAgent, dreamSweepOnce, type DreamConfig } from './dream.js'
