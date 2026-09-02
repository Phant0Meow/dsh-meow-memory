/**
 * meow-memory v2 — 会话开头注入。
 *
 * 结构（用户拍板）：soul/user 全量 + 记忆导引（project/topic 标题列表，
 * 正文模型自取）+ 第一条用户消息关键词命中 fact/lesson 短条目自动注入。
 * 无每轮注入——模型自己用 memory_search 深挖。
 *
 * 去重：.dsh-meow/sessions/<sessionId>.json 记录本会话注入过的 memory id，
 * 已注入不重复。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Doc } from './bm25.js'
import { keywordHitScore, search, tokenize } from './bm25.js'
import { isGlobalProject, memoryDbPath, projectCovers, projectLabel, relativeTime, PROJECT_SUBCATEGORIES, type MemoryDb, type MemoryRow, type ProjectSubcategory } from './db.js'
import { fillTemplate, keyedValue } from './prompt-loader.js'

export interface InjectOptions {
  /** 关键词命中条数上限（fact/lesson 短条目）。 */
  hitTopK: number
  /** 导引里 project/topic 标题超长截断长度。 */
  titleMax: number
}

const DEFAULT_OPTS: InjectOptions = { hitTopK: 2, titleMax: 40 }

export function sessionsFile(workspace: string, sessionId: string, dir = '.dsh-meow'): string {
  return join(workspace, dir, 'sessions', `${sessionId}.json`)
}

/** 会话记忆可见集：injected=注入过的，searched=search/find_similar 返回过的，
 *  accessed=memory_read 读过的（v0.17.0，dream 第一轮清单的"查阅"源）。
 *  前两者是"本会话上下文里已经出现过的记忆"，检索时应排除（省 token、扩大检索面）；
 *  accessed 只服务 dream 扫尾范围（读过的条目该被复查），不参与命中去重。 */
export interface SessionSeen {
  injected: string[]
  searched: string[]
  accessed: string[]
  /** 本会话 AI 调 memory_project 查阅过的项目名（v0.21.0，按查询顺序、去重、
   *  最多保留 MAX_REINJECT_PROJECTS 个最近项）：会话压缩后重注入项目全景的清单。
   *  '全局' 不记（全局 soul/user/rules 已在快照层，非项目）；多项目参数按逗号拆开记。 */
  projectsQueried: string[]
  /** 压缩成功落地后置 true（v0.21.0）：下一个含真实用户消息的 pre-step 注入
   *  压缩重注入块（长期记忆快照 + 项目全景），随后清回 false。 */
  reinjectPending: boolean
  /** 当前 project 锚定（最近一次带 project 参数的 memory 工具调用）：命中检索限定"全局+当前项目"。 */
  currentProject: string | null
}

/** projectsQueried 保留上限：压缩重注入的项目全景个数上限（防极端会话注入膨胀）。 */
export const MAX_REINJECT_PROJECTS = 8

function readSeenFile(workspace: string, sessionId: string, dir: string): SessionSeen {
  try {
    const text = readFileSync(sessionsFile(workspace, sessionId, dir), 'utf8')
    const parsed = JSON.parse(text) as Record<string, unknown>
    return {
      injected: Array.isArray(parsed.injected) ? parsed.injected.filter((x): x is string => typeof x === 'string') : [],
      searched: Array.isArray(parsed.searched) ? parsed.searched.filter((x): x is string => typeof x === 'string') : [],
      accessed: Array.isArray(parsed.accessed) ? parsed.accessed.filter((x): x is string => typeof x === 'string') : [],
      projectsQueried: Array.isArray(parsed.projectsQueried) ? parsed.projectsQueried.filter((x): x is string => typeof x === 'string') : [],
      reinjectPending: parsed.reinjectPending === true,
      currentProject: typeof parsed.currentProject === 'string' && parsed.currentProject.length > 0 ? parsed.currentProject : null,
    }
  } catch {
    return { injected: [], searched: [], accessed: [], projectsQueried: [], reinjectPending: false, currentProject: null }
  }
}

/** 统一写 sessions/<id>.json（全部字段一次写全——新增字段只改这里，防散落漏写）。 */
function writeSeenFile(workspace: string, sessionId: string, seen: SessionSeen, dir: string): void {
  const file = sessionsFile(workspace, sessionId, dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({
    injected: seen.injected,
    searched: seen.searched,
    accessed: seen.accessed,
    projectsQueried: seen.projectsQueried,
    reinjectPending: seen.reinjectPending,
    currentProject: seen.currentProject,
  }), 'utf8')
}

