"""Essentials 카드(term + example)의 네이티브 음성(edge-tts Jenny, -5%)을 사전생성해 Storage tts/ 에 올린다.

프론트 speak() 는 동일 sha1 키(store.tts_key == ui/tts.js)로 tts/{sha1}.mp3 를 먼저 찾으므로,
업로드만 해두면 Essentials 카드가 브라우저 TTS 폴백 대신 '일관된 고품질 네이티브 음성'으로 재생된다.
멱등: 이미 있는 키는 store.pregen_tts 가 스킵.

    python -m scripts.pregen_essentials_tts
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from ingest import store

PACK = Path(__file__).resolve().parent.parent / "ui" / "data" / "essentials.json"


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    pack = json.loads(PACK.read_text(encoding="utf-8"))
    texts: list[str] = []
    for c in pack["cards"]:
        if c.get("term"):
            texts.append(c["term"])
        if c.get("example"):
            texts.append(c["example"])
    print(f"essentials TTS 대상: {len(texts)} (고유 {len(set(texts))})", flush=True)
    n = asyncio.run(store.pregen_tts(texts))
    print(f"pregen 완료: 신규 {n}개 업로드 (나머지는 기존 존재 → 스킵)")


if __name__ == "__main__":
    main()
