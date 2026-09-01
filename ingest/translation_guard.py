"""번역 결과의 '명백히 틀린 것'만 걸러내는 검증 — 저장 직전의 마지막 관문.

왜 필요한가 (2026-09-01):
  `translate_transcripts` 의 저장 조건은 지금까지 `isinstance(ko, str) and ko.strip()` 하나였다.
  즉 **비어 있지만 않으면 무엇이든** `_ko.json` 에 들어간다. 강한 모델에서는 대체로 괜찮았지만,
  로컬 LLM(ollama) 백엔드를 열면서 그 전제가 깨진다: 작은 모델은 실패를 에러로 알리지 않고
  **자신 있게 틀린 문자열을 HTTP 200 으로** 돌려준다. 실측(qwen2.5:7b, 12문장):
  영어를 그대로 되뱉거나, 같은 어절을 수십 번 반복하거나, 원문과 무관한 문장을 만든다.

  그리고 이 파일의 결과물은 **되돌리기 어렵다** — `_ko.json` 은 멱등 채움이라 한 번 들어간 키는
  다시 번역되지 않는다. 쓰레기가 들어가면 그 문장은 영구히 쓰레기다. 그래서 '의심스러우면
  쓰지 않는다'(거른 문장은 다음 실행에서 다시 시도된다).

⛔ 이건 품질 채점기가 아니라 **명백한 고장 탐지기**다. 어색한 번역은 통과시킨다 — 통과 못 시키면
   보수적으로 굴다가 멀쩡한 문장까지 버리게 되고, 그러면 오프라인에서 다시 아무것도 안 보인다.
   '번역 없음'보다 나쁜 것만 막는 것이 목표다.
"""
from __future__ import annotations

import re
import unicodedata

# 한글 음절 + 자모. 한 글자도 없으면 번역이 아니다(영어 되뱉기·빈 껍데기).
_HANGUL = re.compile(r"[가-힣ᄀ-ᇿ㄰-㆏]")
# 라틴 문자 덩어리 — 고유명사는 남기라고 지침이 시키므로 '있다'가 아니라 '얼마나'를 본다.
_LATIN_RUN = re.compile(r"[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*)*")

# 길이비 상한: 한국어는 영어보다 대체로 짧거나 비슷하다. 넘으면 폭주(반복 루프)다.
# ⛔ 짧은 원문에는 적용하지 않는다 — 실측에서 "get by."(7자)에 붙은 정상 번역(26자)이 3.3배로
# 걸렸다. 조각 문장은 문맥에서 온전한 한국어 문장을 받는 게 정상이고, 그건 폭주가 아니다.
MAX_LEN_RATIO = 3.0
RATIO_MIN_EN_CHARS = 25
# 하한은 아주 느슨하게. 영어 한 문장이 한국어 한 단어로 줄어드는 정당한 경우가 있다("Right?" → "그렇죠?").
MIN_LEN_RATIO = 0.08
# 원문을 그대로 흘려보낸 판정: 영어 원문의 연속 N어절이 출력에 그대로 있으면 미번역 통과다.
PASSTHROUGH_WORDS = 6
# ⛔ 단, 영어가 '남아 있다'는 것만으로는 미번역이 아니다 — 이 앱에서는 영어 표현을 따옴표로 인용하고
# 한국어로 설명하는 것이 오히려 좋은 번역이다(실측: `진퇴양난이라는 뜻의 'between a rock and a hard
# place'도요.` 가 거절됐다). 그래서 그 영어 덩어리가 출력의 '대부분'일 때만 미번역으로 본다.
PASSTHROUGH_DOMINANCE = 0.6
# 같은 조각이 이만큼 반복되면 디코딩 루프. 어절 하나가 연달아 반복되는 것보다 '구'가 반복되는 쪽이
# 훨씬 흔하다(실측: "그래서 그러니까"×4). 구 반복은 3회만 넘어도 정상 한국어에 없다.
MAX_REPEAT = 4
PHRASE_REPEAT = 3
MAX_PHRASE_WORDS = 6


def _norm(s: str) -> str:
    return unicodedata.normalize("NFKC", (s or "")).strip()


def _words(s: str) -> list[str]:
    return [w for w in re.split(r"\s+", _norm(s).lower()) if w]


