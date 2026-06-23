"""transcript JSON → 학습 가치 있는 vocab/idiom/collocation 추출.

Claude Max 사용자 — `claude -p` (Claude Code CLI) subprocess 호출 사용.
Anthropic API 직접 호출 금지 (Max 이중과금).

흐름:
  1. transcribe_pending 가 만든 data/transcripts/{ep_id}.json 읽기
  2. segments 의 text 들을 합쳐 transcript 한 덩어리로 (max ~8000 토큰)
  3. PROMPT 와 함께 `claude -p --output-format json` stdin 으로 주입
  4. stdout JSON 파싱 → vocab_cards 테이블 + srs_cards 시드
"""
from __future__ import annotations

import asyncio
import json
import logging
import subprocess
from typing import Any

from ingest import store

log = logging.getLogger(__name__)


def _build_transcript_text(transcript: dict[str, Any], max_chars: int = 24000) -> str:
    """segments → 평문. 너무 길면 잘라냄 (Claude context 보호)."""
    parts: list[str] = []
    total = 0
    for seg in transcript.get("segments", []):
        t = seg.get("text", "").strip()
        if not t:
            continue
        # [start-end] text 형식 — Claude 가 sentence_start_sec 알도록 메타 포함
        line = f"[{seg['start']:.1f}-{seg['end']:.1f}] {t}"
        if total + len(line) > max_chars:
            break
        parts.append(line)
        total += len(line) + 1
    return "\n".join(parts)


def build_prompt(episode_title: str, transcript_text: str) -> str:
    """Claude 에 보낼 vocab 추출 프롬프트.

    TODO(human) 영역 — 사용자 본인이 학습 수준/취향에 맞춰 작성.

    아래 EXAMPLE 프롬프트는 placeholder. 다음 항목을 본인 기준으로 정의:
      1. "학습 가치 있는" 단어/표현이란? (idiom / phrasal verb / collocation /
         American slang / academic vocab / 일상 회화 표현 ...)
      2. 너무 쉬운 단어 (the, is, go ...) 는 어떻게 거를지
      3. 너무 어려운 / 너무 marginal 한 단어는?
      4. 에피소드당 추출할 최대 개수 (예: 8-15개)
      5. definition 길이/언어 (영어 / 한영 혼합 / 한국어만)
      6. example_sentence 는 transcript 그대로 vs Claude 가 다듬기
    """
    EXAMPLE_PROMPT = """\
You are helping a Korean learner (B2–C1, lives in the SF Bay Area) review the
American English Podcast hosted by Shana Thompson. Extract 8 to 12 high-value
vocabulary items from the transcript below.

Selection criteria, in priority order:
  1. Idioms and fixed expressions ("hit the ground running", "ballpark figure")
  2. Phrasal verbs whose meaning isn't obvious from the parts ("come across as",
     "blow off")
  3. Strong collocations a learner wouldn't guess ("suffer from allergies",
     "boilerplate contract")
  4. American slang or cultural references ("Roswell", "the Bay", "freshman 15")
  5. Useful single words above the top-2000-most-common list (e.g. "boilerplate",
     "quirky"), but skip basic vocabulary the learner already knows
     (the, get, go, big, take, etc.)

Avoid:
  - Filler words, proper nouns of one-time guests, numbers
  - Items that already appeared in earlier vocab cards (you don't have that
    history; just skip anything that feels too generic)

For each item, write the definition in this format:
  "<short English definition> (<short Korean gloss>)"
e.g.  "to seem to be a certain way based on impression (~인 인상을 주다)"

Use the example_sentence verbatim from the transcript line containing the term
(do NOT paraphrase) and copy its [start-end] timestamp into
sentence_start_sec / sentence_end_sec so the PWA can jump the audio there."""

    schema_hint = """
Return ONLY a JSON object (no markdown, no prose) of this shape:
{
  "vocab": [
    {
      "term": "boilerplate",
      "kind": "word",
      "definition": "standard text used repeatedly without thinking",
      "example_sentence": "This contract is just boilerplate.",
      "sentence_start_sec": 123.4,
      "sentence_end_sec": 128.1
    }
  ]
}
kind ∈ {"word", "idiom", "collocation", "phrasal_verb"}.
sentence_start_sec / sentence_end_sec — copy from the [start-end] markers in the transcript line containing the term.
""".strip()

    return (
        f"{EXAMPLE_PROMPT}\n\n"
        f"Episode title: {episode_title}\n\n"
        f"Transcript (each line prefixed with [start-end] timestamps in seconds):\n"
        f"---\n{transcript_text}\n---\n\n"
        f"{schema_hint}"
    )


