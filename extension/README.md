# BMFinder browser extension

Tracks BattleMetrics players and servers by reading pages your browser renders.
Chromium Manifest V3, so it runs in Brave, Chrome and Edge.

## Install

1. Open `brave://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode**, top right.
3. Click **Load unpacked** and select this `extension` folder.
4. Pin BMFinder to the toolbar if you want the popup handy.
5. Open the dashboard from the popup, or from the extension's **Details, Extension options**.

No login, no token, no server. It uses the BattleMetrics session your browser
already has.

After an update that adds a permission (the bookmarks permission was added for
bookmark import), Chromium may pause the extension. Click **Reload** on its card and
approve the prompt.

## Why an extension, and not the Python tool or the Worker

Both earlier versions are dead ends, for reasons that were tested rather than
assumed:

- The public API is paywalled. `api.battlemetrics.com` answers
  `403 "A subscription is required to use the API"` to anonymous callers, from a
  home connection and a datacenter host alike.
- Cloudflare Workers cannot reach it at all. Worker subrequests carry an
  unremovable `CF-Worker` header and get `403 error code: 1106` before
  BattleMetrics evaluates any credentials.
- A session cookie does not help, because the refusal happens before auth.
- Scripted HTML scraping works for roughly twenty requests, then Cloudflare
  returns `403 Cf-Mitigated: challenge` and keeps doing so.
- Their internal `/_api/` needs a request signature. Confirmed from inside a real
  page: `window.fetch` is untouched, so a page-context call still returns
  `401 "Missing API request signature."` The signing lives in their own module
  code, and reproducing it means defeating an anti-bot control.

A real browser passes all of that, because it holds Cloudflare clearance, carries
your session, and runs the JavaScript that signs their requests. So the extension
lets their page do the work and reads the result out of the DOM. Nothing is forged.

## How it collects data

**Passively.** Any BattleMetrics page you open is read and recorded, but only for
players and servers you already track. Browsing a profile does not silently add it
to your watchlist. This costs no extra requests.

**On demand.** "Refresh watchlist" and "Poll servers" walk your tracked items one
at a time through a single reused hidden tab, with a gap between each. Sequential
and slow on purpose: about twenty rapid scripted requests is what earned a
Cloudflare challenge during testing, so the queue stays closer to human pace.

Scheduled polling is built but shipped off. It is the only mode that produces
correlation data worth much, and it is also the most automated-looking, so it is a
deliberate choice rather than a default.

## Tabs

- **Search** by name, through the **RCON** view first, since that is the one that
  surfaces players the public pages hide.

  **The search parameter is `filter[search]`.** This one detail cost a lot of
  debugging, so do not change it casually:

  ```
  /rcon/players?filter%5Bsearch%5D=<name>&sort=score
  ```

  `?q=` and `?search=` are silently ignored. They do not error, they render the
  default player list, which looks exactly like a search that returned nothing. If
  search ever "stops working" again, check this parameter first. `sort=score` puts
  the closest matches first. Results come back as bare `/players/<id>` links inside
  list items, which is what the extractor looks for.

  **Whitespace is bridged with `%`.** Their comparison is a substring one already
  wrapped on both sides, and a literal `%` in the term survives unescaped and acts
  as a wildcard. Measured 2026-07-29: `filter[search]=Big%Boss` returns
  `Big "big boss" Boss`, `[BOSS] Big Boss`, `Boss Big Boss`. Matches with text
  *before* "Big" are what prove the wrapping.

  A plain space, by contrast, truncates the term: `Big Boss` searches only `Big`.
  So `searchTerm()` replaces each run of whitespace with one `%`, which is what
  makes multi-word and decorated names findable at all.

  No leading or trailing `%` is added. Their query already wraps the term, so an
  outer wildcard buys nothing, and a bare `%` would ask their database to scan
  every player row.

  If the RCON URL yields nothing the same search is tried on the public path, and
  as a last resort the on-page form is filled and submitted, in case a future
  layout stops honouring the parameter.
- **ID Scan** walks a range of player IDs through `/rcon/players/<id>`, the original
  trick: that view resolves players the public `/players/<id>` page hides, so a
  hidden admin can be found by walking IDs. In the extension each ID costs a full
  page load, so it is capped at 500 and genuinely slow. Seed it near a known
  player rather than starting at 1: IDs are global and now in the hundreds of
  millions.

  Every player lookup (scan, watchlist refresh, search by player ID) goes through
  one helper that tries the RCON view first and only falls back to the public page
  if RCON returns nothing, so the two forms cannot drift apart. No cookie needs
  supplying: the extension drives a tab in your own browser, so these pages already
  carry your logged-in session.
- **Watchlist** keeps the people you have saved, by player ID, online or offline.
  - Each entry leads with the **label you chose** and shows the live in-game name
    beneath it. Rename inline with the button, or **double-click the label**; the
    label sticks and never triggers a lookup.
  - **Relationship** is a dropdown right in the row (Friend, Teammate, Community
    member, Server staff, Other): change it without re-adding anyone. It is your own
    sorting aid and says nothing about the person on BattleMetrics' side.
    **Ctrl+click** several rows to select them, then change any one of their
    relationships to set them all at once.
  - **Last seen** comes from the poller's own observation: when it snapshots a tracked
    server and finds a watched player in the roster, that is recorded as the last seen,
    with the server name. This is why it stays accurate. The player page's global
    figure is only a labelled fallback for players the poller has never caught, and it
    can lag badly (years stale while someone is active), which is the bug it replaces.
  - Click **Role** or **Last seen** to sort. `admin` marks the people whose online and
    offline windows correlation measures against.
  - **Tags** are your own labels with your own colours, shown as chips beside the
    nickname. Create them under Manage tags, assign with the row's tags button, and
    use the star for a quick Favourite (itself just a built-in tag, created the first
    time you use it). Ctrl+click several rows first to tag them all at once. Deleting
    a tag removes it from every player, so no row shows a label that no longer exists.
  - **Import** brings players in from your BattleMetrics bookmarks. "From browser
    bookmarks" scans your bookmarks for player links; "From bookmarks file" reads an
    exported `.html` bookmarks file from any browser. The bookmark title becomes the
    nickname, players already tracked are left alone, and you pick the role to import
    them as. Hit Refresh names afterwards to fetch their current names and last seen.
- **Servers** tracks servers and their rosters. Server links carry the game slug
  (`/servers/arma3/<id>`), because the bare `/servers/<id>` form does not resolve.
  The game is captured when you add a server from search; manual adds default to arma3.
- **Monitor** shows who is online now, runs absence correlation, holds backup, and
  runs continuous polling. **Start** begins snapshotting your tracked servers on the
  interval while the dashboard tab stays open; the same button **pauses** and
  **resumes**, and **Stop** ends it. It is a background consumer, so pause it when you
  do not need it.

## Privacy blur for screenshots

The eye button in the header hides in-game names and player IDs behind a blur so you
can screenshot or share the dashboard without exposing them. Blurred fields reveal on
hover so the page stays usable, and the setting is remembered.

## Archive

Every poll stores who was on each tracked server at that moment, and the Archive tab
replays those snapshots newest first. Filter by player name or ID, or narrow to
watched players only, and export the lot to CSV.

Two things worth knowing. It only covers polls taken from the moment this feature
landed, because per poll player lists were not stored before, so it fills up as the
poller runs rather than showing history retroactively. And it is the one store that
grows with time rather than with how much you track, so it prunes to a rolling
window (14 days by default, the `presenceDays` setting) instead of keeping
everything forever.

## Typography

Two bundled faces rather than the system stack: Chakra Petch for headings, metric
numerals and the wordmark, IBM Plex Sans for everything else. The font files live in
`fonts/` and are loaded with `@font-face` rather than from a CDN, so the extension
works offline and never reports a page visit to a third party. IBM Plex ships with
Cyrillic and Latin Extended subsets because player names are full of both.

Sizes come from a five step scale on `:root` (`--t-hero` down to `--t-meta`) instead
of the eleven near identical values that were there before. Numerals are tabular so
digits line up in columns.

## Appearance

The gear in the header opens appearance settings. Pick from ten accent colours and
switch between Light, Dark, and System (follows the OS). The whole UI is built on a
Material 3 style token system: one seed hue generates the full tonal palette in
`lib/theme.js`, so changing accent or mode is a single variable swap with no reload.
The choice is saved in `chrome.storage.local` and the popup follows it, so the popup
and dashboard always match.

## Backup

Data lives in the browser profile, not a file you can copy. Export writes
`bmfinder-backup.json`, import replaces everything from one. Take a copy before
reinstalling or clearing browser data.

## Known limits

- **Selectors break when BattleMetrics redesigns.** Everything that touches their
  DOM lives in `lib/extract.js` with a version marker, and failures surface as a
  visible warning rather than blank names in the database. Two real examples found
  during development: every `h1` on a server page belongs to the cookie consent
  dialog, and a player page carries around 39 `/players/` links that are nav tabs
  rather than people. Both are handled, and both are the kind of thing a redesign
  reintroduces.
- **Correlation only counts polls that happened.** It cannot see the past, and
  running the browser occasionally samples your habits as much as anyone's. Treat
  it as a lead, not evidence.
- **Short search queries over-match.** An exact whole-word match scores 100%, which
  is what makes `[TAG] Bob` match `Bob`, and also what makes `Bob` match
  `Bob the Builder`. Prefer longer queries when scanning.

## Layout

```
manifest.json
background/worker.js    job queue, hidden tab, the only writer to storage
content/reader.js       reads the rendered page, handles SPA navigation
lib/extract.js          every DOM selector, plus a self test
lib/db.js               IndexedDB
lib/match.js            fuzzy name scoring
lib/correlation.js      absence correlation
dashboard/              the five-tab UI
popup/                  quick actions
test/logic.test.js      matching and correlation
```

## Tests

```
npm test
```

Runs `node --test`, no dependencies. Covers the matching rules and the correlation
engine, using the same cases that passed against SQLite in the earlier build.
IndexedDB and DOM extraction are not covered there: the extraction logic was
verified by running it against live BattleMetrics pages instead.
