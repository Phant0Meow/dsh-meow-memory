/**
 * meow-memory — delegate 打点气泡：反思/梦境独立执行的前端可见提示（状态化）。
 *
 * 背景（猫猫 2026-09-03）：delegate 模式下反思/dream 在 fork 子代理里执行，主会话
 * 只有一条 session.append 的打点消息（delegate.ts buildDelegateMarkerMessage）。
 * 该消息经 dsh 投影（source.kind!=='user' → context 节点，form='notice'）渲染成
 * 一行低调的注入 notice——存在感太弱，用户感知不到「整理发生过」。
 *
 * 本模块：识别打点节点 → 隐藏原生 notice 行 → 原位插入折叠横条同款的胶囊气泡。
 * 气泡文字随任务事实状态变化（猫猫拍板 2026-09-03：处理完了就应该显示处理完成；
 * 「三轮三个子代理都跑完了，才显示已完成」）：
 * - dream：接 /meow-memory/dreamed-sessions 对账 + /meow-memory/dream-events SSE
 *   （与 client-dream-icon 同数据源）——dreamed 事件在最后一组收尾时才推，天然满足
 *   「全部组跑完才完成」。状态未知默认「进行中」（打点的语义就是任务刚发出），
 *   只有明确 dreamed 才翻「已完成」。
 * - reflect：完成信号=子代理 settle 后追加的「完成打点」（delegate.ts
 *   'reflect-done'，不出气泡只作信号）。同会话反思有 in-flight 防重入，打点序列
 *   必然「触发→完成」交替：一条触发打点是「进行中」当且仅当它是最后一条 reflect
 *   系打点且足够新鲜（>30min 的历史打点视为早已完成）。
 *
 * 识别：机器元数据优先（source.memory.kind，与注入 initial/hit、welcome 互斥），
 * 文本标记兜底（防旧数据/元数据丢失）。与主会话折叠轮（[meow-memory-reflect]/
 * [meow-memory-dream] 文本 marker）天然不撞——两者文本不同。
 *
 * 与 client-fold 同款纪律：
 * - 纯计算（computeDelegateNotices）与 DOM（applyDelegateNotices）分层，纯计算可单测；
 * - DOM 操作幂等（锚点只建一次、文本变化才写）——MutationObserver 兜底重放不自我循环；
 * - 异常快照 fail-open：识别不了的节点绝不隐藏，保持可见（GitHub issue #2 教训）。
 */

import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { subscribeDreamEvents } from './client-dream-events.ts'

/** delegate 打点文本标记（与 host 端 delegate.ts 逐字一致）。 */
export const REFLECT_DELEGATE_MARKER = '【记忆反思标记】'
export const REFLECT_DONE_DELEGATE_MARKER = '【记忆反思完成标记】'
export const DREAM_DELEGATE_MARKER = '【记忆整理标记】'

/** 插件 source 识别（与 client-fold.ts PLUGIN_NAME 一致）。 */
const PLUGIN_NAME = 'meow-memory'

/** 隐藏原始行的 data 属性。 */
const HIDDEN_ATTR = 'data-meow-delegate-hidden'
/** 气泡锚点 data 属性（值=节点 key）。 */
const ANCHOR_ATTR = 'data-meow-delegate-anchor'
/** 模块 CSS 的 style 标记（防热重载堆积：注入前先移除旧标签）。
 *  常量禁止命名 CSS：模块级 CSS 会 shadow 浏览器全局 CSS 命名空间，esbuild 打包
 *  时把全局改名为 CSS2，CSS.escape 变成对字符串常量取方法 → TypeError（2026-09-03
 *  实证，dock slot 整体崩溃连累折叠 UI）。 */
const CSS_ID = 'meow-meow-delegate-notice-css'

const NOTICE_CSS = `[${HIDDEN_ATTR}="true"]{display:none!important}`

export type DelegateVariant = 'reflect' | 'reflect-done' | 'dream'

/** reflect 历史打点的「进行中」保鲜窗口：反思子代理几分钟内跑完，超窗视为早已结束。 */
const REFLECT_FRESH_MS = 30 * 60_000

