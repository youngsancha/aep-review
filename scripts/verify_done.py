"""재싱크(--from-r2) 완료 회차 전수 검증 (아침 보고용, 직접 확인).

각 done 회차에 대해 독립적으로:
  A. 싱크: transcript.duration == R2 오디오의 '실제' 길이(헤더 파싱)인가 → Δ
     (--from-r2 는 서빙 오디오를 STT 하므로 구조적으로 Δ≈0 이어야 한다. 독립 측정으로 확증.)
  B. 문장분할: 앱 resegment 를 그대로 포팅해 런온(과도하게 긴 문장)이 없는지.
  C. 구두점: 마침표 밀도(정상 ~1/10단어, 불량 25단어+) — 문장경계 복원 가능 여부.
  D. r2_audio 플래그: 자막이 서빙 R2 오디오로 STT 됐다는 표식.
  E. 예문 클립: vocab 의 (end-start) 가 멀티단어 예문인데 비정상적으로 짧지(잘림) 않은지.

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

    total = len(store.episodes_by_recency())
    print(f"=== 전체 스크립트 검증: done {len(done)}/{total}회차 (싱크Δ·문장분할·구두점·r2_audio·예문클립) ===")
    ok = near = bad = runon_eps = err = lowpunct = noR2 = clip_eps = 0
    for eid in done:
        try:
            t = json.load(urllib.request.urlopen(f"{st}/transcripts/{eid}.json", timeout=30))
            segs = t.get("segments") or []
            tdur = t.get("duration") or (segs[-1]["end"] if segs else 0)
            req = urllib.request.Request(f"{R2}/{eid}.mp3", method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
            clen = int(urllib.request.urlopen(req, timeout=30).headers.get("Content-Length") or 0)
            adur = mp3_duration(f"{R2}/{eid}.mp3", clen) or 0
            d = adur - tdur
            q = seg_quality(segs)
            # C. 구두점 밀도
            txt = " ".join(s.get("text", "") for s in segs)
            words = len(txt.split())
            puncts = txt.count(".") + txt.count("?") + txt.count("!")
            wpp = words / max(puncts, 1)  # words-per-period
            # D. r2_audio
            r2flag = t.get("r2_audio") is True
            # E. 예문 클립 — 멀티단어 예문인데 클립이 1.2s 미만이면 잘림 의심
            short_clips = 0
            for v in (store.vocab_for_episode(eid) or []):
                ex = (v.get("example_sentence") or "")
                s0, e0 = v.get("sentence_start_sec"), v.get("sentence_end_sec")
                if ex and len(ex.split()) >= 4 and s0 is not None and e0 is not None and (e0 - s0) < 1.2:
                    short_clips += 1
            # 집계
            if abs(d) <= 3: ok += 1
            elif abs(d) <= 15: near += 1
            else: bad += 1
            if q.get("runons"): runon_eps += 1
            if wpp > 25: lowpunct += 1
            if not r2flag: noR2 += 1
            if short_clips: clip_eps += 1
            sflag = "OK " if abs(d) <= 3 else ("~  " if abs(d) <= 15 else "BAD")
            flags = ""
            if q.get("runons"): flags += f" 런온{q['runons']}"
            if wpp > 25: flags += f" 구두점부족(1/{wpp:.0f}w)"
            if not r2flag: flags += " r2X"
            if short_clips: flags += f" 짧은클립{short_clips}"
            print(f"  [{sflag}] ep{eid}: tx{tdur:.0f}s vs audio{adur:.0f}s (Δ{d:+.1f}s) · 문장{q['n']} · 1마침표/{wpp:.0f}w{flags}")
        except Exception as ex:
            err += 1
            print(f"  [?  ] ep{eid}: {str(ex)[:60]}")
    print("\n=== 요약 ===")
    print(f"진행: done {len(done)}/{total}  (미동기화 {total - len(done)})")
    print(f"싱크: 완벽(Δ≤3s)={ok}  근사(≤15s)={near}  불량(>15s)={bad}  측정실패={err}")
    print(f"문장분할: 런온 잔존={runon_eps}   구두점부족(>25w/마침표)={lowpunct}   r2_audio 누락={noR2}   예문클립 잘림 회차={clip_eps}")
    allgood = (len(done) == total and bad == 0 and runon_eps == 0 and err == 0 and lowpunct == 0 and noR2 == 0 and clip_eps == 0)
    print("✅ 전 268회차 완벽: 싱크Δ≈0·런온0·구두점정상·r2_audio·클립정상" if allgood else "⚠ 위 플래그 확인 필요")


if __name__ == "__main__":
    main()
