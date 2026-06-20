"""호스팅·싱크·문장분할 전수 검증 (아침 보고용).

A. 호스팅 완료: 자막 있는 전 회차가 매니페스트(audio_hosted.json)에 있는가.
B. 싱크 정합(회차별): R2 오디오 길이 == transcript 길이 인가.
   megaphone mp3 가 일정 비트레이트라면 (Content-Length / transcript.duration) 비율이 회차마다
   같아야 한다(= R2 오디오 길이 == 자막 길이). 비율이 튀는 회차 = 오디오≠자막(싱크 불량) 후보.
C. 문장분할(회차별): 앱의 resegment 를 그대로 포팅해 각 회차 자막을 문장으로 나눈 뒤,
   과도하게 긴 문장(런온)이 남아있지 않은지 검사.

    python -m scripts.verify_hosting            # 전수 검증 + 요약
    python -m scripts.verify_hosting --bad      # 문제 회차만 출력
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import urllib.request

from ingest import store

SUPA = None
STORAGE = None


def _env():
    global SUPA, STORAGE
    import os
    from dotenv import load_dotenv
    load_dotenv(store.PROJECT_ROOT / ".env")
    SUPA = os.environ["SUPABASE_URL"].rstrip("/")
    STORAGE = f"{SUPA}/storage/v1/object/public"


def _get_json(url):
    return json.load(urllib.request.urlopen(url, timeout=30))


def _head_len(url):
    # Cloudflare(r2.dev)는 기본 Python UA 를 403 처리 → 브라우저 UA 필요.
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return int(r.headers.get("Content-Length") or 0)


# ───────────────── resegment 포팅 (ui/views/episode.js 와 동일 기준) ─────────────────
ENDS = re.compile(r'[.!?…]["\')\]]?$')
COMMA = re.compile(r'[,;:]["\')\]]?$')


def resegment(segments):
    words = []
    for seg in segments or []:
        ws = seg.get("words") or []
        if ws:
            for w in ws:
                if w.get("word") is None:
                    continue
                words.append({"word": w["word"], "start": w.get("start", seg.get("start")), "end": w.get("end", seg.get("end"))})
        elif seg.get("text"):
            words.append({"word": seg["text"], "start": seg.get("start"), "end": seg.get("end")})
    out = []
    cur = None
    prev_end = None
    for w in words:
        gap = (w["start"] - prev_end) if (prev_end is not None and isinstance(w["start"], (int, float))) else 0
        if cur and (gap > 1.5 or (len(cur["words"]) >= 3 and gap > 0.8) or (len(cur["words"]) >= 7 and gap > 0.45)):
            out.append(cur); cur = None
        if not cur:
            cur = {"start": w["start"], "end": w["end"], "words": []}
        cur["words"].append(w)
        if isinstance(w["end"], (int, float)):
            cur["end"] = w["end"]; prev_end = w["end"]
        txt = (w["word"] or "").strip()
        n = len(cur["words"])
        dur = (cur["end"] or 0) - (cur["start"] or 0)
        if (ENDS.search(txt) and n >= 2) or (COMMA.search(txt) and n >= 9) or dur > 10 or n >= 16:
            out.append(cur); cur = None
    if cur:
        out.append(cur)
    return out


def seg_quality(segments):
    sents = resegment(segments)
    if not sents:
        return {"n": 0, "max_w": 0, "max_dur": 0, "runons": 0}
    maxw = maxd = 0
    runons = 0
    for s in sents:
        w = len(s["words"]); d = (s["end"] or 0) - (s["start"] or 0)
        maxw = max(maxw, w); maxd = max(maxd, d)
        if w > 22 or d > 14:  # resegment 하드캡(16w/10s) 한참 초과 = 분할 실패(런온)
            runons += 1
    return {"n": len(sents), "max_w": maxw, "max_dur": round(maxd, 1), "runons": runons}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--bad", action="store_true", help="문제 회차만")
    p.add_argument("--limit", type=int, default=10000)
    args = p.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    _env()

    eps = store.episodes_by_recency()
    manifest = set(_get_json(f"{STORAGE}/transcripts/audio_hosted.json"))
    transcribed = [e for e in eps if e.get("transcribed_at")]

    # A. 호스팅 완료
    not_hosted = [e["id"] for e in transcribed if e["id"] not in manifest]
    print(f"=== A. 호스팅 ===")
    print(f"전체 {len(eps)} · 자막보유 {len(transcribed)} · 호스팅 {len(manifest)} · 미호스팅(자막有) {len(not_hosted)}")
    if not_hosted:
        print(f"  미호스팅: {sorted(not_hosted)[:40]}")

    # B,C 회차별
    ratios = []
    rows = []
    for e in transcribed:
        eid = e["id"]
        if eid not in manifest:
            continue
        if len(rows) >= args.limit:
            break
        try:
            t = _get_json(f"{STORAGE}/transcripts/{eid}.json")
            tdur = t.get("duration") or (t["segments"][-1]["end"] if t.get("segments") else 0)
            clen = _head_len(f"https://pub-6226ae33abbc474dbea6ae140582eb8d.r2.dev/{eid}.mp3")
            ratio = (clen / tdur) if tdur else 0
            q = seg_quality(t.get("segments"))
            ratios.append(ratio)
            rows.append((eid, tdur, clen, ratio, q))
        except Exception as ex:
            rows.append((eid, None, None, None, {"err": str(ex)[:60]}))

    med = statistics.median(ratios) if ratios else 0
    print(f"\n=== B. 싱크(오디오길이==자막길이) — 기준 비율(median) {med:.1f} B/s ===")
    sync_bad = []
    for (eid, tdur, clen, ratio, q) in rows:
        if ratio is None:
            sync_bad.append((eid, "fetch-err")); continue
        dev = abs(ratio - med) / med if med else 1
        # 비율 4% 이상 벗어나면 오디오 길이 != 자막 길이 → 싱크 불량 후보
        if dev > 0.04:
            est_audio = clen / med
            sync_bad.append((eid, f"자막{tdur:.0f}s vs 오디오추정{est_audio:.0f}s (Δ{est_audio-tdur:+.0f}s)"))
    print(f"싱크 의심 회차: {len(sync_bad)} / {len(rows)}")
    for eid, why in sync_bad[:40]:
        print(f"  ep{eid}: {why}")

    print(f"\n=== C. 문장분할(런온 잔존) ===")
    seg_bad = [(eid, q) for (eid, _, _, _, q) in rows if q.get("runons")]
    print(f"런온 잔존 회차: {len(seg_bad)} / {len(rows)}")
    for eid, q in seg_bad[:40]:
        print(f"  ep{eid}: 문장{q['n']} 최대{q['max_w']}단어/{q['max_dur']}s 런온{q['runons']}")

    print(f"\n=== 종합 ===")
    ok = (not not_hosted) and (not sync_bad) and (not seg_bad)
    print("✅ 전수 통과" if ok else f"⚠ 미호스팅{len(not_hosted)} 싱크의심{len(sync_bad)} 런온{len(seg_bad)}")


if __name__ == "__main__":
    main()
