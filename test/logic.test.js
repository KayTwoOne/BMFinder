/* Tests for the two pieces of real logic in the extension.

   These are the same cases that passed against real SQLite in the Worker build,
   re-pointed at the JavaScript ports. If the ports drifted, these fail.

   Run: npm test  (node --test, no dependencies) */

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchScore, normalize, searchVariants } from "../lib/match.js";
import { correlate, correlationMeta } from "../lib/correlation.js";

/* ---- matching ------------------------------------------------------------ */

test("exact, case and separator variants all score 1", () => {
  assert.equal(matchScore("Richard", "Richard"), 1);
  assert.equal(matchScore("Richard", "richard"), 1);
  assert.equal(matchScore("xX_Sniper_Xx", "xX Sniper Xx"), 1);
  assert.equal(normalize("A-B.C|D"), "a b c d");
});

/* ---- decorated and multi-word names -------------------------------------- */

test("a decorated name matches itself exactly", () => {
  const name = "MX (「•--•)「";
  assert.equal(matchScore(name, name), 1);
  assert.equal(matchScore(name, name.toLowerCase()), 1);
});

test("a decorated query does NOT strongly match the bare word inside it", () => {
  // Three unrelated players are called MX. Ranking them highly for a query that
  // only contains "MX" would bury the player actually being looked for, so this
  // asymmetry is deliberate: short-query-inside-long-name is evidence,
  // long-query-containing-short-name is not.
  const score = matchScore("MX (「•--•)「", "MX");
  assert.ok(score < 0.5, `expected a weak score, got ${score}`);
});

test("names differing only in unicode encoding still match", () => {
  assert.equal(matchScore("ＭＸ", "MX"), 1);          // fullwidth MX
  assert.equal(matchScore("Jo Smith", "Jo Smith"), 1);   // non-breaking space
});

test("multi-word names match exactly and by token", () => {
  assert.equal(matchScore("John Smith", "John Smith"), 1);
  assert.ok(matchScore("Smith", "John Smith") >= 0.9);
});

test("search falls back from a decorated query to the plain word", () => {
  const v = searchVariants("MX (「•--•)「");
  assert.equal(v[0], "MX (「•--•)「", "exact query is tried first");
  assert.ok(v.includes("MX"), `expected a plain "MX" fallback, got ${JSON.stringify(v)}`);
});

test("search falls back through tag, then to the longest word", () => {
  const v = searchVariants("[C4G] Steve");
  assert.equal(v[0], "[C4G] Steve");
  assert.equal(v[1], "C4G Steve");
  assert.equal(v[2], "Steve");
});

test("a plain query produces no redundant fallbacks", () => {
  assert.deepEqual(searchVariants("Richard"), ["Richard"]);
  assert.deepEqual(searchVariants("  Richard  "), ["Richard"]);
});

test("a multi-word plain query keeps the phrase before the longest word", () => {
  assert.deepEqual(searchVariants("John Smith"), ["John Smith", "Smith"]);
});

test("searchVariants never returns empty or more than three terms", () => {
  assert.deepEqual(searchVariants(""), []);
  assert.deepEqual(searchVariants("「•」"), ["「•」"]);
  assert.ok(searchVariants("[A] B-C D_E (F) G").length <= 3);
});

test("clan tag prefixes still match the bare name", () => {
  assert.ok(matchScore("Bob", "[TAG] Bob") >= 0.95);
});

test("unrelated names score low", () => {
  assert.ok(matchScore("John", "Completely Different") < 0.3);
});

test("an exact whole-token match scores 1, by design", () => {
  // This is the same rule that makes "[TAG] Bob" match "Bob", so it cannot be
  // tuned away without breaking clan tags. The cost is that a short query hits
  // 100% against any name containing it as a separate word, which is a real
  // false-positive source when scanning at a 95% threshold. Prefer longer,
  // more specific queries there.
  assert.equal(matchScore("Bob", "Bob the Builder Extraordinaire"), 1);
  assert.equal(matchScore("Bob", "[TAG] Bob"), 1);
});

