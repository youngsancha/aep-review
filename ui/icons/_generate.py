"""PWA 아이콘 생성기 — cover-original.jpg(앱 아이콘 원본)에서 모든 크기 생성.

생성물:
  icon-64 / 192 / 512.png   — purpose "any" (정사각 원본 그대로 리사이즈)
  icon-maskable-512.png      — purpose "maskable" (안전영역 안에 들어가게 축소 + 원본 배경색 여백)
  aep-review.ico             — 바탕화면 바로가기/파비콘용 멀티해상도 아이콘

원본이 정사각이 아니어도 OK — 가운데를 정사각으로 잘라 쓴다(세로형 타일 이미지 대응).
실행: python ui/icons/_generate.py   의존: Pillow
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image  # type: ignore

HERE = Path(__file__).resolve().parent
SRC = HERE / "cover-original.jpg"


def _square(img: Image.Image) -> Image.Image:
    """가운데 정사각 크롭(이미 1:1 이면 그대로)."""
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def _bg_color(img: Image.Image) -> tuple[int, int, int]:
    """네 모서리 평균색 — 아이콘 배경(어두운 그라데이션) 추정. maskable 여백에 사용."""
    w, h = img.size
    pts = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    px = [img.getpixel(p) for p in pts]
    return tuple(sum(c[i] for c in px) // len(px) for i in range(3))  # type: ignore[return-value]


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"missing source: {SRC}")
    base = _square(Image.open(SRC).convert("RGB"))

    # purpose "any" — 홈 화면/파비콘. OS 가 알아서 모서리를 둥글린다.
    for size in (64, 192, 512):
        base.resize((size, size), Image.LANCZOS).save(
            HERE / f"icon-{size}.png", "PNG", optimize=True)
        print(f"wrote icon-{size}.png")

    # purpose "maskable" — OS 가 원/둥근사각으로 크롭하므로 핵심(마이크)이 중앙 안전영역(≈80%)
    # 안에 있어야 한다. 원본 배경색으로 채운 캔버스에 92% 로 축소 배치 → 타일이 안전원 안에 완전히 들어옴
    # (흰 여백 금지: 어두운 아이콘엔 흰 모서리가 어색하므로 원본 배경색으로 채움).
    mask_size = 512
    inner = int(mask_size * 0.92)
    canvas = Image.new("RGB", (mask_size, mask_size), _bg_color(base))
    off = (mask_size - inner) // 2
    canvas.paste(base.resize((inner, inner), Image.LANCZOS), (off, off))
    canvas.save(HERE / "icon-maskable-512.png", "PNG", optimize=True)
    print("wrote icon-maskable-512.png")

    # .ico (바탕화면 바로가기 + 파비콘 폴백) — 멀티 해상도 한 파일.
    base.resize((256, 256), Image.LANCZOS).save(
        HERE / "aep-review.ico",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote aep-review.ico")


if __name__ == "__main__":
    main()
