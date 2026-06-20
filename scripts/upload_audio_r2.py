"""megaphone clean 오디오 → R2 업로드 (클라우드 GitHub Actions 용).

로컬 PC 네트워크가 R2 S3 엔드포인트(<account>.r2.cloudflarestorage.com)를 SNI 필터로 막아도,
GitHub Actions(클라우드)에서는 정상 동작한다. 이 스크립트는 '오디오 업로드만' 한다.

이후 로컬 GPU 가 R2 의 그 오디오를 받아 자막을 재생성한다(scripts.retranscribe --from-r2):
그래야 자막이 R2 오디오와 '같은 바이트'라 싱크가 완벽하고, 광고 로테이션과 무관해진다.

    python -m scripts.upload_audio_r2 --limit 300        # 최신부터, 이미 올라간 건 스킵
    python -m scripts.upload_audio_r2 --redo --limit 300 # 이미 있어도 다시
"""
from __future__ import annotations

import argparse
import logging
import tempfile
import time
from pathlib import Path

from ingest import store
from ingest.audio_download import clean_audio_url, download_to

log = logging.getLogger(__name__)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=300, help="이번 실행 업로드 상한")
    p.add_argument("--redo", action="store_true", help="이미 R2 에 있어도 다시 업로드")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    rows = store.episodes_by_recency()  # 최신부터
    ok = skip = fail = 0
    t0 = time.time()
    for r in rows:
        if ok >= args.limit:
            break
        ep_id = r["id"]
        if not r.get("audio_url"):
            continue
        if not args.redo and store.r2_audio_exists(ep_id):
            skip += 1
            continue
        try:
            with tempfile.TemporaryDirectory(prefix="aep_r2_") as td:
                ap = Path(td) / f"{ep_id}.mp3"
                download_to(clean_audio_url(r["audio_url"]), ap)
                nbytes = store.upload_audio_r2(ep_id, ap)
            ok += 1
            log.info("✓ R2 ep=%s bytes=%s (%d up / %d skip)", ep_id, nbytes, ok, skip)
        except Exception:
            fail += 1
            log.exception("R2 업로드 실패 ep=%s", ep_id)
    log.info("완료: 업로드=%d 스킵=%d 실패=%d (%.0fs)", ok, skip, fail, time.time() - t0)


if __name__ == "__main__":
    main()
