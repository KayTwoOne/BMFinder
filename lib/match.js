/* Fuzzy name matching.

   Direct port of the Python scorer that was validated against real cases:
   exact and case variants score 1, clan-tag prefixes like "[TAG] Bob" still match
   "Bob", and names that differ only in separator style ("xX_Sniper_Xx" vs
   "xX Sniper Xx") come out identical. Keep those behaviours if you touch this. */

const SEP = /[\s_\-.|/\\]+/g;

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

/* Query forms to try against BattleMetrics, most specific first.

   Their search copes badly with heavily decorated names: a query full of
   brackets and kaomoji characters comes back with unrelated players, or with
   nothing. So when the exact string does not find the player, retry with
   progressively plainer forms of it. Scoring still happens against the ORIGINAL
   query, so a plainer search term never inflates anyone's match. */
export function searchVariants(query) {
  const raw = String(query || "").trim();
  const out = [];
  const add = (s) => {
    const v = String(s || "").trim();
    if (v && !out.includes(v)) out.push(v);
  };

  add(raw);

  // Everything that is not a letter, digit or space is decoration as far as
  // their search index is concerned.
  let plain = raw;
  try {
    plain = raw.normalize("NFKC").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
  } catch {
    plain = raw.replace(/[^A-Za-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
  }
  add(plain);

  // Failing that, the longest word left. A decorated name is usually one real
  // word wrapped in symbols, and the longest token is the most selective thing
  // to search for.
  const tokens = plain.split(" ").filter((t) => t.length >= 2);
  if (tokens.length > 1) add(tokens.slice().sort((a, b) => b.length - a.length)[0]);

  return out.slice(0, 3);
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
