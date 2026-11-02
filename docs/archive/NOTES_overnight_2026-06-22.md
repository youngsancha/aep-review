# Overnight 작업 노트 — 2026-06-22 (branch: `loop/2026-06-22`)

무인 자율. 게이트 green 유지(깨지면 revert). 진행 중 4샤드 번역잡 **읽기만**(실행/`*_ko.json` write 0).
INVARIANTS 준수: 무빌드 바닐라 ESM·폴백 3종 체인 구조 불변·시크릿 경계 불변·RLS 구조 불변·additive 위주.
각 항목: plan → 구현 → 게이트(node --test·pytest·jscheck·웹 스모크) → 작은 커밋.

게이트 최종: **node --test 46 PASS · pytest 16 PASS · jscheck 23파일 0실패 · 헤드리스 스모크 PASS**.

---

## A. 차량(테슬라) 재생 연동

### A1. Media Session 풀 연동 — ✅ done (커밋 `fd3e48c`, 배포 v134)
- `ui/media-session.js`(신규) → 전역 `player` 에 배선. `navigator.mediaSession` 표준만(무권한·무라이브러리).
- 액션: `play`/`pause`/`seekbackward`(−15)/`seekforward`(+30)/`seekto`/`nexttrack`(빨리감기)/`previoustrack`(되감기).
  스킵량은 인앱 버튼과 동일(episode.js back15·fwd30) → 차/핸들/잠금화면/블루투스 컨트롤이 앱과 일관.
- 메타데이터(제목·쇼·아트워크) + `positionState`(길이·위치·속도, duration 유효 시 클램프) + `playbackState`.
- 미지원 환경 자동 no-op. 기존 플레이어/자막동기/시간→문장 매핑 **불변**(컨트롤만 얹음).
- 단위검증 `tests/media_session.test.mjs`(11): 액션→player 매핑·메타·위치 클램프·미지원 no-op·이벤트 배선.

### A2. 백그라운드/잠금화면 재생 견고성 — ✅ done(감사, 코드변경 없음)
- 이미 견고: `player.js` 는 **단일 `<audio>` 를 라우트 전환 내내 유지**(화면 바뀌어도 재생 지속).
  A1 의 Media Session 등록이 OS 에 '활성 미디어 세션'을 알려 백그라운드에서 덜 죽고, 잠금화면 컨트롤 동작.
- **한계(브라우저 정책 — 코드로 못 넘음, 명기)**:
  - 재생 시작은 **사용자 제스처 필요**(자동재생 차단) → Car Mode 도 큰 ▶ 를 직접 탭하게 설계.
  - 백그라운드 탭은 타이머 throttling 가능(오디오 재생 자체는 지속).
  - SW 업데이트 적용 reload 는 **화면이 가려질 때만**(app.js 기존 설계) — 포그라운드 사용 중엔 안 끊김.
    드물게 '백그라운드 재생 중 새 배포 reload' 가 오디오를 끊을 수 있음(버전 bump 시에만). 트레이드오프로 현행 유지.

### A3. 차량 친화 "이어듣기" UX (Car Mode) — ✅ done (커밋 `aeb0287`, 배포 v134)
- `ui/views/drive.js`(신규) + `#/drive` 라우트 + Library 헤더 **🚗 Car mode** 진입 pill.
- 거대한 ▶/일시정지(132px)·−15/+30(100px)·진행바·시각만. **학습 인터랙션(자막/단어) 배제**(운전 부담↓).
- 진입 시 현재 트랙 우선, 없으면 **마지막 이어듣기 지점 로드**(자동재생 X — 운전자가 직접 탭). 테마 변수 재사용(라/다크).
- 전역 `player` 재사용 → 미니플레이어/에피소드뷰와 상태 일관. player 구독 누수 정리.
- 순수 선택로직 `driveTarget` 소스추출 단위검증 `tests/drive.test.mjs`(4).
- PWA 홈화면 설치: index.html manifest/standalone 기존 구비 — 안드로이드 "홈 화면에 추가" 로 1탭 실행(체크리스트 참고).

### A4. ★ 실차 체크리스트 (갤럭시S23 + 테슬라) — **사람이 직접 확인** (자동화 불가)
> 자동 테스트 한계: 실제 블루투스/핸들/차량 디스플레이 연동은 헤드리스로 검증 불가. 아래는 수동 확인용.