/** 读本会话已注入 id 列表（文件不存在返回空数组）。 */
export function readInjected(workspace: string, sessionId: string, dir = '.dsh-meow'): string[] {
  return readSeenFile(workspace, sessionId, dir).injected
}

/** 追加写入已注入 id。 */
export function markInjected(workspace: string, sessionId: string, ids: string[], dir = '.dsh-meow'): void {
  if (ids.length === 0) return
  const seen = readSeenFile(workspace, sessionId, dir)
  const set = new Set(seen.injected)
  for (const id of ids) set.add(id)
  seen.injected = [...set]
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 本会话全部"已见" id（注入 + 检索 + 查阅），dream 第一轮清单范围 + 检索排除用。 */
export function readSeen(workspace: string, sessionId: string, dir = '.dsh-meow'): Set<string> {
  const s = readSeenFile(workspace, sessionId, dir)
  return new Set([...s.injected, ...s.searched, ...s.accessed])
}

/** 追加已检索返回的 id（memory_search / memory_find_similar 命中后调用）。 */
export function markSearched(workspace: string, sessionId: string, ids: string[], dir = '.dsh-meow'): void {
  if (ids.length === 0) return
  const seen = readSeenFile(workspace, sessionId, dir)
  const set = new Set(seen.searched)
  for (const id of ids) set.add(id)
  seen.searched = [...set]
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 追加 memory_read 读过的 id（v0.17.0）：dream 第一轮"查阅过"源。
 *  只由 memory_read 单条读取触发；memory_project 全景不标记（第三轮项目总结专门复查）。 */
export function markAccessed(workspace: string, sessionId: string, ids: string[], dir = '.dsh-meow'): void {
  if (ids.length === 0) return
  const seen = readSeenFile(workspace, sessionId, dir)
  const set = new Set(seen.accessed)
  for (const id of ids) set.add(id)
  seen.accessed = [...set]
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 记录 memory_project 查阅过的项目（v0.21.0）：压缩重注入清单。
 *  全局标记（isGlobalProject，语言感知）/空串跳过；多项目参数按逗号拆开逐个记；
 *  重复查询移到末尾（最近优先）；超过 MAX_REINJECT_PROJECTS 淘汰最旧的。 */
export function markProjectQueried(workspace: string, sessionId: string, project: string, dir = '.dsh-meow'): void {
  const names = project.split(',').map((p) => p.trim()).filter((p) => p.length > 0 && !isGlobalProject(p))
  if (names.length === 0) return
  const seen = readSeenFile(workspace, sessionId, dir)
  const ordered = seen.projectsQueried.filter((p) => !names.includes(p))
  ordered.push(...names)
  seen.projectsQueried = ordered.slice(-MAX_REINJECT_PROJECTS)
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 读本会话查阅过的项目清单（压缩重注入用；文件不存在返回空数组）。 */
export function readProjectQueried(workspace: string, sessionId: string, dir = '.dsh-meow'): string[] {
  return readSeenFile(workspace, sessionId, dir).projectsQueried
}

/** 压缩成功落地后置位（compaction/end 无 error 时调用）：下一个含真实用户消息的
 *  pre-step 注入压缩重注入块。 */
export function markReinjectPending(workspace: string, sessionId: string, dir = '.dsh-meow'): void {
  const seen = readSeenFile(workspace, sessionId, dir)
  if (seen.reinjectPending) return
  seen.reinjectPending = true
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 清除重注入待办（重注入块注入完成后调用；幂等）。 */
export function clearReinjectPending(workspace: string, sessionId: string, dir = '.dsh-meow'): void {
  const seen = readSeenFile(workspace, sessionId, dir)
  if (!seen.reinjectPending) return
  seen.reinjectPending = false
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 读重注入待办标记。 */
export function isReinjectPending(workspace: string, sessionId: string, dir = '.dsh-meow'): boolean {
  return readSeenFile(workspace, sessionId, dir).reinjectPending
}

/** 释放本会话已见记录（收到会话压缩信号后调用）：清空 injected/searched，
 *  允许之前注入/检索过的记忆被再次命中提取——压缩后它们的内容已不在上下文里。
 *  accessed 不清（用户拍板 2026-08-25）：它只服务 dream 扫尾范围、没有去重功能，
 *  清掉纯丢信息——长窗口压缩前读过的条目恰恰最该被 dream 复查。
 *  当前 project 锚定保留（与可见性无关）；projectsQueried/reinjectPending 保留
 *  （它们正是压缩重注入的数据源，见 buildReinjection）。 */
export function releaseSeen(workspace: string, sessionId: string, dir = '.dsh-meow'): void {
  const seen = readSeenFile(workspace, sessionId, dir)
  seen.injected = []
  seen.searched = []
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 读当前 project 锚定（最近一次带 project 参数的 memory 工具调用）；未锚定返回 null。 */
export function getCurrentProject(workspace: string, sessionId: string, dir = '.dsh-meow'): string | null {
  return readSeenFile(workspace, sessionId, dir).currentProject
}

/** 锚定当前 project：memory 工具调用带 project 参数时更新会话状态（命中检索用它，免扫历史）。 */
export function setCurrentProject(workspace: string, sessionId: string, project: string, dir = '.dsh-meow'): void {
  const seen = readSeenFile(workspace, sessionId, dir)
  seen.currentProject = project
  writeSeenFile(workspace, sessionId, seen, dir)
}

function toDocs(rows: MemoryRow[]): Doc[] {
  return rows.map((r) => ({
    id: r.id,
    level: r.level,
    title: r.title,
    content: r.content,
    keywords: r.keywords,
    importance: r.importance,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }))
}

function shortTitle(row: MemoryRow, max: number): string {
  const t = row.title?.trim()
  if (t) return t.length > max ? t.slice(0, max) + '…' : t
  const c = row.content.replace(/\s+/g, ' ').trim()
  return c.length > max ? c.slice(0, max) + '…' : c
}
/* v8 ignore next -- 保留工具函数（历史/调试用），当前导引不再截断标题 */
void shortTitle

/**
 * 构造长期记忆快照正文（buildInjection / buildReinjection 共用）：
 *   顶格「===== 长期记忆 =====」→ 【关于你】(soul) / 【关于user】/ 【设计原则】/ 【记忆导引】(两行)。
 * 不含结束标记与「本轮用户prompt：」尾巴（两链路各自拼装），也不做已见记账（调用方负责）。
 * @returns null = 只有标题头，无任何可注入内容。
 */
function buildInjectionBody(
  db: MemoryDb,
  o: InjectOptions,
): { body: string; injectedIds: string[] } | null {
  void o // 导引不再截断标题；保留参数位以维持两链路签名对称
  // 框架词外置（v0.19.0）：labels.md 的 inject.* 键；记忆条目正文本身是数据不是文案，不外置。
  const lbl = (key: string, params?: Record<string, string>): string => fillTemplate(keyedValue('labels', key), params)
  const soul = db.list('soul', { status: 'active' })
  const user = db.list('user', { status: 'active' })

  const lines: string[] = [lbl('inject.title'), '']
  const injected: string[] = []

  const pushEntries = (label: string, rows: MemoryRow[]) => {
    if (rows.length === 0) return
    lines.push(lbl('inject.sectionFormat', { label }))
    for (const r of rows) {
      lines.push(`- ${r.content}`)
      injected.push(r.id) // 正文已注入 → 记入已见（命中链路不再重复注入）
    }
    lines.push('')
  }

  pushEntries(lbl('inject.aboutYou'), soul)
  pushEntries(lbl('inject.aboutUser'), user)

  // 设计原则（rules）：只注入「全局（project 为空）且 importance≥2」的——少而精的命令式准则。
  const globalRules = db.list('rules', { status: 'active' }).filter((r) => r.project === null && r.importance >= 2)
  pushEntries(lbl('inject.rules'), globalRules)

  // 记忆导引：说明 + 项目列表（正文/标题一律自取，不列）。
  const projectNames = db.listProjectNames()
  if (projectNames.length > 0) {
    lines.push(lbl('inject.sectionFormat', { label: lbl('inject.guide') }))
    lines.push(lbl('inject.guideSearchLine'))
    lines.push(lbl('inject.guideProjectLine'))
    lines.push(lbl('inject.guideProjects', { list: projectNames.join(' / ') }))
    lines.push('')
  }

  if (lines.length <= 2) return null // 只有标题头，无任何内容
  return { body: lines.join('\n').trimEnd(), injectedIds: injected }
}

/**
 * 构造首轮长期记忆注入块（用户拍板格式，PR #10 起为独立 plugin snapshot 正文）：
 *   顶格「===== 长期记忆 =====」→ 【关于你】(soul) / 【关于user】/ 【设计原则】/ 【记忆导引】(两行)。
 *   不再拼接结束标记与「本轮用户prompt：」尾巴——正文作为独立消息插在真实用户消息前，
 *   用户 prompt 保持原样（防会话标题污染；旧格式历史会话由前端折叠兼容）。
 * 首轮只注入长期记忆，不做关键词命中（命中链路从第二轮起，见 buildHitInjection）；
 * 正文注入的 id 记入已见（命中链路不再重复注入它们）。
 * @returns { text, injectedIds }；无任何可注入内容返回 null。
 */
export function buildInjection(
  db: MemoryDb,
  workspace: string,
  sessionId: string,
  _firstUserText: string = '',
  opts: Partial<InjectOptions> = {},
  dir = '.dsh-meow',
): { text: string; injectedIds: string[] } | null {
  const o = { ...DEFAULT_OPTS, ...opts }
  const built = buildInjectionBody(db, o)
  if (built === null) return null
  const text = built.body
  if (built.injectedIds.length > 0) markInjected(workspace, sessionId, built.injectedIds, dir)
  return { text, injectedIds: built.injectedIds }
}

/** 框架词（labels.md）：项目全景段落里的短词随语言包走（PR #6 外置，zh 值逐字不变）。 */
const lbl = (key: string, params?: Record<string, string>): string => fillTemplate(keyedValue('labels', key), params)
/** 子标签 → 注入段落标题（文案外置：labels.md 的 project.section.*）。 */
const sectionTitle = (sub: ProjectSubcategory): string => lbl(`project.section.${sub}`)

/** 组内排序：记忆时间戳（updated_at）旧→新，相同按创建时间；null 视为最旧。 */
function sortByUpdatedAt(list: MemoryRow[]): MemoryRow[] {
  return [...list].sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0) || a.created_at - b.created_at)
}

/** 项目全景条目行（原文视图）：归属 + 完整 id + 绝对/相对时间戳，第二行完整内容。
 *  归属显示：'全局'=真全局；null=未标记（可能是数据 bug）；多值 join '/'。 */
function fmtProjectRow(r: MemoryRow): string {
  const abs = new Date(r.updated_at).toISOString().slice(0, 16).replace('T', ' ')
  return `[${projectLabel(r.project)} : ${r.level}] [${r.id}] ${abs} [${relativeTime(r.updated_at)}]\n${r.content}`
}

/**
 * 构造项目全景注入段落（memory_project 工具与压缩重注入共用，v0.21.0 从 tools.ts 迁入）：
 * 【项目：X】+ 项目设计原则(rules，放最前——规则优先于事实) + 各子标签分组
 * （组内按记忆时间戳旧→新；todo 含已完成最近 5 条）+ 检索说明尾注。
 * 非 todo 子标签只取 active；条目正文本身是数据，不做文案外置。
 * @returns null = 项目无任何可注入段落（active 条目与已完成 todo 皆空）。
 */
export function buildProjectSectionText(db: MemoryDb, workspace: string, project: string, dir = '.dsh-meow'): string | null {
  const rows = db.list('project', { project }).filter((r) => r.project === project)
  const active = rows.filter((r) => r.status === 'active')
  // todo 已完成：stale 且 updated_at 非空，按 updated_at 取最近 5 条（展示仍按旧→新）。
  const done = sortByUpdatedAt(
    rows
      .filter((r) => r.subcategory === 'todo' && r.status === 'stale' && r.updated_at !== null)
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, 5),
  )
  const bySub = new Map<ProjectSubcategory, MemoryRow[]>()
  for (const r of active) {
    const sub = r.subcategory ?? 'overview' // 早期无子类条目归概述组
    const list = bySub.get(sub) ?? []
    list.push(r)
    bySub.set(sub, list)
  }
  const sections: string[] = []
  // 项目设计原则（rules，project 特定）：放最前——规则优先于事实。
  const projectRules = sortByUpdatedAt(
    db.list('rules', { project }).filter((r) => r.project === project && r.status === 'active'),
  )
  if (projectRules.length > 0) {
    sections.push(`${lbl('inject.rules')}\n${projectRules.map(fmtProjectRow).join('\n')}`)
  }
  for (const sub of PROJECT_SUBCATEGORIES) {
    if (sub === 'todo') {
      const todos = sortByUpdatedAt(bySub.get('todo') ?? [])
      if (todos.length === 0 && done.length === 0) continue
      const lines = [sectionTitle('todo')]
      if (done.length > 0) {
        lines.push(lbl('project.todoDone'))
        for (const r of done) lines.push(fmtProjectRow(r))
      }
      if (todos.length > 0) {
        lines.push(lbl('project.todoOpen'))
        for (const r of todos) lines.push(fmtProjectRow(r))
      }
      sections.push(lines.join('\n'))
    } else {
      const list = sortByUpdatedAt(bySub.get(sub) ?? [])
      if (list.length === 0) continue
      sections.push(`${sectionTitle(sub)}\n${list.map(fmtProjectRow).join('\n')}`)
    }
  }
  if (sections.length === 0) return null
  const dbPath = memoryDbPath(workspace, dir)
  return [
    lbl('project.header', { name: project }),
    '',
    sections.join('\n\n'),
    '',
    '——',
    '说明：此处只提供 active 的记忆。',
    `如果你想看非 active 条目（archived=删除 / stale=完结），或某条记忆的具体时间戳（记忆时间戳=该窗口 dream 封存时刻）、记忆来源（source_session）、重要性、关键词等元数据，可以直接去搜记忆库 SQLite：${dbPath}`,
    '（库内结构：七层表 soul/user/project/fact/lesson/topic/rules，字段含 id/title/content/importance/keywords/status/corrected/project/subcategory/goal/source_session/created_at/updated_at（记忆时间戳=最后更新时间）/last_accessed_at；另有 dream_log 整理留痕表、windows 窗口时间表；也可按 id 用 memory_read 看单条完整元数据）',
    `如果你想了解未被记录的更多细节，可以直接去搜会话历史目录（dsh 的 session 日志，位置由 DSH_HOME 决定，默认 ~/.dsh/sessions，喵版为 dsh-home/sessions），按会话 id 查原始记录。`,
  ].join('\n')
}

/**
 * 构造压缩重注入块（v0.21.0）：长期记忆快照正文（与首轮 buildInjection 同款）+
 * 【会话已压缩】说明 + 本会话此前查阅过的项目全景（按当前库最新数据重新构造，
 * 空项目跳过；项目全景条目按现行原则不标记已见）。不拼尾注（PR #10 起）：
 * 正文作为独立 plugin snapshot 消息插在真实用户消息前，用户 prompt 保持原样。
 * 快照条目 id 重新记入 injected——压缩后内容重新进入上下文，去重语义随之恢复。
 * @returns null = 无任何可注入内容（库无快照正文且项目全空）；调用方仍应清除
 *          reinjectPending，避免每个用户消息轮空转重查。
 */
export function buildReinjection(
  db: MemoryDb,
  workspace: string,
  sessionId: string,
  projects: readonly string[],
  opts: Partial<InjectOptions> = {},
  dir = '.dsh-meow',
): { text: string; injectedIds: string[] } | null {
  const o = { ...DEFAULT_OPTS, ...opts }
  const snapshot = buildInjectionBody(db, o)
  const projectTexts: string[] = []
  for (const project of projects) {
    const text = buildProjectSectionText(db, workspace, project, dir)
    if (text !== null) projectTexts.push(text)
  }
  if (snapshot === null && projectTexts.length === 0) return null
  const lines: string[] = []
  if (snapshot !== null) {
    lines.push(snapshot.body)
    lines.push('')
  }
  if (projectTexts.length > 0) {
    lines.push(lbl('inject.sectionFormat', { label: lbl('inject.reinjectSection') }))
    lines.push(lbl('inject.reinjectIntro'))
    lines.push('')
    lines.push(projectTexts.join('\n\n'))
    lines.push('')
  }
  const text = lines.join('\n').trimEnd()
  if (snapshot !== null && snapshot.injectedIds.length > 0) markInjected(workspace, sessionId, snapshot.injectedIds, dir)
  return { text, injectedIds: snapshot !== null ? snapshot.injectedIds : [] }
}

/** 关键词命中查询（首轮与每条消息链路共用）：active 的 fact/lesson/rules/topic，
 *  范围=全局 或 当前 project 锚定；排除本会话已见（injected+searched）；
 *  不检索本 session 建立的记忆（它们就在上下文里，AI 最清楚，无需命中）。
 *  命中打分基于条目关键词（keywords，+title）而非全文——全文匹配噪音大
 *  （常见 bigram 如"的时"每条消息都有，长条目一碰词就整条注入）。 */
function hitQuery(
  db: MemoryDb,
  workspace: string,
  sessionId: string,
  userText: string,
  o: InjectOptions,
  dir: string,
): Array<{ id: string; level: string; content: string; updated_at: number | null }> {
  const currentProject = readSeenFile(workspace, sessionId, dir).currentProject
  const hitRows = [
    ...db.list('fact', { status: 'active' }),
    ...db.list('lesson', { status: 'active' }),
    ...db.list('rules', { status: 'active' }),
    ...db.list('topic', { status: 'active' }),
  ].filter((r) =>
    (r.project === null || isGlobalProject(r.project) || (currentProject !== null && projectCovers(r.project, currentProject)))
    && r.source_session !== sessionId, // 本 session 建立的记忆在上下文里，不命中
  )
  if (hitRows.length === 0) return []
  const query = userText.slice(0, 500)
  const docs = toDocs(hitRows).map((d) => ({
    ...d,
    // 匹配面 = 条目关键词（LLM 提取或自动 bigram；无关键词的旧条目回退内容前 100 字）。
    content: d.keywords.length > 0 ? d.keywords.join(' ') : d.content.slice(0, 100),
  }))
  // 命中专用打分：交集×覆盖率×艾宾浩斯(updated_at)×importance×title 加成（艾宾浩斯开着）。
  const hits = keywordHitScore(query, docs, { k: o.hitTopK })
  const byId = new Map(hitRows.map((r) => [r.id, r]))
  // 展示/注入用原文 content（docs 的 content 只是 keywords 匹配面，不能当正文）。
  return hits
    .filter((h) => !readInjected(workspace, sessionId, dir).includes(h.id))
    .map((h) => {
      const row = byId.get(h.id)
      return { id: h.id, level: h.level, content: row?.content ?? h.content, project: row?.project ?? null, updated_at: row?.updated_at ?? null }
    })
}

/**
 * 每条用户消息的关键词命中注入（独立于首轮注入的链路）：
 * 检索 active 的 fact/lesson/rules/topic（全局+当前锚定项目），top-K 命中注入，
 * 命中 id 记入本会话已见（之后不再命中；压缩释放 seen 后恢复）。
 * 格式：顶格「可能相关的记忆，仅供参考：」→ 条目（- [id] 换行接内容、
 * 条目间空行）。返回文本作为独立 plugin snapshot 消息的正文。
 * @returns 命中注入块；无命中返回 null。
 */
export function buildHitInjection(
  db: MemoryDb,
  workspace: string,
  sessionId: string,
  userText: string,
  opts: Partial<InjectOptions> = {},
  dir = '.dsh-meow',
): { text: string; injectedIds: string[] } | null {
  const o = { ...DEFAULT_OPTS, ...opts }
  const fresh = hitQuery(db, workspace, sessionId, userText, o, dir)
  if (fresh.length === 0) return null
  const lines = [keyedValue('labels', 'inject.hitHeader')]
  for (const h of fresh) {
    // 原文视图：归属 + 完整 id + 绝对/相对时间戳（记忆时间戳=updated_at 最后更新时间；无时间戳不显示），第二行完整内容。
    const proj = projectLabel(h.project)
    const time = h.updated_at
      ? ` ${new Date(h.updated_at).toISOString().slice(0, 16).replace('T', ' ')} [${relativeTime(h.updated_at)}]`
      : ''
    lines.push(`[${proj} : ${h.level}] [${h.id}]${time}`)
    lines.push(h.content)
    lines.push('')
  }
  const text = lines.join('\n').trimEnd()
  const ids = fresh.map((h) => h.id)
  markInjected(workspace, sessionId, ids, dir)
  return { text, injectedIds: ids }
}

// 导出 tokenize 供索引/测试复用
export { tokenize }
