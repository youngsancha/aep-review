"""문장 분절(resegment) 품질 실측 — 쇼마다 '문장이 왜 그 자리에서 끊겼는지'를 센다.

왜 필요한가: 사전번역 키(_ko.json)도, 쉐도잉 반복 단위도, 자막 하이라이트도 전부 resegment()
가 만든 '문장'을 단위로 쓴다. 그런데 그 규칙은 American English Podcast(스튜디오 녹음, Whisper
가 구두점을 잘 찍어주는 소스)를 보고 튜닝됐다. 다른 쇼 — 여러 화자가 겹치는 백악관 브리핑,
빠른 뉴스 낭독인 CNN 10, 두 진행자가 주고받는 All Ears — 에서도 같은 품질이 나오는지는
누구도 잰 적이 없다. 커버리지가 100%여도 문장이 엉뚱한 데서 끊겨 있으면 번역·쉐도잉·하이라이트가
전부 그 위에 쌓인다.

핵심 지표는 **닫힘 사유 분포**다. resegment 에는 문장을 닫는 경로가 일곱 개 있고, 그 중
  · punctuation  — 진짜 종결 구두점을 만나 닫았다(건강한 경계)
  · word-cap-14 / duration>9s — 상한에 걸려 **문장 한가운데를 잘랐다**(나쁜 경계)
  · gap-*        — 말이 쉰 자리에서 끊었다(화자가 강조로 쉬면 문장 중간이 된다)
이 셋의 비율이 그 쇼의 분절 건강도다. 상한 비율이 높다는 것은 Whisper 가 그 소스에서 구두점을
제대로 못 찍고 있다는 뜻이고, 그 회차의 문장 키는 다음 resegment 변경 때 통째로 깨지기 쉽다.

⛔ resegment 를 복사하지 않는다. 이 리포엔 이미 resegment 사본이 세 개 있고 파리티 테스트가
   그 중 둘만 고정한다. 여기서는 `sys.settrace` 로 **진짜 함수**의 실행 줄을 관찰해서, 어떤
   close() 호출이 일어났는지와 그 순간의 지역변수를 그대로 읽는다. 분기 조건을 다시 쓰지 않으므로
   규칙이 바뀌어도 이 도구는 따라간다(줄 위치도 소스 문자열로 찾는다).

    python -m scripts.audit_segmentation --newest 30
    python -m scripts.audit_segmentation --all --cache ~/tmp/tx
    python -m scripts.audit_segmentation --newest 20 --examples 6   # 나쁜 경계 실물 예시까지
"""
from __future__ import annotations

import argparse
import inspect
import json
import re
import statistics
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ingest.shows import show_slugs
from scripts import translate_transcripts as T
from scripts.audit_ko_coverage import _download, newest_ids

SHOWS = tuple(show_slugs())

# ── resegment 안에서 close() 가 불리는 네 자리를 소스 문자열로 찾는다(줄번호 하드코딩 금지) ──
_SRC_LINES, _SRC_START = inspect.getsourcelines(T.resegment)
_SRC_FILE = inspect.getsourcefile(T.resegment)


def _find_line(needle: str) -> int:
    hits = [i for i, line in enumerate(_SRC_LINES) if needle in line]
    if len(hits) != 1:
        raise SystemExit(
            f"audit_segmentation: resegment() 안에서 {needle!r} 를 {len(hits)}번 찾았다(1이어야 함). "
            "resegment 가 바뀌었다면 이 도구의 앵커 문자열을 같이 고쳐라."
        )
    return _SRC_START + hits[0]


LINE_GAP = _find_line("if cur and (gap > 1.5 or") + 1        # 그 다음 줄이 close()
LINE_CONJ = _find_line("if _CONJ.match(lead):") + 1
LINE_STARTER = _find_line("close(force_period=True)")
LINE_FINAL = _find_line("if (_ends_sent(txt) and n >= 2)") + 1


