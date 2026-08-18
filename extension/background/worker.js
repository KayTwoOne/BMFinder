/* Background service worker: the only writer to storage, and the only thing that
   decides when a request goes out.

   Active refreshes drive ONE background tab through the target list, one item
   at a time, with a gap between each. Navigation is serialised and rate limited
   on purpose: it keeps the extension to a single in-flight page load, puts a
   light and predictable load on battlemetrics.com, and avoids overlapping reads
   that would race each other. Issuing them as fast as the code could manage was
   measured as both unnecessary and inconsiderate to the host.

   Passive reads cost nothing: they are pages the user opened anyway. */

import { db } from "../lib/db.js";
import { entriesFor, storesForParts } from "../lib/transfer.js";
import {
  matchScore, searchTerm, unsearchable, usesWildcard,
  rankSearchResults, rankServerResults, discriminatingTerm, confidenceScore, EVIDENCE,
} from "../lib/match.js";

/* A name this close to the query is the player who was asked for. */
const STRONG_MATCH = 0.9;

const SITE = "https://www.battlemetrics.com";

/* Player pages are read through the view the signed-in session is entitled to.

   No cookie is supplied or asked for: the extension drives a tab in the user's
   own browser, so these pages already carry whatever session that browser has.
   An account without RCON permissions is served the ordinary public view by
   BattleMetrics itself, which is the correct outcome and needs no handling here.

   What this deliberately does NOT do is treat an unavailable profile as a
   problem to route around. There is one URL per lookup, and if it does not
   resolve the answer is "unavailable", full stop. */
const playerUrl = (id) => `${SITE}/rcon/players/${id}`;
// Previous names live on the RCON identifiers subpage. This is the alias history
// that makes a renamed player recognisable.
const identifiersUrl = (id) => `${SITE}/rcon/players/${id}/identifiers`;
// The sessions subpage lists which servers a player has been on and when, which
// is what the search cross-reference matches against the user's tracked servers.
const sessionsUrl = (id) => `${SITE}/rcon/players/${id}/sessions`;

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
   the schedule died with the tab and lived nowhere the worker could see it. It
   is now an alarm owned by this worker, so the state is one thing in one place
   and the dashboard is a view of it rather than the owner. The alarm also
   survives the worker being torn down, which a timer would not.

   It is deliberately NOT allowed to outlive the dashboard tab - see
   dashboardOpen() below for why.

   chrome.alarms will not fire faster than once a minute, which is exactly the
   floor the interval picker already offered. */
const MONITOR_ALARM = "bmf-monitor-poll";
const MONITOR_DEFAULT = { mode: "stopped", intervalSec: 300, lastResult: null };

/* The first-run disclosure.

   Bump this when what the disclosure describes materially changes. Acceptance is
   stored with the version that was accepted, so an old acceptance no longer
   satisfies a newer disclosure and the user is asked again rather than being
   treated as having agreed to something they never read. */
const DISCLOSURE_VERSION = 1;

async function getDisclosure() {
  return (await db.getSetting("disclosure", null)) || null;
}

/** True only when this exact disclosure version has been accepted. */
async function disclosureAccepted() {
  try {
    const d = await getDisclosure();
    return !!d && Number(d.version) === DISCLOSURE_VERSION;
  } catch {
    // Storage unreadable is not consent.
    return false;
  }
}

let job = null;           // {kind, total, done, cancelled}
const waiters = new Map(); // tabId -> {resolve, want}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function broadcast(msg) {
  chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
}

/** Pause between requests. An explicit override wins, otherwise the stored
    setting, with a hard floor of 1s so the pacing cannot be configured away. */
async function gap(overrideMs) {
  const stored = Number(await db.getSetting("gapMs", DEFAULT_GAP_MS)) || DEFAULT_GAP_MS;
  const ms = Number(overrideMs) > 0 ? Number(overrideMs) : stored;
  await sleep(Math.max(1000, ms));
}

/* ---- storing what pages report ------------------------------------------ */

