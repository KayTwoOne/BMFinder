/* Export and import, exercised against a real IndexedDB.

   These are the paths that touch data someone cannot get back: a restore that
   clears the database, and a merge that could overwrite a label written by hand.
   Until fake-indexeddb was added they had no automated coverage at all, which is
   how importAll shipped able to wipe everything when handed the wrong file.

   Run: npm test */

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  detectFormat, validateBackup, planPeopleImport, planServerImport, entriesFor, parseCsv, LIST_FORMAT,
  summariseBackup, storesForParts,
} from "../lib/transfer.js";

// Imported after fake-indexeddb/auto so the module sees a working indexedDB.
const { db } = await import("../lib/db.js");

async function freshDb() {
  await db.init();
  await db.deleteAllData();
}
beforeEach(freshDb);

/* ---- format detection ---------------------------------------------------- */

test("a backup, a list and junk are told apart", () => {
  assert.equal(detectFormat({ watched: [], servers: [] }), "backup");
  assert.equal(detectFormat({ format: LIST_FORMAT, version: 1, people: [] }), "list");
  for (const junk of [null, undefined, 42, "text", [], {}, { hello: "world" }]) {
    assert.equal(detectFormat(junk), "unknown", `${JSON.stringify(junk)} should be unknown`);
  }
});

test("a backup taken before a store existed is still a backup", () => {
  // The v4 export carried `stats`, which no longer exists. Recognising the file
  // must not depend on every current store being present.
  assert.equal(detectFormat({ watched: [{ playerId: "1" }] }), "backup");
  assert.equal(validateBackup({ watched: [], stats: [] }).ok, true);
});

test("a backup with a store that is not a list is rejected with a reason", () => {
  const r = validateBackup({ watched: [], servers: "nope" });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /servers/);
});

/* ---- the defect that prompted all of this -------------------------------- */

test("restoring a non-backup throws and leaves the database untouched", async () => {
  await db.addWatch({ playerId: "111", nickname: "Real Friend", role: "friend" });
  await db.addServer({ serverId: "s1", nickname: "My server" });

  for (const wrong of [{}, { format: LIST_FORMAT, version: 1, people: [{ playerId: "9" }] }, { nonsense: 1 }]) {
    await assert.rejects(() => db.importAll(wrong), /not a BMFinder backup/);
  }

  // Everything must still be there.
  const watch = await db.listWatch();
  assert.equal(watch.length, 1);
  assert.equal(watch[0].nickname, "Real Friend");
  assert.equal((await db.listServers()).length, 1);
});

/* ---- full backup round trip ---------------------------------------------- */

test("a full backup restores exactly what was exported", async () => {
  await db.addWatch({ playerId: "1", nickname: "Alpha", role: "friend", note: "medic" });
  await db.addWatch({ playerId: "2", nickname: "Bravo", role: "staff" });
  await db.addServer({ serverId: "10", nickname: "KotH", note: "main" });
  await db.setPlayerTags("1", ["Favourite", "squad"]);
  await db.recordNames("1", ["Alpha", "AlphaOld"]);
  await db.setSetting("retentionDays", 7);

  const backup = JSON.parse(JSON.stringify(await db.exportAll()));
  assert.equal(validateBackup(backup).ok, true);

  await db.deleteAllData();
  assert.equal((await db.listWatch()).length, 0);

  await db.importAll(backup);

  const watch = await db.listWatch();
  assert.equal(watch.length, 2);
  const alpha = watch.find((w) => w.playerId === "1");
  assert.equal(alpha.nickname, "Alpha");
  assert.equal(alpha.note, "medic");
  assert.equal(alpha.role, "friend");
  assert.deepEqual([...alpha.tags].sort(), ["Favourite", "squad"]);
  assert.deepEqual([...alpha.names].sort(), ["Alpha", "AlphaOld"]);
  assert.equal((await db.listServers())[0].nickname, "KotH");
  assert.equal(await db.getSetting("retentionDays"), 7);
});

test("restoring replaces rather than merging, so removed people stay removed", async () => {
  await db.addWatch({ playerId: "1", nickname: "Kept" });
  const backup = JSON.parse(JSON.stringify(await db.exportAll()));
  await db.addWatch({ playerId: "2", nickname: "Added after the backup" });

  await db.importAll(backup);
  const watch = await db.listWatch();
  assert.equal(watch.length, 1);
  assert.equal(watch[0].playerId, "1");
});

/* ---- people list round trip ---------------------------------------------- */

const listOf = (...people) => ({ format: LIST_FORMAT, version: 1, people });

