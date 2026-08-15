#!/usr/bin/env bash
# 한국어 사전번역 품질 패스 — 쇼별 '최근 N편'을 두 단계로 훑는다.
#
#   Phase A  backfill : _ko.json 에 없는 문장을 문맥 인지 번역으로 채운다.
#   Phase B  refine   : 이미 있는 번역을 '직역 → 의도·뉘앙스' 기준으로 재검수하고 고친다.
#
# 왜 A 가 먼저인가(실측 2026-08-15, 최근 50편×3쇼 = 73,748문장): 키가 없는 문장은 앱에서
# '번역 없음'이 아니라 조용히 MyMemory(무료 MT)로 폴백한다 — 문장을 고립시켜 번역하니 대명사·
# 관용구·담화 흐름이 통째로 날아간 직역이 나온다. 커버리지가 aep 31.1% / allears 9.6% 였으므로
# 사용자가 겪은 '직역'의 대부분은 번역 품질이 아니라 번역의 부재였다. A 한 번이 43%의 줄을
# 그 경로에서 꺼낸다 — 호출당 효용이 B 보다 압도적으로 크다.
#
# ⚠ 이 잡은 claude CLI 를 쓴다 = API 비용 0, Claude 구독 쿼터 소모. 호출당 ~1.5분이라 전체가
#   길다 → LaunchAgent(com.roy.aep-ko-quality)로 돌린다. macOS 엔 setsid 가 없어서 셸에서
#   띄운 장시간 잡은 그 셸 세션과 함께 죽는다(2026-08-07 백악관 인제스트가 그렇게 죽었다).
#
# 멱등·재개: 두 단계 모두 체크포인트가 있다. 언제 끊겨도 다시 실행하면 이어서 한다.
#   A = _ko.json 에 이미 있는 키는 건너뜀 · B = 완료 회차 목록 파일(ko_refine_done_*.txt)
#
# ⚠ 샤드 수 기본 4 — translate_local.sh 가 522편 백필을 완주한 값이다. 더 늘려도 총 쿼터
#   소모는 같고 '속도'만 오르는데, 레이트리밋 실패가 늘면 MAX_CONSECUTIVE_FAILS 에 걸려 단계가
#   통째로 멈춘다. 빨리 가려다 자주 서는 쪽이 결국 더 느리다.
#
#     scripts/ko_quality_pass.sh            # 최근 50편/쇼, 4 샤드
#     scripts/ko_quality_pass.sh 30 2       # 최근 30편/쇼, 2 샤드
#     tail -f ~/Library/Logs/aep-ko-quality.log
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
CCSECRET="${CCSECRET:-$HOME/.local/bin/ccsecret}"
PROJECT="aep-review"
PER_SHOW="${1:-50}"
SHARDS="${2:-4}"
MODEL="${MODEL:-sonnet}"
STATE="$HOME/Library/Application Support/aep-review"
LOG="$HOME/Library/Logs/aep-ko-quality.log"
LOCK="$STATE/ko-quality.lock"
IDS="$STATE/ko_quality_ids.txt"

PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH
mkdir -p "$STATE" "$(dirname "$LOG")"
say() { echo "[$(date '+%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# 한 번에 하나만 — LaunchAgent 재시작이 겹쳐 같은 회차를 두 프로세스가 쓰면 _ko.json 이 서로를
# 덮어써 작업이 사라진다(체크포인트가 통째로 업로드되는 구조라 마지막 쓴 쪽이 이긴다).
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && kill -0 "$(cat "$LOCK/pid")" 2>/dev/null; then
    say "이미 실행 중(pid $(cat "$LOCK/pid")) — 종료"; exit 0
  fi
  say "죽은 락 정리 후 진행"; rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ > "$LOCK/pid"
cleanup() { rm -rf "$LOCK"; }
trap cleanup EXIT INT TERM

[ -x "$PY" ] || { say "missing venv at $PY"; exit 1; }
command -v claude >/dev/null || { say "claude CLI not on PATH"; exit 1; }

for v in SUPABASE_URL SUPABASE_SERVICE_KEY; do
  if [ -z "${!v:-}" ] && [ -x "$CCSECRET" ]; then
    val="$("$CCSECRET" get "$PROJECT" "$v" 2>/dev/null || true)"
    [ -n "$val" ] && export "$v=$val"
  fi
done
[ -n "${SUPABASE_SERVICE_KEY:-}" ] || { say "SUPABASE_SERVICE_KEY 없음 — 중단"; exit 1; }

cd "$ROOT" || exit 1

# 대상 목록은 매 실행 시 다시 만든다 — 새 회차가 들어오면 자동으로 포함된다.
say "=== 대상 목록 생성: 쇼별 최근 ${PER_SHOW}편 ==="
"$PY" - "$PER_SHOW" "$IDS" <<'PY' || { say "목록 생성 실패 — 중단"; exit 1; }
import sys
from ingest import store
n, out = int(sys.argv[1]), sys.argv[2]
sb, ids = store.client(), []
for show in ("aep", "allears", "wh"):
    rows = sb.table("episodes").select("id").eq("show", show).not_.is_(
        "transcribed_at", "null").order("id", desc=True).limit(n).execute().data
    got = [r["id"] for r in rows]
    ids += got
    print(f"{show}: {len(got)}편 ({min(got)}~{max(got)})" if got else f"{show}: 0편")
open(out, "w").write("\n".join(map(str, ids)) + "\n")
print(f"총 {len(ids)}편 → {out}")
PY
say "$(wc -l < "$IDS") 편"

run_phase() {   # $1=이름  $2=모듈  $3=로그접두사
  local name="$1" mod="$2" pfx="$3" pids=() rc=0
  say "=== Phase $name 시작 ($SHARDS 샤드, 모델 $MODEL) ==="
  for i in $(seq 0 $((SHARDS - 1))); do
    "$PY" -m "$mod" --ids "@$IDS" --model "$MODEL" --shard "$i/$SHARDS" \
      >>"$HOME/Library/Logs/$pfx-$i.log" 2>&1 &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || rc=$?; done
  # exit 2 = 쿼터로 자진 중단. 실패로 끝내야 LaunchAgent 가 나중에 다시 깨워 이어서 한다.
  say "=== Phase $name 종료 (최종 rc=$rc) ==="
  return $rc
}

run_phase "A(backfill)" scripts.translate_transcripts aep-ko-backfill
a_rc=$?
if [ "$a_rc" -ne 0 ]; then
  say "Phase A 미완(rc=$a_rc, 대개 쿼터) — B 로 넘어가지 않고 종료해 나중에 이어서 한다"
  exit "$a_rc"
fi

run_phase "B(refine)" scripts.refine_translations aep-ko-refine
b_rc=$?
if [ "$b_rc" -ne 0 ]; then
  say "Phase B 미완(rc=$b_rc) — 나중에 이어서 한다"
  exit "$b_rc"
fi

say "=== 전 단계 완료 ==="
exit 0
