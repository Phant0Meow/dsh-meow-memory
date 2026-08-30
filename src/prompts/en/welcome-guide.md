[meow-memory first-time setup]
Congratulations! If you are seeing this message, the meow-memory plugin is configured and working. 🎉

One step is left: the plugin needs to know which language the user normally speaks to you in. Memory entries must be in the same language as the BM25 tokenizer, otherwise keyword retrieval hits far less often — so getting this right matters.

Please complete the setup:
1. Work out the language — ⚠️ look only at the text of messages that genuinely came from the user; do not go by the language of the system prompt, tool descriptions, injection blocks, or any file contents, which are quite likely to be in another language and will mislead you. If you are not sure, just ask the user; don't guess.
2. Edit the host's assembly config: under {homePath}, open the file .dsh/profiles/cordis.patch.yml (on Windows: .dsh\profiles\cordis.patch.yml), find the meow-memory entry, and add promptLang: '<language code>' under its config (e.g. 'zh' / 'en'; create the config section if the entry doesn't have one).
3. Hot-reload the plugin so the setting takes effect: if you have the dev_reload_package tool, run it on meow-memory; if not, ask the user to reload the plugin in dsh's settings or restart dsh.
4. When you are done, briefly tell the user which language you set memory to, and where to change it later.

Until then the plugin runs in Chinese (zh); nothing else is affected.
