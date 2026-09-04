/**
 * meow-memory — 会话列表 dream 小月牙图标（client 端，用户拍板 2026-08-19）。
 *
 * 目标：左侧会话列表中，dream 整理过记忆且之后无新对话新信息的会话行显示
 * 淡黄色静态小月牙；dream 轮进行中显示白→金呼吸灯月牙（替换 dsh 的运行中
 * 蓝色动画，避免与正常工作混淆）；有新活动则移除。图标放进 dsh 会话行的
 * 状态槽位（16×20 的 slot span）——替换其内容，不新增元素，标题零位移。
 *
 * 数据（2026-09-05 连接池修复：SSE 长连接 → 共享 60s 轮询 diff）：
 * - 挂载时 GET /meow-memory/dreamed-sessions 全量对账一次
 *   （{ sessionIds: 已整理, dreamingIds: 进行中 }）+ GET /meow-memory/skip-dreams
 *   （{ sessionIds: 已跳过 }，v0.18.0 起；
 * - 增量经 subscribeDreamEvents（client-dream-events.ts 全页共享轮询）：dream
 *   开始推 state:'dreaming'、dream 完成推 state:'dreamed'、会话有新活动推
 *   state:'active'（去月亮）、跳过状态翻转推 'skip'/'unskip'。
 *
 * 三态优先级（v0.18.0）：呼吸灯 dreaming > 跳过 skipped > 已整理 dreamed——
 * 进行中的 dream 不打断是既有语义，所以呼吸灯最优先；跳过的会话显示灰调
 * 「月牙+斜杠」（macOS 勿扰同款：斜杠穿过月牙并留缝），取消跳过后自动回落。
 *
 * 行定位（零 dsh 改动）：dsh 会话行 DOM 没有 data-id 属性，但 React 18 在每个
 * 渲染元素上挂内部 fiber 引用（__reactFiber$ 前缀属性，DevTools 同款机制，
 * React 18/19 均稳定存在）——行元素 fiber 沿 return 链向上，第一个带字符串 key
 * 的 fiber 就是 SessionNodeItem 的 fiber，其 key = 会话 id（渲染时 key={node.id}）。
 * 找不到 fiber（未来 React 改内部结构）→ 该行跳过，静默降级不报错。
 */

import { subscribeDreamEvents } from './client-dream-events.ts'

/** 静态淡黄月牙标记（CSS 选择器 + 幂等锚点）。 */
export const DREAM_ICON_ATTR = 'data-meow-dreamed'
/** 呼吸灯月牙标记（dream 进行中）。 */
export const DREAMING_ATTR = 'data-meow-dreaming'
/** 灰调「月牙+斜杠」标记（已跳过梦境整理，v0.18.0）。 */
export const SKIPPED_ATTR = 'data-meow-skip-dream'

/** 图标三态：dreamed（淡黄月牙）/ dreaming（呼吸灯）/ skipped（月牙+斜杠）。 */
export type DreamIconState = 'dreamed' | 'dreaming' | 'skipped'

/** 月牙 SVG（Lucide moon 路径，viewBox 24 缩放到 10px——矢量缩放，小尺寸也清晰）。 */
export const MOON_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>'

/** 「月牙+斜杠」的月牙路径（与 MOON_SVG 同源）与斜杠路径。 */
const SKIP_MOON_PATH = 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'
const SKIP_SLASH_PATH = 'M2.5 2.5l19 19'

/**
 * 造一个「月牙+斜杠」SVG（macOS 勿扰图标同款：实心月牙被斜杠穿过、
 * 斜杠周围留一圈缝隙——mask 挖缝保证单色下斜杠在月牙上依然可读，
 * 比 outline 版小尺寸更清晰）。每次调用生成随机 mask id：
 * 会话列表会同时存在多个该图标，共享 id 会互相污染遮罩。
 */
export function makeSkipMoonSvg(): string {
  const id = `meow-skip-${Math.random().toString(36).slice(2, 10)}`
  return `<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">`
    + `<defs><mask id="${id}"><rect width="24" height="24" fill="#fff"/>`
    + `<path d="${SKIP_SLASH_PATH}" fill="none" stroke="#000" stroke-width="4.4" stroke-linecap="round"/></mask></defs>`
    + `<g mask="url(#${id})"><path fill="currentColor" d="${SKIP_MOON_PATH}"/></g>`
    + `<path d="${SKIP_SLASH_PATH}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>`
    + `</svg>`
}

const ICON_CSS = `[${DREAM_ICON_ATTR}],
[${DREAMING_ATTR}],
[${SKIPPED_ATTR}] {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 10px;
  height: 10px;
}
[${DREAM_ICON_ATTR}] { color: #e9c46a; opacity: 0.9; } /* 淡黄停驻 */
[${DREAMING_ATTR}] {
  color: #f2c14e;
  animation: meow-dream-breathe 2.4s ease-in-out infinite;
}
@keyframes meow-dream-breathe {
  0%, 100% { color: #fff8e6; opacity: 0.55; }
  50% { color: #f2c14e; opacity: 1; }
}
[${SKIPPED_ATTR}] { color: #94a3b8; opacity: 0.85; } /* 静音灰：这扇窗不做梦 */
[data-meow-inline-icon] { margin-right: 4px; } /* 无状态槽位的 flat 视图：行首内联 */
`

