# Overnight 작업 노트 — 2026-06-21 (branch: `overnight/2026-06-21-hardening`)

무인 자율 모드. main 직접 push/Vercel prod 배포 없음. 진행 중 4샤드 번역 잡은 읽기 전용으로만 접근(방해 X).
각 작업: plan → self-review → 구현 → 검증(lint/test/node --check/_pwtest) → 작은 커밋.

---

## 1. [보안·최우선] RLS 멀티유저 행 격리 점검 — ✅ 완료(제안 산출)

### 진단
- DB 테이블 3개: `episodes`, `vocab_cards`, `srs_cards` (스키마: `supabase/schema.sql`). 다른 .sql 없음.
- RLS = 셋 다 `for all to authenticated using(true) with check(true)`.
- **유저별 상태가 DB 에 있는 건 `srs_cards` 뿐**(ease/interval_days/due_date/reps). 카탈로그(front/back)와
  복습상태가 한 테이블에 섞여 있고 **user_id 없음**.
- 데일리 스트릭(`aep-study-days`), Essentials Known(`aep-ess-known`), 자막 번역캐시(`aep-trk-*`), 테마/폰트
  스케일 = **전부 localStorage(기기별)** → DB 교차유저 누수 아님(대신 기기 간 동기화 안 됨 = 별도 UX 갭).

### 결론
- **오늘 안전**: 앱은 의도적 단일 사용자(README §4 = 계정 1개). 유저 1명이라 행 공유 문제 미발생.
  anon 은 RLS 로 차단 → publishable 키/URL 공개돼도 데이터 안전.
- **잠재 누수(멀티유저 전환 시)**: `using(true)` 라 2번째 계정이 생기면 두 유저가 같은 `srs_cards`
  복습상태를 공유·덮어씀 → 진도 충돌(무결성) + 타인 상태 열람/수정(프라이버시) 동시 발생.

### 산출물
- `supabase/proposed_multiuser_rls.sql` (제안, **prod 자동적용 금지**):
  - 옵션 A(권장): 복습상태를 `srs_progress`(user_id=auth.uid() RLS)로 분리, `srs_cards`/카탈로그는 읽기전용.
  - 옵션 B(단순): `srs_cards` 에 user_id 추가 + 유저별 카드 복제(비정규화).
  - 카탈로그 3종 쓰기는 service_role(ingest)만 — 인증유저 SELECT-only 심층방어 포함.
  - 2-유저 검증 시나리오 문서화.
- `schema.sql` 은 **변경하지 않음**(가드레일: RLS 기본구조 변경 금지 → 제안만).

### cnpod-review 이식
- cnpod-review 는 aep 패턴을 그대로 따름(메모리 `cnpod-follow-aep-exactly`) → **동일 잠재 위험 존재**.
  멀티유저 계획이 있다면 같은 `srs_progress` 분리를 cnpod 에도 적용해야 함.

### 리뷰 필요
- 멀티유저를 실제로 쓸 의향이 있는가? 없으면 현행 단일유저로 안전(조치 불요). 있으면 옵션 A 적용 + db.js 수정.
