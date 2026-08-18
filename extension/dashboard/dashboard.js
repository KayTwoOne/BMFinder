/* Dashboard UI. Pure presentation: every read and write goes through the
   background service worker over chrome.runtime.sendMessage. This file never
   opens IndexedDB and never fetches battlemetrics.com itself.

   The message contract is fixed by background/worker.js. A few controls in
   dashboard.html do not have a matching message type (server search by name,
   per-request delay, ID cache reuse) because the worker does not implement
   that behaviour yet. Those controls are handled honestly below rather than
   faked. */

import { applyTheme, resolveMode, SEEDS, seedSwatch } from '../lib/theme.js';
import {
  RELATIONSHIPS, RELATIONSHIP_LABEL, RELATIONSHIP_SHORT, RELATIONSHIP_HINT, toRelationship,
} from '../lib/relationships.js';
import {
  detectFormat, validateBackup, planPeopleImport, planServerImport, parseCsv,
  IMPORT_PARTS, summariseBackup,
} from '../lib/transfer.js';

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

/* ---- confirmation dialog ----------------------------------------------------
   window.confirm() is blocked in some extension contexts and cannot be styled
   or reliably cancelled, so every destructive control that is not fully
   reversible routes through this instead. The caller supplies the heading and
   body text, so the body can - and always should - name the specific person,
   server or scope about to be affected rather than asking a bare "Are you
   sure?". Returns a Promise<boolean> the caller awaits before acting. */
let confirmResolve = null;
let confirmRestoreFocus = null; // element to return focus to, same pattern as sheetRestoreFocus

/* `link` adds a single inline link under the body, used where a decision depends
   on a setting the user may want to look at first. `danger` marks the confirm
   button; explanatory dialogs that are not destructive turn it off. */
function askConfirm({ heading, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', link = null, danger = true }) {
  return new Promise((resolve) => {
    const scrim = $('#confirm-scrim'), dialog = $('#confirm-dialog');
    if (!scrim || !dialog) { resolve(false); return; } // fail closed: no dialog, no destructive action
    confirmResolve = resolve;
    confirmRestoreFocus = document.activeElement;
    $('#confirm-heading').textContent = heading;
    $('#confirm-body').textContent = body;
    $('#confirm-ok').textContent = confirmLabel;
    $('#confirm-cancel').textContent = cancelLabel;
    $('#confirm-ok').classList.toggle('danger', danger);

    const linkBox = $('#confirm-link');
    if (linkBox) {
      linkBox.innerHTML = '';
      linkBox.classList.toggle('hide', !link);
      if (link) {
        const a = document.createElement('button');
        a.type = 'button';
        a.className = 'linklike';
        a.textContent = link.text;
        a.addEventListener('click', () => { closeConfirm(false); link.onClick(); });
        linkBox.appendChild(a);
      }
    }

    scrim.classList.remove('hide');
    dialog.classList.remove('hide');
    document.addEventListener('keydown', confirmKeydown, true);
    $('#confirm-ok').focus();
  });
}
function closeConfirm(result) {
  const scrim = $('#confirm-scrim'), dialog = $('#confirm-dialog');
  if (scrim) scrim.classList.add('hide');
  if (dialog) dialog.classList.add('hide');
  document.removeEventListener('keydown', confirmKeydown, true);
  if (confirmRestoreFocus && document.contains(confirmRestoreFocus)) confirmRestoreFocus.focus();
  confirmRestoreFocus = null;
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(result); }
}
function confirmKeydown(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeConfirm(false); }
}
on('#confirm-ok', 'click', () => closeConfirm(true));
on('#confirm-cancel', 'click', () => closeConfirm(false));
on('#confirm-scrim', 'click', () => closeConfirm(false));

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
/* Reads through toRelationship so a row written before the v4 migration, or by
   an older build, still renders as something sensible instead of falling through
   to "other" and quietly losing what the user had set. */
function roleBadge(r) {
  const rel = toRelationship(r);
  return `<span class="badge b-${esc(rel)}">${esc(RELATIONSHIP_LABEL[rel])}</span>`;
}
/* A profile BattleMetrics did not make available to this session.

   This used to read "hidden", with a tooltip asserting the profile was hidden on
   BattleMetrics. Both were claims the extension is in no position to make: it
   cannot tell a private profile from a deleted one, a temporary outage, or an
   account its own permissions simply do not reach. Worse, "hidden" invites the
   reading that someone chose to conceal themselves, which is the inference this
   tool must never encourage. The neutral wording states only what is observable:
   nothing came back. */
