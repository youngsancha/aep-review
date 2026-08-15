"""이미 있는 한국어 사전번역(_ko.json)을 '직역 → 의도·뉘앙스' 기준으로 재검수하고 고친다.

translate_transcripts 는 **멱등**이다 — 키가 없는 문장만 번역하고, 이미 있는 번역은 두 번 다시
보지 않는다. 그래서 초기(프롬프트가 "natural, not word-for-word" 한 줄이던 시절)나 haiku 로 돌린
회차의 번역은 계속 그대로 남는다. 이 스크립트가 그 잔여분을 훑는 유일한 경로다.

왜 '전량 재번역'이 아니라 '검수 후 수정'인가:
  - 전량 재번역은 잘 돼 있는 번역까지 흔들어 회귀를 만든다. 좋은 줄은 손대지 않는 게 안전하다.
  - 응답이 '고칠 것만' 담기므로 출력 토큰이 훨씬 적다(쿼터 = 이 잡의 실질 비용).
  - 무엇을 왜 고쳤는지 JSONL 감사로그로 남아, 나중에 사람이 표본 검증할 수 있다.

번역 기준은 translate_transcripts.TRANSLATION_RULES 를 그대로 재사용한다 — 두 잡이 서로 다른
기준을 쓰면 정제가 사전번역을 되돌리는 싸움이 난다.

    python -m scripts.refine_translations --ids @ids.txt
    python -m scripts.refine_translations --ids 523,524 --dry     # 저장 없이 표본 출력
    python -m scripts.refine_translations --ids @ids.txt --shard 0/4
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path

from scripts.translate_transcripts import (
    TRANSLATION_RULES,
    ClaudeUnavailable,
    _call_claude,
    fetch_transcript,
    load_existing,
    parse_ids,
    resegment,
    save_existing,
    trkey,
)
import scripts.translate_transcripts as tt

log = logging.getLogger("refine_translations")

# 검수는 한 항목이 EN+KO 두 줄이라 입력이 번역의 ~2배다 → 배치를 조금 줄인다.
BATCH = 24
CTX_BEFORE = 2
MAX_CONSECUTIVE_FAILS = 12
HANGUL = re.compile(r"[가-힣]")

STATE_DIR = Path.home() / "Library" / "Application Support" / "aep-review"
AUDIT = STATE_DIR / "ko_refine_audit.jsonl"


def build_review_prompt(items: list[dict], context_before: str) -> str:
    """items = [{"i": "0", "en": ..., "ko": ...}, ...]"""
    return (
        TRANSLATION_RULES
        + "\nYou are REVIEWING existing Korean translations of these lines, not translating from "
        "scratch. For each item decide: does the Korean make a Korean listener understand what the "
        "speaker actually meant, with the same tone?\n"
        "Flag an item ONLY if one of these is true:\n"
        "  - it is word-for-word / translationese where natural Korean differs\n"
        "  - an idiom, phrasal verb or slang was rendered by its literal parts\n"
        "  - the meaning is wrong, reversed, or a pronoun/reference points at the wrong thing\n"
        "  - the speaker's tone is lost (a joke, sarcasm or hedge flattened into a plain statement)\n"
        "  - a discourse marker was translated literally instead of by its function\n"
        "  - it is left in English, empty, or is an obvious machine-translation artifact\n"
        "If the Korean is already good, DO NOT include it. Prefer leaving a line alone when unsure — "
        "a needless rewrite is worse than an imperfect but correct line.\n"
        "Return ONLY a JSON object mapping the id of each item you are fixing to "
        '{"ko": "<corrected Korean>", "why": "<max 6 Korean words>"}. '
        "Return {} if nothing needs fixing. No code fence, no commentary.\n\n"
        f"context_before: {json.dumps(context_before, ensure_ascii=False)}\n"
        f"items: {json.dumps(items, ensure_ascii=False)}"
    )


def _acceptable(new_ko: str, old_ko: str) -> bool:
    """모델이 돌려준 수정본을 받아들일지. 조용한 품질 저하를 막는 최소 가드."""
    if not isinstance(new_ko, str):
        return False
    s = new_ko.strip()
    if not s or s == old_ko.strip():
        return False
    if not HANGUL.search(s):          # 한글이 없다 = 영어 그대로거나 깨진 응답
        return False
    if len(s) > 400:                  # 설명을 덧붙인 응답 — 학습 화면에 들어갈 한 줄이 아니다
        return False
    return True


def refine_episode(ep_id: int, *, dry: bool = False) -> tuple[int, int, int]:
    """반환 (검수한 문장 수, 고친 수, 건너뛴 수)."""
    tr = fetch_transcript(ep_id)
    if not tr:
        log.warning("ep %s 자막 없음 → 건너뜀", ep_id)
        return (0, 0, 0)
    sentences = [s for s in resegment(tr.get("segments", [])) if s.strip()]
    done = load_existing(ep_id)
    if done is None:
        log.warning("ep %s _ko.json 로드 실패(일시 오류) → 스킵(기존 보존)", ep_id)
        return (0, 0, 0)
    keys = [trkey(s) for s in sentences]
    have = [k for k in range(len(sentences)) if keys[k] in done]
    if not have:
        log.info("ep %s 검수할 번역 없음 — 먼저 translate_transcripts 를 돌려야 한다", ep_id)
        return (0, 0, 0)

    fixed = skipped = 0
    audit_lines = []
    for bstart in range(0, len(sentences), BATCH):
        idxs = [k for k in range(bstart, min(bstart + BATCH, len(sentences))) if keys[k] in done]
        if not idxs:
            continue
        ctx = " ".join(sentences[max(0, idxs[0] - CTX_BEFORE):idxs[0]])
        items = [{"i": str(n), "en": sentences[k], "ko": done[keys[k]]} for n, k in enumerate(idxs)]
        try:
            res = _call_claude(build_review_prompt(items, ctx))
            tt._consec_fails = 0
        except Exception:
            tt._consec_fails += 1
            log.exception("ep %s 배치 %d 실패 → 건너뜀 (연속 %d)", ep_id, bstart, tt._consec_fails)
            if tt._consec_fails >= MAX_CONSECUTIVE_FAILS:
                raise ClaudeUnavailable(
                    f"claude 호출이 연속 {tt._consec_fails}회 실패 — 사용 한도로 보인다. "
                    f"여기서 멈춘다(체크포인트 저장됨, 같은 명령으로 이어서 진행)."
                ) from None
            continue
        if not isinstance(res, dict):
            continue
        batch_changed = False
        for local_i, k in enumerate(idxs):
            ent = res.get(str(local_i))
            if not isinstance(ent, dict):
                continue
            new_ko, why = ent.get("ko"), str(ent.get("why", ""))[:40]
            old_ko = done[keys[k]]
            if not _acceptable(new_ko, old_ko):
                skipped += 1
                continue
            new_ko = new_ko.strip()
            audit_lines.append({"ep": ep_id, "en": sentences[k], "old": old_ko,
                                "new": new_ko, "why": why})
            if dry:
                print(f"  EN : {sentences[k]}\n  was: {old_ko}\n  now: {new_ko}   ({why})\n")
            else:
                done[keys[k]] = new_ko
                batch_changed = True
            fixed += 1
        if batch_changed and not dry:
            save_existing(ep_id, done)      # 배치 체크포인트
        if dry and fixed >= 12:
            break

    if audit_lines and not dry:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with AUDIT.open("a", encoding="utf-8") as f:
            for a in audit_lines:
                f.write(json.dumps(a, ensure_ascii=False) + "\n")
    log.info("ep %s: 검수 %d, 수정 %d, 거부 %d", ep_id, len(have), fixed, skipped)
    return (len(have), fixed, skipped)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--ids", type=str, required=True, help="'1,2,3' 또는 '@파일'")
    p.add_argument("--shard", type=str, default=None, help="'i/n' — ids[i::n] 만")
    p.add_argument("--model", default="sonnet")
    p.add_argument("--dry", action="store_true", help="저장 없이 표본만 출력")
    p.add_argument("--state", type=str, default=None,
                   help="완료 회차 기록 파일(재실행 시 건너뜀). 기본 = ~/Library/Application Support/"
                        "aep-review/ko_refine_done_<shard>.txt")
    args = p.parse_args()
    tt._MODEL = args.model or ""

    ids = parse_ids(args.ids)
    shard_tag = "all"
    if args.shard:
        i, n = (int(x) for x in args.shard.split("/"))
        ids = ids[i::n]
        shard_tag = f"{i}of{n}"
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    state = Path(args.state) if args.state else STATE_DIR / f"ko_refine_done_{shard_tag}.txt"
    already = set()
    if state.exists():
        already = {int(x) for x in re.split(r"\s+", state.read_text()) if x.strip().isdigit()}
    todo = [i for i in ids if i not in already]
    log.info("대상 %d편 (완료 %d편 건너뜀) · 모델 %s", len(todo), len(already), tt._MODEL)

    tot_r = tot_f = tot_s = 0
    for n, ep_id in enumerate(todo, 1):
        try:
            r, f, s = refine_episode(ep_id, dry=args.dry)
        except ClaudeUnavailable as e:
            log.error("중단: %s", e)
            log.error("진행: %d/%d편, 수정 %d문장", n - 1, len(todo), tot_f)
            sys.exit(2)
        tot_r += r
        tot_f += f
        tot_s += s
        if not args.dry:
            with state.open("a", encoding="utf-8") as fh:
                fh.write(f"{ep_id}\n")
        log.info("[%d/%d] ep %s — 누적 검수 %d, 수정 %d", n, len(todo), ep_id, tot_r, tot_f)
    log.info("완료: %d편, 검수 %d문장, 수정 %d문장, 거부 %d", len(todo), tot_r, tot_f, tot_s)


if __name__ == "__main__":
    main()
