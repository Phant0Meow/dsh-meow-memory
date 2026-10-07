/**
 * meow-memory v2 — 工具面：memory_remember / memory_search / memory_read / memory_update。
 *
 * 写规则（进 description 给模型看）：
 * - fact/lesson 一句话直陈 ≤60 字（短是关键词命中注入的前提）；
 * - 用户介绍项目设计思路/框架/决策理由的原话必须保留措辞，不转述（project/lesson）；
 * - project 必填项目名（femo / meow-memory / meow-eyes / dsh …）；
 * - topic 必填标题（对象+动作，禁宽泛名）+ 建议目标句。
 */

import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import { findSimilar, search, tokenize, type RankedHit } from './bm25.js'
import { getDb, getDreamWorkspace, globalProjectMarker, isGlobalProject, projectCovers, projectLabel, projectList, relativeTime, type Level, LEVELS, type MemoryPatch, type MemoryRow, type ProjectSubcategory, PROJECT_SUBCATEGORIES } from './db.js'
import { fillTemplate, keyedValue } from './prompt-loader.js'
import { activeHomeDir, homeDirPresets, resolveHomeDir, switchHomeDir } from './home-dir.js'

/** tools.md 键值取用（prompt 文案外置 v0.19.0）：缺键时 keyedValue throw。 */
const T = (key: string): string => keyedValue('tools', key)
/** 框架词/报错文案（labels.md）：与工具描述同源，随语言包走。 */
const L = (key: string, params?: Record<string, string>): string => fillTemplate(keyedValue('labels', key), params)
import { buildProjectSectionText, markProjectQueried, markWritten, readSeen, markAccessed, markSearched, setCurrentProject } from './inject.js'

export type { Level }

// ── 记忆门控（issue #38/#28）：host 注册工具时注入判定器 ─────────────────────
// 读档 = skip_inject / disabledWorkspaces → search/read/findSimilar/project 拒绝；
// 写档 = skip_write / disabledWorkspaces → remember/update 拒绝（整理轮豁免由 host
// 侧的 refuseWrite 闭包判定——工具层不感知轮次语义）。refusal 文案随既有工具错误
// 通道（throw new Error）走，模型可直接读到原因。
export interface MemoryToolGate {
  refuseRead?: (workspace: string, sessionId: string | null) => string | null
  refuseWrite?: (workspace: string, sessionId: string | null) => string | null
}

let toolGate: MemoryToolGate | undefined
/** host 在 apply 时注入门控判定器（活配置闭包；随插件重载重建）。 */
export function setMemoryToolGate(gate: MemoryToolGate | undefined): void {
  toolGate = gate
}

/** 门控检查：拒绝时抛出带理由的 Error（工具错误的既有通道）。 */
function refuseOrThrow(kind: 'read' | 'write', exec: ToolRunContext): void {
  if (toolGate === undefined) return
  const workspace = workspaceOf(exec)
  if (workspace === undefined) return
  const sessionId = sessionIdOf(exec)
  const refusal = kind === 'read' ? toolGate.refuseRead?.(workspace, sessionId) : toolGate.refuseWrite?.(workspace, sessionId)
  if (refusal !== null && refusal !== undefined) throw new Error(refusal)
}

// ── 参数通道兜底（issue #24）────────────────────────────────────────────────
// 部分宿主/模型走 XML 参数通道时，schema 声明为 array/number/boolean 的值会以
// **字符串**形态到达 execute（用户实测：keywords 变成 '["代码审计","静态扫描"]'
// 这类 JSON 文本，50 余次调用只有 1 次成功）。旧实现只认 Array.isArray，其余一律
// 判「必填」清空 → memory_remember 在该类宿主上完全不可用，逼得用户绕过插件直接写
// sqlite。这里统一做「能救就救」的归一：形态不对但语义可解析就照收，绝不因为通道
// 差异丢参数；只有真的解析不出才报错。

/** 参数形态描述（报错文案用，帮用户/模型定位通道问题）。 */
function describeArg(value: unknown): string {
  if (typeof value === 'string') return `string("${value.slice(0, 40)}")`
  if (Array.isArray(value)) return `array(${value.length})`
  if (value === null) return 'null'
  return typeof value
}

/**
 * 关键词归一：数组 / JSON 数组文本 / 「a, b」分隔文本 → string[]（去空白、丢空串、保持顺序）。
 * 递归处理「数组里套 JSON 文本」的形态（如 ['["a","b"]']）。
 */
