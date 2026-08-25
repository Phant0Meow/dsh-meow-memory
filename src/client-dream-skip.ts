/**
 * meow-memory — 会话菜单「跳过梦境整理记忆」toggle（client 端，v0.16.0）。
 *
 * 目标：左侧边栏会话行「…」菜单（dsh SessionNodeItem 硬编码 rename/fork/archive
 * 三项，primitives Menu portal 到 document.body，无扩展点）里追加一项：
 *   未跳过 → 「跳过梦境整理记忆」；已跳过 → 「取消跳过梦境整理记忆」。
 * 点击原地翻转文案、菜单不关（用户拍板交互）；状态持久化在 host 端 memory.db
 * 的 dream_skip 表（POST /meow-memory/skip-dreams），只挡自动 dream。
 *
 * 注入方式（零 dsh 改动）：
 * - pointerdown 捕获阶段记录「点击发生在哪个会话行的操作区」（fiber 读 session id，
 *   dream 图标同款 readSessionId）；pointerdown 先于 click，菜单挂载时目标已知。
 * - MutationObserver 在「该次点击后 1.5s 内」注入：快路径扫 addedNodes 里的
 *   [role="menu"]，全局兜底扫兜住 portal 容器复用（容器不重新挂载、开菜单只增删
 *   子节点的情况）。取现有 menuitem 做 cloneNode 模板——像素级对齐本体菜单（折叠
 *   假气泡同一哲学）；找不到模板/文本叶子一律静默放弃（不报错不残留）。
 * - 幂等锚点=子项存在性；菜单容器打 data-meow-skip-sid 标记仅用于「项被 React
 *   重渲染冲掉」后的补插自愈。
 * - 点击用 capture+stopPropagation+preventDefault：React 18 事件委托不会把它当
 *   原生三项处理，也不会关闭菜单。乐观翻转文案，POST 失败回滚。
 *
 * 数据同步：启动 GET 一次全量对账 + 订阅既有 /meow-memory/dream-events SSE 的
 * skip/unskip 事件（同实例多标签页即时同步；跨实例浏览器标签靠重连对账补齐）。
 * 已知限制：键盘 ↑↓ 导航只走 React 受管的原生三项，不含本项（鼠标优先功能）。
 */

import { MOON_SVG, readSessionId } from './client-dream-icon.ts'

/** 注入项标记属性（清理与幂等锚点）。 */
export const SKIP_ITEM_ATTR = 'data-meow-skip-item'
/** 菜单容器标记属性（值为会话 id；防重复注入 + 冲掉自愈）。 */
export const SKIP_MENU_ATTR = 'data-meow-skip-sid'
/** 会话行操作区（…按钮所在 span）的 CSS Modules 后缀选择器。 */
const ROW_ACTIONS_SEL = '[class$="_rowActions"]'
/** 会话行选择器（dream 图标同款）。 */
const SESSION_ROW_SEL = '[role="treeitem"][class$="_sessionRow"]'
/** 点击→菜单挂载的判定窗口（ms）。 */
const MENU_WINDOW_MS = 1500

