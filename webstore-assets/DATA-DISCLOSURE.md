# Chrome Web Store Data Usage Disclosure for BMFinder

These are the answers to fill into the Chrome Web Store's data-usage
disclosure form. All data described below, when collected at all, is
stored only on the user's own device and is never transmitted off the
device.

## Data categories

| Category | Collected? | Reason |
|---|---|---|
| Personally identifiable information (name, address, email, age, ID numbers) | No | BMFinder does not collect the user's name, email, address, or ID numbers; it stores battlemetrics player handles/IDs and notes the user types in, kept locally only. |
| Health information | No | BMFinder has no feature related to health data. |
| Financial and payment information | No | BMFinder does not handle payments or financial data of any kind. |
| Authentication information (passwords, credentials, PINs, security answers) | No | BMFinder never sees or stores the user's battlemetrics.com password; it relies on the user's existing logged-in browser session for all page loads. |
| Personal communications (emails, texts, chat messages) | No | BMFinder does not read or store email, chat, or messaging content. |
| Location | No | BMFinder does not collect geolocation, IP-based location, or any other location data. |
| Web history | No | BMFinder does not read or store the user's browsing history; the only pages it loads are battlemetrics.com pages it opens itself for search and monitoring. |
| User activity (clicks, mouse position, scroll, keystrokes, network monitoring) | No | BMFinder does not monitor the user's clicks, keystrokes, or general browsing behavior. The presence records it keeps describe which game-server players were online at poll time, not the extension user's own input activity. |
| Website content (text, images, other user-generated content) | Yes | BMFinder reads rendered battlemetrics.com page content, such as player names, IDs, and server rosters, to populate search results, the watchlist, and the Monitor. This content comes only from battlemetrics.com pages loaded with the user's own session, and it is stored locally on the user's device only. |

Note on the optional `bookmarks` permission: if and only if the user clicks
the bookmark-import button, BMFinder reads browser bookmark titles and
URLs the user selects, in order to import battlemetrics.com player or
server entries. This access is not requested or used unless the user
initiates the import.

## Certifications

- **Data is not sold to third parties.** Confirmed. BMFinder has no
  server and no third-party integrations, so no data collected by the
  extension is sold, rented, or otherwise transferred to any third party.
- **Data is not used for purposes unrelated to the extension's single
  purpose.** Confirmed. All data BMFinder stores (watchlist entries,
  tracked servers, notes, and poll history) is used only to support its
  single purpose of tracking player presence on chosen servers, and stays
  on the user's device.
- **Data is not used to determine creditworthiness or for lending
  purposes.** Confirmed. BMFinder has no relationship to credit, lending,
  or financial eligibility decisions of any kind.
