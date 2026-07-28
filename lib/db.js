/* IndexedDB persistence for the extension. Mirrors the D1 schema (see
   ../../schema.sql and ../../src/store.js) but lives in the browser profile
   instead of a Worker's database, so every id that used to be a SQLite TEXT
   primary key gets coerced with String() here too - IndexedDB keys are typed,
   and a numeric 123 and a string "123" are different keys, which would silently
   split one player or server into two records. */

const DB_NAME = "bmfinder";
// v2 added the tags store, v3 added presence (the Archive's per poll player list).
// upgrade() only creates what is missing, so bumping the version adds stores to an
// existing profile without touching the data already there.
const DB_VERSION = 3;

const STORE_NAMES = [
  "watched", "names", "servers", "snapshots", "roster", "stats", "settings", "tags",
  "presence",
];

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function upgrade(idb) {
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
  if (!idb.objectStoreNames.contains("stats")) {
    const stats = idb.createObjectStore("stats", { keyPath: ["playerId", "serverId"] });
    stats.createIndex("byPlayer", "playerId");
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
    req.onupgradeneeded = () => upgrade(req.result);
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
  return new Promise((resolve, reject) => {
    const req = store.index(indexName).openCursor(IDBKeyRange.only(key));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// `stats` only indexes playerId (see byPlayer below), so removing one server's
// rows has no index to use and has to walk the whole store with a predicate.
function deleteWhere(store, predicate) {
  return new Promise((resolve, reject) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      if (predicate(cursor.value)) cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
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

  async addWatch({ playerId, nickname = "", role = "admin", note = "" }) {
    const id = String(playerId);
    return tx(["watched"], "readwrite", async (t) => {
      const store = t.objectStore("watched");
      const existing = await reqp(store.get(id));
      const row = existing
        ? { ...existing, nickname, role, note }
        : {
            playerId: id, nickname, role, note,
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
     it. The poller has been writing these all along as a side effect of
     watching servers, so this is a corpus of real, in-use ids that cost nothing
     to collect. An ID scan can score them without a single request. */
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
      store.put({ ...existing, role });
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

  async adminIds() {
    return tx(["watched"], "readonly", async (t) => {
      const rows = await reqp(t.objectStore("watched").getAll());
      return new Set(rows.filter((r) => r.role === "admin").map((r) => r.playerId));
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

  async addServer({ serverId, nickname = "", note = "", game = null }) {
    const id = String(serverId);
    return tx(["servers"], "readwrite", async (t) => {
      const store = t.objectStore("servers");
      const existing = await reqp(store.get(id));
      const row = existing
        ? { ...existing, nickname, note, game: game || existing.game || null }
        : {
            serverId: id, nickname, note, name: null, game: game || null,
            addedAt: nowIso(), lastChecked: null, totalPolls: 0, adminPolls: 0,
          };
      store.put(row);
    });
  },

  async removeServer(serverId) {
    const id = String(serverId);
    return tx(["servers", "roster", "stats"], "readwrite", async (t) => {
      t.objectStore("servers").delete(id);
      await deleteByIndex(t.objectStore("roster"), "byServer", id);
      await deleteWhere(t.objectStore("stats"), (row) => row.serverId === id);
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

  // Record that we saw a watched player on one of our tracked servers just now.
  // This is the authoritative "last seen" for the watchlist: it comes from our own
  // roster observation, so it cannot disagree with reality the way the player
  // page's global figure can.
  async setLastServer(playerId, serverId, serverName, ts) {
    const id = String(playerId);
    return tx(["watched"], "readwrite", async (t) => {
      const store = t.objectStore("watched");
      const existing = await reqp(store.get(id));
      if (!existing) return;
      store.put({ ...existing, lastServerId: String(serverId), lastServerName: serverName, lastServerSeen: ts });
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
          adminHere: !!s.adminHere,
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
     a day at four servers on a five-minute interval. They are small, and the
     headline "stored snapshots" figure is built from them, so the default
     window is deliberately generous (a year) rather than matching presence.

     Autoincrement keys are issued in insertion order and polls only append, so
     the oldest rows are at the front; the cursor stops at the first row inside
     the window instead of walking the whole store. */
  async pruneSnapshots(days = 365) {
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
      await new Promise((resolve, reject) => {
        const req = idx.openCursor(IDBKeyRange.upperBound(cutoff, true));
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) { resolve(); return; }
          cur.delete();
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
  },

  /** Wipe everything derived from polling so monitoring can start clean: the
   *  snapshots, the presence history behind the Archive, the current rosters and
   *  the rolling correlation tallies. Watched players, tags and tracked servers
   *  survive, though each server's poll counters reset to zero so correlation is
   *  not left comparing new observations against old totals. */
  async clearPolls() {
    return tx(["snapshots", "presence", "roster", "stats", "servers"], "readwrite", async (t) => {
      const counts = {
        snapshots: await reqp(t.objectStore("snapshots").count()),
        presence: await reqp(t.objectStore("presence").count()),
      };
      await reqp(t.objectStore("snapshots").clear());
      await reqp(t.objectStore("presence").clear());
      await reqp(t.objectStore("roster").clear());
      await reqp(t.objectStore("stats").clear());
      const servers = t.objectStore("servers");
      for (const s of await reqp(servers.getAll())) {
        servers.put({ ...s, totalPolls: 0, adminPolls: 0, lastChecked: null });
      }
      return counts;
    });
  },

  async presenceCount() {
    return tx(["presence"], "readonly", async (t) => reqp(t.objectStore("presence").count()));
  },

  /* --- polling ---------------------------------------------------------- */

  // Snapshot, server tally, roster replacement and per-player stats all land in
  // one readwrite transaction. IndexedDB commits or aborts a transaction as a
  // whole, so a mid-write failure (quota, a bad value) cannot leave the roster
  // deleted but not refilled, or a snapshot recorded with stats left stale.
  async recordPoll({ serverId, ts, info = {}, roster = [], admins = [] }) {
    const sid = String(serverId);
    const adminSet = new Set(Array.from(admins, String));
    const rows = roster.map((p) => ({ id: String(p.id), name: p.name }));
    const adminHere = rows.some((p) => adminSet.has(p.id)) ? 1 : 0;

    return tx(["snapshots", "servers", "roster", "stats", "presence"], "readwrite", async (t) => {
      t.objectStore("snapshots").add({
        serverId: sid,
        pollTs: ts,
        players: info.players,
        maxPlayers: info.maxPlayers,
        serverName: info.name || null,
        adminHere,
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
            adminPolls: (existingServer.adminPolls || 0) + adminHere,
            // A page that rendered without a heading must not wipe a name we
            // already have; extract returns null rather than guessing.
            name: info.name || existingServer.name,
            lastChecked: ts,
          }
        : {
            serverId: sid, nickname: "", note: "", name: info.name,
            addedAt: ts, lastChecked: ts, totalPolls: 1, adminPolls: adminHere,
          };
      serverStore.put(serverRow);

      const rosterStore = t.objectStore("roster");
      await deleteByIndex(rosterStore, "byServer", sid);
      for (const p of rows) {
        rosterStore.put({ serverId: sid, playerId: p.id, playerName: p.name, pollTs: ts });
      }

      // Admins define the present/absent window; they are never scored as candidates.
      const statsStore = t.objectStore("stats");
      for (const p of rows) {
        if (adminSet.has(p.id)) continue;
        const existing = await reqp(statsStore.get([p.id, sid]));
        const row = existing
          ? {
              ...existing,
              lastName: p.name,
              total: existing.total + 1,
              absent: existing.absent + (adminHere ? 0 : 1),
              present: existing.present + (adminHere ? 1 : 0),
              lastSeen: ts,
            }
          : {
              playerId: p.id, serverId: sid, lastName: p.name,
              total: 1, absent: adminHere ? 0 : 1, present: adminHere ? 1 : 0,
              firstSeen: ts, lastSeen: ts,
            };
        statsStore.put(row);
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

  /* --- correlation support -------------------------------------------------- */

  async allStats() {
    return tx(["stats"], "readonly", async (t) => reqp(t.objectStore("stats").getAll()));
  },

  async serversWithAdminActivity() {
    return tx(["servers"], "readonly", async (t) => {
      const rows = await reqp(t.objectStore("servers").getAll());
      return new Set(rows.filter((r) => (r.adminPolls || 0) > 0).map((r) => r.serverId));
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

  async importAll(json) {
    const data = json || {};
    return tx(STORE_NAMES, "readwrite", async (t) => {
      for (const name of STORE_NAMES) {
        const store = t.objectStore(name);
        await reqp(store.clear());
        const rows = Array.isArray(data[name]) ? data[name] : [];
        for (const row of rows) store.put(row);
      }
    });
  },
};
