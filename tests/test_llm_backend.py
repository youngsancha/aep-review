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


def _stub_ollama(monkeypatch, calls, text=None):
    import ingest.ollama_client as oc
    def fake(prompt, timeout_sec=300, max_output_tokens=8192, schema=None):
        calls.append(("ollama", prompt, timeout_sec))
        return text if text is not None else json.dumps(PAYLOAD)
    monkeypatch.setattr(oc, "call_ollama", fake)
    monkeypatch.setattr(oc, "configured", lambda: True)
    monkeypatch.setattr(oc, "model_name", lambda: "fake-model")


@pytest.fixture(autouse=True)
def _reset_policy(monkeypatch):
    from ingest import llm_policy
    monkeypatch.setattr(llm_policy, "_gemini_exhausted", False)
    monkeypatch.delenv("AEP_ALLOW_CLAUDE_QUOTA", raising=False)


def test_defaults_to_gemini(monkeypatch):
    """env 를 안 건드리면 Claude 한도를 한 톨도 쓰지 않는다."""
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_gemini(monkeypatch, calls)
    assert extract_vocab.call_llm("p") == PAYLOAD
    assert [c[0] for c in calls] == ["gemini"]


def test_claude_cli_refused_without_the_allow_flag(monkeypatch):
    """AEP_LLM_BACKEND=claude-cli 만으로는 부족하다 — 두 번 누수된 뒤의 규칙(2026-09-14)."""
    from ingest.llm_policy import ClaudeQuotaRefused
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_gemini(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "claude-cli")
    with pytest.raises(ClaudeQuotaRefused):
        extract_vocab.call_llm("p")
    assert calls == []


def test_claude_cli_with_double_optin(monkeypatch):
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_gemini(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "claude-cli")
    monkeypatch.setenv("AEP_ALLOW_CLAUDE_QUOTA", "1")
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
    _stub_gemini(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "  GEMINI ")
    extract_vocab.call_llm("p")
    assert [c[0] for c in calls] == ["gemini"]


def test_unknown_backend_raises(monkeypatch):
    """오타난 env 가 조용히 엉뚱한 벤더(특히 claude)로 새지 않아야 한다."""
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_gemini(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "gpt")
    with pytest.raises(ValueError):
        extract_vocab.call_llm("p")
    assert calls == []


def test_auto_never_picks_claude_even_with_cli_present(monkeypatch):
    calls: list = []
    _stub_claude(monkeypatch, calls)
    _stub_gemini(monkeypatch, calls)
    monkeypatch.setenv("AEP_LLM_BACKEND", "auto")
    import shutil
    monkeypatch.setattr(shutil, "which", lambda _: "/usr/local/bin/claude")   # CLI 가 있어도
    extract_vocab.call_llm("p")
    assert [c[0] for c in calls] == ["gemini"]


def test_gemini_exhausted_falls_back_to_ollama_and_sticks(monkeypatch):
    """무료 크레딧이 끝나면(429/403) 같은 프로세스는 이후 ollama 로 — 실패를 N 번 반복하지 않는다."""
    import ingest.gemini_client as gc
    calls: list = []
    def broke(prompt, timeout_sec=300, max_output_tokens=8192):
        calls.append(("gemini", prompt, timeout_sec))
        raise RuntimeError("gemini failed status=429: Your prepayment credits are depleted")
    monkeypatch.setattr(gc, "call_gemini", broke)
    _stub_ollama(monkeypatch, calls)
    assert extract_vocab.call_llm("p") == PAYLOAD
    assert [c[0] for c in calls] == ["gemini", "ollama"]
    assert extract_vocab.call_llm("q") == PAYLOAD
    assert [c[0] for c in calls][2:] == ["ollama"]


def test_gemini_transient_error_does_not_fall_back(monkeypatch):
    """500/네트워크 오류는 재시도의 영역 — 조용히 다른 모델로 바꾸면 품질이 소리 없이 바뀐다."""
    import ingest.gemini_client as gc
    calls: list = []
    def broke(prompt, timeout_sec=300, max_output_tokens=8192):
        raise RuntimeError("gemini failed status=500: internal")
    monkeypatch.setattr(gc, "call_gemini", broke)
    _stub_ollama(monkeypatch, calls)
    with pytest.raises(RuntimeError, match="status=500"):
        extract_vocab.call_llm("p")
    assert calls == []


def test_gemini_response_goes_through_the_same_json_parser(monkeypatch):
    """```json 펜스/앞뒤 prose 가 붙어도 똑같이 벗겨져야 한다."""
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


# ── thinking 예산: 모델별로 0 을 받아주지 않는 경우가 있다 ────────────────────
class _Resp:
    status_code = 200
    text = "{}"

    @staticmethod
    def json():
        return {"candidates": [{"content": {"parts": [{"text": "{}"}]}}]}


def _capture_body(monkeypatch):
    """call_gemini 가 실제로 Vertex 에 보내는 body 를 가로챈다."""
    from ingest import gemini_client as gc

    sent = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        sent.update(json or {})
        return _Resp()

    monkeypatch.setattr(gc.httpx, "post", fake_post)
    monkeypatch.setattr(gc, "_endpoint", lambda m: ("https://x", {}))
    return sent


def test_flash_disables_thinking(monkeypatch):
    from ingest import gemini_client as gc

    monkeypatch.setenv("GEMINI_MODEL_FAST", "gemini-2.5-flash")
    sent = _capture_body(monkeypatch)
    gc.call_gemini("p", max_output_tokens=8192)
    cfg = sent["generationConfig"]
    assert cfg["thinkingConfig"]["thinkingBudget"] == 0
    assert cfg["maxOutputTokens"] == 8192


def test_pro_never_gets_a_zero_budget(monkeypatch):
    """gemini-2.5-pro 는 thinkingBudget:0 을 하드 400 으로 거부한다(2026-08-23 실측).
    fail-open 이라 이 400 은 아무 데도 안 보이고 기능만 조용히 멈춘다."""
    from ingest import gemini_client as gc

    monkeypatch.setenv("GEMINI_MODEL_FAST", "gemini-2.5-pro")
    sent = _capture_body(monkeypatch)
    gc.call_gemini("p", max_output_tokens=8192)
    assert sent["generationConfig"]["thinkingConfig"]["thinkingBudget"] > 0


def test_pro_gets_its_thinking_budget_as_EXTRA_output(monkeypatch):
    """thinking 토큰은 maxOutputTokens 에서 차감된다 — 그대로 두면 본문이 잘린 채 200 이
    돌아온다. 본문 예산은 지키고 생각 몫만 더해야 한다."""
    from ingest import gemini_client as gc

    monkeypatch.setenv("GEMINI_MODEL_FAST", "gemini-2.5-pro")
    sent = _capture_body(monkeypatch)
    gc.call_gemini("p", max_output_tokens=8192)
    cfg = sent["generationConfig"]
    assert cfg["maxOutputTokens"] == 8192 + cfg["thinkingConfig"]["thinkingBudget"]
