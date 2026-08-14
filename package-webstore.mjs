/* Produce webstore/ from extension/.
 *
 * This used to be a 343-line transformer: it stripped @full-only regions,
 * rewrote the manifest, and lowered the polling floor, because the public build
 * was a reduced version of a larger private one. That distinction is gone. ID
 * enumeration and absence correlation were deleted from the source outright
 * rather than stripped from one copy, and the manifest and polling floor the
 * public build wanted are now simply what the source says.
 *
 * So there is nothing left to transform, and a transformer that transforms
 * nothing is a place for bugs to hide. What remains is the honest operation:
 * copy the source, leave out the files a browser extension has no use for, and
 * prove the two are identical afterwards.
 *
 * Run: node package-webstore.mjs
 */

import {
  readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, statSync, copyFileSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "extension");
const OUT = join(ROOT, "webstore");

/* Files that exist for development and have no business in a packaged
   extension. Chrome never reads any of them, and shipping them only widens what
   a reviewer has to read and what a user has downloaded. */
const EXCLUDE_DIRS = new Set(["test"]);
const EXCLUDE_FILES = new Set(["package.json", "README.md"]);

let failed = false;
const fail = (m) => { failed = true; console.log("  FAIL  " + m); };
const okay = (m) => console.log("  ok    " + m);

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(base, abs).split("\\").join("/");
    if (statSync(abs).isDirectory()) {
      if (EXCLUDE_DIRS.has(rel)) continue;
      out.push(...walk(abs, base));
    } else {
      out.push(rel);
    }
  }
  return out;
}

console.log("Packaging webstore/ from extension/\n");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const srcFiles = walk(SRC);
const shipped = [];
for (const rel of srcFiles) {
  if (EXCLUDE_FILES.has(rel) || EXCLUDE_DIRS.has(rel.split("/")[0])) {
    console.log(`  skip  ${rel}`);
    continue;
  }
  const to = join(OUT, rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(SRC, rel), to);
  shipped.push(rel);
}

console.log(`\nCopied ${shipped.length} files.\n\nVerifying:`);

/* 1. Every shipped file is byte-for-byte what the source holds. This is the
      whole promise of the new arrangement, so it is checked rather than assumed. */
{
  const differing = shipped.filter((rel) => {
    const a = readFileSync(join(SRC, rel));
    const b = readFileSync(join(OUT, rel));
    return !a.equals(b);
  });
  differing.length
    ? fail(`not identical to source: ${differing.join(", ")}`)
    : okay(`all ${shipped.length} files are byte-identical to extension/`);
}

// 2. Nothing was left out except the exclusions, and nothing extra appeared.
{
  const expected = srcFiles
    .filter((r) => !EXCLUDE_FILES.has(r) && !EXCLUDE_DIRS.has(r.split("/")[0]))
    .sort();
  const actual = walk(OUT).sort();
  const missing = expected.filter((r) => !actual.includes(r));
  const extra = actual.filter((r) => !expected.includes(r));
  if (missing.length) fail(`missing from the package: ${missing.join(", ")}`);
  if (extra.length) fail(`unexpected in the package: ${extra.join(", ")}`);
  if (!missing.length && !extra.length) okay("the package contains exactly the shipping files");
}

// 3. Development files really are absent.
{
  const leaked = walk(OUT).filter(
    (r) => EXCLUDE_FILES.has(r) || EXCLUDE_DIRS.has(r.split("/")[0]) || /\.test\.js$/.test(r),
  );
  leaked.length ? fail(`development files shipped: ${leaked.join(", ")}`)
                : okay("no test or tooling files in the package");
}

