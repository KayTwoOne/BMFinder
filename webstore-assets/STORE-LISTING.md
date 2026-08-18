# Chrome Web Store listing copy for BMFinder

Category: **Social & Communication**

## Short description (limit 132 characters)

See when the players you follow are online on the game servers you track.

(73 characters. This is also the manifest `description`; keep the two identical.)

## Detailed description

BMFinder helps you save and recognise the people you play Arma 3 with.

Players change their in-game name constantly. You finish a good round with
someone, go looking for them a week later, and the name you remember is gone.
BMFinder lets you save that person under a label that means something to you,
and tells you when they turn up again on a server you follow.

Everything stays on your own device. There is no BMFinder account, no BMFinder
server, no analytics, and no third party of any kind.

**What you can do**

- Save people you recognise, with your own label, a note, tags, and how you
  know them: friend, teammate, community member, server staff, or other.
- See their current in-game name, and the names they used before, so a rename
  never loses them.
- Follow the servers you play on and see who is on them.
- Turn on live updates while the dashboard is open to build up a picture of who
  plays when.
- Find someone by name, including multi-word and decorated names.

**How it works**

BMFinder reads BattleMetrics pages in your own browser, using the session you
are already signed in with. It does not use an API, does not ask for your
password, and never touches any other website.

When you ask for a refresh or turn on live updates, it opens BattleMetrics
pages one at a time in a background tab, deliberately paced, and reads what
your browser has already rendered. Live updates only run while the dashboard is
open, and stop when you close it.

**Your data, your control**

- Recent activity is kept for 14 days by default, and you can set it from 1 to
  90 days or clear it whenever you like.
- Exports ask what the file is for and let you choose which fields to include.
  Player IDs are always included because they are needed for re-importing.
- A Data and privacy section shows exactly what is stored and lets you delete
  any part of it, or all of it.

**What BMFinder will not do**

- It will not reveal profiles BattleMetrics has made private or unavailable.
- It will not tell you whether anyone is cheating, and it will not score,
  rank, or flag anyone as suspicious.
- It is not a moderation tool and not a public player database.

BMFinder is an independent community project. It is not affiliated with,
endorsed by, sponsored by, or produced by BattleMetrics, Valve, Steam, Bohemia
Interactive, or Arma.

## Screenshots

**Upload the five files in `webstore-assets/screenshots/listing/`.** They are
numbered in the order the store should show them. The parent folder holds the
raw full-resolution captures they were built from; `resize-screenshots.py`
regenerates the listing set from those.

Screenshots go through the dashboard form and are not bundled in the zip, so
this folder is a staging area rather than part of the package.

Validate before uploading:

```bash
npm run screenshots
```

Requirements the store enforces:

- **1280x800** or 640x400. Use 1280x800.
- **PNG or JPEG**, no alpha channel.
- **At least one**, at most five. Supply all five below.
- The image must be the full canvas, no padding or borders added.

Turn on **Presentation mode** (the screen icon in the header) before capturing
so in-game names and player IDs are blurred in every shot.

1. **People — tiles.** The main view. Shows saved people with labels,
   relationships and last observed.
2. **People — list.** The same list as a table, showing sorting and filtering.
3. **Find players.** A search with results, showing the "on your servers"
   column.
4. **Live activity.** The schedule and at-a-glance numbers.
5. **Data and privacy.** Retention, storage summary, and the deletion controls.
   This is the one that answers a reviewer's questions before they ask.

The old set, named after tab labels that no longer exist, has already been
removed.

## Submission field values

Everything the dashboard asks for, in one place.

| Field | Value |
|---|---|
| Extension name | BMFinder |
| Short description | See when the players you follow are online on the game servers you track. |
| Category | Social & Communication |
| Language | English (United Kingdom) |
| Store icon | `webstore-assets/store-icon-512.png` (512x512) |
| Screenshots | 5 files from `webstore-assets/screenshots/`, 1280x800 |
| Privacy policy URL | `https://dotkay.dev/projects/bmfinder/privacy.html` |
| Remote code | **No.** All code and assets ship in the package. |
| Data collection | Tick **Website content** only. Leave every other category unticked. |
| Certifications | Tick all three. Wording in DATA-DISCLOSURE.md. |
| Visibility | Public |
| Distribution | All regions |
| Pricing | Free |

Promo tiles are optional and none are supplied. Skip that section.

## Single purpose statement

BMFinder lets a player keep a personal, local list of the Arma 3 players they
know and see when those players are online on servers they follow, using
BattleMetrics pages in their own browser.

## Permission justifications

See PERMISSION-JUSTIFICATIONS.md. Summary:

- `storage` and IndexedDB: the saved list and settings, on the device only.
- `tabs`: to open and read one BattleMetrics page at a time during a refresh.
- `alarms`: to schedule live updates while the dashboard is open.
- `bookmarks`: **optional**, requested only when the user imports their own
  BattleMetrics bookmarks, and never requested otherwise.
- Host permission is limited to `https://www.battlemetrics.com/*`.
