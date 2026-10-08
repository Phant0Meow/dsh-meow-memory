/**
 * meow-memory — 会话菜单「记忆参与」门控（client 端，v0.16.0 跳过 dream → v0.30.0
 * 三档门控 + 面板交互，issue #38/#28）。
 *
 * 目标：左侧会话行「…」菜单里保留一项「记忆参与」（带状态后缀），点击弹出一个
 * 插件自有 DOM 面板（不是子菜单——不赌宿主 Menu 组件的嵌套支持），内含三档独立
 * 开关 + 预设按钮：
 *   - 停止读入（skip_inject）：首轮快照/每轮命中/压缩重注入/search+read 等读入口全关；
 *   - 跳过整理（skip_dream）：自动 dream 与自动 reflect 都不触发（手动 /dream 仍可用，
 *     「手动=明确意愿」的既定设计不变；v0.16.0 的「跳过梦境整理记忆」是本档的子集）；
 *   - 停止写入（skip_write）：普通轮的 memory_remember/update 拒绝；整理轮写入跟随
 *     整理档（写档单独关而整理开着时，整理轮写入不受影响——否则整理白跑）。
 * 预设：参与（全开）/ 免打扰（只停读入）/ 退出（全关）。
 * 工作区级停用（#28）是配置侧硬开关（disabledWorkspaces），面板不覆盖它。
 *
 * 注入方式（零 dsh 改动，与 v0.18.0 相同）：dsh Rows.tsx 在菜单打开期间给行挂
 * menuOpen 类 → 读行 fiber key 得 session id；MutationObserver 双路注入 + 防抖自愈；
 * cloneNode 模板像素级对齐本体菜单。点击 capture+stopPropagation：React 委托不会
 * 误触发原生三项；面板打开期间把菜单 portal 暂时隐藏（visibility），关面板恢复。
 *
 * 数据同步：启动 GET 全量对账（scopes 三档明细）+ 订阅共享轮询 diff 的 scope 事件
 * （同实例多标签页即时同步；跨实例浏览器标签靠重连对账补齐）。已知限制：键盘
 * ↑↓ 导航只走 React 受管的原生三项（v0.16.0 起不变）。
 */

import { MOON_SVG, readSessionId } from './client-dream-icon.ts'
import { subscribeDreamEvents } from './client-dream-events.ts'
import { registerUiReplayer } from './client-i18n-replay.ts'
import { t } from './i18n/index.js'
import type { UiKey } from './i18n/index.js'

/** 测试接点：界面语言（生产代码读 DSH locale 服务）。 */
export { setUiLocaleForTest, getUiLocale } from './i18n/index.js'

/** 注入项标记属性（清理与幂等锚点；data-meow-session-id 记录绑定会话）。 */
export const SKIP_ITEM_ATTR = 'data-meow-skip-item'
/** 行操作区（…按钮所在 span）的 CSS Modules 后缀选择器。
 *  子串匹配：生成格式为 `<hash>_<local>`，`_rowActions` 子串全库唯一。 */
const ROW_ACTIONS_SEL = '[class*="_rowActions"]'
/** 会话行选择器（dream 图标同款）。
 *  必须子串匹配而非结尾匹配：行类按 clsx 顺序拼接（sessionRow, selected, menuOpen），
 *  当前选中行常驻 _selected、菜单打开时追加 _menuOpen，都排在 _sessionRow 之后——
 *  `[class$=]` 对整个 class 属性串做结尾匹配必然失配（2026-08-26 实测根因：
 *  对当前选中的会话点 … 永远捕获不到 id，注入时灵时不灵）。 */
