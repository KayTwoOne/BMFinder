# Permission Justifications for BMFinder

## storage

Used to save the user's watchlist (players, nicknames, roles, tags,
notes), the tracked server list, and extension settings using
`chrome.storage.local`. Without this permission the extension cannot
remember anything between browser sessions: the watchlist and tracked
server list would reset to empty every time the browser restarts.

## tabs

Used to open battlemetrics.com pages in a background tab so the extension
can read the rendered page when the user searches for a player or when the
Monitor polls a tracked server, and to close that tab when done. Without
this permission, player search and the Monitor cannot load any
battlemetrics.com page at all, since there is no API being called; the
extension's only way to get player and server data is to load the real
page in a tab and read it.

## unlimitedStorage

Used because presence history and poll snapshots recorded by the Monitor
accumulate over time and are stored in IndexedDB. Without this permission,
the browser's default storage quota would cause older poll data to be
evicted or new polls to fail to save once the quota is hit, breaking the
Archive feature and truncating the user's presence history.

## alarms

Used to schedule the Monitor's recurring poll of tracked servers (five
minutes at the fastest, and the default interval) using `chrome.alarms`
instead of an in-page timer that would stop running when no extension page
is open. Without this permission, the Monitor cannot reliably run on a
schedule in the background; polling would stop as soon as the user closed
any popup or extension view.

## Host permission: https://www.battlemetrics.com/*

Used to allow the extension's background tab to load and read
battlemetrics.com pages using the user's own logged-in session. This is
the only host the extension ever contacts. Without this permission, the
extension cannot open or read any battlemetrics.com page, which means
player search, the watchlist lookup, and the Monitor's polling all stop
working, since none of them use an API and all of them depend on reading
the real page.

## bookmarks (optional, requested only on demand)

Used only when the user clicks the bookmark-import button, to read the
user's browser bookmarks so the user can pick existing battlemetrics.com
player or server bookmarks to import into the watchlist or tracked server
list. This permission is not requested at install time and is not needed
for any other feature. Without it, the bookmark-import button cannot read
the user's bookmarks, so the user would have to add players and servers
manually instead of importing them.
