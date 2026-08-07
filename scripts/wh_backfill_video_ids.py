"""wh(백악관 브리핑) 기존 회차에 video_id 소급 백필 — Part A(Video 모드) 를 이미 적재된 회차에도.

신규 인제스트(ingest/wh_fetch.py::extract_audio)는 이제 YouTube 영상 id 를 직접 잡아
retranscribe_one() 이 r2_audio 와 같은 방식으로 transcript JSON 에 얹는다(video_id). 이 스크립트는
그 변경 '전'에 이미 STT 까지 끝난 wh 회차들에 소급 적용한다: whitehouse.gov 페이지에서
`yt-dlp --skip-download --print "%(id)s"` 로 가볍게 영상 id 만 뽑고(오디오 재추출·재STT 없음),
기존 transcript JSON 을 내려받아 video_id 를 얹은 뒤 다시 올린다. DB 컬럼은 안 건드린다(마이그레이션 불필요).

⚠ 충돌 방지: 최신 wh 회차(pub_date 최상단)는 기본적으로 건너뛴다. 백그라운드로 도는
ingest.wh_fetch 가 바로 그 회차를 지금 STT 중일 수 있어(같은 transcript JSON 파일을 씀) — 이
스크립트가 동시에 download→patch→upload 하면 그 실행 결과를 덮어써 유실시킬 수 있다.
--include-newest 로 명시 override 하거나(그 ingest 가 안 돌고 있다고 확신할 때만), --ids 로 특정
회차만 지정하면(그 경우 최신-스킵 판정 자체를 안 탄다 — 콜리전 책임은 호출자가 진다).

멱등: transcript 에 이미 video_id 가 있으면 건너뛴다(재실행 안전, 중단 후 이어서 실행 가능).

사용:
    python -m scripts.wh_backfill_video_ids                   # 최신 1건 자동 제외, 나머지 전부
    python -m scripts.wh_backfill_video_ids --limit 10         # 이번 실행 처리 상한
    python -m scripts.wh_backfill_video_ids --dry-run          # 무엇을 할지만 출력, 쓰기 없음
    python -m scripts.wh_backfill_video_ids --ids 501,498      # 이 id 들만(최신-스킵 미적용)
    python -m scripts.wh_backfill_video_ids --include-newest   # 최신도 포함(⚠ 러닝 ingest 없을 때만)
"""
from __future__ import annotations

import argparse
import logging
import subprocess
import sys
from typing import Any

from ingest import store
from ingest.wh_fetch import PAGE_URL, SHOW

log = logging.getLogger("wh_backfill_video_ids")


def resolve_video_id(page_url: str) -> str | None:
    """whitehouse.gov 브리핑 페이지 → 임베드된 YouTube 영상 id, 오디오 다운로드 없이(가볍다).
    extract_audio()(ingest/wh_fetch.py)와 같은 봇우회 옵션(player_client)을 쓴다 — 같은 페이지·
    같은 임베드라 필요. 익스트랙터가 youtube 가 아니면(예: 페이지가 바뀌었거나 임베드가 아니면)
    None — C-SPAN 등 비-YouTube id 를 잘못 채우지 않는다(extract_audio 의 같은 가드와 대칭)."""
    cmd = [
        sys.executable, "-m", "yt_dlp", "--skip-download", "--print", "%(extractor)s|%(id)s",
        "--no-playlist", "--socket-timeout", "60", "--no-warnings", "--quiet",
        "--extractor-args", "youtube:player_client=tv,web_safari,mweb,default",
        page_url,
    ]
    try:
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=120)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        log.exception("yt-dlp id 조회 실패: %s", page_url)
        return None
    out = proc.stdout.strip()
    if "|" not in out:
        return None
    extractor, vid = out.split("|", 1)
    vid = vid.strip()
    return vid if (vid and "youtube" in extractor.lower()) else None


