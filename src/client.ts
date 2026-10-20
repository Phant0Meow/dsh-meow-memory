/**
 * meow-memory — 反思轮折叠 UI（client 端）。
 *
 * 目标：记忆反思/dream 轮（prompt 注入 + 后续 think/tool call/汇报）不刷屏——
 * 折叠成一条横条（默认折叠），点击横条向下展开成一个大卡片，对话记录
 * 显示在卡片里面；再点收起。原始消息流里的行始终隐藏。
 *
 * 机制（纯插件，不改 dsh 本体）：
 * - 挂 conversation.composer.dock（随宿主形态取会话快照：0.1.2- 读 session prop，
 *   0.1.3+/0.1.5 用 useChat hook，见 MemoryFoldDock）；
 * - computeFoldGroups 从快照识别 meow-memory 注入的 context 节点及其 turn 范围；
 * - DOM：chat 视图每个节点行有稳定 data-chat-flow-key 锚点，隐藏 + 原位插入
 *   横条锚点（细条 bar + 展开卡片 body）；展开时把原始行 cloneNode 进卡片
 *   （复用原渲染样式，克隆为静态快照，交互不复制）；
 * - MutationObserver 兜底：视图切换（chat↔trajectory）/元素重建后自动重新应用。
 *   防自循环：applyFoldState 只做幂等操作（属性写入/元素存在性），不重建、
 *   不碰卡片内容——卡片内容只在 toggle 时同步填充/清空。
 */

import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { AssistantChatData, ChatNode, ToolChatData } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { blocksToText, computeFoldGroups, computeInjectionGroups, foldLabel, formatInjectionClock, memoryTurnNumbers, toolCallDetail, type FoldGroup, type InjectionGroup } from './client-fold.ts'
import {
  applyVanishDom,
  computeVanishDecision,
  SENTINEL_ATTR,
  startVanishObserver,
  type VanishDecision,
} from './client-delegate-vanish.ts'
import { applyDelegateNotices, computeDelegateNotices, startDelegateStateSync, type DelegateNotice } from './client-delegate-notice.ts'
import { startDreamIconManager } from './client-dream-icon.ts'
import { startDreamSkipManager } from './client-dream-skip.ts'
import { startMenuDreamFace } from './client-menu-dream.ts'
import { applySettingsPage } from './settings-page.ts'
import { installI18n, onUiLocaleChange, t } from './i18n/index.js'

/** 折叠行标记（CSS 规则隐藏）。 */
const FOLDED_ATTR = 'data-meow-memory-folded'
const ANCHOR_ATTR = 'data-meow-memory-anchor'
const BODY_ATTR = 'data-meow-memory-body'
const INJ_ANCHOR_ATTR = 'data-meow-injection-anchor'
const INJ_BODY_ATTR = 'data-meow-injection-body'
const INJ_PROMPT_ATTR = 'data-meow-injection-prompt'

