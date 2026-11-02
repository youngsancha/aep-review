"""scripts/audit_punctuation.py: the pure parts, and the failure handling that keeps an audit honest."""
from __future__ import annotations

import io
import json
import urllib.error

import pytest

from ingest.transcribe import PUNCT_MIN
from scripts import audit_punctuation as audit


def rows(*items):
    return [{"id": i, "show": s, "ratio": r} for i, s, r in items]


def test_summary_counts_below_the_same_threshold_as_the_retry():
    s = audit.summarise(rows((1, "a", PUNCT_MIN - 0.001), (2, "a", PUNCT_MIN), (3, "b", 0.07)))
    assert s["a"]["low"] == 1 and s["a"]["n"] == 2
    assert s["b"]["low"] == 0


def test_ids_are_worst_first_and_filter_by_show():
    r = rows((1, "cnn10", 0.03), (2, "cnn10", 0.01), (3, "aep", 0.005), (4, "cnn10", 0.07))
    assert audit.low_ids(r, "cnn10") == [2, 1]
    assert audit.low_ids(r) == [3, 2, 1]


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_a_missing_file_is_not_a_failure(monkeypatch):
    def gone(*a, **k):
        raise urllib.error.HTTPError("u", 404, "nope", None, None)
    monkeypatch.setattr(audit.urllib.request, "urlopen", gone)
    assert audit.read_ratio("https://x/", {"id": 1, "show": "a"}) is None


def test_a_network_failure_is_counted_not_read_as_a_missing_file(monkeypatch):
    # This exact conflation made an earlier audit in this repo report 29 phantom missing files.
    calls = []

    def flaky(*a, **k):
        calls.append(1)
        raise TimeoutError("timed out")
    monkeypatch.setattr(audit.urllib.request, "urlopen", flaky)
    with pytest.raises(RuntimeError):
        audit.read_ratio("https://x/", {"id": 1, "show": "a"})
    assert len(calls) == 3


def test_a_retry_recovers(monkeypatch):
    body = json.dumps({"segments": [{"text": "One sentence here."}]}).encode()
    answers = [TimeoutError("timed out"), FakeResponse(body)]

    def next_answer(*a, **k):
        a0 = answers.pop(0)
        if isinstance(a0, Exception):
            raise a0
        return a0
    monkeypatch.setattr(audit.urllib.request, "urlopen", next_answer)
    assert audit.read_ratio("https://x/", {"id": 1, "show": "a"})["ratio"] > 0
