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
import collections
import json
import logging
import os
import re
import shutil
import subprocess
import sys

from ingest import store
from ingest.extract_vocab import _result_text
from ingest.translation_guard import sane_translation

log = logging.getLogger("translate_transcripts")
# 한 호출에 묶는 문장 수(문맥 유지 + 응답 안정, 호출수 절감).
BATCH = 32
# ⛔ 로컬 모델은 이 크기를 못 버틴다. 실측(exaone3.5:7.8b, cnn10 ep1026, 24문장):
#     batch=1 → 정렬 21/24(4.6s/문장) · batch=2 → 8/24 · batch=4 → 0/24 · batch=6 → 0/24
# 배치가 커지면 입력 '줄'을 따르지 않고 단어열을 제멋대로 2~3어절로 다시 쪼갠다. 그래서 백엔드별로
# 기본값을 다르게 둔다 — 안 그러면 AEP_LLM_BACKEND=ollama 만 켠 사람은 한 문장도 못 얻고
# '정렬 실패' 경고만 잔뜩 보게 된다(조용한 0 진행이야말로 이 리포가 반복해서 당한 사고다).
OLLAMA_BATCH = 1


def batch_size() -> int:
    if os.environ.get("AEP_TRANSLATE_BATCH"):
        return max(1, int(os.environ["AEP_TRANSLATE_BATCH"]))
    backend = (os.environ.get("AEP_LLM_BACKEND") or "").strip().lower()
    return OLLAMA_BATCH if backend == "ollama" else BATCH
MIN_BATCH = 4       # 정렬 실패 시 반씩 줄이는 하한 — 이 아래면 '문맥째 번역'이 아니게 된다
CHECKPOINT_EVERY = 16   # 이 문장 수마다 _ko.json 업로드(배치=1 에서 매번 올리는 낭비 방지)
CTX_BEFORE = 2      # 배치 앞에 붙여 줄 '맥락용' 직전 문장 수(번역 대상 아님)

# 배치 실패는 '건너뛰고 계속'이 기본이다 — 일시적 오류엔 맞다. 하지만 claude 사용 한도에
# 걸리면 이후 모든 호출이 즉시 실패하므로, 그대로 두면 남은 전 회차를 초고속으로 '시도만'
# 하고 완주해 버린다. 실제로 2026-07-27 그렇게 됐다: 10:46 에 한도에 걸린 뒤 40분 동안
# 5,368건을 실패시키며 목록을 소진하고 exit 0 으로 끝나 '완료'처럼 보였다.
# 재시도는 '다시 하면 나아지는 실패'에만 의미가 있다. 한도는 아니다 → 연속 실패가 임계치를
# 넘으면 멈춘다(멱등·체크포인트라 나중에 이어서 하면 된다).
MAX_CONSECUTIVE_FAILS = 12
_consec_fails = 0
# 거절 사유별 누계 — 실행 끝에 출력한다. 개수만 남기면 '어느 모델이 어떤 식으로 망가지는가'를
# 알 수 없고, 그게 백엔드 교체 판단의 유일한 근거다.
_rejected: "collections.Counter[str]" = collections.Counter()
_accepted = 0
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
    # ⓪ 신뢰 모드 — scripts.resegment_llm 이 저장한 transcript(segment 마다 `sent: True`)는 이미
    # 문장 단위다. 규칙(14어절·9초 상한)을 다시 적용하면 LLM 이 살린 문장을 도로 자른다. episode.js
    # resegment 의 같은 블록과 1:1 — tests/test_resegment_parity.py 의 픽스처 10554 가 고정한다.
    segs_in = segments or []
    if segs_in and all(isinstance(s, dict) and s.get("sent") is True for s in segs_in):
        out_t = []
        for seg in segs_in:
            # 저장된 text 그대로 — 스크립트가 문장 끝에만 마침표를 붙였다(절 조각엔 없음). episode.js 와 동일.
            ws = [w for w in (seg.get("words") or []) if w.get("word") is not None]
            text = (seg.get("text") or ("".join(w["word"] for w in ws) if ws else "")).strip()
            out_t.append(text)
        return out_t
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