export const SESSION_ROW_SEL = '[role="treeitem"][class*="_sessionRow"]'
/** 菜单打开中的会话行：dsh Rows.tsx 把 menuOpen 状态同时挂到行级 menuOpen 类——
 *  据此可在任意时刻确定「哪个会话的菜单正开着」，不依赖点击时间窗。
 *  必须叠加 _sessionRow 约束（issue #8 回归）：工作区行（projectRow）同样是
 *  `role="treeitem"` 且共用同一 CSS Modules 的 _menuOpen 类——无 _sessionRow
 *  约束时，工作区菜单打开也会被解析成"会话菜单"，注入项落 workspace id
 *  （点击无反应 + 垃圾数据落库）。 */
export const MENU_OPEN_ROW_SEL = '[role="treeitem"][class*="_sessionRow"][class*="_menuOpen"]'
/** 点击→菜单挂载的判定窗口（ms；仅作 menuOpen 锚点失效时的兜底）。 */
const MENU_WINDOW_MS = 1500

/** 三档门控状态：dream=跳过整理 / inject=停止读入 / write=停止写入。 */
export interface MemoryScope {
  dream: boolean
  inject: boolean
  write: boolean
}

/** 窗口门控汇总（菜单后缀用）：两开关（自动注入/自动整理）的 4 种组合全部命名。
 *  写档（skip_write）不参与命名——面板不露出，仅工作区停用与存量数据仍生效。 */
export type ParticipationState = 'active' | 'writeonly' | 'readonly' | 'exited'

const PART_STATE_KEYS: Record<ParticipationState, UiKey> = {
  active: 'part.state.active',
  writeonly: 'part.state.writeonly',
  readonly: 'part.state.readonly',
  exited: 'part.state.exited',
}

export function participationState(scope: MemoryScope): ParticipationState {
  const { dream, inject } = scope
  if (!inject && !dream) return 'active'
  if (inject && !dream) return 'writeonly' // 停止读入 + 照常整理：只往库里写，不被记忆影响
  if (!inject && dream) return 'readonly' // 照常读入 + 跳过整理：用记忆但不再整理
  return 'exited'
}

/** 菜单项文案：主文案 + 状态后缀（四态全命名，含默认态「功能全开」）。 */
export function participationLabel(scope: MemoryScope): string {
  return `${t('part.menu')} · ${t(PART_STATE_KEYS[participationState(scope)])}`
}

/**
 * pointerdown 目标 → 会话 id：目标必须落在会话行的操作区内（即 … 按钮），
 * 行元素经 fiber 读 key 得 id。其余位置（行主体/项目行/页面其他区域）返回 null。
 */
export function captureSessionIdFromTarget(target: unknown): string | null {
  const el = target as { closest?: (sel: string) => unknown } | null | undefined
  if (el === null || el === undefined || typeof el.closest !== 'function') return null
  if (el.closest(ROW_ACTIONS_SEL) === null) return null
  const row = el.closest(SESSION_ROW_SEL) as HTMLElement | null
  if (row === null) return null
  return readSessionId(row)
}

/**
 * 把克隆出的菜单项里的文案叶子替换为 text：找最深的同时满足「无元素子节点且
 * trim 后文本非空」的后代（多个时取最后一个——模板项 icon 在前 label 在后）。
 * @returns 是否找到并替换（找不到返回 false，调用方放弃注入）。
 */
export function retitleLeaf(root: Element, text: string): boolean {
  let leaf: Element | null = null
  const walk = (el: Element): void => {
    let hasElementChild = false
    for (const c of el.children) {
      hasElementChild = true
      walk(c)
    }
    if (!hasElementChild && (el.textContent ?? '').trim().length > 0) leaf = el
  }
  walk(root)
  if (leaf === null) return false
  ;(leaf as Element).textContent = text
  return true
}

/**
 * 解析「当前开着的会话菜单」属于哪个会话：优先读 menuOpen 行（确定性锚点，
 * dsh Rows.tsx 在菜单打开期间给行挂 menuOpen 类），行存在但 fiber 读失败时
 * 退回点击时捕获的 id；页面上**没有** menuOpen 会话行时返回 null——此时开着的
 * 菜单若存在必属非会话行（工作区行同样挂 menuOpen，issue #8），绝不能把点击
 * 窗口残留的会话 id 注进别行的菜单（1.5s 内先点会话 … 再开工作区菜单的串味
 * 防护）。menuOpen 锚点整体失效（dsh 改类名）时本功能降级为不注入——好过
 * 错注入 + 垃圾数据落库。
 * @param doc - Document（或等价 querySelector 载体，测试传桩）。
 * @param fallback - 点击捕获兜底值；仅 menuOpen 会话行存在但行不可读时生效。
 */
