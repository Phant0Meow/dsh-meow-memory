/**
 * meow-memory — i18n 公共入口（client 端 UI/UX 文案）。
 *
 * 用法：
 *   import { t } from './i18n/index.js'          // 渲染/应用时取文案
 *   import { installI18n, onUiLocaleChange } from './i18n/index.js'
 *
 * 详见 core.ts 的设计注释（跟随 DSH 语言设置 + 老宿主降级 + 追加语言的方法）。
 */
export {
  installI18n,
  getUiLocale,
  onUiLocaleChange,
  setUiLocaleForTest,
  setLocaleRetryForTest,
  t,
  NS,
  SUPPORTED_UI_LOCALES,
  type Translate,
  type UiLocaleId,
  type LocaleServiceLike,
  type LocaleSnapshotLike,
  type LocaleHostContext,
} from './core.js'
export { UI_KEYS, missingKeys, extraKeys, type UiKey } from './keys.js'
export { en } from './en.js'
export { zh } from './zh.js'
export { ptBr } from './pt-br.js'
