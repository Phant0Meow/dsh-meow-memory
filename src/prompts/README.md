# Prompt language packs

meow-memory 的 prompt 文案（v0.19.0+）是**数据文件，不是代码**：一个语言一个子目录，运行时读取。添加一门语言不需要改任何代码、不需要重新编译——翻译文件、跑自查、提 PR，就完成了。

Prompt texts are **data files, not code**: one directory per language, read at runtime. Adding a language = translating files + one green self-check + a PR. No code changes, no rebuild.

## Layout / 目录结构

```
src/prompts/
  zh/    ← key-set source of truth（真源）
  <lang>/ ← e.g. en（your translation）
```

`build.mjs` copies `src/prompts/` → `lib/prompts/`; the loader reads `lib/prompts/` at runtime.

## Slots / 槽位（8 个）

| file | kind | placeholders |
|---|---|---|
| `system-guide.md` | whole text | — |
| `reflect.md` | whole text | `{projectList}` |
| `dream-header.md` | whole text | `{timestamp}` `{idx}` `{total}` `{roundKind}` |
| `dream-atomic.md` | whole text | `{list}` |
| `dream-topic.md` | whole text | `{list}` |
| `dream-project-summary.md` | whole text | `{projects}` |
| `welcome-guide.md` | whole text | `{homePath}` |
| `labels.md` | key-value lines | per key（e.g. `{label}` `{name}` `{list}` `{n}`） |
| `tools.md` | key-value lines | — |

- **`zh/` is the key-set source of truth**: every slot & key in `zh` must exist in your language — no missing, no extras.
- **Whole-text slots**: translate freely; keep `{placeholders}` and place them where your grammar needs them.
- **Key-value slots**: lines shaped `- key: value` — keep **keys exactly as-is** (the code looks them up), translate **values** only. A line starting with two spaces continues the previous value.
- One value in `labels.md` is **not** decoration: `project.global` is the word the model writes into a memory's `project` field for globally applicable information, and the code matches on it. Pick a natural word in your language, keep it to one word, and don't reuse it as a real project name.
- Lines starting with `#` are comments; blank lines are ignored.

## Resolution order / 读取顺序（per slot, 逐槽位）

1. Instance overrides: `<home>/.dsh-meow/prompts/<lang>/<slot>.md` — users may override just the slots they care about
2. Built-in pack: `lib/prompts/<lang>/<slot>.md`
3. Fallback: built-in `zh/`（最终兜底）

## How to contribute a language / 贡献一门语言

1. Copy the truth source: `cp -r src/prompts/zh src/prompts/<your-lang>`
2. Translate the **values** (keys, slot filenames and `{placeholders}` stay as-is)
3. Self-check until green: `npm run check-lang -- <your-lang>`
4. Open a PR 🎉

## One more thing: the tokenizer / 分词器也是语言分支

`src/bm25.ts` → `tokenize()` branches on the same language (on its base code, so `en-US` → `en`, `zh-CN` → `zh`):

| lang | tokenizer |
|---|---|
| `zh` | character bigrams (Chinese has no spaces) + whole ASCII words |
| `en` | whole words, lowercased → stopwords dropped → Porter stemmer (`stemEn`) |
| anything else | **ASCII word baseline**, no normalization |

If your language needs stemming / lemmatization / its own segmentation, that function is yours to extend — PRs welcome. Keyword recall depends on query and memory entries being tokenized the same way, so this matters as much as the translations themselves.

Normalization lives **only** in `tokenize()`, so both sides of a match go through it and stay consistent; keywords are still stored verbatim, they are only normalized at match time. Anything language-specific you add belongs there too.

## Config / 用户配置

`promptLang` (plugin config, default `zh`) selects the directory. **Set it on first use** — it decides the language of injected prompts, tool descriptions, the memory entries the model writes, **and** the BM25 tokenizer; a mismatch between entry language and tokenizer kills keyword recall.
