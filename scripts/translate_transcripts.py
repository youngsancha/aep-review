"""모든 transcript(에피소드 자막)의 한국어를 '문맥 인지' 고품질로 사전 번역 → Storage 저장.

기존엔 episode.js 가 재생 중 문장마다 MyMemory(무료 MT)로 즉석 번역했는데, 한 문장을
'고립'시켜 번역하니 대명사·관용구·담화 흐름을 못 살려 직역·문맥불일치가 잦았다.
이 스크립트는 앱이 '실제로 보여주는 문장'(Storage 자막을 episode.js 와 동일하게 resegment)
을 연속 배치로 묶어 claude 에게 '문맥째' 자연스러운 구어체 한국어로 번역시킨다.

저장: Storage `transcripts/{id}_ko.json` = { trKey(문장) : 한국어 }.
  - trKey 는 episode.js 의 trKey 와 동일(소문자·공백정규화·180자) → 앱이 그 키로 즉시 조회.
  - 매칭 실패분만 런타임 MyMemory 폴백(기존 동작 유지) → 배포가 이 잡 완료에 의존하지 않음.

멱등: 에피소드별 기존 _ko.json 을 이어받아 빠진 문장만 번역, 배치마다 체크포인트 업로드.
백그라운드 안전: 중간에 끊겨도 다시 실행하면 이어서 진행.

    python -m scripts.translate_transcripts                 # 전체(최근 id 먼저)
    python -m scripts.translate_transcripts --only 250      # 한 에피소드만
    python -m scripts.translate_transcripts --limit 3       # 앞 3개(테스트)
    python -m scripts.translate_transcripts --sample 250    # 번역 품질 표본만 출력(저장 X)
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import subprocess
import sys

from ingest import store
from ingest.extract_vocab import _result_text

log = logging.getLogger("translate_transcripts")
BATCH = 32          # 한 claude 호출에 묶는 문장 수(문맥 유지 + 응답 안정, 호출수 절감)
CTX_BEFORE = 2      # 배치 앞에 붙여 줄 '맥락용' 직전 문장 수(번역 대상 아님)

# 배치 실패는 '건너뛰고 계속'이 기본이다 — 일시적 오류엔 맞다. 하지만 claude 사용 한도에
# 걸리면 이후 모든 호출이 즉시 실패하므로, 그대로 두면 남은 전 회차를 초고속으로 '시도만'
# 하고 완주해 버린다. 실제로 2026-07-27 그렇게 됐다: 10:46 에 한도에 걸린 뒤 40분 동안
# 5,368건을 실패시키며 목록을 소진하고 exit 0 으로 끝나 '완료'처럼 보였다.
# 재시도는 '다시 하면 나아지는 실패'에만 의미가 있다. 한도는 아니다 → 연속 실패가 임계치를
# 넘으면 멈춘다(멱등·체크포인트라 나중에 이어서 하면 된다).
MAX_CONSECUTIVE_FAILS = 12
_consec_fails = 0
_MODEL = ""         # --model 로 설정. 빈 값이면 claude CLI 기본(=세션 모델).


class ClaudeUnavailable(RuntimeError):
    """연속 실패가 임계치 초과 — 재시도로 나아지지 않는 종류(대개 사용 한도)."""

# ─────────────────────────── resegment (episode.js 포팅, 키 정합 필수) ───────────────────────────
_ENDS = re.compile(r'[.!?…]["\')\]]?$')
# 약어는 마침표로 끝나지만 문장을 끝내지 않는다 — episode.js 의 ABBR/endsSent 와 1:1 대응.
# (근거·실측 사례는 episode.js 주석 참조. tests/test_resegment_parity.py 가 둘을 함께 고정한다.)
_ABBR = re.compile(r'^(?:[A-Za-z]\.)+$|^(?:mr|mrs|ms|dr|prof|sen|rep|gov|st|jr|sr|vs|etc|inc|ltd|co|no|dept|approx)\.$', re.I)
_LEAD_NONALPHA = re.compile(r'^[^A-Za-z]+')


def _ends_sent(t: str) -> bool:
    t = (t or "").strip()
    return bool(_ENDS.search(t)) and not _ABBR.match(_LEAD_NONALPHA.sub("", t))
_COMMA = re.compile(r'[,;:]["\')\]]?$')
_CONJ = re.compile(r'^(and|but|so|or|because|when|while|if|since|though|although|unless)$', re.I)
# The/My 는 episode.js 와 동일하게 실측(53 회차, 470-522) 기반으로 추가 — 그 근거는
# episode.js 의 STARTER 주석 참고. A/An/Our/Their/His/Her 는 오탐(작품명·스폰서 철자코드) 또는
# 근거 부족으로 제외.
_STARTER = re.compile(
    r"^(But|And|So|Or|Now|Then|Well|Yeah|Yes|No|Okay|OK|Here|There|This|That|These|Those|"
    r"He|She|It|They|We|You|Who|If|When|Where|What|Why|How|Because|Although|Though|While|"
    r"Since|Maybe|Actually|Finally|However|Meanwhile|Anyway|Plus|Also|The|My)$"
)
_LEAD_STRIP = re.compile(r"^[^A-Za-z']+")


def _num(x):
    return x if isinstance(x, (int, float)) else None


def resegment(segments) -> list[str]:
    """episode.js resegment 와 동일하게 Whisper segment 를 구두점/쉼/접속사 기준 문장으로 재분할."""
    words = []
    for seg in segments or []:
        sw = seg.get("words")
        if sw:
            for w in sw:
                if w.get("word") is None:
                    continue
                words.append({"word": w["word"], "start": w.get("start", seg.get("start")), "end": w.get("end", seg.get("end"))})
        elif seg.get("text"):
            words.append({"word": seg["text"], "start": seg.get("start"), "end": seg.get("end")})
    if not words:
        return [(s.get("text") or "").strip() for s in (segments or [])]

    # episode.js 와 같이 '문장 객체' 로 모았다가 마지막에 텍스트만 뽑는다 — 아래 ⑤ 후처리(꼬리
    # 되돌리기)가 단어 목록을 봐야 하기 때문이다. 반환 계약(list[str])은 그대로다.
    out: list[dict] = []
    cur = None
    prev_end = None

    def close(force_period=False):
        nonlocal cur
        cur["text"] = "".join(x["word"] for x in cur["words"]).strip()
        # STARTER 분할은 종결 구두점 자체가 빠진 경계라, 보충하지 않으면 trkey 쪽(_ko.json 조회)과
        # groupIntoParagraphs 쪽(endsSentence) 양쪽에서 문장이 안 끝난 것처럼 보인다.
        if force_period and cur["text"] and not _ENDS.search(cur["text"]):
            cur["text"] += "."
        out.append(cur)
        cur = None

    for w in words:
        ws = _num(w.get("start"))
        gap = (ws - prev_end) if (prev_end is not None and ws is not None) else 0
        if cur and (gap > 1.5 or (len(cur["words"]) >= 3 and gap > 0.8) or (len(cur["words"]) >= 7 and gap > 0.45)):
            close()
        if cur and len(cur["words"]) >= 11:
            lead = _LEAD_STRIP.sub("", (w.get("word") or "").strip()).lower()
            if _CONJ.match(lead):
                close()
        if cur and len(cur["words"]) >= 3:
            raw = _LEAD_STRIP.sub("", (w.get("word") or "").strip())
            if raw[:1].isupper() and _STARTER.match(raw.split("'")[0]):
                close(force_period=True)
        if not cur:
            cur = {"start": ws, "end": _num(w.get("end")), "words": []}
        cur["words"].append(w)
        we = _num(w.get("end"))
        if we is not None:
            cur["end"] = we
            prev_end = we
        txt = (w.get("word") or "").strip()
        n = len(cur["words"])
        dur = (cur["end"] - cur["start"]) if (_num(cur.get("end")) is not None and _num(cur.get("start")) is not None) else 0
        if (_ends_sent(txt) and n >= 2) or (_COMMA.search(txt) and n >= 7) or dur > 9 or n >= 14:
            close()
    if cur:
        cur["text"] = "".join(x["word"] for x in cur["words"]).strip()
        out.append(cur)

    # ⑤ 후처리 — '앞 문장의 꼬리' 되돌리기. episode.js resegment 의 같은 블록과 1:1 대응이며
    # tests/test_resegment_parity.py 가 두 구현을 함께 고정한다. 상세 근거는 episode.js 주석 참조
    # (요지: 강조 쉼 때문에 문장의 마지막 단어 앞에서 갈리면, ENDS 의 n>=2 가드 때문에 그 한 단어가
    #  닫히지 못하고 다음 문장에 붙는다 — 실측 3개 회차 2065문장 중 3.8%).
    for i in range(len(out) - 1, 0, -1):
        sc, pc = out[i], out[i - 1]
        if len(sc["words"]) < 2 or not pc["words"]:
            continue
        if not _ends_sent((sc["words"][0].get("word") or "")):
            continue
        if _ends_sent(pc.get("text") or ""):
            continue
        w0 = sc["words"].pop(0)
        pc["words"].append(w0)
        we0 = _num(w0.get("end"))
        if we0 is not None:
            pc["end"] = we0
        ws0 = _num(sc["words"][0].get("start"))
        if ws0 is not None:
            sc["start"] = ws0
        pc["text"] = "".join(x["word"] for x in pc["words"]).strip()
        sc["text"] = "".join(x["word"] for x in sc["words"]).strip()
    return [o["text"] for o in out]


def trkey(text: str) -> str:
    """episode.js trKey 와 동일: 소문자·공백정규화·trim·종결구두점 제거·180자.

    종결 구두점을 떼는 이유: resegment 가 마침표 빠진 문장에 '.' 을 보충하게 되면서 문장
    텍스트가 바뀌는데, 이미 만들어 둔 521회차 분량의 `_ko.json` 키는 보충 전 텍스트다.
    키에서 구두점을 빼면 재생성 없이 옛 키가 그대로 다시 맞는다(실측 미스 14.6%→1.1%).
    """
    s = re.sub(r"\s+", " ", str(text or "")).strip().lower()
    return re.sub(r"[.!?…]+$", "", s)[:180]


# ─────────────────────────── claude (문맥 인지 번역) ───────────────────────────
def _call_claude(prompt: str, timeout_sec: int = 300) -> dict:
    # 모델을 지정하지 않으면 CLI 기본값(=세션 모델, 보통 opus)을 상속한다. 번역은 추론이 아니라
    # 변환 작업이라 상위 모델이 꼭 필요하지 않다 → --model 로 낮춰 쿼터를 아낀다(_MODEL).
    cmd = ["claude", "-p", "--output-format", "json"]
    if _MODEL:
        cmd += ["--model", _MODEL]
    proc = subprocess.run(
        cmd,
        input=prompt, capture_output=True, text=True, encoding="utf-8", timeout=timeout_sec,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude CLI rc={proc.returncode}: {proc.stderr[:300]}")
    try:
        envelope = json.loads(proc.stdout)
    except json.JSONDecodeError:
        envelope = {"result": proc.stdout}
    text = _result_text(envelope, proc.stdout)
    return _json_object(text)


def _call_llm(prompt: str, timeout_sec: int = 300) -> dict:
    """백엔드 중립 진입점 — ingest.extract_vocab.call_llm 과 같은 규약(AEP_LLM_BACKEND).

      (미설정)/"claude-cli" → `claude -p` (기존 동작 그대로, Max 구독이라 과금 0)
      "gemini"             → HTTP. claude CLI 가 못 뜨는 cron/CI 에서 번역을 살린다.
      "auto"               → CLI 가 PATH 에 있으면 그것, 없으면 Gemini.

    기본값이 claude-cli 라 env 를 안 건드리면 이전과 완전히 동일하게 동작한다.
    """
    choice = (os.environ.get("AEP_LLM_BACKEND") or "claude-cli").strip().lower()
    if choice == "auto":
        choice = "claude-cli" if shutil.which("claude") else "gemini"
    if choice == "gemini":
        from ingest.gemini_client import call_gemini

        # 한 배치가 32문장이라 출력이 길다 — 잘리면 그 배치가 통째로 버려진다.
        return _json_object(call_gemini(prompt, timeout_sec=timeout_sec, max_output_tokens=16384))
    return _call_claude(prompt, timeout_sec=timeout_sec)


def _json_object(text: str) -> dict:
    """응답에서 첫 JSON 오브젝트만 안전 추출(코드펜스·잡설 허용)."""
    if not text:
        return {}
    s = text.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s).rstrip("`").strip()
    i, j = s.find("{"), s.rfind("}")
    if i == -1 or j == -1 or j < i:
        return {}
    try:
        return json.loads(s[i:j + 1])
    except json.JSONDecodeError:
        return {}


# 번역 지침 — 사전번역(신규)과 정제 패스(scripts/refine_translations.py)가 같은 기준을 쓰도록
# 한 곳에 둔다. 두 잡이 서로 다른 기준으로 돌면 정제가 사전번역을 되돌리는 싸움이 난다.
#
# 왜 이렇게 길어졌나(2026-08-15 사용자 요청): "완전히 원어민이 말했던 그 의도와 뉘앙스로 이해하면서
# 공부하고 싶다". 예전 지침은 "natural, not word-for-word" 한 줄이라 문장 단위로는 자연스러워도
# 화자의 태도(농담·비꼼·머뭇거림·강조)와 담화표지가 통째로 증발했다. 학습자가 원하는 건 '뜻'이
# 아니라 '그 사람이 그 말을 왜 그렇게 했는지'다.
TRANSLATION_RULES = (
    "You are translating an American English podcast transcript for a Korean learner who wants to "
    "understand exactly what the speaker MEANT — the intent and the nuance, not the dictionary words.\n"
    "Rules:\n"
    "1. Translate meaning, never word order. If a literal rendering and a natural Korean sentence "
    "differ, always choose the natural Korean one.\n"
    "2. Idioms, phrasal verbs, slang and set phrases become the Korean expression a native speaker "
    "would actually use in that situation. Never translate their parts separately.\n"
    "3. Preserve the speaker's attitude: humour, sarcasm, exaggeration, hedging, excitement, "
    "hesitation, emphasis. A flat Korean sentence for a joking English one is a wrong translation.\n"
    "4. Discourse markers (well, I mean, you know, like, right?, actually, so) carry conversational "
    "function, not content. Render the function in Korean (그러니까, 사실, 뭐랄까, 그쵸?) or drop them "
    "when Korean would not use one — never translate them literally.\n"
    "5. Keep pronoun references, tense and discourse flow coherent with 'context_before'.\n"
    "6. Keep proper nouns, brand names, show names and people's names in their original form.\n"
    "7. The source is speech-to-text and can be imperfect: split numbers ('episode 26 15' = 2615화), "
    "missing punctuation, mis-heard words. Translate what the speaker clearly meant to say.\n"
    "8. Polite conversational register (~요체). As short as natural Korean allows, but never shorten "
    "at the cost of the meaning.\n"
    "9. No romanization, no bracketed glosses, no explanations, no English left in the output "
    "except proper nouns.\n"
)


def build_prompt(lines: list[str], context_before: str) -> str:
    items = [{"i": str(k), "en": en} for k, en in enumerate(lines)]
    return (
        TRANSLATION_RULES
        + "Use 'context_before' only as context for pronouns/flow — translate ONLY the numbered 'lines'.\n"
        "Return ONLY a JSON object mapping each line id (string) to its Korean translation. "
        "No code fence, no commentary.\n\n"
        f"context_before: {json.dumps(context_before, ensure_ascii=False)}\n"
        f"lines: {json.dumps(items, ensure_ascii=False)}"
    )


# ─────────────────────────── Storage I/O ───────────────────────────
def _out_path(ep_id: int) -> str:
    return f"{ep_id}_ko.json"


def _is_not_found(exc: Exception) -> bool:
    """다운로드 예외가 '객체 없음(정상 신규)'인지 판별 — 일시 네트워크 오류와 구분.
    Supabase/R2(S3) 가 내는 다양한 표현(status 404 / not_found / NoSuchKey)을 보수적으로 매칭."""
    s = f"{getattr(exc, 'status', '')} {getattr(exc, 'message', '')} {exc}".lower()
    return ("not_found" in s or "not found" in s or "404" in s
            or "no such key" in s or "nosuchkey" in s or "object_not_found" in s)


def load_existing(ep_id: int):
    """기존 _ko.json 로드. 반환:
      dict  — 정상(또는 파일 없음=신규 빈 dict / 손상=자가치유 빈 dict)
      None  — 일시 다운로드 오류(404 아님) → 호출부가 '이번 실행 스킵'해 기존본 보존(축소 방지).
    (AUDIT P4/I1: 과거엔 모든 예외를 {} 로 삼켜, 일시 오류 시 전량 재번역→부분실패로 _ko.json 이
     축소될 수 있었다. 404 와 그 외 오류를 분리해 비정상 경로의 데이터 후퇴를 막는다.)"""
    try:
        raw = store.client().storage.from_("transcripts").download(_out_path(ep_id))
    except Exception as e:
        if _is_not_found(e):
            return {}            # 정상 신규(파일 없음)
        log.warning("ep %s _ko.json 다운로드 오류(비-404) → 이번 실행 스킵(축소 방지): %s", ep_id, e)
        return None              # 일시 오류 → 덮어쓰지 않도록 신호
    try:
        return json.loads(raw)
    except Exception:
        log.warning("ep %s _ko.json 손상 → 전량 재번역(자가치유)", ep_id)
        return {}               # 손상 → 온전한 맵으로 덮어씀(기존 자가치유 동작 유지)


def save_existing(ep_id: int, m: dict) -> None:
    payload = json.dumps(m, ensure_ascii=False).encode("utf-8")
    store.client().storage.from_("transcripts").upload(
        path=_out_path(ep_id), file=payload,
        file_options={"content-type": "application/json", "upsert": "true"},
    )


def fetch_transcript(ep_id: int) -> dict | None:
    """앱과 동일하게 Storage 자막을 받는다(키 정합). 실패하면 디스크 폴백."""
    try:
        raw = store.client().storage.from_("transcripts").download(f"{ep_id}.json")
        return json.loads(raw)
    except Exception:
        pass
    from pathlib import Path
    p = store.PROJECT_ROOT / "data" / "transcripts" / f"{ep_id}.json"
    if p.exists():
        return json.loads(Path(p).read_text(encoding="utf-8"))
    return None


def parse_ids(spec: str) -> list[int]:
    """'1,2,3' 또는 '@경로'(줄바꿈·쉼표 구분) → id 리스트. 중복 제거하되 준 순서를 지킨다."""
    if spec.startswith("@"):
        from pathlib import Path
        spec = Path(spec[1:]).read_text(encoding="utf-8")
    out, seen = [], set()
    for tok in re.split(r"[,\s]+", spec.strip()):
        if tok.isdigit() and int(tok) not in seen:
            seen.add(int(tok))
            out.append(int(tok))
    return out


def episode_ids() -> list[int]:
    """transcribed 된 에피소드 id (최근=큰 id 먼저)."""
    sb = store.client()
    rows, off, step = [], 0, 1000
    while True:
        chunk = sb.table("episodes").select("id,transcribed_at").not_.is_(
            "transcribed_at", "null").range(off, off + step - 1).execute().data
        rows += chunk
        if len(chunk) < step:
            break
        off += step
    return sorted((r["id"] for r in rows), reverse=True)


# ─────────────────────────── 한 에피소드 처리 ───────────────────────────
def translate_episode(ep_id: int, *, dry: bool = False) -> tuple[int, int]:
    tr = fetch_transcript(ep_id)
    if not tr:
        log.warning("ep %s 자막 없음 → 건너뜀", ep_id)
        return (0, 0)
    sentences = [s for s in resegment(tr.get("segments", [])) if s.strip()]
    done = {} if dry else load_existing(ep_id)
    if done is None:
        # 일시 다운로드 오류 — 기존 _ko.json 을 덮어쓰지 않도록 이번 실행에선 건너뛴다.
        log.warning("ep %s 기존 번역 로드 실패(일시 오류) → 스킵(기존 _ko.json 보존)", ep_id)
        return (len(sentences), 0)
    # 번역 필요한(키 미보유) 문장 인덱스
    keys = [trkey(s) for s in sentences]
    pending = [k for k in range(len(sentences)) if keys[k] not in done]
    if not pending:
        log.info("ep %s 이미 완료(%d문장)", ep_id, len(sentences))
        return (len(sentences), 0)

    added = 0
    # 배치는 '연속 인덱스' 윈도우로(문맥 보존). pending 만 번역하되 context_before 는 직전 문장에서.
    for bstart in range(0, len(sentences), BATCH):
        idxs = [k for k in range(bstart, min(bstart + BATCH, len(sentences))) if keys[k] not in done]
        if not idxs:
            continue
        ctx = " ".join(sentences[max(0, idxs[0] - CTX_BEFORE):idxs[0]])
        lines = [sentences[k] for k in idxs]
        global _consec_fails
        try:
            res = _call_llm(build_prompt(lines, ctx))
            _consec_fails = 0
        except Exception:
            _consec_fails += 1
            log.exception("ep %s 배치 %d 실패 → 건너뜀 (연속 %d)", ep_id, bstart, _consec_fails)
            if _consec_fails >= MAX_CONSECUTIVE_FAILS:
                raise ClaudeUnavailable(
                    f"LLM 호출이 연속 {_consec_fails}회 실패 — 사용 한도/장애로 보인다. "
                    f"여기서 멈춘다(체크포인트 저장됨, 나중에 같은 명령으로 이어서 진행)."
                ) from None
            continue
        for local_i, k in enumerate(idxs):
            ko = res.get(str(local_i)) if isinstance(res, dict) else None
            if isinstance(ko, str) and ko.strip():
                if dry:
                    print(f"  EN: {sentences[k]}\n  KO: {ko.strip()}\n")
                else:
                    done[keys[k]] = ko.strip()
                added += 1
        if not dry and added:
            save_existing(ep_id, done)   # 배치 체크포인트
        if dry:
            break                        # 표본은 첫 배치만(품질 확인용)
    if not dry:
        log.info("ep %s: +%d (누적 %d/%d 문장)", ep_id, added, len(done), len(sentences))
    return (len(sentences), added)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--only", type=int, default=None, help="한 에피소드 id 만")
    p.add_argument("--limit", type=int, default=None, help="앞 N개 에피소드만")
    p.add_argument("--sample", type=int, default=None, help="해당 id 표본 번역 출력(저장 X)")
    p.add_argument("--model", default="sonnet",
                   help="claude CLI 모델 별칭(sonnet/haiku/opus). 번역은 변환 작업이라 상위 모델이 "
                        "꼭 필요하지 않다 — 기본 sonnet 으로 쿼터를 아낀다. 빈 문자열이면 CLI 기본값.")
    p.add_argument("--shard", type=str, default=None, help="병렬 샤딩 'i/n' (예: 0/4) — ids[i::n] 만 처리")
    p.add_argument("--ids", type=str, default=None,
                   help="처리할 에피소드 id 목록: '1,2,3' 또는 '@파일'(줄바꿈/쉼표 구분). "
                        "쇼별 '최근 N편'처럼 임의의 대상 집합을 돌릴 때 쓴다 — 전체 스캔보다 "
                        "훨씬 싸고, 어디까지 했는지가 목록으로 남는다.")
    args = p.parse_args()
    global _MODEL
    _MODEL = args.model or ""
    log.info("모델: %s", _MODEL or "(CLI 기본)")

    if args.sample:
        translate_episode(args.sample, dry=True)
        return

    if args.only:
        ids = [args.only]
    elif args.ids:
        ids = parse_ids(args.ids)
    else:
        ids = episode_ids()
    if args.shard:                       # 다중 프로세스 병렬: 각 프로세스가 서로 다른 에피소드를 맡음
        i, n = (int(x) for x in args.shard.split("/"))
        ids = ids[i::n]
        log.info("shard %d/%d → 에피소드 %d개", i, n, len(ids))
    if args.limit:
        ids = ids[: args.limit]
    log.info("대상 에피소드 %d개", len(ids))
    tot_sent = tot_added = 0
    done_eps = 0
    for n, ep_id in enumerate(ids, 1):
        try:
            sent, added = translate_episode(ep_id)
        except ClaudeUnavailable as e:
            # 조용히 '완주'하지 않는다 — 남은 회차를 실패로 태우는 대신 여기서 멈추고,
            # 어디까지 했는지와 왜 멈췄는지를 분명히 남긴다.
            log.error("중단: %s", e)
            log.error("진행 상황: 에피소드 %d/%d 처리, 신규번역 %d문장", done_eps, len(ids), tot_added)
            sys.exit(2)
        done_eps += 1
        tot_sent += sent
        tot_added += added
        log.info("[%d/%d] ep %s 진행 — 누적 +%d문장", n, len(ids), ep_id, tot_added)
    log.info("완료: 에피소드 %d, 문장 %d, 신규번역 %d", len(ids), tot_sent, tot_added)


if __name__ == "__main__":
    main()
