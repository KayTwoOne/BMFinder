"""Produce the 1280x800 listing screenshots from the full-resolution captures.

The captures are 2x full-page grabs about 2550px wide, but the app lays its
cards out in a centred max-width column roughly 1200px of that. Fitting the
whole capture into 1280 therefore threw away half the frame on empty margin
and rendered the UI at 1x, which is too small to read in the store's carousel.

So each shot is cropped to its own content column plus a gutter, and starts at
the tab bar rather than at the top of the page: the header's logo and controls
sit outside the column and would be sliced, and the presentation-mode banner
above it reads as broken when cut mid-sentence. Starting at the tabs gives a
clean top edge and keeps the navigation, which is the part that shows what the
extension actually is.

Both bounds are measured from the image, not hard-coded, so a recapture at a
different window size still lands correctly.

Run: python resize-screenshots.py
"""
from pathlib import Path

import numpy as np
from PIL import Image

DIR = Path(__file__).parent / "webstore-assets" / "screenshots"
OUT = DIR / "listing"
W, H = 1280, 800
GUTTER = 100          # breathing room either side of the content column
TOP_PAD = 26          # space above the tab bar

WANTED = ["People", "Search", "LiveActivity", "RecentActivity", "DataPrivacy"]


def content_column(arr, from_y=260):
    """Horizontal bounds of the card column, ignoring the full-width header."""
    body = arr[from_y:, :, :]
    bg = np.median(body.reshape(-1, 3), axis=0)
    diff = np.abs(body - bg).sum(axis=2)
    cols = np.where(diff.max(axis=0) > 40)[0]
    return int(cols[0]), int(cols[-1])


def tab_bar_top(arr, left, right):
    """First row of real content inside the column, below the page header.

    The header and the presentation-mode banner span the full width, so they
    are excluded by searching only within the column, starting below them.
    """
    strip = arr[:, left:right, :]
    bg = np.median(strip.reshape(-1, 3), axis=0)
    diff = np.abs(strip - bg).sum(axis=2)
    rows = np.where(diff.max(axis=1) > 40)[0]
    rows = rows[rows > 100]           # clear the header band
    return int(rows[0]) if len(rows) else 0


def convert(src, dst):
    im = Image.open(src).convert("RGB")   # flattens alpha; the store rejects it
    arr = np.asarray(im).astype(int)
    iw, ih = im.size

    left, right = content_column(arr)
    left = max(0, left - GUTTER)
    right = min(iw, right + GUTTER)

    top = max(0, tab_bar_top(arr, left, right) - TOP_PAD)

    cw = right - left
    ch = round(cw * H / W)
    if top + ch > ih:                      # not enough page below: sit on the bottom
        top = max(0, ih - ch)
    if ch > ih:                            # page shorter than the crop: take it all
        ch = ih
        cw = round(ch * W / H)
        right = min(iw, left + cw)
        cw = right - left

    im = im.crop((left, top, left + cw, top + ch)).resize((W, H), Image.LANCZOS)
    im.save(dst, "PNG", optimize=True)
    return cw, round(W / cw * 100)


def main():
    OUT.mkdir(exist_ok=True)
    for i, stem in enumerate(WANTED, 1):
        src = DIR / f"{stem}.jpg"
        if not src.exists():
            print(f"  MISSING  {src.name}")
            continue
        dst = OUT / f"{i}-{stem}.png"
        cw, pct = convert(src, dst)
        kb = dst.stat().st_size // 1024
        print(f"  {dst.name:<22} 1280x800  {kb:>4}KB  (from {cw}px column, UI at {pct}%)")


if __name__ == "__main__":
    main()
