/**
 * client-dream-events.ts — dream 状态增量共享源（2026-09-05 连接池修复）。
 *
 * 此前 dream-icon / dream-skip / delegate-notice 三个管理器各开一条
 * EventSource('/meow-memory/dream-events')——单页 3 条 HTTP/1.1 长连接，加上
 * 官方 events.mux / events.host 两条 ws，同源浏览器连接池（每域 6 条）只剩 1
 * 条余量：同源第二个标签页或刷新会被饿死（前端「第二个窗口打不开 / 刷新打不
 * 开 / 越来越卡」的直接原因，3080/3081 皆然，femwa 的页面级 SSE 只是压垮线的
 * 最后一根）。
 *
 * 药方：SSE → 共享轮询。dream 状态是小时级低频信号（空闲期整理），三条长连接
 * 换成一个全页共享的 60s 轮询（dreamed-sessions + skip-dreams 各一次 GET），
 * 对上一次快照做 diff，产出与旧 SSE 'dream' 帧同语义的增量事件
 * （dreamed/dreaming/active + skip/unskip）。UI 层（月亮图标 / 菜单文案 /
 * 气泡翻转）对 60s 延迟不敏感；各管理器挂载时的 refresh() 全量对账保持不变，
 * 首屏即时性不受影响。
 *
 * 本模块零 DOM 依赖：纯 订阅表 + 定时器 + fetch diff，可单测。
 */

/** 一条 dream 状态增量（与旧 SSE 'dream' 帧的 data 同形）。 */
export interface DreamEvent {
  sessionId: string
  /** 'dreamed' | 'dreaming' | 'active'（新活动/退出整理） | 'skip' | 'unskip' */
  state: string
}

type DreamListener = (event: DreamEvent) => void

const listeners = new Set<DreamListener>()
let pollTimer = 0
let lastStates = new Map<string, string>()
let lastSkipped = new Set<string>()
/** 是否已建立基线快照。首轮 poll 只建基线不 emit——各管理器挂载时已各自
 *  refresh() 全量对账，首轮把存量状态当"增量"发出去是纯冗余（库里几百个
 *  已 dream 会话时 = 订阅回调连发上百次幂等 DOM 重放）。 */
let hasBaseline = false

function emit(sessionId: string, state: string): void {
  for (const listener of [...listeners]) {
    try {
      listener({ sessionId, state })
    } catch {
      // 单订阅者异常不影响其他订阅者（与旧 SSE 各自 try/catch 同语义）。
    }
  }
}

/** 一轮对账：拉两个快照端点，diff 出增量并广播。任何失败静默（下轮再试）。 */
export async function pollDreamEventsOnce(): Promise<void> {
  let states: Map<string, string>
  let skipped: Set<string>
  try {
    const [statesRes, skipRes] = await Promise.all([
      fetch('/meow-memory/dreamed-sessions', { cache: 'no-store' }),
      fetch('/meow-memory/skip-dreams', { cache: 'no-store' }),
    ])
    if (!statesRes.ok || !skipRes.ok) return
    const statesData = await statesRes.json() as { sessionIds?: unknown; dreamingIds?: unknown }
    const skipData = await skipRes.json() as { sessionIds?: unknown }
    states = new Map()
    if (Array.isArray(statesData.sessionIds)) {
      for (const id of statesData.sessionIds) if (typeof id === 'string') states.set(id, 'dreamed')
    }
    if (Array.isArray(statesData.dreamingIds)) {
      for (const id of statesData.dreamingIds) if (typeof id === 'string') states.set(id, 'dreaming')
    }
    skipped = new Set()
    if (Array.isArray(skipData.sessionIds)) {
      for (const id of skipData.sessionIds) if (typeof id === 'string') skipped.add(id)
    }
  } catch {
    // 路由不可用（webServer 缺失/旧版本 host）：静默降级，下轮再试。
    return
  }
  // 首轮：静默建基线（各管理器 refresh() 已全量对账，此处 emit 是冗余）。
  if (!hasBaseline) {
    lastStates = states
    lastSkipped = skipped
    hasBaseline = true
    return
  }
  // 状态增量：出现/翻转/消失（消失 = 'active'，与旧 SSE 语义一致）。
  for (const [sessionId, state] of states) {
    if (lastStates.get(sessionId) !== state) emit(sessionId, state)
  }
  for (const [sessionId, state] of lastStates) {
    if (!states.has(sessionId)) emit(sessionId, 'active')
  }
  // skip 增量：新出现 = skip，消失 = unskip。
  for (const sessionId of skipped) {
    if (!lastSkipped.has(sessionId)) emit(sessionId, 'skip')
  }
  for (const sessionId of lastSkipped) {
    if (!skipped.has(sessionId)) emit(sessionId, 'unskip')
  }
  lastStates = states
  lastSkipped = skipped
}

/**
 * 订阅 dream 状态增量（轮询 diff 产出，事件形状与旧 SSE 'dream' 帧一致）。
 * 首个订阅者启动共享轮询（并立即对账一次，替代旧 SSE onopen 全量补漏——各
 * 管理器自己的 refresh() 仍保留，负责首屏即时渲染）。最后一个订阅者移除时停
 * 表。@returns 清理函数（移除本订阅）。
 */
export function subscribeDreamEvents(listener: DreamListener): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && pollTimer === 0) {
    pollTimer = window.setInterval(() => { void pollDreamEventsOnce() }, 60_000)
    void pollDreamEventsOnce()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && pollTimer !== 0) {
      window.clearInterval(pollTimer)
      pollTimer = 0
    }
  }
}
