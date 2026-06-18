# Supabase 셋업 (사용자 1회 작업)

aep-review 의 클라우드 백엔드. **이 단계만 사용자가 직접** 하면, 나머지(마이그레이션·
프론트·인제스트)는 코드가 처리한다.

## 1. 프로젝트 생성
1. https://supabase.com → 로그인 → **New project**
2. Region 은 `Northeast Asia (Seoul)` 권장 (한국에서 지연 최소)
3. DB 비밀번호는 아무거나(쓸 일 없음). 생성 완료까지 ~2분.

## 2. 스키마 실행
1. 좌측 **SQL Editor** → **New query**
2. `supabase/schema.sql` 전체 붙여넣기 → **Run**
3. 테이블 `episodes / vocab_cards / srs_cards`, 뷰 `episodes_list`,
   Storage 버킷 `transcripts / tts` 가 생성됐는지 확인 (Table Editor / Storage 탭).

## 3. 키 확보
**Project Settings → API** 에서 3가지 복사:

| 값 | 어디에 쓰나 | 공개 여부 |
|---|---|---|
| **Project URL** (`https://xxxx.supabase.co`) | 프론트 + 인제스트 | 공개 OK |
| **anon public** key | 프론트(`ui/config.js`) | 공개 OK (RLS 가 보호) |
| **service_role** key | 마이그레이션·인제스트(`.env`, GitHub secret) | **절대 비공개** |

## 4. 로그인 계정 1개 생성
**Authentication → Users → Add user → Create new user**
- 이메일/비밀번호 입력 (본인이 쓸 1계정)
- **Auto Confirm User 체크** (이메일 확인 메일 생략)

> 이 계정으로 폰 PWA 에서 로그인한다. RLS 가 anon 을 차단하므로,
> 로그인하지 않으면 데이터가 전혀 안 보인다(= URL 노출돼도 안전).

## 5. 코드에 키 넣기
- 프론트: `ui/config.js` 의 `SUPABASE_URL`, `SUPABASE_ANON_KEY` 채우기.
- 인제스트/마이그레이션: 프로젝트 루트 `.env` 에
  ```
  SUPABASE_URL=https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY=eyJ...   # service_role
  ```
  (`.env` 는 git-ignore 됨 — 커밋 금지)

이후 절차는 `../README.md` 의 "마이그레이션 / 배포" 참고.

## 무료 티어 한도 (현재 데이터 기준 여유)
- DB 500MB (현재 수 MB) · Storage 1GB (transcripts 102MB + tts 수십 MB) · 대역폭 5GB/월
- 오디오는 원본 CDN 직접 스트리밍 → Storage/대역폭에 안 잡힘
