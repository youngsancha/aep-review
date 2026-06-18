"""에피소드 라우트 — list / detail / audio stream / transcript."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .db import connect

router = APIRouter(prefix="/api/episodes", tags=["episodes"])


@router.get("")
def list_episodes() -> list[dict[str, Any]]:
    """모든 에피소드. 최신순. vocab/transcript 진행상태 chip 데이터 포함."""
    with connect() as conn:
        rows = conn.execute(
            """SELECT e.id, e.guid, e.season, e.episode_no, e.title, e.pub_date,
                      e.duration_sec, e.audio_path IS NOT NULL AS has_audio,
                      e.transcribed_at, e.vocab_extracted_at,
                      (SELECT COUNT(*) FROM vocab_cards v WHERE v.episode_id = e.id) AS vocab_count
               FROM episodes e
               ORDER BY e.pub_date DESC"""
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/{episode_id}")
def get_episode(episode_id: int) -> dict[str, Any]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM episodes WHERE id = ?", (episode_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "episode not found")
        vocab = conn.execute(
            """SELECT id, term, kind, definition, example_sentence,
                      sentence_start_sec, sentence_end_sec
               FROM vocab_cards WHERE episode_id = ?
               ORDER BY (sentence_start_sec IS NULL), sentence_start_sec ASC, id ASC""",
            (episode_id,),
        ).fetchall()

    transcript = None
    if row["transcript_path"]:
        p = Path(row["transcript_path"])
        if p.exists():
            try:
                transcript = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                transcript = None

    out = dict(row)
    out["vocab"] = [dict(v) for v in vocab]
    out["transcript"] = transcript
    return out


@router.get("/{episode_id}/audio")
def stream_audio(episode_id: int):
    with connect() as conn:
        row = conn.execute(
            "SELECT audio_path FROM episodes WHERE id = ?", (episode_id,)
        ).fetchone()
    if not row or not row["audio_path"]:
        raise HTTPException(404, "audio not available")
    p = Path(row["audio_path"])
    if not p.exists():
        raise HTTPException(404, "audio file missing")
    return FileResponse(p, media_type="audio/mpeg")