async function storePage(pageType, data) {
  /* Nothing is recorded before the disclosure is accepted - not just no polling.
     This is the passive path: pages the user opened themselves, which the content
     script reports. Reading them costs nothing, but writing what it saw is
     exactly the "passive recording" the disclosure has to precede. */
  if (!(await disclosureAccepted())) return { stored: false, blocked: "disclosure" };

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
      await db.recordPoll({ serverId: data.info.id, ts, info: data.info, roster: data.roster });
      // Remember the game slug so this server can be reopened at a URL that resolves.
      if (data.info.game) await db.updateServerMeta(data.info.id, data.info.name, data.info.game);
      // Anyone we track who is in this roster was, by definition, just seen here,
      // and the roster carries their live in-game name. Recording both keeps the
      // watchlist's current name and last-seen accurate straight from the poll,
      // with no separate name-refresh needed.
      const label = server.nickname || server.name || data.info.name || data.info.id;
      const watch = await db.listWatch();
      const watchedIds = new Set(watch.map((w) => String(w.playerId)));
      for (const p of data.roster || []) {
        if (watchedIds.has(String(p.id))) await db.recordWatchedSighting(p.id, p.name, data.info.id, label, ts);
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

/* Open a player through the view this session is entitled to, and stop there.

   There used to be a second attempt against the public page whenever the first
   came back without a name. That retry is gone. A profile that does not resolve
   is simply unavailable to this session, and trying another route to see whether
   some other endpoint will surrender it is exactly the pattern the extension
   should not have. Unavailable is a normal answer, not an obstacle.

   The practical loss is small: the public page is a strict subset of what the
   RCON view shows, so the fallback could only ever have helped when RCON itself
   returned nothing, which is the case where stopping is correct anyway. */
async function visitPlayer(tabId, id) {
  return visit(tabId, playerUrl(id));
}

/** Previous names for one player, stored as alias history. Costs one extra page
    load, so it runs during a watchlist refresh rather than on every sighting. */
async function fetchIdentifiers(tabId, id) {
  const payload = await visit(tabId, identifiersUrl(id));
  const names = (payload && payload.data && payload.data.names) || [];
  if (names.length) await db.recordNames(id, names);
  return names;
}

/** A player's sessions page, read on demand for the search cross-reference.
    Uses READ_SESSIONS rather than the auto-report path so an empty list (no
    sessions, or none we can read) is a normal answer and never raises the
    "page reading is broken" banner. */
async function fetchSessions(tabId, id) {
  await navigate(tabId, sessionsUrl(id));
  const resp = await sendTab(tabId, { type: "READ_SESSIONS" });
  /* `ok` separates "the page said this player has no sessions on your servers"
     from "we never managed to read the page". The scoring treats the first as
     evidence of absence and the second as no information at all, so the two must
     not arrive looking the same. */
  if (resp && Array.isArray(resp.servers)) return { ...resp, ok: true };
  return { id: String(id), servers: [], lastSeen: null, private: null, ok: false };
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
  let idFetches = 0;
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
      /* Alias history, on the same pass so a refresh leaves the watchlist able to
         answer "have they gone by anything else".

         `identifiers` may be a predicate rather than a flag, which is what makes
         a refresh cost one page load per player instead of two. Names barely ever
         change, and re-reading an unchanged history every time doubled the whole
         job for nothing. */
      const wantIds = typeof opts.identifiers === "function"
        ? opts.identifiers(payload, t)
        : !!opts.identifiers;
      if (wantIds && !job.cancelled) {
        await gap();
        try { await fetchIdentifiers(tabId, t.id); } catch { /* history is optional */ }
        idFetches++;
      }
      job.done++;
      if (job.done < job.total && !job.cancelled) await gap();
    }
  } finally {
    await closeTab();
  }
  const summary = { kind, done: job.done, total: job.total, failures, cancelled: job.cancelled, idFetches };
  job = null;
  broadcast({ type: "DONE", summary });
  return summary;
}

const refreshWatchlist = async () => {
  const watched = await db.listWatch();
  /* Snapshot what we already know, so the queue can decide per player whether
     the alias history is worth a second page load. Fetch it when the name has
     actually changed, or when we have never collected any, and skip it
     otherwise. That is the difference between two page loads per player and
     one, which on a 23 player list is roughly a minute either way. */
  const priorName = new Map(watched.map((w) => [String(w.playerId), w.currentName || ""]));
  const hasHistory = new Set(watched.filter((w) => (w.names || []).length).map((w) => String(w.playerId)));

  return runQueue(
    "watchlist",
    watched.map((w) => ({ id: w.playerId, label: w.nickname || w.playerId })),
    (t) => playerUrl(t.id),
    {
      player: true,
      identifiers: (payload, t) => {
        const id = String(t.id);
        if (!hasHistory.has(id)) return true;              // nothing stored yet
        const now = payload && payload.data && payload.data.name;
        if (!now) return false;                            // read failed, do not spend more
        return now !== priorName.get(id);                  // only when the name moved
      },
    }
  );
};

