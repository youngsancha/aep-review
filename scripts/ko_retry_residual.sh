#!/usr/bin/env bash
# Daily retry of the Korean sentences that are still missing (Roy, 2026-11-26: "남은 문장 매일
# 자동으로 다시 시도하게 해줘" (retry the remaining sentences automatically every day)).
#
# Why a separate step: ko_quality_pass.sh only covers the newest N episodes per show, and it runs
# ollama at temperature 0, so a sentence the quality gate rejected gets the same rejected answer
# again. This step:
#   1. audits EVERY episode and lists those with a gap (sentences without a _ko.json key);
#   2. re-runs translate_transcripts on just those, with AEP_OLLAMA_TEMPERATURE and a per-day
#      AEP_OLLAMA_SEED, so each day draws a different candidate. sane_translation() and the
#      alignment checks still decide what is saved; nothing weaker gets in.
# Idempotent: only missing keys are tried; every save stamps ko_at, so phones pick it up.
#
#   bash scripts/ko_retry_residual.sh          # all gap episodes
#   KO_RETRY_LIMIT=50 bash scripts/ko_retry_residual.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
STATE="$HOME/Library/Application Support/aep-review"
LOCK="$STATE/ko-quality.lock"          # same lock as ko_quality_pass.sh: one _ko.json writer at a time
AUDIT="$STATE/ko_residual_audit.json"
IDS="$STATE/ko_residual_ids.txt"
TEMP="${KO_RETRY_TEMPERATURE:-0.6}"
LIMIT="${KO_RETRY_LIMIT:-}"
mkdir -p "$STATE"
say() { echo "[$(date '+%m-%d %H:%M:%S')] ko-retry: $*"; }
cd "$ROOT" || exit 1

if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && kill -0 "$(cat "$LOCK/pid")" 2>/dev/null; then
    say "another _ko.json writer is running (pid $(cat "$LOCK/pid")): skip today"; exit 0
  fi
  rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT INT TERM

"$PY" -m scripts.audit_ko_coverage --all --json "$AUDIT" >/dev/null 2>&1 || { say "audit failed"; exit 1; }
"$PY" - "$AUDIT" "$IDS" "$LIMIT" <<'PY' || exit 1
import json, sys
rows = json.load(open(sys.argv[1]))["episodes"]
# Gap = sentences without a key. An episode with no transcript has sent=0 and is skipped.
gap = [r for r in rows if (r.get("sent") or 0) > (r.get("hit") or 0)]
gap.sort(key=lambda r: -r["id"])                 # newest first: the ones people play
if sys.argv[3]:
    gap = gap[: int(sys.argv[3])]
open(sys.argv[2], "w").write("".join(f"{r['id']}\n" for r in gap))
print(f"{len(gap)} episodes, {sum(r['sent'] - r['hit'] for r in gap)} sentences missing")
PY
n=$(wc -l < "$IDS" | tr -d ' ')
[ "$n" -gt 0 ] || { say "nothing missing"; exit 0; }

SEED=$(( $(date +%Y) * 1000 + 10#$(date +%j) ))
say "retrying at temperature $TEMP, seed $SEED"
RUNLOG="$HOME/Library/Logs/aep-ko-retry.log"
echo "=== $(date '+%F %T') seed $SEED ===" >> "$RUNLOG"
AEP_LLM_BACKEND=ollama AEP_OLLAMA_TEMPERATURE="$TEMP" AEP_OLLAMA_SEED="$SEED" \
  "$PY" -m scripts.translate_transcripts --ids "@$IDS" >> "$RUNLOG" 2>&1
rc=$?
# Summary lines only into the daily-loop log; the full run is in $RUNLOG.
tail -n 400 "$RUNLOG" | grep -E "완료:|저장 거절|Traceback" | tail -4
say "done rc=$rc"
exit "$rc"
