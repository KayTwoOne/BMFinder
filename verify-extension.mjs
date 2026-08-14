/* Structural checks against extension/ itself.

   build-webstore.mjs verifies webstore/, which is the stripped copy. That
   catches damage done by stripping, but it is blind to anything living inside a
   @full-only block, and blind to the source the private build ships from. This
   runs the same class of checks against the source both builds come from.

   These are the failures that survive a syntax check and only show up when a
   user clicks the thing: a handler bound to an id the markup no longer has, a
   message with no handler behind it, a badge class with no rule.

   Run: node verify-extension.mjs   (exits non-zero on any failure) */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "extension");

let bad = 0;
const fail = (m) => { bad++; console.log("  FAIL  " + m); };
const okay = (m) => console.log("  ok    " + m);
/* Line endings normalised on the way in. The working tree is CRLF on Windows,
   and several checks below slice on "\n}\n" or split on "\n" - against CRLF
   those silently matched nothing and reported a pass, which is the worst way for
   a checker to fail. */
const read = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const html = read("dashboard/dashboard.html");
const js = read("dashboard/dashboard.js");
const css = read("dashboard/dashboard.css");
const worker = read("background/worker.js");
const popup = read("popup/popup.js");

console.log("Verifying extension/\n");

/* 1. Ids the JS reaches for must exist. Ids come from the static markup AND from
      the templates dashboard.js builds at runtime - the side sheet and the
      ID-scan panel are assembled in JS, so their ids are never in the html. */
const ids = new Set([
  ...[...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
  ...[...js.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]),
]);

// $() throws on a missing element, so these take the page down with them.
const hard = [...js.matchAll(/\$\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)\s*\./g)].map((m) => m[1]);
const missing = [...new Set(hard)].filter((id) => !ids.has(id));
missing.length ? fail(`JS dereferences missing element(s): ${missing.join(", ")}`)
               : okay(`${new Set(hard).size} hard-dereferenced element ids all resolve`);