const pollServers = async () => {
  const servers = await db.listServers();
  // Presence and snapshots are the stores that grow with time rather than with
  // how much you track, so both are trimmed to the user's retention window at
  // the start of every cycle. One setting drives both (see db.applyRetention),
  // rather than the two independent knobs this used to read.
  try {
    await db.applyRetention(await db.retentionDays());
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

/* Nothing polls unless a dashboard is open.

   The extension used to re-arm its alarm on browser startup, so simply opening
   the browser made it navigate a tab to battlemetrics.com in the background.
   That is a surprising amount of activity for something the user has not opened
   yet, and it is not what an installed extension should be doing while it sits
   idle. Monitoring is now tied to the dashboard being on screen: an open
   dashboard is the user asking for this, and closing it is the user done.

   `mode: "running"` still means "the user turned monitoring on", and it still
   persists. It is a standing intent, not a licence to run unattended - the
   alarm only exists while that intent and an open dashboard coincide. */
const DASHBOARD_PORT = "bmf-dashboard";
const dashPorts = new Set();

/* Ports are the prompt signal - they fire the moment the tab opens or closes.
   They are not the whole answer, because the service worker can be torn down
   and revived by the alarm with an empty set while the tab is still there, so
   the authoritative check is the tab query. Both are cheap. */
async function dashboardOpen() {
  if (dashPorts.size) return true;
  try {
    const url = chrome.runtime.getURL("dashboard/dashboard.html");
    const tabs = await chrome.tabs.query({ url: url + "*" });
    return tabs.length > 0;
  } catch {
    return false;
  }
}

/** The alarm exists if and only if monitoring is running and a dashboard is open. */
/* The period the picker actually promised.

   This used to Math.round() the value into whole minutes, which silently turned
   a 90-second choice into 2 minutes. chrome.alarms accepts fractional minutes
   above its 1-minute floor, so the exact value is passed and only the floor is
   enforced. */
function alarmPeriodMinutes(state) {
  return Math.max(1, (Number(state.intervalSec) || 300) / 60);
}

/** The alarm exists if and only if monitoring is running, the disclosure has
 *  been accepted, and a dashboard is open.
 *
 *  `restart` decides whether an already-correct countdown is left alone or
 *  started again. This distinction is load-bearing, and getting it wrong is what
 *  broke scheduled polling: this function used to clear and recreate the alarm
 *  unconditionally, and onConnect calls it every time the dashboard reconnects.
 *  MV3 tears an idle service worker down after about thirty seconds, the page
 *  reconnects a second later, and each reconnect restarted the countdown from
 *  zero - so with any interval longer than the worker's idle life, the alarm was
 *  perpetually reset and the poll never came due.
 *
 *  So: only re-arm when there is nothing armed, when the period has actually
 *  changed, or when the caller explicitly wants the clock restarted (the user
 *  starting monitoring or picking a new interval). */
async function applyAlarm(state, { restart = false } = {}) {
  let existing = null;
  try { existing = await chrome.alarms.get(MONITOR_ALARM); } catch { /* none set */ }

  const allowed = state.mode === "running"
    && (await disclosureAccepted())
    && (await dashboardOpen());
  if (!allowed) {
    if (existing) { try { await chrome.alarms.clear(MONITOR_ALARM); } catch { /* gone */ } }
    return;
  }

  const mins = alarmPeriodMinutes(state);
  if (existing && !restart && existing.periodInMinutes === mins) return;

  try { await chrome.alarms.clear(MONITOR_ALARM); } catch { /* none set */ }
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
    /* Both re-checked every cycle rather than trusted from when the alarm was
       set. A tab can close, or storage can be cleared, while the worker is
       asleep - and the handler that would have torn the alarm down never got to
       run. Consent especially is checked here and not only at arm time: an alarm
       that outlived a "delete all data" must not keep polling. */
    if (!(await disclosureAccepted()) || !(await dashboardOpen())) {
      await chrome.alarms.clear(MONITOR_ALARM);
      return;
    }
    await pollServers();
  } catch { /* a failed cycle must never kill the schedule */ }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== DASHBOARD_PORT) return;
  dashPorts.add(port);
  port.onDisconnect.addListener(() => {
    dashPorts.delete(port);
    /* Last dashboard closed. Stop the schedule now rather than leaving one more
       poll to fire against a page nobody is looking at. */
    if (!dashPorts.size) {
      dashboardOpen()
        .then((open) => (open ? null : chrome.alarms.clear(MONITOR_ALARM)))
        .catch(() => {});
    }
  });
  // A dashboard opening is the cue to resume a schedule the user left running.
  getMonitor().then(applyAlarm).catch(() => {});
});

