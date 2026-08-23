"""Gemini 백엔드 — `claude -p` CLI 의 대안.

왜 필요한가 (비용이 아니다):
  extract_vocab 은 Claude Max 구독을 쓰려고 `claude -p` subprocess 를 부른다. 이건
  이미 추가 과금이 0 이라 **비용상 이득은 없다**. 문제는 *이식성*이다 — `claude -p` 는
  로그인된 Claude Code CLI 가 깔린 머신에서만 돈다. 그래서 cron_fetch 에 `--no-vocab`
  ("claude CLI 없을 때") 탈출구가 있고, 서버/CI/컨테이너에서는 vocab 단계가 통째로 빠진다.
  이 모듈은 HTTP 만으로 도는 경로를 줘서 그 구멍을 메운다.

인증 경로(위에서부터 우선):
  1) Vertex + 서비스 계정 — GOOGLE_APPLICATION_CREDENTIALS(키 JSON) + GOOGLE_VERTEX_PROJECT.
     ★ 권장. 키가 만료되지 않고 액세스 토큰은 이 모듈이 직접 발급·캐시한다(사람 개입 0).
  2) Vertex + 수동 토큰 — GOOGLE_VERTEX_TOKEN. 1시간 만료 → 디버깅용. 상시 실행에 쓰지 말 것.
  3) AI Studio — GEMINI_API_KEY. ⚠️ AI Studio 는 자체 선불(prepay) 잔액을 쓰므로
     GCP 월 $10 크레딧이 차감되지 않는다(429 "prepayment credits are depleted" 로 확인).
"""
from __future__ import annotations

import json
import logging
import os
import re
import time

import httpx
import jwt

log = logging.getLogger(__name__)

_TOKEN_URL = "https://oauth2.googleapis.com/token"
_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
_SKEW_SEC = 300  # 만료 5분 전 선갱신 — 경계에서 401 나지 않도록
_token_cache: dict[str, float | str] = {}


def _service_account() -> dict | None:
    """GOOGLE_APPLICATION_CREDENTIALS 의 키 JSON. 없거나 불완전하면 None."""
    path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            sa = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    return sa if sa.get("client_email") and sa.get("private_key") else None


def _access_token() -> str | None:
    """서비스 계정으로 액세스 토큰 발급(프로세스 내 캐시). 없으면 None."""
    sa = _service_account()
    if not sa:
        return None

    now = time.time()
    exp = _token_cache.get("expires_at", 0)
    tok = _token_cache.get("token")
    if isinstance(tok, str) and isinstance(exp, (int, float)) and exp - _SKEW_SEC > now:
        return tok

    assertion = jwt.encode(
        {
            "iss": sa["client_email"],
            "scope": _SCOPE,
            "aud": _TOKEN_URL,
            "iat": int(now),
            "exp": int(now) + 3600,
        },
        sa["private_key"],
        algorithm="RS256",
    )
    try:
        r = httpx.post(
            _TOKEN_URL,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            },
            timeout=30,
        )
        if r.status_code != 200:
            log.warning("service account token exchange failed: %s", r.text[:200])
            return None
        body = r.json()
    except httpx.HTTPError as e:
        log.warning("service account token exchange error: %s", e)
        return None

    token = body.get("access_token")
    if not token:
        return None
    _token_cache["token"] = token
    _token_cache["expires_at"] = now + body.get("expires_in", 3600)
    return token

DEFAULT_LOCATION = "us-central1"
DEFAULT_MODEL = "gemini-2.5-flash"

# thinkingBudget:0 을 하드 400 으로 거부하는 모델들. Vertex us-central1 에서 2026-08-23 실측:
# gemini-2.5-pro 는 "The model does not support setting thinking_budget to 0" 을 돌려준다.
# 모델만 pro 로 올리면 전 호출이 실패하는데, 이 프로젝트는 fail-open 이라 조용히 멈춘다.
ALWAYS_THINKS = re.compile(r"^gemini-2\.5-pro\b")

