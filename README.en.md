# meow-memory 🐱📝

| [中文](README.md) | [English](README.en.md) | [Português (BR)](README.pt-br.md) | [MIT License](LICENSE) |
| :---: | :---: | :---: | :---: |

Cross-session memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Version **0.31.0** ｜ Changelog: [CHANGELOG.md](CHANGELOG.md) ｜ Supports **dsh 0.1.5**

## ✨ Features

- **Seven memory layers**: `soul` (the AI itself) / `user` (user basics & preferences) / `project` (per-project info with `subcategory`) / `fact` (atomic facts) / `lesson` (mistakes & corrections) / `topic` (ongoing discussion arcs with a goal sentence) / `rules` (design principles & behavioral rules). One SQLite table per layer, UUIDs are time-prefixed so id order == creation order.
- **First-turn injection (long-term memory block)**: before the first user message, soul / user / design principles / memory guide are injected. The memory is inserted as an independent plugin snapshot directly before the real user message; **the user's prompt is never rewritten**, and **no keyword hits run on the first turn** (hits start from the second message).
- **Per-message keyword hits**: from the second user message on, every real user message is matched against fact/lesson/rules/topic (scope = global + current-project anchor) and the top-2 hits are injected. Matching is based on **entry keywords**, not full text.
- **Current-project anchor**: any `memory_remember/search/update/project` call with a `project` parameter anchors the session's current project; unanchored sessions only hit global entries (casual chat stays unaffected).
- **Cache-friendly by design**: the static `meow-memory:guide` section is registered in the system prompt once — constant text, so it cannot break the provider's KV cache.
- **Post-compaction re-injection**: after a session is compacted, the next turn automatically re-injects the long-term snapshot plus the project overviews this session fetched via `memory_project`, plus the entries this session wrote or updated — so the AI never suddenly goes amnesiac after compaction.
- **Three things on top of the layers**: writes dedup and merge automatically; displayed timestamps are always `updated_at`; global information uses the global marker (distinct from leaving the field blank).
- **Per-window dream**: a window becomes dream-eligible once idle ≥ 3 hours, and its own main agent consolidates in rounds (atomic memories / topic / project summary); **peak-hour suppression** (09:00–12:00 and 14:00–18:00 in the configured `timeZone`, default Asia/Shanghai — the API's peak-tariff hours) prevents triggering. Typing `/dream` consolidates immediately on demand.
- **Reflection**: after ≥7 consecutive tool steps within one task the plugin asks the model whether anything since the last consolidation is worth remembering. A turn whose last tool is a `memory_*` tool counts as already consolidated (no re-reflection).
- **External memory trust gate**: a workspace-carried `.dsh-meow` that was not created on this machine (e.g. a cloned external repo) is paused by default — one notice on the first round, then `/meow-trust` re-enables instantly; libraries created locally and workspaces opened before the upgrade are trusted automatically, so normal use never notices.
- **Client UI**: injected text collapses into a slim bar, reflection/dream turns collapse into one expandable card, and the session list shows dream state icons (🌙 consolidated / breathing moon in progress / muted-gray slashed moon skipped).
- **Zero runtime dependencies**: `node:sqlite` + self-contained esbuild bundle (`lib/index.js`). No native modules.

## 📦 Install

### One-command install (recommended)

```sh
dsh plugin --profile web add github:Phant0Meow/dsh-meow-memory
```

One command and it works: the package compiles itself on install (it ships a `prepare` script), mounts automatically, and new sessions load the plugin after you restart `dsh web`.

> pnpm ≥10 blocks install-time build scripts by default: the first `add` may fail and mention `allowBuilds`. Add the keys it prints to the profile's `pnpm-workspace.yaml` and run it again.

### Via npm (published package)

```sh
# 1. Install into the profile's node_modules (the loader resolves plugins there)
cd $DSH_HOME/profiles/web          # default home: ~/.dsh/profiles/web
npm install meow-memory

# 2. Add the package to the profile's assembly bundles in package.json (recommended since v0.9.0):
#    "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "meow-memory"] } }
#    (the package ships a dsh.bundle.patch; bundle assembly inserts it. Profile-patch
#     `insert` entries address existing ids — a new plugin not in the tree reports
#     "entry not found", so new plugins go through the bundles array.)

# 3. Restart dsh web. New sessions pick up the plugin automatically.
```

### Remove

```sh
dsh plugin --profile web remove meow-memory
```

### PT-BR fork

For a build packaged for Brazilian Portuguese, see [coutogilson](https://github.com/coutogilson)'s fork:

```sh
dsh plugin --profile web add github:coutogilson/dsh-meow-memory
```

### By hand (any DSH install, no npm needed)

1. Copy (or symlink) this package into the profile's `node_modules`:

   ```sh
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -s /path/to/meow-memory ~/.dsh/profiles/web/node_modules/meow-memory
   ```

   (On Windows: `New-Item -ItemType Junction ...` — NTFS junction, no admin needed.)

2. Add `meow-memory` to the profile `package.json`'s `dsh.profile.bundles` (same as above).

3. Restart `dsh web`. New sessions pick up the plugin automatically.

## 🔌 Compatibility

Supports **dsh 0.1.5** (including the latest `0.1.5-rc.1`) and stays backward compatible with older releases — upgrading dsh needs no change to this plugin or its configuration.

The plugin never hardcodes a version: it probes host capabilities at runtime, so new and old releases each take their correct branch. Both generations are verified — on `0.1.5-rc.1` first-turn injection, memory tool calls, and client rendering all work; on `0.1.1-rc.2` behavior is unchanged from previous releases.

## ⚙️ Configuration

All fields are optional (profile patch or `cordis.patch.yml`). **You don't have to hand-edit files**: the DSH settings page has a dedicated "喵记忆" tab for this plugin (peer of General/Models/Plugins) where every option below is editable in place, saved per-field with one-click restore-to-default (restoring means the plugin's built-in factory default, not the patch baseline); reload/restart the meow-memory plugin after saving for changes to take effect.

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true          # master switch
    projectDir: '.dsh-meow' # memory directory, relative to the workspace
    promptLang: 'zh'       # ⚠️ set this on first use (see note below)
    hitTopK: 2             # max keyword-hit entries injected per user message
    dream:
      enabled: true
      idleMinutes: 180      # window is dream-eligible after ≥180 min (3 h) idle
```

**Every field, its type and its default are in [docs/configuration-reference.md](docs/configuration-reference.md)**, including `titleMax` / `autoMigrate` / `homeDir` / `disabledWorkspaces` / `backup` / `delegate`.

> ⚠️ **Set `promptLang` explicitly on first use.** It decides the language of injected/reflection/dream prompts and of tool descriptions, and it also shapes the language the model writes memory entries in — keywords are extracted in the entry's language. `zh` / `en` / `pt-br` ship built in. The value *is* the subdirectory name under `src/prompts/` and is matched **verbatim**: a name that does not exist (e.g. `pt`) raises nothing and silently falls back to the Chinese pack. See [docs/configuration-reference.md](docs/configuration-reference.md).

### UI language

The plugin's UI copy follows DSH's Settings → General → Language (built in: 中文 / English / Português (Brasil)) and is a separate layer from `promptLang`; the two do not interfere. See [docs/configuration-reference.md](docs/configuration-reference.md).

## 🧠 How it works

```
First user message (turn 1)      Every message from turn 2            idle ≥3h, not peak
┌────────────────────┐          ┌────────────────────┐        ┌──────────────────────┐
│ ===== 长期记忆 ===== │          │ 可能相关的记忆，仅供  │        │ per-window dream:     │
│ 【关于你】(soul)     │          │ 参考：keyword hits    │        │ three rounds (atomic/ │
│ 【关于user】         │          │ top-2 (global +     │        │ topic, summary), 7+   │
│ 【设计原则】(rules)   │          │ current-project     │        │ extracted, updated_at │
│ 【记忆导引】          │          │ anchor)            │        │ stamped at T          │
└────────────────────┘          └────────────────────┘        └──────────────────────┘
independent snapshot message    seen ids recorded
↓ pristine user prompt          per session (sessions/<id>.json)
  injected once per             compaction signal → seen released
  session, no hits on turn 1
```

### Tools

| Tool | Purpose |
|---|---|
| `memory_remember` | Write one memory (content/project/keywords/importance required; dedups and merges) |
| `memory_search` | Keyword search (BM25 × recency; level/project/status/days filters) |
| `memory_project` | Fetch a project's whole-project injection paragraph (**`project` parameter required**) |
| `memory_find_similar` | Duplicate & conflict detection |
| `memory_read` | Read one entry's complete metadata by id |
| `memory_update` | Correct status / importance / goal / keywords |
| `memory_dream` | Manually trigger this window's consolidation |
| `memory_home` | Inspect / switch the global data directory |

There is also the `/dream` command: type `/dream` in the composer to consolidate this window right away, immune to peak-hour suppression.

**Parameters, returns and side effects are in [docs/tool-reference.md](docs/tool-reference.md)** (including `memory_project`'s anchoring side effect and `memory_home`'s three preset directory markers).

## 🛠 Development

```sh
npm install
npm run build          # esbuild bundle → lib/index.js (self-contained)
npm run test           # 228 logic tests: db / bm25 / migrate / inject / reflect / dream / tools / apply
```

The `@deepseek-ai/*` packages live in the dsh-meow pnpm workspace, not in this package's
`node_modules`. On Windows, `npm run link-workspace` (or `scripts/link-workspace.ps1`)
creates junction mirrors of the workspace packages so esbuild can resolve them;
`build.mjs` uses `nodePaths` to pick them up. The links are build-time only.

## 📚 Documentation

| To learn about | Read |
| --- | --- |
| The seven tools: parameters, returns and side effects | [docs/tool-reference.md](docs/tool-reference.md) |
| Every configuration field, type and default | [docs/configuration-reference.md](docs/configuration-reference.md) |
| Why it is designed this way (cache, hits, dream, pitfalls) | [docs/design-notes.md](docs/design-notes.md) |
| Install failures, poor search results, how to read errors | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Version history | [CHANGELOG.md](CHANGELOG.md) |
| Adding a UI language | [src/i18n/README.md](src/i18n/README.md) |
| Adding a prompt language pack | [src/prompts/README.md](src/prompts/README.md) |

## 🙏 Acknowledgments

Thanks to every contributor who made meow-memory better:

- **[daveycodez](https://github.com/daveycodez)** — English language pack & tokenizer ([PR #6](https://github.com/Phant0Meow/dsh-meow-memory/pull/6), shipped in v0.22.0)
- **[chenmzh](https://github.com/chenmzh)** — isolated memory injections into independent plugin snapshot messages, fixing session title pollution ([PR #10](https://github.com/Phant0Meow/dsh-meow-memory/pull/10))
- **[cuddly-guacamole](https://github.com/cuddly-guacamole)** — dual-version Session events compatibility for dsh 0.1.2-alpha.4 ([PR #11](https://github.com/Phant0Meow/dsh-meow-memory/pull/11))
- **[coutogilson](https://github.com/coutogilson)** — Brazilian Portuguese prompt pack (`src/prompts/pt-br/`) and the UI copy layer that follows the DSH locale

## 📄 License

MIT — see [LICENSE](LICENSE).
