"""scripts.resegment_llm — LLM 경계 정렬기와 신뢰 모드 회귀 고정.

이 스크립트가 지키는 성질은 하나다: **자막에 들어가는 단어는 언제나 원본이다.** LLM 은 '어디서
끝나는가'만 정하고, 그 답을 원본 단어열에 정렬해서 인덱스로만 가져온다. 정렬이 안 되면 청크를 통째로
규칙 분절로 되돌린다(부분 채택 없음). 아래 테스트는 그 계약의 양쪽을 고정한다:
  ① 구두점·대소문자만 다른 출력은 받아들이고, 단어를 바꾼 출력(패러프레이즈)은 거절한다
  ② 신뢰 모드: `sent: true` segment 는 파이썬·JS 양쪽 resegment 가 규칙 없이 그대로 문장으로 본다
"""
from __future__ import annotations

from scripts.resegment_llm import (
    MAX_SENT_WORDS,
    align,
    balanced_split,
    cap_split,
    presplit_terminal,
    make_chunks,
    rule_sentences,
    to_segment,
)
from scripts.translate_transcripts import resegment, trkey


def _w(text: str, t0: float = 0.0, step: float = 0.3):
    out, t = [], t0
    for tok in text.split():
        out.append({"word": " " + tok, "start": round(t, 2), "end": round(t + step, 2)})
        t += step
    return out


def test_align_accepts_punctuation_and_case_changes():
    words = _w("we went to the store and then we came home it was late")
    ends = align(words, ["We went to the store.", "And then we came home.", "It was late."])
    assert ends == [5, 10, 13]


def test_align_rejects_paraphrase():
    words = _w("we went to the store and then we came home it was late")
    assert align(words, ["We visited the shop.", "Afterwards we returned.", "The hour was late."]) is None


def test_align_tail_always_reaches_chunk_end():
    """모델이 마지막 단어를 빠뜨려도 마지막 문장은 청크 끝까지 — 단어가 사라지면 안 된다."""
    filler = " ".join(f"w{i}" for i in range(30))
    words = _w(f"{filler} and this is the second one okay")
    ends = align(words, [" ".join(f"w{i}" for i in range(30)) + ".", "And this is the second one."])
    assert ends is not None and ends[-1] == len(words)
    # 반면 짧은 청크에서 한 단어 누락은 비율 문턱(0.95)에 걸려 거절된다 — 거절은 규칙 분절로의 복귀다.
    assert align(_w("a b c d e f g h i j k l m"), ["A b c d e f g h i j k l."]) is None


def test_align_merges_empty_or_backward_sentences():
    words = _w("hello there friend how are you")
    ends = align(words, ["Hello there friend.", "", "How are you?"])
    assert ends == [3, 6]


def test_balanced_split_cuts_at_clause_boundary_and_marks_fragments():
    """긴 문장은 절 시작 단어 앞에서 균형 있게 갈리고, 마지막 조각만 '문장 끝'이다."""
    long = _w("we started the program in the spring because the old one had failed and nobody wanted to run it again "
              "so the board asked for a new plan which took most of the summer to write")
    parts = balanced_split(long)
    assert len(parts) >= 2 and sum(len(p) for p in parts) == len(long)
    assert all(len(p) <= MAX_SENT_WORDS for p in parts)
    assert all(p[0]["word"].strip() in {"because", "and", "so", "which"} for p in parts[1:])
    frag = to_segment(0, parts[0], complete=False)
    assert not frag["text"].endswith(".")                    # 조각에 가짜 마침표를 붙이지 않는다
    assert to_segment(1, parts[-1], complete=True)["text"].endswith(".")
    assert to_segment(2, _w("well, you know,"), complete=True)["text"] == "well, you know,"   # ',.' 금지


def test_cap_split_leaves_short_sentences_alone():
    short = _w("a short one")
    assert cap_split(short) == [(short, True)]


def test_to_segment_adds_period_and_preserves_trkey():
    seg = to_segment(0, _w("no punctuation here"))
    assert seg["text"] == "no punctuation here." and seg["sent"] is True
    assert trkey(seg["text"]) == trkey("no punctuation here")
    seg2 = to_segment(1, _w("in the U.S."))
    assert seg2["text"] == "in the U.S."                    # 약어 마침표 뒤에 '.'을 또 붙이지 않는다


def test_make_chunks_prefers_punctuated_boundaries():
    sents = [_w("x " * 50 + "end.") for _ in range(6)]        # 51 words each, all punctuated
    chunks = make_chunks(sents)
    assert all(sum(len(s) for s in c) <= 200 for c in chunks)
    assert sum(len(c) for c in chunks) == 6


def test_rule_sentences_partition_all_words():
    words = _w("Hello there. This is a test of the rule based segmenter, which should keep every single word intact okay")
    parts = rule_sentences(words)
    assert [w["word"] for p in parts for w in p] == [w["word"] for w in words]


def test_trust_mode_skips_rules():
    """`sent: true` 가 전부 달려 있으면 20어절짜리도 자르지 않는다 — 규칙(14어절 상한)이 꺼진다."""
    text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
    seg = to_segment(0, _w(text))
    assert resegment([seg]) == [text + "."]
    # 표식이 하나라도 빠지면 규칙으로 간다(부분 신뢰 없음).
    plain = {k: v for k, v in seg.items() if k != "sent"}
    assert len(resegment([seg, plain])) > 2


def test_presplit_restores_sentences_the_model_merged():
    """모델이 한 항목에 두 문장을 넣으면 종결 구두점+대문자에서 먼저 나눈다. 약어는 예외."""
    merged = _w("Seeing red? That is the beauty of the festival.")
    parts = presplit_terminal(merged)
    assert [" ".join(w["word"].strip() for w in p) for p in parts] == ["Seeing red?", "That is the beauty of the festival."]
    abbr = _w("We met Mr. Smith in the U.S. Army office.")
    assert presplit_terminal(abbr) == [abbr]
    # cap_split 을 거쳐도 둘 다 '문장 끝'이라 마침표가 그대로다.
    assert [c for _, c in cap_split(merged)] == [True, True]


def test_balanced_split_cuts_at_a_long_silence_first():
    """어절은 적지만 안에 긴 침묵이 있는 문장(5어절 15초) — 침묵에서 갈라야 한다(UI 12초 상한)."""
    a = _w("well we did", 0.0)                      # 0.0–0.9
    b = _w("go home", 12.0)                         # 12.0–12.6
    parts = balanced_split(a + b)
    assert [len(p) for p in parts] == [3, 2]
    # 침묵 없이 22어절 이하면 그대로.
    assert balanced_split(_w("a short one")) == [_w("a short one")]
