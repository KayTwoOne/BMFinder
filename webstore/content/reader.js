/* Content script: turn the page the browser just rendered into structured data.

   Classic script, not a module. It relies on lib/extract.js having been injected
   first (see the content_scripts order in manifest.json).

   Two things make this trickier than reading a static document:

   1. BattleMetrics is a single page app, so at document_idle the interesting parts
      are often still empty. We poll until extraction succeeds rather than reading
      once and recording a blank.
   2. Navigating inside the app does not reload the page, so a load listener alone
      would only ever see the first URL. We watch for the URL changing instead. */

(function () {
  "use strict";

  const EX = globalThis.BMExtract;
  if (!EX) return;

  const RENDER_TIMEOUT_MS = 12000;
  const POLL_MS = 250;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function build(type, url) {
    if (type === "player") {
      const p = EX.extractPlayer(document, url);
      return p && p.name ? p : null;
    }
    if (type === "server") {
      const s = EX.extractServer(document, url);
      if (!s) return null;
      // A rendered roster is ready. So is a server the page reports as 0 players:
      // that is a genuinely empty or offline server, not a failed read. Only keep
      // waiting when the count is above 0 but no names have painted yet.
      if (s.roster.length > 0) return s;
      if (s.info.players === 0 && s.info.name) return s;
      return null;
    }
    if (type === "identifiers") {
      const r = EX.extractIdentifiers(document, url);
      return r && r.names.length ? r : null;
    }
    if (type === "search") {
      const r = EX.extractSearch(document, url);
      return r.length ? { results: r } : null;
    }
    if (type === "serversearch") {
      const r = EX.extractServerSearch(document);
      return r.length ? { servers: r } : null;
    }
    return null;
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch {
      // Extension reloaded or context torn down; nothing useful to do here.
    }
  }

  let lastReported = "";

  async function reportCurrentPage() {
    const url = location.href;
    const type = EX.detectPageType(url, document);
    if (type === "unknown") return;

    // Search pages are never auto-reported. An empty form is not a failure, and a
    // results page is read on demand through DRIVE_SEARCH / READ_SEARCH, which know
    // whether a query actually ran. Reporting here produced a false "page reading is
    // broken" banner on every search. Sessions are the same shape: read on demand
    // via READ_SESSIONS, and a player with no sessions is a valid empty answer, not
    // a failed read.
    if (type === "search" || type === "serversearch" || type === "sessions") return;

    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    let data = null;
    while (Date.now() < deadline) {
      data = build(type, url);
      if (data) break;
      await sleep(POLL_MS);
    }

    // The URL can change while we wait; if it has, this result is stale.
    if (location.href !== url) return;

    const key = type + "|" + url + "|" + JSON.stringify(data && (data.name || data.info || "")).slice(0, 120);
    if (key === lastReported) return;
    lastReported = key;

    if (data) {
      send({ type: "PAGE_DATA", pageType: type, url, data });
    } else {
      send({ type: "EXTRACT_FAILED", url, failures: EX.selfTest(document, url).failures });
    }
  }

  // Initial render.
  reportCurrentPage();

  // In-app navigation. pushState and replaceState do not fire events of their own.
  let href = location.href;
  const onNav = () => {
    if (location.href === href) return;
    href = location.href;
    reportCurrentPage();
  };
  for (const fn of ["pushState", "replaceState"]) {
    const orig = history[fn];
    history[fn] = function () {
      const out = orig.apply(this, arguments);
      queueMicrotask(onNav);
      return out;
    };
  }
  window.addEventListener("popstate", onNav);

  // Fallback for route changes that bypass the History API entirely.
  new MutationObserver(onNav).observe(document.documentElement, { childList: true, subtree: true });

  /* Player search has to be driven, not navigated. The query string alone does
     nothing: loading /players?q=X server-renders a default player list. The real
     search is the site's own form, and on a logged-in account that form is the full
     Player Search panel (a "Player Name" field plus filters and a separate Search
     button). Typing without pressing Search is why a query would appear in the box
     and then nothing happened.

     So: fill the field, then actually submit. Submitting may navigate, which tears
     down this content script, so the worker also reads the page again afterwards.
     Server search is different, that page does honour ?q= and is plain navigation. */

  /** The player-name field, by id, then by name, then by its visible label. */
  function findSearchInput(doc) {
    const direct = doc.querySelector(
      '#input-search, input[name="search"], input[name="playerName"], form.player-search input[type="text"]'
    );
    if (direct) return direct;
    for (const label of doc.querySelectorAll("label")) {
      if (!/player\s*name/i.test(label.textContent || "")) continue;
      const forId = label.getAttribute("for");
      const byFor = forId && doc.getElementById(forId);
      if (byFor) return byFor;
      const inside = label.querySelector('input[type="text"], input:not([type])');
      if (inside) return inside;
      const near = label.parentElement && label.parentElement.querySelector('input[type="text"], input:not([type])');
      if (near) return near;
    }
    return null;
  }

  /** The control that actually runs the search, preferring the one in the same form. */
  function findSearchButton(doc, input) {
    const form = input && input.form;
    const scopes = form ? [form, doc] : [doc];
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll('button, input[type="submit"], a.btn')) {
        const text = (el.value || el.textContent || "").trim();
        if (/^search$/i.test(text)) return el;
      }
      const submit = scope.querySelector('button[type="submit"], input[type="submit"]');
      if (submit) return submit;
    }
    return null;
  }

  function setNativeValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(input, value);
    // React listens for input; change and keyup cover other handlers.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "r", bubbles: true }));
  }

  async function driveSearch(query) {
    let input = null;
    for (let i = 0; i < 40 && !input; i++) {
      input = findSearchInput(document);
      if (!input) await sleep(POLL_MS);
    }
    if (!input) return { error: "Could not find the BattleMetrics player name field." };

    const read = () => EX.extractSearch(document, location.href).map((p) => p.id).join(",");
    const before = read();

    input.focus();
    setNativeValue(input, query);

    const btn = findSearchButton(document, input);
    if (btn) btn.click();
    else if (input.form && input.form.requestSubmit) input.form.requestSubmit();
    else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));

    // Wait for the result set to change and then hold steady across two reads, so we
    // return a settled list rather than a mid-render flash. If the submit navigates,
    // this context dies and the worker re-reads the new page instead.
    let last = before, stable = 0;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(400);
      const sig = read();
      if (sig && sig !== before && sig === last) { if (++stable >= 2) break; }
      else stable = 0;
      last = sig;
    }
    return { results: EX.extractSearch(document, location.href), submitted: !!btn, diag: pageDiag() };
  }

  /* When a search comes back empty the useful question is what the page actually
     contains. This reports a small, non-identifying summary so a real failure can
     be told apart from a page shape we do not recognise yet. */
  function pageDiag() {
    const links = [...document.querySelectorAll('a[href*="/players/"]')];
    const shapes = new Map();
    for (const a of links.slice(0, 400)) {
      const href = a.getAttribute("href") || "";
      const shape = href.replace(/\d+/g, "<id>").split("?")[0] + (href.includes("?") ? "?..." : "");
      shapes.set(shape, (shapes.get(shape) || 0) + 1);
    }
    const body = (document.body && document.body.innerText) || "";
    return {
      url: location.href,
      playerLinkTotal: links.length,
      linkShapes: [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
      tableRows: document.querySelectorAll("table tr").length,
      mentionsNoResults: /no results|no players|nothing found|0 results/i.test(body),
      // "Premium" appears in the site nav on every page, so a bare word match here
      // reports a paywall that is not there. Look for an actual gate instead.
      mentionsSubscription: /requires? a subscription|subscribe to|upgrade to (view|access)|rcon required/i.test(body),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg && msg.type === "RESCAN") {
      lastReported = "";
      reportCurrentPage().then(() => respond({ ok: true }));
      return true;
    }
    if (msg && msg.type === "DRIVE_SEARCH") {
      driveSearch(String(msg.query || "")).then(respond);
      return true;
    }
    // Read results from a page that loaded after the search form navigated.
    if (msg && msg.type === "READ_SEARCH") {
      (async () => {
        const deadline = Date.now() + 12000;
        let rows = EX.extractSearch(document, location.href);
        while (!rows.length && Date.now() < deadline) {
          await sleep(POLL_MS);
          rows = EX.extractSearch(document, location.href);
        }
        respond({ results: rows, diag: rows.length ? null : pageDiag() });
      })();
      return true;
    }
    /* Read a server search results page on demand.

       This has to exist because reportCurrentPage deliberately does not
       auto-report serversearch (an empty search form is not a failure). Without
       it the worker's visit() sat waiting for a PAGE_DATA that was never coming
       and timed out into an empty result on every single server search. */
    if (msg && msg.type === "READ_SERVERSEARCH") {
      (async () => {
        const deadline = Date.now() + 12000;
        let rows = EX.extractServerSearch(document);
        while (!rows.length && Date.now() < deadline) {
          await sleep(POLL_MS);
          rows = EX.extractServerSearch(document);
        }
        respond({ servers: rows, diag: rows.length ? null : pageDiag() });
      })();
      return true;
    }
    // Read a player's sessions page for the search cross-reference. A player with
    // no listed sessions is a legitimate empty result, so this waits for a server
    // link OR a short settle window rather than treating empty as a failure.
    if (msg && msg.type === "READ_SESSIONS") {
      (async () => {
        const deadline = Date.now() + 10000;
        let data = EX.extractSessions(document, location.href);
        while ((!data || !data.servers.length) && Date.now() < deadline) {
          await sleep(POLL_MS);
          data = EX.extractSessions(document, location.href);
        }
        respond(data || { id: null, servers: [], lastSeen: null, private: false });
      })();
      return true;
    }
    return false;
  });
})();
