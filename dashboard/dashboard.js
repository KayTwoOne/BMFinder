/* Dashboard UI. Pure presentation: every read and write goes through the
   background service worker over chrome.runtime.sendMessage. This file never
   opens IndexedDB and never fetches battlemetrics.com itself.

   The message contract is fixed by background/worker.js. A few controls in
   dashboard.html do not have a matching message type (server search by name,
   per-request delay, ID cache reuse) because the worker does not implement
   that behaviour yet. Those controls are handled honestly below rather than
   faked. */

import { applyTheme, resolveMode, SEEDS, seedSwatch } from '../lib/theme.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* Binding by id at module scope is convenient but brittle: one missing element
   threw before any later listener was attached, which took the whole dashboard
   down rather than the one feature. on() binds when the element exists and is a
   no-op when it does not, so removing a control from the markup is a markup
   change and nothing more. */
function on(sel, ev, fn, opts) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.addEventListener(ev, fn, opts);
  return el;
}

const esc = s => (s==null?'':String(s)).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const fdate = iso => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(); };
const fdt = iso => { if (!iso) return '-'; const d = new Date(iso); return isNaN(d) ? '-' : d.toLocaleString(); };
// Compact "9h ago" style for at-a-glance scanning; full timestamp goes in a title.
const frel = iso => {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 0) return fdate(iso);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const dd = Math.floor(h / 24); if (dd < 30) return dd + 'd ago';
  const mo = Math.floor(dd / 30); if (mo < 12) return mo + 'mo ago';
  return Math.floor(mo / 12) + 'y ago';
};
// Longer, sentence-shaped relative time for places with room for it.
const frelLong = iso => {
  const short = frel(iso);
  if (!short) return '';
  if (short === 'just now') return 'just now';
  return short
    .replace(/^(\d+)m ago$/, (_, n) => `${n} minute${n === '1' ? '' : 's'} ago`)
    .replace(/^(\d+)h ago$/, (_, n) => `${n} hour${n === '1' ? '' : 's'} ago`)
    .replace(/^(\d+)d ago$/, (_, n) => `${n} day${n === '1' ? '' : 's'} ago`)
    .replace(/^(\d+)mo ago$/, (_, n) => `${n} month${n === '1' ? '' : 's'} ago`)
    .replace(/^(\d+)y ago$/, (_, n) => `${n} year${n === '1' ? '' : 's'} ago`);
};
const fdur = sec => {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return s + 's';
  const m = Math.round(s / 60); if (m < 60) return m + 'm';
  const h = Math.round(m / 6) / 10; if (h < 24) return h + 'h';
  return Math.round(h / 2.4) / 10 + 'd';
};
const fint = sec => {
  const m = Math.round(sec / 60);
  return m === 1 ? 'every minute' : `every ${m} minutes`;
};

/* ---- value states ---------------------------------------------------------
   A number rendered by this dashboard is one of: a value the database actually
   confirmed, or something we do not know yet. Those two must never look the
   same, because "0 online" and "we have not asked yet" lead a user to opposite
   conclusions. Everything that paints a count goes through here rather than
   defaulting to `|| 0` at the call site. */
const UNKNOWN = '—'; // em dash
const isKnown = (v) => v != null && v !== '';
/** Paint a value into an element, marking unknown values so CSS can dim them. */
function setValue(sel, value, { unknownAs = UNKNOWN } = {}) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return;
  const known = isKnown(value);
  el.textContent = known ? String(value) : unknownAs;
  el.classList.toggle('unknown', !known);
}
function setText(sel, text) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.textContent = text == null ? '' : String(text);
}

/* ---- snackbars ------------------------------------------------------------
   Confirmation for something that already happened, and the place an undo
   lives. Inline .msg regions are still used for anything tied to a specific
   form; these are for actions whose result is a change somewhere else on the
   page, where the user's attention has already moved on.

   A snackbar carrying an undo holds the only copy of what was deleted, so it
   does not auto-dismiss as quickly as a plain acknowledgement, and dismissing
   it is what makes the deletion final. */
const SNACK_MS = 5000;
const SNACK_UNDO_MS = 9000;

function toast(message, opts = {}) {
  const host = $('#snackbars');
  if (!host) return null;
  const el = document.createElement('div');
  el.className = 'snackbar' + (opts.tone ? ' tone-' + opts.tone : '');
  el.innerHTML = `<span class="snack-text">${esc(message)}</span>`;

  let done = false;
  const dismiss = (viaAction) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
    if (!viaAction && opts.onDismiss) opts.onDismiss();
  };

  if (opts.actionLabel && opts.onAction) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opts.actionLabel;
    b.addEventListener('click', () => { dismiss(true); opts.onAction(); });
    el.appendChild(b);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'snack-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML = '&times;';
  close.addEventListener('click', () => dismiss(false));
  el.appendChild(close);

  host.appendChild(el);
  // Only ever three on screen; older ones have been read or are irrelevant.
  while (host.children.length > 3) host.firstElementChild.remove();
  const timer = setTimeout(() => dismiss(false), opts.timeout || (opts.onAction ? SNACK_UNDO_MS : SNACK_MS));
  return el;
}

// encodeURIComponent, not esc: this builds a URL path segment, not HTML text.
// It neutralizes the same breakout characters and is the correct tool for
// that context. Player ids are digit-only by construction (extract.js pulls
// them from /players/(\d+)), so this is defensive rather than load-bearing.
const plink = id => `<a href="https://www.battlemetrics.com/rcon/players/${encodeURIComponent(id)}" target="_blank" rel="noopener">rcon &#8599;</a>`;
// Server URLs need the game slug: /servers/<id> alone does not resolve. We store
// the game when a server is added from search; anything else defaults to arma3.
const slink = (id, game) => `<a href="https://www.battlemetrics.com/servers/${encodeURIComponent(game || 'arma3')}/${encodeURIComponent(id)}" target="_blank" rel="noopener">open &#8599;</a>`;

