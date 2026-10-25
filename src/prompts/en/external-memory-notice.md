【meow-memory external memory notice】
This workspace ships a memory library that was not created on this machine (.dsh-meow/). To prevent repo-provided content from being injected as the user's own long-term memory, meow-memory is paused in this workspace: no injection, no retrieval, no dream consolidation, no writes, and memory tools are disabled.

- This typically happens after cloning an external repository that carries its own .dsh-meow/ (zero-interaction injection is designed for local memories; for pre-seeded libraries it is a security risk, issue #64).
- If this is the user's own project (new machine / restored backup / copied directory), have them run /meow-trust in the composer to re-enable — takes effect immediately, no restart needed.
- If the user does not recognize this library, simply keep it paused; the workspace can also be added to the disabledWorkspaces list.

This notice appears only once and needs no reply; if the user asks why their memory "disappeared", the points above are the answer.