1. **설치**: 폰 Chrome 으로 prod URL → ⋮ → "홈 화면에 추가" → 홈 아이콘으로 실행(주소창 없는 standalone).
2. **재생→블루투스 출력**: 차 블루투스 연결 후 앱에서 에피소드 재생 → 소리가 차 스피커로.
3. **잠금화면 컨트롤**: 폰 잠금 → 잠금화면에 제목/아트워크/재생바 표시, ⏯/⏪⏩ 동작.
4. **핸들 버튼**: 핸들의 재생/일시정지, 좌우(이전·다음 트랙) → 각각 ⏯ / −15·+30 스킵 동작.
5. **차량 디스플레이**: 테슬라 미디어 카드에 제목·아트워크·진행바, 화면 ⏯/스크럽 동작.
6. **Car Mode**: 앱 Library → 🚗 Car mode → 큰 버튼으로 이어듣기/스킵(거치 상태에서 시인성).
7. **이어듣기**: 일부 듣고 종료 → 재진입 시 마지막 지점에서 resume.
- ⚠️ **자동 실행 불가(한계)**: "차에 타면(키/블루투스 연결) 앱이 저절로 켜지는" 표준 웹 API 는 없음.
  → 회피책(구현 안 함, 제안만): **안드로이드 Tasker** 로 '특정 블루투스 연결 시 PWA 인텐트 실행' 자동화 가능.

---

## B. Study 표현 확장 + 학습

### B1. 표현 데이터 대폭 확장 — ✅ done (커밋 `108ffd7` 게이트 + `2a6612a` 확장, 배포 v134)
- `ui/data/essentials.json` **140 → 256 (+116)**. 신규 카테고리 5: **Negotiation/Calls/Presenting/Feedback/Networking**.
  기존 확장: meetings·email·business·smalltalk·opinions·softeners. 미국 현지 비즈니스 실전(협상/전화/발표/피드백/네트워킹/회의/이메일).
- 각 카드: 한국어 정의 + 자연스러운 예문 + `register`(상황 태그). 뉘앙스는 `ko` 글로스에 녹임.
- **품질 가드**: `tests/essentials_schema.test.mjs`(8) — 7필드 비어있지 않음·id 유일·cat 정합·term 대소문자 중복 0·
  미지 필드 차단·빈 카테고리 차단. 확장 중 **term 충돌 11건을 게이트가 검출 → 전부 교체**.
  기존 140장 **바이트 동일 보존(0 변경/0 누락)** 검증 후 커밋.
- ⚠️ 스키마 결정: "예문 2~3개 + 전용 뉘앙스 필드"는 **소비코드(essentials.js)가 7필드만 읽어** 추가 시 dead-data+UI 변경 필요.
  호환 INVARIANT 우선 → breadth(표현 수) 확장으로 해석. 다중 예문/뉘앙스 필드는 **스키마+UI 변경 후속**(아래 다음 우선순위).

### B2. 발음 보강 — ✅ done(검증 + 사전합성 목록)
- 폴백 검증: `tts.js speak()` 는 Storage `tts/{sha1}.mp3` 미존재(404) 시 **브라우저 TTS 로 자동 강등**(killBrowserTTS→speechSynthesis).
  → 새 표현은 사전합성 전까지도 발음 재생됨(무중단). 미지원 브라우저면 조용히 무음(크래시 X). 폴백 체인 **구조 불변**.
- ★ **사전합성 필요 목록(인제스트 = [사람]/별도, 외부 Storage write 라 야간 미실행)**:
  신규 116장 × (term + example) = **약 232개 클립**. 명령: `python -m scripts.pregen_essentials_tts`
  (멱등 — 기존 키 스킵, 신규만 edge-tts Jenny/-5% 합성·Storage 업로드). 실행 후 새 표현이 네이티브 음성으로 재생.

### B3. 학습 모드 — ◑ partial (기존 모드 자동 편입 done · 신규 모드/SRS 편입 제안)
- ✅ **신규 표현이 기존 Essentials 학습에 자동 편입**: 새 5개 카테고리가 탭으로 노출, 카드게임
  (recognition EN→뜻 / production 🇰🇷→EN)·리스트·스와이프 Known·Study 통계에 그대로 들어감(코드상 cats/cards 전수 소비 확인).
