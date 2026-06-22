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

---

## 3. [견고성] 번역 잡 체크포인트 멱등성 — ✅ 완료(코드레벨 분석, 실행/수정 없음)

`translate_transcripts.py` 의 `translate_episode` / `save_existing` / `load_existing` / 샤딩(`ids[i::n]`)을
정독 분석. **잡은 건드리지 않았고 코드도 수정하지 않음**(가드레일: 제안만).

### 안전한 점(✅)
- **샤드 간 에피소드 분리**: `ids = ids[i::n]` 은 `episode_ids()`(=`sorted(reverse=True)`, 결정적)를 같은
  n 으로 분할 → 4샤드가 서로소(disjoint) 에피소드 집합. **두 샤드가 같은 `{id}_ko.json` 을 동시 write
  하지 않음** → 교차 write 충돌 없음.
- **체크포인트 원자성**: `save_existing` 은 누적 `done` 전체를 Supabase Storage 에 단일 PUT(upsert)로
  덮어쓴다. PUT 은 객체 단위 원자 교체 → **torn/부분 JSON 저장 불가**. 끊겨도 마지막 저장본은 항상 유효.
- **부분 실패 내성**: 배치 claude 실패는 `except → continue`(저장 안 함). 완료분만 멱등 누적. 재실행 시
  `load_existing` 으로 이어받아 `keys[k] not in done` 인 문장만 다시 시도.
- **손상 _ko.json 자가치유**: `load_existing` 이 깨진 JSON → `{}` 반환 → 전량 재번역 후 온전한 맵으로 덮어씀.

### 발견된 결함 / 위험 (재현조건 + 안전가드 제안)
**[B·주요] `load_existing` 이 모든 예외를 `{}` 로 삼킴 → 전체덮어쓰기와 결합 시 기존 _ko.json 축소 가능.**
- 재현: 이미 400문장 완료된 회차에서 `download()` 가 *일시적 네트워크 오류*(404 아님)로 실패 → `{}` 반환
  → `pending=전체` → 재번역 중 일부 배치 claude 실패(`continue`) → `save_existing` 이 **성공분만 담긴 더
  작은 맵으로 덮어씀** → 기존 완료 번역 일부 소실(다음 실행에 복구되나, 일시적 커버리지 후퇴 + 재작업/비용).
- 안전가드 제안(낮에 사람 리뷰로 적용): `load_existing` 에서 *파일 부재(404)* 와 *그 외 오류* 를 구분.
  404 면 `{}`(정상 신규), 그 외 다운로드 오류면 sentinel(예: `None`)을 반환해 `translate_episode` 가 그
  회차를 **이번 실행에서 건너뛰게**(덮어쓰지 않게) 한다. 또는 `save_existing` 직전에 한 번 더 load 해 merge.

**[A] 샤드 분할은 `episode_ids()` 안정성에 의존.** 각 샤드가 리스트를 *독립적으로* 계산하므로, 실행 중
  ingest 가 새 에피소드를 추가하면 샤드별 스냅샷이 달라져 중복배정/누락 가능. 오버나잇엔 ingest 미실행
  이라 안전. 가드: 오케스트레이터가 id 목록을 1회 스냅샷해 각 샤드에 명시 전달(`--ids`)하거나, 번역 중
  ingest 금지(현행 '한 번에 한 잡' 원칙과 합치).

**[E] 같은 샤드 이중 실행 주의.** 죽은 줄 알고 재시작했는데 옛 프로세스가 살아있으면 두 프로세스가 같은
  회차의 `{id}_ko.json` 을 번갈아 덮어써 맵이 진동(결국 수렴하나 재작업). 가드: 재시작 전 PID 종료 확인
  (메모리 `transcript-ko-pretranslation` 의 재개 절차에 'PID 죽음 확인 후 재실행' 명시 권장).

### 결론
- 정상 경로(네트워크 안정 + 단일 러너 + ingest 미동시)에서 **멱등·원자·재개 안전**. 위 B/A/E 는 드문
  비정상 경로의 일시적 후퇴(영구 데이터 손실 아님). 진행 중 잡은 그대로 두는 것이 맞다.

---

## 4. [견고성] 런타임 폴백 — ✅ 감사 완료(이미 견고, 코드 변경 없음 + 소수 제안)

