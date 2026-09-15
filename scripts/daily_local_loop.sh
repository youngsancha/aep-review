#!/usr/bin/env bash
# aep-review 로컬 일일 루프 — Claude 토큰 0. LaunchAgent com.roy.aep-daily-loop 가 매일 16:30(로컬) 호출.
#
# CI 가 끝난 뒤에 돈다: aep-sync(16:00Z, RSS→STT→R2 호스팅) · aep-r2-upload(17:00Z + ≤300분, 백카탈로그
# 재STT). 그 결과물 위에서 세 단계를 순서대로:
#   ① 문장 경계 재점검  scripts/resegment_llm   — ollama(로컬, 과금 0). 규칙 분절의 14단어/9초 컷을 뜻 기준으로.
#   ② vocab 추출        ingest/extract_vocab    — Gemini(Vertex). CI 는 --no-vocab 이라 여기 말고는 아무도 안 한다.
#   ③ 한국어 번역       scripts/ko_quality_pass — Gemini. A 백필(없는 문장) → B 재검수(직역→뉘앙스).
# ⛔ 순서가 곧 정합성이다. 번역 키(trKey)는 문장 텍스트라 ①이 경계를 바꾼 문장만 키가 새로 생긴다 —
#    ①을 ③ 뒤에 돌리면 방금 번역한 문장이 그날 바로 키를 잃는다. 재STT 된 회차도 segments 가 통째로
#    새로 와서 ①의 표식(sent:true)이 사라지므로 다음날 ①이 다시 잡는다(멱등).
#
# 각 단계는 실패해도 다음 단계로 넘어간다(한 백엔드가 죽었다고 번역까지 멈출 이유가 없다). 종료 코드는
# 항상 0 — 재시작은 KeepAlive 가 아니라 달력 스케줄이 한다(예전 com.roy.aep-ko-quality 는
# RunAtLoad+KeepAlive(SuccessfulExit=false) 라 성공하면 재부팅 때까지 다시 안 돌았다 — 실측: 08-26,
# 08-28, 09-06, 09-10, 09-13, 09-14 만 실행. 그 잡은 2026-09-14 에 이 루프로 흡수해 은퇴시켰다).
#
#   RESEG_NEWEST=60 RESEG_LIMIT=8 VOCAB_LIMIT=6 KO_PER_SHOW=50 bash scripts/daily_local_loop.sh
#   tail -f ~/Library/Logs/aep-daily-loop.log
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
CCSECRET="${CCSECRET:-$HOME/.local/bin/ccsecret}"
STATE="$HOME/Library/Application Support/aep-review"
LOG="$HOME/Library/Logs/aep-daily-loop.log"
LOCK="$STATE/daily-loop.lock"
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH
RESEG_NEWEST="${RESEG_NEWEST:-60}"   # 쇼별 최신 N편을 훑는다 — 신규 + 최근 재STT 회차가 여기 들어온다
RESEG_LIMIT="${RESEG_LIMIT:-8}"      # 하루에 실제로 경계를 다시 나눌 회차 수(로컬 7.8B 모델, 편당 수 분)
VOCAB_LIMIT="${VOCAB_LIMIT:-6}"
KO_PER_SHOW="${KO_PER_SHOW:-50}"
KO_SHARDS="${KO_SHARDS:-4}"
mkdir -p "$STATE" "$(dirname "$LOG")"
say() { echo "[$(date '+%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && kill -0 "$(cat "$LOCK/pid")" 2>/dev/null; then
    say "이미 실행 중(pid $(cat "$LOCK/pid")) — 종료"; exit 0
  fi
  say "죽은 락 정리 후 진행"; rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT INT TERM
[ -x "$PY" ] || { say "missing venv at $PY"; exit 0; }
cd "$ROOT" || exit 0

# 자격증명: Supabase 는 Keychain(ccsecret), Gemini/Vertex 는 .env.local(GOOGLE_* — ccsecret 관리 밖).
for v in SUPABASE_URL SUPABASE_SERVICE_KEY; do
  val="$("$CCSECRET" get aep-review "$v" 2>/dev/null || true)"
  [ -n "$val" ] && export "$v=$val"
done
if [ -f "$ROOT/.env.local" ]; then set -a; . "$ROOT/.env.local"; set +a; fi

run_step() {  # run_step <이름> <명령...>
  local name="$1"; shift
  local t0; t0=$(date +%s)
  say "── $name 시작"
  if "$@" >>"$LOG" 2>&1; then say "── $name 끝 ($(( $(date +%s) - t0 ))s)"
  else say "── $name 실패 rc=$? ($(( $(date +%s) - t0 ))s) — 다음 단계로"; fi
}

say "=== 일일 루프 시작 (reseg newest=$RESEG_NEWEST limit=$RESEG_LIMIT · vocab limit=$VOCAB_LIMIT · ko per-show=$KO_PER_SHOW) ==="
AEP_LLM_BACKEND=ollama run_step "① 문장 경계(ollama)" "$PY" -m scripts.resegment_llm --newest "$RESEG_NEWEST" --limit "$RESEG_LIMIT"
AEP_LLM_BACKEND=gemini run_step "② vocab(gemini)"    "$PY" -m ingest.extract_vocab --limit "$VOCAB_LIMIT"
AEP_LLM_BACKEND=gemini run_step "③ 한국어 번역(gemini)" bash "$ROOT/scripts/ko_quality_pass.sh" "$KO_PER_SHOW" "$KO_SHARDS"
say "=== 일일 루프 끝 ==="
exit 0
