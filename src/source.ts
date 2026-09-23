/**
 * 插件消息的生产者身份（DSH session format v4 准入契约）。
 *
 * dsh 0.1.7 起，v4 会话要求每条消息的生产者「自报家门」：退役的通用 kind
 * `plugin` 在写入（encodeCurrentEvent）与读取（行准入）两侧都会被拒，报
 * `format v4 message requires a producer-owned source kind` —— 插件的快照/通知
 * 消息一注入就整轮失败。第三方插件的规范形态是 `plugin:<包名>`，与官方迁移器
 * 对历史会话的处理一致：`{ kind: 'plugin', plugin: 'meow-memory' }` →
 * `{ kind: 'plugin:meow-memory' }`（并丢弃 plugin 字段）。
 *
 * 由此，识别端必须同时认这两种形态：当前形态来自本插件新写入的消息，
 * 退役形态来自尚未迁移的历史日志。
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:meow-memory': { kind: 'plugin:meow-memory' } & ContextFormed
  }
}

/** 插件名（= 包名后半段），同时是生产者 kind 的后缀。 */
export const PLUGIN_NAME = 'meow-memory'

/** 本插件写入消息时声明的生产者 kind。 */
export const PLUGIN_KIND = `plugin:${PLUGIN_NAME}` as const

/** 本插件消息的 source 基座；带 form 的调用点在其上展开。 */
export const PLUGIN_SOURCE = { kind: PLUGIN_KIND } as const

/** 消息 source 的最小可判别形状（durable 行与客户端投影节点通用）。 */
interface SourceLike {
  kind?: unknown
  plugin?: unknown
}

/**
 * 判定一条消息是否由本插件生产。
 * @param source - 消息 source 字段（未知输入，可能是投影节点或日志行）。
 * @returns 当前形态 `plugin:meow-memory` 或退役形态 `plugin` + 插件名时为 true。
 */
export function isMeowSource(source: unknown): boolean {
  if (source === null || typeof source !== 'object') return false
  const record = source as SourceLike
  if (record.kind === PLUGIN_KIND) return true
  return record.kind === 'plugin' && record.plugin === PLUGIN_NAME
}
