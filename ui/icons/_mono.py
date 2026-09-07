"""Monochrome app icons from glyph-source.png (reproduces v1.54.0's brightness
keying) but sizes the mark to FILL the frame — the maskable icon in particular,
whose mark was small enough that Android's safe-zone crop made it look shrunken
on the home screen. Keeps the exact black+white design; only the scale changes.
Run: cdpvenv/bin/python ui/icons/_mono.py   deps: Pillow
"""
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent
BG = (11, 11, 16)          # #0B0B10 == manifest background_color (no splash seam)
LO, HI = 110, 190          # brightness key: strips the lavender tint + glow halo

def glyph():
    im = Image.open(HERE / "glyph-source.png").convert("RGBA")
    lum = im.convert("L")
    lut = [0 if v < LO else (255 if v > HI else round((v - LO) / (HI - LO) * 255))
           for v in range(256)]
    alpha = lum.point(lut)
    white = Image.new("RGBA", im.size, (255, 255, 255, 0))
    white.putalpha(alpha)
    return white.crop(alpha.getbbox())   # tight to the mark

def make(g, size, frac, dy=0):
    cv = Image.new("RGBA", (size, size), BG + (255,))
    gw, gh = g.size
    th = round(size * frac); tw = round(th * gw / gh)
    if tw > size * frac:                 # keep width in frame too
        tw = round(size * frac); th = round(tw * gh / gw)
    # dy nudges the mark DOWN: the wave rings carry the visual mass high, so a
    # bbox-centered mark still reads as sitting too high. dy re-centers the mass.
    cv.alpha_composite(g.resize((tw, th), Image.LANCZOS), ((size - tw) // 2, (size - th) // 2 + round(dy)))
    return cv.convert("RGB")

def main():
    g = glyph()
    print("glyph crop:", g.size)
    # "any": fill generously (no launcher crop). maskable: fill the safe zone
    # (~80% dia) without touching it -> 0.76 of the frame on the long axis.
    for size in (64, 192, 512):
        make(g, size, 0.90).save(HERE / f"icon-{size}.png", "PNG", optimize=True)
    # maskable: home-screen icon. Slightly smaller (0.70) and nudged down (dy=25) so
    # the wave-heavy mark reads as vertically centered inside the launcher mask while
    # staying 100% inside the 80%-dia safe circle (grid-verified: 0% clipped).
    make(g, 512, 0.70, dy=25).save(HERE / "icon-maskable-512.png", "PNG", optimize=True)
    print("wrote icon-64/192/512 (0.90) + icon-maskable-512 (0.70, dy=25)")

if __name__ == "__main__":
    main()