/* Browser start and extension update both leave a stored mode with no alarm and
   no dashboard. Clearing rather than re-arming is the point: nothing should run
   until the user actually opens the dashboard. */
async function clearAlarmOnIdleStart() {
  try { await chrome.alarms.clear(MONITOR_ALARM); } catch { /* none set */ }
}
chrome.runtime.onStartup.addListener(clearAlarmOnIdleStart);

/* On a fresh install the disclosure is opened straight away, because it has to be
   read before anything runs and burying it behind a click on the toolbar icon
   would leave the extension installed but inert with no explanation. On an update
   nothing is opened: a tab appearing unbidden after a background update is the
   behaviour this whole reframing is trying to get away from. If an update ever
   bumps DISCLOSURE_VERSION, the dashboard sends the user to it on next open. */
chrome.runtime.onInstalled.addListener(async (details) => {
  await clearAlarmOnIdleStart();
  if (details && details.reason === "install") {
    try { await chrome.tabs.create({ url: chrome.runtime.getURL("pages/welcome.html") }); }
    catch { /* the dashboard redirect is the fallback */ }
  }
});

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
/* Navigate the tab and resolve once the NEW page has finished loading.

   This replaces a `tabs.update()` followed by a status check, which looked
   equivalent and was the cause of the search cross-reference returning nothing
   at all. tabs.update() resolves before the navigation begins, so asking "is
   this tab loaded?" immediately after it answered yes about the PREVIOUS page.
   The wait ended instantly and the subsequent message was delivered to whatever
   content script was still alive: the old player's page, or nothing at all
   during teardown. Every sessions read came back empty, which in turn emptied
   the tracked-server column, last seen and first seen.

   The listener is attached BEFORE the navigation is issued, and a `complete` is
   only accepted once that navigation has actually started (a `loading` status,
   or a url change). If neither is ever observed the timeout still releases it,
   so a page that somehow never reports cannot hang the queue. */
