"""Turn a hero photograph into the two files the site serves.

    python3 tools/prepare-hero.py ~/Downloads/whatever.png

Writes assets/img/hero.webp (large) and assets/img/hero-sm.webp (served under 800px),
which are the filenames site.css already points at — so nothing else changes.

Needs Pillow:  pip install pillow
"""
import sys
from pathlib import Path

from PIL import Image

OUT = Path(__file__).parent.parent / "assets" / "img"
LARGE, SMALL = 2400, 1200
QUALITY = 82
BUDGET_KB = 250  # the hero is the LCP element; keep it cheap to fetch


def main(src):
    im = Image.open(src).convert("RGB")
    print(f"source: {im.width}x{im.height}")

    # The hero box is roughly square on a desktop and very tall on a phone, so
    # a wide 16:9 source has to be blown up vertically to cover it. Report the
    # actual scale factor rather than guessing at "big enough".
    scale = max(1372 / im.width, 1224 / im.height)  # a 1440px-wide desktop hero
    if scale > 1.15:
        print(f"note: this gets scaled up {scale:.1f}x to cover the hero on a 1440px\n"
              f"      screen, so fine detail will soften. Two ways to improve it:\n"
              f"      export wider, and export TALLER — the hero box is nearly\n"
              f"      square, so a 3:2 picture covers it far better than 16:9.\n"
              f"      2400x1600 needs no upscaling at all.")

    # Never upscale — that only adds bytes, never detail.
    for width, out in ((LARGE, "hero.webp"), (SMALL, "hero-sm.webp")):
        w = min(width, im.width)
        h = round(im.height * w / im.width)
        resized = im if w == im.width else im.resize((w, h), Image.LANCZOS)
        path = OUT / out
        resized.save(path, "WEBP", quality=QUALITY, method=6)
        kb = path.stat().st_size / 1024
        flag = "  <-- over budget, drop QUALITY" if out == "hero.webp" and kb > BUDGET_KB else ""
        print(f"wrote {path.name}: {w}x{h}, {kb:.0f} KB{flag}")
        if out == "hero-sm.webp" and w == min(LARGE, im.width):
            print("      (same size as the large file — the source is too small to\n"
                  "       split, which is harmless but the phone saving is lost)")

    print("\nThe hero picks these up automatically. Check the heading is still\n"
          "readable over the top third of the picture before you push.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
