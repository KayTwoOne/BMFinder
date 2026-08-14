#!/usr/bin/env node
/* Generate the Chrome Web Store build from the full extension.
 *
 *   node build-webstore.mjs
 *
 * extension/ is the single source of truth. This script produces webstore/ from
 * it by physically REMOVING the features that do not belong in a published
 * build, rather than disabling them behind a flag: a reviewer reads the package
 * that ships, so code that is present but unreachable is still code that is
 * present.
 *
 * What comes out:
 *   - no sequential ID enumeration, no date bisection
 *   - polling floor and default both 5 minutes
 *   - bookmarks demoted to an optional permission, requested on click
 *
 * Regions to strip are marked in the source with @full-only, so the boundaries
 * are decided by the person editing the code and not guessed at here. Two forms:
 *
 *   /_* @full-only *_/            strip this single line
 *   /_* @full-only:start *_/      strip everything through the matching end
 *   /_* @full-only:end *_/
 *
 * (HTML uses <!-- --> comments with the same words.)
 *
 * The script refuses to write a build that fails its own checks, so a botched
 * strip cannot silently ship.
 */

import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "extension");
const OUT = join(ROOT, "webstore");

/* Files that exist only to serve a stripped feature. Empty right now: absence
   correlation used to live in lib/correlation.js, but it was deleted from the
   source outright rather than stripped from one build. Kept as a hook because
   the mechanism is still right if a full-only module ever reappears. */
const DROP_FILES = [];

/* Text files that get marker processing. Everything else is copied verbatim. */
const PROCESS_EXT = new Set([".js", ".html", ".css", ".json", ".md"]);

/* Nothing matching these may survive into the output. This is the safety net:
   if a marker is mis-placed and enumeration code slips through, the build
   fails loudly instead of shipping. */