export function resolveMenuSessionId(
  doc: { querySelector(selector: string): Element | null },
  fallback: string | null,
): string | null {
  const openRow = doc.querySelector(MENU_OPEN_ROW_SEL)
  if (openRow === null) return null
  const sid = readSessionId(openRow as HTMLElement)
  return sid !== null ? sid : fallback
}

// ── 本地门控状态（模块内可变；读写函数便于注入/面板复用） ────────────────────
const scopes = new Map<string, MemoryScope>()
function readScope(sid: string): MemoryScope {
  return scopes.get(sid) ?? { dream: false, inject: false, write: false }
}
function writeScopeField(sid: string, field: keyof MemoryScope, val: boolean): void {
  const cur = readScope(sid)
  cur[field] = val
  scopes.set(sid, cur)
}

interface SkipItemHost {
  /** 点击菜单项：打开该会话的门控面板（由管理器注入实现）。 */
  onOpen: (sessionId: string, item: HTMLElement) => void
}

/**
 * 向一个刚挂载的 [role="menu"] 注入门控启动项。幂等锚点=「子项存在且绑定同一会话」：
 * portal 容器跨开关复用，若容器里残留的是**别的会话**的注入项（上次开菜单的
 * 残留），拆掉重注，绝不让 A 会话的菜单显示 B 的状态。
 * @returns 注入的元素；无法注入（无模板/无文本叶子）返回 null（调用方静默放弃，
 *  后续 mutation 会重试）。
 */
export function injectSkipItem(menu: Element, sessionId: string, host: SkipItemHost): HTMLElement | null {
  for (const old of Array.from(menu.querySelectorAll(`[${SKIP_ITEM_ATTR}]`))) {
    if (old.getAttribute('data-meow-session-id') === sessionId) return null // 已注入过，本菜单完成
    old.remove() // 容器复用残留的别会话旧项：拆掉
  }
  const template = menu.querySelector('[role="menuitem"]')
  if (template === null) return null
  const item = template.cloneNode(true) as HTMLElement
  item.removeAttribute('id')
  for (const el of Array.from(item.querySelectorAll('[id]'))) el.removeAttribute('id')
  item.setAttribute('role', 'menuitem')
  // 文案替换必须成功才继续——失败路径不留下任何半配置状态（属性/监听器都还没挂）。
  if (!retitleLeaf(item, participationLabel(readScope(sessionId)))) return null
  item.setAttribute(SKIP_ITEM_ATTR, 'true')
  item.setAttribute('data-meow-session-id', sessionId)
  // 图标固定月牙（启动项=面板入口；「点击后变成的状态」语义随面板化退役）。
  const icon = item.querySelector('svg')
  if (icon !== null) icon.outerHTML = MOON_SVG
  // 点击：capture 截停，不让事件冒泡进 React 委托（防误触发原生三项/关菜单）。
  const onClick = (e: Event): void => {
    e.stopPropagation()
    e.preventDefault()
    host.onOpen(sessionId, item)
  }
  item.addEventListener('click', onClick, true)
  item.addEventListener('pointerdown', (e) => e.stopPropagation())
  menu.appendChild(item)
  return item
}

// ── 门控面板（issue #38 交互面）─────────────────────────────────────────────
let openPanel: HTMLElement | null = null
let openPanelMenu: HTMLElement | null = null
let outsideCloseHandler: ((e: PointerEvent) => void) | null = null
let escapeCloseHandler: ((e: KeyboardEvent) => void) | null = null
/** 面板重渲染回调（scope 变化时由管理器驱动刷新勾选态）。 */
let panelRerender: (() => void) | null = null

