/* Reading files back in.

   Export was rebuilt carefully; import was not, and it was the more dangerous
   half. `db.importAll` clears every store and then writes whatever it finds, so
   handing it the wrong JSON - a shared people list, an unrelated file, `{}` -
   emptied the database and put nothing back. Someone restoring what they thought
   was a backup could lose everything they had.

   So nothing here writes. These functions only inspect a parsed file and report
   what it is and what importing it would do. The caller decides, the user
   confirms, and the worker performs the write. Being pure is also what makes
   this testable without a browser. */

import { RELATIONSHIPS, toRelationship } from "./relationships.js";

/* Stores a full backup is expected to carry. `stats` is deliberately absent:
   it was deleted at schema v5, and a v4 backup that still contains it is not
   invalid - the extra key is simply ignored on restore. */
export const BACKUP_STORES = [
  "watched", "names", "servers", "snapshots", "roster", "settings", "tags", "presence",
];

export const LIST_FORMAT = "bmfinder-list";

/* What a backup can be taken apart into.

   Grouped by what a person would recognise, not by store: nobody thinks in
   terms of a `names` store, they think "my saved people, with the names they
   have used". The groups are whole — a part is imported or it is not — so there
   is no way to end up with alias history for people who were not brought in. */
export const IMPORT_PARTS = {
  people: { label: "Saved people", stores: ["watched", "names"] },
  servers: { label: "Followed servers", stores: ["servers"] },
  activity: { label: "Recent activity", stores: ["presence", "snapshots", "roster"] },
  settings: { label: "Settings and tags", stores: ["settings", "tags"] },
};

/** Row counts per part, for showing what a file actually holds before importing. */
export function summariseBackup(parsed) {
  const out = {};
  for (const [key, part] of Object.entries(IMPORT_PARTS)) {
    // The headline count is the first store in the group: the people, the
    // servers, the observations. The rest travel with them.
    const [primary] = part.stores;
    out[key] = {
      label: part.label,
      count: Array.isArray(parsed && parsed[primary]) ? parsed[primary].length : 0,
      present: part.stores.some((s) => Array.isArray(parsed && parsed[s])),
    };
  }
  return out;
}

/** The stores behind a set of ticked parts, deduplicated. */
export function storesForParts(parts) {
  const out = new Set();
  for (const key of parts || []) {
    for (const s of (IMPORT_PARTS[key] || { stores: [] }).stores) out.add(s);
  }
  return [...out];
}

/** What a file is, without trusting its name or extension. */
export function detectFormat(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown";
  if (parsed.format === LIST_FORMAT && Array.isArray(parsed.people)) return "list";
  /* A backup is recognised by carrying at least one known store as an array.
     Requiring all of them would reject a backup taken before a store existed,
     which is exactly when someone needs a restore to work. */
  if (BACKUP_STORES.some((s) => Array.isArray(parsed[s]))) return "backup";
  return "unknown";
}

/* A person is only importable if we can identify them. The player id is the one
   stable key across installs - labels and in-game names both change - so a row
   without a usable one cannot be deduplicated and is reported rather than
   guessed at. */
function readPerson(raw, i) {
  if (!raw || typeof raw !== "object") return { error: `Row ${i + 1} is not a record.` };
  const id = String(raw.playerId ?? raw.id ?? "").trim();
  if (!id) return { error: `Row ${i + 1} has no player ID, so it cannot be matched to anyone.` };
  if (!/^\d+$/.test(id)) return { error: `Row ${i + 1} has a player ID that is not a number: "${id}".` };

  const person = { playerId: id };
  if (typeof raw.label === "string" && raw.label.trim()) person.nickname = raw.label.trim();
  else if (typeof raw.nickname === "string" && raw.nickname.trim()) person.nickname = raw.nickname.trim();
  if (typeof raw.note === "string" && raw.note.trim()) person.note = raw.note.trim();
  if (raw.relationship || raw.role) person.role = toRelationship(raw.relationship || raw.role);
  if (Array.isArray(raw.tags)) person.tags = raw.tags.filter((t) => typeof t === "string" && t.trim());
  else if (typeof raw.tags === "string" && raw.tags.trim()) {
    // The CSV export writes tags as "a | b | c".
    person.tags = raw.tags.split("|").map((t) => t.trim()).filter(Boolean);
  }
  return { person };
}

/* Plans a people import against what is already saved.

   Nothing is decided here that the user cannot see first: how many are new, how
   many already exist, and specifically which existing labels the file disagrees
   with. Overwriting a label someone chose by hand is the one irreversible thing
   a merge can do, so it is surfaced by name and is off unless asked for. */