export function normalizeKeywords(raw: unknown): string[] {
  const out: string[] = []
  const push = (v: string): void => {
    const t = v.trim()
    if (t.length > 0) out.push(t)
  }
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item)
      return
    }
    if (typeof v !== 'string') return
    const text = v.trim()
    if (text.length === 0) return
    if (text.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (Array.isArray(parsed)) {
          walk(parsed)
          return
        }
      } catch { /* 非法 JSON（如 '[a, b]'）：剥掉方括号按分隔文本处理 */ }
      walk(text.replace(/^\[+|\]+$/g, ''))
      return
    }
    if (/[,，、;；\n]/.test(text)) {
      for (const part of text.split(/[,，、;；\n]+/)) push(part)
      return
    }
    push(text)
  }
  walk(raw)
  return out
}

/** 数值归一：number 原样（非有限值视为未提供）；纯数字字符串（'2' / '2.0'）→ number；其余 undefined。 */
export function coerceNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (t.length === 0) return undefined
    const n = Number(t)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** 布尔归一：true / 'true' / '1' / 'yes' / 'y' / 1 → true；其余 false。 */
export function coerceBoolean(raw: unknown): boolean {
  if (raw === true) return true
  if (typeof raw === 'number') return raw === 1
  if (typeof raw === 'string') return ['true', '1', 'yes', 'y'].includes(raw.trim().toLowerCase())
  return false
}

/** 检索范围过滤（查询参数）：只按 project/status/days 过滤。
 *  已见（injected+searched）与本 session 建立的记忆不再预排除——search 先全量排名，
 *  前 5 条无脑取（不排除任何记忆），第 6 名起绕开已见补齐（用户拍板 2026-08-19）。 */
function filterSearchable(
  rows: MemoryRow[],
  opts: { project?: string[] | null; status?: string[] | null; days?: number | null },
): MemoryRow[] {
  return rows.filter((r) => {
    // project 多选（OR 语义）：任一项目覆盖即通过；"全局"/未标记天然覆盖。
    if (opts.project && opts.project.length > 0 && !opts.project.some((p) => projectCovers(r.project, p))) return false
    // status 多选（OR 语义）：'all' 表示不过滤。
    const statuses = opts.status?.filter((s) => s !== 'all') ?? []
    if (statuses.length > 0 && !statuses.includes(r.status)) return false
    if (opts.days && Date.now() - r.created_at > opts.days * 86_400_000) return false
    return true
  })
}

export function workspaceOf(exec: ToolRunContext): string | undefined {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return getDreamWorkspace() ?? undefined
}

export function sessionIdOf(exec: ToolRunContext): string | null {
  const header = (exec.agent?.session?.header ?? {}) as { id?: unknown; parentSession?: unknown; origin?: unknown }
  const id = typeof header.id === 'string' && header.id.length > 0 ? header.id : null
  // 子 agent（origin='subagent'）：source_session 继承母窗口（用户拍板：子 agent 写记忆归属父窗口）。
  // 注意：GUI fork/续写的主会话也有 parentSession 但 origin 无——不继承（它是独立主会话）。
  if (header.origin === 'subagent' && header.parentSession !== undefined) {
    const p = header.parentSession
    if (typeof p === 'string' && p.length > 0) return p
    if (p !== null && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string') {
      return (p as { id: string }).id
    }
  }
  return id
}

/** 自动提取关键词：bigram 词频 top N（去重、去纯数字）。 */
export function extractKeywords(content: string, n = 10): string[] {
  const freq = new Map<string, number>()
  for (const t of tokenize(content)) {
    if (/^[0-9]+$/.test(t)) continue
    freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t)
}

/** bigram Jaccard 相似度（去重用）。 */
export function similarity(a: string, b: string): number {
  const sa = new Set(tokenize(a))
  const sb = new Set(tokenize(b))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}

const DEDUP_THRESHOLD = 0.8

