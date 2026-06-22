"""_preKo 적중률 진단 (읽기 전용) — 앱(episode.js)이 자막 사전번역(_ko.json)을 얼마나 적중시키는지 측정.

resegment 파리티(tests/test_resegment_parity.py)로 JS≡Python 분절이 증명됐으므로, Python resegment 로
만든 trKey 가 Storage `{id}_ko.json` 키와 일치하는 비율 = 앱이 재생 중 _preKo 로 직역 MyMemory 를
대체하는 실제 비율. 적중 못 한 문장은 런타임 MyMemory 폴백으로 새므로 이 수치가 곧 '직역 잔존율'의 보수.

읽기 전용: Storage 의 {id}.json / {id}_ko.json 을 download 만 한다(절대 upload X). 진행 중 번역 잡과
무관(현 시점 스냅샷). 분절·키 로직은 scripts/translate_transcripts 의 것을 그대로 재사용(중복 X).

    python -m ingest.diag_preko                # transcribed 된 전체
    python -m ingest.diag_preko --only 268
    python -m ingest.diag_preko --ids 268,260,250
    python -m ingest.diag_preko --limit 20     # 최근 20개(빠른 표본)
"""
from __future__ import annotations

import argparse
import sys

from scripts.translate_transcripts import (
    episode_ids,
    fetch_transcript,
    load_existing,
    resegment,
    trkey,
)


def hit_rate(ep_id: int) -> tuple[int, int, bool]:
    """(적중 문장수, 총 문장수, _ko.json 존재여부). 자막 없으면 (0,0,False)."""
    tr = fetch_transcript(ep_id)
    if not tr:
        return (0, 0, False)
    sents = [s for s in resegment(tr.get("segments", [])) if s.strip()]
    ko = load_existing(ep_id)            # 읽기 전용 download. 없으면 {}
    if not sents:
        return (0, 0, bool(ko))
    keys = [trkey(s) for s in sents]
    hit = sum(1 for k in keys if k in ko)
    return (hit, len(sents), bool(ko))


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--only", type=int, default=None)
    p.add_argument("--ids", type=str, default=None, help="콤마구분 id 목록")
    p.add_argument("--limit", type=int, default=None, help="최근 N개만")
    args = p.parse_args()

    if args.only:
        ids = [args.only]
    elif args.ids:
        ids = [int(x) for x in args.ids.split(",") if x.strip()]
    else:
        ids = episode_ids()
        if args.limit:
            ids = ids[: args.limit]

    tot_hit = tot_sent = with_ko = missing = full = 0
    print(f"{'ep':>5}  {'hit/total':>12}  {'rate':>6}  ko?")
    for ep_id in ids:
        hit, total, has_ko = hit_rate(ep_id)
        if not has_ko:
            missing += 1
        if total:
            tot_hit += hit
            tot_sent += total
            rate = hit / total
            if rate >= 0.999:
                full += 1
            if has_ko:
                with_ko += 1
            print(f"{ep_id:>5}  {hit:>5}/{total:<6}  {rate*100:>5.1f}%  {'Y' if has_ko else '-'}")
        else:
            print(f"{ep_id:>5}  {'(no transcript/sents)':>12}")
    agg = (tot_hit / tot_sent * 100) if tot_sent else 0.0
    print("─" * 40)
    print(f"에피소드 {len(ids)} | _ko.json 보유 {with_ko}, 없음 {missing}, 100%적중 {full}")
    print(f"문장 적중 {tot_hit}/{tot_sent} = {agg:.1f}%  (= _preKo 로 직역 대체되는 비율)")


if __name__ == "__main__":
    main()
