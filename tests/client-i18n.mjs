/**
 * client-i18n 测试：界面文案层（字典完整性 + 语言解析 + DSH locale 服务接线 +
 * foldLabel / participationLabel / delegateNoticeLabelFor / formatInjectionClock 的多语言输出）。
 *
 * 运行：node tests/client-i18n.mjs（内部 esbuild 现场打包源码，保证与 src 同步）。
 */
import { build } from 'esbuild'

/**
 * 现场打包一个源文件为 ESM，返回其模块命名空间。
 *
 * 每次调用都用唯一的 query 后缀——否则 import(dataURL) 会命中模块缓存，多次
 * bundleSrc('src/i18n/index.ts') 共享同一实例的模块级状态（语言注册表 / 订阅表），
 * 用例之间互相污染。查询串让每个用例拿到独立实例，与「一份 bundle 一个实例」一致。
 */
let bundleSeq = 0
async function bundleSrc(entry) {
  const { outputFiles } = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  })
  const code = new TextDecoder().decode(outputFiles[0].contents)
  bundleSeq++
  const modUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${bundleSeq}`
  return import(modUrl)
}

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name} ${detail}`)
  }
}

// ── 1. 字典完整性（keys.ts 是真源，三份字典必须逐键覆盖） ────────────────────
console.log('=== 1. 字典完整性 ===')
const i18n = await bundleSrc('src/i18n/index.ts')
const { UI_KEYS, missingKeys, extraKeys, en, zh, ptBr, t, setUiLocaleForTest, getUiLocale, installI18n, onUiLocaleChange, NS, SUPPORTED_UI_LOCALES } = i18n

check('en 无缺键', missingKeys(en).length === 0, JSON.stringify(missingKeys(en).slice(0, 5)))
check('zh 无缺键', missingKeys(zh).length === 0, JSON.stringify(missingKeys(zh).slice(0, 5)))
check('ptBr 无缺键', missingKeys(ptBr).length === 0, JSON.stringify(missingKeys(ptBr).slice(0, 5)))
check('en 无多余键', extraKeys(en).length === 0, JSON.stringify(extraKeys(en)))
check('zh 无多余键', extraKeys(zh).length === 0, JSON.stringify(extraKeys(zh)))
check('pt-br 无多余键', extraKeys(ptBr).length === 0, JSON.stringify(extraKeys(ptBr)))

// 占位符一致：模板里出现的 {name} 在三份字典里必须相同（否则运行时漏填）。
const paramsOf = (text) => [...new Set([...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]))].sort().join(',')
let placeholderMismatch = []
for (const key of UI_KEYS) {
  const a = paramsOf(en[key])
  const b = paramsOf(zh[key])
  const c = paramsOf(ptBr[key])
  if (a !== b || a !== c) placeholderMismatch.push(`${key}: en[${a}] zh[${b}] pt-br[${c}]`)
}
check('三语占位符集合一致', placeholderMismatch.length === 0, placeholderMismatch.slice(0, 5).join(' | '))

check('语言目录含 zh/en/pt-br', SUPPORTED_UI_LOCALES.map((l) => l.id).join(',') === 'zh,en,pt-br')
check('命名空间 = meow-memory', NS === 'meow-memory')

// ── 2. 无 DSH 服务时的静态查表（降级路径） ───────────────────────────────────
console.log('=== 2. 静态查表（老宿主降级） ===')
setUiLocaleForTest('zh')
check('zh 取中文', t('part.menu') === '记忆参与')
check('zh 占位符填充', t('fold.status.remembered', { title: '记忆反思', n: 3 }) === '记忆反思 · 新增记忆 3 条')
setUiLocaleForTest('en')
check('en 取英文', t('part.menu') === 'Memory participation')
check('en 占位符填充', t('fold.status.remembered', { title: 'Memory reflection', n: 3 }) === 'Memory reflection · 3 memories added')
check('en 日期模板', t('datetime.ymd', { m: 1, d: 2 }) === '1/2')
setUiLocaleForTest('pt-br')
check('pt-br 取葡语', t('part.menu') === 'Participação de memória')
check('pt-br 占位符填充', t('fold.status.remembered', { title: 'Reflexão de memória', n: 2 }) === 'Reflexão de memória · 2 memórias adicionadas')
check('pt-br 日期模板（日在前）', t('datetime.ymd', { m: 9, d: 16 }) === '16/9')
// 未登记的语言（服务给了我们没见过的标签）→ 主标签，仍不匹配落 en。
setUiLocaleForTest('ja')
check('未登记语言落 en', t('part.menu') === 'Memory participation')
setUiLocaleForTest('zh')

