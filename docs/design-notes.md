# Design notes

Why meow-memory is built the way it is. These are the trade-offs and the pitfalls hit along the way — not a feature list.

---

## 1. Why the static manual lives in the system prompt while dynamic content goes into the first user message

| Content | Where | Why |
|---|---|---|
| Static memory manual (data overview + tool usage + writing guidelines) | A fixed section of the **system prompt** | Constant text, so it **cannot break the LLM provider's KV/context cache** |
| Dynamic content (full soul/user, design principles, memory guide) | **Prefix of the first user message** | The content varies per workspace; putting it in the system prompt would invalidate the cache every time |

The static section is named `meow-memory:guide`, **order 130, right after the `tool:*` guidance sections**, registered once with constant text.

The memory itself is inserted as an **independent plugin snapshot message** ahead of the real user message and **never rewrites the user prompt**.

---

## 2. Why the first turn runs no keyword hits

The first turn only injects the long-term memory snapshot; **hits start from the second message**. The reason: the first user message may arrive batched with a plugin notice (such as an approval-policy change notification), and if hits ran on the first turn they would be attached to the notice's turn rather than the real user message's turn.

So the design is: **the snapshot lands directly before the real user message, and hits never fire early**.

---

## 3. Why hits are based on entry keywords rather than full text

Full-text matching is noisy — a word appearing somewhere in a memory often does not mean that memory is relevant to the current topic.

Therefore hits are based on **entry keywords** (LLM-extracted or auto bigram).

The scoring formula:

```
intersection × idf × coverage × Ebbinghaus decay (by memory timestamp) × importance weight × title bonus
```

Both `importance` and `title` participate in scoring, so filling them in accurately at write time pays off.

---

## 4. Why "seen" entries are recorded per session

Already-seen memories (`injected` + `searched`) are recorded per session in `sessions/<id>.json`:

- **Injection never repeats**
- `memory_search` takes the top 5 by relevance unconditionally (**seen entries and entries created in this session are not excluded**), then fills the rest from further down the ranking while skipping already-seen entries
- A session-compaction signal (`compaction/*`) **releases the seen records**, letting compressed-away memories be hit and extracted again

The top 5 deliberately do not exclude seen entries: if they did, the most relevant few could never be retrieved and search would drift further off with every query.

---

## 5. Why memories are re-injected after compaction

Once a session is compacted (manual `/compact` or automatic token-pressure compaction), the next user-message turn automatically re-injects:

- the long-term memory snapshot
- the project overviews this session previously fetched via `memory_project`
- the entries this session itself wrote or updated

(all rebuilt from the latest data)

**The memory compacted away comes back within one turn, so the AI never suddenly goes amnesiac after compaction.** Consulted projects are recorded through `memory_project`'s call trace (`markProjectQueried`); global markers are not recorded (the global layer goes through the snapshot).

---

## 6. Why consolidation is per-window rather than a nightly window

The original design used a nightly window. It became **per-window**: a window becomes eligible after ≥ `idleMinutes` (default 3 hours) idle, and **every window whose last chat is newer than its last dream is consolidated by its own main agent**.

The benefit: consolidation uses **that window's own full conversation context**, with the scope being the memories created and extracted in this window.

Three rounds:

| Round | Content |
|---|---|
| 1 | Atomic memories: project / fact / lesson / rules / soul / user |
| 2 | topic memories |
| 3 | Project summary (appended when the window touched concrete projects: re-check via `memory_project`, distil a new long-term project memory, archive the superseded entries) |

---

## 7. Why there is peak-hour suppression

`suppressWindows` defaults to 09:00–12:00 and 14:00–18:00 — the **API's peak-tariff hours**, when calls cost more. The `suppressLeadMinutes` (default 15) before each window is suppressed too.

It fires on the next check cycle after the peak ends, and **a dream already in progress is never interrupted**.

`timeZone` defaults to `Asia/Shanghai`: the user's machine clock is US time, so the suppression windows must be computed in a fixed zone — otherwise the peak-hour decision is entirely wrong.

---

## 8. Why `rules` need anti-churn

Re-reviewing long-stable `rules` turns into no-op "updates for the sake of updating". `dream.rulesReviewDays` defaults to 2 days: **stable rules whose `updated_at` is older than that are skipped in dream round 1**; `0` = no filter.

---

## 9. Why "restore default" has to distinguish the factory default from the patch baseline

The settings page's original "restore default" only deleted the user-layer field and displayed the fallback base — but base = factory default + patch baseline (`cordis.patch.yml`), so **a non-default value hand-written into the patch was handed back to the user as the "default"**. This was hit in practice (a model hard-coded in the patch became the restore-to-default result for the reflection/dream model override).

The semantics are now unified as: **restore default = back to the plugin's factory default**. The factory defaults live in a single source (`src/defaults.ts`) shared by host and client.

---

## 10. Why consolidation no longer runs in an independent fork subagent

The standalone fork-subagent execution mode was removed in **v0.24**; there is no longer an "independent execution" switch.

The reflection turn and each dream group now **always run in the main window (steer)** — prompts, replies, and tool calls land in the main session log (the fold UI keeps them tidy).

