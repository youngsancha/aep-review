"""재싱크(--from-r2) 완료 회차 전수 검증 (아침 보고용, 직접 확인).

각 done 회차에 대해 독립적으로:
  A. 싱크: transcript.duration == R2 오디오의 '실제' 길이(헤더 파싱)인가 → Δ
     (--from-r2 는 서빙 오디오를 STT 하므로 구조적으로 Δ≈0 이어야 한다. 독립 측정으로 확증.)
  B. 문장분할: 앱 resegment 를 그대로 포팅해 런온(과도하게 긴 문장)이 없는지.

    python -m scripts.verify_done            # done.json 전 회차 검증 + 요약
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

from dotenv import load_dotenv

from ingest import store
from scripts.verify_hosting import mp3_duration, seg_quality

R2 = "https://pub-6226ae33abbc474dbea6ae140582eb8d.r2.dev"


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    load_dotenv(store.PROJECT_ROOT / ".env")
    supa = os.environ["SUPABASE_URL"].rstrip("/")
    st = f"{supa}/storage/v1/object/public"
    done = sorted(json.loads((store.PROJECT_ROOT / "data" / "retranscribe_done.json").read_text()))

    print(f"=== 재싱크 완료 {len(done)}회차 직접 검증 (싱크 Δ + 문장분할) ===")
    ok = near = bad = runon_eps = err = 0
    for eid in done:
        try:
            t = json.load(urllib.request.urlopen(f"{st}/transcripts/{eid}.json", timeout=30))
            tdur = t.get("duration") or (t["segments"][-1]["end"] if t.get("segments") else 0)
            req = urllib.request.Request(f"{R2}/{eid}.mp3", method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
            clen = int(urllib.request.urlopen(req, timeout=30).headers.get("Content-Length") or 0)
            adur = mp3_duration(f"{R2}/{eid}.mp3", clen) or 0
            d = adur - tdur
            q = seg_quality(t.get("segments"))
            sflag = "OK " if abs(d) <= 3 else ("~  " if abs(d) <= 15 else "BAD")
            if abs(d) <= 3:
                ok += 1
            elif abs(d) <= 15:
                near += 1
            else:
                bad += 1
            if q.get("runons"):
                runon_eps += 1
            rtag = f" 런온{q['runons']}(최대{q['max_w']}w/{q['max_dur']}s)" if q.get("runons") else ""
            print(f"  [{sflag}] ep{eid}: tx{tdur:.0f}s vs audio{adur:.0f}s (Δ{d:+.1f}s) · 문장{q['n']}{rtag}")
        except Exception as ex:
            err += 1
            print(f"  [?  ] ep{eid}: {str(ex)[:60]}")
    print(f"\n=== 요약 ===")
    print(f"싱크: 완벽(Δ≤3s)={ok}  근사(≤15s)={near}  불량(>15s)={bad}  측정실패={err}")
    print(f"문장분할: 런온 잔존 회차={runon_eps}")
    print("✅ 전 회차 싱크완벽·런온0" if (bad == 0 and runon_eps == 0 and err == 0) else "⚠ 위 플래그 확인")


if __name__ == "__main__":
    main()
