/* Reading BattleMetrics pages.

   Every selector in this extension lives here. When BattleMetrics redesigns, and
   they will, this is the only file that needs fixing. Nothing else should ever
   query their DOM directly.

   Loaded as a CLASSIC script alongside the content script, not an ES module:
   MV3 content scripts do not support import. It attaches to globalThis.BMExtract.

   Design rule: never guess. Each field is attempted through a chain of strategies
   and, if all of them fail, the value comes back null and the failure is named.
   A blank name written into the database is worse than a visible error, because
   the watchlist would silently report that everyone renamed themselves.

   Verified against live pages on 2026-07-23:
     player h1 renders as "<name> Overview Name Search"
     player links render as <a href="/players/123">NAME</a>
     document.title renders as "<name> - BattleMetrics" */

(function (root) {
  "use strict";

  const EXTRACTOR_VERSION = "2026-07-23";

  // Text the page appends inside headings that is chrome, not part of a name.
  const TRAILERS = [
    "Overview", "Name Search", "Sessions", "Related Players",
    "Flags", "Notes", "Bans", "Coplay", "Connect",
  ];

  // Consent and cookie dialogs inject their own headings, and on a server page
  // every single h1 belongs to one. Reading headings without excluding these
  // stores "battlemetrics.com asks for your consent..." as the server name.
  const DIALOG_SEL = [
    '[role="dialog"]', '[aria-modal="true"]',
    ".fc-consent-root", ".fc-dialog", ".fc-help-dialog",
    ".qc-cmp2-container", "#qc-cmp2-container",
  ].join(",");

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  function stripTrailers(name) {
    let out = clean(name);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of TRAILERS) {
        if (out.toLowerCase().endsWith(t.toLowerCase())) {
          out = clean(out.slice(0, out.length - t.length));
          changed = true;
        }
      }
    }
    return out;
  }

  function fromTitle(doc) {
    const t = clean(doc.title || "");
    if (!t || /^battlemetrics$/i.test(t)) return "";
    // "<name> - BattleMetrics", sometimes prefixed with "Player "
    return clean(t.replace(/\s*[-|]\s*BattleMetrics\s*$/i, "").replace(/^Player\s+/i, ""));
  }

  function idFromUrl(url, kind) {
    const m = String(url).match(
      kind === "player" ? /\/players\/(\d+)/ : /\/servers\/(?:[a-z0-9]+\/)?(\d+)/i
    );
    return m ? m[1] : null;
  }

  function detectPageType(url, doc) {
    const u = String(url);
    // Check the subpages before the generic player match, since their URLs
    // contain /players/<id> too.
    if (/\/players\/\d+\/identifiers/.test(u)) return "identifiers";
    if (/\/players\/\d+\/sessions/.test(u)) return "sessions";
    if (/\/players\/\d+/.test(u)) return "player";
    if (/\/servers\/(?:[a-z0-9]+\/)?\d+/i.test(u)) return "server";
    // Order matters: a server page carries an id, a server search does not.
    if (/\/servers(?:\/[a-z0-9]+)?(?:\?|$)/i.test(u)) return "serversearch";
    if (/\/players(?:\?|$)/.test(u)) return "search";
    if (doc && doc.querySelector("form.player-search")) return "search";
    return "unknown";
  }

  /** First heading that is real page content rather than a dialog's own title. */
  function firstHeading(doc, tags) {
    for (const tag of tags) {
      for (const el of doc.querySelectorAll(tag)) {
        if (el.closest && el.closest(DIALOG_SEL)) continue;
        const text = stripTrailers(el.textContent);
        if (text) return { name: text, via: tag };
      }
    }
    return null;
  }

  /** Player name, tried hardest-evidence first. Returns {name, via} or null. */
  function playerName(doc) {
    const h = firstHeading(doc, ["h1"]);
    if (h) return h;
    const t = stripTrailers(fromTitle(doc));
    if (t) return { name: t, via: "title" };
    return null;
  }

  /** First <time> element that comes after `el` in document order. */
  function nextTimeAfter(el) {
    for (const t of el.ownerDocument.querySelectorAll("time")) {
      if (el.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) return t;
    }
    return null;
  }

  /** The value beside a "First Seen" / "Last Seen" label. The page renders these
   *  as a <dt> label followed by a <dd><time datetime="ISO">relative</time></dd>,
   *  so we read the absolute datetime and keep the relative text as a fallback. */
  function seenValue(doc, label) {
    const want = label.toLowerCase();
    for (const el of doc.querySelectorAll("dt, .header, strong, b, span, div")) {
      if (clean(el.textContent).toLowerCase() !== want) continue;
      const sib = el.nextElementSibling;
      let t = null;
      if (sib) t = sib.tagName === "TIME" ? sib : sib.querySelector("time");
      if (!t) t = nextTimeAfter(el);
      if (t) return { iso: t.getAttribute("datetime") || null, rel: clean(t.textContent) || null };
      if (sib && clean(sib.textContent)) return { iso: null, rel: clean(sib.textContent) };
    }
    return null;
  }

  function extractPlayer(doc, url) {
    const id = idFromUrl(url, "player");
    if (!id) return null;
    const got = playerName(doc);
    if (!got) return null;
    const body = (doc.body && doc.body.textContent) || "";
    const first = seenValue(doc, "First Seen");
    const last = seenValue(doc, "Last Seen");
    return {
      id,
      name: got.name,
      private: /this profile is private|profile is hidden/i.test(body),
      firstSeen: first ? first.iso : null,
      firstSeenRel: first ? first.rel : null,
      lastSeen: last ? last.iso : null,
      lastSeenRel: last ? last.rel : null,
      via: got.via,
    };
  }

  /** Player links anywhere in a page: rosters and search results share this shape.
   *
   *  Only a BARE profile link counts. A player page carries ~39 links matching
   *  /players/, nearly all of them page chrome: /players/1/sessions,
   *  /players/1/coplay, /players/1?servers[87259]=7D and so on. Matching loosely
   *  turns "Session History" into a player called Session History and poisons
   *  server rosters, so the path must be exactly /players/<id> with no extra
   *  segment and no query. */
  function playerLinks(doc, opts) {
    const allowQuery = !!(opts && opts.allowQuery);
    const base = (doc && doc.baseURI) || "https://www.battlemetrics.com/";
    // A player page links to itself many times with a query (the 7D/1M/3M range
    // filters). Those self-links are noise, so on a page that IS a player we drop
    // any link back to that same id rather than banning query strings outright:
    // search results legitimately carry query strings.
    const selfId = (String((doc && doc.baseURI) || "").match(/\/players\/(\d+)/) || [])[1];
    const seen = new Set();
    const out = [];
    for (const a of doc.querySelectorAll('a[href*="/players/"]')) {
      const raw = a.getAttribute("href") || "";
      let u;
      try { u = new URL(raw, base); } catch { continue; }
      const m = u.pathname.match(/^\/(?:rcon\/)?players\/(\d+)$/);
      if (!m) continue;
      const id = m[1];
      if (u.search && !allowQuery) continue;
      if (u.search && id === selfId) continue;
      // Nav labels reduce to nothing once trailers are stripped, which is what
      // separates the "Overview" tab from an actual player called something.
      const name = stripTrailers(a.textContent);
      if (!name || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name });
    }
    return out;
  }

  /** Game slug from a /servers/<game>/<id> URL, e.g. "arma3". Server links need
   *  it: /servers/<id> alone does not resolve, which is why bookmarks to the
   *  bare form never load. */
  function gameFromUrl(url) {
    const m = String(url).match(/\/servers\/([a-z0-9]+)\/\d+/i);
    return m ? m[1] : null;
  }

  /** The <time> nearest to an element: one inside its row-like ancestor if there
   *  is one, otherwise the next <time> in document order. Best-effort, because a
   *  session row's exact shape is not something this code can assume. */
  function timeNear(el) {
    let scope = el;
    for (let i = 0; i < 4 && scope; i++) {
      const tag = scope.tagName;
      if (tag === "TR" || tag === "LI" || (scope.className && /session|row|item/i.test(scope.className))) break;
      scope = scope.parentElement;
    }
    const t = (scope || el).querySelector && (scope || el).querySelector("time[datetime]");
    if (t) return t.getAttribute("datetime");
    const after = nextTimeAfter(el);
    return after ? after.getAttribute("datetime") : null;
  }

  /* Server links on a sessions page, as {id, game, name, lastSeen}. This is
     deliberately separate from serverLinks (used for server SEARCH results),
     which requires a visible name and a game slug and drops timestamps: right
     for a search card, wrong here, where a session row's link may be terse and
     the time is the whole point. Accepts the bare /servers/<id> form too, since
     a sessions row is not guaranteed to carry the slug. Deduped by id, keeping
     the most recent associated time. */
  function sessionServerLinks(doc) {
    const base = (doc && doc.baseURI) || "https://www.battlemetrics.com/";
    const byId = new Map();
    for (const a of doc.querySelectorAll('a[href*="/servers/"]')) {
      const raw = a.getAttribute("href") || "";
      let u;
      try { u = new URL(raw, base); } catch { continue; }
      // Trailing slash tolerated; a deeper segment (/rank, /players) is not,
      // since those are subpages rather than the server itself. Query strings
      // never reach here because pathname excludes them.
      const m = u.pathname.match(/^\/servers\/(?:([a-z0-9]+)\/)?(\d+)\/?$/i);
      if (!m) continue;
      const id = m[2];
      const name = clean(a.textContent);
      const lastSeen = timeNear(a);
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, { id, game: m[1] || null, name: name || null, lastSeen });
      } else {
        if (name && !prev.name) prev.name = name;
        if (lastSeen && (!prev.lastSeen || lastSeen > prev.lastSeen)) prev.lastSeen = lastSeen;
        if (m[1] && !prev.game) prev.game = m[1];
      }
    }
    return [...byId.values()];
  }

  /* The sessions subpage (/rcon/players/<id>/sessions) lists which servers a
     player has been on and when. Its exact DOM is NOT verified against a live
     page (Cloudflare blocks scripted access), so this leans only on the two
     things that are structurally reliable: server links follow the same
     /servers/<game>/<id> shape used everywhere else, and dates render in <time
     datetime> elements. The per-server timestamp is best-effort via timeNear;
     the server MEMBERSHIP (which is what the cross-reference needs) is as solid
     as roster reading. An empty list is a valid answer, not a failure. */
  function extractSessions(doc, url) {
    const id = idFromUrl(url, "player");
    if (!id) return null;
    const servers = sessionServerLinks(doc);
    const times = servers.map((s) => s.lastSeen).filter(Boolean).sort();
    const body = (doc.body && doc.body.textContent) || "";
    return {
      id,
      servers,
      lastSeen: times.length ? times[times.length - 1] : null,
      private: /this profile is private|profile is hidden/i.test(body),
    };
  }

  function extractServer(doc, url) {
    const id = idFromUrl(url, "server");
    if (!id) return null;
    const roster = playerLinks(doc);
    // Server pages put the name in an h2, not an h1, and the title stays
    // "BattleMetrics" because it is set client side after render.
    const h = firstHeading(doc, ["h1", "h2"]);
    let name = h ? h.name : "";
    if (!name) name = stripTrailers(fromTitle(doc));

    // "12 / 64 players" or a "Players 12/64" style counter.
    const body = (doc.body && doc.body.textContent) || "";
    const m = body.match(/(\d+)\s*\/\s*(\d+)\s*(?:players)?/i);
    // roster.length is a floor, not a truth: an offline or empty server has a
    // real count of 0 with no roster, which is valid, not a failed read.
    const count = m ? Number(m[1]) : null;
    return {
      info: {
        id,
        name: name || null,
        game: gameFromUrl(url),
        players: count,
        maxPlayers: m ? Number(m[2]) : null,
      },
      roster,
    };
  }

  /* Previous names, from the RCON identifiers subpage
     (/rcon/players/<id>/identifiers). That list is the perk of the RCON view and is
     what lets you recognise someone who has renamed themselves.

     The page layout is not something this code can assume, so names are gathered by
     three independent strategies and merged. Anything that looks like a timestamp,
     an id, or page chrome is dropped, because a wrong name here is worse than a
     missing one: it would show up as a false alias on a player. */
  /* Page chrome that has been observed rendering as a "previous name".
     This is a BACKSTOP, not the mechanism: the table reader below is
     authoritative and its results deliberately skip this list, because a player
     genuinely called "Activity" should not be silently dropped. Anything here
     only filters the loose fallback strategies. */
  const NOT_A_NAME = new RegExp(
    "^(?:name|names?|identifier|identifiers|all identifiers|type|value|" +
    "first seen|last seen|player|player queries|players|" +
    "steam ?id|steam|bem?id|ip|by ip|by time|hash|actions?|activity|activity log|" +
    "admin log|search|overview|sessions|related players|" +
    "flags|notes|bans|ban player|current & past bans|current and past bans|coplay|" +
    "profile|public profile|private profile|my id|in game|known names|previous names|" +
    "show|hide|copy|premium|rcon|servers|home)$", "i"
  );

  function looksLikeName(s) {
    const v = clean(s);
    if (!v || v.length > 64) return false;
    if (NOT_A_NAME.test(v)) return false;
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return false;          // ISO date
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v)) return false;  // locale date
    if (/^\d+$/.test(v) && v.length > 6) return false;        // bare id
    if (/^(?:\d+\s*(?:years?|months?|days?|hours?|minutes?|seconds?)\s*ago)$/i.test(v)) return false;
    return true;
  }

  /* The identifiers table, read by column position.

     This is the authoritative reader. The page renders a real table with an
     "Identifier" column and a "Type" column, so a previous name is not something
     to be inferred: it is the Identifier cell of a row whose Type is "Name".
     Reading it that way means nav labels, sort links and section headings can
     never be mistaken for a name, because they are not in the table at all.

     Results from here are NOT passed through looksLikeName. The table has
     already told us these are names, and filtering them again would drop a
     player genuinely called "Activity" or "Search". */
  function identifiersFromTable(doc) {
    for (const table of doc.querySelectorAll("table")) {
      const headRow = table.querySelector("thead tr") || table.querySelector("tr");
      if (!headRow) continue;
      const heads = [...headRow.children].map((c) => clean(c.textContent).toLowerCase());
      const idIdx = heads.findIndex((h) => /^identifiers?$/.test(h));
      const typeIdx = heads.findIndex((h) => /^type$/.test(h));
      if (idIdx === -1 || typeIdx === -1) continue;

      const out = [];
      for (const row of table.querySelectorAll("tr")) {
        if (row === headRow) continue;
        const cells = [...row.children];               // direct cells only
        if (cells.length <= Math.max(idIdx, typeIdx)) continue;
        // The type cell can carry icon markup alongside the word, so match the
        // leading token rather than requiring the cell to equal "Name" exactly.
        if (!/^name\b/i.test(clean(cells[typeIdx].textContent))) continue;
        const value = clean(cells[idIdx].textContent);
        if (value && value.length <= 64) out.push(value);
      }
      if (out.length) return out;
    }
    return [];
  }

  /** {names: [...], via: string} from an identifiers page, or null. */
  function extractIdentifiers(doc, url) {
    const id = idFromUrl(url, "player");

    // Preferred path: the real table. When it parses, trust it completely and
    // stop, so the guessier strategies cannot add chrome on top of a good read.
    const fromTable = identifiersFromTable(doc);
    if (fromTable.length) {
      return { id, names: [...new Set(fromTable)], via: "table" };
    }

    /* Fallbacks, used only when the table is missing or has been restructured.
       These infer rather than read, so everything they produce is filtered
       through looksLikeName. */
    const found = new Set();
    const via = [];

    // 1. Row-shaped markup carrying a "name" type cell.
    for (const row of doc.querySelectorAll("tr, li, .row")) {
      const cells = [...row.querySelectorAll("td, th, span, div")]
        .map((c) => clean(c.textContent)).filter(Boolean);
      if (!cells.length) continue;
      const typeIdx = cells.findIndex((c) => /^name$/i.test(c));
      if (typeIdx === -1) continue;
      for (const c of cells) if (c !== cells[typeIdx] && looksLikeName(c)) found.add(c);
      via.push("typed-row");
    }

    /* 2. Links back to this same player.

       Restricted to the BARE profile path. The nav bar links to
       /players/<id>/activity, /sessions, /flags and so on, and matching those
       turned every tab label into a previous name: "Activity", "Player Queries"
       and "Public Profile" all arrived here. Only /players/<id> with nothing
       after it can plausibly be an alias link. */
    if (id) {
      const base = (doc && doc.baseURI) || "https://www.battlemetrics.com/";
      for (const a of doc.querySelectorAll(`a[href*="/players/${id}"]`)) {
        let u;
        try { u = new URL(a.getAttribute("href") || "", base); } catch { continue; }
        if (!new RegExp(`^/(?:rcon/)?players/${id}$`).test(u.pathname)) continue;
        const t = stripTrailers(a.textContent);
        if (looksLikeName(t)) { found.add(t); via.push("self-link"); }
      }
    }

    // 3. A dedicated names section, if the page has one.
    for (const h of doc.querySelectorAll("h1, h2, h3, h4, dt, .header, strong")) {
      if (!/^names?$/i.test(clean(h.textContent))) continue;
      let el = h.nextElementSibling;
      for (let i = 0; el && i < 3; i++, el = el.nextElementSibling) {
        for (const c of el.querySelectorAll("td, li, span, div, a")) {
          const t = clean(c.textContent);
          if (looksLikeName(t)) { found.add(t); via.push("names-section"); }
        }
      }
    }

    return { id, names: [...found], via: [...new Set(via)].join(",") || "none" };
  }

  /** Search results, including the single-result case: quickMatchRedirect=on means
   *  an exact match lands you on the player's page instead of a list, so a player
   *  page reached from a search still counts as one result. */
  function extractSearch(doc, url) {
    const rows = playerLinks(doc, { allowQuery: true });
    if (rows.length) return rows;
    const here = url || (doc && doc.baseURI) || "";
    if (/\/players\/\d+/.test(here)) {
      const p = extractPlayer(doc, here);
      if (p && p.name) return [{ id: p.id, name: p.name, private: p.private }];
    }
    return [];
  }

  /* serverLinks has to reject far more than playerLinks does. A player page
     links to itself dozens of times, but those are all THIS player; a server
     SEARCH page renders the real results alongside a nav bar, a footer and
     often a "popular servers" rail, and those belong to OTHER servers
     entirely, not chrome around the same answer. Matching the path shape is
     not enough to tell them apart, so this also has to ask WHERE on the page
     a link lives. */

  /** True when an anchor sits inside page chrome. Cheap and free when
   *  BattleMetrics happens to use the semantic tag for its sidebar, but that
   *  alone cannot be trusted: nothing requires them to. The density grouping
   *  below is what catches the rest. */
  function inServerChrome(a) {
    return !!(a.closest && a.closest("nav, aside, header, footer"));
  }

  /** The nearest ancestor an anchor shares with at least one OTHER candidate.
   *  A rendered results list puts its links as siblings under one wrapping
   *  element, so walking up from any of them converges on that same element.
   *  A sidebar's links converge the same way, just on a smaller container of
   *  their own - which is what makes grouping by this value useful. The walk
   *  stops before the document's own body/root: without that ceiling, a link
   *  with no real neighbour would "converge" with every other unrelated link
   *  on the page purely because the root contains everything, turning
   *  unrelated chrome into one fake group. */
  function nearestSharedAncestor(a, candidates, doc) {
    const ceiling = new Set([doc && doc.body, doc && doc.documentElement].filter(Boolean));
    let el = a.parentElement;
    while (el && !ceiling.has(el)) {
      let count = 0;
      for (const other of candidates) if (el.contains(other)) count++;
      if (count > 1) return el;
      el = el.parentElement;
    }
    return a.parentElement || a;
  }

  /** Keep only the biggest group of candidates sharing a nearestSharedAncestor.
   *  The results list is the container holding the most server links; a
   *  sidebar or a "popular servers" rail holds a handful. Fewer than 3 in the
   *  winning group is treated as no group at all: the only candidates that
   *  exist before results have painted ARE the sidebar's, and a real result
   *  set is never that thin, so returning empty here is what keeps the
   *  caller's poll loop waiting instead of locking onto chrome. */
  function densestServerGroup(candidates, doc, min) {
    const groups = new Map();
    for (const a of candidates) {
      const root = nearestSharedAncestor(a, candidates, doc);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(a);
    }
    let best = [];
    for (const group of groups.values()) if (group.length > best.length) best = group;
    return best.length >= min ? best : [];
  }

  /** Server result links, same bare-path rule as players. Captures the game slug
   *  from the href so tracked servers can be reopened at a URL that resolves.
   *
   *  Unscoped, this always finds SOME server link - a sidebar, a "popular
   *  servers" panel, nav or footer - which used to make extraction "succeed"
   *  on the very first poll tick, before the real results had rendered, and
   *  report whatever static links were already sitting on the page. Two
   *  different searches were proven in the field to return the identical ten
   *  IDs because of exactly this. Scoping to the densest group of surviving
   *  links (see densestServerGroup above) means a page whose results have
   *  not painted yet correctly yields nothing instead of yielding the wrong
   *  thing.
   *
   *  `min` is how many links the winning group must hold to be believed, and it
   *  exists because "two links" is genuinely ambiguous: it is either a rail that
   *  rendered early, or a search that really did match two servers. The page
   *  alone cannot say which. The caller can, because it knows how long it has
   *  been waiting - so reader.js asks strictly at first and leniently once the
   *  page has had time to settle, rather than this guessing and being wrong for
   *  every narrow search. */
  function serverLinks(doc, min = 3) {
    const base = (doc && doc.baseURI) || "https://www.battlemetrics.com/";
    // Collected as anchor elements, not plain objects, because the grouping
    // step below needs each hit's position on the page - information that is
    // gone the moment a hit is reduced to {id, name, game}.
    const candidates = [];
    for (const a of doc.querySelectorAll('a[href*="/servers/"]')) {
      if (inServerChrome(a)) continue;
      const raw = a.getAttribute("href") || "";
      let u;
      try { u = new URL(raw, base); } catch { continue; }
      if (u.search) continue;
      const m = u.pathname.match(/^\/servers\/([a-z0-9]+)\/(\d+)$/i);
      if (!m) continue;
      const name = stripTrailers(a.textContent);
      if (!name) continue;
      candidates.push({ el: a, id: m[2], name, game: m[1] });
    }

    const winners = new Set(densestServerGroup(candidates.map((c) => c.el), doc, min));

    const seen = new Set();
    const out = [];
    for (const c of candidates) {
      if (!winners.has(c.el) || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ id: c.id, name: c.name, game: c.game });
    }
    return out;
  }

  const extractServerSearch = (doc, min) => serverLinks(doc, min);

  /** Report whether this page produced what its type promises. */
  function selfTest(doc, url) {
    const type = detectPageType(url, doc);
    const failures = [];
    if (type === "player") {
      const p = extractPlayer(doc, url);
      if (!p) failures.push("player page yielded no record");
      else if (!p.name) failures.push("player name empty");
    } else if (type === "server") {
      const s = extractServer(doc, url);
      if (!s) failures.push("server page yielded no record");
      else if (!s.info.name) failures.push("server name empty");
      // An empty roster is only a failure when the server claims players are on.
      else if (s.info.players > 0 && !s.roster.length) failures.push("server roster empty");
    } else if (type === "search") {
      if (!extractSearch(doc).length) failures.push("search returned no players");
    } else if (type === "serversearch") {
      if (!extractServerSearch(doc).length) failures.push("server search returned nothing");
    }
    return { ok: failures.length === 0, type, version: EXTRACTOR_VERSION, failures };
  }

  root.BMExtract = {
    EXTRACTOR_VERSION, detectPageType, extractPlayer, extractServer,
    extractSearch, extractServerSearch, extractIdentifiers, extractSessions, selfTest, stripTrailers,
    playerLinks, serverLinks,
  };
})(globalThis);
