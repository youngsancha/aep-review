#!/usr/bin/env bash
# kokoro_pregen.sh — run the Kokoro TTS pre-generation locally on the Mac mini.
#
# Must run here, not in CI: Kokoro is mlx-audio on this machine's Metal GPU, served by the
# speakloop gateway (LaunchAgent com.roy.speakloop.gateway, 127.0.0.1:8788). GitHub runners
# have neither the GPU nor the gateway.
#
# Secrets come from the login Keychain via `ccsecret` at runtime — nothing secret on disk.
#
#     scripts/kokoro_pregen.sh --limit 50     # smoke a small batch first
#     scripts/kokoro_pregen.sh                # everything (idempotent, resumable)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
CCSECRET="${CCSECRET:-$HOME/.local/bin/ccsecret}"
LOG="$HOME/Library/Logs/aep-kokoro-pregen.log"

[ -x "$PY" ] || { echo "kokoro_pregen: missing venv at $PY" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "kokoro_pregen: ffmpeg not on PATH (brew install ffmpeg)" >&2; exit 1; }

for v in SUPABASE_URL SUPABASE_SERVICE_KEY; do
  if [ -z "${!v:-}" ] && [ -x "$CCSECRET" ]; then
    val="$("$CCSECRET" get aep-review "$v" 2>/dev/null || true)"
    [ -n "$val" ] && export "$v=$val"
  fi
done

# Fail early with a useful message rather than 10k identical connection errors.
curl -fsS -o /dev/null "http://127.0.0.1:8788/api/tts?text=ok" || {
  echo "kokoro_pregen: the speakloop gateway is not answering on 127.0.0.1:8788." >&2
  echo "  start it with: launchctl kickstart -k gui/\$(id -u)/com.roy.speakloop.gateway" >&2
  exit 1
}

cd "$ROOT"
echo "=== $(date '+%Y-%m-%d %H:%M:%S') kokoro_pregen $* ===" >> "$LOG"
exec "$PY" -m scripts.pregen_kokoro_tts "$@" 2>&1 | tee -a "$LOG"
