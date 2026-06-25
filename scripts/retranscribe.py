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
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from ingest import store
from ingest.audio_download import clean_audio_url, download_to
from ingest.transcribe import transcribe_one

log = logging.getLogger(__name__)

PROGRESS = store.PROJECT_ROOT / "data" / "retranscribe_done.json"
# 하드 크래시(예: CUDA 드라이버 폴트)로 프로세스가 통째로 죽는 '독성' 회차를 격리.
# done 과 달리 '완벽싱크됨'이 아니라 '건너뜀(미완료)' 의미 → 절대 done 에 섞지 않는다.
SKIP = store.PROJECT_ROOT / "data" / "retranscribe_skip.json"


# ─────────────────────── 진행 상태 (로컬) ───────────────────────
def load_done() -> set[int]:
    try:
        return set(json.loads(PROGRESS.read_text(encoding="utf-8")))
    except Exception:
        return set()


def load_skip() -> set[int]:
    try:
        return set(json.loads(SKIP.read_text(encoding="utf-8")))
    except Exception:
        return set()


def save_done(done: set[int]) -> None:
    PROGRESS.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS.write_text(json.dumps(sorted(done)), encoding="utf-8")


# ─────────────────────── vocab 타임스탬프 재매핑 ───────────────────────
_WORD = re.compile(r"[a-z0-9']+")

# 구어 축약(native reductions) 정규화 — 예문(claude 정제)과 ASR transcript 가 서로 다른 형태를 써도
# ('going to' vs 'gonna') 같은 위치로 정렬되게 양쪽 모두 펼친 표준형으로. 대칭 적용이라 기존 정상매칭은
# 불변(축약이 없으면 그대로) → 매칭 견고성만 +. 'cause' 등 다의어는 위험해 제외(고빈도 안전형만).
_EXPAND = {
    "gonna": ("going", "to"), "wanna": ("want", "to"), "gotta": ("got", "to"),
    "gimme": ("give", "me"), "lemme": ("let", "me"), "kinda": ("kind", "of"),
    "sorta": ("sort", "of"), "outta": ("out", "of"), "tryna": ("trying", "to"),
}


def _norm_tokens(text: str) -> list[str]:
    out: list[str] = []
    for t in _WORD.findall((text or "").lower()):
        out.extend(_EXPAND.get(t, (t,)))
    return out


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


def _anchor(probe: list[str], words: list[str], lo: int, hi: int) -> int | None:
    """probe 토큰열이 words[lo:hi] 에서 '가장 잘' 맞는 시작 인덱스. 끝(tail) 경계용이라 단순 첫매칭이
    아니라 (1) 일치수 최대, (2) 마지막 토큰 일치를 강하게 가산 — 동일단어가 반복되는 예문
    ('…want to get fit. They want to get in shape')에서 앞쪽 'want' 에 오매칭해 클립이 일찍
    잘리던 버그 방지, (3) 동점이면 더 뒤(예문 끝에 가까운) 위치 채택. 임계 미만이면 None."""
    L = len(probe)
    if L == 0:
        return None
    first, last = probe[0], probe[-1]
    hi = min(hi, len(words))
    best_i, best_score = None, 0
    for i in range(lo, hi - L + 1):
        if words[i] != first:
            continue
        hit = sum(1 for k in range(L) if words[i + k] == probe[k])
        score = hit + (2 if words[i + L - 1] == last else 0)  # 끝 토큰 일치 가산(경계 정확도)
        if score >= best_score:   # '>=' → 동점이면 더 뒤(꼬리에 가까운) 위치
            best_score, best_i = score, i
    return best_i if best_score >= max(2, int(L * 0.7)) else None


