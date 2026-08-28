/**
 * meow-memory — 会话菜单「跳过梦境整理记忆」toggle（client 端，v0.16.0 / v0.18.0 重构锚点）。
 *
 * 目标：左侧边栏会话行「…」菜单（dsh SessionNodeItem 硬编码 rename/fork/archive
 * 三项，primitives Menu portal 到 document.body，无扩展点）里追加一项：
 *   未跳过 → 「跳过梦境整理记忆」（斜杠月牙图标）；已跳过 → 「取消跳过梦境整理记忆」
 *   （实心月牙图标）。点击原地翻转、菜单不关（用户拍板交互）；状态持久化在 host 端
 * memory.db 的 dream_skip 表（POST /meow-memory/skip-dreams），只挡自动 dream。
 *
 * 注入方式（零 dsh 改动）：
 * - 身份解析：dsh Rows.tsx 在菜单打开期间给行挂 menuOpen 类——读该行 fiber key
 *   即得 session id，任意时刻可确定「谁的菜单开着」，不受挂载延迟影响；
 *   pointerdown 捕获（行操作区 → readSessionId）作 menuOpen 锚点失效时的兜底，
 *   仅限点击后 1.5s 时间窗内生效。
 * - MutationObserver 双路注入：快路径扫 addedNodes 里的 [role="menu"]；防抖自愈
 *   （syncOpenMenus）在每次 DOM 变化后收敛——迟挂载/模板晚到/项被冲掉/容器复用
 *   串味统一处理。取现有 menuitem 做 cloneNode 模板——像素级对齐本体菜单；找不到
 *   模板/文本叶子一律静默放弃（不报错不残留），后续 mutation 重试。
 * - 幂等锚点=「子项存在且绑定同一会话」；绑定别会话的残留项拆掉重注。
 * - 点击用 capture+stopPropagation+preventDefault：React 18 事件委托不会把它当
 *   原生三项处理，也不会关闭菜单。乐观翻转文案与图标，POST 失败回滚。
 *
 * 数据同步：启动 GET 一次全量对账 + 订阅既有 /meow-memory/dream-events SSE 的
 * skip/unskip 事件（同实例多标签页即时同步；跨实例浏览器标签靠重连对账补齐）。
 * 已知限制：键盘 ↑↓ 导航只走 React 受管的原生三项，不含本项（鼠标优先功能）。
 */

import { MOON_SVG, makeSkipMoonSvg, readSessionId } from './client-dream-icon.ts'

/** 注入项标记属性（清理与幂等锚点；data-meow-session-id 记录绑定会话）。 */
export const SKIP_ITEM_ATTR = 'data-meow-skip-item'
/** 会话行操作区（…按钮所在 span）的 CSS Modules 后缀选择器。
 *  子串匹配：生成格式为 `<hash>_<local>`，`_rowActions` 子串全库唯一。 */
const ROW_ACTIONS_SEL = '[class*="_rowActions"]'
/** 会话行选择器（dream 图标同款）。
 *  必须子串匹配而非结尾匹配：行类按 clsx 顺序拼接（sessionRow, selected, menuOpen），
 *  当前选中行常驻 _selected、菜单打开时追加 _menuOpen，都排在 _sessionRow 之后——
 *  `[class$=]` 对整个 class 属性串做结尾匹配必然失配（2026-08-26 实测根因：
 *  对当前选中的会话点 … 永远捕获不到 id，注入时灵时不灵）。 */
export const SESSION_ROW_SEL = '[role="treeitem"][class*="_sessionRow"]'
/** 菜单打开中的会话行：dsh Rows.tsx 把 menuOpen 状态同时挂到行级 menuOpen 类——
 *  据此可在任意时刻确定「哪个会话的菜单正开着」，不依赖点击时间窗。 */
export const MENU_OPEN_ROW_SEL = '[role="treeitem"][class*="_menuOpen"]'
/** 点击→菜单挂载的判定窗口（ms；仅作 menuOpen 锚点失效时的兜底）。 */
const MENU_WINDOW_MS = 1500

/** 菜单项文案（用户拍板：按一下翻转，再按恢复）。 */
export function skipLabel(skipped: boolean): string {
  return skipped ? '取消跳过梦境整理记忆' : '跳过梦境整理记忆'
}

