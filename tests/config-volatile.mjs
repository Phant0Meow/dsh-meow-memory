/**
 * Config volatile 标记契约测试（2026-09-24「设置页仅本机回环可编辑」排查的锁死件）。
 *
 * dsh 0.1.7 设置服务 describe() 只收录 volatileForm(Config) 非空的插件——即 Config
 * 根上必须带 meta.volatile，否则整个插件不进命名空间名单，设置页永远显示
 * 「当前连接不支持设置写入（仅本机回环连接可编辑）」（文案误导，与连接无关）。
 *
 * 同时锁死运行时安全假设：仓内 schemastery@3.18.1 的解析不含 volatile 逻辑，
 * meta 只是宿主侧标记——~standard.validate 必须返回裸值（官方新版 .volatile()
 * 会把值包成 createVolatile 的 .get() 引用，消费端就得逐处改读法）。
 * 若日后升级 schemastery 使本测试第 2 组断言失败，须重验全部 config 消费点。
 *
 * 运行：node tests/config-volatile.mjs
 */
import esbuild from 'esbuild'
import { rmSync, writeFileSync } from 'node:fs'

const ENTRY = 'tests/_config-volatile-entry.ts'
const OUT = 'tests/_config-volatile-bundle.mjs'
writeFileSync(ENTRY, "export { Config } from '../src/index.ts'\n")

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

try {
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: OUT,
    logLevel: 'silent',
  })
  const { Config } = await import('./_config-volatile-bundle.mjs')

  check('Config 根带 meta.volatile（0.1.7 describe 收录的必要条件）', Config?.meta?.volatile === true)
  check('Config 仍是 object 形状', Config?.type === 'object', `type=${Config?.type}`)

  const probe = { enabled: false, hitTopK: 5, projectDir: '.dsh-meow-probe' }
  const result = Config['~standard'].validate(probe)
  const value = result.value
  check('~standard.validate 无 issues', !result.issues)
  check('解析值是裸值非 Volatile 包装（enabled 直接是 boolean）', typeof value?.enabled === 'boolean', `typeof=${typeof value?.enabled}`)
  check('解析值不是冻结的 get() 引用（根对象无 get 协议）', typeof value?.get !== 'function')
  check('默认值照常补全（titleMax=40）', value?.titleMax === 40, `titleMax=${value?.titleMax}`)
  check('传入值照常透传（hitTopK=5）', value?.hitTopK === 5, `hitTopK=${value?.hitTopK}`)

  // homeDirPresets 只读 meta 必须住进 schema 默认值：0.1.7 的 base 视图=宿主拿
  // Config schema 深填，不在 schema 里的键宿主永远剥掉（patch 通道已随写入死锁
  // 退役）——声明缺席=设置页 radio 旁的三个预设实际路径消失。
  const empty = Config['~standard'].validate({})
  check('空输入无 issues（base 视图=resolveConfig({}) 的同款路径）', !empty.issues, JSON.stringify(empty.issues ?? []))
  check('空输入深填 enabled=true', empty.value?.enabled === true, `enabled=${String(empty.value?.enabled)}`)
  check(
    'homeDirPresets 深填且含三预设',
    typeof empty.value?.homeDirPresets?.default === 'string'
      && typeof empty.value?.homeDirPresets?.['dsh-storage'] === 'string'
      && typeof empty.value?.homeDirPresets?.['plugin-root'] === 'string',
    `homeDirPresets=${JSON.stringify(empty.value?.homeDirPresets)}`,
  )
  check(
    '传入对象不被污染（homeDirPresets 只进解析值不回写输入）',
    !Object.hasOwn(probe, 'homeDirPresets'),
    JSON.stringify(Object.keys(probe)),
  )
} catch (error) {
  failed++
  console.log(`  FAIL  测试装挂失败 — ${error instanceof Error ? error.message : error}`)
} finally {
  rmSync(ENTRY, { force: true })
  rmSync(OUT, { force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
