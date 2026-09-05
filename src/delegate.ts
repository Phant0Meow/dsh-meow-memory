/**
 * meow-memory — 反思/梦境的独立执行体（fork 子代理，delegate 链路）。
 *
 * 目标（猫猫 2026-09-02 拍板）：反思/梦境轮不再拼接进主会话上下文——steer 方案的
 * prompt+回应+工具调用全落主 log（折叠 UI 只是视觉隐藏，LLM 上下文仍在），且主会话
 * 一个 session 一个 route，steer 无法单轮换模型（issue #7 的需求）。
 *
 * 机制（dsh 源码实证 2026-09-02）：
 * - fork 后端把父会话「全部已完成 turn」的 log 播种进子会话（completedTurnPrefix：
 *   user 消息、assistant 回应、工具调用与工具结果都在；切到最后一个 turn/end），
 *   子代理跑在自己的 session log 里，父会话零写入——主对话 compaction 更晚触发。
 * - 子代理 origin='subagent'（dsh 权威标记）→ 本插件的注入/反思/dream 链路对它
 *   天然跳过，不会自循环；GUI 会话列表也天然过滤 origin='subagent'（子会话不可见）。
 * - per-child 模型覆盖原生支持：request.agentOptions = { provider?, model? }
 *   （resolveChildAgentOptions 只覆盖提供的字段，缺省继承父 route）。model 留空=
 *   跟随主会话——请求前缀与主会话请求同源（seed 即主 log 重放、system prompt 继承
 *   父 preset），provider 侧 prompt cache 可命中。
 * - subagents registry 在 host composition（process singleton），插件经
 *   ctx.get('subagents') 解析；'fork' provider 名来自 dsh-subagent-fork-in-process。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** delegate.model 配置解析结果（agentOptions 只覆盖提供的字段）。 */
export interface AgentOptionsSpec {
  provider?: string
  model?: string
}

/**
 * 解析 delegate.model 配置：'provider/model'（dsh route 格式，如
 * zai-coding-cn/glm-5.3-flash）或 'model'（provider 继承父会话 route）。
 * 空串/undefined → undefined（跟随父）。
 */
export function parseModelSpec(spec: string | undefined): AgentOptionsSpec | undefined {
  const trimmed = spec?.trim()
  if (!trimmed) return undefined
  const idx = trimmed.indexOf('/')
  if (idx > 0 && idx < trimmed.length - 1) {
    return { provider: trimmed.slice(0, idx), model: trimmed.slice(idx + 1) }
  }
  return { model: trimmed }
}

/** ctx.subagents.start 的最小结构（@deepseek-ai/dsh-subagent SubagentsService.start）。 */
export interface SubagentsLike {
  getProvider?(name: string): { name: string } | undefined
  start(
    name: string,
    request: {
      label?: string
      prompt: ReadonlyArray<{ type: 'text'; text: string }>
      parent: unknown
      signal: AbortSignal
      agentOptions?: { provider?: string; model?: string }
    },
  ): Promise<{
    id: string
    result: Promise<{ stopReason: string; output?: ReadonlyArray<{ type?: string; text?: string }> }>
    dispose(): Promise<void>
  }>
}

export interface DelegateLogger {
  info(msg: string): void
  warn(msg: string): void
}

/**
 * 从插件 ctx 解析 subagents 服务（cordis 走 ctx.get；测试桩可直挂属性）。
 * 服务未就绪时 ctx.get 静默返回 undefined，而直取属性会抛
 * "cannot get property ... without inject"（真机踩坑 2026-09-03：apply 期
 * subagents 服务尚未启动，同步解析炸掉整个插件树加载）——整体兜底返回
 * undefined，调用方按 unavailable 降级（startDelegateSubagent 已处理）。
 */
export function resolveSubagents(ctx: unknown): SubagentsLike | undefined {
  try {
    const c = ctx as { get?: (name: string) => unknown; subagents?: SubagentsLike }
    const viaGet = c.get?.('subagents') as SubagentsLike | undefined
    if (viaGet !== undefined) return viaGet
    return c.subagents
  } catch {
    return undefined
  }
}

