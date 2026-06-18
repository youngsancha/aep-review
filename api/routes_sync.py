"""동기화 트리거.

POST /api/sync         — RSS 신규 에피소드 인제스트 (audio + STT + vocab).
GET  /api/sync/status  — 마지막 실행 상태.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Query

router = APIRouter(prefix="/api/sync", tags=["sync"])
log = logging.getLogger(__name__)

_state: dict[str, Any] = {
    "running": False,
    "last_run_at": None,
    "last_pull_at": None,
    "last_result": None,
    "last_error": None,
}


async def _pipeline(work_limit: int | None) -> None:
    from ingest.cron_fetch import run as run_pipeline

    _state["running"] = True
    _state["last_error"] = None
    try:
        result = await asyncio.to_thread(run_pipeline, 30, work_limit, True)
        _state["last_result"] = result
        _state["last_pull_at"] = datetime.utcnow().isoformat() + "Z"
    except Exception as e:
        log.exception("sync pipeline failed")
        _state["last_error"] = f"{type(e).__name__}: {e}"
    finally:
        _state["running"] = False
        _state["last_run_at"] = datetime.utcnow().isoformat() + "Z"


@router.post("")
async def trigger_sync(
    background: BackgroundTasks,
    limit: int | None = Query(None, description="이번 사이클 처리 max"),
) -> dict[str, Any]:
    if _state["running"]:
        return {"status": "already_running", "since": _state["last_run_at"]}
    background.add_task(_pipeline, limit)
    return {"status": "started"}


@router.get("/status")
def sync_status() -> dict[str, Any]:
    return dict(_state)