function closeScopePanel(): void {
  if (openPanel === null) return
  openPanel.remove()
  openPanel = null
  if (openPanelMenu !== null) {
    try {
      openPanelMenu.style.visibility = ''
    } catch {
      /* 菜单已被 React 卸载：无需恢复 */
    }
  }
  openPanelMenu = null
  if (outsideCloseHandler !== null) document.removeEventListener('pointerdown', outsideCloseHandler, true)
  if (escapeCloseHandler !== null) document.removeEventListener('keydown', escapeCloseHandler, true)
  outsideCloseHandler = null
  escapeCloseHandler = null
  panelRerender = null
}

function buildScopePanel(sid: string, post: (field: keyof MemoryScope, value: boolean) => void): HTMLElement {
  const panel = document.createElement('div')
  panel.setAttribute('data-meow-scope-panel', 'true')
  panel.style.cssText =
    'position:fixed;z-index:2147483647;background:#0f172a;color:#e2e8f0;border:1px solid #334155;' +
    'border-radius:8px;padding:8px 8px 6px;font-size:12px;line-height:1.6;min-width:276px;' +
    'box-shadow:0 8px 24px rgba(0,0,0,0.45);font-family:inherit;'

  const rerender = (): void => renderRows(sid)
  panelRerender = rerender

  // 标题行（含关闭钮）。
  const title = document.createElement('div')
  title.style.cssText = 'font-weight:600;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;gap:12px;'
  const titleText = document.createElement('span')
  titleText.textContent = t('part.menu')
  const close = document.createElement('span')
  close.textContent = '✕'
  close.style.cssText = 'cursor:pointer;opacity:0.7;padding:0 3px;'
  close.addEventListener('click', () => closeScopePanel())
  title.append(titleText, close)
  panel.appendChild(title)

  // 两个开关行（用户拍板：记忆工具默认开着不关，想限制口头告诉 AI 即可）：
  // 整行可点，右侧「打开/关闭」表达当前态（打开=该能力在参与记忆）。
  const rows: Array<{ field: keyof MemoryScope; key: UiKey }> = [
    { field: 'inject', key: 'part.panel.inject' },
    { field: 'dream', key: 'part.panel.consolidate' },
  ]
  const rowEls: Array<{ el: HTMLElement; field: keyof MemoryScope; state: HTMLElement }> = []
  for (const { field, key } of rows) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:16px;padding:5px 6px;border-radius:4px;cursor:pointer;white-space:nowrap;'
    row.addEventListener('pointerenter', () => { row.style.background = 'rgba(128,128,128,0.18)' })
    row.addEventListener('pointerleave', () => { row.style.background = 'transparent' })
    row.addEventListener('click', () => {
      const next = !readScope(sid)[field]
      writeScopeField(sid, field, next)
      post(field, next)
      rerender()
      syncOpenMenuLabels()
    })
    const label = document.createElement('span')
    label.textContent = t(key)
    const state = document.createElement('span')
    state.style.cssText = 'white-space:nowrap;'
    row.append(label, state)
    panel.appendChild(row)
    rowEls.push({ el: row, field, state })
  }

  function renderRows(sid2: string): void {
    const cur = readScope(sid2)
    for (const { field, state } of rowEls) {
      const on = cur[field]
      // 状态列直陈「打开/关闭」：打开=该行能力在参与（非门控），关闭=已停用。
      state.textContent = on ? t('part.panel.off') : t('part.panel.on')
      state.style.cssText = on ? 'opacity:0.55;' : 'color:#93c5fd;'
    }
  }
  renderRows(sid)

  return panel
}

/**
 * 打开门控面板：锚定菜单项（portal 定位，越界收进视口），同时把所属菜单暂时隐藏
 * （visibility，关面板恢复——React 重渲染会自然复位，不会留僵尸）。同一时刻至多
 * 一个面板；外部 pointerdown / Escape 关闭。
 */
