/* Tests for the two pieces of real logic in the extension.

   These are the same cases that passed against real SQLite in the Worker build,
   re-pointed at the JavaScript ports. If the ports drifted, these fail.

   Run: npm test  (node --test, no dependencies) */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  matchScore, normalize, searchTerm, unsearchable, usesWildcard,
  rankSearchResults, rankServerResults, serverSearchToken, confidenceScore, EVIDENCE,
} from "../lib/match.js";
import {
  RELATIONSHIPS, RELATIONSHIP_LABEL, RELATIONSHIP_SHORT, RELATIONSHIP_HINT, toRelationship,
} from "../lib/relationships.js";
import {
  clampRetentionDays, RETENTION_DEFAULT_DAYS, RETENTION_MIN_DAYS, RETENTION_MAX_DAYS,
} from "../lib/db.js";

/* extract.js is a classic script, not a module - it attaches itself to
   globalThis.BMExtract rather than exporting anything import can see (see the
   comment at the top of that file for why). Running its source through vm
   against a throwaway context reaches it without turning it into something
   it explicitly is not, and without adding a dependency just to fake a DOM. */
const extractSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "extract.js"), "utf8"
);
// A bare vm context has the ECMAScript intrinsics but none of the host globals
// serverLinks needs at call time - notably URL, used to resolve every href it
// reads. Without it every anchor throws inside extract.js's own try/catch and
// silently disappears, which reads exactly like "found nothing" and would
// have hidden the real bug this file exists to catch.
const extractSandbox = { URL };
vm.createContext(extractSandbox);
vm.runInContext(extractSrc, extractSandbox);
const { serverLinks } = extractSandbox.BMExtract;

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

