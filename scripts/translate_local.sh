#!/usr/bin/env bash
# 사전번역(_ko.json) 백필 로컬 러너 — scripts/translate_transcripts.py 를 N 샤드로 병렬 실행.
#
# 왜 로컬인가: 이 잡은 `claude` CLI 를 쓴다(문맥 인지 번역). CI 에서 claude 를 인증하기
# 어려워 로컬 전용이다. API 비용은 0 이지만 Claude Max 쿼터를 쓴다.
#
# 왜 필요한가 (2026-07-27): _ko.json 은 자막 522개 중 62개(id 200~268)뿐이었다. 나머지
# 회차는 재생 중 문장마다 MyMemory 를 호출하는데, 오프라인이면 그게 실패해 번역이 안 뜬다
# (사용자 신고). 사전번역이 있으면 오프라인에서도 뜨고, 온라인 번역 품질도 올라간다
# (MyMemory 는 문장을 고립시켜 번역해 대명사·관용구·담화 흐름을 놓친다).
#
# 시크릿은 Keychain 에서 런타임에 꺼낸다(평문 저장 없음). 멱등·체크포인트라 언제 끊겨도
# 다시 실행하면 이어서 진행한다.
#
#     scripts/translate_local.sh            # 4 샤드(기본), 전체 회차
#     scripts/translate_local.sh 6          # 6 샤드
#     tail -f ~/Library/Logs/aep-translate-*.log
#     pkill -f scripts.translate_transcripts    # 중단(진행분은 유지)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
CCSECRET="${CCSECRET:-$HOME/.local/bin/ccsecret}"
PROJECT="aep-review"
SHARDS="${1:-4}"
# 번역은 추론이 아니라 변환 작업이라 상위 모델이 꼭 필요하지 않다. 실측(2026-07-29): haiku 는
# STT 가 쪼갠 숫자("episode 26 15" → 2615화)를 복원 못 하고 "the math isn't mapping" 을 "수학"
# 으로 직역했다 — 관용구를 문맥으로 살리는 게 이 잡의 존재 이유라 부적합. sonnet 은 둘 다 정확.
MODEL="${MODEL:-sonnet}"

[ -x "$PY" ] || { echo "translate_local: missing venv at $PY" >&2; exit 1; }
command -v claude >/dev/null || { echo "translate_local: claude CLI not on PATH" >&2; exit 1; }

# Keychain → env. 이미 export 된 값이 있으면 그것을 존중한다.
for v in SUPABASE_URL SUPABASE_SERVICE_KEY; do
  if [ -z "${!v:-}" ] && [ -x "$CCSECRET" ]; then
    val="$("$CCSECRET" get "$PROJECT" "$v" 2>/dev/null || true)"
    [ -n "$val" ] && export "$v=$val"
  fi
done
[ -n "${SUPABASE_SERVICE_KEY:-}" ] || {
  echo "translate_local: SUPABASE_SERVICE_KEY 없음 — pbpaste | ccsecret set $PROJECT SUPABASE_SERVICE_KEY" >&2
  exit 1
}

cd "$ROOT"
for i in $(seq 0 $((SHARDS - 1))); do
  log="$HOME/Library/Logs/aep-translate-$i.log"
  nohup "$PY" -m scripts.translate_transcripts --model "$MODEL" --shard "$i/$SHARDS" >>"$log" 2>&1 &
  echo "shard $i/$SHARDS → pid $! · log $log"
done
echo
echo "진행: grep -c '저장' ~/Library/Logs/aep-translate-*.log"
echo "중단: pkill -f scripts.translate_transcripts   (진행분은 체크포인트로 남는다)"