def select_targets(rows: list[dict[str, Any]], ids: list[int] | None, skip_newest: bool) -> list[dict[str, Any]]:
    """순수 함수(단위검증 대상).
    ids 지정 시 그 id 들만(순서는 rows 순서 유지) — 최신-스킵을 안 탄다(명시적 지정 = 콜리전은
    호출자 책임). 아니면 skip_newest 면 '가장 최근에 적재된 1건'을 제외한 나머지 전부.

    ⚠ 제외 기준은 **id 최대값**이지 pub_date 최신이 아니다. 이 가드의 목적은 지금 인제스트가
    쓰고 있는 회차의 transcript JSON 을 동시에 덮어쓰지 않는 것인데, 인제스트가 만드는 행은
    항상 id 가 가장 큰 행이다. pub_date 로 고르면(브리핑은 최신순으로 적재되므로) 엉뚱하게
    '가장 오래전에 적재된' 회차를 보호하고 정작 쓰기 중인 회차는 무방비로 둔다 — 실제로
    첫 실행에서 ep554(pub_date 최신, id 최소)가 누락됐다."""
    if ids:
        idset = set(ids)
        return [r for r in rows if r["id"] in idset]
    if skip_newest and rows:
        newest = max(r["id"] for r in rows)
        return [r for r in rows if r["id"] != newest]
    return list(rows)


def backfill_one(row: dict[str, Any], dry_run: bool = False) -> str:
    """반환: patched / skipped-has-id / skipped-no-transcript / skipped-no-video-id / dry-run."""
    ep_id, guid = row["id"], row["guid"]
    tr = store.download_transcript(ep_id)
    if not tr:
        return "skipped-no-transcript"
    if tr.get("video_id"):
        return "skipped-has-id"   # 멱등 — 이미 채워진 회차(신규 인제스트 경로로 들어온 것 포함)는 건너뜀
    vid = resolve_video_id(PAGE_URL.format(slug=guid))
    if not vid:
        return "skipped-no-video-id"
    if dry_run:
        log.info("[dry-run] ep=%s guid=%s → video_id=%s (안 씀)", ep_id, guid, vid)
        return "dry-run"
    tr["video_id"] = vid
    store.upload_transcript(ep_id, tr)
    log.info("patched ep=%s guid=%s video_id=%s", ep_id, guid, vid)
    return "patched"


def wh_transcribed_rows() -> list[dict[str, Any]]:
    """show='wh' 이고 이미 STT 완료(transcribed_at not null)인 회차, 최신순(pub_date desc, id desc —
    동률 pub_date 를 위한 2차 키, wh_fetch.discover_new 와 같은 전순서 원칙)."""
    q = (store.client().table("episodes")
         .select("id, guid, pub_date")
         .eq("show", SHOW).not_.is_("transcribed_at", "null"))
    return q.order("pub_date", desc=True).order("id", desc=True).execute().data or []


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None, help="이번 실행 처리 상한(기본: 대상 전부)")
    p.add_argument("--ids", default=None, help="쉼표구분 episode id — 지정 시 이것만(최신-스킵 미적용)")
    p.add_argument("--include-newest", action="store_true",
                   help="최신 wh 회차도 포함 — ⚠ ingest.wh_fetch 가 그 회차를 지금 STT 중이 아닐 때만")
    p.add_argument("--dry-run", action="store_true", help="무엇을 백필할지만 출력, transcript 는 안 건드림")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    ids = [int(x) for x in args.ids.split(",") if x.strip()] if args.ids else None
    rows = wh_transcribed_rows()
    skip_newest = not args.include_newest
    if not ids and skip_newest and rows:
        log.info("최신 wh 회차 스킵(러닝 중일 수 있는 ingest 와 콜리전 방지): ep=%s guid=%s",
                 rows[0]["id"], rows[0]["guid"])
    targets = select_targets(rows, ids, skip_newest)
    if args.limit:
        targets = targets[: args.limit]
    if not targets:
        log.info("백필 대상 없음(전부 이미 video_id 있거나, 대상 0건)")
        return 0

    counts: dict[str, int] = {}
    for row in targets:
        status = backfill_one(row, dry_run=args.dry_run)
        counts[status] = counts.get(status, 0) + 1
    log.info("wh_backfill_video_ids 완료: %s (대상 %d건)", counts, len(targets))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
