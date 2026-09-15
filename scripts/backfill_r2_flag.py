"""이미 R2 에 호스팅됐지만 transcript JSON 에 `r2_audio` 플래그가 없는 회차를 제자리에서 패치한다.

배경(실측 2026-09-14): ingest/transcribe.py 의 직접 업로드 경로(2026-08-24 ~ 09-14)가 오디오는
올리고 mark_hosted 는 했지만 transcript 에 `r2_audio: true` 를 안 실었다. 앱은 그 플래그만 '완벽
싱크'로 취급하므로 09-07 이후 신규 25편이 R2 를 정확히 재생하면서도 "아직 완전 자동싱크 전"
배너를 띄웠다. 파이프라인은 고쳤고(플래그를 싣는다), 이 스크립트는 이미 나간 회차를 되돌린다.

⛔ 판정 기준은 '매니페스트에 있다' 가 아니다 — 옛 host_audio 경로는 오디오를 **다시 받아서**
올렸기 때문에 매니페스트에 있어도 자막과 바이트가 다를 수 있다(megaphone DAI). 여기서는
**R2 객체의 LastModified 가 transcribed_at 직후(기본 10분 안)** 인 회차만 패치한다: 직접 업로드
경로는 transcript 저장 → 같은 파일 업로드를 연달아 하므로(실측 0~131초) 그 창 안의 객체는
'자막을 만든 바로 그 파일' 이다. 그 밖의 회차는 이유와 함께 건너뛰고, 재STT(--from-r2)가 답이다.

transcribed_at 은 건드리지 않는다 — 그 값이 앱의 오프라인 캐시 키라 바꾸면 저장해 둔 오디오가
전부 다시 받아진다(scripts/wh_backfill_video_ids.py 와 같은 제자리 패치 규칙).

사용:
    python -m scripts.backfill_r2_flag            # dry-run: 대상/건너뜀 표만 출력
    python -m scripts.backfill_r2_flag --apply    # 실제 패치
    python -m scripts.backfill_r2_flag --max-gap-sec 600 --ids 1062,1063
"""
from __future__ import annotations

import argparse
import datetime as dt
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest import store  # noqa: E402

log = logging.getLogger("backfill_r2_flag")


def r2_last_modified(ep_id: int) -> dt.datetime | None:
    import botocore
    try:
        return store.r2().head_object(Bucket=store.r2_bucket(), Key=f"{ep_id}.mp3")["LastModified"]
    except botocore.exceptions.ClientError:
        return None


def classify(row: dict, hosted: set[int], max_gap_s: float) -> tuple[str, str, dict | None]:
    """(verdict, reason, transcript). verdict ∈ {patch, skip}."""
    ep_id = int(row["id"])
    t = store.download_transcript(ep_id)
    if not t:
        return "skip", "transcript 없음/다운로드 실패", None
    if isinstance(t.get("r2_audio"), bool):
        return "skip", f"이미 r2_audio={t['r2_audio']}", t
    if ep_id not in hosted:
        return "skip", "매니페스트에 없음(호스팅 안 됨) → 재STT 대상", t
    lm = r2_last_modified(ep_id)
    if lm is None:
        return "skip", "매니페스트엔 있는데 R2 객체 없음", t
    ta = dt.datetime.fromisoformat(row["transcribed_at"].replace("Z", "+00:00"))
    gap = (lm - ta).total_seconds()
    if not (0 <= gap <= max_gap_s):
        return "skip", f"R2 객체가 자막과 같은 실행이 아님(gap={gap:.0f}s) → 재STT 대상", t
    return "patch", f"gap={gap:.0f}s", t


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    p = argparse.ArgumentParser()
    p.add_argument("--apply", action="store_true", help="실제로 transcript 를 패치(기본은 dry-run)")
    p.add_argument("--max-gap-sec", type=float, default=600,
                   help="transcribed_at → R2 LastModified 허용 간격(초). 직접 업로드 경로 실측 최대 131s")
    p.add_argument("--ids", help="쉼표구분 episode id (지정 시 그것만)")
    args = p.parse_args()

    hosted = store.load_hosted(strict=True)
    rows = [r for r in store.episodes_by_recency() if r.get("transcribed_at")]
    if args.ids:
        want = {int(x) for x in args.ids.split(",") if x.strip()}
        rows = [r for r in rows if int(r["id"]) in want]
    # 플래그가 없을 가능성이 있는 회차만 storage 를 읽는다: 매니페스트 회차 전부(옛 경로 포함).
    rows = [r for r in rows if int(r["id"]) in hosted]
    log.info("검사 대상 %d편 (매니페스트 %d, 허용 gap %.0fs)", len(rows), len(hosted), args.max_gap_sec)

    patched, skipped = [], []
    for r in rows:
        ep_id = int(r["id"])
        verdict, why, t = classify(r, hosted, args.max_gap_sec)
        if verdict != "patch":
            if not why.startswith("이미 r2_audio="):
                skipped.append((ep_id, why))
            continue
        if args.apply:
            t["r2_audio"] = True
            store.upload_transcript(ep_id, t)
        patched.append((ep_id, why))
        log.info("%s ep=%s %s", "PATCHED" if args.apply else "would-patch", ep_id, why)

    print(f"\n{'패치' if args.apply else '패치 예정(dry-run)'}: {len(patched)}편")
    for ep_id, why in patched:
        print(f"  {ep_id}  {why}")
    print(f"건너뜀(플래그 없음·패치 불가): {len(skipped)}편")
    for ep_id, why in skipped:
        print(f"  {ep_id}  {why}")
    if not args.apply and patched:
        print("\n--apply 를 붙여 실행하면 위 회차의 transcript 에 r2_audio=true 를 싣습니다.")


if __name__ == "__main__":
    main()
