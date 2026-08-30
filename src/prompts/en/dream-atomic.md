[Entries in this group]: {list}

The [Entries in this group] list above is the entire scope of this round: the entries you created yourself, plus the ones you saw in this window through injection, search, or memory_read. That is where the scope ends — don't try to recall entries you "saw but that aren't listed".
Is there anything here you think should be tidied up or updated? If so, update it.

## How to decide something needs updating — go through the list above entry by entry and ask yourself:
1. Was anything recorded wrongly or one-sidedly, has it gone out of date, does it need new information, did the user change their mind, has there been new progress? -> Update the content promptly; the memory store should match the project's latest state.
2. Was any design or piece of information overturned, changed, or proven not to work? -> Set status=archived. Never leave those active or stale. stale only means "finished" (a todo done, a topic that reached its goal), not "void"; superseded approaches and conclusions left in the store will only mislead later sessions.
3. Are there completed todo entries? -> Set status=stale (which means done);
4. Are there entries that are wrong, too trivial, or that you now think don't matter at all? -> Set status=archived;
5. Have bugs been fixed, or lessons stopped applying? -> Change the content, or set status=archived;
6. Did you find entries that contradict each other? -> Fix them according to what you know to be true. Keep the newest fact, archive the older version;
7. Looking back now, is each entry's importance right (check it against the memory system's importance rules)? Note: don't mark things important lightly — work-in-progress entries are usually 1, at most 2; only something serious deserves 3. Where it is inflated, lower it;
8. Is any entry too long, carrying too much? -> Split it into several, using update to rewrite and remember to create the new ones.
9. Are the keywords accurate? -> If they are, leave the keywords parameter out; if you think they are off, fix them with memory_update's keywords parameter — when the user's prompt hits an entry's keywords, that entry gets pulled in. So think backwards: "which words in a user prompt should make this memory surface?" That is your standard. Don't use the project name as a keyword; use words specific to the entry. Prefer core entities, the semantic center, proper nouns. Plain dictionary form — the tokenizer stems English words, so a singular already matches its plural, and stopwords retrieve nothing. 8-13 of them.
10. Are the project labels right? Is anything labeled with a project when it is really global information? Then the project label should go. Does anything clearly belong to a project but carry no project information? Then add it.
11. Learning without reflection is wasted — generalize more:
- This is an excellent moment to abstract and consolidate. Are there general rules worth distilling? Add them as new memories.
- You may now understand some entries better and more deeply than when you wrote them. Update them.
12. Look at what gets injected on the first turn. Do you still think all of it matters? Does it really need to be injected at the start of every session? Anything that doesn't, you can lower in importance or move to another level (fact, for instance).
The first turn injects only: soul (the AI itself) / user (the user's preferences) / global rules (importance>=2). To get something into the first turn: a global rule -> move it to rules with importance>=2 (project "global"); something about the user -> move it to user; something about you -> move it to soul.
13. memory_project shows project-level entries (completed todos, only the 5 most recent) plus project-specific rules; the checks above apply there too (completed todos go stale, out-of-date entries go archived, project labels stay accurate).

Notes:
Important: go through them one by one, and archive or fix memories that are out of date or that mislead you — prefer archiving.
For a memory you consider very important, if you are unsure what the truth is, go read the project's files and check. Only for memories that really matter.
When you are finished, reply "this group is consolidated" and call no other tools.

You can call several tools in one turn — please finish every tool call for this task in a single response.
