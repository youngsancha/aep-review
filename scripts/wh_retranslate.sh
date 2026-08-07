#!/usr/bin/env bash
# Refill the Korean pre-translation (_ko.json) for the White House briefings after a resegment change.
#
# Why: `_ko.json` is keyed by the sentence text that resegment() produces. Changing sentence
# boundaries changes those keys, so the affected lines silently fall back to on-demand translation
# (and to nothing at all offline). The v1.63.0 boundary fix moved ~10% of the sentences in these
# episodes, so their pre-translations have to be topped up.
#
# translate_transcripts only translates keys that are missing, so this is cheap and re-runnable:
# an episode that is already complete costs one read and exits.
#
# ⚠ Skips the newest wh episode by id — the ingest LaunchAgent (com.roy.aep-wh-ingest) may be
# writing that episode's _ko.json right now, and two writers on one file lose work.
set -uo pipefail
ROOT="$HOME/projects/aep-review"
PY="$ROOT/.venv/bin/python"
LOG="$HOME/Library/Logs/aep-wh-retranslate.log"
PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"; export PATH
cd "$ROOT" || exit 1

for v in SUPABASE_URL SUPABASE_SERVICE_KEY R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  val="$(ccsecret get aep-review "$v" 2>/dev/null || true)"
  [ -n "$val" ] && export "$v=$val"
done

say() { echo "[$(date '+%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

ids="$("$PY" - <<'PY'
import os, json, urllib.request
u, k = os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"]
r = json.load(urllib.request.urlopen(urllib.request.Request(
    f"{u}/rest/v1/episodes?select=id&show=eq.wh&transcribed_at=not.is.null&order=id.asc",
    headers={"apikey": k, "Authorization": f"Bearer {k}"})))
ids = [x["id"] for x in r]
print(" ".join(str(i) for i in ids[:-1]))   # drop the newest — the ingest may own it
PY
)"

say "=== wh retranslate start: $ids ==="
for ep in $ids; do
  say "--- ep $ep ---"
  "$PY" -m scripts.translate_transcripts --only "$ep" >>"$LOG" 2>&1 \
    || say "ep $ep failed (continuing)"
done
say "=== wh retranslate done ==="
