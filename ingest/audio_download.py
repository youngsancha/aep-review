"""mp3 다운로드 헬퍼 — STT 입력용 임시 파일.

클라우드 모델에선 오디오를 저장하지 않는다(앱은 원본 CDN audio_url 직접 스트리밍).
faster-whisper 입력으로만 잠깐 받았다가 transcribe 단계가 끝나면 삭제한다.
"""
from __future__ import annotations

import logging
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)


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