function pill(score) {
  if (score == null) return '<span class="pill p-na">direct</span>';
  const p = Math.round(score * 100);
  const cls = p >= 95 ? 'p-hi' : p >= 70 ? 'p-mid' : 'p-lo';
  return `<span class="pill ${cls}">${esc(p)}%</span>`;
}
function roleBadge(r) {
  const cls = { admin: 'b-admin', suspect: 'b-suspect', player: 'b-player' }[r] || 'b-other';
  return `<span class="badge ${cls}">${esc(r || 'other')}</span>`;
}
function privBadge(p) {
  return p ? ' <span class="badge b-hidden" title="Profile hidden on BattleMetrics">hidden</span>' : '';
}
function setMsg(target, text, cls) {
  const el = typeof target === 'string' ? $(target) : target;
  if (!el) return;
  el.textContent = text;
  el.className = 'msg ' + (cls || '');
}
function downloadCsv(filename, headers, rows) {
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const csv = [headers.map(q).join(',')].concat(rows.map(r => r.map(q).join(','))).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

/* ---- messaging to the background worker ---------------------------------- */

async function send(msg) {
  try {
    const res = await chrome.runtime.sendMessage(msg);
    return res || {};
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
}

/* ---- shared state ---------------------------------------------------------
   activeJob tracks what this page believes is running, so a PROGRESS
   broadcast (which carries no "kind") can be routed to the right widget. It
   is set right before a job-starting message is sent and cleared when the
   matching DONE broadcast arrives. */

let state = { stats: {}, watch: [], servers: [], running: false };
// Until the first GET_STATE resolves we know nothing, and nothing may be
// painted as a confirmed number. This is what stops "0 snapshots" appearing
// while the snapshot store is still being read.
let stateLoaded = false;
let currentTab = 'search';
let activeJob = null;

async function refreshState() {
  const r = await send({ type: 'GET_STATE' });
  if (!r.error) {
    state = r;
    stateLoaded = true;
    // The worker owns the schedule and knows whether a cycle is in flight, so
    // this page adopts both rather than assuming. Opening the dashboard while a
    // background cycle is already running now shows Polling instead of Stopped.
    adoptMonitor(r.monitor);
    if (r.running && r.runningKind && !activeJob) activeJob = r.runningKind;
    else if (!r.running && activeJob && activeJob !== 'scan' && activeJob !== 'seek') activeJob = null;
    updateHeader();
  }
  return r;
}

function updateHeader() {
  const el = $('#hdr-status');
  if (!el) return;
  if (!stateLoaded) { el.innerHTML = ''; return; }
  const stats = state.stats || {};
  const watched = stats.watched != null ? stats.watched : (state.watch || []).length;
  const servers = stats.servers != null ? stats.servers : (state.servers || []).length;
  el.innerHTML = `<span><b>${esc(watched)}</b> watched</span><span class="sep">&middot;</span>` +
    `<span><b>${esc(servers)}</b> server${servers === 1 ? '' : 's'}</span>`;
}

/* ---- tabs ------------------------------------------------------------------ */

on('#tabs', 'click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const t = b.dataset.tab;
  $$('#tabs button').forEach(x => x.classList.toggle('active', x === b));
  $$('[data-panel]').forEach(p => p.classList.toggle('hide', p.dataset.panel !== t));
  activateTab(t);
});

async function activateTab(tab) {
  currentTab = tab;
  // Route-appropriate width. A table-heavy page earns more of the viewport than
  // a form; the attribute drives it in CSS so the tab strip and page heading
  // stay flush with the content below them.
  const wrap = document.querySelector('.wrap');
  if (wrap) wrap.dataset.route = tab;
  if (tab === 'watch') {
    const r = await refreshState();
    renderWatch(r.watch || []);
  } else if (tab === 'servers') {
    const r = await refreshState();
    renderServers(r.servers || []);
  } else if (tab === 'archive') {
    await loadArchive();
  } else if (tab === 'monitor') {
    await refreshState();
    updateMonStatus();
    await loadOnline();
  }
}

/* ============================ SEARCH ==================================== */

let searchResults = [];

$('#s-go').addEventListener('click', runSearch);
$('#s-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
$('#s-export').addEventListener('click', () => {
  if (!searchResults.length) return;
  downloadCsv('bmfinder-search.csv', ['match', 'name', 'playerId', 'firstSeen', 'lastSeen'],
    searchResults.map(p => [p.score == null ? 'direct' : Math.round(p.score * 100) + '%', p.name, p.id, p.createdAt || '', p.updatedAt || '']));
});

async function runSearch() {
  const query = $('#s-name').value.trim();
  if (!query) return;
  const btn = $('#s-go');
  btn.disabled = true; btn.textContent = 'Searching...';
  setMsg('#s-msg', '', '');
  try {
    const d = await send({ type: 'SEARCH', query, mode: ($('#s-mode') || {}).value || 'name' });
    if (d.error) { setMsg('#s-msg', d.error, 'err'); return; }
    renderSearch(query, d.results || []);
    // An empty result is ambiguous on its own: it can mean no such player, or a
    // results page we do not recognise. Show what the page actually contained.
    if (!(d.results || []).length && d.diag) {
      const g = d.diag.publicSearch || d.diag;
      const bits = [];
      if (g.playerLinkTotal != null) bits.push(`${g.playerLinkTotal} player links on the page`);
      if (g.tableRows) bits.push(`${g.tableRows} table rows`);
      if (g.mentionsNoResults) bits.push('the page says there are no results');
      if (g.mentionsSubscription) bits.push('the page mentions a subscription or upgrade');
      setMsg('#s-msg', 'No matches. Page seen: ' + (bits.join(', ') || 'nothing recognisable') +
        '. Full detail is in the service worker console.', 'err');
      console.log('BMFinder search diagnostic', d.diag);
    }
  } finally {
    btn.disabled = false; btn.textContent = 'Search';
  }
}

function renderSearch(query, results) {
  searchResults = results;
  $('#s-resultcard').classList.remove('hide');
  $('#s-meta').textContent = `- ${results.length} for "${query}"`;
  const tb = $('#s-table tbody');
  tb.innerHTML = '';
  if (!results.length) {
    tb.innerHTML = '<tr><td colspan="6" class="note">No players returned.</td></tr>';
    return;
  }
  for (const p of results) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${pill(p.score)}</td>
      <td class="name"><span class="pii">${esc(p.name) || '<span class="note">(no name)</span>'}</span>${privBadge(p.private)}</td>
      <td class="col-id"><span class="pii">${esc(p.id)}</span></td>
      <td class="note opt-2">${esc(fdate(p.createdAt))}</td>
      <td class="note">${esc(fdate(p.updatedAt)) || '<span class="unknown-text">Unknown</span>'}</td>
      <td>${plink(p.id)} <button class="ghost" data-track="${esc(p.id)}" type="button">Track</button></td>`;
    tb.appendChild(tr);
  }
}

$('#s-table tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-track]');
  if (!btn) return;
  btn.disabled = true; btn.textContent = 'tracking...';
  const r = await send({ type: 'ADD_WATCH', entry: { playerId: btn.dataset.track, role: 'suspect' } });
  btn.textContent = r.error ? 'failed' : 'tracked';
  if (!r.error) {
    await refreshState();
    if (currentTab === 'watch') renderWatch(state.watch || []);
  }
});

/* ============================ ID SCAN ==================================== */

const LOG_MAX = 1000;
const SEC_PER_ID = 3.2;
const SCAN_CAP = 500;

let scanMatches = [];
let scanHits = 0;

$('#c-useseed').addEventListener('click', () => {
  const nums = ($('#c-seed').value.match(/\d+/g)) || [];
  if (nums.length) $('#c-start').value = nums[nums.length - 1];
});

$('#c-clear').addEventListener('click', () => { $('#c-log').innerHTML = ''; });

$('#c-export').addEventListener('click', () => {
  if (!scanMatches.length) return;
  downloadCsv('bmfinder-matches.csv', ['match', 'name', 'playerId', 'firstSeen'],
    scanMatches.map(m => [Math.round(m.score * 100) + '%', m.name, m.id, m.createdAt || '']));
});

function fmtDur(s) {
  if (s < 60) return s.toFixed(0) + 's';
  if (s < 3600) return (s / 60).toFixed(1) + ' min';
  if (s < 86400) return (s / 3600).toFixed(1) + ' hours';
  return (s / 86400).toFixed(1) + ' days';
}

function updateEta() {
  const count = Number($('#c-count').value) || 0;
  const capped = Math.min(Math.max(count, 0), SCAN_CAP);
  if (!capped) { $('#c-eta').textContent = ''; return; }
  let text = `Estimated ~${fmtDur(capped * SEC_PER_ID)} for ${capped} IDs.`;
  if (count > SCAN_CAP) text += ` Anything above ${SCAN_CAP} is clamped when the scan starts.`;
  $('#c-eta').textContent = text;
}
$('#c-count').addEventListener('input', updateEta);
updateEta();

function logLine(cls, text) {
  const log = $('#c-log');
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = text; // textContent: no HTML is ever parsed here, so no escaping is needed.
  log.appendChild(d);
  while (log.childNodes.length > LOG_MAX) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

$('#c-stop').addEventListener('click', () => { send({ type: 'CANCEL' }); });

$('#c-go').addEventListener('click', async () => {
  const target = $('#c-name').value.trim();
  if (!target) { alert('Enter a target name.'); return; }

  let count = Math.max(1, Number($('#c-count').value) || 100);
  const start = Math.max(1, Number($('#c-start').value) || 1);
  const direction = $('#c-dir').value;
  const threshold = (Number($('#c-thresh').value) || 95) / 100;

  $('#c-log').innerHTML = '';
  $('#c-checked').textContent = '0'; $('#c-hits').textContent = '0'; $('#c-last').textContent = '-';
  $('#c-hitcard').classList.add('hide'); $('#c-table tbody').innerHTML = '';
  scanMatches = []; scanHits = 0;

  if (count > SCAN_CAP) {
    count = SCAN_CAP;
    $('#c-count').value = SCAN_CAP;
    updateEta();
    logLine('l-info', `[i] Count clamped to ${SCAN_CAP}. Each ID is a full page load in a real tab, so large ranges are slow and impolite.`);
  }

  $('#c-go').disabled = true; $('#c-stop').disabled = false;
  $('#c-state').textContent = 'scanning...';
  $('#c-state').classList.remove('text-muted');
  activeJob = 'scan';

  const delayMs = Math.max(1, Number(($('#c-delay') || {}).value) || 3.2) * 1000;
  const useCache = !!($('#c-cache') || {}).checked;
  const r = await send({ type: 'SCAN', start, count, direction, target, threshold, delayMs, useCache });
  if (r.error) {
    logLine('l-err', '[!] ' + r.error);
    activeJob = null;
    $('#c-go').disabled = false; $('#c-stop').disabled = true;
    $('#c-state').textContent = 'idle';
    $('#c-state').classList.add('text-muted');
  }
  // Normal completion (including a cancel) is finished by the DONE broadcast,
  // which arrives whether this tab or another extension page started the job.
});

function finishScan(summary) {
  $('#c-go').disabled = false;
  $('#c-stop').disabled = true;
  $('#c-state').textContent = summary.cancelled ? 'stopped' : 'done';
  $('#c-state').classList.add('text-muted');
  const hits = summary.hits ? summary.hits.length : scanHits;
  // Saying how much of the range came from storage makes the cache visible; a
  // silent optimisation looks like nothing happened.
  const saved = summary.cached
    ? ` ${summary.cached} resolved from stored sightings, ${summary.fetched} fetched.`
    : '';
  logLine('l-info', `[done] checked ${summary.done}, ${hits} match(es).${saved} Last ID ${$('#c-last').textContent}.`);
  toast(`Scan finished: ${summary.done} IDs, ${hits} match${hits === 1 ? '' : 'es'}.`, { tone: hits ? 'ok' : undefined });
}

function onScanRow(msg) {
  const pct = Math.round((msg.score || 0) * 100);
  if (msg.match) {
    scanHits++;
    $('#c-hits').textContent = String(scanHits);
    logLine('l-hit', `[MATCH ${pct}%] id ${msg.id} -> ${msg.name}`);
    scanMatches.push({ id: msg.id, name: msg.name, score: msg.score });
    $('#c-hitcard').classList.remove('hide');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${pill(msg.score)}</td><td class="name">${esc(msg.name)}</td>
      <td class="col-id">${esc(msg.id)}</td>
      <td class="note opt-2"></td>
      <td>${plink(msg.id)} <button class="ghost" data-track="${esc(msg.id)}" type="button">Track</button></td>`;
    $('#c-table tbody').appendChild(tr);
  } else if (msg.name == null) {
    if ($('#c-misses').checked) logLine('l-miss', `  id ${msg.id} no such player${msg.cached ? ' (from storage)' : ''}`);
  } else {
    if ($('#c-misses').checked) logLine(msg.cached ? 'l-cache' : '', `  id ${msg.id} ${pct}% ${msg.name}${msg.cached ? ' (from storage)' : ''}`);
  }
}

/* ---- date-targeted ID seek -------------------------------------------------
   The answer to "there are hundreds of millions of profiles". A linear walk
   cannot cross that space; a bisection can, because ids are issued in roughly
   the order players are first seen and every player page states its first-seen
   date. Each probe halves what is left, so about thirty page loads narrows the
   whole space to a workable neighbourhood. */
let seekProbes = [];

on('#k-stop', 'click', () => { send({ type: 'CANCEL' }); });

on('#k-go', 'click', async () => {
  const isoDate = ($('#k-date') || {}).value;
  if (!isoDate) { setMsg('#k-msg', 'Pick a date to seek.', 'err'); return; }
  const low = Math.max(1, Number($('#k-low').value) || 1);
  const high = Math.max(low + 1, Number($('#k-high').value) || 1200000000);

  seekProbes = [];
  $('#k-result').innerHTML = '';
  $('#k-go').disabled = true; $('#k-stop').disabled = false;
  setMsg('#k-msg', 'Probing. Each step halves the remaining range; about 30 page loads.', '');
  activeJob = 'seek';

  const r = await send({ type: 'SEEK_DATE', isoDate, low, high });
  if (r.error) {
    activeJob = null;
    $('#k-go').disabled = false; $('#k-stop').disabled = true;
    setMsg('#k-msg', r.error, 'err');
  }
  // Success is finished by the DONE broadcast, like every other job.
});

function onSeekRow(msg) {
  seekProbes.push(msg);
  setMsg('#k-msg', `Probe ${seekProbes.length}: id ${msg.id} was first seen ${fdate(msg.firstSeen)}.`, '');
}

function finishSeek(summary) {
  activeJob = null;
  $('#k-go').disabled = false; $('#k-stop').disabled = true;
  const box = $('#k-result');
  if (!box) return;

  if (summary.cancelled && !summary.probes.length) { setMsg('#k-msg', 'Stopped.', ''); return; }
  if (!summary.suggestion) {
    setMsg('#k-msg', 'No probe in that range resolved to a player with a first-seen date. Try a wider range.', 'err');
    return;
  }

  /* The bracket is reported, not a single boundary. The key is only
     approximately sorted, so claiming an exact crossing id would be a
     precision the data does not support. */
  const { below, above, span, suggestion } = summary;
  box.innerHTML = `<div class="seek-result">
    <div class="headline">Start scanning near ID ${esc(suggestion.toLocaleString())}</div>
    <div class="seek-bracket">
      ${below ? `<span>Latest ID seen <b>before</b> ${esc(fdate(summary.isoDate))}: <b>${esc(below.id.toLocaleString())}</b> (${esc(fdate(below.firstSeen))})</span>` : '<span>No ID probed was older than that date</span>'}
      ${above ? `<span>Earliest ID seen <b>after</b>: <b>${esc(above.id.toLocaleString())}</b> (${esc(fdate(above.firstSeen))})</span>` : '<span>No ID probed was newer than that date</span>'}
    </div>
    <p class="note">${span != null
      ? `Narrowed to a bracket of ${esc(span.toLocaleString())} IDs in ${esc(summary.done)} page loads.`
      : `Bounded on one side only after ${esc(summary.done)} page loads.`}
      IDs are ordered by when BattleMetrics first saw each player, which is close to but not exactly
      registration order, so treat this as a neighbourhood rather than an exact line.</p>
    <div class="sheet-actions">
      <button type="button" id="k-use">Use as scan start</button>
      ${span != null && span > 1 ? `<button class="secondary" type="button" id="k-narrow">Narrow further</button>` : ''}
    </div>
  </div>`;
  setMsg('#k-msg', '', '');

  on('#k-use', 'click', () => {
    $('#c-start').value = String(suggestion);
    $('#c-dir').value = 'up';
    updateEta();
    $('#c-name').focus();
    toast(`Scan start set to ${suggestion.toLocaleString()}.`, { tone: 'ok' });
  });
  on('#k-narrow', 'click', () => {
    // Re-run bounded by what we just learned, which is where the remaining
    // uncertainty actually is.
    if (below) $('#k-low').value = String(below.id);
    if (above) $('#k-high').value = String(above.id);
    $('#k-go').click();
  });
}

$('#c-table tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-track]');
  if (!btn) return;
  btn.disabled = true; btn.textContent = 'tracking...';
  const r = await send({ type: 'ADD_WATCH', entry: { playerId: btn.dataset.track, role: 'suspect' } });
  btn.textContent = r.error ? 'failed' : 'tracked';
  if (!r.error) {
    await refreshState();
    if (currentTab === 'watch') renderWatch(state.watch || []);
  }
});

/* ============================ WATCHLIST ================================== */

let watchData = [];
let watchBeforeRefresh = null;

/* ---- disclosure panels ----------------------------------------------------
   Add player, Import and Manage tags are secondary workflows: each one is a
   panel opened from the page header rather than a card permanently pushing the
   watched-player table below the fold. Only one is open at a time, because they
   are alternatives to each other, not a stack. */
const PANELS = [
  { btn: '#w-addtoggle', panel: '#w-addpanel', focus: '#w-id' },
  { btn: '#imp-toggle', panel: '#imp-panel' },
  { btn: '#tag-toggle', panel: '#tag-panel', focus: '#tag-name' },
];

function setPanel(panelSel, open) {
  const spec = PANELS.find((p) => p.panel === panelSel);
  if (!spec) return;
  for (const p of PANELS) {
    const wantOpen = p.panel === panelSel && open;
    const el = $(p.panel), btn = $(p.btn);
    if (el) el.classList.toggle('hide', !wantOpen);
    if (btn) { btn.classList.toggle('is-open', wantOpen); btn.setAttribute('aria-expanded', String(wantOpen)); }
  }
  if (open && spec.focus) { const f = $(spec.focus); if (f) f.focus(); }
}
const openPanel = (sel) => setPanel(sel, true);

for (const p of PANELS) {
  on(p.btn, 'click', () => {
    const el = $(p.panel);
    setPanel(p.panel, !!el && el.classList.contains('hide'));
  });
}
on('[data-panel="watch"]', 'click', (e) => {
  const close = e.target.closest('[data-closepanel]');
  if (!close) return;
  setPanel('#' + close.dataset.closepanel, false);
  const spec = PANELS.find((p) => p.panel === '#' + close.dataset.closepanel);
  const btn = spec && $(spec.btn);
  if (btn) btn.focus();
});

on('#w-add', 'click', async () => {
  const id = $('#w-id').value.trim();
  if (!id) { setMsg('#w-msg', 'Enter a player ID.', 'err'); return; }
  const entry = { playerId: id, nickname: $('#w-nick').value.trim(), role: $('#w-role').value, note: $('#w-note').value.trim() };
  const r = await send({ type: 'ADD_WATCH', entry });
  if (r.error) { setMsg('#w-msg', r.error, 'err'); return; }
  setMsg('#w-msg', 'Added.', 'ok');
  // The panel stays open for a second add, so the confirmation goes where the
  // eye ends up: with the table row that just appeared.
  toast(`Now tracking ${entry.nickname || entry.playerId}.`, { tone: 'ok' });
  $('#w-id').value = ''; $('#w-nick').value = ''; $('#w-note').value = '';
  $('#w-id').focus();
  renderWatch(r.watch || []);
  await refreshState();
});

/* ---- tags ---------------------------------------------------------------- */

async function loadTags() {
  const r = await send({ type: 'LIST_TAGS' });
  tagList = (r && r.tags) || [];
  renderTagList();
}

// Favourite is created on first use rather than seeded, so a user who never wants
// it never sees it in their catalogue.
async function ensureFavouriteTag() {
  if (tagList.some((t) => t.name === FAVOURITE)) return;
  tagList = [...tagList, { name: FAVOURITE, colour: '#ffb300' }];
  const r = await send({ type: 'SAVE_TAGS', tags: tagList });
  tagList = (r && r.tags) || tagList;
  renderTagList();
}

