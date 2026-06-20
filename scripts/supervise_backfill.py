"""백필 슈퍼바이저 — 하드 크래시에도 재STT 그라인드를 무인 완주시킨다.

배경: faster-whisper(CUDA)는 드물게 드라이버/런타임 레벨 폴트로 **프로세스가 통째로 죽는다**.
이건 Python try/except 로 못 잡는다(실제로 06-20 10:06 ep93 처리 중 트레이스백 없이 사멸 →
4시간 그라인드 정지). 따라서 외부 프로세스가 죽음을 감지해 재기동해야 한다.

전략:
  - 기존 retranscribe(--all --from-r2 --limit N) 를 서브프로세스로 반복 기동.
  - 한 번 죽으면(rc≠0 또는 done 미증가) 즉시 재기동 → done 트래커가 끝난 회차를 건너뛰므로
    크래시 직전 회차부터 자동으로 이어감(멱등).
  - 같은(맨 앞) 회차에서 STALL_MAX 번 연속 진척 0 이면 그 회차를 '독성'으로 보고
    data/retranscribe_skip.json 에 격리한다. done(=완벽싱크) 에는 **절대** 넣지 않으므로
    verify/보고에서 정직하게 '미동기화'로 남는다. 그 뒤 다음 회차로 진행.
  - 전 회차가 done(또는 skip) 이면 verify_done 을 돌리고 종료.

실행:
    python -m scripts.supervise_backfill
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

from ingest import store

log = logging.getLogger("supervise")

DONE = store.PROJECT_ROOT / "data" / "retranscribe_done.json"
SKIP = store.PROJECT_ROOT / "data" / "retranscribe_skip.json"
STALL_MAX = 3          # 같은 회차서 연속 '진척 0' 이 이만큼이면 독성으로 격리
RELAUNCH_PAUSE = 3     # 재기동 사이 짧은 숨고르기(초)


def load_set(p: Path) -> set[int]:
    try:
        return set(json.loads(p.read_text(encoding="utf-8")))
    except Exception:
        return set()


def save_set(p: Path, s: set[int]) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(sorted(s)), encoding="utf-8")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [SUP] %(message)s")
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # Windows cp949 콘솔 보호
    except Exception:
        pass

    # 그라인드와 동일 순서: vocab 많은(자주 학습) 회차 먼저 → 예문 정확도가 학습지점에 빨리 도달.
    from scripts.retranscribe import _vocab_counts
    order = [r["id"] for r in store.episodes_by_recency()]
    vc = _vocab_counts()
    order.sort(key=lambda i: vc.get(i, 0), reverse=True)
    total = len(order)
    log.info("슈퍼바이저 시작: 전체 %d회차", total)

    env = {
        **os.environ,
        "AEP_WHISPER_DEVICE": "cuda",
        "AEP_WHISPER_BEAM": "1",
        "AEP_WHISPER_MODEL": "small.en",
    }
    cmd = [sys.executable, "-m", "scripts.retranscribe", "--all", "--from-r2", "--by-vocab", "--limit", "300"]

    stall = 0
    while True:
        done = load_set(DONE)
        skip = load_set(SKIP)
        remaining = [i for i in order if i not in done and i not in skip]
        log.info("진행: done=%d skip=%d remaining=%d / %d", len(done), len(skip), len(remaining), total)
        if not remaining:
            log.info("✅ 전 회차 종료. done=%d skip=%d (skip 은 미동기화로 남음)", len(done), len(skip))
            break

        before = len(done)
        head = remaining[0]
        log.info("그라인드 기동 (다음 회차 ep=%s, 남은 %d)…", head, len(remaining))
        try:
            rc = subprocess.run(cmd, env=env).returncode
        except Exception as e:  # 기동 자체 실패(드묾)
            log.exception("그라인드 기동 실패: %s", e)
            rc = -999
        after = len(load_set(DONE))
        log.info("그라인드 종료 rc=%s, done %d→%d (+%d)", rc, before, after, after - before)

        if after > before:
            stall = 0
        else:
            stall += 1
            log.warning("진척 0 (연속 %d/%d) — 맨 앞 ep=%s 의심", stall, STALL_MAX, head)
            if stall >= STALL_MAX:
                skip.add(head)
                save_set(SKIP, skip)
                log.error("☠️ ep=%s 독성 격리(skip.json). done 엔 안 넣음 → 미동기화로 보고됨.", head)
                stall = 0
        time.sleep(RELAUNCH_PAUSE)

    log.info("최종 검증(verify_done) 실행…")
    subprocess.run([sys.executable, "-m", "scripts.verify_done"], env=env)
    log.info("슈퍼바이저 종료.")


if __name__ == "__main__":
    main()