function openScopePanel(
  sid: string,
  anchor: HTMLElement,
  post: (field: keyof MemoryScope, value: boolean) => void,
): void {
  closeScopePanel()
  const menu = anchor.closest('[role="menu"]') as HTMLElement | null
  const panel = buildScopePanel(sid, post)
  document.body.appendChild(panel)
  const rect = anchor.getBoundingClientRect()
  const pw = panel.offsetWidth
  const ph = panel.offsetHeight
  let left = rect.right + 6
  if (left + pw > window.innerWidth - 8) left = Math.max(8, rect.left - pw - 6)
  let top = rect.top
  if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8)
  panel.style.left = `${Math.max(8, left)}px`
  panel.style.top = `${Math.max(8, top)}px`
  openPanel = panel
  openPanelMenu = menu
  if (menu !== null) menu.style.visibility = 'hidden'
  outsideCloseHandler = (e: PointerEvent): void => {
    if (openPanel !== null && !openPanel.contains(e.target as Node)) closeScopePanel()
  }
  escapeCloseHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeScopePanel()
  }
  document.addEventListener('pointerdown', outsideCloseHandler, true)
  document.addEventListener('keydown', escapeCloseHandler, true)
}

/** 已注入菜单项的文案/状态同步（scope 变化与语言切换共用）。 */
function syncOpenMenuLabels(): void {
  for (const item of Array.from(document.querySelectorAll<HTMLElement>(`[${SKIP_ITEM_ATTR}]`))) {
    const sid = item.getAttribute('data-meow-session-id')
    if (sid !== null) retitleLeaf(item, participationLabel(readScope(sid)))
  }
}

/**
 * 启动会话菜单门控管理器：全量对账 + 共享轮询增量 + 点击捕获 + 菜单注入 + 面板。
 * @returns 清理函数（插件卸载时调用：断连接、摘监听、移除已注入项与面板）。
 */
