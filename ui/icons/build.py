"""E-Podcast icon set — the ONLY generator. Every icon file the app ships comes from here.

Master: glyph-source.png (white studio microphone on black, picked by Roy 2026-10-04 from a
gemini-image candidate sheet; keyed by brightness, so any white-on-black master works).
Output: ui/icons/<SET>/ — the folder name IS the version. Change the artwork → bump SET,
update manifest.json / index.html / service-worker.js to the new folder (the test
tests/pwa_icons.test.mjs fails until all three agree). Never overwrite a published set:
an installed service worker or WebAPK keeps whatever bytes it saw at a given URL.

Why every launcher icon is maskable-safe (the "white frame" bug, v1.53 → v1.78):
  The manifest used to list a full-bleed "any" icon next to a separate maskable one.
  Chrome re-checks an installed WebAPK's manifest about once a day. When the maskable
  file could not be fetched at that moment (it was not in the SW precache, so offline
  or a flaky LTE fetch returned an error), Chrome fell back to the "any" icon, saw a
  different icon hash, and re-minted the WebAPK with it. Android treats a non-maskable
  icon as a legacy icon: it shrinks it and puts it on a WHITE plate. Hence "a few days
  after install, white border + smaller icon", and only in this app (the only one with
  an offline SW that cached the any-icon but not the maskable one).
  Now each launcher file is declared as BOTH "any" and "maskable", so any fallback lands
  on the same bytes and the same hash, and there is nothing to downgrade to.

Run: .venv/bin/python ui/icons/build.py      deps: Pillow
"""
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SET = "v2"
OUT = HERE / SET
BG = (11, 11, 16)          # #0B0B10 == manifest background_color (splash has no seam)
LO, HI = 110, 190          # brightness key: strips the lavender tint + glow halo

# name -> (px, mark fraction of the frame, downward nudge as a fraction of the frame)
#  launcher: the mark stays inside the 80%-diameter maskable safe circle (0.70 tall).
#  apple-touch: iOS does not crop to a circle, only rounds corners -> a bit larger.
#  favicon: browser tab / in-app brand, no crop at all -> fills the frame.
SPECS = {
    "icon-192.png": (192, 0.70, 0),
    "icon-512.png": (512, 0.70, 0),
    "apple-touch-180.png": (180, 0.78, 0),
    "favicon-64.png": (64, 0.90, 0),
}


def glyph() -> Image.Image:
    im = Image.open(HERE / "glyph-source.png").convert("RGBA")
    lut = [0 if v < LO else (255 if v > HI else round((v - LO) / (HI - LO) * 255))
           for v in range(256)]
    alpha = im.convert("L").point(lut)
    white = Image.new("RGBA", im.size, (255, 255, 255, 0))
    white.putalpha(alpha)
    return white.crop(alpha.getbbox())


def render(g: Image.Image, size: int, frac: float, dy: float) -> Image.Image:
    # Draw at 1024 and downsample once: small sizes keep the same geometry as 512.
    work = 1024
    cv = Image.new("RGBA", (work, work), BG + (255,))
    gw, gh = g.size
    th = round(work * frac)
    tw = round(th * gw / gh)
    if tw > work * frac:
        tw = round(work * frac)
        th = round(tw * gh / gw)
    cv.alpha_composite(g.resize((tw, th), Image.LANCZOS),
                       ((work - tw) // 2, (work - th) // 2 + round(dy * work)))
    # Opaque RGB: a transparent pixel anywhere is another way to get a launcher plate.
    return cv.convert("RGB").resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    g = glyph()
    for name, (size, frac, dy) in SPECS.items():
        render(g, size, frac, dy).save(OUT / name, "PNG", optimize=True)
        print(f"wrote {SET}/{name}")


if __name__ == "__main__":
    main()