function rememberTool(dir: string): ToolDefinition {
  return {
    name: 'memory_remember',
    description: T('memory_remember.description'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['content', 'project', 'keywords', 'importance'],
      properties: {
        content: { type: 'string', description: T('memory_remember.param.content') },
        level: {
          type: 'string',
          enum: [...LEVELS],
          default: 'fact',
          description: T('memory_remember.param.level'),
        },
        project: { type: 'string', description: T('memory_remember.param.project') },
        subcategory: { type: 'string', enum: [...PROJECT_SUBCATEGORIES], description: T('memory_remember.param.subcategory') },
        goal: { type: 'string', description: T('memory_remember.param.goal') },
        importance: { type: 'integer', default: 1, description: T('memory_remember.param.importance') },
        corrected: { type: 'boolean', default: false, description: T('memory_remember.param.corrected') },
        keywords: { type: 'array', items: { type: 'string' }, description: T('memory_remember.param.keywords') },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          level: { type: 'string' },
          merged: { type: 'boolean' },
          keywords: { type: 'array', items: { type: 'string' }, description: T('memory_remember.out.keywords') },
          project: { type: 'string', description: T('memory_remember.out.project') },
        },
      },
      render: (_args, value) => {
        const v = value as { level?: unknown; merged?: unknown; id?: unknown; keywords?: unknown; project?: unknown }
        const kw = Array.isArray(v.keywords) && v.keywords.length > 0 ? `关键词：${v.keywords.join(' / ')}。` : ''
        const proj = typeof v.project === 'string' ? `项目：${v.project}。` : ''
        const head = v.merged ? '✅ 已合并到已有条目' : '✅ 记忆已写入'
        return [{
          type: 'text' as const,
          text: `${head}（${String(v.level ?? 'fact')}${typeof v.id === 'string' ? `，id=${v.id.slice(0, 8)}` : ''}）。${proj}${kw}无需重复调用本工具。`,
        }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      refuseOrThrow('write', exec)
      const parsed = args as { content?: unknown; level?: unknown; project?: unknown; subcategory?: unknown; goal?: unknown; importance?: unknown; corrected?: unknown; keywords?: unknown }
      const content = typeof parsed.content === 'string' ? parsed.content.trim() : ''
      // 四必填：缺失逐个报错并引导重填（用户拍板 2026-08-19）。
      if (content.length === 0) throw new Error(L('remember.error.content'))
      const project = typeof parsed.project === 'string' && parsed.project.trim() ? parsed.project.trim() : null
      if (project === null) throw new Error(L('remember.error.project', { global: globalProjectMarker() }))
      const keywords = normalizeKeywords(parsed.keywords)
      if (keywords.length === 0) {
        // 区分「压根没传」与「传了但解析不出任何关键词」（issue #24）：旧实现两者都
        // 报「必填」，用户明明带了 8-13 个关键词却被告知没填，排查方向被带偏。
        const missing = parsed.keywords === undefined || parsed.keywords === null
          || (typeof parsed.keywords === 'string' && parsed.keywords.trim() === '')
          || (Array.isArray(parsed.keywords) && parsed.keywords.length === 0)
        throw new Error(missing
          ? L('remember.error.keywords')
          : L('remember.error.keywordsEmpty', { received: describeArg(parsed.keywords) }))
      }
      const importanceRaw = coerceNumber(parsed.importance)
      if (importanceRaw === undefined) throw new Error(L('remember.error.importance'))
      const level: Level = typeof parsed.level === 'string' && (LEVELS as readonly string[]).includes(parsed.level)
        ? (parsed.level as Level)
        : 'fact'
      const importance = Math.round(importanceRaw)
      const subcategory =
        level === 'project' && typeof parsed.subcategory === 'string' && (PROJECT_SUBCATEGORIES as readonly string[]).includes(parsed.subcategory)
          ? (parsed.subcategory as ProjectSubcategory)
          : null
      const goal = typeof parsed.goal === 'string' && parsed.goal.trim() ? parsed.goal.trim() : null
      const corrected = coerceBoolean(parsed.corrected) ? 1 : 0

      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_remember: 无法确定工作区（会话无 cwd）')
      const db = getDb(workspace, dir)
      const source_session = sessionIdOf(exec)
      // 锚定当前 project：带 project 参数的 memory 调用更新会话状态（命中检索用它）；"全局"与多项目（逗号分隔）不锚定。
      if (project && !isGlobalProject(project) && !project.includes(',')) setCurrentProject(workspace, source_session ?? 'unknown', project, dir)

      // 去重：同 level 找相似条目 → 合并更新
      const existing = db.list(level)
      let merged: MemoryRow | undefined
      for (const r of existing) {
        if (similarity(r.content, content) >= DEDUP_THRESHOLD) {
          merged = r
          break
        }
      }
      if (merged) {
        const patch: MemoryPatch = {
          content,
          importance: Math.max(merged.importance, importance),
        }
        if (project && (level === 'project' || level === 'fact' || level === 'lesson' || level === 'topic' || level === 'rules')) patch.project = project
        if (subcategory && level === 'project') patch.subcategory = subcategory
        if (goal && level === 'topic') patch.goal = goal
        if (level === 'lesson' && corrected) patch.corrected = 1
        patch.keywords = keywords // 显式关键词才覆盖合并目标（能走到这里说明关键词非空）
        db.update(level, merged.id, patch)
        // 写痕迹（v0.23.0）：合并落库也记入 written——压缩重注入第三块回放本会话写过的记忆。
        markWritten(workspace, source_session ?? 'unknown', [merged.id], dir)
        // 读回合并后的实际存储结果（关键词等），让模型知道最终落库形态。
        const after = db.findById(merged.id)?.row
        return {
          ok: true,
          id: merged.id,
          level,
          merged: true,
          keywords: after?.keywords ?? merged.keywords,
          ...(after?.project ? { project: after.project } : {}),
        }
      }

      const row = db.insert({
        level,
        content,
        project,
        subcategory,
        goal,
        importance,
        corrected,
        keywords,
        source_session,
      })
      // 写痕迹（v0.23.0）：新建落库记入 written——压缩重注入第三块回放本会话写过的记忆。
      markWritten(workspace, source_session ?? 'unknown', [row.id], dir)
      return {
        ok: true,
        id: row.id,
        level,
        merged: false,
        keywords: row.keywords,
        ...(row.project ? { project: row.project } : {}),
      }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'write' } {
      const parsed = args as { content?: unknown }
      const preview = typeof parsed.content === 'string' ? parsed.content.slice(0, 40) : ''
      return { card: 'generic', title: `memory_remember: ${preview}`, kind: 'write' }
    },
  }
}

function searchTool(dir: string): ToolDefinition {
  return {
    name: 'memory_search',
    description: T('memory_search.description'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: T('memory_search.param.query') },
        level: { type: 'string', description: T('memory_search.param.level') },
        project: { type: 'string', description: T('memory_search.param.project') },
        status: { type: 'string', description: T('memory_search.param.status') },
        days: { type: 'integer', minimum: 1, maximum: 3650, description: T('memory_search.param.days') },
        k: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: T('memory_search.param.k') },
        content_max: { type: 'integer', minimum: 0, maximum: 5000, default: 300, description: T('memory_search.param.content_max') },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['note', 'hits'],
        properties: {
          note: { type: 'string', description: T('memory_search.out.note') },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'level'],
              properties: {
                id: { type: 'string', description: T('memory_search.out.hits.id') },
                level: { type: 'string' },
                title: { type: 'string' },
                content: { type: 'string' },
                keywords: { type: 'array', items: { type: 'string' }, description: T('memory_search.out.hits.keywords') },
                project: { type: 'string', description: T('memory_search.out.hits.project') },
                score: { type: 'number' },
                updated_at: { type: 'number', description: T('memory_search.out.hits.updated_at') },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { note?: string; hits?: Array<{ id?: string; level?: string; content?: string; keywords?: unknown; project?: string | null; updated_at?: number | null }> }
        const lines = [String(v.note ?? '')]
        for (const h of v.hits ?? []) {
          // 检索元数据视图：归属 + id + 相对时间 + 关键词（无关键词回退原文开头）；原文内容不显示。
          const kw = (Array.isArray(h.keywords) ? h.keywords : []).filter((x): x is string => typeof x === 'string' && x.length > 0)
          const about = kw.length > 0 ? kw.join(', ') : `${String(h.content ?? '').slice(0, 40)}…`
          // 归属显示：'全局'=真全局；null=未标记（可能是数据 bug）；多值 join '/'（如 dsh/femo）。
          const proj = `${projectLabel(h.project)} : ${String(h.level ?? '')}`
          const rel = relativeTime(h.updated_at ?? null)
          lines.push(`[${proj}] [${String(h.id ?? '')}] [${rel}] 关于：${about}`)
        }
        return lines.map((t) => ({ type: 'text' as const, text: t }))
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      refuseOrThrow('read', exec)
      const parsed = args as { query?: unknown; level?: unknown; project?: unknown; status?: unknown; days?: unknown; k?: unknown; content_max?: unknown }
      const query = typeof parsed.query === 'string' ? parsed.query.trim() : ''
      if (!query) throw new Error('memory_search: query 必填且不能为空（例：{"query": "关键词"}）；浏览项目全貌请用 memory_project')
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_search: 无法确定工作区（会话无 cwd）')
      const db = getDb(workspace, dir)
      const sessionId = sessionIdOf(exec)
      const seen = readSeen(workspace, sessionId ?? 'unknown', dir)
      // project/status 支持逗号多选（OR 语义，用户拍板 2026-08-19）。
      const projectList = typeof parsed.project === 'string' && parsed.project.trim()
        ? parsed.project.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
        : []
      const project = projectList.length > 0 ? projectList : null
      // 锚定当前 project（命中检索限定"全局+当前项目"）；单值才锚定，"全局"不锚定。
      if (projectList.length === 1 && !isGlobalProject(projectList[0])) setCurrentProject(workspace, sessionId ?? 'unknown', projectList[0], dir)
      const statusList = typeof parsed.status === 'string' && parsed.status.trim()
        ? parsed.status.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
        : []
      const status = statusList.length > 0 ? statusList : null
      const daysRaw = coerceNumber(parsed.days)
      const days = daysRaw !== undefined && daysRaw > 0 ? daysRaw : null
      const kRaw = coerceNumber(parsed.k)
      const k = kRaw !== undefined ? Math.max(1, Math.min(50, Math.round(kRaw))) : 10
      const cmRaw = coerceNumber(parsed.content_max)
      const contentMax = cmRaw !== undefined ? Math.max(0, Math.min(5000, Math.round(cmRaw))) : 300

      const levels: Level[] = typeof parsed.level === 'string' && parsed.level.trim()
        ? parsed.level.split(',').map((s) => s.trim()).filter((s): s is Level => (LEVELS as readonly string[]).includes(s))
        : (['fact', 'lesson', 'topic', 'rules'] as Level[])
      const rows = levels.flatMap((lv) => {
        // 单一非默认 status → db 层过滤；多选 → 全量取出后 filterSearchable 过滤；默认 active（+todo stale）。
        if (statusList.length === 1 && statusList[0] !== 'active' && statusList[0] !== 'all') return db.list(lv, { status: statusList[0] as MemoryRow['status'] })
        if (statusList.length > 1) return db.list(lv)
        return db.listSearchable(lv)
      })
      // 查询参数过滤（project/status/days）；不再预排除已见/本 session 建立的记忆。
      const filtered = filterSearchable(rows, { project, status, days })
      const byId = new Map(filtered.map((r) => [r.id, r]))
      const docs = filtered.map((r) => ({
        id: r.id,
        level: r.level,
        title: r.title,
        content: r.content,
        keywords: r.keywords,
        importance: r.importance,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
      // 全量排名（分高到低）后分段选取（用户拍板 2026-08-19）：
      //   前 5 条无脑取（不排除任何记忆，含已见/本 session 建立的）；
      //   第 6 名起逐个往下，绕开已见（injected+searched）的记忆补足，保证新信息。
      const ranked = search(query, docs, { k: docs.length })
      const blindCount = Math.min(5, k)
      const blind = ranked.slice(0, blindCount)
      const fresh: RankedHit[] = []
      for (const h of ranked.slice(blindCount)) {
        if (fresh.length >= k - blindCount) break
        if (seen.has(h.id)) continue
        fresh.push(h)
      }
      const hits = [...blind, ...fresh]
      for (const h of hits) db.bumpHit(h.level as Level, h.id)
      markSearched(workspace, sessionId ?? 'unknown', hits.map((h) => h.id), dir)
      // 按记忆时间戳（updated_at）重排：旧→新；null 视为最旧（从未封存/更新）。
      const reordered = [...hits].sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0))
      return {
        note: '如果冲突，以最新的为准。时间戳较旧的条目可作为事情发展过程的参考。如果你确实需要更多细节，可以直接去聊天记录里搜索相关关键词。',
        hits: reordered.map((h) => {
          const row = byId.get(h.id)
          return {
            id: h.id,
            level: h.level,
            title: h.title ?? '',
            content: contentMax > 0 ? h.content.slice(0, contentMax) : h.content,
            keywords: row?.keywords ?? [],
            project: row?.project ?? '',
            score: Math.round(h.score * 100) / 100,
            updated_at: h.updated_at ?? 0,
          }
        }),
      }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'read' } {
      const parsed = args as { query?: unknown }
      return { card: 'generic', title: `memory_search: ${String(parsed.query ?? '').slice(0, 40)}`, kind: 'read' }
    },
  }
}

function findSimilarTool(dir: string): ToolDefinition {
  return {
    name: 'memory_find_similar',
    description: T('memory_find_similar.description'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: T('memory_find_similar.param.id') },
        k: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: T('memory_find_similar.param.k') },
        content_max: { type: 'integer', minimum: 0, maximum: 5000, default: 200, description: T('memory_find_similar.param.content_max') },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['hits'],
        properties: {
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'level', 'similarity'],
              properties: {
                id: { type: 'string' },
                level: { type: 'string' },
                title: { type: 'string' },
                content: { type: 'string' },
                similarity: { type: 'number', description: T('memory_find_similar.out.hits.similarity') },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { hits?: Array<{ id?: string; level?: string; title?: string; content?: string; similarity?: number }> }
        return (v.hits ?? []).map((h) => ({
          type: 'text' as const,
          text: `[${String(h.level ?? '')} ${String(h.id ?? '').slice(0, 12)}] 相似度 ${Number(h.similarity ?? 0).toFixed(3)} ${String(h.title ?? '')} ${String(h.content ?? '').slice(0, 80)}`,
        }))
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      refuseOrThrow('read', exec)
      const parsed = args as { id?: unknown; k?: unknown; content_max?: unknown }
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
      if (!id) throw new Error('memory_find_similar: id 不能为空')
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_find_similar: 无法确定工作区（会话无 cwd）')
      const db = getDb(workspace, dir)
      const found = db.findById(id)
      if (!found) throw new Error(`memory_find_similar: 未找到记忆 ${id.slice(0, 12)}`)
      const sessionId = sessionIdOf(exec)
      const seen = readSeen(workspace, sessionId ?? 'unknown', dir)
      const kRaw = coerceNumber(parsed.k)
      const k = kRaw !== undefined ? Math.max(1, Math.min(20, Math.round(kRaw))) : 5
      const cmRaw = coerceNumber(parsed.content_max)
      const contentMax = cmRaw !== undefined ? Math.max(0, Math.min(5000, Math.round(cmRaw))) : 200

      const rows = LEVELS.flatMap((lv) => (lv === 'soul' || lv === 'user' ? [] : db.listSearchable(lv)))
      const candidates = rows.filter((r) => r.id !== found.row.id && !seen.has(r.id) && r.source_session !== sessionId)
      const docs = candidates.map((r) => ({
        id: r.id,
        level: r.level,
        title: r.title,
        content: r.content,
        keywords: r.keywords,
        importance: r.importance,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
      const hits = findSimilar(found.row.content, docs, k)
      markSearched(workspace, sessionId ?? 'unknown', hits.map((h) => h.id), dir)
      return {
        hits: hits.map((h) => ({
          id: h.id,
          level: h.level,
          title: h.title ?? '',
          content: contentMax > 0 ? h.content.slice(0, contentMax) : h.content,
          similarity: h.similarity,
        })),
      }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'read' } {
      const parsed = args as { id?: unknown }
      return { card: 'generic', title: `memory_find_similar: ${String(parsed.id ?? '').slice(0, 12)}`, kind: 'read' }
    },
  }
}

function readTool(dir: string): ToolDefinition {
  return {
    name: 'memory_read',
    description: T('memory_read.description'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: T('memory_read.param.id') },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['found'],
        properties: {
          found: { type: 'boolean' },
          id: { type: 'string' },
          level: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          importance: { type: 'number' },
          status: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          project: { type: 'string' },
          goal: { type: 'string' },
          corrected: { type: 'boolean' },
          created_at: { type: 'number' },
          updated_at: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const v = value as { found?: boolean; level?: unknown; title?: unknown; content?: unknown; status?: unknown; project?: unknown; goal?: unknown }
        const hint = '如果你确实需要更多细节，可以直接去聊天记录里搜索相关关键词。'
        if (!v.found) return [{ type: 'text' as const, text: `未找到该记忆。${hint}` }]
        const parts = [`[${String(v.level ?? '')}] ${String(v.title ?? '')}（${String(v.status ?? '')}）`]
        if (v.project) parts.push(`项目：${String(v.project)}`)
        if (v.goal) parts.push(`目标：${String(v.goal)}`)
        parts.push(String(v.content ?? ''))
        parts.push(hint)
        return [{ type: 'text' as const, text: parts.join('\n') }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      refuseOrThrow('read', exec)
      const parsed = args as { id?: unknown }
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
      if (!id) throw new Error('memory_read: id 不能为空')
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_read: 无法确定工作区（会话无 cwd）')
      const found = getDb(workspace, dir).findById(id)
      if (!found) return { found: false }
      const { row } = found
      // 查阅留痕（v0.17.0）：dream 第一轮清单的"查阅过"源（memory_project 全景不标记，第三轮专门复查）。
      markAccessed(workspace, sessionIdOf(exec) ?? 'unknown', [row.id], dir)
      return {
        found: true,
        id: row.id,
        level: row.level,
        title: row.title ?? '',
        content: row.content,
        importance: row.importance,
        status: row.status,
        keywords: row.keywords,
        project: row.project ?? '',
        goal: row.goal ?? '',
        corrected: row.corrected === 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'read' } {
      const parsed = args as { id?: unknown }
      return { card: 'generic', title: `memory_read: ${String(parsed.id ?? '').slice(0, 16)}`, kind: 'read' }
    },
  }
}

function updateTool(dir: string): ToolDefinition {
  return {
    name: 'memory_update',
    description: T('memory_update.description'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: T('memory_update.param.id') },
        content: { type: 'string', description: T('memory_update.param.content') },
        status: { type: 'string', enum: ['active', 'archived', 'stale'], description: T('memory_update.param.status') },
        importance: { type: 'integer', description: T('memory_update.param.importance') },
        goal: { type: 'string', description: T('memory_update.param.goal') },
        project: { type: 'string', description: T('memory_update.param.project') },
        keywords: { type: 'array', items: { type: 'string' }, description: T('memory_update.param.keywords') },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          level: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok?: boolean; level?: unknown; id?: unknown }
        return [{ type: 'text' as const, text: v.ok ? `✅ 已更新（${String(v.level ?? '')} ${String(v.id ?? '').slice(0, 8)}）。` : '更新失败：未找到该记忆。' }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      refuseOrThrow('write', exec)
      const parsed = args as { id?: unknown; content?: unknown; status?: unknown; importance?: unknown; goal?: unknown; project?: unknown; keywords?: unknown }
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
      if (!id) throw new Error('memory_update: id 不能为空')
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_update: 无法确定工作区（会话无 cwd）')
      const db = getDb(workspace, dir)
      const sessionId = sessionIdOf(exec)
      const found = db.findById(id)
      if (!found) return { ok: false, id, level: '' }
      const patch: MemoryPatch = {}
      if (typeof parsed.content === 'string' && parsed.content.trim()) patch.content = parsed.content.trim()
      if (typeof parsed.status === 'string' && ['active', 'archived', 'stale'].includes(parsed.status)) patch.status = parsed.status as MemoryPatch['status']
      const importanceRaw = coerceNumber(parsed.importance)
      if (importanceRaw !== undefined) patch.importance = Math.round(importanceRaw)
      if (typeof parsed.goal === 'string' && parsed.goal.trim() && found.level === 'topic') patch.goal = parsed.goal.trim()
      if (typeof parsed.project === 'string' && (found.level === 'project' || found.level === 'fact' || found.level === 'lesson' || found.level === 'rules' || found.level === 'topic')) {
        const cleared = parsed.project.trim() === ''
        patch.project = cleared ? null : parsed.project.trim()
        // 锚定当前 project（命中检索限定"全局+当前项目"）；"全局"、清空归属、多项目（逗号分隔）不锚定。
        if (!cleared && !isGlobalProject(String(patch.project)) && !String(patch.project).includes(',')) setCurrentProject(workspace, sessionId ?? 'unknown', patch.project, dir)
      }
      {
        // 空数组 / 未提供 = 不更新（用户拍板：防 AI 幻觉"不想改关键词"却传 [] 把关键词全清空）；
        // 字符串形态经通道兜底归一后同样接受（issue #24）。
        const kw = normalizeKeywords(parsed.keywords)
        if (kw.length > 0) patch.keywords = kw
      }
      // 记忆时间戳 = 最后更新时间：db.update 内部自动刷新 updated_at（任何 update 都刷新）。
      // patch 为空（如只想传 keywords:[] 表达"不更新"）→ 视为调用成功、无字段变化。
      const ok = Object.keys(patch).length > 0 ? db.update(found.level, found.row.id, patch) : true
      // 写痕迹（v0.23.0）：实际落库（patch 非空且 update 成功）才记——空 patch 无字段变化不算写。
      if (ok && Object.keys(patch).length > 0) markWritten(workspace, sessionId ?? 'unknown', [found.row.id], dir)
      return { ok, id: found.row.id, level: found.level }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'write' } {
      const parsed = args as { id?: unknown; status?: unknown }
      return { card: 'generic', title: `memory_update: ${String(parsed.id ?? '').slice(0, 8)}${parsed.status ? ` → ${String(parsed.status)}` : ''}`, kind: 'write' }
    },
  }
}

/**
 * memory_project：取回某项目的完整注入段落（用户拍板规格）。
 * - 非 todo 子标签：active 条目全部；
 * - todo 子标签：active 全部为「To do list：」+ stale（已完成）按 updated_at 取最近 5 条为「已完成：」；
 * - 组内按记忆时间戳旧→新；只拼 content 纯文本，不写复杂格式。
 * 段落构造与压缩重注入共用 buildProjectSectionText（v0.21.0，inject.ts）。
 */
function projectTool(dir: string): ToolDefinition {
  return {
    name: 'memory_project',
    description: T('memory_project.description'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['project'],
      properties: {
        project: { type: 'string', description: T('memory_project.param.project') },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['project', 'text'],
        properties: {
          project: { type: 'string' },
          text: { type: 'string', description: T('memory_project.out.text') },
        },
      },
      render: (_args, value) => {
        const v = value as { text?: unknown }
        return [{ type: 'text' as const, text: String(v.text ?? '') }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      refuseOrThrow('read', exec)
      const parsed = args as { project?: unknown }
      const project = typeof parsed.project === 'string' ? parsed.project.trim() : ''
      if (!project) throw new Error('memory_project: project 不能为空')
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_project: 无法确定工作区（会话无 cwd）')
      const db = getDb(workspace, dir)
      // 锚定当前 project：用户话题切到某项目时 AI 调 memory_project → 命中检索立即跟进；"全局"与多项目不锚定。
      const sessionId = sessionIdOf(exec)
      if (!isGlobalProject(project) && !project.includes(',')) setCurrentProject(workspace, sessionId ?? 'unknown', project, dir)
      // 查阅留痕（v0.21.0）：本会话查阅过的项目记入 sessions/<id>.json——会话压缩成功后
      // 按此清单重注入项目全景。全局标记不记（markProjectQueried 内部过滤，全局层走快照）；
      // 多项目参数按逗号拆开逐个记（重注入按单项目段落拼装）。
      markProjectQueried(workspace, sessionId ?? 'unknown', project, dir)
      const text = buildProjectSectionText(db, workspace, project, dir)
      if (text === null) {
        return { project, text: L('project.empty', { name: project }) }
      }
      return { project, text }
    },
    presentCall(args: unknown): { card: 'generic'; title: string; kind: 'read' } {
      const parsed = args as { project?: unknown }
      return { card: 'generic', title: `memory_project: ${String(parsed.project ?? '').slice(0, 24)}`, kind: 'read' }
    },
  }
}

/** 全局数据目录查看/切换（用户拍板 2026-09-25）：对用户=说一句话即可换目录，
 *  零代码零重启——不依赖 dsh 0.1.7 设置页写入链（其真机写入被拒、拒因静默）。
 *  切换=插件内部 switchHomeDir（同盘移动/跨盘复制+旧目录绝不自动删+失败留原地）。 */
function homeTool(): ToolDefinition {
  return {
    name: 'memory_home',
    description: T('memory_home.description'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: T('memory_home.param.target') },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['note'],
        properties: { note: { type: 'string', description: T('memory_home.out.note') } },
      },
      render: (_args, value) => {
        const v = value as { note?: string }
        return [{ type: 'text' as const, text: String(v.note ?? '') }]
      },
    },
    async execute(args: unknown) {
      const parsed = args as { target?: unknown }
      const presets = homeDirPresets()
      const raw = typeof parsed.target === 'string' ? parsed.target.trim() : ''
      if (raw === '') {
        return { note: [
          `当前全局数据目录：${activeHomeDir()}`,
          `预设 default（系统用户主目录）：${presets.default}`,
          `预设 dsh-storage（DSH 根目录 Storage）：${presets['dsh-storage']}`,
          `预设 plugin-root（插件本体根目录）：${presets['plugin-root']}`,
          `不修改则不传 target；要切换请传预设标记或绝对路径。`,
        ].join('\n') }
      }
      const LEGAL = ['default', 'dsh-storage', 'plugin-root']
      const target = resolveHomeDir(raw)
      // 非法输入防误切：resolveHomeDir 会把非法值回落默认——这里识别出来直接报错
      const downgraded = target === resolveHomeDir(undefined) && !LEGAL.includes(raw)
      if (downgraded) {
        return { note: `无法识别的 target："${raw}"（可用预设标记或绝对路径）。当前目录未变：${activeHomeDir()}` }
      }
      const sw = switchHomeDir(target)
      if (sw.mode === 'same') return { note: `全局数据目录本就是 ${sw.to}，未变更。` }
      if (sw.mode === 'failed') return { note: `切换失败：${sw.error}。仍使用 ${sw.from}，数据未受影响，可稍后重试。` }
      if (sw.mode === 'reused-nonempty') return { note: `已切换为 ${sw.to}（目标目录已有内容，直接启用、未覆盖）。旧目录 ${sw.from} 原样保留。` }
      if (sw.mode === 'rename') return { note: `已切换为 ${sw.to}：自 ${sw.from} 移动 ${sw.files} 项完成（同盘移动）。如本机有多个 dsh 实例共享旧目录，请同步修改它们的设置。` }
      return { note: `已切换为 ${sw.to}：自 ${sw.from} 复制 ${sw.files} 项（跨盘复制为快照）。旧目录 ${sw.from} 保留未删，确认无误后可手动删除；若多个 dsh 实例共享旧目录，请同步修改其他实例的设置。` }
    },
  }
}

export function registerMemoryTools(register: (t: ToolDefinition) => void, dir = '.dsh-meow'): void {
  // 门控判定器经 setMemoryToolGate 注入（apply 期设置；工具工厂签名保持不变）。
  register(rememberTool(dir))
  register(searchTool(dir))
  register(findSimilarTool(dir))
  register(readTool(dir))
  register(updateTool(dir))
  register(projectTool(dir))
  register(homeTool())
}