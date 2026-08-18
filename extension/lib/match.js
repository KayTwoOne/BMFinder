/* Fuzzy name matching.

   Direct port of the Python scorer that was validated against real cases:
   exact and case variants score 1, clan-tag prefixes like "[TAG] Bob" still match
   "Bob", and names that differ only in separator style ("xX_Sniper_Xx" vs
   "xX Sniper Xx") come out identical. Keep those behaviours if you touch this. */

/* `%` is in here because it is the wildcard the search term uses to bridge a
   space. Without it, typing "Crack%Sparrow" scored 92% against a player actually
   called "Crack Sparrow", the missing 8% being the wildcard counted as a
   character difference. Same trade already made for _ - . and |: a name that
   genuinely contains one of these compares as though it were a space. */
const SEP = /[\s_\-.|/\\%]+/g;

/* NFKC first, so names that look identical on screen but are encoded differently
   compare equal: fullwidth ＭＸ folds to MX, halfwidth ｢ to 「, and the various
   compatibility spaces to a plain one. Without it two players with the same
   apparent name score well below 1 for no visible reason. */
export function normalize(s) {
  if (!s) return "";
  let v = String(s);
  try { v = v.normalize("NFKC"); } catch { /* pre-ES6 engine, or a lone surrogate */ }
  return v.trim().toLowerCase().replace(SEP, " ").trim();
}

/* What BattleMetrics' own search does with a query.

   Measured against their public /players endpoint while signed out.

   2026-07-28, first pass:
     filter[search]=MX        -> 10 players, every one named exactly "MX"
     filter[search]=Big Boss  -> 10 players, every one named exactly "Big"

   Those two led to the wrong conclusion, recorded here so nobody re-derives it:
   that their index matched one whole name and multi-word names were therefore
   unreachable by anyone.

   2026-07-29, with a wildcard:
     filter[search]=Big%Boss  -> "Big \"big boss\" Boss", "[BOSS] Big Boss",
                                 "Boss Big Boss", "BIG (*_*) BOSS BIG`", ...

   That corrects the model completely. Note the matches with text BEFORE "Big":
   the term is used in a LIKE-style comparison already wrapped on both sides, so
   it was always a substring search. A literal `%` inside the term survives
   unescaped and acts as an extra internal wildcard.

   What actually blocked multi-word search was whitespace truncating the term,
   and what hid substring matches in the first pass was ranking: exact matches
   sort first and the page holds ten, so identical names crowd everything else
   off page one.

   So: replace each run of whitespace with `%` and the whole name becomes
   searchable.

   Deliberately NOT done here, because their query already wraps the term:
   adding our own leading or trailing `%` buys nothing and a bare `%` would ask
   their database to scan every player row. Only the internal gaps get a
   wildcard. */
const WILDCARD = "%";

export function searchTerm(query) {
  const raw = String(query || "").trim();
  if (!raw) return "";

  // Nothing for their comparison to work with.
  if (!/[\p{L}\p{N}]/u.test(raw)) return "";

  let norm = raw;
  try { norm = raw.normalize("NFKC"); } catch { /* lone surrogate */ }

  /* Split BEFORE trimming. Trimming the whole string first looked equivalent and
     was not: in "MX (kaomoji)" the entire tail, space included, is one unbroken
     run of non-alphanumerics, so a greedy edge-trim swallowed the kaomoji and
     left a bare "MX" that matches half the server.

     Only the outer edges of the outer tokens are trimmed, and only when
     something survives. That keeps "(Bob)" searching as the wider "Bob" while
     preserving a symbol-only token, which on a decorated name is the most
     selective part of the query. */
  const strip = (s, re) => {
    const out = s.replace(re, "");
    return out || s; // never trim a token out of existence
  };
  const lead = /^[^\p{L}\p{N}]+/u;
  const tail = /[^\p{L}\p{N}]+$/u;

  const tokens = norm.split(/\s+/).filter(Boolean);
  const last = tokens.length - 1;
  tokens[0] = strip(tokens[0], lead);
  tokens[last] = strip(tokens[last], tail);

  // Each run of whitespace becomes one wildcard, so the term spans the gap
  // instead of being cut at the first space.
  return tokens.join(WILDCARD);
}

/** True when the query needs a wildcard to be expressible, which is worth
    telling the user because it changes what the results mean. */
export function usesWildcard(query) {
  return searchTerm(query).includes(WILDCARD);
}

/** True when their search cannot express this query at all. Now that whitespace
    is bridged with a wildcard, the only genuinely unsearchable input is one with
    no letters or digits anywhere for the term to be built from. */
export function unsearchable(query) {
  const raw = String(query || "").trim();
  if (!raw) return true;
  return !/[\p{L}\p{N}]/u.test(raw);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur.slice();
  }
  return prev[b.length];
}

const ratio = (a, b) =>
  (!a.length && !b.length) ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length);

