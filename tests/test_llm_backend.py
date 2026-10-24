"""call_llm 백엔드 선택 계약 — 실제 네트워크/CLI 호출 없이 디스패치만 검증.
Vertex/Gemini 백엔드는 2026-10-23 삭제됐다: ollama 가 유일한 자동 백엔드다."""
from __future__ import annotations

import json

import pytest

from ingest import extract_vocab

PAYLOAD = {"vocab": [{"term": "boilerplate", "kind": "word"}]}


@pytest.fixture(autouse=True)
def _clear_backend(monkeypatch):
    monkeypatch.delenv("AEP_LLM_BACKEND", raising=False)
    monkeypatch.delenv("AEP_ALLOW_CLAUDE_QUOTA", raising=False)


def _stub_claude(monkeypatch, calls):
    def fake(prompt, timeout_sec=300):
        calls.append(("claude", prompt, timeout_sec))
        return PAYLOAD

    monkeypatch.setattr(extract_vocab, "call_claude", fake)


def _stub_ollama(monkeypatch, calls, text=None):
    import ingest.ollama_client as oc

    def fake(prompt, timeout_sec=300, max_output_tokens=8192, schema=None):
        calls.append(("ollama", prompt, timeout_sec))
        return text if text is not None else json.dumps(PAYLOAD)

    monkeypatch.setattr(oc, "call_ollama", fake)
    monkeypatch.setattr(oc, "configured", lambda: True)
    monkeypatch.setattr(oc, "model_name", lambda: "fake-model")


def _forbid_network(monkeypatch):
    """어떤 HTTP 호출도 나가면 실패 — 벤더가 되살아나면 여기서 잡힌다."""
    import httpx

    def boom(*a, **k):
        raise AssertionError(f"unexpected network call: {a[:1]}")

    monkeypatch.setattr(httpx, "post", boom)


def test_defaults_to_ollama(monkeypatch):
    """env 를 안 건드리면 로컬 ollama — Claude 한도도, 원격 벤더도 쓰지 않는다."""
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_ollama(monkeypatch, calls)
    _forbid_network(monkeypatch)
    assert extract_vocab.call_llm("p") == PAYLOAD
    assert [c[0] for c in calls] == ["ollama"]


def test_unknown_backend_raises(monkeypatch):
    """오타난 env 가 조용히 엉뚱한 벤더(특히 claude)로 새지 않아야 한다."""
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_ollama(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "gpt")
    with pytest.raises(ValueError):
        extract_vocab.call_llm("p")
    assert calls == []


@pytest.mark.parametrize("value", ["gemini", "  GEMINI ", "vertex", "auto"])
def test_retired_values_fall_back_to_ollama_with_a_log_line(monkeypatch, caplog, value):
    """예전에 Vertex 를 고르던 값은 ollama 로 읽힌다 — 재시도도, 원격 호출도 없다."""
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_ollama(monkeypatch, calls)
    _forbid_network(monkeypatch)
    monkeypatch.setenv("AEP_LLM_BACKEND", value)
    with caplog.at_level("WARNING", logger="ingest.llm_policy"):
        assert extract_vocab.call_llm("p") == PAYLOAD
    assert [c[0] for c in calls] == ["ollama"]
    if value.strip().lower() != "auto":
        assert "ollama" in caplog.text and "Vertex" in caplog.text


def test_auto_never_picks_claude_even_with_cli_present(monkeypatch):
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_ollama(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "auto")
    import shutil
    monkeypatch.setattr(shutil, "which", lambda _: "/usr/local/bin/claude")   # CLI 가 있어도
    extract_vocab.call_llm("p")
    assert [c[0] for c in calls] == ["ollama"]


def test_claude_cli_refused_without_the_allow_flag(monkeypatch):
    """AEP_LLM_BACKEND=claude-cli 만으로는 부족하다 — 두 번 누수된 뒤의 규칙(2026-09-14)."""
    from ingest.llm_policy import ClaudeQuotaRefused
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_ollama(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "claude-cli")
    with pytest.raises(ClaudeQuotaRefused):
        extract_vocab.call_llm("p")
    assert calls == []


def test_claude_cli_with_double_optin(monkeypatch):
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_ollama(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "claude-cli")
    monkeypatch.setenv("AEP_ALLOW_CLAUDE_QUOTA", "1")
    extract_vocab.call_llm("p")
    assert [c[0] for c in calls] == ["claude"]


def test_ollama_response_goes_through_the_same_json_parser(monkeypatch):
    """```json 펜스/앞뒤 prose 가 붙어도 똑같이 벗겨져야 한다."""
    calls: list = []
    _stub_ollama(monkeypatch, calls, text="```json\n" + json.dumps(PAYLOAD) + "\n```")
    monkeypatch.setenv("AEP_LLM_BACKEND", "ollama")
    assert extract_vocab.call_llm("p") == PAYLOAD


def test_backend_value_is_case_and_space_tolerant(monkeypatch):
    calls: list = []
    _stub_ollama(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "  OLLAMA ")
    extract_vocab.call_llm("p")
    assert [c[0] for c in calls] == ["ollama"]


def test_timeout_is_forwarded(monkeypatch):
    calls: list = []
    _stub_ollama(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "ollama")
    extract_vocab.call_llm("p", timeout_sec=42)
    assert calls[0][2] == 42


def test_no_vertex_client_module_remains():
    """Vertex 클라이언트가 되살아나지 않게 — 파일 자체가 없어야 한다."""
    from pathlib import Path
    assert not (Path(extract_vocab.__file__).parent / "gemini_client.py").exists()
