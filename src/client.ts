/**
 * meow-memory — 反思轮折叠 UI（client 端）。
 *
 * 目标：记忆反思/dream 轮（prompt 注入 + 后续 think/tool call/汇报）不刷屏——
 * 折叠成一条横条（默认折叠），点击横条向下展开成一个大卡片，对话记录
 * 显示在卡片里面；再点收起。原始消息流里的行始终隐藏。
 *
 * 机制（纯插件，不改 dsh 本体）：
 * - 挂 conversation.composer.dock（InputZone 提供会话快照，随快照重渲染）；
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
import type { InputZone } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AssistantChatData, ChatNode, ToolChatData } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { blocksToText, computeFoldGroups, computeInjectionGroups, foldLabel, formatInjectionClock, toolCallDetail, type FoldGroup, type InjectionGroup } from './client-fold.ts'
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
import { applySettingsPage } from './settings-page.ts'

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

/** 匹配某折叠组的横条锚点。 */
function anchorOf(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[${ANCHOR_ATTR}="${CSS.escape(id)}"]`)
}

/** 构建/更新一个折叠组的锚点（细条 bar + 展开卡片 body）。
 *  幂等：元素只创建一次，文本仅在变化时写入——重建/反复写文本会触发
 *  MutationObserver → 自我循环（横条被反复替换，点击必然丢失）。 */
function ensureAnchor(
  container: HTMLElement,
  group: FoldGroup,
  expanded: boolean,
  onToggle: (id: string) => void,
): void {
  let anchor = anchorOf(container, group.id)
  if (anchor === null) {
    const startRow = flowRow(container, group.id)
    if (startRow === null || startRow.parentElement === null) return
    anchor = document.createElement('div')
    anchor.setAttribute(ANCHOR_ATTR, group.id)
    startRow.parentElement.insertBefore(anchor, startRow)
  }
  let bar = anchor.querySelector<HTMLButtonElement>(':scope > button')
  if (bar === null) {
    bar = document.createElement('button')
    bar.type = 'button'
    bar.style.cssText = [
      'display:block;width:100%;margin:4px 0;padding:5px 12px;',
      'font-size:12px;line-height:1.6;text-align:left;cursor:pointer;',
      'color:var(--dsw-text-secondary, rgba(127,127,127,.9));',
      'background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.14);',
      'border-radius:999px;',
    ].join('')
    bar.addEventListener('click', () => onToggle(group.id))
    anchor.appendChild(bar)
  }
  const label = foldLabel(group, expanded)
  if (bar.textContent !== label) bar.textContent = label
  let body = anchor.querySelector<HTMLElement>(`:scope > [${BODY_ATTR}]`)
  if (body === null) {
    body = document.createElement('div')
    body.setAttribute(BODY_ATTR, 'true')
    body.style.display = 'none'
    body.style.cssText = [
      'display:none;',
      'background:rgba(127,127,127,.05);',
      'border:1px solid rgba(127,127,127,.12);',
      'border-radius:12px;',
      'margin:2px 0 6px;',
      'padding:6px 10px;',
      'max-height:70vh;',
      'overflow-y:auto;',
    ].join('')
    anchor.appendChild(body)
  }
}

/**
 * 给克隆的静态行补上折叠块（Think / tool call）的展开能力。
 * 背景：dsh UI 的 DisclosureRow 展开内容（think 全文 / tool 详情）是 React 条件渲染
 * （open && children），折叠时不在 DOM 里——纯 DOM 克隆会永久丢失，且 React 事件
 * 不复制导致"点不开"。这里用快照数据把详情补进克隆 DOM，并用原生 click 切换
 * data-open + 显示/隐藏（幂等：每行只增强一次，fillBody 每次重建克隆）。
 */
function attachDisclosure(rowEl: HTMLElement, label: string, text: string): void {
  const root = rowEl.parentElement
  if (root === null) return
  if (root.querySelector(':scope > [data-meow-detail-body]') !== null) return // 已增强
  const body = document.createElement('div')
  body.setAttribute('data-meow-detail-body', label)
  body.textContent = text
  body.style.display = 'none'
  root.appendChild(body)
  rowEl.addEventListener('click', () => {
    const open = root.getAttribute('data-open') === 'true'
    root.setAttribute('data-open', open ? '' : 'true')
    body.style.display = open ? 'none' : 'block'
  })
}

/** 增强一个克隆行：按快照数据补 Think/tool/context 详情（同类块按 DOM 顺序匹配源顺序）。 */
function enhanceClone(clone: HTMLElement, node: ChatNode | undefined): void {
  if (node === undefined) return
  // 注意：assistant 节点在 ChatNodeDataMap 注册的 kind 是 'assistant-step'（dsh 源码
  // conversation-nodes/assistant.ts），不是 'assistant'——写错则 think 增强永不生效。
  if (node.kind === 'assistant-step') {
    // issue #2：异常数据缺 blocks 时按空数组处理，不让增强路径抛错。
    const blocks = (node.data as AssistantChatData).blocks ?? []
    const reasoning = blocks.filter((b): b is Extract<typeof b, { kind: 'reasoning' }> => b.kind === 'reasoning')
    const toolCalls = blocks.filter((b): b is Extract<typeof b, { kind: 'tool-call' }> => b.kind === 'tool-call')
    const thinkRows = Array.from(clone.querySelectorAll<HTMLElement>('[data-variant="think"]'))
    thinkRows.forEach((root, i) => {
      const text = reasoning[i]?.text
      const rowEl = root.querySelector<HTMLElement>('[data-disclosure-row]')
      if (text !== undefined && rowEl !== null) attachDisclosure(rowEl, 'think', text)
    })
    const toolRows = Array.from(clone.querySelectorAll<HTMLElement>('[data-disclosure-row]'))
      .filter((el) => el.closest('[data-variant="think"]') === null)
    toolRows.forEach((rowEl, i) => {
      const block = toolCalls[i]
      if (block !== undefined) attachDisclosure(rowEl, 'tool', toolCallDetail(block))
    })
  } else if (node.kind === 'tool-call') {
    const root = (node.data as ToolChatData).root
    if (root === undefined) return // issue #2：异常数据无 root 时跳过增强（与 toolNameOf 同防护）
    const rowEl = clone.querySelector<HTMLElement>('[data-disclosure-row]')
    if (rowEl === null) return
    const name = 'name' in root ? root.name : (root.call?.name ?? root.callId)
    const argsRaw = 'name' in root ? root.argsRaw : (root.call?.argsRaw ?? '')
    const detail = toolCallDetail({ name, argsRaw })
    const resultText = 'content' in root ? blocksToText(root.content) : ''
    attachDisclosure(rowEl, 'tool', resultText.length > 0 ? `${detail}\n\n【结果】\n${resultText}` : detail)
  } else if (node.kind === 'context') {
    // 上下文注入行（反思/dream 指令 prompt）：补完整文本可展开查看。
    const content = (node.data as { content?: readonly { type?: string; text?: string }[] }).content
    const text = blocksToText(content ?? [])
    const rowEl = clone.querySelector<HTMLElement>('[data-disclosure-row]')
    if (rowEl !== null && text.length > 0) attachDisclosure(rowEl, 'context', text)
  }
}

/** 填充/清空一个组的展开卡片（克隆原始行，静态快照；签名记录供自愈比对）。 */
function fillBody(id: string, visible: boolean, keys: readonly string[], session: ConversationSnapshot): void {
  for (const container of Array.from(document.querySelectorAll<HTMLElement>('[data-chat-flow]'))) {
    const anchor = anchorOf(container, id)
    if (anchor === null) continue
    const body = anchor.querySelector<HTMLElement>(`:scope > [${BODY_ATTR}]`)
    if (body === null) continue
    body.replaceChildren()
    if (!visible) {
      body.style.display = 'none'
      bodySigs.delete(id)
      return
    }
    body.style.display = 'block'
    for (const key of keys) {
      const row = flowRow(container, key)
      if (row === null) continue
      const clone = row.cloneNode(true) as HTMLElement
      // 克隆去掉折叠标记与流锚点：卡片内展示，且不再被当作原始行匹配。
      clone.removeAttribute(FOLDED_ATTR)
      clone.removeAttribute('data-chat-flow-key')
      clone.removeAttribute('data-chat-anchor-key')
      clone.removeAttribute('data-chat-flow-kind')
      body.appendChild(clone)
      enhanceClone(clone, session.chat?.nodes.get(key))
    }
    bodySigs.set(id, sigOf(container, keys))
  }
}

/** 复制/已复制图标（与 dsh 本体 IconCopyOutline16 / IconCheckOutline16 同 path，
 *  ui-primitives src/icons/index.tsx；fill currentColor 跟随按钮颜色）。 */
const COPY_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106C10.7202 4.8653 11.2008 5.3459 11.535 5.92462C11.8142 6.40818 11.9334 6.94481 11.9901 7.57012C12.0459 8.18625 12.0458 8.95419 12.0458 9.9168C12.0458 10.8795 12.0459 11.6473 11.9901 12.2635C11.9334 12.8888 11.8142 13.4254 11.535 13.909C11.2008 14.4877 10.7202 14.9683 10.1415 15.3025C9.65792 15.5817 9.12128 15.7009 8.49597 15.7576C7.87984 15.8134 7.11196 15.8133 6.14929 15.8133C5.18667 15.8133 4.41874 15.8134 3.80261 15.7576C3.1773 15.7009 2.64067 15.5817 2.1571 15.3025C1.5784 14.9683 1.09778 14.4877 0.76355 13.909C0.484366 13.4254 0.365184 12.8888 0.308472 12.2635C0.252649 11.6473 0.252808 10.8795 0.252808 9.9168C0.252808 8.95418 0.252664 8.18625 0.308472 7.57012C0.365184 6.94481 0.484366 6.40818 0.76355 5.92462C1.09777 5.34589 1.57839 4.86529 2.1571 4.53106C2.64067 4.25188 3.1773 4.13269 3.80261 4.07598C4.41874 4.02017 5.18666 4.02032 6.14929 4.02032ZM6.14929 5.37774C5.16181 5.37774 4.46634 5.37761 3.92566 5.42657C3.39434 5.47472 3.07859 5.56574 2.83582 5.70587C2.4632 5.92106 2.15354 6.2307 1.93835 6.60333C1.79823 6.8461 1.70721 7.16185 1.65906 7.69317C1.6101 8.23385 1.61023 8.92933 1.61023 9.9168C1.61023 10.9043 1.61009 11.5998 1.65906 12.1404C1.70721 12.6717 1.79823 12.9875 1.93835 13.2303C2.15356 13.6029 2.46321 13.9126 2.83582 14.1277C3.07859 14.2679 3.39434 14.3589 3.92566 14.407C4.46634 14.456 5.16182 14.4559 6.14929 14.4559C7.13682 14.4559 7.83224 14.456 8.37292 14.407C8.90425 14.3589 9.21999 14.2679 9.46277 14.1277C9.83535 13.9126 10.145 13.6029 10.3602 13.2303C10.5004 12.9875 10.5914 12.6717 10.6395 12.1404C10.6885 11.5998 10.6884 10.9043 10.6884 9.9168C10.6884 8.92934 10.6885 8.23384 10.6395 7.69317C10.5914 7.16185 10.5004 6.8461 10.3602 6.60333C10.1451 6.23071 9.83536 5.92107 9.46277 5.70587C9.21999 5.56574 8.90424 5.47472 8.37292 5.42657C7.83224 5.3776 7.13682 5.37774 6.14929 5.37774ZM9.80164 0.367975C10.7638 0.367975 11.5314 0.36788 12.1473 0.423639C12.7726 0.480307 13.3093 0.598759 13.7928 0.877741C14.3717 1.21192 14.8521 1.69355 15.1864 2.27227C15.4655 2.75574 15.5857 3.29164 15.6425 3.9168C15.6983 4.53301 15.6971 5.3016 15.6971 6.26446V7.82989C15.6971 8.29264 15.6989 8.58993 15.6649 8.84844C15.4668 10.3525 14.401 11.5738 12.9833 11.9988V10.5467C13.6973 10.1903 14.2105 9.49662 14.3192 8.67169C14.3387 8.52347 14.3407 8.3358 14.3407 7.82989V6.26446C14.3407 5.27706 14.3398 4.58149 14.2909 4.04083C14.2428 3.50968 14.1526 3.19372 14.0126 2.95098C13.7974 2.57849 13.4876 2.26869 13.1151 2.05352C12.8724 1.91347 12.5564 1.82237 12.0253 1.77423C11.4847 1.72528 10.7888 1.7254 9.80164 1.7254H7.71472C6.7562 1.72558 5.92665 2.27697 5.52332 3.07891H4.07019C4.54221 1.51132 5.9932 0.368186 7.71472 0.367975H9.80164Z" fill="currentColor"/></svg>'
const CHECK_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z" fill="currentColor"/></svg>'

/** 写剪贴板并给出「已复制」反馈（图标切对勾 1s，对齐本体 MessageIconActions）。
 *  复制的是用户 prompt 原文——本体按钮的文本闭包含注入前缀，不能复用。
 *  clipboard API 失败（非安全上下文等）回退 execCommand。 */
async function copyInjectionText(button: HTMLButtonElement, text: string): Promise<void> {
  let ok = false
  try {
    await navigator.clipboard.writeText(text)
    ok = true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    textarea.remove()
  }
  if (!ok || button.dataset.meowInjState === 'copied') return
  button.dataset.meowInjState = 'copied'
  button.title = '已复制'
  button.innerHTML = CHECK_ICON_SVG
  window.setTimeout(() => {
    button.dataset.meowInjState = 'copy'
    button.title = '复制'
    button.innerHTML = COPY_ICON_SVG
  }, 1000)
}

/** 应用一次注入折叠（首轮长期记忆/关键词命中）：原行隐藏，原位插入
 *  「已注入记忆」横条（点开显示注入全文）+ 用户 prompt 气泡 + 操作行
 *  （复制按钮写 userText 原文 + hover 显隐时钟），样式与本体 UserStyleBubble
 *  对齐（同 token 同尺寸）。幂等：只做元素存在性/文本写入；事件只挂一次。 */
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
      const startRow = flowRow(container, group.id)
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
          'color:var(--dsw-text-secondary, rgba(127,127,127,.9));',
          'background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.14);',
          'border-radius:999px;',
        ].join('')
        bar.addEventListener('click', () => onToggle(group.id))
        anchor.appendChild(bar)
      }
      const kindLabel = group.kind === 'first' ? '（长期记忆）' : '（关键词命中）'
      const label = `${expanded.has(group.id) ? '▾' : '▸'} 已注入记忆${kindLabel}`
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
        copyButton.title = '复制'
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

/**
 * 隐形 dock 条目：不渲染可见 UI（横条直接进消息流 DOM），只随快照驱动折叠。
 */
export function MemoryFoldDock({ session }: InputZone): null {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [injExpanded, setInjExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const groups = useMemo(() => computeFoldGroups(session), [session])
  const injGroups = useMemo(() => computeInjectionGroups(session), [session])
  const dgNotices = useMemo(() => computeDelegateNotices(session), [session])
  const toggle = useCallback((id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      const willExpand = !next.has(id)
      if (willExpand) next.add(id)
      else next.delete(id)
      // 同步填充/清空展开卡片（不依赖 effect 时序，也避免 observer 循环）。
      const group = groups.find((candidate) => candidate.id === id)
      fillBody(id, willExpand, group?.keys ?? [], session)
      return next
    })
  }, [groups, session])
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
    applyFoldState(groups, expanded, toggle, session)
    applyInjectionFold(injGroups, injExpanded, toggleInj)
    applyDelegateNotices(dgNotices)
  }, [groups, expanded, toggle, session, injGroups, injExpanded, toggleInj, dgNotices])

  // 兜底：视图切换/元素重建/流式重渲染导致 DOM 变化时自愈（防抖）。
  const latest = useRef({ groups, expanded, toggle, session, injGroups, injExpanded, toggleInj, dgNotices })
  latest.current = { groups, expanded, toggle, session, injGroups, injExpanded, toggleInj, dgNotices }
  useEffect(() => {
    let timer = 0
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        applyFoldState(latest.current.groups, latest.current.expanded, latest.current.toggle, latest.current.session)
        applyInjectionFold(latest.current.injGroups, latest.current.injExpanded, latest.current.toggleInj)
        applyDelegateNotices(latest.current.dgNotices)
      }, 80)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
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
export const inject = ['slots', 'settingsScope', 'sessions']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): () => void {
  const disposers: Array<() => void> = []
  // 会话列表"已 dream"小月牙：独立于 slots，直接启动（host 路由不可用时静默降级）。
  disposers.push(startDreamIconManager())
  // delegate 打点气泡的 dream 状态同步（SSE）：dream 完成时气泡「处理中…」→「已完成 ✓」。
  disposers.push(startDelegateStateSync())
  // 会话「…」菜单「跳过梦境整理记忆」toggle（v0.16.0）：同上独立启动，静默降级。
  disposers.push(startDreamSkipManager())
  // 设置页「喵记忆」标签页（settings.section 顶级分区）：settingsScope 服务缺失
  // 或注册失败只警告，不影响折叠/图标。
  try {
    applySettingsPage(ctx)
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
