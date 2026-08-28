/**
 * meow-memory — prompt 文案加载器（v0.19.0：prompt 文案外置为数据文件）。
 *
 * 目标（用户拍板 2026-08-27）：
 * - prompt 文案 = 数据而非代码：所有注入给模型的文案存 prompts/<lang>/*.md，
 *   代码运行时读取。用户改文案 = 改文件（无需改代码/重新构建），下一次构建 prompt 时生效。
 * - 语言包 = 一个子目录：promptLang config 选择子目录（本步固定 zh，config 后续版本接线）；
 *   社区语言包（如 en）= 新增一个子目录，不需要动任何代码。
 * - fallback：内置 <lang> → 内置 zh（最终兜底）。工作区覆盖层后续版本接入。
 *
 * 文件格式（prompts/zh/）：
 * - 整段槽位（system-guide.md / reflect.md / dream-*.md）：UTF-8 纯文本，
 *   {name} 占位符由 fillTemplate 填充。
 * - 键值槽位（labels.md / tools.md）：`- key: value` 行（首个半角 ": " 为分隔符，
 *   value 原样保留），后续以两格缩进开头的行为续行（与上一值以 \n 连接）；
 *   tools.md 用 `### 工具名` 标题分块（解析时忽略，仅供阅读）。
 *
 * esbuild 单文件 bundle：本模块被内联进 lib/index.js，import.meta.url 指向
 * lib/index.js → dirname 即 lib/；prompts/ 由 build.mjs 从 src/prompts 拷贝到 lib/prompts。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 内置语言包根目录（<包>/lib/prompts）。 */
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'prompts')

/** 实例覆盖层根目录（<home>/.dsh-meow/prompts/<lang>/<slot>.md）。prompt 语言与
 *  自定义文案是实例级偏好（记忆库才是 per-workspace），与 perf.log 等实例级文件
 *  同目录惯例；逐槽位可选——只放想改的文件，缺失自动落回内置语言包。 */
const OVERRIDE_DIR = join(homedir(), '.dsh-meow', 'prompts')

/** 默认语言（最终兜底语言包目录名）。 */
export const DEFAULT_LANG = 'zh'

/** 进程级 prompt 语言（实例常量：一个 dsh 实例一个值，不随会话/agent 变化）。
 *  apply() 入口 setPromptLang(resolved.promptLang) 设一次；bm25 分词与全部文案
 *  读取经 getPromptLang() 动态取用——切换语言后下一次检索/注入即生效。 */
let currentLang = DEFAULT_LANG

/** 设置 prompt 语言（apply 入口调用一次；测试可显式设置并还原）。 */
export function setPromptLang(lang: string): void {
  currentLang = lang
}

/** 当前 prompt 语言。 */
export function getPromptLang(): string {
  return currentLang
}

/** 全部槽位名（搬运契约：新增文案槽位须同步此清单 + prompts/zh/ 文件 + build.mjs 拷贝）。 */
export const SLOTS = [
  'system-guide',
  'reflect',
  'dream-header',
  'dream-atomic',
  'dream-topic',
  'dream-project-summary',
  'welcome-guide',
  'labels',
  'tools',
] as const

export type SlotName = (typeof SLOTS)[number]

/** 整段槽位的必需占位符（labels/tools 为键值格式，无槽位级占位符）。 */
export const SLOT_PARAMS: Partial<Record<SlotName, readonly string[]>> = {
  reflect: ['projectList'],
  'dream-header': ['timestamp', 'idx', 'total', 'roundKind'],
  'dream-topic': ['list'],
  'dream-project-summary': ['projects'],
  'welcome-guide': ['homePath'],
}

/** 读槽位原始文本，逐槽位 fallback：①实例覆盖层（homedir/.dsh-meow/prompts/<lang>/，
 *  用户自定义、可只覆盖部分槽位）→ ②内置语言包 <lang> → ③内置 zh 兜底。
 *  文件在③仍缺失直接 throw（部署完整性由 build.mjs 拷贝保证）。
 *  末尾空白剥离：md 文件惯例以换行结尾，而原代码常量末尾无换行——剥离后与外置前逐字节等价。 */
function readSlotFile(slot: SlotName, lang: string): string {
  const read = (p: string): string => readFileSync(p, 'utf8').replace(/\s+$/, '')
  const override = join(OVERRIDE_DIR, lang, `${slot}.md`)
  if (existsSync(override)) return read(override)
  if (lang !== DEFAULT_LANG) {
    const primary = join(PROMPTS_DIR, lang, `${slot}.md`)
    if (existsSync(primary)) return read(primary)
  }
  return read(join(PROMPTS_DIR, DEFAULT_LANG, `${slot}.md`))
}

/** 占位符填充：replaceAll 传函数形式——替换串含 $&/$1 等序列时不被特殊解释（记忆正文可能带 $）。 */
export function fillTemplate(text: string, params: Readonly<Record<string, string>> = {}): string {
  let out = text
  for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, () => v)
  return out
}

/** 解析键值行格式（labels.md / tools.md）→ key → value（保持文件顺序）。 */
export function parseKeyValueText(text: string): Map<string, string> {
  const map = new Map<string, string>()
  let cur: string | null = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '') // 行尾空白剥离（编辑器卫生），行首原样
    if (line.startsWith('- ')) {
      const sep = line.indexOf(': ')
      if (sep > 2) {
        cur = line.slice(2, sep)
        map.set(cur, line.slice(sep + 2))
        continue
      }
    }
    if (cur !== null && line.startsWith('  ') && line.trim().length > 0) {
      map.set(cur, `${map.get(cur)}\n${line.trimStart()}`) // 续行
    }
  }
  return map
}

/** 取整段槽位（占位符已填充）。不缓存：改 md 文件下一次构建 prompt 即生效。
 *  lang 缺省 = 当前进程语言（setPromptLang 设定），调用方无需透传 config。 */
export function resolveSlotText(slot: SlotName, params: Readonly<Record<string, string>> = {}, lang: string = getPromptLang()): string {
  const required = SLOT_PARAMS[slot] ?? []
  for (const p of required) {
    if (!(p in params)) throw new Error(`[meow-memory] 槽位 ${slot} 缺少必需占位符 {${p}}`)
  }
  return fillTemplate(readSlotFile(slot, lang), params)
}

/** 取键值文案单个值（labels.md / tools.md）。缺键 throw——静默回退会产出错误文案，宁可暴露。 */
export function keyedValue(slot: 'labels' | 'tools', key: string, lang: string = getPromptLang()): string {
  const v = resolveKeyedText(slot, lang).get(key)
  if (v === undefined) throw new Error(`[meow-memory] prompt 文案缺失：${slot}.md 的 "${key}"`)
  return v
}

/** 取整个键值槽位。 */
export function resolveKeyedText(slot: 'labels' | 'tools', lang: string = getPromptLang()): Map<string, string> {
  return parseKeyValueText(readSlotFile(slot, lang))
}
