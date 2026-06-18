"""SRS 라우트 + SM-2 알고리즘 (chcn-teams 와 동일).

- ease(난이도 계수, 초기 2.5)
- interval(다음 복습까지 일수): rep 마다 ease 곱해 늘어남
- 4 grade: Again(0) / Hard(3) / Good(4) / Easy(5)
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .db import connect

router = APIRouter(prefix="/api/srs", tags=["srs"])

Grade = Literal["again", "hard", "good", "easy"]
GRADE_TO_Q = {"again": 0, "hard": 3, "good": 4, "easy": 5}


class ReviewInput(BaseModel):
    card_id: int
    grade: Grade


def sm2_update(ease: float, interval: int, reps: int, grade: Grade) -> tuple[float, int, int]:
    q = GRADE_TO_Q[grade]
    if q < 3:
        return max(1.3, ease - 0.2), 1, 0

    new_reps = reps + 1
    if new_reps == 1:
        new_interval = 1
    elif new_reps == 2:
        new_interval = 6
    else:
        new_interval = max(1, round(interval * ease))

    new_ease = max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
    return new_ease, new_interval, new_reps


@router.get("/queue")
def get_queue(new_limit: int = 5, review_limit: int = 50) -> list[dict[str, Any]]:
    today = date.today().isoformat()
    with connect() as conn:
        review_rows = conn.execute(
            """SELECT s.*, e.title as episode_title, v.example_sentence,
                      v.sentence_start_sec, v.sentence_end_sec, v.kind as vkind
               FROM srs_cards s
               LEFT JOIN episodes e ON e.id = s.episode_id
               LEFT JOIN vocab_cards v ON v.id = s.vocab_id
               WHERE s.due_date <= ? AND s.reps > 0
               ORDER BY s.due_date ASC, s.id ASC
               LIMIT ?""",
            (today, review_limit),
        ).fetchall()
        new_rows = conn.execute(
            """SELECT s.*, e.title as episode_title, v.example_sentence,
                      v.sentence_start_sec, v.sentence_end_sec, v.kind as vkind
               FROM srs_cards s
               LEFT JOIN episodes e ON e.id = s.episode_id
               LEFT JOIN vocab_cards v ON v.id = s.vocab_id
               WHERE s.due_date <= ? AND s.reps = 0
               ORDER BY s.id ASC
               LIMIT ?""",
            (today, new_limit),
        ).fetchall()
    return [dict(r) for r in (*review_rows, *new_rows)]


@router.post("/review")
def review_card(payload: ReviewInput) -> dict[str, Any]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM srs_cards WHERE id = ?", (payload.card_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "card not found")

        new_ease, new_interval, new_reps = sm2_update(
            row["ease"], row["interval_days"], row["reps"], payload.grade
        )
        new_due = (date.today() + timedelta(days=new_interval)).isoformat()

        conn.execute(
            """UPDATE srs_cards
               SET ease = ?, interval_days = ?, reps = ?, due_date = ?
               WHERE id = ?""",
            (new_ease, new_interval, new_reps, new_due, payload.card_id),
        )

    return {
        "card_id": payload.card_id,
        "ease": new_ease,
        "interval_days": new_interval,
        "reps": new_reps,
        "due_date": new_due,
    }


@router.get("/stats")
def get_stats() -> dict[str, Any]:
    today = date.today().isoformat()
    NEW_LIMIT = 5
    REVIEW_LIMIT = 50
    with connect() as conn:
        total = conn.execute("SELECT COUNT(*) AS c FROM srs_cards").fetchone()["c"]
        due_review = conn.execute(
            "SELECT COUNT(*) AS c FROM srs_cards WHERE due_date <= ? AND reps > 0", (today,),
        ).fetchone()["c"]
        due_new = conn.execute(
            "SELECT COUNT(*) AS c FROM srs_cards WHERE due_date <= ? AND reps = 0", (today,),
        ).fetchone()["c"]
        backlog_new = conn.execute(
            "SELECT COUNT(*) AS c FROM srs_cards WHERE due_date > ? AND reps = 0", (today,),
        ).fetchone()["c"]
        learned = conn.execute(
            "SELECT COUNT(*) AS c FROM srs_cards WHERE reps > 0"
        ).fetchone()["c"]
    return {
        "total": total,
        "today_batch": min(due_review, REVIEW_LIMIT) + min(due_new, NEW_LIMIT),
        "today_review": min(due_review, REVIEW_LIMIT),
        "today_new": min(due_new, NEW_LIMIT),
        "backlog_new": backlog_new,
        "learned": learned,
    }