- ◑ **제안(후속, 야간 미구현 — 큰 파일 회귀위험·아키텍처 변경)**:
  - 전용 **상황별 퀴즈/예문 빈칸(cloze)/표현↔의미 매칭** 모드: study.js(1037 LOC)·essentials.js(270) 대수술 → 사람 리뷰 붙는 낮 별도 PR.
  - **SM-2 SRS 편입**: Essentials 는 현재 localStorage `aep-ess-known`(기기별) 사용. Supabase `srs_cards` 는
    episode vocab(vocab_id FK) 모델이라 Essentials 를 그대로 못 넣음 → essentials 전용 SRS 테이블/뷰 설계 필요(스키마 변경).
  - 다중 예문 + 뉘앙스 필드(B1 연계): essentials 스키마 7→N 필드 + 렌더 추가.

---

## C. AUDIT 기반 안전 항목

### C1. [P4·I1] `load_existing` 404 vs 일시오류 구분 — ✅ done (커밋 `6ab52d3`)
- `scripts/translate_transcripts.py`: `_is_not_found` 로 404(정상 신규→`{}`)와 일시오류(→`None`) 분리.
  `translate_episode` 는 `None` 이면 그 회차 **스킵(기존 `_ko.json` 보존)** → 일시 네트워크오류로 인한 커버리지 후퇴 방지.
  손상 JSON 자가치유(`{}`)는 유지. **진행 중 잡 무방해: 코드 가드만(실행/write 0).**
- `tests/test_load_existing_guard.py`(14): 가짜 client 주입 — 분류·반환계약·일시오류 스킵(save/claude 미호출). ruff clean.

### C2. [P5·I3] `boot()` getSession 타임아웃 가드 — ✅ done (커밋 `47916bd`)
- `withTimeout(promise, 3500ms, fallback)` 로 감싸 인증 네트워크 매달림 시 로그인/스피너로 강등.
  뒤늦게 세션 도착 시 `onAuthStateChange` 가 게이트 열어 무손실 복구. `tests/with_timeout.test.mjs`(4).

### C3. [P6·I6] 빌드리스 JS 게이트 — ✅ done (커밋 `278e121`)
- `scripts/jscheck.mjs`(의존성 0): ui/·tests/ 전 .js/.mjs 를 `node --check`(현재 23파일 PASS).
- `eslint.config.js`(flat) 준비 — ESLint 설치(npm=사람/네트워크) 후 `npx eslint ui tests scripts` 로 강게이트.
- (I2 음성 캐스케이드·I4 resegment 추출은 폴백체인/episode.js 대수술 = [사람 리뷰] → 미구현, 제안만.)

---

## ★ 사람 할 일 (loop 권한 밖 — 재명기)
1. **[P1] 정지된 4샤드 번역 잡 재개**: `logs/shard*.err` 2026-06-21 18:05 정지(잔존 `pythonw` PID 종료 확인 후)
   `python -m scripts.translate_transcripts --shard i/4`(i=0..3). C1 가드가 이제 재시작을 더 안전하게 함.
2. **[P2] 라이브 배포 검증**: Vercel prod **v134** 열어 로그인→Library→🚗 Car mode→재생→이어듣기, Essentials 새 카테고리 노출,
   SRS 채점 후 Supabase `srs_cards` 변경 확인. (A4 실차 체크리스트도)
3. **[사전합성] Essentials 신규 TTS**: `python -m scripts.pregen_essentials_tts` (≈232 클립, edge-tts→Storage. 외부 write 라 야간 제외).

## 다음 세션 우선순위
1. (사람) P1 잡 재개 → 구회차 사전번역 커버리지 회복 + (사람) pregen TTS.
2. B3 전용 학습모드(cloze/매칭/상황퀴즈) — 낮에 사람 리뷰로 study.js 별도 PR.
3. Essentials SRS 편입 설계(전용 테이블/뷰) — 기기 간 동기화 갭(localStorage)과 함께.
4. ESLint 실제 설치 후 강게이트 켜기 + 기존 ruff 43건 정리 PR(별도).
5. (사람 결정) 멀티유저 RLS — 쓸 경우 `proposed_multiuser_rls.sql` 옵션 A.

## git log (이번 세션, loop/2026-06-22)
```
278e121 test(js): 빌드리스 JS 게이트 + ESLint flat config (C3)
6ab52d3 fix(translate): load_existing 404 vs 일시오류 구분 (C1)
47916bd fix(boot): getSession 타임아웃 가드 (C2)
aeb0287 feat(drive): Car Mode 운전용 큰 버튼 화면 (A3)
fd3e48c feat(player): Media Session 연동 차량/핸들/잠금화면 (A1)
2a6612a feat(essentials): 비즈니스 표현 확장 140→256 (B1)
108ffd7 test(essentials): 데이터 품질 스키마 가드 (B1)
+ release: v134 bump (배포)
```
