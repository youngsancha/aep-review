// Supabase 공개 설정 — 커밋해도 안전(RLS 가 데이터를 보호).
// supabase/README.md 의 3단계에서 Project URL / anon public key 를 복사해 채운다.
//
// ⚠️ service_role(secret) 키는 절대 여기 넣지 말 것 (프론트는 publishable/anon 키만).
export const SUPABASE_URL = 'https://lbcvuztpyaapyckxmqhk.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Ql1_5-UEpclxRc8LLQ3D2A_3748Xz07';

// Cloudflare R2 공개(읽기) 베이스 — 우리가 STT 한 '바로 그 오디오'를 호스팅. 공개 URL 이라 커밋 OK.
// 앱은 호스팅된 회차(audio_hosted.json 매니페스트)만 여기서 스트리밍 → 자막=오디오 영구 일치(완전 자동 싱크).
// 멀티-쇼 주의: 에피소드 id 는 두 쇼가 공유하는 단일 시퀀스(전역 유일)라 R2 키를 쇼별로 나눌 필요 없다
// (`{id}.mp3` 그대로). cnpod 와 달리 aep 는 기존 호스팅 오디오를 재업로드하지 않아도 멀티-쇼 가능.
export const R2_PUBLIC_BASE = 'https://pub-6226ae33abbc474dbea6ae140582eb8d.r2.dev';
export function hostedAudioUrl(id) { return `${R2_PUBLIC_BASE}/${id}.mp3`; }

// MyMemory 번역 API 무료 한도 키. 익명은 하루 ~1천 단어로 금방 소진(429) → 이메일 지정 시
// 하루 5만 단어. 비우면 익명으로 동작(권장X).
// ⚠ 2026-07-26 저장소가 PUBLIC 으로 전환됐다(GitHub Actions 분 한도 때문). 이 파일은 원래도
// 브라우저로 서빙되는 클라이언트 모듈이라 이 주소는 예전부터 앱 사용자에게 보였지만, 이제는
// 공개 저장소에서 스크래핑 대상이기도 하다. 바꾸려면 전용 별칭(yscha.roy+mymemory@)으로 교체할 것
// — 비우면 한도가 하루 1천 단어로 떨어져 번역 품질이 실제로 나빠지므로 그냥 지우지는 말 것.
export const TRANSLATE_EMAIL = 'yscha.roy@gmail.com';

// 앱 이름(쇼 이름과 다르다) — 단일 출처. 쇼는 SHOWS[].name, 앱 전체는 이것.
// media-session.js 는 node 단위테스트를 위해 의도적으로 import 가 없어 같은 문자열을 자체 보관하며,
// tests/media_session.test.mjs 가 두 값이 어긋나지 않도록 고정한다.
export const APP_NAME = 'E-Podcast';

// ─────────────────────────── 멀티-쇼: 한 앱, 두 영어 팟캐스트 ───────────────────────────
// cnpod-review(중국어 멀티-쇼)와 같은 패턴을 영어 두 쇼에 적용:
//   American English Podcast(기존) + All Ears English(추가).
// slug = episodes.show 컬럼 값이자 UI 선택 식별자. 두 쇼 모두 Megaphone 호스팅 → 기존 megaphone
// clean-URL/R2 재전사 싱크 그대로 적용됨(traffic.megaphone.fm 패턴 공통).
//
// ⚠️ 활성화 순서(중요 — 라이브 단일쇼 앱을 깨지 않으려면):
//   ① supabase/migration_multishow.sql 적용(episodes/vocab/srs 에 show 컬럼 + 기존행 'aep' 백필)
//   ② All Ears English 인제스트(python -m ingest.cron_fetch --show allears …) — [사람]/장기 잡
//   ③ 이 MULTISHOW 를 true 로 커밋·배포 → 쇼 선택기 노출 + 쿼리에 show 필터 적용
// MULTISHOW=false 동안은 기존 단일쇼(aep)와 **완전히 동일**하게 동작(컬럼 없어도 안전).
// 활성화됨(v137, 중간 상태): ①마이그레이션 적용 ②AEE 적재 진행 중(65+/250) → 선택기 노출.
// 기본 쇼는 aep 라 켜도 AEP 경험은 그대로; AEE 는 상단 선택기 탭 시 노출(부분 적재분).
export const MULTISHOW = true;

