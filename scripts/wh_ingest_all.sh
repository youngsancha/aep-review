#!/usr/bin/env bash
# Ingest every remaining White House briefing, completing ONE episode fully before starting the next.
#
# Per-episode order matters: audio -> R2 -> STT -> vocab -> Kokoro speech -> Korean pre-translation.
# A 35-hour job WILL be interrupted (reboot, failure, someone closing the lid). Batching by stage
# would leave a pile of transcript-less rows at hour 20; completing each episode leaves N finished
# episodes plus untouched work, which just resumes.
#
# Resumable: wh_fetch skips guids already in the DB, kokoro_pregen skips existing keys, and
# translate_transcripts checkpoints per sentence. Re-running is always safe.
set -uo pipefail
ROOT="$HOME/projects/aep-review"
PY="$ROOT/.venv/bin/python"
LOG="$HOME/Library/Logs/aep-wh-all.log"
cd "$ROOT"

for v in SUPABASE_URL SUPABASE_SERVICE_KEY R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  val="$(ccsecret get aep-review "$v" 2>/dev/null || true)"
  [ -n "$val" ] && export "$v=$val"
done

newest_wh_id() {
  "$PY" - <<'PY'
import os, json, urllib.request
u, k = os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"]
r = json.load(urllib.request.urlopen(urllib.request.Request(
    f"{u}/rest/v1/episodes?select=id&show=eq.wh&order=id.desc&limit=1",
    headers={"apikey": k, "Authorization": f"Bearer {k}"})))
print(r[0]["id"] if r else 0)
PY
}

remaining() {
  "$PY" - <<'PY'
from ingest.wh_fetch import discover_new
print(len(discover_new(None)))
PY
}

say() { echo "[$(date '+%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

say "=== wh_all start ==="
n=0
while : ; do
  left="$(remaining 2>/dev/null || echo 0)"
  say "remaining briefings: $left"
  [ "${left:-0}" -le 0 ] && { say "nothing left — done"; break; }

  before="$(newest_wh_id)"
  say "--- ingest one (audio -> R2 -> STT) ---"
  "$PY" -m ingest.wh_fetch --limit 1 >>"$LOG" 2>&1 || { say "INGEST FAILED — stopping"; break; }
  after="$(newest_wh_id)"
  if [ "$after" = "$before" ]; then say "no new episode appeared — stopping"; break; fi

  say "episode $after ingested; vocab…"
  "$PY" -m ingest.extract_vocab --episode "$after" >>"$LOG" 2>&1 || say "vocab failed for $after (continuing)"
  say "episode $after: kokoro speech…"
  scripts/kokoro_pregen.sh >>"$LOG" 2>&1 || say "kokoro failed for $after (continuing)"
  say "episode $after: korean pre-translation…"
  "$PY" -m scripts.translate_transcripts --only "$after" >>"$LOG" 2>&1 \
    || say "translation failed for $after (continuing)"

  n=$((n+1))
  say "=== episode $after COMPLETE ($n done this run) ==="
done
say "=== wh_all finished: $n episode(s) completed this run ==="
