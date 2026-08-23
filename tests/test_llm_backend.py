"""call_llm 백엔드 선택 계약 — 실제 네트워크/CLI 호출 없이 디스패치만 검증."""
from __future__ import annotations

import json

import pytest

from ingest import extract_vocab

PAYLOAD = {"vocab": [{"term": "boilerplate", "kind": "word"}]}


@pytest.fixture(autouse=True)
def _clear_backend(monkeypatch):
    monkeypatch.delenv("AEP_LLM_BACKEND", raising=False)


def _stub_claude(monkeypatch, calls):
    def fake(prompt, timeout_sec=300):
        calls.append(("claude", prompt, timeout_sec))
        return PAYLOAD

    monkeypatch.setattr(extract_vocab, "call_claude", fake)


def _stub_gemini(monkeypatch, calls, text=None):
    import ingest.gemini_client as gc

    def fake(prompt, timeout_sec=300, max_output_tokens=8192):
        calls.append(("gemini", prompt, timeout_sec))
        return text if text is not None else json.dumps(PAYLOAD)

    monkeypatch.setattr(gc, "call_gemini", fake)


def test_defaults_to_claude_cli(monkeypatch):
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_gemini(monkeypatch, calls)

    assert extract_vocab.call_llm("p") == PAYLOAD
    assert [c[0] for c in calls] == ["claude"]


def test_explicit_claude_cli(monkeypatch):
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_gemini(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "claude-cli")

    extract_vocab.call_llm("p")
    assert [c[0] for c in calls] == ["claude"]


def test_gemini_backend_selected(monkeypatch):
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_gemini(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "gemini")

    assert extract_vocab.call_llm("p") == PAYLOAD
    assert [c[0] for c in calls] == ["gemini"]


def test_backend_value_is_case_and_space_tolerant(monkeypatch):
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_gemini(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "  GEMINI ")

    extract_vocab.call_llm("p")
    assert [c[0] for c in calls] == ["gemini"]


def test_unknown_backend_falls_back_to_claude(monkeypatch):
    """오타난 env 가 조용히 엉뚱한 벤더로 새지 않아야 한다."""
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_gemini(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "gpt")

    extract_vocab.call_llm("p")
    assert [c[0] for c in calls] == ["claude"]


def test_auto_prefers_claude_when_cli_present(monkeypatch):
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_gemini(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "auto")
    monkeypatch.setattr(extract_vocab.shutil, "which", lambda _: "/usr/local/bin/claude")

    extract_vocab.call_llm("p")
    assert [c[0] for c in calls] == ["claude"]


def test_auto_falls_back_to_gemini_without_cli(monkeypatch):
    """cron/CI 처럼 claude CLI 가 없는 환경 — vocab 단계가 통째로 빠지지 않게."""
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_gemini(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "auto")
    monkeypatch.setattr(extract_vocab.shutil, "which", lambda _: None)

    extract_vocab.call_llm("p")
    assert [c[0] for c in calls] == ["gemini"]


def test_gemini_response_goes_through_the_same_json_parser(monkeypatch):
    """```json 펜스/앞뒤 prose 가 붙어도 claude 경로와 똑같이 벗겨져야 한다."""
    calls: list = []
    _stub_gemini(monkeypatch, calls, text="```json\n" + json.dumps(PAYLOAD) + "\n```")
    monkeypatch.setenv("AEP_LLM_BACKEND", "gemini")

    assert extract_vocab.call_llm("p") == PAYLOAD


def test_timeout_is_forwarded(monkeypatch):
    calls: list = []
    _stub_gemini(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "gemini")

    extract_vocab.call_llm("p", timeout_sec=42)
    assert calls[0][2] == 42