/* ---- server search extraction ---------------------------------------------
   serverLinks(doc) used to match a[href*="/servers/"] anywhere on the page,
   so a sidebar or a "popular servers" rail always produced SOME hit before
   the real results had rendered. content/reader.js polls until extraction
   returns something non-empty, so that first, wrong hit was mistaken for a
   completed render and the poll stopped immediately - two different searches
   were proven in the field to come back with the identical ten IDs because
   of exactly this. These exercise the fix: excluding nav/aside/header/footer
   ancestors, then keeping only the densest cluster of links on the page.

   There is no real DOM available here and none is worth adding as a
   dependency for one function, so this builds just enough of one: elements
   with attributes, a parent/child tree, and the handful of DOM methods
   serverLinks and its helpers actually call - querySelectorAll, closest,
   contains. */

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this._attrs = new Map();
    this.children = [];
    this.parentElement = null;
    this._text = "";
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this._text = v; }
  setAttribute(k, v) { this._attrs.set(k, String(v)); }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  append(...kids) {
    for (const k of kids) { k.parentElement = this; this.children.push(k); }
    return this;
  }
  contains(node) {
    for (let n = node; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  closest(selector) {
    const tags = selector.split(",").map((s) => s.trim().toUpperCase());
    for (let el = this; el; el = el.parentElement) if (tags.includes(el.tagName)) return el;
    return null;
  }
  // Only the one attribute-contains form extract.js actually uses is needed here.
  querySelectorAll(selector) {
    const m = selector.match(/^([a-zA-Z0-9]*)\[([a-zA-Z-]+)([*^$]?)="([^"]*)"\]$/);
    const test = (el) => {
      if (!m) return el.tagName === selector.toUpperCase();
      const [, tag, attr, op, val] = m;
      if (tag && el.tagName !== tag.toUpperCase()) return false;
      const av = el.getAttribute(attr);
      if (av == null) return false;
      if (op === "*") return av.includes(val);
      if (op === "^") return av.startsWith(val);
      if (op === "$") return av.endsWith(val);
      return av === val;
    };
    const out = [];
    const walk = (node) => { for (const c of node.children) { if (test(c)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

// A minimal document: a root node that also stands in for body/documentElement,
// so the "don't merge unrelated links at the document root" ceiling in
// nearestSharedAncestor has something real to stop at, same as it would in a
// real DOM.
function fakeDoc() {
  const d = new El("#document");
  d.baseURI = "https://www.battlemetrics.com/servers";
  d.body = d;
  return d;
}

function anchor(href, text) {
  const a = new El("a");
  a.setAttribute("href", href);
  a.textContent = text;
  return a;
}
const srvAnchor = (n, game = "arma3") => anchor(`/servers/${game}/${n}`, `Server ${n}`);

// extract.js runs inside its own vm context, so the plain arrays and objects
// serverLinks returns are built from THAT context's Array/Object, not this
// file's. They compare fine element-by-element but deepStrictEqual also
// checks prototypes, so a cross-realm array of identical content still fails
// as "not reference-equal". Round-tripping through JSON rebuilds the result
// with this file's own Array/Object, which is all deepStrictEqual needs.
const plain = (v) => JSON.parse(JSON.stringify(v));

test("a sidebar with a couple of links loses to a ten-link results list", () => {
  const root = fakeDoc();
  const sidebar = new El("div").append(srvAnchor(11), srvAnchor(12));
  const results = new El("div");
  for (let n = 1; n <= 10; n++) results.append(new El("div").append(srvAnchor(n)));
  root.append(sidebar, results);

  const rows = plain(serverLinks(root));
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((r) => r.id).sort(), Array.from({ length: 10 }, (_, i) => String(i + 1)).sort());
  assert.ok(!rows.some((r) => r.id === "11" || r.id === "12"), "the sidebar's own servers leaked into the results");
});

test("a page with only sidebar links (results not yet rendered) yields nothing", () => {
  const root = fakeDoc();
  const sidebar = new El("div").append(srvAnchor(1), srvAnchor(2));
  root.append(sidebar);

  // This is the actual bug: on the first poll tick, before the results list
  // exists, the only candidates on the page belong to the sidebar. Returning
  // them as if they were results is what let a stale set win the race.
  assert.deepEqual(plain(serverLinks(root)), []);
});

test("links inside nav, aside and footer are excluded outright, even when they outnumber the real results", () => {
  const root = fakeDoc();
  const nav = new El("nav");
  for (let n = 90; n < 98; n++) nav.append(srvAnchor(n)); // 8 links: more than the real results below
  const aside = new El("aside").append(srvAnchor(200), srvAnchor(201));
  const footer = new El("footer").append(srvAnchor(210));
  const results = new El("div");
  for (let n = 1; n <= 5; n++) results.append(new El("div").append(srvAnchor(n)));
  root.append(nav, aside, footer, results);

  const rows = plain(serverLinks(root));
  // If chrome exclusion were missing, the 8-link nav would out-mass the 5-link
  // results and win the density grouping outright.
  assert.deepEqual(rows.map((r) => r.id).sort(), ["1", "2", "3", "4", "5"]);
});

test("the returned shape is exactly {id, name, game}, unchanged by the fix", () => {
  const root = fakeDoc();
  const results = new El("div");
  for (let n = 1; n <= 3; n++) results.append(new El("div").append(anchor(`/servers/rust/${n}`, `Rust Server ${n}`)));
  root.append(results);

  const rows = plain(serverLinks(root));
  assert.equal(rows.length, 3);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ["game", "id", "name"]);
  assert.deepEqual(rows[0], { id: "1", name: "Rust Server 1", game: "rust" });
});

test("existing per-anchor validation is untouched: no query string, a game slug is required, dedup by id", () => {
  const root = fakeDoc();
  const results = new El("div");
  results.append(new El("div").append(anchor("/servers/123", "Bare id, no game slug")));
  results.append(new El("div").append(anchor("/servers/arma3/5?tab=info", "Carries a query string")));
  results.append(new El("div").append(anchor("/servers/arma3/1", "First")));
  results.append(new El("div").append(anchor("/servers/arma3/1", "Duplicate of the first")));
  results.append(new El("div").append(anchor("/servers/arma3/2", "Second")));
  root.append(results);

  assert.deepEqual(plain(serverLinks(root)).map((r) => r.id), ["1", "2"]);
});

/* The density floor is a guess about TIMING, not about correctness, so the
   caller has to be able to relax it. reader.js polls strictly while results
   could still be painting, then leniently once the page has settled - without
   which a search matching one or two servers would report nothing at all. */

test("a two-server result is withheld while the page could still be painting", () => {
  const root = fakeDoc();
  const results = new El("div");
  results.append(new El("div").append(anchor("/servers/arma3/1", "Only match")));
  results.append(new El("div").append(anchor("/servers/arma3/2", "Other match")));
  root.append(results);

  assert.deepEqual(plain(serverLinks(root)), [],
    "strict by default: two links could be a rail that rendered early");
});

test("the same two-server result is accepted once the caller says the page settled", () => {
  const root = fakeDoc();
  const results = new El("div");
  results.append(new El("div").append(anchor("/servers/arma3/1", "Only match")));
  results.append(new El("div").append(anchor("/servers/arma3/2", "Other match")));
  root.append(results);

  assert.deepEqual(plain(serverLinks(root, 1)).map((r) => r.id), ["1", "2"]);
});

test("a single genuine match survives a settled read", () => {
  const root = fakeDoc();
  const results = new El("div");
  results.append(new El("div").append(anchor("/servers/arma3/7", "CodeFourGaming - King of the Hill EU#1")));
  root.append(results);

  const rows = plain(serverLinks(root, 1));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "CodeFourGaming - King of the Hill EU#1");
});

test("relaxing the floor does not let page chrome back in", () => {
  const root = fakeDoc();
  const nav = new El("nav");
  nav.append(anchor("/servers/arma3/90", "Browse servers"));
  nav.append(anchor("/servers/arma3/91", "Popular"));
  root.append(nav);

  assert.deepEqual(plain(serverLinks(root, 1)), [],
    "nav is excluded before the floor is ever consulted");
});

/* ---- picking the word to send to BattleMetrics --------------------------
   Their server search takes ONE word, which is the opposite of the player
   search. Verified against the live site: "CodeFourGaming" returns the wanted
   server, while "CodeFourGaming EU#1", "King of the Hill EU#1" and "EU#1" each
   return a page without it. The token only has to get the right server into the
   results; ranking against the full query does the rest. */

test("the community name is chosen over the filler around it", () => {
  assert.equal(serverSearchToken("CodeFourGaming - King of the Hill EU#1"), "CodeFourGaming");
});

test("words that appear on half the platform are not selective, so they lose", () => {
  assert.equal(serverSearchToken("Olympus Gaming"), "Olympus");
  assert.equal(serverSearchToken("The Official Arma Server"), "Official");
});

test("separators are not words", () => {
  // The point is that a lone dash never becomes the search term, and that
  // brackets are stripped rather than counted as part of the word.
  assert.equal(serverSearchToken("Exile - Altis"), "Exile");
  assert.equal(serverSearchToken("[GER] LiveYourLife"), "LiveYourLife");
  // With no word to pick, the query is passed through untouched rather than
  // blanked: sending what the user typed is no worse than sending nothing, and
  // the caller has no better fallback to offer.
  assert.equal(serverSearchToken("- - -"), "- - -");
});

test("a single word is returned unchanged", () => {
  assert.equal(serverSearchToken("CodeFourGaming"), "CodeFourGaming");
});

test("a query of nothing but filler still yields a usable term", () => {
  // Every word is filler, so the filter is ignored rather than returning
  // nothing: a weak search still beats refusing to search at all. Ties go to
  // the first word, which keeps the choice stable rather than arbitrary.
  assert.equal(serverSearchToken("the of and"), "the");
  assert.equal(serverSearchToken(""), "");
});
