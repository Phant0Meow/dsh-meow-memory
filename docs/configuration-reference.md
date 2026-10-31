# Configuration reference

All fields are optional (profile patch or `cordis.patch.yml`). **You don't have to hand-edit files**: the DSH settings page has a dedicated "喵记忆" tab for this plugin (peer of General/Models) where every option below is editable in place, saved per-field with one-click restore-to-default (restoring means the plugin's built-in factory default, not the patch baseline); reload/restart the meow-memory plugin after saving for changes to take effect.

---

## Factory defaults

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true             # master switch
    projectDir: '.dsh-meow'   # memory directory, relative to the workspace
    promptLang: 'zh'          # ⚠️ set this on first use (see below)
    hitTopK: 2                # max keyword-hit entries injected per user message (fact/lesson/rules/topic)
    titleMax: 40              # guide title truncation length
    reflect: true             # auto-reflection after ≥reflectTurns consecutive tool turns
    reflectTurns: 7           # consecutive tool turns before reflection triggers
    autoMigrate: true         # migrate a legacy PROJECT.md when the db is first opened
    homeDir: ''               # global directory: '' = default; or a preset marker / absolute path
    disabledWorkspaces: []    # workspaces with memory fully disabled (cwd-normalised match)
    backup:
      enabled: false          # snapshot memory.db to memory.db.bak at the end of each dream
    dream:
      enabled: true
      idleMinutes: 180        # window is dream-eligible after ≥180 min (3 h) idle
      suppressWindows:        # peak-hour suppression (computed in timeZone, "HH:MM")
        - start: '09:00'      #   API peak-tariff hours
          end: '12:00'
        - start: '14:00'
          end: '18:00'
      suppressLeadMinutes: 15 # also suppressed for 15 min before each window
      checkMinutes: 15
      timeZone: 'Asia/Shanghai'  # the user's machine clock is US time; suppression
                                 # windows must follow this fixed zone instead
      rulesReviewDays: 2      # stable rules whose updated_at is older than this many
                              # days are skipped in dream round 1 (anti-churn); 0 = off
    delegate:
      model: ''               # model override for memory work (optional): when set,
                              # reflection turns and dream rounds automatically run on
                              # this model and switch back afterwards; 'provider/model'
                              # sets both, 'model' swaps the model only (provider
                              # inherited); empty = always the main model
