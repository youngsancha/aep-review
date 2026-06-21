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

## 3. 키 확보 (새 키 스타일)
**Project Settings → API Keys** 에서 복사. **새 키 스타일(`sb_publishable_…` / `sb_secret_…`)** 을 쓴다.
레거시 JWT(`eyJ…`) anon/service_role 키는 2026년 말 폐기 예정이니 새 프로젝트는 새 키만 사용.

| 값 | 어디에 쓰나 | 공개 여부 |
|---|---|---|
| **Project URL** (`https://xxxx.supabase.co`) | 프론트 + 인제스트 | 공개 OK |
| **Publishable** key (`sb_publishable_…`) | 프론트(`ui/config.js`) | 공개 OK (RLS 가 보호) |
| **Secret** key (`sb_secret_…`) | 마이그레이션·인제스트(`.env`, GitHub secret) | **절대 비공개** |

## 4. 로그인 계정 1개 생성
**Authentication → Users → Add user → Create new user**
- 이메일/비밀번호 입력 (본인이 쓸 1계정)
- **Auto Confirm User 체크** (이메일 확인 메일 생략)

> 이 계정으로 폰 PWA 에서 로그인한다. RLS 가 anon 을 차단하므로,
> 로그인하지 않으면 데이터가 전혀 안 보인다(= URL 노출돼도 안전).

## 5. 코드에 키 넣기
- 프론트: `ui/config.js` 의 `SUPABASE_URL`, `SUPABASE_ANON_KEY`(= publishable 키) 채우기.
- 인제스트/마이그레이션: 프로젝트 루트 `.env` 에
  ```
  SUPABASE_URL=https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY=sb_secret_...   # secret 키(새 스타일)
  ```
  (`.env` 는 git-ignore 됨 — 커밋 금지)

## 6. Google 로그인(OAuth) 켜기 — 선택(이메일/비번 외 원탭 로그인)
1. **Google Cloud Console** → *APIs & Services → Credentials* → **Create OAuth client ID**
   - Application type: **Web application**
   - **Authorized redirect URIs** 에 Supabase 콜백 추가:
     `https://lbcvuztpyaapyckxmqhk.supabase.co/auth/v1/callback`
     (로컬 테스트도 쓰면 `http://127.0.0.1:54321/auth/v1/callback` 추가)
   - 생성된 **Client ID / Client secret** 복사.
2. **Supabase → Authentication → Providers → Google** → 사용 설정 후 위 Client ID/Secret 붙여넣기 → Save.
3. **Authentication → URL Configuration → Redirect URLs** 에 앱 주소 추가:
   - 프로덕션: `https://<vercel-도메인>/`  (필요시 프리뷰: `https://*-<팀>.vercel.app/`)
   - 로컬: `http://localhost:8000/` 등 테스트로 쓰는 출처
   > Google 은 와일드카드 origin 을 허용하지 않으므로 프리뷰 URL 은 그때그때 추가해야 한다.
     Supabase Redirect URLs 는 와일드카드 OK.

> 코드 쪽은 이미 준비됨: 로그인 화면의 **Continue with Google** 버튼이
> `supabase.auth.signInWithOAuth({provider:'google'})`(PKCE) 를 호출하고,
> 복귀(`?code=`)는 `app.js` 가 자동 처리한다.

이후 절차는 `../README.md` 의 "마이그레이션 / 배포" 참고.

## 무료 티어 한도 (현재 데이터 기준 여유)
- DB 500MB (현재 수 MB) · Storage 1GB (transcripts 102MB + tts 수십 MB) · 대역폭 5GB/월
- 오디오는 원본 CDN 직접 스트리밍 → Storage/대역폭에 안 잡힘