/** workspace 服务的最小结构（@deepseek-ai/dsh-workspace archiveSession：把会话加进持久化归档集合）。 */
export interface WorkspaceLike {
  archiveSession?(sessionId: string): unknown
}

/** 从插件 ctx 解析 workspace 服务（host composition 装配；缺失时调用方跳过归档）。 */
export function resolveWorkspace(ctx: unknown): WorkspaceLike | undefined {
  try {
    return (ctx as { get?: (name: string) => unknown }).get?.('workspace') as WorkspaceLike | undefined
  } catch {
    return undefined
  }
}

// ── 主会话打点（猫猫拍板 2026-09-02）─────────────────────────────────────────
//
// delegate 模式下整理过程不进主会话，主模型对「整理发生过」完全无感——在主会话
// log 里补一条极短的插件标记消息（session.append，**不触发 LLM turn**），恢复
// 对话流里的位置锚点：主模型元认知知道此处整理过；后续整理以标记为界取增量。
// kind='plugin' + form='notice'：GUI 渲染成一行折叠通知、标题提取跳过
// （collectSessionTitleMessages 只认 kind='user'）；文本绝不能含
// REFLECT_MARKER/DREAM_MARKER 原文（wasDreamTurn/scanTurn 是全量/按 marker 扫描）。

export const REFLECT_DELEGATE_MARKER = '【记忆反思标记】'
export const DREAM_DELEGATE_MARKER = '【记忆整理标记】'
/** 反思完成打点（子代理 settle 后追加）：不出气泡，是 client 气泡「进行中→已完成」的翻转信号。 */
export const REFLECT_DONE_DELEGATE_MARKER = '【记忆反思完成标记】'

export type DelegateMarkerKind = 'reflect' | 'reflect-done' | 'dream'

/** 构造打点消息（session.append('user/message', ...) 用，不触发 turn）。
 *  sessionId 进 source.memory：client 气泡据此精确判定所属会话的 dream 状态。
 *  reflect=触发打点（气泡锚点，显示「进行中」）；reflect-done=完成信号（不出气泡）；
 *  dream=触发打点（完成信号走 dream-events SSE）。 */