class TestGeminiClient:
    def test_configured_false_without_credentials(self, monkeypatch):
        import ingest.gemini_client as gc

        for k in ("GEMINI_API_KEY", "GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_TOKEN",
                  "GOOGLE_APPLICATION_CREDENTIALS"):
            monkeypatch.delenv(k, raising=False)
        assert gc.configured() is False
        assert gc.backend() == "none"

    def test_aistudio_endpoint_uses_header_not_query_string(self, monkeypatch):
        """키가 URL 에 실리면 로그·프록시에 그대로 남는다 → 헤더로 보낸다."""
        import ingest.gemini_client as gc

        monkeypatch.delenv("GOOGLE_VERTEX_PROJECT", raising=False)
        monkeypatch.delenv("GOOGLE_VERTEX_TOKEN", raising=False)
        monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
        monkeypatch.setenv("GEMINI_API_KEY", "secret-key")

        url, headers = gc._endpoint("gemini-3-flash")
        assert "secret-key" not in url
        assert headers["x-goog-api-key"] == "secret-key"
        assert gc.backend() == "aistudio"

    def test_vertex_wins_when_both_are_set(self, monkeypatch):
        import ingest.gemini_client as gc

        monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
        monkeypatch.setenv("GEMINI_API_KEY", "k")
        monkeypatch.setenv("GOOGLE_VERTEX_PROJECT", "proj")
        monkeypatch.setenv("GOOGLE_VERTEX_TOKEN", "ya29.tok")
        monkeypatch.setenv("GOOGLE_VERTEX_LOCATION", "us-west1")

        url, headers = gc._endpoint("gemini-3-flash")
        assert "us-west1-aiplatform.googleapis.com" in url
        assert "projects/proj" in url
        assert headers["Authorization"] == "Bearer ya29.tok"
        # 서비스 계정이 없을 때만 수동 토큰 경로로 떨어진다.
        assert gc.backend() == "vertex-token"

    def test_endpoint_raises_a_useful_message_when_unset(self, monkeypatch):
        import ingest.gemini_client as gc

        for k in ("GEMINI_API_KEY", "GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_TOKEN",
                  "GOOGLE_APPLICATION_CREDENTIALS"):
            monkeypatch.delenv(k, raising=False)
        with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
            gc._endpoint("gemini-3-flash")


class TestServiceAccountAuth:
    """만료 없는 경로 — 서비스 계정 키가 있으면 수동 토큰보다 우선한다."""

    KEY = {"client_email": "sa@proj.iam.gserviceaccount.com", "private_key": "PEM",
           "project_id": "proj-from-key"}

    def _write_key(self, tmp_path, monkeypatch, data=None):
        p = tmp_path / "sa.json"
        p.write_text(json.dumps(data if data is not None else self.KEY))
        monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(p))
        return p

    def test_backend_reports_service_account(self, tmp_path, monkeypatch):
        import ingest.gemini_client as gc
        self._write_key(tmp_path, monkeypatch)
        monkeypatch.setenv("GOOGLE_VERTEX_PROJECT", "proj")
        assert gc.backend() == "vertex-sa"
        assert gc.configured() is True

    def test_project_falls_back_to_the_key_file(self, tmp_path, monkeypatch):
        """GOOGLE_VERTEX_PROJECT 를 안 넣어도 키 안의 project_id 로 동작해야 한다."""
        import ingest.gemini_client as gc
        self._write_key(tmp_path, monkeypatch)
        monkeypatch.delenv("GOOGLE_VERTEX_PROJECT", raising=False)
        assert gc._project() == "proj-from-key"
        assert gc.configured() is True

    def test_service_account_token_beats_manual_token(self, tmp_path, monkeypatch):
        import ingest.gemini_client as gc
        self._write_key(tmp_path, monkeypatch)
        monkeypatch.setenv("GOOGLE_VERTEX_PROJECT", "proj")
        monkeypatch.setenv("GOOGLE_VERTEX_TOKEN", "manual-1h-token")
        monkeypatch.setattr(gc, "_access_token", lambda: "sa-token")
        _, headers = gc._endpoint("gemini-2.5-flash")
        assert headers["Authorization"] == "Bearer sa-token"

    def test_falls_back_to_manual_token_when_exchange_fails(self, tmp_path, monkeypatch):
        import ingest.gemini_client as gc
        self._write_key(tmp_path, monkeypatch)
        monkeypatch.setenv("GOOGLE_VERTEX_PROJECT", "proj")
        monkeypatch.setenv("GOOGLE_VERTEX_TOKEN", "manual-1h-token")
        monkeypatch.setattr(gc, "_access_token", lambda: None)
        _, headers = gc._endpoint("gemini-2.5-flash")
        assert headers["Authorization"] == "Bearer manual-1h-token"

    def test_malformed_key_file_is_ignored_not_fatal(self, tmp_path, monkeypatch):
        import ingest.gemini_client as gc
        self._write_key(tmp_path, monkeypatch, data={"client_email": "x"})  # private_key 없음
        monkeypatch.delenv("GOOGLE_VERTEX_PROJECT", raising=False)
        monkeypatch.delenv("GOOGLE_VERTEX_TOKEN", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        assert gc._service_account() is None
        assert gc.configured() is False

    def test_token_is_cached_not_reminted_every_call(self, tmp_path, monkeypatch):
        import ingest.gemini_client as gc
        self._write_key(tmp_path, monkeypatch)
        gc._token_cache.clear()
        calls = []

        class R:
            status_code = 200
            def json(self): return {"access_token": "tok", "expires_in": 3600}

        def fake_post(url, **kw):
            calls.append(url)
            return R()

        monkeypatch.setattr(gc.httpx, "post", fake_post)
        monkeypatch.setattr(gc.jwt, "encode", lambda *a, **k: "assertion")
        assert gc._access_token() == "tok"
        assert gc._access_token() == "tok"
        assert len(calls) == 1
        gc._token_cache.clear()
