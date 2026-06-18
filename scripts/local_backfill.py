"""사용자 PC GPU 에서 일괄 백필 → Supabase.

이제 파이프라인 본체는 ingest.cron_fetch.run (Supabase sink). 이 스크립트는
첫 셋업용 편의 래퍼다. 오디오는 STT 입력으로만 임시 다운되고 저장하지 않는다.

CLI:
    python scripts/local_backfill.py                      # RSS + 미처리 모두 (STT+vocab+TTS)
    python scripts/local_backfill.py --episodes 50        # 이 사이클 작업 max 50개
    python scripts/local_backfill.py --skip-vocab         # claude CLI 없을 때 (STT 만)
    python scripts/local_backfill.py --rss-only           # RSS 메타만 적재
    python scripts/local_backfill.py --rss-limit 263      # RSS 전체 메타

권장 흐름 (첫 셋업):
    python scripts/local_backfill.py --rss-limit 263 --rss-only
    python scripts/local_backfill.py --episodes 20        # 시범 20개부터
    python scripts/local_backfill.py                      # 만족하면 전체
"""
from __future__ import annotations

import argparse
import logging
import time

from ingest.cron_fetch import run
from ingest.rss_fetch import fetch_feed, upsert_episodes

log = logging.getLogger(__name__)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--rss-limit", type=int, default=None,
                   help="RSS 에서 가져올 메타 max (default: 전체)")
    p.add_argument("--episodes", type=int, default=None,
                   help="이 사이클에서 STT/vocab 처리할 max")
    p.add_argument("--rss-only", action="store_true", help="메타 적재만, 작업 안함")
    p.add_argument("--skip-vocab", action="store_true")
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    t0 = time.time()

    if args.rss_only:
        items = fetch_feed(limit=args.rss_limit)
        added, skipped = upsert_episodes(items)
        log.info("rss-only: items=%d added=%d skipped=%d (%.1fs)",
                 len(items), added, skipped, time.time() - t0)
        return

    result = run(rss_limit=args.rss_limit, work_limit=args.episodes,
                 do_vocab=not args.skip_vocab)
    log.info("done: %s (%.1fs)", result, time.time() - t0)


if __name__ == "__main__":
    main()