function navigate(tabId, url, timeoutMs = NAV_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    let started = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      // A url change or a loading status means our navigation is under way, so
      // any completion from here belongs to the page we asked for.
      if (info.status === "loading" || info.url) started = true;
      if (info.status === "complete" && started) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch(finish);
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
    const term = searchTerm(query);
    // A query of nothing but whitespace or decoration leaves no token to search
    // for, and navigating with an empty filter renders the default player list,
    // which reads as a page of unrelated people rather than as a mistake.
    if (!term) return { results: [], error: "Enter a name to search for." };

    const byId = new Map();
    let diag = null;
    /* Two search routes, not a circumvention chain. This reacts to an empty
       RESULT SET, never to a profile reported as private or unavailable, and the
       public list is a strict subset of the RCON one, so the second attempt can
       only ever return fewer people. It cannot surface anything the first route
       withheld. */
    for (const rcon of [true, false]) {
      if (job.cancelled) break;
      await navigate(tabId, playerSearchUrl(term, rcon));
      const resp = await sendTab(tabId, { type: "READ_SEARCH" });
      if (resp && resp.diag) diag = resp.diag;
      const got = (resp && resp.results) || [];
      if (got.length) {
        for (const r of got) byId.set(String(r.id), r);
        break;
      }
    }

    /* Names we have observed ourselves, matched locally.

       This is the only route to a player whose name contains a space or
       decoration, because their index truncates the query at the first
       whitespace and compares it as a whole name (see searchTerm). Every roster
       this extension has polled was stored with full, untruncated names, so a
       player we have actually seen is findable even though their own search
       cannot return them. Costs nothing: it is a read of local storage, no
       requests. */
    try {
      const seen = await db.knownPlayerNames();
      for (const [id, name] of seen) {
        if (!name || byId.has(String(id))) continue;
        if (matchScore(query, name) >= 0.6) {
          byId.set(String(id), { id: String(id), name, fromHistory: true });
        }
      }
    } catch { /* history is a bonus; never fail the search on it */ }

    let rows = [...byId.values()];

    // Last resort: drive the on-page form, for the case where a future layout
    // stops honouring the query parameter.
    if (!rows.length) {
      const resp = await sendTab(tabId, { type: "DRIVE_SEARCH", query: term });
      if (resp && resp.results && resp.results.length) rows = resp.results;
      else if (resp && resp.diag) diag = resp.diag;
    }
    if (!rows.length && diag) console.log("BMFinder search diagnostic", diag);

    /* nameScore is kept alongside the blended score for the whole life of the
       result, so the UI can show the breakdown and nobody has to guess why a
       perfect name reads 70%. */
    const scored = rows
      .map((r) => {
        const nameScore = matchScore(query, r.name);
        return { ...r, nameScore, serverEvidence: EVIDENCE.UNKNOWN, score: nameScore };
      })
      .sort((a, b) => b.nameScore - a.nameScore);

    /* Enrich the top matches. When there are tracked servers, this reads each
       one's SESSIONS page and cross-references it against them, so the person who
       actually plays on your servers rises to the top instead of being one line
       in a list of ten same-named strangers.

       The sessions page is read INSTEAD of the profile page, not in addition, to
       hold the request count where it already was (~12, paced) rather than
       doubling the load a single search puts on the host. The cost is
       that a cross-referenced row has no first-seen date (the sessions page does
       not carry it); its last-seen comes from the most recent session, which is
       at least as accurate. With no tracked servers there is nothing to match
       against, so it falls back to the original profile-page enrichment and the
       behaviour is unchanged. */
    const trackedServers = await db.listServers();
    const trackedById = new Map(trackedServers.map((s) => [String(s.serverId), s]));
    const trackedOrder = trackedServers.map((s) => String(s.serverId));
    const crossRef = trackedById.size > 0;

    const enrichCount = Math.min(scored.length, 12);
    const candidates = scored.slice(0, enrichCount);

    /* Step one, free: our own poll history. Covers every candidate at once, no
       requests, and it is better evidence than the sessions page because we
       watched it happen. */
    let localHits = 0;
    if (crossRef) {
      const seen = await db.trackedSightings(candidates.map((r) => r.id));
      for (const r of candidates) {
        const hit = seen.get(String(r.id));
        if (!hit || !trackedById.has(hit.serverId)) continue;
        r.trackedServerId = hit.serverId;
        r.trackedServerName = hit.serverName;
        r.trackedLastSeen = hit.lastSeen;
        r.lastSeen = r.lastSeen || hit.lastSeen;
        r.serverEvidence = EVIDENCE.CONFIRMED;
        r.evidenceFrom = "local";
        localHits++;
      }
    }

    /* Step two, paid: ask BattleMetrics only about candidates our own history
       says nothing about. Budgeted, and it stops as soon as anything is
       confirmed, because at that point the question "which of these is the one I
       mean" has an answer and further page loads buy very little. Candidates
       never reached stay UNKNOWN rather than ABSENT: not checking is not the same
       as checking and finding nothing. */
    const SESSION_BUDGET = 8;
    let fetched = 0;
    let confirmed = localHits;

    for (const r of candidates) {
      if (job.cancelled) break;
      if (r.serverEvidence === EVIDENCE.CONFIRMED) continue;
      if (!crossRef) break;
      if (confirmed > 0 || fetched >= SESSION_BUDGET) break;

      if (fetched) await gap();
      const sess = await fetchSessions(tabId, r.id);
      fetched++;

      let best = null;
      for (const sv of sess.servers || []) {
        if (!trackedById.has(String(sv.id))) continue;
        if (!best || String(sv.lastSeen || "") > String(best.lastSeen || "")) best = sv;
      }
      if (best) {
        const t = trackedById.get(String(best.id));
        r.trackedServerId = String(best.id);
        r.trackedServerName = t.nickname || t.name || best.name || best.id;
        r.trackedLastSeen = best.lastSeen || null;
        confirmed++;
      }
      if (sess.lastSeen) r.lastSeen = sess.lastSeen;
      if (sess.private != null) r.private = sess.private;
      // Only a page we actually read can say anything about absence.
      r.serverEvidence = !sess.ok ? EVIDENCE.UNKNOWN
        : best ? EVIDENCE.CONFIRMED : EVIDENCE.ABSENT;
      r.evidenceFrom = sess.ok ? "sessions" : "unread";
    }

    /* With nothing tracked there is nothing to cross-reference against, so fall
       back to reading profile pages for the dates, which is what this did before
       any of the cross-referencing existed. */
    if (!crossRef) {
      for (let i = 0; i < candidates.length && !job.cancelled; i++) {
        const r = candidates[i];
        const payload = await visitPlayer(tabId, r.id);
        const p = payload && payload.data;
        if (p) {
          r.lastSeen = p.lastSeen || null;
          r.firstSeen = p.firstSeen || null;
          r.private = p.private;
        }
        if (i < candidates.length - 1 && !job.cancelled) await gap();
      }
    }

    for (const r of scored) r.score = confidenceScore(r.nameScore, r.serverEvidence);

    // rankSearchResults floats tracked-server hits to the top (grouped by server
    // in the user's order, newest-on-that-server first) and falls back to the
    // ordinary name-then-recency ranking when nothing matched.
    const ranked = rankSearchResults(scored, trackedOrder);
    const crossReferenced = crossRef && ranked.some((r) => r.trackedServerId != null);

    /* Explain a weak result instead of presenting strangers as a failed match.

       Two different situations, and they need different advice. A query with no
       letters or digits gives their search nothing to work with. A multi-word
       query DID search the whole name, using a wildcard across the gaps, so a
       poor result there means the name genuinely is not indexed that way rather
       than the query being inexpressible. */
    /* Judged on the NAME, not the blended score. The note answers "did the search
       find who I typed", and a perfect name that simply does not play on your
       servers scores 70% while still being a perfect find. */
    const strong = ranked.some((r) => (r.nameScore ?? r.score) >= STRONG_MATCH);
    let note = null;
    if (!strong) {
      if (unsearchable(query)) {
        note = `That query has no letters or numbers for BattleMetrics to search on. ` +
          `Try a player ID, or track the servers they play on: anyone seen on a tracked ` +
          `server becomes findable here by their full name.`;
      } else if (usesWildcard(query)) {
        note = `Searched for "${term}", bridging the spaces with a wildcard so the whole ` +
          `name was matched rather than just the first word. Nothing scored as a strong ` +
          `match, so either the name is spelled differently or they are not indexed. ` +
          `A player ID is exact if you have one.`;
      }
    }

    /* How the cross-reference was answered, so a run that hit nothing can be told
       apart from a run that never looked. Surfaced in the UI rather than only in
       the console, because "why is that column empty" was the question that
       cost the most time here. */
    const crossRefStats = crossRef
      ? { local: localHits, fetched, confirmed, budget: SESSION_BUDGET, checked: candidates.length }
      : null;

    return {
      results: ranked, note, searchedFor: term, crossReferenced, crossRefStats,
      diag: rows.length ? null : diag,
    };
  } finally {
    await closeTab();
    job = null;
  }
}

