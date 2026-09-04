/**
 * meow-memory — 反思轮折叠：纯计算逻辑（与 DOM 无关，可单测）。
 *
 * 识别：会话快照 chat 节点里 kind='context' 且 source 为
 * { kind: 'plugin', plugin: 'meow-memory' } 的节点 = 反思/dream 轮 prompt
 * （steer 注入的 user/message 事件，非 append 改写，渲染为 context 行）。
 * 范围：该 prompt 所在 turn 内、位于 prompt 之后的全部节点（排除 user/steering，
 * 防止误折叠反思期间用户插入的消息；排除 turn-tail——dsh 每个完成 turn 唯一的
 * 操作 footer（复制/分支/耗时行）。反思 prompt 经 agent/turn-stopping steer 注入，
 * dsh 契约是「延续同一个 turn」，即正常轮与反思轮共用这一个 turn-tail，藏掉它
 * 正常轮工作汇报的复制/点赞行也会消失，必须保持可见），用快照的
 * locations.getTurn(turn) 获取。
 * 计数：范围内 kind='tool' 节点中 memory_remember / memory_update 的调用次数。
 * 状态：范围内有 running assistant → 进行中；interrupted → 已中断；否则已完成。
 */

import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  AssistantChatData,
  ChatNode,
  ToolChatData,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** 反思轮识别标记（与 host 端 reflect.ts / dream.ts 保持一致）。 */
export const REFLECT_MARKER = '[meow-memory-reflect]'
export const DREAM_MARKER = '[meow-memory-dream]'

/** 插件 source 识别（与 host 端 PLUGIN_SOURCE 保持一致）。 */
export const PLUGIN_NAME = 'meow-memory'

export type FoldVariant = 'reflect' | 'dream'

export type FoldStatus = 'running' | 'done' | 'interrupted'

/** 一个可折叠的反思/dream 轮。 */
export interface FoldGroup {
  /** 起点 context 节点的 key（快照 chat 节点 key，全局唯一）。 */
  readonly id: string
  readonly variant: FoldVariant
  /** 折叠的节点 keys（按渲染顺序；不含 user/steering/turn-tail）。 */
  readonly keys: readonly string[]
  /** memory_remember 调用次数（"新增记忆 N 条"）。 */
  readonly rememberCount: number
  /** memory_update 调用次数。 */
  readonly updateCount: number
  readonly status: FoldStatus
}

interface ContextLike {
  readonly source?: unknown
  readonly content?: readonly { type?: string; text?: string }[]
}

/** 从节点 location 提取 turn 号（unresolved/session 定位无法确定时返回 undefined，
 *  调用方对 undefined 一律跳过=不折叠保持可见）。location 与 location.turn 均做
 *  缺失防护：异常快照/版本偏差下节点可能无 location（GitHub issue #2），缺失时
 *  与 unresolved 同路径降级，绝不抛错——computeFoldGroups 在每次渲染都跑，一炸
 *  就是一整个会话视图。 */
function turnOf(node: ChatNode): number | undefined {
  const location = node.location
  if (location?.kind === 'turn') return location.turn?.turn
  if (location?.kind === 'step') return location.turn?.turn
  return undefined
}

function contextText(node: ChatNode): string {
  return blocksToText((node.data as ContextLike).content ?? [])
}

/** 判定节点是否 meow-memory 注入的反思/dream prompt。 */
function isMemoryPrompt(node: ChatNode): boolean {
  if (node.kind !== 'context') return false
  const source = (node.data as ContextLike).source as { kind?: string; plugin?: string } | undefined
  if (source?.kind !== 'plugin' || source.plugin !== PLUGIN_NAME) return false
  const text = contextText(node)
  return text.includes(REFLECT_MARKER) || text.includes(DREAM_MARKER)
}

/** 从 prompt 文本判定轮次类型（reflect / dream）。 */
function variantOf(node: ChatNode): FoldVariant {
  const text = contextText(node)
  return text.includes(DREAM_MARKER) ? 'dream' : 'reflect'
}

/** 统计一个工具节点的调用名（memory_remember / memory_update）。
 *  注意：工具节点的渲染 kind 是 'tool-call'（ui-conversation 的 toolDefinition
 *  以 chatNode(context, 'tool-call', ...) 发布），不是 'tool'。 */
function toolNameOf(node: ChatNode): string | undefined {
  if (node.kind !== 'tool-call') return undefined
  const root = (node.data as ToolChatData).root
  if (root === undefined) return undefined
  if ('name' in root) return root.name // RunningToolCall
  return root.call?.name // ToolResultNode（窗口截断时 call 可能为 null）
}

