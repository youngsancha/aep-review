#!/usr/bin/env bash
# wh_local.sh — run the White House ('wh') briefing ingest LOCALLY on the Mac mini.
#
# Why local instead of CI: both audio sources block datacenter IPs — YouTube (the
# whitehouse.gov pages are YouTube embeds) answers "Sign in to confirm you're not a
# bot", and C-SPAN returns HTTP 403. A residential IP passes both, so .github/workflows/
# wh-sync.yml is dispatch-only and this script is the real ingest path.
#
# Secrets: pulled from the macOS login Keychain at runtime via `ccsecret get` and
# exported as env vars — nothing secret is written to disk. python-dotenv loads .env
# with override=False, so these exported values win over the (empty) .env entries.
# Store them once:
#     pbpaste | ccsecret set aep-review SUPABASE_SERVICE_KEY   # copy the key first
#     pbpaste | ccsecret set aep-review R2_ACCESS_KEY_ID
#     pbpaste | ccsecret set aep-review R2_SECRET_ACCESS_KEY
#     pbpaste | ccsecret set aep-review R2_ENDPOINT
# (The first `ccsecret get` may raise a Keychain access dialog — choose "Always Allow".)
#
# Usage:
#     scripts/wh_local.sh --discover-only      # scrape only — works with NO credentials
#     scripts/wh_local.sh --list-only          # new slugs vs the DB (needs the Supabase key)
#     scripts/wh_local.sh --limit 2            # ingest the 2 newest unloaded briefings
#     scripts/wh_local.sh --limit 1 --no-stt   # audio + row only, transcribe later
#     scripts/wh_local.sh --cspan-urls "https://www.c-span.org/program/.../123456"
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
CCSECRET="${CCSECRET:-$HOME/.local/bin/ccsecret}"
PROJECT="aep-review"
LOG="$HOME/Library/Logs/aep-wh-local.log"

[ -x "$PY" ] || { echo "wh_local: missing venv at $PY — run: python3 -m venv .venv && .venv/bin/pip install -e ." >&2; exit 1; }

# Keychain → env. Only fills vars that are empty, so an already-exported value wins.
# Always returns 0: a missing secret is normal (it may live in .env instead), and under
# `set -e` a falsy trailing test would abort the whole script with no diagnostic.
load_secret() {
  local var="$1" val=""
  if [ -z "${!var:-}" ] && [ -x "$CCSECRET" ]; then
    val="$("$CCSECRET" get "$PROJECT" "$var" 2>/dev/null || true)"
    [ -n "$val" ] && export "$var=$val"
  fi
  return 0
}

for v in SUPABASE_URL SUPABASE_SERVICE_KEY R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_PUBLIC_BASE; do
  load_secret "$v"
done

# .env still supplies the non-secret values (SUPABASE_URL, R2_BUCKET, R2_PUBLIC_BASE).
missing=()
for v in SUPABASE_SERVICE_KEY R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
if [ "${#missing[@]}" -gt 0 ]; then
  # .env may still hold them (older setup) — let store.py decide; only warn.
  echo "wh_local: not in Keychain: ${missing[*]} (falling back to .env; see docs/WH_LOCAL_INGEST.md)" >&2
fi

# ffmpeg is needed by yt-dlp (mp3 transcode) and by faster-whisper's decoder.
command -v ffmpeg >/dev/null || { echo "wh_local: ffmpeg not on PATH (brew install ffmpeg)" >&2; exit 1; }

cd "$ROOT"
{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') wh_local $* ==="
} >> "$LOG"
exec "$PY" -m ingest.wh_fetch "$@" 2>&1 | tee -a "$LOG"
