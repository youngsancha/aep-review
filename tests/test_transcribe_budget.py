"""STT 시간 예산 + 샤딩 회귀 테스트.

배경(실측 2026-07-26): 일일 aep-sync 는 `--limit 5`(건수)로 돌았지만 job 은 60분(시간)에
잘린다. CI CPU STT 는 약 0.7x 실시간이라 20분 에피소드가 ~14분 → 3개만 들어가고,
4번째가 STT 도중 강제 종료되며 그 연산이 매일 통째로 버려졌다. 예산은 *시간* 단위로
소비되므로 판정도 시간으로 해야 한다는 것을 여기서 고정한다.

TimeBudget 은 경과시간을 인자로 받는 순수 로직이라 실제 대기 없이 검증한다.
"""
from __future__ import annotations

from ingest.transcribe import STT_RATE_GUESS, UNKNOWN_DURATION_S, TimeBudget, in_shard


def test_no_budget_never_stops():
    b = TimeBudget(None)
    ok, why = b.fits(3600, elapsed_s=99999, done=5)
    assert ok and why == ""


def test_stops_before_overrunning():
    b = TimeBudget(50 * 60)
    # 20분 에피소드 ≈ 0.75x*1.15 = 약 17분 추정. 40분 경과면 들어갈 자리가 없다.
    ok, why = b.fits(20 * 60, elapsed_s=40 * 60, done=3)
    assert not ok
    assert "stopping cleanly" in why


def test_fits_when_room_remains():
    b = TimeBudget(50 * 60)
    ok, why = b.fits(20 * 60, elapsed_s=10 * 60, done=1)
    assert ok and why == ""


def test_first_episode_runs_even_when_over_budget():
    """한 건도 못 하고 멈추면 그 에피소드가 큐를 영구히 막는다 → 예산 초과여도 1건은 시도."""
    b = TimeBudget(5 * 60)
    ok, why = b.fits(60 * 60, elapsed_s=0, done=0)
    assert ok
    assert "nothing done yet" in why
    # 단, 이미 뭔가 했다면 같은 조건에서 멈춘다.
    ok2, _ = b.fits(60 * 60, elapsed_s=0, done=1)
    assert not ok2


def test_unknown_duration_uses_fallback():
    b = TimeBudget(50 * 60)
    assert b.estimate(None) == b.estimate(UNKNOWN_DURATION_S)
    assert b.estimate(0) == b.estimate(UNKNOWN_DURATION_S)


def test_estimate_is_conservative_vs_guess():
    """예산 초과는 연산 폐기로 이어지므로 추정은 실측 rate 보다 커야 한다."""
    b = TimeBudget(60 * 60)
    assert b.estimate(1200) > 1200 * STT_RATE_GUESS


def test_observe_learns_the_real_rate():
    b = TimeBudget(60 * 60)
    before = b.rate
    b.observe(duration_sec=1200, took_s=1200)   # 1.0x — 추정보다 느린 러너
    assert b.rate > before
    for _ in range(6):
        b.observe(duration_sec=1200, took_s=1200)
    assert abs(b.rate - 1.0) < 0.05             # 실측으로 수렴


def test_observe_ignores_garbage():
    b = TimeBudget(60 * 60)
    before = b.rate
    b.observe(duration_sec=None, took_s=100)
    b.observe(duration_sec=0, took_s=100)
    b.observe(duration_sec=1200, took_s=0)
    assert b.rate == before


def test_shard_partition_is_total_and_disjoint():
    ids = list(range(461, 480)) + [497]
    for shards in (1, 2, 3, 4, 6):
        buckets = [[i for i in ids if in_shard(i, s, shards)] for s in range(shards)]
        flat = sorted(x for b in buckets for x in b)
        assert flat == sorted(ids)                       # 누락 없음
        assert len(flat) == len(set(flat))               # 중복 없음


def test_single_shard_takes_everything():
    assert all(in_shard(i, 0, 1) for i in range(100))
    assert all(in_shard(i, 0, 0) for i in range(100))     # shards=0 도 안전
