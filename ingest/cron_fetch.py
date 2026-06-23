"""신규 에피소드 인제스트 orchestrator (Supabase sink).

흐름: RSS → (Supabase upsert) → STT(임시 다운→transcript Storage 업로드) → vocab+TTS.
각 단계 실패해도 다음 단계 시도 (멱등성 — Supabase 가 무엇이 처리됐는지 추적).

CLI:
    python -m ingest.cron_fetch                  # 신규 에피소드만
    python -m ingest.cron_fetch --limit 5        # 이번 사이클 최대 5개 처리
    python -m ingest.cron_fetch --rss-limit 30   # RSS 30개까지만 본 후 작업
    python -m ingest.cron_fetch --no-vocab       # vocab 추출 스킵 (claude CLI 없을 때)
"""
from __future__ import annotations

import argparse
import logging
from typing import Any

from ingest.rss_fetch import fetch_feed, upsert_episodes
from ingest.shows import DEFAULT_SHOW, rss_for
from ingest.transcribe import transcribe_pending

log = logging.getLogger(__name__)


def run(rss_limit: int | None = 30, work_limit: int | None = None,
        do_vocab: bool = True, show: str | None = None) -> dict[str, Any]:
    # show=None(기본): 레거시 단일쇼(aep 피드, show 컬럼 미기록 → 마이그레이션 전에도 안전).
    # show='allears' 등: 멀티-쇼 적재(컬럼 기록·쇼별 필터). 일일 cron 은 --show 없이 안전하게 돈다.
    items = fetch_feed(limit=rss_limit, rss_url=rss_for(show or DEFAULT_SHOW))
    added, skipped = upsert_episodes(items, show)
    log.info("rss[%s]: fetched=%d added=%d skipped=%d", show or DEFAULT_SHOW, len(items), added, skipped)

    transcribed = transcribe_pending(limit=work_limit, show=show)
    log.info("stt: transcribed=%d", transcribed)

    extracted = 0
    if do_vocab:
        try:
            from ingest.extract_vocab import extract_pending
            extracted = extract_pending(limit=work_limit, show=show)
            log.info("vocab: extracted=%d episodes", extracted)
        except Exception:
            log.exception("vocab extraction skipped")

    return {
        "rss_added": added,
        "rss_skipped": skipped,
        "transcribed": transcribed,
        "vocab_episodes": extracted,
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--rss-limit", type=int, default=30)
    p.add_argument("--limit", type=int, default=None,
                   help="이번 사이클에서 작업(STT/vocab)할 max 개수")
    p.add_argument("--no-vocab", action="store_true")
    p.add_argument("--show", default=None,
                   help="팟캐스트 slug (ingest/shows.py): 미지정=레거시 aep(안전) / allears=멀티-쇼 적재")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    result = run(rss_limit=args.rss_limit, work_limit=args.limit,
                 do_vocab=not args.no_vocab, show=args.show)
    log.info("done[%s]: %s", args.show or DEFAULT_SHOW, result)


if __name__ == "__main__":
    main()