# thinking 을 끌 수 없을 때 부여하는 '생각 전용' 예산. thinking 토큰은 maxOutputTokens 에서
# 차감되고 출력 단가로 과금되므로, 그냥 두면 답이 잘린 채 HTTP 200 으로 돌아온다(실측: 3토큰
# 답변에 thinking 144토큰). 딱 이만큼을 '추가로' 줘서 본문 예산은 그대로 지킨다.
THINKING_BUDGET = 1024


def model_name() -> str:
    return os.environ.get("GEMINI_MODEL_FAST") or DEFAULT_MODEL


def _project() -> str | None:
    if os.environ.get("GOOGLE_VERTEX_PROJECT"):
        return os.environ["GOOGLE_VERTEX_PROJECT"]
    sa = _service_account()
    return sa.get("project_id") if sa else None


def configured() -> bool:
    project = _project()
    vertex = bool(project) and bool(_service_account() or os.environ.get("GOOGLE_VERTEX_TOKEN"))
    return vertex or bool(os.environ.get("GEMINI_API_KEY"))


def backend() -> str:
    """어느 경로로 나가는지 — 로그/진단용."""
    project = _project()
    if project and _service_account():
        return "vertex-sa"
    if project and os.environ.get("GOOGLE_VERTEX_TOKEN"):
        return "vertex-token"
    if os.environ.get("GEMINI_API_KEY"):
        return "aistudio"
    return "none"


def _endpoint(model: str) -> tuple[str, dict[str, str]]:
    project = _project()
    if project:
        # 서비스 계정 우선(만료 없음). 없을 때만 수동 토큰(1시간)으로 폴백.
        token = _access_token() or os.environ.get("GOOGLE_VERTEX_TOKEN")
        if token:
            loc = os.environ.get("GOOGLE_VERTEX_LOCATION") or DEFAULT_LOCATION
            url = (
                f"https://{loc}-aiplatform.googleapis.com/v1/projects/{project}"
                f"/locations/{loc}/publishers/google/models/{model}:generateContent"
            )
            return url, {
                "Authorization": f"Bearer {token}",
                # 사용자 계정 토큰은 이 헤더가 없으면 gcloud 공유 프로젝트로 집계된다 → 크레딧 미차감.
                # 서비스 계정엔 불필요하지만 무해하므로 한 경로로 통일.
                "x-goog-user-project": project,
                "Content-Type": "application/json",
            }

    key = os.environ.get("GEMINI_API_KEY")
    if key:
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}"
            f":generateContent"
        )
        return url, {"x-goog-api-key": key, "Content-Type": "application/json"}

    raise RuntimeError(
        "Gemini 미설정: GOOGLE_APPLICATION_CREDENTIALS(권장) 또는 GEMINI_API_KEY 필요"
    )


def call_gemini(prompt: str, timeout_sec: int = 300, max_output_tokens: int = 8192) -> str:
    """프롬프트 → 응답 텍스트(raw). JSON 파싱은 호출부(_parse_vocab_json)가 한다."""
    model = model_name()
    url, headers = _endpoint(model)
    log.info("calling gemini model=%s backend=%s prompt_chars=%d", model, backend(), len(prompt))

    # vocab 추출은 결정적 작업이라 thinking 은 끄는 게 원칙이다. 다만 0 을 거부하는 모델이
    # 있어서, 그런 모델에는 '상한이 있는' 예산과 그만큼의 추가 출력량을 준다 — 끄지 못한다고
    # 무제한으로 두면 본문이 잘리거나 과금이 부푼다.
    thinks = bool(ALWAYS_THINKS.match(model))
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "maxOutputTokens": max_output_tokens + (THINKING_BUDGET if thinks else 0),
            "temperature": 0,
            "responseMimeType": "application/json",
            "thinkingConfig": {"thinkingBudget": THINKING_BUDGET if thinks else 0},
        },
    }

    resp = httpx.post(url, headers=headers, json=body, timeout=timeout_sec)
    if resp.status_code != 200:
        raise RuntimeError(f"gemini failed status={resp.status_code}: {resp.text[:500]}")

    data = resp.json()
    candidates = data.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"gemini returned no candidates: {str(data)[:500]}")
    parts = (candidates[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts)
    if not text.strip():
        raise RuntimeError("gemini returned empty text")
    return text