export function buildDelegateMarkerMessage(kind: DelegateMarkerKind, sessionId?: string): ReturnType<typeof createUserMessage> {
  const meta: { text: string; summary: string; memoryKind: string } = kind === 'reflect'
    ? { text: `${REFLECT_DELEGATE_MARKER} 记忆反思任务已在后台启动，独立执行不占用本对话上下文。`, summary: '记忆反思任务进行中', memoryKind: 'reflect-marker' }
    : kind === 'reflect-done'
      ? { text: `${REFLECT_DONE_DELEGATE_MARKER} 记忆反思任务已完成，成果已写入记忆库。`, summary: '记忆反思任务已完成', memoryKind: 'reflect-done-marker' }
      : { text: `${DREAM_DELEGATE_MARKER} 梦境记忆整理任务已在后台启动，独立执行不占用本对话上下文。`, summary: '梦境记忆整理任务进行中', memoryKind: 'dream-marker' }
  return createUserMessage({
    content: [{ type: 'text', text: meta.text }],
    source: {
      kind: 'plugin',
      plugin: 'meow-memory',
      form: 'notice',
      // summary=原生 notice 折叠行的单行文案：client 气泡模块未加载时的降级显示（人话，不是裸标记）。
      summary: meta.summary,
      memory: {
        kind: meta.memoryKind,
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
    },
  })
}

/** 防御式向主会话 log 追加打点（session 不可写/桩环境静默跳过）。
 *  必须带 { surfaceOp: 'append' }：投影层只把 surfaceOp='append' 的 user/message
 *  投影成会话流节点（isAppendSurfaceEvent）——不传则消息只落 log，UI 完全不可见
 *  （2026-09-03 气泡不显示的根因：打点进了 log 却进不了会话流）。 */
export function appendDelegateMarker(agent: unknown, kind: DelegateMarkerKind): void {
  const session = (agent as { session?: { header?: { id?: string }; append?: (type: string, data: unknown, opts?: unknown) => void } }).session
  if (session === undefined || typeof session.append !== 'function') return
  try {
    session.append('user/message', buildDelegateMarkerMessage(kind, session.header?.id), { surfaceOp: 'append' })
  } catch {
    /* 打点失败不阻塞主流程 */
  }
}

export type DelegateOutcome = 'started' | 'in-flight' | 'unavailable'

/**
 * 起一个 fork 子代理跑一段记忆任务（反思 prompt / dream 组 prompt）。异步不等待：
 * 提交后立即返回，结果在内部记日志/回调。绝不 throw（后台任务不阻塞调用方）。
 *
 * @returns
 *   'started'     — 已提交启动（inFlight 已占位，settle 后自动清除）；
 *   'in-flight'   — 同会话已有任务进行中，本次静默跳过（调用方无需回退）；
 *   'unavailable' — subagents 服务或 fork provider 不可用（调用方可回退 steer）。
 */
export function startDelegateSubagent(
  logger: DelegateLogger,
  subagents: SubagentsLike | undefined,
  opts: {
    parent: unknown
    promptText: string
    label: string
    modelSpec?: AgentOptionsSpec
    signal: AbortSignal
    /** 同会话防重入集合（键=sessionId；start 前 add，settle 后清除）。 */
    inFlight: Set<string>
    sessionKey: string
    /** 任务收尾回调（含失败；用于 dream 组推进等）。 */
    done?: (outcome: { stopReason: string; errorDetail?: string }) => void
    /** workspace 服务（可选）：子代理 settle 后把子会话加进归档集合（双保险隐藏——
     *  GUI 列表本就过滤 origin='subagent'，归档兜底未来过滤变化；子会话成果在
     *  memory.db，log 无保留价值，宿主无删除 API 故不物理删除）。 */
    workspace?: WorkspaceLike
  },
): DelegateOutcome {
  if (opts.inFlight.has(opts.sessionKey)) return 'in-flight'
  const svc = subagents as SubagentsLike | undefined
  if (svc === undefined || typeof svc.start !== 'function') {
    logger.warn('meow-memory: delegate skipped — subagents service unavailable')
    return 'unavailable'
  }
  if (svc.getProvider !== undefined && svc.getProvider('fork') === undefined) {
    logger.warn('meow-memory: delegate skipped — fork provider not registered')
    return 'unavailable'
  }
  opts.inFlight.add(opts.sessionKey)
  void (async () => {
    let run: Awaited<ReturnType<SubagentsLike['start']>> | undefined
    let outcome: { stopReason: string; errorDetail?: string } | undefined
    try {
      run = await svc.start('fork', {
        label: opts.label,
        prompt: [{ type: 'text', text: opts.promptText }],
        parent: opts.parent,
        ...(opts.modelSpec !== undefined ? { agentOptions: opts.modelSpec } : {}),
        signal: opts.signal,
      })
      const result = await run.result
      logger.info(`meow-memory: delegate "${opts.label}" finished (${result.stopReason})`)
      outcome = { stopReason: result.stopReason }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      logger.warn(`meow-memory: delegate "${opts.label}" failed: ${detail}`)
      // 错误详情透传 done 回调（2026-09-05：fork start 秒败 26ms 的排障需要——
      // logger.warn 只进宿主控制台，dream-debug.log 拿不到异常内容）。
      outcome = { stopReason: 'error', errorDetail: detail }
    } finally {
      // 子会话归档双保险（成果在 memory.db，log 无保留价值）：失败只 warn。
      if (opts.workspace?.archiveSession && run !== undefined) {
        try {
          opts.workspace.archiveSession(run.id)
        } catch (e) {
          logger.warn(`meow-memory: delegate subagent archive failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      // dispose 失败不吞结果/清账：单独兜底。
      if (run !== undefined) {
        try {
          await run.dispose()
        } catch (e) {
          logger.warn(`meow-memory: delegate dispose failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      opts.inFlight.delete(opts.sessionKey)
    }
    // done 必须在 inFlight 清账**之后**：链式推进（dream 组 N+1 由组 N 的 done 驱动）
    // 会在同 tick 内再次 startDelegateSubagent，账未清会被自己的防重入挡住。
    if (outcome !== undefined) opts.done?.(outcome)
  })()
  return 'started'
}
