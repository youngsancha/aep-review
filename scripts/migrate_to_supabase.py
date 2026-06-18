"""기존 로컬 데이터(SQLite + transcripts) → Supabase 1회 마이그레이션.

흐름:
  1. SQLite episodes/vocab_cards/srs_cards → Supabase Postgres (id 보존 upsert)
  2. data/transcripts/{id}.json → Storage 버킷 `transcripts`
  3. 모든 vocab term/example → edge-tts(Jenny) 합성 → Storage 버킷 `tts/{sha1}.mp3`
  4. reset_id_sequences() RPC 로 id 시퀀스 보정

TTS 키·합성·클라이언트는 ingest/store.py 의 단일 출처를 재사용한다.
멱등: 다시 돌려도 upsert/덮어쓰기/존재 스킵으로 안전.

사용:
    # .env 에 SUPABASE_URL / SUPABASE_SERVICE_KEY 채운 뒤
    python -m scripts.migrate_to_supabase
    python -m scripts.migrate_to_supabase --skip-tts        # TTS 생성 생략
    python -m scripts.migrate_to_supabase --only tts        # TTS 만
"""
from __future__ import annotations

import argparse
import asyncio
import logging
from pathlib import Path
from typing import Any, Iterable

from api.db import connect
from ingest import store

log = logging.getLogger("migrate")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TRANSCRIPTS_DIR = PROJECT_ROOT / "data" / "transcripts"
CHUNK = 500


def _chunks(rows: list[dict], n: int = CHUNK) -> Iterable[list[dict]]:
    for i in range(0, len(rows), n):
        yield rows[i : i + n]


def _iso_or_none(v: Any) -> Any:
    """빈 문자열/None → None, 그 외 ISO 문자열 그대로 (Postgres timestamptz 가 파싱)."""
    if v is None:
        return None
    s = str(v).strip()
    return s or None


# ─────────────────────────── 1. 행 이관 ───────────────────────────
def migrate_rows() -> None:
    client = store.client()
    with connect() as conn:
        episodes = [dict(r) for r in conn.execute("SELECT * FROM episodes").fetchall()]
        vocab = [dict(r) for r in conn.execute("SELECT * FROM vocab_cards").fetchall()]
        srs = [dict(r) for r in conn.execute("SELECT * FROM srs_cards").fetchall()]

    ep_rows = [{
        "id": e["id"], "guid": e["guid"], "season": e["season"],
        "episode_no": e["episode_no"], "title": e["title"],
        "pub_date": _iso_or_none(e["pub_date"]), "duration_sec": e["duration_sec"],
        "description": e["description"], "audio_url": e["audio_url"],
        "transcribed_at": _iso_or_none(e["transcribed_at"]),
        "vocab_extracted_at": _iso_or_none(e["vocab_extracted_at"]),
        "created_at": _iso_or_none(e["created_at"]),
    } for e in episodes]

    vocab_rows = [{
        "id": v["id"], "episode_id": v["episode_id"], "term": v["term"],
        "kind": v["kind"], "definition": v["definition"],
        "example_sentence": v["example_sentence"],
        "sentence_start_sec": v["sentence_start_sec"],
        "sentence_end_sec": v["sentence_end_sec"],
        "created_at": _iso_or_none(v["created_at"]),
    } for v in vocab]

    srs_rows = [{
        "id": s["id"], "episode_id": s["episode_id"], "vocab_id": s["vocab_id"],
        "front": s["front"], "back": s["back"], "category": s["category"],
        "ease": s["ease"], "interval_days": s["interval_days"],
        "due_date": s["due_date"], "reps": s["reps"],
        "created_at": _iso_or_none(s["created_at"]),
    } for s in srs]

    for table, rows in [("episodes", ep_rows), ("vocab_cards", vocab_rows), ("srs_cards", srs_rows)]:
        for batch in _chunks(rows):
            client.table(table).upsert(batch, on_conflict="id").execute()
        log.info("upserted %s: %d rows", table, len(rows))

    client.rpc("reset_id_sequences").execute()
    log.info("id 시퀀스 보정 완료")


# ─────────────────────────── 2. transcripts 업로드 ───────────────────────────
def upload_transcripts() -> None:
    client = store.client()
    files = sorted(TRANSCRIPTS_DIR.glob("*.json"),
                   key=lambda p: int(p.stem) if p.stem.isdigit() else 0)
    bucket = client.storage.from_("transcripts")
    n = 0
    for f in files:
        bucket.upload(
            path=f.name, file=f.read_bytes(),
            file_options={"content-type": "application/json", "upsert": "true"},
        )
        n += 1
        if n % 25 == 0:
            log.info("transcripts uploaded %d/%d", n, len(files))
    log.info("transcripts 업로드 완료: %d", n)


# ─────────────────────────── 3. TTS 미리 생성 ───────────────────────────
def _collect_tts_texts() -> list[str]:
    texts: set[str] = set()
    with connect() as conn:
        for r in conn.execute("SELECT term, example_sentence FROM vocab_cards").fetchall():
            for t in (r["term"], r["example_sentence"]):
                if t and t.strip():
                    texts.add(t.strip())
    return sorted(texts)


async def pregen_tts() -> None:
    texts = _collect_tts_texts()
    log.info("TTS 대상 텍스트 %d 개", len(texts))
    n = await store.pregen_tts(texts)
    log.info("TTS 미리 생성 완료: 신규 %d", n)


# ─────────────────────────── main ───────────────────────────
def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--only", choices=["rows", "transcripts", "tts"], help="한 단계만 실행")
    p.add_argument("--skip-rows", action="store_true")
    p.add_argument("--skip-transcripts", action="store_true")
    p.add_argument("--skip-tts", action="store_true")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    store.client()  # .env 검증 (없으면 즉시 종료)

    def want(step: str, skip_flag: bool) -> bool:
        return args.only == step if args.only else not skip_flag

    if want("rows", args.skip_rows):
        migrate_rows()
    if want("transcripts", args.skip_transcripts):
        upload_transcripts()
    if want("tts", args.skip_tts):
        asyncio.run(pregen_tts())

    log.info("마이그레이션 완료")


if __name__ == "__main__":
    main()
