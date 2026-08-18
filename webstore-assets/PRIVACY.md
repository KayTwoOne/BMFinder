# Privacy policy — superseded, see the canonical document

This file used to hold a full privacy policy dated **2026-07-28**. That version
is superseded and must not be quoted, linked, or submitted anywhere.

It described features under names the product no longer uses ("watchlist",
"Archive", "roles"), and it predates the rewrite of the responsible-use terms.
Keeping a second, older policy in a public repository is a liability: someone
reading it would be reading terms that no longer describe the extension.

## The canonical policy lives in two places

Both carry the same text, effective **14 August 2026**, in 21 sections grouped
into three parts (Privacy Policy, Terms of Use, Acceptable Use Policy).

| Where | What it is for |
|---|---|
| `extension/pages/policy.html` | Bundled in the extension, reachable offline from the dashboard and the first-run consent screen. |
| <https://dotkay.dev/projects/bmfinder/privacy.html> | Publicly hosted. **This is the URL to give the Chrome Web Store.** |

## If you change the policy

Change `extension/pages/policy.html` first, then mirror it to the site page.
The two are verified section by section; they should never drift. Bump the
effective date in both, and bump `DISCLOSURE_VERSION` in the extension if the
change alters what users are consenting to, so existing users are re-prompted.
