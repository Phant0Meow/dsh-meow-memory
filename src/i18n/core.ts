/**
 * meow-memory — i18n 核心（client 端 UI/UX 文案，v0.27.0）。
 *
 * 设计（用户拍板 2026-09-16：UI 跟随 DSH 语言设置）：
 * - **跟随 DSH**：DSH 0.1.5+ 的 locale 服务（@deepseek-ai/dsh-client-locale）是
 *   UI 语言的唯一真源——用户在「设置 → 通用 → 语言」里选的 zh / en / pt-br
 *   立即切换本插件的界面文案。我们注册自己的语言与字典：
 *     ctx.locale.addLanguage({ id: 'pt-br', label: 'Português (Brasil)', fallback: 'en' })
 *     ctx.locale.register(NS, 'zh'|'en'|'pt-br', 字典)
 *   查表走 DSH 的 fallback 链（pt-br → en）——漏翻的键自动落到英文，绝不出现空串。
 * - **降级路径**：老 DSH（无 locale 服务）或服务异常时，用 navigator.languages
 *   自己判定（zh → en → pt-br），都没有则沿用 zh（插件的历史默认语言，行为与
 *   外置前逐字一致）。动态包（cordis-client-runner 的受限 ctx）可能拿不到
 *   ctx.locale，所以一律 ctx.get('locale') 探测，绝不写进 inject（写进去会让
 *   插件在无 locale 的宿主上整体挂起）。
 * - **追加语言**：新增语言 = 加一个字典文件 + SUPPORTED_UI_LOCALES 一行，
 *   core 自动注册，UI 无需改动（这就是「支持加入语言」的落点）。
 *
 * 范围：本模块只管**界面文案**。注入给模型的文案是另一层——src/prompts/<lang>/
 * 由 promptLang 选择（见 prompt-loader.ts）。
 */

import { en } from './en.js'
import { zh } from './zh.js'
import { ptBr } from './pt-br.js'
import type { UiKey } from './keys.js'

/** 字典命名空间（DSH locale 服务的表键；一个命名空间只能有一个占用者）。 */
export const NS = 'meow-memory'

/** 界面支持的语言（追加语言只改这里 + 加一个字典文件）。 */
export const SUPPORTED_UI_LOCALES = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
  { id: 'pt-br', label: 'Português (Brasil)' },
] as const

/** 界面语言 id（BCP 47 风格小写标签；DSH locale 服务的 LocaleId）。 */
export type UiLocaleId = (typeof SUPPORTED_UI_LOCALES)[number]['id']

type UiLocale = string

/** 各语言的字典（en 是键集真源，其余缺失的键落 en）。 */
const DICTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en,
  zh,
  'pt-br': ptBr,
}

/** 无 DSH 服务时的兜底链（语言 → 依次尝试的语言）。 */
const FALLBACK_CHAIN: Readonly<Record<string, readonly string[]>> = {
  zh: ['zh', 'en'],
  en: ['en'],
  'pt-br': ['pt-br', 'en'],
}

/** 插件历史默认语言（无任何信号时的行为，与外置前一致）。 */
const DEFAULT_LOCALE: UiLocale = 'zh'

/** 翻译函数：`{name}` 占位符由 params 填充，未知键返回键名本身。 */
export type Translate = (key: UiKey, params?: Readonly<Record<string, string | number>>) => string

/**
 * DSH locale 服务的最小结构（结构化类型，不 import 官方包：插件对老宿主零硬
 * 依赖，构建也不需要该包在 node_modules 里）。方法与 LocaleRuntime 一一对应。
 */
export interface LocaleSnapshotLike {
  readonly active: string
  readonly locales: readonly { readonly id: string; readonly label: string }[]
}

export interface LocaleServiceLike {
  getLocale(): LocaleSnapshotLike
  subscribe(fn: () => void): () => void
  setLocale(id: string): void
  addLanguage(input: { id: string; label: string; fallback: string }): () => void
  register(ns: string, locale: string, dict: Record<string, string>): () => void
  /** 绑定命名空间 → 翻译函数（语言查表语义在服务内实现）。 */
  bind(ns: string): Translate
}

