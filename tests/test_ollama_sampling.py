"""The daily residual retry varies sampling via env; unset env must leave temperature 0 alone."""
from ingest.ollama_client import sampling_overrides


def test_unset_changes_nothing(monkeypatch):
    monkeypatch.delenv("AEP_OLLAMA_TEMPERATURE", raising=False)
    monkeypatch.delenv("AEP_OLLAMA_SEED", raising=False)
    assert sampling_overrides() == {}


def test_temperature_and_seed(monkeypatch):
    monkeypatch.setenv("AEP_OLLAMA_TEMPERATURE", "0.6")
    monkeypatch.setenv("AEP_OLLAMA_SEED", "2026330")
    assert sampling_overrides() == {"temperature": 0.6, "seed": 2026330}


def test_bad_values_are_ignored_or_clamped(monkeypatch):
    monkeypatch.setenv("AEP_OLLAMA_TEMPERATURE", "hot")
    monkeypatch.setenv("AEP_OLLAMA_SEED", "x")
    assert sampling_overrides() == {}
    monkeypatch.setenv("AEP_OLLAMA_TEMPERATURE", "9")
    assert sampling_overrides() == {"temperature": 1.5}
