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

Required to check whether the BMFinder dashboard is still open, using
`chrome.tabs.query({ url: chrome.runtime.getURL("dashboard/dashboard.html") })`.
Querying by URL requires either this permission or host access to the URL being
matched, and the dashboard is a `chrome-extension://` page that the extension's
`host_permissions` entry for battlemetrics.com does not cover.

That check is what stops the extension working in the background. Live updates
are only permitted while a dashboard tab exists; when the last one closes, the
scheduled refresh is cancelled rather than left running. Without this
permission the extension cannot tell that the dashboard has gone, and the
guarantee that it does nothing while closed could not be enforced.

Creating, navigating and closing the background tab used to read a
battlemetrics.com page does not itself require this permission, and is not
being claimed as a reason for it.

## alarms

Used to hold the user's chosen refresh interval for followed servers while the
BMFinder dashboard is open. A Manifest V3 service worker is suspended when idle,
which would discard an in-page or in-worker timer part-way through an interval;
`chrome.alarms` survives that suspension, so a 10-minute interval stays a
10-minute interval instead of restarting whenever Chrome revives the worker.

The alarm does not outlive the dashboard. It is created only while a dashboard
tab is open and monitoring is running, and it is cleared as soon as the last
dashboard tab closes. The handler re-checks on every fire and cancels itself if
the dashboard has gone or consent has been withdrawn, so the extension does not
poll in the background when the user is not looking at it.

Without this permission the interval could not be kept accurately across
service-worker suspension.

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
