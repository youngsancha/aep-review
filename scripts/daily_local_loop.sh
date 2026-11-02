#!/usr/bin/env bash
# aep-review 로컬 일일 루프 — Claude 토큰 0. LaunchAgent com.roy.aep-daily-loop 가 매일 16:30(로컬) 호출.
#
# CI 가 끝난 뒤에 돈다: aep-sync(16:00Z, RSS→STT→R2 호스팅) · aep-r2-upload(17:00Z + ≤300분, 백카탈로그
# 재STT). 그 결과물 위에서 세 단계를 순서대로:
#   ⓪ storage guard      scripts/storage_guard   — drains retired Storage buckets (tts) and files a td-task
#                        when Storage nears the 1 GB free cap (restricted 2026-10-11 at 1.25 GB).
#   ① 문장 경계 재점검  scripts/resegment_llm   — ollama(로컬, 과금 0). 규칙 분절의 14단어/9초 컷을 뜻 기준으로.
#   ② vocab 추출        ingest/extract_vocab    — ollama(로컬). CI 는 --no-vocab 이라 여기 말고는 아무도 안 한다.
#   ③ 한국어 번역       scripts/ko_quality_pass — ollama. A 백필(없는 문장) → B 재검수(직역→뉘앙스).
# ⛔ 순서가 곧 정합성이다. 번역 키(trKey)는 문장 텍스트라 ①이 경계를 바꾼 문장만 키가 새로 생긴다 —
#    ①을 ③ 뒤에 돌리면 방금 번역한 문장이 그날 바로 키를 잃는다. 재STT 된 회차도 segments 가 통째로
#    새로 와서 ①의 표식(sent:true)이 사라지므로 다음날 ①이 다시 잡는다(멱등).
#
# ①②③ 은 전부 같은 로컬 ollama 에 매달려 있으므로 시작 전에 한 번 확인한다(LLM preflight). 데몬이 모델을
# 못 보면 ①②③ 을 건너뛰고 td-task 를 올린다. 실측 2026-11-01: brew 가 ollama 를 올린 날 launchd 데몬이 T5 를
# 못 열어 모델 0개가 됐는데, ① 은 6초 만에 죽고 ② 는 1,504초를 매달린 뒤 '처리 0건'으로 **성공** 종료했고,
# 아무 알림도 없었다. 그 뒤 실패한 단계는 전부 td-task 하나로 모아 알린다(제목이 같으면 중복 생성되지 않는다).
# 원인: ad-hoc 서명 바이너리는 업그레이드마다 TCC 신원이 바뀌어 T5(이동식 볼륨) 권한 프롬프트를 다시 띄우고,
# 그 프롬프트가 처리될 때까지 launchd 데몬의 open() 이 멈춘다. 그래서 ollama 는 brew pin 해 둔다.
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
unset AEP_ALLOW_CLAUDE_QUOTA   # ⛔ 자동 경로에서 Claude 는 절대 안 쓴다 — ingest/llm_policy.py 의 이중 opt-in 관문
RESEG_NEWEST="${RESEG_NEWEST:-60}"   # 쇼별 최신 N편을 훑는다 — 신규 + 최근 재STT 회차가 여기 들어온다
RESEG_LIMIT="${RESEG_LIMIT:-8}"      # 하루에 실제로 경계를 다시 나눌 회차 수(로컬 7.8B 모델, 편당 수 분)
VOCAB_LIMIT="${VOCAB_LIMIT:-6}"
KO_PER_SHOW="${KO_PER_SHOW:-50}"
# 2: exaone 은 병렬 슬롯마다 KV 캐시를 따로 잡는다. 샤드 4 는 llama-server 10 GB, 스왑 4.7→14.8 GB,
# 내장 여유 30→17.8 GB 까지 밀었다(16 GB Mac mini, 2026-10-25). 시간은 더 걸려도 어차피 밤 작업이다.
KO_SHARDS="${KO_SHARDS:-2}"
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

# 자격증명: Supabase 는 Keychain(ccsecret). LLM 은 로컬 ollama 라 자격증명이 없다.
for v in SUPABASE_URL SUPABASE_SERVICE_KEY; do
  val="$("$CCSECRET" get aep-review "$v" 2>/dev/null || true)"
  [ -n "$val" ] && export "$v=$val"
done
if [ -f "$ROOT/.env.local" ]; then set -a; . "$ROOT/.env.local"; set +a; fi

FAILED=""
notify() {  # td-task 제목이 같으면 새로 만들지 않는다. 알림 실패가 루프를 멈추면 안 된다.
  command -v td-task >/dev/null 2>&1 && td-task add "$1" -P aep-review -p 1 -n "$2" >>"$LOG" 2>&1 || true
}

run_step() {  # run_step <이름> <명령...>
  local name="$1"; shift
  local t0; t0=$(date +%s)
  say "── $name 시작"
  if "$@" >>"$LOG" 2>&1; then say "── $name 끝 ($(( $(date +%s) - t0 ))s)"
  else say "── $name 실패 rc=$? ($(( $(date +%s) - t0 ))s) — 다음 단계로"; FAILED="$FAILED [$name]"; fi
}

say "=== 일일 루프 시작 (reseg newest=$RESEG_NEWEST limit=$RESEG_LIMIT · vocab limit=$VOCAB_LIMIT · ko per-show=$KO_PER_SHOW) ==="
run_step "⓪ storage guard" "$PY" -m scripts.storage_guard
if "$PY" -c 'import sys; from ingest.ollama_client import configured as o; sys.exit(0 if o() else 1)'; then
  AEP_LLM_BACKEND=ollama run_step "① 문장 경계(ollama)" "$PY" -m scripts.resegment_llm --newest "$RESEG_NEWEST" --limit "$RESEG_LIMIT"
  AEP_LLM_BACKEND=ollama run_step "② vocab(ollama)"    "$PY" -m ingest.extract_vocab --limit "$VOCAB_LIMIT"
  AEP_LLM_BACKEND=ollama run_step "③ 한국어 번역(ollama)" bash "$ROOT/scripts/ko_quality_pass.sh" "$KO_PER_SHOW" "$KO_SHARDS"
else
  say "ollama 가 모델을 못 본다 — ①②③ 건너뜀"
  FAILED="$FAILED [ollama]"
fi
if [ -n "$FAILED" ]; then
  notify "aep-daily-loop: step failed$FAILED" "Log: ~/Library/Logs/aep-daily-loop.log. If [ollama]: run 'curl localhost:11434/api/tags'. An empty list right after a brew upgrade means macOS is waiting to allow the new ollama binary onto the T5 volume (the model store): click Allow, or System Settings > Privacy & Security > Files and Folders. The grant is per binary, so ollama is brew-pinned."
fi
say "=== 일일 루프 끝 ==="
exit 0
