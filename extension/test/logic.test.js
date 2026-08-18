/* Tests for the two pieces of real logic in the extension.

   These are the same cases that passed against real SQLite in the Worker build,
   re-pointed at the JavaScript ports. If the ports drifted, these fail.

   Run: npm test  (node --test, no dependencies) */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchScore, normalize, searchTerm, unsearchable, usesWildcard,
  rankSearchResults, rankServerResults, confidenceScore, EVIDENCE,
} from "../lib/match.js";
import {
  RELATIONSHIPS, RELATIONSHIP_LABEL, RELATIONSHIP_SHORT, RELATIONSHIP_HINT, toRelationship,
} from "../lib/relationships.js";
import {
  clampRetentionDays, RETENTION_DEFAULT_DAYS, RETENTION_MIN_DAYS, RETENTION_MAX_DAYS,
} from "../lib/db.js";

/* ---- relationships ------------------------------------------------------- */

test("every relationship has a label and a hint", () => {
  for (const r of RELATIONSHIPS) {
    assert.equal(typeof RELATIONSHIP_LABEL[r], "string");
    assert.ok(RELATIONSHIP_LABEL[r].length, `${r} has no label`);
    assert.ok(RELATIONSHIP_HINT[r] && RELATIONSHIP_HINT[r].length, `${r} has no hint`);
  }
});

/* The compact labels are shown in tiles instead of the full ones, so they must
   cover the whole vocabulary and must not rename a category into something that
   means anything different. */
test("every relationship has a short label that is no longer than its full one", () => {
  for (const r of RELATIONSHIPS) {
    const short = RELATIONSHIP_SHORT[r];
    assert.ok(short && short.length, `${r} has no short label`);
    assert.ok(short.length <= RELATIONSHIP_LABEL[r].length, `${r} short label is longer`);
    /* Containment, not prefix. "Staff" abbreviates "Server staff" by dropping
       the leading word, which a prefix rule would reject even though it is
       exactly the kind of shortening wanted. What matters is that the short form
       is made of words already in the full label, so it names the same category
       rather than introducing a new one. */
    const full = RELATIONSHIP_LABEL[r].toLowerCase().split(/\s+/);
    for (const word of short.toLowerCase().split(/\s+/)) {
      assert.ok(full.includes(word), `${r}: "${short}" introduces "${word}", absent from "${RELATIONSHIP_LABEL[r]}"`);
    }
  }
});

test("current values pass through unchanged", () => {
  for (const r of RELATIONSHIPS) assert.equal(toRelationship(r), r);
});

/* The mapping the v4 upgrade applies. These assertions are the contract: a
   database written before v4 must land on exactly these values, and a change
   here silently rewrites people's saved data. */
test("the old vocabulary maps onto the new one", () => {
  assert.equal(toRelationship("admin"), "staff");
  assert.equal(toRelationship("player"), "community");
  assert.equal(toRelationship("other"), "other");
});

test("suspect is retired to the neutral category, carrying nothing forward", () => {
  assert.equal(toRelationship("suspect"), "other");
  assert.ok(!RELATIONSHIPS.includes("suspect"));
  // No label anywhere may reintroduce the accusation under a new name.
  const words = Object.values(RELATIONSHIP_LABEL).concat(Object.values(RELATIONSHIP_HINT));
  for (const w of words) assert.ok(!/suspect|cheat|ban|offender/i.test(w), `loaded wording: ${w}`);
});

test("anything unrecognised, empty or missing lands on other rather than throwing", () => {
  for (const v of [undefined, null, "", "  ", "nonsense", 0, 42, {}, []]) {
    assert.equal(toRelationship(v), "other");
  }
});

test("normalising is idempotent and case-insensitive", () => {
  assert.equal(toRelationship("ADMIN"), "staff");
  assert.equal(toRelationship("Suspect"), "other");
  assert.equal(toRelationship(toRelationship("admin")), "staff");
});