/**
 * 菜单项图标（v0.18.0，用户实测纠正）：菜单项是**动作按钮**，图标画「点击后将变成的
 * 状态」，与标签动词呼应——「跳过梦境整理记忆」配灰调月牙+斜杠（点下去就静音）、
 * 「取消跳过梦境整理记忆」配实心月牙（点下去就恢复）。@param skipped 当前状态；
 * 模板没有 svg 就保持纯文本。
 */
export function setMenuIcon(item: HTMLElement, skipped: boolean): void {
  const icon = item.querySelector('svg')
  if (icon !== null) icon.outerHTML = skipped ? MOON_SVG : makeSkipMoonSvg()
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
 * dsh Rows.tsx 在菜单打开期间给行挂 menuOpen 类），读不到再退回点击时捕获的 id。
 * @param doc - Document（或等价 querySelector 载体，测试传桩）。
 * @param fallback - 点击捕获兜底值；无兜底且行不可读时返回 null（不注入）。
 */
export function resolveMenuSessionId(
  doc: { querySelector(selector: string): Element | null },
  fallback: string | null,
): string | null {
  const openRow = doc.querySelector(MENU_OPEN_ROW_SEL)
  if (openRow !== null) {
    const sid = readSessionId(openRow as HTMLElement)
    if (sid !== null) return sid
  }
  return fallback
}

interface SkipItemHost {
  /** toggle 后回调（发 POST + 更新本地集合），由管理器注入。 */
  onToggle: (sessionId: string, skip: boolean, rollback: () => void) => void
}

/**
 * 向一个刚挂载的 [role="menu"] 注入跳过项。幂等锚点=「子项存在且绑定同一会话」：
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
  if (!retitleLeaf(item, skipLabel(readSkipped(sessionId)))) return null
  item.setAttribute(SKIP_ITEM_ATTR, 'true')
  item.setAttribute('data-meow-session-id', sessionId)
  // 图标画「点击后将变成的状态」（未跳过→斜杠月牙；已跳过→实心月牙），与标签动词呼应
  setMenuIcon(item, readSkipped(sessionId))
  // 点击：capture 截停，不让事件冒泡进 React 委托（防误触发原生三项/关菜单）。
  const onClick = (e: Event): void => {
    e.stopPropagation()
    e.preventDefault()
    const next = !readSkipped(sessionId)
    writeSkipped(sessionId, next)
    retitleLeaf(item, skipLabel(next))
    setMenuIcon(item, next)
    host.onToggle(sessionId, next, () => {
      writeSkipped(sessionId, !next)
      retitleLeaf(item, skipLabel(!next))
      setMenuIcon(item, !next)
    })
  }
  item.addEventListener('click', onClick, true)
  item.addEventListener('pointerdown', (e) => e.stopPropagation())
  menu.appendChild(item)
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

  /**
   * 菜单同步（防抖自愈，任何 DOM 变化后收敛一次）：只要检测到「有会话菜单正开着」
   * （menuOpen 行存在；时间窗内的点击捕获作兜底），就确保页面上每个可见
   * [role=menu] 都带正确会话的跳过项。迟挂载、模板晚到、项被 React 冲掉、
   * 容器复用串味，全部在这一条路上收敛——不受 1.5s 时间窗限制。
   */
  const syncOpenMenus = (): void => {
    const withinWindow = pendingSid !== null && Date.now() - pendingAt <= MENU_WINDOW_MS
    const sid = resolveMenuSessionId(document, withinWindow ? pendingSid : null)
    if (sid === null) return
    for (const menu of Array.from(document.querySelectorAll('[role="menu"]'))) {
      injectSkipItem(menu, sid, { onToggle: handleToggle })
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
            for (const menu of menus) injectSkipItem(menu, sid, { onToggle: handleToggle })
          }
        }
        for (const menu of Array.from(document.querySelectorAll('[role="menu"]'))) {
          injectSkipItem(menu, sid, { onToggle: handleToggle })
        }
      }
    }
    // 自愈检查合并进同一 observer（防抖 120ms，dream 图标同款节流）。
    window.clearTimeout(observerTimer)
    observerTimer = window.setTimeout(syncOpenMenus, 120)
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

  // SSE 增量：skip/unskip 同步本标签页集合（v0.18.0 起 dream 图标管理器也消费
  // 同通道的 skip/unskip 渲染「月牙+斜杠」——两边各自对账，互不干扰）。
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
        void syncOpenMenus() // 已开着的菜单文案/图标同步翻转
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
  }
}