def call_claude(prompt: str, timeout_sec: int = 300) -> dict[str, Any]:
    """Claude Code CLI 호출. stdin 으로 prompt 주입, stdout 에서 JSON 받기.

    `claude -p --output-format json --permission-mode bypassPermissions`
      -p: print mode (non-interactive)
      --output-format json: 마지막 응답을 JSON 으로 wrap
      --permission-mode bypassPermissions: 도구 호출 prompt 없이 진행 (여기서는 도구 없음)
    """
    cmd = ["claude", "-p", "--output-format", "json"]
    log.info("calling claude CLI prompt_chars=%d", len(prompt))
    proc = subprocess.run(
        cmd,
        input=prompt,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout_sec,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude CLI failed rc={proc.returncode}: {proc.stderr[:500]}")

    # claude --output-format json 응답: 보통 {"result": ...} dict 이지만, CLI 버전에 따라
    # 메시지/이벤트 배열(list)로 오기도 한다 → 둘 다 처리.
    try:
        envelope = json.loads(proc.stdout)
    except json.JSONDecodeError:
        envelope = {"result": proc.stdout}
    return _parse_vocab_json(_result_text(envelope, proc.stdout))


def _result_text(envelope: Any, raw: str) -> str:
    if isinstance(envelope, dict):
        return envelope.get("result") or raw
    if isinstance(envelope, list):
        # type=="result" 항목 우선 (claude CLI 최종 결과 이벤트)
        for it in reversed(envelope):
            if isinstance(it, dict) and it.get("type") == "result" and isinstance(it.get("result"), str):
                return it["result"]
        # 없으면 마지막 assistant 메시지의 text 블록 수집
        for it in reversed(envelope):
            if isinstance(it, dict):
                msg = it.get("message")
                if isinstance(msg, dict) and isinstance(msg.get("content"), list):
                    txt = "".join(c.get("text", "") for c in msg["content"]
                                  if isinstance(c, dict) and c.get("type") == "text")
                    if txt.strip():
                        return txt
        return raw
    return raw


def _parse_vocab_json(text: str) -> dict[str, Any]:
    """Claude 응답에서 JSON object 추출. ```json fence / 앞뒤 prose 제거."""
    s = text.strip()
    # ```json 펜스 제거
    if s.startswith("```"):
        s = s.split("\n", 1)[-1] if "\n" in s else s
        if s.endswith("```"):
            s = s.rsplit("```", 1)[0]
    # 첫 { 부터 매칭되는 } 까지
    if "{" in s:
        depth = 0
        start = s.index("{")
        for i in range(start, len(s)):
            c = s[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    s = s[start:i + 1]
                    break
    return json.loads(s)


def extract_for_episode(episode_id: int, title: str | None = None, show: str = "aep") -> int:
    """episode 1건 처리: transcript(Storage) → claude → vocab+srs+TTS write. 반환: vocab 수.
    show = episode.show (vocab/srs 비정규화 라벨)."""
    transcript = store.download_transcript(episode_id)
    if not transcript:
        raise ValueError(f"episode {episode_id} transcript 없음")
    if title is None:
        title = store.episode_title(episode_id) or ""

    text = _build_transcript_text(transcript)
    prompt = build_prompt(title, text)
    parsed = call_claude(prompt)

    vocab_list = parsed.get("vocab", [])
    if not isinstance(vocab_list, list):
        raise ValueError(f"unexpected vocab shape: {type(vocab_list)}")

    added, tts_texts = store.insert_vocab_and_srs(episode_id, vocab_list, show)
    if tts_texts:
        asyncio.run(store.pregen_tts(tts_texts))  # 새 term/example 발음 미리 생성
    store.mark_vocab_extracted(episode_id)
    return added


def extract_pending(limit: int | None = None, show: str | None = None) -> int:
    """transcript 있고 vocab 미추출인 episode 처리. show 지정 시 그 쇼만(None=전체). 반환: 처리 수."""
    count = 0
    rows = store.episodes_needing_vocab(show)
    for row in rows:
        if limit and count >= limit:
            break
        try:
            n = extract_for_episode(row["id"], row.get("title"), row.get("show") or "aep")
        except Exception:
            log.exception("extract_vocab failed ep=%s", row["id"])
            continue
        log.info("extracted ep=%s vocab=%d", row["id"], n)
        count += 1
    return count


if __name__ == "__main__":
    import argparse
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser()
    p.add_argument("--episode", type=int, default=None, help="단일 episode 처리")
    p.add_argument("--limit", type=int, default=None)
    args = p.parse_args()
    if args.episode:
        n = extract_for_episode(args.episode)
        log.info("episode=%d vocab=%d", args.episode, n)
    else:
        n = extract_pending(limit=args.limit)
        log.info("processed=%d episodes", n)