/* ---- retention ------------------------------------------------------------
   clampRetentionDays is the one rule standing between a value that reached the
   settings store some other way (a hand-edited profile, a future import) and a
   poll cycle computing a negative or unbounded cutoff, so it is worth pinning
   down on its own rather than only exercising it indirectly through IndexedDB. */

test("the default is 14 days and sits inside its own clamped range", () => {
  assert.equal(RETENTION_DEFAULT_DAYS, 14);
  assert.equal(clampRetentionDays(RETENTION_DEFAULT_DAYS), RETENTION_DEFAULT_DAYS);
});

test("values inside 1..90 pass through unchanged", () => {
  for (const n of [1, 3, 7, 14, 30, 90]) assert.equal(clampRetentionDays(n), n);
});

test("values outside the range are clamped, not rejected", () => {
  assert.equal(clampRetentionDays(0), RETENTION_MIN_DAYS);
  assert.equal(clampRetentionDays(-5), RETENTION_MIN_DAYS);
  assert.equal(clampRetentionDays(91), RETENTION_MAX_DAYS);
  assert.equal(clampRetentionDays(10000), RETENTION_MAX_DAYS);
});

test("fractional values round rather than truncate or floor silently", () => {
  assert.equal(clampRetentionDays(14.5), 15);
  assert.equal(clampRetentionDays(14.4), 14);
});

test("anything that is not a usable number falls back to the default", () => {
  for (const v of [undefined, null, "", "  ", "nonsense", NaN, {}, []]) {
    assert.equal(clampRetentionDays(v), RETENTION_DEFAULT_DAYS);
  }
});

test("clamping is idempotent", () => {
  for (const n of [-5, 0, 1, 14, 90, 91, 1000]) {
    assert.equal(clampRetentionDays(clampRetentionDays(n)), clampRetentionDays(n));
  }
});

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

/* These encode what BattleMetrics' search was MEASURED to do.

   2026-07-29: `filter[search]=Big%Boss` returned "Big \"big boss\" Boss",
   "[BOSS] Big Boss", "Boss Big Boss" and similar. A literal `%` in the term acts
   as a LIKE wildcard, and matches with text before "Big" prove the term is
   already wrapped on both sides. Whitespace, not the matching, was what broke
   multi-word search.

   If these start failing against reality, their search changed and searchTerm
   needs revisiting rather than the tests being relaxed. */

test("spaces become wildcards so the whole name is searched", () => {
  assert.equal(searchTerm("Big Boss"), "Big%Boss");
  assert.equal(searchTerm("John Smith"), "John%Smith");
  assert.equal(searchTerm("a b c"), "a%b%c");
});

test("runs of whitespace collapse to a single wildcard", () => {
  assert.equal(searchTerm("Big    Boss"), "Big%Boss");
  assert.equal(searchTerm("  Big Boss  "), "Big%Boss");
  assert.equal(searchTerm("Big\tBoss"), "Big%Boss");
});

test("a decorated multi-word name keeps its inner symbols", () => {
  // The kaomoji is a middle/end token, so only the outer edges are trimmed.
  // This is the case that was previously unreachable altogether.
  assert.equal(searchTerm("MX (「•--•)「"), "MX%(「•--•)「");
});

test("leading and trailing decoration is stripped, inner punctuation kept", () => {
  assert.equal(searchTerm("(Bob)"), "Bob");
  assert.equal(searchTerm("**Ace**"), "Ace");
  // Only the ends are trimmed; a bracket in the middle is part of the name
  // their comparison will see, so removing it would change the query.
  assert.equal(searchTerm("[C4G]Steve"), "C4G]Steve");
});

test("a plain single-word query is sent unchanged, with no wildcard", () => {
  assert.equal(searchTerm("Richard"), "Richard");
  assert.equal(searchTerm("  Richard  "), "Richard");
  assert.equal(usesWildcard("Richard"), false);
});