function renderTagList() {
  const box = $('#tag-list');
  if (!box) return;
  if (!tagList.length) { box.innerHTML = '<span class="note">No tags yet.</span>'; return; }
  box.innerHTML = tagList.map((t) => `<div class="tag-row">
    <span class="tag-dot" style="background:${esc(safeColour(t.colour))}"></span>
    <span class="grow">${esc(t.name)}</span>
    <input type="color" class="w-60 p-compact" data-tagcolour="${esc(t.name)}" value="${esc(safeColour(t.colour) === 'var(--md-primary)' ? '#7f77dd' : t.colour)}">
    <button class="ghost" data-tagdel="${esc(t.name)}" type="button">delete</button>
  </div>`).join('');
}

on('#tag-add', 'click', async () => {
  const name = $('#tag-name').value.trim();
  if (!name) { setMsg('#tag-msg', 'Give the tag a name.', 'err'); return; }
  if (tagList.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    setMsg('#tag-msg', 'That tag already exists.', 'err'); return;
  }
  tagList = [...tagList, { name, colour: $('#tag-colour').value }];
  const r = await send({ type: 'SAVE_TAGS', tags: tagList });
  tagList = (r && r.tags) || tagList;
  $('#tag-name').value = '';
  setMsg('#tag-msg', `Added "${name}".`, 'ok');
  renderTagList();
  renderWatch((r && r.watch) || watchData);
});

on('#tag-list', 'input', async (e) => {
  const picker = e.target.closest('[data-tagcolour]');
  if (!picker) return;
  tagList = tagList.map((t) => (t.name === picker.dataset.tagcolour ? { ...t, colour: picker.value } : t));
  const r = await send({ type: 'SAVE_TAGS', tags: tagList });
  tagList = (r && r.tags) || tagList;
  renderTagList();
  renderWatch((r && r.watch) || watchData);
});

on('#tag-list', 'click', async (e) => {
  const del = e.target.closest('[data-tagdel]');
  if (!del) return;
  tagList = tagList.filter((t) => t.name !== del.dataset.tagdel);
  const r = await send({ type: 'SAVE_TAGS', tags: tagList });
  tagList = (r && r.tags) || tagList;
  renderTagList();
  renderWatch((r && r.watch) || watchData);
});

/** Small inline picker under the row's tags button. Applies to the whole selection
    when the clicked row is part of it, matching how the role dropdown behaves. */
function openTagPicker(anchor, playerId) {
  document.querySelectorAll('.tag-picker').forEach((p) => p.remove());
  if (!tagList.length) { setMsg('#tag-msg', 'Create a tag first, under Manage tags.', 'err'); openPanel('#tag-panel'); return; }
  const w = watchData.find((x) => String(x.playerId) === String(playerId));
  const have = new Set((w && w.tags) || []);
  const box = document.createElement('div');
  box.className = 'tag-picker card';
  box.innerHTML = tagList.map((t) => `<label class="checkbox-label">
    <input type="checkbox" class="chk" data-tagpick="${esc(t.name)}"${have.has(t.name) ? ' checked' : ''}>
    <span class="tag-chip" style="--tag:${esc(tagColour(t.name))}">${esc(t.name)}</span></label>`).join('');
  anchor.closest('td').appendChild(box);
  box.addEventListener('change', async (ev) => {
    const cb = ev.target.closest('[data-tagpick]');
    if (!cb) return;
    const ids = (watchSel.size && watchSel.has(String(playerId))) ? [...watchSel] : [String(playerId)];
    const r = await send({ type: 'SET_PLAYER_TAGS', playerIds: ids, tag: cb.dataset.tagpick, mode: 'toggle' });
    renderWatch((r && r.watch) || watchData);
    await refreshState();
  });
  const close = (ev) => {
    if (box.contains(ev.target) || anchor.contains(ev.target)) return;
    box.remove();
    document.removeEventListener('click', close, true);
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

async function afterImport(r) {
  if (r.error) { setMsg('#imp-msg', r.error, 'err'); return; }
  const parts = [`Imported ${r.added}`];
  if (r.skipped) parts.push(`${r.skipped} already tracked`);
  setMsg('#imp-msg', parts.join(', ') + '. Use "Refresh player details" to fetch their current names and last seen.', 'ok');
  renderWatch(r.watch || []);
  await refreshState();
  if (r.added) {
    toast(`Imported ${r.added} player${r.added === 1 ? '' : 's'}.`, {
      tone: 'ok',
      actionLabel: 'Fetch their details',
      onAction: () => { setPanel('#imp-panel', false); startWatchlistRefresh(); },
    });
  }
}

on('#imp-bookmarks', 'click', async () => {
  setMsg('#imp-msg', 'Scanning your bookmarks...', '');
  const r = await send({ type: 'IMPORT_BOOKMARKS', role: $('#imp-role').value });
  if (!r.error && !r.found) { setMsg('#imp-msg', 'No BattleMetrics player bookmarks found.', ''); return; }
  await afterImport(r);
});

on('#imp-file', 'click', () => $('#imp-fileinput').click());

on('#imp-fileinput', 'change', async () => {
  const input = $('#imp-fileinput');
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  setMsg('#imp-msg', 'Reading file...', '');
  let text;
  try { text = await file.text(); }
  catch (err) { setMsg('#imp-msg', 'Could not read that file: ' + ((err && err.message) || err), 'err'); return; }

  // Parse the exported bookmarks HTML with DOMParser so entities and structure
  // are handled for us; pull out unique BattleMetrics player links.
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const seen = new Set();
  const entries = [];
  for (const a of doc.querySelectorAll('a[href*="battlemetrics.com"]')) {
    const m = (a.getAttribute('href') || '').match(/players\/(\d+)/i);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    entries.push({ playerId: m[1], nickname: (a.textContent || '').trim() });
  }
  if (!entries.length) { setMsg('#imp-msg', 'No BattleMetrics player links found in that file.', ''); return; }
  const r = await send({ type: 'ADD_WATCH_BATCH', entries, role: $('#imp-role').value });
  await afterImport(r);
});

/** Shared by "Export CSV" in the page header and "Export selected" in the bulk
    bar, so both produce identical columns. */
function exportWatch(rows, filename) {
  if (!rows.length) return;
  downloadCsv(filename,
    ['nickname', 'role', 'tags', 'currentName', 'playerId', 'lastSeenServer', 'lastSeenServerAt', 'lastSeenGlobal', 'firstSeen', 'note', 'nameHistory'],
    rows.map(w => [w.nickname, w.role, (w.tags || []).join(' | '), w.currentName || '', w.playerId,
      w.lastServerName || '', w.lastServerSeen || '', w.lastSeen || '', w.firstSeen || '',
      w.note || '', (w.names || []).join(' | ')]));
}

on('#w-export', 'click', () => exportWatch(watchData, 'bmfinder-watchlist.csv'));

/* ---- watchlist state ---------------------------------------------------- */
let watchSort = { key: null, dir: 1 };  // dir 1 asc, -1 desc
const watchSel = new Set();             // player ids ticked for a bulk role change
let tagList = [];                       // [{name, colour}] catalogue

const FAVOURITE = 'Favourite';
// The colour lands in an inline style, so only a plain hex is ever allowed through.
// Anything else falls back to the theme accent rather than being interpolated.
const safeColour = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : 'var(--md-primary)');
const tagColour = (name) => {
  const t = tagList.find((x) => x.name === name);
  return safeColour(t && t.colour);
};

function tagChips(w) {
  const tags = w.tags || [];
  if (!tags.length) return '';
  const chips = tags.map((name) => {
    const star = name === FAVOURITE ? '<span class="tag-star">&#9733;</span>' : '';
    return `<span class="tag-chip" style="--tag:${esc(tagColour(name))}">${star}${esc(name)}</span>`;
  }).join('');
  return `<span class="tag-chips">${chips}</span>`;
}

const ROLE_OPTS = ['admin', 'suspect', 'player', 'other'];
const ROLE_LABEL = { admin: 'Admin', suspect: 'Suspect', player: 'Player', other: 'Other' };
const ROLE_ORDER = { admin: 0, suspect: 1, player: 2, other: 3 };

function roleSelect(w) {
  const role = w.role || 'other';
  const opts = ROLE_OPTS.map(r => `<option value="${r}"${r === role ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`).join('');
  return `<select class="role-select role-${esc(role)}" data-role-pid="${esc(w.playerId)}">${opts}</select>`;
}

// Our own tracked-server sighting is the authoritative "last seen": it is what the
// poller actually observed. The player page's global figure can be years stale
// while the player is active on one of our servers, so it is only a labelled
// fallback for players we have not caught ourselves.
function seenCell(w) {
  if (w.lastServerSeen) {
    return `<div title="Seen by the poller at ${esc(fdt(w.lastServerSeen))}">${esc(frelLong(w.lastServerSeen))}</div>` +
      `<div class="note">on ${esc(w.lastServerName || 'a tracked server')}</div>`;
  }
  if (w.lastSeen) {
    return `<div title="BattleMetrics global last seen (${esc(fdt(w.lastSeen))}); can lag behind reality">${esc(frelLong(w.lastSeen))}</div>` +
      '<div class="note">BattleMetrics global</div>';
  }
  return '<span class="unknown-text">Never seen</span>';
}

/** "107 known names" reads; "107 names" does not say what kind. */
function namesLabel(n) {
  if (!n) return 'No known names';
  return n === 1 ? '1 known name' : `${n} known names`;
}

function sortedWatch(watch) {
  if (!watchSort.key) return watch.slice();
  const k = watchSort.key, dir = watchSort.dir;
  const val = (w) => {
    if (k === 'nickname') return (w.nickname || w.currentName || '').toLowerCase();
    if (k === 'role') return ROLE_ORDER[w.role] ?? 9;
    if (k === 'names') return (w.names || []).length;
    if (k === 'lastseen') return Date.parse(w.lastServerSeen || w.lastSeen || 0) || 0;
    return 0;
  };
  return watch.slice().sort((a, b) => {
    const va = val(a), vb = val(b);
    return va < vb ? -dir : va > vb ? dir : 0;
  });
}

/* The contextual bulk surface. It only exists while rows are selected, which is
   why it earns the primary container: it is a temporary mode, not part of the
   resting data workspace. */
function updateBulkBar() {
  const el = $('#w-bulk');
  if (!el) return;
  const n = watchSel.size;
  el.classList.toggle('hide', !n);
  if (!n) { el.innerHTML = ''; return; }
  const roleOpts = ROLE_OPTS.map(r => `<option value="${r}">${ROLE_LABEL[r]}</option>`).join('');
  el.innerHTML =
    `<span class="count">${esc(n)} selected</span>` +
    `<select id="w-bulkrole" aria-label="Change role for selected players">` +
      `<option value="">Change role&hellip;</option>${roleOpts}</select>` +
    `<button type="button" data-bulk="tag">Add or remove a tag</button>` +
    `<button type="button" data-bulk="export">Export selected</button>` +
    `<span class="spacer"></span>` +
    `<button type="button" class="danger-item" data-bulk="remove">Remove selected</button>` +
    `<button type="button" data-bulk="clear">Clear selection</button>`;
}

const selectedWatch = () => watchData.filter((w) => watchSel.has(String(w.playerId)));

on('#w-bulk', 'change', async (e) => {
  const sel = e.target.closest('#w-bulkrole');
  if (!sel || !sel.value) return;
  const r = await send({ type: 'SET_ROLE', playerIds: [...watchSel], role: sel.value });
  watchSel.clear();
  renderWatch((r && r.watch) || watchData);
  await refreshState();
});

on('#w-bulk', 'click', async (e) => {
  const btn = e.target.closest('[data-bulk]');
  if (!btn) return;
  const what = btn.dataset.bulk;
  if (what === 'clear') { watchSel.clear(); renderWatch(watchData); return; }
  if (what === 'export') { exportWatch(selectedWatch(), 'bmfinder-watchlist-selection.csv'); return; }
  if (what === 'tag') { openTagPicker(btn, [...watchSel][0]); return; }
  if (what === 'remove') {
    /* No confirmation step. Removal is fully reversible here: the worker hands
       back the watch row and its alias history, and the snackbar holds them
       until it is dismissed. A confirm dialog on a reversible action is a tax
       on the common case for no safety gained. */
    btn.disabled = true;
    const ids = [...watchSel];
    const snapshots = [];
    let last = null;
    for (const id of ids) {
      last = await send({ type: 'REMOVE_WATCH', playerId: id });
      if (last && last.removed) snapshots.push(last.removed);
    }
    watchSel.clear();
    renderWatch((last && last.watch) || watchData);
    await refreshState();
    offerUndoRemoval(snapshots, `Removed ${snapshots.length} player${snapshots.length === 1 ? '' : 's'}.`);
  }
});

/** Shared by single-row and bulk removal so both undo identically. */
function offerUndoRemoval(snapshots, message) {
  const restorable = (snapshots || []).filter(Boolean);
  if (!restorable.length) { toast(message); return; }
  toast(message, {
    actionLabel: 'Undo',
    onAction: async () => {
      let last = null;
      for (const s of restorable) last = await send({ type: 'RESTORE_WATCH', snapshot: s });
      renderWatch((last && last.watch) || watchData);
      await refreshState();
      toast(restorable.length === 1 ? 'Player restored.' : `${restorable.length} players restored.`, { tone: 'ok' });
    },
  });
}

function renderWatch(watch) {
  watchData = watch;
  const present = new Set(watch.map(w => String(w.playerId)));
  for (const id of [...watchSel]) if (!present.has(id)) watchSel.delete(id);
  updateBulkBar();
  closeRowMenu();

  const tb = $('#w-table tbody');
  if (!tb) return;
  tb.innerHTML = '';
  if (!watch.length) {
    tb.innerHTML = `<tr><td colspan="6"><div class="empty">
      <span class="empty-title">Nobody tracked yet</span>
      <p>Add a player by ID, import your BattleMetrics bookmarks, or track someone
        straight from a search result.</p></div></td></tr>`;
    return;
  }
  let first = true;
  for (const w of sortedWatch(watch)) {
    const names = w.names || [];
    const nick = esc(w.nickname);
    const live = esc(w.currentName);
    const fav = (w.tags || []).includes(FAVOURITE);
    const tr = document.createElement('tr');
    tr.dataset.pid = String(w.playerId);
    // Roving tabindex: only the first row is a tab stop, arrows move from there.
    tr.setAttribute('tabindex', first ? '0' : '-1');
    first = false;
    if (watchSel.has(String(w.playerId))) tr.classList.add('sel');
    // .pii marks the in-game name and id so the obfuscate toggle can blur them for
    // screenshots without re-rendering. The nickname is your own label, not blurred.
    // The note lives here rather than in a column of its own: most rows have no
    // note, and a column that is empty most of the time is wasted width.
    tr.innerHTML = `
      <td class="identity">
        <div class="nick${nick ? '' : ' none'}" data-pid="${esc(w.playerId)}" title="Double-click to rename"><button class="row-toggle" data-expand="${esc(w.playerId)}" type="button" title="Show previous names" aria-label="Show previous names for ${esc(w.nickname || w.playerId)}">&#9656;</button>${nick || '(no nickname)'}${tagChips(w)}</div>
        <div class="live"><span class="tag">in game</span><span class="pii">${live || '<span class="unknown-text">Not checked yet</span>'}</span>${privBadge(w.private)}</div>
        ${w.note ? `<div class="has-note" title="${esc(w.note)}">${esc(w.note)}</div>` : ''}
      </td>
      <td>${roleSelect(w)}</td>
      <td class="col-id opt-1"><span class="pii">${esc(w.playerId)}</span></td>
      <td>${seenCell(w)}</td>
      <td class="opt-2"><button class="ghost" data-expand="${esc(w.playerId)}" type="button"
        title="${esc(names.join('\n'))}">${esc(namesLabel(names.length))}</button></td>
      <td><div class="row-actions">
        <button class="fav-btn" data-fav="${esc(w.playerId)}" type="button" aria-pressed="${fav}"
          title="${fav ? 'Remove from favourites' : 'Mark as favourite'}"
          aria-label="${fav ? 'Remove from favourites' : 'Mark as favourite'}">${fav ? '&#9733;' : '&#9734;'}</button>
        <span class="menu-wrap"><button class="menu-btn" data-menu="${esc(w.playerId)}" type="button"
          aria-haspopup="menu" aria-expanded="false"
          aria-label="More actions for ${esc(w.nickname || w.playerId)}">&#8942;</button></span>
      </div></td>`;
    tb.appendChild(tr);
  }
}

/* ---- row overflow menu ----------------------------------------------------
   Six buttons per row made every row look equally urgent and made Remove as
   easy to hit as Rename. Only the two controls that actually get used per
   session stay visible; everything else lives one click deeper, with the
   destructive action separated and last. */
let openMenu = null;      // {el, trigger}

function closeRowMenu(restoreFocus) {
  if (!openMenu) return;
  const { el, trigger } = openMenu;
  openMenu = null;
  el.remove();
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }
  document.removeEventListener('click', onDocClickForMenu, true);
}