// ── 3. 语言变化订阅（设置页 / DOM 重放的接点） ────────────────────────────────
console.log('=== 3. 语言变化订阅 ===')
const seen = []
const unsubscribe = onUiLocaleChange((locale) => seen.push(locale))
check('订阅时立即回调当前值', seen.length === 1 && seen[0] === 'zh', JSON.stringify(seen))
setUiLocaleForTest('pt-br')
check('语言变化回调新语言', seen.length === 2 && seen[1] === 'pt-br', JSON.stringify(seen))
unsubscribe()
setUiLocaleForTest('en')
check('退订后不再回调', seen.length === 2, JSON.stringify(seen))

// ── 4. DSH locale 服务接线（跟随宿主语言设置） ───────────────────────────────
console.log('=== 4. DSH locale 服务接线 ===')
/** 最小 DSH locale 服务替身：注册表 + fallback 链，语义对齐 LocaleRuntime。 */
function makeFakeService() {
  const dicts = new Map() // ns -> Map(locale -> dict)
  const catalog = new Map([['zh', { id: 'zh', label: '中文' }], ['en', { id: 'en', label: 'English' }]])
  const fallback = new Map([['zh', 'en']])
  const state = { active: 'en', revision: 1 }
  const listeners = new Set()
  const calls = { addLanguage: [], register: [] }
  const chainOf = (locale) => {
    const out = []
    for (let cur = locale; cur !== undefined; cur = fallback.get(cur)) out.push(cur)
    return out
  }
  return {
    calls,
    state,
    getLocale: () => ({ active: state.active, locales: [...catalog.values()], revision: state.revision }),
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setLocale: (id) => {
      state.active = id
      state.revision++
      for (const fn of [...listeners]) fn()
    },
    addLanguage: (input) => {
      calls.addLanguage.push({ ...input })
      catalog.set(input.id, { id: input.id, label: input.label })
      fallback.set(input.id, input.fallback)
      return () => catalog.delete(input.id)
    },
    register: (ns, locale, dict) => {
      calls.register.push({ ns, locale, keys: Object.keys(dict).length })
      if (!dicts.has(ns)) dicts.set(ns, new Map())
      dicts.get(ns).set(locale, dict)
      state.revision++
      return () => dicts.get(ns).delete(locale)
    },
    /** 测试用：把某语言的字典换薄（模拟翻译未完成），验证 fallback 链。 */
    thinDict: (ns, locale, dict) => {
      dicts.get(ns).set(locale, dict)
    },
    bind: (ns) => (key, params) => {
      const byLocale = dicts.get(ns)
      let template
      for (const locale of chainOf(state.active)) {
        const hit = byLocale?.get(locale)?.[key]
        if (hit !== undefined) {
          template = hit
          break
        }
      }
      if (template === undefined) return key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
    },
  }
}

const service = makeFakeService()
const warnings = []
const installed = installI18n({ get: (name) => (name === 'locale' ? service : undefined) }, (m) => warnings.push(m))
check('注册语言目录（pt-br，fallback=en）', service.calls.addLanguage.length === 1 && service.calls.addLanguage[0].id === 'pt-br' && service.calls.addLanguage[0].fallback === 'en', JSON.stringify(service.calls.addLanguage))
check('注册三语字典', service.calls.register.length === 3 && service.calls.register.every((c) => c.ns === 'meow-memory'), JSON.stringify(service.calls.register))
check('返回已注册语言列表', installed.join(',') === 'zh,en,pt-br', installed.join(','))
check('无告警', warnings.length === 0, warnings.join(' | '))
check('active 跟随服务（en）', getUiLocale() === 'en')
check('服务语言取英文', t('part.menu') === 'Memory participation')

service.setLocale('pt-br')
check('切到 pt-br 后取葡语', t('part.menu') === 'Participação de memória')
check('切语言触发订阅（UI 重放）', getUiLocale() === 'pt-br')

// 缺键时走服务自己的 fallback 链（pt-br → en）：安装后把某语言的字典换薄，验证
// 查表确实经过服务，而不是落到我们的静态字典（静态字典永远是全量，掩盖缺失）。
const thinService = makeFakeService()
const thin = await bundleSrc('src/i18n/index.ts')
thin.installI18n({ get: () => thinService })
thinService.setLocale('pt-br')
thinService.thinDict('meow-memory', 'pt-br', { 'part.menu': 'SÓ PT-BR' })
check('服务字典有键时取服务值', thin.t('part.menu') === 'SÓ PT-BR')
thinService.thinDict('meow-memory', 'pt-br', {})
check('服务字典缺键落 en（fallback 链）', thin.t('part.menu') === 'Memory participation')

