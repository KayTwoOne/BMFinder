"""Produce exact 1280x800 listing screenshots from the full-resolution captures.

The captures come in three shapes and no single transform suits all of them:

  full-page (aspect ~1.20)  People, DataPrivacy, LiveActivity
  near-target (1.64)        RecentActivity
  viewport (2.00)           Search, Servers

Every image is fitted to the full 1280 width first, so nothing is ever lost
horizontally. What happens vertically then depends on the shape:

  taller than 800  -> crop from the top. Squashing a 2100px page into 800px
                      makes it unreadable at the size the store renders it,
                      and the top of a dashboard carries the header, the tab
                      bar and the first rows, which is what the shot is for.
  shorter than 800 -> pad symmetrically with the page's own background colour,
                      sampled from the capture so the join is invisible.

Sources are PNG with alpha; output is PNG with the alpha flattened, because
the store rejects an alpha channel. Downscaling uses Lanczos.

Run: python resize-screenshots.mjs.py
"""
from pathlib import Path

from PIL import Image

DIR = Path(__file__).parent / "webstore-assets" / "screenshots"
OUT = DIR / "listing"
W, H = 1280, 800

# The five shots the listing uses, in the order the store should show them.
WANTED = ["People", "Search", "LiveActivity", "RecentActivity", "DataPrivacy"]


def background(im):
    """Sample the page background from the capture's own corners.

    The top-left pixel sits in the header, which is not the page ground, so
    take the most common colour along the bottom edge instead.
    """
    w, h = im.size
    strip = im.crop((0, h - 2, w, h)).resize((w // 8, 1), Image.NEAREST)
    colours = strip.getcolors(maxcolors=w) or []
    return max(colours)[1] if colours else (13, 13, 15)


def convert(src, dst):
    im = Image.open(src)
    im = im.convert("RGB")  # flattens alpha; the store rejects it
    w, h = im.size

    scaled_h = round(h * W / w)
    im = im.resize((W, scaled_h), Image.LANCZOS)

    if scaled_h > H:
        im = im.crop((0, 0, W, H))  # anchor top, keep header and first rows
        note = f"cropped {scaled_h - H}px from the bottom"
    elif scaled_h < H:
        pad = H - scaled_h
        top = pad // 2
        canvas = Image.new("RGB", (W, H), background(im))
        canvas.paste(im, (0, top))
        im = canvas
        note = f"padded {top}px top / {pad - top}px bottom"
    else:
        note = "exact fit"

    im.save(dst, "PNG", optimize=True)
    return note, dst.stat().st_size


def main():
    OUT.mkdir(exist_ok=True)
    made = 0
    for i, stem in enumerate(WANTED, 1):
        src = DIR / f"{stem}.jpg"
        if not src.exists():
            print(f"  MISSING  {src.name}")
            continue
        dst = OUT / f"{i}-{stem}.png"
        note, size = convert(src, dst)
        print(f"  {dst.name:<22} 1280x800  {size // 1024:>4}KB  ({note})")
        made += 1
    print(f"\n{made} screenshot(s) written to webstore-assets/screenshots/listing/")


if __name__ == "__main__":
    main()