### 검증 방법
- 코드 정독(translate.js / tts.js / clip.js / app.js / srs.js / study.js / essentials.js / timeline.js) +
  **헤드리스 스모크 PASS**(`scripts/_pwtest_async.py`: episode 10문장·study 5표현·timeline 3행, `window.__err`
  전부 [], 콘솔 error/warning 0).

### 이미 견고한 점(✅) — 변경 불필요
- **번역(MyMemory)**: `translateEnKo` 는 절대 throw 안 함. 429/403/QUOTA/WARNING 감지 시 `_trQuotaHit`
  세팅 → 세션 내 추가 호출 중단(실패 누적 방지). 네트워크 오류 → `''`(호출부가 조용히 패널 숨김).
- **음성**: `speak` = Storage mp3 재생 실패(404 등) → `browserFallback`(speechSynthesis). 미지원 브라우저면
  조용히 무음(크래시 X). `prefetch` 는 개별 `.catch(()=>{})`. `clip.js` 는 `play().catch(()=>{})` +
  `onerror=stopClip` 로 미처리 reject 없음.
- **오프라인 3티어 SW**: `networkFirst` 가 오프라인+미캐시일 때 rethrow → db.js 가 throw → **app.js 라우터
  try/catch 가 'Something went wrong'+Retry 로 강등**(무한 스피너/블랭크 없음). 전역
  `error`/`unhandledrejection` 안전망도 존재(콘솔 스팸 차단).
- **쓰기 실패 내성**: `srsReview().catch`, `markKnown().catch` 등 모든 변이 호출이 옵티미스틱+캐치.

### 소수 제안 (frozen 체인이라 NOTES 제안만 — 코드 미변경)
- **[음성 체인] 실제클립→TTS 캐스케이드 누락(런타임 오류 시)**: `playSentenceClip` 의 실제 클립이 로드/재생
  실패(`onerror`)하면 그냥 정지할 뿐 TTS 로 안 내려간다. 현재는 호출부(study `playExample`)가 audio_url
  유무로 *사전* 선택만 함. 개선: `playSentenceClip(...)` 에 옵셔널 `onError` 콜백 추가(기본=현행)→ 호출부가
  실패 시 `speak(text)` 로 폴백. **폴백 순서(클립→TTS) 유지**·하위호환. (체인 변경이라 사람 리뷰로 적용.)
- **[음성] 미지원 브라우저 무음 시 1회 토스트**("이 기기는 음성 미지원") — UX 힌트. 역시 음성 체인 손대므로 제안만.
- **[부팅] `boot()` 의 `getSession()` 무타임아웃**: getSession 은 로컬 우선이라 보통 즉시 반환(저위험). 만약을
  대비해 짧은 타임아웃 후 로그인/스피너로 강등하는 가드 고려 가능.

---

## 5. [UX] async 뷰 빈/에러/로딩 상태 — ✅ 감사 완료(이미 전 뷰 커버, 변경 없음)

라우터(app.js)가 **모든 뷰 핸들러를 try/catch 로 감싸고** 진입 시 스피너를 깐다. 그 위에 각 뷰가 로컬
빈/에러 상태까지 갖춰 이중 안전:

| 뷰 | 로딩 | 빈 데이터 | 에러 |
|---|---|---|---|
| Timeline | 라우터 스피너 | `No episodes yet.` / 검색 `No results.` | 라우터 바운더리 |
| Episode | 라우터 스피너 | `transcript pending` / `audio not downloaded yet` | 라우터 + transcript 시트 try/catch |
| Study | 라우터+섹션 스피너 | `No expressions.` / `Not enough…(4+)` / `No examples yet` | 로컬 `Failed to load: {msg}` |
| Essentials | 자체 스피너 | 카드/카테고리 0 가드 | 로컬 `Failed to load Essentials.`+뒤로 |
| SRS | 라우터 스피너 | `Review complete!`(CTA→Study) | 라우터 바운더리 |

- 헤드리스 스모크로 세 뷰 클린 렌더(에러 0) 확인. **추가할 빈/에러 상태 없음** — 이미 모범적.
- (참고) 시각 리디자인 금지 가드 준수: 어차피 변경할 것이 없었음.