const FOLD_CSS = `[${FOLDED_ATTR}="true"] { display: none !important; }
[data-meow-detail-body] {
  display: none;
  margin: 2px 0 8px 22px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-secondary, rgba(190,190,190,.9));
  background: rgba(127,127,127,.06);
  border: 1px solid rgba(127,127,127,.12);
  border-radius: 8px;
  font-family: ui-monospace, 'Cascadia Code', Consolas, 'Courier New', monospace;
}
[data-meow-detail-body="think"] {
  font-family: inherit;
  font-style: italic;
  opacity: .9;
}
[${INJ_BODY_ATTR}] {
  display: none;
  margin: 2px 0 8px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-secondary, rgba(190,190,190,.9));
  background: rgba(127,127,127,.05);
  border: 1px solid rgba(127,127,127,.12);
  border-radius: 8px;
  font-family: ui-monospace, 'Cascadia Code', Consolas, 'Courier New', monospace;
}
[${INJ_PROMPT_ATTR}] {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
/* 用户 prompt 气泡：样式对齐 dsh 本体 UserStyleBubble（MessageItem.module.css
 * .userStack/.bubble）——同 token 同尺寸，主题切换自动跟随。 */
[${INJ_PROMPT_ATTR}] > [data-meow-inj-bubble] {
  max-width: min(525px, 82%);
  padding: 10px 16px;
  border-radius: 22px;
  background: var(--dsw-specific-bubble);
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  line-height: 24px;
  white-space: pre-wrap;
  word-break: break-word;
}
[data-meow-inj-actions] {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 28px;
  background: transparent;
}
[data-meow-inj-time] {
  padding-right: 12px;
  font-size: 14px;
  line-height: 24px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
  background: transparent;
}
@media (hover: hover) {
  [data-meow-inj-time] {
    opacity: 0;
    transition: opacity 80ms ease;
  }
  [${INJ_PROMPT_ATTR}]:hover [data-meow-inj-time],
  [${INJ_PROMPT_ATTR}]:focus-within [data-meow-inj-time] {
    opacity: 1;
  }
}
[data-meow-inj-copy] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: none;
  border-radius: 28px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
[data-meow-inj-copy]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}`

/** 卡片克隆签名缓存（groupId → 原始行文本签名）：展开时行内容更新/不完整则自愈重克隆。 */
const bodySigs = new Map<string, string>()

/** 原始行当前文本签名（全文：流式补全是尾部追加，截断会漏检）。 */
function sigOf(container: HTMLElement, keys: readonly string[]): string {
  return keys.map((key) => flowRow(container, key)?.textContent ?? '').join('\u0001')
}

