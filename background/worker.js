/* Background service worker: the only writer to storage, and the only thing that
   decides when a request goes out.

   Active refreshes drive ONE hidden tab through the target list, one item at a
   time, with a gap between each. That pacing is not decoration. Roughly twenty
   rapid scripted requests to battlemetrics.com earned a Cloudflare challenge
   during testing, so the queue stays deliberately slower than a script could go
   and closer to what a person clicking around produces.

   Passive reads cost nothing: they are pages the user opened anyway. */

import { db } from "../lib/db.js";
import { correlate, correlationMeta } from "../lib/correlation.js";
import { matchScore, searchVariants } from "../lib/match.js";

/* A result this close to the query means we have found who was asked for, so
   the search stops spending page loads on plainer fallback terms. */
const STRONG_MATCH = 0.9;

const SITE = "https://www.battlemetrics.com";

/* The RCON views are the point of this tool. /rcon/players/<id> resolves players
   that the public /players/<id> page hides, which is the whole reason a hidden
   admin can be found by walking IDs. Every player lookup goes through here so the
   two forms can never drift apart again.

   No cookie needs supplying: the extension drives a tab in your own browser, so
   these pages already carry your logged-in session. Without RCON access on an
   account these URLs simply fall back to the public view. */
const playerUrl = (id) => `${SITE}/rcon/players/${id}`;
const playerUrlPublic = (id) => `${SITE}/players/${id}`;
// Previous names live on the RCON identifiers subpage. This is the alias history
// that makes a renamed player recognisable.
const identifiersUrl = (id) => `${SITE}/rcon/players/${id}/identifiers`;

/* Name search is a URL, not a form. The parameter is filter[search] (percent
   encoded below); ?q= and ?search= are silently ignored and render the default
   player list, which reads as "no results" and cost a lot of debugging to spot.
   sort=score puts the closest matches first. */
const playerSearchUrl = (query, rcon = true) =>
  `${SITE}${rcon ? "/rcon" : ""}/players` +
  `?filter%5Bsearch%5D=${encodeURIComponent(query)}&sort=score`;
const DEFAULT_GAP_MS = 3000;
const NAV_TIMEOUT_MS = 20000;

/* Monitoring used to be a setInterval living in the dashboard page, which meant
   closing the tab silently ended it. It is now an alarm owned by this worker:
   the schedule survives the tab closing, the worker being torn down, and the
   browser restarting, because chrome.alarms persists all three. The dashboard
   became a view of this state rather than the owner of it.

   chrome.alarms will not fire faster than once a minute, which is exactly the
   floor the interval picker already offered. */
const MONITOR_ALARM = "bmf-monitor-poll";
const MONITOR_DEFAULT = { mode: "stopped", intervalSec: 300, lastResult: null };

let job = null;           // {kind, total, done, cancelled}
const waiters = new Map(); // tabId -> {resolve, want}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function broadcast(msg) {
  chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
}

/** Pause between requests. An explicit override wins, otherwise the stored
    setting, but never below 1s: faster than that stops looking like browsing. */
async function gap(overrideMs) {
  const stored = Number(await db.getSetting("gapMs", DEFAULT_GAP_MS)) || DEFAULT_GAP_MS;
  const ms = Number(overrideMs) > 0 ? Number(overrideMs) : stored;
  await sleep(Math.max(1000, ms));
}

/* ---- storing what pages report ------------------------------------------ */

