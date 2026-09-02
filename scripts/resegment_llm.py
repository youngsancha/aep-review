"""문장 경계 LLM 재점검 — 규칙 분절이 어색하게 끊은 자막을 로컬 LLM(과금 0)으로 다시 나눈다.

왜 필요한가 (2026-09-02, 사용자 신고 "문장 끊어짐이 어색하고 싱크가 안 맞는다"):
  자막·번역 키·쉐도잉 반복 단위는 전부 resegment() 가 만든 '문장'이다. 그 규칙은 구두점이 없을 때
  **단어 14개 / 9초 상한에서 문장 한가운데를 자른다**(scripts/audit_segmentation 이 세는 word-cap /
  duration 경로). 잘린 앞토막은 뜻이 안 통하고, 뒷토막으로 시작하는 문단은 반복재생 때마다 문장
  중간에서 소리가 시작돼 사용자에게는 "싱크가 안 맞는" 것으로 보인다. 실측(2026-08-07)으로
  타임스탬프 자체는 정확했다(중앙값 -0.01s) — 어긋난 것은 경계다. 그러니 고칠 것도 경계다.

  규칙으로는 못 푼다: 구두점이 빠진 자막에서 "여기가 문장 끝인가"는 뜻을 읽어야 안다. 그건 LLM 의
  일이고, 이 프로젝트에는 과금·한도 0 인 로컬 백엔드(ingest.ollama_client)가 이미 있다.

어떻게 (⛔ 두 가지 함정을 설계로 피한다):
  ① LLM 에게 **경계만** 맡기고 단어는 원본을 쓴다. 출력 문장을 원본 단어열에 정렬(difflib)해서
     '몇 번째 단어에서 끝나는가'만 가져오므로, 모델이 단어를 바꾸거나 빠뜨려도 자막에 들어가지 않고,
     정렬이 안 맞는 청크는 통째로 규칙 분절로 되돌린다(부분 채택 없음 — 어느 쪽이 맞는지 모른다).
  ② 결과를 transcript 의 segments 로 **저장**한다(문장 하나 = segment 하나, `sent: true`). 앱과
     번역 스크립트의 resegment 는 그 표식을 보면 규칙을 건너뛰고 경계를 그대로 믿는다 — 같은 파일을
     읽는 모든 소비자가 같은 문장을 보게 되고, 앱에는 추가 다운로드도 계산도 없다.

  번역 키(trkey)는 종결 구두점을 떼므로 경계가 안 바뀐 문장의 `_ko.json` 은 그대로 맞는다. 경계가
  바뀐 문장만 키가 새로 생기고, translate_transcripts(ollama) 가 빈 키를 채운다(멱등).

    AEP_LLM_BACKEND=ollama python -m scripts.resegment_llm --newest 10          # 쇼별 최신 10편
    python -m scripts.resegment_llm --ids 1026,682 --dry                        # 저장 없이 통계만
    python -m scripts.resegment_llm --ids 1026 --show-diff                      # 바뀐 경계 실물 출력

⛔ 이 스크립트는 ollama 전용이다. 문장 경계 판단은 청크당 한 번씩 수백 번 부르는 작업이라 한도가
   있는 백엔드(claude -p)로 돌리면 2026-07-27 처럼 한도를 태우고 조용히 실패한다.
"""
from __future__ import annotations

import argparse
import difflib
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone

from ingest import store
from ingest.ollama_client import call_ollama, configured, model_name
from ingest.shows import show_slugs
from scripts.audit_ko_coverage import newest_ids
from scripts.translate_transcripts import _ENDS, _ends_sent, resegment, trkey

log = logging.getLogger("resegment_llm")