export function planPeopleImport(people, existing, { defaultRelationship = "other" } = {}) {
  const known = new Map((existing || []).map((w) => [String(w.playerId), w]));
  const fallback = RELATIONSHIPS.includes(defaultRelationship) ? defaultRelationship : "other";

  const add = [], update = [], labelConflicts = [], errors = [];
  const seen = new Set();

  (people || []).forEach((raw, i) => {
    const { person, error } = readPerson(raw, i);
    if (error) { errors.push(error); return; }
    // A file can list the same person twice; the first occurrence wins.
    if (seen.has(person.playerId)) return;
    seen.add(person.playerId);

    const current = known.get(person.playerId);
    if (!current) {
      add.push({ ...person, role: person.role || fallback });
      return;
    }
    if (person.nickname && current.nickname && person.nickname !== current.nickname) {
      labelConflicts.push({
        playerId: person.playerId,
        current: current.nickname,
        incoming: person.nickname,
      });
    }
    update.push(person);
  });

  return { add, update, labelConflicts, errors, total: (people || []).length };
}

/* Followed servers from a list.

   Simpler than people: a server has no hand-written label worth protecting
   beyond its nickname, and addServer already leaves fields it is not given
   alone. The id is required for the same reason a player id is - it is what
   identifies the server on the other side. */
export function planServerImport(servers, existing) {
  const known = new Set((existing || []).map((s) => String(s.serverId)));
  const add = [], update = [], errors = [];
  const seen = new Set();

  (servers || []).forEach((raw, i) => {
    if (!raw || typeof raw !== "object") { errors.push(`Server row ${i + 1} is not a record.`); return; }
    const id = String(raw.serverId ?? raw.id ?? "").trim();
    if (!id) { errors.push(`Server row ${i + 1} has no server ID.`); return; }
    if (!/^\d+$/.test(id)) { errors.push(`Server row ${i + 1} has a non-numeric server ID: "${id}".`); return; }
    if (seen.has(id)) return;
    seen.add(id);

    const entry = { serverId: id };
    if (typeof raw.name === "string" && raw.name.trim()) entry.nickname = raw.name.trim();
    else if (typeof raw.nickname === "string" && raw.nickname.trim()) entry.nickname = raw.nickname.trim();
    if (typeof raw.game === "string" && raw.game.trim()) entry.game = raw.game.trim();

    (known.has(id) ? update : add).push(entry);
  });

  return { add, update, errors, total: (servers || []).length };
}

/* Turns the plan into the entries the worker will write.

   `overwriteLabels` is the user's answer to the conflicts above. When false, an
   existing label is left exactly as it was and only the fields that are genuinely
   missing get filled in - which is what someone re-importing their own list
   after using the extension for a while almost always wants. */
export function entriesFor(plan, existing, { overwriteLabels = false } = {}) {
  const known = new Map((existing || []).map((w) => [String(w.playerId), w]));
  const out = [...plan.add];

  for (const p of plan.update) {
    const current = known.get(p.playerId) || {};
    const entry = { playerId: p.playerId };
    if (p.nickname && (overwriteLabels || !current.nickname)) entry.nickname = p.nickname;
    if (p.note && (overwriteLabels || !current.note)) entry.note = p.note;
    if (p.role) entry.role = p.role;
    // Tags merge rather than replace: a tag you added here should survive an
    // import, and a tag from the file should join it.
    if (p.tags && p.tags.length) {
      entry.tags = [...new Set([...(current.tags || []), ...p.tags])];
    }
    // Nothing worth writing means nothing is written.
    if (Object.keys(entry).length > 1) out.push(entry);
  }
  return out;
}

/* Minimal CSV reader for the file this extension itself writes.

   Handles quoted fields, escaped quotes and CRLF, which is all downloadCsv can
   produce. It is not a general CSV parser and does not pretend to be: anything
   it cannot read is reported as a malformed row rather than guessed at. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = String(text || "");

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((v) => v !== ""));
  if (!nonEmpty.length) return { headers: [], records: [] };

  const headers = nonEmpty[0].map((h) => h.trim());
  const records = nonEmpty.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i] ?? ""; });
    return o;
  });
  return { headers, records };
}

/* A backup is a wholesale replacement, so it is checked before it is trusted:
   the shape has to be right, and every key that claims to be a store has to be
   an array. Restoring garbage is worse than refusing to restore. */
export function validateBackup(parsed) {
  const problems = [];
  if (detectFormat(parsed) !== "backup") {
    problems.push("This file does not look like a BMFinder backup.");
    return { ok: false, problems, counts: {} };
  }
  const counts = {};
  for (const store of BACKUP_STORES) {
    const v = parsed[store];
    if (v === undefined) { counts[store] = 0; continue; }
    if (!Array.isArray(v)) { problems.push(`"${store}" should be a list but is ${typeof v}.`); continue; }
    counts[store] = v.length;
  }
  return { ok: problems.length === 0, problems, counts };
}
