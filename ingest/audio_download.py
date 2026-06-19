"""mp3 다운로드 헬퍼 — STT 입력용 임시 파일.

클라우드 모델에선 오디오를 저장하지 않는다(앱은 원본 CDN audio_url 직접 스트리밍).
faster-whisper 입력으로만 잠깐 받았다가 transcribe 단계가 끝나면 삭제한다.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)

# ui/db.js::cleanAudioUrl 과 반드시 동일한 규칙.
# RSS audio_url 은 6단계 광고 추적 래퍼(podtrac→pdst→pscrb→swap→mgln→megaphone)다.
# 이 래퍼로 받으면 megaphone 이 끼우는 동적 광고(DAI) 적재량이 앱이 직접 받는
# traffic.megaphone.fm/<id>.mp3 와 달라져, STT 타임스탬프가 스트림과 어긋난다.
# → STT 도 앱과 "똑같은" clean URL 로 받아야 transcript ≡ stream (광고 포함 동일) → 싱크 0.
_MEGAPHONE = re.compile(r"(traffic\.megaphone\.fm/[A-Za-z0-9_-]+\.mp3)")


def clean_audio_url(u: str | None) -> str | None:
    """광고 추적 래퍼를 벗겨 megaphone CDN 직접 URL 로 (앱과 동일한 바이트)."""
    if not u:
        return u
    m = _MEGAPHONE.search(u)
    return "https://" + m.group(1) if m else u


def download_to(url: str, dest: Path, timeout: float = 60.0) -> int:
    """url → dest 스트림 다운로드 (임시파일 → atomic rename). 반환: byte count."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    total = 0
    with httpx.stream("GET", url, follow_redirects=True, timeout=timeout, headers=headers) as r:
        r.raise_for_status()
        with tmp.open("wb") as f:
            for chunk in r.iter_bytes(chunk_size=64 * 1024):
                f.write(chunk)
                total += len(chunk)
    tmp.replace(dest)
    return total