function onDocClickForMenu(ev) {
  if (!openMenu) return;
  if (openMenu.el.contains(ev.target) || openMenu.trigger.contains(ev.target)) return;
  closeRowMenu();
}

function openRowMenu(trigger, playerId) {
  const already = openMenu && openMenu.trigger === trigger;
  closeRowMenu();
  if (already) return;

  const w = watchData.find((x) => String(x.playerId) === String(playerId));
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  const item = (action, label, cls) =>
    `<button type="button" role="menuitem" data-act="${action}" data-pid="${esc(playerId)}"${cls ? ` class="${cls}"` : ''}>${label}</button>`;
  menu.innerHTML =
    item('details', 'View player details') +
    item('rename', 'Rename') +
    item('tags', 'Manage tags') +
    item('names', 'View known names') +
    item('note', w && w.note ? 'Edit note' : 'Add note') +
    item('copy', 'Copy player ID') +
    item('rcon', 'Open in BattleMetrics RCON') +
    '<div class="sep"></div>' +
    item('remove', 'Remove from watchlist', 'danger-item');

  trigger.parentElement.appendChild(menu);
  trigger.setAttribute('aria-expanded', 'true');
  openMenu = { el: menu, trigger };

  // Near the bottom of the window the menu would be clipped, so it flips above
  // its trigger instead. Measured after insertion, since the height depends on
  // how many items this row actually has.
  const box = menu.getBoundingClientRect();
  if (box.bottom > window.innerHeight - 8) menu.classList.add('up');

  const items = () => [...menu.querySelectorAll('button')];
  items()[0].focus();
  menu.addEventListener('keydown', (ev) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (ev.key === 'Escape') { ev.preventDefault(); closeRowMenu(true); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (ev.key === 'Home') { ev.preventDefault(); list[0].focus(); }
    else if (ev.key === 'End') { ev.preventDefault(); list[list.length - 1].focus(); }
    else if (ev.key === 'Tab') { closeRowMenu(); }
  });
  setTimeout(() => document.addEventListener('click', onDocClickForMenu, true), 0);
}

async function runRowAction(act, playerId, trigger) {
  const tr = document.querySelector(`#w-table tbody tr[data-pid="${CSS.escape(String(playerId))}"]`);
  const w = watchData.find((x) => String(x.playerId) === String(playerId));
  closeRowMenu();
  if (act === 'rename') { if (tr) startRename(tr, playerId); return; }
  if (act === 'tags') { if (trigger) openTagPicker(trigger, playerId); return; }
  if (act === 'names') {
    const btn = tr && tr.querySelector('[data-expand]');
    if (btn && !btn.classList.contains('open')) toggleHistory(btn);
    return;
  }
  // The detail sheet already has a proper note editor, so this opens that rather
  // than a blocking window.prompt that cannot be styled, cancelled cleanly, or
  // used comfortably for more than a few words.
  if (act === 'note') {
    await openPlayerSheet(playerId);
    const ta = document.querySelector('#sheet-note');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    return;
  }
  if (act === 'details') { openPlayerSheet(playerId); return; }
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(String(playerId)); toast(`Copied player ID ${playerId}.`, { tone: 'ok' }); }
    catch { toast('Could not reach the clipboard.', { tone: 'err' }); }
    return;
  }
  if (act === 'rcon') {
    window.open(`https://www.battlemetrics.com/rcon/players/${encodeURIComponent(playerId)}`, '_blank', 'noopener');
    return;
  }
  if (act === 'remove') {
    const label = (w && w.nickname) || (w && w.currentName) || playerId;
    const r = await send({ type: 'REMOVE_WATCH', playerId });
    if (r.error) { toast(r.error, { tone: 'err' }); return; }
    renderWatch(r.watch || []);
    await refreshState();
    offerUndoRemoval([r.removed], `Removed ${label}.`);
  }
}

/* ---- player detail side sheet ---------------------------------------------
   The one place that shows everything known about a player at once, including
   the stored sighting history. db.playerSessions() has existed in the worker
   since the archive was built and nothing had ever asked for it; this is what
   it was for.

   A sheet rather than a dialog because the answer to "who is this" is usually
   checked against the row it came from, and a sheet leaves the table visible. */
let sheetRestoreFocus = null;

function closeSheet() {
  const mount = $('#sheet-mount');
  if (!mount || !mount.firstChild) return;
  mount.innerHTML = '';
  document.removeEventListener('keydown', sheetKeydown, true);
  if (sheetRestoreFocus && document.contains(sheetRestoreFocus)) sheetRestoreFocus.focus();
  sheetRestoreFocus = null;
}