/**
 * 从会话快照计算全部可折叠组。
 * @param snapshot - 会话快照（dock 组件收到的 point-in-time 快照）。
 * @returns 按渲染顺序排列的折叠组。
 */
export function computeFoldGroups(snapshot: ConversationSnapshot): FoldGroup[] {
  // fail-closed：宿主快照形状变化（如旧/新 dsh 前端 chat 缺失）时降级为不折叠，
  // 绝不抛错炸掉 dock（官方 issue #2 turnOf 同类无保护读教训）。
  if (snapshot?.chat === undefined) return []
  const order = snapshot.chat.order
  const nodes = snapshot.chat.nodes
  const groups: FoldGroup[] = []
  for (const key of order) {
    const node = nodes.get(key)
    if (node === undefined || !isMemoryPrompt(node)) continue
    const turn = turnOf(node)
    if (turn === undefined) continue // 定位未解析（历史窗口外）：不折叠，保持可见
    const turnKeys = snapshot.chat.locations.getTurn(turn)
    const startIdx = turnKeys.indexOf(key)
    const keys = turnKeys
      .slice(startIdx === -1 ? 0 : startIdx)
      .filter((k) => {
        const n = nodes.get(k)
        // turn-tail = 该 turn 的操作 footer（复制/点赞/耗时行），保持可见不折叠。
        return n !== undefined && n.kind !== 'user' && n.kind !== 'steering' && n.kind !== 'turn-tail'
      })
    let rememberCount = 0
    let updateCount = 0
    let status: FoldStatus = 'done'
    for (const k of keys) {
      const n = nodes.get(k)
      if (n === undefined) continue
      const name = toolNameOf(n)
      if (name === 'memory_remember') rememberCount++
      else if (name === 'memory_update') updateCount++
      if (n.kind === 'assistant') {
        const data = n.data as AssistantChatData
        if (data.status === 'running') status = 'running'
        else if (data.status === 'interrupted' && status !== 'running') status = 'interrupted'
      }
    }
    groups.push({ id: key, variant: variantOf(node), keys, rememberCount, updateCount, status })
  }
  return groups
}

/** 横条文案（产品 copy，中文）。 */
export function foldLabel(group: FoldGroup, expanded: boolean): string {
  const arrow = expanded ? '▾' : '▸'
  const title = group.variant === 'dream' ? '记忆梦境任务' : '记忆反思'
  if (group.status === 'running') return `${arrow} ${title}进行中…`
  if (group.status === 'interrupted') return `${arrow} ${title}已中断`
  if (group.rememberCount > 0) return `${arrow} ${title} · 新增记忆 ${group.rememberCount} 条`
  if (group.updateCount > 0) return `${arrow} ${title} · 已更新 ${group.updateCount} 条`
  return `${arrow} ${title} · 无需记忆`
}

/** 渲染一个 tool 调用的详情文本：名称 + 格式化参数（JSON pretty）。 */
export function toolCallDetail(block: { name: string; argsRaw: string }): string {
  let args = block.argsRaw
  try {
    args = JSON.stringify(JSON.parse(block.argsRaw), null, 2)
  } catch {
    /* 非 JSON 参数原样展示 */
  }
  return args.length > 0 ? `${block.name}\n${args}` : block.name
}

/** 从 content blocks 提取纯文本（tool result / 消息正文）。 */
export function blocksToText(blocks: readonly { type?: string; text?: string }[]): string {
  return blocks
    .map((block) => block.text ?? '')
    .join('\n')
    .trim()
}

// ── 注入折叠（首轮长期记忆 / 每消息关键词命中） ─────────────────────────────

/** 首轮注入文本的开头标记（与 host 端 buildInjection 保持一致）。 */
export const FIRST_INJECTION_MARKER = '===== 长期记忆 ====='
/** 命中注入文本的开头标记（与 host 端 buildHitInjection 保持一致）。 */
export const HIT_INJECTION_MARKER = '可能相关的记忆，仅供参考：'
/** 注入文本与用户 prompt 的分隔标记（两种注入都以它结尾）。 */
export const PROMPT_SEPARATOR = '本轮用户prompt：'
/** en 语言包（v0.22.0）旧格式分隔符（labels en inject.promptLabel，逐字一致）。 */
export const EN_PROMPT_SEPARATOR = "This turn's user prompt:"

export type InjectionKind = 'first' | 'hit'

