# aep-review

American English Podcast (Shana Thompson) 복습 PWA.
**Supabase + Vercel + PWA** 서버리스 스택 — PC 없이 폰만으로 항상 사용.

> **멀티-쇼(배포됨·휴면):** 한 앱에서 두 영어 팟캐스트(American English Podcast +
> All Ears English)를 골라 듣는 기능이 main 에 배포돼 있다(`MULTISHOW=false` 라 현재는 단일쇼,
> 라이브 동작 불변). 두 번째 쇼 활성화 절차는 **[MULTISHOW.md](MULTISHOW.md)** 참고
> (마이그레이션 → AEE 적재 → 플래그 ON).

## 아키텍처

```
[인제스트] GitHub Actions / 로컬 GPU   ← Python 은 여기에만
  RSS → 임시 mp3 → faster-whisper STT → claude vocab → edge-tts 미리 합성
       → Supabase write (Postgres 행 + Storage 파일)

[저장] Supabase (무료)
  Postgres: episodes / vocab_cards / srs_cards (+ view episodes_list) + RLS
  Storage : transcripts/{id}.json · tts/{sha1}.mp3  (public read)

[앱] Vercel(정적) + PWA
  데이터 : @supabase/supabase-js 직접 쿼리 (런타임 서버 0)
  오디오 : <audio src=episode.audio_url>  ← 원본 CDN 직접 스트리밍
  TTS    : Storage 의 미리 생성된 mp3, 없으면 브라우저 TTS 폴백
  인증   : Supabase Auth (email+password) 단일 사용자
```

## 셋업 순서

### 1. Supabase (1회, 사용자 직접)
`supabase/README.md` 참고 — 프로젝트 생성 → `supabase/schema.sql` 실행 →
키 확보 → 로그인 계정 1개 생성.

### 2. 키 채우기
- 프론트: `ui/config.js` 에 `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
- 인제스트: 루트 `.env` 에 `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (`.env.example` 참고).

### 3. 로컬 확인
```pwsh
npx serve ui          # 또는: python -m http.server 8000 --directory ui
```
브라우저로 열어 로그인 → 타임라인/오디오/트랜스크립트/SRS 동작 확인.
(crypto.subtle 은 https 또는 localhost 에서만 동작 — LAN IP http 로는 TTS 키 계산 불가)

### 4. Vercel 배포
이 폴더는 git 미초기화 → GitHub repo 를 만들고(인제스트 cron 에도 필요) Vercel 에 연결.
```pwsh
git init && git add -A && git commit -m "supabase+vercel migration"
# GitHub 에 push 후 https://vercel.com → New Project → 이 repo import
```
`vercel.json` 이 `ui/` 를 사이트 루트로 서빙한다(빌드 없음). anon 키는 `config.js` 에 있어
Vercel 시크릿 불필요. 배포 URL 을 폰에서 열어 **PWA 설치** → 홈 화면 앱처럼 사용.

또는 CLI 즉시 배포: `npx vercel --prod`.

## 지속 인제스트 (신규 에피소드)
```pwsh
python -m ingest.cron_fetch              # RSS→STT→vocab→TTS, Supabase 에 write
python -m ingest.cron_fetch --no-vocab   # STT 만 (claude CLI 없을 때)
```
- `.github/workflows/aep-sync.yml` 가 매일 cron 으로 STT 까지 수행(CI 는 `--no-vocab`).
- vocab+TTS 는 claude CLI(Claude Max) 가 있는 로컬에서 `cron_fetch` 로 마저 처리.
  GitHub repo secret 에 `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` 등록 필요.

## 구조
- `ui/` — PWA (vanilla JS). `db.js`=Supabase 데이터 shim, `supabase.js`/`config.js`=클라이언트.
- `ingest/` — RSS/STT/vocab/TTS 파이프라인. `store.py`=Supabase sink(단일 출처).
- `supabase/` — `schema.sql` + 셋업 가이드.

## 비용
$0 — Supabase 무료(DB 500MB / Storage 1GB / 대역폭 5GB) + Vercel Hobby +
GitHub Actions + Edge TTS. 오디오는 원본 CDN 스트리밍이라 Storage/대역폭에 안 잡힘.

## 데이터 소스
RSS: `https://feeds.megaphone.fm/americanenglishpodcast` (Shana Thompson, Megaphone)