/** React fiber 内部属性前缀（React 17+ 稳定约定：__reactFiber$ + 随机后缀）。 */
const FIBER_KEY_RE = /^__reactFiber\$/

/**
 * 从会话行 DOM 元素读 session id：找行元素上的 React fiber 引用，
 * 沿 return 链向上最多 8 层，取第一个带非空字符串 key 的 fiber 的 key。
 * @param row - 会话行元素（ui-workspace 的 SessionNodeItem 行）。
 * @returns 会话 id；找不到返回 null。
 */
export function readSessionId(row: HTMLElement): string | null {
  let fiber: unknown = null
  for (const key of Object.keys(row)) {
    if (FIBER_KEY_RE.test(key)) {
      fiber = (row as unknown as Record<string, unknown>)[key]
      break
    }
  }
  let cur = fiber
  for (let depth = 0; depth < 8 && cur !== null && cur !== undefined; depth++) {
    const f = cur as { key?: unknown; return?: unknown }
    if (typeof f.key === 'string' && f.key.length > 0) return f.key
    cur = f.return
  }
  return null
}

/** 会话行最小视图（可测试：真机传 DOM 行，测试传 fake 行）。 */
export interface DreamRowLike {
  querySelector(selector: string): HTMLElement | null
  insertBefore(node: HTMLElement, reference: Node | null): void
  firstChild: Node | null
}

/** 造一个图标元素（状态决定标记属性与 SVG）。 */
function makeIcon(state: DreamIconState): HTMLElement {
  const icon = document.createElement('span')
  icon.setAttribute(attrForState(state) ?? DREAM_ICON_ATTR, 'true')
  icon.setAttribute('aria-hidden', 'true')
  icon.innerHTML = state === 'skipped' ? makeSkipMoonSvg() : MOON_SVG
  return icon
}

/** 当前状态对应标记属性；无状态返回 null。 */
function attrForState(state: DreamIconState | undefined): string | null {
  if (state === 'dreaming') return DREAMING_ATTR
  if (state === 'dreamed') return DREAM_ICON_ATTR
  if (state === 'skipped') return SKIPPED_ATTR
  return null
}

/** 图标三属性选择器（查询已有图标用）。 */
const ANY_ICON_SEL = `[${DREAM_ICON_ATTR}], [${DREAMING_ATTR}], [${SKIPPED_ATTR}]`

/** 会话行默认扫描选择器。必须子串匹配：行类按 clsx 顺序拼接（sessionRow,
 *  selected, menuOpen…），结尾匹配会让选中/菜单打开中的行失配丢图标。 */
export const SESSION_ROWS_SEL = 'div[role="treeitem"][class*="_sessionRow"]'

/**
 * 合并 dream 状态与跳过集合为展示态（纯函数，便于测试）：
 * dreaming > skipped > dreamed——进行中的 dream 不被打断，呼吸灯最优先；
 * 跳过压过已整理月牙；两者皆无 → undefined（移除图标）。
 */
export function mergeIconStates(
  dreamStates: ReadonlyMap<string, 'dreamed' | 'dreaming'>,
  skippedIds: ReadonlySet<string>,
): Map<string, DreamIconState> {
  const merged = new Map<string, DreamIconState>()
  for (const [id, state] of dreamStates) merged.set(id, state)
  for (const id of skippedIds) {
    if (merged.get(id) !== 'dreaming') merged.set(id, 'skipped')
  }
  return merged
}

/**
 * 重放一轮图标：扫描全部会话行，对照状态表放置/更新/移除小月牙。
 * 幂等：状态一致时不动元素；插入/替换动作触发 MutationObserver → 防抖重扫 → 已一致跳过，
 * 无自循环（client-fold 同款模式）。
 * 位置：优先放进行的状态槽位（`[class$="_slot"]`，16×20 居中，替换槽内内容——
 * 含 dsh 的运行中/完成状态点，用户拍板"dream 图标直接替换它的位置"）；
 * 无槽位（flat 无状态视图）时退化为行首内联（占 14px，可接受）。
 * @param states - 当前状态表：session id → 'dreamed' | 'dreaming' | 'skipped'
 *   （管理器先用 mergeIconStates 合并两路数据再传入）。
 * @param rows - 会话行集合；缺省时按 dsh 会话行选择器查询（CSS Modules 类名
 *   `[hash]_[local]`，后缀匹配 local 名，dsh 升级 hash 变化仍稳定）。
 */
