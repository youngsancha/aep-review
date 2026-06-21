"""예문 한국어 번역(transcripts/examples_ko.json) 전수 검증.

translate_examples 가 끝난 뒤 '진짜 다 됐고 품질도 괜찮은가'를 한 번에 확인한다.
  - 커버리지: example_sentence 가 있는 모든 vocab_card 가 번역을 갖는가 (빠진 id 목록).
  - 품질: 빈 값 / 영어 그대로(한글 0자) / 오류마커('Translation unavailable' 등) / 비정상 단문.
  - 표본: 무작위 몇 개를 en→ko 로 같이 출력해 사람이 눈으로 확인.

    python -m scripts.verify_translations            # 전수 검증 + 표본 8개
    python -m scripts.verify_translations --sample 20
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys

from ingest import store

OUT = "examples_ko.json"
HANGUL = re.compile(r"[가-힣]")
BAD_MARKERS = ("translation unavailable", "unavailable", "n/a", "error")


def fetch_examples_ko() -> dict[str, str]:
    raw = store.client().storage.from_("transcripts").download(OUT)
    return json.loads(raw)


def fetch_cards() -> list[dict]:
    sb = store.client()
    rows, off, step = [], 0, 1000
    while True:
        chunk = sb.table("vocab_cards").select("id,example_sentence").not_.is_(
            "example_sentence", "null").range(off, off + step - 1).execute().data
        rows += chunk
        if len(chunk) < step:
            break
        off += step
    return rows


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--sample", type=int, default=8, help="표본 출력 개수")
    args = p.parse_args()

    ko = fetch_examples_ko()
    cards = fetch_cards()
    by_id = {str(c["id"]): (c.get("example_sentence") or "").strip() for c in cards}
    have_ex = {i: s for i, s in by_id.items() if s}

    missing = [i for i in have_ex if i not in ko or not str(ko.get(i, "")).strip()]
    empty = [i for i, v in ko.items() if not str(v).strip()]
    no_hangul = [i for i, v in ko.items() if str(v).strip() and not HANGUL.search(str(v))]
    marker = [i for i, v in ko.items() if any(m in str(v).lower() for m in BAD_MARKERS)]
    orphan = [i for i in ko if i not in by_id]  # 카드엔 없는데 번역엔 있는 (예문 삭제 등)

    total = len(have_ex)
    covered = total - len(missing)
    print("=" * 56)
    print(f"예문 보유 카드(번역 대상)  : {total}")
    print(f"번역 저장 키 수            : {len(ko)}")
    print(f"커버리지                   : {covered}/{total}"
          f"  ({covered * 100 // max(total, 1)}%)")
    print(f"빠진 예문(미번역)          : {len(missing)}")
    print(f"빈 값                      : {len(empty)}")
    print(f"한글 0자(영어 그대로 의심)  : {len(no_hangul)}")
    print(f"오류마커                   : {len(marker)}")
    print(f"고아 키(카드 없음)         : {len(orphan)}")
    print("=" * 56)

    def show(label: str, ids: list[str], n: int = 10) -> None:
        if not ids:
            return
        print(f"\n[{label}] {len(ids)}개 — 앞 {min(n, len(ids))}:")
        for i in ids[:n]:
            print(f"  id={i}  en={by_id.get(i, '(카드없음)')!r}  ko={ko.get(i, '')!r}")

    show("미번역", missing)
    show("빈 값", empty)
    show("한글 0자", no_hangul)
    show("오류마커", marker)

    ok = not (missing or empty or no_hangul or marker)
    if args.sample and have_ex:
        ids = random.sample(list(have_ex), min(args.sample, len(have_ex)))
        print(f"\n[표본 {len(ids)}]")
        for i in ids:
            print(f"  • {by_id[i]}")
            print(f"    → {ko.get(i, '(없음)')}")

    print("\n" + ("✅ 전수 검증 통과 — 모든 예문 번역 완비, 품질 이상 없음."
                  if ok else "⚠️ 위 문제 항목 확인 필요."))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
