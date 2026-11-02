"""The punctuation retry in ingest/transcribe.py, driven by a fake Whisper model.

The old gate could never fire: it retried only when beam_size < 5 and the default is 5. Meanwhile 86 of
1,133 transcripts had collapsed, with no sentence end for 120+ words starting a median 4% into the episode.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from ingest import transcribe

GOOD = "This is a sentence. Here is another one. And a third."
BAD = "this goes on and on with no sentence end at all for the whole of the episode really"


class FakeModel:
    """Answers each transcribe() call with the next text, and records the options it was given."""

    def __init__(self, *texts):
        self.texts = list(texts)
        self.calls = []

    def transcribe(self, path, **options):
        self.calls.append(options)
        text = self.texts.pop(0)
        seg = SimpleNamespace(start=0.0, end=1.0, text=text, words=None)
        return iter([seg]), SimpleNamespace(language="en", duration=1.0)


@pytest.fixture
def run(monkeypatch):
    def go(*texts):
        model = FakeModel(*texts)
        monkeypatch.setattr(transcribe, "_get_model", lambda: model)
        return transcribe.transcribe_one("x.mp3"), model
    return go


def text_of(data):
    return data["segments"][0]["text"]


def test_a_well_punctuated_episode_runs_once(run):
    data, model = run(GOOD)
    assert len(model.calls) == 1
    assert text_of(data) == GOOD


def test_a_collapsed_episode_retries_without_previous_text(run):
    data, model = run(BAD, GOOD)
    assert len(model.calls) == 2
    assert "condition_on_previous_text" not in model.calls[0]
    assert model.calls[1]["condition_on_previous_text"] is False
    assert text_of(data) == GOOD


def test_the_retry_keeps_the_same_beam_and_timestamps(run):
    _, model = run(BAD, GOOD)
    first, second = model.calls
    assert first["beam_size"] == second["beam_size"]
    assert second["word_timestamps"] is True and second["vad_filter"] is True


def test_the_retry_is_dropped_when_it_is_no_better(run):
    data, model = run(BAD, BAD + " and more words")
    assert len(model.calls) == 2
    assert text_of(data) == BAD


def test_the_default_beam_can_reach_the_retry(run, monkeypatch):
    # The regression itself: this must hold with no environment override.
    monkeypatch.delenv("AEP_WHISPER_BEAM", raising=False)
    _, model = run(BAD, GOOD)
    assert model.calls[0]["beam_size"] == 5 and len(model.calls) == 2