/** Server search, read from their rendered results page. */
/* Server search, read from their rendered results page.

   Two things were wrong here and either alone returned an empty list:

   1. It used visit(), which waits for the content script to push PAGE_DATA. But
      reportCurrentPage deliberately never auto-reports a serversearch page, so
      that wait could only ever end in the 20 second navigation timeout. It now
      navigates, waits for load, and ASKS for the results, the same shape the
      player search uses.

   2. The query went in as ?q=. That is the parameter that does nothing on the
      player list (it renders the default view and reads as zero results), and
      there is no reason to think the server list treats it differently. Both
      forms are tried, filter[search] first, so whichever their router honours
      wins and a future change to either does not break the feature. */
/* sort=score asks BattleMetrics to order by how well the name matches, which is
   what the player search has always done. Without it the server list comes back
   in its default order - broadly by how busy each server is - so a quiet server
   whose name matches exactly can sit below busier siblings, or past the end of
   the results altogether. Re-ranking here cannot rescue a server that was never
   returned, so the ordering has to be asked for at the source. */
const serverSearchUrl = (term, game, legacyQ = false) => {
  const base = `${SITE}/servers/${encodeURIComponent(game)}`;
  const q = encodeURIComponent(term);
  return legacyQ ? `${base}?q=${q}` : `${base}?filter%5Bsearch%5D=${q}&sort=score`;
};

/* Server names are long and full of separators - "CodeFourGaming - King of the
   Hill EU#1" - so a user typing the two parts they remember, "CodeFourGaming
   EU#1", is asking for a phrase that does not appear anywhere in the name. The
   raw query therefore misses the very server it names. searchTerm() bridges
   each gap with the same wildcard the player search relies on, so the query
   spans the words in between; the raw term is still tried afterwards in case
   their matcher ever prefers it. */
