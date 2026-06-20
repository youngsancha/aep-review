"""Supabase 데이터 접근 계층 (인제스트 sink).

기존 SQLite(api/db.py) 자리. faster-whisper/claude 로직은 그대로 두고,
"무엇이 처리됐나" 추적 + 결과 write 만 Supabase 로.

service_role 키 사용 (RLS 우회) — .env 의 SUPABASE_URL / SUPABASE_SERVICE_KEY.
TTS 키 공식·합성 헬퍼의 단일 출처 (마이그레이션 스크립트·프론트와 동일해야 함).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from datetime import date, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

import edge_tts
from dotenv import load_dotenv
from supabase import Client, create_client

log = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 프론트(ui/tts.js)·마이그레이션과 반드시 동일.
TTS_VOICE = "en-US-JennyNeural"
TTS_RATE = "-5%"


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


@lru_cache(maxsize=1)
def client() -> Client:
    load_dotenv(PROJECT_ROOT / ".env")
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        raise SystemExit("SUPABASE_URL / SUPABASE_SERVICE_KEY 가 .env 에 없습니다. supabase/README.md 참고.")
    return create_client(url, key)


# ─────────────────────────── episodes ───────────────────────────
def existing_guids() -> set[str]:
    res = client().table("episodes").select("guid").execute()
    return {r["guid"] for r in (res.data or [])}


def upsert_episodes(items: list[dict[str, Any]]) -> tuple[int, int]:
    """RSS 신규만 insert. 반환: (added, skipped)."""
    have = existing_guids()
    now = _now()
    new_rows = [{
        "guid": it["guid"], "season": it["season"], "episode_no": it["episode_no"],
        "title": it["title"], "pub_date": it["pub_date"] or None,
        "duration_sec": it["duration_sec"], "description": it["description"],
        "audio_url": it["audio_url"], "created_at": now,
    } for it in items if it["guid"] not in have]
    if new_rows:
        client().table("episodes").insert(new_rows).execute()
    return len(new_rows), len(items) - len(new_rows)


def episodes_needing_transcription() -> list[dict[str, Any]]:
    res = (client().table("episodes")
           .select("id, audio_url, duration_sec")
           .is_("transcribed_at", "null").not_.is_("audio_url", "null")
           .order("pub_date", desc=True).execute())
    return res.data or []


def episodes_needing_vocab() -> list[dict[str, Any]]:
    res = (client().table("episodes")
           .select("id, title")
           .not_.is_("transcribed_at", "null").is_("vocab_extracted_at", "null")
           .order("pub_date", desc=True).execute())
    return res.data or []


def mark_transcribed(ep_id: int, whisper_duration: float | None) -> None:
    patch: dict[str, Any] = {"transcribed_at": _now()}
    if whisper_duration:
        cur = (client().table("episodes").select("duration_sec").eq("id", ep_id)
               .single().execute().data or {})
        if not cur.get("duration_sec"):  # COALESCE 흉내 — 기존 값 우선
            patch["duration_sec"] = int(whisper_duration)
    client().table("episodes").update(patch).eq("id", ep_id).execute()


def mark_vocab_extracted(ep_id: int) -> None:
    client().table("episodes").update({"vocab_extracted_at": _now()}).eq("id", ep_id).execute()


def episodes_by_recency(limit: int | None = None) -> list[dict[str, Any]]:
    """pub_date 내림차순 episode 목록 (재정렬용). audio_url 있는 것만."""
    q = (client().table("episodes")
         .select("id, audio_url, pub_date, transcribed_at, duration_sec")
         .not_.is_("audio_url", "null")
         .order("pub_date", desc=True))
    if limit:
        q = q.limit(limit)
    return q.execute().data or []


def vocab_for_episode(ep_id: int) -> list[dict[str, Any]]:
    res = (client().table("vocab_cards")
           .select("id, example_sentence, sentence_start_sec, sentence_end_sec")
           .eq("episode_id", ep_id).execute())
    return res.data or []


def update_vocab_times(vocab_id: int, start: float | None, end: float | None) -> None:
    client().table("vocab_cards").update(
        {"sentence_start_sec": start, "sentence_end_sec": end}
    ).eq("id", vocab_id).execute()


def episode_title(ep_id: int) -> str | None:
    res = client().table("episodes").select("title").eq("id", ep_id).single().execute()
    return (res.data or {}).get("title")


# ─────────────────────── transcripts (Storage) ───────────────────────
def upload_transcript(ep_id: int, data: dict[str, Any]) -> None:
    payload = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    client().storage.from_("transcripts").upload(
        path=f"{ep_id}.json", file=payload,
        file_options={"content-type": "application/json", "upsert": "true"},
    )


def download_transcript(ep_id: int) -> dict[str, Any] | None:
    try:
        raw = client().storage.from_("transcripts").download(f"{ep_id}.json")
        return json.loads(raw)
    except Exception:
        log.exception("transcript 다운로드 실패 ep=%s", ep_id)
        return None


# ─────────────────────────── vocab + srs ───────────────────────────
def insert_vocab_and_srs(ep_id: int, vocab_list: list[dict[str, Any]]) -> tuple[int, list[str]]:
    """vocab_cards + srs_cards 시드. 반환: (added, tts_texts)."""
    now = _now()
    today = date.today().isoformat()
    added = 0
    tts_texts: list[str] = []
    c = client()
    for v in vocab_list:
        term = (v.get("term") or "").strip()
        if not term:
            continue
        vres = c.table("vocab_cards").insert({
            "episode_id": ep_id, "term": term, "kind": v.get("kind"),
            "definition": v.get("definition"), "example_sentence": v.get("example_sentence"),
            "sentence_start_sec": v.get("sentence_start_sec"),
            "sentence_end_sec": v.get("sentence_end_sec"), "created_at": now,
        }).execute()
        vocab_id = vres.data[0]["id"]

        back = v.get("definition") or ""
        ex = v.get("example_sentence")
        if ex:
            back = f"{back}\n\n— {ex}" if back else f"— {ex}"
        c.table("srs_cards").insert({
            "episode_id": ep_id, "vocab_id": vocab_id, "front": term, "back": back,
            "category": v.get("kind"), "due_date": today, "created_at": now,
        }).execute()
        added += 1
        tts_texts.append(term)
        if ex and ex.strip():
            tts_texts.append(ex.strip())
    return added, tts_texts


# ─────────────────────────── TTS (Storage) ───────────────────────────
def tts_key(text: str, voice: str = TTS_VOICE, rate: str = TTS_RATE) -> str:
    """ui/tts.js 와 동일한 sha1 키 — 미리 생성 TTS 파일명의 단일 출처."""
    return hashlib.sha1(f"{voice}|{rate}|{text}".encode("utf-8")).hexdigest()


async def synth(text: str) -> bytes:
    """edge-tts → mp3 bytes."""
    chunks: list[bytes] = []
    communicate = edge_tts.Communicate(text, TTS_VOICE, rate=TTS_RATE)
    async for ev in communicate.stream():
        if ev["type"] == "audio":
            chunks.append(ev["data"])
    return b"".join(chunks)


def existing_tts_names() -> set[str]:
    names: set[str] = set()
    bucket = client().storage.from_("tts")
    offset = 0
    while True:
        page = bucket.list("", {"limit": 1000, "offset": offset})
        if not page:
            break
        names.update(o["name"] for o in page)
        if len(page) < 1000:
            break
        offset += 1000
    return names


async def pregen_tts(texts: list[str], concurrency: int = 5) -> int:
    """주어진 텍스트들을 기본 보이스로 합성해 tts/{sha1}.mp3 업로드. 이미 있으면 스킵."""
    uniq = sorted({t.strip() for t in texts if t and t.strip()})
    existing = existing_tts_names()
    todo = [(t, tts_key(t)) for t in uniq if f"{tts_key(t)}.mp3" not in existing]
    if not todo:
        return 0
    bucket = client().storage.from_("tts")
    sem = asyncio.Semaphore(concurrency)
    # storage3 의 httpx 클라이언트는 스레드 간 동시 호출이 안전하지 않다(HTTP/2 multiplex
    # 를 여러 OS 스레드가 만지면 WinError 10035 / RemoteProtocolError). 합성(edge-tts)은
    # 동시에 두되, 업로드는 이 lock 으로 직렬화해 공유 클라이언트를 한 번에 한 스레드만 쓴다.
    upload_lock = asyncio.Lock()
    done = 0

    def _upload(key: str, data: bytes) -> None:
        for attempt in range(3):  # 일시적 소켓/연결 오류 재시도
            try:
                bucket.upload(
                    path=f"{key}.mp3", file=data,
                    file_options={"content-type": "audio/mpeg", "upsert": "true"},
                )
                return
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(0.5 * (attempt + 1))

    async def worker(text: str, key: str) -> None:
        nonlocal done
        async with sem:
            try:
                data = await synth(text)
                if not data:
                    return
                async with upload_lock:
                    await asyncio.to_thread(_upload, key, data)
                done += 1
            except Exception:
                log.exception("TTS 실패: %r", text[:40])

    await asyncio.gather(*(worker(t, k) for t, k in todo))
    log.info("TTS 업로드: 성공 %d / 대상 %d", done, len(todo))
    return done
