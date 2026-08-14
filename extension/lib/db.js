/* IndexedDB persistence for the extension. Mirrors the D1 schema (see
   ../../schema.sql and ../../src/store.js) but lives in the browser profile
   instead of a Worker's database, so every id that used to be a SQLite TEXT
   primary key gets coerced with String() here too - IndexedDB keys are typed,
   and a numeric 123 and a string "123" are different keys, which would silently
   split one player or server into two records. */

const DB_NAME = "bmfinder";
/* v2 added the tags store, v3 added presence (the Archive's per poll player list),
   v4 replaced the old role vocabulary with neutral relationship categories,
   v5 deleted the stats store outright along with absence correlation.
   upgrade() only creates what is missing, so bumping the version adds stores to an
   existing profile without touching the data already there. */
export const DB_VERSION = 5;

/* The relationship vocabulary lives in relationships.js so the UI can read it
   without importing the persistence layer. Re-exported here because callers that
   already hold db.js expect to find it alongside the stores it applies to. */
import { toRelationship } from "./relationships.js";
export { RELATIONSHIPS, RELATIONSHIP_LABEL, RELATIONSHIP_FROM_LEGACY, toRelationship } from "./relationships.js";

const STORE_NAMES = [
  "watched", "names", "servers", "snapshots", "roster", "settings", "tags",
  "presence",
];

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/* One retention setting drives both presence and snapshots (see applyRetention
   below) rather than the two independent knobs this used to have. Exported as a
   pure function so it can be unit tested without touching IndexedDB at all -
   see extension/test/logic.test.js. */
export const RETENTION_DEFAULT_DAYS = 14;
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 90;
export function clampRetentionDays(value) {
  // Coercion is deliberately restricted to number/string inputs. Number(null)
  // and Number([]) are both 0, which is indistinguishable from a genuine "0" -
  // and this value drives how much history applyRetention deletes, so garbage
  // input must fall back to the safe default rather than silently becoming the
  // 1-day floor and pruning far more than anyone asked for.
  const usable = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
  const n = usable ? Number(value) : NaN;
  if (!Number.isFinite(n)) return RETENTION_DEFAULT_DAYS;
  return Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, Math.round(n)));
}

/* `tx` is the version-change transaction and `oldVersion` is what the profile
   held before this open. Both are needed to migrate data rather than only create
   stores: a fresh profile (oldVersion 0) has nothing to migrate, and writing
   through any other transaction would let a rename commit while the schema bump
   that justified it rolled back. */
function upgrade(idb, tx, oldVersion) {
  if (!idb.objectStoreNames.contains("watched")) {
    idb.createObjectStore("watched", { keyPath: "playerId" });
  }
  if (!idb.objectStoreNames.contains("names")) {
    const names = idb.createObjectStore("names", { keyPath: ["playerId", "name"] });
    names.createIndex("byPlayer", "playerId");
  }
  if (!idb.objectStoreNames.contains("servers")) {
    idb.createObjectStore("servers", { keyPath: "serverId" });
  }
  if (!idb.objectStoreNames.contains("snapshots")) {
    const snapshots = idb.createObjectStore("snapshots", { autoIncrement: true });
    snapshots.createIndex("byServer", "serverId");
  }
  if (!idb.objectStoreNames.contains("roster")) {
    const roster = idb.createObjectStore("roster", { keyPath: ["serverId", "playerId"] });
    roster.createIndex("byServer", "serverId");
  }
  if (!idb.objectStoreNames.contains("settings")) {
    idb.createObjectStore("settings", { keyPath: "key" });
  }
  // Legacy and always empty: tags moved to a single JSON blob in `settings`
  // (see listTags/saveTags). The store is kept so existing databases are not
  // touched; drop it at the next DB_VERSION bump.
  if (!idb.objectStoreNames.contains("tags")) {
    idb.createObjectStore("tags", { keyPath: "tagId" });
  }
  // One row per player per poll. This is the only store that grows with time
  // rather than with how much you track, which is why everything else was built
  // as rolling tallies. It is what the Archive reads, and it is pruned on a
  // retention window so it cannot grow without limit.
  if (!idb.objectStoreNames.contains("presence")) {
    const presence = idb.createObjectStore("presence", { autoIncrement: true });
    presence.createIndex("byPoll", ["serverId", "pollTs"]);
    presence.createIndex("byTs", "pollTs");
    presence.createIndex("byPlayer", "playerId");
  }

  /* v4: rewrite the old role vocabulary in place.

     This runs inside the version-change transaction, so it either applies
     completely or the whole upgrade rolls back and the previous data survives.
     A partial rename would be the worst outcome: half the list on one vocabulary
     and half on the other, with no way to tell which.

     Only the `role` field is touched. Labels, tags, notes, names and observation
     history are left exactly as they are. Idempotent by construction, since
     toRelationship() returns current values unchanged, so re-running it or
     upgrading from any older version lands in the same place. */
  if (tx && oldVersion > 0 && oldVersion < 4) {
    const store = tx.objectStore("watched");
    let migrated = 0;
    let hadSuspect = false;
    store.openCursor().onsuccess = (ev) => {
      const cur = ev.target.result;
      if (!cur) {
        /* Leave a breadcrumb so the dashboard can explain the change once. The
           settings store is in the same transaction, so this cannot end up
           recorded against a migration that did not commit. */
        if (migrated) {
          tx.objectStore("settings").put({
            key: "relationshipMigration",
            value: { at: nowIso(), migrated, hadSuspect, notified: false },
          });
        }
        return;
      }
      const row = cur.value;
      const next = toRelationship(row.role);
      if (next !== row.role) {
        if (String(row.role || "").toLowerCase() === "suspect") hadSuspect = true;
        cur.update({ ...row, role: next });
        migrated++;
      }
      cur.continue();
    };
  }

  /* v5: delete the stats store, and the per-server tallies that fed it.

     `stats` existed for exactly one feature: absence correlation, which scored
     how often a player was missing while server staff were online. That was an
     accusation engine, and it is gone. The store is not kept "just in case" -
     leaving it would leave the per-player absence tallies sitting in the profile
     with nothing to read them, which is precisely the data this build should not
     be holding.

     adminPolls goes with it. It counted how many polls caught staff online, and
     its only consumer was the correlation denominator. */
  if (idb.objectStoreNames.contains("stats")) idb.deleteObjectStore("stats");

  if (tx && oldVersion > 0 && oldVersion < 5) {
    const servers = tx.objectStore("servers");
    servers.openCursor().onsuccess = (ev) => {
      const cur = ev.target.result;
      if (!cur) return;
      const { adminPolls, ...rest } = cur.value;
      if (adminPolls !== undefined) cur.update(rest);
      cur.continue();
    };
    // snapshots carried an adminHere flag for the same reason. Same treatment.
    const snapshots = tx.objectStore("snapshots");
    snapshots.openCursor().onsuccess = (ev) => {
      const cur = ev.target.result;
      if (!cur) return;
      const { adminHere, ...rest } = cur.value;
      if (adminHere !== undefined) cur.update(rest);
      cur.continue();
    };
  }
}

