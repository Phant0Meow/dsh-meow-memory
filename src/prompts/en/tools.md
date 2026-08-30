# meow-memory tool copy (key-value lines: `- key: value`; the first ASCII colon+space is the separator, the value is kept verbatim; a line starting with two spaces continues the previous value. `###` headings are for readers only and are ignored by the parser.
# Key convention: <tool>.description / <tool>.param.<name> / <tool>.out.<path>. A missing key throws; new keys must be mirrored in src/tools.ts.)

### memory_remember

- memory_remember.description: Write something worth remembering across sessions into this workspace's memory store (SQLite, one table per level). Required: content / project ("global", or a project name; comma-separate several) / keywords (8-13 retrieval keywords) / importance. Leaving one out raises an error asking you to fill it in. Levels: soul=the AI itself (use sparingly); user=the user's basic facts and baseline preferences; project=a project (e.g. femwa/meow-memory/meow-eyes/dsh); rules=design principles / behavioral guidelines (a global rule takes project "global", and with importance>=2 it is injected in full on the first turn;  a project-specific rule takes that project's name and is injected with memory_project; everything else surfaces through search); fact=small atomic facts (one plain sentence, <=30 words); lesson=mistakes and lessons (anything you were corrected on belongs here); topic=a thread (give it a goal sentence; retrieved by keywords). Hard rule: when the user explains a project's design thinking, framework, or the reasoning behind a decision, content must preserve the user's own wording — do not paraphrase or summarize it away. Entries that heavily overlap an existing one are merged automatically (updated, not duplicated). The tool confirms on success — no need to call it again.
- memory_remember.param.content: What to remember; fact/lesson one sentence <=30 words; topic <=180 words; wherever the user's own words are involved, keep their wording.
- memory_remember.param.level: Memory level, default fact.
- memory_remember.param.project: Required. Project name (must be a concrete project name when level=project); use "global" for globally applicable information; comma-separate several projects, e.g. "dsh,femwa".
- memory_remember.param.subcategory: project subcategory: overview=purpose and summary / structure=architecture / decisions=technical decisions / quotes=the user's own words / ops=deployment and data / todo=in progress.
- memory_remember.param.goal: The topic's goal sentence (recommended when level=topic, e.g. "get the femGen integration working").
- memory_remember.param.importance: Importance (any number, no upper bound; soft guide 1-4: 4=fatal red line / health and safety, 3=stressed by the user / globally applicable, 2=a user decision or an abstract conclusion, 1=trivia).
- memory_remember.param.corrected: Whether this is something the user corrected (for level=lesson).
- memory_remember.param.keywords: Keywords you choose (the reflection/dream rounds ask for 8-13 content words; omit it and they are extracted automatically).
- memory_remember.out.keywords: The keywords actually stored (auto-extracted; after a merge, the latest value).
- memory_remember.out.project: The project actually recorded (if any).

### memory_search

- memory_search.description: Search this workspace's memory store (BM25 x recency weight). query is required and must not be empty — pass the keywords or sentence you are looking for, e.g. memory_search({query: "memory plugin deployment"}); to browse a whole project use memory_project (no query needed), don't call this tool with an empty query. What comes back (the user's call): default top 10 = the first 5 straight off the relevance ranking (nothing excluded, including entries already injected/searched/created this session) + 5 more taken from further down the ranking while skipping already-injected/already-searched entries (so you get fresh material). Default scope = fact+lesson+topic+rules; level accepts a comma-separated list (e.g. fact,lesson); pass level=project for the project-wide view. Results are taken top-k by relevance and then re-sorted by memory timestamp (old -> new), so you can see how things developed and which of two conflicting entries is newer.
- memory_search.param.query: Search keywords or sentence (required, must not be empty; e.g. "memory plugin deployment").
- memory_search.param.level: Restrict to levels, comma-separated: fact/lesson/topic/rules/project/soul/user (default fact,lesson,topic,rules).
- memory_search.param.project: Filter by project name (comma-separated, OR semantics, e.g. "dsh,femwa"; "global" and unlabeled entries are always included).
- memory_search.param.status: Filter by status (comma-separated: active/archived/stale/all; default active, where a stale todo counts as completed and still participates; including all = no filter).
- memory_search.param.days: Only entries created in the last N days (by creation time).
- memory_search.param.k: Maximum number of results.
- memory_search.param.content_max: Truncate each entry's content to this length, 0=full text.
- memory_search.out.note: Conflict note.
- memory_search.out.hits.id: Full memory id (pass it to memory_read/memory_update/memory_find_similar).
- memory_search.out.hits.keywords: The entry's keywords (extracted by an LLM or automatically).
- memory_search.out.hits.project: Project the entry belongs to; ""=unlabeled; globally applicable entries read "global".
- memory_search.out.hits.updated_at: Memory timestamp (last update, in milliseconds).

### memory_find_similar

- memory_find_similar.description: Find entries similar to a given memory id (cosine over term-frequency vectors) — for spotting duplicates, finding conflicts, and checking whether something close to this entry already exists. Like search, it only looks at memories created in other sessions; anything already seen in this session (injected or searched) is excluded automatically.
- memory_find_similar.param.id: The reference memory id (the full id from memory_read/search results, or its first 12 characters).
- memory_find_similar.param.k: Number of results.
- memory_find_similar.param.content_max: Truncate each entry's content to this length, 0=full text.
- memory_find_similar.out.hits.similarity: Cosine similarity 0-1; higher is closer.

### memory_read

- memory_read.description: Read one memory in full (including title/keywords/importance/status metadata).
- memory_read.param.id: Memory id (from the injection block or a memory_search result).

### memory_update

- memory_update.description: Update a memory (content / importance / status / project / topic goal sentence / keywords, ...). status values: active / stale (finished: a completed todo, a topic that reached its goal -> stale means done) / archived (deleted: out of date, void, duplicated, or superseded entries).
- memory_update.param.id: Memory id.
- memory_update.param.content: New content (when rewriting a topic: cause, course, development, outcome, <=180 words).
- memory_update.param.status: New status.
- memory_update.param.importance: New importance (any number, no upper bound; soft guide 1-4: 4=fatal red line / health and safety, 3=stressed by the user / globally applicable, 2=a user decision or an abstract conclusion, 1=trivia).
- memory_update.param.goal: New goal sentence (topic).
- memory_update.param.project: New project name (project/fact/lesson/rules/topic); use "global" for globally applicable information; comma-separate several projects; an empty string clears it (unlabeled).
- memory_update.param.keywords: Keywords you choose (fix or extend them whenever you notice they are off; omitting the parameter or passing an empty array leaves the keywords untouched).

### memory_project

- memory_project.description: Retrieve a project's complete injection block from the memory store (plain text, grouped by subcategory, every entry that is not out of date at once). project is required: which project do you want to see? Calling without it raises an error, so settle on the project name first. Call it when the user brings up a project (femwa/meow-memory/meow-eyes/dsh, ...) and asks about its design history, technical decisions, their own past words, or where it stands; also whenever you need the project-wide picture before you answer. Rules: within a group, entries run old -> new by memory timestamp; the todo subcategory prints "Done:" (the 5 most recently completed) followed by "To do list:"; every entry carries its full id, its last-updated timestamp, and its text.
- memory_project.param.project: Project name (the memory guide at the start of the session lists every project the user has — pick from it).
- memory_project.out.text: The project's memory block, grouped by subcategory (plain text).

### memory_dream

- memory_dream.description: Schedule a memory consolidation (dream) for this window right now: everything this window created or pulled up is sent to the main agent round by round to be tidied and put away (round 1 = atomic memories, project/fact/lesson/rules/soul/user; round 2 = topic memories; round 3 = project summary, added only when this window actually touched a project). It triggers automatically after 3+ hours of window idle time (suppressed during peak hours, 09:00-12:00 and 14:00-18:00 Beijing time, plus the 15 minutes before each); this tool is the manual trigger.