const FORBIDDEN = [
  { re: /\bscanRange\b/, why: "ID enumeration function" },
  { re: /\bseekDate\b/, why: "date-bisection probing" },
  { re: /["']SEEK_DATE["']|\bSEEK_DATE:/, why: "date-seek message" },
  { re: /["']SCAN["']|\bSCAN:/, why: "scan message" },
  /* Absence correlation is gone from BOTH builds now, not stripped from one.
     These stay as a tripwire: if any of it is ever reintroduced, the public
     build refuses to package rather than quietly shipping an accusation
     engine that scored people for being offline. */
  { re: /\bcorrelate\b|\bcorrelationMeta\b/, why: "absence-correlation engine" },
  { re: /["']CORRELATION["']|\bCORRELATION:/, why: "correlation message" },
  /* lib/db.js is exempt from this one rule only. Its v5 migration has to name
     these fields in order to strip them from databases written before they were
     removed - code that deletes the tally is the opposite of code that keeps
     one, and the exemption is per-file so a reference anywhere else still
     fails the build. */
  {
    re: /\badminPolls\b|\badminHere\b/,
    why: "staff-presence tally that fed correlation",
    except: ["lib/db.js"],
  },
  { re: /@full-only/, why: "unprocessed build marker" },
];

const MIN_POLL_SECONDS = 300; // 5 minutes, floor and default

let failed = false;
const fail = (msg) => { console.error("  FAIL  " + msg); failed = true; };
const okay = (msg) => console.log("  ok    " + msg);

/* ---- marker stripping ---------------------------------------------------- */

/** Remove @full-only regions. Returns {text, removed} or throws on unbalanced
 *  markers, because silently keeping a region would be the dangerous outcome. */
function strip(text, file) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let depth = 0;
  let removed = 0;
  let openedAt = 0;

  lines.forEach((line, i) => {
    const hasStart = /@full-only:start/.test(line);
    const hasEnd = /@full-only:end/.test(line);

    // A region opened and closed on the same line (the inline form used for a
    // single tab button) is just a one-line removal.
    if (hasStart && hasEnd && depth === 0) { removed++; return; }

    if (hasStart) {
      if (depth === 0) openedAt = i + 1;
      depth++;
      removed++;
      return;
    }
    if (hasEnd) {
      depth--;
      removed++;
      if (depth < 0) throw new Error(`${file}: @full-only:end without a start at line ${i + 1}`);
      return;
    }
    if (depth > 0) { removed++; return; }
    // Single-line form, only when it is not part of a region already handled.
    if (/@full-only/.test(line)) { removed++; return; }
    out.push(line);
  });

  if (depth !== 0) throw new Error(`${file}: @full-only:start at line ${openedAt} was never closed`);
  return { text: out.join("\n"), removed };
}

/* ---- per-file rewrites --------------------------------------------------- */

function rewriteManifest(text) {
  const m = JSON.parse(text);
  // bookmarks is a scary install prompt for one convenience button, and the
  // file-import path already covers the same job. Ask for it on click instead.
  m.permissions = (m.permissions || []).filter((p) => p !== "bookmarks");
  m.optional_permissions = [...new Set([...(m.optional_permissions || []), "bookmarks"])];
  m.description = "See when the players you follow are online on the game servers you track.";
  return JSON.stringify(m, null, 2) + "\n";
}

/** Raise the polling floor and default to 5 minutes. */
function rewritePollInterval(text, file) {
  let out = text;
  if (file.endsWith("dashboard.html")) {
    // Drop the sub-5-minute options and make 5 minutes the selected default.
    out = out.replace(/\s*<option value="(?:60|120)">[^<]*<\/option>/g, "");
    out = out.replace(/<option value="300"[^>]*>/, '<option value="300" selected>');
  }
  if (file.endsWith("dashboard.js")) {
    // Both call sites clamp with Math.max(60, ...); lift the floor.
    out = out.replace(/Math\.max\(60,\s*Number\(\$\('#mon-interval'\)\.value\)\s*\|\|\s*300\)/g,
      `Math.max(${MIN_POLL_SECONDS}, Number($('#mon-interval').value) || ${MIN_POLL_SECONDS})`);
  }
  if (file.endsWith("worker.js")) {
    // The worker independently clamps the alarm period; keep the two in step.
    out = out.replace(/const MONITOR_DEFAULT = \{ mode: "stopped", intervalSec: \d+/,
      `const MONITOR_DEFAULT = { mode: "stopped", intervalSec: ${MIN_POLL_SECONDS}`);
    out = out.replace(/Math\.max\(1,\s*Math\.round\(\(state\.intervalSec \|\| \d+\) \/ 60\)\)/,
      `Math.max(${MIN_POLL_SECONDS / 60}, Math.round((state.intervalSec || ${MIN_POLL_SECONDS}) / 60))`);
  }
  return out;
}

/* ---- walk ---------------------------------------------------------------- */

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "pr") continue;
      out.push(...walk(full, base));
    } else {
      out.push(relative(base, full).split(sep).join("/"));
    }
  }
  return out;
}

/* ---- build --------------------------------------------------------------- */

console.log("Building webstore/ from extension/\n");

if (!existsSync(SRC)) { console.error("extension/ not found"); process.exit(1); }
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const files = walk(SRC);
let stripped = 0;

for (const rel of files) {
  if (DROP_FILES.includes(rel)) { console.log(`  drop  ${rel}`); continue; }

  const from = join(SRC, rel);
  const to = join(OUT, rel);
  mkdirSync(dirname(to), { recursive: true });

  const ext = rel.slice(rel.lastIndexOf("."));
  if (!PROCESS_EXT.has(ext)) { cpSync(from, to); continue; }

  let text = readFileSync(from, "utf8");
  let removed = 0;
  try { ({ text, removed } = strip(text, rel)); }
  catch (e) { console.error("  FAIL  " + e.message); process.exit(1); }
  if (removed) { stripped += removed; console.log(`  strip ${rel}  (${removed} lines)`); }

  if (rel === "manifest.json") text = rewriteManifest(text);
  else text = rewritePollInterval(text, rel);

  writeFileSync(to, text);
}

console.log(`\nStripped ${stripped} lines across the build.\n\nVerifying:`);

/* ---- verification -------------------------------------------------------- */

const outFiles = walk(OUT);

// 1. Nothing forbidden survived.
for (const rel of outFiles) {
  const ext = rel.slice(rel.lastIndexOf("."));
  if (!PROCESS_EXT.has(ext)) continue;
  const text = readFileSync(join(OUT, rel), "utf8");
  for (const { re, why, except } of FORBIDDEN) {
    if (except && except.includes(rel)) continue;
    if (re.test(text)) fail(`${rel} still contains ${why} (${re})`);
  }
}
if (!failed) okay("no enumeration, correlation or leftover markers in the output");

/* 1b. Every emitted JS file still parses.

   This is the check that matters most, because the failure it catches is silent
   and easy to cause: a marker placed INSIDE a block comment splits that comment,
   the opening slash-star survives the strip, and the file becomes unparseable.
   Shelling out to node --check is the only honest way to know the output is
   still valid JavaScript rather than merely looking right. */
for (const rel of outFiles) {
  if (!rel.endsWith(".js")) continue;
  const r = spawnSync(process.execPath, ["--check", join(OUT, rel)], { encoding: "utf8" });
  if (r.status !== 0) {
    const msg = (r.stderr || "").split("\n").find((l) => /SyntaxError|Error/.test(l)) || "did not parse";
    fail(`${rel} is not valid JS after stripping: ${msg.trim()}`);
  }
}
if (!failed) okay(`all ${outFiles.filter((f) => f.endsWith(".js")).length} JS files parse`);

/* 1c. No call to a function the strip removed.

   node --check proves the output PARSES, which is not the same as it working:
   stripping a function while leaving its call site is still valid JavaScript and
   only fails at runtime, when a job finishes and the listener throws. This
   caught exactly that (finishScan, onScanRow, finishSeek, onSeekRow all
   surviving as calls into deleted code), so it stays. */
for (const rel of outFiles) {
  if (!rel.endsWith(".js") || rel.includes("/test/") || rel.startsWith("test/")) continue;
  const text = readFileSync(join(OUT, rel), "utf8");
  const src = readFileSync(join(SRC, rel), "utf8");
  // Names the FULL build defines at top level but this build no longer does.
  const defRe = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
  const fullDefs = new Set([...src.matchAll(defRe)].map((m) => m[1]));
  const outDefs = new Set([...text.matchAll(defRe)].map((m) => m[1]));
  for (const name of fullDefs) {
    if (outDefs.has(name)) continue;
    // Called anywhere in the emitted file?
    const called = new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(text);
    if (called) fail(`${rel} calls ${name}(), which the strip removed`);
  }
}
if (!failed) okay("no calls into stripped functions");

// 2. Dropped files are actually gone.
for (const f of DROP_FILES) {
  if (existsSync(join(OUT, f))) fail(`${f} should have been dropped`);
}
okay("feature-only files removed");

// 3. The manifest is valid and says what we expect.
try {
  const m = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));
  if (m.manifest_version !== 3) fail("manifest_version is not 3");
  if ((m.permissions || []).includes("bookmarks")) fail("bookmarks is still a required permission");
  if (!(m.optional_permissions || []).includes("bookmarks")) fail("bookmarks is not in optional_permissions");
  okay(`manifest ok, permissions: ${(m.permissions || []).join(", ")}`);
  okay(`optional: ${(m.optional_permissions || []).join(", ")}`);
} catch (e) { fail("manifest.json did not parse: " + e.message); }