/** 受限 client ctx 里我们用到的最小面（探测式取用）。 */
export interface LocaleHostContext {
  get?(name: string): unknown
}

let service: LocaleServiceLike | null = null
let active: UiLocale = DEFAULT_LOCALE
/** 已注册进 DSH 服务的语言 id（幂等：重复 install 不再 register，避免抛重复占用）。 */
const registeredLocales = new Set<string>()
/** 已注册进 DSH 服务的字典语言 id（同上；命名空间被别的包占用时只告警一次）。 */
const registeredDicts = new Set<string>()
const listeners = new Set<(locale: UiLocale) => void>()

// ── locale 服务晚到重试（issue #32/#33）──────────────────────────────────────
// 冷启动时序：client apply 可能跑在宿主 locale 服务之前——installI18n 首次探测拿不到
// 服务，走一次性回退（browserLocale 定格）且原实现永不纠正 → 冷启动后 UI 整会话卡
// 英文（#32 桌面端实测，#33 重复报告）。
// 修复区分两种「没服务」（红线不动：locale 绝不进 inject——写进去会让插件在无 locale
// 的老宿主/受限动态包上整体挂起，v0.28.0 设计决策）：
//  - ctx 本身没有 get 能力（老宿主/受限动态包）→ 永久回退，不重试；
//  - ctx.get 存在但 locale 服务未注册（纯时序）→ 有界轮询重入 installI18n（幂等：
//   registeredLocales/registeredDicts 去重），就绪即注册 + notify（DOM 重放层挂在
//   onUiLocaleChange 上，文案随之刷新）。默认 1s × 30 次封顶自清——定时器有界自灭，
//   不挂 dispose；tick 内 try/catch 兜宿主上下文失效（页面卸载/fiber dispose）。
let localeRetryMs = 1_000
let localeRetryMax = 30
let localeRetryTimer: ReturnType<typeof setTimeout> | undefined
let localeRetryAttempts = 0

/** locale 服务探测：get 能力存在且服务形状齐备才算数（与 installI18n 主探测同口径）。 */
function probeLocaleService(ctx: LocaleHostContext): LocaleServiceLike | null {
  const svc = typeof ctx?.get === 'function' ? (ctx.get('locale') as LocaleServiceLike | null | undefined) : null
  if (svc === null || svc === undefined || typeof svc.getLocale !== 'function' || typeof svc.register !== 'function') return null
  return svc
}

function stopLocaleRetry(): void {
  if (localeRetryTimer !== undefined) clearTimeout(localeRetryTimer)
  localeRetryTimer = undefined
  localeRetryAttempts = 0
}

function armLocaleRetry(ctx: LocaleHostContext, warn: (message: string) => void): void {
  if (localeRetryTimer !== undefined) return // 已在轮询（重复 install 不叠加定时器）
  localeRetryAttempts = 0
  const tick = (): void => {
    localeRetryTimer = undefined
    localeRetryAttempts++
    let svc: LocaleServiceLike | null = null
    try {
      svc = probeLocaleService(ctx)
    } catch {
      svc = null // 宿主上下文已失效（页面卸载/fiber dispose）：放弃轮询
    }
    if (svc !== null) {
      installI18n(ctx, warn) // 重入走服务路径（幂等）：注册 + subscribe + notify（重放随动）
      return
    }
    if (localeRetryAttempts >= localeRetryMax) return // 封顶放弃：服务始终缺席
    localeRetryTimer = setTimeout(tick, localeRetryMs)
  }
  localeRetryTimer = setTimeout(tick, localeRetryMs)
}

/** 语言标签归一：pt_BR / pt-BR / PT-br → pt-br；只取主标签的比较用 primary()。 */
function normalize(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, '-')
}

function primary(tag: string): string {
  return normalize(tag).split('-')[0]
}