// 重复 install 幂等：不再重复 addLanguage/register。
const before = { add: service.calls.addLanguage.length, reg: service.calls.register.length }
installI18n({ get: () => service })
check('重复 install 不重复注册语言', service.calls.addLanguage.length === before.add)
check('重复 install 不重复注册字典', service.calls.register.length === before.reg)
check('重复 install 不告警', warnings.length === 0, warnings.join(' | '))

// 无 locale 服务（老宿主 / 受限动态 ctx）：不抛错，退化到静态查表。
const legacyWarnings = []
const legacy = await bundleSrc('src/i18n/index.ts')
const legacyInstalled = legacy.installI18n({ get: () => undefined }, (m) => legacyWarnings.push(m))
check('无服务不抛错且返回空列表', Array.isArray(legacyInstalled) && legacyInstalled.length === 0)
check('无服务无告警', legacyWarnings.length === 0, legacyWarnings.join(' | '))
legacy.setUiLocaleForTest('pt-br')
check('无服务仍能取葡语（静态查表）', legacy.t('part.menu') === 'Participação de memória')

// 服务 addLanguage 抛错（语言已被别的包占用）：只告警，字典照常注册。
const brokenService = makeFakeService()
brokenService.addLanguage = () => {
  throw new Error('locale id "pt-br" is occupied')
}
const brokenWarnings = []
const broken = await bundleSrc('src/i18n/index.ts')
const brokenRet = broken.installI18n({ get: () => brokenService }, (m) => brokenWarnings.push(m))
check('语言占用只告警', brokenWarnings.length === 1 && brokenWarnings[0].includes('pt-br'), JSON.stringify(brokenWarnings))
check('语言占用仍注册字典', brokenService.calls.register.length === 3, JSON.stringify(brokenService.calls.register.map((c) => c.locale)))

// ── 5. 各模块的多语言输出 ───────────────────────────────────────────────────
console.log('=== 5. 模块文案（foldLabel / participationLabel / notice / clock） ===')
const fold = await bundleSrc('src/client-fold.ts')
const skip = await bundleSrc('src/client-dream-skip.ts')
const notice = await bundleSrc('src/client-delegate-notice.ts')
const base = { id: 'g', variant: 'reflect', keys: [], rememberCount: 0, updateCount: 0, status: 'done' }

fold.setUiLocaleForTest('zh')
check('zh foldLabel 新增', fold.foldLabel({ ...base, rememberCount: 3 }, false) === '▸ 记忆反思 · 新增记忆 3 条')
fold.setUiLocaleForTest('en')
check('en foldLabel 新增', fold.foldLabel({ ...base, rememberCount: 3 }, false) === '▸ Memory reflection · 3 memories added')
check('en foldLabel dream running', fold.foldLabel({ ...base, variant: 'dream', status: 'running' }, true) === '▾ Memory dream task in progress… (your message joins this turn)')
check('en foldLabel 无需记忆', fold.foldLabel(base, false) === '▸ Memory reflection · nothing to save')
fold.setUiLocaleForTest('pt-br')
check('pt-br foldLabel 新增', fold.foldLabel({ ...base, rememberCount: 3 }, false) === '▸ Reflexão de memória · 3 memórias adicionadas')
check('pt-br foldLabel 已更新', fold.foldLabel({ ...base, updateCount: 2 }, false) === '▸ Reflexão de memória · 2 atualizadas')

const now = new Date(2026, 8, 16, 12, 0).getTime()
const earlier = new Date(2026, 0, 2, 8, 30).getTime()
const crossYear = new Date(2025, 11, 31, 23, 59).getTime()
fold.setUiLocaleForTest('zh')
check('zh 时钟 今年', fold.formatInjectionClock(earlier, now) === '1月2日 08:30')
fold.setUiLocaleForTest('en')
check('en 时钟 今年', fold.formatInjectionClock(earlier, now) === '1/2 08:30')
check('en 时钟 跨年', fold.formatInjectionClock(crossYear, now) === '2025/12/31 23:59')
fold.setUiLocaleForTest('pt-br')
check('pt-br 时钟 今年', fold.formatInjectionClock(earlier, now) === '2/1 08:30')
check('pt-br 时钟 跨年', fold.formatInjectionClock(crossYear, now) === '31/12/2025 23:59')

skip.setUiLocaleForTest('zh')
check('zh 菜单文案（参与态无后缀 / 退出态带后缀）', skip.participationLabel({ dream: false, inject: false, write: false }) === '记忆参与' && skip.participationLabel({ dream: true, inject: true, write: true }) === '记忆参与 · 已退出')
skip.setUiLocaleForTest('en')
check('en 菜单文案（只读态带后缀）', skip.participationLabel({ dream: false, inject: true, write: false }) === 'Memory participation · Do not disturb')
skip.setUiLocaleForTest('pt-br')
check('pt-br 菜单文案（参与态）', skip.participationLabel({ dream: false, inject: false, write: false }) === 'Participação de memória')