async function storePage(pageType, data) {
  if (pageType === "player") {
    const watched = await db.listWatch();
    const known = watched.some((w) => String(w.playerId) === String(data.id));
    // Only record names for players we track. Every profile the user happens to
    // open should not silently become a watchlist entry.
    if (known) {
      await db.recordNames(data.id, [data.name]);
      await db.setCurrentName(data.id, data.name, !!data.private,
        { lastSeen: data.lastSeen, firstSeen: data.firstSeen });
    }
    return { stored: known };
  }

  if (pageType === "server") {
    const tracked = await db.listServers();
    const server = tracked.find((s) => String(s.serverId) === String(data.info.id));
    if (server) {
      const ts = new Date().toISOString();
      const admins = await db.adminIds();
      await db.recordPoll({ serverId: data.info.id, ts, info: data.info, roster: data.roster, admins });
      // Remember the game slug so this server can be reopened at a URL that resolves.
      if (data.info.game) await db.updateServerMeta(data.info.id, data.info.name, data.info.game);
      // Anyone we track who is in this roster was, by definition, just seen here.
      // This is the accurate "last seen", sourced from our own observation.
      const label = server.nickname || server.name || data.info.name || data.info.id;
      const watch = await db.listWatch();
      const watchedIds = new Set(watch.map((w) => String(w.playerId)));
      for (const p of data.roster || []) {
        if (watchedIds.has(String(p.id))) await db.setLastServer(p.id, data.info.id, label, ts);
      }
    }
    return { stored: !!server };
  }
  return { stored: false };
}

/* ---- driving a hidden tab ----------------------------------------------- */

async function ensureTab() {
  if (job && job.tabId) {
    try {
      await chrome.tabs.get(job.tabId);
      return job.tabId;
    } catch {
      job.tabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url: SITE + "/", active: false });
  if (job) job.tabId = tab.id;
  return tab.id;
}

/** Navigate the hidden tab and resolve once its content script reports back. */
function visit(tabId, url) {
  return new Promise(async (resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(tabId);
      resolve(null);
    }, NAV_TIMEOUT_MS);

    waiters.set(tabId, {
      resolve: (payload) => {
        clearTimeout(timer);
        waiters.delete(tabId);
        resolve(payload);
      },
    });

    try {
      await chrome.tabs.update(tabId, { url });
    } catch {
      clearTimeout(timer);
      waiters.delete(tabId);
      resolve(null);
    }
  });
}

/** Open a player through the RCON view, falling back to the public page only if
    RCON yields nothing (no RCON access on the account, or the id does not exist
    there). The fallback costs a second request, so it only runs on failure. */
async function visitPlayer(tabId, id) {
  const rcon = await visit(tabId, playerUrl(id));
  if (rcon && rcon.data && rcon.data.name) return rcon;
  const pub = await visit(tabId, playerUrlPublic(id));
  return (pub && pub.data && pub.data.name) ? pub : rcon;
}

/** Previous names for one player, stored as alias history. Costs one extra page
    load, so it runs during a watchlist refresh rather than on every sighting. */
async function fetchIdentifiers(tabId, id) {
  const payload = await visit(tabId, identifiersUrl(id));
  const names = (payload && payload.data && payload.data.names) || [];
  if (names.length) await db.recordNames(id, names);
  return names;
}

async function closeTab() {
  if (job && job.tabId) {
    try { await chrome.tabs.remove(job.tabId); } catch { /* already gone */ }
    job.tabId = null;
  }
}

/* ---- jobs ---------------------------------------------------------------- */

async function runQueue(kind, targets, urlFor, opts = {}) {
  if (job) return { error: "A refresh is already running." };
  job = { kind, total: targets.length, done: 0, cancelled: false, tabId: null };
  const failures = [];
  try {
    const tabId = await ensureTab();
    for (const t of targets) {
      if (job.cancelled) break;
      broadcast({ type: "PROGRESS", done: job.done, total: job.total, current: t.label });
      const payload = opts.player
        ? await visitPlayer(tabId, t.id)
        : await visit(tabId, urlFor(t));
      if (payload && payload.data) await storePage(payload.pageType, payload.data);
      else failures.push(t.label);
      // Alias history, gathered on the same pass so a refresh leaves the watchlist
      // able to answer "have they gone by anything else".
      if (opts.identifiers && !job.cancelled) {
        await gap();
        try { await fetchIdentifiers(tabId, t.id); } catch { /* history is optional */ }
      }
      job.done++;
      if (job.done < job.total && !job.cancelled) await gap();
    }
  } finally {
    await closeTab();
  }
  const summary = { kind, done: job.done, total: job.total, failures, cancelled: job.cancelled };
  job = null;
  broadcast({ type: "DONE", summary });
  return summary;
}