function sheetKeydown(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); return; }
  if (e.key !== 'Tab') return;
  // Focus stays inside the sheet while it is open.
  const sheet = $('#sheet-mount .sheet');
  if (!sheet) return;
  const focusable = [...sheet.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

async function openPlayerSheet(playerId) {
  const mount = $('#sheet-mount');
  const w = watchData.find((x) => String(x.playerId) === String(playerId));
  if (!mount || !w) return;
  sheetRestoreFocus = document.activeElement;

  const names = w.names || [];
  const fav = (w.tags || []).includes(FAVOURITE);
  const kv = (k, v) => `<div class="sheet-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;

  mount.innerHTML = `
    <div class="sheet-scrim" data-sheetclose></div>
    <aside class="sheet" role="dialog" aria-modal="true" aria-label="Player details">
      <div class="sheet-head">
        <div class="grow">
          <h2>${esc(w.nickname) || `<span class="unknown-text">No nickname</span>`}</h2>
          <div class="sheet-sub"><span class="pii">${esc(w.currentName) || 'Current name not checked yet'}</span>
            ${w.private ? ' &middot; hidden profile' : ''}</div>
        </div>
        <button class="sheet-close" type="button" data-sheetclose aria-label="Close player details">&times;</button>
      </div>

      <div class="sheet-actions">
        <button class="secondary" type="button" data-sheetact="fav">${fav ? '&#9733; Favourited' : '&#9734; Favourite'}</button>
        <button class="secondary" type="button" data-sheetact="rename">Rename</button>
        <button class="secondary" type="button" data-sheetact="copy">Copy ID</button>
        <button class="secondary" type="button" data-sheetact="rcon">Open in RCON</button>
      </div>

      <div class="sheet-section">
        <h3>Identity</h3>
        ${kv('Player ID', `<span class="pii">${esc(w.playerId)}</span>`)}
        ${kv('Role', roleBadge(w.role))}
        ${kv('Tags', (w.tags || []).length ? tagChips(w) : '<span class="unknown-text">None</span>')}
        ${kv('Last seen', w.lastServerSeen
          ? `${esc(frelLong(w.lastServerSeen))}<div class="note">on ${esc(w.lastServerName || 'a tracked server')}</div>`
          : w.lastSeen ? `${esc(frelLong(w.lastSeen))}<div class="note">BattleMetrics global</div>`
          : '<span class="unknown-text">Never seen</span>')}
        ${kv('First seen', w.firstSeen ? esc(fdate(w.firstSeen)) : '<span class="unknown-text">Unknown</span>')}
      </div>

      <div class="sheet-section">
        <h3>Note</h3>
        <textarea id="sheet-note" rows="3" placeholder="Why are you tracking this player?">${esc(w.note || '')}</textarea>
        <div class="sheet-actions"><button type="button" data-sheetact="savenote">Save note</button></div>
      </div>

      <div class="sheet-section">
        <h3>${esc(namesLabel(names.length))}</h3>
        ${names.length
          ? `<div class="hist-names">${names.map(n => `<span class="hist-name${n === w.currentName ? ' current' : ''} pii">${esc(n)}</span>`).join('')}</div>`
          : '<p class="note m-0">Nothing recorded yet. "Refresh player details" collects alias history.</p>'}
      </div>

      <div class="sheet-section">
        <h3>Sightings on your tracked servers</h3>
        <div id="sheet-sessions"><p class="note m-0">Reading stored history&hellip;</p></div>
      </div>
    </aside>`;

  document.addEventListener('keydown', sheetKeydown, true);
  const closeBtn = mount.querySelector('.sheet-close');
  if (closeBtn) closeBtn.focus();

  /* Sightings come from the presence store, which is what the poller has been
     filling in all along. It is a rolling window, so an empty list means "not
     within the retention window", not "never here". */
  const r = await send({ type: 'PLAYER_SESSIONS', playerId });
  const box = $('#sheet-sessions');
  if (!box) return;
  const sessions = (r && r.sessions) || [];
  if (r && r.error) { box.innerHTML = `<p class="note err m-0">${esc(r.error)}</p>`; return; }
  box.innerHTML = sessions.length
    ? sessions.slice(0, 40).map((s) => `<div class="session-row">
        <span class="when" title="${esc(fdt(s.pollTs || s.ts))}">${esc(frel(s.pollTs || s.ts))}</span>
        <span class="where">${esc(s.serverName || s.serverId || 'a tracked server')}</span>
      </div>`).join('') +
      (sessions.length > 40 ? `<p class="note">Showing the 40 most recent of ${esc(sessions.length)}.</p>` : '')
    : '<p class="note m-0">No sightings inside the stored history window.</p>';
}

on('#sheet-mount', 'click', async (e) => {
  if (e.target.closest('[data-sheetclose]')) { closeSheet(); return; }
  const act = e.target.closest('[data-sheetact]');
  if (!act) return;
  const sheet = e.target.closest('.sheet');
  const pid = sheetPlayerId();
  if (!pid) return;
  const what = act.dataset.sheetact;
  if (what === 'savenote') {
    const w = watchData.find((x) => String(x.playerId) === String(pid));
    const ta = sheet.querySelector('#sheet-note');
    const r = await send({ type: 'ADD_WATCH', entry: { playerId: pid, nickname: (w && w.nickname) || '', role: (w && w.role) || 'other', note: ta.value.trim() } });
    renderWatch((r && r.watch) || watchData);
    toast('Note saved.', { tone: 'ok' });
    return;
  }
  if (what === 'fav') {
    await ensureFavouriteTag();
    const r = await send({ type: 'SET_PLAYER_TAGS', playerIds: [pid], tag: FAVOURITE, mode: 'toggle' });
    renderWatch((r && r.watch) || watchData);
    await refreshState();
    openPlayerSheet(pid);
    return;
  }
  if (what === 'rename') { closeSheet(); runRowAction('rename', pid, null); return; }
  if (what === 'copy') { runRowAction('copy', pid, null); return; }
  if (what === 'rcon') { runRowAction('rcon', pid, null); return; }
});

/** The sheet renders one player at a time; its id is the one in the ID row. */
function sheetPlayerId() {
  const el = document.querySelector('#sheet-mount .sheet .sheet-kv .v .pii');
  return el ? el.textContent.trim() : null;
}

/* ---- table keyboard navigation --------------------------------------------
   Roving tabindex: one row is in the tab order, arrows move within the list.
   Without this a 200 row watchlist is 200 tab stops before the next control,
   which makes the page effectively unusable from the keyboard. */
function focusRow(tr) {
  if (!tr) return;
  $$('#w-table tbody tr').forEach((r) => r.setAttribute('tabindex', '-1'));
  tr.setAttribute('tabindex', '0');
  tr.focus();
}

on('#w-table tbody', 'keydown', (e) => {
  // The overflow menu runs its own key handling while open.
  if (openMenu) return;
  const tr = e.target.closest('tr[data-pid]');
  if (!tr) return;
  const rows = [...document.querySelectorAll('#w-table tbody tr[data-pid]')];
  const i = rows.indexOf(tr);
  const inField = e.target.matches('input, textarea, select');

  if (e.key === 'ArrowDown' && !inField) { e.preventDefault(); focusRow(rows[Math.min(i + 1, rows.length - 1)]); }
  else if (e.key === 'ArrowUp' && !inField) { e.preventDefault(); focusRow(rows[Math.max(i - 1, 0)]); }
  else if (e.key === 'Home' && !inField) { e.preventDefault(); focusRow(rows[0]); }
  else if (e.key === 'End' && !inField) { e.preventDefault(); focusRow(rows[rows.length - 1]); }
  else if (e.key === 'Enter' && e.target === tr) { e.preventDefault(); openPlayerSheet(tr.dataset.pid); }
  else if (e.key === ' ' && e.target === tr) {
    e.preventDefault();
    const id = tr.dataset.pid;
    if (watchSel.has(id)) watchSel.delete(id); else watchSel.add(id);
    tr.classList.toggle('sel');
    updateBulkBar();
  } else if ((e.key === 'm' || e.key === 'M') && e.target === tr) {
    e.preventDefault();
    const btn = tr.querySelector('[data-menu]');
    if (btn) openRowMenu(btn, btn.dataset.menu);
  }
});

/* Inline + bulk role change. Changing any selected row's dropdown applies to the
   whole selection, so you set many at once without re-adding anyone. */
on('#w-table tbody', 'change', async (e) => {
  const sel = e.target.closest('.role-select[data-role-pid]');
  if (!sel) return;
  const pid = sel.dataset.rolePid;
  const ids = (watchSel.size && watchSel.has(pid)) ? [...watchSel] : [pid];
  const r = await send({ type: 'SET_ROLE', playerIds: ids, role: sel.value });
  watchSel.clear();
  renderWatch((r && r.watch) || watchData);
  await refreshState();
});

on('#w-table tbody', 'dblclick', (e) => {
  const nick = e.target.closest('.nick[data-pid]');
  if (nick) startRename(nick.closest('tr'), nick.dataset.pid);
});

function applySort(th) {
  const key = th.dataset.sort;
  if (watchSort.key === key) watchSort.dir *= -1;
  else { watchSort = { key, dir: 1 }; }
  $$('#w-table thead th').forEach(h => {
    h.classList.remove('sort-asc', 'sort-desc');
    h.removeAttribute('aria-sort');
  });
  th.classList.add(watchSort.dir === 1 ? 'sort-asc' : 'sort-desc');
  th.setAttribute('aria-sort', watchSort.dir === 1 ? 'ascending' : 'descending');
  renderWatch(watchData);
}

on('#w-table thead', 'click', (e) => {
  const th = e.target.closest('th.sortable[data-sort]');
  if (th) applySort(th);
});
// Sortable headers are focusable, so they have to answer the keyboard too.
on('#w-table thead', 'keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const th = e.target.closest('th.sortable[data-sort]');
  if (!th) return;
  e.preventDefault();
  applySort(th);
});

/* Expandable alias history. When several players share a name, their previous
   names are usually what tells you which one you actually want, so this opens
   under the row rather than sending you off to BattleMetrics. */
async function toggleHistory(btn) {
  const tr = btn.closest('tr');
  const playerId = btn.dataset.expand;
  const existing = tr.nextElementSibling;
  if (existing && existing.classList.contains('detail')) {
    existing.remove();
    btn.classList.remove('open');
    return;
  }
  btn.classList.add('open');

  const detail = document.createElement('tr');
  detail.className = 'detail';
  const cols = tr.children.length;
  detail.innerHTML = `<td colspan="${cols}"><div class="hist-title">Previous names</div>
    <div class="hist-names"><span class="hist-empty">Loading...</span></div></td>`;
  tr.after(detail);

  const w = watchData.find((x) => String(x.playerId) === String(playerId));
  let names = (w && w.names) || [];

  // Nothing stored yet, so fetch the identifiers page once, on demand.
  if (!names.length) {
    const r = await send({ type: 'FETCH_IDENTIFIERS', playerId });
    if (r && r.watch) { watchData = r.watch; }
    names = (r && r.names) || [];
    if (r && r.error) {
      detail.querySelector('.hist-names').innerHTML = `<span class="hist-empty">${esc(r.error)}</span>`;
      return;
    }
  }

  const current = (w && w.currentName) || '';
  const box = detail.querySelector('.hist-names');
  box.innerHTML = names.length
    ? names.map(n => `<span class="hist-name${n === current ? ' current' : ''} pii">${esc(n)}</span>`).join('')
    : '<span class="hist-empty">No previous names recorded. A watchlist refresh collects them.</span>';
}

function startRename(tr, playerId) {
  const w = watchData.find((x) => String(x.playerId) === String(playerId));
  if (!w) return;
  const nickDiv = tr.querySelector('.identity .nick');
  if (nickDiv) {
    const inp = document.createElement('input');
    inp.className = 'rename-input';
    inp.setAttribute('data-renameinput', '');
    inp.value = w.nickname || '';
    inp.placeholder = 'Nickname';
    nickDiv.replaceWith(inp);
    inp.focus();
    inp.select();
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') commitRename(tr, playerId);
      else if (ev.key === 'Escape') renderWatch(watchData);
    });
  }
  const actions = tr.querySelector('td:last-child');
  if (actions) {
    actions.innerHTML =
      `<button class="ghost" data-save="${esc(playerId)}" type="button">save</button> ` +
      `<button class="ghost" data-cancel type="button">cancel</button>`;
  }
}

async function commitRename(tr, playerId) {
  const w = watchData.find((x) => String(x.playerId) === String(playerId));
  if (!w) return renderWatch(watchData);
  const inp = tr.querySelector('[data-renameinput]');
  const nickname = inp ? inp.value.trim() : w.nickname;
  // ADD_WATCH upserts: it overwrites nickname/role/note and preserves the live
  // name and name history, so a rename never triggers a network lookup.
  const r = await send({ type: 'ADD_WATCH', entry: { playerId, nickname, role: w.role, note: w.note || '' } });
  renderWatch((r && r.watch) || watchData);
  await refreshState();
}

on('#w-table tbody', 'click', async (e) => {
  // Ctrl / Cmd + click on a row (not on a control) toggles it into the bulk set.
  if ((e.ctrlKey || e.metaKey) && !e.target.closest('button, a, select, input')) {
    const tr = e.target.closest('tr[data-pid]');
    if (tr) {
      const id = tr.dataset.pid;
      if (watchSel.has(id)) watchSel.delete(id); else watchSel.add(id);
      tr.classList.toggle('sel');
      updateBulkBar();
    }
    return;
  }
  // Favourite is just a built-in tag, so the star toggles it like any other.
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    fav.disabled = true;
    await ensureFavouriteTag();
    const ids = (watchSel.size && watchSel.has(fav.dataset.fav)) ? [...watchSel] : [fav.dataset.fav];
    const r = await send({ type: 'SET_PLAYER_TAGS', playerIds: ids, tag: FAVOURITE, mode: 'toggle' });
    renderWatch((r && r.watch) || watchData);
    await refreshState();
    return;
  }
  const menuBtn = e.target.closest('[data-menu]');
  if (menuBtn) { openRowMenu(menuBtn, menuBtn.dataset.menu); return; }
  const act = e.target.closest('[data-act]');
  if (act) { runRowAction(act.dataset.act, act.dataset.pid, act); return; }
  const expand = e.target.closest('[data-expand]');
  if (expand) { toggleHistory(expand); return; }
  // Injected by startRename, so these only exist while a row is being edited.
  const save = e.target.closest('[data-save]');
  if (save) { commitRename(save.closest('tr'), save.dataset.save); return; }
  if (e.target.closest('[data-cancel]')) { renderWatch(watchData); return; }
});

// Escape closes the open row menu from anywhere, and returns focus to the
// control that opened it rather than dropping the user at the top of the page.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openMenu) closeRowMenu(true);
});

/* One label, set in exactly one place. This button used to be titled "Sync
   watchlist" in the markup and then rewrote itself to "Refresh names" the first
   time it ran, so the same control had two different names depending on whether
   you had used it yet. */
const WATCH_REFRESH_LABEL = 'Refresh player details';

async function startWatchlistRefresh() {
  if (activeJob) return;
  watchBeforeRefresh = new Map((state.watch || []).map(w => [String(w.playerId), w.currentName]));
  activeJob = 'watchlist';
  const btn = $('#w-refresh');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  setText('#w-refreshinfo', '');
  const r = await send({ type: 'REFRESH_WATCHLIST' });
  if (r.error) {
    activeJob = null;
    watchBeforeRefresh = null;
    if (btn) { btn.disabled = false; btn.textContent = WATCH_REFRESH_LABEL; }
    const info = $('#w-refreshinfo');
    if (info) info.innerHTML = `<span class="err">${esc(r.error)}</span>`;
  }
}
on('#w-refresh', 'click', startWatchlistRefresh);

async function finishWatchlistRefresh(summary) {
  const btn = $('#w-refresh');
  if (btn) { btn.disabled = false; btn.textContent = WATCH_REFRESH_LABEL; }
  clearProgressPanel();

  const r = await refreshState();
  const watch = r.watch || [];

  const info = $('#w-refreshinfo');
  if (watchBeforeRefresh && info) {
    const changes = [];
    for (const w of watch) {
      const prev = watchBeforeRefresh.get(String(w.playerId));
      if (prev !== undefined && prev !== w.currentName) {
        changes.push({ label: w.nickname || w.playerId, previous: prev, current: w.currentName });
      }
    }
    watchBeforeRefresh = null;
    if (changes.length) {
      info.innerHTML = `<span class="err">${esc(changes.length)} name change(s):</span> ` +
        changes.map(c => `<b>${esc(c.label)}</b>: "${esc(c.previous)}" to "${esc(c.current)}"`).join(' &middot; ');
    } else if (summary.failures && summary.failures.length) {
      info.innerHTML = `<span class="err">${esc(summary.failures.length)} lookup error(s): ${esc(summary.failures.join(', '))}</span>`;
    } else {
      info.textContent = `Checked ${summary.done}, no name changes.`;
    }
  }

  renderWatch(watch);
}

/* ============================ SERVERS ===================================== */

let serversData = [];

/* Segmented mode: finding a server by name and adding one by ID are two ways to
   do the same job, so they are alternatives rather than two stacked forms
   separated by a rule. */
on('#sv-mode', 'click', (e) => {
  const b = e.target.closest('button[data-svmode]');
  if (!b) return;
  const mode = b.dataset.svmode;
  $$('#sv-mode button').forEach((x) => {
    const active = x === b;
    x.classList.toggle('active', active);
    x.setAttribute('aria-selected', String(active));
  });
  const search = $('#sv-pane-search'), add = $('#sv-pane-add');
  if (search) search.classList.toggle('hide', mode !== 'search');
  if (add) add.classList.toggle('hide', mode !== 'add');
  setMsg('#sv-msg', '', '');
});

on('#sv-search', 'click', async () => {
  const q = $('#sv-q').value.trim();
  if (!q) return;
  const box = $('#sv-searchresults');
  box.innerHTML = '<span class="note">Searching, this opens a background tab...</span>';
  const d = await send({ type: 'SERVER_SEARCH', query: q, game: 'arma3' });
  if (d.error) { box.innerHTML = `<span class="err">${esc(d.error)}</span>`; return; }
  const rows = d.results || [];
  if (!rows.length) { box.innerHTML = '<span class="note">No servers found.</span>'; return; }
  box.innerHTML = rows.map((s) => `<div class="srvcard flex gap-10 items-center">
    <div class="grow"><b>${esc(s.name)}</b><div class="note">ID ${esc(s.id)}</div></div>
    <button class="secondary small" data-addsv="${esc(s.id)}" data-nm="${esc(s.name)}" data-game="${esc(s.game || 'arma3')}" type="button">Track</button>
  </div>`).join('');
  box.querySelectorAll('[data-addsv]').forEach((b) => {
    b.addEventListener('click', async () => {
      b.disabled = true;
      const r = await send({ type: 'ADD_SERVER',
        entry: { serverId: b.dataset.addsv, nickname: b.dataset.nm, note: '', game: b.dataset.game } });
      b.textContent = r && r.error ? 'failed' : 'tracked';
      if (r && r.servers) renderServers(r.servers);
    });
  });
});

on('#sv-add', 'click', async () => {
  const id = $('#sv-id').value.trim();
  if (!id) { setMsg('#sv-msg', 'Enter a server ID.', 'err'); return; }
  const entry = { serverId: id, nickname: $('#sv-nick').value.trim(), note: $('#sv-note').value.trim() };
  const r = await send({ type: 'ADD_SERVER', entry });
  if (r.error) { setMsg('#sv-msg', r.error, 'err'); return; }
  setMsg('#sv-msg', 'Added.', 'ok');
  $('#sv-id').value = ''; $('#sv-nick').value = ''; $('#sv-note').value = '';
  renderServers(r.servers || []);
  await refreshState();
});

function renderServers(servers) {
  serversData = servers;
  const tb = $('#sv-table tbody');
  if (!tb) return;
  tb.innerHTML = '';
  if (!servers.length) {
    tb.innerHTML = `<tr><td colspan="6"><div class="empty">
      <span class="empty-title">No servers tracked yet</span>
      <p>Search for a server by name above, then track it. The Monitor polls
        everything listed here.</p></div></td></tr>`;
    return;
  }
  for (const s of servers) {
    // A server added but never polled has no name and no tallies yet. That is
    // "not checked", not "zero polls with a blank name", so it says so.
    const polled = (s.totalPolls || 0) > 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><b>${esc(s.nickname) || '<span class="note">(none)</span>'}</b></td>
      <td class="name">${esc(s.name) || '<span class="unknown-text">Not read yet</span>'}</td>
      <td class="col-id opt-1">${esc(s.serverId)}</td>
      <td class="name note opt-2">${esc(s.note) || ''}</td>
      <td class="note tnum">${polled
        ? `${esc(s.totalPolls)} <span title="Polls in which a tracked admin was online">(${esc(s.adminPolls || 0)} with an admin)</span>`
        : '<span class="unknown-text">Never polled</span>'}</td>
      <td>${slink(s.serverId, s.game)} <button class="ghost" data-rm="${esc(s.serverId)}" type="button">Remove</button></td>`;
    tb.appendChild(tr);
  }
}