Model swapping moved to `delegate.model`: every LLM request issued during reflection/dream turns gets its provider/model overridden via dsh's `agent/request` waterfall, and the main model takes over once the turn ends. The implementation is **stateless** — each request is judged by whether the current turn carries a reflection/dream directive marker, so user aborts, crashes, and hot reloads can never leave a stuck "overridden" state.

---

## 11. Why dream needs anti-repeat protection

Four mechanisms:

| Mechanism | Role |
|---|---|
| check gate | DB-atomic 60s check throttle |
| idempotent start claim | `dream_pending` |
| interrupted-dream self-healing | a dream without a finish is finalised automatically |
| orphan finalisation | a finished dream turn always lands, even across hot-reload instances |

Additionally: **plugin-injected turn events do not refresh window activity** — an already-dreamed window is never re-dreamed.

---

## 12. Why the session-list icon only adds and removes its own nodes

The icon is placed in the dsh session row's status slot, left of its status dots: **only self-created nodes are added or removed, never rewriting React-owned children**.

The reason: replacing the whole slot desyncs React's virtual DOM — the next commit throws `removeChild NotFoundError` and unmounts the entire sidebar tree.

Row targeting also needs **zero dsh changes**: it reads the React 18 fiber (`__reactFiber$` internal property) to get the row's render key = session id, **without relying on title matching**.

Data flows through a page-wide shared **60s polling diff** (v0.23.0 connection-pool fix, replacing the former SSE stream): one GET each against `/meow-memory/dreamed-sessions` and `/meow-memory/skip-dreams`; `state:'dreaming'` when a dream starts, `state:'dreamed'` when it finishes, `state:'active'` when a session gets new activity, and `state:'skip'/'unskip'` when the skip flag flips; the client reconciles once on mount.

---

## 13. Why the global marker follows the language

The global marker comes from the active language pack's `project.global` value in `labels.md` (the Chinese pack uses 「全局」, the English pack uses `"global"`).

**It must follow the language** — otherwise a `"global"` written by the model under the English pack would be treated as a project literally named global: global rules would stop being injected and a phantom project would appear in the project list.

When it cannot be resolved (the instance override layer's `labels.md` is an older version missing the key) it falls back to the literal value: the global decision is on the retrieval hot path, so an outdated copy file must not be allowed to throw away the whole injection chain.

---

## 14. Why zero runtime dependencies

`node:sqlite` (default-enabled on Node ≥22.13; 22.5–22.12 needs `--experimental-sqlite`) plus a self-contained esbuild bundle (`lib/index.js`). **No native modules.**

## 15. Why external memory libraries require a trust gate (#64)

Housing the memory db inside the workspace is the product's core design (the workspace carries its memory); the corollary is that **anyone can pre-seed a `.dsh-meow`**. A malicious repo carrying a crafted `memory.db` (or a `PROJECT.md`, which autoMigrate would import) gets its content spliced into the `===== Long-term memory ===== / About the user` block on the victim's first message — the **highest-trust framing in the whole plugin**. Attacker text is laundered into "words the user actually said", with zero interaction (it fires automatically on the first message) and zero notice (a pre-seeded db is not `isFresh`, so the first-create notice never fires). The host does not gate AGENTS.md-style project files either, but the model knows those are third-party project content; this channel carries a far stronger disguise, and it is one we built and can close.

**The criterion: a machine-local registry, and nothing else.** `<global home>/trusted-workspaces/<hash-of-normalised-path>.json` — outside the workspace, out of reach for repo authors, not forgeable. Any marker inside the workspace (seen files, db fields) can be pre-seeded along with the malicious library and is therefore unusable.

**Three registration points cover every legitimate flow:**

1. **Trust at creation** (getDb sees no memory.db → the plugin is about to create an empty one): but only if the `.dsh-meow` directory was empty or absent at that moment — the "PROJECT.md only, no db" attack would otherwise slip through creation-trust plus autoMigrate; a non-empty directory (the ignore set covers only runtime residue like memory.db*/dream-debug.log) is not registered;
2. **Upgrade seeding** (at apply, read `window-index.json` and register every workspace listed): that file also lives in the global home — unforgeable — and its semantics are exact: "actually opened on this machine before the upgrade" = a library from the trusted era; existing users never notice;
3. **The `/meow-trust` command** (human confirmation): the single interaction point for new machines / restored backups / hand-copied directories; writes the registry and takes effect immediately (every gate is a live check, no restart).

**Untrusted = everything paused** (same short-circuit points as disabledWorkspaces: no injection, no hit chain, no dream, no reflection, all tools refused, no PROJECT.md migration), plus a one-time notice on the first round (bookkeeping likewise in the registry). The failure directions are deliberately asymmetric: gate disabled / registry IO failure → **fail-open** (identical to 0.31.x behaviour; the trust machinery must never kill memory); corrupt registry file → **fail-closed** (back to untrusted, re-run `/meow-trust`; the cost is one repeated notice, not a silent bypass).

---

## See also

- [Tool reference](tool-reference.md) — the seven tools' parameters and returns
- [Configuration reference](configuration-reference.md) — every configuration field
- [Troubleshooting](troubleshooting.md) — install failures, poor search results, reading errors
