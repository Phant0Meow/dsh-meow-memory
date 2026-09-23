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
var ANY_ICON_SEL = `[${DREAM_ICON_ATTR}], [${DREAMING_ATTR}], [${SKIPPED_ATTR}]`;

// src/client-dream-skip.ts
var SKIP_ITEM_ATTR = "data-meow-skip-item";
var ROW_ACTIONS_SEL = '[class*="_rowActions"]';
var SESSION_ROW_SEL = '[role="treeitem"][class*="_sessionRow"]';
var MENU_OPEN_ROW_SEL = '[role="treeitem"][class*="_sessionRow"][class*="_menuOpen"]';
var MENU_WINDOW_MS = 1500;
function skipLabel(skipped2) {
  return skipped2 ? "\u53D6\u6D88\u8DF3\u8FC7\u68A6\u5883\u6574\u7406\u8BB0\u5FC6" : "\u8DF3\u8FC7\u68A6\u5883\u6574\u7406\u8BB0\u5FC6";
}
function setMenuIcon(item, skipped2) {
  const icon = item.querySelector("svg");
  if (icon !== null) icon.outerHTML = skipped2 ? MOON_SVG : makeSkipMoonSvg();
}
function captureSessionIdFromTarget(target) {
  const el = target;
  if (el === null || el === void 0 || typeof el.closest !== "function") return null;
  if (el.closest(ROW_ACTIONS_SEL) === null) return null;
  const row = el.closest(SESSION_ROW_SEL);
  if (row === null) return null;
  return readSessionId(row);
}
function retitleLeaf(root, text) {
  let leaf = null;
  const walk = (el) => {
    let hasElementChild = false;
    for (const c of el.children) {
      hasElementChild = true;
      walk(c);
    }
    if (!hasElementChild && (el.textContent ?? "").trim().length > 0) leaf = el;
  };
  walk(root);
  if (leaf === null) return false;
  leaf.textContent = text;
  return true;
}
function resolveMenuSessionId(doc, fallback) {
  const openRow = doc.querySelector(MENU_OPEN_ROW_SEL);
  if (openRow === null) return null;
  const sid = readSessionId(openRow);
  return sid !== null ? sid : fallback;
}
function injectSkipItem(menu, sessionId, host) {
  for (const old of Array.from(menu.querySelectorAll(`[${SKIP_ITEM_ATTR}]`))) {
    if (old.getAttribute("data-meow-session-id") === sessionId) return null;
    old.remove();
  }
  const template = menu.querySelector('[role="menuitem"]');
  if (template === null) return null;
  const item = template.cloneNode(true);
  item.removeAttribute("id");
  for (const el of Array.from(item.querySelectorAll("[id]"))) el.removeAttribute("id");
  item.setAttribute("role", "menuitem");
  if (!retitleLeaf(item, skipLabel(readSkipped(sessionId)))) return null;
  item.setAttribute(SKIP_ITEM_ATTR, "true");
  item.setAttribute("data-meow-session-id", sessionId);
  setMenuIcon(item, readSkipped(sessionId));
  const onClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const next = !readSkipped(sessionId);
    writeSkipped(sessionId, next);
    retitleLeaf(item, skipLabel(next));
    setMenuIcon(item, next);
    host.onToggle(sessionId, next, () => {
      writeSkipped(sessionId, !next);
      retitleLeaf(item, skipLabel(!next));
      setMenuIcon(item, !next);
    });
  };
  item.addEventListener("click", onClick, true);
  item.addEventListener("pointerdown", (e) => e.stopPropagation());
  menu.appendChild(item);
  return item;
}
var skipped = /* @__PURE__ */ new Set();
function readSkipped(sid) {
  return skipped.has(sid);
}
function writeSkipped(sid, val) {
  if (val) skipped.add(sid);
  else skipped.delete(sid);
}
function startDreamSkipManager() {
  let pendingSid = null;
  let pendingAt = 0;
  let observerTimer = 0;
  const syncOpenMenus = () => {
    const withinWindow = pendingSid !== null && Date.now() - pendingAt <= MENU_WINDOW_MS;
    const sid = resolveMenuSessionId(document, withinWindow ? pendingSid : null);
    if (sid === null) return;
    for (const menu of Array.from(document.querySelectorAll('[role="menu"]'))) {
      injectSkipItem(menu, sid, { onToggle: handleToggle });
    }
  };
  const observer = new MutationObserver((muts) => {
    if (pendingSid !== null && Date.now() - pendingAt <= MENU_WINDOW_MS) {
      const sid = resolveMenuSessionId(document, pendingSid);
      if (sid !== null) {
        for (const m of muts) {
          for (const node of Array.from(m.addedNodes)) {
            if (!(node instanceof HTMLElement)) continue;
            const menus = node.matches('[role="menu"]') ? [node] : Array.from(node.querySelectorAll('[role="menu"]'));
            for (const menu of menus) injectSkipItem(menu, sid, { onToggle: handleToggle });
          }
        }
        for (const menu of Array.from(document.querySelectorAll('[role="menu"]'))) {
          injectSkipItem(menu, sid, { onToggle: handleToggle });
        }
      }
    }
    window.clearTimeout(observerTimer);
    observerTimer = window.setTimeout(syncOpenMenus, 120);
  });
  const handleToggle = (sessionId, skip, rollback) => {
    void (async () => {
      try {
        const resp = await fetch("/meow-memory/skip-dreams", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, skip })
        });
        if (!resp.ok) throw new Error(String(resp.status));
      } catch {
        rollback();
      }
    })();
  };
  const onPointerDown = (e) => {
    const sid = captureSessionIdFromTarget(e.target);
    if (sid === null) return;
    pendingSid = sid;
    pendingAt = Date.now();
  };
  const refresh = async () => {
    try {
      const response = await fetch("/meow-memory/skip-dreams", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      skipped.clear();
      if (Array.isArray(data.sessionIds)) {
        for (const id of data.sessionIds) {
          if (typeof id === "string") skipped.add(id);
        }
      }
    } catch {
    }
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
        if (data.state === "skip") {
          skipped.add(data.sessionId);
        } else if (data.state === "unskip") {
          skipped.delete(data.sessionId);
        } else {
          return;
        }
        void syncOpenMenus();
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
  document.addEventListener("pointerdown", onPointerDown, true);
  observer.observe(document.body, { childList: true, subtree: true });
  connect();
  void refresh();
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    observer.disconnect();
    window.clearTimeout(observerTimer);
    window.clearTimeout(reconnectTimer);
    eventSource?.close();
    eventSource = null;
    for (const item of Array.from(document.querySelectorAll(`[${SKIP_ITEM_ATTR}]`))) item.remove();
  };
}
export {
  MENU_OPEN_ROW_SEL,
  SESSION_ROW_SEL,
  SKIP_ITEM_ATTR,
  captureSessionIdFromTarget,
  injectSkipItem,
  resolveMenuSessionId,
  retitleLeaf,
  setMenuIcon,
  skipLabel,
  startDreamSkipManager
};
