/**
 * meow-memory v2 — ReAct 任务结束后的自动反思。
 *
 * 触发：一次任务（单个 turn）内连续 react（工具）step ≥ reflectTurns（默认 7）
 * 后，在该轮结束时触发一次；单次简单工具调用不触发。顶层会话、本 turn 未反思过、
 * 最后工具非 memory_ 系列。
 * 反思消息（用户拍板 2026-08-19 终稿）：【一】新记忆（project 列表/纠正/偏好等）、
 * 【二】更新判断（过时/错误/完成/关键词不准反推）、【三】通用要求（subcategory/
 * 关键词 8-13/importance/收尾）。topic 归 dream 轮处理，反思不再涉及。
 */

import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import { getDb } from './db.js'
import { keyedValue, resolveSlotText } from './prompt-loader.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'meow-memory' }

/** 反思消息识别标记（防同 turn 重复反思）。 */
export const REFLECT_MARKER = '[meow-memory-reflect]'

export function scanTurn(events: readonly unknown[]): {
  sawToolCall: boolean
  lastToolName?: string
  sawReflect: boolean
  turnText: string
} {
  let startIdx = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string }
    if (e?.type === 'turn/start') {
      startIdx = i
      break
    }
  }
  let sawToolCall = false
  let lastToolName: string | undefined
  let sawReflect = false
  const texts: string[] = []
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i] as {
      type?: string
      data?: {
        source?: { kind?: string; plugin?: string }
        content?: Array<{ type?: string; text?: string }>
        message?: { content?: Array<{ type?: string; name?: string; text?: string }> }
      }
    }
    if (e?.type === 'user/message') {
      const src = e.data?.source as { kind?: string; plugin?: string } | undefined
      const msgText = (e.data?.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text ?? '')
        .join(' ')
      if (src?.kind === 'plugin' && src.plugin === 'meow-memory' && msgText.includes(REFLECT_MARKER)) {
        sawReflect = true
      } else {
        for (const b of e.data?.content ?? []) if (b.type === 'text' && b.text) texts.push(b.text)
      }
    } else if (e?.type === 'assistant/message') {
      for (const block of e.data?.message?.content ?? []) {
        if (block.type === 'tool-call') {
          sawToolCall = true
          lastToolName = block.name
        } else if (block.type === 'text' && block.text) {
          texts.push(block.text)
        }
      }
    }
  }
  return { sawToolCall, lastToolName, sawReflect, turnText: texts.join('\n').slice(-2000) }
}

/**
 * 统计当前 turn（最后一个 turn/start 之后）内「连续非 memory_ 工具 step」的最大段长。
 * 每个 tool-call 计 1 step（同一 assistant/message 内的并行调用逐个计数）；
 * memory_ 工具调用中断连续段（已主动记忆，不再反思）。用户拍板：一次任务
 * 连续 react ≥7 个工具 step 才在任务结束时触发反思。
 */
export function consecutiveToolSteps(events: readonly unknown[]): number {
  let startIdx = 0
  for (let i = events.length - 1; i >= 0; i--) {
    if ((events[i] as { type?: string }).type === 'turn/start') {
      startIdx = i
      break
    }
  }
  let best = 0
  let cur = 0
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i] as {
      type?: string
      data?: { message?: { content?: Array<{ type?: string; name?: string }> } }
    }
    if (e?.type !== 'assistant/message') continue
    for (const b of e.data?.message?.content ?? []) {
      if (b.type !== 'tool-call' || typeof b.name !== 'string') continue
      if (b.name.startsWith('memory_')) cur = 0
      else {
        cur++
        if (cur > best) best = cur
      }
    }
  }
  return best
}

export function buildReflectMessage(workspace: string, turnText: string, dir = '.dsh-meow'): ReturnType<typeof createUserMessage> {
  const db = getDb(workspace, dir)
  // 文案外置（v0.19.0）：prompts/zh/reflect.md，{projectList} 占位符填充；改文件下一次反思即生效。
  const prompt = resolveSlotText('reflect', { projectList: projectNamesText(db.listProjectNames()) })
  const text = `${REFLECT_MARKER} ${prompt}`
  return createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE })
}

/** project 清单展示（原 buildBasePrompt 逻辑：空清单显示占位说明）。 */
function projectNamesText(projectNames: string[]): string {
  return projectNames.length > 0 ? projectNames.join(' / ') : keyedValue('labels', 'reflect.noProjects')
}

export { PLUGIN_SOURCE }