export function applyDreamIcons(states: ReadonlyMap<string, DreamIconState>, rows?: Iterable<DreamRowLike>): void {
  const all = rows ?? document.querySelectorAll<HTMLElement>(SESSION_ROWS_SEL)
  for (const row of all) {
    const id = readSessionId(row as HTMLElement)
    const state = id !== null ? states.get(id) : undefined
    const wantAttr = attrForState(state)
    const slot = row.querySelector('[class$="_slot"]')
    if (slot !== null) {
      // 状态槽位：替换槽内内容（含我们的旧图标 / dsh 状态点）。
      const cur = slot.querySelector(ANY_ICON_SEL)
      const consistent = cur !== null && wantAttr !== null && cur.getAttribute(wantAttr) === 'true'
      if (state !== undefined && !consistent) {
        slot.replaceChildren(makeIcon(state))
      } else if (state === undefined && cur !== null) {
        cur.remove()
      }
    } else if (state !== undefined) {
      // 无状态槽位（flat 无状态视图）：行首内联。
      const cur = row.querySelector(ANY_ICON_SEL)
      const consistent = cur !== null && cur.getAttribute(wantAttr ?? '') === 'true'
      if (!consistent) {
        cur?.remove()
        const icon = makeIcon(state)
        icon.setAttribute('data-meow-inline-icon', 'true')
        row.insertBefore(icon, row.firstChild)
      }
    } else {
      row.querySelector(ANY_ICON_SEL)?.remove()
    }
  }
}

/**
 * 启动会话列表 dream 图标管理器：注入常驻 CSS + 全量对账 + SSE 增量 + DOM 兜底重放。
 * @returns 清理函数（插件卸载时调用：断开连接、移除 observer 与已注入图标）。
 */
export function startDreamIconManager(): () => void {
  const dreamStates = new Map<string, 'dreamed' | 'dreaming'>()
  const skippedIds = new Set<string>()
  let timer = 0

  /** 合并两路状态后重放一轮图标。 */
  const replay = (): void => applyDreamIcons(mergeIconStates(dreamStates, skippedIds))

  /** 拉跳过集合快照（路由不可用时静默保持现状）。 */
  const refreshSkips = async (): Promise<void> => {
    try {
      const response = await fetch('/meow-memory/skip-dreams', { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json() as { sessionIds?: unknown }
      skippedIds.clear()
      if (Array.isArray(data.sessionIds)) {
        for (const id of data.sessionIds) {
          if (typeof id === 'string') skippedIds.add(id)
        }
      }
    } catch {
      // 路由不可用（旧版本 host）：静默降级，无跳过图标不报错。
    }
  }

  /** 全量对账（挂载/重连时各一次）：拉 dreamed-sessions + skip-dreams 快照并重放。 */
  const refresh = async (): Promise<void> => {
    try {
      const response = await fetch('/meow-memory/dreamed-sessions', { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json() as { sessionIds?: unknown; dreamingIds?: unknown }
      dreamStates.clear()
      if (Array.isArray(data.sessionIds)) {
        for (const id of data.sessionIds) {
          if (typeof id === 'string') dreamStates.set(id, 'dreamed')
        }
      }
      if (Array.isArray(data.dreamingIds)) {
        for (const id of data.dreamingIds) {
          if (typeof id === 'string') dreamStates.set(id, 'dreaming')
        }
      }
    } catch {
      // 路由不可用（webServer 缺失/旧版本）：静默降级，无图标不报错。
    }
    await refreshSkips()
    replay()
  }

  // 增量订阅（共享 60s 轮询 diff，替代原每页一条的 EventSource——连接池饥饿
  // 修复，见 client-dream-events.ts 头注）。事件语义与旧 SSE 'dream' 帧一致。
  const unsubscribeDreamEvents = subscribeDreamEvents((event) => {
    const { sessionId, state } = event
    if (state === 'dreamed' || state === 'dreaming') dreamStates.set(sessionId, state)
    else if (state === 'skip') skippedIds.add(sessionId)
    else if (state === 'unskip') skippedIds.delete(sessionId)
    else dreamStates.delete(sessionId) // 'active'（有新活动）或未知状态：去月亮
    replay()
  })

  // 样式常驻全局（图标由 data 属性驱动，规则在即生效；与折叠 UI 的 CSS 同策略）。
  // 热重载 dispose 不删 style——注入前先移除本插件旧 style，防多代规则堆积污染
  // （同 client.ts apply 的处理）。
  for (const stale of Array.from(document.querySelectorAll('style[data-meow-dream-icon-css]'))) {
    stale.remove()
  }
  const style = document.createElement('style')
  style.dataset.meowDreamIconCss = 'true'
  style.textContent = ICON_CSS
  document.head.appendChild(style)

  // DOM 兜底：React 重渲染/视图切换重建行时防抖重放（含 slot 内容被 React 恢复后的自愈）。
  const observer = new MutationObserver(() => {
    window.clearTimeout(timer)
    timer = window.setTimeout(replay, 120)
  })
  observer.observe(document.body, { childList: true, subtree: true })

  void refresh()

  return () => {
    observer.disconnect()
    window.clearTimeout(timer)
    unsubscribeDreamEvents()
    style.remove()
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${DREAM_ICON_ATTR}], [${DREAMING_ATTR}], [${SKIPPED_ATTR}]`))) el.remove()
  }
}
