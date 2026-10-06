#!/usr/bin/env node
/**
 * meow-memory 语言包自查（贡献者工具，v0.19.0）。
 *
 * 用法：
 *   npm run check-lang              ← 检查 src/prompts/ 下所有已 ship 的语言包（en / pt-br / ...）
 *   npm run check-lang -- <lang>    ← 只检查一门语言，如 `npm run check-lang -- en`
 *
 * 以 src/prompts/zh/ 为 key-set 真源，检查 <lang> 语言包：
 *   1. 槽位齐全：zh 的每个槽位文件都存在，且没有 zh 之外的未知文件
 *   2. 整段槽位：{placeholder} 集合与 zh 完全一致（缺失=数据丢失；多余=不会被填充）
 *   3. 键值槽位（labels.md / tools.md）：键集合与 zh 一致；每个键的值内占位符一致
 *
 * 无参数模式 = 全部语言包，且 `npm test` 会调用它——上游加键/加工具时，
 * 漏翻译的语言包在这一步就红（历史教训：v0.29.0 的 memory_home 只补了 zh/en，
 * pt-br 漏键，pt-br 实例直接起不来）。
 *
 * 全绿 exit 0；任何问题列出清单并 exit 1。PR 前请跑到全绿。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'prompts')
const ZH = join(SRC, 'zh')

const placeholders = (text) => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((m) => m[1])
const uniq = (a) => [...new Set(a)]
const keysOf = (text) => uniq([...text.matchAll(/^- ([a-zA-Z0-9_.]+): /gm)].map((m) => m[1]))
const kvOf = (text) => {
  const m = new Map()
  for (const match of text.matchAll(/^- ([a-zA-Z0-9_.]+): (.*)$/gm)) m.set(match[1], match[2])
  return m
}

/** 检查一门语言包，返回问题清单（空数组 = 全绿）。 */
function checkLang(lang) {
  const problems = []
  const TARGET = join(SRC, lang)
  if (!existsSync(TARGET)) {
    return [`src/prompts/${lang}/ 不存在——从 zh/ 复制一份再翻译：cp -r src/prompts/zh src/prompts/${lang}`]
  }
  const zhSlots = readdirSync(ZH).filter((f) => f.endsWith('.md'))
  for (const f of zhSlots) {
    const target = join(TARGET, f)
    if (!existsSync(target)) {
      problems.push(`missing: ${f} 不存在`)
      continue
    }
    const zhText = readFileSync(join(ZH, f), 'utf8')
    const tText = readFileSync(target, 'utf8')
    if (f === 'labels.md' || f === 'tools.md') {
      const zhKeys = keysOf(zhText)
      const tKeys = keysOf(tText)
      for (const k of zhKeys) if (!tKeys.includes(k)) problems.push(`[${f}] 缺键 ${k}`)
      for (const k of tKeys) if (!zhKeys.includes(k)) problems.push(`[${f}] 多余键 ${k}（zh 真源中不存在，代码不会读取）`)
      const zhKv = kvOf(zhText)
      const tKv = kvOf(tText)
      for (const k of zhKeys) {
        if (!tKv.has(k)) continue
        const zp = uniq(placeholders(zhKv.get(k) ?? ''))
        const tp = uniq(placeholders(tKv.get(k) ?? ''))
        for (const p of zp) if (!tp.includes(p)) problems.push(`[${f}] ${k} 缺占位符 {${p}}（运行时数据会丢失）`)
        for (const p of tp) if (!zp.includes(p)) problems.push(`[${f}] ${k} 多余占位符 {${p}}（不会被填充，将原样漏进 prompt）`)
      }
    } else {
      const zp = uniq(placeholders(zhText))
      const tp = uniq(placeholders(tText))
      for (const p of zp) if (!tp.includes(p)) problems.push(`[${f}] 缺占位符 {${p}}（运行时数据会丢失）`)
      for (const p of tp) if (!zp.includes(p)) problems.push(`[${f}] 多余占位符 {${p}}（不会被填充，将原样漏进 prompt）`)
    }
  }
  for (const f of readdirSync(TARGET).filter((x) => x.endsWith('.md'))) {
    if (!zhSlots.includes(f)) problems.push(`extra: ${f} 不是 zh 真源中的槽位（代码不读取）`)
  }
  return problems
}

const arg = process.argv[2]
let langs
if (arg) {
  if (!/^[a-z][a-z0-9-]*$/.test(arg)) {
    console.error('用法：node scripts/check-lang.mjs [lang]   （lang 省略 = 检查全部语言包；lang = 小写 kebab-case，如 en / pt-br）')
    process.exit(1)
  }
  if (arg === 'zh') {
    console.log('✅ zh 是 key-set 真源，无需自查。')
    process.exit(0)
  }
  langs = [arg]
} else {
  langs = readdirSync(SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'zh')
    .map((d) => d.name)
    .sort()
  if (langs.length === 0) {
    console.log('✅ 除 zh 真源外没有其他语言包，无需自查。')
    process.exit(0)
  }
}

let failed = 0
for (const lang of langs) {
  const problems = checkLang(lang)
  const slots = readdirSync(ZH).filter((f) => f.endsWith('.md')).length
  if (problems.length === 0) {
    console.log(`✅ 语言包 "${lang}" 检查通过：${slots} 个槽位与 zh 键集完全对齐。`)
    continue
  }
  failed++
  console.error(`❌ 语言包 "${lang}" 有 ${problems.length} 个问题：`)
  for (const p of problems) console.error(`  - ${p}`)
}
process.exit(failed === 0 ? 0 : 1)