def hangul_ratio(ko: str) -> float:
    """한글 글자 / 공백·문장부호를 뺀 전체 글자. 고유명사만 남았는지 판단하는 데 쓴다."""
    letters = [c for c in _norm(ko) if c.isalnum()]
    if not letters:
        return 0.0
    return sum(1 for c in letters if _HANGUL.match(c)) / len(letters)


def has_repeat_loop(ko: str, max_repeat: int = MAX_REPEAT) -> bool:
    """같은 어절이 연달아 max_repeat 번 넘게 나오는가 — 작은 모델의 전형적 폭주."""
    w = _words(ko)
    run = 1
    for i in range(1, len(w)):
        run = run + 1 if w[i] == w[i - 1] else 1
        if run > max_repeat:
            return True
    # 어절이 아니라 '구'가 반복되는 경우: "그래서 그래서" 가 아니라 "A B A B A B".
    # 길이 6어절까지 본다 — 5어절 구가 열두 번 반복되는 폭주를 2~3어절만 보면 놓친다(실측).
    for size in range(2, MAX_PHRASE_WORDS + 1):
        span = size * (PHRASE_REPEAT + 1)
        if len(w) < span:
            continue
        for i in range(len(w) - span + 1):
            chunk = w[i:i + size]
            if all(w[i + size * k:i + size * (k + 1)] == chunk for k in range(1, PHRASE_REPEAT + 1)):
                return True
    return False


def is_passthrough(en: str, ko: str, n: int = PASSTHROUGH_WORDS,
                   dominance: float = PASSTHROUGH_DOMINANCE) -> bool:
    """번역하지 않고 원문을 흘려보냈는가.

    '영어가 남아 있다'가 아니라 **'남은 영어가 출력의 대부분이다'** 로 판정한다. 학습용 번역에서
    영어 표현을 따옴표로 인용하는 것은 정상이고 오히려 바람직하기 때문이다(모듈 상단 주석 참고).
    """
    e = _words(en)
    if not e:
        return False
    if len(e) < n:
        # 짧은 문장은 통째로 같은지만 본다(고유명사 한 단어짜리 오탐 방지).
        return _words(ko) == e
    k = " ".join(_words(ko))
    if not k:
        return False
    longest = 0
    for i in range(len(e) - n + 1):
        for j in range(i + n, len(e) + 1):
            run = " ".join(e[i:j])
            if run in k:
                longest = max(longest, len(run))
            else:
                break
    return longest / len(k) >= dominance


def sane_translation(en: str, ko: str) -> tuple[bool, str]:
    """저장해도 되는가. 반환 (ok, reason) — reason 은 거절 사유(통과면 '').

    거절 사유는 문자열로 돌려준다. 집계하면 '어느 모델이 어떤 식으로 망가지는가'가 바로 보이고,
    그게 모델 교체 판단의 유일한 근거다(로그에 이유 없이 개수만 남기면 아무것도 못 고친다).
    """
    ko_n = _norm(ko)
    en_n = _norm(en)
    if not ko_n:
        return False, "empty"
    if not en_n:
        return False, "no-source"
    if not _HANGUL.search(ko_n):
        return False, "no-hangul"
    if ko_n.lower() == en_n.lower():
        return False, "echo"
    if is_passthrough(en_n, ko_n):
        return False, "passthrough"
    if has_repeat_loop(ko_n):
        return False, "repeat-loop"
    if len(en_n) >= RATIO_MIN_EN_CHARS:
        ratio = len(ko_n) / len(en_n)
        if ratio > MAX_LEN_RATIO:
            return False, f"too-long({ratio:.1f}x)"
        if ratio < MIN_LEN_RATIO:
            return False, f"too-short({ratio:.2f}x)"
    # ⛔ '라틴 문자 비중이 높다'는 거절 사유가 아니다. 실측에서 그 규칙이 잡은 3건은 전부 정상이었다
    # (영화 제목 《The Game of Their Lives》, URL `s-h-o-p-i-f-y.com/aee입니다`, 그리고 배우려는
    # 영어 표현을 인용한 문장). 진짜 고장인 '한글이 하나도 없음'은 위 no-hangul 이 이미 잡는다.
    return True, ""


__all__ = ["sane_translation", "hangul_ratio", "has_repeat_loop", "is_passthrough",
           "MAX_LEN_RATIO", "MIN_LEN_RATIO", "PASSTHROUGH_WORDS", "PASSTHROUGH_DOMINANCE",
           "RATIO_MIN_EN_CHARS", "MAX_REPEAT", "PHRASE_REPEAT", "MAX_PHRASE_WORDS"]
