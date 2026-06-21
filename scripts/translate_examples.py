"""모든 vocab 예문(Shana 문장)을 한국어로 미리 번역 → Storage(transcripts/examples_ko.json) 저장.

Study 카드의 KR 버튼이 온디맨드 번역(MyMemory) 없이 '즉시·고품질' 한국어를 보여주도록 사전 생성한다.
claude CLI 배치 번역(자연스러운 구어체). 멱등: Storage 의 기존 결과를 이어받아 빠진 것만 번역하고
배치마다 체크포인트 업로드(중간에 끊겨도 이어하기).

    python -m scripts.translate_examples            # 전체
    python -m scripts.translate_examples --limit 80 # 테스트(앞 80개만)
"""
from __future__ import annotations

import argparse
import json
import logging
import sys

from ingest import store
from ingest.extract_vocab import call_claude

log = logging.getLogger("translate_examples")
OUT = "examples_ko.json"   # transcripts 버킷(공개) — db.js 가 fetch
BATCH = 40


def load_existing() -> dict[str, str]:
    try:
        raw = store.client().storage.from_("transcripts").download(OUT)
        return json.loads(raw)
    except Exception:
        return {}


def save(m: dict[str, str]) -> None:
    payload = json.dumps(m, ensure_ascii=False).encode("utf-8")
    store.client().storage.from_("transcripts").upload(
        path=OUT, file=payload,
        file_options={"content-type": "application/json", "upsert": "true"},
    )


def build_prompt(batch: list[dict]) -> str:
    items = [{"id": r["id"], "en": r["example_sentence"]} for r in batch]
    return (
        "You translate for a Korean learner of American English. Translate each English sentence into "
        "natural, conversational Korean (구어체로 자연스럽게, 의미 정확하게, 너무 딱딱하지 않게). Keep it concise. "
        "Return ONLY a JSON object mapping each id (string key) to its Korean translation — no commentary, "
        "no code fence.\n\n" + json.dumps(items, ensure_ascii=False)
    )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None, help="앞 N개만(테스트)")
    args = p.parse_args()

    sb = store.client()
    rows, off, step = [], 0, 1000   # Supabase 기본 1000행 캡 → range 페이지네이션으로 전체(3333)
    while True:
        chunk = sb.table("vocab_cards").select("id,example_sentence").not_.is_(
            "example_sentence", "null").range(off, off + step - 1).execute().data
        rows += chunk
        if len(chunk) < step:
            break
        off += step
    done = load_existing()
    todo = [r for r in rows if str(r["id"]) not in done and (r.get("example_sentence") or "").strip()]
    if args.limit:
        todo = todo[: args.limit]
    log.info("번역 대상 %d개 (이미 %d) / 예문보유 %d", len(todo), len(done), len(rows))

    for i in range(0, len(todo), BATCH):
        batch = todo[i:i + BATCH]
        try:
            res = call_claude(build_prompt(batch))
        except Exception:
            log.exception("배치 실패 i=%d → 건너뜀", i)
            continue
        added = 0
        for r in batch:
            ko = res.get(str(r["id"])) if isinstance(res, dict) else None
            if ko is None and isinstance(res, dict):
                ko = res.get(r["id"])
            if isinstance(ko, str) and ko.strip():
                done[str(r["id"])] = ko.strip()
                added += 1
        save(done)   # 배치 체크포인트
        log.info("배치 %d–%d: +%d (누적 %d/%d)", i, i + len(batch), added, len(done), len(rows))

    log.info("완료: 총 %d 예문 번역 저장(transcripts/%s)", len(done), OUT)


if __name__ == "__main__":
    main()