export function startDreamSkipManager(): () => void {
  let pendingSid: string | null = null
  let pendingAt = 0
  let observerTimer = 0

  /**
   * 菜单同步（防抖自愈，任何 DOM 变化后收敛一次）：只要检测到「有会话菜单正开着」
   * （menuOpen 行存在；时间窗内的点击捕获作兜底），就确保页面上每个可见
   * [role=menu] 都带正确会话的门控启动项。迟挂载、模板晚到、项被 React 冲掉、
   * 容器复用串味，全部在这一条路上收敛——不受 1.5s 时间窗限制。
   */
  const syncOpenMenus = (): void => {
    const withinWindow = pendingSid !== null && Date.now() - pendingAt <= MENU_WINDOW_MS
    const sid = resolveMenuSessionId(document, withinWindow ? pendingSid : null)
    if (sid === null) return
    for (const menu of Array.from(document.querySelectorAll('[role="menu"]'))) {
      injectSkipItem(menu, sid, { onOpen: handleOpen })
    }
  }

  const observer = new MutationObserver((muts) => {
    // 快路径：点击窗口内的新挂载菜单立即注入（不等防抖）。身份优先读 menuOpen 行。
    if (pendingSid !== null && Date.now() - pendingAt <= MENU_WINDOW_MS) {
      const sid = resolveMenuSessionId(document, pendingSid)
      if (sid !== null) {
        for (const m of muts) {
          for (const node of Array.from(m.addedNodes)) {
            if (!(node instanceof HTMLElement)) continue
            const menus = node.matches('[role="menu"]') ? [node] : Array.from(node.querySelectorAll('[role="menu"]'))
            for (const menu of menus) injectSkipItem(menu, sid, { onOpen: handleOpen })
          }
        }
        for (const menu of Array.from(document.querySelectorAll('[role="menu"]'))) {
          injectSkipItem(menu, sid, { onOpen: handleOpen })
        }
      }
    }
    // 自愈检查合并进同一 observer（防抖 120ms，dream 图标同款节流）。
    window.clearTimeout(observerTimer)
    observerTimer = window.setTimeout(syncOpenMenus, 120)
  })

  /** 面板开关落库：失败回滚由闭包完成（乐观 UI；共享轮询对账兜底）。 */
  const handlePost = (sessionId: string, field: keyof MemoryScope, value: boolean): void => {
    void (async () => {
      try {
        const resp = await fetch('/meow-memory/skip-dreams', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, field, value }),
        })
        if (!resp.ok) throw new Error(String(resp.status))
      } catch {
        writeScopeField(sessionId, field, !value) // 网络/路由失败：本地还原
        panelRerender?.()
        syncOpenMenuLabels()
      }
    })()
  }

  const handleOpen = (sessionId: string, item: HTMLElement): void => {
    openScopePanel(sessionId, item, (field, value) => {
      handlePost(sessionId, field, value)
    })
  }

  const onPointerDown = (e: PointerEvent): void => {
    const sid = captureSessionIdFromTarget(e.target)
    if (sid === null) return
    pendingSid = sid
    pendingAt = Date.now()
  }

  /** 全量对账（挂载/重连时）：GET 合并快照重建门控表。 */
  const refresh = async (): Promise<void> => {
    try {
      const response = await fetch('/meow-memory/skip-dreams', { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json() as { sessionIds?: unknown; scopes?: unknown }
      scopes.clear()
      if (Array.isArray(data.scopes)) {
        for (const sc of data.scopes as Array<{ sessionId?: unknown; dream?: unknown; inject?: unknown; write?: unknown }>) {
          if (typeof sc.sessionId !== 'string') continue
          scopes.set(sc.sessionId, { dream: sc.dream === true, inject: sc.inject === true, write: sc.write === true })
        }
      } else if (Array.isArray(data.sessionIds)) {
        // 旧形态兜底（不应发生：client/host 同版本发布）
        for (const id of data.sessionIds) {
          if (typeof id === 'string') scopes.set(id, { dream: true, inject: false, write: false })
        }
      }
      syncOpenMenuLabels()
    } catch {
      // 路由不可用（旧版本 host / webServer 缺失）：静默降级，菜单项照常注入但
      // 面板 toggle 会失败还原——比整个功能消失更可诊断。
    }
  }

  // 增量订阅：scope 事件同步三档（dream 档变化同时会收到旧 skip/unskip，幂等忽略）；
  // 旧 skip/unskip 也处理（防只有旧通道的场景）。已开着的菜单/面板即时刷新。
  const unsubscribeDreamEvents = subscribeDreamEvents((event) => {
    const { sessionId, state } = event
    if (state === 'scope' && (event.field === 'dream' || event.field === 'inject' || event.field === 'write')) {
      writeScopeField(sessionId, event.field, event.value === true)
    } else if (state === 'skip') {
      writeScopeField(sessionId, 'dream', true)
    } else if (state === 'unskip') {
      writeScopeField(sessionId, 'dream', false)
    } else {
      return
    }
    syncOpenMenuLabels()
    panelRerender?.()
  })

  document.addEventListener('pointerdown', onPointerDown, true)
  observer.observe(document.body, { childList: true, subtree: true })
  void refresh()

  // UI 语言切换后重放已开着的菜单项文案（纯 DOM 写入，不随 React 重渲染更新）。
  const unregisterReplay = registerUiReplayer(() => {
    syncOpenMenuLabels()
  })

  return () => {
    unregisterReplay()
    closeScopePanel()
    document.removeEventListener('pointerdown', onPointerDown, true)
    observer.disconnect()
    window.clearTimeout(observerTimer)
    unsubscribeDreamEvents()
    for (const item of Array.from(document.querySelectorAll(`[${SKIP_ITEM_ATTR}]`))) item.remove()
    for (const el of Array.from(document.querySelectorAll('[data-meow-scope-panel]'))) el.remove()
  }
}
