"""사전번역 잡의 연속-실패 차단기 회귀 테스트.

배경(2026-07-27 실측): 배치 실패를 무조건 '건너뛰고 계속' 하다가, claude 사용 한도에
걸린 10:46 이후 40분 동안 5,368건을 실패시키며 남은 전 회차를 소진하고 exit 0 으로
끝났다 — 로그만 보면 '완료'다. 재시도는 '다시 하면 나아지는 실패'에만 의미가 있고
한도는 거기 해당하지 않는다. 그래서 연속 실패가 임계치를 넘으면 멈춘다.

여기서 고정하는 계약:
  ① 드문드문 나는 실패는 계속 진행한다(일시적 오류를 한도로 오인하지 않는다).
  ② 성공 한 번이면 연속 카운터가 리셋된다.
  ③ 연속 MAX_CONSECUTIVE_FAILS 회면 ClaudeUnavailable 로 멈춘다.
  ④ 멈추기 전까지의 번역은 체크포인트로 저장돼 있다(멱등 재개).
"""
from __future__ import annotations

import pytest

from scripts import translate_transcripts as tt


@pytest.fixture(autouse=True)
def _reset_counter():
    tt._consec_fails = 0
    yield
    tt._consec_fails = 0


def _run(fail_plan, monkeypatch, n_batches=20):
    """fail_plan(i) -> True 면 i번째 claude 호출이 실패.

    반환: (실제 claude 호출수, 예외, 체크포인트 크기들, 전체 배치수).
    배치수는 resegment 를 실제로 태워 역산한다 — resegment 가 세그먼트를 표시 문장으로
    다시 묶으므로(관측: 2 세그먼트 → 1 문장) 세그먼트 수로 배치 수를 가정하면 어긋난다.
    """
    calls = {"n": 0}
    saved: list[int] = []
    n_sentences = tt.BATCH * n_batches

    def fake_claude(prompt, timeout_sec=300):
        i = calls["n"]
        calls["n"] += 1
        if fail_plan(i):
            raise RuntimeError("claude CLI rc=1: ")
        # 응답은 실제 형태(lines 배열 + 정렬 앵커)로 준다. 번역문도 저장 관문
        # (ingest.translation_guard)을 통과할 만큼은 실물이어야 한다 — 예전 픽스처의 "번역0" 은
        # 원문 대비 너무 짧아 전부 거절되면서, 이 테스트가 재려는 '차단기' 와 무관한 이유로 깨졌다.
        return {"lines": [{"src": "This is unique sentence",
                           "ko": f"이건 이 회차의 {k}번째 고유한 문장이에요."}
                          for k in range(tt.BATCH)]}

    # Supabase 를 타지 않도록 실제 시임(fetch_transcript/load_existing/save_existing)만 갈아끼운다.
    # resegment 는 진짜 코드를 그대로 태운다 — 문장 분해가 바뀌면 배치 경계도 바뀌므로.
    # 문장은 전부 '고유'해야 한다. 같은 문장이 두 번 나오면 trkey 가 같아 두 번째는 이미
    # 번역된 것으로 간주돼 claude 호출이 건너뛰어진다(실제로 이 픽스처가 그래서 틀렸다).
    # resegment 는 세그먼트를 다시 묶으므로(관측 2:1) 넉넉히 만들고 실제 배치수를 역산한다.
    segs = [{"text": f"This is unique sentence number {k} in the episode."}
            for k in range(n_sentences * 2)]
    real_batches = -(-len(tt.resegment(segs)) // tt.BATCH)   # ceil
    monkeypatch.setattr(tt, "_call_claude", fake_claude)
    monkeypatch.setattr(tt, "fetch_transcript", lambda ep_id: {"segments": segs})
    monkeypatch.setattr(tt, "load_existing", lambda ep_id: {})
    monkeypatch.setattr(tt, "save_existing", lambda ep_id, d: saved.append(len(d)))

    err = None
    try:
        tt.translate_episode(1)
    except tt.ClaudeUnavailable as e:
        err = e
    return calls["n"], err, saved, real_batches


def test_sparse_failures_do_not_stop(monkeypatch):
    """드문 실패(매 3번째)는 한도가 아니다 — 끝까지 진행해야 한다."""
    n, err, saved, total = _run(lambda i: i % 3 == 2, monkeypatch)
    assert err is None, "간헐적 실패에서 멈추면 일시적 오류로 잡 전체가 죽는다"
    assert n == total, "모든 배치를 시도해야 한다"
    assert saved, "성공분은 체크포인트로 저장돼야 한다"


def test_one_success_resets_the_counter(monkeypatch):
    """MAX-1 회 실패 후 성공하면 카운터가 리셋돼 다시 MAX-1 회를 버틸 수 있어야 한다."""
    k = tt.MAX_CONSECUTIVE_FAILS - 1
    n, err, _, total = _run(lambda i: i != k, monkeypatch, n_batches=2 * k + 1)
    assert err is None, f"성공이 끼면 연속 카운터가 리셋돼야 한다 (실패 {k}회 → 성공 → 실패 {k}회)"
    assert n == total


def test_consecutive_failures_stop_the_run(monkeypatch):
    """전부 실패 = 한도 → 남은 배치를 태우지 말고 멈춘다."""
    n, err, _, total = _run(lambda i: True, monkeypatch, n_batches=tt.MAX_CONSECUTIVE_FAILS * 3)
    assert isinstance(err, tt.ClaudeUnavailable)
    assert n == tt.MAX_CONSECUTIVE_FAILS, (
        f"{tt.MAX_CONSECUTIVE_FAILS}회에서 멈춰야 하는데 {n}/{total}회 시도했다 — "
        "남은 배치를 실패로 소진하는 예전 동작"
    )


def test_partial_work_is_checkpointed_before_stopping(monkeypatch):
    """멈추기 전까지 번역한 건 저장돼 있어야 재개가 의미 있다."""
    fail_from = 3
    _, err, saved, _ = _run(lambda i: i >= fail_from, monkeypatch,
                            n_batches=tt.MAX_CONSECUTIVE_FAILS * 3)
    assert isinstance(err, tt.ClaudeUnavailable)
    assert saved and saved[-1] == fail_from * tt.BATCH, "성공한 배치가 체크포인트에 없다"