/** dream「进行中」的租约硬上限（DREAM_LEASE_MS 同款 30min）：打点超窗仍无 dreamed
 *  状态 = 租约必然已过期收尾（Llm 瞬态失败被 release 释放重试）——气泡改显
 *  「已中断，稍后自动重试」，不再永远卡「进行中」（2026-09-05 猫猫实证：智谱 429
 *  期间 dream 15min 周期性失败，气泡刷新也翻不了已完成）。 */
const DREAM_RUNNING_STALE_MS = 30 * 60_000

/** 一个 delegate 打点气泡（打点消息投影出的 context 节点）。 */
export interface DelegateNotice {
  /** context 节点的 key（快照 chat 节点 key，= 原始行 DOM 的 data-chat-flow-key）。 */
  readonly id: string
  readonly variant: DelegateVariant
  /** 任务是否仍在进行（决定气泡文字；reflect-done 恒 false——它只隐藏不出气泡）。 */
  readonly running: boolean
  /** dream 专属：任务已中断（租约超窗仍无 dreamed），稍后自动重试。 */
  readonly interrupted?: boolean
  /** 打点所属会话 id（新打点消息 source.memory.sessionId；历史打点缺省）。 */
  readonly sessionId?: string
}

/** dream 任务状态（与会话列表图标同源：dreamed=整理过，dreaming=进行中）。 */
export type DreamTaskState = 'dreaming' | 'dreamed'

interface NoticeSourceLike {
  kind?: unknown
  plugin?: unknown
  memory?: { kind?: unknown; sessionId?: unknown }
  sections?: readonly { name?: string; text?: string }[]
}

interface NoticeNodeLike {
  readonly kind?: unknown
  readonly data?: {
    readonly source?: NoticeSourceLike
    readonly content?: readonly { type?: string; text?: string }[]
    readonly time?: unknown
  }
}

const META_SECTION_NAME = '__meta__'