test("a shared list adds people who are not saved yet", async () => {
  const plan = planPeopleImport(
    listOf({ playerId: "5", label: "Sniper", relationship: "friend" },
           { playerId: "6", label: "Medic" }).people,
    await db.listWatch(),
    { defaultRelationship: "teammate" },
  );
  assert.equal(plan.add.length, 2);
  assert.equal(plan.update.length, 0);
  assert.equal(plan.errors.length, 0);
  // Relationship from the file wins; the fallback fills the gap.
  assert.equal(plan.add.find((p) => p.playerId === "5").role, "friend");
  assert.equal(plan.add.find((p) => p.playerId === "6").role, "teammate");

  const res = await db.importPeople(entriesFor(plan, await db.listWatch()));
  assert.deepEqual(res, { added: 2, updated: 0 });
  assert.equal((await db.listWatch()).length, 2);
});

test("re-importing your own list does not disturb labels you have since changed", async () => {
  await db.addWatch({ playerId: "5", nickname: "My own name for them", role: "friend" });
  const incoming = listOf({ playerId: "5", label: "Old exported name", relationship: "community" }).people;

  const existing = await db.listWatch();
  const plan = planPeopleImport(incoming, existing);
  assert.equal(plan.add.length, 0);
  assert.equal(plan.update.length, 1);
  assert.equal(plan.labelConflicts.length, 1);
  assert.deepEqual(plan.labelConflicts[0], {
    playerId: "5", current: "My own name for them", incoming: "Old exported name",
  });

  await db.importPeople(entriesFor(plan, existing, { overwriteLabels: false }));
  const after = await db.listWatch();
  assert.equal(after[0].nickname, "My own name for them", "the hand-written label must survive");
  assert.equal(after[0].role, "community", "other fields still update");
});

test("overwriting labels is possible, but only when asked for", async () => {
  await db.addWatch({ playerId: "5", nickname: "Mine" });
  const existing = await db.listWatch();
  const plan = planPeopleImport(listOf({ playerId: "5", label: "Theirs" }).people, existing);
  await db.importPeople(entriesFor(plan, existing, { overwriteLabels: true }));
  assert.equal((await db.listWatch())[0].nickname, "Theirs");
});

test("an empty label in the file never blanks one you have", async () => {
  await db.addWatch({ playerId: "5", nickname: "Keep me", note: "keep this too" });
  const existing = await db.listWatch();
  const plan = planPeopleImport(listOf({ playerId: "5", label: "", note: "" }).people, existing);
  await db.importPeople(entriesFor(plan, existing, { overwriteLabels: true }));
  const after = await db.listWatch();
  assert.equal(after[0].nickname, "Keep me");
  assert.equal(after[0].note, "keep this too");
});

test("tags merge instead of replacing", async () => {
  await db.addWatch({ playerId: "5" });
  await db.setPlayerTags("5", ["mine"]);
  const existing = await db.listWatch();
  const plan = planPeopleImport(listOf({ playerId: "5", tags: ["theirs"] }).people, existing);
  await db.importPeople(entriesFor(plan, existing));
  assert.deepEqual([...(await db.listWatch())[0].tags].sort(), ["mine", "theirs"]);
});

test("duplicates within one file are collapsed", () => {
  const plan = planPeopleImport(
    listOf({ playerId: "7", label: "First" }, { playerId: "7", label: "Second" }).people, []);
  assert.equal(plan.add.length, 1);
  assert.equal(plan.add[0].nickname, "First");
});

test("rows that cannot be identified are reported, not guessed at", () => {
  const plan = planPeopleImport(
    [{ label: "no id" }, { playerId: "abc", label: "not numeric" }, null, { playerId: "8", label: "fine" }],
    []);
  assert.equal(plan.add.length, 1);
  assert.equal(plan.errors.length, 3);
  assert.match(plan.errors.join(" "), /no player ID/);
  assert.match(plan.errors.join(" "), /not a number/);
});

test("a legacy role in an old export is normalised on the way in", () => {
  const plan = planPeopleImport(listOf({ playerId: "9", role: "admin" }).people, []);
  assert.equal(plan.add[0].role, "staff");
});

/* ---- followed servers travel with a list --------------------------------- */