/** 菜单项文案（用户拍板：按一下翻转，再按恢复）。 */
export function skipLabel(skipped: boolean): string {
  return skipped ? '取消跳过梦境整理记忆' : '跳过梦境整理记忆'
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

interface SkipItemHost {
  /** toggle 后回调（发 POST + 更新本地集合），由管理器注入。 */
  onToggle: (sessionId: string, skip: boolean, rollback: () => void) => void
}

/**
 * 向一个刚挂载的 [role="menu"] 注入跳过项。幂等锚点=子项存在性（不是容器标记）：
 * portal 容器可能跨开关复用，若"先标记后注入失败"会把复用容器永久挡在门外。
 * @returns 注入的元素；无法注入（无模板/无文本叶子）返回 null（调用方静默放弃，
 *  后续 mutation 会重试）。
 */
function injectSkipItem(menu: Element, sessionId: string, host: SkipItemHost): HTMLElement | null {
  if (menu.querySelector(`[${SKIP_ITEM_ATTR}]`) !== null) return null // 本菜单已注入过
  const template = menu.querySelector('[role="menuitem"]')
  if (template === null) return null
  const item = template.cloneNode(true) as HTMLElement
  item.removeAttribute('id')
  for (const el of Array.from(item.querySelectorAll('[id]'))) el.removeAttribute('id')
  item.setAttribute('role', 'menuitem')
  item.setAttribute(SKIP_ITEM_ATTR, 'true')
  item.setAttribute('data-meow-session-id', sessionId)
  if (!retitleLeaf(item, skipLabel(readSkipped(sessionId)))) return null
  // 图标换月牙（与 dream 小月牙视觉呼应；模板没有 svg 就保持纯文本）
  const icon = item.querySelector('svg')
  if (icon !== null) icon.outerHTML = MOON_SVG
  // 点击：capture 截停，不让事件冒泡进 React 委托（防误触发原生三项/关菜单）。
  const onClick = (e: Event): void => {
    e.stopPropagation()
    e.preventDefault()
    const next = !readSkipped(sessionId)
    writeSkipped(sessionId, next)
    retitleLeaf(item, skipLabel(next))
    host.onToggle(sessionId, next, () => {
      writeSkipped(sessionId, !next)
      retitleLeaf(item, skipLabel(!next))
    })
  }
  item.addEventListener('click', onClick, true)
  item.addEventListener('pointerdown', (e) => e.stopPropagation())
  menu.appendChild(item)
  menu.setAttribute(SKIP_MENU_ATTR, sessionId) // 注入成功才标记：供冲掉自愈（healMarkedMenus）识别
  return item
}

// ── 管理器 ──────────────────────────────────────────────────────────────────

/** 本地跳过集合（模块内可变状态；读写函数便于注入逻辑复用）。 */
const skipped = new Set<string>()
function readSkipped(sid: string): boolean {
  return skipped.has(sid)
}
function writeSkipped(sid: string, val: boolean): void {
  if (val) skipped.add(sid)
  else skipped.delete(sid)
}

/**
 * 启动会话菜单跳过项管理器：全量对账 + SSE 增量 + 点击捕获 + 菜单注入。
 * @returns 清理函数（插件卸载时调用：断连接、摘监听、移除已注入项与菜单标记）。
 */
export function startDreamSkipManager(): () => void {
  let pendingSid: string | null = null
  let pendingAt = 0
  let observerTimer = 0

  /** 给所有「标记过但项被 React 冲掉」的菜单补插（幂等自愈）。 */
  const healMarkedMenus = (): void => {
    for (const menu of Array.from(document.querySelectorAll(`[${SKIP_MENU_ATTR}]`))) {
      const sid = menu.getAttribute(SKIP_MENU_ATTR)
      if (sid === null || menu.querySelector(`[${SKIP_ITEM_ATTR}]`) !== null) continue
      injectSkipItem(menu, sid, { onToggle: handleToggle })
    }
  }

  const observer = new MutationObserver((muts) => {
    // 新菜单注入：仅限「会话 … 点击后窗口期内」。快路径扫 addedNodes；
    // 全局兜底扫不可省——portal 容器常驻复用时，开菜单只增删子节点，
    // [role="menu"] 本体不进 addedNodes（2026-08-25 实测：首次开能注入、重开丢失）。
    if (pendingSid !== null && Date.now() - pendingAt <= MENU_WINDOW_MS) {
      const sid = pendingSid
      for (const m of muts) {
        for (const node of Array.from(m.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue
          const menus = node.matches('[role="menu"]') ? [node] : Array.from(node.querySelectorAll('[role="menu"]'))
          for (const menu of menus) injectSkipItem(menu, sid, { onToggle: handleToggle })
        }
      }
      for (const menu of Array.from(document.querySelectorAll('[role="menu"]'))) {
        injectSkipItem(menu, sid, { onToggle: handleToggle })
      }
    }
    // 标记菜单自愈检查合并进同一 observer（防抖 120ms，dream 图标同款节流）。
    window.clearTimeout(observerTimer)
    observerTimer = window.setTimeout(healMarkedMenus, 120)
  })

  /** toggle 落库：失败回滚由闭包完成（乐观 UI）。 */
  const handleToggle = (sessionId: string, skip: boolean, rollback: () => void): void => {
    void (async () => {
      try {
        const resp = await fetch('/meow-memory/skip-dreams', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, skip }),
        })
        if (!resp.ok) throw new Error(String(resp.status))
      } catch {
        rollback() // 网络/路由失败：文案翻回去，集合还原（SSE 对账也会兜底）
      }
    })()
  }

  const onPointerDown = (e: PointerEvent): void => {
    const sid = captureSessionIdFromTarget(e.target)
    if (sid === null) return
    pendingSid = sid
    pendingAt = Date.now()
  }

  /** 全量对账（挂载/SSE 重连时）：GET 合并快照重建集合。 */
  const refresh = async (): Promise<void> => {
    try {
      const response = await fetch('/meow-memory/skip-dreams', { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json() as { sessionIds?: unknown }
      skipped.clear()
      if (Array.isArray(data.sessionIds)) {
        for (const id of data.sessionIds) {
          if (typeof id === 'string') skipped.add(id)
        }
      }
    } catch {
      // 路由不可用（旧版本 host / webServer 缺失）：静默降级，菜单项照常注入但
      // toggle 会失败回滚——比整个功能消失更可诊断。
    }
  }

  // SSE 增量：skip/unskip 同步本标签页集合（dream-icon 用同通道不同关注点，互不影响：
  // 它对未知状态删月牙——skip/unskip 不携带月亮语义，恰好幂等无害）。
  let eventSource: EventSource | null = null
  let reconnectTimer = 0
  const connect = (): void => {
    eventSource?.close()
    eventSource = new EventSource('/meow-memory/dream-events')
    eventSource.addEventListener('dream', (raw) => {
      try {
        const data = JSON.parse((raw as MessageEvent).data) as { sessionId?: unknown; state?: unknown }
        if (typeof data.sessionId !== 'string') return
        if (data.state === 'skip') {
          skipped.add(data.sessionId)
        } else if (data.state === 'unskip') {
          skipped.delete(data.sessionId)
        } else {
          return
        }
        healMarkedMenus() // 已开着的菜单文案同步翻转
      } catch {
        // 坏帧忽略
      }
    })
    eventSource.onopen = () => { void refresh() }
    eventSource.onerror = () => {
      eventSource?.close()
      eventSource = null
      window.clearTimeout(reconnectTimer)
      reconnectTimer = window.setTimeout(connect, 60_000)
    }
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  observer.observe(document.body, { childList: true, subtree: true })
  connect()
  void refresh()

  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    observer.disconnect()
    window.clearTimeout(observerTimer)
    window.clearTimeout(reconnectTimer)
    eventSource?.close()
    eventSource = null
    for (const item of Array.from(document.querySelectorAll(`[${SKIP_ITEM_ATTR}]`))) item.remove()
    for (const menu of Array.from(document.querySelectorAll(`[${SKIP_MENU_ATTR}]`))) menu.removeAttribute(SKIP_MENU_ATTR)
  }
}