const refreshWatchlist = async () => {
  const watched = await db.listWatch();
  return runQueue(
    "watchlist",
    watched.map((w) => ({ id: w.playerId, label: w.nickname || w.playerId })),
    (t) => playerUrl(t.id),
    { player: true, identifiers: true }
  );
};

const pollServers = async () => {
  const servers = await db.listServers();
  // Presence is the one store that grows with time rather than with how much you
  // track, so it is trimmed to a retention window at the start of every cycle.
  try {
    const days = Number(await db.getSetting("presenceDays", 14)) || 14;
    await db.prunePresence(days);
    const snapDays = Number(await db.getSetting("snapshotDays", 365)) || 365;
    await db.pruneSnapshots(snapDays);
  } catch { /* pruning is housekeeping, never block a poll on it */ }
  const summary = await runQueue(
    "servers",
    servers.map((s) => ({ id: s.serverId, label: s.nickname || s.serverId, game: s.game || "arma3" })),
    (t) => `${SITE}/servers/${t.game}/${t.id}`
  );
  /* The outcome is stored, not just broadcast. A cycle that runs while the
     dashboard is closed still has to be reportable when it is opened again,
     and the worker can be torn down between cycles, so in-memory would not
     survive either. */
  if (summary && !summary.error) {
    const failed = (summary.failures || []).length;
    await setMonitor({
      lastResult: {
        total: summary.total, failed, ok: Math.max(0, summary.done - failed),
        failures: summary.failures || [], cancelled: !!summary.cancelled, at: Date.now(),
      },
    });
  }
  return summary;
};

/* ---- monitoring schedule ------------------------------------------------- */

async function getMonitor() {
  const stored = await db.getSetting("monitor", null);
  return { ...MONITOR_DEFAULT, ...(stored || {}) };
}

async function setMonitor(patch) {
  const next = { ...(await getMonitor()), ...patch };
  await db.setSetting("monitor", next);
  return next;
}

/** The alarm exists if and only if monitoring is running. */
async function applyAlarm(state) {
  try { await chrome.alarms.clear(MONITOR_ALARM); } catch { /* none set */ }
  if (state.mode !== "running") return;
  // Alarms are minute-granular; the interval picker never offers less than one.
  const mins = Math.max(1, Math.round((state.intervalSec || 300) / 60));
  chrome.alarms.create(MONITOR_ALARM, { periodInMinutes: mins, delayInMinutes: mins });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== MONITOR_ALARM) return;
  try {
    await db.init();
    const m = await getMonitor();
    // A cycle that overruns its interval simply misses the next alarm rather
    // than stacking a second one on top of it.
    if (m.mode !== "running" || job) return;
    await pollServers();
  } catch { /* a failed cycle must never kill the schedule */ }
});

/* An alarm survives the worker being torn down, but if the extension is
   reloaded or updated the alarm is dropped while the stored mode still says
   running. Re-arming on startup keeps the two in step. */
async function reconcileAlarm() {
  try {
    await db.init();
    const m = await getMonitor();
    const existing = await chrome.alarms.get(MONITOR_ALARM);
    if (m.mode === "running" && !existing) await applyAlarm(m);
    if (m.mode !== "running" && existing) await chrome.alarms.clear(MONITOR_ALARM);
  } catch { /* nothing stored yet */ }
}
chrome.runtime.onStartup.addListener(reconcileAlarm);
chrome.runtime.onInstalled.addListener(reconcileAlarm);

/** Send a message to a specific tab's content script and await its reply. */
function sendTab(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (r) => { void chrome.runtime.lastError; resolve(r); });
    } catch {
      resolve(null);
    }
  });
}

/** Resolve once the tab finishes loading, or after a timeout. Used instead of
    waiting for PAGE_DATA on pages the content script deliberately does not report,
    such as the empty search form. */