def _call_llm(prompt: str, timeout_sec: int = 300, n_lines: int = 0) -> dict:
    """백엔드 중립 진입점 — ingest.extract_vocab.call_llm 과 같은 규약(AEP_LLM_BACKEND).

      (미설정)/"claude-cli" → `claude -p` (기존 동작 그대로, Max 구독이라 과금 0)
      "gemini"             → HTTP. claude CLI 가 못 뜨는 cron/CI 에서 번역을 살린다.
      "ollama"             → 로컬 LLM. 과금 0 · Claude 한도 0 — 8만 문장 백필의 유일한 현실적 경로.
      "auto"               → CLI 가 PATH 에 있으면 그것, 없으면 Gemini.

    기본값이 claude-cli 라 env 를 안 건드리면 이전과 완전히 동일하게 동작한다.
    """
    choice = (os.environ.get("AEP_LLM_BACKEND") or "claude-cli").strip().lower()
    if choice == "auto":
        choice = "claude-cli" if shutil.which("claude") else "gemini"
    if choice == "ollama":
        from ingest.ollama_client import call_ollama

        return _json_object(call_ollama(prompt, timeout_sec=timeout_sec, max_output_tokens=16384,
                                        schema=batch_schema(n_lines) if n_lines else None))
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
    """배치 프롬프트. 응답은 id → {en, ko} 다 — 모델에게 원문을 '되읊게' 해서 정렬을 증명시킨다.

    ⛔ 왜 en 을 되받는가 (2026-09-01 실측): id → 한국어 평면 맵을 요구했더니 로컬 모델이 32줄을
    받아 **29개 키로 답하면서 번호를 0..28 로 다시 매겼다.** JSON 은 유효하고 값은 전부 자연스러운
    한국어인데 **모든 문장이 옆 문장의 번역과 짝지어진다.** _ko.json 은 멱등 채움이라 한 번 저장되면
    영구적이므로, 이건 '번역 없음'보다 훨씬 나쁘다. 개별 문자열 검증(sane_translation)으로는 절대
    잡을 수 없는 종류라 — 각각은 멀쩡하다 — 구조로 막아야 한다.
    """
    items = [{"i": str(k), "en": en} for k, en in enumerate(lines)]
    return (
        TRANSLATION_RULES
        + "Use 'context_before' only as context for pronouns/flow — translate ONLY the numbered 'lines'.\n"
        'Return ONLY {"lines": [ ... ]} — a JSON array with EXACTLY one element per input line, '
        'in the SAME ORDER as the input. Element k is {"src": <the first four words of input line k, '
        'in ENGLISH, copied exactly as given — this is an alignment anchor, NEVER translate it>, '
        '"ko": <Korean translation of the WHOLE line k>}.\n'
        "Never merge two input lines into one element, never skip a line, never reorder: if a line is "
        "an incomplete fragment, translate the fragment on its own. The array length MUST equal the "
        "number of input lines. No code fence, no commentary.\n\n"
        f"context_before: {json.dumps(context_before, ensure_ascii=False)}\n"
        f"lines: {json.dumps(items, ensure_ascii=False)}"
    )


_WORD_RE = re.compile(r"[a-z0-9']+")
_HANGUL_RE = re.compile(r"[가-힣]")


def _prefix_overlap(echo: str, line: str, n: int = 4) -> float:
    """되읊은 앵커가 그 줄의 것인가 — 앞 n어절 토큰 집합의 겹침(0~1).

    ⛔ 전문(全文)을 되읊게 하면 출력 토큰이 2배가 되어 로컬 7B 에서 배치 하나가 분 단위로 늘어난다
    (실측: 전문 되읊기로 --sample 이 10분 타임아웃). 정렬이 깨질 때 어긋나는 것은 '줄의 시작'이므로
    앞 4어절만으로도 판별력은 사실상 같다. 모델이 전문을 되읊어도 앞부분만 비교하므로 안전하다.
    """
    ea = _WORD_RE.findall(echo.lower())[:n]
    la = _WORD_RE.findall(line.lower())[:n]
    if not ea or not la:
        return 1.0 if ea == la else 0.0
    m = min(len(ea), len(la))
    sa, sb = set(ea[:m]), set(la[:m])
    return len(sa & sb) / max(len(sa), len(sb))


ECHO_MIN_OVERLAP = 0.7      # 되읊은 앵커가 이만큼은 겹쳐야 '같은 줄'로 인정
ALIGN_MIN_VERIFIED = 0.8    # 배치의 이 비율 이상이 정렬 확인돼야 배치를 채택


