"""번역 저장 관문(ingest.translation_guard) 회귀 고정.

이 검증이 없던 동안 저장 조건은 `비어 있지 않은 문자열` 하나뿐이었다. `_ko.json` 은 멱등 채움이라
한 번 저장된 키는 다시 번역되지 않으므로, 쓰레기가 들어가면 그 문장은 영구히 쓰레기다.

⛔ 이 테스트가 지키는 것은 두 방향이다:
  ① 명백한 고장(영어 되뱉기·반복 폭주·미번역 통과)은 반드시 막는다
  ② 멀쩡한 실제 번역은 절대 막지 않는다 — 실측 3,051문장에서 오탐 0 이었고, 그 성질을 고정한다.
     (초안은 '라틴 문자 비중' 규칙으로 영화 제목·URL·학습용 인용문 3건을 잘못 잘랐다. 규칙을
      삭제한 이유가 여기 남아 있어야 누가 다시 넣지 않는다.)
"""
from __future__ import annotations

import pytest

from ingest.translation_guard import (
    has_repeat_loop,
    is_passthrough,
    sane_translation,
)

# 실제 프로덕션 _ko.json 에서 가져온, 반드시 통과해야 하는 번역들.
GOOD = [
    ("My name is Shauna and this is the American English Podcast.",
     "제 이름은 Shauna이고, 여기는 American English Podcast예요."),
    ("Right? When I say I'm having a crummy day,",
     "그렇죠? 제가 'crummy한 하루를 보내고 있다'고 하면,"),
    # 학습용 인용 — 영어 표현을 그대로 두고 한국어로 설명하는 것이 이 앱에서는 '좋은' 번역이다.
    ("between a rock and a hard place.",
     "진퇴양난이라는 뜻의 'between a rock and a hard place'도요."),
    # 라틴 문자가 대부분이어도 정상: 영화 제목과 URL.
    ("So the game of their lives or the miracle match.",
     "바로 《The Game of Their Lives》나 《The Miracle Match》예요."),
    ("That's s-h-o-p-i-f-y.com slash a-e-e.", "s-h-o-p-i-f-y.com/aee입니다."),
    # 짧은 원문이 문맥에서 온전한 문장을 받는 것은 폭주가 아니다.
    ("get by.", "댄스 레슨 같은 게 필요 없었다는 거예요."),
    ("Right?", "그렇죠?"),
    ("Rise up.", "일어나세요!"),
]

BAD = [
    # 영어를 그대로 되뱉음 — 프로덕션 _ko.json 에 실제로 19건 들어 있던 형태.
    ("That's. That's a.", "That's. That's a.", "no-hangul"),
    ("Hello there friend.", "Hello there friend.", "no-hangul"),
    ("", "안녕하세요", "no-source"),
    ("Something.", "", "empty"),
    # 작은 모델의 전형적 디코딩 폭주.
    ("The prime minister runs the country day to day.",
     "총리는 총리는 총리는 총리는 총리는 총리는", "repeat-loop"),
    ("We should talk about this later today okay.",
     "그래서 그러니까 그래서 그러니까 그래서 그러니까 그래서 그러니까", "repeat-loop"),
]


@pytest.mark.parametrize("en,ko", GOOD)
def test_real_translations_pass(en, ko):
    ok, why = sane_translation(en, ko)
    assert ok, f"멀쩡한 번역을 막았다({why}): {ko}"


@pytest.mark.parametrize("en,ko,expected", BAD)
def test_broken_translations_rejected(en, ko, expected):
    ok, why = sane_translation(en, ko)
    assert not ok, f"고장난 번역을 통과시켰다: {ko}"
    assert why.startswith(expected.split("(")[0]), f"사유가 {expected} 가 아니라 {why}"


def test_passthrough_needs_dominance():
    """영어가 '남아 있다'가 아니라 '남은 영어가 대부분이다' 일 때만 미번역이다."""
    en = "we are diving into the difference between the British government today"
    assert is_passthrough(en, en)                       # 통째로 흘려보냄
    # 같은 영어가 인용으로 들어가 있지만 한국어 설명이 붙어 있으면 정상.
    assert not is_passthrough(
        en,
        "오늘은 '" + en + "' 즉 영국 정부의 차이를 살펴보는 시간이에요. 아주 흥미로운 주제죠. "
        "왕실과 정부가 어떻게 다른지 하나씩 짚어 볼게요.",
    )


def test_repeat_loop_catches_phrase_repetition():
    assert has_repeat_loop("네 그렇죠 네 그렇죠 네 그렇죠 네 그렇죠 네 그렇죠")
    assert not has_repeat_loop("네 그렇죠 그런데 오늘은 조금 다른 이야기를 해볼게요")
    assert not has_repeat_loop("")


def test_length_ratio_only_applies_to_long_sources():
    """짧은 조각에는 길이비를 적용하지 않는다 — 'get by.'(7자)의 정상 번역이 3.3배였다."""
    ok, _ = sane_translation("get by.", "댄스 레슨 같은 게 필요 없었다는 거예요.")
    assert ok
    # 충분히 긴 원문에서 4배를 넘으면 폭주로 본다.
    long_en = "The prime minister is the head of government and runs the country."
    ok2, why2 = sane_translation(long_en, "총리에 대해 아주 길게 설명하자면 " * 12)
    assert not ok2 and ("too-long" in why2 or "repeat-loop" in why2)


def test_never_raises_on_odd_input():
    for en, ko in [(None, None), ("", ""), ("a", "가"), ("  ", "  ")]:
        ok, why = sane_translation(en, ko)
        assert isinstance(ok, bool) and isinstance(why, str)