// 4. The manifest is what a reviewer should see.
{
  try {
    const m = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));
    if (m.manifest_version !== 3) fail("manifest_version is not 3");
    if ((m.permissions || []).includes("bookmarks")) {
      fail("bookmarks is a required permission; it should be optional and requested on use");
    }
    const hosts = m.host_permissions || [];
    if (hosts.length !== 1 || hosts[0] !== "https://www.battlemetrics.com/*") {
      fail(`host_permissions should be battlemetrics.com only, got ${JSON.stringify(hosts)}`);
    }
    if (!m.description || m.description.length > 132) {
      fail("description is missing or longer than the 132 characters the store allows");
    }
    for (const size of ["16", "32", "48", "128"]) {
      if (!m.icons || !m.icons[size]) fail(`icons is missing the ${size}px entry`);
    }
    if (!failed) {
      okay(`manifest ok, permissions: ${(m.permissions || []).join(", ")}`);
      okay(`optional: ${(m.optional_permissions || []).join(", ") || "none"}`);
    }
  } catch (e) {
    fail("manifest.json is unreadable: " + e.message);
  }
}

// 5. Every file the manifest names actually exists in the package.
{
  const m = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));
  const refs = [
    m.background && m.background.service_worker,
    m.action && m.action.default_popup,
    m.options_page,
    ...Object.values((m.action && m.action.default_icon) || {}),
    ...Object.values(m.icons || {}),
    ...(m.content_scripts || []).flatMap((c) => c.js || []),
  ].filter(Boolean);
  const present = new Set(walk(OUT));
  const dangling = [...new Set(refs)].filter((r) => !present.has(r));
  dangling.length ? fail(`manifest references missing file(s): ${dangling.join(", ")}`)
                  : okay(`all ${new Set(refs).size} manifest-referenced files are present`);
}

/* 6. Every permission requested has a written justification, and every
      justification names a permission still requested.

      A reviewer reads both. Requesting something the docs do not explain reads
      as overreach; documenting something no longer requested reads as stale. */
{
  const m = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));
  const hosts = m.host_permissions || [];
  const justPath = join(ROOT, "webstore-assets", "PERMISSION-JUSTIFICATIONS.md");
  try {
    const doc = readFileSync(justPath, "utf8");
    /* Headings are "## storage", "## bookmarks (optional, ...)" and
       "## Host permission: https://...". Only the first word identifies the
       permission, and the host entry is documented prose rather than a
       manifest `permissions` key, so it is not matched against the list. */
    const documented = [...doc.matchAll(/^##\s+([A-Za-z]+)/gm)]
      .map((x) => x[1])
      .filter((p) => p !== "Host");
    const requested = [...(m.permissions || []), ...(m.optional_permissions || [])];
    const undocumented = requested.filter((p) => !documented.includes(p));
    const stale = documented.filter((p) => !requested.includes(p));
    const problems = [];
    if (undocumented.length) problems.push(`requested but unexplained: ${undocumented.join(", ")}`);
    if (stale.length) problems.push(`explained but no longer requested: ${stale.join(", ")}`);
    // The host permission is prose rather than a permissions key, but it still
    // has to be justified, and it has to name the one host actually used.
    if (!doc.includes(hosts[0])) problems.push("the host permission is not justified");
    problems.length ? fail(`permission docs: ${problems.join("; ")}`)
                    : okay(`all ${requested.length} permissions have a written justification`);
  } catch {
    fail("webstore-assets/PERMISSION-JUSTIFICATIONS.md is missing");
  }
}

/* 7. The store's short description and the manifest must be the same sentence.
      They appear side by side on the listing page. */
{
  const m = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));
  try {
    const listing = readFileSync(join(ROOT, "webstore-assets", "STORE-LISTING.md"), "utf8");
    listing.includes(m.description)
      ? okay("the store listing quotes the manifest description exactly")
      : fail("the store listing's short description does not match the manifest");
  } catch {
    fail("webstore-assets/STORE-LISTING.md is missing");
  }
}

console.log(
  failed
    ? "\nPackaging FAILED. Do not upload webstore/ until the failures above are resolved."
    : `\nPackage OK. ${shipped.length} files in webstore/`,
);
process.exit(failed ? 1 : 0);