// on() is null-safe, so a typo here costs a dead control rather than a crash -
// which is worse to find, not better.
const soft = new Set();
for (const re of [/\$\(\s*['"]#([A-Za-z0-9_-]+)/g, /on\(\s*['"]#([A-Za-z0-9_-]+)/g]) {
  for (const m of js.matchAll(re)) soft.add(m[1]);
}
const softMissing = [...soft].filter((id) => !ids.has(id));
softMissing.length ? fail(`referenced but absent from markup: ${softMissing.join(", ")}`)
                   : okay(`all ${soft.size} referenced element ids resolve`);

// 2. Duplicate ids: getElementById silently returns the first, so the second
//    control looks bound and does nothing.
{
  const seen = new Set(), dupes = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
    if (seen.has(m[1])) dupes.add(m[1]);
    seen.add(m[1]);
  }
  dupes.size ? fail(`duplicate element ids: ${[...dupes].join(", ")}`)
             : okay("no duplicate element ids");
}

// 3. Every message the UI sends has a handler behind it.
{
  const handlers = new Set([...worker.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]));
  const sent = new Set();
  for (const src of [js, popup]) {
    for (const m of src.matchAll(/type:\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) sent.add(m[1]);
  }
  // Broadcast types travel the other way and have no handler by design.
  const broadcasts = new Set(["DONE", "PROGRESS", "EXTRACT_WARNING", "PAGE_DATA",
    "SCAN_ROW", "SEEK_ROW", "READ_SERVERSEARCH", "EXTRACT_FAILED", "JOB_DONE"]);
  const noHandler = [...sent].filter((t) => !handlers.has(t) && !broadcasts.has(t));
  noHandler.length ? fail(`messages with no handler: ${noHandler.join(", ")}`)
                   : okay(`all ${sent.size} sent messages have handlers`);
}

/* 4. Relationship styling. The badge and dropdown classes are built by
      interpolation (`b-${rel}`), so scanning for literals cannot see them.
      Assert the vocabulary directly: a relationship with no rule renders as an
      unstyled chip, which reads as a bug rather than a category. */
{
  const rels = ["friend", "teammate", "community", "staff", "other"];
  const gaps = [];
  for (const r of rels) {
    if (!new RegExp(`\\.b-${r}\\b`).test(css)) gaps.push(`.b-${r}`);
    if (!new RegExp(`\\.role-select\\.role-${r}\\b`).test(css)) gaps.push(`.role-select.role-${r}`);
  }
  if (!/\.b-unavailable\b/.test(css)) gaps.push(".b-unavailable");
  gaps.length ? fail(`missing CSS rules: ${gaps.join(", ")}`)
              : okay(`every relationship has a badge and a dropdown rule (${rels.length * 2 + 1} rules)`);
}

// Orphaned rules from the retired vocabulary are dead weight in the bundle.
{
  const dead = ["b-admin", "b-suspect", "b-player", "b-hidden",
    "role-admin", "role-suspect", "role-player"]
    .filter((c) => new RegExp(`\\.${c}\\b`).test(css));
  dead.length ? fail(`retired CSS rules still present: ${dead.join(", ")}`)
              : okay("no orphaned rules from the old vocabulary");
}

/* 5. The retired vocabulary must not reappear anywhere user-visible. The one
      permitted exception is the migration notice, which has to name the role it
      retired or the user cannot tell what happened to their own data. */
{
  for (const [name, src] of [["dashboard.html", html], ["dashboard.js", js],
                             ["dashboard.css", css], ["popup.js", popup]]) {
    const hits = src.split("\n")
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /\bsuspect\b/i.test(l) && !/retired|hadSuspect/.test(l));
    hits.length
      ? fail(`${name} uses the retired vocabulary at line(s) ${hits.map(([n]) => n).join(", ")}`)
      : okay(`${name} is free of the retired vocabulary`);
  }
}

/* 5b. Vocabulary the public release audit bans outright (§3.2).

   These words framed the extension as an investigation tool. They are checked
   against user-visible text, not identifiers: `e.target` and `target="_blank"`
   are DOM, not vocabulary, so "target" is only checked where a reader would
   actually see it. The ID Scan panel is exempt - it is private-build-only and
   stripped from anything published. */
{
  /* Checked line by line across whole files rather than by parsing out string
     literals. Parsing them is not worth it: an apostrophe in a prose comment
     ("the user's own tab") opens a phantom string that swallows code until the
     next apostrophe, which produced false positives. None of these words has a
     legitimate technical use in this codebase, so any occurrence at all is the
     thing being looked for. */
  const banned = /\b(suspect|surveillance|hidden admin|risk score|investigation candidate|correlation subject)\b/i;
  const offenders = [];

  for (const [name, src] of [["dashboard.html", html], ["dashboard.js", js],
                             ["dashboard.css", css], ["popup.js", popup],
                             ["worker.js", worker]]) {
    src.split("\n").forEach((line, i) => {
      // The v4 migration notice has to name the role it retired; see check 5.
      if (/retired|hadSuspect|RELATIONSHIP_FROM_LEGACY/.test(line)) return;
      if (banned.test(line)) offenders.push(`${name}:${i + 1}  ${line.trim().slice(0, 66)}`);
    });
  }

  offenders.length
    ? fail(`banned vocabulary in user-visible text:\n        ${offenders.join("\n        ")}`)
    : okay("no banned vocabulary in user-visible text");
}

// 6. No code path may write a relationship outside the vocabulary.
{
  const writes = [...js.matchAll(/role:\s*['"]([a-z]+)['"]/g),
                  ...popup.matchAll(/role:\s*['"]([a-z]+)['"]/g)].map((m) => m[1]);
  const legal = new Set(["friend", "teammate", "community", "staff", "other"]);
  const illegal = [...new Set(writes)].filter((r) => !legal.has(r));
  illegal.length ? fail(`literal role values outside the vocabulary: ${illegal.join(", ")}`)
                 : okay(`${writes.length} literal role write(s), all in the vocabulary`);
}

/* 7. Nothing may poll while the dashboard is closed. This is the behaviour that
      stops the extension navigating a tab to battlemetrics.com on browser start,
      so it is asserted rather than trusted. */
{
  const gaps = [];
  if (!/async function dashboardOpen\(/.test(worker)) gaps.push("dashboardOpen() is gone");
  if (!/async function disclosureAccepted\(/.test(worker)) gaps.push("disclosureAccepted() is gone");
  if (/onStartup\.addListener\(reconcileAlarm\)/.test(worker)) gaps.push("startup re-arms the alarm");

  // applyAlarm must consult both gates before it will arm anything.
  const arm = worker.slice(worker.indexOf("async function applyAlarm"));
  const armBody = arm.slice(0, arm.indexOf("\n}\n") + 1);
  if (!/await disclosureAccepted\(\)/.test(armBody)) gaps.push("applyAlarm does not check consent");
  if (!/await dashboardOpen\(\)/.test(armBody)) gaps.push("applyAlarm does not check for an open dashboard");

  // ...and the alarm handler must re-check them, because either can change while
  // the worker is asleep and the teardown handler never runs.
  const fire = worker.slice(worker.indexOf("chrome.alarms.onAlarm.addListener"));
  const fireBody = fire.slice(0, fire.indexOf("\n});\n") + 1);
  if (!/await disclosureAccepted\(\)/.test(fireBody)) gaps.push("the alarm handler does not re-check consent");
  if (!/await dashboardOpen\(\)/.test(fireBody)) gaps.push("the alarm handler does not re-check for an open dashboard");

  // Passive persistence is gated too: the rule is nothing RECORDED before consent.
  const store = worker.slice(worker.indexOf("async function storePage"));
  if (!/await disclosureAccepted\(\)/.test(store.slice(0, 600))) {
    gaps.push("storePage records without checking consent");
  }

  gaps.length ? fail(`polling/consent gates: ${gaps.join("; ")}`)
              : okay("polling and passive recording are gated on consent and an open dashboard");
}

/* 7b. The scheduled poll must not restart its own countdown on every reconnect.
      MV3 tears an idle worker down constantly and the dashboard reconnects a
      second later; an unconditional re-arm meant a long interval never came due.
      Re-arming has to be conditional on there being nothing armed, the period
      having changed, or an explicit restart. */
{
  const arm = worker.slice(worker.indexOf("async function applyAlarm"));
  const body = arm.slice(0, arm.indexOf("\n}\n") + 1);
  const guarded = /existing\s*&&\s*!restart\s*&&\s*existing\.periodInMinutes\s*===/.test(body);
  guarded ? okay("an already-correct poll schedule is left running on reconnect")
          : fail("applyAlarm re-arms unconditionally; reconnects will reset the countdown");
}

/* 7c. Export defaults.

   The whole point of the export dialog is that identifiers and history are OFF
   until someone deliberately turns them on. A checked attribute added to the
   wrong line would hand that away silently, so the defaults are asserted against
   the audit's list rather than trusted. */
{
  const WANT = {
    label: true, currentName: true, relationship: true, tags: true,
    playerId: false, lastServer: false, lastSeen: false,
    serverName: true, serverLink: true, serverId: false,
    checks: false, rosterMembers: false, exactTimes: false, activityPlayerIds: false,
  };
  const block = html.slice(html.indexOf('id="exp-fields"'), html.indexOf('id="exp-warn"'));
  const found = [...block.matchAll(/data-f="([A-Za-z]+)"( checked)?/g)].map((m) => [m[1], !!m[2]]);
  const problems = [];
  for (const [k, on] of found) {
    if (!(k in WANT)) problems.push(`unknown field "${k}"`);
    else if (WANT[k] !== on) problems.push(`${k} defaults ${on ? "on" : "off"}, should be ${WANT[k] ? "on" : "off"}`);
  }
  const missing = Object.keys(WANT).filter((k) => !found.some(([f]) => f === k));
  if (missing.length) problems.push(`missing field(s): ${missing.join(", ")}`);

  // The acknowledgement must never ship pre-ticked.
  const ackAt = html.indexOf('id="exp-ack"');
  if (ackAt !== -1 && /checked/.test(html.slice(ackAt - 60, ackAt + 60))) {
    problems.push("the review acknowledgement is preselected");
  }
  // A full backup must not be the format a sharing dialog opens on.
  const fmtAt = html.indexOf('id="exp-format"');
  const def = (html.slice(fmtAt, fmtAt + 900).match(/value="(\w+)" checked/) || [])[1];
  if (def === "backup") problems.push("full backup is the default export format");

  problems.length ? fail(`export defaults: ${problems.join("; ")}`)
                  : okay(`all ${found.length} export field defaults match the audit`);
}

// 7d. The share preset must never carry identifiers or unsaved roster members.
{
  const share = js.slice(js.indexOf("share: {"), js.indexOf("activity: {"));
  const problems = [];
  if (!/lock:\s*\{\s*rosterMembers:\s*false/.test(share)) problems.push("share does not lock unsaved roster members off");
  for (const f of ["playerId", "activityPlayerIds", "exactTimes", "checks"]) {
    if (new RegExp(`${f}:\\s*1`).test(share)) problems.push(`share enables ${f}`);
  }
  const warn = (js.match(/EXPORT_WARN_FIELDS = \[([^\]]+)\]/) || [])[1] || "";
  for (const f of ["playerId", "exactTimes", "rosterMembers", "checks"]) {
    if (!warn.includes(f)) problems.push(`${f} does not trigger the export warning`);
  }
  problems.length ? fail(`export sharing safety: ${problems.join("; ")}`)
                  : okay("the share preset carries no identifiers, and every sensitive field warns");
}

// 8. No network call may reach anything but BattleMetrics. No analytics, no CDN.
{
  const sources = ["background/worker.js", "dashboard/dashboard.js", "popup/popup.js",
    "content/reader.js", "lib/extract.js", "lib/db.js", "lib/match.js",
    "lib/theme.js", "lib/relationships.js"];
  const offenders = [];
  for (const p of sources) {
    for (const m of read(p).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      if (!/(^|\.)battlemetrics\.com$/i.test(m[1]) && !/^(www\.)?w3\.org$/i.test(m[1])) {
        offenders.push(`${p} -> ${m[1]}`);
      }
    }
  }
  offenders.length ? fail(`off-site URLs: ${offenders.join(", ")}`)
                   : okay("every URL in the source points at battlemetrics.com");
}

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