on('#sv-table tbody', 'click', async (e) => {
  const btn = e.target.closest('[data-rm]');
  if (!btn) return;
  btn.disabled = true;
  const r = await send({ type: 'REMOVE_SERVER', serverId: btn.dataset.rm });
  if (r.error) { btn.disabled = false; return; }
  renderServers(r.servers || []);
  await refreshState();
});

/* ============================ MONITOR ====================================== */

/* pollState is the user's INTENT (is monitoring meant to be on), not what is
   happening at this instant. Whether a request is in flight right now is
   activeJob === 'servers', and the outcome of the last one is lastPollResult.
   Keeping those three apart is what makes an honest status possible: "running
   but the last cycle half failed" is a real situation and used to render
   identically to "running and healthy".

   None of these are owned by this page any more. The schedule is a
   chrome.alarms alarm in the service worker and the mode is persisted in the
   database, so closing this tab no longer stops monitoring. What lives here is
   a cache of that state for rendering, refreshed from the worker. */
let pollState = 'stopped';   // stopped | running | paused
let pollIntervalSec = 300;
let lastPollResult = null;   // {ok, failed, total, failures[], at, cancelled}
let pollProgress = null;     // {done, total, current} while a cycle is in flight
let corrRows = [];
let lastOnline = null;       // most recent ONLINE read, kept during a poll

/** Pull the worker's monitor state into this page's cache. */
function adoptMonitor(monitor) {
  if (!monitor) return;
  pollState = monitor.mode || 'stopped';
  pollIntervalSec = Number(monitor.intervalSec) || 300;
  lastPollResult = monitor.lastResult || null;
  const sel = $('#mon-interval');
  if (sel && String(pollIntervalSec) !== sel.value) sel.value = String(pollIntervalSec);
}

/** Send intent to the worker, then adopt whatever it decided. */
async function setMonitorMode(patch) {
  const r = await send({ type: 'MONITOR_SET', patch });
  if (r.error) { toast(r.error, { tone: 'err' }); return null; }
  adoptMonitor(r.monitor);
  return r.monitor;
}

/* Stale threshold. A poll a little late is not a problem; the schedule has no
   hard deadline and one slow page load pushes the next cycle out. Data is
   called stale once it is older than TWO full intervals, which means a whole
   expected cycle was missed and the next one is already late. Anything sooner
   would paint a healthy poller amber most of the time. */
const STALE_FACTOR = 2;

const pollAgeSec = () => {
  const at = (state.stats || {}).lastPoll;
  return at ? (Date.now() - Date.parse(at)) / 1000 : null;
};
const isStale = () => {
  const age = pollAgeSec();
  return age != null && age > pollIntervalSec * STALE_FACTOR;
};

/** The single source of truth for the Monitor's operational state. Everything
    on the page reads from this rather than deciding for itself. */
function monitorStatus() {
  const stats = state.stats || {};
  const inFlight = activeJob === 'servers';
  const everPolled = !!stats.lastPoll;

  if (inFlight) {
    if (!everPolled) return { key: 'starting', label: 'Starting', sub: 'Waiting for the first successful poll' };
    const p = pollProgress;
    return {
      key: 'polling', label: 'Polling',
      sub: p && p.total ? `server ${Math.min(p.done + 1, p.total)} of ${p.total}` : '',
    };
  }
  const res = lastPollResult;
  if (res && !res.cancelled && res.total > 0) {
    if (res.ok === 0) return { key: 'failed', label: 'Poll failed', sub: `${res.total} server${res.total === 1 ? '' : 's'} unreachable` };
    if (res.failed > 0) return { key: 'degraded', label: 'Partly reached', sub: `${res.ok} of ${res.total} servers` };
  }
  if (pollState === 'stopped') return { key: 'stopped', label: 'Stopped', sub: everPolled ? '' : 'No poll recorded yet' };
  if (pollState === 'paused') return { key: 'paused', label: 'Paused', sub: 'No cycles scheduled' };
  if (!everPolled) return { key: 'starting', label: 'Starting', sub: 'Waiting for the first successful poll' };
  if (isStale()) return { key: 'stale', label: 'Stale', sub: `expected ${fint(pollIntervalSec)}` };
  return { key: 'running', label: 'Running', sub: fint(pollIntervalSec) };
}

/** Controls follow the state: nothing is offered that cannot be done, and
    nothing that is already happening is offered a second time. */
function updatePollButtons() {
  const st = monitorStatus();
  const inFlight = activeJob === 'servers';
  const t = $('#mon-toggle');
  if (t) {
    t.textContent = pollState === 'running' ? 'Pause polling'
      : pollState === 'paused' ? 'Resume polling' : 'Start monitoring';
    // Pausing mid-cycle is safe: it only stops the NEXT cycle being scheduled,
    // and the cycle in flight is allowed to finish and store its results.
    t.disabled = false;
  }
  const stop = $('#mon-stop');
  if (stop) {
    stop.disabled = pollState === 'stopped' && !inFlight;
    stop.textContent = inFlight && pollState === 'stopped' ? 'Cancel poll' : 'Stop monitoring';
  }
  const poll = $('#mon-poll');
  if (poll) {
    poll.disabled = !!activeJob;
    poll.textContent = inFlight ? 'Polling…'
      : (st.key === 'failed' || st.key === 'degraded') ? 'Retry poll' : 'Poll all servers now';
  }
}

/* The numbers that answer "is anything happening" get set large at the top of the
   Monitor tab, so the tab has one focal point instead of five equal cards.
   Every value here is either something the database confirmed or an em dash.
   None of them fall back to zero. */
function updateMetrics(onlineList) {
  const stats = state.stats || {};
  const loaded = stateLoaded;
  if (onlineList) lastOnline = onlineList;
  const list = onlineList || lastOnline;

  setValue('#m-watched', loaded ? stats.watched : null);
  setValue('#m-servers', loaded ? stats.servers : null);
  setValue('#m-snapshots', loaded ? stats.snapshots : null);

  /* "Watched online" is only a real number once at least one server has
     actually been read. Before that, zero would be a claim we cannot make.

     The roster rows come straight from storage as {id, name}: there is no
     `watched` flag on them, so this has to be resolved against the watchlist
     here. Filtering on p.watched (as this used to) silently counted zero every
     time, because that property only exists on the copy loadOnline() builds for
     rendering. A player is counted once even if they somehow appear on two
     servers in the same cycle. */
  const polled = (list || []).filter((s) => s.pollTs);
  const known = polled.length > 0;
  const watchedIds = new Set((state.watch || []).map((w) => String(w.playerId)));
  const seen = new Set();
  for (const s of polled) {
    for (const p of s.roster || []) {
      const id = String(p.id);
      if (watchedIds.has(id)) seen.add(id);
    }
  }
  setValue('#m-online', known ? seen.size : null);
  setText('#m-online-sub', known
    ? `across ${polled.length} polled server${polled.length === 1 ? '' : 's'}`
    : 'No poll recorded yet');

  /* Freshness reads as an interpretation, not a raw duration. Healthy shows how
     long ago the last SUCCESSFUL poll was; stale shows how overdue it is, which
     is the number that tells you whether to act. */
  const card = $('#m-lastpoll-card');
  const age = pollAgeSec();
  if (card) card.classList.remove('warn');
  if (age == null) {
    setValue('#m-lastpoll', null);
    setText('#m-lastpoll-lbl', 'Last successful poll');
    setText('#m-lastpoll-sub', 'No snapshot yet');
  } else if (isStale() && pollState !== 'stopped') {
    const overdue = age - pollIntervalSec;
    if (card) card.classList.add('warn');
    setValue('#m-lastpoll', fdur(overdue) + ' overdue');
    setText('#m-lastpoll-lbl', 'Data is stale');
    setText('#m-lastpoll-sub', `Last success ${frel(stats.lastPoll)}, expected ${fint(pollIntervalSec)}`);
  } else {
    setValue('#m-lastpoll', frel(stats.lastPoll));
    setText('#m-lastpoll-lbl', 'Last successful poll');
    setText('#m-lastpoll-sub', pollState === 'running' ? `Polling ${fint(pollIntervalSec)}` : '');
  }
  paintPollState();
}

/** Paints the one status chip, and the tab badges. */
function paintPollState() {
  const el = $('#mon-state');
  const txt = $('#mon-state-text');
  const sub = $('#mon-state-sub');
  if (el && txt) {
    const st = monitorStatus();
    el.className = 'status status-' + st.key;
    txt.textContent = st.label;
    if (sub) sub.textContent = st.sub || '';
  }

  // Tab badges: counts belong next to the thing they describe.
  const stats = state.stats || {};
  const badge = (tab, n) => {
    const b = document.querySelector(`#tabs button[data-tab="${tab}"]`);
    if (!b) return;
    let c = b.querySelector('.count');
    if (!n) { if (c) c.remove(); return; }
    if (!c) { c = document.createElement('span'); c.className = 'count'; b.appendChild(c); }
    c.textContent = String(n);
  };
  badge('watch', stats.watched || 0);
  badge('servers', stats.servers || 0);
}

/* Supporting facts for the poller panel. These deliberately do NOT restate the
   state: the chip in the page header owns that. Replaces the old one-line
   "stopped - 833 snapshots - last 7/27/2026, 14:02:11". */
function updateMonStatus() {
  const stats = state.stats || {};
  const box = $('#mon-status');
  if (box) {
    const res = lastPollResult;
    const reached = res && res.total
      ? { text: `${res.ok} of ${res.total}`, cls: res.failed ? 'warn' : '' }
      : { text: UNKNOWN, cls: 'unknown' };
    const fact = (label, value, cls) =>
      `<div class="fact"><span class="fact-label">${label}</span>` +
      `<span class="fact-value${cls ? ' ' + cls : ''}">${value}</span></div>`;
    box.innerHTML =
      fact('Stored snapshots', stateLoaded ? esc(stats.snapshots) : UNKNOWN, stateLoaded ? '' : 'unknown') +
      fact('Last successful poll', stats.lastPoll
        ? `<span title="${esc(fdt(stats.lastPoll))}">${esc(frelLong(stats.lastPoll))}</span>`
        : 'Never', stats.lastPoll ? '' : 'unknown') +
      fact('Schedule', pollState === 'running' ? esc('Polling ' + fint(pollIntervalSec))
        : pollState === 'paused' ? 'Paused' : 'Not scheduled', pollState === 'running' ? '' : 'unknown') +
      fact('Servers reached last cycle', esc(reached.text), reached.cls);
  }
  updatePollButtons();
  updateMetrics();
}

/* ---- polling progress ------------------------------------------------------
   The server list is known before the first request goes out (the job is built
   from the tracked-server table), so this is determinate from the start. It
   falls back to an indeterminate sweep only when a total has not arrived yet. */