function waitForLoad(tabId, timeoutMs = NAV_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === "complete") finish(); }).catch(finish);
  });
}

/** Search runs through the same hidden tab: their page makes the signed request,
    we read the rendered results.

    mode 'playerid' skips search entirely and opens the profile directly, which is
    both faster and exact. */
async function search(query, mode = "name") {
  if (job) return { error: "A refresh is already running." };
  job = { kind: "search", total: 1, done: 0, cancelled: false, tabId: null };
  try {
    const tabId = await ensureTab();

    if (mode === "playerid") {
      const id = String(query).trim();
      if (!/^\d+$/.test(id)) return { error: "Player ID must be a whole number." };
      const payload = await visitPlayer(tabId, id);
      const p = payload && payload.data;
      return p && p.name
        ? { results: [{ id: p.id, name: p.name, private: p.private, score: null }] }
        : { results: [], error: "No player found with that ID." };
    }

    /* Name search is a plain navigation. The app reads filter[search], which is the
       detail that made this look impossible for so long: ?q= and ?search= are both
       ignored, so those URLs render the default view and look like zero results.
       RCON first, since that view resolves players the public list hides.

       Two loops, not one. The old version varied only rcon-vs-public and stopped
       at the first page that returned ANY rows, which is why a decorated name
       like "MX (kaomoji)" failed: their search returned ten unrelated players
       called MX, that counted as success, and the real player was never looked
       for again. Now a page of weak matches is treated as a miss and the next,
       plainer query form is tried. Results are merged rather than replaced,
       because the exact query's hits stay valid even when a later one finds
       more. */
    const variants = searchVariants(query);
    // A query of nothing but whitespace or stripped decoration leaves no term to
    // search for, and navigating with an empty filter renders the default player
    // list, which reads as a page of unrelated results rather than a mistake.
    if (!variants.length) return { results: [], error: "Enter a name to search for." };

    const byId = new Map();
    let diag = null;
    let bestScore = 0;

    for (const term of variants) {
      if (job.cancelled || bestScore >= STRONG_MATCH) break;
      for (const rcon of [true, false]) {
        if (job.cancelled) break;
        await chrome.tabs.update(tabId, { url: playerSearchUrl(term, rcon) });
        await waitForLoad(tabId);
        const resp = await sendTab(tabId, { type: "READ_SEARCH" });
        if (resp && resp.diag) diag = resp.diag;
        const got = (resp && resp.results) || [];
        if (!got.length) continue;

        for (const r of got) if (!byId.has(String(r.id))) byId.set(String(r.id), r);
        // Scored against the original query, never against the term we searched.
        for (const r of got) bestScore = Math.max(bestScore, matchScore(query, r.name));
        break; // this term produced rows; no need to repeat it on the other view
      }
    }
    let rows = [...byId.values()];

    // Last resort: drive the on-page form. Kept for the case where a future layout
    // stops honouring the query parameter. Uses the plainest term, since a raw
    // decorated string is exactly what the field tends to choke on.
    if (!rows.length) {
      const resp = await sendTab(tabId, { type: "DRIVE_SEARCH", query: variants[variants.length - 1] });
      if (resp && resp.results && resp.results.length) rows = resp.results;
      else if (resp && resp.diag) diag = resp.diag;
    }
    if (!rows.length && diag) console.log("BMFinder search diagnostic", diag);

    // Enrich the top matches with their last seen date, then order by it. Several
    // players routinely share a name, and the one who played today is nearly always
    // the one being looked for, so recency is a better tie break than score alone.
    const scored = rows
      .map((r) => ({ ...r, score: matchScore(query, r.name) }))
      .sort((a, b) => b.score - a.score);

    const enrichCount = Math.min(scored.length, 12);
    for (let i = 0; i < enrichCount && !job.cancelled; i++) {
      const payload = await visitPlayer(tabId, scored[i].id);
      const p = payload && payload.data;
      if (p) {
        scored[i].lastSeen = p.lastSeen || null;
        scored[i].firstSeen = p.firstSeen || null;
        scored[i].private = p.private;
      }
      if (i < enrichCount - 1) await gap();
    }
    /* Recency decides between players whose names are equally plausible, but it
       must not outrank the name itself: sorting purely by lastSeen buried an
       exact match under a stranger who happened to log in more recently. That
       got worse once the fallback terms started returning whole pages of
       loosely-related players. So group by how well the name matches, then sort
       by recency inside each group. */
    const tier = (s) => (s >= STRONG_MATCH ? 2 : s >= 0.6 ? 1 : 0);
    scored.sort((a, b) => {
      const t = tier(b.score) - tier(a.score);
      if (t) return t;
      const ta = Date.parse(a.lastSeen || 0) || 0;
      const tb = Date.parse(b.lastSeen || 0) || 0;
      if (tb !== ta) return tb - ta;             // most recently seen first
      return b.score - a.score;                  // then closest name match
    });

    return { results: scored, diag: rows.length ? null : diag };
  } finally {
    await closeTab();
    job = null;
  }
}

