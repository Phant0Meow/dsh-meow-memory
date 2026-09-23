// src/client-fold.ts
var REFLECT_MARKER = "[meow-memory-reflect]";
var DREAM_MARKER = "[meow-memory-dream]";
var PLUGIN_NAME = "meow-memory";
function turnOf(node) {
  const location = node.location;
  if (location?.kind === "turn") return location.turn?.turn;
  if (location?.kind === "step") return location.turn?.turn;
  return void 0;
}
function contextText(node) {
  return blocksToText(node.data.content ?? []);
}
function isMemoryPrompt(node) {
  if (node.kind !== "context") return false;
  const source = node.data.source;
  if (source?.kind !== "plugin" || source.plugin !== PLUGIN_NAME) return false;
  const text = contextText(node);
  return text.includes(REFLECT_MARKER) || text.includes(DREAM_MARKER);
}
function variantOf(node) {
  const text = contextText(node);
  return text.includes(DREAM_MARKER) ? "dream" : "reflect";
}
function toolNameOf(node) {
  if (node.kind !== "tool-call") return void 0;
  const root = node.data.root;
  if (root === void 0) return void 0;
  if ("name" in root) return root.name;
  return root.call?.name;
}
function computeFoldGroups(snapshot) {
  const order = snapshot.chat.order;
  const nodes = snapshot.chat.nodes;
  const groups = [];
  for (const key of order) {
    const node = nodes.get(key);
    if (node === void 0 || !isMemoryPrompt(node)) continue;
    const turn = turnOf(node);
    if (turn === void 0) continue;
    const turnKeys = snapshot.chat.locations.getTurn(turn);
    const startIdx = turnKeys.indexOf(key);
    const keys = turnKeys.slice(startIdx === -1 ? 0 : startIdx).filter((k) => {
      const n = nodes.get(k);
      return n !== void 0 && n.kind !== "user" && n.kind !== "steering" && n.kind !== "turn-tail";
    });
    let rememberCount = 0;
    let updateCount = 0;
    let status = "done";
    for (const k of keys) {
      const n = nodes.get(k);
      if (n === void 0) continue;
      const name = toolNameOf(n);
      if (name === "memory_remember") rememberCount++;
      else if (name === "memory_update") updateCount++;
      if (n.kind === "assistant") {
        const data = n.data;
        if (data.status === "running") status = "running";
        else if (data.status === "interrupted" && status !== "running") status = "interrupted";
      }
    }
    groups.push({ id: key, variant: variantOf(node), keys, rememberCount, updateCount, status });
  }
  return groups;
}
function foldLabel(group, expanded) {
  const arrow = expanded ? "\u25BE" : "\u25B8";
  const title = group.variant === "dream" ? "\u8BB0\u5FC6\u68A6\u5883\u4EFB\u52A1" : "\u8BB0\u5FC6\u53CD\u601D";
  if (group.status === "running") return `${arrow} ${title}\u8FDB\u884C\u4E2D\u2026`;
  if (group.status === "interrupted") return `${arrow} ${title}\u5DF2\u4E2D\u65AD`;
  if (group.rememberCount > 0) return `${arrow} ${title} \xB7 \u65B0\u589E\u8BB0\u5FC6 ${group.rememberCount} \u6761`;
  if (group.updateCount > 0) return `${arrow} ${title} \xB7 \u5DF2\u66F4\u65B0 ${group.updateCount} \u6761`;
  return `${arrow} ${title} \xB7 \u65E0\u9700\u8BB0\u5FC6`;
}
function toolCallDetail(block) {
  let args = block.argsRaw;
  try {
    args = JSON.stringify(JSON.parse(block.argsRaw), null, 2);
  } catch {
  }
  return args.length > 0 ? `${block.name}
${args}` : block.name;
}
function blocksToText(blocks) {
  return blocks.map((block) => block.text ?? "").join("\n").trim();
}
var FIRST_INJECTION_MARKER = "===== \u957F\u671F\u8BB0\u5FC6 =====";
var HIT_INJECTION_MARKER = "\u53EF\u80FD\u76F8\u5173\u7684\u8BB0\u5FC6\uFF0C\u4EC5\u4F9B\u53C2\u8003\uFF1A";
var PROMPT_SEPARATOR = "\u672C\u8F6E\u7528\u6237prompt\uFF1A";
var EN_PROMPT_SEPARATOR = "This turn's user prompt:";
function computeInjectionGroups(snapshot) {
  const groups = [];
  for (const key of snapshot.chat.order) {
    const node = snapshot.chat.nodes.get(key);
    if (node === void 0) continue;
    if (node.kind === "context") {
      const source = node.data.source;
      if (source?.kind !== "plugin" || source.plugin !== PLUGIN_NAME) continue;
      const memKind = source.memory?.kind;
      if (memKind === "initial" || memKind === "reinjection") {
        groups.push({ id: key, kind: "first", injectedText: contextText(node) });
        continue;
      }
      if (memKind === "hit") {
        groups.push({ id: key, kind: "hit", injectedText: contextText(node) });
        continue;
      }
      if (source.form === "snapshot") {
        const injectedText = contextText(node);
        const isFirst = injectedText.startsWith(FIRST_INJECTION_MARKER) || injectedText.includes("LONG-TERM MEMORY");
        groups.push({ id: key, kind: isFirst ? "first" : "hit", injectedText });
      }
      continue;
    }
    if (node.kind !== "user") continue;
    const content = node.data.content ?? [];
    if (content.length === 0 || content.some((b) => b.type !== "text")) continue;
    const text = blocksToText(content);
    if (text.length === 0) continue;
    let kind = null;
    if (text.startsWith(FIRST_INJECTION_MARKER) || text.includes("LONG-TERM MEMORY") || text.includes("===== \u957F\u671F\u8BB0\u5FC6 =====")) kind = "first";
    else if (text.startsWith(HIT_INJECTION_MARKER) || text.includes("Possibly relevant memories") || text.includes("\u53EF\u80FD\u76F8\u5173\u7684\u8BB0\u5FC6")) kind = "hit";
    if (kind === null) continue;
    const sep = text.includes(PROMPT_SEPARATOR) ? PROMPT_SEPARATOR : text.includes(EN_PROMPT_SEPARATOR) ? EN_PROMPT_SEPARATOR : null;
    if (sep === null) continue;
    const sepIdx = text.lastIndexOf(sep);
    const userText = text.slice(sepIdx + sep.length).replace(/^\n+/, "");
    const time = typeof node.data.time === "number" ? node.data.time : void 0;
    groups.push({ id: key, kind, injectedText: text.slice(0, sepIdx + sep.length), userText, time });
  }
  return groups;
}
function formatInjectionClock(time, now = Date.now()) {
  const d = new Date(time);
  const n = new Date(now);
  const pad = (value) => String(value).padStart(2, "0");
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return clock;
  const md = d.getFullYear() === n.getFullYear() ? `${d.getMonth() + 1}\u6708${d.getDate()}\u65E5` : `${d.getFullYear()}\u5E74${d.getMonth() + 1}\u6708${d.getDate()}\u65E5`;
  return `${md} ${clock}`;
}
export {
  DREAM_MARKER,
  EN_PROMPT_SEPARATOR,
  FIRST_INJECTION_MARKER,
  HIT_INJECTION_MARKER,
  PLUGIN_NAME,
  PROMPT_SEPARATOR,
  REFLECT_MARKER,
  blocksToText,
  computeFoldGroups,
  computeInjectionGroups,
  foldLabel,
  formatInjectionClock,
  toolCallDetail
};
