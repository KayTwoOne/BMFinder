/* Fills in the runtime build-information placeholders on about.html:
   #about-version, #about-schema, #about-extractor.

   Loaded as a module script, after lib/extract.js has been loaded on the page
   as a plain classic script (see the <script> order in about.html). extract.js
   is written as a classic script on purpose (MV3 content scripts cannot use
   import), so it attaches its exports to globalThis.BMExtract instead of
   using ES module exports - that is why it is read off globalThis here rather
   than imported. */

/* Imported rather than restated so the page cannot report a schema version the
   database is not on. Importing db.js does not open IndexedDB - the connection
   is made lazily on first use, and this page never uses it. */
import { DB_VERSION } from '../lib/db.js';

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function fillVersion() {
  try {
    const manifest = chrome.runtime.getManifest();
    setText('about-version', (manifest && manifest.version) || 'unknown');
  } catch {
    setText('about-version', 'unknown');
  }
}

function fillSchema() {
  setText('about-schema', String(DB_VERSION));
}

/* The extractor version IS a date, stored as YYYY-MM-DD because that sorts and
   compares correctly in code. Showing it in that form on a page read by people
   in the UK invites the 08/13 ambiguity, so it is reformatted for display only.
   The stored value is untouched: anything comparing versions still gets the
   sortable form. A value that is not a date is printed as-is rather than
   mangled, since a future scheme should not silently render as nonsense. */
function ukDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(value || '');
}

function fillExtractor() {
  const ext = globalThis.BMExtract;
  const raw = ext && ext.EXTRACTOR_VERSION;
  setText('about-extractor', raw ? ukDate(raw) : 'unknown');
}

fillVersion();
fillSchema();
fillExtractor();
