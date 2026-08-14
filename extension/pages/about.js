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

function fillExtractor() {
  const ext = globalThis.BMExtract;
  setText('about-extractor', (ext && ext.EXTRACTOR_VERSION) || 'unknown');
}

fillVersion();
fillSchema();
fillExtractor();
