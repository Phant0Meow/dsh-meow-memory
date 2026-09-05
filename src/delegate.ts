/**
 * meow-memory — 整理任务的模型 spec 解析 + 历史 delegate 打点标记。
 *
 * v0.24 起反思/梦境**永远在主窗口执行**（steer），独立 fork 子代理链路整体移除
 * （猫猫 2026-09-06 拍板：设置里不再提供"独立执行"选项，代码永远走 steer 分支）。
 * 换模型不再依赖 fork：agent/request waterfall（dsh 官方单请求换模型扩展点）在
 * 反思/梦境轮的请求上覆盖 provider/model，轮次结束自动换回主模型（index.ts 实现）。
 *
 * 本文件保留两块：
 * - parseModelSpec / AgentOptionsSpec：delegate.model（整理任务模型）配置解析，
 *   格式不变——'provider/model'（dsh route 格式）或 'model'（provider 继承主会话）。
 * - 三个打点标记常量：v0.23 时代 delegate 模式写入主会话 log 的历史打点消息识别。
 *   旧会话里这些消息仍在（client 气泡渲染 + index.ts 事件链防 touchWindow 都靠
 *   文本标记识别），绝不能删；新代码不再产生新打点。
 */

/** delegate.model 配置解析结果（agent/request 覆盖只替换提供的字段）。 */
export interface AgentOptionsSpec {
  provider?: string
  model?: string
}

/**
 * 解析 delegate.model 配置：'provider/model'（dsh route 格式，如
 * zai-coding-cn/glm-5.3-flash）或 'model'（provider 继承主会话 route）。
 * 空串/undefined → undefined（全程主模型）。
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

// ── 历史 delegate 打点标记（v0.23 遗留识别，只读不写）────────────────────────
//
// delegate 模式已移除，新代码不再 append 打点；但旧版本写入主会话 log 的打点
// 消息仍在历史会话里，index.ts 事件链靠这些文本标记把它们判为插件消息
// （不 touchWindow 不刷新活跃度），client 气泡靠识别渲染历史状态。

export const REFLECT_DELEGATE_MARKER = '【记忆反思标记】'
export const DREAM_DELEGATE_MARKER = '【记忆整理标记】'
/** 反思完成打点（不出气泡，client 气泡「进行中→已完成」的历史翻转信号）。 */
export const REFLECT_DONE_DELEGATE_MARKER = '【记忆反思完成标记】'
