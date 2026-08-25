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
 * - 串行：同一时刻只有一个进行中的 dream 任务；旧窗口（无 live agent）不碰。
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
import { readSeen } from './inject.js'
import { workspaceOf } from './tools.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'meow-memory' }

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
  rulesReviewDays = 2,
): DreamRound[] {
  const seen = readSeen(workspace, sessionId, dir)
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

function formatRow(r: MemoryRow): string {
  const head = r.content.replace(/\s+/g, ' ').trim()
  const meta = [r.level]
  if (r.level === 'project' && r.subcategory) meta.push(r.subcategory)
  if (r.title) meta.push(`《${r.title}》`)
  if (r.status !== 'active') meta.push(r.status)
  meta.push(`${r.id} ${formatTime(r.updated_at)}`) // 完整 id + 绝对时间戳（最后更新时间）
  // 关键词行：AI 要核查/重写关键词（判断 6），必须先把现有关键词给它看。
  const kw = (r.keywords ?? []).filter((k) => typeof k === 'string' && k.length > 0)
  const kwLine = kw.length > 0 ? kw.join(', ') : '（无）'
  return `- [${meta.join(' ')}] ${head}\n  关键词: ${kwLine}`
}

/** 第 1 轮（原子记忆）指南（用户拍板 2026-08-19 终稿；v0.17.0 清单范围实指令化——
 *  测评发现「顺便检查你看过的所有记忆」是无清单的空指令，改为明确以【本组记忆】为界）。 */
const ATOMIC_GUIDE = [
  '下面的【本组记忆】就是本窗口的全部整理范围：你自己建立的、以及本窗口注入/检索/查阅（memory_read）时看过的条目。范围到此为止——不要试图回忆清单之外"看过但没列出"的条目。',
  '有没有你认为该整理、更新的？如有，请更新它。',
  '',
  '## 如何判断该更新——逐条核查上面的清单，你现在觉得：',
  '1. 有没有当时记录错误或片面、过时、信息需要更新、用户改变决定、已有新进展的条目？ → 请及时更新内容，记忆库的信息应该吻合project进展的最新状态。',
  '2. 有没有被推翻的、被改掉的、被证明无效的设计和信息？ → 应设 status=archived 归档，绝不要让它们保持active或stale。stale只表示「完结」（todo做完、话题达成目标），不是「作废」；已被替代的旧方案旧结论继续留在库里，只会误导之后的会话。',
  '3. 有没有已完成的 todo 条目？ → 设 status = stale（视为done）；',
  '4. 有没有错误的、过于琐碎、你现在看它根本不重要的条目？ → 设 status=archived；',
  '5. 有没有曾经的bug已被修复，曾经的lesson已不再适用？ → 修改内容，或者设 status=archived；',
  '6. 有没有发现互相矛盾的条目？ → 按你所知道的事实修改。保留最新事实，旧版本设 status=archived；',
  '7. 现在回头去看，那些记忆的 importance 标记是否正确（按记忆系统 importance 准则核查）？注意：不要轻易将信息标记为高重要性——工作进展类的重要性一般是1，最多只到2，很严重的事情才能用3；发现虚标的应调低；',
  '8. 有没有哪条记忆太长，信息太多？→ 拆分成多条，可用update修改，或remember新建新条目。',
  '9. 记忆的关键词是否准确？→ 如果准确就不使用keywords参数，如果你觉得关键词不准，请使用memory_update的keywords参数更新它——当用户prompt命中某条记忆的关键词，它就会被提取。所以你需要反向思考，"你希望在用户prompt提及哪些词的时候，这条记忆被检索到？"以此作为关键词的写入标准。不要用项目名当关键词，用更加针对这条记忆本身的信息作为关键词。优先提取核心实体、语义中心、专有名词。8-13个。',
  '10. project标签是否准确？是否有些信息应该是全局信息但被错误的标记了project？那应该删去project标记。是否有些信息明明属于某个project，却没写project信息？那应该加上。',
  '11. 学而不思则罔，更多抽象泛化：',
  '- 这是总结抽象框架的极好时机，你看看有没有可以总结沉淀的通用规则？可添加新记忆。',
  '- 你现在对某些记忆条目可能有更好更深刻地理解，你可以更新他们。',
  '12. 看一下首轮注入的内容，你现在觉得那些内容都重要吗？有必要每个session首轮注入吗？如果有不重要的，你可以降低他们的importance或者将他们移动到其他level（比如fact）。',
  '首轮只注入：soul（AI 自身）/ user（用户偏好）/ 全局 rules（importance≥2）。想加入首轮：全局规则类 → 移入 rules 且 importance≥2（project 填"全局"）；用户相关 → 移入 user；AI 自身 → 移入 soul。',
  '13. memory_project 展示的是 project 层条目（todo 已完成只列最近 5 条）+ 项目特定 rules；上面的检查同样适用（todo 完成标 stale、过时标 archived、project 标签准确）。',
  '',
  '说明：',
  '重要：务必逐条检查，把过时记忆、误导你的记忆归档，或者修改——两者优先选择归档。',
  '对于你认为非常重要的记忆，如果不确定事实到底如何，你可以直接翻项目文件来核实。仅对非常重要的记忆使用。',
  '完成后直接回复"本组整理完成"，不要调用其他工具。',
]

/** 第 2 轮（topic）开头介绍段（在【本组记忆】之前）。 */
const TOPIC_INTRO = [
  'topic是一种特殊的记忆，它追踪一个话题的起因经过发展结果，为AI提供更全局的、事件发展的视野。',
  '一个topic只说一件事的前因后果发展脉络，依然要求信息要聚焦在这一件事上，不可跑题。',
  '如果一个topic的事件链太长、细节太多，你也可以将其拆分成更小的事件。',
  '如果你发现有不同的topic条目在说同一件事，可以将它们合并。',
  '如果你发现有topic记录混乱，比如一件事的前因在topic A，后果在topic B，但topic A和B分别还有其他乱七八糟的信息，你应该综合考虑这些事情发展脉络，将它们整理清楚。用最合理最清楚的方式把这些信息分解成几件事、几条发展脉络，每件事一个topic。',
]

/** 第 2 轮（topic 记忆）更新指导（用户拍板 2026-08-19 终稿 v2：默认触发 + 回顾建新 topic）。 */
const TOPIC_GUIDE = [
  '# topic记忆更新指导——',
  '1. 请你根据最新信息判断：这些topic中描述的事情，他们有新的发展、新的重要信息吗？请及时更新。你可以重新起草topic，将该话题的新进展加入，旧信息点如果你认为不再重要，可以删减。',
  '2. 请你回顾对话历史，是否有新的topic可以存下？如有，请创建。如果你的任务没检索到任何topic记忆，那很可能就是一个新topic。',
  '3. 有没有哪些topic说的太庞杂跑题了，如果提了好几件事，你认为应该拆分，你可以把一个大topic拆成几个子topic（新建topic）。',
  '4. 有没有哪几个topic其实在说同一件事，应该合并？请你合并。',
  '5. 有没有哪几个topic信息交叉混乱，你认为应该将它们的信息合并后重新拆分，这样才能更清晰的分割成两件事？请你重写他们。',
  '6. 更新topic时，你依然需要反向思考，"我写这条topic记忆是为了提供哪些信息？别人看到这条topic能看明白这个话题/事件的发展脉络吗？"',
  '7. 写/改topic时，同时总结该topic记忆的关键词（提取 8-13 个内容词供检索；"你希望在用户提及什么关键词时，AI能看到这条记忆"）。',
  '8. 要记录project信息（project名，或全局）、importance。',
  '9. 对于你认为非常重要的topic，如果不确定事实到底如何，你可以直接翻项目文件来核实。仅对非常重要的记忆使用。',
  '10. 重要：务必检查这些topic有没有过时的、被推翻的、被证明无效的、会误导你的内容——有则归档（status=archived）或重写（优先归档），绝不要让它们保持active；importance也别轻易标高：普通话题进展一般1、最多2，很严重的事才3。',
  '11. 完成后直接回复"本组整理完成"，不要调用其他工具。',
]

/** 第 3 轮（项目总结）指导（用户拍板 2026-08-22，prompt 以用户原话为主体）。 */
const PROJECT_SUMMARY_GUIDE = [
  '# 项目总结指导——',
  '1. memory_project 返回的内容可能太啰嗦了。如果确实啰嗦冗杂，你必须把它们总结成新的精简的记忆条目（用 memory_remember 新建，level=project）；如果本来就很精炼，就不要强行动它。',
  '2. 具体总结多少条由你决定，只总结你认为真正重要的东西。',
  '3. 要明白：你总结的记忆会成为这个项目的长期记忆，以后其他窗口做这个项目时，他们会首先看到这一段。所以你的总结应对他们有指导意义——能帮助他们快速明白用户的要求，以及这个项目本身是要干什么、概况是什么、重要的架构和设计理念是什么。',
  '4. 你依然应该总结成一条一条的记忆，每一条里面只讲一个要点；为每条选合适的 subcategory（overview=概况 / structure=架构 / decisions=设计决策 / ops=部署数据 / todo=待办），关键词 8-13 个，importance 不要虚标。',
  '5. 总结完成后，你需要将 memory_project 返回的、已被你的新总结取代的旧记忆归档（memory_update 设 status=archived），不要让新旧两套描述并存。没有被你的总结覆盖、仍有独立价值的条目（例如还没做完的 todo、独特的教训）保留不动，不要为了归档而归档。',
  '6. 完成后直接回复"本组整理完成"，不要调用其他工具。',
]

/** 构造一轮 dream 指令消息（各轮共用头部：封存时间戳 + 时间戳规则）。 */
export function buildDreamMessage(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  T: number,
  rounds: DreamRound[],
  idx: number,
): ReturnType<typeof createUserMessage> {
  const round = rounds[idx]
  const lines: string[] = [
    `${DREAM_MARKER} 记忆整理任务（dream）`,
    '',
    `本窗口记忆封存时间戳：${formatTime(T)}`,
    '如果其他窗口在此时间戳之后有新进展，你是不知道的。所以如果遇到记忆和你所知的上下文冲突，你需要根据时间戳来判断，是那条记忆错了，还是你信息落后了，来考虑要不要修改它。',
    '',
    '时间戳规则：',
    '所有展示给你的时间戳，都是那条记忆的**最后更新**时间戳。',
    '因为你现在看到的是很长时间的完整上下文，所以"几小时前"这种相对时间戳其实一直在变，不值得参考。此时你需要看的是绝对时间戳来判断记忆信息的新旧。',
    '',
    '',
    `第 ${idx + 1}/${rounds.length} 组 - ${round.kind === 'topic' ? 'topic记忆条目' : round.kind === 'project-summary' ? '项目总结' : '原子记忆条目'}`,
    '',
  ]
  if (round.kind === 'project-summary') {
    // 项目总结轮：不带条目列表——AI 自己逐个调 memory_project 看当前项目描述（用户拍板 2026-08-22）。
    lines.push(
      '对于你一直在进行的项目，请再次使用 memory_project 工具，再看一眼记忆对项目的描述，然后请你精简它们。',
      `本组涉及的项目：${(round.projects ?? []).join('、')}`,
      '',
      ...PROJECT_SUMMARY_GUIDE,
    )
  } else {
    if (round.kind === 'topic') lines.push(...TOPIC_INTRO, '')
    lines.push('【本组记忆】：')
    if (round.groups.length === 0) {
      // topic 轮默认触发：空列表时提示 AI 回顾对话建新 topic（对应指导 2）。
      lines.push('（本组暂无已建立的 topic 记忆——回顾对话历史，如有新 topic 请按下方指导 2 创建）')
    }
    for (const g of round.groups) {
      lines.push('', `【project：${g.name === '' ? '无项目 - 全局信息，或缺少项目标签' : g.name}】`)
      for (const r of g.rows) lines.push(formatRow(r))
    }
    lines.push('', ...(round.kind === 'topic' ? TOPIC_GUIDE : ATOMIC_GUIDE))
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

/** 扫描判定：窗口需要 dream 吗？ */
export function windowNeedsDream(w: { last_event_time: number; last_dream_time: number | null }, now = Date.now()): boolean {
  if (now - w.last_event_time > 24 * 3600_000) return false // 超过 24h 的旧窗口不碰
  return (w.last_dream_time ?? 0) < w.last_event_time
}

/** dream 状态信号回调：'dreaming' = dream 开始（租约抢占成功），'dreamed' = 整理完成/收尾。 */
export type DreamStateCallback = (sessionId: string, state: 'dreaming' | 'dreamed') => void

/**
 * 启动一个窗口的 dream（steer 第一组）。agent 必须是该窗口的 live 顶层 agent。
 * 返回 false 表示无法启动（已有任务在跑 / 别处（含其他进程）正在 dream / 无记忆可整理）。
 * 防重复：DB 原子抢占 dream_pending 标记（跨进程/重启一致）——抢占失败即不 start；
 * 抢占成功后即使本进程崩溃/被重载，下个检查周期也会补收尾而不是重复 start。
 */
export function startWindowDream(ctx: Context, agent: { session?: { header?: { id?: string } } }, workspace: string, dir = '.dsh-meow', onDreamState?: DreamStateCallback, rulesReviewDays = 2): boolean {
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
  ;(agent as { steer?: (m: unknown) => void }).steer?.(msg)
  dreamLog(workspace, dir, `dream start pid=${process.pid} session=${shortSessionId(sessionId)} rounds=${rounds.length} T=${T}`)
  return true
}

/**
 * turn-stopping 推进：本 turn 是 dream 轮 → 下一组或收尾。
 * 状态完全从 DB 租约读：跨实例、热重载残留、中止都不影响推进正确性。
 * 推进按「sessionId + 租约未过期」判定，不校验 owner（owner 只用于抢占判断 + 诊断）。
 */
export function advanceDream(agent: unknown, dir = '.dsh-meow', onDreamState?: DreamStateCallback, rulesReviewDays = 2): void {
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
      ;(agent as { steer?: (m: unknown) => void }).steer?.(msg)
      dreamLog(ws, dir, `dream group ${nextIdx + 1}/${rounds.length} steered`)
    }
    return
  }
  // 最后一轮完成 → 收尾
  finalizeDream(db, sessionId, ws, dir, lease.T, 'done', rounds.length, onDreamState)
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

export function dreamTool(ctx: Context, dir = '.dsh-meow', onDreamState?: DreamStateCallback, rulesReviewDays = 2): ToolDefinition {
  return {
    name: 'memory_dream',
    description: '立即为本窗口安排一次记忆整理（dream）：把本窗口建立过/提取过的记忆逐轮发给主 agent 整理封存（第 1 轮=原子记忆 project/fact/lesson/rules/soul/user，第 2 轮=topic 记忆，第 3 轮=项目总结——仅当本窗口涉及具体项目时追加）。窗口空闲 3 小时以上自动触发（北京时间峰时 9-12 点/14-18 点及各自前 15 分钟不触发），此工具用于手动触发。',
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
      const ok = startWindowDream(ctx, exec.agent, workspace, dir, onDreamState, rulesReviewDays)
      if (ok) return { ok, note: '整理指令已发出，逐个项目组处理中。' }
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
export function dreamCommandDefinition(ctx: Context, dir = '.dsh-meow', onDreamState?: DreamStateCallback, rulesReviewDays = 2): DreamCommandDefinition {
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
      if (ok) return { kind: 'success', text: '🧠 dream 已安排：整理指令已发出，逐组处理中。' }
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
        dreamLog(workspace, dir, `check agent-missing sid=${shortSessionId(sessionId)}`)
        continue // 进程内无该窗口 agent（重启后）：跳过
      }
      const started = startWindowDream(ctx, agent as never, workspace, dir, onDreamState, cfg.rulesReviewDays)
      if (started) return // 一轮一个窗口
    }
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