async function searchServers(query, game = "arma3") {
  if (job) return { error: "A refresh is already running." };
  const raw = String(query || "").trim();
  if (!raw) return { results: [], error: "Enter a server name to search for." };

  const bridged = searchTerm(raw);
  const terms = bridged && bridged !== raw ? [bridged, raw] : [raw];

  /* Attempts, cheapest and likeliest first, and deliberately NOT every
     combination of term and URL form.

     filter[search] is the parameter that actually works, so both terms are
     tried against it. ?q= is only a hedge against their router changing one
     day - and if it ever does change, it changes for both terms at once, so
     trying it more than once buys nothing. Pairing every term with every form
     would have made a failed search cost four page loads where it used to cost
     two, and keeping load on battlemetrics.com low is the whole basis on which
     this extension reads pages at all. A hit still costs one. */
  const attempts = [
    ...terms.map((t) => ({ term: t, url: serverSearchUrl(t, game) })),
    { term: raw, url: serverSearchUrl(raw, game, true) },
  ];

  job = { kind: "serversearch", total: 1, done: 0, cancelled: false, tabId: null };
  try {
    const tabId = await ensureTab();
    let diag = null;
    let best = null;

    for (const { term, url } of attempts) {
      if (job.cancelled) break;
      await navigate(tabId, url);
      const resp = await sendTab(tabId, { type: "READ_SERVERSEARCH" });
      const rows = (resp && resp.servers) || [];
      if (rows.length) {
        best = {
          results: rankServerResults(raw, rows),
          searchedWith: url,
          wildcarded: term !== raw,
        };
        break;
      }
      if (resp && resp.diag) diag = resp.diag;
    }

    if (!best) return { results: [], diag };

    /* Results came back, but if none of them is really the server that was
       asked for, they are the busy siblings that share its words rather than
       the server itself. One narrower search, on the part of the name that
       tells siblings apart, is worth the extra page load - it is the whole
       difference between finding a quiet server and never seeing it.

       Only when it would actually help: a strong match already found needs no
       rescue, and a query with nothing to narrow to would just repeat itself. */
    if ((best.results[0] && best.results[0].score) < STRONG_MATCH && !job.cancelled) {
      const narrow = discriminatingTerm(raw);
      if (narrow) {
        const url = serverSearchUrl(narrow, game);
        await navigate(tabId, url);
        const resp = await sendTab(tabId, { type: "READ_SERVERSEARCH" });
        const rows = (resp && resp.servers) || [];
        if (rows.length) {
          // Scored against the ORIGINAL query, not the narrowed one, so the
          // full name the user typed is still what decides the order.
          const ranked = rankServerResults(raw, rows);
          if ((ranked[0].score || 0) > (best.results[0].score || 0)) {
            best = { results: ranked, searchedWith: url, wildcarded: true, narrowed: narrow };
          }
        }
      }
    }
    return best;
  } finally {
    await closeTab();
    job = null;
  }
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
    /* restart: the user just started monitoring or chose a different interval,
       so the countdown should begin now rather than inheriting whatever was
       left of the previous one. */
    await applyAlarm(next, { restart: true });
    return { monitor: next };
  },
  DISCLOSURE_GET: async () => ({
    accepted: await disclosureAccepted(),
    version: DISCLOSURE_VERSION,
    record: await getDisclosure(),
  }),
  DISCLOSURE_ACCEPT: async () => {
    await db.setSetting("disclosure", {
      version: DISCLOSURE_VERSION,
      acceptedAt: new Date().toISOString(),
    });
    return { accepted: true, version: DISCLOSURE_VERSION };
  },
  /* The v4 upgrade rewrote the relationship on rows the user had set by hand.
     Changing someone's saved data without saying so is not acceptable even when
     the change is an improvement, so the migration leaves a breadcrumb and the
     dashboard reports it once. */
  MIGRATION_NOTICE: async () => {
    const n = await db.getSetting("relationshipMigration", null);
    return { notice: n && !n.notified ? n : null };
  },
  MIGRATION_NOTICE_ACK: async () => {
    const n = await db.getSetting("relationshipMigration", null);
    if (n) await db.setSetting("relationshipMigration", { ...n, notified: true });
    return { ok: true };
  },
  RESTORE_WATCH: async (m) => {
    await db.restoreWatch(m.snapshot);
    return { watch: await db.listWatch() };
  },
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
  DATA_SUMMARY: async () => ({ summary: await db.dataSummary() }),
  GET_RETENTION: async () => ({ days: await db.retentionDays() }),
  // Applies the new window immediately rather than waiting for the next poll
  // cycle, per audit §7.1: "When the user shortens retention, prune older data
  // immediately after confirmation."
  SET_RETENTION: async (m) => {
    const days = await db.setRetentionDays(m.days);
    const pruned = await db.applyRetention(days);
    return { days, pruned };
  },
  CLEAR_PLAYER_HISTORY: async (m) => {
    await db.clearPlayerHistory(m.playerId);
    return { watch: await db.listWatch() };
  },
  CLEAR_SERVER_HISTORY: async (m) => {
    await db.clearServerHistory(m.serverId);
    return { servers: await db.listServers() };
  },
  RESET_LABELS: async () => {
    await db.resetLabelsAndTags();
    return { watch: await db.listWatch(), tags: await db.listTags() };
  },
  DELETE_ALL_DATA: async () => { await db.deleteAllData(); return { ok: true }; },
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
  CANCEL: async () => { if (job) job.cancelled = true; return { ok: true }; },
  ONLINE: async () => ({ online: await db.currentOnline() }),
  EXPORT: async () => ({ json: await db.exportAll() }),
  /* Restore a full backup. Destructive by design - importAll refuses anything
     that is not recognisably a backup, and the dashboard confirms the
     replacement before sending this. */
  IMPORT: async (m) => ({ ok: true, result: await db.importAll(m.json) }),
  /* Selective import: only the parts that were ticked, applied the way that was
     chosen. Everything else in the file is discarded rather than written. */
  IMPORT_PARTS: async (m) => {
    const result = await db.importSelective(m.json, storesForParts(m.parts), m.mode);
    return { ok: true, result, watch: await db.listWatch(), servers: await db.listServers() };
  },
  /* Merge a shared list or CSV. The plan was computed in the dashboard against
     the saved list and shown to the user; this only writes what they approved. */
  IMPORT_PEOPLE: async (m) => {
    const existing = await db.listWatch();
    const entries = entriesFor(m.plan, existing, { overwriteLabels: !!m.overwriteLabels });
    const res = await db.importPeople(entries);
    /* Followed servers ride along in a BMFinder list. addServer writes only the
       fields it is given, so a server already followed keeps its own nickname
       and note. */
    let servers = 0;
    for (const entry of (m.serverPlan ? [...m.serverPlan.add, ...m.serverPlan.update] : [])) {
      await db.addServer(entry);
      servers++;
    }
    return { ...res, servers, watch: await db.listWatch(), serverList: await db.listServers() };
  },
  GET_SETTING: async (m) => ({ value: await db.getSetting(m.key, m.dflt) }),
  SET_SETTING: async (m) => { await db.setSetting(m.key, m.value); return { ok: true }; },
};