notice.setUiLocaleForTest('zh')
check('zh 气泡文案', notice.delegateNoticeLabelFor('dream', false) === '▸ 梦境记忆整理任务已完成。')
notice.setUiLocaleForTest('en')
check('en 气泡文案', notice.delegateNoticeLabelFor('dream', true) === '▸ Memory dream task in progress…')
check('en 气泡中断', notice.delegateNoticeLabelFor('dream', true, true) === '▸ Memory dream task interrupted; retrying automatically later.')
check('en reflect-done 恒已完成', notice.delegateNoticeLabelFor('reflect-done', true) === '▸ Memory reflection task completed.')
notice.setUiLocaleForTest('pt-br')
check('pt-br 气泡文案', notice.delegateNoticeLabelFor('reflect', true) === '▸ Tarefa de reflexão de memória em andamento…')

// ── 6. 纯 DOM 节点的语言重放注册表 ──────────────────────────────────────────
console.log('=== 6. UI 语言重放注册表 ===')
const replay = await bundleSrc('src/client-i18n-replay.ts')
let replayed = 0
const unregister = replay.registerUiReplayer(() => { replayed++ })
replay.setUiLocaleForTest('en')
check('语言变化触发重放', replayed === 1, String(replayed))
unregister()
replay.setUiLocaleForTest('pt-br')
check('退订后不再重放', replayed === 1, String(replayed))
// 单个重放函数抛错不影响其它订阅者。
const replay2 = await bundleSrc('src/client-i18n-replay.ts')
let second = 0
replay2.registerUiReplayer(() => { throw new Error('boom') })
replay2.registerUiReplayer(() => { second++ })
replay2.setUiLocaleForTest('en')
check('单个重放失败不阻断其它', second === 1, String(second))

// ── 7. locale 服务晚到重试（issue #32/#33：冷启动卡英文修复） ─────────────────
console.log('=== 7. locale 服务晚到重试 ===')
{
  // 冷启动时序：installI18n 首探失败走回退 → 服务晚到 → 有界轮询重入补注册 + 语言跟随
  const inst = await bundleSrc('src/i18n/index.ts')
  inst.setLocaleRetryForTest(5, 30)
  const registered = []
  let svcRef
  const svc = {
    getLocale: () => ({ active: 'en', locales: [] }),
    subscribe: () => () => {},
    setLocale: () => {},
    addLanguage: () => () => {},
    register: (ns, locale) => { registered.push(locale) },
    bind: () => (key) => key,
  }
  const ctx = { get: (name) => (name === 'locale' ? svcRef : undefined) }
  inst.installI18n(ctx, () => {})
  check('晚到：首探失败走回退（browserLocale/zh）', typeof inst.getUiLocale() === 'string')
  svcRef = svc
  await new Promise((r) => setTimeout(r, 60))
  check('晚到：服务就绪后轮询重入完成三语注册', registered.length === SUPPORTED_UI_LOCALES.length, String(registered.length))
  check('晚到：UI 语言跟随服务 active', inst.getUiLocale() === 'en')
}
{
  // 轮询上限：服务始终缺席 → 封顶放弃，之后服务再出现也不再注册（定时器有界自灭）
  const inst = await bundleSrc('src/i18n/index.ts')
  inst.setLocaleRetryForTest(5, 3)
  let svcRef
  const registered = []
  const ctx = { get: (name) => (name === 'locale' ? svcRef : undefined) }
  inst.installI18n(ctx, () => {})
  await new Promise((r) => setTimeout(r, 60)) // 3 次 × 5ms 早已封顶
  svcRef = {
    getLocale: () => ({ active: 'en', locales: [] }),
    subscribe: () => () => {},
    setLocale: () => {},
    addLanguage: () => () => {},
    register: (ns, locale) => { registered.push(locale) },
    bind: () => (key) => key,
  }
  await new Promise((r) => setTimeout(r, 60))
  check('晚到：达上限后放弃（迟到服务不再注册）', registered.length === 0, String(registered.length))
}
{
  // 老宿主（ctx 连 get 都没有）→ v0.28.0 决策的永久回退场景：不轮询、不炸
  const inst = await bundleSrc('src/i18n/index.ts')
  inst.setLocaleRetryForTest(5, 5)
  inst.installI18n({}, () => {})
  check('老宿主：无 get 能力走静态查表回退', inst.getUiLocale() === 'zh')
  await new Promise((r) => setTimeout(r, 40))
  check('老宿主：不轮询不炸', inst.getUiLocale() === 'zh')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