def _find_span(ex_tokens: list[str], words: list[str], spans):
    """example 의 (start, end). 앞 단어로 시작을, 뒤 단어로 끝을 따로 앵커해 예문 '전체'를 커버한다.
    (예전엔 prefix 만 매칭해 멀티문장 예문의 끝이 일찍 잘렸다 — 'ball of energy' 클립 2.7s 버그)."""
    if not ex_tokens or not words:
        return None
    n = len(words)
    # 시작: 긴 prefix 부터 시도(가장 구체적 → 정확한 위치). 짧은 앵커만 쓰면 흔한 'that's a…' 에
    # 오매칭한다 → 반드시 긴 prefix 우선. 또한 '첫 70% 매칭'이 아니라 '그 길이에서 최고 점수' 위치를
    # 골라야 한다 — 흔한 단어가 반복되는 예문("i'm going to…")에서 앞쪽 코인시던스 위치에 붙어
    # 시작이 어긋나고 결국 클립이 짧게 잡히던 버그 방지(완전일치 발견 즉시 확정).
    si = None
    for take in (len(ex_tokens), 8, 6, 4, 3):
        L = min(take, len(ex_tokens))
        if (L < 3 and len(ex_tokens) >= 3) or L == 0 or L > n:
            continue
        probe = ex_tokens[:L]
        thr = max(2, int(L * 0.7))
        best_i, best_sc = None, 0
        for i in range(n - L + 1):
            if words[i] != probe[0]:
                continue
            sc = sum(1 for k in range(L) if words[i + k] == probe[k])
            if sc > best_sc:          # 최고 점수(동점이면 더 이른 위치 유지)
                best_sc, best_i = sc, i
                if sc == L:           # 완전일치면 더 볼 것 없음
                    break
        if best_i is not None and best_sc >= thr:
            si = best_i
            break
    if si is None:
        return None
    # 끝: 예문 꼬리 단어들을 si 이후에서 앵커 → 예문 '전체'를 커버. 못 찾으면 예문 단어수만큼.
    if len(ex_tokens) <= 5:
        ei = min(si + len(ex_tokens) - 1, n - 1)
    else:
        tail = ex_tokens[-5:]
        ti = _anchor(tail, words, si, min(n, si + len(ex_tokens) + 12))
        ei = (ti + len(tail) - 1) if ti is not None else (si + len(ex_tokens) - 1)
        ei = min(ei, n - 1)
    if ei < si:
        ei = min(si + len(ex_tokens) - 1, n - 1)
    return spans[si][0], spans[ei][1]


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
def retranscribe_one(row: dict[str, Any], remap: bool = True, host_r2: bool = True,
                     from_r2: bool = False) -> dict[str, Any]:
    ep_id = row["id"]
    if from_r2:
        # 앱이 '실제로 트는' R2 오디오를 받아 그걸 STT → 자막 = 서빙 오디오 (완벽 일치).
        # host_audio 의 별도 다운로드(광고 적재 다름)로 생긴 불일치를 근본 해결. 재업로드 불필요.
        base = (os.environ.get("R2_PUBLIC_BASE") or "").rstrip("/")
        url = f"{base}/{ep_id}.mp3"
    else:
        url = clean_audio_url(row["audio_url"])
    hosted = False
    with tempfile.TemporaryDirectory(prefix="aep_re_") as tmpdir:
        apath = Path(tmpdir) / f"{ep_id}.mp3"
        nbytes = download_to(url, apath)
        data = transcribe_one(apath)   # 구두점 품질 게이트는 transcribe_one 내부에 있어 자동 자가복구
        if host_r2 and not from_r2:  # 자막과 '같은 바이트'를 R2 에 올림(신규 호스팅용). from_r2 면 이미 R2 에 있음
            # R2 업로드 실패를 삼키지 않는다 — 삼키면 transcript 는 저장되는데 R2 엔 없어 앱이
            # megaphone(DAI)로 폴백→영구 desync('transcribed-but-not-hosted', 예: ep312). 실패 시 raise →
            # 호출부가 done 마킹 안 함 → 다음 실행에 통째로 재시도(transcript≡R2 보장 회복).
            store.upload_audio_r2(ep_id, apath)
            hosted = True
    data["aligned"] = True  # clean URL 정렬 → 클라이언트 offset 0
    if host_r2 or from_r2:
        data["r2_audio"] = True
    store.upload_transcript(ep_id, data)
    store.mark_transcribed(ep_id, data.get("duration"))
    n_remap = remap_vocab(ep_id, data) if remap else 0
    if hosted or from_r2:
        store.mark_hosted(ep_id)
    return {
        "ep": ep_id, "bytes": nbytes, "dur": data.get("duration"),
        "segments": len(data.get("segments", [])), "remap": n_remap, "hosted": hosted or from_r2,
    }


