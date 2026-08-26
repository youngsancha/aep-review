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
    python -m scripts.audit_ko_coverage --all -w 12    # 전 회차 (뒤 카탈로그 재번역 규모 산정용)

`--all` audits the whole back catalogue instead of the newest N, which is what sizing a
re-translation costs. It also reports ORPHAN keys — entries in `_ko.json` whose sentence no
longer exists because a `resegment()` change moved the boundary. Orphans are dead weight the app
downloads in full for every episode, and their share is a direct measure of how far an episode
has drifted from the segmentation that produced its translations.

⛔ Read-only, but it is NOT free of timing: `scripts/ko_quality_pass.sh` rewrites these same
`_ko.json` objects while it runs, so a number taken mid-pass is a snapshot of a moving target.
Note the wall-clock time with any figure produced during a pass.
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor

from ingest import store
from scripts.translate_transcripts import resegment, trkey

SHOWS = ("aep", "allears", "wh")


_PAGE = 500   # PostgREST hard-caps a response at 1000 rows; stay well under and paginate.


def newest_ids(show: str, n: int | None) -> list[int]:
    """Transcribed episode ids for `show`, newest first. `n=None` returns every one.

    ⛔ Do not replace this with a single `.limit(n)`: PostgREST truncates any response at 1000
    rows no matter what limit is asked for, and the truncation is silent. A "whole catalogue"
    audit that stopped at 1000 would report a coverage percentage for a subset while reading like
    a complete answer — the same shape of bug as a scraper reporting page 1 of 6 as the total.
    """
    q = store.client().table("episodes").select("id").eq("show", show).not_.is_(
        "transcribed_at", "null").order("id", desc=True)
    if n is not None and n <= _PAGE:
        return [r["id"] for r in q.limit(n).execute().data]
    out: list[int] = []
    start = 0
    while True:
        page = q.range(start, start + _PAGE - 1).execute().data
        out.extend(r["id"] for r in page)
        if len(page) < _PAGE or (n is not None and len(out) >= n):
            break
        start += _PAGE
    return out[:n] if n is not None else out


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
    # `hit` counts SENTENCES that find a translation, so it drives the coverage percentage.
    # ⛔ It must NOT be reused to count orphan keys. It counts with multiplicity: an episode
    # saying "Right." five times contributes 5 hits against a single key. The pre-existing
    # `len(ko) - hit` therefore undercounted dead keys, and could floor to 0 while real orphans
    # remained — a silently wrong number of exactly the kind that has shipped here before.
    # Orphans are a set question: keys the file holds that no current sentence asks for.
    sent_keys = {trkey(s) for s in sents}
    hit = sum(1 for s in sents if trkey(s) in ko)
    orphans = len(set(ko) - sent_keys)
    return {"id": ep_id, "sent": len(sents), "hit": hit,
            "pct": round(hit / len(sents) * 100, 1) if sents else None,
            "ko_keys": len(ko), "orphan_keys": orphans,
            "orphan_pct": round(orphans / len(ko) * 100, 1) if ko else None,
            "note": note}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--newest", type=int, default=50, help="쇼별 최근 N편 (기본 50)")
    p.add_argument("--all", action="store_true", help="전 회차 감사 (--newest 무시)")
    p.add_argument("-w", "--workers", type=int, default=8,
                   help="동시 다운로드 수 (회차당 2개 객체를 받는다; 기본 8)")
    p.add_argument("--shows", default=",".join(SHOWS))
    p.add_argument("--min-pct", type=float, default=None,
                   help="쇼별 커버리지가 이 값 미만이면 exit 1 — 게이트/크론용")
    p.add_argument("--json", dest="json_out", default=None, help="회차별 상세를 JSON 으로 저장")
    args = p.parse_args()

    shows = [s.strip() for s in args.shows.split(",") if s.strip()]
    want = None if args.all else args.newest
    rows, summary, failed = [], {}, []
    for show in shows:
        ids = newest_ids(show, want)
        # Each episode costs two storage downloads and no CPU, so the audit is latency-bound —
        # serial, the full catalogue takes long enough that nobody runs it, which is how it went
        # unmeasured in the first place.
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
            show_rows = list(ex.map(audit_episode, ids))
        tot_s = tot_h = 0
        for r in show_rows:
            r["show"] = show
            rows.append(r)
            tot_s += r["sent"]
            tot_h += r["hit"]
        pct = round(tot_h / tot_s * 100, 1) if tot_s else 0.0
        keys = sum(r.get("ko_keys") or 0 for r in show_rows)
        orph = sum(r.get("orphan_keys") or 0 for r in show_rows)
        summary[show] = {"eps": len(ids), "sent": tot_s, "hit": tot_h,
                         "missing": tot_s - tot_h, "pct": pct,
                         "ko_keys": keys, "orphan_keys": orph,
                         "orphan_pct": round(orph / keys * 100, 1) if keys else None,
                         "eps_no_ko": sum(1 for r in show_rows if r.get("note") == "_ko.json 없음"),
                         "eps_under_50": sum(1 for r in show_rows
                                             if r["pct"] is not None and r["pct"] < 50)}
        # 최악의 회차를 같이 보여준다 — 총계는 멀쩡한데 특정 회차만 0% 인 경우가 흔하다.
        worst = sorted((r for r in rows if r["show"] == show and r["pct"] is not None),
                       key=lambda r: r["pct"])[:5]
        summary[show]["worst"] = [{"id": r["id"], "pct": r["pct"], "missing": r["sent"] - r["hit"]}
                                  for r in worst]
        if args.min_pct is not None and pct < args.min_pct:
            failed.append(f"{show} {pct}% < {args.min_pct}%")

    g_s = sum(v["sent"] for v in summary.values())
    g_h = sum(v["hit"] for v in summary.values())
    scope = "전 회차" if args.all else f"쇼별 최근 {args.newest}편"
    print(f"=== 사전번역 커버리지 ({scope}) ===")
    for show, v in summary.items():
        print(f"  {show:8s} {v['pct']:5.1f}%  {v['hit']:6d}/{v['sent']:6d}  "
              f"미번역 {v['missing']:6d}  ({v['eps']}편, _ko.json 없음 {v['eps_no_ko']}편, "
              f"50%미만 {v['eps_under_50']}편)")
        for w in v["worst"]:
            if w["pct"] < 95:
                print(f"           ⚠ ep {w['id']}: {w['pct']}% (미번역 {w['missing']})")
    print(f"  {'전체':8s} {round(g_h / g_s * 100, 1) if g_s else 0:5.1f}%  {g_h}/{g_s}  "
          f"미번역 {g_s - g_h}")

    # Orphan keys — dead entries from an older segmentation. The app downloads each _ko.json
    # whole, so this is bytes shipped to the phone for sentences that no longer exist.
    g_keys = sum(v["ko_keys"] for v in summary.values())
    g_orph = sum(v["orphan_keys"] for v in summary.values())
    print("\n=== _ko.json 고아 키 (옛 분절이 남긴 죽은 키) ===")
    for show, v in summary.items():
        op = v["orphan_pct"]
        print(f"  {show:8s} 고아 {v['orphan_keys']:6d} / 키 {v['ko_keys']:6d}"
              f"  ({op if op is not None else 0:5.1f}%)")
    print(f"  {'전체':8s} 고아 {g_orph:6d} / 키 {g_keys:6d}"
          f"  ({round(g_orph / g_keys * 100, 1) if g_keys else 0:5.1f}%)")
    worst_orph = sorted((r for r in rows if (r.get("orphan_pct") is not None)),
                        key=lambda r: -r["orphan_pct"])[:8]
    for r in worst_orph:
        print(f"           ⚠ ep {r['id']} ({r['show']}): 고아 {r['orphan_keys']}/{r['ko_keys']}"
              f" = {r['orphan_pct']}%  (문장 {r['sent']}, 적중 {r['hit']})")
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
