#!/usr/bin/env bash
# supabase-js 를 단일 파일 ESM 으로 번들해 ui/vendor/ 에 셀프호스팅한다.
#
# 왜 (2026-09-02, 사용자 신고 "오프라인이면 앱이 안 켜지고, 어쩔 때는 느리게 열린다" — 화면은 v? + 스켈레톤):
#   ui/supabase.js 가 `https://esm.sh/@supabase/supabase-js@2` 를 import 했다. 그 URL 은 **떠다니는
#   포인터**다(cache-control: max-age=600, vary: User-Agent; 오늘 2.114.0 으로 풀림). esm.sh 출력은
#   17개 파일·289KB 의 상대경로 import 체인이고, 안에 두 번째 포인터(iceberg-js@^0.8.1)까지 있다.
#   SW 의 stale-while-revalidate 가 진입 파일만 새 버전으로 갈아 두면, 새 버전이 가리키는 하위 모듈
#   URL 은 그 세션에서 한 번도 받은 적이 없다 → 다음 오프라인 부팅에서 모듈 그래프가 깨지고
#   app.js 가 실행조차 안 된다(그래서 버전 배지가 'v?'). '느리게 열림'은 같은 체인을 온라인에서
#   17홉으로 다시 받는 시간이다.
#   단일 파일이면 포인터도 체인도 없다: SHELL 프리캐시 한 항목, 버전은 ?v= 로 함께 움직인다.
#
#   bash scripts/vendor_supabase.sh            # node_modules 의 @supabase/supabase-js 를 번들
#   npm i -D @supabase/supabase-js@latest esbuild && bash scripts/vendor_supabase.sh   # 올릴 때
#
# ⛔ 번들 결과에 `import`/`from "http` 가 남아 있으면 실패로 처리한다 — 외부 import 하나가 곧 오프라인
#    부팅 실패다(esm.sh ?bundle 은 /node/buffer.mjs, /node/process.mjs 를 남긴다 — 그래서 esbuild).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=ui/vendor/supabase-js.mjs
npx --yes esbuild node_modules/@supabase/supabase-js/dist/index.mjs \
  --bundle --format=esm --platform=browser --target=es2020 --minify --legal-comments=none \
  --define:process.env.NODE_ENV='"production"' --outfile="$OUT"
if grep -Eq 'from"https?:|import\("https?:' "$OUT"; then
  echo "⛔ 번들에 외부 import 가 남았다 — 오프라인 부팅이 다시 깨진다" >&2; exit 1
fi
VER=$(node -p "require('./node_modules/@supabase/supabase-js/package.json').version")
node --input-type=module -e "import('./$OUT').then(m => { if (typeof m.createClient !== 'function') throw new Error('createClient 없음'); console.log('ok supabase-js', '$VER', m.createClient.length >= 0 ? '' : ''); })"
ls -l "$OUT"