class _Trace:
    """close() 호출 시점의 사유를 순서대로 모은다."""

    def __init__(self) -> None:
        self.reasons: list[str] = []
        self.durs: list[float] = []

    def _dur(self, L) -> float:
        cur = L.get("cur") or {}
        a, b = cur.get("start"), cur.get("end")
        try:
            return round(float(b) - float(a), 2)
        except (TypeError, ValueError):
            return -1.0

    def __call__(self, frame, event, arg):
        if event != "line" or frame.f_code.co_filename != _SRC_FILE:
            return self
        ln, L = frame.f_lineno, frame.f_locals
        if ln == LINE_GAP:
            gap, cur = L.get("gap") or 0, L.get("cur") or {}
            nw = len(cur.get("words") or ())
            # 세 문턱 중 실제로 걸린 것 (조건식과 같은 순서로 판정)
            if gap > 1.5:
                self.reasons.append("gap>1.5s")
                self.durs.append(self._dur(L))
            elif nw >= 3 and gap > 0.8:
                self.reasons.append("gap>0.8s")
                self.durs.append(self._dur(L))
            else:
                self.reasons.append("gap>0.45s")
                self.durs.append(self._dur(L))
        elif ln == LINE_CONJ:
            self.reasons.append("conjunction")
            self.durs.append(self._dur(L))
        elif ln == LINE_STARTER:
            self.reasons.append("capital-starter")
            self.durs.append(self._dur(L))
        elif ln == LINE_FINAL:
            txt, n, dur = L.get("txt") or "", L.get("n") or 0, L.get("dur") or 0
            # ⚠ 조건식과 동일한 우선순위로 분류한다(먼저 참인 것이 실제 사유).
            if T._ends_sent(txt) and n >= 2:
                self.reasons.append("punctuation")
            elif T._COMMA.search(txt) and n >= 7:
                self.reasons.append("comma")
            elif dur > 9:
                self.reasons.append("duration>9s")
            elif n >= 14:
                self.reasons.append("word-cap-14")
            else:                                  # 도달 불가 — 조건이 바뀌었다는 신호
                self.reasons.append("UNCLASSIFIED")
            self.durs.append(round(float(dur), 2))
        return self


def segment_with_reasons(segments) -> tuple[list[str], list[str], list[float]]:
    """(문장들, 문장별 닫힘 사유). 마지막 문장은 close() 없이 끝날 수 있어 'end-of-audio'."""
    tr = _Trace()
    sys.settrace(tr)
    try:
        sents = T.resegment(segments)
    finally:
        sys.settrace(None)
    reasons, durs = list(tr.reasons), list(tr.durs)
    if len(reasons) == len(sents) - 1:
        reasons.append("end-of-audio")
        durs.append(-1.0)
    elif len(reasons) != len(sents):
        # 정렬이 깨졌다 = 트레이서가 규칙 변경을 놓쳤다. 조용히 틀린 통계를 내느니 티를 낸다.
        reasons = (reasons + ["MISALIGNED"] * len(sents))[: len(sents)]
        durs = (durs + [-1.0] * len(sents))[: len(sents)]
    return sents, reasons, durs


# ── 문장 자체의 품질 신호 ────────────────────────────────────────────────────
_TERMINAL = re.compile(r"[.!?…][\"')\]]?$")
# 이런 단어로 문장이 끝나면 절 한가운데를 자른 것이다(기능어는 뒤에 무언가가 반드시 온다).
_DANGLING = frozenset("""
a an the and but or so nor for yet because if when while since although though unless
of to in on at by with from into onto over under about as that which who whom whose
is are was were be been being am do does did have has had will would can could shall
should may might must not very more most much many some any this these those my your
his her its our their i he she it we they you there here
""".split())
_ABBR_TAIL = re.compile(r"\b(?:[A-Z]\.){1,}$|\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Sen|Rep|Gov|Gen|Lt|Col|vs|etc|Inc|Corp|approx|Ave|Blvd)\.$")


