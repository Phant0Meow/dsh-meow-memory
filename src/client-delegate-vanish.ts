/**
 * meow-memory — header 子代理列表隐身（client 端，vanish 链路）。
 *
 * 目标（猫猫 2026-09-03 拍板）：delegate 反思/梦境 fork 子代理**全程**不出现在
 * header 的子代理列表（SubagentHeaderLineage）里——行与 "N subagents" 数字
 * trigger 都不出现；后台任务的存在感由主会话的打点气泡承担。
 *
 * 为什么 host 侧解决不了（dsh 0.1.1-rc.2 源码实证）：
 * - header 行列表 = subagents.list API → listChildren()：数据源是 live registry
 *   + 持久化全量会话头，过滤条件只有 origin==='subagent' && parentSession，
 *   **不读 workspace 归档集合**（archiveSession 的官方语义"hidden from every
 *   grouping surface"在 catalog 这一面不生效）；dispose 只清运行时，log 落盘
 *   后仍被列为 inactive 行。
 * - 数字 = 客户端 indexSubagentDescendants(byId) 谱系计数 + catalog 条目数取
 *   max，React 渲染，同样不过滤。
 * - descriptor 无"隐藏"字段、list API 无过滤参数、宿主无删除会话 API。
 *
 * 机制（纯 client，官方 UI 零侵入、fail-open）：
 * - 数据：meow-memory 注册自己的零渲染 seat（header.actions 是叠加 list 槽；
 *   lineage single 槽被官方 SubagentHeaderLineage 独占，不能同槽共存），经
 *   standardProps 注入的 useSessions 只读订阅 current/byId/subagentsByParent，
 *   复刻官方 count 公式做出 trigger 决策；
 * - 识别：label 前缀 'meow-memory'（delegate 写死的插件命名空间 label：
 *   'meow-memory reflect' / 'meow-memory dream N/M'）——用户手动子代理的
 *   label 是任务描述，不可能撞上；匹配不上的条目一概不碰；
 * - DOM：行 = role="treeitem" 且 aria-label 匹配 → display:none（幂等，失配
 *   恢复）；trigger = 从哨兵元素定位 lineage root 内 [class*="_trigger"]
 *   （CSS Modules 编译格式 hash_原名，子串匹配；switcher 类名 _switcherTrigger
 *   大写 T 不会误中）→ 按决策写 style；
 * - 已知边界：混合状态（我们家 + 用户手动子代理并存）时 trigger 保留、数字虚高
 *   （React 计算逻辑改不动，点开下拉行是正确过滤的）；纯我们家时 trigger 整体
 *   藏掉 → 完全无感；
 * - fail-open：数据未就绪/结构变化/任何异常 → 不动 DOM，退化回官方显示。
 */

/** delegate 子代理 label 的命名空间前缀（delegate.ts 写死，勿改两边之一）。
 *  带尾随空格：'meow-memory reflect' / 'meow-memory dream N/M' 两形态均含；
 *  'meow-memoryx' 这类近似串不命中。 */
export const DELEGATE_LABEL_PREFIX = 'meow-memory '

/** 判定一个 catalog 条目/行 aria-label 是否属于 meow-memory delegate。 */
export function isMeowDelegateLabel(label: unknown): boolean {
  return typeof label === 'string' && label.startsWith(DELEGATE_LABEL_PREFIX)
}

/** useSessions state 的最小结构（只取本链路用到的字段）。 */
export interface VanishSessionState {
  current?: string
  byId?: Record<string, VanishSummary>
  subagentsByParent?: Record<string, VanishCatalog>
}

export interface VanishSummary {
  id?: string
  origin?: string
  parentId?: string
  running?: boolean
}

export interface VanishCatalogEntry {
  kind?: string
  id?: string
  label?: string
  activity?: string
  hasChildren?: boolean
}

export interface VanishCatalog {
  state?: string
  entries?: VanishCatalogEntry[]
}

/** trigger 决策结果。known=false 表示数据未就绪，调用方不得动 DOM（fail-open）。 */
export interface VanishDecision {
  /** 数据是否足够做决策（catalog 已 ready）。 */
  known: boolean
  /** 是否隐藏 header 的数字 trigger（目录里只有我们家条目时为 true）。 */
  hideTrigger: boolean
  /** 目录里我们家条目数（诊断/测试用）。 */
  mineCount: number
  /** 目录里别人家条目数（>0 时 trigger 必须保留）。 */
  othersCount: number
}

/**
 * 复刻官方 indexSubagentDescendants（dsh-client-runtime）：统计 root 会话
 * 谱系内全部 origin='subagent' 的 summary 数（沿 parentId 链逐级聚合，环安全）。
 * 官方语义：count 计入完整后代谱系（含孙辈）；delegate 子代理无下一代，
 * 该值 ≈ 直接子代数，作为"别人家是否存在"的谱系兜底。
 */
export function indexSubagentDescendantCount(
  byId: Record<string, VanishSummary> | undefined,
  rootId: string | undefined,
): number {
  if (byId === undefined || rootId === undefined) return 0
  let total = 0
  for (const descendant of Object.values(byId)) {
    if (descendant?.origin !== 'subagent') continue
    const seen = new Set<string>()
    let node: VanishSummary | undefined = descendant
    while (node?.origin === 'subagent' && typeof node.parentId === 'string' && !seen.has(node.id ?? '')) {
      seen.add(node.id ?? '')
      if (node.parentId === rootId) {
        total += 1
        break
      }
      node = byId[node.parentId]
    }
  }
  return total
}

