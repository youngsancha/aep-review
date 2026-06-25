"""audio_hosted.json 재구축 — R2 버킷 실재({id}.mp3 존재)를 단일 진실로 삼는다.

복구 배경(2026-06-24): mark_hosted 의 read-modify-write 가 load_hosted() 실패(네트워크 블립) 시
빈 집합을 받아, 기존 매니페스트(AEP 268개 포함)를 통째로 축소 덮어썼다 → 앱이 AEP 전 회차를
megaphone(DAI)로 재생 → 매 재생마다 다른 광고로 자막 desync. R2 에 {id}.mp3 가 있으면
retranscribe_one 이 STT 한 '바로 그 바이트'가 호스팅된 것(transcript ≡ R2)이므로 매니페스트에 포함한다.

    python -m scripts.rebuild_hosted_manifest            # R2 실재로 매니페스트 재구축
    python -m scripts.rebuild_hosted_manifest --dry-run  # 쓰지 않고 비교만
"""
from __future__ import annotations

import argparse
import json

from ingest import store


def list_r2_ids() -> set[int]:
    r2 = store.r2()
    bucket = store.r2_bucket()
    ids: set[int] = set()
    tok = None
    while True:
        kw = {"Bucket": bucket, "MaxKeys": 1000}
        if tok:
            kw["ContinuationToken"] = tok
        resp = r2.list_objects_v2(**kw)
        for o in resp.get("Contents", []):
            k = o["Key"]
            if k.endswith(".mp3") and k[:-4].isdigit():
                ids.add(int(k[:-4]))
        if resp.get("IsTruncated"):
            tok = resp.get("NextContinuationToken")
        else:
            break
    return ids


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    r2_ids = sorted(list_r2_ids())
    try:
        cur = sorted(store.load_hosted())
    except Exception as e:  # noqa: BLE001
        cur = []
        print("현재 매니페스트 로드 실패(무시하고 R2 기준으로 재구축):", e)

    added = sorted(set(r2_ids) - set(cur))
    print(f"R2 실재 id: {len(r2_ids)} (min {r2_ids[0]} max {r2_ids[-1]})")
    print(f"현재 매니페스트: {len(cur)} → 재구축 후: {len(r2_ids)} (추가 {len(added)})")
    if added:
        print("  복구되는 id 샘플:", added[:12], "..." if len(added) > 12 else "")
    if args.dry_run:
        print("[dry-run] 쓰지 않음.")
        return

    body = json.dumps(r2_ids).encode("utf-8")
    sb = store.client().storage.from_("transcripts")
    try:
        sb.update(store.HOSTED_MANIFEST, body, {"content-type": "application/json", "upsert": "true"})
    except Exception:  # noqa: BLE001
        sb.upload(store.HOSTED_MANIFEST, body, {"content-type": "application/json", "upsert": "true"})
    print(f"✓ audio_hosted.json 재구축 완료: {len(r2_ids)} ids")


if __name__ == "__main__":
    main()