function unavailableBadge(p) {
  return p
    ? ' <span class="badge b-unavailable" title="BattleMetrics is not making this profile available to your current session. ' +
      'It may be private, deleted, temporarily unavailable, or inaccessible with your current permissions.">unavailable</span>'
    : '';
}
function setMsg(target, text, cls) {
  const el = typeof target === 'string' ? $(target) : target;
  if (!el) return;
  el.textContent = text;
  el.className = 'msg ' + (cls || '');
}
function downloadBlob(filename, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function downloadCsv(filename, headers, rows) {
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const csv = [headers.map(q).join(',')].concat(rows.map(r => r.map(q).join(','))).join('\r\n');
  downloadBlob(filename, csv, 'text/csv');
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
    else if (!r.running && activeJob) activeJob = null;
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
  } else if (tab === 'privacy') {
    await loadPrivacyPanel();
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
/* Search results are people you have NOT saved, so they go through the same
   dialog as everything else - a list of strangers with their identifiers is the
   most casual identifier export there is. They are mapped into the shape the
   dialog's field list expects; label and relationship come out empty, which is
   honest, because you have not given them one. */
$('#s-export').addEventListener('click', () => {
  if (!searchResults.length) return;
  const asPeople = () => searchResults.map((p) => ({
    playerId: p.id,
    nickname: '',
    currentName: p.name,
    role: 'other',
    tags: [],
    lastSeen: p.lastSeen,
    lastServerName: p.trackedServerName || '',
    lastServerSeen: p.trackedLastSeen || '',
  }));
  openExportDialog({
    purpose: 'custom',
    filename: 'bmfinder-search-results',
    people: asPeople,
    describe: () => `Exporting ${searchResults.length} search ${searchResults.length === 1 ? 'result' : 'results'}. ` +
      'These are people you have not saved.',
  });
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
    renderSearch(query, d.results || [], d.crossReferenced);
    /* Say how the tracked-server column was filled in, including when it was not.
       "Empty because we looked and they are not there" and "empty because the
       lookup failed" needed telling apart; guessing which cost real time. */
    const cs = d.crossRefStats;
    if (d.crossReferenced) {
      const n = (d.results || []).filter((r) => r.trackedServerId).length;
      const how = cs && cs.local && !cs.fetched ? ' straight from your own poll history'
        : cs && cs.local ? ` (${cs.local} from your poll history)` : '';
      setMsg('#s-msg', `${n} of these have been seen on your tracked servers, shown first${how}.`, 'ok');
    } else if (cs && cs.fetched && !cs.confirmed) {
      setMsg('#s-msg', `Checked ${cs.fetched} of ${cs.checked} against your ${cs.checked === 1 ? 'server' : 'servers'} ` +
        `and found none of them there. Rows marked "?" were not checked.`, '');
    } else if (cs && !cs.fetched && !cs.local) {
      setMsg('#s-msg', 'Could not read any sessions pages, so the tracked-server column is unknown rather than empty.', 'err');
    }
    // A query their search cannot express is not a failed match, and saying so
    // beats letting a page of unrelated people imply the player does not exist.
    if (d.note) { setMsg('#s-msg', d.note, 'err'); return; }
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

function renderSearch(query, results, crossReferenced) {
  searchResults = results;
  $('#s-resultcard').classList.remove('hide');
  const onYours = results.filter((r) => r.trackedServerId).length;
  $('#s-meta').textContent = crossReferenced && onYours
    ? `- ${results.length} for "${query}", ${onYours} on your servers`
    : `- ${results.length} for "${query}"`;
  const tb = $('#s-table tbody');
  tb.innerHTML = '';
  if (!results.length) {
    tb.innerHTML = '<tr><td colspan="7" class="note">No players returned.</td></tr>';
    return;
  }
  for (const p of results) {
    const tr = document.createElement('tr');
    // A tracked-server hit is the whole point of the cross-reference, so it gets
    // a filled chip with the server and when they were last on it; everyone else
    // gets a quiet dash so the matches stand out at a glance.
    // The tracked-server column: a filled chip linking straight to the RCON
    // profile when they play somewhere you watch, a quiet dash otherwise, so the
    // hits stand out at a glance. "Not seen" is different from "we could not
    // check", and the column says which.
    const onServer = p.trackedServerId
      ? `<a class="chip w" href="https://www.battlemetrics.com/rcon/players/${encodeURIComponent(p.id)}" ` +
        `target="_blank" rel="noopener" title="Last observed playing ${esc(fdt(p.trackedLastSeen))}">${esc(p.trackedServerName)}` +
        `${p.trackedLastSeen ? ` &middot; ${esc(frel(p.trackedLastSeen))}` : ''}</a>`
      : p.serverEvidence === 'unknown'
        ? '<span class="unknown-text" title="Their sessions page could not be read, so this is unknown rather than no">?</span>'
        : '<span class="unknown-text" title="Not seen on any server you track">&mdash;</span>';
    if (p.trackedServerId) tr.classList.add('sel');

    /* Match blends name similarity with whether they have been observed on a
       server you follow, so the tooltip spells out both. A bare percentage that
       silently moved would be worse than no percentage at all. */
    const namePct = Math.round((p.nameScore != null ? p.nameScore : p.score) * 100);
    const why = p.serverEvidence === 'confirmed'
      ? `name ${namePct}%, raised because they play on ${p.trackedServerName}`
      : p.serverEvidence === 'absent'
        ? `name ${namePct}%, lowered because they are on none of your servers`
        : `name ${namePct}%, no server check available`;

    tr.innerHTML = `<td title="${esc(why)}">${pill(p.score)}</td>
      <td class="name"><span class="pii">${esc(p.name) || '<span class="note">(no name)</span>'}</span>${unavailableBadge(p.private)}</td>
      <td class="col-id"><span class="pii">${esc(p.id)}</span></td>
      <td class="note opt-2">${esc(fdate(p.firstSeen)) || '<span class="unknown-text">Unknown</span>'}</td>
      <td class="note">${esc(fdate(p.lastSeen)) || '<span class="unknown-text">Unknown</span>'}</td>
      <td>${onServer}</td>
      <td>${plink(p.id)} <button class="ghost" data-track="${esc(p.id)}" type="button">Save</button></td>`;
    tb.appendChild(tr);
  }
}

$('#s-table tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-track]');
  if (!btn) return;
  btn.disabled = true; btn.textContent = 'saving...';
  // No role: addWatch picks the neutral default for a new person and leaves an
  // existing one exactly as the user set them up.
  const r = await send({ type: 'ADD_WATCH', entry: { playerId: btn.dataset.track } });
  btn.textContent = r.error ? 'failed' : 'saved';
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

/* The v4 upgrade rewrote the relationship on rows the user had set by hand, so
   it says so. A snackbar would be wrong here: it disappears on its own, and a
   change to saved data should not be announced by something the user can miss
   while looking at another tab. This stays until dismissed. */
async function showMigrationNotice() {
  const box = $('#w-migration'), text = $('#w-migration-text');
  if (!box || !text) return;
  let notice = null;
  try {
    const r = await send({ type: 'MIGRATION_NOTICE' });
    notice = r && r.notice;
  } catch { return; }
  if (!notice) return;

  const n = notice.migrated || 0;
  text.textContent =
    `The old roles were replaced with relationships that describe how you know someone: ` +
    `Friend, Teammate, Community member, Server staff and Other. ` +
    `${n} ${n === 1 ? 'entry was' : 'entries were'} updated. Admin became Server staff and Player ` +
    `became Community member.` +
    (notice.hadSuspect
      ? ' The Suspect role has been retired, and anyone filed under it is now Other. Nothing else about them changed.'
      : '') +
    ' Your labels, notes, tags and history were not touched, and you can change any of these yourself.';
  box.classList.remove('hide');
}
on('#w-migration-ok', 'click', async () => {
  $('#w-migration').classList.add('hide');
  try { await send({ type: 'MIGRATION_NOTICE_ACK' }); } catch { /* shown again next time */ }
});

/* The hint under the relationship picker. The categories are deliberately soft,
   so saying what each one means beats making the user guess from one word. */
function syncRoleHint() {
  const sel = $('#w-role'), hint = $('#w-rolehint');
  if (sel && hint) hint.textContent = RELATIONSHIP_HINT[toRelationship(sel.value)] || '';
}
on('#w-role', 'change', syncRoleHint);
syncRoleHint();

on('#w-add', 'click', async () => {
  const id = $('#w-id').value.trim();
  if (!id) { setMsg('#w-msg', 'Enter a player ID.', 'err'); return; }
  const entry = { playerId: id, nickname: $('#w-nick').value.trim(), role: $('#w-role').value, note: $('#w-note').value.trim() };
  const r = await send({ type: 'ADD_WATCH', entry });
  if (r.error) { setMsg('#w-msg', r.error, 'err'); return; }
  setMsg('#w-msg', 'Saved.', 'ok');
  // The panel stays open for a second add, so the confirmation goes where the
  // eye ends up: with the table row that just appeared.
  toast(`Saved ${entry.nickname || entry.playerId}.`, { tone: 'ok' });
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
  const host = anchor.closest('td') || anchor.closest('.ptile-acts') || anchor.parentElement;
  host.appendChild(box);
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
  if (r.error) { setMsg('#impd-msg', r.error, 'err'); return; }
  const parts = [`Imported ${r.added}`];
  if (r.skipped) parts.push(`${r.skipped} already tracked`);
  setMsg('#impd-msg', parts.join(', ') + '. Use "Refresh player details" to fetch their current names and last seen.', 'ok');
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

/* Reading bookmarks is an optional permission in the published build, so it is
   asked for at the moment it is needed rather than at install, where "read your
   bookmarks" on a server tracker is an alarming thing to be shown with no
   context. The request must happen here, in a page and inside the click, since
   Chrome refuses it from a service worker or outside a user gesture.

   In the full build the permission is declared up front, so contains() is
   already true and nothing is asked. Same code, both builds. */
async function ensureBookmarksPermission() {
  try {
    if (!chrome.permissions) return true;
    const has = await chrome.permissions.contains({ permissions: ['bookmarks'] });
    if (has) return true;
    return await chrome.permissions.request({ permissions: ['bookmarks'] });
  } catch {
    return true; // let the worker report the real problem
  }
}

on('#imp-bookmarks', 'click', async () => {
  if (!(await ensureBookmarksPermission())) {
    setMsg('#impd-msg', 'Bookmark access was declined. You can still import from a bookmarks file.', 'err');
    return;
  }
  setMsg('#impd-msg', 'Scanning your bookmarks...', '');
  const r = await send({ type: 'IMPORT_BOOKMARKS', role: $('#imp-role').value });
  if (!r.error && !r.found) { setMsg('#impd-msg', 'No BattleMetrics player bookmarks found.', ''); return; }
  await afterImport(r);
});

on('#imp-file', 'click', () => $('#imp-fileinput').click());

on('#imp-fileinput', 'change', async () => {
  const input = $('#imp-fileinput');
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  setMsg('#impd-msg', 'Reading file...', '');
  let text;
  try { text = await file.text(); }
  catch (err) { setMsg('#impd-msg', 'Could not read that file: ' + ((err && err.message) || err), 'err'); return; }

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
  if (!entries.length) { setMsg('#impd-msg', 'No BattleMetrics player links found in that file.', ''); return; }
  const r = await send({ type: 'ADD_WATCH_BATCH', entries, role: $('#imp-role').value });
  await afterImport(r);
});

/** Shared by "Export CSV" in the page header and "Export selected" in the bulk
    bar, so both produce identical columns. */
/* ---- export dialog ---------------------------------------------------------

   One dialog for every export in the extension. Before this there were six
   one-click buttons, each of which wrote player IDs into a file without asking,
   which is exactly the casual identifier export the audit set out to stop.

   Three ideas hold it together:
     - a SCOPE, set by whichever button opened it (all saved people, the current
       selection, search results, recent activity, everything);
     - a PURPOSE, which presets the fields for what someone is actually doing;
     - the FIELDS themselves, which the user can always override.

   Defaults are the audit's: labels, names, relationships and tags on;
   identifiers, servers and timestamps off. */

/* Any of these turns an ordinary list into something that identifies people
   across services or reconstructs where they were and when, so any of them
   triggers the warning and the acknowledgement. */
const EXPORT_WARN_FIELDS = ['playerId', 'activityPlayerIds', 'exactTimes', 'rosterMembers', 'checks'];

const EXPORT_PURPOSES = {
  // Your own data, coming back to you. Nothing is withheld from its owner.
  backup: {
    format: 'backup',
    fields: { label: 1, currentName: 1, relationship: 1, tags: 1, playerId: 1, lastServer: 1,
      lastSeen: 1, serverName: 1, serverLink: 1, serverId: 1, checks: 1, rosterMembers: 1,
      exactTimes: 1, activityPlayerIds: 1 },
  },
  /* Sharing. Who you play with, without the identifiers that would let a
     recipient trace them elsewhere. Roster members are not merely off here -
     they are locked off, because people who never agreed to be on anyone's list
     must not leave the device inside a list about friendship. */
  share: {
    format: 'list',
    fields: { label: 1, currentName: 1, relationship: 1, tags: 1, serverName: 1, serverLink: 1,
      playerId: 1, serverId: 1 },
    lock: { rosterMembers: false },
  },
  activity: {
    format: 'csv',
    fields: { checks: 1, serverName: 1, serverLink: 1, label: 1, currentName: 1,
      playerId: 1, serverId: 1 },
  },
  custom: null, // leaves whatever is ticked alone
};

/* Identifiers are not optional. Both are the keys an import matches on - a
   person by player ID, a followed server by server ID - so a file without them
   restores nothing and is a broken export rather than a private one. They stay
   ticked, disabled, and are re-asserted after every purpose and format change so
   no preset can quietly clear them. */
const REQUIRED_EXPORT_FIELDS = ['playerId', 'serverId'];

function expLockRequiredIds() {
  for (const key of REQUIRED_EXPORT_FIELDS) {
    const box = $(`#exp-fields input[data-f="${key}"]`);
    if (!box) continue;
    box.checked = true;
    box.disabled = true;
    box.closest('label').classList.add('locked');
  }
}

let exportScope = null;

function expFieldInputs() { return [...$$('#exp-fields input[data-f]')]; }
function expFields() {
  const f = {};
  for (const i of expFieldInputs()) f[i.dataset.f] = i.checked;
  return f;
}

/* Which whole sections belong in the file, as distinct from which columns.

   Someone sharing the servers they play on should not have to hand over their
   people list to do it, and the reverse is just as true. A field tick chooses a
   column; these choose whether the section exists at all. The required id
   fields stay locked within a section, because a section that IS exported still
   needs its key to be importable - being required does not mean being
   unavoidable. */
function expSections() {
  const s = {};
  for (const i of $$('#exp-fields input[data-section]')) s[i.dataset.section] = i.checked;
  return s;
}

/* The fields that will actually reach the file.

   A field tick inside an excluded section is inert: the section contributes
   nothing, so the column cannot appear. Anything reasoning about what the export
   CONTAINS - the sensitive-data warning, the self-describing field list - has to
   ask this rather than expFields(), or it describes ticks instead of contents.

   The case that made this necessary: player IDs are a warned field and live in
   the people section, so excluding people to share a server list still raised
   "this export contains detailed player information" and demanded an
   acknowledgement, for a file with no player data in it. A warning that fires
   when nothing is wrong teaches people to dismiss warnings. */
function expEffectiveFields() {
  const sec = expSections();
  const f = {};
  for (const i of expFieldInputs()) {
    const group = i.closest('[data-section-of]');
    const owner = group && group.dataset.sectionOf;
    f[i.dataset.f] = i.checked && (!owner || sec[owner] !== false);
  }
  return f;
}

/* An excluded section's field ticks are meaningless, so grey them out rather
   than leaving them live and ignored. */
function expSyncSections() {
  for (const box of $$('#exp-fields input[data-section]')) {
    const group = box.closest('.exp-group');
    if (!group) continue;
    group.classList.toggle('section-off', !box.checked);
    for (const f of group.querySelectorAll('input[data-f]')) {
      // A locked required field is disabled for its own reason; leave it alone.
      if (f.dataset.f === 'playerId' || f.dataset.f === 'serverId') continue;
      f.disabled = !box.checked;
    }
  }
}

/* The warning is a function of the current ticks, so it is recomputed on every
   change rather than shown once and left. Unticking the field that caused it
   takes the warning away, and re-ticking brings back an unticked acknowledgement
   - consent to one selection is not consent to a later, wider one. */
function expSyncWarning() {
  // Effective, not ticked: a warned field in an excluded section is not in the file.
  const f = expEffectiveFields();
  const need = EXPORT_WARN_FIELDS.some((k) => f[k]);
  $('#exp-warn').classList.toggle('hide', !need);
  /* Cleared unconditionally. This runs on every field change, so any change to
     what is being exported invalidates a tick that was made against the previous
     selection - the box says "I have reviewed the selected fields", and the
     selected fields just changed. Ticking the box itself does not come through
     here, so this cannot fight the user. */
  $('#exp-ack').checked = false;
  expSyncGo();
}

function expSyncGo() {
  const needAck = !$('#exp-warn').classList.contains('hide');
  /* A full backup ignores the section switches by definition, so it is never
     empty. Otherwise, with both sections excluded and no activity selected there
     is nothing to write: refuse up front rather than letting the click land on
     an error message. Saying no before the button is pressed is kinder than
     saying no after. */
  const fmt = ($('#exp-format input:checked') || {}).value;
  const sec = expSections();
  const empty = fmt !== 'backup'
    && sec.people === false && sec.servers === false && !expFields().checks;
  $('#exp-go').disabled = empty || (needAck && !$('#exp-ack').checked);
}

/* A full backup is a complete copy by definition, so offering field
   checkboxes beside it would be a lie about what the file will contain. */
function expSyncFormat() {
  const fmt = ($('#exp-format input:checked') || {}).value;
  const whole = fmt === 'backup';
  $('#exp-fields').classList.toggle('disabled', whole);
  for (const i of expFieldInputs()) i.disabled = whole;

  if (!whole) expLockRequiredIds();
  setMsg('#exp-msg', whole
    ? 'A full backup always contains everything, so field choices do not apply to it.'
    : 'Player and server IDs are always included: they are what an import matches on.', '');
}

function expApplyPurpose(name) {
  const p = EXPORT_PURPOSES[name];
  if (!p) return;
  for (const i of expFieldInputs()) {
    i.checked = !!p.fields[i.dataset.f];
    const locked = p.lock && Object.prototype.hasOwnProperty.call(p.lock, i.dataset.f);
    i.disabled = !!locked;
    i.closest('label').classList.toggle('locked', !!locked);
    if (locked) i.checked = !!p.lock[i.dataset.f];
  }
  /* A preset describes which columns it wants, not which sections to drop, so
     choosing one restores both sections. Otherwise a section switched off for
     one export would silently persist into the next, differently-intended one. */
  for (const s of $$('#exp-fields input[data-section]')) s.checked = true;
  expSyncSections();

  const fmt = $(`#exp-format input[value="${p.format}"]`);
  if (fmt) fmt.checked = true;
  expSyncFormat();
  expLockRequiredIds();
  expSyncWarning();
}

function openExportDialog(scope) {
  exportScope = scope;
  $('#exp-scope').textContent = scope.describe();
  setMsg('#exp-msg', '', '');
  // Sharing is the safe default to land on, not a full backup.
  const purpose = scope.purpose || 'share';
  const radio = $(`#exp-purpose input[value="${purpose}"]`);
  if (radio) radio.checked = true;
  expApplyPurpose(purpose);
  $('#exp-scrim').classList.remove('hide');
  $('#exp-dialog').classList.remove('hide');
  $('#exp-go').focus();
}

function closeExportDialog() {
  $('#exp-scrim').classList.add('hide');
  $('#exp-dialog').classList.add('hide');
  exportScope = null;
}

on('#exp-purpose', 'change', (e) => {
  const r = e.target.closest('input[name="exp-purpose"]');
  if (r) expApplyPurpose(r.value);
});
on('#exp-fields', 'change', (e) => {
  // Touching a field by hand means this is no longer one of the presets.
  const custom = $('#exp-purpose input[value="custom"]');
  if (custom) custom.checked = true;
  if (e.target && e.target.dataset && e.target.dataset.section) expSyncSections();
  expSyncWarning();
});
on('#exp-format', 'change', () => { expSyncFormat(); expSyncWarning(); });
on('#exp-ack', 'change', expSyncGo);
on('#exp-cancel', 'click', closeExportDialog);
on('#exp-scrim', 'click', closeExportDialog);
on('#exp-go', 'click', runExport);

/* Column order is fixed and field-driven: a column only exists when its box is
   ticked, so an unticked field cannot reach the file through some other path. */
const EXPORT_COLUMNS = [
  ['label', 'label', (w) => w.nickname || ''],
  ['currentName', 'currentName', (w) => w.currentName || ''],
  ['relationship', 'relationship', (w) => toRelationship(w.role)],
  ['tags', 'tags', (w) => (w.tags || []).join(' | ')],
  ['playerId', 'playerId', (w) => String(w.playerId)],
  ['lastServer', 'lastObservedServer', (w) => w.lastServerName || ''],
  ['lastSeen', 'lastObservedAt', (w, f) => fmtTime(w.lastServerSeen || w.lastSeen, f)],
];

/* Exact timestamps are themselves a field. With it off, a time is rounded to the
   day, which still answers "roughly when" without pinning someone to a minute. */
function fmtTime(iso, f) {
  if (!iso) return '';
  return f.exactTimes ? iso : String(iso).slice(0, 10);
}

function peopleRows(people, f) {
  const cols = EXPORT_COLUMNS.filter(([key]) => f[key]);
  return {
    headers: cols.map(([, header]) => header),
    rows: people.map((w) => cols.map(([, , get]) => get(w, f))),
  };
}

/* CSV had no server writer, so asking for servers without people produced an
   empty people file. Sharing "here are the servers I play on" is an ordinary
   thing to want, and it should not require handing over the people list or
   switching to JSON to do it. */
function serverRows(servers, f) {
  const headers = ['serverId'];
  if (f.serverName) headers.push('server');
  if (f.serverLink) headers.push('link');
  const rows = servers.map((s) => {
    const row = [String(s.serverId)];
    if (f.serverName) row.push(s.nickname || s.name || '');
    if (f.serverLink) row.push(s.game ? `https://www.battlemetrics.com/servers/${s.game}/${s.serverId}` : '');
    return row;
  });
  return { headers, rows };
}

async function runExport() {
  if (!exportScope) return;
  /* Followed servers come from local state, which is empty until the first
     GET_STATE resolves. Exporting inside that window would write a file with no
     servers in it and report success, and a silently incomplete export is worse
     than a refused one: the user keeps the file and believes it is whole. The
     window is one message round-trip, so this should effectively never be seen. */
  if (!stateLoaded) {
    setMsg('#exp-msg', 'Still reading your data. Try again in a moment.', 'err');
    return;
  }
  const scope = exportScope;
  const f = expFields();
  const fmt = ($('#exp-format input:checked') || {}).value || 'csv';
  const stamp = new Date().toISOString().slice(0, 10);

  setMsg('#exp-msg', 'Preparing export...', '');

  try {
    if (fmt === 'backup') {
      const r = await send({ type: 'EXPORT' });
      if (!r || r.error) { setMsg('#exp-msg', 'Export failed: ' + ((r && r.error) || 'unknown error'), 'err'); return; }
      downloadBlob(`bmfinder-backup-${stamp}.json`, JSON.stringify(r.json, null, 2), 'application/json');
      closeExportDialog();
      toast('Full backup exported.', { tone: 'ok' });
      return;
    }

    const sec = expSections();
    const eff = expEffectiveFields();
    /* An unticked section contributes nothing at all - not an empty array of
       objects with ids in them, nothing. This is the whole point: sharing a
       server list must not ship the people list alongside it. */
    const people = sec.people === false ? [] : (scope.people ? scope.people() : []);
    const servers = sec.servers === false ? [] : (state.servers || []);

    if (!people.length && !servers.length && !f.checks) {
      setMsg('#exp-msg', 'Nothing selected to export. Tick a section, or choose recent activity.', 'err');
      return;
    }

    if (fmt === 'list') {
      /* A transfer format, so it is self-describing: a receiving BMFinder should
         be able to tell what it is and which fields are present without guessing
         from the shape of the first row. */
      const payload = {
        format: 'bmfinder-list',
        version: 1,
        exportedAt: f.exactTimes ? new Date().toISOString() : stamp,
        /* Describes what is in the file, not what was ticked. A receiving
           BMFinder trusts this list to know which fields are present, so
           advertising a column from an excluded section would be a lie. */
        fields: Object.keys(eff).filter((k) => eff[k]),
        people: people.map((w) => {
          const o = { playerId: String(w.playerId) };
          if (f.label) o.label = w.nickname || '';
          if (f.currentName) o.currentName = w.currentName || '';
          if (f.relationship) o.relationship = toRelationship(w.role);
          if (f.tags) o.tags = w.tags || [];
          if (f.note && w.note) o.note = w.note;
          if (f.lastServer) o.lastObservedServer = w.lastServerName || '';
          if (f.lastSeen) o.lastObservedAt = fmtTime(w.lastServerSeen || w.lastSeen, f);
          return o;
        }),
        /* Followed servers travel with the list.

           They did not, which meant re-importing your own list restored the
           people and left you following nothing — the server ID was an export
           field that no import path read. Carrying them makes the id
           load-bearing, and makes a list a complete picture of a setup rather
           than half of one. */
        servers: servers.map((s) => {
          const o = { serverId: String(s.serverId) };
          if (f.serverName) o.name = s.nickname || s.name || '';
          if (s.game) o.game = s.game;
          if (f.serverLink && s.serverId) {
            o.link = `https://www.battlemetrics.com/servers/${s.game || 'arma3'}/${s.serverId}`;
          }
          return o;
        }),
      };
      downloadBlob(`bmfinder-list-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
      closeExportDialog();
      /* Name only what was actually written. Reporting "0 people" when the
         people section was deliberately left out reads like a failure. */
      const parts = [];
      if (payload.people.length) {
        parts.push(`${payload.people.length} ${payload.people.length === 1 ? 'person' : 'people'}`);
      }
      if (payload.servers.length) {
        parts.push(`${payload.servers.length} ${payload.servers.length === 1 ? 'server' : 'servers'}`);
      }
      toast(`Exported ${parts.join(' and ')}.`, { tone: 'ok' });
      return;
    }

    // CSV. Activity is a different shape from people, so it gets its own file.
    if (f.checks) {
      const r = await send({ type: 'ARCHIVE', limit: 300 });
      if (r && r.error) { setMsg('#exp-msg', 'Export failed: ' + r.error, 'err'); return; }
      const saved = new Set((watchData || []).map((w) => String(w.playerId)));
      /* Snapshots record a serverId but not a game slug, and a BattleMetrics
         server URL needs both. Look the game up from the followed servers
         rather than assuming one: exporting a Rust server as /servers/arma3/
         produces a link that does not resolve. */
      const gameOf = new Map((state.servers || [])
        .filter((s) => s.game)
        .map((s) => [String(s.serverId), s.game]));
      const headers = ['when'];
      if (f.serverName) headers.push('server');
      if (f.serverId) headers.push('serverId');
      if (f.serverLink) headers.push('serverLink');
      headers.push('player');
      if (f.activityPlayerIds) headers.push('playerId');
      headers.push('saved');

      const rows = [];
      for (const s of (r.snapshots || [])) {
        for (const p of (s.roster || [])) {
          const isSaved = saved.has(String(p.id));
          // Unsaved roster members are people who never asked to be on a list.
          if (!isSaved && !f.rosterMembers) continue;
          const row = [fmtTime(s.pollTs, f)];
          if (f.serverName) row.push(s.serverName || '');
          if (f.serverId) row.push(String(s.serverId || ''));
          if (f.serverLink) {
            const g = gameOf.get(String(s.serverId));
            row.push(s.serverId && g ? `https://www.battlemetrics.com/servers/${g}/${s.serverId}` : '');
          }
          row.push(p.nickname || p.name || '');
          if (f.activityPlayerIds) row.push(String(p.id));
          row.push(isSaved ? 'yes' : 'no');
          rows.push(row);
        }
      }
      downloadCsv(`bmfinder-recent-activity-${stamp}.csv`, headers, rows);
      closeExportDialog();
      toast(`Exported ${rows.length} activity ${rows.length === 1 ? 'row' : 'rows'}.`, { tone: 'ok' });
      return;
    }

    // Servers without people is a servers file, not an empty people file.
    if (!people.length && servers.length) {
      const s = serverRows(servers, f);
      downloadCsv(`bmfinder-servers-${stamp}.csv`, s.headers, s.rows);
      closeExportDialog();
      toast(`Exported ${s.rows.length} ${s.rows.length === 1 ? 'server' : 'servers'}.`, { tone: 'ok' });
      return;
    }

    const { headers, rows } = peopleRows(people, f);
    if (!headers.length) { setMsg('#exp-msg', 'Choose at least one field to export.', 'err'); return; }
    downloadCsv(`${scope.filename || 'bmfinder-saved-people'}-${stamp}.csv`, headers, rows);
    closeExportDialog();
    toast(`Exported ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}.`, { tone: 'ok' });
  } catch (e) {
    setMsg('#exp-msg', 'Export failed: ' + ((e && e.message) || e), 'err');
  }
}

/* ---- watchlist state ---------------------------------------------------- */
/* The floor the picker offers, in one place so the clamp and the markup cannot
   drift apart. Faster than this produces more traffic than a person browsing
   does, which is the line this extension stays on the right side of. */
const MIN_INTERVAL_SEC = 300;

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

/* Sort order for the relationship column, and the second key of the resting
   order in defaultOrder(). Closest relationships first, which is how someone
   scanning their own list expects it to read. Staff sits above community because
   the people running a server you play on are the ones you are most likely to be
   looking for. Presentation only; it carries no judgement about anyone in it. */
const ROLE_ORDER = { friend: 0, teammate: 1, staff: 2, community: 3, other: 4 };

/* `compact` swaps the option text for the short form. A tile's select is about
   110px wide, and a native select cannot ellipsis - it clips, so "Community
   member" rendered as "COMMUNITY MEMBEI", which reads as a bug rather than as an
   abbreviation. The aria-label keeps the full name for screen readers. */
function roleSelect(w, { compact = false } = {}) {
  const role = toRelationship(w.role);
  const text = compact ? RELATIONSHIP_SHORT : RELATIONSHIP_LABEL;
  const opts = RELATIONSHIPS
    .map(r => `<option value="${r}"${r === role ? ' selected' : ''}>${esc(text[r])}</option>`)
    .join('');
  return `<select class="role-select role-${esc(role)}" data-role-pid="${esc(w.playerId)}"
    title="${esc(RELATIONSHIP_LABEL[role])}"
    aria-label="Relationship for ${esc(w.nickname || w.playerId)}: ${esc(RELATIONSHIP_LABEL[role])}">${opts}</select>`;
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

/* The resting order, used whenever the user has not chosen a column.

   It used to be whatever order IndexedDB handed back, which meant the people you
   care about most were scattered through the list. Closest first: favourites,
   then by relationship, then most recently observed, then label. Clicking a
   column header still overrides all of this - this is the order the list returns
   to, not one it is locked into. */
function defaultOrder(a, b) {
  const fav = (w) => ((w.tags || []).includes(FAVOURITE) ? 0 : 1);
  if (fav(a) !== fav(b)) return fav(a) - fav(b);

  const rel = (w) => ROLE_ORDER[toRelationship(w.role)] ?? 9;
  if (rel(a) !== rel(b)) return rel(a) - rel(b);

  // Most recently observed first. Never seen sorts last rather than first.
  const seen = (w) => Date.parse(w.lastServerSeen || w.lastSeen || 0) || 0;
  if (seen(a) !== seen(b)) return seen(b) - seen(a);

  const name = (w) => (w.nickname || w.currentName || '').toLowerCase();
  return name(a).localeCompare(name(b));
}

function sortedWatch(watch) {
  if (!watchSort.key) return watch.slice().sort(defaultOrder);
  const k = watchSort.key, dir = watchSort.dir;
  const val = (w) => {
    if (k === 'nickname') return (w.nickname || w.currentName || '').toLowerCase();
    if (k === 'role') return ROLE_ORDER[toRelationship(w.role)] ?? 9;
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
  const roleOpts = RELATIONSHIPS.map(r => `<option value="${r}">${esc(RELATIONSHIP_LABEL[r])}</option>`).join('');
  el.innerHTML =
    `<span class="count">${esc(n)} selected</span>` +
    `<select id="w-bulkrole" aria-label="Change relationship for selected people">` +
      `<option value="">Change relationship&hellip;</option>${roleOpts}</select>` +
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

/* ---- batch removal ----------------------------------------------------------
   Shared by every control that removes more than one row through a loop of
   single-id messages - there is no bulk REMOVE_WATCH/REMOVE_SERVER - namely
   the Watchlist's "Remove selected", and the Data and privacy panel's "Remove
   all saved people" and "Remove all followed servers". Each response is
   checked for .error individually: the reported count is how many actually
   succeeded, never the number requested, and if the LAST call in the loop is
   the one that fails, the caller still knows about every earlier success
   because this counts as it goes rather than trusting whichever response
   happened to arrive last. Callers re-render from a fresh GET_STATE
   afterwards rather than from anything this returns, so a failed final call
   can never paint an empty table over rows that are still in the database. */
async function removeBatch(type, idKey, ids) {
  let ok = 0, failed = 0;
  const removed = []; // populated only for REMOVE_WATCH, which hands back a restorable snapshot
  for (const id of ids) {
    const r = await send({ type, [idKey]: id });
    if (!r || r.error) { failed++; continue; }
    ok++;
    if (r.removed) removed.push(r.removed);
  }
  return { ok, failed, removed };
}

/* A partial failure is always visible in the wording, never rounded up to a
   clean success or silently dropped - "3 removed, 1 could not be removed" is
   the honest middle ground between claiming full success and staying silent. */
function batchResultText(ok, failed, singular, plural) {
  const noun = (n) => (n === 1 ? singular : plural);
  return failed
    ? `${ok} ${noun(ok)} removed, ${failed} could not be removed.`
    : `${ok} ${noun(ok)} removed.`;
}

on('#w-bulk', 'click', async (e) => {
  const btn = e.target.closest('[data-bulk]');
  if (!btn) return;
  const what = btn.dataset.bulk;
  if (what === 'clear') { watchSel.clear(); renderWatch(watchData); return; }
  if (what === 'export') {
    const picked = selectedWatch();
    openExportDialog({
      purpose: 'share',
      filename: 'bmfinder-saved-people-selection',
      people: () => picked,
      describe: () => `Exporting the ${picked.length} selected ${picked.length === 1 ? 'person' : 'people'}.`,
    });
    return;
  }
  if (what === 'tag') { openTagPicker(btn, [...watchSel][0]); return; }
  if (what === 'remove') {
    /* No confirmation step. Removal is fully reversible here: the worker hands
       back the watch row and its alias history, and the snackbar holds them
       until it is dismissed. A confirm dialog on a reversible action is a tax
       on the common case for no safety gained. */
    btn.disabled = true;
    const ids = [...watchSel];
    const { ok, failed, removed } = await removeBatch('REMOVE_WATCH', 'playerId', ids);
    watchSel.clear();
    btn.disabled = false;
    await refreshState();
    renderWatch(state.watch || []);
    offerUndoRemoval(removed, batchResultText(ok, failed, 'player', 'players'));
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

/* List or tiles. Tiles exist for the case the table handles badly: once someone
   has saved a few dozen people, a full-width row per person means scrolling past
   most of the list to find anyone. A tile drops to the four things you actually
   scan for - your label, who they are in game, when they were last seen, and a
   way in - and fits five across. */
let watchView = 'list';

function setWatchView(view) {
  watchView = view === 'tiles' ? 'tiles' : 'list';
  const list = $('#w-listview'), tiles = $('#w-tileview');
  if (list) list.classList.toggle('hide', watchView !== 'list');
  if (tiles) tiles.classList.toggle('hide', watchView !== 'tiles');
  for (const b of $$('#w-view button')) {
    const on = b.dataset.view === watchView;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  // Each view has its own keyboard hint; showing the table's in tiles would
  // promise arrow-key navigation and inline rename that tiles do not have.
  const listHint = $('#w-listhint'), tileHint = $('#w-tilehint');
  if (listHint) listHint.classList.toggle('hide', watchView !== 'list');
  if (tileHint) tileHint.classList.toggle('hide', watchView !== 'tiles');
  renderWatch(watchData);
  try { chrome.storage.local.set({ bmfWatchView: watchView }); } catch { /* ignore */ }
}

on('#w-view', 'click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) setWatchView(b.dataset.view);
});

/* The empty state. Deliberately an invitation rather than an explanation of what
   an empty database means - this is the first thing a new user sees on this tab,
   and it should say what the extension is for. */
const EMPTY_PEOPLE = {
  title: 'Save people you recognise',
  body: 'Add friends, teammates, or familiar players so BMFinder can help you recognise name ' +
    'changes and see when they appear on servers you follow.',
  actions: '<div class="empty-actions">' +
    '<button type="button" data-empty="find">Find players</button>' +
    '<button class="secondary" type="button" data-empty="import">Import saved links</button></div>',
};

on('#w-views', 'click', (e) => {
  const b = e.target.closest('[data-empty]');
  if (!b) return;
  if (b.dataset.empty === 'clearfilter') {
    watchFilter = { text: '', rel: '' };
    const s = $('#w-search'); if (s) s.value = '';
    for (const x of $$('#w-relfilter button')) {
      const on = x.dataset.rel === '';
      x.classList.toggle('active', on);
      x.setAttribute('aria-pressed', String(on));
    }
    renderWatch(watchData);
    return;
  }
  if (b.dataset.empty === 'find') {
    // Click the real tab button so the tab strip's own state updates with it.
    const tab = document.querySelector('#tabs button[data-tab="search"]');
    if (tab) tab.click();
  } else {
    setPanel('#imp-panel', true);
  }
});

/* Filter state. Kept out of watchData so filtering never destroys the list -
   clearing the filter restores everything without re-fetching. */
let watchFilter = { text: '', rel: '' };

function filteredWatch(watch) {
  const q = watchFilter.text.trim().toLowerCase();
  const rel = watchFilter.rel;
  return watch.filter((w) => {
    if (rel === 'favourite') {
      if (!(w.tags || []).includes(FAVOURITE)) return false;
    } else if (rel && toRelationship(w.role) !== rel) {
      return false;
    }
    if (!q) return true;
    // Previous names are searched too: recognising someone by a name they used
    // to play under is the whole reason the name history is kept.
    return (w.nickname || '').toLowerCase().includes(q)
      || (w.currentName || '').toLowerCase().includes(q)
      || String(w.playerId).includes(q)
      || (w.names || []).some((n) => String(n).toLowerCase().includes(q));
  });
}

function updateFilterCount(shown, total) {
  const el = $('#w-filtercount');
  if (!el) return;
  el.textContent = shown === total
    ? ''
    : `${shown} of ${total} shown`;
}

on('#w-search', 'input', (e) => {
  watchFilter.text = e.target.value;
  renderWatch(watchData);
});

on('#w-relfilter', 'click', (e) => {
  const b = e.target.closest('[data-rel]');
  if (!b) return;
  watchFilter.rel = b.dataset.rel;
  for (const x of $$('#w-relfilter button')) {
    const on = x.dataset.rel === watchFilter.rel;
    x.classList.toggle('active', on);
    x.setAttribute('aria-pressed', String(on));
  }
  renderWatch(watchData);
});

function renderWatch(watch) {
  watchData = watch;
  const present = new Set(watch.map(w => String(w.playerId)));
  for (const id of [...watchSel]) if (!present.has(id)) watchSel.delete(id);
  updateBulkBar();
  closeRowMenu();

  const shown = filteredWatch(watch);
  updateFilterCount(shown.length, watch.length);

  /* A filter that hides everything is not the same as an empty list, and saying
     "save people you recognise" to someone who has 200 saved would be wrong. */
  if (watch.length && !shown.length) {
    const msg = `<div class="empty"><span class="empty-title">Nothing matches that filter</span>
      <p>${esc(watch.length)} saved ${watch.length === 1 ? 'person is' : 'people are'} hidden by the
      current filter.</p><div class="empty-actions">
      <button type="button" data-empty="clearfilter">Clear filter</button></div></div>`;
    if (watchView === 'tiles') { $('#w-tileview').innerHTML = msg; return; }
    const tb0 = $('#w-table tbody');
    if (tb0) tb0.innerHTML = `<tr><td colspan="6">${msg}</td></tr>`;
    return;
  }

  if (watchView === 'tiles') { renderWatchTiles(shown); return; }

  const tb = $('#w-table tbody');
  if (!tb) return;
  tb.innerHTML = '';
  if (!watch.length) {
    tb.innerHTML = `<tr><td colspan="6"><div class="empty">
      <span class="empty-title">${esc(EMPTY_PEOPLE.title)}</span>
      <p>${esc(EMPTY_PEOPLE.body)}</p>${EMPTY_PEOPLE.actions}</div></td></tr>`;
    return;
  }
  let first = true;
  for (const w of sortedWatch(shown)) {
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
    // screenshots without re-rendering. .pii-nick marks the label too, but only
    // presentation mode blurs it - screenshot privacy leaves your own label readable.
    // The note lives here rather than in a column of its own: most rows have no
    // note, and a column that is empty most of the time is wasted width.
    tr.innerHTML = `
      <td class="identity">
        <div class="nick${nick ? '' : ' none'}" data-pid="${esc(w.playerId)}" title="Double-click to rename"><button class="row-toggle" data-expand="${esc(w.playerId)}" type="button" title="Show previous names" aria-label="Show previous names for ${esc(w.nickname || w.playerId)}">&#9656;</button><span class="pii-nick">${nick || '(no label)'}</span>${tagChips(w)}</div>
        <div class="live"><span class="tag">in game</span><span class="pii">${live || '<span class="unknown-text">Not checked yet</span>'}</span>${unavailableBadge(w.private)}</div>
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

/* Tiles carry data-pid like rows do, so every delegated handler on #w-views -
   favourite, overflow menu, relationship change, ctrl+click selection - works
   here with no branch. What tiles deliberately do NOT get is inline rename by
   double-click: there is no room for an input without the tile jumping size, so
   rename goes through the overflow menu instead. */
function renderWatchTiles(watch) {
  const box = $('#w-tileview');
  if (!box) return;
  if (!watch.length) {
    box.innerHTML = `<div class="empty">
      <span class="empty-title">${esc(EMPTY_PEOPLE.title)}</span>
      <p>${esc(EMPTY_PEOPLE.body)}</p>${EMPTY_PEOPLE.actions}</div>`;
    return;
  }
  const parts = [];
  for (const w of sortedWatch(watch)) {
    const pid = String(w.playerId);
    const fav = (w.tags || []).includes(FAVOURITE);
    const names = (w.names || []).length;
    const label = w.nickname || '';
    /* Favourite is deliberately expressed ONCE, by the star and the card accent.
       It used to also appear as a gold chip from tagChips(), which put the same
       fact in two visual languages a centimetre apart. Every other tag still
       shows - they are the ones the chip row exists for. */
    const otherTags = (w.tags || []).filter((t) => t !== FAVOURITE);
    parts.push(`<article class="ptile${watchSel.has(pid) ? ' sel' : ''}${fav ? ' fav' : ''}"
      data-pid="${esc(pid)}" tabindex="0"
      aria-label="${esc(label || w.currentName || pid)}${fav ? ', favourite' : ''}">
      <div class="ptile-head">
        ${avatar(w)}
        <h3 class="ptile-name pii-nick${label ? '' : ' none'}" data-pid="${esc(pid)}"
          title="${esc(label ? label + ' — double-click to rename' : 'Double-click to add a label')}"
        >${esc(label) || 'No label'}</h3>
        <div class="ptile-acts">
          <button class="fav-btn" data-fav="${esc(pid)}" type="button" aria-pressed="${fav}"
            title="${fav ? 'Remove from favourites' : 'Mark as favourite'}"
            aria-label="${fav ? 'Remove from favourites' : 'Mark as favourite'}">${fav ? '&#9733;' : '&#9734;'}</button>
          <span class="menu-wrap"><button class="menu-btn" data-menu="${esc(pid)}" type="button"
            aria-haspopup="menu" aria-expanded="false"
            aria-label="More actions for ${esc(label || pid)}">&#8942;</button></span>
        </div>
      </div>
      <dl class="ptile-facts">
        <dt>In game</dt>
        <dd class="pii">${esc(w.currentName) || '<span class="unknown-text">Not checked yet</span>'}${unavailableBadge(w.private)}</dd>
        <dt>Last observed</dt>
        <dd>${seenCell(w)}</dd>
      </dl>
      <div class="ptile-foot">
        ${roleSelect(w, { compact: true })}
        ${names ? `<button class="ghost small ptile-names" data-expand="${esc(pid)}" type="button"
          title="${esc(namesLabel(names))}">${esc(names)} ${names === 1 ? 'name' : 'names'}</button>` : ''}
      </div>
      ${otherTags.length ? tagChips({ ...w, tags: otherTags }) : ''}
    </article>`);
  }
  box.innerHTML = parts.join('');
}

/* A coloured initial disc. It is not decoration: at five tiles across, the eye
   needs somewhere to land before it starts reading, and a stable colour per
   person makes a familiar tile findable without reading at all.

   The hue is derived from the player id so it never moves - a favourite that
   changed colour on rename would be worse than no colour. Chroma and lightness
   are fixed at the palette's own level so these sit inside the theme rather than
   introducing a second colour system. */
function avatar(w) {
  const seed = String(w.playerId || '');
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  const src = (w.nickname || w.currentName || '?').trim();
  // codePointAt, not [0]: an emoji or a CJK name would otherwise split a surrogate
  // pair and render a replacement character.
  const initial = src ? String.fromCodePoint(src.codePointAt(0)).toUpperCase() : '?';
  // pii-nick here too: the initial is drawn from the nickname whenever one is set,
  // so it sits right next to the blurred label leaking its first letter otherwise.
  return `<span class="ptile-avatar pii-nick" aria-hidden="true" style="--h:${h}">${esc(initial)}</span>`;
}

/* ---- row overflow menu ----------------------------------------------------
   Six buttons per row made every row look equally urgent and made Remove as
   easy to hit as Rename. Only the two controls that actually get used per
   session stay visible; everything else lives one click deeper, with the
   destructive action separated and last. */
let openMenu = null;      // {el, trigger}

/* Places the open menu against its trigger in viewport coordinates.

   Right-aligned to the trigger so it hangs back into the card rather than off
   the edge, flipped above when there is not room below, and clamped to the
   viewport on both axes so a tile in the last column or the last row can still
   show a full menu. Re-run on scroll and resize because the menu is fixed and
   the trigger is not - they would otherwise drift apart. */
function positionRowMenu() {
  if (!openMenu) return;
  const { el, trigger } = openMenu;
  const t = trigger.getBoundingClientRect();
  const m = el.getBoundingClientRect();
  const GAP = 4, EDGE = 8;

  const below = window.innerHeight - t.bottom;
  const flip = below < m.height + GAP + EDGE && t.top > below;
  let top = flip ? t.top - m.height - GAP : t.bottom + GAP;
  top = Math.max(EDGE, Math.min(top, window.innerHeight - m.height - EDGE));

  let left = t.right - m.width;
  left = Math.max(EDGE, Math.min(left, window.innerWidth - m.width - EDGE));

  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
}

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
  window.removeEventListener('scroll', positionRowMenu, true);
  window.removeEventListener('resize', positionRowMenu);
}

// Capture phase: the menu must track a scroll happening in any container, not
// only the document.
window.addEventListener('scroll', () => { if (openMenu) positionRowMenu(); }, true);
window.addEventListener('resize', () => { if (openMenu) positionRowMenu(); });

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
    item('clearhistory', 'Clear history') +
    item('remove', 'Remove saved person', 'danger-item');

  /* Parented to the page, not to the row.

     It used to be appended into the trigger's own wrapper. That is fine in a
     one-column table, where the only thing below a row is the next row. In the
     tile grid it broke: sibling cards later in the DOM paint over earlier ones,
     so the menu's last items rendered on top of the neighbouring tile instead of
     over it. A popup belongs to the page, so it lives on the page and is placed
     from the trigger's rect. */
  menu.classList.add('menu-float');
  document.body.appendChild(menu);
  trigger.setAttribute('aria-expanded', 'true');
  openMenu = { el: menu, trigger };
  positionRowMenu();

  menu.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (btn) runRowAction(btn.dataset.act, btn.dataset.pid, btn);
  });

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
  if (act === 'rename') {
    if (tr) startRename(tr, playerId);
    else {
      const tile = document.querySelector(`.ptile[data-pid="${CSS.escape(String(playerId))}"]`);
      if (tile) startRenameTile(tile, playerId);
    }
    return;
  }
  if (act === 'tags') {
    const anchor = tr
      ? tr.querySelector('[data-menu]')
      : document.querySelector(`.ptile[data-pid="${CSS.escape(String(playerId))}"] [data-menu]`);
    if (anchor) openTagPicker(anchor, playerId);
    return;
  }
  if (act === 'names') {
    if (tr) {
      const btn = tr.querySelector('[data-expand]');
      if (btn) toggleHistory(btn);
    } else {
      await openPlayerSheet(playerId);
    }
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
  if (act === 'clearhistory') {
    const label = (w && w.nickname) || (w && w.currentName) || `player ${playerId}`;
    // Scope verified against db.clearPlayerHistory(), which runs inside
    // tx(["presence", "names"]): that player's presence rows (sightings) and
    // names rows (alias history) go. It never opens "watched", so the label,
    // note, tags and relationship on the row itself are untouched.
    const ok = await askConfirm({
      heading: 'Clear stored history?',
      body: `Removes stored sightings and previous names recorded for ${label}. ${label} stays on ` +
        `your saved people, with their label, note and tags unchanged. This cannot be undone.`,
      confirmLabel: 'Clear history',
    });
    if (!ok) return;
    const r = await send({ type: 'CLEAR_PLAYER_HISTORY', playerId });
    if (r.error) { toast(r.error, { tone: 'err' }); return; }
    renderWatch(r.watch || []);
    await refreshState();
    toast(`Cleared stored history for ${label}.`, { tone: 'ok' });
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
          <h2 class="pii-nick">${esc(w.nickname) || `<span class="unknown-text">No label</span>`}</h2>
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
        ${kv('Relationship', roleBadge(w.role))}
        ${kv('Tags', (w.tags || []).length ? tagChips(w) : '<span class="unknown-text">None</span>')}
        ${kv('Last observed playing', w.lastServerSeen
          ? `${esc(frelLong(w.lastServerSeen))}<div class="note">on ${esc(w.lastServerName || 'a tracked server')}</div>`
          : w.lastSeen ? `${esc(frelLong(w.lastSeen))}<div class="note">BattleMetrics global</div>`
          : '<span class="unknown-text">Never seen</span>')}
        ${kv('First seen', w.firstSeen ? esc(fdate(w.firstSeen)) : '<span class="unknown-text">Unknown</span>')}
      </div>

      <div class="sheet-section">
        <h3>Note</h3>
        <textarea id="sheet-note" rows="3" placeholder="How do you know them? e.g. medic on the Thursday op">${esc(w.note || '')}</textarea>
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
    const ta = sheet.querySelector('#sheet-note');
    const r = await send({ type: 'ADD_WATCH', entry: { playerId: pid, note: ta.value.trim() } });
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

on('#w-views', 'keydown', (e) => {
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
on('#w-views', 'change', async (e) => {
  const sel = e.target.closest('.role-select[data-role-pid]');
  if (!sel) return;
  const pid = sel.dataset.rolePid;
  const ids = (watchSel.size && watchSel.has(pid)) ? [...watchSel] : [pid];
  const r = await send({ type: 'SET_ROLE', playerIds: ids, role: sel.value });
  watchSel.clear();
  renderWatch((r && r.watch) || watchData);
  await refreshState();
});

on('#w-views', 'dblclick', (e) => {
  const nick = e.target.closest('.nick[data-pid]');
  if (nick) { startRename(nick.closest('tr'), nick.dataset.pid); return; }
  const tileName = e.target.closest('.ptile-name[data-pid]');
  if (tileName) startRenameTile(tileName.closest('.ptile'), tileName.dataset.pid);
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
    : '<span class="hist-empty">No previous names recorded. Refreshing saved people collects them.</span>';
}

/* Rename inside a tile.

   startRename below is built around the table row - it swaps the identity cell
   and rewrites the action cell. A tile has neither, and runRowAction bailed out
   entirely when it could not find a <tr>, so "Rename" from a tile's menu did
   nothing at all. This is the tile equivalent: swap the label for an input in
   place, commit on Enter or blur, abandon on Escape. */
function startRenameTile(tile, playerId) {
  const w = watchData.find((x) => String(x.playerId) === String(playerId));
  if (!w || !tile) return;
  const h = tile.querySelector('.ptile-name');
  if (!h) return;

  const inp = document.createElement('input');
  inp.className = 'rename-input ptile-rename';
  inp.value = w.nickname || '';
  inp.placeholder = 'Your label';
  inp.setAttribute('aria-label', 'Label for this person');
  h.replaceWith(inp);
  inp.focus();
  inp.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (!save) { renderWatch(watchData); return; }
    const r = await send({ type: 'ADD_WATCH', entry: { playerId, nickname: inp.value.trim() } });
    renderWatch((r && r.watch) || watchData);
    await refreshState();
  };
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  // Blur saves rather than discards: clicking away from a field you just typed
  // into should not throw the typing away.
  inp.addEventListener('blur', () => finish(true));
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
    inp.placeholder = 'Your label';
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
  // ADD_WATCH writes only the fields it is given, so sending the label alone
  // leaves the relationship, note, live name and name history untouched. A
  // rename never triggers a network lookup.
  const r = await send({ type: 'ADD_WATCH', entry: { playerId, nickname } });
  renderWatch((r && r.watch) || watchData);
  await refreshState();
}

on('#w-views', 'click', async (e) => {
  // Ctrl / Cmd + click on a row (not on a control) toggles it into the bulk set.
  if ((e.ctrlKey || e.metaKey) && !e.target.closest('button, a, select, input')) {
    const card = e.target.closest('tr[data-pid], .ptile[data-pid]');
    if (card) {
      const id = card.dataset.pid;
      if (watchSel.has(id)) watchSel.delete(id); else watchSel.add(id);
      card.classList.toggle('sel');
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
        changes.push({ label: w.nickname || w.playerId, labelled: !!w.nickname, previous: prev, current: w.currentName });
      }
    }
    watchBeforeRefresh = null;
    if (changes.length) {
      info.innerHTML = `<span class="err">${esc(changes.length)} name change(s):</span> ` +
        changes.map(c => `<b class="${c.labelled ? 'pii-nick' : 'pii'}">${esc(c.label)}</b>: ` +
          `"<span class="pii">${esc(c.previous)}</span>" to "<span class="pii">${esc(c.current)}</span>"`).join(' &middot; ');
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
  if (!rows.length) {
    // An empty result used to be indistinguishable from a broken read, which is
    // exactly what it was for a long time. Say what the page actually contained.
    const g = d.diag || {};
    const bits = [];
    if (g.tableRows) bits.push(`${g.tableRows} table rows`);
    if (g.mentionsNoResults) bits.push('the page says there are no results');
    box.innerHTML = '<span class="note">No servers found' +
      (bits.length ? `. Page seen: ${esc(bits.join(', '))}` : '') + '.</span>';
    if (d.diag) console.log('BMFinder server search diagnostic', d.diag);
    return;
  }
  /* Results arrive ranked by how well the name matches, not by how busy the
     server is, so say so: without a note the top hit looks like BattleMetrics'
     own order and a close-but-not-exact first result reads as a bug. */
  const exact = rows.filter((s) => (s.score || 0) >= 0.999).length;
  const lead = exact
    ? `Best name match${exact > 1 ? 'es' : ''} first.`
    : 'No exact name match. Closest names first.';
  box.innerHTML = `<div class="note mb-8">${esc(lead)}`
    + (d.wildcarded ? ' Your words were matched across the whole name.' : '')
    + `</div>`
    + rows.map((s) => `<div class="srvcard flex gap-10 items-center">
    <div class="grow"><b>${esc(s.name)}</b><div class="note">ID ${esc(s.id)}${
      s.score != null ? ` &middot; ${esc(Math.round(s.score * 100))}% name match` : ''}</div></div>
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
      <p>Search for a server by name above, then follow it. Live updates check
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
        ? `${esc(s.totalPolls)}`
        : '<span class="unknown-text">Never polled</span>'}</td>
      <td>${slink(s.serverId, s.game)}
        <button class="ghost" data-clearhist="${esc(s.serverId)}" type="button">Clear history</button>
        <button class="ghost" data-rm="${esc(s.serverId)}" type="button">Remove</button></td>`;
    tb.appendChild(tr);
  }
}

on('#sv-table tbody', 'click', async (e) => {
  const clearBtn = e.target.closest('[data-clearhist]');
  if (clearBtn) {
    const id = clearBtn.dataset.clearhist;
    const s = serversData.find((x) => String(x.serverId) === String(id));
    const label = (s && (s.nickname || s.name)) || id;
    // Scope verified against db.clearServerHistory(), which runs inside
    // tx(["presence", "snapshots", "roster", "stats"]): stored snapshots,
    // presence rows, the cached roster and the poll tallies behind it all go.
    // It never opens "watched" or "servers", so the tracked server itself and
    // your saved people are untouched.
    const ok = await askConfirm({
      heading: 'Clear server history?',
      body: `Removes stored snapshots, presence, roster and poll tallies recorded for ${label}. ` +
        `${label} stays in your tracked servers. This cannot be undone.`,
      confirmLabel: 'Clear history',
    });
    if (!ok) return;
    clearBtn.disabled = true;
    const r = await send({ type: 'CLEAR_SERVER_HISTORY', serverId: id });
    clearBtn.disabled = false;
    if (r.error) { toast(r.error, { tone: 'err' }); return; }
    renderServers(r.servers || []);
    await refreshState();
    toast(`Cleared stored history for ${label}.`, { tone: 'ok' });
    return;
  }
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
    t.textContent = pollState === 'running' ? 'Pause live updates'
      : pollState === 'paused' ? 'Resume live updates' : 'Start live updates';
    // Pausing mid-cycle is safe: it only stops the NEXT cycle being scheduled,
    // and the cycle in flight is allowed to finish and store its results.
    t.disabled = false;
  }
  const stop = $('#mon-stop');
  if (stop) {
    stop.disabled = pollState === 'stopped' && !inFlight;
    stop.textContent = inFlight && pollState === 'stopped' ? 'Cancel check' : 'Stop live updates';
  }
  const poll = $('#mon-poll');
  if (poll) {
    poll.disabled = !!activeJob;
    poll.textContent = inFlight ? 'Checking…'
      : (st.key === 'failed' || st.key === 'degraded') ? 'Retry check' : 'Check servers now';
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
  // A poll updates every tracked player's current name and last-seen (the worker
  // records the roster name as it stores the poll), so if the Watchlist is the
  // tab in view it has to re-render or it would keep showing pre-poll names. This
  // is the other half of the Monitor/Watchlist link: the poll feeds the
  // watchlist, and the watchlist view reflects it without a manual refresh.
  if (currentTab === 'watch') renderWatch(state.watch || []);

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
/* Said once, before live updates run for the first time.

   Turning this on is the point where BMFinder starts opening pages on its own
   and keeping a record of what it saw, so it is the point where that should be
   described - not buried in a policy page nobody opens. Shown once and then not
   again: repeating it every time would train people to dismiss it.

   The record lives in the database rather than chrome.storage.local so that
   "delete all BMFinder data" genuinely resets the extension to its first-run
   state, explanation included.

   Returns true when live updates may start. */
async function explainLiveUpdates() {
  let seen = false;
  try {
    const r = await send({ type: 'GET_SETTING', key: 'liveUpdatesExplained', dflt: false });
    seen = !!(r && r.value);
  } catch { /* treat an unreadable setting as not yet explained */ }
  if (seen) return true;

  // The real retention value, not a hardcoded one: the sentence promises a
  // specific period and must not be able to drift away from the setting.
  let days = 14;
  try {
    const r = await send({ type: 'GET_RETENTION' });
    if (r && Number(r.days)) days = Number(r.days);
  } catch { /* fall back to the documented default */ }
  const period = days === 1 ? '1 day' : `${days} days`;

  const ok = await askConfirm({
    heading: 'Enable live updates?',
    body: 'BMFinder will check your followed servers one at a time while this dashboard remains ' +
      `open. Recent observations are stored locally for ${period}. You can pause updates or ` +
      'delete the history at any time.',
    confirmLabel: 'Enable live updates',
    cancelLabel: 'Not now',
    danger: false,
    link: {
      text: 'Retention settings',
      onClick: () => {
        const tab = document.querySelector('#tabs button[data-tab="privacy"]');
        if (tab) tab.click();
        const sel = $('#priv-retentionsel');
        if (sel) { sel.scrollIntoView({ block: 'center' }); sel.focus(); }
      },
    },
  });
  if (!ok) return false;

  // Recorded only after the user agrees. Backing out leaves it unexplained, so
  // the next attempt asks again rather than starting silently.
  try { await send({ type: 'SET_SETTING', key: 'liveUpdatesExplained', value: true }); } catch { /* ask again next time */ }
  return true;
}

on('#mon-toggle', 'click', async () => {
  if (pollState === 'stopped') {
    if (!(await explainLiveUpdates())) return;
    const intervalSec = Math.max(MIN_INTERVAL_SEC, Number($('#mon-interval').value) || MIN_INTERVAL_SEC);
    const m = await setMonitorMode({ mode: 'running', intervalSec });
    if (!m) return;
    updateMonStatus();
    // The first cycle runs immediately rather than waiting a whole interval.
    startPollServers(true);
    toast(`Live updates started, checking ${fint(pollIntervalSec)}. They run while this tab is open.`, { tone: 'ok' });
  } else if (pollState === 'running') {
    await setMonitorMode({ mode: 'paused' });
    setText('#mon-pollmsg', 'Paused. Any check in flight finishes; no new ones are scheduled until you resume.');
    updateMonStatus();
  } else {
    await setMonitorMode({ mode: 'running' });
    setText('#mon-pollmsg', 'Live updates resumed.');
    updateMonStatus();
    toast('Live updates resumed.', { tone: 'ok' });
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
    : 'Live updates stopped. Stored data is kept.');
  updateMonStatus();
});
/* Changing the interval while running has to re-arm the alarm, or the picker
   would silently disagree with the schedule actually in force. */
on('#mon-interval', 'change', async () => {
  const intervalSec = Math.max(MIN_INTERVAL_SEC, Number($('#mon-interval').value) || MIN_INTERVAL_SEC);
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
          ? `<span class="has-watched">${esc(watched.length)} saved ${watched.length === 1 ? 'person' : 'people'} here</span>`
          : 'No saved people detected');

    const when = everPolled
      ? `<span class="srv-when" title="${esc(fdt(srv.pollTs))}">Updated ${esc(frelLong(srv.pollTs))}</span>`
      : '';

    const watchedHtml = watched.length
      ? `<div class="watched-list">${watched.map(p => `<div class="watched-row">
          <span class="who ${p.nickname ? 'pii-nick' : 'pii'}">${esc(p.nickname || p.name)}</span>
          ${p.nickname && p.name && p.nickname !== p.name ? `<span class="note pii">${esc(p.name)}</span>` : ''}
          ${roleBadge(p.role)}
          <span class="meta">${plink(p.id)}</span>
        </div>`).join('')}</div>`
      : '';

    const othersHtml = others.length ? `<div class="roster-more">
        <div class="roster hide" data-rosterlist="${esc(srv.serverId)}">
          ${others.map(p => `<a class="roster-name pii" href="https://www.battlemetrics.com/rcon/players/${encodeURIComponent(p.id)}" target="_blank" rel="noopener" title="${esc(p.name)}">${esc(p.name)}</a>`).join('')}
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
    // Both variants link to the player's RCON profile; only the label and class differ.
    const chips = s.shown.map(p => p.watched
      ? `<a class="chip w" href="https://www.battlemetrics.com/rcon/players/${encodeURIComponent(p.id)}" target="_blank" rel="noopener"><span class="${p.nickname ? 'pii-nick' : 'pii'}">${esc(p.nickname || p.name)}</span> ${roleBadge(p.role)}</a>`
      : `<a class="chip pii" href="https://www.battlemetrics.com/rcon/players/${encodeURIComponent(p.id)}" target="_blank" rel="noopener">${esc(p.name)}</a>`).join('');
    const hidden = (s.roster || []).length - s.shown.length;
    return `<div class="arch-snap">
      <div class="arch-head">
        <span class="arch-when">${esc(fdt(s.pollTs))}</span>
        <span class="arch-server">${esc(s.serverName || s.serverId)}</span>
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
  openExportDialog({
    purpose: 'activity',
    people: () => watchData,
    describe: () => 'Exporting recent activity. Only the checks BMFinder collected while it was ' +
      'running are stored, so this is not a complete history.',
  });
});

$('#file-import').addEventListener('change', async () => {
  const input = $('#file-import');
  const file = input.files[0];
  input.value = '';
  if (!file) return;

  const box = '#priv-importmsg';
  setMsg(box, 'Reading file...', '');

  let text;
  try {
    text = await file.text();
  } catch (err) {
    setMsg(box, 'Could not read that file: ' + ((err && err.message) || err), 'err');
    return;
  }

  /* Three things can arrive here: a full backup, a shared people list, and a
     CSV. They are told apart by their contents rather than their filename, and
     each takes a different path - a backup replaces everything, a list merges.
     Getting that wrong is how the old importer could empty the database. */
  const isCsv = /\.csv$/i.test(file.name) || (!text.trimStart().startsWith('{') && text.includes(','));

  if (isCsv) {
    const { records } = parseCsv(text);
    await importPeopleFile(records, box, `${file.name}`);
    return;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    setMsg(box, 'That file is not valid JSON or CSV: ' + ((err && err.message) || err), 'err');
    return;
  }

  const kind = detectFormat(json);

  if (kind === 'list') {
    await importPeopleFile(json.people, box, file.name, json.servers);
    return;
  }

  if (kind === 'backup') {
    const check = validateBackup(json);
    if (!check.ok) {
      setMsg(box, 'That backup is damaged: ' + check.problems.join(' '), 'err');
      return;
    }
    openImportDialog(json, file.name);
    return;
  }

  setMsg(box, 'That file is not a BMFinder backup or people list, so nothing was changed.', 'err');
});

/* The merge path, shared by BMFinder lists and CSV.

   The plan is computed and shown before anything is written: how many are new,
   how many already saved, which labels disagree, and which rows could not be
   read. Overwriting a label you wrote by hand is the only irreversible part, so
   it is opt-in and names the people affected. */
async function importPeopleFile(records, box, filename, servers) {
  const plan = planPeopleImport(records, state.watch || [], { defaultRelationship: 'other' });
  const serverPlan = planServerImport(servers, state.servers || []);

  if (!plan.add.length && !plan.update.length) {
    const why = plan.errors.length
      ? ` None of the ${plan.total} rows could be read: ${plan.errors[0]}`
      : '';
    setMsg(box, `Nothing to import from ${filename}.${why}`, 'err');
    return;
  }

  const parts = [];
  if (plan.add.length) parts.push(`${plan.add.length} new`);
  if (plan.update.length) parts.push(`${plan.update.length} already saved`);
  let body = `${filename} holds ${plan.total} ${plan.total === 1 ? 'person' : 'people'}: ${parts.join(', ')}. `
    + 'New people are added; people you already have keep their own label unless you choose otherwise.';
  if (plan.errors.length) {
    body += ` ${plan.errors.length} ${plan.errors.length === 1 ? 'row' : 'rows'} could not be read and will be skipped.`;
  }
  if (plan.labelConflicts.length) {
    const sample = plan.labelConflicts.slice(0, 3)
      .map((c) => `"${c.current}" would become "${c.incoming}"`).join('; ');
    body += ` ${plan.labelConflicts.length} of your labels differ from the file (${sample}${plan.labelConflicts.length > 3 ? '; and more' : ''}).`;
  }

  const ok = await askConfirm({
    heading: 'Import these people?',
    body,
    confirmLabel: plan.labelConflicts.length ? 'Import, keeping my labels' : 'Import',
    cancelLabel: 'Cancel',
    danger: false,
  });
  if (!ok) { setMsg(box, 'Import cancelled. Nothing was changed.', ''); return; }

  const r = await send({ type: 'IMPORT_PEOPLE', plan, serverPlan, overwriteLabels: false });
  if (r.error) { setMsg(box, 'Import failed: ' + r.error, 'err'); return; }

  const msg = `Imported ${r.added} new, updated ${r.updated}.`
    + (serverPlan.add.length ? ` ${serverPlan.add.length} servers followed.` : '')
    + (plan.errors.length ? ` ${plan.errors.length} skipped.` : '');
  setMsg(box, msg, 'ok');
  toast(msg, { tone: 'ok' });
  await afterImportRefresh();
}

/* ---- selective import ------------------------------------------------------

   The mirror of the export dialog. A backup is read first, then the user picks
   which parts of it to take. Anything unticked is never written - importing a
   friend's backup for its people list does not drag their server checks along
   with it.

   Merge is the default because it cannot lose anything: it only adds rows whose
   key is absent. Replace is the destructive option and says so, behind an
   acknowledgement that names what will go. */
let importFile = null;

function impParts() {
  return [...$$('#impd-parts input[data-p]')].filter((i) => i.checked).map((i) => i.dataset.p);
}
function impMode() {
  return ($('#impd-mode input:checked') || {}).value || 'merge';
}

function impSyncWarning() {
  const replacing = impMode() === 'replace';
  const parts = impParts();
  const box = $('#impd-warn');
  box.classList.toggle('hide', !replacing || !parts.length);
  $('#impd-ack').checked = false;

  if (replacing && parts.length) {
    const names = parts.map((p) => (IMPORT_PARTS[p] || {}).label || p);
    // Say what is actually at stake, using what is here now rather than a
    // generic warning about data.
    const held = [];
    if (parts.includes('people') && (state.watch || []).length) held.push(`${state.watch.length} saved people`);
    if (parts.includes('servers') && (state.servers || []).length) held.push(`${state.servers.length} followed servers`);
    $('#impd-warn-body').textContent =
      `${names.join(', ')} will be cleared and replaced with what the file holds`
      + (held.length ? `. You currently have ${held.join(' and ')}, and anything not in the file will be gone` : '')
      + '.';
  }
  impSyncGo();
}

function impSyncGo() {
  const needAck = !$('#impd-warn').classList.contains('hide');
  $('#impd-go').disabled = !impParts().length || (needAck && !$('#impd-ack').checked);
}

function openImportDialog(json, filename) {
  importFile = json;
  const summary = summariseBackup(json);
  $('#impd-scope').textContent = `${filename} — tick what you want to bring in. Anything you leave `
    + 'unticked is ignored.';

  for (const [key, info] of Object.entries(summary)) {
    const box = $(`#impd-parts input[data-p="${key}"]`);
    const note = $(`#impd-count-${key}`);
    if (note) {
      note.textContent = info.present
        ? `${info.count} in this file`
        : 'not in this file';
    }
    if (box) {
      // Nothing to import means nothing to tick.
      box.disabled = !info.present || info.count === 0;
      if (box.disabled) box.checked = false;
      box.closest('label').classList.toggle('locked', box.disabled);
    }
  }

  setMsg('#impd-msg', '', '');
  impSyncWarning();
  $('#impd-scrim').classList.remove('hide');
  $('#impd-dialog').classList.remove('hide');
  $('#impd-go').focus();
}

function closeImportDialog() {
  $('#impd-scrim').classList.add('hide');
  $('#impd-dialog').classList.add('hide');
  importFile = null;
}

on('#impd-parts', 'change', impSyncWarning);
on('#impd-mode', 'change', impSyncWarning);
on('#impd-ack', 'change', impSyncGo);
on('#impd-cancel', 'click', () => {
  closeImportDialog();
  setMsg('#priv-importmsg', 'Import cancelled. Nothing was changed.', '');
});
on('#impd-scrim', 'click', () => {
  closeImportDialog();
  setMsg('#priv-importmsg', 'Import cancelled. Nothing was changed.', '');
});

on('#impd-go', 'click', async () => {
  if (!importFile) return;
  const parts = impParts();
  const mode = impMode();
  if (!parts.length) return;

  setMsg('#impd-msg', 'Importing…', '');
  const r = await send({ type: 'IMPORT_PARTS', json: importFile, parts, mode });
  if (r.error) { setMsg('#impd-msg', 'Import failed: ' + r.error, 'err'); return; }

  const counts = (r.result && r.result.counts) || {};
  const written = Object.values(counts).reduce((a, b) => a + b, 0);
  const msg = mode === 'replace'
    ? `Replaced ${parts.length} ${parts.length === 1 ? 'area' : 'areas'} with ${written} records.`
    : `Added ${written} new ${written === 1 ? 'record' : 'records'}. Nothing existing was changed.`;

  closeImportDialog();
  setMsg('#priv-importmsg', msg, 'ok');
  toast(msg, { tone: 'ok' });
  await afterImportRefresh();
  await loadPrivacyPanel();
});

on('#priv-import', 'click', () => $('#file-import').click());

async function afterImportRefresh() {
  await refreshState();
  renderWatch(state.watch || []);
  renderServers(state.servers || []);
  updateMonStatus();
  await loadOnline();
}

/* ============================ DATA AND PRIVACY ============================= */

// Storage estimates arrive in bytes; nobody reads "8214531 bytes" at a glance.
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

async function loadPrivacySummary() {
  const r = await send({ type: 'DATA_SUMMARY' });
  if (r.error) return; // transient failure: leave the last good numbers on screen rather than blank them
  const s = r.summary || {};
  setValue('#priv-people', s.people);
  setValue('#priv-servers', s.servers);
  setValue('#priv-checks', s.observations);
  // oldestObservation is null when there are no observations stored at all, which
  // db.dataSummary() and the worker both treat the same as "unknown" rather than
  // "zero" - see the DATA_SUMMARY contract - so this renders identically to the
  // storage estimate being unavailable, not as a blank date or a fabricated one.
  setValue('#priv-oldest', s.oldestObservation ? fdate(s.oldestObservation) : null, { unknownAs: 'Not available' });
  setText('#priv-oldestsub', s.oldestObservation ? frelLong(s.oldestObservation) : '');
  setValue('#priv-storage', s.bytes != null ? fmtBytes(s.bytes) : null, { unknownAs: 'Not available' });
}

async function loadPrivacyRetention() {
  const r = await send({ type: 'GET_RETENTION' });
  const days = (r && !r.error && r.days) || 14;
  const sel = $('#priv-retentionsel');
  if (sel) sel.value = String(days);
  setValue('#priv-retentionval', `${days} day${days === 1 ? '' : 's'}`);
  return days;
}

async function loadPrivacyPanel() {
  await Promise.all([loadPrivacySummary(), loadPrivacyRetention()]);
}

on('#priv-retentionsel', 'change', async (e) => {
  const sel = e.target;
  sel.disabled = true;
  const r = await send({ type: 'SET_RETENTION', days: Number(sel.value) });
  sel.disabled = false;
  if (r.error) { setMsg('#priv-retentionmsg', r.error, 'err'); return; }
  const p = r.pruned || {};
  const removedAny = (p.presence || 0) + (p.snapshots || 0) > 0;
  const days = r.days;
  setMsg('#priv-retentionmsg', removedAny
    ? `Retention set to ${days} day${days === 1 ? '' : 's'}. Removed ${p.presence || 0} activity ` +
      `record${p.presence === 1 ? '' : 's'} and ${p.snapshots || 0} server check${p.snapshots === 1 ? '' : 's'} ` +
      `outside the new window.`
    : `Retention set to ${days} day${days === 1 ? '' : 's'}. Nothing was outside the new window.`, 'ok');
  toast(`Retention set to ${days} day${days === 1 ? '' : 's'}.`, { tone: 'ok' });
  await loadPrivacySummary();
});

on('#priv-clearactivity', 'click', async () => {
  const ok = await askConfirm({
    heading: 'Clear recent activity?',
    body: 'Removes stored snapshots and presence history collected so far, the same records ' +
      'retention prunes automatically. Saved people, labels, tags and followed servers are kept. ' +
      'This cannot be undone.',
    confirmLabel: 'Clear recent activity',
  });
  if (!ok) return;
  const btn = $('#priv-clearactivity');
  btn.disabled = true;
  const r = await send({ type: 'CLEAR_POLLS' });
  btn.disabled = false;
  if (r.error) { setMsg('#priv-clearmsg', r.error, 'err'); return; }
  const c = r.cleared || {};
  setMsg('#priv-clearmsg', `Cleared ${c.snapshots || 0} snapshots and ${c.presence || 0} presence rows.`, 'ok');
  toast(`Cleared ${c.snapshots || 0} stored snapshots.`, { tone: 'ok' });
  lastPollResult = null;
  await refreshState();
  updateMonStatus();
  await loadOnline();
  if (currentTab === 'archive') await loadArchive();
  await loadPrivacySummary();
});

on('#priv-removepeople', 'click', async () => {
  const ids = (state.watch || []).map((w) => String(w.playerId));
  if (!ids.length) { setMsg('#priv-peoplemsg', 'No saved people to remove.', ''); return; }
  // Scope verified against db.removeWatch(), which runs inside
  // tx(["watched", "names"]): it deletes the watched row itself (carrying the
  // nickname, note and tag fields with it) and that player's rows in "names".
  // It never opens "presence", so observations recorded on tracked servers are
  // untouched - they age out under retention or via "Clear recent activity"
  // like any other observation, not through this control.
  const ok = await askConfirm({
    heading: 'Remove all saved people?',
    body: `Removes all ${ids.length} saved ${ids.length === 1 ? 'person' : 'people'} from your ` +
      `saved people list, including their label, note, tag assignments and recorded name history. ` +
      `Observations already recorded on your followed servers are not removed by this - they stay ` +
      `until retention prunes them or you clear recent activity. You can undo the removal itself ` +
      `immediately afterwards.`,
    confirmLabel: 'Remove all saved people',
  });
  if (!ok) return;
  const btn = $('#priv-removepeople');
  btn.disabled = true;
  // Same loop the Watchlist's own "Remove selected" bulk action uses, and for the
  // same reason it skips the two-click arm pattern used elsewhere on this page:
  // REMOVE_WATCH hands back a restorable snapshot per player, so this is genuinely
  // undoable and does not need a second confirmation on top of the dialog above.
  const { ok: succeeded, failed, removed } = await removeBatch('REMOVE_WATCH', 'playerId', ids);
  btn.disabled = false;
  await refreshState();
  renderWatch(state.watch || []);
  const msg = batchResultText(succeeded, failed, 'person', 'people');
  setMsg('#priv-peoplemsg', msg, failed ? 'err' : 'ok');
  offerUndoRemoval(removed, msg);
  await loadPrivacySummary();
});

on('#priv-removeservers', 'click', async () => {
  const ids = (state.servers || []).map((s) => String(s.serverId));
  if (!ids.length) { setMsg('#priv-serversmsg', 'No followed servers to remove.', ''); return; }
  // Scope verified against db.removeServer(), which runs inside
  // tx(["servers", "roster", "stats"]): it deletes the tracked-server row, its
  // cached roster rows and its stats rows. It never opens "presence" or
  // "snapshots", so history already recorded while the server was tracked is
  // not removed by this - it stays until retention prunes it or you clear
  // recent activity, the same as removeWatch above.
  const ok = await askConfirm({
    heading: 'Remove all followed servers?',
    body: `Removes all ${ids.length} followed ${ids.length === 1 ? 'server' : 'servers'} from your ` +
      `tracked list. Snapshots and presence already recorded while tracked are not removed by this - ` +
      `they stay until retention prunes them or you clear recent activity. Saved people and their ` +
      `history are not affected. This removal itself cannot be undone.`,
    confirmLabel: 'Remove all followed servers',
  });
  if (!ok) return;
  const btn = $('#priv-removeservers');
  btn.disabled = true;
  // No RESTORE_SERVER exists (unlike REMOVE_WATCH/RESTORE_WATCH), so unlike the
  // saved-people control above this genuinely cannot offer an undo.
  const { ok: succeeded, failed } = await removeBatch('REMOVE_SERVER', 'serverId', ids);
  btn.disabled = false;
  await refreshState();
  renderServers(state.servers || []);
  const msg = batchResultText(succeeded, failed, 'server', 'servers');
  setMsg('#priv-serversmsg', msg, failed ? 'err' : 'ok');
  toast(msg, { tone: failed ? 'err' : 'ok' });
  await loadPrivacySummary();
});

on('#priv-resetlabels', 'click', async () => {
  const ok = await askConfirm({
    heading: 'Reset labels and tags?',
    body: "Clears every saved person's nickname, note and tag assignments. Relationships are kept. " +
      'The tag catalogue itself is kept too: your tags stay defined, but nothing stays tagged. ' +
      'This cannot be undone.',
    confirmLabel: 'Reset labels and tags',
  });
  if (!ok) return;
  const btn = $('#priv-resetlabels');
  btn.disabled = true;
  const r = await send({ type: 'RESET_LABELS' });
  btn.disabled = false;
  if (r.error) { setMsg('#priv-resetmsg', r.error, 'err'); return; }
  renderWatch(r.watch || []);
  tagList = r.tags || [];
  renderTagList();
  await refreshState();
  setMsg('#priv-resetmsg', 'Cleared nicknames, notes and tag assignments for every saved person.', 'ok');
  toast('Labels and tags reset.', { tone: 'ok' });
});

on('#priv-export', 'click', () => openExportDialog({
  purpose: 'backup',
  people: () => watchData,
  describe: () => 'Exporting everything stored in this browser profile.',
}));

/* ---- delete all: the one action that gates on typed confirmation ----------
   Kept separate from askConfirm() above rather than adding a "require typed
   text" option to it, so that stronger gate can never accidentally apply to,
   or be missing from, any control other than this one. */
function openDeleteAllDialog() {
  const inp = $('#delall-input'), btn = $('#delall-confirm');
  if (inp) inp.value = '';
  if (btn) btn.disabled = true;
  setMsg('#delall-msg', '', '');
  $('#delall-scrim').classList.remove('hide');
  $('#delall-dialog').classList.remove('hide');
  document.addEventListener('keydown', delallKeydown, true);
  if (inp) inp.focus();
}
function closeDeleteAllDialog() {
  $('#delall-scrim').classList.add('hide');
  $('#delall-dialog').classList.add('hide');
  document.removeEventListener('keydown', delallKeydown, true);
  const trigger = $('#priv-deleteall');
  if (trigger) trigger.focus();
}
function delallKeydown(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeDeleteAllDialog(); }
}
on('#priv-deleteall', 'click', openDeleteAllDialog);
on('#delall-cancel', 'click', closeDeleteAllDialog);
on('#delall-scrim', 'click', closeDeleteAllDialog);
on('#delall-input', 'input', (e) => {
  const btn = $('#delall-confirm');
  if (btn) btn.disabled = e.target.value.trim() !== 'DELETE';
});
on('#delall-confirm', 'click', async () => {
  const inp = $('#delall-input');
  // The disabled attribute is a convenience, not the gate: a disabled button can
  // still receive a synthetic click, and this is the one action in the app that
  // cannot be undone, so the actual typed value is re-checked here too.
  if (!inp || inp.value.trim() !== 'DELETE') return;
  const btn = $('#delall-confirm');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Deleting...';
  const r = await send({ type: 'DELETE_ALL_DATA' });
  btn.textContent = original;
  if (r.error) { btn.disabled = false; setMsg('#delall-msg', r.error, 'err'); return; }
  closeDeleteAllDialog();
  toast('All BMFinder data has been deleted from this browser profile.', { tone: 'ok' });
  // Deleting everything also wipes settings (retention included), so every
  // surface that caches worker state needs a real reload, not just the panel
  // the user happened to trigger this from.
  watchSel.clear();
  closeRowMenu();
  closeSheet();
  await refreshState();
  renderWatch(state.watch || []);
  renderServers(state.servers || []);
  await loadTags();
  updateMonStatus();
  await loadOnline();
  if (currentTab === 'archive') await loadArchive();
  await loadPrivacyPanel();
});

/* ============================ BROADCASTS ==================================== */

function onProgress(msg) {
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
  /* Each branch returns rather than chaining with else, so the enumeration ones
     can be stripped without leaving a dangling else behind them. */
  if (summary.kind === 'watchlist') finishWatchlistRefresh(summary);
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

/* Presentation mode: the stricter form of screenshot privacy, for when someone
   else is looking at your screen.

   Screenshot privacy lets you hover to check a row, which is right when you are
   alone and wrong when you are sharing. Here nothing un-blurs, exports are
   disabled, and leaving takes a deliberate click on a bar that will not go away
   on its own - forgetting the mode is off is the failure this guards against.

   It is presentation only, and the copy says so: nothing is removed from
   storage, and turning it off shows everything again. */
async function initPresentation() {
  // Not named `on`: that is the module-level event-binding helper, and shadowing
  // it here would break every binding made inside this function.
  let active = false;
  try { const g = await chrome.storage.local.get('bmfPres'); active = !!(g && g.bmfPres); } catch { /* first run */ }

  const bar = document.createElement('div');
  bar.className = 'pres-bar hide';
  bar.id = 'pres-bar';
  bar.setAttribute('role', 'status');
  bar.innerHTML =
    '<span class="pres-dot" aria-hidden="true"></span>' +
    '<span class="grow">Presentation mode is on. Names and player IDs stay blurred, and exports are ' +
    'disabled. This only affects what is shown &mdash; nothing has been deleted.</span>' +
    '<button type="button" id="pres-exit">Turn off</button>';
  document.body.appendChild(bar);

  const apply = () => {
    document.body.classList.toggle('pres-on', active);
    bar.classList.toggle('hide', !active);
    const btn = $('#btn-presentation');
    if (btn) { btn.setAttribute('aria-pressed', String(active)); btn.classList.toggle('active', active); }
    /* Tooltips carry names and ids too, so they come off entirely. Stashed on
       the element rather than rebuilt, because many are generated per row and
       there is no other copy of them to restore from. */
    for (const el of $$('[title]')) {
      if (el.closest('.pres-bar')) continue;
      if (el.dataset.presTitle === undefined) el.dataset.presTitle = el.getAttribute('title');
      el.removeAttribute('title');
    }
    if (!active) {
      for (const el of $$('[data-pres-title]')) {
        el.setAttribute('title', el.dataset.presTitle);
        delete el.dataset.presTitle;
      }
    }
  };

  const set = async (next) => {
    active = next;
    apply();
    try { await chrome.storage.local.set({ bmfPres: active }); } catch { /* ignore */ }
  };

  apply();
  on('#btn-presentation', 'click', () => set(!active));
  bar.querySelector('#pres-exit').addEventListener('click', () => set(false));

  /* Rows are re-rendered constantly (every poll, every sort, every filter), and
     each re-render brings back title attributes this mode has to strip. A
     MutationObserver keeps the promise true for markup that did not exist when
     the mode was switched on. */
  new MutationObserver(() => { if (active) apply(); })
    .observe(document.body, { childList: true, subtree: true });
}

/* ============================ INIT ==================================== */

/* The consent gate.

   The worker refuses to poll or persist without an accepted disclosure, so
   without this check the dashboard would simply appear broken - every action
   quietly doing nothing. Sending the user to the page that explains why is the
   honest version of that failure.

   Checked before anything else on the page runs. A failed check is treated as
   "not accepted": if the worker cannot answer, nothing should proceed anyway. */
(async () => {
  try {
    const r = await send({ type: 'DISCLOSURE_GET' });
    if (!r || !r.accepted) location.replace(chrome.runtime.getURL('pages/welcome.html'));
  } catch {
    location.replace(chrome.runtime.getURL('pages/welcome.html'));
  }
})();

/* Tell the worker this page exists. Monitoring only runs while a dashboard is
   open, so this port is what permits it: connecting arms the schedule the user
   left on, and closing the tab drops the port and stops it. The worker also
   verifies with a tab query, so a dropped port never causes a silent poll
   behind the user's back - but reconnecting keeps the stop prompt.

   The worker is a service worker and will be torn down when idle, which
   disconnects the port through no fault of this page. Reconnecting on a short
   delay re-establishes the signal without spinning if the worker is genuinely
   gone. */
function connectToWorker() {
  let port;
  try {
    port = chrome.runtime.connect({ name: 'bmf-dashboard' });
  } catch {
    return; // Extension reloading or shutting down; nothing useful to do.
  }
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // Expected on worker teardown; not an error here.
    setTimeout(connectToWorker, 1000);
  });
}
connectToWorker();

initTheme();
initObfuscate();
initPresentation();
// Restore the view before the first render, so the list does not flash in and
// get replaced by tiles a moment later.
chrome.storage.local.get('bmfWatchView')
  .then((g) => { if (g && g.bmfWatchView === 'tiles') setWatchView('tiles'); })
  .catch(() => { /* first run */ });
loadTags();
showMigrationNotice();
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