/** 从 source.sections 提取 __meta__ 元数据（v0.27.0+ 兼容）。 */
function extractMetaFromSections(
  sections?: readonly { name?: string; text?: string }[],
): { kind?: string; sessionId?: string } | undefined {
  if (!Array.isArray(sections)) return undefined
  const raw = sections.find((s) => s?.name === META_SECTION_NAME)?.text
  if (raw === undefined) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

/** 从 content blocks 提取纯文本（与 client-fold blocksToText 同规则）。 */
function noticeText(node: NoticeNodeLike): string {
  const blocks = node.data?.content ?? []
  return blocks.map((block) => block.text ?? '').join('\n').trim()
}

/** 判定 context 节点是否 delegate 打点（元数据优先，文本兜底）。 */
function delegateVariantOf(node: NoticeNodeLike): DelegateVariant | undefined {
  if (node.kind !== 'context') return undefined
  const source = node.data?.source
  if (source === undefined || source === null || typeof source !== 'object') return undefined
  if (source.kind !== 'plugin' || source.plugin !== PLUGIN_NAME) return undefined
  // v0.27.0+: 优先从 sections.__meta__ 读取；回退到旧 source.memory（兼容历史会话）
  const meta = extractMetaFromSections(source.sections) ?? source.memory
  const memKind = meta?.kind
  if (memKind === 'reflect-marker') return 'reflect'
  if (memKind === 'reflect-done-marker') return 'reflect-done'
  if (memKind === 'dream-marker') return 'dream'
  // 文本兜底：无元数据的旧数据。文本标记与折叠 marker（[meow-memory-reflect]）不同，不撞。
  const text = noticeText(node)
  if (text.includes(REFLECT_DONE_DELEGATE_MARKER)) return 'reflect-done'
  if (text.includes(REFLECT_DELEGATE_MARKER)) return 'reflect'
  if (text.includes(DREAM_DELEGATE_MARKER)) return 'dream'
  return undefined
}

function delegateSessionIdOf(node: NoticeNodeLike): string | undefined {
  // v0.27.0+: 优先从 sections.__meta__ 读取；回退到旧 source.memory（兼容历史会话）
  const meta = extractMetaFromSections(node.data?.source?.sections) ?? node.data?.source?.memory
  const sid = meta?.sessionId
  return typeof sid === 'string' && sid !== '' ? sid : undefined
}

function delegateTimeOf(node: NoticeNodeLike): number | undefined {
  const time = node.data?.time
  return typeof time === 'number' ? time : undefined
}

// ── dream 状态同步（对账 + SSE，client-dream-icon 同数据源的独立轻量订阅） ──

const dreamStateBySession = new Map<string, DreamTaskState>()

/** 测试专用：直接注入 dream 状态表（模拟 dreamed-sessions 对账结果）。生产代码勿用。 */
export function setDreamStatesForTest(entries: ReadonlyArray<readonly [string, DreamTaskState]>): void {
  dreamStateBySession.clear()
  for (const [id, state] of entries) dreamStateBySession.set(id, state)
}
/** 最近一次 apply 的气泡集合：SSE 状态变化时重放它（文本随状态翻转）。 */
let lastApplied: readonly DelegateNotice[] = []

/** dream 是否仍在进行（仅状态表查询；compute 的 dream 三态判定内联于 computeDelegateNotices）：
 *  所属会话精确判定；无 sessionId 的历史打点全局退化
 *  （任一会话 dreaming=可能在说它；状态表空=未知=进行中；有信息且无 dreaming=已完成）。
 *  只有明确 dreamed 才算完成——打点的语义就是任务刚发出（猫猫：处理完了才显示已完成）。
 *  @deprecated 由 computeDelegateNotices 的三态判定（dreaming/dreamed/打点年龄）取代。 */
function dreamRunning(sessionId: string | undefined): boolean {
  if (sessionId !== undefined) return dreamStateBySession.get(sessionId) !== 'dreamed'
  for (const state of dreamStateBySession.values()) {
    if (state === 'dreaming') return true
  }
  return dreamStateBySession.size === 0
}
void dreamRunning

/** 气泡文案（猫猫拍板文案 + 折叠横条同款 ▸ 箭头）——纯映射，可单测。
 *  dream 的 interrupted 优先于 running（中断是终态观感，重试由 host 自动进行）。 */
export function delegateNoticeLabelFor(variant: DelegateVariant, running: boolean, interrupted = false): string {
  if (variant === 'dream') {
    if (interrupted) return '▸ 梦境记忆整理已中断，稍后自动重试。'
    return running ? '▸ 梦境记忆整理任务进行中……' : '▸ 梦境记忆整理任务已完成。'
  }
  if (variant === 'reflect-done') return '▸ 记忆反思任务已完成。'
  return running ? '▸ 记忆反思任务进行中……' : '▸ 记忆反思任务已完成。'
}

/** 气泡文案：按打点的 running 状态渲染。 */
export function delegateNoticeLabel(notice: DelegateNotice): string {
  return delegateNoticeLabelFor(notice.variant, notice.running, notice.interrupted === true)
}

/**
 * 从会话快照计算全部 delegate 打点气泡（按渲染顺序）。
 * reflect 触发打点的 running=它是最后一条 reflect 系打点（触发/完成交替的防重入
 * 序列）且消息时间在保鲜窗口内；dream 走三态判定（dreaming/dreamed/打点年龄兜底）。
 * reflect-done 打点也在输出里（apply 只隐藏、不出气泡——完成信号行同样不该露脸）。
 * @param snapshot - 会话快照（dock 组件收到的 point-in-time 快照）。
 * @param now - 当前时刻（默认 Date.now()；测试可注入）。
 */
export function computeDelegateNotices(snapshot: ConversationSnapshot, now: number = Date.now()): DelegateNotice[] {
  // fail-closed：宿主快照形状变化（如新 dsh 前端 chat 缺失）时降级为不打点，
  // 绝不抛错炸掉 dock（与 PR #11 client-fold 同款守卫）。
  if (snapshot?.chat === undefined) return []
  const found: Array<{ key: string; variant: DelegateVariant; sessionId?: string; time?: number }> = []
  for (const key of snapshot.chat.order) {
    const node = snapshot.chat.nodes.get(key) as unknown as NoticeNodeLike | undefined
    if (node === undefined) continue
    const variant = delegateVariantOf(node)
    if (variant === undefined) continue
    found.push({ key, variant, sessionId: delegateSessionIdOf(node), time: delegateTimeOf(node) })
  }
  // reflect 系打点的最后一条索引：其之前的触发打点全部已完成（触发→完成交替）。
  let lastReflectIdx = -1
  for (let i = 0; i < found.length; i++) {
    if (found[i].variant === 'reflect' || found[i].variant === 'reflect-done') lastReflectIdx = i
  }
  const out: DelegateNotice[] = found.map((f, i) => {
    if (f.variant !== 'dream') {
      return {
        id: f.key,
        variant: f.variant,
        sessionId: f.sessionId,
        running: f.variant === 'reflect' && i === lastReflectIdx && f.time !== undefined && now - f.time < REFLECT_FRESH_MS,
      }
    }
    // dream 三态判定（2026-09-05：error 释放重试语义下，失败窗口在 dreamed-sessions
    // 里永不存在，仅按 dreamed/dreaming 二态会永远卡「进行中」——按打点年龄兜底）：
    // dreaming（活跃租约）→ 进行中；dreamed → 已完成；状态未知时打点 <30min（租约窗）
    // 视为进行中，≥30min 视为已中断（租约 30min 硬上限，超窗未 dreamed 必然失败释放，
    // host 下个检查周期自动重试）。无 sessionId 的远古打点同走年龄兜底（可能把早已
    // 完成的显示为已中断——好过永久「进行中」）。
    const state = f.sessionId !== undefined ? dreamStateBySession.get(f.sessionId) : undefined
    if (state === 'dreaming') return { id: f.key, variant: f.variant, sessionId: f.sessionId, running: true }
    if (state === 'dreamed') return { id: f.key, variant: f.variant, sessionId: f.sessionId, running: false }
    const stale = f.time !== undefined && now - f.time >= DREAM_RUNNING_STALE_MS
    return { id: f.key, variant: f.variant, sessionId: f.sessionId, running: !stale, interrupted: stale }
  })
  // 临时诊断（2026-09-03，定案后移除）：气泡识别结果。
  if (out.length > 0) console.debug('[meow-dg] notices:', out.map((n) => `${n.id.slice(0, 8)}:${n.variant}:${n.running ? 'run' : 'done'}`).join(', '))
  return out
}

/** 注入模块 CSS（幂等：先移除旧标签再注入，防热重载堆积）。 */
function ensureCss(): void {
  if (typeof document === 'undefined') return
  for (const stale of Array.from(document.querySelectorAll(`style[data-plugin-css="${CSS_ID}"]`))) {
    stale.remove()
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = 'meow-memory-delegate-notice'
  tag.dataset.pluginCss = CSS_ID
  tag.textContent = NOTICE_CSS
  document.head.appendChild(tag)
}

/**
 * 应用一次气泡状态（幂等；对每个 chat 流容器独立处理）。
 * 只做：原始行隐藏（data 属性）+ 锚点/气泡存在性与文本——不重建，
 * 与 client.ts 折叠锚点同模式，MutationObserver 重放不会自我循环。
 * 气泡锚点是原始行的**前兄弟节点**（行整体 display:none，挂在行内会一起消失）。
 * reflect-done 打点只隐藏（它是状态信号，不出气泡）。
 */
export function applyDelegateNotices(groups: readonly DelegateNotice[]): void {
  if (typeof document === 'undefined') return
  lastApplied = groups
  ensureCss()
  const containers = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-flow]'))
  if (containers.length === 0) return
  // 临时诊断（2026-09-03，定案后移除）：气泡落 DOM 情况。
  if (groups.length > 0) console.debug('[meow-dg] apply:', groups.length, 'group(s),', containers.length, 'container(s)')
  const liveIds = new Set(groups.map((group) => group.id))
  for (const container of containers) {
    // 清理已不存在的组的锚点。
    for (const stale of Array.from(container.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTR}]`))) {
      if (!liveIds.has(stale.getAttribute(ANCHOR_ATTR) ?? '')) stale.remove()
    }
    // 摘掉失效的隐藏标记：原始行 key 不在识别结果里 = 保持可见（fail-open）。
    for (const row of Array.from(container.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`))) {
      if (!liveIds.has(row.getAttribute('data-chat-flow-key') ?? '')) row.removeAttribute(HIDDEN_ATTR)
    }
    for (const group of groups) {
      const row = container.querySelector<HTMLElement>(`[data-chat-flow-key="${CSS.escape(group.id)}"]`)
      if (row === null || row.parentElement === null) continue
      row.setAttribute(HIDDEN_ATTR, 'true')
      if (group.variant === 'reflect-done') continue // 完成信号行：只隐藏，不出气泡
      let anchor = container.querySelector<HTMLElement>(`[${ANCHOR_ATTR}="${CSS.escape(group.id)}"]`)
      if (anchor === null) {
        anchor = document.createElement('div')
        anchor.setAttribute(ANCHOR_ATTR, group.id)
        row.parentElement.insertBefore(anchor, row)
      }
      let bubble = anchor.querySelector<HTMLElement>(':scope > [data-meow-delegate-bubble]')
      if (bubble === null) {
        bubble = document.createElement('div')
        bubble.setAttribute('data-meow-delegate-bubble', 'true')
        // 折叠横条同款胶囊视觉（client.ts ensureAnchor bar cssText）。不可点击：
        // 内容在子代理里，主会话没有可展开的东西。
        bubble.style.cssText = [
          'display:block;margin:4px 0;padding:5px 12px;',
          'font-size:12px;line-height:1.6;text-align:left;',
          'color:var(--dsw-text-secondary, rgba(127,127,127,.9));',
          'background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.14);',
          'border-radius:999px;',
        ].join('')
        anchor.appendChild(bubble)
      }
      const label = delegateNoticeLabel(group)
      if (bubble.textContent !== label) bubble.textContent = label
    }
  }
}