/** 匹配某 key 的原始节点行（key 含特殊字符时 CSS.escape）。 */
function flowRow(container: HTMLElement, key: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-chat-flow-key="${CSS.escape(key)}"]`)
}

/** 注入横条的落点行。
 *  旧宿主把注入块渲染成独立行 → 直接用节点自身的行；
 *  dsh 0.2.x 起注入 context 不再单独成行（只在快照里，宿主把内容合进用户消息），
 *  于是退化为「注入文本尾部那段用户 prompt 所在的输入行」—— 横条落在用户消息
 *  上方，展开仍显示注入全文（全文来自快照，不依赖 DOM 行）。 */
function injectionRow(
  container: HTMLElement,
  group: { id: string; turn?: number },
): { row: HTMLElement; exact: boolean } | null {
  const exact = flowRow(container, group.id)
  if (exact !== null) return { row: exact, exact: true }
  // dsh 0.2.x：注入块不再单独成行（宿主把它合进用户消息），按 turn 找该轮第一行
  if (typeof group.turn === 'number') {
    const sameTurn = container.querySelector<HTMLElement>(`[data-chat-turn="${group.turn}"]`)
    if (sameTurn !== null) return { row: sameTurn, exact: false }
  }
  return null
}
function applyInjectionFold(
  groups: readonly InjectionGroup[],
  expanded: ReadonlySet<string>,
  onToggle: (id: string) => void,
): void {
  const containers = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-flow]'))
  if (containers.length === 0) return
  const liveIds = new Set(groups.map((g) => g.id))
  for (const container of containers) {
    for (const stale of Array.from(container.querySelectorAll<HTMLElement>(`[${INJ_ANCHOR_ATTR}]`))) {
      if (!liveIds.has(stale.getAttribute(INJ_ANCHOR_ATTR) ?? '')) stale.remove()
    }
    for (const group of groups) {
      const startRow = injectionRow(container, group)
      if (startRow === null || startRow.parentElement === null) continue
      startRow.setAttribute(FOLDED_ATTR, 'true') // 原行隐藏
      let anchor = container.querySelector<HTMLElement>(`[${INJ_ANCHOR_ATTR}="${CSS.escape(group.id)}"]`)
      if (anchor === null) {
        anchor = document.createElement('div')
        anchor.setAttribute(INJ_ANCHOR_ATTR, group.id)
        startRow.parentElement.insertBefore(anchor, startRow)
      }
      let bar = anchor.querySelector<HTMLButtonElement>(':scope > button')
      if (bar === null) {
        bar = document.createElement('button')
        bar.type = 'button'
        // 右对齐 + 与用户气泡同宽（max-width 82%）——横条视觉归属用户消息。
        bar.style.cssText = [
          'display:block;margin:4px 0 4px auto;max-width:82%;padding:5px 12px;',
          'font-size:12px;line-height:1.6;text-align:left;cursor:pointer;',
          'color:var(--dsw-alias-label-secondary, rgba(127,127,127,.9));',
          'background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.14);',
          'border-radius:999px;',
        ].join('')
        bar.addEventListener('click', () => onToggle(group.id))
        anchor.appendChild(bar)
      }
      const kindLabel = t(group.kind === 'first' ? 'inject.kind.first' : 'inject.kind.hit')
      const label = `${expanded.has(group.id) ? '▾' : '▸'} ${t('inject.bar')}${kindLabel}`
      if (bar.textContent !== label) bar.textContent = label
      let body = anchor.querySelector<HTMLElement>(`:scope > [${INJ_BODY_ATTR}]`)
      if (body === null) {
        body = document.createElement('div')
        body.setAttribute(INJ_BODY_ATTR, 'true')
        anchor.appendChild(body)
      }
      if (expanded.has(group.id)) {
        if (body.textContent !== group.injectedText) body.textContent = group.injectedText
        body.style.display = 'block'
      } else {
        body.style.display = 'none'
      }
      // 旧格式把记忆和 prompt 粘在同一 user 消息里，需重建纯净 prompt 气泡。
      // 新格式只隐藏独立 plugin 行，真实 user 行由 DSH 原生渲染。
      let prompt = anchor.querySelector<HTMLElement>(`:scope > [${INJ_PROMPT_ATTR}]`)
      if (group.userText === undefined) {
        prompt?.remove()
        continue
      }
      if (prompt === null) {
        prompt = document.createElement('div')
        prompt.setAttribute(INJ_PROMPT_ATTR, 'true')
        const bubble = document.createElement('div')
        bubble.dataset.meowInjBubble = 'true'
        prompt.appendChild(bubble)
        const actions = document.createElement('div')
        actions.dataset.meowInjActions = 'true'
        const timeLabel = document.createElement('span')
        timeLabel.dataset.meowInjTime = 'true'
        actions.appendChild(timeLabel)
        const copyButton = document.createElement('button')
        copyButton.type = 'button'
        copyButton.dataset.meowInjCopy = 'true'
        copyButton.title = t('inject.copy')
        copyButton.setAttribute('aria-label', t('inject.copy'))
        copyButton.innerHTML = COPY_ICON_SVG
        copyButton.addEventListener('click', () => {
          if (group.userText !== undefined) {
            void copyInjectionText(copyButton, group.userText)
          }
        })
        actions.appendChild(copyButton)
        prompt.appendChild(actions)
        anchor.appendChild(prompt)
      }
      const bubble = prompt.querySelector<HTMLElement>(':scope > [data-meow-inj-bubble]')
      if (bubble !== null && bubble.textContent !== group.userText) bubble.textContent = group.userText
      const timeLabel = prompt.querySelector<HTMLElement>(':scope > [data-meow-inj-actions] > [data-meow-inj-time]')
      if (timeLabel !== null) {
        const label = group.time === undefined ? '' : formatInjectionClock(group.time)
        if (timeLabel.textContent !== label) timeLabel.textContent = label
        if (label === '') timeLabel.style.display = 'none'
        else if (timeLabel.style.display !== '') timeLabel.style.display = ''
      }
    }
  }
}

/** 应用一次折叠状态（幂等；对每个 chat 流容器独立处理）。
 *  只做：行隐藏 + 锚点/细条存在性与文本——不重建；展开组的卡片在
 *  原始行内容变化（流式补全/产物到达/视图重建）时按签名自愈重克隆。 */
function applyFoldState(
  groups: readonly FoldGroup[],
  expanded: ReadonlySet<string>,
  onToggle: (id: string) => void,
  session: ConversationSnapshot,
): void {
  const containers = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-flow]'))
  if (containers.length === 0) return
  const liveIds = new Set(groups.map((group) => group.id))
  for (const container of containers) {
    // 清理已不存在的组的锚点。
    for (const stale of Array.from(container.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTR}]`))) {
      if (!liveIds.has(stale.getAttribute(ANCHOR_ATTR) ?? '')) stale.remove()
    }
    for (const group of groups) {
      // 原始行始终隐藏（对话记录只在展开卡片里展示）。
      for (const key of group.keys) {
        const row = flowRow(container, key)
        if (row === null) continue
        row.setAttribute(FOLDED_ATTR, 'true')
      }
      ensureAnchor(container, group, expanded.has(group.id), onToggle)
      if (expanded.has(group.id)) {
        // 自愈：克隆快照落后于原始行（点击时行未完整/之后被更新）→ 重克隆收敛。
        const sig = sigOf(container, group.keys)
        if (bodySigs.get(group.id) !== sig) fillBody(group.id, true, group.keys, session)
      } else {
        bodySigs.delete(group.id)
      }
    }
  }
}

