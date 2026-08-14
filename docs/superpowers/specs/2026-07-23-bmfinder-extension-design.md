# BMFinder browser extension - design

Date: 2026-07-23
Status: approved, ready to implement

## Why this exists

BMFinder started as a local Python tool, then a Cloudflare Worker. Both are dead
ends for reasons that are now proven rather than assumed:

- **The public API is paywalled.** Since July 2026 `api.battlemetrics.com` answers
  `403 "Access denied. A subscription is required to use the API."` to anonymous
  callers, from any IP we tested (residential and datacenter alike).
- **Cloudflare Workers cannot reach it at all.** Worker subrequests carry an
  unremovable `CF-Worker` header and get `403 error code: 1106` before BattleMetrics
  ever evaluates credentials.
- **A session cookie does not help.** Verified: the same 403 with a cookie attached.
- **HTML scraping from a script works for ~20 requests, then dies.** Cloudflare
  starts returning `403 Cf-Mitigated: challenge`. A real browser passes because it
  holds a `cf_clearance` token; a scripted client cannot.
- **Their internal `/_api/` needs a request signature we cannot produce.** Confirmed
  from inside a real page: `window.fetch` is still native (they do not patch it), so
  a page-context call returns `401 "Missing API request signature."` The signing
  happens inside their own module code. Reproducing it means defeating their
  anti-bot control, which is out of scope by choice.

What does work: a real browser, logged in, rendering pages normally. So the
extension reads what the browser already renders. Their page makes its own signed
request, React paints the result, we read the DOM. Nothing is forged.

## Architecture

Chromium Manifest V3 extension (Brave, Chrome, Edge).

```
content script  -- reads rendered pages, extracts structured data
      |  chrome.runtime.sendMessage
      v
background worker  -- job queue, hidden-tab driver, storage writes, correlation
      ^  chrome.runtime.sendMessage
      |
dashboard page + popup  -- UI only, never touches storage directly
```

The worker is the only writer to storage. UI surfaces ask it for data and send it
commands. This keeps the queue and the rate discipline in one place.

### Data collection

**Passive.** Any BattleMetrics page the user opens is read and recorded. No extra
requests, indistinguishable from browsing.

**Active (on demand).** The user triggers a refresh. The worker walks the target
list one item at a time through a *single reused hidden tab*, with a delay between
each. Sequential by design: ~20 rapid scripted requests is what earned a Cloudflare
challenge during testing.

**Scheduled.** Same queue on a timer. Built behind a setting, shipped **off**.

## Module contracts

Subagents build to these. Do not change a signature without updating this file.

### `lib/extract.js`

All DOM selectors live here and nowhere else, so a BattleMetrics redesign breaks
exactly one file.

```js
export const EXTRACTOR_VERSION;                  // 'YYYY-MM-DD' marker
export function detectPageType(url, doc);        // 'player'|'server'|'search'|'serversearch'|'unknown'
export function extractPlayer(doc, url);         // {id, name, private} | null
export function extractServer(doc, url);         // {info:{id,name,players,maxPlayers}, roster:[{id,name}]} | null
export function extractSearch(doc);              // [{id, name}]
export function extractServerSearch(doc);        // [{id, name}]
export function selfTest(doc, url);              // {ok:boolean, failures:string[]}
```

Two traps found while testing against live pages, both handled here and both the
kind of thing a redesign reintroduces:

- **A player page carries ~39 `/players/` links that are not players**, such as
  `/players/1/sessions` and `/players/1?servers[87259]=7D`. Matching loosely turns
  "Session History" into a player and poisons server rosters. Only a bare
  `/players/<id>` path with no query counts.
- **Every `h1` on a server page belongs to the cookie consent dialog.** The server
  name lives in an `h2` with a "Connect" button glued on. Heading lookup skips
  anything inside a dialog and falls back through `h1` then `h2`.

Every function returns `null` or `[]` when the expected shape is missing. It never
guesses. A failed extraction must surface in the UI, not write a blank name.

### `lib/db.js` (IndexedDB, database `bmfinder`)

