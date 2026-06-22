# aep-review BACKLOG (loop 모드)

상태: `done` 완료 / `partial` 부분 / `blocked` 차단(사람 필요) / `todo` 대기.
상세 근거는 `NOTES_overnight_2026-06-21.md` + `NOTES_loop_2026-06-21.md`, 반복 로그는 `PROGRESS_loop.md`.

| # | 항목 | 상태 | 산출물 |
|---|---|---|---|
| 1 | RLS 멀티유저 행 격리 점검 | **done** | `supabase/proposed_multiuser_rls.sql`(제안·prod 미적용) + NOTES §1 |
| 2 | resegment SSOT 검증 + _preKo 적중률 진단 | **done** | `tests/test_resegment_parity.py`·`scripts/resegment_parity.mjs`·`ingest/diag_preko.py` (전수 0불일치, 적중 99.9%) |
| 3 | 런타임 폴백 견고성 | **done(감사+테스트)** | NOTES §4 — 이미 견고. + `tests/translate_fallback.test.mjs`(7): 번역 폴백 계약(never-throw·429/403/쿼터 래치·캐시) 회귀 고정 |
| 4 | async 뷰 빈/에러/로딩 보강 | **done(감사)** | NOTES §5 — 전 뷰 이미 구비(헤드리스 PASS). 변경 불요 |
| 5 | 핵심 로직 단위 테스트 | **done** | `tests/srs_streak.test.mjs`(SM-2·스트릭 12케이스) + `_pwtest_async.py` 시간→문장 통합 |
| 6 | 번역 잡 체크포인트 멱등성 분석(읽기전용) | **done** | NOTES §3 — 멱등·원자 확인 + load_existing 404가드 등 제안 |
| 7 | cnpod-review 이식 발견사항 | **done** | `NOTES_loop_2026-06-21.md` §cnpod |

## BACKLOG 소진 — 새 작업 발명 금지. 아래는 '추가 제안'(구현 X, 사람 리뷰용)

- **[음성 체인]** `playSentenceClip` 옵셔널 `onError`→호출부 `speak()` 폴백(실제클립 런타임 실패 시 TTS 캐스케이드). 폴백 순서 유지·하위호환. (frozen 체인이라 제안만)
- **[부팅]** `app.js boot()` 의 `getSession()` 짧은 타임아웃 가드(네트워크 무응답 시 로그인/스피너 강등).
- **[번역잡]** `load_existing` 에서 404(정상 신규) vs 기타 다운로드 오류 구분 → 오류 시 덮어쓰지 않고 스킵(기존 _ko.json 축소 방지). 샤드 id 1회 스냅샷 전달.
- **[SSOT]** episode.js 의 `resegment`/`trKey` 를 `ui/resegment.js` 순수 모듈로 추출(파리티 테스트가 가드). 회귀 위험 있어 사람 리뷰 붙는 낮에.
- **[린트빚]** 기존 ruff 에러 43건(scripts/_pwtest.py·verify_done.py·verify_hosting.py·ingest/store.py) — 이번 변경과 무관, 별도 정리 PR 권장.

## ⚠️ needs-human (loop 권한 밖)
- **4샤드 번역 잡 정지**: 로그 마지막 기록 ~18:05(약 6h 전), 각 샤드 67개 중 ~15개만 완료 후 중단. loop INVARIANT 상 재실행/_ko.json 쓰기 금지라 **건드리지 않음**. 재개는 사람이 `python -m scripts.translate_transcripts --shard i/4`(PID 죽음 확인 후). 현재 커버리지: 최신 ~50회차(225–268) 99.9%, 그 이하는 런타임 MyMemory 폴백.
- Google OAuth 대시보드 설정 / Vercel v133 배포 확인(이전 세션 산출).