/** 0.1.5 右侧 turn 导航框的内联变量（frameStyle 设置；语义命名非哈希，全文档唯一）。 */
const TURN_NAV_FRAME_VAR = '--turn-rail-inset'

/** 隐藏 turn 导航条上的 memory 轮刻度（2026-09-10 用户拍板：反思/梦境独立成轮后
 *  会在 0.1.5 右侧导航多出刻度，很困扰）。
 *  定位：宿主导航框是唯一带 --turn-rail-inset 内联变量的 nav（类名是内容哈希
 *  不可依赖，aria-label 文案随语言变）；刻度按钮的 aria-label 内插 turn 号
 *  （数字不随语言变），取其中整数比对 memory turn 集合。
 *  刻度为绝对定位，隐藏后留一小段空隙；hover 预览与跳转随刻度一起消失。
 *  旧宿主（0.1.2-）没有导航条：查询为空，纯 no-op。 */
function applyTurnNavHiding(memoryTurns: ReadonlySet<number>): void {
  if (memoryTurns.size === 0) return
  for (const nav of document.querySelectorAll<HTMLElement>('nav[style]')) {
    if (nav.style.getPropertyValue(TURN_NAV_FRAME_VAR) === '') continue // 只处理宿主 turn 导航框
    for (const btn of nav.querySelectorAll('button[aria-label]')) {
      const nums = (btn.getAttribute('aria-label') ?? '').match(/\d+/g)
      if (nums === null) continue
      const turn = Number(nums[nums.length - 1])
      const slot = btn.parentElement
      if (Number.isInteger(turn) && memoryTurns.has(turn) && slot !== null) slot.style.display = 'none'
    }
  }
}

/**
 * 隐形 dock 条目：不渲染可见 UI（横条直接进消息流 DOM），只随快照驱动折叠。
 *
 * 双版本 props（2026-09-10）：
 * - dsh 0.1.2 及以下：`{ session: ConversationSnapshot, input }`——session 即含
 *   `.chat` 的会话快照；
 * - dsh 0.1.3+/0.1.5：dock 条目改发 hooks（与第一方 StatsPills 同款契约）——
 *   `useChat(selector)` 响应式取 chat 快照，`session` 缺席或只剩生命周期字段。
 * 取快照一律能力探测：有 useChat 走 hooks，否则回退 props.session——旧宿主
 * 行为逐字节不变。两版都拿不到 chat（异常宿主）时 fail-closed 不折叠。
 */
const chatIdentity = (chat: unknown): unknown => chat