/** 一个语言标签在我们支持的语言里的 id（全标签优先，其次主标签），没有返回 null。 */
function match(tag: string): UiLocale | null {
  const wanted = normalize(tag)
  const exact = SUPPORTED_UI_LOCALES.find((l) => normalize(l.id) === wanted)
  if (exact !== undefined) return exact.id
  const byPrimary = SUPPORTED_UI_LOCALES.find((l) => primary(l.id) === primary(wanted))
  return byPrimary !== undefined ? byPrimary.id : null
}

/** 浏览器语言（navigator.languages → navigator.language）里第一个支持的语言。 */
function browserLocale(): UiLocale | null {
  if (typeof navigator === 'undefined') return null
  const listed: string[] = []
  if (Array.isArray(navigator.languages)) {
    for (const tag of navigator.languages) if (typeof tag === 'string') listed.push(tag)
  }
  if (typeof navigator.language === 'string') listed.push(navigator.language)
  for (const tag of listed) {
    const hit = match(tag)
    if (hit !== null) return hit
  }
  return null
}

/** 无服务时的静态查表：语言 → fallback 链 → en → 键名。 */
function staticTranslate(locale: UiLocale, key: UiKey, params?: Readonly<Record<string, string | number>>): string {
  const chain = FALLBACK_CHAIN[locale] ?? [locale, 'en']
  let template: string | undefined
  for (const lang of chain) {
    const hit = DICTS[lang]?.[key]
    if (hit !== undefined) {
      template = hit
      break
    }
  }
  if (template === undefined) template = DICTS.en[key] ?? key
  return fill(template, params)
}

/** 模板填充：replaceAll 用函数形式，正文里的 $& / $1 不被特殊解释。 */
function fill(template: string, params?: Readonly<Record<string, string | number>>): string {
  if (params === undefined) return template
  let out = template
  for (const [name, value] of Object.entries(params)) {
    out = out.replaceAll(`{${name}}`, () => String(value))
  }
  return out
}

/**
 * 注册字典（幂等）：把我们支持的全部语言交给 DSH locale 服务。
 * 重复 install 只跳过已注册的语言；任何一步失败都只告警——UI 退化为静态查表，
 * 绝不让整个插件因为文案层起不来。
 * @param ctx - client 根上下文（受限 ctx 只有 get，也能工作）。
 * @param warn - 告警出口（默认 console.warn；测试可注入收集器）。
 * @returns 实际完成注册的语言 id 列表（诊断/测试用）。
 */
export function installI18n(ctx: LocaleHostContext, warn: (message: string) => void = (m) => console.warn(m)): string[] {
  const svc = typeof ctx?.get === 'function' ? (ctx.get('locale') as LocaleServiceLike | null | undefined) : null
  if (svc === null || svc === undefined || typeof svc.getLocale !== 'function' || typeof svc.register !== 'function') {
    // 老宿主 / 动态包：没有 locale 服务，走浏览器判定 + 静态查表。
    service = null
    active = browserLocale() ?? DEFAULT_LOCALE
    notify()
    // issue #32：两种「没服务」分流——ctx 有 get 能力（服务只是晚到，冷启动竞态）
    // → 有界轮询重入；ctx 连 get 都没有（v0.28.0 决策的永久回退场景）→ 不重试。
    if (typeof ctx?.get === 'function') armLocaleRetry(ctx, warn)
    else stopLocaleRetry()
    return []
  }
  stopLocaleRetry()
  service = svc
  const done: string[] = []
  // ①语言目录：追加语言必须声明 fallback（链最终落在 en，DSH 的硬约束）。
  for (const locale of SUPPORTED_UI_LOCALES) {
    if (registeredLocales.has(locale.id)) {
      done.push(locale.id)
      continue
    }
    try {
      if (locale.id === 'zh' || locale.id === 'en') {
        // zh / en 是 DSH 内置语言，无需（也不能）重复声明目录项。
        registeredLocales.add(locale.id)
        done.push(locale.id)
        continue
      }
      if (typeof svc.addLanguage !== 'function') continue
      svc.addLanguage({ id: locale.id, label: locale.label, fallback: 'en' })
      registeredLocales.add(locale.id)
      done.push(locale.id)
    } catch (error) {
      warn(`[meow-memory] 语言 "${locale.id}" 注册失败（UI 退回英文/中文）：${String(error)}`)
    }
  }
  // ②字典：逐个语言注册（某语言已占用/非法只影响该语言）。重复 install 幂等。
  for (const locale of SUPPORTED_UI_LOCALES) {
    const dict = DICTS[locale.id]
    if (dict === undefined || registeredDicts.has(locale.id)) continue
    try {
      svc.register(NS, locale.id, { ...dict })
      registeredDicts.add(locale.id)
    } catch (error) {
      warn(`[meow-memory] 界面字典 "${locale.id}" 注册失败（该语言退回英文）：${String(error)}`)
    }
  }
  // ③当前语言：服务的 active 是唯一真源（配置写入后经 setLocale/adopt 发布）。
  active = readServiceLocale()
  // ④语言切换与字典晚到都经 subscribe 通知；只在 active 真的变化时广播。
  try {
    svc.subscribe(() => {
      const next = readServiceLocale()
      if (next === active) return
      active = next
      notify()
    })
  } catch (error) {
    warn(`[meow-memory] 语言变化订阅失败（文案在切换语言前保持当前语言）：${String(error)}`)
  }
  notify()
  return done
}

