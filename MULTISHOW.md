# 멀티-쇼 — 두 영어 팟캐스트 (American English Podcast + All Ears English)

aep-review 를 한 앱에서 **두 팟캐스트를 골라 듣는** 멀티-쇼 앱으로 확장. cnpod-review 패턴 이식.
코드는 `feat/multishow` 브랜치에 **완성·휴면(`MULTISHOW=false`)** 상태 — 라이브 단일쇼 앱과 100% 동일하게
동작한다. 아래 순서로 **[사람]이 활성화**한다(브랜치를 아직 main 에 머지하지 않은 이유 = ③ 참고).

## 무엇이 들어갔나 (코드, 완료)
| 영역 | 내용 | 커밋 |
|---|---|---|
| 설정/레지스트리 | `ui/config.js` SHOWS·`MULTISHOW`·currentShow / `ingest/shows.py`(slug+rss SSOT) | e8ab570 |
| 스키마 | `supabase/migration_multishow.sql`(라이브 전환) + `schema.sql`(신규 설치) | e8ab570 |
| 선택기 UI + 필터 | 라이브러리 상단 쇼 세그먼트(커버+이름+레벨) / `db.js` `.eq('show', …)` 게이트 | a75c762 |
| 인제스트 | `cron_fetch/rss_fetch/store/transcribe/extract_vocab` 의 `--show` 스레딩 | 7280c29 |
| 커버 쇼-인지 | episode/drive/미니플레이어가 현재 쇼 커버 동적 표시 | 495a351 |

설계 핵심: **episode id 는 두 쇼 공유 단일 시퀀스(전역 유일)** → R2 키(`{id}.mp3`)·transcript 경로·
hosted 매니페스트 그대로(쇼 네임스페이스 불필요). 쇼 구분은 `episodes.show` 한 컬럼 + `(show, guid)` 유일.

## 활성화 순서 ([사람] — 순서 중요)

### ① 마이그레이션 적용 (Supabase, 먼저)
Supabase 대시보드 → SQL Editor → `supabase/migration_multishow.sql` 전체 실행(멱등).
- 기존 264 episodes / 1905 vocab / 1905 srs 가 전부 `show='aep'` 로 백필됨.
- 검증: `select show, count(*) from episodes group by show;` → `aep | 264`.

### ② 브랜치 머지 (마이그레이션 후에)
```pwsh
git checkout main
git merge --ff-only feat/multishow   # 충돌 없으면 ff
git push origin main                  # Vercel 자동배포 — UI 는 여전히 휴면(MULTISHOW=false)
```
> 왜 마이그레이션 후에? 인제스트(`store.upsert_episodes`)가 `show` 컬럼에 write 한다. 일일 `aep-sync`
> cron 이 이 코드를 받기 전에 컬럼이 있어야 한다. ①을 먼저 하면 cron 은 그대로 안전(show='aep' 기록).

### ③ All Ears English 적재 (로컬, claude CLI + .env 있는 곳)
```pwsh
# RSS→STT→vocab→TTS 를 allears 쇼로. AEE 는 ~2747화라 점진 적재(최근 N부터).
python -m ingest.cron_fetch --show allears --rss-limit 50 --limit 10
#   --no-vocab 로 STT 만 먼저 돌리고, vocab+TTS 는 claude CLI 있는 로컬에서 마저.
```
- 오디오 싱크(자막=오디오): 기존 R2 호스팅 흐름 그대로 — `scripts/host_audio.py` / `scripts/retranscribe.py`
  가 `{id}.mp3`(전역 유일 id) 로 동작. `audio_hosted.json` 매니페스트는 두 쇼 공유(문제없음).
- 검증: `select show, count(*) from episodes group by show;` → allears 증가 확인.

### ④ 플래그 ON (선택기 노출)
`ui/config.js` 의 `export const MULTISHOW = false;` → `true` 로 바꾸고 버전 bump 배포:
```pwsh
python -m scripts.release "feat(multishow): 두 팟캐스트 선택 활성화"
```
→ 라이브러리 상단에 쇼 선택기 등장, 두 팟캐스트 전환 가능. 앱 재방문 시 폰 PWA 가 새 셸 수신.

## 롤백 / 안전
- 언제든 `MULTISHOW=false` 로 되돌리면 선택기 숨김 + 단일쇼(aep)로 복귀(데이터는 그대로 남음).
- 마이그레이션은 **additive**(컬럼/인덱스 추가) — 되돌릴 필요 없음. allears 데이터만 안 보일 뿐.
- 게이트: `node --test` / `pytest` / `node scripts/jscheck.mjs` 모두 green 유지. 깨지면 직전 커밋으로 revert.

## 자율 범위 밖 ([사람] 전용)
- AEE **전체 시즌(~2747화) 백필**은 거대 STT+vocab 잡(시간·연산) → 장기 [사람] ingest.
- Supabase 마이그레이션 적용 / R2 호스팅 실행 / claude CLI vocab(외부 자원).
