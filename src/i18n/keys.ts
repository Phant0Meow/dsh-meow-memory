/**
 * meow-memory — UI copy key set (single list, shared by every language pack).
 *
 * `en.ts` must define every key here; `zh.ts` / `pt-br.ts` are typed as
 * `Record<UiKey, string>`, so a missing key fails the build and an extra key
 * is a type error too. Adding a language = adding one pack with the same key
 * set — no code change anywhere else.
 */

export const UI_KEYS = [
  // reflection / dream turn bars
  'fold.title.reflect',
  'fold.title.dream',
  'fold.status.running',
  'fold.hint.running',
  'fold.status.interrupted',
  'fold.status.remembered',
  'fold.status.updated',
  'fold.status.nothing',
  // memory injection bars
  'inject.bar',
  'inject.kind.first',
  'inject.kind.hit',
  'inject.expand',
  'inject.collapse',
  'inject.copy',
  'inject.copied',
  'inject.result',
  // delegate marker bubbles
  'notice.reflect.running',
  'notice.reflect.done',
  'notice.dream.running',
  'notice.dream.done',
  'notice.dream.interrupted',
  // session menu
  // memory participation gate (issue #38/#28): per-window tri-state + panel
  'part.menu',
  'part.state.active',
  'part.state.readonly',
  'part.state.exited',
  'part.state.noConsolidation',
  'part.state.noWrite',
  'part.state.custom',
  'part.panel.read',
  'part.panel.consolidate',
  'part.panel.write',
  'part.panel.presets',
  'part.preset.full',
  'part.preset.readonly',
  'part.preset.exit',
  // settings tab
  'settings.title',
  'settings.summary',
  'settings.loading',
  'settings.unavailable',
  'settings.readonly',
  'settings.saved',
  'settings.badge.override',
  'settings.badge.default',
  'settings.reset',
  'settings.saveFailed',
  'settings.saveNotApplied',
  'settings.resetFailed',
  'settings.resetNotApplied',
  'settings.suppress.format',
  'settings.suppress.atLeastOne',
  'settings.group.base',
  'settings.group.inject',
  'settings.group.reflect',
  'settings.group.delegate',
  'settings.group.dream',
  'settings.group.language',
  'settings.group.storage',
  'settings.field.enabled.label',
  'settings.field.enabled.hint',
  'settings.field.projectDir.label',
  'settings.field.projectDir.hint',
  'settings.field.homeDir.label',
  'settings.field.homeDir.hint',
  'settings.field.homeDir.preset.default',
  'settings.field.homeDir.preset.dshStorage',
  'settings.field.homeDir.preset.pluginRoot',
  'settings.field.homeDir.preset.custom',
  'settings.mirrorReadonly',
  'settings.field.autoMigrate.label',
  'settings.field.autoMigrate.hint',
  'settings.field.hitTopK.label',
  'settings.field.hitTopK.hint',
  'settings.field.titleMax.label',
  'settings.field.titleMax.hint',
  'settings.field.reflect.label',
  'settings.field.reflect.hint',
  'settings.field.reflectTurns.label',
  'settings.field.reflectTurns.hint',
  'settings.field.delegateModel.label',
  'settings.field.delegateModel.hint',
  'settings.field.delegateModel.placeholder',
  'settings.field.dreamEnabled.label',
  'settings.field.dream.idleMinutes.label',
  'settings.field.dream.idleMinutes.hint',
  'settings.field.dream.suppressWindows.label',
  'settings.field.dream.suppressWindows.hint',
  'settings.field.dream.suppressLeadMinutes.label',
  'settings.field.dream.checkMinutes.label',
  'settings.field.dream.timeZone.label',
  'settings.field.dream.timeZone.hint',
  'settings.field.dream.rulesReviewDays.label',
  'settings.field.dream.rulesReviewDays.hint',
  'settings.field.promptLang.label',
  'settings.field.promptLang.hint',
  'settings.field.promptLang.placeholder',
  // date and time
  'datetime.ymd',
  'datetime.ymdFull',
] as const

/** Every UI copy key the plugin consumes. */
export type UiKey = (typeof UI_KEYS)[number]

/** Runtime key-set check (used by tests and by packs coming from outside). */
export function missingKeys(dict: Readonly<Record<string, string>>): UiKey[] {
  return UI_KEYS.filter((key) => typeof dict[key] !== 'string')
}

/** Runtime reverse check: keys a pack carries that the source of truth does not know. */
export function extraKeys(dict: Readonly<Record<string, string>>): string[] {
  const known = new Set<string>(UI_KEYS)
  return Object.keys(dict).filter((key) => !known.has(key))
}
