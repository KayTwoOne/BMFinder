# Permission Justifications for BMFinder

Paste each block into the matching field on the dashboard's **Privacy practices**
tab. Every permission the manifest declares has an entry below, including the
host permission and the optional one.

**Privacy policy URL:** `https://dotkay.dev/projects/bmfinder/privacy.html`

**Remote code:** No. All logic and assets ship inside the package.

## storage

Used to save the user's saved people (their label, relationship, note and
tags), the list of servers they follow, and extension settings using
`chrome.storage.local`. Without this permission the extension cannot
remember anything between browser sessions: the saved people and followed
servers would reset to empty every time the browser restarts.

## tabs

Used to open battlemetrics.com pages in a background tab so the extension
can read the rendered page when the user searches for a player or when live
updates refresh a followed server, and to close that tab when done. Without
this permission, player search and live updates cannot load any
battlemetrics.com page at all, since there is no API being called; the
extension's only way to get player and server data is to load the real
page in a tab and read it.

## alarms

Used to schedule the recurring refresh of followed servers (five minutes at
the fastest, and the default interval) using `chrome.alarms` instead of an
in-page timer that would stop running when no extension page is open.
Without this permission, live updates cannot reliably run on a schedule in
the background; refreshing would stop as soon as the user closed any popup
or extension view.

## Host permission: https://www.battlemetrics.com/*

Used to allow the extension's background tab to load and read
battlemetrics.com pages using the user's own logged-in session. This is
the only host the extension ever contacts. Without this permission, the
extension cannot open or read any battlemetrics.com page, which means
player search, looking up saved people, and live updates all stop
working, since none of them use an API and all of them depend on reading
the real page.

## bookmarks (optional, requested only on demand)

Used only when the user clicks the bookmark-import button, to read the
user's browser bookmarks so the user can pick existing battlemetrics.com
player or server bookmarks to import into their saved people or followed
servers. This permission is not requested at install time and is not needed
for any other feature. Without it, the bookmark-import button cannot read
the user's bookmarks, so the user would have to add people and servers
manually instead of importing them.