/** 读服务当前语言并归一到我们支持的语言（未知语言落到它的主标签，仍不匹配则 en）。 */
function readServiceLocale(): UiLocale {
  try {
    const snapshot = service?.getLocale()
    const id = snapshot?.active
    if (typeof id !== 'string' || id === '') return DEFAULT_LOCALE
    return match(id) ?? primary(id)
  } catch {
    return DEFAULT_LOCALE
  }
}

/** 广播语言变化。 */
function notify(): void {
  for (const fn of [...listeners]) {
    try {
      fn(active)
    } catch (error) {
      console.error('[meow-memory] UI 语言订阅者异常：', error)
    }
  }
}

/** 当前界面语言。 */
export function getUiLocale(): UiLocale {
  return active
}

/** 订阅界面语言变化（注册时立即回调一次当前值）。@returns 取消订阅。 */
export function onUiLocaleChange(fn: (locale: UiLocale) => void): () => void {
  listeners.add(fn)
  try {
    fn(active)
  } catch (error) {
    console.error('[meow-memory] UI 语言订阅者异常：', error)
  }
  return () => {
    listeners.delete(fn)
  }
}

/**
 * 测试专用：显式设置界面语言并广播（生产代码勿用——真源是 DSH locale 服务）。
 */
export function setUiLocaleForTest(locale: UiLocale): void {
  active = locale
  notify()
}

/**
 * 测试专用：调整 locale 晚到重试的节奏与上限（生产 1s × 30；intervalMs 传小值可
 * 在测试里毫秒级跑完整个轮询生命周期）。
 */
export function setLocaleRetryForTest(intervalMs: number, maxAttempts: number): void {
  localeRetryMs = intervalMs
  localeRetryMax = maxAttempts
}

/**
 * 翻译：当前语言 → fallback 链 → en → 键名。
 *
 * 走 DSH 服务时用服务 bind(NS) 的翻译（pt-br 缺键自动落 en，链由服务实现）；
 * 没有服务时用内置静态查表，语义一致。每次调用都读当前语言，所以 DOM 层只要
 * 在渲染/应用时调用即可；纯 DOM 节点在语言切换后由 onUiLocaleChange 的重放
 * 函数刷新。
 */
export const t: Translate = (key, params) => {
  if (service !== null) {
    try {
      const translate = service.bind(NS)
      const out = translate(key, params)
      // 服务落回键名 = 服务字典里没有这个键（理论上不会：注册的就是全量字典）。
      if (out !== key) return out
    } catch {
      /* 服务异常：落静态查表 */
    }
  }
  return staticTranslate(active, key, params)
}