```

---

## Field by field

### Master switch and directories

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | bool | `true` | Master switch. When `false`, injection, reflection and tools are all disabled |
| `projectDir` | string | `.dsh-meow` | Memory directory, **relative to the workspace**. The db lives at `<workspace>/<projectDir>/memory.db` |
| `homeDir` | string | `''` (= platform user home) | **Instance-level global directory**: logs / window-index / prompts overrides / migrate state. See the table below |
| `disabledWorkspaces` | string[] | `[]` | Workspace denylist. A matching workspace has memory **fully disabled** — reads, consolidation and writes are all refused, **including a manual `/dream`**. Meant for throwaway-task workspaces so they do not pollute the memory db |

**The four `homeDir` values**:

| Value | Location |
|---|---|
| `''` or omitted | The platform user home directory |
| `'default'` | Same as above (explicit marker) |
| `'dsh-storage'` | `<DSH home>/storages/meow-memory` |
| `'plugin-root'` | `<plugin root>/storage` |
| an absolute path | A custom directory |

Changing it migrates the old directory automatically (same-volume move / cross-volume copy; **the old directory is never deleted automatically**). You can also just tell the AI "switch the global directory" — the `memory_home` tool offers the same capability with no restart.

### Retrieval and reflection

| Field | Type | Default | Notes |
|---|---|---|---|
| `hitTopK` | number 0–10 | `2` | Max keyword hits injected per user message (scope: short fact/lesson/rules/topic entries) |
| `titleMax` | number 10–200 | `40` | Guide title truncation length |
| `reflect` | bool | `true` | Whether to auto-inject reflection after a ReAct task ends |
| `reflectTurns` | number 1–50 | `7` | Consecutive tool steps within one task before reflection triggers at its end |

### Language

| Field | Type | Default | Notes |
|---|---|---|---|
| `promptLang` | string | unset (runs as `zh` + first-use guidance) | Prompt language pack directory name. `zh` is built in; `en` and `pt-br` ship as built-in packs |

### Migration and backup

| Field | Type | Default | Notes |
|---|---|---|---|
| `autoMigrate` | bool | `true` | Migrate a legacy `PROJECT.md` when the db is first opened |
| `backup.enabled` | bool | `false` | Automatic memory-db backup (#37): at the end of each dream, snapshot `memory.db` to `memory.db.bak` (`VACUUM INTO` consistent backup, mtime-based incrementality). **Consumed at registration; a change needs a reload** |

### dream

| Field | Type | Default | Notes |
|---|---|---|---|
| `dream.enabled` | bool | `true` | Whether automatic consolidation is allowed |
| `dream.idleMinutes` | number ≥1 | `180` | Idle minutes before a window becomes dream-eligible |
| `dream.suppressWindows` | `{start,end}[]` | `09:00–12:00`, `14:00–18:00` | Suppression windows (computed in `timeZone`) inside which dream does not trigger |
| `dream.suppressLeadMinutes` | number 0–120 | `15` | Extra non-triggering minutes before each suppression window starts |
| `dream.checkMinutes` | number ≥1 | `15` | Check cycle |
| `dream.timeZone` | string | `Asia/Shanghai` | Time zone used for the suppression windows |
| `dream.rulesReviewDays` | number ≥0 | `2` | Stable `rules` whose `updated_at` is older than this many days are skipped in dream round 1; `0` = no filter |

### delegate

| Field | Type | Default | Notes |
|---|---|---|---|
| `delegate.model` | string | `''` (always the main model) | Model for reflection/dream turns: `'provider/model'` sets both, `'model'` swaps the model only (provider inherited from the main session) |
| `delegate.effort` | string | `''` (strip) | Reasoning effort for the delegate model (#98): empty = strip the main session's `reasoningEffort` on override (recommended — if the target model does not declare reasoning efforts, the request is rejected outright with `UNSUPPORTED_REASONING_EFFORT`); `'inherit'` = keep the main session's effort (old behavior); any other non-empty value = sent verbatim (set it manually when you know the delegate model supports it, e.g. `'high'`). The main effort is restored together with the main model when the turn ends |

---

## `promptLang`: prompt & retrieval language (important)

`promptLang` decides two things: ① the language of injected/reflection/dream prompts; ② the language of tool descriptions. It also shapes the language the model writes memory entries in — keywords are extracted in the entry's language, so **go with your chat language**.

**Set it explicitly on first use**: `'zh'` (default), `'en'` (built-in English pack) or `'pt-br'` (built-in Brazilian Portuguese pack). All three ship built in. The value *is* the subdirectory name and is matched **verbatim**: a name that does not exist under `src/prompts/` (e.g. `pt`) raises nothing and silently falls back to the Chinese pack.

When it is unset: the plugin runs as `zh`, and the first real user message after it takes effect receives a "first-time setup" guidance task (the AI judges the user's language and completes the configuration; at most one reminder per session).

**On the retrieval side**: the BM25 tokenizer is language-independent since v0.20.0 (category routing) — a language mismatch between queries and stored entries no longer degrades recall; `en` additionally enables English normalization (stopword filter + Porter stemmer), so inflected queries still hit stored entries (`tokenizers` matches `tokenizer`).

**Custom / community language packs**: prompt copy is data (one directory per language under `src/prompts/`, hot-read at runtime — no code changes needed). See [`src/prompts/README.md`](../src/prompts/README.md) for the contributor guide and `npm run check-lang`. Instance-level overrides: drop same-named slot files into `<home>/.dsh-meow/prompts/<lang>/` (partial overrides welcome). For another Portuguese variant, or to adjust the Portuguese copy, use that instance override layer and set `promptLang` to the same name.

---

## Model override for memory work (optional)

The reflection turn and each dream group always run in the main window (steer) — prompts, replies, and tool calls land in the main session log (the fold UI keeps them tidy). The standalone fork-subagent execution mode was removed in v0.24; there is no longer an "independent execution" switch.

To run memory work on a different (cheaper) model: with `delegate.model` set, every LLM request issued during reflection/dream turns gets its provider/model overridden via dsh's `agent/request` waterfall, and the main model takes over again once the turn ends — normal conversation and tool rounds are untouched. The implementation is stateless: each request is judged by whether the current turn carries a reflection/dream directive marker, so user aborts, crashes, and hot reloads can never leave a stuck "overridden" state.

**Reasoning effort**: the main session's `reasoningEffort` does not travel with the override — the target model's declared capabilities are unknown, and carrying it can get the request rejected before it is sent (`UNSUPPORTED_REASONING_EFFORT`), which shows up as "the model answered but the round still fails, the same dream group is redelivered". It is stripped by default; set `delegate.effort: 'inherit'` when the delegate model supports the same efforts, or specify an effort it supports.

---

## UI language: follows the DSH locale (v0.27.0)

The plugin's own UI copy (fold bars, delegate bubbles, session menu item, settings page) goes through a separate **UI copy layer** that follows DSH's Settings → General → Language: **中文 / English / Português (Brasil)** ship built in, and a switch applies immediately (the settings label re-registers per the official contract; plain DOM nodes are refreshed through a replay registry).

It is a different layer from `promptLang` (model-facing copy) and the two do not interfere: the UI can follow the shell while injected prompts keep following `promptLang`. On old hosts (no locale service) it degrades to the browser language plus the built-in dictionaries, ending at `zh` — unchanged for a Chinese-reading user on a Chinese browser, and now pulling English (the point of the change) for one whose browser asks for it.

Adding a community UI language: one dictionary file plus one line in `SUPPORTED_UI_LOCALES` (no UI code changes). See [`src/i18n/README.md`](../src/i18n/README.md).

---

## See also

- [Tool reference](tool-reference.md) — the seven tools' parameters and returns
- [Design notes](design-notes.md) — why it is designed this way
- [Troubleshooting](troubleshooting.md) — install failures, poor search results, reading errors