Object stores mirror the SQLite schema already in use:

| store | key | fields |
|---|---|---|
| `watched` | `playerId` | nickname, role (admin/suspect/other), note, currentName, private, addedAt, lastChecked |
| `names` | `[playerId, name]` | firstSeen, lastSeen |
| `servers` | `serverId` | nickname, note, name, addedAt, lastChecked, totalPolls, adminPolls |
| `snapshots` | auto | serverId, pollTs, players, maxPlayers, adminHere |
| `roster` | `[serverId, playerId]` | playerName, pollTs |
| `stats` | `[playerId, serverId]` | lastName, total, absent, present, firstSeen, lastSeen |

```js
export const db = {
  init(),
  listWatch(), addWatch({playerId,nickname,role,note}), removeWatch(playerId),
  setCurrentName(playerId, name, isPrivate), recordNames(playerId, names),
  adminIds(),
  listServers(), addServer({serverId,nickname,note}), removeServer(serverId),
  updateServerMeta(serverId, name),
  recordPoll({serverId, ts, info, roster, admins}),
  currentOnline(), stats(),
  allStats(), serversWithAdminActivity(),
  getSetting(key, dflt), setSetting(key, value),
  exportAll(), importAll(json),
};
```

`recordPoll` carries the rolling-tally rule: for each non-admin in the roster,
`total += 1` and either `absent += 1` or `present += 1` depending on whether any
watched admin was on that server at that moment. Admins are never scored.

### Messaging

```js
// content -> worker
{type:'PAGE_DATA', pageType, url, data}
{type:'EXTRACT_FAILED', url, failures}

// ui -> worker
{type:'GET_STATE'} {type:'REFRESH_WATCHLIST'} {type:'POLL_SERVERS'}
{type:'ADD_WATCH', ...} {type:'REMOVE_WATCH', playerId}
{type:'ADD_SERVER', ...} {type:'REMOVE_SERVER', serverId}
{type:'SEARCH', query, mode}          // mode 'playerid' opens the profile directly
{type:'SERVER_SEARCH', query, game}
{type:'SCAN', start, count, direction, target, threshold, delayMs}
{type:'CORRELATION', min}
{type:'EXPORT'} {type:'IMPORT', json}

// worker -> ui (broadcast)
{type:'PROGRESS', done, total, current}
{type:'DONE', summary}
{type:'ERROR', message}
```

### `lib/match.js`

Port of the tested Python scorer: lowercase, fold separators (space `_` `-` `.` `|`
`/` `\`) to single spaces, exact match scores 1, substring boosts to
`0.9 + 0.1*(q.length/n.length)`, and each whitespace token is compared too.

### `lib/correlation.js`

Port of the tested SQL. Rank non-admin players by `absent / total`. Only count
servers where an admin has actually been seen (`adminPolls > 0`), otherwise
"absent" is meaningless and flags everyone. Apply a minimum-sightings floor.

## UI

Dashboard page with the existing five tabs and dark styling ported from
`local/index.html`: Search, ID Scan, Watchlist, Servers, Monitor. Popup is thin:
who you are looking at, a track button, current counts.

Backup matters more than before, because data now lives in the browser profile
rather than a file the user can copy. Export and import JSON are first-class.

## Known limits (state these in the UI, do not hide them)

- **ID Scan costs one page load per ID.** Slow, and the most bot-shaped feature
  here. Capped and labelled.
- **Correlation only accumulates while the browser is open**, so it stays a lead
  rather than evidence.
- **Selectors break on redesign.** Mitigated by one file plus `selfTest`.
- **This is automated reading of someone else's site.** Keeping volume close to
  human is a design constraint.

## Testing

- Node unit tests for `match.js` and `correlation.js`, reusing the cases that
  already passed against SQLite.
- `extract.js` tested against saved HTML fixtures.
- Manual load-unpacked check in Brave.

## Build split

Cheaper models: manifest, dashboard markup and CSS port, IndexedDB module, popup.
Opus: extraction, correlation, worker orchestration, and review of everything
before it lands.