def sentence_stats(sent: str) -> dict:
    words = sent.split()
    last = words[-1].strip("\"')]").lower().rstrip(".,;:!?") if words else ""
    first_caps_starter = 0
    for w in words[1:]:
        raw = T._LEAD_STRIP.sub("", w.strip())
        if raw[:1].isupper() and T._STARTER.match(raw.split("'")[0].rstrip(".,;:!?")):
            first_caps_starter += 1
    return {
        "n_words": len(words),
        "terminal": bool(_TERMINAL.search(sent.strip())),
        "dangling": bool(words) and last in _DANGLING and not _TERMINAL.search(sent.strip()),
        "abbr_tail": bool(_ABBR_TAIL.search(sent.strip())),
        "mid_starter": first_caps_starter,
        "fragment": len(words) <= 2,
    }


# ── 회차 1편 분석 ────────────────────────────────────────────────────────────
GOOD = ("punctuation",)                       # 진짜 문장 경계
HARD = ("word-cap-14", "duration>9s")         # 상한에 걸려 문장 한가운데를 잘랐다
SOFT = ("gap>1.5s", "gap>0.8s", "gap>0.45s", "comma", "conjunction", "capital-starter")


def analyse_episode(ep_id: int, cache: Path | None = None) -> dict | None:
    tx = None
    cached = (cache / f"{ep_id}.json") if cache else None
    if cached and cached.exists():
        try:
            tx = json.loads(cached.read_text(encoding="utf-8"))
        except Exception:
            tx = None
    if tx is None:
        tx, state = _download(f"{ep_id}.json")
        if state == "error":
            return {"id": ep_id, "note": "다운로드 실패"}
        if not tx:
            return {"id": ep_id, "note": "자막 없음"}
        if cached:
            cached.write_text(json.dumps(tx, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    sents, reasons, durs = segment_with_reasons(tx.get("segments") or [])
    sents = [s for s in sents]
    if not sents:
        return {"id": ep_id, "note": "문장 없음"}

    per = [sentence_stats(s) for s in sents]
    n = len(sents)
    rc = Counter(reasons)
    words = [p["n_words"] for p in per]
    real_durs = [d for d in durs if d >= 0]
    return {
        "id": ep_id,
        "sents": n,
        "reasons": dict(rc),
        "hard_cut": sum(rc[r] for r in HARD),
        "good_cut": sum(rc[r] for r in GOOD),
        # ⛔ The close reason alone OVERSTATES badness. resegment's step ⑤ (tail rollback) can move
        # the next sentence's first word back into this one AFTER it closed, and that word may carry
        # the terminal period — so a sentence that closed on the word cap can still end up
        # well-formed. The honest count of a mid-sentence cut is "hit a hard cap AND still has no
        # terminal punctuation".
        "hard_open": sum(1 for r_, p_ in zip(reasons, per) if r_ in HARD and not p_["terminal"]),
        "hard_repaired": sum(1 for r_, p_ in zip(reasons, per) if r_ in HARD and p_["terminal"]),
        "terminal": sum(p["terminal"] for p in per),
        "dangling": sum(p["dangling"] for p in per),
        "abbr_tail": sum(p["abbr_tail"] for p in per),
        "mid_starter": sum(p["mid_starter"] for p in per),
        "fragment": sum(p["fragment"] for p in per),
        "words_mean": round(statistics.mean(words), 2),
        "words_med": statistics.median(words),
        "words_p95": sorted(words)[int(0.95 * (n - 1))],
        "dur_med": round(statistics.median(real_durs), 2) if real_durs else None,
        "duration": tx.get("duration"),
        "note": "",
    }


def _pct(a: int, b: int) -> float:
    return round(100 * a / b, 1) if b else 0.0


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--newest", type=int, default=25, help="쇼별 최근 N편 (기본 25)")
    ap.add_argument("--all", action="store_true", help="전 회차 (--newest 무시)")
    ap.add_argument("--shows", default=",".join(SHOWS))
    ap.add_argument("-w", "--workers", type=int, default=8, help="동시 다운로드 수")
    ap.add_argument("--cache", default=None, help="트랜스크립트 로컬 캐시 디렉터리(재실행이 싸진다)")
    ap.add_argument("--examples", type=int, default=0, help="쇼마다 '나쁜 경계' 실물 예시 N개")
    ap.add_argument("--json", dest="json_out", default=None)
    args = ap.parse_args()

    cache = Path(args.cache).expanduser() if args.cache else None
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
    shows = [s.strip() for s in args.shows.split(",") if s.strip()]
    want = None if args.all else args.newest

    all_rows, summary = [], {}
    for show in shows:
        ids = newest_ids(show, want)
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
            rows = [r for r in ex.map(lambda i: analyse_episode(i, cache), ids) if r]
        for r in rows:
            r["show"] = show
        all_rows.extend(rows)
        ok = [r for r in rows if not r["note"]]
        if not ok:
            summary[show] = None
            continue
        tot = sum(r["sents"] for r in ok)
        agg = Counter()
        for r in ok:
            agg.update(r["reasons"])
        summary[show] = {
            "eps": len(ok), "failed": sum(1 for r in rows if r["note"] == "다운로드 실패"),
            "skipped": sum(1 for r in rows if r["note"] and r["note"] != "다운로드 실패"),
            "sents": tot, "reasons": agg,
            "hard": sum(r["hard_cut"] for r in ok), "good": sum(r["good_cut"] for r in ok),
            "hard_open": sum(r["hard_open"] for r in ok),
            "hard_repaired": sum(r["hard_repaired"] for r in ok),
            "terminal": sum(r["terminal"] for r in ok),
            "dangling": sum(r["dangling"] for r in ok),
            "abbr_tail": sum(r["abbr_tail"] for r in ok),
            "mid_starter": sum(r["mid_starter"] for r in ok),
            "fragment": sum(r["fragment"] for r in ok),
            "words_mean": round(statistics.mean([r["words_mean"] for r in ok]), 2),
            "words_p95": round(statistics.mean([r["words_p95"] for r in ok]), 1),
            "dur_med": round(statistics.mean([r["dur_med"] for r in ok if r["dur_med"] is not None]), 2),
        }

    scope = "전 회차" if args.all else f"쇼별 최근 {args.newest}편"
    print(f"=== 문장 분절 품질 ({scope}) ===\n")
    hdr = (f"{'show':<9}{'회차':>5}{'문장':>8}{'구두점으로':>11}{'상한에 걸려':>12}"
           f"{'쉼/쉼표로':>11}{'종결부호':>10}{'꼬리 기능어':>12}{'단어/문장':>10}")
    print(hdr)
    print("-" * 92)
    for show in shows:
        v = summary.get(show)
        if not v:
            print(f"{show:<9} (측정 불가)")
            continue
        soft = sum(v["reasons"][r] for r in SOFT)
        print(f"{show:<9}{v['eps']:>5}{v['sents']:>8}"
              f"{_pct(v['good'], v['sents']):>10.1f}%{_pct(v['hard'], v['sents']):>11.1f}%"
              f"{_pct(soft, v['sents']):>10.1f}%{_pct(v['terminal'], v['sents']):>9.1f}%"
              f"{_pct(v['dangling'], v['sents']):>11.1f}%{v['words_mean']:>10.1f}")
    print("\n  구두점으로 = 진짜 종결부호를 만나 닫힘(건강). 상한에 걸려 = n>=14 / dur>9s 로 "
          "문장 한가운데를 자름.\n  꼬리 기능어 = 관사·전치사·접속사로 끝남(절 중간을 자른 확실한 신호).")

    print("\n=== 상한 절단의 실제 피해 (⑤ 꼬리 되돌리기가 복구한 것을 뺀 값) ===")
    print(f"{'show':<9}{'상한 절단':>10}{'⑤가 복구':>11}{'끝내 열린 채':>14}{'= 전체 문장의':>14}")
    for show in shows:
        v = summary.get(show)
        if not v:
            continue
        print(f"{show:<9}{v['hard']:>10}{v['hard_repaired']:>11}{v['hard_open']:>14}"
              f"{_pct(v['hard_open'], v['sents']):>13.1f}%")
    print("  '끝내 열린 채' = 상한에 걸려 닫혔고 ⑤ 후처리로도 종결부호를 못 얻은 문장 "
          "= 확실한 문장 중간 절단.")

    print("\n=== 닫힘 사유 상세 (%) ===")
    keys = ["punctuation", "comma", "gap>1.5s", "gap>0.8s", "gap>0.45s",
            "capital-starter", "conjunction", "word-cap-14", "duration>9s", "end-of-audio"]
    print(f"{'show':<9}" + "".join(f"{k.replace('duration','dur'):>16}" for k in keys))
    for show in shows:
        v = summary.get(show)
        if not v:
            continue
        print(f"{show:<9}" + "".join(f"{_pct(v['reasons'][k], v['sents']):>15.1f}%" for k in keys))

    print("\n=== 기타 신호 (문장 1000개당) ===")
    print(f"{'show':<9}{'파편(<=2단어)':>15}{'약어로 끝남':>14}{'문장중간 대문자':>16}{'p95 단어':>10}{'중간값 초':>10}")
    for show in shows:
        v = summary.get(show)
        if not v:
            continue
        k = 1000 / v["sents"]
        print(f"{show:<9}{v['fragment'] * k:>14.1f}{v['abbr_tail'] * k:>14.1f}"
              f"{v['mid_starter'] * k:>16.1f}{v['words_p95']:>10.1f}{v['dur_med']:>10.2f}")

    # ⛔ The detail table above prints only the reason keys it knows about. If the tracer ever fails
    # to classify a close (rules changed) or loses alignment (threading, a new close site), those
    # rows would vanish from the table and the percentages would still add up to something
    # plausible. Report any unknown key loudly instead of letting it disappear.
    known = set(keys)
    strays = Counter()
    for show in shows:
        v = summary.get(show)
        if v:
            for k, c in v["reasons"].items():
                if k not in known:
                    strays[f"{show}/{k}"] += c
    if strays:
        print("\n⛔ 분류되지 않은 닫힘 사유가 있다 — 위 표는 그만큼 덜 세고 있다:")
        for k, c in strays.most_common():
            print(f"     {k}: {c}")
    else:
        print("\n분류 실패 0건 — 모든 닫힘이 알려진 사유 10종 중 하나로 설명됨.")

    failed = sum((summary[s] or {}).get("failed", 0) for s in shows if summary.get(s))
    if failed:
        print(f"\n⛔ 다운로드 실패 {failed}편 — 위 수치는 그만큼 덜 잰 것이다.")
    else:
        print(f"\n다운로드 실패 0편 — {sum((summary[s] or {}).get('eps', 0) for s in shows)}편 전부 실측됨.")

    if args.examples:
        print("\n=== 나쁜 경계 실물 예시 (상한에 걸려 잘린 문장 → 그 다음 문장) ===")
        for show in shows:
            rows = [r for r in all_rows if r["show"] == show and not r["note"]]
            if not rows:
                continue
            print(f"\n[{show}]")
            shown = 0
            for r in rows:
                if shown >= args.examples:
                    break
                tx = None
                cached = (cache / f"{r['id']}.json") if cache else None
                if cached and cached.exists():
                    tx = json.loads(cached.read_text(encoding="utf-8"))
                if tx is None:
                    tx, _ = _download(f"{r['id']}.json")
                if not tx:
                    continue
                sents, reasons, _d = segment_with_reasons(tx.get("segments") or [])
                for i, (s_, rn) in enumerate(zip(sents, reasons)):
                    if rn in HARD and shown < args.examples:
                        nxt = sents[i + 1] if i + 1 < len(sents) else "<끝>"
                        print(f"  ep{r['id']} [{rn}]")
                        print(f"     …{s_[-72:]!r}")
                        print(f"     → {nxt[:72]!r}")
                        shown += 1
    if args.json_out:
        Path(args.json_out).write_text(
            json.dumps({"summary": {k: (dict(v, reasons=dict(v["reasons"])) if v else None)
                                    for k, v in summary.items()}, "episodes": all_rows},
                       ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n상세 → {args.json_out}")


if __name__ == "__main__":
    main()