test("a list restores followed servers as well as people", async () => {
  const servers = [
    { serverId: "12345", name: "KotH US#4", game: "arma3" },
    { serverId: "67890", name: "KotH EU#5" },
  ];
  const plan = planServerImport(servers, await db.listServers());
  assert.equal(plan.add.length, 2);
  assert.equal(plan.errors.length, 0);
  for (const entry of plan.add) await db.addServer(entry);

  const saved = await db.listServers();
  assert.equal(saved.length, 2);
  assert.equal(saved.find((s) => s.serverId === "12345").nickname, "KotH US#4");
  assert.equal(saved.find((s) => s.serverId === "12345").game, "arma3");
});

test("importing a list does not rename a server you already follow", async () => {
  await db.addServer({ serverId: "12345", nickname: "My own name", note: "keep" });
  const plan = planServerImport([{ serverId: "12345", name: "Their name" }], await db.listServers());
  assert.equal(plan.add.length, 0);
  assert.equal(plan.update.length, 1);
  // addServer writes only what it is given, so the note survives regardless.
  for (const entry of plan.update) await db.addServer(entry);
  const s = (await db.listServers())[0];
  assert.equal(s.note, "keep");
});

test("server rows without a usable id are reported rather than guessed at", () => {
  const plan = planServerImport([{ name: "no id" }, { serverId: "abc" }, null, { serverId: "9" }], []);
  assert.equal(plan.add.length, 1);
  assert.equal(plan.errors.length, 3);
});

test("a list with no servers key imports people without complaining", () => {
  const plan = planServerImport(undefined, []);
  assert.deepEqual(plan, { add: [], update: [], errors: [], total: 0 });
});

/* ---- CSV ----------------------------------------------------------------- */

test("the CSV this extension writes reads back correctly", () => {
  const csv = 'label,relationship,tags,playerId\r\n'
    + '"Big ""Boss"" Man",friend,"squad | eu",123\r\n'
    + '"Comma, name",staff,,456\r\n';
  const { headers, records } = parseCsv(csv);
  assert.deepEqual(headers, ["label", "relationship", "tags", "playerId"]);
  assert.equal(records.length, 2);
  assert.equal(records[0].label, 'Big "Boss" Man');
  assert.equal(records[1].label, "Comma, name");

  const plan = planPeopleImport(records, []);
  assert.equal(plan.add.length, 2);
  assert.deepEqual(plan.add[0].tags, ["squad", "eu"]);
  assert.equal(plan.add[1].role, "staff");
});

test("a CSV exported without player IDs reports every row rather than importing nothing silently", () => {
  const { records } = parseCsv('label,relationship\r\n"Someone",friend\r\n');
  const plan = planPeopleImport(records, []);
  assert.equal(plan.add.length, 0);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /no player ID/);
});

/* ---- destructive operations, now actually covered ------------------------ */

test("deleteAllData empties every store and leaves the database usable", async () => {
  await db.addWatch({ playerId: "1", nickname: "x" });
  await db.addServer({ serverId: "2" });
  await db.recordPoll({ serverId: "2", ts: new Date().toISOString(), info: {}, roster: [{ id: "1", name: "x" }] });

  await db.deleteAllData();
  assert.equal((await db.listWatch()).length, 0);
  assert.equal((await db.listServers()).length, 0);
  assert.equal(await db.presenceCount(), 0);

  // Still writable afterwards.
  await db.addWatch({ playerId: "3", nickname: "after" });
  assert.equal((await db.listWatch()).length, 1);
});

test("clearPlayerHistory forgets the observations but keeps the person", async () => {
  await db.addWatch({ playerId: "1", nickname: "Keep me", role: "friend" });
  await db.addServer({ serverId: "2" });
  await db.recordPoll({ serverId: "2", ts: new Date().toISOString(), info: {}, roster: [{ id: "1", name: "x" }] });
  assert.ok((await db.presenceCount()) > 0);

  await db.clearPlayerHistory("1");
  const watch = await db.listWatch();
  assert.equal(watch.length, 1, "the saved person must survive");
  assert.equal(watch[0].nickname, "Keep me");
  assert.equal(await db.presenceCount(), 0);
});

test("clearServerHistory forgets the checks but keeps the followed server", async () => {
  await db.addServer({ serverId: "2", nickname: "Mine" });
  await db.recordPoll({ serverId: "2", ts: new Date().toISOString(), info: {}, roster: [{ id: "1", name: "x" }] });
  await db.clearServerHistory("2");
  const servers = await db.listServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].nickname, "Mine");
  assert.equal(await db.presenceCount(), 0);
});