/** Server search, read from their rendered results page. */
async function searchServers(query, game = "arma3") {
  if (job) return { error: "A refresh is already running." };
  job = { kind: "serversearch", total: 1, done: 0, cancelled: false, tabId: null };
  try {
    const tabId = await ensureTab();
    const url = `${SITE}/servers/${encodeURIComponent(game)}?q=${encodeURIComponent(query)}`;
    const payload = await visit(tabId, url);
    const rows = payload && payload.data && payload.data.servers ? payload.data.servers : [];
    return { results: rows };
  } finally {
    await closeTab();
    job = null;
  }
}

async function scanRange({ start, count, direction, target, threshold, delayMs, useCache = true }) {
  if (job) return { error: "A refresh is already running." };
  const step = direction === "down" ? -1 : 1;
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = start + i * step;
    if (id < 1) break;
    ids.push(id);
  }
  /* Ids this device has already seen are scored from storage instead of being
     fetched again. Every server poll has been writing player ids and names all
     along, so on a well-used install a scan can resolve a meaningful slice of
     its range for free, and the request budget goes to the ids that are
     genuinely unknown. */
  const cache = useCache ? await db.knownPlayerNames() : new Map();
  job = { kind: "scan", total: ids.length, done: 0, cancelled: false, tabId: null };
  const hits = [];
  let cached = 0, fetched = 0;
  try {
    const tabId = await ensureTab();
    for (const id of ids) {
      if (job.cancelled) break;
      const key = String(id);
      let name = null, fromCache = false;

      if (cache.has(key)) {
        name = cache.get(key) || null;
        fromCache = true;
        cached++;
      } else {
        // RCON view: this is the walk that turns up players the public pages hide.
        const payload = await visitPlayer(tabId, id);
        const p = payload && payload.data;
        name = p && p.name ? p.name : null;
        fetched++;
      }

      if (name) {
        const score = matchScore(target, name);
        broadcast({ type: "SCAN_ROW", id, name, score, match: score >= threshold, cached: fromCache });
        if (score >= threshold) hits.push({ id, name, score, cached: fromCache });
      } else {
        broadcast({ type: "SCAN_ROW", id, name: null, score: 0, match: false, cached: fromCache });
      }
      job.done++;
      broadcast({ type: "PROGRESS", done: job.done, total: job.total, current: String(id) });
      // A cached id cost no request, so it earns no pause.
      if (!fromCache && job.done < job.total && !job.cancelled) await gap(delayMs);
    }
  } finally {
    await closeTab();
  }
  const summary = { kind: "scan", hits, done: job.done, total: job.total, cancelled: job.cancelled, cached, fetched };
  job = null;
  broadcast({ type: "DONE", summary });
  return summary;
}

