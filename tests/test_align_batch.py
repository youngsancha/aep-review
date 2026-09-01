"""배치 정렬 검증(scripts.translate_transcripts.align_batch) 회귀 고정.

왜 이 파일이 존재하는가 (2026-09-01 실측):
  로컬 LLM 백엔드를 열자마자 나온 것은 '틀린 한국어'가 아니라 **밀린 한국어**였다. 32줄을 보내면
  exaone3.5:7.8b 가 29개 키로 답하면서 번호를 0..28 로 다시 매겼다. JSON 은 유효하고, 값은 전부
  자연스러운 한국어이고, 문장 단위 검증(sane_translation)은 전부 통과한다 — 그런데 **모든 문장이
  옆 문장의 번역과 짝지어진다.** `_ko.json` 은 멱등 채움이라 그대로 영구 저장된다.

  개별 문자열을 아무리 검사해도 이 종류는 잡히지 않는다. 구조(개수·앵커)로만 잡을 수 있다.
"""
from __future__ import annotations

from scripts.translate_transcripts import ALIGN_MIN_VERIFIED, align_batch

LINES = [
    "But here's the twist.",
    "Voters don't pick the prime minister directly.",
    "in parliament chooses the prime minister.",
    "So it's more like voting for the whole team.",
]


def _arr(items):
    return {"lines": items}


def test_aligned_array_is_accepted():
    res = _arr([{"src": " ".join(ln.split()[:4]), "ko": f"번역{i}입니다"} for i, ln in enumerate(LINES)])
    kos, why = align_batch(res, LINES)
    assert why == ""
    assert kos == ["번역0입니다", "번역1입니다", "번역2입니다", "번역3입니다"]


def test_shifted_array_is_rejected_whole():
    """한 칸 밀린 응답 — 앵커가 '다른 줄'임을 드러낸다. 배치를 통째로 버려야 한다."""
    res = _arr([{"src": " ".join(LINES[(i + 1) % len(LINES)].split()[:4]), "ko": f"번역{i}"}
                for i in range(len(LINES))])
    kos, why = align_batch(res, LINES)
    assert why.startswith("misaligned"), why
    assert kos == [None] * len(LINES), "정렬이 깨졌으면 일부만 살리면 안 된다 — 어느 게 맞는지 모른다"


def test_short_array_is_rejected():
    """실측된 그 버그: 32줄 요청에 29개 응답. 길이만으로도 잡힌다."""
    res = _arr([{"src": " ".join(ln.split()[:4]), "ko": "번역"} for ln in LINES[:-1]])
    kos, why = align_batch(res, LINES)
    assert why.startswith("array-len"), why
    assert kos == [None] * len(LINES)


def test_korean_anchor_accepted_only_for_single_line_batches():
    """모델이 앵커까지 번역해 버리는 경우 — 실측에서 거절 4건 중 3건이 이랬고 번역은 정확했다.
    전부 막으면 멀쩡한 번역을 대량으로 버리지만(오프라인이 다시 빈다), 전부 받으면 '앵커를 다
    번역한 채 한 칸 밀린 배열'이 무사통과한다. 줄이 하나면 위치가 어긋날 수 없으므로 그때만 받는다."""
    one = ["But here's the twist."]
    kos, why = align_batch(_arr([{"src": "그런데", "ko": "그런데 반전이 있어요."}]), one)
    assert why == "" and kos == ["그런데 반전이 있어요."]

    # 여러 줄 배치에서는 정렬을 증명할 수 없으므로 받아들이지 않는다.
    res = _arr([{"src": "그리고", "ko": f"번역{i}"} for i in range(len(LINES))])
    kos2, why2 = align_batch(res, LINES)
    assert why2.startswith("misaligned"), why2
    assert kos2 == [None] * len(LINES)


def test_legacy_flat_map_requires_exact_count():
    """구형(평면 id→한국어) 응답에는 앵커가 없다 → 개수라도 정확해야 한다."""
    ok = {str(i): f"번역{i}" for i in range(len(LINES))}
    kos, why = align_batch(ok, LINES)
    assert why == "" and kos == [f"번역{i}" for i in range(len(LINES))]

    short = {str(i): f"번역{i}" for i in range(len(LINES) - 1)}
    kos2, why2 = align_batch(short, LINES)
    assert why2.startswith("count-mismatch"), why2
    assert kos2 == [None] * len(LINES)


def test_garbage_shapes_never_raise():
    for res in (None, {}, [], "nope", {"lines": "nope"}, {"lines": [None, None, None, None]}):
        kos, why = align_batch(res, LINES)
        assert len(kos) == len(LINES)
        assert isinstance(why, str)


def test_partial_verification_threshold():
    """일부만 검증돼도 임계치를 넘으면 채택 — 전부 아니면 전무는 진도를 못 낸다."""
    n = 10
    lines = [f"line number {i} of the transcript here" for i in range(n)]
    good = int(ALIGN_MIN_VERIFIED * n) + 1
    items = []
    for i in range(n):
        anchor = " ".join(lines[i].split()[:4]) if i < good else "totally different words here"
        items.append({"src": anchor, "ko": f"번역{i}"})
    kos, why = align_batch(_arr(items), lines)
    assert why == "", why
    assert kos[0] == "번역0"
    assert kos[-1] is None, "검증 실패한 자리는 개별적으로 비워 둔다"