test("similar but distinct names stay below the match threshold", () => {
  // No shared token, so these rely on edit distance and score low.
  assert.ok(matchScore("Bob", "Robert") < 0.5);
  assert.ok(matchScore("John", "Jonathan") < 0.95);
});

/* ---- correlation --------------------------------------------------------- */

// Helper mirroring what db.recordPoll accumulates, so the tests speak in polls
// rather than in table rows.
function tally(rows, playerId, serverId, name, adminHere) {
  let r = rows.find((x) => x.playerId === playerId && x.serverId === serverId);
  if (!r) {
    r = { playerId, serverId, lastName: name, total: 0, absent: 0, present: 0, lastSeen: "t" };
    rows.push(r);
  }
  r.total++;
  if (adminHere) r.present++; else r.absent++;
}

test("ranks the admin avoider above players who show up regardless", () => {
  const rows = [];
  for (let i = 0; i < 4; i++) {            // admin online
    tally(rows, "regular", "S1", "regular", true);
    tally(rows, "innocent", "S1", "innocent", true);
  }
  for (let i = 0; i < 4; i++) {            // admin away
    tally(rows, "regular", "S1", "regular", false);
    tally(rows, "ghost", "S1", "ghost", false);
  }
  const out = correlate(rows, new Set(["A"]), new Set(["S1"]), 3);

  assert.equal(out[0].playerId, "ghost");
  assert.equal(out[0].absentRatio, 1);
  assert.equal(out[0].present, 0);
  assert.equal(out.find((c) => c.playerId === "regular").absentRatio, 0.5);
  assert.equal(out.find((c) => c.playerId === "innocent").absent, 0);
});

test("never scores a server where no admin has been seen", () => {
  const rows = [];
  for (let i = 0; i < 6; i++) tally(rows, "decoy", "S2", "decoy", false);
  tally(rows, "known", "S1", "known", true);

  // S1 has admin activity, S2 does not.
  const out = correlate(rows, new Set(["A"]), new Set(["S1"]), 1);
  const ids = out.map((c) => c.playerId);
  assert.ok(!ids.includes("decoy"), "absent is meaningless on a server with no admins");
  assert.ok(ids.includes("known"));
});

test("admins are never candidates", () => {
  const rows = [];
  for (let i = 0; i < 5; i++) tally(rows, "A", "S1", "AdminSteve", false);
  const out = correlate(rows, new Set(["A"]), new Set(["S1"]), 1);
  assert.equal(out.length, 0);
});

test("honours the minimum sightings floor", () => {
  const rows = [];
  tally(rows, "rare", "S1", "rare", false);
  assert.equal(correlate(rows, new Set(["A"]), new Set(["S1"]), 3).length, 0);
  assert.equal(correlate(rows, new Set(["A"]), new Set(["S1"]), 1).length, 1);
});

test("totals combine across servers for the same player", () => {
  const rows = [];
  for (let i = 0; i < 2; i++) tally(rows, "p", "S1", "p", false);
  for (let i = 0; i < 2; i++) tally(rows, "p", "S2", "p", true);
  const out = correlate(rows, new Set(["A"]), new Set(["S1", "S2"]), 3);
  assert.equal(out[0].total, 4);
  assert.equal(out[0].absent, 2);
  assert.deepEqual(out[0].servers, ["S1", "S2"]);
});

test("meta reports whether the data is worth trusting yet", () => {
  const m = correlationMeta(
    [{ totalPolls: 10, adminPolls: 4 }, { totalPolls: 5, adminPolls: 0 }],
    new Set(["A"]), 3
  );
  assert.equal(m.totalPolls, 15);
  assert.equal(m.adminPolls, 4);
  assert.equal(m.serversWithAdminActivity, 1);
});