function setProgressPanel({ title, done, total, current, failed, unit = 'Server' }) {
  const box = $('#mon-progress');
  if (!box) return;
  const known = total > 0;
  const pct = known ? Math.round((done / total) * 100) : 0;
  box.innerHTML = `<div class="progress-panel">
    <p class="p-title">${esc(title)}</p>
    <span class="p-step">${known ? `${esc(unit)} ${esc(Math.min(done + 1, total))} of ${esc(total)}` : 'Preparing…'}</span>
    <span class="p-current">${current ? esc(current) : '&nbsp;'}</span>
    <div class="progress-track${known ? '' : ' indeterminate'}">
      <div class="progress-fill" style="width:${known ? pct : 35}%"></div>
    </div>
    <div class="p-tally">${known ? `${esc(done)} done &middot; ${esc(total - done)} remaining` : ''}` +
    `${failed ? ` &middot; <span class="bad">${esc(failed)} failed</span>` : ''}</div>
  </div>`;
}
function clearProgressPanel() {
  const box = $('#mon-progress');
  if (box) box.innerHTML = '';
  pollProgress = null;
}

async function startPollServers(auto) {
  if (activeJob) {
    if (!auto) setMsg('#mon-pollmsg', 'Another job is already running. Wait for it to finish.', 'err');
    return;
  }
  activeJob = 'servers';
  // The previous cycle's outcome stops being the current truth the moment a new
  // cycle starts, but the DATA it produced stays on screen until replaced.
  lastPollResult = null;
  pollProgress = null;
  setText('#mon-pollmsg', '');
  setProgressPanel({ title: 'Polling tracked servers', done: 0, total: (state.servers || []).length, current: '' });
  updateMonStatus();
  const r = await send({ type: 'POLL_SERVERS' });
  if (r.error) {
    activeJob = null;
    clearProgressPanel();
    setMsg('#mon-pollmsg', r.error, 'err');
    updateMonStatus();
  }
}
on('#mon-poll', 'click', () => startPollServers(false));

async function finishPoll(summary) {
  const total = summary.total || 0;
  const failed = (summary.failures || []).length;
  lastPollResult = {
    total, failed, ok: Math.max(0, (summary.done || 0) - failed),
    failures: summary.failures || [], cancelled: !!summary.cancelled, at: Date.now(),
  };
  clearProgressPanel();
  await refreshState();
  await loadOnline();
  updateMonStatus();

  const res = lastPollResult;
  const box = $('#mon-pollmsg');
  if (!box) return;
  if (summary.cancelled) {
    setMsg(box, `Cancelled after ${summary.done} of ${total} server(s). What was read is stored.`, '');
  } else if (res.ok === 0 && total) {
    // A failure is not an empty result, so it never renders as zeroes: the last
    // known roster stays on screen and the servers that failed are named.
    box.innerHTML = `<span class="err">No server could be read.</span> Last known figures are still shown above. ` +
      `<a href="#" data-showfail="1">Which servers?</a>`;
    box.className = 'msg';
  } else if (failed) {
    box.innerHTML = `Reached ${esc(res.ok)} of ${esc(total)} servers. ` +
      `<span class="err">${esc(failed)} failed</span>, showing their last known figures. ` +
      `<a href="#" data-showfail="1">Which servers?</a>`;
    box.className = 'msg';
  } else {
    setMsg(box, `Reached all ${total} server${total === 1 ? '' : 's'}.`, 'ok');
  }
}

on('#mon-pollmsg', 'click', (e) => {
  const link = e.target.closest('[data-showfail]');
  if (!link) return;
  e.preventDefault();
  const names = (lastPollResult && lastPollResult.failures) || [];
  const box = $('#mon-pollmsg');
  if (box) box.innerHTML = `<span class="err">Could not read:</span> ${esc(names.join(', ') || 'unknown')}. ` +
    `A server usually fails because the page did not finish loading in time; retrying often clears it.`;
});

// One toggle cycles Start -> Pause -> Resume; Stop ends it. Each one is a
// message to the worker, which owns the alarm.
on('#mon-toggle', 'click', async () => {
  if (pollState === 'stopped') {
    const intervalSec = Math.max(60, Number($('#mon-interval').value) || 300);
    const m = await setMonitorMode({ mode: 'running', intervalSec });
    if (!m) return;
    updateMonStatus();
    // The first cycle runs immediately rather than waiting a whole interval.
    startPollServers(true);
    toast(`Monitoring started, polling ${fint(pollIntervalSec)}. It keeps running with this tab closed.`, { tone: 'ok' });
  } else if (pollState === 'running') {
    await setMonitorMode({ mode: 'paused' });
    setText('#mon-pollmsg', 'Paused. Any cycle in flight finishes; no new ones are scheduled until you resume.');
    updateMonStatus();
  } else {
    await setMonitorMode({ mode: 'running' });
    setText('#mon-pollmsg', 'Monitoring resumed.');
    updateMonStatus();
    toast('Monitoring resumed.', { tone: 'ok' });
  }
});
/* Stop is not destructive and is not styled as if it were: it ends the schedule
   and cancels the cycle in flight. Nothing stored is touched. */
on('#mon-stop', 'click', async () => {
  const wasPolling = activeJob === 'servers';
  await setMonitorMode({ mode: 'stopped' });
  send({ type: 'CANCEL' });
  setText('#mon-pollmsg', wasPolling
    ? 'Stopping. The page being read right now finishes, then the cycle ends. Stored data is kept.'
    : 'Monitoring stopped. Stored data is kept.');
  updateMonStatus();
});
/* Changing the interval while running has to re-arm the alarm, or the picker
   would silently disagree with the schedule actually in force. */
