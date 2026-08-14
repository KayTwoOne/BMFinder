<div align="center">

<a href="https://dotkay.dev/">
  <img src="assets/banner.png" alt="BMFinder -- see when the players you follow are online on the servers you track" width="100%">
</a>

<br>

**Save and recognise the people you play Arma 3 with.**<br>
A Chromium extension that keeps everything on your own machine.

<br>

<img alt="Version 2.0.0" src="https://img.shields.io/badge/version-2.0.0-F5842B?style=for-the-badge&labelColor=171210">
<img alt="Manifest V3" src="https://img.shields.io/badge/manifest-V3-FFC814?style=for-the-badge&labelColor=171210">
<img alt="74 tests passing" src="https://img.shields.io/badge/tests-74%20passing-16A34A?style=for-the-badge&labelColor=171210">
<img alt="Telemetry: none" src="https://img.shields.io/badge/telemetry-none-E8433A?style=for-the-badge&labelColor=171210">
<img alt="Licence Apache 2.0" src="https://img.shields.io/badge/licence-Apache%202.0-9C8D84?style=for-the-badge&labelColor=171210">

<br>

[What it does](#what-it-does) ·
[Install](#install) ·
[How it works](#how-it-works) ·
[Privacy](#privacy-and-data) ·
[Architecture](#architecture) ·
[Development](#development)

</div>

---

Players change their in-game name constantly. You finish a good round with
someone, go looking for them a week later, and the name you remember is gone.

BMFinder lets you save that person under a label that means something to
**you** -- "the medic from Sunday", "Dave's mate" -- and tells you when they turn
up again on a server you follow.

Everything stays on your own device. There is no BMFinder account, no BMFinder
server, no analytics, and no third party of any kind.

<details>
<summary><b>Full contents</b></summary>

<br>

- [What it does](#what-it-does)
- [What it deliberately does not do](#what-it-deliberately-does-not-do)
- [Install](#install)
- [How it works](#how-it-works)
  - [Why an extension, and not a server or a script](#why-an-extension-and-not-a-server-or-a-script)
- [Privacy and data](#privacy-and-data)
- [Repository layout](#repository-layout)
- [Architecture](#architecture)
  - [Shared modules](#shared-modules)
- [Data model](#data-model)
- [Development](#development)
  - [Working on the extension](#working-on-the-extension)
- [Packaging and release](#packaging-and-release)
- [Compatibility](#compatibility)
- [Contributing](#contributing)
- [Licence](#licence)

</details>

## What it does

- **Save people you recognise** with your own label, a note, tags, and how you
  know them: friend, teammate, community member, server staff, or other.
- **Follow renames.** See someone's current in-game name alongside the names
  they used before, so a rename never loses them.
- **Track servers you play on** and see who is on them right now.
- **Build a picture of who plays when.** Turn on live updates while the
  dashboard is open and BMFinder records presence over time.
- **Find someone by name**, including multi-word and decorated names -- the
  matcher handles the unicode-heavy tags players decorate themselves with.
- **Import and export** on your terms. Choose exactly which fields leave your
  machine, and choose exactly which parts of a backup come back in.

## What it deliberately does not do

This is worth stating plainly, because the category invites the assumption.

- It will **not** reveal profiles BattleMetrics has made private or unavailable.
- It will **not** tell you whether anyone is cheating, and it will not score,
  rank, or flag anyone as suspicious.
- It is **not** a moderation tool and **not** a public player database.
- It does **not** enumerate player IDs, correlate absences, or retry against
  alternate endpoints when a profile is unavailable.

BMFinder is a general-purpose social tool for keeping track of people you
actually know. The information it shows is partial and can be out of date, and
acting on it is your responsibility. See
[the full terms](extension/pages/policy.html), section 14.

## Install

### From the Chrome Web Store

Not yet published -- submission is pending. This section will carry the store
link once the listing is live.

### From source, as an unpacked extension

1. Clone this repository.
2. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
3. Turn on **Developer mode**, top right.
4. Click **Load unpacked** and select the [`extension/`](extension/) folder.
5. Pin BMFinder to the toolbar if you want the popup handy.

No login, no token, no server. It uses the BattleMetrics session your browser
already has.

On first run you get a disclosure screen explaining what the extension reads and
stores. You have to accept it before the dashboard will do anything. If a later
version changes what is disclosed, the version bump re-prompts you.

> After an update that adds a permission, Chromium may pause the extension.
> Click **Reload** on its card and approve the prompt.

## How it works

BMFinder reads BattleMetrics pages **in your own browser**, using the session
you are already signed in with. It does not use an API, does not ask for your
password, and never touches any other website.

When you ask for a refresh or turn on live updates, it opens BattleMetrics pages
one at a time in a background tab, deliberately paced, and reads what your
browser has already rendered. Live updates only run while the dashboard is open,
and stop when you close it.

### Why an extension, and not a server or a script

Every other access path was tested and closed:

| Approach | Result |
| --- | --- |
| Public REST API | `403 -- A subscription is required to use the API.` Anonymous access closed in July 2026. |
| Cloudflare Worker → API | `403 error code: 1106`. Worker subrequests carry an unremovable `CF-Worker` header, rejected before auth is evaluated. |
| Session cookie against the API | No help. The refusal happens before authentication. |
| Scripted HTML scraping | Works for roughly twenty requests, then `403 Cf-Mitigated: challenge` indefinitely. |
| Internal `/_api/` from page context | `401 -- Missing API request signature.` Signing lives in their module code; reproducing it means defeating an anti-bot control, which this project will not do. |

A real browser passes all of that, because it already holds Cloudflare clearance
and carries a legitimate session. That is the whole reason this is an extension.

## Privacy and data

- **Everything is local.** IndexedDB and `chrome.storage.local` on your machine.
  Nothing is transmitted anywhere.
- **No telemetry, no analytics, no crash reporting, no remote fonts.** The
  typefaces are bundled in [`extension/fonts/`](extension/fonts/).
- **Retention is yours.** Recent activity is kept for 14 days by default,
  adjustable from 1 to 90 days, clearable at any time.
- **Host permission is a single origin**: `https://www.battlemetrics.com/*`.
- **`bookmarks` is optional** and requested only at the moment you choose to
  import your own BattleMetrics bookmarks. Decline it and everything else still
  works.
- **A Data and privacy screen** shows exactly what is stored and lets you delete
  any part of it, or all of it.

Full documents: [privacy policy and terms](extension/pages/policy.html) ·
[data disclosure](webstore-assets/DATA-DISCLOSURE.md) ·
[permission justifications](webstore-assets/PERMISSION-JUSTIFICATIONS.md)

## Repository layout

```
extension/          The extension. This is the product.
  background/       MV3 service worker -- scheduling, tab orchestration, messaging
  content/          Content script that reads rendered BattleMetrics pages
  dashboard/        Options page: the main UI
  popup/            Toolbar popup
  pages/            First-run consent gate, privacy policy, about
  lib/              Shared modules (see Architecture)
  fonts/            Bundled woff2 -- no external font requests
  icons/            Extension icons, 16–128px
  test/             Node test-runner suites

webstore/           Generated. Byte-identical to extension/ minus dev files.
                    This is what gets zipped and uploaded. Never edit directly.

webstore-assets/    Store listing copy, permission justifications, screenshots
assets/             Repo banner and source icons
docs/               Design spec, privacy policy, public release audit

package-webstore.mjs   Builds and verifies webstore/ from extension/
verify-extension.mjs   Static checks: duplicate IDs, dead references, vocabulary
```

## Architecture

**Service worker** ([`background/worker.js`](extension/background/worker.js)) --
owns all persistence and scheduling. Message handlers live in a single dispatch
map. Alarms drive live updates, and `applyAlarm({ restart })` distinguishes a
genuine interval change from a worker reconnect, so a countdown is never
silently reset. Dashboard presence is detected over `chrome.runtime.connect`,
so live updates stop the moment the dashboard closes.

**Content script** ([`content/reader.js`](extension/content/reader.js) +
[`lib/extract.js`](extension/lib/extract.js)) -- reads the rendered DOM and
reports structured data upward. It never mutates the host page. The worker
accepts only an explicit allowlist of message types from it
(`CONTENT_SCRIPT_MESSAGES`), so a compromised page cannot reach privileged
handlers.

**Dashboard** ([`dashboard/`](extension/dashboard/)) -- the whole UI. Tile and
list views over the same data, a search tab, live activity, and data controls.
Plain ES modules, no framework, no build step.

### Shared modules

| Module | Responsibility |
| --- | --- |
| [`lib/db.js`](extension/lib/db.js) | IndexedDB wrapper. Schema, migrations, retention pruning, selective import. |
| [`lib/extract.js`](extension/lib/extract.js) | Parses BattleMetrics DOM into structured records. |
| [`lib/match.js`](extension/lib/match.js) | Name matching and scoring -- handles decoration, separators, case, multi-word. |
| [`lib/relationships.js`](extension/lib/relationships.js) | The relationship vocabulary and its migrations from older terms. |
| [`lib/transfer.js`](extension/lib/transfer.js) | Import/export formats, field selection, backup summarising. |
| [`lib/theme.js`](extension/lib/theme.js) | Theme resolution shared across the dashboard and pages. |

## Data model

IndexedDB, database version 5, eight stores:

| Store | Holds |
| --- | --- |
| `watched` | Saved people: label, relationship, note, tags |
| `names` | Every in-game name observed per player, with first and last seen |
| `servers` | Servers you follow |
| `snapshots` | Point-in-time server population readings |
| `roster` | Who was on which server at a given moment |
| `presence` | Derived presence history, subject to your retention setting |
| `settings` | Preferences, retention, disclosure acceptance |
| `tags` | Your tag vocabulary |

Exports come in three shapes: a **BMFinder list**
(`{ format: "bmfinder-list" }`), **CSV**, and a **full backup**. On import you
pick which parts to restore -- people, servers, activity, settings -- and whether
to **merge** (adds only what is absent, never overwrites) or **replace** (clears
the selected stores first). Merge is the default; replace requires explicit
acknowledgement.

`playerId` and `serverId` are always included in exports regardless of field
selection, because a file without them cannot be re-imported.

## Development

Requires Node 20 or newer.

```bash
npm install
```

Run the test suite -- 74 tests covering matching, relationships, retention,
transfer formats, and selective import:

```bash
npm test
```

Run the static checks -- duplicate element IDs, references to removed elements,
banned vocabulary, placeholder text:

```bash
npm run verify
```

Everything at once, including a package build:

```bash
npm run check
```

Tests use [`fake-indexeddb`](https://www.npmjs.com/package/fake-indexeddb) so
destructive database paths can be exercised for real rather than mocked.

### Working on the extension

Edit files in [`extension/`](extension/) only. Never edit `webstore/` -- it is
generated output and your changes will be overwritten. Reload the extension from
`chrome://extensions` to pick up changes; the service worker may need an
explicit reload for background changes.

## Packaging and release

```bash
npm run package
```

This regenerates `webstore/` from `extension/`, then verifies:

- every file is byte-identical to its source
- the package contains exactly the shipping files, and no test or tooling files
- the manifest is valid and its referenced files all exist
- every permission has a written justification
- the store listing quotes the manifest description exactly

Then zip the **contents** of `webstore/` -- `manifest.json` must sit at the zip
root -- and upload that.

To cut a release, bump `version` in **both** `extension/manifest.json` and
`webstore/manifest.json`, run `npm run check`, then package and upload.

## Compatibility

Chromium Manifest V3, so it runs in Chrome, Brave, and Edge. Firefox is not
supported -- it uses a different extension model and BMFinder has not been
ported.

## Contributing

Issues and pull requests are welcome, with two firm boundaries:

1. **Nothing that defeats an anti-bot control.** No request signing, no
   challenge solving, no fingerprint spoofing. The reason this project is a
   browser extension is precisely to stay inside what a normal signed-in browser
   already does.
2. **Nothing that turns this into a surveillance or moderation tool.** No ID
   enumeration, no absence correlation, no suspicion scoring, no accusation
   language. These were removed from the source deliberately and will not come
   back.

Run `npm run check` before opening a pull request.

Contributions are accepted under the [Apache License 2.0](LICENSE) -- by opening
a pull request you agree your work ships under those terms.

## Licence

[Apache License 2.0](LICENSE) -- you may use, modify and redistribute this code,
including commercially, provided you keep the copyright notice, state your
changes, and include a copy of the licence.

Two things the licence does not cover, both spelled out in [NOTICE](NOTICE):

- **The names.** Apache 2.0 grants no trademark rights. "BMFinder" and "dotKay"
  stay with the author -- if you publish a fork, give it a different name.
- **The bundled fonts.** Chakra Petch and IBM Plex Sans live in
  [`extension/fonts/`](extension/fonts/) under the SIL Open Font License 1.1,
  not Apache 2.0.

<div align="center">

---

**BMFinder is an independent community project by [dotKay](https://dotkay.dev/).**

Not affiliated with, endorsed by, sponsored by, or produced by BattleMetrics,
Valve, Steam, Bohemia Interactive, or Arma.

</div>