def batch_schema(n: int) -> dict:
    """응답 문법(JSON Schema). 작은 모델은 '말로 한 지시'를 형태로 옮기지 못한다 — 배열 길이까지
    스키마로 못 박아야 병합·건너뛰기가 애초에 생성 불가능해진다."""
    return {
        "type": "object",
        "properties": {
            "lines": {
                "type": "array",
                "minItems": n,
                "maxItems": n,
                "items": {
                    "type": "object",
                    "properties": {"a": {"type": "string"}, "ko": {"type": "string"}},
                    "required": ["a", "ko"],
                },
            }
        },
        "required": ["lines"],
    }


def align_batch(res, lines: list[str]) -> tuple[list[str | None], str]:
    """모델 응답 → lines 와 1:1 정렬된 번역 리스트. 정렬을 증명 못 하면 배치를 통째로 버린다.

    반환 (kos, reason). reason 이 비어 있지 않으면 배치 거절.
    세 응답 형태를 모두 받는다:
      · {"lines": [{"a": <앞 4어절>, "ko": ...}]}  — 순서로 정렬 + 앵커로 검증(권장·현재 프롬프트)
      · {"0": {"a": <앞 4어절>, "ko": ...}}  — 앵커로 줄마다 정렬 검증(권장·현재 프롬프트)
      · {"0": "한국어"}                 — 구형 평면 맵. 증명 수단이 없으므로 **개수 일치**를 요구한다
                                         (실측된 그 버그가 29 vs 32 였으므로 이것만으로도 잡힌다).
    """
    if not isinstance(res, dict) or not res:
        return [None] * len(lines), "not-a-dict"
    arr = res.get("lines")
    if isinstance(arr, list):
        if len(arr) != len(lines):
            return [None] * len(lines), f"array-len({len(arr)} vs {len(lines)})"
        kos_a: list[str | None] = [None] * len(lines)
        ok_n = 0
        unverified = 0
        for i, item in enumerate(arr):
            if not isinstance(item, dict):
                continue
            ko = item.get("ko")
            if not isinstance(ko, str) or not ko.strip():
                continue
            anchor = item.get("src") or item.get("a") or item.get("en") or ""
            if _HANGUL_RE.search(anchor):
                # 모델이 앵커까지 한국어로 번역해 버린 경우. 실측(exaone3.5, batch=1): 거절 4건 중
                # 3건이 이랬고 **번역 자체는 정확했다** — 오정렬로 취급하면 멀쩡한 번역을 30% 버린다.
                # ⛔ 그렇다고 그냥 통과시키면 '앵커를 전부 번역한 채 한 칸 밀린 배열'이 무사통과한다
                # (xcheck 2026-09-01 지적, 검증함: 밀린 배열에서는 kos[i]=tr(i-1) 이고 _prev_ko=tr(i-2)
                # 라 dup-prev 도 못 잡는다). 그래서 **줄이 하나뿐일 때만** 검증 불가를 받아들인다 —
                # 입력 1줄·출력 1개는 위치가 어긋날 수 없고, 남는 위험('문맥 문장을 대신 번역')은
                # 그때 정확히 _prev_ko 와 같아지므로 dup-prev 가 잡는다.
                if len(lines) != 1:
                    continue
                kos_a[i] = ko.strip()
                unverified += 1
                continue
            if _prefix_overlap(anchor, lines[i]) < ECHO_MIN_OVERLAP:
                continue
            kos_a[i] = ko.strip()
            ok_n += 1
        # 명시적으로 '다른 줄'이라고 드러난 것만 오정렬로 본다(검증 불가는 통과시키되 아래에서 거른다).
        if ok_n + unverified < ALIGN_MIN_VERIFIED * len(lines):
            return [None] * len(lines), f"misaligned({ok_n}+{unverified}/{len(lines)})"
        return kos_a, ""
    kos: list[str | None] = [None] * len(lines)
    verified = 0
    echoed = 0
    for i in range(len(lines)):
        item = res.get(str(i))
        if isinstance(item, dict):
            echoed += 1
            ko = item.get("ko")
            en = item.get("a") or item.get("en") or ""    # 'a'=앵커(현재) / 'en'=전문(구형 응답 허용)
            if not isinstance(ko, str) or not ko.strip():
                continue
            if _prefix_overlap(en, lines[i]) < ECHO_MIN_OVERLAP:
                continue          # 되읊은 원문이 다르다 = 이 자리는 다른 줄의 번역이다
            kos[i] = ko.strip()
            verified += 1
        elif isinstance(item, str) and item.strip():
            kos[i] = item.strip()
    if echoed >= max(1, len(lines) // 2):
        # 되읊기 형태로 답했다 → 정렬을 실제로 검증할 수 있다. 검증 통과 비율로 채택 여부 결정.
        if verified < ALIGN_MIN_VERIFIED * len(lines):
            return [None] * len(lines), f"misaligned({verified}/{len(lines)} verified)"
        return kos, ""
    # 구형 평면 맵 — 증명이 없으니 개수라도 정확히 맞아야 한다.
    got = sum(1 for k in kos if k)
    if got != len(lines):
        return [None] * len(lines), f"count-mismatch({got} vs {len(lines)})"
    return kos, ""


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
def _call_batch(lines: list[str], ctx: str, ep_id: int, bstart: int) -> tuple[list[str | None], bool]:
    """한 배치를 LLM 에 보내고 정렬까지 확인. 반환 (번역들, 호출 자체가 실패했는가).

    ⛔ 두 실패를 반드시 구분한다. '호출 실패'(한도·장애)는 쪼개서 다시 해도 나아지지 않고 오히려
    한도만 더 태운다 — 이 잡이 2026-07-27 에 40분간 5,368건을 실패시킨 사고가 바로 그 모양이었다.
    쪼개기가 도움이 되는 것은 '정렬 실패'(모델이 줄 수를 못 버팀)뿐이다.
    """
    global _consec_fails
    try:
        res = _call_llm(build_prompt(lines, ctx), n_lines=len(lines))
        _consec_fails = 0
    except Exception:
        _consec_fails += 1
        log.exception("ep %s 배치 %d 호출 실패 (연속 %d)", ep_id, bstart, _consec_fails)
        if _consec_fails >= MAX_CONSECUTIVE_FAILS:
            raise ClaudeUnavailable(
                f"LLM 호출이 연속 {_consec_fails}회 실패 — 사용 한도/장애로 보인다. "
                f"여기서 멈춘다(체크포인트 저장됨, 나중에 같은 명령으로 이어서 진행)."
            ) from None
        return [None] * len(lines), True
    kos, why = align_batch(res, lines)
    if why:
        _rejected["align:" + why.split("(")[0]] += len(lines)
        log.warning("ep %s 배치 %d 정렬 실패(%s) — 배치 폐기", ep_id, bstart, why)
    return kos, False


def _translate_lines(lines: list[str], ctx: str, ep_id: int, bstart: int) -> list[str | None]:
    """배치를 번역하되, 정렬에 실패하면 반으로 쪼개 다시 시도한다.

    왜 쪼개는가: 작은 모델은 줄이 많을수록 병합·건너뛰기로 번호가 어긋난다(실측: 32줄 → 29키).
    배치를 통째로 버리기만 하면 그 모델로는 cnn10 이 영원히 번역되지 않는다. 절반으로 줄이면
    대개 정렬이 살아나므로, 문맥을 조금 잃더라도 진도가 나가는 쪽을 택한다. MIN_BATCH 아래로는
    쪼개지 않는다 — 한 줄씩 번역하면 문맥 인지라는 이 잡의 존재 이유가 사라진다.
    """
    kos, call_failed = _call_batch(lines, ctx, ep_id, bstart)
    # 호출이 죽은 것이면 쪼개 봐야 같은 이유로 또 죽는다(한도는 배치 크기와 무관하다).
    if call_failed or any(k for k in kos) or len(lines) <= MIN_BATCH:
        return kos
    half = len(lines) // 2
    log.info("ep %s 배치 %d → %d줄로 쪼개 재시도", ep_id, bstart, half)
    left = _translate_lines(lines[:half], ctx, ep_id, bstart)
    right = _translate_lines(lines[half:], " ".join(lines[max(0, half - CTX_BEFORE):half]), ep_id, bstart + half)
    return left + right



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
    saved_at = 0    # 마지막 체크포인트 시점의 added
    _prev_ko = ""   # 직전에 채택한 번역 — '한 칸 밀림' 검출용
    # 배치는 '연속 인덱스' 윈도우로(문맥 보존). pending 만 번역하되 context_before 는 직전 문장에서.
    bsz = batch_size()
    for bstart in range(0, len(sentences), bsz):
        idxs = [k for k in range(bstart, min(bstart + bsz, len(sentences))) if keys[k] not in done]
        if not idxs:
            continue
        ctx = " ".join(sentences[max(0, idxs[0] - CTX_BEFORE):idxs[0]])
        lines = [sentences[k] for k in idxs]
        try:
            kos = _translate_lines(lines, ctx, ep_id, bstart)
        except ClaudeUnavailable:
            raise
        except Exception:
            log.exception("ep %s 배치 %d 실패 → 건너뜀", ep_id, bstart)
            continue
        global _accepted
        for local_i, k in enumerate(idxs):
            ko = kos[local_i]
            if isinstance(ko, str) and ko.strip():
                # ⛔ 예전엔 '비어 있지 않으면' 그대로 저장했다. _ko.json 은 멱등 채움이라 한 번 들어간
                # 키는 다시 번역되지 않으므로, 쓰레기가 들어가면 그 문장은 영구히 쓰레기다. 로컬 LLM
                # 백엔드는 실패를 에러가 아니라 '자신 있게 틀린 한국어'로 돌려주므로 관문이 필요하다.
                # 거른 문장은 저장되지 않을 뿐이라 다음 실행에서 다시 시도된다(손실 없음).
                ok, why = sane_translation(sentences[k], ko)
                # dup-prev 는 **앵커를 검증하지 못하는 batch=1 모드에서만** 건다. 앵커로 정렬이
                # 확인된 배치에서 앞 문장과 같은 한국어가 나오는 것은 정상이다("Wait." "Wait." →
                # 둘 다 '잠깐.'), 거기까지 막으면 멀쩡한 번역을 영구히 잃는다(xcheck 지적 ①③).
                if bsz == 1 and ok and _prev_ko and ko.strip() == _prev_ko:
                    # batch=1 에서 남는 단 하나의 오정렬 형태 — 모델이 대상 줄 대신 문맥의 마지막
                    # 줄을 번역해 내놓는 것(실측: 'in parliament chooses…' 자리에 앞 문장의 번역).
                    ok, why = False, "dup-prev"
                if not ok:
                    _rejected[why] += 1
                    log.warning("ep %s 문장 %d 거절(%s): %.80s", ep_id, k, why, ko.strip())
                    continue
                if dry:
                    print(f"  EN: {sentences[k]}\n  KO: {ko.strip()}\n")
                else:
                    done[keys[k]] = ko.strip()
                added += 1
                _accepted += 1
                _prev_ko = ko.strip()
        # 체크포인트는 '누적 N문장마다'다. 배치=1(로컬 모델)에서 매 배치 저장하면 회차당 수백 번
        # _ko.json 전체를 다시 올리게 된다 — 200문장 회차면 30KB × 200 ≈ 6MB 의 헛된 업로드.
        # 끊겨도 최대 CHECKPOINT_EVERY 문장만 다시 하면 되므로 멱등성은 그대로다.
        if not dry and added - saved_at >= CHECKPOINT_EVERY:
            save_existing(ep_id, done)
            saved_at = added
        if dry:
            break                        # 표본은 첫 배치만(품질 확인용)
    if not dry and added > saved_at:
        save_existing(ep_id, done)       # 마지막 잔여분 — 이게 없으면 끝자락이 통째로 날아간다
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
    _log_rejections()


def _log_rejections() -> None:
    """거절 요약 — 사유별로 남긴다. 이 줄이 없으면 로컬 LLM 이 조용히 절반을 흘려도 '완료'로 보인다.
    거절률이 5%를 넘으면 백엔드/모델이 이 작업에 안 맞는다는 신호이므로 눈에 띄게 경고한다."""
    total = sum(_rejected.values())
    if not total:
        return
    detail = ", ".join(f"{why}={n}" for why, n in _rejected.most_common())
    log.warning("저장 거절 %d문장 — %s", total, detail)
    if total >= 20 and total > 0.05 * max(total + _accepted, 1):
        log.warning("⚠ 거절률이 5%%를 넘는다 — 모델이 이 작업에 안 맞을 수 있다. "
                    "scripts/bench_translation.py 로 실측하고 AEP_OLLAMA_MODEL 을 바꿔 볼 것.")


if __name__ == "__main__":
    main()
