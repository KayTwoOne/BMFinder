# BMFinder

Private BattleMetrics tracking tool for Arma 3 anti-cheat work.

## Which of these three builds actually works

The repository holds three implementations. **Only the browser extension works
today.** Read this before following any deployment instructions below.

| Path | Status | Why |
| --- | --- | --- |
| **`extension/`** | **Working. This is the product.** | Drives a tab in your own logged-in browser, so it never needs API access. |
| `src/` (Cloudflare Worker) | **Dead.** Parked, not deployed. | Two independent blockers, see below. |
| `local/` (Python, `localhost:8765`) | **Dead** against the public API. | Depends on `api.battlemetrics.com`, which is paywalled. |

In **July 2026 BattleMetrics closed anonymous API access**: `api.battlemetrics.com`
now answers `403 "A subscription is required to use the API."` That alone stops
`local/` and the Worker's `src/bmapi.js`. The Worker has a second, independent
blocker: Cloudflare stamps an unremovable `CF-Worker` header on subrequests and
BattleMetrics rejects those with error 1106, so a Worker cannot reach the API even
*with* a subscription. `wrangler.toml` is parked accordingly — its `[[routes]]`
block is commented out and **`bmfinder.dotkay.dev` is not currently serving**.

The extension exists because a real, logged-in browser is the only access path
BattleMetrics still permits. Its own setup notes are in
[`extension/README.md`](extension/README.md).

The Worker and Python code are kept for reference and would need a paid API
subscription (and, for the Worker, a non-Cloudflare egress) to run again. Treat
everything below this line as historical.

---

## Worker notes (historical — not deployed)

### Why it's gated (read before touching the assets config)

`noindex` and `robots.txt` do **not** hide anything. The subdomain is published in
public **Certificate Transparency logs** the moment Cloudflare issues its TLS cert —
anyone can enumerate `*.dotkay.dev` via `crt.sh`. Obscurity is not a control here.

That matters more than usual: this database records **which admins are watched and
when they're online** — exactly the intel the people being tracked would want. So:

- **`run_worker_first = true` in `wrangler.toml` is required, not cosmetic.**
  Without it the assets layer serves `./public` directly and never invokes the
  Worker, silently handing `index.html` to anonymous visitors. Verified: with the
  flag off, a signed-out `GET /` returned the full app.
- The Worker **fails closed**: no `ADMIN_PASSWORD` ⇒ everything denied.
- The login page is served **inline from the Worker**, never from `/public`, so no
  asset request can leak the app shell.
- Failed logins are **throttled per IP** (5 fails / 15 min ⇒ 15 min lockout). A
  per-request delay alone is useless: Worker invocations run in parallel.
  ⚠️ This applies to you too — five fat-fingered attempts means a 15-minute wait.

## Deploy to bmfinder.dotkay.dev

```bash
cd "personal website/bmfinder"
npm install

# 1. Create the database, then paste the printed id into wrangler.toml
npx wrangler d1 create bmfinder

# 2. Apply the schema
npm run schema:remote

# 3. Secrets — reuse your ATAC admin password
npx wrangler secret put ADMIN_PASSWORD
# optional: npx wrangler secret put ADMIN_SECRET   (HMAC key; defaults to the password)
# optional: npx wrangler secret put BM_TOKEN       (raises the BM rate limit)

# 4. Ship — this also provisions DNS + TLS for the custom domain
npm run deploy
```

The `[[routes]] custom_domain = true` block in `wrangler.toml` creates the
`bmfinder.dotkay.dev` DNS record and certificate on deploy — no dashboard steps.
`dotkay.dev` must already be a zone on the same Cloudflare account (it is).

Then visit <https://bmfinder.dotkay.dev/> — you should get the **Restricted** login
page, *not* the app. If you see the app while signed out, `run_worker_first` is off.

### Strongly recommended: an edge rate-limit rule

The in-app throttle is defence in depth; the real control belongs at the edge,
before a request ever costs you a Worker invocation:

> Cloudflare dashboard → **Security → WAF → Rate limiting rules → Create**
> · If URI Path equals `/api/auth/login`
> · Rate: **5 requests per 1 minute** per IP · Action: **Block** (1 min timeout)

