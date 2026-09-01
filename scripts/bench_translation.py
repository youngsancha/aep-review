"""번역 백엔드/모델을 실제 회차로 실측 비교 — 모델 선택의 유일한 근거.

왜 이 스크립트가 필요한가 (2026-09-01):
  번역 백엔드는 '되는지 안 되는지'를 눈으로 못 본다. 작은 로컬 모델은 실패를 에러가 아니라
  **자연스러운 한국어**로 돌려주기 때문이다. 실제로 이 프로젝트에서 나온 두 가지 고장은 둘 다
  HTTP 200 + 유효한 JSON 이었다:
    ① 뜻이 틀림     qwen2.5:7b — "piece of cake" → '케이크 한 조각', "a crummy day" → '날씨가 나쁘다'
    ② 줄이 밀림     exaone3.5:7.8b @ batch=32 — 32줄을 29개로 병합하고 번호를 다시 매김
  ②는 개별 문장을 아무리 봐도 못 잡는다(각각은 멀쩡하다). 그래서 이 스크립트는 두 가지를 함께 잰다:
  **정렬 성공률**(배치 크기별)과 **기존 번역과의 나란히 비교**(뜻).

    python -m scripts.bench_translation --ids 250            # 기존 _ko.json 을 정답지로 나란히 비교
    python -m scripts.bench_translation --ids 1026 --batches 1,2,4,8
    AEP_OLLAMA_MODEL=qwen2.5:7b python -m scripts.bench_translation --ids 250

⛔ 배치 크기는 백엔드마다 다르다(translate_transcripts.batch_size). 모델을 바꾸면 정렬이 살아나는
   배치 크기도 달라지므로, 모델 교체 시 --batches 로 반드시 다시 재고 OLLAMA_BATCH 를 맞출 것.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import time
import urllib.request

from scripts.translate_transcripts import (
    CTX_BEFORE,
    _call_llm,
    align_batch,
    build_prompt,
    resegment,
    trkey,
)

log = logging.getLogger("bench_translation")
PUBLIC = "https://lbcvuztpyaapyckxmqhk.supabase.co/storage/v1/object/public/transcripts"


def _public_json(name: str):
    """공개 Storage 에서 직접 받는다 — 이 스크립트는 읽기 전용이라 service key 가 필요 없다."""
    with urllib.request.urlopen(f"{PUBLIC}/{name}", timeout=60) as r:
        return json.load(r)


def bench(ep_id: int, batches: list[int], limit: int) -> None:
    tr = _public_json(f"{ep_id}.json")
    sents = [s for s in resegment(tr.get("segments", [])) if s.strip()][:limit]
    try:
        ref = _public_json(f"{ep_id}_ko.json")
    except Exception:
        ref = {}
    backend = os.environ.get("AEP_LLM_BACKEND") or "claude-cli"
    model = os.environ.get("AEP_OLLAMA_MODEL", "")
    print(f"\nep {ep_id} · 문장 {len(sents)} · backend={backend} {model} · 정답지 {len(ref)}키")

    best = None
    for n in batches:
        ok = tot = 0
        t0 = time.time()
        produced: dict[int, str] = {}
        for start in range(0, len(sents), n):
            lines = sents[start:start + n]
            if not lines:
                break
            ctx = " ".join(sents[max(0, start - CTX_BEFORE):start])
            try:
                res = _call_llm(build_prompt(lines, ctx), n_lines=len(lines))
            except Exception as e:                       # noqa: BLE001 — 벤치는 계속 돌아야 한다
                log.warning("배치 실패: %s", e)
                tot += len(lines)
                continue
            kos, _why = align_batch(res, lines)
            for j, k in enumerate(kos):
                if k:
                    produced[start + j] = k
            ok += sum(1 for k in kos if k)
            tot += len(lines)
        dt = time.time() - t0
        rate = ok / max(tot, 1)
        print(f"  batch={n:3d}  정렬성공 {ok:3d}/{tot:3d} ({rate:5.1%})  {dt:5.0f}s  ({dt/max(tot,1):.1f}s/문장)")
        if best is None or rate > best[1]:
            best = (n, rate, produced)

    if best and ref:
        n, _rate, produced = best
        print(f"\n  ── batch={n} 결과를 기존 번역과 나란히 (뜻 확인은 사람 몫) ──")
        shown = 0
        for i, s in enumerate(sents):
            k = trkey(s)
            if i not in produced or k not in ref:
                continue
            print(f"\n  EN   {s[:100]}")
            print(f"  기존 {ref[k][:100]}")
            print(f"  신규 {produced[i][:100]}")
            shown += 1
            if shown >= 10:
                break
        if not shown:
            print("  (겹치는 문장이 없다 — 이 회차엔 기존 번역이 없거나 키가 어긋났다)")


def main() -> None:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    p = argparse.ArgumentParser()
    p.add_argument("--ids", default="250", help="쉼표로 구분한 에피소드 id")
    p.add_argument("--batches", default="1,4,16", help="시험할 배치 크기들")
    p.add_argument("--limit", type=int, default=24, help="회차당 앞 N문장만")
    a = p.parse_args()
    for ep in [int(x) for x in a.ids.split(",") if x.strip()]:
        bench(ep, [int(x) for x in a.batches.split(",") if x.strip()], a.limit)


if __name__ == "__main__":
    main()