/* ---- date-targeted ID seek ------------------------------------------------
   Walking ids one at a time cannot find anyone in an id space this large: at a
   polite request rate a linear scan covers a few hundred ids an hour against a
   space of hundreds of millions. Binary search changes the shape of the
   problem. Player ids are handed out in roughly chronological order, and every
   player page reports a first-seen date, so the id space is an approximately
   sorted array keyed by date and can be bisected.

   That turns "which ids belong to accounts first seen in March 2019" from
   unreachable into roughly thirty page loads, because each probe halves the
   remaining range. The result is an id neighbourhood to scan, not a person: it
   narrows a hundred-million-wide space to a few hundred, and the ordinary scan
   does the rest.

   The key is only APPROXIMATELY monotonic (BattleMetrics records a player when
   it first observes them, and back-fills happen), so this reports a bracket it
   actually probed rather than claiming a single exact boundary. */
async function seekDate({ isoDate, low = 1, high = 1200000000, maxProbes = 34 }) {
  if (job) return { error: "A refresh is already running." };
  const targetT = Date.parse(isoDate);
  if (!Number.isFinite(targetT)) return { error: "That is not a date I can read." };

  job = { kind: "seek", total: maxProbes, done: 0, cancelled: false, tabId: null };
  const probes = [];
  let lo = Math.max(1, Math.floor(low));
  let hi = Math.max(lo, Math.floor(high));
  let below = null, above = null;

  try {
    const tabId = await ensureTab();
    while (job.done < maxProbes && lo <= hi && !job.cancelled) {
      const mid = Math.floor((lo + hi) / 2);

      /* Not every id resolves: ids are skipped, deleted and hidden. A dead
         probe is not an answer, so it steps forward a little rather than
         throwing away half the range on no evidence. */
      let found = null;
      for (let off = 0; off < 3 && job.done < maxProbes && !job.cancelled; off++) {
        const id = mid + off;
        if (id > hi) break;
        const payload = await visitPlayer(tabId, id);
        const p = payload && payload.data;
        job.done++;
        broadcast({ type: "PROGRESS", done: job.done, total: maxProbes, current: `id ${id}` });
        if (p && p.name && p.firstSeen) { found = { id, firstSeen: p.firstSeen, name: p.name }; break; }
        await gap();
      }

      if (!found) { lo = mid + 3; continue; }

      probes.push(found);
      broadcast({ type: "SEEK_ROW", ...found });
      if (Date.parse(found.firstSeen) < targetT) { below = found; lo = found.id + 1; }
      else { above = found; hi = found.id - 1; }
      if (!job.cancelled) await gap();
    }
  } finally {
    await closeTab();
  }

  const summary = {
    kind: "seek", done: job.done, total: maxProbes, cancelled: job.cancelled,
    isoDate, below, above, probes,
    // The answer is the narrowest bracket that was actually observed.
    suggestion: below ? below.id + 1 : (above ? Math.max(1, above.id - 1) : null),
    span: below && above ? Math.abs(above.id - below.id) : null,
  };
  job = null;
  broadcast({ type: "DONE", summary });
  return summary;
}

/* ---- bookmark import ---------------------------------------------------- */

const BM_PLAYER = /battlemetrics\.com\/(?:[a-z]{2}\/)?(?:rcon\/)?players\/(\d+)/i;

/** Add many players at once, skipping any already tracked so an import never
    overwrites a nickname you already set. Pure DB, no network. */
async function addWatchBatch(entries, role = "other") {
  const tracked = new Set((await db.listWatch()).map((w) => String(w.playerId)));
  let added = 0, skipped = 0;
  for (const e of entries || []) {
    const id = String(e.playerId || "").trim();
    if (!/^\d+$/.test(id) || tracked.has(id)) { skipped++; continue; }
    tracked.add(id);
    await db.addWatch({ playerId: id, nickname: (e.nickname || "").trim(), role, note: "" });
    added++;
  }
  return { added, skipped, watch: await db.listWatch() };
}