Local dev: `cp .dev.vars.example .dev.vars`, `npm run schema:local`, `npm run dev`.

## Tests

```bash
npm test     # node --test, zero dependencies (node:sqlite is built in)
```

Covers the correlation engine — the only real logic here — by running the **exact**
SQL `store.js` exports against real SQLite (D1 *is* SQLite): that the admin-avoider
ranks first, that servers with no admin activity are never scored, that the
minimum-sightings floor holds, and that the batched multi-row upsert accumulates
tallies instead of overwriting them.

## Stack

| Piece | What |
|---|---|
| `src/index.js` | Router (`fetch`) + cron (`scheduled`) |
| `src/auth.js` | Whole-origin gate, login page, throttling, session cookie |
| `src/session.js` | HMAC-signed cookie helpers (same scheme as ATAC admin) |
| `src/bmapi.js` | BattleMetrics public-API client + fuzzy name matching |
| `src/store.js` | D1 queries (exports the correlation SQL for the test) |
| `src/monitor.js` | Roster polling + name refresh |
| `public/index.html` | The UI (Search · ID Scan · Watchlist · Servers · Monitor) |

Data lives in a **separate `bmfinder` D1 database** — private tracking data never
shares a blast radius with the public leaderboard.

### Schema changes

`schema.sql` is the authoritative, idempotent (`CREATE IF NOT EXISTS`) definition.
For a change against a live database, add a `migrate-<n>-<what>.sql` at the root and
an npm script for it — the same convention `leaderboard/` uses — rather than editing
`schema.sql` alone and hoping.

## Tabs

- **Search** — name (fuzzy-ranked), Steam ID, or exact player ID. Hidden profiles
  carry a **`hidden`** badge.
- **ID Scan** — walks a seeded window of player IDs as **client-paced batches**: a
  Worker can't hold a 40-minute loop, so the browser requests ~10 IDs at a time and
  paces itself under the ~60 req/min budget.
- **Watchlist** — track players by ID with your own nickname and a role. Stores full
  public **name history** and flags name changes. The `admin` role defines the
  online/offline windows the Monitor correlates against.
- **Servers** — search Arma 3 servers by name (or add by ID) and track them.
- **Monitor** — live rosters + **absence correlation**.

## Scheduling

Two crons, deliberately separate so the two workloads never share an invocation and
burst past the rate limit:

| Cron | Does |
|---|---|
| `*/5 * * * *` | Poll every tracked server's roster (1 request each) |
| `7 * * * *` | Refresh watched players' names (1 request each) + prune old snapshots |

## How the correlation works (and its limits)

Each poll records whether any watched **admin** was on, then increments every other
player's `absent`/`present` tallies. Correlation ranks by `absent / total` — someone
who only ever appears while admins are away is the signal.

Honest limits:

- **It only knows what it observed.** BattleMetrics doesn't expose session history,
  so tallies start when you start tracking. Signal builds over days, not minutes.
- **Servers where an admin has never been seen are excluded** (`admin_polls > 0`) —
  "absent" there is meaningless and would flag everyone. Tested.
- **Tallies are rolling, not recomputed.** Changing who is an `admin` affects future
  polls, not history already recorded.
- **It's a lead, not proof.** Plenty of people just play off-peak.

## Storage & retention

Deliberately **no row-per-player-per-poll**: at 5-minute polls that's ~288
rows/player/day and would bloat D1 and turn correlation into a full scan. Instead
`player_stats` holds rolling tallies each poll increments, `current_roster` holds
only the newest roster per server, and `server_snapshots` keeps a light poll history
**pruned to 30 days** (`SNAPSHOT_RETENTION_DAYS` in `src/store.js`).

Note this stores third parties' names, IDs and presence. Keep the retention window
honest — if you don't use snapshot history, shorten it.

## Rate limits

The BattleMetrics public API allows ~**60 requests/min** anonymously and everything
works without a token. Each poll is one request per server (`include=player` returns
server info *and* roster together). `BM_TOKEN` raises the ceiling if you need it.
