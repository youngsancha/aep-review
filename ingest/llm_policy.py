"""LLM 백엔드 정책 — 자동 경로는 **ollama(로컬)만** 쓴다. Claude Code 의 API 와 주간 토큰은 절대
쓰지 않는다(Roy, 2026-09-14). 이 모듈이 그 규칙의 단일 관문이다.

2026-10-23: Vertex(Gemini) 백엔드를 삭제했다. 결제 계정이 2026-10-17 에 닫혀 모든 호출이
403 BILLING_DISABLED 였고 Roy 가 복구하지 않기로 했다. "gemini"/"vertex"/"auto" 값은 더 이상 어떤 벤더도
부르지 않는다 — 경고 로그를 남기고 ollama 로 처리한다.

- resolve():  AEP_LLM_BACKEND → "ollama" | "claude-cli". 미설정/auto/gemini/vertex → ollama.
              모르는 값은 ValueError — 오타가 엉뚱한 벤더로 새지 않게.
- claude-cli: AEP_LLM_BACKEND=claude-cli **그리고** AEP_ALLOW_CLAUDE_QUOTA=1 둘 다 있어야 한다.
              launchd/CI/일일 루프는 후자를 절대 설정하지 않는다(daily_local_loop.sh 가 unset 까지 한다).
              두 번 누수됐다: 09-10 하루 53.7%, 09-13 refine 패스 우회 6%p.
"""
from __future__ import annotations

import logging
import os

log = logging.getLogger(__name__)

FREE_BACKENDS = ("ollama",)
# 예전에 Vertex/Gemini 를 가리키던 값들 — 이제는 ollama 로 읽는다(재시도 없음, 벤더 호출 없음).
RETIRED_BACKENDS = ("gemini", "vertex")


class ClaudeQuotaRefused(RuntimeError):
    pass


def claude_allowed() -> bool:
    return ((os.environ.get("AEP_LLM_BACKEND") or "").strip().lower() == "claude-cli"
            and os.environ.get("AEP_ALLOW_CLAUDE_QUOTA") == "1")


def require_claude_allowed() -> None:
    if not claude_allowed():
        raise ClaudeQuotaRefused(
            "claude -p refused: automated paths use ollama only. "
            "To spend the Claude subscription by hand set BOTH AEP_LLM_BACKEND=claude-cli "
            "and AEP_ALLOW_CLAUDE_QUOTA=1 (ingest/llm_policy.py).")


def resolve() -> str:
    c = (os.environ.get("AEP_LLM_BACKEND") or "ollama").strip().lower()
    if c in ("", "auto"):
        c = "ollama"          # never claude-cli by accident
    if c in RETIRED_BACKENDS:
        log.warning("AEP_LLM_BACKEND=%s 는 삭제된 백엔드(Vertex, 결제 닫힘) — ollama 로 처리한다", c)
        c = "ollama"
    if c == "claude-cli":
        require_claude_allowed()
        return c
    if c not in FREE_BACKENDS:
        raise ValueError(f"unknown AEP_LLM_BACKEND={c!r} — use ollama")
    return c


def call_text(prompt: str, *, timeout_sec: int = 300, max_output_tokens: int = 8192,
              schema: dict | None = None) -> str:
    """ollama 텍스트 호출(JSON 파싱은 호출부). claude-cli 는 여기로 오지 않는다 —
    호출부가 resolve() 로 먼저 분기한다."""
    if resolve() == "claude-cli":
        raise RuntimeError("call_text does not drive claude-cli; branch on resolve() first")
    from ingest.ollama_client import call_ollama
    return call_ollama(prompt, timeout_sec=timeout_sec, max_output_tokens=max_output_tokens, schema=schema)