test("no leading or trailing wildcard is ever added", () => {
  // Their query already wraps the term, so an outer wildcard buys nothing and a
  // bare one would ask their database to scan every player row.
  for (const q of ["Big Boss", "MX (「•--•)「", "(Bob)", "a b"]) {
    const t = searchTerm(q);
    assert.ok(!t.startsWith("%"), `${q} produced a leading wildcard: ${t}`);
    assert.ok(!t.endsWith("%"), `${q} produced a trailing wildcard: ${t}`);
    assert.ok(!t.includes("%%"), `${q} produced a doubled wildcard: ${t}`);
  }
});

test("multi-word queries are reported as using a wildcard", () => {
  assert.equal(usesWildcard("Big Boss"), true);
  assert.equal(usesWildcard("MX (「•--•)「"), true);
});

test("an empty query yields no term to search", () => {
  assert.equal(searchTerm(""), "");
  assert.equal(searchTerm("   "), "");
});

test("only a query with no letters or digits is truly unsearchable", () => {
  assert.equal(unsearchable(""), true);
  assert.equal(unsearchable("   "), true);
  assert.equal(unsearchable("「•」"), true);
  // These are all expressible now that whitespace is bridged.
  assert.equal(unsearchable("Big Boss"), false);
  assert.equal(unsearchable("MX (「•--•)「"), false);
  assert.equal(unsearchable("Richard"), false);
});

/* ---- confidence scoring --------------------------------------------------- */

test("a manually typed wildcard does not cost name similarity", () => {
  // Typing Crack%Sparrow yourself used to read 92%, the wildcard counting as a
  // character difference against the real name.
  assert.equal(matchScore("Crack%Sparrow", "Crack Sparrow"), 1);
  assert.equal(matchScore("Big%Boss", "Big Boss"), 1);
});

test("presence on a tracked server raises the score, absence lowers it", () => {
  const n = 0.8;
  assert.ok(confidenceScore(n, EVIDENCE.CONFIRMED) > n);
  assert.ok(confidenceScore(n, EVIDENCE.ABSENT) < n);
  assert.equal(confidenceScore(n, EVIDENCE.UNKNOWN), n);
});

test("a failed sessions read is neutral, never treated as absence", () => {
  // Punishing a player because their page timed out would be inventing evidence.
  for (const n of [1, 0.5, 0]) {
    assert.equal(confidenceScore(n, EVIDENCE.UNKNOWN), n);
  }
});

test("a perfect name on a tracked server still reads 100%", () => {
  assert.equal(confidenceScore(1, EVIDENCE.CONFIRMED), 1);
});

test("confidence never exceeds 1 or drops below 0", () => {
  for (const ev of Object.values(EVIDENCE)) {
    for (const n of [-5, 0, 0.37, 1, 42, NaN, undefined]) {
      const c = confidenceScore(n, ev);
      assert.ok(c >= 0 && c <= 1, `${n} with ${ev} gave ${c}`);
    }
  }
});

test("confidence stays monotonic in the name score", () => {
  for (const ev of Object.values(EVIDENCE)) {
    let prev = -1;
    for (const n of [0, 0.2, 0.5, 0.8, 1]) {
      const c = confidenceScore(n, ev);
      assert.ok(c >= prev, `${ev} went backwards at ${n}`);
      prev = c;
    }
  }
});

test("a weak name on your server beats a strong name on a stranger", () => {
  // The whole point: eleven identical names are separated by who actually plays
  // where, not by spelling.
  const mine = confidenceScore(0.5, EVIDENCE.CONFIRMED);
  const theirs = confidenceScore(1.0, EVIDENCE.ABSENT);
  assert.ok(mine > theirs, `${mine} should beat ${theirs}`);
});

/* ---- search cross-reference ranking -------------------------------------- */

const ids = (rows) => rows.map((r) => r.id);