/**
 * 启动 dream 状态同步（气泡文案的状态源）：
 * 挂载时全量对账 /meow-memory/dreamed-sessions，增量走共享轮询
 * subscribeDreamEvents（client-dream-events.ts，2026-09-05 连接池修复：替代原
 * 每管理器一条的 dream-events SSE 长连接）。状态变化时自动重放最近一次
 * applyDelegateNotices（气泡文本随状态翻转，如「进行中……」→「已完成。」）。
 * 路由不可用（旧版本 host）静默降级：气泡退化为静态文案，不报错。
 * @returns 清理函数（移除订阅）。
 */
export function startDelegateStateSync(): () => void {
  if (typeof window === 'undefined') return () => {}

  const notify = (): void => {
    if (lastApplied.length > 0) applyDelegateNotices(lastApplied)
  }

  const refresh = async (): Promise<void> => {
    try {
      const response = await fetch('/meow-memory/dreamed-sessions', { cache: 'no-store' })
      if (!response.ok) {
        console.debug('[meow-dg] dreamed-sessions HTTP', response.status)
        return
      }
      const data = await response.json() as { sessionIds?: unknown; dreamingIds?: unknown }
      dreamStateBySession.clear()
      if (Array.isArray(data.sessionIds)) {
        for (const id of data.sessionIds) if (typeof id === 'string') dreamStateBySession.set(id, 'dreamed')
      }
      if (Array.isArray(data.dreamingIds)) {
        for (const id of data.dreamingIds) if (typeof id === 'string') dreamStateBySession.set(id, 'dreaming')
      }
      // 临时诊断（2026-09-03，定案后移除）。
      console.debug('[meow-dg] state sync:', dreamStateBySession.size, 'session(s)')
      notify()
    } catch {
      // 路由不可用：静默降级。
    }
  }

  // 增量订阅（共享 60s 轮询 diff，替代原每页一条的 EventSource——连接池饥饿
  // 修复，见 client-dream-events.ts 头注）。事件语义与旧 SSE 'dream' 帧一致。
  const unsubscribeDreamEvents = subscribeDreamEvents((event) => {
    const { sessionId, state } = event
    if (state === 'dreaming' || state === 'dreamed') dreamStateBySession.set(sessionId, state)
    else dreamStateBySession.delete(sessionId) // 'active'（新活动）/skip/未知：去状态
    notify()
  })

  void refresh()

  return () => {
    unsubscribeDreamEvents()
    dreamStateBySession.clear()
    lastApplied = []
  }
}