// Cached across calls so the many small transactions a poll cycle issues share
// one connection. The service worker gets torn down and restarted by the
// browser at will, which resets this module-level state - that is fine, the
// next call just reopens. onclose/onversionchange drop the cache too, so a
// connection killed from outside (another context upgrading the db, or the
// browser reclaiming it) doesn't leave callers awaiting a dead handle.
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => upgrade(req.result, req.transaction, ev.oldVersion);
    req.onsuccess = () => {
      const idb = req.result;
      idb.onclose = () => { dbPromise = null; };
      idb.onversionchange = () => {
        idb.close();
        dbPromise = null;
      };
      resolve(idb);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqp(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Cursor delete via an index, so removing everything for one player/server
// doesn't need to pull the whole store into memory first.
function deleteByIndex(store, indexName, key) {
  return deleteByIndexRange(store, indexName, IDBKeyRange.only(key));
}

// Same as deleteByIndex, but for an arbitrary range rather than one exact key -
// what a compound index needs when only its leading component is known (see
// clearServerHistory's use against `byPoll`, which is indexed on
// [serverId, pollTs]).
function deleteByIndexRange(store, indexName, range) {
  return new Promise((resolve, reject) => {
    const req = store.index(indexName).openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// navigator.storage is unavailable in some contexts (older Chromium, and this
// module is also imported by the plain-Node test suite, which has no
// navigator at all), so absence is treated as "unknown" rather than an error -
// dataSummary() surfaces that as null rather than a fabricated number.
async function estimateBytes() {
  try {
    if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.estimate) return null;
    const { usage } = await navigator.storage.estimate();
    return typeof usage === "number" ? usage : null;
  } catch {
    return null;
  }
}

// Runs `fn(transaction)` inside one readwrite/readonly transaction spanning
// `storeNames` and resolves with whatever fn returns once the transaction
// actually commits (not just when fn's own promise settles). `fn` is invoked
// synchronously, in the same task that opens the transaction, so its first
// request is issued before control returns to the event loop - that is what
// keeps the transaction alive across the awaits inside fn in Chromium's
// microtask-friendly IndexedDB implementation. If fn throws or rejects, the
// transaction is aborted so nothing it already wrote survives.
function tx(storeNames, mode, fn) {
  return open().then((idb) => new Promise((resolve, reject) => {
    const t = idb.transaction(storeNames, mode);
    let result;
    let failed = false;

    t.oncomplete = () => resolve(result);
    t.onerror = () => { failed = true; reject(t.error); };
    t.onabort = () => { if (!failed) reject(t.error || new Error("transaction aborted")); };

    let ret;
    try {
      ret = fn(t);
    } catch (err) {
      failed = true;
      reject(err);
      try { t.abort(); } catch (_) { /* already finished */ }
      return;
    }
    Promise.resolve(ret).then(
      (r) => { result = r; },
      (err) => {
        failed = true;
        reject(err);
        try { t.abort(); } catch (_) { /* already finished */ }
      }
    );
  }));
}

export const db = {
  async init() {
    await open();
    return true;
  },

  /* --- watched players ---------------------------------------------------- */

  async listWatch() {
    return tx(["watched", "names"], "readonly", async (t) => {
      const watched = await reqp(t.objectStore("watched").getAll());
      const namesIndex = t.objectStore("names").index("byPlayer");
      for (const w of watched) {
        const rows = await reqp(namesIndex.getAll(IDBKeyRange.only(w.playerId)));
        rows.sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
        w.names = rows.map((r) => r.name);
      }
      watched.sort((a, b) =>
        (a.role || "").localeCompare(b.role || "") ||
        (a.nickname || "").localeCompare(b.nickname || "") ||
        (a.playerId || "").localeCompare(b.playerId || "")
      );
      return watched;
    });
  },

  /* Add someone, or edit them if they are already saved.

     Only the fields the caller actually passed are written. This used to
     destructure with defaults and spread the result over the existing row, so
     re-adding a person from search silently replaced the label and note the user
     had written with empty strings. Those are the whole reason for saving
     someone, so losing them to a stray click is not acceptable.

     A new row gets the neutral relationship: saving someone should never assert
     a connection the user did not choose. */
  async addWatch(entry) {
    const id = String(entry.playerId);
    const patch = {};
    for (const k of ["nickname", "role", "note"]) {
      if (entry[k] !== undefined) patch[k] = entry[k];
    }
    if (patch.role !== undefined) patch.role = toRelationship(patch.role);
    return tx(["watched"], "readwrite", async (t) => {
      const store = t.objectStore("watched");
      const existing = await reqp(store.get(id));
      const row = existing
        ? { ...existing, ...patch }
        : {
            playerId: id, nickname: "", role: "other", note: "", ...patch,
            currentName: null, private: false, addedAt: nowIso(), lastChecked: null,
          };
      store.put(row);
    });
  },

  /* Returns everything it deleted, so the caller can offer a real undo.
     Removing a player drops their alias history as well as the watch row, so
     re-adding by id would NOT restore them: the names, tags and observed
     current name would all be gone. Capturing both stores here is what makes
     undo lossless rather than a partial re-add pretending to be one. */
  async removeWatch(playerId) {
    const id = String(playerId);
    return tx(["watched", "names"], "readwrite", async (t) => {
      const store = t.objectStore("watched");
      const row = await reqp(store.get(id));
      const names = await reqp(t.objectStore("names").index("byPlayer").getAll(IDBKeyRange.only(id)));
      store.delete(id);
      await deleteByIndex(t.objectStore("names"), "byPlayer", id);
      return row ? { row, names } : null;
    });
  },

  /** Put back exactly what removeWatch returned. */
  async restoreWatch(snapshot) {
    if (!snapshot || !snapshot.row) return false;
    return tx(["watched", "names"], "readwrite", async (t) => {
      t.objectStore("watched").put(snapshot.row);
      const names = t.objectStore("names");
      for (const n of snapshot.names || []) names.put(n);
      return true;
    });
  },

  /* Every player id this device has ever seen, with the last name observed for
     it. Live updates have been writing these all along as a side effect of
     checking servers, so a name can often be resolved from what is already
     stored rather than by asking BattleMetrics again. */
  async knownPlayerNames() {
    return tx(["watched", "roster", "presence"], "readonly", async (t) => {
      const out = new Map();
      for (const w of await reqp(t.objectStore("watched").getAll())) {
        out.set(String(w.playerId), w.currentName || w.nickname || "");
      }
      for (const r of await reqp(t.objectStore("roster").getAll())) {
        if (!out.has(String(r.playerId))) out.set(String(r.playerId), r.playerName || "");
      }
      // nextunique visits one record per distinct player instead of walking
      // every presence row, which is the store that grows without bound.
      await new Promise((resolve, reject) => {
        const req = t.objectStore("presence").index("byPlayer").openCursor(null, "nextunique");
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve();
          const id = String(c.value.playerId);
          if (!out.has(id)) out.set(id, c.value.playerName || "");
          c.continue();
        };
        req.onerror = () => reject(req.error);
      });
      return out;
    });
  },

  // meta may carry lastSeen / firstSeen (ISO). A page that did not render those
  // (older cache, partial load) passes them as undefined; only defined values are
  // written, so a good stored timestamp is never wiped by a blank read.
  async setCurrentName(playerId, name, isPrivate = false, meta = {}) {
    const id = String(playerId);
    return tx(["watched"], "readwrite", async (t) => {
      const store = t.objectStore("watched");
      const existing = await reqp(store.get(id));
      if (!existing) return;
      const row = { ...existing, currentName: name, private: !!isPrivate, lastChecked: nowIso() };
      if (meta.lastSeen != null) row.lastSeen = meta.lastSeen;
      if (meta.firstSeen != null) row.firstSeen = meta.firstSeen;
      store.put(row);
    });
  },

  /* --- custom tags --------------------------------------------------------- */
  /* Tags are free-form labels the user creates, each with its own colour. The
     catalogue of available tags lives in settings under one key; a player just
     stores the tag names they carry. Storing names rather than copies means
     recolouring a tag updates every player at once. */
  async listTags() {
    const raw = await this.getSetting("tags", null);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  },

  async saveTags(tags) {
    await this.setSetting("tags", JSON.stringify(tags || []));
    return tags || [];
  },

  async setPlayerTags(playerId, tags) {
    const id = String(playerId);
    return tx(["watched"], "readwrite", async (t) => {
      const store = t.objectStore("watched");
      const existing = await reqp(store.get(id));
      if (!existing) return;
      store.put({ ...existing, tags: [...new Set((tags || []).filter(Boolean))] });
    });
  },

  // Role only, preserving nickname / note / names / seen data. Used by the inline
  // role picker and the multi-select bulk change.
  async setRole(playerId, role) {
    const id = String(playerId);
    return tx(["watched"], "readwrite", async (t) => {
      const store = t.objectStore("watched");
      const existing = await reqp(store.get(id));
      if (!existing) return;
      // Normalised on the way in so nothing outside the current vocabulary can
      // reach the store, whatever a caller passes.
      store.put({ ...existing, role: toRelationship(role) });
    });
  },

  async recordNames(playerId, names) {
    const id = String(playerId);
    const list = [...new Set((names || []).filter(Boolean))];
    if (!list.length) return;
    const ts = nowIso();
    return tx(["names"], "readwrite", async (t) => {
      const store = t.objectStore("names");
      for (const name of list) {
        const existing = await reqp(store.get([id, name]));
        if (existing) {
          store.put({ ...existing, lastSeen: ts });
        } else {
          store.put({ playerId: id, name, firstSeen: ts, lastSeen: ts });
        }
      }
    });
  },

  /* Saved people marked as server staff. Read through toRelationship so a
     database that has not yet been upgraded, or a row written by an older build,
     still resolves correctly rather than silently matching nothing. */
  async staffIds() {
    return tx(["watched"], "readonly", async (t) => {
      const rows = await reqp(t.objectStore("watched").getAll());
      return new Set(rows.filter((r) => toRelationship(r.role) === "staff").map((r) => r.playerId));
    });
  },

  /* --- tracked servers ------------------------------------------------------ */

  async listServers() {
    return tx(["servers"], "readonly", async (t) => {
      const rows = await reqp(t.objectStore("servers").getAll());
      rows.sort((a, b) =>
        (a.nickname || "").localeCompare(b.nickname || "") ||
        (a.serverId || "").localeCompare(b.serverId || "")
      );
      return rows;
    });
  },

  // Same partial-write rule as addWatch: tracking a server you already track
  // must not wipe the nickname and note you gave it.
  async addServer(entry) {
    const id = String(entry.serverId);
    const patch = {};
    for (const k of ["nickname", "note"]) {
      if (entry[k] !== undefined) patch[k] = entry[k];
    }
    return tx(["servers"], "readwrite", async (t) => {
      const store = t.objectStore("servers");
      const existing = await reqp(store.get(id));
      const row = existing
        ? { ...existing, ...patch, game: entry.game || existing.game || null }
        : {
            serverId: id, nickname: "", note: "", ...patch,
            name: null, game: entry.game || null,
            addedAt: nowIso(), lastChecked: null, totalPolls: 0,
          };
      store.put(row);
    });
  },

  async removeServer(serverId) {
    const id = String(serverId);
    return tx(["servers", "roster"], "readwrite", async (t) => {
      t.objectStore("servers").delete(id);
      await deleteByIndex(t.objectStore("roster"), "byServer", id);
    });
  },

  async updateServerMeta(serverId, name, game = null) {
    const id = String(serverId);
    return tx(["servers"], "readwrite", async (t) => {
      const store = t.objectStore("servers");
      const existing = await reqp(store.get(id));
      if (!existing) return;
      store.put({ ...existing, name, game: game || existing.game || null, lastChecked: nowIso() });
    });
  },

  /* One write for everything a poll observes about a watched player it just saw
     in a roster. This is where the Monitor keeps the Watchlist current on its
     own, which it previously did not: the old setLastServer recorded WHEN and
     WHERE a player was seen but threw away the live in-game name sitting right
     next to it, so the watchlist kept showing a stale name until someone ran a
     manual refresh. Now the roster name updates currentName and the alias
     history in the same transaction.

     `private` is deliberately never touched here. A roster row does not carry
     it, and a sighting must not clear the hidden flag on a profile we already
     know is private (which only the player page can tell us). currentName is
     only overwritten when the roster actually gave us a name. */
  async recordWatchedSighting(playerId, name, serverId, serverName, ts) {
    const id = String(playerId);
    const nm = (name || "").trim();
    return tx(["watched", "names"], "readwrite", async (t) => {
      const store = t.objectStore("watched");
      const existing = await reqp(store.get(id));
      if (!existing) return;
      const row = {
        ...existing,
        lastServerId: String(serverId),
        lastServerName: serverName,
        lastServerSeen: ts,
      };
      if (nm) {
        row.currentName = nm;
        row.lastChecked = ts;
      }
      store.put(row);

      if (nm) {
        const names = t.objectStore("names");
        const prev = await reqp(names.get([id, nm]));
        names.put(prev ? { ...prev, lastSeen: ts } : { playerId: id, name: nm, firstSeen: ts, lastSeen: ts });
      }
    });
  },

  /* --- archive ---------------------------------------------------------- */

  /** Snapshots newest first, optionally limited to one server, each carrying the
   *  players seen in that poll. This is the only view built from raw history
   *  rather than rolling tallies.
   *
   *  Read through indexes and cursors, never getAll(). getAll() on `presence`
   *  deserialised the ENTIRE history to render one page: at this tool's own
   *  defaults (4 servers, a 5-minute interval, ~50 players, the 14-day presence
   *  window) that is on the order of 800,000 objects for a 60-row view. A
   *  reverse cursor stops as soon as it has `limit` rows, and the byPoll index
   *  fetches only the players belonging to those specific polls. */
  async archive({ serverId = null, since = null, limit = 60 } = {}) {
    return tx(["snapshots", "presence", "servers", "watched"], "readonly", async (t) => {
      const servers = await reqp(t.objectStore("servers").getAll());
      const watched = await reqp(t.objectStore("watched").getAll());
      const byServer = new Map(servers.map((s) => [String(s.serverId), s]));
      const watchedById = new Map(watched.map((w) => [String(w.playerId), w]));

      // Autoincrement keys are handed out in insertion order, and polls only
      // ever append, so walking backwards is newest-first. Filtering by server
      // uses the byServer index so a quiet server does not force a scan of
      // every other server's history to find its rows.
      const snapStore = t.objectStore("snapshots");
      const source = serverId
        ? snapStore.index("byServer").openCursor(IDBKeyRange.only(String(serverId)), "prev")
        : snapStore.openCursor(null, "prev");

      const rows = [];
      await new Promise((resolve, reject) => {
        source.onsuccess = () => {
          const cur = source.result;
          if (!cur || rows.length >= limit) return resolve();
          const s = cur.value;
          if (!since || s.pollTs >= since) rows.push(s);
          cur.continue();
        };
        source.onerror = () => reject(source.error);
      });
      // Newest first, then by server id so that the several rows sharing one
      // cycle's timestamp have a stable, defined order. The previous
      // implementation happened to emit them in insertion order; relying on
      // that was incidental, and a cursor walks it backwards. At most `limit`
      // rows reach this sort.
      rows.sort((a, b) =>
        String(b.pollTs).localeCompare(String(a.pollTs)) ||
        String(a.serverId).localeCompare(String(b.serverId)));

      const byPoll = t.objectStore("presence").index("byPoll");
      const out = [];
      for (const s of rows) {
        const list = await reqp(byPoll.getAll(IDBKeyRange.only([String(s.serverId), s.pollTs])));
        const srv = byServer.get(String(s.serverId));
        out.push({
          serverId: String(s.serverId),
          serverName: srv ? (srv.nickname || srv.name) : (s.serverName || s.serverId),
          game: srv ? srv.game : null,
          pollTs: s.pollTs,
          players: s.players,
          maxPlayers: s.maxPlayers,
          roster: list.map((p) => {
            const w = watchedById.get(String(p.playerId));
            return {
              id: p.playerId, name: p.playerName,
              watched: !!w, nickname: w ? w.nickname : null, role: w ? w.role : null,
            };
          }),
        });
      }
      return out;
    });
  },

  /* Where each of these players was last seen on a tracked server, from our own
     poll history. One index lookup per id and no network at all.

     This exists because the search was asking BattleMetrics a question it had
     already answered itself. Every Monitor cycle writes who was on each tracked
     server, so for anyone the poller has observed, "do they play on my servers"
     is a local read. Reserving the sessions page for players we have genuinely
     never seen turns a dozen page loads into none for the common case.

     A reverse cursor on byPlayer gives the newest row first: presence keys are
     autoincrement and polls only append, so insertion order is chronological. */
  async trackedSightings(playerIds) {
    const want = [...new Set([...(playerIds || [])].map(String))];
    if (!want.length) return new Map();
    return tx(["presence", "servers"], "readonly", async (t) => {
      const servers = await reqp(t.objectStore("servers").getAll());
      const byServer = new Map(servers.map((s) => [String(s.serverId), s]));
      const idx = t.objectStore("presence").index("byPlayer");
      const out = new Map();
      for (const id of want) {
        const newest = await new Promise((resolve, reject) => {
          const req = idx.openCursor(IDBKeyRange.only(id), "prev");
          req.onsuccess = () => resolve(req.result ? req.result.value : null);
          req.onerror = () => reject(req.error);
        });
        if (!newest) continue;
        const srv = byServer.get(String(newest.serverId));
        out.set(id, {
          serverId: String(newest.serverId),
          serverName: srv ? (srv.nickname || srv.name || newest.serverId) : String(newest.serverId),
          lastSeen: newest.pollTs,
        });
      }
      return out;
    });
  },

  /** Every distinct appearance of one player across stored history. */
  async playerSessions(playerId, limit = 200) {
    const id = String(playerId);
    return tx(["presence", "servers"], "readonly", async (t) => {
      const rows = await reqp(t.objectStore("presence").index("byPlayer").getAll(IDBKeyRange.only(id)));
      const servers = await reqp(t.objectStore("servers").getAll());
      const byServer = new Map(servers.map((s) => [String(s.serverId), s]));
      rows.sort((a, b) => String(b.pollTs).localeCompare(String(a.pollTs)));
      return rows.slice(0, limit).map((p) => {
        const srv = byServer.get(String(p.serverId));
        return {
          pollTs: p.pollTs, name: p.playerName, serverId: p.serverId,
          serverName: srv ? (srv.nickname || srv.name) : p.serverId,
        };
      });
    });
  },

  /* Snapshots had no retention limit at all, so the one store that grows with
     elapsed time rather than with how much you track grew forever: ~1,150 rows
     a day at four servers on a five-minute interval. They are small, but the
     headline "stored snapshots" figure is built from them, so they are pruned
     on the same window as presence rather than left to grow indefinitely.

     The default below is effectively dead in normal operation: every real
     caller (applyRetention, via the single `retentionDays` setting) passes an
     explicit value now that one retention period covers both stores, per the
     audit's "recent activity and server-check history" wording. It is kept at
     14 rather than the old 365 so a caller that forgets to pass a value fails
     safe towards deleting more, not silently keeping a year of history.

     Autoincrement keys are issued in insertion order and polls only append, so
     the oldest rows are at the front; the cursor stops at the first row inside
     the window instead of walking the whole store. */
  async pruneSnapshots(days = 14) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
    return tx(["snapshots"], "readwrite", async (t) => {
      const store = t.objectStore("snapshots");
      let removed = 0;
      await new Promise((resolve, reject) => {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve();
          if (String(cur.value.pollTs) >= cutoff) return resolve();
          cur.delete();
          removed++;
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
      return removed;
    });
  },

  async prunePresence(days = 14) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
    return tx(["presence"], "readwrite", async (t) => {
      const store = t.objectStore("presence");
      const idx = store.index("byTs");
      let removed = 0;
      await new Promise((resolve, reject) => {
        const req = idx.openCursor(IDBKeyRange.upperBound(cutoff, true));
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) { resolve(); return; }
          cur.delete();
          removed++;
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
      return removed;
    });
  },

  /* --- retention and deletion --------------------------------------------- */

  /* Everything the Data and privacy panel's "at a glance" section needs, in one
     call. `bytes` is null whenever navigator.storage.estimate() is not
     available rather than a fabricated 0 - the caller is expected to render
     that as "not available", never as an empty database. */
  async dataSummary() {
    const [totals, bytes] = await Promise.all([
      tx(["watched", "servers", "presence", "snapshots"], "readonly", async (t) => {
        const people = await reqp(t.objectStore("watched").count());
        const servers = await reqp(t.objectStore("servers").count());
        const observations = await reqp(t.objectStore("presence").count());
        const snapshots = await reqp(t.objectStore("snapshots").count());
        // byTs is sorted ascending by pollTs, so the first row under a forward
        // cursor is the oldest observation still retained.
        const oldestObservation = await new Promise((resolve, reject) => {
          const req = t.objectStore("presence").index("byTs").openCursor();
          req.onsuccess = () => resolve(req.result ? req.result.value.pollTs : null);
          req.onerror = () => reject(req.error);
        });
        return { people, servers, observations, oldestObservation, snapshots };
      }),
      estimateBytes(),
    ]);
    return { ...totals, bytes };
  },

  /* One number the user sets once, applied to both presence and snapshots (see
     applyRetention), rather than a separate knob per store. Reading and writing
     both clamp, so a value that reached the settings store some other way (a
     future import, a hand-edited profile) can never make a poll cycle compute a
     negative or absurd cutoff. */
  async retentionDays() {
    return clampRetentionDays(await this.getSetting("retentionDays", RETENTION_DEFAULT_DAYS));
  },

  async setRetentionDays(n) {
    const days = clampRetentionDays(n);
    await this.setSetting("retentionDays", days);
    return days;
  },

  /** Prunes presence and snapshots to the same window in one call, so the one
   *  retention setting the user sees actually governs both stores the audit
   *  groups together as "recent activity and server-check history". Reuses the
   *  existing per-store pruners rather than duplicating their cursor logic. */
  async applyRetention(days) {
    const d = clampRetentionDays(days);
    const presence = await this.prunePresence(d);
    const snapshots = await this.pruneSnapshots(d);
    return { presence, snapshots };
  },

  /* Everything BattleMetrics observed a specific player doing, without touching
     the saved watchlist row itself: the point is "forget where I've seen them",
     not "forget I know them". */
  async clearPlayerHistory(playerId) {
    const id = String(playerId);
    return tx(["presence", "names"], "readwrite", async (t) => {
      await deleteByIndex(t.objectStore("presence"), "byPlayer", id);
      await deleteByIndex(t.objectStore("names"), "byPlayer", id);
    });
  },

  /* Everything a poll ever recorded about one server, without dropping the
     tracked server itself: the counterpart to clearPlayerHistory.

     `presence` has no serverId-only index, but `byPoll` IS usable here: it is
     compound on [serverId, pollTs], and a compound index supports a bounded
     range on its leading component. IDBKeyRange.bound([id], [id, []]) selects
     every key whose first element is `id`, whatever the second element is.
     The upper bound is the empty array `[]`, not a string sentinel, because
     IndexedDB's key ordering ranks every Array above every String and Number
     - recordPoll always writes pollTs as an ISO string today (see
     storePage/pollServers in worker.js), but an array bound stays a true
     upper bound even if that ever stopped being true, where a string
     sentinel would silently miss anything that wasn't a string. Deleting
     through this range matters because presence is the one store this
     codebase documents as growing without bound over time (see
     prunePresence) - a user-triggered "clear this server's history" should
     touch only the rows it deletes, not scan the whole store.

*/
  async clearServerHistory(serverId) {
    const id = String(serverId);
    return tx(["presence", "snapshots", "roster"], "readwrite", async (t) => {
      await deleteByIndexRange(t.objectStore("presence"), "byPoll", IDBKeyRange.bound([id], [id, []]));
      await deleteByIndex(t.objectStore("snapshots"), "byServer", id);
      await deleteByIndex(t.objectStore("roster"), "byServer", id);
    });
  },

  /* Clears the labels the user attached themselves - nickname, note, and tag
     assignments - without touching the relationship category. A relationship
     records who someone IS to the user (friend, teammate, ...); nicknames,
     notes and tags are free-form annotations, and "reset labels and tags" asks
     to clear the annotations, not to forget the connection.

     The `tags` object store cleared below is legacy and already always empty
     in practice - see its comment in upgrade() - so clearing it is a
     formality, not the substance of this method. The actual tag catalogue
     (names and colours the user defined) lives in `settings["tags"]`, read
     and written by listTags()/saveTags(), and is DELIBERATELY left alone
     here: it is the user's own vocabulary, not an annotation on a specific
     person, and "reset labels and tags" means clearing who has which tag,
     not deleting the tags themselves (including the built-in Favourite,
     which the UI recreates anyway). Do not read the store clear below as an
     attempt at that and "fix" it to also wipe the catalogue. */
  async resetLabelsAndTags() {
    return tx(["watched", "tags"], "readwrite", async (t) => {
      const store = t.objectStore("watched");
      await new Promise((resolve, reject) => {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) { resolve(); return; }
          cur.update({ ...cur.value, nickname: "", note: "", tags: [] });
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
      await reqp(t.objectStore("tags").clear());
    });
  },

  /* Deletes the CONTENTS of every store while leaving the database itself, and
     therefore this connection, intact - deleting the database out from under an
     open connection would either fail or force every open tab to reload before
     anything could be written again, which "delete all data" should not require. */
  async deleteAllData() {
    return tx(STORE_NAMES, "readwrite", async (t) => {
      for (const name of STORE_NAMES) {
        await reqp(t.objectStore(name).clear());
      }
    });
  },

  /** Wipe everything derived from polling so monitoring can start clean: the
   *  snapshots, the presence history behind the Archive, the current rosters and
   *  the rolling correlation tallies. Watched players, tags and tracked servers
   *  survive, though each server's poll counters reset to zero so correlation is
   *  not left comparing new observations against old totals. */
  async clearPolls() {
    return tx(["snapshots", "presence", "roster", "servers"], "readwrite", async (t) => {
      const counts = {
        snapshots: await reqp(t.objectStore("snapshots").count()),
        presence: await reqp(t.objectStore("presence").count()),
      };
      await reqp(t.objectStore("snapshots").clear());
      await reqp(t.objectStore("presence").clear());
      await reqp(t.objectStore("roster").clear());
      const servers = t.objectStore("servers");
      for (const s of await reqp(servers.getAll())) {
        servers.put({ ...s, totalPolls: 0, lastChecked: null });
      }
      return counts;
    });
  },

  async presenceCount() {
    return tx(["presence"], "readonly", async (t) => reqp(t.objectStore("presence").count()));
  },

  /* --- polling ---------------------------------------------------------- */

  // Snapshot, server tally and roster replacement all land in one readwrite
  // transaction. IndexedDB commits or aborts a transaction as a whole, so a
  // mid-write failure (quota, a bad value) cannot leave the roster deleted but
  // not refilled, or a snapshot recorded without the player list it describes.
  async recordPoll({ serverId, ts, info = {}, roster = [] }) {
    const sid = String(serverId);
    const rows = roster.map((p) => ({ id: String(p.id), name: p.name }));

    return tx(["snapshots", "servers", "roster", "presence"], "readwrite", async (t) => {
      t.objectStore("snapshots").add({
        serverId: sid,
        pollTs: ts,
        players: info.players,
        maxPlayers: info.maxPlayers,
        serverName: info.name || null,
      });

      // Presence history: what the Archive replays later. Same transaction as the
      // snapshot it belongs to, so a snapshot never exists without its player list.
      const presenceStore = t.objectStore("presence");
      for (const p of rows) {
        presenceStore.add({ serverId: sid, pollTs: ts, playerId: p.id, playerName: p.name });
      }

      const serverStore = t.objectStore("servers");
      const existingServer = await reqp(serverStore.get(sid));
      const serverRow = existingServer
        ? {
            ...existingServer,
            totalPolls: (existingServer.totalPolls || 0) + 1,
            // A page that rendered without a heading must not wipe a name we
            // already have; extract returns null rather than guessing.
            name: info.name || existingServer.name,
            lastChecked: ts,
          }
        : {
            serverId: sid, nickname: "", note: "", name: info.name,
            addedAt: ts, lastChecked: ts, totalPolls: 1,
          };
      serverStore.put(serverRow);

      const rosterStore = t.objectStore("roster");
      await deleteByIndex(rosterStore, "byServer", sid);
      for (const p of rows) {
        rosterStore.put({ serverId: sid, playerId: p.id, playerName: p.name, pollTs: ts });
      }
    });
  },

  async currentOnline() {
    return tx(["servers", "roster"], "readonly", async (t) => {
      const servers = await reqp(t.objectStore("servers").getAll());
      const rosterIndex = t.objectStore("roster").index("byServer");
      const out = [];
      for (const s of servers) {
        const rows = await reqp(rosterIndex.getAll(IDBKeyRange.only(s.serverId)));
        out.push({
          serverId: s.serverId,
          nickname: s.nickname,
          name: s.name,
          pollTs: rows.length ? rows[0].pollTs : s.lastChecked,
          players: rows.length,
          roster: rows.map((r) => ({ id: r.playerId, name: r.playerName })),
        });
      }
      return out;
    });
  },

  async stats() {
    return tx(["snapshots", "servers", "watched"], "readonly", async (t) => {
      const snapshots = await reqp(t.objectStore("snapshots").count());
      const servers = await reqp(t.objectStore("servers").count());
      const watched = await reqp(t.objectStore("watched").count());
      // Autoincrement keys are handed out in insertion order, so the last entry
      // under a reverse cursor is the most recent poll - cheaper than scanning
      // every snapshot for the max pollTs.
      const lastPoll = await new Promise((resolve, reject) => {
        const req = t.objectStore("snapshots").openCursor(null, "prev");
        req.onsuccess = () => resolve(req.result ? req.result.value.pollTs : null);
        req.onerror = () => reject(req.error);
      });
      return { snapshots, servers, watched, lastPoll };
    });
  },

  /* --- settings --------------------------------------------------------- */

  async getSetting(key, dflt) {
    return tx(["settings"], "readonly", async (t) => {
      const row = await reqp(t.objectStore("settings").get(key));
      return row ? row.value : dflt;
    });
  },

  async setSetting(key, value) {
    return tx(["settings"], "readwrite", async (t) => {
      t.objectStore("settings").put({ key, value });
    });
  },

  /* --- backup ------------------------------------------------------------- */

  async exportAll() {
    return tx(STORE_NAMES, "readonly", async (t) => {
      const out = {};
      for (const name of STORE_NAMES) {
        out[name] = await reqp(t.objectStore(name).getAll());
      }
      return out;
    });
  },

  /* Restore a full backup, replacing everything.

     This used to clear every store and then write whatever the file happened to
     contain. Handing it a shared people list, or any unrelated JSON, therefore
     emptied the database and put nothing back - the one operation people reach
     for precisely when they cannot afford to lose anything. It now refuses
     anything that is not recognisably a backup, and it only clears a store it is
     actually going to refill.

     Still destructive by design: a restore replaces. The caller is responsible
     for confirming that with the user first. */
  async importAll(json) {
    const data = json || {};
    const present = STORE_NAMES.filter((name) => Array.isArray(data[name]));
    if (!present.length) {
      throw new Error("That file is not a BMFinder backup, so nothing was changed.");
    }
    return tx(STORE_NAMES, "readwrite", async (t) => {
      for (const name of present) {
        const store = t.objectStore(name);
        await reqp(store.clear());
        for (const row of data[name]) store.put(row);
      }
      return { restored: present, counts: Object.fromEntries(present.map((n) => [n, data[n].length])) };
    });
  },

  /* Import only the parts of a backup the user ticked.

     `stores` is the resolved store list for those parts (see transfer.js), and
     anything outside it is ignored entirely - a file can hold a full backup and
     still contribute only its saved people if that is all that was asked for.

     mode "replace" clears each store first, so the ticked areas end up exactly
     as the file has them. mode "merge" adds only rows whose key is not already
     present, which makes what is already here authoritative: importing a friend's
     backup can add people you do not have without touching anyone you do. */
  async importSelective(json, stores, mode = "merge") {
    const data = json || {};
    const usable = (stores || []).filter((s) => STORE_NAMES.includes(s) && Array.isArray(data[s]));
    if (!usable.length) {
      throw new Error("Nothing in that file matched what you asked to import.");
    }
    return tx(usable, "readwrite", async (t) => {
      const counts = {};
      for (const name of usable) {
        const store = t.objectStore(name);
        if (mode === "replace") {
          await reqp(store.clear());
          for (const row of data[name]) store.put(row);
          counts[name] = data[name].length;
          continue;
        }
        /* Merge. An out-of-line key store (snapshots, presence) has no key to
           compare, so its rows are appended - they are observations, and two
           observations of the same moment are not a conflict worth solving. */
        let added = 0;
        for (const row of data[name]) {
          if (!store.keyPath) { store.add(row); added++; continue; }
          const key = Array.isArray(store.keyPath)
            ? store.keyPath.map((k) => row[k])
            : row[store.keyPath];
          if (key === undefined || (Array.isArray(key) && key.some((k) => k === undefined))) continue;
          const existing = await reqp(store.get(key));
          if (existing === undefined) { store.put(row); added++; }
        }
        counts[name] = added;
      }
      return { mode, stores: usable, counts };
    });
  },

  /* Merge people in from a shared list or CSV, rather than replacing anything.
     The entries have already been reconciled against what is saved (see
     lib/transfer.js), so this only writes them. addWatch writes only the fields
     each entry carries, which is what keeps an existing label intact. */
  async importPeople(entries) {
    let added = 0, updated = 0;
    for (const entry of entries || []) {
      const existing = await tx(["watched"], "readonly", async (t) =>
        reqp(t.objectStore("watched").get(String(entry.playerId))));

      /* Tags are not one of addWatch's fields - they are held on the row but
         written through setPlayerTags, and addWatch drops anything outside
         nickname/role/note. Passing them to addWatch silently lost them, so
         they are applied separately here. */
      const { tags, ...fields } = entry;
      await this.addWatch(fields);
      if (tags) await this.setPlayerTags(entry.playerId, tags);

      if (existing) updated++; else added++;
    }
    return { added, updated };
  },
};