export function MemoryFoldDock(props: {
  /** 旧宿主（0.1.2-）：含 .chat 的会话快照；新宿主上缺席或为纯生命周期快照。 */
  session?: unknown
  /** 新宿主（0.1.3+）：响应式 chat 快照 hook（useChat(selector) → ChatSnapshot）。 */
  useChat?: (selector: (chat: unknown) => unknown) => unknown
}): null {
  const useChat = props?.useChat
  // hooks 顺序按宿主形态固定（同一宿主内 useChat 要么恒在要么恒缺），不违反规则。
  const chatViaHook = typeof useChat === 'function' ? useChat(chatIdentity) : undefined
  const legacySession = props?.session as { chat?: unknown } | undefined
  const snapshot: unknown = chatViaHook !== undefined
    ? { chat: chatViaHook }
    : (legacySession !== null && typeof legacySession === 'object' && legacySession.chat !== undefined
        ? legacySession
        : undefined)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [injExpanded, setInjExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const groups = useMemo(() => computeFoldGroups(snapshot as never), [snapshot])
  const injGroups = useMemo(() => computeInjectionGroups(snapshot as never), [snapshot])
  const dgNotices = useMemo(() => computeDelegateNotices(snapshot as never), [snapshot])
  const memTurns = useMemo(() => memoryTurnNumbers(snapshot as never), [snapshot])
  const toggle = useCallback((id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      const willExpand = !next.has(id)
      if (willExpand) next.add(id)
      else next.delete(id)
      // 同步填充/清空展开卡片（不依赖 effect 时序，也避免 observer 循环）。
      const group = groups.find((candidate) => candidate.id === id)
      fillBody(id, willExpand, group?.keys ?? [], snapshot as never)
      return next
    })
  }, [groups, snapshot])
  const toggleInj = useCallback((id: string): void => {
    setInjExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // 快照/展开态变化 → 重放折叠（行隐藏 + 锚点，不改卡片内容）。
  useLayoutEffect(() => {
    applyFoldState(groups, expanded, toggle, snapshot as never)
    applyInjectionFold(injGroups, injExpanded, toggleInj)
    applyDelegateNotices(dgNotices)
    applyTurnNavHiding(memTurns)
  }, [groups, expanded, toggle, snapshot, injGroups, injExpanded, toggleInj, dgNotices, memTurns])

  // 兜底：视图切换/元素重建/流式重渲染导致 DOM 变化时自愈（防抖）。
  const latest = useRef({ groups, expanded, toggle, snapshot, injGroups, injExpanded, toggleInj, dgNotices, memTurns })
  latest.current = { groups, expanded, toggle, snapshot, injGroups, injExpanded, toggleInj, dgNotices, memTurns }
  useEffect(() => {
    let timer = 0
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        applyFoldState(latest.current.groups, latest.current.expanded, latest.current.toggle, latest.current.snapshot as never)
        applyInjectionFold(latest.current.injGroups, latest.current.injExpanded, latest.current.toggleInj)
        applyDelegateNotices(latest.current.dgNotices)
        applyTurnNavHiding(latest.current.memTurns)
      }, 80)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [])

  // UI 语言切换（DSH 设置 → 通用 → 语言）：横条/气泡文案是纯 DOM 写入，不会随
  // React 重渲染自动更新——用重放注册表在语言变化时用当前语言重刷一次。重放读
  // ref 里的最新快照（订阅回调不依赖闭包时序），且与 observer 同款幂等。
  useEffect(() => {
    return onUiLocaleChange(() => {
      applyFoldState(latest.current.groups, latest.current.expanded, latest.current.toggle, latest.current.snapshot as never)
      applyInjectionFold(latest.current.injGroups, latest.current.injExpanded, latest.current.toggleInj)
      applyDelegateNotices(latest.current.dgNotices)
    })
  }, [])

  return null
}

