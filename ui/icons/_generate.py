"""PWA 아이콘 생성기 — cover-original.jpg 에서 192/512/maskable.

실행: python ui/icons/_generate.py
의존: Pillow
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image  # type: ignore

HERE = Path(__file__).resolve().parent
SRC = HERE / "cover-original.jpg"


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"missing source: {SRC}")
    cover = Image.open(SRC).convert("RGB")

    # 정사각 트림 (이미 1:1 이지만 안전 보장)
    w, h = cover.size
    side = min(w, h)
    box = ((w - side) // 2, (h - side) // 2,
           (w - side) // 2 + side, (h - side) // 2 + side)
    cover = cover.crop(box)

    for size in (192, 512):
        out = cover.resize((size, size), Image.LANCZOS)
        out.save(HERE / f"icon-{size}.png", "PNG", optimize=True)
        print(f"wrote icon-{size}.png")

    # maskable: 안전영역 80% 안에 표지 들어가도록 흰 배경 + 80% 스케일
    mask_size = 512
    inner = int(mask_size * 0.8)
    mask = Image.new("RGB", (mask_size, mask_size), (255, 255, 255))
    inner_img = cover.resize((inner, inner), Image.LANCZOS)
    off = (mask_size - inner) // 2
    mask.paste(inner_img, (off, off))
    mask.save(HERE / "icon-maskable-512.png", "PNG", optimize=True)
    print("wrote icon-maskable-512.png")

    # 작은 favicon
    fav = cover.resize((64, 64), Image.LANCZOS)
    fav.save(HERE / "icon-64.png", "PNG", optimize=True)
    print("wrote icon-64.png")


if __name__ == "__main__":
    main()