# ─────────────────────── 선택 + 실행 ───────────────────────
def _vocab_counts() -> dict[int, int]:
    """episode_id → vocab 개수 (episodes_list 뷰). 학습 빈도 우선순위용."""
    try:
        res = store.client().table("episodes_list").select("id,vocab_count").execute()
        return {r["id"]: (r.get("vocab_count") or 0) for r in res.data}
    except Exception:
        return {}


def select_ids(args) -> list[int]:
    if args.ids:
        return [int(x) for x in args.ids.split(",") if x.strip()]
    rows = store.episodes_by_recency(limit=args.recent if args.recent else None)
    ids = [r["id"] for r in rows]
    if getattr(args, "by_vocab", False):
        # vocab 많은(=Study 에서 자주 보는) 회차 먼저 → 예문 탭 정확도가 학습 지점에 빨리 도달.
        # 동률은 최신순(recency) 유지. 재싱크되면 그 회차 예문이 즉시 정확히 재생됨.
        vc = _vocab_counts()
        ids.sort(key=lambda i: vc.get(i, 0), reverse=True)
    return ids


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser()
    p.add_argument("--ids", help="쉼표구분 episode id (명시 시 우선)")
    p.add_argument("--recent", type=int, help="pub_date 최신 N개 대상")
    p.add_argument("--all", action="store_true", help="전 에피소드 대상(진행파일로 이어감)")
    p.add_argument("--limit", type=int, default=20, help="이번 실행 처리 상한")
    p.add_argument("--redo", action="store_true", help="이미 done 인 것도 다시")
    p.add_argument("--no-remap", action="store_true", help="vocab 타임스탬프 재매핑 생략")
    p.add_argument("--from-r2", action="store_true",
                   help="megaphone 대신 R2(서빙 오디오)를 받아 재STT → 자막=서빙오디오 완벽 일치(재업로드 X)")
    p.add_argument("--by-vocab", action="store_true",
                   help="recency 대신 vocab 많은(자주 학습) 회차 먼저 — 예문 정확도를 학습지점에 빨리 도달")
    p.add_argument("--remap-only", action="store_true",
                   help="STT 없이 기존 transcript 로 vocab 타임스탬프만 재매핑(예문 클립 잘림 일괄수정, GPU 불필요)")
    args = p.parse_args()

    if args.remap_only:
        rows = store.episodes_by_recency()
        tot = 0
        for r in rows:
            eid = r["id"]
            try:
                tr = store.download_transcript(eid)
                if not tr:
                    continue
                u = remap_vocab(eid, tr)
                tot += u
                if u:
                    log.info("remap ep=%s: vocab %d 갱신", eid, u)
            except Exception:
                log.exception("remap 실패 ep=%s", eid)
        log.info("remap-only 완료: 총 %d vocab 갱신", tot)
        return

    if not (args.ids or args.recent or args.all):
        p.error("--ids / --recent N / --all 중 하나 필요")

    done = load_done()                          # 저장 베이스는 항상 전체 — --redo 여도 진행파일 손실 방지
    skip = load_skip()
    sel_done = set() if args.redo else done     # --redo 는 '이미 done' 도 다시 처리(선택 필터에만 영향)
    ids = [i for i in select_ids(args) if i not in sel_done and i not in skip]
    ids = ids[: args.limit]
    if not ids:
        log.info("처리할 episode 없음 (모두 done?). 총 done=%d", len(done))
        return

    log.info("재정렬 시작: %d개 (done 누적 %d, skip %d)", len(ids), len(done), len(skip))
    rows = {r["id"]: r for r in store.episodes_by_recency()}
    ok = 0
    for ep_id in ids:
        row = rows.get(ep_id)
        if not row or not row.get("audio_url"):
            log.warning("skip ep=%s (no audio_url)", ep_id)
            continue
        try:
            res = retranscribe_one(row, remap=not args.no_remap, from_r2=args.from_r2)
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
