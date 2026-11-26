"""Vocab timestamps from the local LLM must never reach PostgREST as non-numbers (ep 1161, 2026-11-25)."""
import math

from ingest.store import _vocab_sec


def test_numbers_pass():
    assert _vocab_sec(12.5) == 12.5
    assert _vocab_sec(3) == 3.0
    assert _vocab_sec("41.2") == 41.2
    assert _vocab_sec(" 41.2s ") == 41.2


def test_junk_becomes_none():
    for bad in ("-", "", "  ", "n/a", None, True, float("nan"), math.inf, -1, [], {}):
        assert _vocab_sec(bad) is None, bad