test("retention prunes only what is older than the window", async () => {
  await db.addServer({ serverId: "2" });
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const recent = new Date().toISOString();
  await db.recordPoll({ serverId: "2", ts: old, info: {}, roster: [{ id: "1", name: "old" }] });
  await db.recordPoll({ serverId: "2", ts: recent, info: {}, roster: [{ id: "1", name: "new" }] });
  assert.equal(await db.presenceCount(), 2);

  await db.applyRetention(14);
  assert.equal(await db.presenceCount(), 1, "the 30-day-old observation should be gone");
});

test("resetLabelsAndTags clears annotations but keeps the relationship", async () => {
  await db.addWatch({ playerId: "1", nickname: "Label", note: "Note", role: "friend" });
  await db.setPlayerTags("1", ["a"]);
  await db.resetLabelsAndTags();
  const w = (await db.listWatch())[0];
  assert.equal(w.nickname, "");
  assert.equal(w.note, "");
  assert.deepEqual(w.tags, []);
  assert.equal(w.role, "friend", "the relationship is not an annotation");
});

/* ---- selective import: pick parts of a backup ---------------------------- */

test("summariseBackup reports counts per part and marks absent parts", async () => {
  await db.deleteAllData();
  await db.addWatch({ playerId: "1", nickname: "a" });
  await db.addWatch({ playerId: "2", nickname: "b" });
  await db.addServer({ serverId: "9" });
  const backup = JSON.parse(JSON.stringify(await db.exportAll()));

  const s = summariseBackup(backup);
  assert.equal(s.people.count, 2);
  assert.equal(s.people.present, true);
  assert.equal(s.servers.count, 1);
  // A file with no presence rows reports activity as present:false, count 0.
  assert.equal(s.activity.count, 0);
});

test("storesForParts resolves the groups a person ticks into real stores", () => {
  assert.deepEqual(storesForParts(["people"]).sort(), ["names", "watched"]);
  assert.deepEqual(storesForParts(["servers"]), ["servers"]);
  assert.deepEqual(storesForParts(["people", "servers"]).sort(), ["names", "servers", "watched"]);
  assert.deepEqual(storesForParts([]), []);
});

test("importing only the People part leaves servers and activity out entirely", async () => {
  await db.deleteAllData();
  await db.addWatch({ playerId: "1", nickname: "Alpha", role: "friend" });
  await db.addServer({ serverId: "9", nickname: "A server" });
  await db.recordPoll({ serverId: "9", ts: new Date().toISOString(), info: {}, roster: [{ id: "1", name: "Alpha" }] });
  const backup = JSON.parse(JSON.stringify(await db.exportAll()));

  await db.deleteAllData();
  await db.importSelective(backup, storesForParts(["people"]), "merge");

  assert.equal((await db.listWatch()).length, 1, "people came in");
  assert.equal((await db.listServers()).length, 0, "servers were not asked for");
  assert.equal(await db.presenceCount(), 0, "activity was not asked for");
});

test("merge adds new rows and never overwrites one already present", async () => {
  await db.deleteAllData();
  await db.addWatch({ playerId: "1", nickname: "My label" });
  const backup = { watched: [
    { playerId: "1", nickname: "Their label" },
    { playerId: "2", nickname: "New person" },
  ] };

  const res = await db.importSelective(backup, ["watched"], "merge");
  assert.equal(res.counts.watched, 1, "only the genuinely new row is written");
  const watch = await db.listWatch();
  assert.equal(watch.length, 2);
  assert.equal(watch.find((w) => w.playerId === "1").nickname, "My label", "existing row untouched");
});

test("replace clears the ticked store first, so it matches the file exactly", async () => {
  await db.deleteAllData();
  await db.addWatch({ playerId: "1", nickname: "Was here before" });
  await db.addServer({ serverId: "9", nickname: "Kept" });
  const backup = { watched: [{ playerId: "2", nickname: "From the file" }] };

  await db.importSelective(backup, ["watched"], "replace");
  const watch = await db.listWatch();
  assert.equal(watch.length, 1);
  assert.equal(watch[0].playerId, "2", "the pre-existing person was cleared");
  // Only the ticked store is replaced; servers were not in the part, so they stay.
  assert.equal((await db.listServers()).length, 1, "an untouched store is left alone");
});

test("selective import refuses a file with nothing matching the ticked parts", async () => {
  await db.deleteAllData();
  await db.addWatch({ playerId: "1", nickname: "safe" });
  // A servers-only file, but the user ticked people.
  await assert.rejects(
    () => db.importSelective({ servers: [{ serverId: "9" }] }, storesForParts(["people"]), "merge"),
    /Nothing in that file matched/,
  );
  assert.equal((await db.listWatch()).length, 1, "nothing was touched");
});