/**
 * trigger 决策（纯函数）：
 * - catalog 未 ready（未加载/loading/error）→ known=false，fail-open；
 * - 目录里存在别人家条目（或谱系计数超出我们家条目数，兜底孙辈等未列出的
 *   后代）→ trigger 保留（别人家的入口不能藏）；
 * - 目录里只有我们家条目 → hideTrigger=true。
 */
export function computeVanishDecision(state: VanishSessionState | undefined): VanishDecision {
  const current = state?.current
  const catalog = current === undefined ? undefined : state?.subagentsByParent?.[current]
  const entries = catalog?.state === 'ready' ? (catalog.entries ?? []).filter((e) => e?.kind === 'child') : []
  if (catalog?.state !== 'ready') {
    return { known: false, hideTrigger: false, mineCount: 0, othersCount: 0 }
  }
  const mine = entries.filter((e) => isMeowDelegateLabel(e.label))
  const others = entries.length - mine.length
  const lineageTotal = indexSubagentDescendantCount(state?.byId, current)
  const hideTrigger = others === 0 && mine.length > 0 && lineageTotal <= mine.length
  return { known: true, hideTrigger, mineCount: mine.length, othersCount: others }
}

// ── DOM 层 ────────────────────────────────────────────────────────────────────

/** 哨兵元素属性（组件渲染在 header.actions 槽内，上溯定位 crumb 里的 lineage root）。 */
export const SENTINEL_ATTR = 'data-meow-vanish'
/** 已被我们隐藏的行标记（失配恢复用；幂等判重）。 */
const ROW_ATTR = 'data-meow-vanish-row'

/**
 * 从哨兵元素向上定位 lineage root 容器：祖先若干层内找带 [class*="_root"]
 * 且含 [class*="_trigger"] 的容器（双条件防撞别的 CSS module 的 _root）。
 * 找不到返回 null（fail-open）。
 */
export function locateLineageRoot(sentinel: Element | null | undefined): HTMLElement | null {
  let scope = sentinel?.parentElement ?? null
  for (let hop = 0; scope !== null && hop < 5; hop += 1, scope = scope.parentElement) {
    const candidates = scope.querySelectorAll<HTMLElement>(':scope [class*="_root"]')
    for (const candidate of Array.from(candidates)) {
      if (candidate.contains(sentinel ?? null)) continue
      if (candidate.querySelector(':scope [class*="_trigger"]') !== null) return candidate
    }
    // 哨兵的近邻层级若无 root，继续向上一级扩大搜索。
  }
  return null
}

/**
 * 行隐藏：全页 role="treeitem" 中 aria-label 命中 delegate 命名空间的行
 * （header 下拉菜单经 portal 渲染，所以全页扫）→ display:none；
 * 曾被我们隐藏但现已失配的行 → 恢复显示。只写差异值，幂等。
 */
export function vanishRows(root: ParentNode = document): void {
  const rows = root.querySelectorAll('[role="treeitem"]')
  for (const row of Array.from(rows)) {
    const match = isMeowDelegateLabel(row.getAttribute('aria-label'))
    const marked = row.getAttribute(ROW_ATTR) === '1'
    if (match && !marked) {
      row.setAttribute(ROW_ATTR, '1')
      ;(row as HTMLElement).style.display = 'none'
    } else if (!match && marked) {
      row.removeAttribute(ROW_ATTR)
      ;(row as HTMLElement).style.display = ''
    }
  }
}

/**
 * 应用一次 trigger 显隐决策（root 内第一个 [class*="_trigger"]；switcher
 * 类名 _switcherTrigger 大写 T 不会命中）。只写差异值，幂等。
 */
export function applyTriggerVisibility(root: HTMLElement | null | undefined, hide: boolean): void {
  if (root === null || root === undefined) return
  const trigger = root.querySelector<HTMLElement>(':scope [class*="_trigger"]')
  if (trigger === null) return
  const next = hide ? 'none' : ''
  if (trigger.style.display !== next) trigger.style.display = next
}

/** DOM 动作入口：行隐藏恒执行；决策已知时同步 trigger 显隐。 */
export function applyVanishDom(decision: VanishDecision, sentinel: Element | null | undefined): void {
  try {
    vanishRows()
    if (decision.known) applyTriggerVisibility(locateLineageRoot(sentinel), decision.hideTrigger)
  } catch (e) {
    console.warn('[meow-memory] vanish DOM 应用失败（fail-open，保持官方显示）：', e)
  }
}

/**
 * 挂 body 级 MutationObserver 兜底：菜单 portal 渲染/React 重渲染/视图切换
 * 后自愈（行是新 DOM、trigger 可能被重建）。防抖 80ms（同折叠模块）。
 * 返回断开函数。
 */
export function startVanishObserver(getApply: () => { decision: VanishDecision; sentinel: Element | null }): () => void {
  let timer = 0
  const observer = new MutationObserver(() => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      const { decision, sentinel } = getApply()
      applyVanishDom(decision, sentinel)
    }, 80)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    window.clearTimeout(timer)
    observer.disconnect()
  }
}
