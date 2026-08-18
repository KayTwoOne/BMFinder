/* Validate listing screenshots against what the Chrome Web Store accepts.
 *
 * The store rejects, or silently mangles, screenshots that are the wrong size
 * or that carry an alpha channel. Both are easy to produce by accident and
 * neither is obvious until the upload form refuses the file, so check here
 * first.
 *
 * Run: node check-screenshots.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "webstore-assets", "screenshots");
const ACCEPTED = [[1280, 800], [640, 400]];

/* PNG header: width and height are big-endian 32-bit ints at byte 16 and 20,
   colour type is a single byte at 25. Types 4 and 6 carry alpha. */
function readPng(buf) {
  if (buf.length < 26 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    hasAlpha: [4, 6].includes(buf[25]),
  };
}

/* JPEG: walk the segment markers to the frame header, which carries the size.
   No alpha to worry about, JPEG cannot represent one. */
function readJpeg(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), hasAlpha: false };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

let files;
try {
  files = readdirSync(DIR).filter((f) => [".png", ".jpg", ".jpeg"].includes(extname(f).toLowerCase()));
} catch {
  console.error(`No screenshots directory at ${DIR}`);
  process.exit(1);
}

if (!files.length) {
  console.log("No screenshots yet. Capture them at 1280x800 and drop them in");
  console.log(`  ${DIR}`);
  process.exit(1);
}

console.log(`Checking ${files.length} screenshot(s) in webstore-assets/screenshots\n`);

let bad = 0;
for (const f of files.sort()) {
  const p = join(DIR, f);
  const buf = readFileSync(p);
  const meta = extname(f).toLowerCase() === ".png" ? readPng(buf) : readJpeg(buf);
  const kb = (statSync(p).size / 1024).toFixed(0);

  if (!meta) {
    console.log(`  FAIL  ${f} — not a readable PNG or JPEG`);
    bad++;
    continue;
  }

  const sizeOk = ACCEPTED.some(([w, h]) => meta.width === w && meta.height === h);
  const problems = [];
  if (!sizeOk) problems.push(`${meta.width}x${meta.height}, need 1280x800 or 640x400`);
  if (meta.hasAlpha) problems.push("has an alpha channel, flatten it onto a solid background");

  if (problems.length) {
    console.log(`  FAIL  ${f} — ${problems.join("; ")}`);
    bad++;
  } else {
    console.log(`  ok    ${f}  ${meta.width}x${meta.height}, ${kb}KB`);
  }
}

if (files.length > 5) {
  console.log(`\n  note  ${files.length} files present; the store accepts at most 5.`);
}

console.log();
if (bad) {
  console.log(`${bad} screenshot(s) would be rejected. Fix them before uploading.`);
  process.exit(1);
}
console.log(`All ${files.length} screenshot(s) meet the store's requirements.`);