/**
 * header 子代理列表隐身哨兵（client-delegate-vanish 链路的 React 壳）：
 * 挂 conversation.session.header.actions 叠加槽（lineage 是 single 槽：官方
 * SubagentHeaderLineage 独占，同槽注册抛错、顶替则毁掉官方 UI）——useSessions
 * 只读订阅官方 sessions store，复刻官方 count 公式做 trigger 决策；行隐藏与
 * 自愈 observer 在纯逻辑模块里。
 * 零视觉输出（display:none 哨兵作 DOM 定位锚点）；useSessions 不可用时
 * fail-open（不订阅、不动 DOM）。
 * @param useSessions - renderer standardProps 注入的官方 store hook。
 * @param refreshSubagents - sessions face 的 catalog 刷新（apply 闭包注入；
 *   缺省时目录未加载则决策 fail-open，等官方 UI 自行加载后收敛）。
 */
function makeDelegateVanishDock(
  refreshSubagents: ((parentSessionId: string) => unknown) | undefined,
): (props: { useSessions?: (selector: (state: any) => any) => any }) => any {
  return function DelegateVanishDock({ useSessions }: { useSessions?: (selector: (state: any) => any) => any }): any {
    // 三个独立 selector：各自返回 store 内部稳定引用（新对象会破坏
    // useSyncExternalStore 语义导致死循环），任一变化即重渲染。
    const current: string | undefined = useSessions?.((state: any) => state?.current)
    const byId = useSessions?.((state: any) => state?.byId)
    const catalogs = useSessions?.((state: any) => state?.subagentsByParent)
    const sentinelRef = useRef<HTMLElement | null>(null)
    const decision: VanishDecision = useMemo(
      () => computeVanishDecision({ current, byId, subagentsByParent: catalogs }),
      [current, byId, catalogs],
    )
    const latest = useRef<{ decision: VanishDecision }>({ decision })
    latest.current = { decision }

    // 数据驱动：决策变化 → 立即应用（行 + trigger）。
    useLayoutEffect(() => {
      applyVanishDom(decision, sentinelRef.current)
    }, [decision])

    useEffect(() => {
      // 目录尚未被官方 UI 请求时主动拉一次（manager 幂等去重；失败静默，
      // 决策退化为 fail-open，等官方 trigger/菜单加载后自然收敛）。
      if (current !== undefined && typeof refreshSubagents === 'function') {
        try {
          refreshSubagents(current)
        } catch {
          /* catalog 拉取失败不打扰用户 */
        }
      }
      // 兜底：菜单 portal 渲染 / React 重渲染 / trigger 重建后自愈。
      return startVanishObserver(() => ({ decision: latest.current.decision, sentinel: sentinelRef.current }))
    }, [current])

    return createElement('span', {
      [SENTINEL_ATTR]: '1',
      style: { display: 'none' },
      ref: sentinelRef,
    })
  }
}

/**
 * 浏览器端插件体：注入折叠 CSS（常驻，防多会话/卸载时折叠失效），
 * 并注册 composer.dock 隐形条目驱动折叠、header 隐身哨兵（挂 header.actions 叠加槽）。
 * @param ctx - client 根上下文（slots / sessions 服务）。
 */
