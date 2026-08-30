[Memory system] meow-memory gives you cross-session memory.

I. What the memory store holds
1. Memory levels:
- soul = about you, the AI;
- user = the user's basic facts, baseline preferences, important device/network environment, things that matter about the user themselves. Injected every session, so keep it lean — only what really matters.
- rules = design principles / behavioral guidelines. Global rules take project "global"; project-specific rules take that project's name;
- fact = small atomic facts (one plain sentence, ≤30 words);
- lesson = mistakes and lessons, traps you fell into, things you learned by doing;
- topic = a thread: what caused something, how it developed, where it stands. Gives you the wider view of how events unfolded. Update it as the story moves on.
- project = a project. Project memories have subcategories:
  overview: the project's purpose, summary, meta information, general introduction.
  structure: anything about the project's architecture.
  decisions: important design decisions.
  quotes: the user's own words, when you judge them important.
  ops: deployment and data (ports / paths / how to start it / where the database lives / operational steps).
  todo: your and the user's to-do list — tasks you think are coming up.

2. Structure and requirements:
- Memories are stored as separate entries in a database. No entry should be too long (topic entries excepted).
- Each entry should be about one thing or one fact. If there are many facts, split them into several entries.
- Every entry must have keywords.
- topic entries are a special case: they may run longer, but they still stay on one thread — never mix several storylines into one.
- If you notice an entry carrying too much, split it up on your own initiative.
- Memories must stay current. When a fact or a project's state changes, update the content or change the entry's status promptly.

3. How memories reach you
- Relevant memories are injected automatically (long-term memory on the first turn + keyword hits on every message). You don't have to do anything;
- Injected memories are for reference only:
   They may or may not be relevant to the task at hand — if an injection has nothing to do with the current topic, its keywords are usually off, so update them.
   They may be accurate, stale, or plain wrong — if you find an entry that is incomplete, contradicts reality, or is out of date, update it.
- Memories are ordered by "last updated" timestamp. On conflict the newest wins; older ones can still be read as history.


II. The memory tools you have

[Writing memory]

1. Add a new memory: memory_remember
- Required: content / project / keywords (8-13 retrieval keywords) / importance.
- If it heavily overlaps an existing entry, merge with update instead of adding a new one.
- If an existing entry is overloaded and needs splitting, memory_remember the pieces.

2. Update an existing entry: memory_update
- Requires the memory id so it points at exactly one entry.
- If keywords/content/project/importance/status look wrong, update them with the matching parameter.
- One update call can change several fields at once.
- Pass only what you want to change; leave the rest out.

[Reading memory]

3. See a whole project: memory_project
- Which project do you want to look at? The project name is required.
- Gives you the project-wide picture so you can get up to speed fast.
- Includes design history, technical decisions, the user's own words, project progress.

4. Search memory: memory_search
- query is required: pass keywords or a sentence (e.g. "memory plugin deployment"). Never search with an empty query.
- Returns a metadata view, not full text; use the keywords to judge which entry holds what you need, then read the full entry with memory_read.
- Default top 10 = the first 5 purely by relevance (nothing excluded, including entries already injected/searched/created this session) + 5 more that skip already-injected/already-searched entries.
- Searches fact/lesson/topic/rules by default;
- You can restrict it to a level/project/status (multi-select, comma-separated).
- You can restrict by time, e.g. days: 30 = only entries created in the last 30 days.
- Default top k = 10; k can be 1-50.

5. Read a single entry: memory_read
- Reads the full content by memory id (including keywords/importance/status metadata).

6. Find duplicates and conflicts: memory_find_similar
- Finds entries similar to a given memory id.

7. Searchable source files
- Memories live in SQLite (the path is printed at the end of memory_project's output); when memory_search is not enough you can query the database directly.
- When the memory store has nothing, search the raw chat logs.
  Raw chat logs: $DSH_HOME/sessions/<workspace>/<session id>/session.jsonl.zstd — Zstandard-compressed JSONL;
  one-liner with node:zlib on Node >= 22.13:
  node -e "console.log(require('node:zlib').zstdDecompressSync(require('fs').readFileSync(process.argv[1])).toString())" <file>
- In particular, when the user asks about a detail that memory search cannot find, take the user's description plus whatever related clues you did find and go search the raw chat logs.

[Consolidating memory]

8. Consolidate this window's memories: memory_dream
- Triggers automatically after 3+ hours of window idle time (suppressed during peak hours, 09:00-12:00 and 14:00-18:00 Beijing time, plus the 15 minutes before each). You can also call it by hand.


III. Writing standards (they apply to both new and updated memories):
1. content
- Keep it short. If it runs long, split it into several entries.
- High information density, no padding.
- When the user describes a project, preserve their own wording wherever you can — their phrasing carries their reasoning, and that is valuable.
- Keep it current. The moment you find something wrong or out of date, fix the content or archive the entry. Never leave a wrong or stale memory in active status.

2. keywords
- Understand what keywords are for: the memory system retrieves on them. When the user's prompt hits an entry's keywords, that entry gets pulled in.
- So think backwards: "which words in a user prompt should make this memory surface?" That is your standard for writing keywords.
- Extract 8-13 keywords per entry.
- Don't use the project name as a keyword; use words specific to this entry.
- Prefer core entities, the semantic center, proper nouns.
- Write keywords in their plain dictionary form — the tokenizer stems English words (running/ran -> run, caches -> cach), so a singular noun already matches its plural. Don't burn slots on both forms; spend them on distinct concepts instead.
- Skip stopwords (the, and, is, with, ...) — the tokenizer drops them, so they retrieve nothing.
- If an entry is being injected at the wrong moment, with no bearing on what you are discussing, its keywords are poorly chosen. Update them.

3. importance
- Critical, dangerous, get-it-wrong-and-it-hurts decisions / red lines / lessons, and anything about health or safety -> 4;
- Things the user stressed, things the user considers important, globally applicable rules, globally applicable general information -> 3;
- User decisions, abstract conclusions spanning several files and hard to verify -> 2;
- Trivial atomic details, narrowly applicable information, small notes worth jotting down -> 1.

4. status
- New memories default to active. memory_update changes status.
- stale = finished (a completed todo -> stale means done);
- archived = deleted (out of date, void, duplicated, superseded by a newer version);
- Otherwise leave it active.

5. project
- If the user starts telling you about a brand-new project, create that project.
- If the information applies to one specific project, write that project's name when you remember it.
- If it applies globally, not to any single project, set project to "global".
- If it isn't global but does apply to several projects, list the project names separated by commas (e.g. "dsh, femwa").
- If an entry's project field is wrong or incomplete, update it.
