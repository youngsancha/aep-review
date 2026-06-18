"""Edge TTS proxy — Microsoft Azure Neural voices via the public Edge endpoint.

영어 학습용 voice 셋. 디스크 캐시 (data/tts/{sha1}.mp3) → 같은 텍스트+voice 즉시 반환.
"""
from __future__ import annotations

import asyncio
import hashlib
import re
from pathlib import Path

import edge_tts
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

router = APIRouter(prefix="/api/tts", tags=["tts"])

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = PROJECT_ROOT / "data" / "tts"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# 학습용으로 평이 좋은 en-US Neural voices.
ALLOWED_VOICES = {
    "en-US-AriaNeural",       # 여성·표준 뉴스
    "en-US-JennyNeural",      # 여성·따뜻 (Shana 톤에 가까움)
    "en-US-GuyNeural",        # 남성·표준
    "en-US-DavisNeural",      # 남성·캐주얼
    "en-US-AndrewNeural",     # 남성·차분 multilingual
    "en-US-EmmaNeural",       # 여성·캐주얼 multilingual
}
DEFAULT_VOICE = "en-US-JennyNeural"

_locks: dict[str, asyncio.Lock] = {}
_locks_guard = asyncio.Lock()


def _cache_path(text: str, voice: str, rate: str) -> Path:
    key = hashlib.sha1(f"{voice}|{rate}|{text}".encode("utf-8")).hexdigest()
    return CACHE_DIR / f"{key}.mp3"


async def _get_lock(key: str) -> asyncio.Lock:
    async with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            _locks[key] = lock
        return lock


@router.get("")
async def tts(
    text: str = Query(..., min_length=1, max_length=600),
    voice: str = Query(DEFAULT_VOICE),
    rate: str = Query("-5%", pattern=r"^[+-]\d{1,3}%$"),
):
    if voice not in ALLOWED_VOICES:
        raise HTTPException(400, f"voice not allowed: {voice}")
    clean = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text).strip()
    if not clean:
        raise HTTPException(400, "empty text")

    path = _cache_path(clean, voice, rate)
    if not path.exists():
        lock = await _get_lock(path.name)
        async with lock:
            if not path.exists():
                tmp = path.with_suffix(".mp3.tmp")
                try:
                    communicate = edge_tts.Communicate(clean, voice, rate=rate)
                    await communicate.save(str(tmp))
                    tmp.replace(path)
                except Exception as e:
                    if tmp.exists():
                        tmp.unlink(missing_ok=True)
                    raise HTTPException(502, f"tts synth failed: {e}")

    return FileResponse(
        path,
        media_type="audio/mpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/voices")
async def list_voices():
    return {"default": DEFAULT_VOICE, "voices": sorted(ALLOWED_VOICES)}