on('#mon-interval', 'change', async () => {
  const intervalSec = Math.max(60, Number($('#mon-interval').value) || 300);
  if (pollState === 'stopped') { pollIntervalSec = intervalSec; updateMonStatus(); return; }
  await setMonitorMode({ intervalSec });
  updateMonStatus();
  toast(`Now polling ${fint(intervalSec)}.`);
});
// Reads what is already stored on this device rather than contacting anything,
// which is fast but used to look broken because nothing acknowledged the click.
on('#mon-refreshonline', 'click', async () => {
  const btn = $('#mon-refreshonline');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Reloading…';
  try {
    await refreshState();
    const online = await loadOnline();
    updateMonStatus();
    const polled = online.filter((s) => s.pollTs);
    const players = polled.reduce((n, s) => n + (s.roster || []).length, 0);
    // Same as updateMetrics: stored roster rows carry no `watched` flag, so the
    // watchlist is what decides who counts.
    const ids = new Set((state.watch || []).map((w) => String(w.playerId)));
    const watched = new Set();
    for (const s of polled) for (const p of s.roster || []) if (ids.has(String(p.id))) watched.add(String(p.id));
    setMsg('#mon-pollmsg', polled.length
      ? `Reloaded from storage: ${players} online across ${polled.length} polled server(s), ${watched.size} watched.`
      : 'Reloaded, but no server has been polled yet. Use "Poll all servers now" to take the first snapshot.',
      polled.length ? 'ok' : '');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

async function loadOnline() {
  const box = $('#mon-online');
  if (!box) return [];
  const r = await send({ type: 'ONLINE' });
  if (r.error) { box.innerHTML = `<p class="note err">${esc(r.error)}</p>`; return []; }
  const online = r.online || [];
  if (!online.length) {
    box.innerHTML = `<div class="empty"><span class="empty-title">No servers tracked</span>
      <p>Add a server on the Servers tab and the Monitor will start recording who is on it.</p></div>`;
    updateMetrics([]);
    return [];
  }

  const watchMap = new Map((state.watch || []).map(w => [String(w.playerId), w]));
  const polling = activeJob === 'servers';
  /* The question this section answers is "are any watched players online, and
     where". So watched players come first in an expressive row, and the ordinary
     roster becomes a quiet collapsed text list rather than hundreds of pills that
     look like buttons but do nothing.

     One surface, rows divided by a tonal rule. A row only gains a background
     once it is expanded, so the nesting is a state rather than permanent
     decoration. */
  box.innerHTML = online.map((srv) => {
    const roster = (srv.roster || []).map((p) => {
      const w = watchMap.get(String(p.id));
      return { id: p.id, name: p.name, watched: !!w, nickname: w && w.nickname, role: w && w.role };
    });
    const watched = roster.filter(p => p.watched);
    const others = roster.filter(p => !p.watched);
    /* A server with no stored poll timestamp has never been read. Its roster is
       empty because we have not looked, not because nobody is playing, so it
       must never render as a confirmed "0 online". */
    const everPolled = !!srv.pollTs;

    const facts = !everPolled
      ? `<span class="unknown">${polling ? 'Checking…' : 'No result yet'}</span>`
      : `<span class="live-count">${esc(srv.players)}</span> online` +
        `<span class="sep">&middot;</span>` +
        (watched.length
          ? `<span class="has-watched">${esc(watched.length)} watched player${watched.length === 1 ? '' : 's'} here</span>`
          : 'No watched players detected');

    const when = everPolled
      ? `<span class="srv-when" title="${esc(fdt(srv.pollTs))}">Updated ${esc(frelLong(srv.pollTs))}</span>`
      : '';

    const watchedHtml = watched.length
      ? `<div class="watched-list">${watched.map(p => `<div class="watched-row">
          <span class="who">${esc(p.nickname || p.name)}</span>
          ${p.nickname && p.name && p.nickname !== p.name ? `<span class="note pii">${esc(p.name)}</span>` : ''}
          ${roleBadge(p.role)}
          <span class="meta">${plink(p.id)}</span>
        </div>`).join('')}</div>`
      : '';

    const othersHtml = others.length ? `<div class="roster-more">
        <div class="roster hide" data-rosterlist="${esc(srv.serverId)}">
          ${others.map(p => `<span class="roster-name pii" title="${esc(p.name)}">${esc(p.name)}</span>`).join('')}
        </div>
      </div>` : '';

    const disclosure = others.length
      ? `<button class="disclosure" data-roster="${esc(srv.serverId)}" type="button"
          aria-expanded="false">Show ${esc(others.length)} other player${others.length === 1 ? '' : 's'}</button>`
      : '';

    return `<div class="srv-row" data-srvrow="${esc(srv.serverId)}">
      <div class="srv-line">
        <div class="srv-main">
          <div class="srv-head"><span class="srv-title">${esc(srv.nickname || srv.name || srv.serverId)}</span></div>
          <div class="srv-facts">${facts}</div>
          ${when}
        </div>
        ${disclosure}
      </div>
      ${watchedHtml}
      ${othersHtml}
    </div>`;
  }).join('');

  // Progressive disclosure: the full roster stays collapsed until asked for.
  box.querySelectorAll('[data-roster]').forEach((b) => {
    b.addEventListener('click', () => {
      const list = box.querySelector(`[data-rosterlist="${b.dataset.roster}"]`);
      if (!list) return;
      const nowHidden = list.classList.toggle('hide');
      b.setAttribute('aria-expanded', String(!nowHidden));
      const row = b.closest('.srv-row');
      if (row) row.classList.toggle('open', !nowHidden);
      b.textContent = nowHidden
        ? b.textContent.replace(/^Hide/, 'Show')
        : b.textContent.replace(/^Show/, 'Hide');
    });
  });
  updateMetrics(online);
  return online;
}

$('#btn-clearpolls').addEventListener('click', async () => {
  const btn = $('#btn-clearpolls');
  // Two step rather than a browser confirm(): the first click states the
  // consequence, the second carries it out. Destructive, so it should take intent.
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Click again to clear';
    setMsg('#clear-msg', 'This cannot be undone. Click again within 5 seconds to confirm.', 'err');
    setTimeout(() => {
      if (btn.dataset.armed === '1') {
        btn.dataset.armed = '';
        btn.textContent = 'Clear stored polls';
        setMsg('#clear-msg', '', '');
      }
    }, 5000);
    return;
  }
  btn.dataset.armed = '';
  btn.textContent = 'Clear stored polls';
  btn.disabled = true;
  const r = await send({ type: 'CLEAR_POLLS' });
  btn.disabled = false;
  if (r.error) { setMsg('#clear-msg', r.error, 'err'); return; }
  const c = (r && r.cleared) || {};
  setMsg('#clear-msg', `Cleared ${c.snapshots || 0} snapshots and ${c.presence || 0} presence rows.`, 'ok');
  // No undo offered here on purpose: clearPolls empties the stores outright and
  // there is no snapshot to hand back, which is why this one keeps its confirm.
  toast(`Cleared ${c.snapshots || 0} stored snapshots.`, { tone: 'ok' });
  lastPollResult = null;
  await refreshState();
  updateMonStatus();
  await loadOnline();
  if (currentTab === 'archive') await loadArchive();
});

/* ============================ ARCHIVE ====================================== */

let archiveData = [];

async function loadArchive() {
  const box = $('#arch-list');
  box.innerHTML = '<p class="note">Reading stored snapshots...</p>';
  const r = await send({
    type: 'ARCHIVE',
    serverId: $('#arch-server').value || null,
    limit: Number($('#arch-limit').value) || 60,
  });
  if (r.error) { box.innerHTML = `<p class="note err">${esc(r.error)}</p>`; return; }

  // Keep the server picker in step with what is actually tracked.
  const sel = $('#arch-server');
  const chosen = sel.value;
  sel.innerHTML = '<option value="">All tracked servers</option>' +
    (r.servers || []).map(s => `<option value="${esc(s.serverId)}">${esc(s.nickname || s.name || s.serverId)}</option>`).join('');
  sel.value = chosen;

  archiveData = r.snapshots || [];
  $('#arch-stats').textContent = `${archiveData.length} shown, ${r.rows || 0} presence rows stored`;
  renderArchive();
}

function renderArchive() {
  const box = $('#arch-list');
  const needle = $('#arch-filter').value.trim().toLowerCase();
  const watchedOnly = $('#arch-watched').checked;

  const snaps = archiveData
    .map((s) => {
      let roster = s.roster || [];
      if (watchedOnly) roster = roster.filter(p => p.watched);
      if (needle) roster = roster.filter(p =>
        String(p.name || '').toLowerCase().includes(needle) || String(p.id).includes(needle));
      return { ...s, shown: roster };
    })
    // A filtered snapshot with nobody left is noise, so drop it.
    .filter((s) => (!needle && !watchedOnly) || s.shown.length);

  if (!snaps.length) {
    box.innerHTML = '<p class="note">Nothing matches. Snapshots appear here once the poller has run.</p>';
    return;
  }

  box.innerHTML = snaps.map((s) => {
    const chips = s.shown.map(p => p.watched
      ? `<span class="chip w">${esc(p.nickname || p.name)} ${roleBadge(p.role)}</span>`
      : `<span class="chip pii">${esc(p.name)}</span>`).join('');
    const hidden = (s.roster || []).length - s.shown.length;
    return `<div class="arch-snap">
      <div class="arch-head">
        <span class="arch-when">${esc(fdt(s.pollTs))}</span>
        <span class="arch-server">${esc(s.serverName || s.serverId)}</span>
        ${s.adminHere ? '<span class="badge b-admin">admin on</span>' : ''}
        <span class="arch-count">${esc(s.shown.length)}${hidden > 0 ? ` of ${esc((s.roster || []).length)}` : ''} shown</span>
      </div>
      <div class="arch-players">${chips || '<span class="note">nobody</span>'}</div>
    </div>`;
  }).join('');
}

$('#arch-refresh').addEventListener('click', loadArchive);
$('#arch-server').addEventListener('change', loadArchive);
$('#arch-limit').addEventListener('change', loadArchive);
$('#arch-filter').addEventListener('input', renderArchive);
$('#arch-watched').addEventListener('change', renderArchive);

$('#arch-export').addEventListener('click', () => {
  if (!archiveData.length) return;
  const rows = [];
  for (const s of archiveData) {
    for (const p of s.roster || []) {
      rows.push([s.pollTs, s.serverName || s.serverId, s.serverId, p.id, p.name,
        p.watched ? (p.nickname || '') : '', p.role || '']);
    }
  }
  downloadCsv('bmfinder-archive.csv',
    ['pollTs', 'server', 'serverId', 'playerId', 'playerName', 'nickname', 'role'], rows);
});

$('#mon-correxport').addEventListener('click', () => {
  if (!corrRows.length) return;
  downloadCsv('bmfinder-correlation.csv', ['absentPct', 'name', 'playerId', 'sightings', 'absent', 'present', 'lastSeen', 'servers'],
    corrRows.map(c => [Math.round(c.absentRatio * 100) + '%', c.name, c.playerId, c.total, c.absent, c.present, c.lastSeen || '', (c.servers || []).join(' ')]));
});

$('#mon-corr').addEventListener('click', loadCorr);

async function loadCorr() {
  const btn = $('#mon-corr');
  btn.disabled = true; btn.textContent = 'Computing...';
  try {
    const min = Math.max(1, Number($('#mon-min').value) || 3);
    const r = await send({ type: 'CORRELATION', min });
    if (r.error) { $('#mon-corrmeta').innerHTML = `<span class="err">${esc(r.error)}</span>`; return; }

    corrRows = r.candidates || [];
    const m = r.meta || {};
    let metaHtml = `${esc(m.totalPolls || 0)} polls across ${esc(m.serversWithAdminActivity || 0)} server(s) with admin activity, ` +
      `admins seen in ${esc(m.adminPolls || 0)} of them, ${esc(m.admins || 0)} admin(s) tracked.`;
    if (!m.adminPolls) {
      metaHtml += ' <span class="err">No poll has caught an admin online yet, so these numbers do not mean anything. Keep collecting and check your admins have role "admin".</span>';
    }
    $('#mon-corrmeta').innerHTML = metaHtml;

    const tb = $('#mon-corrtable tbody');
    tb.innerHTML = '';
    if (!corrRows.length) { tb.innerHTML = '<tr><td colspan="8" class="note">No candidates yet.</td></tr>'; return; }
    for (const c of corrRows) {
      const pct = Math.round(c.absentRatio * 100);
      const cls = pct >= 90 ? 'p-hi' : pct >= 70 ? 'p-mid' : 'p-lo';
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><span class="pill ${cls}">${esc(pct)}%</span></td><td class="name"><span class="pii">${esc(c.name)}</span></td>
        <td class="col-id opt-1"><span class="pii">${esc(c.playerId)}</span></td>
        <td>${esc(c.total)}</td><td class="opt-2">${esc(c.absent)}</td><td class="opt-2">${esc(c.present)}</td>
        <td class="note">${esc(fdate(c.lastSeen)) || '<span class="unknown-text">Unknown</span>'}</td>
        <td>${plink(c.playerId)} <button class="ghost" data-track="${esc(c.playerId)}" data-name="${esc(c.name)}" type="button">Track</button></td>`;
      tb.appendChild(tr);
    }
  } finally {
    btn.disabled = false; btn.textContent = 'Compute';
  }
}

$('#mon-corrtable tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-track]');
  if (!btn) return;
  btn.disabled = true; btn.textContent = 'tracking...';
  const entry = { playerId: btn.dataset.track, role: 'suspect', nickname: btn.dataset.name || '' };
  const r = await send({ type: 'ADD_WATCH', entry });
  btn.textContent = r.error ? 'failed' : 'tracked';
  if (!r.error) {
    await refreshState();
    if (currentTab === 'watch') renderWatch(state.watch || []);
  }
});

/* ---- backup ----------------------------------------------------------------
   dashboard.html has no dedicated message element next to the backup
   buttons, so one is created on first use rather than editing the markup. */

function ensureBackupMsgEl() {
  let el = document.getElementById('backup-msg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'backup-msg';
    el.className = 'msg';
    $('#file-import').insertAdjacentElement('afterend', el);
  }
  return el;
}

$('#btn-export').addEventListener('click', async () => {
  const box = ensureBackupMsgEl();
  setMsg(box, 'Exporting...', '');
  const r = await send({ type: 'EXPORT' });
  if (r.error) { setMsg(box, 'Export failed: ' + r.error, 'err'); return; }
  const blob = new Blob([JSON.stringify(r.json, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bmfinder-backup.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  setMsg(box, 'Exported bmfinder-backup.json.', 'ok');
});

$('#btn-import').addEventListener('click', () => $('#file-import').click());

$('#file-import').addEventListener('change', async () => {
  const input = $('#file-import');
  const file = input.files[0];
  input.value = '';
  if (!file) return;

  const box = ensureBackupMsgEl();
  setMsg(box, 'Reading file...', '');

  let text;
  try {
    text = await file.text();
  } catch (err) {
    setMsg(box, 'Could not read that file: ' + ((err && err.message) || err), 'err');
    return;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    setMsg(box, 'That file is not valid JSON: ' + ((err && err.message) || err), 'err');
    return;
  }

  const r = await send({ type: 'IMPORT', json });
  if (r.error) { setMsg(box, 'Import failed: ' + r.error, 'err'); return; }

  setMsg(box, 'Import complete.', 'ok');
  toast('Backup imported.', { tone: 'ok' });
  await refreshState();
  renderWatch(state.watch || []);
  renderServers(state.servers || []);
  updateMonStatus();
  await loadOnline();
});

/* ============================ BROADCASTS ==================================== */

function onProgress(msg) {
  if (activeJob === 'scan') {
    setText('#c-checked', msg.done);
    setText('#c-last', msg.current != null ? msg.current : '-');
    return;
  }
  if (activeJob === 'seek') {
    // A bisection has a hard probe ceiling, so this is a countdown of the
    // budget, not a percentage of a range being covered.
    setMsg('#k-msg', `Probe ${msg.done} of at most ${msg.total}${msg.current ? ' — ' + msg.current : ''}.`, '');
    return;
  }
  const watchJob = activeJob === 'watchlist';
  pollProgress = { done: msg.done, total: msg.total, current: msg.current };
  setProgressPanel({
    title: watchJob ? 'Refreshing player details' : 'Polling tracked servers',
    unit: watchJob ? 'Player' : 'Server',
    done: msg.done, total: msg.total, current: msg.current,
  });
  // A watchlist refresh is started from the Watchlist tab, where the Monitor's
  // progress panel is not visible, so it reports there as well.
  if (watchJob) setText('#w-refreshinfo', `Checking ${msg.done + 1} of ${msg.total}${msg.current ? ': ' + msg.current : ''}`);
  // The header chip counts through the cycle with it.
  paintPollState();
}

function onDone(msg) {
  const summary = (msg && msg.summary) || {};
  activeJob = null;
  if (summary.kind === 'scan') finishScan(summary);
  else if (summary.kind === 'seek') finishSeek(summary);
  else if (summary.kind === 'watchlist') finishWatchlistRefresh(summary);
  else if (summary.kind === 'servers') finishPoll(summary);
}

function onExtractWarning(msg) {
  const el = $('#extract-warning');
  const failures = Array.isArray(msg.failures) ? msg.failures : [];
  el.innerHTML = `<b>BattleMetrics page reading is broken.</b> The page at ` +
    `<code>${esc(msg.url)}</code> did not come back with what this extension expected: ` +
    `${esc(failures.join(', ') || 'unknown failure')}. BattleMetrics most likely changed its page ` +
    `layout, and the selectors in this extension need to be updated before player and server data ` +
    `can be trusted again.`;
  el.classList.remove('hide');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'PROGRESS') onProgress(msg);
  else if (msg.type === 'SCAN_ROW') onScanRow(msg);
  else if (msg.type === 'SEEK_ROW') onSeekRow(msg);
  else if (msg.type === 'DONE') onDone(msg);
  else if (msg.type === 'EXTRACT_WARNING') onExtractWarning(msg);
});

/* ============================ THEME ==================================== */
/* Appearance lives in chrome.storage.local, not the worker: it is pure UI state,
   the popup reads the same key, and reading it locally avoids a first-paint flash
   waiting on a worker round trip. */

const THEME_DEFAULT = { seed: 'violet', mode: 'system' };
let themePref = { ...THEME_DEFAULT };

function paintTheme() {
  applyTheme(document.documentElement, { seed: themePref.seed, mode: resolveMode(themePref.mode) });
  $$('#mode-seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === themePref.mode));
  $$('#swatches .swatch').forEach((b) => b.classList.toggle('active', b.dataset.seed === themePref.seed));
}

function buildSwatches() {
  const box = $('#swatches');
  box.innerHTML = '';
  for (const s of SEEDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.seed = s.id;
    b.title = s.name;
    b.setAttribute('aria-label', s.name);
    b.style.background = seedSwatch(s);
    b.addEventListener('click', () => setTheme({ seed: s.id }));
    box.appendChild(b);
  }
}

async function setTheme(patch) {
  themePref = { ...themePref, ...patch };
  paintTheme();
  try { await chrome.storage.local.set({ bmfTheme: themePref }); } catch { /* storage full or denied */ }
}

async function initTheme() {
  try {
    const got = await chrome.storage.local.get('bmfTheme');
    if (got && got.bmfTheme) themePref = { ...THEME_DEFAULT, ...got.bmfTheme };
  } catch { /* first run */ }
  buildSwatches();
  paintTheme();

  $('#mode-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setTheme({ mode: b.dataset.mode });
  });

  const panel = $('#settings-panel');
  const scrim = $('#scrim');
  const close = () => { panel.classList.add('hide'); scrim.classList.add('hide'); };
  $('#btn-settings').addEventListener('click', () => {
    const open = panel.classList.contains('hide');
    panel.classList.toggle('hide', !open);
    scrim.classList.toggle('hide', !open);
  });
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // Follow the OS when the mode is set to System.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)')
      .addEventListener('change', () => { if (themePref.mode === 'system') paintTheme(); });
  }
}

/* ============================ OBFUSCATE =============================== */
/* Blur in-game names and player ids for screenshots. Marked elements carry the
   .pii class; toggling body.obf-on blurs them all with no re-render, and they
   reveal on hover so the page stays usable. */

async function initObfuscate() {
  let on = false;
  try { const g = await chrome.storage.local.get('bmfObf'); on = !!(g && g.bmfObf); } catch { /* first run */ }
  const apply = () => {
    document.body.classList.toggle('obf-on', on);
    const btn = $('#btn-obfuscate');
    if (btn) { btn.setAttribute('aria-pressed', String(on)); btn.classList.toggle('active', on); }
  };
  apply();
  $('#btn-obfuscate').addEventListener('click', async () => {
    on = !on;
    apply();
    try { await chrome.storage.local.set({ bmfObf: on }); } catch { /* ignore */ }
  });
}

/* ============================ INIT ==================================== */

initTheme();
initObfuscate();
loadTags();
refreshState().then(updateMonStatus);

/* Two jobs for this tick, both only while the Monitor is on screen.

   Freshness is a function of elapsed time, so with nothing else happening the
   page would sit on a "2m ago" that had silently become an hour old.

   And now that cycles run in the service worker, they complete whether or not
   this page is open. A DONE broadcast reaches an open page, but a page opened
   later, or one that missed a broadcast while the worker was asleep, needs to
   notice on its own. These are IndexedDB reads through the worker: no network. */
setInterval(async () => {
  if (currentTab !== 'monitor' || activeJob) return;
  const before = (state.stats || {}).lastPoll;
  await refreshState();
  if ((state.stats || {}).lastPoll !== before) await loadOnline();
  updateMonStatus();
}, 30000);
