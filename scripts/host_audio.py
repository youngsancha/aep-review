"""오디오를 R2 에 올려 '자막=오디오' 호스팅 완료 처리 (GPU 불필요, I/O 만).

자막은 이번 세션 백필이 megaphone clean URL 로 만들었다(dcs 캐시). 같은 URL 을 지금 받아 R2 에
올리므로 캐시가 안정적인 한 동일 바이트 → 자막과 일치. 업로드 후 매니페스트(audio_hosted.json)에
등록하면 앱이 그 회차를 R2 에서 스트리밍(광고 로테이션 무관·완전 자동 싱크).

자막 없는 회차는 스킵(아직 보여줄 자막이 없으므로). retranscribe 가 자막을 채우면 다음 실행에 호스팅.

    python -m scripts.host_audio --limit 300        # 자막 있는 회차 중 미호스팅분, 최신부터
    python -m scripts.host_audio --redo --limit 300 # 이미 호스팅돼도 다시 업로드
"""
from __future__ import annotations

import argparse
import json
import logging
import tempfile
import time
from pathlib import Path

from ingest import store
from ingest.audio_download import clean_audio_url, download_to

log = logging.getLogger(__name__)


def realigned_ids() -> set[int]:
    # clean-URL 로 재정렬(aligned)된 회차만 호스팅해야 R2(clean) 오디오와 자막이 일치한다.
    # 구버전 podtrac 자막 회차를 호스팅하면 어긋나므로 제외.
    try:
        return set(json.loads((store.PROJECT_ROOT / "data" / "retranscribe_done.json").read_text(encoding="utf-8")))
    except Exception:
        return set()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=300, help="이번 실행 호스팅 상한")
    p.add_argument("--redo", action="store_true", help="이미 호스팅돼도 다시 업로드")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    rows = store.episodes_by_recency()  # 최신부터
    hosted = set() if args.redo else store.load_hosted()
    aligned = realigned_ids()
    ok = skip = fail = 0
    t0 = time.time()
    for r in rows:
        if ok >= args.limit:
            break
        ep_id = r["id"]
        if ep_id not in aligned:
            continue  # 재정렬(clean-URL)된 회차만 — 자막=clean오디오 일치 보장
        if not r.get("audio_url"):
            continue
        if not r.get("audio_url"):
            continue
        if ep_id in hosted:
            skip += 1
            continue
        try:
            with tempfile.TemporaryDirectory(prefix="aep_host_") as td:
                ap = Path(td) / f"{ep_id}.mp3"
                nbytes = download_to(clean_audio_url(r["audio_url"]), ap)
                store.upload_audio_r2(ep_id, ap)
            store.mark_hosted(ep_id)
            ok += 1
            log.info("✓ hosted ep=%s bytes=%s (%d up / %d skip)", ep_id, nbytes, ok, skip)
        except Exception:
            fail += 1
            log.exception("host 실패 ep=%s", ep_id)
    log.info("완료: hosted=%d skip=%d fail=%d (%.0fs)", ok, skip, fail, time.time() - t0)


if __name__ == "__main__":
    main()
