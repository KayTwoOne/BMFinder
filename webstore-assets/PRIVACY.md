# Privacy Policy for BMFinder

Last updated: 2026-07-28

## Summary

BMFinder is a browser extension for battlemetrics.com. It stores all of its
data locally on your device. It does not have a server, does not use
analytics or telemetry, does not use any third-party service, and does not
transmit any data anywhere. This policy explains exactly what the extension
stores, why, how long it is kept, and how to remove it.

## What BMFinder does

BMFinder helps a player track other players and servers on battlemetrics.com.
It:

- Looks up a player by name using your own logged-in battlemetrics.com
  session, by opening battlemetrics.com pages in a background browser tab
  and reading the page content that your browser already rendered for you.
- Lets you keep a watchlist of players with nicknames, roles, tags, and
  notes that you write yourself.
- Lets you keep a list of servers you want to track.
- Polls the servers on your tracked list on a schedule (five minutes at the
  fastest) and records who was on them at each poll.
- Lets you replay the polls you have already collected in an archive view.

All of this runs inside your browser. There is no BMFinder backend.

## What is collected

BMFinder collects and stores only the following, and only because you asked
it to by using the corresponding feature:

- **Player data you enter or select**: player names, IDs, nicknames, roles,
  tags, and notes you add to your watchlist.
- **Server data you enter or select**: server names and IDs you choose to
  track.
- **Presence history**: snapshots of which players were seen on your
  tracked servers, captured each time the Monitor polls, plus a timestamp
  for each poll.
- **Page content read from battlemetrics.com**: when you search for a
  player or the Monitor polls a tracked server, the extension reads the
  rendered battlemetrics.com page in a background tab (using your existing
  logged-in session) to extract player and server information. It does not
  read any other website.
- **Bookmarks, only if you use the bookmark-import feature**: if you click
  the button to import from your browser bookmarks, BMFinder requests
  temporary access to your bookmarks to read entries you choose to import.
  BMFinder does not access bookmarks otherwise.

BMFinder does not collect passwords, payment information, health
information, precise location, or the content of any private messages. It
does not read any website other than battlemetrics.com.

## Where data is stored

Everything BMFinder stores lives on your own device, inside your browser's
local storage mechanisms:

- `chrome.storage.local` for settings, watchlist entries, and tracked
  server lists.
- IndexedDB for presence history and poll snapshots (this is why the
  extension requests the `unlimitedStorage` permission, so that a long
  history is not truncated by the browser's default storage cap).

Nothing is uploaded, synced to a remote server, or shared with any
third party. BMFinder has no analytics, no crash reporting, and no
telemetry of any kind.

## Retention

- **Presence history** is kept on a rolling window and pruned
  automatically as it ages, so recent activity is retained while very old
  entries are dropped over time.
- **Poll snapshots** (the records the Archive replays) are retained for up
  to one year, after which older snapshots are removed automatically.
- **Watchlist entries, server lists, nicknames, and notes** are kept
  indefinitely, because they represent data you deliberately entered, until
  you delete them yourself.

You can export all of your data as JSON at any time, and you can clear
stored polls from within the extension's own settings.

## How to delete your data

You control your data directly:

- Use the in-extension controls to clear stored polls or remove individual
  watchlist entries, tags, or tracked servers.
- Use the export feature to save a JSON copy of your data before deleting
  anything, if you want a backup.
- Uninstalling the extension removes all of its stored data from your
  browser.

## Permissions and what they are used for

A full breakdown of each requested permission is in
`PERMISSION-JUSTIFICATIONS.md`. In summary, BMFinder only requests access
needed to store your data locally, run scheduled polls, and load
battlemetrics.com pages in a background tab using your existing session.

## Children's privacy

BMFinder is not directed at children and does not knowingly collect data
from children. It does not collect any personal information at all beyond
what described above, all of which is supplied by the user and stored only
on the user's own device.

## Changes to this policy

If this policy changes, the updated version will be posted at the same
location it is currently hosted, with an updated "Last updated" date at the
top.

## Contact

Questions about this policy or about BMFinder's data handling can be sent
to: enquiries@dotkay.dev
