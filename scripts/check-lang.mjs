#!/usr/bin/env node
/**
 * meow-memory 语言包自查（贡献者工具，v0.19.0）。
 *
 * 用法：npm run check-lang -- <lang>   （如 `npm run check-lang -- en`）
 *
 * 以 src/prompts/zh/ 为 key-set 真源，检查 <lang> 语言包：
 *   1. 槽位齐全：zh 的每个槽位文件都存在，且没有 zh 之外的未知文件
 *   2. 整段槽位：{placeholder} 集合与 zh 完全一致（缺失=数据丢失；多余=不会被填充）
 *   3. 键值槽位（labels.md / tools.md）：键集合与 zh 一致；每个键的值内占位符一致
 *
 * 全绿 exit 0；任何问题列出清单并 exit 1。PR 前请跑到全绿。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'prompts')
const lang = process.argv[2]
if (!lang || !/^[a-z][a-z0-9-]*$/.test(lang)) {
  console.error('用法：node scripts/check-lang.mjs <lang>   （<lang> = 小写 kebab-case，如 en / ja）')
  process.exit(1)
}
if (lang === 'zh') {
  console.log('✅ zh 是 key-set 真源，无需自查。')
  process.exit(0)
}

const ZH = join(SRC, 'zh')
const TARGET = join(SRC, lang)
if (!existsSync(TARGET)) {
  console.error(`❌ src/prompts/${lang}/ 不存在——从 zh/ 复制一份再翻译：cp -r src/prompts/zh src/prompts/${lang}`)
  process.exit(1)
}

const placeholders = (text) => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((m) => m[1])
const uniq = (a) => [...new Set(a)]
const keysOf = (text) => uniq([...text.matchAll(/^- ([a-zA-Z0-9_.]+): /gm)].map((m) => m[1]))
const kvOf = (text) => {
  const m = new Map()
  for (const match of text.matchAll(/^- ([a-zA-Z0-9_.]+): (.*)$/gm)) m.set(match[1], match[2])
  return m
}

const problems = []
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

if (problems.length === 0) {
  console.log(`✅ 语言包 "${lang}" 检查通过：${zhSlots.length} 个槽位与 zh 键集完全对齐。`)
  process.exit(0)
}
console.error(`❌ 语言包 "${lang}" 有 ${problems.length} 个问题：`)
for (const p of problems) console.error(`  - ${p}`)
process.exit(1)