/** 0..1 similarity between a query and a candidate name. */
export function matchScore(query, name) {
  const q = normalize(query);
  const n = normalize(name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  let r = ratio(q, n);
  // A clean substring is a strong signal, scaled by how much of the name it covers,
  // so "Bob" ranks far above "Bob the Builder Extraordinaire" for the query "Bob".
  if (n.includes(q)) r = Math.max(r, 0.9 + 0.1 * (q.length / n.length));
  for (const tok of n.split(" ")) if (tok) r = Math.max(r, ratio(q, tok));
  return Math.round(r * 10000) / 10000;
}

/* How much the tracked-server check told us about one result.

   The distinction that matters is between "we checked and they were not there"
   and "we could not check". Only the first is evidence. Treating a failed read
   as absence would quietly punish players for a page that timed out. */
export const EVIDENCE = {
  CONFIRMED: "confirmed",   // seen on a server the user tracks
  ABSENT: "absent",         // sessions read fine, none of their servers matched
  UNKNOWN: "unknown",       // no sessions read, or nothing tracked to compare to
};

/* Blend name similarity with that evidence into the number shown as "Match".

   A name on its own cannot separate eleven players all called Crack Sparrow,
   which is exactly the pile the user was sifting by hand. Presence on a server
   they track is the strongest signal available for "this is the one I mean", so
   it belongs in the score rather than only in the sort order.

     confirmed -> move half way from the name score to certainty
     absent    -> keep about two thirds of it
     unknown   -> leave it alone

   Deliberately monotonic in the name score and never above 1, so a perfect name
   on a tracked server still reads 100% and nothing can outrank it. */
export function confidenceScore(nameScore, evidence) {
  const n = Math.max(0, Math.min(1, Number(nameScore) || 0));
  let out = n;
  if (evidence === EVIDENCE.CONFIRMED) out = n + (1 - n) * 0.5;
  else if (evidence === EVIDENCE.ABSENT) out = n * 0.7;
  return Math.round(out * 10000) / 10000;
}

/* Order a search result set so the people who actually play on YOUR servers rise
   to the top, instead of ten same-named strangers you have to sift by hand.

   A result may carry a cross-reference annotation set by the worker after reading
   the player's sessions page:
     trackedServerId   - a tracked server this player was seen on, or null
     trackedLastSeen    - ISO time they were last on THAT server, or null

   `trackedOrder` is the tracked-server ids in the order the user keeps them, so
   grouping follows the user's own arrangement rather than an arbitrary one.

   Ranking, in order of precedence:
     1. Anyone seen on a tracked server, before anyone who was not.
     2. Within those, by tracked server (in the user's order), because the
        request was to read "in the order of which server they were seen on".
     3. Within one server, most recently seen there first.
     4. Everyone with no tracked-server hit keeps the ordinary ranking: strong
        name matches first, then most recently seen, then closest name.

   If NOTHING matched a tracked server the whole set is ordered by rule 4, which
   is exactly the previous behaviour — the promised fallback.

   Pure and side-effect free so it can be tested without a browser or network. */
export function rankSearchResults(results, trackedOrder = []) {
  const order = new Map(trackedOrder.map((id, i) => [String(id), i]));
  const rows = (results || []).slice();
  const t = (ms) => Number.isFinite(ms) ? ms : -Infinity;
  const seenT = (r) => t(Date.parse(r.trackedLastSeen || "")); // NaN -> -Infinity
  const lastT = (r) => t(Date.parse(r.lastSeen || ""));
  const tier = (s) => (s >= 0.9 ? 2 : s >= 0.6 ? 1 : 0);
  const matched = (r) => r.trackedServerId != null && order.has(String(r.trackedServerId));

  const byPlain = (a, b) =>
    tier(b.score || 0) - tier(a.score || 0) ||
    lastT(b) - lastT(a) ||
    (b.score || 0) - (a.score || 0);

  rows.sort((a, b) => {
    const am = matched(a), bm = matched(b);
    if (am !== bm) return am ? -1 : 1;          // tracked-server hits first
    if (!am) return byPlain(a, b);              // neither matched: ordinary rank
    const ai = order.get(String(a.trackedServerId));
    const bi = order.get(String(b.trackedServerId));
    if (ai !== bi) return ai - bi;              // group by server, user's order
    return seenT(b) - seenT(a);                 // newest on that server first
  });
  return rows;
}

/* Rank server search results by name rather than by population.

   The BattleMetrics results page is ordered the way it ranks servers, which is
   broadly by how busy they are. A small server whose name matches the query
   exactly can therefore sit below a busy one that merely shares a word, or fall
   past the end of the page entirely. The user searched by NAME, so the name is
   what should decide the order.

   Nothing is discarded. A weak match is still a result, just not the first one,
   and the original page order is kept as the tie-break so equally-good matches
   still arrive most-popular-first.

   Pure and side-effect free so it can be tested without a browser or network. */
/* The narrower query to try when a search brought back nothing that matches.

   Server names in a community share almost every word: "CodeFourGaming - King
   of the Hill EU#1" and "... EU#5 - Infantry" differ only in the part carrying
   a number. Searching the full name asks BattleMetrics for the words the
   siblings have in common, and since it returns them ranked by how busy they
   are, a quiet server can fall off the end of the results entirely - the
   ranking here cannot promote what was never sent.

   The tokens carrying digits are the ones that separate siblings, so they make
   a far more selective query. The results are still scored against the ORIGINAL
   query, so searching "EU#1" and matching "CodeFourGaming ... EU#1" still ranks
   the right server first.

   Returns nothing when it would not help: a single token, or a query where
   every token has a digit, would just repeat the search that already failed. */
export function discriminatingTerm(query) {
  const tokens = String(query || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return "";
  const withDigit = tokens.filter((t) => /\d/.test(t));
  if (!withDigit.length || withDigit.length === tokens.length) return "";
  return withDigit.join(WILDCARD);
}

export function rankServerResults(query, rows) {
  return (rows || [])
    .map((r, i) => ({ ...r, score: matchScore(query, r.name || ""), order: i }))
    .sort((a, b) => (b.score - a.score) || (a.order - b.order))
    .map(({ order, ...r }) => r);
}
