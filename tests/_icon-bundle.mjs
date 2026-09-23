// src/client-dream-icon.ts
var DREAM_ICON_ATTR = "data-meow-dreamed";
var DREAMING_ATTR = "data-meow-dreaming";
var SKIPPED_ATTR = "data-meow-skip-dream";
var MOON_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
var SKIP_MOON_PATH = "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z";
var SKIP_SLASH_PATH = "M2.5 2.5l19 19";
function makeSkipMoonSvg() {
  const id = `meow-skip-${Math.random().toString(36).slice(2, 10)}`;
  return `<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><defs><mask id="${id}"><rect width="24" height="24" fill="#fff"/><path d="${SKIP_SLASH_PATH}" fill="none" stroke="#000" stroke-width="4.4" stroke-linecap="round"/></mask></defs><g mask="url(#${id})"><path fill="currentColor" d="${SKIP_MOON_PATH}"/></g><path d="${SKIP_SLASH_PATH}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`;
}
var ICON_CSS = `[${DREAM_ICON_ATTR}],
[${DREAMING_ATTR}],
[${SKIPPED_ATTR}] {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 10px;
  height: 10px;
}
[${DREAM_ICON_ATTR}] { color: #e9c46a; opacity: 0.9; } /* \u6DE1\u9EC4\u505C\u9A7B */
[${DREAMING_ATTR}] {
  color: #f2c14e;
  animation: meow-dream-breathe 2.4s ease-in-out infinite;
}
@keyframes meow-dream-breathe {
  0%, 100% { color: #fff8e6; opacity: 0.55; }
  50% { color: #f2c14e; opacity: 1; }
}
[${SKIPPED_ATTR}] { color: #94a3b8; opacity: 0.85; } /* \u9759\u97F3\u7070\uFF1A\u8FD9\u6247\u7A97\u4E0D\u505A\u68A6 */
[data-meow-inline-icon] { margin-right: 4px; } /* \u65E0\u72B6\u6001\u69FD\u4F4D\u7684 flat \u89C6\u56FE\uFF1A\u884C\u9996\u5185\u8054 */
`;
var FIBER_KEY_RE = /^__reactFiber\$/;
function readSessionId(row) {
  let fiber = null;
  for (const key of Object.keys(row)) {
    if (FIBER_KEY_RE.test(key)) {
      fiber = row[key];
      break;
    }
  }
  let cur = fiber;
  for (let depth = 0; depth < 8 && cur !== null && cur !== void 0; depth++) {
    const f = cur;
    if (typeof f.key === "string" && f.key.length > 0) return f.key;
    cur = f.return;
  }
  return null;
}
function makeIcon(state) {
  const icon = document.createElement("span");
  icon.setAttribute(attrForState(state) ?? DREAM_ICON_ATTR, "true");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = state === "skipped" ? makeSkipMoonSvg() : MOON_SVG;
  return icon;
}
function attrForState(state) {
  if (state === "dreaming") return DREAMING_ATTR;
  if (state === "dreamed") return DREAM_ICON_ATTR;
  if (state === "skipped") return SKIPPED_ATTR;
  return null;
}
var ANY_ICON_SEL = `[${DREAM_ICON_ATTR}], [${DREAMING_ATTR}], [${SKIPPED_ATTR}]`;
var SESSION_ROWS_SEL = 'div[role="treeitem"][class*="_sessionRow"]';
function mergeIconStates(dreamStates, skippedIds) {
  const merged = /* @__PURE__ */ new Map();
  for (const [id, state] of dreamStates) merged.set(id, state);
  for (const id of skippedIds) {
    if (merged.get(id) !== "dreaming") merged.set(id, "skipped");
  }
  return merged;
}
function applyDreamIcons(states, rows) {
  const all = rows ?? document.querySelectorAll(SESSION_ROWS_SEL);
  for (const row of all) {
    const id = readSessionId(row);
    const state = id !== null ? states.get(id) : void 0;
    const wantAttr = attrForState(state);
    const slot = row.querySelector('[class$="_slot"]');
    if (slot !== null) {
      const cur = slot.querySelector(ANY_ICON_SEL);
      const consistent = cur !== null && wantAttr !== null && cur.getAttribute(wantAttr) === "true";
      if (state !== void 0 && !consistent) {
        slot.replaceChildren(makeIcon(state));
      } else if (state === void 0 && cur !== null) {
        cur.remove();
      }
    } else if (state !== void 0) {
      const cur = row.querySelector(ANY_ICON_SEL);
      const consistent = cur !== null && cur.getAttribute(wantAttr ?? "") === "true";
      if (!consistent) {
        cur?.remove();
        const icon = makeIcon(state);
        icon.setAttribute("data-meow-inline-icon", "true");
        row.insertBefore(icon, row.firstChild);
      }
    } else {
      row.querySelector(ANY_ICON_SEL)?.remove();
    }
  }
}
function startDreamIconManager() {
  const dreamStates = /* @__PURE__ */ new Map();
  const skippedIds = /* @__PURE__ */ new Set();
  let timer = 0;
  const replay = () => applyDreamIcons(mergeIconStates(dreamStates, skippedIds));
  const refreshSkips = async () => {
    try {
      const response = await fetch("/meow-memory/skip-dreams", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      skippedIds.clear();
      if (Array.isArray(data.sessionIds)) {
        for (const id of data.sessionIds) {
          if (typeof id === "string") skippedIds.add(id);
        }
      }
    } catch {
    }
  };
  const refresh = async () => {
    try {
      const response = await fetch("/meow-memory/dreamed-sessions", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      dreamStates.clear();
      if (Array.isArray(data.sessionIds)) {
        for (const id of data.sessionIds) {
          if (typeof id === "string") dreamStates.set(id, "dreamed");
        }
      }
      if (Array.isArray(data.dreamingIds)) {
        for (const id of data.dreamingIds) {
          if (typeof id === "string") dreamStates.set(id, "dreaming");
        }
      }
    } catch {
    }
    await refreshSkips();
    replay();
  };
  let eventSource = null;
  let reconnectTimer = 0;
  const connect = () => {
    eventSource?.close();
    eventSource = new EventSource("/meow-memory/dream-events");
    eventSource.addEventListener("dream", (raw) => {
      try {
        const data = JSON.parse(raw.data);
        if (typeof data.sessionId !== "string") return;
        if (data.state === "dreamed" || data.state === "dreaming") dreamStates.set(data.sessionId, data.state);
        else if (data.state === "skip") skippedIds.add(data.sessionId);
        else if (data.state === "unskip") skippedIds.delete(data.sessionId);
        else dreamStates.delete(data.sessionId);
        replay();
      } catch {
      }
    });
    eventSource.onopen = () => {
      void refresh();
    };
    eventSource.onerror = () => {
      eventSource?.close();
      eventSource = null;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, 6e4);
    };
  };
  for (const stale of Array.from(document.querySelectorAll("style[data-meow-dream-icon-css]"))) {
    stale.remove();
  }
  const style = document.createElement("style");
  style.dataset.meowDreamIconCss = "true";
  style.textContent = ICON_CSS;
  document.head.appendChild(style);
  const observer = new MutationObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(replay, 120);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  connect();
  void refresh();
  return () => {
    observer.disconnect();
    window.clearTimeout(timer);
    window.clearTimeout(reconnectTimer);
    eventSource?.close();
    eventSource = null;
    style.remove();
    for (const el of Array.from(document.querySelectorAll(`[${DREAM_ICON_ATTR}], [${DREAMING_ATTR}], [${SKIPPED_ATTR}]`))) el.remove();
  };
}
export {
  DREAMING_ATTR,
  DREAM_ICON_ATTR,
  MOON_SVG,
  SESSION_ROWS_SEL,
  SKIPPED_ATTR,
  applyDreamIcons,
  makeSkipMoonSvg,
  mergeIconStates,
  readSessionId,
  startDreamIconManager
};
