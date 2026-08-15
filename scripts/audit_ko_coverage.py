"""사전번역(_ko.json) 커버리지 실측 — '조용한 MyMemory 폴백'을 드러내는 유일한 계측.

왜 이게 필요한가 (2026-08-15):
  앱은 문장 키가 _ko.json 에 없으면 '번역 없음'을 표시하지 않는다. 조용히 MyMemory(무료 MT)로
  폴백한다. MyMemory 는 문장을 고립시켜 번역하므로 대명사·관용구·담화 흐름이 통째로 날아간
  직역이 나온다 — 화면상으론 '번역이 있다'라서 아무도 눈치채지 못한다.
  실제로 최근 50편 기준 aep 31.1% / allears 9.6% 까지 떨어져 있었고, 사용자가 "직역이 심하다"고
  신고하기 전까지 어떤 게이트도 이걸 잡지 못했다. 번역 품질 문제로 보였지만 실은 번역의 부재였다.

왜 조용히 썩는가: _ko.json 의 키는 resegment() 가 만든 문장 텍스트다. 문장 분절 규칙을 고치면
  (그 자체는 옳은 수정이다) 기존 키가 통째로 어긋난다. 번역 스크립트는 멱등이라 '없는 것만'
  채우는데, 아무도 다시 돌리지 않으면 그 회차는 영영 폴백 상태로 남는다.

    python -m scripts.audit_ko_coverage                # 쇼별 최근 50편
    python -m scripts.audit_ko_coverage --newest 20
    python -m scripts.audit_ko_coverage --min-pct 95   # 미달이면 exit 1 (게이트용)
    python -m scripts.audit_ko_coverage --json out.json
"""
from __future__ import annotations

import argparse
import json
import sys

from ingest import store
from scripts.translate_transcripts import resegment, trkey

SHOWS = ("aep", "allears", "wh")


def newest_ids(show: str, n: int) -> list[int]:
    rows = store.client().table("episodes").select("id").eq("show", show).not_.is_(
        "transcribed_at", "null").order("id", desc=True).limit(n).execute().data
    return [r["id"] for r in rows]


def _download(path: str):
    try:
        return json.loads(store.client().storage.from_("transcripts").download(path))
    except Exception:
        return None


def audit_episode(ep_id: int) -> dict:
    tx = _download(f"{ep_id}.json")
    if not tx:
        return {"id": ep_id, "sent": 0, "hit": 0, "pct": None, "note": "자막 없음"}
    sents = [s for s in resegment(tx.get("segments", [])) if s.strip()]
    ko = _download(f"{ep_id}_ko.json")
    note = "" if ko is not None else "_ko.json 없음"
    ko = ko or {}
    hit = sum(1 for s in sents if trkey(s) in ko)
    return {"id": ep_id, "sent": len(sents), "hit": hit,
            "pct": round(hit / len(sents) * 100, 1) if sents else None,
            "orphan_keys": max(0, len(ko) - hit), "note": note}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--newest", type=int, default=50, help="쇼별 최근 N편 (기본 50)")
    p.add_argument("--shows", default=",".join(SHOWS))
    p.add_argument("--min-pct", type=float, default=None,
                   help="쇼별 커버리지가 이 값 미만이면 exit 1 — 게이트/크론용")
    p.add_argument("--json", dest="json_out", default=None, help="회차별 상세를 JSON 으로 저장")
    args = p.parse_args()

    shows = [s.strip() for s in args.shows.split(",") if s.strip()]
    rows, summary, failed = [], {}, []
    for show in shows:
        ids = newest_ids(show, args.newest)
        tot_s = tot_h = 0
        for ep_id in ids:
            r = audit_episode(ep_id)
            r["show"] = show
            rows.append(r)
            tot_s += r["sent"]
            tot_h += r["hit"]
        pct = round(tot_h / tot_s * 100, 1) if tot_s else 0.0
        summary[show] = {"eps": len(ids), "sent": tot_s, "hit": tot_h,
                         "missing": tot_s - tot_h, "pct": pct}
        # 최악의 회차를 같이 보여준다 — 총계는 멀쩡한데 특정 회차만 0% 인 경우가 흔하다.
        worst = sorted((r for r in rows if r["show"] == show and r["pct"] is not None),
                       key=lambda r: r["pct"])[:5]
        summary[show]["worst"] = [{"id": r["id"], "pct": r["pct"], "missing": r["sent"] - r["hit"]}
                                  for r in worst]
        if args.min_pct is not None and pct < args.min_pct:
            failed.append(f"{show} {pct}% < {args.min_pct}%")

    g_s = sum(v["sent"] for v in summary.values())
    g_h = sum(v["hit"] for v in summary.values())
    print(f"=== 사전번역 커버리지 (쇼별 최근 {args.newest}편) ===")
    for show, v in summary.items():
        print(f"  {show:8s} {v['pct']:5.1f}%  {v['hit']:6d}/{v['sent']:6d}  "
              f"미번역 {v['missing']:6d}  ({v['eps']}편)")
        for w in v["worst"]:
            if w["pct"] < 95:
                print(f"           ⚠ ep {w['id']}: {w['pct']}% (미번역 {w['missing']})")
    print(f"  {'전체':8s} {round(g_h / g_s * 100, 1) if g_s else 0:5.1f}%  {g_h}/{g_s}  "
          f"미번역 {g_s - g_h}")
    print("\n미번역 문장은 앱에서 MyMemory(문장 고립 기계번역)로 폴백한다 — 화면엔 번역이 보이므로"
          "\n이 수치를 재지 않으면 품질 저하를 아무도 눈치채지 못한다."
          "\n채우기: python -m scripts.translate_transcripts --ids <id,...>")

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump({"summary": summary, "episodes": rows}, f, ensure_ascii=False, indent=1)
        print(f"\n상세 → {args.json_out}")

    if failed:
        print("\nFAIL: " + " · ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
