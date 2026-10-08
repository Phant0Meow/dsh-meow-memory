/**
 * meow-memory — UI copy, English pack (the key-set source of truth).
 *
 * Every user-visible string of the client half lives here; `zh.ts` and
 * `pt-br.ts` must carry exactly the same keys (tests/client-i18n.mjs enforces
 * it by compiling all three packs). Keys are flat and namespaced by area:
 *   fold.*      reflection/dream turn bars
 *   inject.*    long-term-memory / keyword-hit collapse bars
 *   notice.*    delegate marker bubbles
 *   menu.*      session "…" menu items
 *   settings.*  the meow-memory settings tab
 *   datetime.*  our own clock label
 *
 * `{name}` placeholders are substituted by `t()`; keep them intact when
 * translating.
 *
 * Scope note: this dictionary is the plugin's UI/UX text. The text injected
 * into the model (injection guide, reflect/dream prompts, tool descriptions)
 * is a separate, model-facing layer — see src/prompts/<lang>/ and promptLang.
 */
import type { UiKey } from './keys.js'

export const en: Record<UiKey, string> = {
  // ── reflection / dream turn bars ──────────────────────────────────────────
  'fold.title.reflect': 'Memory reflection',
  'fold.title.dream': 'Memory dream task',
  'fold.status.running': '{title} in progress…',
  'fold.hint.running': ' (your message joins this turn)',
  'fold.status.interrupted': '{title} interrupted',
  'fold.status.remembered': '{title} · {n} memories added',
  'fold.status.updated': '{title} · {n} updated',
  'fold.status.nothing': '{title} · nothing to save',

  // ── memory injection bars ─────────────────────────────────────────────────
  'inject.bar': 'Memory injected',
  'inject.kind.first': ' (long-term)',
  'inject.kind.hit': ' (keyword hits)',
  'inject.expand': 'Click to expand',
  'inject.collapse': 'Click to collapse',
  'inject.copy': 'Copy',
  'inject.copied': 'Copied',
  'inject.result': '[Result]',

  // ── delegate marker bubbles ───────────────────────────────────────────────
  'notice.reflect.running': '▸ Memory reflection task in progress…',
  'notice.reflect.done': '▸ Memory reflection task completed.',
  'notice.dream.running': '▸ Memory dream task in progress…',
  'notice.dream.done': '▸ Memory dream task completed.',
  'notice.dream.interrupted': '▸ Memory dream task interrupted; retrying automatically later.',

  // ── session menu ──────────────────────────────────────────────────────────
  'part.menu': 'Memory participation',
  'part.state.active': 'Active',
  'part.state.readonly': 'Do not disturb',
  'part.state.exited': 'Exited',
  'part.state.noConsolidation': 'Consolidation off',
  'part.state.noWrite': 'Writes off',
  'part.state.custom': 'Custom',
  'part.panel.read': 'Recall (auto-inject + read tools)',
  'part.panel.consolidate': 'Auto consolidation (reflect + dream)',
  'part.panel.write': 'Active writes (write tools)',
  'part.panel.on': 'On',
  'part.panel.off': 'Off',
  'part.panel.presets': 'Presets',
  'part.preset.full': 'Full',
  'part.preset.readonly': 'Quiet',
  'part.preset.exit': 'Exit',

  // ── settings tab ──────────────────────────────────────────────────────────
  'settings.title': 'Meow memory',
  'settings.summary':
    'Every setting of the cross-session memory plugin. Changes are stored in DSH settings (per field; "Restore default" goes back to the plugin factory default and ignores the patch assembly baseline); they take effect after a hot reload or restart of the meow-memory plugin.',
  'settings.loading': 'Loading meow-memory configuration…',
  'settings.unavailable': 'This connection does not support settings writes (only loopback connections can edit).',
  'settings.readonly': 'This connection is read-only (settings writes are limited to loopback connections).',
  'settings.saved': 'Saved ✓ takes effect after a hot reload or restart of the meow-memory plugin',
  'settings.badge.override': 'Overridden',
  'settings.badge.default': 'Default',
  'settings.reset': 'Restore default',
  'settings.saveFailed': 'Save failed: {error}',
  'settings.saveNotApplied': 'Save did not take effect: the server rejected the write (it may have failed validation). Showing the current server value again.',
  'settings.resetFailed': 'Restore default failed: {error}',
  'settings.resetNotApplied': 'Restore default did not take effect; please try again.',
  'settings.suppress.format': 'A window must look like "HH:MM-HH:MM"; got "{value}"',
  'settings.suppress.atLeastOne': 'At least one window is required',
  'settings.group.base': 'Basics',
  'settings.group.inject': 'Injection and hits',
  'settings.group.reflect': 'Reflection',
  'settings.group.delegate': 'Consolidation task model',
  'settings.group.dream': 'Idle consolidation (dream)',
  'settings.group.language': 'Language',
  'settings.group.storage': 'Directories & migration',
  'settings.field.enabled.label': 'Master switch',
  'settings.field.enabled.hint': 'When off, injection, reflection and the memory tools are all disabled',
  'settings.field.projectDir.label': 'Memory directory',
  'settings.field.projectDir.hint': 'Data directory, relative to the workspace',
  'settings.field.homeDir.label': 'Global data directory',
  'settings.field.homeDir.hint': 'Where instance-level data (logs, window index) lives. On change, contents of the old directory are migrated automatically (same-disk move / cross-disk copy); after a cross-disk copy the old directory is kept — delete it manually once verified. If multiple dsh instances share one directory, update them together.',
  'settings.field.homeDir.preset.default': 'System user home (default)',
  'settings.field.homeDir.preset.dshStorage': 'DSH home storage',
  'settings.field.homeDir.preset.pluginRoot': 'Plugin folder',
  'settings.field.homeDir.preset.custom': 'Custom path',
  'settings.mirrorReadonly': 'Non-local connection: dsh serves this settings page as a read-only mirror and no change will be saved. Open dsh via 127.0.0.1 on the host machine to edit settings.',
  'settings.field.autoMigrate.label': 'Auto-migrate old database',
  'settings.field.autoMigrate.hint': 'Migrate PROJECT.md automatically the first time a v1 database is opened',
  'settings.field.hitTopK.label': 'Max hits per message',
  'settings.field.hitTopK.hint': 'Upper bound on keyword-hit entries injected per message (fact/lesson/rules/topic)',
  'settings.field.titleMax.label': 'Guide title truncation length',
  'settings.field.titleMax.hint': 'Truncation length (characters) of the project list in the memory guide',
  'settings.field.reflect.label': 'Automatic reflection',
  'settings.field.reflect.hint': 'Review memory automatically after a task ends',
  'settings.field.reflectTurns.label': 'Reflection trigger turns',
  'settings.field.reflectTurns.hint': 'Consecutive tool steps inside one task needed to trigger at the end',
  'settings.field.delegateModel.label': 'Reflection/dream model override',
  'settings.field.delegateModel.hint':
    "Empty = the main model throughout. When set, reflection and dream turns run on that model and switch back to the main model at the end of the turn (the rest of the conversation is unaffected); 'provider/model' selects the route, 'model' only changes the model name",
  'settings.field.delegateModel.placeholder': 'e.g. zai-coding-cn/glm-5.3-flash',
  'settings.field.dreamEnabled.label': 'Idle consolidation switch',
  'settings.field.dream.idleMinutes.label': 'Idle minutes',
  'settings.field.dream.idleMinutes.hint': 'A window idle for this many minutes allows a dream',
  'settings.field.dream.suppressWindows.label': 'Peak-hour suppression windows',
  'settings.field.dream.suppressWindows.hint': 'Comma-separated "HH:MM-HH:MM"; no dream is triggered inside these windows',
  'settings.field.dream.suppressLeadMinutes.label': 'Extra suppression before peak (minutes)',
  'settings.field.dream.checkMinutes.label': 'Check interval (minutes)',
  'settings.field.dream.timeZone.label': 'Timezone for suppression windows',
  'settings.field.dream.timeZone.hint': 'Peak windows are computed in this fixed timezone (independent of the system clock)',
  'settings.field.dream.rulesReviewDays.label': 'Rules anti-churn days',
  'settings.field.dream.rulesReviewDays.hint': 'Stable rules whose updated_at is older than this many days skip dream round 1; 0 = no filter',
  'settings.field.promptLang.label': 'Prompt and retrieval language',
  'settings.field.promptLang.hint':
    "Empty = zh by default (sessions that never configured it get a one-time first-run guide); 'en' = built-in English pack. The UI language is unrelated — that follows the DSH language setting. The language must match the one you speak, or keyword hit rates drop",
  'settings.field.promptLang.placeholder': 'zh / en',

  // ── date and time ─────────────────────────────────────────────────────────
  'datetime.ymd': '{m}/{d}',
  'datetime.ymdFull': '{y}/{m}/{d}',
}