test("players seen on a tracked server rank above those who were not", () => {
  const rows = [
    { id: "A", score: 1.0, lastSeen: "2026-07-01T00:00:00Z" },                 // strong name, no server
    { id: "B", score: 0.4, trackedServerId: "S1", trackedLastSeen: "2026-07-20T00:00:00Z" },
  ];
  assert.deepEqual(ids(rankSearchResults(rows, ["S1"])), ["B", "A"]);
});

test("tracked hits group by the user's server order, then newest first", () => {
  const rows = [
    { id: "s2old", score: 0.5, trackedServerId: "S2", trackedLastSeen: "2026-01-01T00:00:00Z" },
    { id: "s1new", score: 0.5, trackedServerId: "S1", trackedLastSeen: "2026-07-01T00:00:00Z" },
    { id: "s1old", score: 0.5, trackedServerId: "S1", trackedLastSeen: "2026-02-01T00:00:00Z" },
  ];
  // S1 before S2 (user order), and within S1 the newer session first.
  assert.deepEqual(ids(rankSearchResults(rows, ["S1", "S2"])), ["s1new", "s1old", "s2old"]);
});

test("with no tracked-server hits, ranking is the ordinary name-then-recency order", () => {
  const rows = [
    { id: "weak-recent", score: 0.3, lastSeen: "2026-07-25T00:00:00Z" },
    { id: "strong-old", score: 1.0, lastSeen: "2020-01-01T00:00:00Z" },
    { id: "strong-recent", score: 0.95, lastSeen: "2026-07-20T00:00:00Z" },
  ];
  // Both strong names outrank the weak one; between them, the more recent wins.
  assert.deepEqual(ids(rankSearchResults(rows, ["S1"])), ["strong-recent", "strong-old", "weak-recent"]);
});

test("a tracked id not in the current tracked list does not count as a hit", () => {
  const rows = [
    { id: "stale", score: 0.4, trackedServerId: "GONE", trackedLastSeen: "2026-07-20T00:00:00Z" },
    { id: "strong", score: 1.0, lastSeen: "2026-07-01T00:00:00Z" },
  ];
  // "GONE" is not in the tracked order, so it is treated as unmatched and the
  // strong name wins.
  assert.deepEqual(ids(rankSearchResults(rows, ["S1"])), ["strong", "stale"]);
});

test("ranking never mutates the input array", () => {
  const rows = [{ id: "A", score: 0.5 }, { id: "B", score: 1.0 }];
  const before = ids(rows);
  rankSearchResults(rows, []);
  assert.deepEqual(ids(rows), before);
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

/* ---- server search ranking ----------------------------------------------
   BattleMetrics returns its server results population-first, so the server the
   user actually named can sit below busier ones that merely share a word. */

const srvPage = [
  { id: "1", name: "CodeFourGaming - King of the Hill US#4 - Infantry" },
  { id: "2", name: "CodeFourGaming - King of the Hill US#5 - RHS Vehicle" },
  { id: "3", name: "CodeFourGaming - King of the Hill EU#1" },
];

test("the named server ranks first even when the page ranked it last", () => {
  const out = rankServerResults("CodeFourGaming - King of the Hill EU#1", srvPage);
  assert.equal(out[0].id, "3");
  assert.equal(out[0].score, 1);
});

test("ranking reorders servers without dropping any", () => {
  assert.equal(rankServerResults("EU#1", srvPage).length, srvPage.length);
});

test("a partial server name still matches, just lower", () => {
  const out = rankServerResults("King of the Hill", srvPage);
  assert.equal(out.length, 3);
  assert.ok(out[0].score > 0, "a partial match should score above zero");
});

test("equally-good server matches keep the page's popularity order", () => {
  const tied = [{ id: "a", name: "Identical Name" }, { id: "b", name: "Identical Name" }];
  assert.deepEqual(ids(rankServerResults("Identical Name", tied)), ["a", "b"]);
});

test("server ranking survives an empty list and a nameless row", () => {
  assert.deepEqual(rankServerResults("x", []), []);
  assert.equal(rankServerResults("x", [{ id: "1" }])[0].score, 0);
});
