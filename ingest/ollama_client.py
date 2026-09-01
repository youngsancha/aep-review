"""Ollama 백엔드 — 로컬 LLM. `claude -p`/Gemini 의 세 번째 대안.

왜 필요한가 (2026-09-01, 이번엔 정말 비용이다):
  사전번역(_ko.json)이 없는 문장은 앱이 재생 중 MyMemory 로 폴백하는데, **오프라인이면 그
  폴백조차 실패해 "Translation needs a connection" 만 뜬다.** 실측: cnn10 은 395편 중 387편에
  `_ko.json` 이 아예 없고, 오프라인 다운로드 창(최신 15편)의 커버리지가 **0.0%** 다 — 그 쇼를
  오프라인으로 들으면 3,048문장 전부가 번역 없이 뜬다.
  남은 미번역은 전체 85,620문장이고 그중 72,306(84%)이 cnn10 이다.

  `claude -p` 는 API 과금은 0 이지만 **Claude 사용 한도**를 쓴다. 실제로 2026-07-27 에 이 잡이
  한도에 걸려 40분 동안 5,368건을 실패시키고 exit 0 으로 끝난 적이 있다(그래서 위 스크립트에
  MAX_CONSECUTIVE_FAILS 차단기가 있다). 8만 문장을 그 한도로 갈아 넣는 것은 현실적이지 않다.
  Ollama 는 과금도 한도도 없고 네트워크도 필요 없다 — 밤새 돌려도 아무것도 소모하지 않는다.

⛔ 대신 품질이 백엔드마다 다르다. 작은 로컬 모델은 **자신 있게 틀린 한국어를 HTTP 200 으로**
   돌려준다(실측 qwen2.5:7b: "piece of cake" → '케이크 한 조각', "a crummy day" → '날씨가
   좋지 않다'). 그래서 이 백엔드를 쓸 때는 scripts/translate_transcripts.sane_translation 의
   검증이 반드시 함께 돈다. 모델 선택은 scripts/bench_translation.py 로 실측하고 고른다.

    AEP_LLM_BACKEND=ollama python -m scripts.translate_transcripts --show cnn10
    AEP_OLLAMA_MODEL=exaone3.5:7.8b   # 기본값은 DEFAULT_MODEL
    OLLAMA_HOST=http://localhost:11434
"""
from __future__ import annotations

import json
import logging
import os

import httpx

log = logging.getLogger(__name__)

DEFAULT_HOST = "http://localhost:11434"
# 번역 대상이 한국어라 '한국어를 모국어급으로 하는' 모델을 기본으로 둔다. 영어권 범용 7B 는
# 관용구에서 무너진다(위 주석의 실측). 바꾸기 전에 scripts/bench_translation.py 를 돌릴 것.
DEFAULT_MODEL = "exaone3.5:7.8b"


def host() -> str:
    return (os.environ.get("OLLAMA_HOST") or DEFAULT_HOST).rstrip("/")


def model_name() -> str:
    return os.environ.get("AEP_OLLAMA_MODEL") or DEFAULT_MODEL


def configured() -> bool:
    """데몬이 떠 있고 모델이 실제로 받아져 있는가. (둘 중 하나만 빠져도 전 호출이 실패한다)"""
    return model_name() in installed_models()


def installed_models() -> set[str]:
    try:
        r = httpx.get(f"{host()}/api/tags", timeout=5)
        if r.status_code != 200:
            return set()
        return {m.get("name", "") for m in (r.json().get("models") or [])}
    except httpx.HTTPError:
        return set()


def call_ollama(prompt: str, timeout_sec: int = 300, max_output_tokens: int = 8192,
                schema: dict | None = None) -> str:
    """프롬프트 → 응답 텍스트(raw). JSON 파싱은 호출부가 한다(call_gemini 와 같은 규약).

    ⚠ 실패는 반드시 raise 한다. 빈 문자열을 돌려주면 호출부의 연속실패 차단기가 돌지 않아,
    데몬이 꺼진 채로 전 회차를 '시도만' 하고 완주해 버린다 — claude 한도 사고와 같은 모양이다.
    """
    body = {
        "model": model_name(),
        "prompt": prompt,
        "stream": False,
        # 구조화 출력. schema 를 주면 JSON Schema 로 문법을 강제한다 — "json" 만으로는 부족했다:
        # 실측(exaone3.5:7.8b)에서 '줄마다 {a, ko}' 를 말로 지시했더니 입력 스키마를 흉내 내
        # `{"i":"0","ko":"..."}` 한 개만 돌려줬다(8줄 요청 → 1개). 스키마는 그 형태를 불가능하게 만든다.
        "format": schema if schema else "json",
        "options": {
            "temperature": 0,     # 번역은 변환 작업 — 샘플링 다양성은 손해다
            "num_ctx": 8192,      # 배치 32문장 + 지침이 들어갈 컨텍스트
            "num_predict": max_output_tokens,
        },
    }
    log.info("calling ollama model=%s prompt_chars=%d", model_name(), len(prompt))
    try:
        r = httpx.post(f"{host()}/api/generate", json=body, timeout=timeout_sec)
    except httpx.HTTPError as e:
        raise RuntimeError(f"ollama unreachable at {host()}: {e}") from e
    if r.status_code != 200:
        raise RuntimeError(f"ollama failed status={r.status_code}: {r.text[:300]}")
    data = r.json()
    text = data.get("response") or ""
    if not text.strip():
        # done_reason 을 그대로 노출한다 — 'length'(컨텍스트 초과)와 장애를 구분해야 배치 크기를
        # 줄일지 데몬을 볼지 판단할 수 있다.
        raise RuntimeError(f"ollama returned empty response (done_reason={data.get('done_reason')!r})")
    return text


def describe() -> str:
    """진단용 한 줄 — 어떤 모델로 나가는지 로그에 남긴다."""
    return f"ollama {model_name()} @ {host()}"


__all__ = ["call_ollama", "configured", "installed_models", "model_name", "host", "describe",
           "DEFAULT_MODEL", "DEFAULT_HOST"]


if __name__ == "__main__":  # 수동 점검: python -m ingest.ollama_client
    logging.basicConfig(level=logging.INFO)
    print(describe())
    print("installed:", sorted(installed_models()))
    print("configured:", configured())
    if configured():
        print(json.dumps(json.loads(call_ollama('Return ONLY {"ok": true}')), ensure_ascii=False))