/** 一个可折叠的记忆注入（新格式为独立 context，旧格式为 user 前缀）。 */
export interface InjectionGroup {
  /** 要隐藏并在其原位放置横条的节点 key。 */
  readonly id: string
  readonly kind: InjectionKind
  /** 注入的完整文本。 */
  readonly injectedText: string
  /** 仅旧格式存在：从被污染 user 消息中拆出的 prompt 原文。 */
  readonly userText?: string
  /** 消息事件时间（Unix epoch ms）；缺失时操作行不显示时钟。 */
  readonly time?: number
}

/**
 * 新格式优先识别 source.memory.kind (initial/reinjection/hit) 机器元数据，解耦于自然语言文本；
 * 兼容未带元数据的 snapshot (中英文标记兜底)；
 * 旧格式继续识别含注入前缀和分隔符的 user 消息。
 */
export function computeInjectionGroups(snapshot: ConversationSnapshot): InjectionGroup[] {
  if (snapshot?.chat === undefined) return [] // fail-closed：快照无 chat 时不注入折叠，绝不抛错
  const groups: InjectionGroup[] = []
  for (const key of snapshot.chat.order) {
    const node = snapshot.chat.nodes.get(key)
    if (node === undefined) continue
    if (node.kind === 'context') {
      const source = (node.data as ContextLike).source as {
        kind?: string
        plugin?: string
        form?: string
        memory?: { kind?: 'initial' | 'hit' | 'reinjection' | 'welcome' }
      } | undefined
      if (source?.kind !== 'plugin' || source.plugin !== PLUGIN_NAME) continue
      const memKind = source.memory?.kind
      if (memKind === 'initial' || memKind === 'reinjection') {
        groups.push({ id: key, kind: 'first', injectedText: contextText(node) })
        continue
      }
      if (memKind === 'hit') {
        groups.push({ id: key, kind: 'hit', injectedText: contextText(node) })
        continue
      }
      if (source.form === 'snapshot') {
        const injectedText = contextText(node)
        const isFirst = injectedText.startsWith(FIRST_INJECTION_MARKER) || injectedText.includes('LONG-TERM MEMORY')
        groups.push({ id: key, kind: isFirst ? 'first' : 'hit', injectedText })
      }
      continue
    }
    if (node.kind !== 'user') continue
    const content = (node.data as { content?: readonly { type?: string; text?: string }[] }).content ?? []
    if (content.length === 0 || content.some((b) => b.type !== 'text')) continue // 带附件不折叠
    const text = blocksToText(content)
    if (text.length === 0) continue
    let kind: InjectionKind | null = null
    if (text.startsWith(FIRST_INJECTION_MARKER) || text.includes('LONG-TERM MEMORY') || text.includes('===== 长期记忆 =====')) kind = 'first'
    else if (text.startsWith(HIT_INJECTION_MARKER) || text.includes('Possibly relevant memories') || text.includes('可能相关的记忆')) kind = 'hit'
    if (kind === null) continue
    // en 旧格式分隔符 = labels en inject.promptLabel 实际值（"This turn's user prompt:"，v0.22.0 en 包历史会话）
    const sep = text.includes(PROMPT_SEPARATOR) ? PROMPT_SEPARATOR : (text.includes(EN_PROMPT_SEPARATOR) ? EN_PROMPT_SEPARATOR : null)
    if (sep === null) continue // 没有分隔标记（异常数据）：不折叠
    const sepIdx = text.lastIndexOf(sep)
    const userText = text.slice(sepIdx + sep.length).replace(/^\n+/, '')
    const time = typeof (node.data as { time?: unknown }).time === 'number'
      ? (node.data as { time: number }).time
      : undefined
    groups.push({ id: key, kind, injectedText: text.slice(0, sepIdx + sep.length), userText, time })
  }
  return groups
}

/** 注入用户消息的时间标签。与 dsh 本体 formatMessageClock 同规则（同天 HH:mm、
 *  今年「M月D日 HH:mm」、跨年「Y年M月D日 HH:mm」，中文产品文案），供插件自绘的
 *  注入消息操作行使用——本体按钮的复制文本闭包含注入前缀，无法直接复用。
 * @param time - 消息事件时间（Unix epoch ms）。
 * @param now - 参考时刻（默认当前；测试可注入）。
 * @returns 时钟字符串（24 小时制补零）。
 */
export function formatInjectionClock(time: number, now: number = Date.now()): string {
  const d = new Date(time)
  const n = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay = d.getFullYear() === n.getFullYear()
    && d.getMonth() === n.getMonth()
    && d.getDate() === n.getDate()
  if (sameDay) return clock
  const md = d.getFullYear() === n.getFullYear()
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  return `${md} ${clock}`
}