# 청크: 규칙 분절 문장을 모아 이 어절 수를 넘고 '구두점으로 끝난' 문장에서 자른다. 상한을 넘으면
# 구두점이 없어도 자른다(모델 컨텍스트 보호). 실측 exaone3.5:7.8b — 150어절 안쪽이 정렬 성공률이 높다.
CHUNK_WORDS = 120
CHUNK_HARD = 200
# 정렬 채택 기준: 원본 단어와 모델 출력 단어의 일치 비율. 그 아래면 모델이 말을 바꿨다 — 청크 폐기.
ALIGN_MIN_RATIO = 0.95
# 모델이 내놓은 문장이 이보다 길면 UI 상한(번역카드와 겹침) 때문에 규칙 분절로 다시 나눈다.
MAX_SENT_WORDS = 22
MAX_SENT_SEC = 12.0
# 긴 문장을 나눌 때 '절'이 시작되는 단어 — LLM 2차 분할이 실패하면 이 앞에서 균형 분할한다.
_CLAUSE = {"and", "but", "because", "so", "which", "who", "that", "when", "where", "while", "if", "as",
           "after", "before", "since", "or", "although", "though", "until", "unless", "whereas", "then"}
_TRAIL_OPEN = re.compile(r'[,;:]["\')\]]?$')
# 이 표식이 달린 segment 는 이미 '문장'이다 — resegment(앱·파이썬 양쪽)가 규칙을 건너뛴다.
SENT_FLAG = "sent"
TAG = "llm-v1"

_TOKEN = re.compile(r"[^a-z0-9']+")


def norm_token(w: str) -> str:
    return _TOKEN.sub("", (w or "").lower().replace("’", "'"))


def flatten_words(segments) -> list[dict]:
    """resegment 와 같은 규칙으로 단어열을 만든다(단어 타임스탬프 없는 segment 는 통째로 한 단어)."""
    words = []
    for seg in segments or []:
        sw = seg.get("words")
        if sw:
            for w in sw:
                if w.get("word") is None:
                    continue
                words.append({"word": w["word"], "start": w.get("start", seg.get("start")),
                              "end": w.get("end", seg.get("end"))})
        elif seg.get("text"):
            words.append({"word": seg["text"], "start": seg.get("start"), "end": seg.get("end")})
    return words


def rule_sentences(words: list[dict]) -> list[list[dict]]:
    """규칙 분절을 단어 묶음으로. resegment 는 문자열만 돌려주므로 단어열에 다시 대응시킨다."""
    texts = resegment([{"words": words}]) if words else []
    out, i = [], 0
    for t in texts:
        n = len(t.split())
        # resegment 는 단어를 "".join 하므로 어절 수 == 단어 객체 수가 아닐 수 있다(공백 없는 토큰).
        # 토큰을 하나씩 붙여 가며 텍스트가 같아지는 지점을 찾는다.
        j, acc = i, ""
        target = re.sub(r"\s+", " ", t).strip().rstrip(".")
        while j < len(words):
            acc += words[j]["word"]
            j += 1
            cand = re.sub(r"\s+", " ", acc).strip().rstrip(".")
            if cand == target:
                break
            if len(cand) > len(target) + 2:
                break
        if j == i:                      # 대응 실패 — 어절 수로 근사
            j = min(len(words), i + max(1, n))
        out.append(words[i:j])
        i = j
    if i < len(words):
        out.append(words[i:])
    return [s for s in out if s]


def make_chunks(sents: list[list[dict]]) -> list[list[list[dict]]]:
    chunks, cur, n = [], [], 0
    for s in sents:
        cur.append(s)
        n += len(s)
        closed = _ENDS.search("".join(w["word"] for w in s).strip()) is not None
        if (n >= CHUNK_WORDS and closed) or n >= CHUNK_HARD:
            chunks.append(cur)
            cur, n = [], 0
    if cur:
        chunks.append(cur)
    return chunks


SCHEMA = {
    "type": "object",
    "properties": {"sentences": {"type": "array", "items": {"type": "string"}}},
    "required": ["sentences"],
}