/** Walk the browser's own bookmarks for BattleMetrics player links. The bookmark
    title becomes the nickname, which is exactly what a "bm_track" folder holds. */
async function importBookmarks(role = "other") {
  if (!chrome.bookmarks) return { error: "Bookmarks permission is not granted. Reload the extension." };
  const tree = await chrome.bookmarks.getTree();
  const found = [];
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.url) {
        const m = n.url.match(BM_PLAYER);
        if (m) found.push({ playerId: m[1], nickname: (n.title || "").trim() });
      }
      if (n.children) walk(n.children);
    }
  })(tree);
  const res = await addWatchBatch(found, role);
  return { ...res, found: found.length };
}

async function correlation(min) {
  const [rows, servers, admins, active] = await Promise.all([
    db.allStats(), db.listServers(), db.adminIds(), db.serversWithAdminActivity(),
  ]);
  return {
    candidates: correlate(rows, admins, active, min),
    meta: correlationMeta(servers, admins, min),
  };
}

/* ---- message routing ----------------------------------------------------- */

const handlers = {
  PAGE_DATA: async (msg, sender) => {
    const tabId = sender && sender.tab && sender.tab.id;
    const w = tabId != null ? waiters.get(tabId) : null;
    if (w) { w.resolve(msg); return { ok: true }; }
    // Not part of a job, so this is a page the user opened themselves.
    return await storePage(msg.pageType, msg.data);
  },
  EXTRACT_FAILED: async (msg, sender) => {
    const tabId = sender && sender.tab && sender.tab.id;
    const w = tabId != null ? waiters.get(tabId) : null;
    if (w) w.resolve(null);
    broadcast({ type: "EXTRACT_WARNING", url: msg.url, failures: msg.failures });
    return { ok: true };
  },
  GET_STATE: async () => ({
    stats: await db.stats(),
    watch: await db.listWatch(),
    servers: await db.listServers(),
    running: !!job,
    runningKind: job ? job.kind : null,
    monitor: await getMonitor(),
  }),
  /* The dashboard no longer owns the schedule, so it asks for the state and
     sends intent. Two messages instead of start/pause/resume/stop, because they
     all set the same field. */
  MONITOR_GET: async () => ({ monitor: await getMonitor(), running: !!job, runningKind: job ? job.kind : null }),
  MONITOR_SET: async (m) => {
    const next = await setMonitor(m.patch || {});
    await applyAlarm(next);
    return { monitor: next };
  },
  RESTORE_WATCH: async (m) => {
    await db.restoreWatch(m.snapshot);
    return { watch: await db.listWatch() };
  },
  SEEK_DATE: (m) => seekDate(m),
  ADD_WATCH: async (m) => { await db.addWatch(m.entry); return { watch: await db.listWatch() }; },
  ADD_WATCH_BATCH: (m) => addWatchBatch(m.entries, m.role),
  IMPORT_BOOKMARKS: (m) => importBookmarks(m.role),
  SET_ROLE: async (m) => {
    for (const id of m.playerIds || []) await db.setRole(id, m.role);
    return { watch: await db.listWatch() };
  },
  ARCHIVE: async (m) => ({
    snapshots: await db.archive({ serverId: m.serverId || null, limit: Math.min(Number(m.limit) || 60, 300) }),
    servers: await db.listServers(),
    rows: await db.presenceCount(),
  }),
  PLAYER_SESSIONS: async (m) => ({ sessions: await db.playerSessions(m.playerId) }),
  PLAYER_NAMES: async (m) => {
    const w = (await db.listWatch()).find((x) => String(x.playerId) === String(m.playerId));
    return { names: (w && w.names) || [] };
  },
  FETCH_IDENTIFIERS: async (m) => {
    if (job) return { error: "A refresh is already running." };
    job = { kind: "identifiers", total: 1, done: 0, cancelled: false, tabId: null };
    try {
      const tabId = await ensureTab();
      const names = await fetchIdentifiers(tabId, m.playerId);
      return { names, watch: await db.listWatch() };
    } finally {
      await closeTab();
      job = null;
    }
  },
  CLEAR_POLLS: async () => ({ cleared: await db.clearPolls() }),
  LIST_TAGS: async () => ({ tags: await db.listTags() }),
  SAVE_TAGS: async (m) => {
    const tags = await db.saveTags(m.tags);
    // Dropping a tag from the catalogue also removes it from every player, so no
    // row is left showing a label that no longer exists.
    const names = new Set(tags.map((t) => t.name));
    for (const w of await db.listWatch()) {
      const kept = (w.tags || []).filter((n) => names.has(n));
      if (kept.length !== (w.tags || []).length) await db.setPlayerTags(w.playerId, kept);
    }
    return { tags, watch: await db.listWatch() };
  },
  SET_PLAYER_TAGS: async (m) => {
    for (const id of m.playerIds || []) {
      if (m.mode === "toggle") {
        const w = (await db.listWatch()).find((x) => String(x.playerId) === String(id));
        const cur = new Set((w && w.tags) || []);
        if (cur.has(m.tag)) cur.delete(m.tag); else cur.add(m.tag);
        await db.setPlayerTags(id, [...cur]);
      } else {
        await db.setPlayerTags(id, m.tags || []);
      }
    }
    return { watch: await db.listWatch() };
  },
  // Returns what it deleted so the caller can offer an undo that actually
  // restores the alias history, not just the row.
  REMOVE_WATCH: async (m) => {
    const removed = await db.removeWatch(m.playerId);
    return { watch: await db.listWatch(), removed };
  },
  ADD_SERVER: async (m) => { await db.addServer(m.entry); return { servers: await db.listServers() }; },
  REMOVE_SERVER: async (m) => { await db.removeServer(m.serverId); return { servers: await db.listServers() }; },
  REFRESH_WATCHLIST: () => refreshWatchlist(),
  POLL_SERVERS: () => pollServers(),
  SEARCH: (m) => search(m.query, m.mode),
  SERVER_SEARCH: (m) => searchServers(m.query, m.game),
  SCAN: (m) => scanRange(m),
  CANCEL: async () => { if (job) job.cancelled = true; return { ok: true }; },
  CORRELATION: (m) => correlation(Math.max(1, Number(m.min) || 3)),
  ONLINE: async () => ({ online: await db.currentOnline() }),
  EXPORT: async () => ({ json: await db.exportAll() }),
  IMPORT: async (m) => { await db.importAll(m.json); return { ok: true }; },
  GET_SETTING: async (m) => ({ value: await db.getSetting(m.key, m.dflt) }),
  SET_SETTING: async (m) => { await db.setSetting(m.key, m.value); return { ok: true }; },
};

/* Only this extension's own pages and content scripts may drive the worker.
   `externally_connectable` is unset, so a web page cannot reach onMessage today
   and this is defence in depth rather than a live hole; it exists so that adding
   that field later cannot silently expose every handler. A message from a tab
   must come from a battlemetrics.com page, which is the only place our content
   scripts run. */
function senderAllowed(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  let origin;
  try {
    origin = new URL(sender.url || (sender.tab && sender.tab.url) || "").origin;
  } catch {
    return false;
  }
  // The dashboard is the options page, so it runs IN A TAB and therefore has
  // sender.tab set exactly like a content script does. Checking only the
  // battlemetrics origin would reject every message the dashboard sends, so our
  // own extension origin has to be allowed explicitly.
  return origin === SITE || origin === `chrome-extension://${chrome.runtime.id}`;
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const fn = msg && handlers[msg.type];
  if (!fn) return false;
  if (!senderAllowed(sender)) { respond({ error: "Rejected: unrecognised sender." }); return true; }
  // The worker can be torn down between messages, so open the database per call.
  db.init()
    .then(() => fn(msg, sender))
    .then((r) => respond(r || { ok: true }))
    .catch((e) => respond({ error: String((e && e.message) || e) }));
  return true; // keep the channel open for the async reply
});
