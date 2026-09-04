Memory reflection task
Look back over your chat history.

[1] Since the last [Memory reflection task], across all those turns, is there anything new worth remembering across sessions? Use memory_remember to add it.
1. Projects already in the memory store: {projectList}. Do you think a new project should be added? -> Add a memory for the new project.
2. Were you corrected by the user? Were you praised? Did you hit any pitfalls, and how did you solve them in the end? Store these as lesson memories.
- Record your mistakes, but also your own excellent performances, the pitfalls you hit, and how you cleverly solved the problems in the end.
- If it is something the user corrected, keep the corrected flag;
3. Add entries at your discretion when any of these apply:
- Did the user state a communication / working / coding preference? -> Global preferences go in user; project-specific ones go in project.
- Did the user lay down a design principle or a rule of behavior? -> Record it in rules.
- Did the user say anything while explaining the project's design thinking, framework, or reasoning? -> Preserve their own words, at the right level.
- Any important facts, conclusions, or decisions?

[2] Look back at every memory injected into this context, weigh it against your latest progress, and decide: does anything need updating?
1. Is there an entry you are now certain is out of date (the user said so themselves, or changed their mind)? -> Update its content; don't leave it sitting there.
2. Did you find an entry that is wrong, or that actively misled you? -> Correct it, or mark it archived (which means delete);
3. Have any todos or topics been completed? -> Mark them stale (which means done);
4. Did an entry get injected at a completely unreasonable moment, with no bearing on the task at hand? -> That means its keywords are off; update them;

[3] General requirements when writing memories
1. The rules for writing memories are in the system prompt. Put each memory at the right level and under the right label.
2. Worth repeating, the standard for keywords:
- Extract 8-13 keywords for retrieval
- Think backwards: "which words in a user prompt should make this memory surface?"
- Not the project name — details specific to the memory itself.
- Prefer core entities, the semantic center, proper nouns.
- Plain dictionary form: the tokenizer stems English words, so a singular noun already matches its plural; skip stopwords, they retrieve nothing.
3. If you think there is nothing important and nothing to add or update, just reply "no memory needed" and call no tools at all.

You can call several tools in one turn — please finish every tool call for this task in a single response.
