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
        do_vocab: bool = True, show: str = DEFAULT_SHOW) -> dict[str, Any]:
    items = fetch_feed(limit=rss_limit, rss_url=rss_for(show))
    added, skipped = upsert_episodes(items, show)
    log.info("rss[%s]: fetched=%d added=%d skipped=%d", show, len(items), added, skipped)

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
    p.add_argument("--show", default=DEFAULT_SHOW,
                   help="팟캐스트 slug (ingest/shows.py): aep / allears")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    result = run(rss_limit=args.rss_limit, work_limit=args.limit,
                 do_vocab=not args.no_vocab, show=args.show)
    log.info("done[%s]: %s", args.show, result)


if __name__ == "__main__":
    main()
