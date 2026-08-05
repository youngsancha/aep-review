"""신규 에피소드 인제스트 orchestrator (Supabase sink).

흐름: RSS → (Supabase upsert) → STT(임시 다운→transcript Storage 업로드) → vocab+TTS.
각 단계 실패해도 다음 단계 시도 (멱등성 — Supabase 가 무엇이 처리됐는지 추적).

CLI:
    python -m ingest.cron_fetch                  # 신규 에피소드만
    python -m ingest.cron_fetch --limit 5        # 이번 사이클 최대 5개 처리
    python -m ingest.cron_fetch --rss-limit 30   # RSS 30개까지만 본 후 작업
    python -m ingest.cron_fetch --no-vocab       # vocab 추출 스킵 (claude CLI 없을 때)
    python -m ingest.cron_fetch --time-budget-min 50   # 50분 안에 끝날 만큼만 (CI)
    python -m ingest.cron_fetch --no-rss --shard 0 --shards 4   # 백필 병렬 샤드
"""
from __future__ import annotations

import argparse
import logging
from typing import Any

from ingest.rss_fetch import fetch_feed, upsert_episodes
from ingest.shows import DEFAULT_SHOW, SHOW_BY_SLUG, rss_for, show_slugs
from ingest.transcribe import transcribe_pending

log = logging.getLogger(__name__)


def run(rss_limit: int | None = 30, work_limit: int | None = None,
        do_vocab: bool = True, show: str | None = None,
        time_budget_s: float | None = None, shard: int = 0, shards: int = 1,
        do_rss: bool = True) -> dict[str, Any]:
    # show=None(기본): 레거시 단일쇼(aep 피드, show 컬럼 미기록 → 마이그레이션 전에도 안전).
    # show='allears' 등: 멀티-쇼 적재(컬럼 기록·쇼별 필터). 일일 cron 은 --show 없이 안전하게 돈다.
    added = skipped = 0
    if do_rss:
        items = fetch_feed(limit=rss_limit, rss_url=rss_for(show or DEFAULT_SHOW))
        added, skipped = upsert_episodes(items, show)
        log.info("rss[%s]: fetched=%d added=%d skipped=%d", show or DEFAULT_SHOW, len(items), added, skipped)
        if show is None:
            # ⛔ 이 루프가 없으면 일일 cron 은 영원히 DEFAULT_SHOW 피드 하나만 읽는다.
            # 실제로 그렇게 돌았다: aep-sync 는 매일 success 인데 All Ears English 는
            # 2026-06-24 이후 6주간 한 편도 안 들어왔다(그날은 사람이 --show 로 수동 실행).
            # RSS 소스가 있는 쇼는 전부 훑는다(wh 는 rss=None → 전용 wh-sync 워크플로).
            for slug in show_slugs():
                if slug == DEFAULT_SHOW or not (SHOW_BY_SLUG.get(slug) or {}).get("rss"):
                    continue
                extra = fetch_feed(limit=rss_limit, rss_url=rss_for(slug))
                a, s = upsert_episodes(extra, slug)
                added += a
                skipped += s
                log.info("rss[%s]: fetched=%d added=%d skipped=%d", slug, len(extra), a, s)

    transcribed = transcribe_pending(limit=work_limit, show=show,
                                     time_budget_s=time_budget_s, shard=shard, shards=shards)
    log.info("stt: transcribed=%d", transcribed)

    extracted = 0
    if do_vocab and shards > 1:
        # vocab 큐는 샤딩되지 않는다 → 병렬 샤드가 전부 같은 큐를 집어 중복 추출한다.
        log.info("vocab: skipped (sharded run)")
    elif do_vocab:
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
    p.add_argument("--no-rss", action="store_true",
                   help="RSS 단계 스킵 — 이미 적재된 백로그만 처리할 때")
    p.add_argument("--time-budget-min", type=float, default=None,
                   help="STT 를 이 시간 안에 끝날 만큼만 하고 깨끗이 종료. CI job timeout 보다 작게 잡을 것 "
                        "— 넘기면 job 이 STT 도중에 강제 종료돼 그 에피소드의 연산이 통째로 버려진다")
    p.add_argument("--shard", type=int, default=0, help="이 job 이 맡을 샤드 번호 (0 부터)")
    p.add_argument("--shards", type=int, default=1, help="총 샤드 수 (id 모듈로 분배)")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    result = run(rss_limit=args.rss_limit, work_limit=args.limit,
                 do_vocab=not args.no_vocab, show=args.show,
                 time_budget_s=(args.time_budget_min or 0) * 60 or None,
                 shard=args.shard, shards=args.shards, do_rss=not args.no_rss)
    log.info("done[%s]: %s", args.show or DEFAULT_SHOW, result)


if __name__ == "__main__":
    main()