// settingsScope / configForms 都不进强制 inject：两者都是可选服务（0.1.6 只有
// settingsScope，0.1.7 只有 configForms），写进清单会让缺它的那一版整个插件
// pending（"waiting for service: …"）。官方纪律=只 inject 必需服务，可选服务走
// ctx 软取——applySettingsPage 双腿软取（0.1.6 走 settingsScope.bind，0.1.7 短
// 轮询等 configForms 提供方就绪后 get(entryId) 当 scope），缺服务只降级不阻断。
// remote.settings 进清单（2026-09-25）：设置写入失败探针要直调 remote.settings
// 拿宿主拒因原文——cordis rejectGuard 按「remote.settings」复合键守卫，不声明
// 则属性访问直接抛（ctx.get('remote') 能过、.settings 仍拦，实证）。两版宿主的
// api-settings-controller 都提供该服务，无 pending 风险。
export const inject = ['slots', 'sessions', 'remote.settings']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): () => void {
  const disposers: Array<() => void> = []
  // UI 文案层（v0.27.0）：跟随 DSH 语言设置（zh/en/pt-br），并向 locale 服务注册
  // 本插件的语言与字典。必须在设置页/折叠/气泡读取文案之前装好；无 locale 服务
  // 的老宿主自动降级（浏览器语言 + 内置字典），失败只告警不阻断插件。
  try {
    installI18n(ctx)
  } catch (e) {
    console.warn('[meow-memory] 文案层初始化失败（UI 退回默认语言）：', e)
  }
  // 会话列表"已 dream"小月牙：独立于 slots，直接启动（host 路由不可用时静默降级）。
  disposers.push(startDreamIconManager())
  // delegate 打点气泡的 dream 状态同步（SSE）：dream 完成时气泡「处理中…」→「已完成 ✓」。
  disposers.push(startDelegateStateSync())
  // 会话「…」菜单「跳过梦境整理记忆」toggle（v0.16.0）：同上独立启动，静默降级。
  disposers.push(startDreamSkipManager())
  // 指令菜单 dream 行换官方脸（0.1.7 菜单 DOM 装饰；0.1.6 菜单结构不同天然不命中）。
  disposers.push(startMenuDreamFace())
  // 设置页「喵记忆」标签页（settings.section 顶级分区，0.1.6/0.1.7 双版本）：
  // 服务缺失、轮询超时或注册失败只警告，不影响折叠/图标。
  try {
    disposers.push(applySettingsPage(ctx))
  } catch (e) {
    console.warn('[meow-memory] 设置页注册失败（不影响折叠与图标）：', e)
  }
  // CSS 常驻全局（不随组件卸载移除：折叠行的隐藏由 data 属性驱动，规则在即生效）。
  // 热重载时 dispose 不删 style，直接 append 会堆积多代规则——旧代规则（如假气泡
  // 时代的 `[data-meow-injection-prompt] > div` 背景）会以同等/更高特异性命中新 DOM
  // （操作行灰底就是这么来的）。注入前先移除本插件旧 style：任意时刻只有一份最新规则。
  for (const stale of Array.from(document.querySelectorAll('style[data-meow-memory-css]'))) {
    stale.remove()
  }
  const style = document.createElement('style')
  style.dataset.meowMemoryCss = 'true'
  // 0.1.6 加载器认领无主 <style> 并在其他插件热替换时连坐删除——必须自报家门。
  style.dataset.plugin = 'meow-memory'
  style.textContent = FOLD_CSS
  document.head.appendChild(style)
  const slots = ctx?.slots
  if (slots === undefined || typeof slots.inject !== 'function') {
    console.warn('[meow-memory] slots service unavailable; reflection folding disabled')
  } else {
    disposers.push(slots.inject('conversation.composer.dock', () => slots.register(
      {
        name: 'conversation.composer.dock',
        id: 'meow-memory',
        order: 90,
      },
      MemoryFoldDock,
    )))
    // header 子代理列表隐身（delegate fork 子代理全程不出现在 header）：
    // conversation.session.header.lineage 是 single 槽，官方 SubagentHeaderLineage
    // 已以 priority 0 独占——同槽再注册直接抛错，顶替则会毁掉官方 UI；哨兵改挂
    // 同 header 的叠加 actions 槽（list），隐形 span 落在 header 里即作 DOM 锚点。
    // sessions face 拿不到时 refresh 传 undefined，决策退化 fail-open。
    const sessions = ctx?.sessions
    const refreshSubagents = typeof sessions?.refreshSubagents === 'function'
      ? (id: string) => sessions.refreshSubagents(id)
      : undefined
    disposers.push(slots.inject('conversation.session.header.actions', () => slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'meow-memory',
        order: 200,
      },
      makeDelegateVanishDock(refreshSubagents),
    )))
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 清理失败不阻塞 */
      }
    }
  }
}
