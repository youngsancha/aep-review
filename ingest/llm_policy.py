"""LLM 백엔드 정책 — 자동 경로는 **ollama 또는 Gemini 무료 크레딧만** 쓴다. Claude Code 의 API 와
주간 토큰은 절대 쓰지 않는다(Roy, 2026-09-14). 이 모듈이 그 규칙의 단일 관문이다.

- resolve():  AEP_LLM_BACKEND → "gemini" | "ollama" | "claude-cli". 미설정/auto → gemini.
              모르는 값은 ValueError — 오타가 엉뚱한 벤더로 새지 않게.
- claude-cli: AEP_LLM_BACKEND=claude-cli **그리고** AEP_ALLOW_CLAUDE_QUOTA=1 둘 다 있어야 한다.
              launchd/CI/일일 루프는 후자를 절대 설정하지 않는다(daily_local_loop.sh 가 unset 까지 한다).
              두 번 누수됐다: 09-10 하루 53.7%, 09-13 refine 패스 우회 6%p.
- Gemini 소진: 무료 크레딧($300 일회성, ~2026-10-17 만료, 청구 계정이 자동 닫힘)이 끝나면 429/403 이
              온다 → 같은 프로세스 안에서는 이후 ollama 로 간다(sticky). 다음 프로세스는 다시 gemini 부터
              시도한다 — 크레딧이 채워졌을 수 있고, 시도 한 번의 비용은 실패 응답 하나다.
"""
from __future__ import annotations

import logging
import os

log = logging.getLogger(__name__)

FREE_BACKENDS = ("gemini", "ollama")
# 크레딧/쿼터 소진으로 읽는 신호. 500/네트워크 오류는 여기 없다 — 그건 재시도가 답이지 폴백이 아니다.
EXHAUSTED_MARKERS = ("status=429", "status=403", "status=402", "resource_exhausted",
                     "permission_denied", "credits", "billing", "quota")
_gemini_exhausted = False


class ClaudeQuotaRefused(RuntimeError):
    pass


def claude_allowed() -> bool:
    return ((os.environ.get("AEP_LLM_BACKEND") or "").strip().lower() == "claude-cli"
            and os.environ.get("AEP_ALLOW_CLAUDE_QUOTA") == "1")


def require_claude_allowed() -> None:
    if not claude_allowed():
        raise ClaudeQuotaRefused(
            "claude -p refused: automated paths use ollama or the Gemini free credit only. "
            "To spend the Claude subscription by hand set BOTH AEP_LLM_BACKEND=claude-cli "
            "and AEP_ALLOW_CLAUDE_QUOTA=1 (ingest/llm_policy.py).")


def resolve() -> str:
    c = (os.environ.get("AEP_LLM_BACKEND") or "gemini").strip().lower()
    if c in ("", "auto"):
        c = "gemini"          # never claude-cli by accident
    if c == "claude-cli":
        require_claude_allowed()
        return c
    if c not in FREE_BACKENDS:
        raise ValueError(f"unknown AEP_LLM_BACKEND={c!r} — use gemini or ollama")
    if c == "gemini" and _gemini_exhausted:
        return "ollama"
    return c


def looks_exhausted(exc: BaseException) -> bool:
    s = str(exc).lower()
    return any(m in s for m in EXHAUSTED_MARKERS)


def call_text(prompt: str, *, timeout_sec: int = 300, max_output_tokens: int = 8192,
              schema: dict | None = None) -> str:
    """gemini/ollama 공통 텍스트 호출(JSON 파싱은 호출부). gemini 소진 → ollama 폴백.
    claude-cli 는 여기로 오지 않는다 — 호출부가 resolve() 로 먼저 분기한다."""
    global _gemini_exhausted
    b = resolve()
    if b == "claude-cli":
        raise RuntimeError("call_text does not drive claude-cli; branch on resolve() first")
    if b == "gemini":
        from ingest.gemini_client import call_gemini
        try:
            return call_gemini(prompt, timeout_sec=timeout_sec, max_output_tokens=max_output_tokens)
        except Exception as e:
            from ingest import ollama_client
            if looks_exhausted(e) and ollama_client.configured():
                _gemini_exhausted = True
                log.warning("Gemini 크레딧/쿼터 소진으로 보임(%s) — 이 프로세스는 이후 ollama(%s)",
                            str(e)[:120], ollama_client.model_name())
            else:
                raise
    from ingest.ollama_client import call_ollama
    return call_ollama(prompt, timeout_sec=timeout_sec, max_output_tokens=max_output_tokens, schema=schema)