/* Only this extension's own pages and content scripts may drive the worker.
   `externally_connectable` is unset, so a web page cannot reach onMessage today
   and this is defence in depth rather than a live hole; it exists so that adding
   that field later cannot silently expose every handler. A message from a tab
   must come from a battlemetrics.com page, which is the only place our content
   scripts run. */
/* The only two messages a content script has any business sending. Everything
   else - saving people, changing retention, deleting the database - belongs to
   the extension's own pages.

   The content script runs in an isolated world, so a compromised battlemetrics
   page cannot reach chrome.runtime directly, and reader.js listens for no page
   events that could be used to launder a message through it. This is defence in
   depth rather than a fix for a known hole: the cost is one Set, and it means a
   future change to reader.js cannot quietly widen what the site can ask for. */
const CONTENT_SCRIPT_MESSAGES = new Set(["PAGE_DATA", "EXTRACT_FAILED"]);

function senderAllowed(sender, type) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  let origin;
  try {
    origin = new URL(sender.url || (sender.tab && sender.tab.url) || "").origin;
  } catch {
    return false;
  }
  // Our own pages may use the whole message surface.
  if (origin === `chrome-extension://${chrome.runtime.id}`) return true;
  /* The dashboard is the options page, so it runs IN A TAB and has sender.tab
     set exactly like a content script does - which is why the origin, not the
     presence of a tab, is what distinguishes them. */
  if (origin === SITE) return CONTENT_SCRIPT_MESSAGES.has(type);
  return false;
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const fn = msg && handlers[msg.type];
  if (!fn) return false;
  if (!senderAllowed(sender, msg.type)) { respond({ error: "Rejected: unrecognised sender." }); return true; }
  // The worker can be torn down between messages, so open the database per call.
  db.init()
    .then(() => fn(msg, sender))
    .then((r) => respond(r || { ok: true }))
    .catch((e) => respond({ error: String((e && e.message) || e) }));
  return true; // keep the channel open for the async reply
});
