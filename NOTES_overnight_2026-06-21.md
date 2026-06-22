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

---

## 2. [정합성] resegment SSOT 이탈 검증 — ✅ 완료(불일치 0, 회귀가드 추가)

### 검증 결과 (전수)
- **전체 264 회차 / 106,272 문장에서 JS(episode.js) ↔ Python(translate_transcripts.py) 분절·trKey
  불일치 0건.** 두 구현은 실제 코퍼스 전체에서 바이트 단위로 동일 → _preKo 키 정합 완전.
- 코드 정독으로 발견한 *이론적* 엣지 분기 3종은 실데이터에서 미발현(아래). faster-whisper 가 항상
  수치 start/end + ASCII 영문을 내기 때문.
  1. `w.start ?? seg.start`(JS nullish) vs `w.get("start", seg.get("start"))`(Python: 키 부재일 때만
     default) — 키가 명시적 null 일 때만 갈림. whisper 는 항상 키+수치라 미발생.
  2. `raw[:1].isupper()`(Python 유니코드) vs `/^[A-Z]/`(JS ASCII) — STARTER 가 ASCII 단어목록이라
     2차 조건에서 마스킹됨(무해).
  3. dur 계산 시 start 가 null 이면 JS=coerce0 / Python=0분기 — 추출단계 seg.start 폴백으로 start 가
     항상 수치라 미발생.

### _preKo 적중률(완료 회차 표본, 읽기 전용 측정)
- ep 268/255/240/225 = 100%, ep 230 = 99.7%(1문장 누락) → **합계 99.9%**.
  누락 1문장은 claude 가 그 줄 번역을 안 돌려준 케이스 → 런타임 MyMemory 폴백으로 무중단 처리(설계대로).

### 산출물
- `scripts/resegment_parity.mjs` — episode.js 의 '실제' resegment/trKey 소스를 추출해 실행(복사 드리프트
  없음). `data/transcripts/*.json` 픽스처로 JS 분절 출력.
- `tests/test_resegment_parity.py` — Python 포팅과 대조(문장경계 + trKey). node 없으면 skip. 표본 9회차
  (앞/중/뒤). **이제 둘 중 하나만 고쳐도 테스트가 깨져 SSOT 이탈을 CI 에서 즉시 잡는다.**
- `ingest/diag_preko.py` — _preKo 적중률 진단(읽기 전용, Storage download 만). 분절/키 로직은
  translate_transcripts 재사용(중복 0).
- `conftest.py` — 루트를 sys.path 에 넣어 테스트가 scripts/ingest 네임스페이스패키지 import 가능.

### 단일 공유 모듈 추출(제안만 — 이번 밤 미통합)
- 현재는 분절 로직이 JS·Python 2벌. 파리티 테스트가 가드를 제공하므로 당장 위험은 낮음. 다만 영구
  SSOT 화를 원하면: episode.js 의 `resegment`/`trKey` 를 `ui/resegment.js`(순수 ESM, DOM무의존)로 추출해
  episode.js 가 import. Python 은 언어가 달라 포팅 유지가 불가피하나, 파리티 테스트로 강제 동기화.
  회귀 위험(episode.js 의 큰 함수 이동)이 있어 사람 리뷰가 붙는 낮에 별도 PR 권장.

### cnpod-review 이식
- 동일 사전번역 구조면 같은 파리티 테스트(언어축만 교체)를 두는 것을 권장 — 분절 드리프트 무인 탐지.
