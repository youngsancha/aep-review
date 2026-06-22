# NOTES (loop 모드) — 2026-06-21

이 파일은 loop 요약 + cnpod 이식거리. **상세 근거·진단·제안 전문은 `NOTES_overnight_2026-06-21.md`**
(§1 RLS / §2 resegment·적중률 / §3 체크포인트 / §4 런타임폴백 / §5 뷰 상태). 반복 로그는 `PROGRESS_loop.md`,
상태판은 `BACKLOG.md`.

## 한눈 요약
- BACKLOG 1–7 전부 **done**. 이번 세션 변경은 전부 **additive**(테스트·진단·문서·제안 SQL) — **ui/ 런타임
  코드 0 변경** → main 배포해도 PWA 동작 동일.
- 게이트 매 커밋 green: `node --check`(전 파일)·`node --test tests/srs_streak.test.mjs`(12)·`pytest`(2)·
  `ruff`(신규파일 clean)·웹 스모크 `_pwtest_async.py`(PASS).
- **핵심 검증 결과**: resegment JS↔Python **전수 264회차/106,272문장 불일치 0**. _preKo 적중률 완료회차 99.9%.

## 리뷰 필요(사람)
1. **RLS**: 멀티유저 쓸지 결정 → 쓰면 `supabase/proposed_multiuser_rls.sql` 적용(+db.js 수정). 안 쓰면 현행 안전.
2. **번역 잡 정지**(needs-human): 4샤드 ~18:05 중단(6h), ~15/67 회차만 완료. loop 권한 밖이라 미재실행.
   재개·원인(claude CLI 세션/머신 슬립?) 확인 필요. → `BACKLOG.md` ⚠️ 참고.
3. **gate 숫자 불일치**: loop 스펙의 "pytest 현재 111"은 이 repo 와 불일치 — aep-review 엔 기존 pytest
   테스트가 없었고(이번에 2개 신설), JS 로직은 `node --test`/웹스모크가 담당. 게이트는 "신규 변경이
   green 유지"로 해석해 운용함.
4. **ruff 빚 43건**(기존 파일, 이번 변경 무관) — 별도 정리 PR 권장.

## cnpod-review 이식거리 (BACKLOG 7)
cnpod-review 는 aep 패턴을 그대로 따른다(메모리 `cnpod-follow-aep-exactly`). 이번 산출물 대부분 직접 이식 가능:

| 산출물 | cnpod 이식 | 비고 |
|---|---|---|
| `supabase/proposed_multiuser_rls.sql` | ✅ 높음 | 같은 srs_cards 잠재 누수. 멀티-쇼판이면 show 스코프도 함께 고려 |
| `tests/test_resegment_parity.py` + `resegment_parity.mjs` | ✅ 높음 | cnpod 가 중국어 사전번역+자체 resegment 포팅을 쓰면 언어축만 바꿔 그대로. 분절 드리프트 무인 탐지 |
| `ingest/diag_preko.py` | ✅ 높음 | 읽기전용 적중률 진단. Storage 경로/키 동일 가정 |
| `scripts/_pwtest_async.py` | ✅ 높음 | **Py3.14+Playwright1.58 sync 드라이버 깨짐**은 cnpod 도 동일하게 겪을 것 → async 러너 그대로 이식 |
| `tests/srs_streak.test.mjs` | ✅ 높음 | sm2/getStreak/_dayKey 가 같은 db.js/study.js 패턴이면 거의 그대로. 특히 스트릭 타임존/DST 테스트 |
| 런타임 폴백·뷰 상태 감사(§4·§5) | ◐ 중 | 같은 바닐라 PWA면 동일 견고성 기대. async 러너로 재확인 권장 |
| 체크포인트 404가드 제안(§3) | ◐ 중 | cnpod 에 translate_transcripts 류가 있으면 동일 `load_existing` 가드 적용 |

> 권장: cnpod 에 먼저 `_pwtest_async.py`(검증 복구) + 파리티/단위 테스트를 이식해 **회귀 안전망**을 깐 뒤,
> RLS 제안을 검토. 코드 재발명 없이 언어/쇼 축만 교체.

## git log (이번 세션)
- 253265f RLS 제안 SQL + 진단
- 4bbb522 resegment 파리티 테스트 + _preKo 진단
- a0c65ec 체크포인트 멱등성 분석
- 416f21e async 헤드리스 스모크 러너
- a770c9d 런타임폴백·뷰 감사
- e6ae654 SM-2·스트릭·시간→문장 테스트
- (이번) loop 부트스트랩(BACKLOG/PROGRESS/NOTES_loop) + cnpod 이식거리