// 쇼 커버(megaphone imgix — w/h 리사이즈·webp 자동). RSS itunes:image 에서 가져온 공식 아트워크.
const _AEP_COVER = 'https://megaphone.imgix.net/podcasts/15526600-fb41-11ee-92ae-93bb88e95bb6/image/17f5482ab2cc597b1acfc1f8b7dc45e8.jpg?auto=format,compress&fit=crop';
const _AEE_COVER = 'https://megaphone.imgix.net/podcasts/88b85f10-a0c0-11ec-9e52-bfcf9441f742/image/All_Ears_English_New_Cover_with_Michelle_Under_500_KB.jpg?ixlib=rails-4.3.1&fit=crop&auto=format,compress';
const _CNN10_COVER = 'https://megaphone.imgix.net/podcasts/642870d2-5a7b-11ef-a320-db1aac295786/image/34e52f51ea1ae5a06e58fb8c37bc51e2.jpg?ixlib=rails-4.3.1&fit=crop&auto=format,compress';

export const SHOWS = [
  {
    slug: 'aep',
    name: 'American English Podcast',
    short: 'American English',
    host: 'Shana Thompson',
    level: '중급–고급 · 발음·표현 집중',
    rss: 'https://feeds.megaphone.fm/americanenglishpodcast',
    cover: _AEP_COVER,
  },
  {
    slug: 'allears',
    name: 'All Ears English',
    short: 'All Ears English',
    host: 'Lindsay & Michelle',
    level: '중급–고급 · 일상·비즈니스 ESL',
    source: 'rss',
    rss: 'https://feeds.megaphone.fm/allearsenglish',
    cover: _AEE_COVER,
  },
  {
    // White House 브리핑 — RSS 없음(whitehouse.gov 스크레이프 + yt-dlp, ingest/wh_fetch.py).
    // 미 연방정부 저작물이라 미국 내 퍼블릭 도메인. 격식 영어·시사 어휘·Q&A 청해용.
    slug: 'wh',
    name: 'White House Briefing',
    short: 'White House',
    host: 'Press Secretary & officials',
    level: '고급 · 격식체·시사·Q&A 청해',
    source: 'whitehouse',
    rss: null,
    cover: '/icons/wh-cover.png?v=1',   // whitehouse.gov 공식 앱 아이콘(apple-touch-icon 180²). ?v=1 로 뷰의 &w=..&h=.. 부착이 유효 쿼리
  },
  {
    slug: 'cnn10',
    name: 'CNN 10',
    short: 'CNN 10',
    host: 'CNN Podcasts',
    level: '중급 · 시사 뉴스 10분',
    rss: 'https://feeds.megaphone.fm/WMHY2232473209',
    cover: _CNN10_COVER,
  },
];
export const SHOW_BY_SLUG = Object.fromEntries(SHOWS.map((s) => [s.slug, s]));
export const DEFAULT_SHOW = 'aep';
const SHOW_KEY = 'aep-show';

// 현재 선택된 쇼(localStorage). MULTISHOW=false 면 항상 기본 쇼(aep) — 기존 동작 보존.
export function currentShow() {
  if (!MULTISHOW) return DEFAULT_SHOW;
  try { return localStorage.getItem(SHOW_KEY) || DEFAULT_SHOW; } catch (e) { return DEFAULT_SHOW; }
}
export function setCurrentShow(slug) {
  if (SHOW_BY_SLUG[slug]) { try { localStorage.setItem(SHOW_KEY, slug); } catch (e) {} }
}
export function showMeta(slug) { return SHOW_BY_SLUG[slug || currentShow()] || SHOWS[0]; }
export function showCover(slug) { return showMeta(slug).cover; }

// 쇼 선택기 렌더용(순수 — 테스트 가능): 각 쇼 + 현재 선택여부. UI 가 이걸로 세그먼트를 그린다.
export function showOptions() {
  const cur = currentShow();
  return SHOWS.map((s) => ({ slug: s.slug, name: s.name, short: s.short, host: s.host, level: s.level, cover: s.cover, active: s.slug === cur }));
}

// 기존 뷰 호환(다수 뷰가 import) — 현재 쇼 커버의 사이즈 변형. 단일쇼(flag off)면 aep 커버 그대로라
// 기존 픽셀과 100% 동일. 쇼 전환 시 앱이 재라우팅/리로드되어 모듈 재평가 → 새 커버 반영.
export const SHOW_COVER = showCover() + '&w=720&h=720';
export const SHOW_COVER_SM = showCover() + '&w=160&h=160';  // 앱 UI 는 각 뷰가 자체 계산본을 쓰지만 config 계약(테스트)이 이 export 를 검증