// 4. Polling floor really is 5 minutes everywhere it is enforced.
{
  const html = readFileSync(join(OUT, "dashboard/dashboard.html"), "utf8");
  // Scope to the interval picker. Other selects on the page (the Archive's
  // "last N polls") use numeric values too, and counting those as poll
  // intervals produced a false failure.
  const sel = html.match(/<select id="mon-interval">([\s\S]*?)<\/select>/);
  if (!sel) fail("could not find the #mon-interval select");
  else {
    const pollOpts = [...sel[1].matchAll(/<option value="(\d+)"/g)].map((x) => Number(x[1]));
    const tooFast = pollOpts.filter((n) => n < MIN_POLL_SECONDS);
    if (tooFast.length) fail(`interval options below the floor remain: ${tooFast.join(", ")}s`);
    else okay(`interval options start at ${Math.min(...pollOpts)}s (${pollOpts.length} choices)`);
  }
  if (!/<option value="300" selected>/.test(html)) fail("5 minutes is not the selected default");
  else okay("5 minutes is the default");

  const js = readFileSync(join(OUT, "dashboard/dashboard.js"), "utf8");
  if (/Math\.max\(60,/.test(js)) fail("dashboard still clamps the interval at 60s");
  else okay("dashboard clamps at the 5 minute floor");
}

// 5. Every ID the JS reaches for still exists in the HTML. A strip that removed
//    markup but left its handler would throw on load and take the page down.
{
  const html = readFileSync(join(OUT, "dashboard/dashboard.html"), "utf8");
  const js = readFileSync(join(OUT, "dashboard/dashboard.js"), "utf8");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set();
  for (const re of [/\$\(\s*['"]#([A-Za-z0-9_-]+)/g, /on\(\s*['"]#([A-Za-z0-9_-]+)/g]) {
    for (const m of js.matchAll(re)) used.add(m[1]);
  }
  // $() throws on a missing element; on() is null-safe by design.
  const hard = [...js.matchAll(/\$\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)\s*\./g)].map((m) => m[1]);
  const missing = [...new Set(hard)].filter((id) => !ids.has(id));
  if (missing.length) fail(`JS dereferences missing element(s): ${missing.join(", ")}`);
  else okay(`all ${used.size} referenced element ids resolve`);

  const dupes = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
    .filter((v, i, a) => a.indexOf(v) !== i);
  if (dupes.length) fail(`duplicate element ids: ${[...new Set(dupes)].join(", ")}`);
  else okay("no duplicate element ids");
}

// 6. Every message the dashboard sends has a handler in the worker.
{
  const js = readFileSync(join(OUT, "dashboard/dashboard.js"), "utf8");
  const w = readFileSync(join(OUT, "background/worker.js"), "utf8");
  const sent = new Set([...js.matchAll(/type:\s*['"]([A-Z_]+)['"]/g)].map((m) => m[1]));
  const broadcasts = new Set(["PROGRESS", "SCAN_ROW", "SEEK_ROW", "DONE", "EXTRACT_WARNING"]);
  const handlers = new Set([...w.matchAll(/^\s{2}([A-Z_]+):\s/gm)].map((m) => m[1]));
  const orphan = [...sent].filter((t) => !handlers.has(t) && !broadcasts.has(t));
  if (orphan.length) fail(`no worker handler for: ${orphan.join(", ")}`);
  else okay(`all ${sent.size - [...sent].filter((t) => broadcasts.has(t)).length} sent messages have handlers`);
}

console.log("");
if (failed) {
  console.error("Build FAILED verification. webstore/ is left in place for inspection,");
  console.error("but do NOT publish it until the failures above are resolved.");
  process.exit(1);
}
console.log(`Build OK. ${outFiles.length} files in webstore/`);