def build_prompt(text: str) -> str:
    return (
        "You are fixing sentence boundaries in an automatic speech transcript (a podcast or news show). "
        "The text below was split by a machine and may have missing or wrong punctuation.\n\n"
        "Rewrite it as a JSON object {\"sentences\": [...]} with ONE complete sentence per array item.\n"
        "Rules:\n"
        "- Copy every word exactly, in the same order. Do not add, drop, merge, or paraphrase words. "
        "Only punctuation and capitalization may change.\n"
        "- A sentence is a complete thought. Never end a sentence right before its last word or in the middle of a phrase.\n"
        "- Start a new sentence when the speaker changes or a new thought begins, even if the text has no punctuation there.\n"
        f"- If a sentence is longer than about {MAX_SENT_WORDS} words, split it at a natural clause boundary "
        "(before 'and', 'but', 'because', 'which', 'so', ...).\n"
        "- Sentence fragments that are clearly spoken as their own utterance (\"Yeah.\", \"Thank you.\") are their own item.\n\n"
        f"TEXT:\n{text}\n"
    )


SPLIT_SCHEMA = {
    "type": "object",
    "properties": {"segments": {"type": "array", "items": {"type": "string"}}},
    "required": ["segments"],
}


def build_split_prompt(text: str, n_words: int) -> str:
    parts = max(2, -(-n_words // MAX_SENT_WORDS))
    return (
        "The following is ONE long spoken sentence from a transcript. Split it into "
        f"{parts} shorter segments of at most {MAX_SENT_WORDS} words each, cutting ONLY at natural clause "
        "boundaries (before 'and', 'but', 'because', 'which', 'who', 'so', 'that', a relative clause, or after a comma).\n"
        "Copy every word exactly, in order; do not add, drop, or change words. "
        "Return JSON {\"segments\": [...]}. Do not add a period to a segment that is not the end of the sentence.\n\n"
        f"SENTENCE:\n{text}\n"
    )


def balanced_split(sent: list[dict]) -> list[list[dict]]:
    """결정적 폴백: 절 시작 단어(또는 쉼표 뒤) 중 가운데에 가장 가까운 곳에서 반으로 나눈다(재귀).

    규칙 분절(resegment)을 부분 단어열에 다시 돌리면 어절 수 문턱이 0 부터 다시 세어져 원본과도
    다르고 뜻과도 무관한 곳("last | week")에서 갈린다 — 실측(ep 620 dry-run). 절 경계에서 균형
    있게 나누는 쪽이 어색함이 훨씬 덜하다.
    """
    n = len(sent)
    dur = (sent[-1].get("end") or 0) - (sent[0].get("start") or 0)
    if n <= MAX_SENT_WORDS and dur <= MAX_SENT_SEC:
        return [sent]
    # 큰 침묵(≥1.5s)이 안에 있으면 문법보다 먼저 거기서 나눈다 — 규칙 엔진의 gap 규칙과 같다. 어절이
    # 적어도 12초를 넘는 문장은 이 경우다(xcheck: "5어절 15초짜리가 그대로 통과" — 침묵을 안 봤다).
    gaps = [((sent[i]["start"] or 0) - (sent[i - 1]["end"] or 0), i) for i in range(1, n)
            if isinstance(sent[i].get("start"), (int, float)) and isinstance(sent[i - 1].get("end"), (int, float))]
    if gaps:
        g, gi = max(gaps)
        if g >= 1.5:
            return balanced_split(sent[:gi]) + balanced_split(sent[gi:])
    if n < 6:
        return [sent]
    cands = [i for i in range(3, n - 2)
             if norm_token(sent[i]["word"]) in _CLAUSE or _TRAIL_OPEN.search(sent[i - 1]["word"].strip())]
    cut = min(cands, key=lambda i: abs(i - n / 2)) if cands else n // 2
    return balanced_split(sent[:cut]) + balanced_split(sent[cut:])


def split_long(sent: list[dict]) -> list[list[dict]]:
    """UI 상한을 넘는 LLM 문장 → LLM 에게 절 단위 분할을 한 번 더 맡기고, 안 되면 balanced_split."""
    text = re.sub(r"\s+", " ", "".join(w["word"] for w in sent)).strip()
    pieces = None
    try:
        raw = call_ollama(build_split_prompt(text, len(sent)), timeout_sec=120, max_output_tokens=2048,
                          schema=SPLIT_SCHEMA)
        segs = [s for s in ((json.loads(raw) or {}).get("segments") or []) if isinstance(s, str)]
        ends = align(sent, segs) if len(segs) >= 2 else None
        if ends and len(ends) >= 2:
            pieces, i = [], 0
            for e in ends:
                pieces.append(sent[i:e])
                i = e
    except Exception as e:                                  # noqa: BLE001
        log.debug("split_long LLM 실패: %s", str(e)[:100])
    if not pieces:
        return balanced_split(sent)
    out = []
    for p in pieces:
        out.extend(balanced_split(p))                       # 모델이 여전히 길게 남긴 조각은 폴백으로
    return out


def align(chunk_words: list[dict], sentences: list[str]) -> list[int] | None:
    """모델 문장들 → 각 문장이 끝나는 '원본 단어 인덱스'(exclusive) 목록. 실패면 None.

    원본 단어열과 모델 출력 단어열을 difflib 로 정렬한다. 모델이 단어를 조금 바꿨어도(대문자·구두점·
    축약형) 정규화 뒤 일치하면 같은 단어다. 일치 비율이 ALIGN_MIN_RATIO 미만이면 말을 바꾼 것 —
    이 청크는 채택하지 않는다.
    """
    orig = [norm_token(w["word"]) for w in chunk_words]
    out_tokens, sent_end_out = [], []
    for s in sentences:
        toks = [norm_token(t) for t in re.split(r"\s+", s.strip()) if norm_token(t)]
        if not toks:
            continue
        out_tokens.extend(toks)
        sent_end_out.append(len(out_tokens))          # exclusive
    if not out_tokens:
        return None
    sm = difflib.SequenceMatcher(None, orig, out_tokens, autojunk=False)
    matched = sum(b.size for b in sm.get_matching_blocks())
    if matched / max(len(orig), len(out_tokens)) < ALIGN_MIN_RATIO:
        return None
    # 출력 인덱스 → 원본 인덱스 매핑(일치 블록 안에서만 확정, 나머지는 직전 확정값으로 보간)
    out2orig = [-1] * (len(out_tokens) + 1)
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            out2orig[blk.b + k] = blk.a + k
    out2orig[len(out_tokens)] = len(orig)
    last = 0
    for i in range(len(out2orig)):
        if out2orig[i] < 0:
            out2orig[i] = last
        else:
            last = out2orig[i]
    ends = []
    for e in sent_end_out:
        # 문장의 마지막 출력 토큰이 대응하는 원본 토큰 + 1
        j = e - 1
        o = out2orig[j]
        if o < 0:
            continue
        end = o + 1
        if ends and end <= ends[-1]:
            continue                                   # 빈 문장(모델이 한 문장을 둘로 쓴 흔적) — 병합
        ends.append(end)
    if not ends:
        return None
    if ends[-1] != len(orig):
        ends[-1] = len(orig)                           # 마지막 문장은 청크 끝까지 (꼬리 누락 방지)
    return ends


def cap_split(sent: list[dict]) -> list[tuple[list[dict], bool]]:
    """모델 문장이 UI 상한을 넘으면 절 단위로 나눈다. 반환 (단어들, 문장끝인가).

    문장 끝이 아닌 조각에는 마침표를 붙이지 않는다 — "upstairs in the." 같은 가짜 종결이 바로
    사용자가 말한 '어색한 끊어짐'이다. 규칙 분절 출력도 조각에는 마침표를 안 붙였다.
    """
    out: list[tuple[list[dict], bool]] = []
    for piece in presplit_terminal(sent):
        dur = (piece[-1].get("end") or 0) - (piece[0].get("start") or 0)
        if len(piece) <= MAX_SENT_WORDS and dur <= MAX_SENT_SEC:
            out.append((piece, True))
            continue
        parts = split_long(piece)
        out.extend((p, i == len(parts) - 1) for i, p in enumerate(parts))
    return out


def presplit_terminal(sent: list[dict]) -> list[list[dict]]:
    """모델이 한 항목에 두 문장을 넣은 경우("Seeing red? That is…", "…Ontario. Restrictions apply.")
    — 항목 안의 종결 구두점 뒤에 대문자 단어가 오면 거기서 먼저 나눈다(실측 ep 1049, 4건).
    규칙 엔진의 ENDS 조건과 같게 왼쪽은 2어절 이상, 약어(U.S., Mr.)는 종결로 보지 않는다."""
    pieces, start = [], 0
    for i in range(2, len(sent)):
        prev = sent[i - 1]["word"].strip()
        nxt = sent[i]["word"].strip()
        if i - start >= 2 and _ends_sent(prev) and nxt[:1].isupper():
            pieces.append(sent[start:i])
            start = i
    pieces.append(sent[start:])
    return [p for p in pieces if p]


def to_segment(idx: int, sent: list[dict], complete: bool = True) -> dict:
    text = "".join(w["word"] for w in sent).strip()
    if complete and text and not _ENDS.search(text) and not _TRAIL_OPEN.search(text):
        text += "."
    starts = [w["start"] for w in sent if isinstance(w.get("start"), (int, float))]
    ends = [w["end"] for w in sent if isinstance(w.get("end"), (int, float))]
    return {"idx": idx, "start": min(starts) if starts else None, "end": max(ends) if ends else None,
            "text": text, "words": sent, SENT_FLAG: True}


def timing_anomalies(words: list[dict]) -> dict:
    """싱크 재점검의 결정적 부분: 타임스탬프 자체가 깨진 단어를 센다(역행·비정상 길이)."""
    back = long = 0
    prev_end = None
    for w in words:
        s, e = w.get("start"), w.get("end")
        if not isinstance(s, (int, float)) or not isinstance(e, (int, float)):
            continue
        if prev_end is not None and s < prev_end - 0.5:
            back += 1
        if e - s > 4.0:
            long += 1
        prev_end = e
    return {"backwards": back, "overlong": long}


def resegment_episode(ep_id: int, *, dry: bool, show_diff: bool, force: bool) -> dict | None:
    tr = store.download_transcript(ep_id)
    if not tr:
        return None
    segs = tr.get("segments") or []
    if not force and segs and all(s.get(SENT_FLAG) for s in segs):
        log.info("ep %s 이미 처리됨(%s) — 건너뜀", ep_id, tr.get("resegmented", {}).get("by", "?"))
        return {"id": ep_id, "skipped": True}
    words = flatten_words(segs)
    if not words:
        return None
    if not any(isinstance(w.get("start"), (int, float)) for w in words):
        log.warning("ep %s 단어 타임스탬프 없음 — 건너뜀", ep_id)
        return None
    before = rule_sentences(words)
    chunks = make_chunks(before)
    result: list[tuple[list[dict], bool]] = []
    stats = {"id": ep_id, "chunks": len(chunks), "llm_ok": 0, "llm_fail": 0, "before": len(before)}
    t0 = time.time()
    for ci, chunk in enumerate(chunks):
        cw = [w for s in chunk for w in s]
        text = re.sub(r"\s+", " ", "".join(w["word"] for w in cw)).strip()
        ends = None
        try:
            raw = call_ollama(build_prompt(text), timeout_sec=180, max_output_tokens=4096, schema=SCHEMA)
            sents = (json.loads(raw) or {}).get("sentences") or []
            ends = align(cw, [s for s in sents if isinstance(s, str)])
        except Exception as e:                          # noqa: BLE001 — 청크 단위로 되돌린다
            log.warning("ep %s chunk %d/%d LLM 실패: %s", ep_id, ci + 1, len(chunks), str(e)[:120])
        if ends is None:
            stats["llm_fail"] += 1
            # 규칙 분절 그대로 — 조각인지 문장인지 모르므로 마침표도 원래대로(있는 것만).
            result.extend((s, False) for s in chunk)
            continue
        stats["llm_ok"] += 1
        i = 0
        for e in ends:
            result.extend(cap_split(cw[i:e]))
            i = e
    new_segs = [to_segment(k, s, complete) for k, (s, complete) in enumerate(result)]
    # 번역 키 보존율: 경계가 그대로인 문장은 _ko.json 이 그대로 맞는다.
    before_keys = {trkey("".join(w["word"] for w in s)) for s in before}
    after_keys = [trkey(s["text"]) for s in new_segs]
    kept = sum(1 for k in after_keys if k in before_keys)
    stats.update({"after": len(new_segs), "keys_kept": kept, "keys_new": len(after_keys) - kept,
                  "timing": timing_anomalies(words), "sec": round(time.time() - t0, 1)})
    if show_diff:
        bt = ["".join(w["word"] for w in s).strip() for s in before]
        at = [s["text"] for s in new_segs]
        for line in difflib.unified_diff(bt, at, "rule", "llm", lineterm="", n=0):
            if line.startswith(("+", "-")) and not line.startswith(("+++", "---")):
                print("   " + line)
    if not dry:
        tr["segments"] = new_segs
        tr["resegmented"] = {"by": f"ollama {model_name()}", "tag": TAG,
                             "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                             "chunks": stats["chunks"], "llm_ok": stats["llm_ok"]}
        store.upload_transcript(ep_id, tr)
    return stats


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)   # 파이프로 볼 때 diff 와 로그 순서가 섞이지 않게
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser()
    p.add_argument("--ids", help="쉼표로 구분한 에피소드 id")
    p.add_argument("--newest", type=int, help="쇼별 최신 N편(--show 로 한 쇼만)")
    p.add_argument("--show", help="한 쇼만")
    p.add_argument("--dry", action="store_true", help="저장하지 않고 통계만")
    p.add_argument("--show-diff", action="store_true", help="바뀐 문장 경계를 실물로 출력")
    p.add_argument("--force", action="store_true", help="이미 처리된 회차도 다시")
    a = p.parse_args()

    if (os.environ.get("AEP_LLM_BACKEND") or "") != "ollama":
        raise SystemExit("AEP_LLM_BACKEND=ollama 로만 돈다(모듈 상단 주석 — 한도 있는 백엔드로 수백 번 부르지 않는다)")
    if not configured():
        raise SystemExit(f"ollama 모델 {model_name()} 이 준비되지 않았다 — ollama serve / ollama pull 확인")

    ids: list[int] = []
    if a.ids:
        ids = [int(x) for x in a.ids.split(",") if x.strip()]
    elif a.newest:
        shows = [a.show] if a.show else list(show_slugs())
        # 최근 것부터: 쇼를 번갈아 가며 최신순으로 섞는다(한 쇼가 다 끝나야 다음 쇼가 시작되지 않게).
        per = [newest_ids(s, a.newest) for s in shows]
        for k in range(a.newest):
            for lst in per:
                if k < len(lst):
                    ids.append(lst[k])
    else:
        raise SystemExit("--ids 또는 --newest 가 필요하다")

    tot = {"eps": 0, "chunks": 0, "llm_ok": 0, "before": 0, "after": 0, "keys_new": 0, "back": 0, "long": 0}
    for i, ep in enumerate(ids, 1):
        st = resegment_episode(ep, dry=a.dry, show_diff=a.show_diff, force=a.force)
        if not st or st.get("skipped"):
            continue
        tot["eps"] += 1
        for k in ("chunks", "llm_ok", "before", "after", "keys_new"):
            tot[k] += st[k]
        tot["back"] += st["timing"]["backwards"]
        tot["long"] += st["timing"]["overlong"]
        log.info("[%d/%d] ep %s: 청크 %d(LLM 채택 %d) 문장 %d→%d, 번역키 유지 %d/신규 %d, 타임스탬프 역행 %d·과장 %d, %.0fs%s",
                 i, len(ids), ep, st["chunks"], st["llm_ok"], st["before"], st["after"], st["keys_kept"],
                 st["keys_new"], st["timing"]["backwards"], st["timing"]["overlong"], st["sec"],
                 " (dry)" if a.dry else "")
    if tot["eps"]:
        log.info("완료: %d편, 청크 %d 중 LLM 채택 %d(%.0f%%), 문장 %d→%d, 새 번역키 %d, 타임스탬프 역행 %d·과장 %d",
                 tot["eps"], tot["chunks"], tot["llm_ok"], 100 * tot["llm_ok"] / max(1, tot["chunks"]),
                 tot["before"], tot["after"], tot["keys_new"], tot["back"], tot["long"])


if __name__ == "__main__":
    main()
