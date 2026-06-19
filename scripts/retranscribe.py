"""광고-무관 싱크 재정렬 (#2 싱크 완전 해결).

문제: 기존 transcript 는 RSS 광고 추적 래퍼(podtrac…)로 받은 mp3 로 STT 했는데,
앱은 traffic.megaphone.fm/<id>.mp3(clean) 를 스트리밍한다. megaphone 동적 광고(DAI)는
래퍼 경로와 clean 경로에 서로 다른 광고를 끼워, 같은 에피소드라도 두 파일의 광고 적재량이
달라진다 → 단일 offset 으로는 못 맞추고(특히 mid-roll), 중간부터 싱크가 깨진다.

해결: 앱과 "똑같은" clean URL 로 STT 를 다시 떠서 transcript ≡ stream(광고 포함 동일)으로
만든다 → 클라이언트는 offset 0 으로 완벽 싱크. vocab 타임스탬프는 새 transcript 의
단어스트림에서 example_sentence 를 텍스트 매칭해 재계산(결정적, claude 불필요).

배치 실행(루프/야간):
    python -m scripts.retranscribe --recent 20 --limit 20   # 최신 20개
    python -m scripts.retranscribe --all --limit 30         # 진행파일 이어서 30개
    python -m scripts.retranscribe --ids 1,6,3
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import tempfile
from pathlib import Path
from typing import Any

from ingest import store
from ingest.audio_download import clean_audio_url, download_to
from ingest.transcribe import transcribe_one

log = logging.getLogger(__name__)

PROGRESS = store.PROJECT_ROOT / "data" / "retranscribe_done.json"


# ─────────────────────── 진행 상태 (로컬) ───────────────────────
def load_done() -> set[int]:
    try:
        return set(json.loads(PROGRESS.read_text(encoding="utf-8")))
    except Exception:
        return set()


def save_done(done: set[int]) -> None:
    PROGRESS.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS.write_text(json.dumps(sorted(done)), encoding="utf-8")


# ─────────────────────── vocab 타임스탬프 재매핑 ───────────────────────
_WORD = re.compile(r"[a-z0-9']+")


def _norm_tokens(text: str) -> list[str]:
    return _WORD.findall((text or "").lower())


def _build_word_index(transcript: dict[str, Any]):
    """transcript → (정규화 단어 리스트, 각 단어의 start/end). 매칭용."""
    words: list[str] = []
    spans: list[tuple[float, float]] = []
    for seg in transcript.get("segments", []):
        ws = seg.get("words") or []
        if ws:
            for w in ws:
                for tok in _norm_tokens(w.get("word", "")):
                    words.append(tok)
                    spans.append((w.get("start", seg["start"]), w.get("end", seg["end"])))
        else:
            for tok in _norm_tokens(seg.get("text", "")):
                words.append(tok)
                spans.append((seg["start"], seg["end"]))
    return words, spans


def _find_span(ex_tokens: list[str], words: list[str], spans):
    """example 토큰열을 단어스트림에서 찾아 (start, end). 전체→prefix 순으로 점점 짧게 시도."""
    if not ex_tokens or not words:
        return None
    n = len(words)
    for take in (len(ex_tokens), 8, 6, 4, 3):
        probe = ex_tokens[:take]
        if len(probe) < 3 and len(ex_tokens) >= 3:
            continue
        L = len(probe)
        if L == 0 or L > n:
            continue
        first = probe[0]
        for i in range(n - L + 1):
            if words[i] != first:
                continue
            # 일치 비율(작은 STT 차이 허용): 70% 이상이면 채택
            hit = sum(1 for k in range(L) if words[i + k] == probe[k])
            if hit >= max(2, int(L * 0.7)):
                return spans[i][0], spans[i + L - 1][1]
    return None


def remap_vocab(ep_id: int, transcript: dict[str, Any]) -> int:
    """새 transcript 기준으로 vocab.sentence_start/end_sec 재계산. 반환: 갱신 건수."""
    vocab = store.vocab_for_episode(ep_id)
    if not vocab:
        return 0
    words, spans = _build_word_index(transcript)
    updated = 0
    for v in vocab:
        ex = v.get("example_sentence")
        if not ex:
            continue
        span = _find_span(_norm_tokens(ex), words, spans)
        if not span:
            continue
        ns, ne = round(span[0], 3), round(span[1], 3)
        if ns != v.get("sentence_start_sec") or ne != v.get("sentence_end_sec"):
            store.update_vocab_times(v["id"], ns, ne)
            updated += 1
    return updated


# ─────────────────────── 재정렬 한 건 ───────────────────────
def retranscribe_one(row: dict[str, Any], remap: bool = True) -> dict[str, Any]:
    ep_id = row["id"]
    url = clean_audio_url(row["audio_url"])
    with tempfile.TemporaryDirectory(prefix="aep_re_") as tmpdir:
        apath = Path(tmpdir) / f"{ep_id}.mp3"
        nbytes = download_to(url, apath)
        data = transcribe_one(apath)
    data["aligned"] = True  # clean URL 정렬 → 클라이언트 offset 0
    store.upload_transcript(ep_id, data)
    store.mark_transcribed(ep_id, data.get("duration"))
    n_remap = remap_vocab(ep_id, data) if remap else 0
    return {
        "ep": ep_id, "bytes": nbytes, "dur": data.get("duration"),
        "segments": len(data.get("segments", [])), "remap": n_remap,
    }


# ─────────────────────── 선택 + 실행 ───────────────────────
def select_ids(args) -> list[int]:
    if args.ids:
        return [int(x) for x in args.ids.split(",") if x.strip()]
    rows = store.episodes_by_recency(limit=args.recent if args.recent else None)
    return [r["id"] for r in rows]


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser()
    p.add_argument("--ids", help="쉼표구분 episode id (명시 시 우선)")
    p.add_argument("--recent", type=int, help="pub_date 최신 N개 대상")
    p.add_argument("--all", action="store_true", help="전 에피소드 대상(진행파일로 이어감)")
    p.add_argument("--limit", type=int, default=20, help="이번 실행 처리 상한")
    p.add_argument("--redo", action="store_true", help="이미 done 인 것도 다시")
    p.add_argument("--no-remap", action="store_true", help="vocab 타임스탬프 재매핑 생략")
    args = p.parse_args()

    if not (args.ids or args.recent or args.all):
        p.error("--ids / --recent N / --all 중 하나 필요")

    done = set() if args.redo else load_done()
    ids = [i for i in select_ids(args) if args.ids or i not in done]
    ids = ids[: args.limit]
    if not ids:
        log.info("처리할 episode 없음 (모두 done?). 총 done=%d", len(done))
        return

    log.info("재정렬 시작: %d개 (done 누적 %d)", len(ids), len(done))
    rows = {r["id"]: r for r in store.episodes_by_recency()}
    ok = 0
    for ep_id in ids:
        row = rows.get(ep_id)
        if not row or not row.get("audio_url"):
            log.warning("skip ep=%s (no audio_url)", ep_id)
            continue
        try:
            res = retranscribe_one(row, remap=not args.no_remap)
        except Exception:
            log.exception("retranscribe 실패 ep=%s", ep_id)
            continue
        done.add(ep_id)
        save_done(done)
        ok += 1
        log.info("✓ ep=%(ep)s dur=%(dur)ss seg=%(segments)d vocab재매핑=%(remap)d bytes=%(bytes)d", res)
    log.info("완료: %d/%d 성공, done 누적=%d", ok, len(ids), len(done))


if __name__ == "__main__":
    main()
