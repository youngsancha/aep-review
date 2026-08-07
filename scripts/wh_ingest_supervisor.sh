#!/usr/bin/env bash
# Supervise scripts/wh_ingest_all.sh until every White House briefing is ingested.
#
# Why this exists. The driver is a plain loop with two failure modes that a ~30-hour job
# will absolutely hit:
#   1. It dies with the shell that launched it. That happened: a session ended, SIGHUP took
#      the driver down, and only its orphaned faster-whisper child survived — leaving one
#      episode with STT but no vocab/speech/translation, and 49 briefings never started.
#   2. It `break`s on the FIRST ingest failure. A transient yt-dlp bot check or an R2 blip
#      then parks the whole backlog until a human notices.
# So: run in our own session (setsid, see below), finish whatever the last run left half-done,
# and restart the driver on failure instead of parking.
#
# Everything downstream is idempotent (wh_fetch skips known guids, kokoro_pregen skips existing
# keys, translate_transcripts checkpoints per sentence), so a restart is always safe.
#
# Usage:
#   scripts/wh_ingest_supervisor.sh
#   AEP_FINISH_EP=568 scripts/wh_ingest_supervisor.sh   # also finish a half-done episode first
#
# Run it under launchd, not from a shell: `com.roy.aep-wh-ingest` (RunAtLoad, restart on failure).
# macOS ships no `setsid`, so there is no reliable way to detach a 30-hour job from the terminal
# that started it — launchd owns its own session and survives a reboot too. Start/stop with
#   launchctl kickstart -k gui/$UID/com.roy.aep-wh-ingest
#   launchctl bootout gui/$UID/com.roy.aep-wh-ingest
set -uo pipefail
ROOT="$HOME/projects/aep-review"
PY="$ROOT/.venv/bin/python"
LOG="$HOME/Library/Logs/aep-wh-all.log"
PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"; export PATH
cd "$ROOT" || exit 1

say() { echo "[$(date '+%m-%d %H:%M:%S')] [sup] $*" | tee -a "$LOG"; }

for v in SUPABASE_URL SUPABASE_SERVICE_KEY R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  val="$(ccsecret get aep-review "$v" 2>/dev/null || true)"
  [ -n "$val" ] && export "$v=$val"
done

remaining() {
  "$PY" - <<'PY' 2>/dev/null
from ingest.wh_fetch import discover_new
print(len(discover_new(None)))
PY
}

# 0. One supervisor at a time. launchd restarts on failure, and a human may also kickstart it.
LOCK="$HOME/Library/Caches/aep-wh-ingest.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  say "another supervisor holds $LOCK — exiting (this is not an error)"; exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# 1. An earlier run may still own the audio/STT stage — its shell can be gone while the
#    faster-whisper child lives on. Two drivers on the same episode race on the same transcript
#    JSON, so wait that orphan out rather than starting alongside it.
while orphan="$(pgrep -f 'ingest\.wh_fetch' | head -1)"; [ -n "$orphan" ]; do
  say "in-flight ingest pid $orphan still running — waiting…"
  while kill -0 "$orphan" 2>/dev/null; do sleep 30; done
  say "pid $orphan gone"
done

# 2. That orphan finished its STT but its parent was already dead, so nobody ran the three
#    stages after it. Do them here, then consume the request file so a launchd restart does not
#    repeat it — extract_vocab calls an LLM per episode, so repeating it costs real money.
FINISH_FILE="$HOME/Library/Caches/aep-wh-finish-ep"
[ -z "${AEP_FINISH_EP:-}" ] && [ -f "$FINISH_FILE" ] && AEP_FINISH_EP="$(cat "$FINISH_FILE")"
if [ -n "${AEP_FINISH_EP:-}" ]; then
  ep="$AEP_FINISH_EP"
  say "finishing episode $ep left half-done by the previous run (vocab/speech/translation)"
  "$PY" -m ingest.extract_vocab --episode "$ep" >>"$LOG" 2>&1 || say "vocab failed for $ep (continuing)"
  scripts/kokoro_pregen.sh >>"$LOG" 2>&1 || say "kokoro failed for $ep (continuing)"
  "$PY" -m scripts.translate_transcripts --only "$ep" >>"$LOG" 2>&1 || say "translation failed for $ep (continuing)"
  rm -f "$FINISH_FILE"
  say "=== episode $ep COMPLETE (recovered by supervisor) ==="
fi

# 3. Supervise. The attempt cap is a runaway guard, not a schedule: a healthy run needs exactly
#    one attempt because the driver itself loops over every remaining briefing.
MAX_ATTEMPTS=40
BACKOFF=300
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  left="$(remaining || echo unknown)"
  say "attempt $attempt/$MAX_ATTEMPTS — remaining briefings: $left"
  if [ "$left" = "0" ]; then say "all briefings ingested — supervisor exiting"; exit 0; fi
  scripts/wh_ingest_all.sh
  say "driver exited (attempt $attempt); sleeping ${BACKOFF}s before re-checking"
  sleep "$BACKOFF"
done
say "supervisor gave up after $MAX_ATTEMPTS attempts — inspect $LOG"
exit 1
