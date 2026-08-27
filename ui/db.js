// 데이터 접근 shim — 기존 /api/* 응답 모양을 Supabase 직접 호출로 재현.
// 뷰(timeline/episode/srs)는 받는 데이터 모양만 같으면 거의 그대로 동작한다.
import { supabase, STORAGE_URL } from '/supabase.js';
import { hostedAudioUrl, currentShow, MULTISHOW } from '/config.js';

const NEW_LIMIT = 5;
const REVIEW_LIMIT = 50;

// 멀티-쇼: 활성화(MULTISHOW)면 현재 쇼로 필터(episodes_list/vocab_cards/srs_cards 모두 show 보유).
// 비활성(기본)이면 무필터 → 기존 단일쇼 동작·스키마와 완전히 동일(컬럼 없어도 안전). id 로 직접
// 찾는 getEpisode/markKnown/srsReview 는 id 가 전역 유일이라 쇼 필터 불필요.
const withShow = (q) => (MULTISHOW ? q.eq('show', currentShow()) : q);

// 네트워크 읽기는 '실패'할 수는 있어도 '끝나지 않아'서는 안 된다.
// (사용자 신고 2026-07-29, 차량 오프라인: 라이브러리가 스켈레톤에 영구 고착. 원인은 supabase-js 가
//  인증 요청을 navigator.locks 로 직렬화하는데, 오프라인에서 토큰 갱신이 재시도를 반복하며 락을
//  쥐고 있어 뒤따르는 PostgREST 호출이 '요청조차 나가지 못한 채' 영원히 대기한 것. 실패가 아니라
//  침묵이라 route() 의 catch 도, 뷰의 에러 상태도 발동하지 않았다.)
// 거절시키면 기존 에러 경로(route catch·뷰 빈상태)가 정상 동작한다.
const READ_DEADLINE_MS = 8000;
export function withDeadline(promise, label, ms = READ_DEADLINE_MS) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

// 로컬(폰) 기준 오늘 날짜 YYYY-MM-DD — srs due_date 비교용
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─────────────────────────── episodes ───────────────────────────
// GET /api/episodes 대체
// 라이브러리 목록 스냅샷 — 오프라인에서 목록을 '네트워크 없이' 그리기 위한 마지막 성공본.
// SW 의 DATA_CACHE 에 의존하지 않는 이유: 오프라인에서는 supabase-js 가 실패하는 토큰 갱신을
// navigator.locks 로 붙들고 있어 REST 요청이 아예 나가지 못한다(실측: auth 7회 / REST 0회).
// 즉 SW 까지 도달을 못 하므로 캐시가 있어도 못 쓴다. 스냅샷은 그 경로를 통째로 우회한다.
const EPS_SNAP_KEY = () => 'aep-eps-snap-' + (MULTISHOW ? currentShow() : '_');
const EPS_SNAP_MAX = 300;
function saveEpisodesSnapshot(rows) {
  try {
    // description 은 회차당 수 KB 라 목록엔 불필요 — 빼야 localStorage 한도에 안전하게 들어간다.
    // `_description` 로 받는 건 버리기 위해서다(eslint 는 `_` 접두 미사용 변수를 허용).
    const slim = rows.slice(0, EPS_SNAP_MAX).map(({ description: _description, ...r }) => r);
    localStorage.setItem(EPS_SNAP_KEY(), JSON.stringify(slim));
  } catch (e) { /* quota — 스냅샷은 있으면 좋은 것이지 필수는 아니다 */ }
}
export function loadEpisodesSnapshot() {
  try {
    const v = JSON.parse(localStorage.getItem(EPS_SNAP_KEY()) || 'null');
    return Array.isArray(v) && v.length ? v : null;
  } catch (e) { return null; }
}

// 회차 '상세'(행 + vocab) 스냅샷 — 목록 스냅샷과 같은 이유, 같은 패턴. 회차 화면은 getEpisode()
// 한 번에 전부를 걸고 있어서(views/episode.js: `const ep = await getEpisode(id)`) 이 읽기가 늦으면
// 화면이 통째로 스피너에 멈춘다.
//
// ⛔ '오프라인이면 SW 캐시(DOC_CACHE)가 받아준다'는 가정은 틀렸다 — 요청이 거기까지 가는 데 걸리는
//    시간이 문제다. 실측(2026-08-27, 실제 supabase-js·오프라인·만료 세션, 앱 코드 없이 단독 계측):
//      · 만료 세션 + 오프라인 → PostgREST 읽기 한 건이 **32.6초** 뒤에야 settle. auth 7회 재시도가
//        _getAccessToken() 안에서 인라인으로 돌고, 그게 끝나야 REST 요청이 나간다.
//      · 동시 3건도 32.6초(같은 갱신을 함께 기다림) — 곱해지지는 않는다.
//      · ⛔ app.js 의 오프라인 우회가 부르는 stopAutoRefresh() 로는 1ms 도 안 줄었다(32.59초).
//        그 주석의 전제("갱신을 멈추면 락이 풀린다")는 지금 supabase-js 에선 더 이상 맞지 않는다 —
//        비용은 백그라운드 갱신 루프가 아니라 getSession() 안의 '인라인' 갱신이다.
//      · 아직 안 만료된 세션이어도 오프라인이면 7.3초(REST 재시도 4회).
//    즉 유일하게 확실한 우회는 supabase-js 를 아예 안 거치는 것이다. 목록이 이미 그렇게 하고 있고
//    (위 EPS_SNAP), 상세만 빠져 있었다(사용자 신고 2026-08-27 "오프라인모드 안됨": 회차 화면이
//    스피너에서 안 넘어감 — 실제로는 33초쯤 뒤에 그려지지만 사람이 기다릴 시간이 아니다).
//
// 저장 대상은 '행 + vocab' 뿐이다. 자막(.json)·한글번역(_ko.json)·오디오는 인증이 필요 없는 공개
// Storage/R2 URL 이라 SW 캐시로 오프라인에서 정상 동작한다 — 여기 중복 저장할 이유가 없다.
//
// ⚠ 알고 받아들이는 트레이드오프(xcheck 패널 grok 지적, 2026-08-27): 스냅샷을 쓰는데 자막은
// 네트워크에서 새로 받는 조합에서는, 그 사이 재STT 가 돌았다면 vocab 의 sentence_start_sec 가
// 옛 자막 기준이라 vocab 탭 점프가 몇 초 어긋날 수 있다(자막 하이라이트 자체는 새 자막 기준이라
// 정확하다). 오프라인일 때는 자막도 같은 `?v=` URL 로 SW 캐시에서 나오므로 둘이 항상 짝이 맞고,
// 이 창은 '온라인인데 PostgREST 만 느린' 경우로 좁다. 지금은 클라이언트가 이걸 감지할 방법이
// 없다 — transcripts/{id}.json 에 transcribed_at 이 안 들어 있고, `?v=` 는 캐시버스터일 뿐
// 내용을 고르지 않는다(파일은 제자리에서 덮인다). 자막 JSON 에 transcribed_at 을 넣으면
// 여기서 대조해 어긋난 vocab 시각을 버릴 수 있다 → td-task 로 등록.
const EP_SNAP_KEY = (id) => `aep-ep-snap-${id}`;
const EP_SNAP_LRU = 'aep-ep-snap-lru';   // 최근 저장 id 목록(오래된 것부터 앞) — 용량 상한용
const EP_SNAP_MAX = 40;                  // offlineCount() 상한(30) + 최근에 그냥 열어본 회차 여유
// 스냅샷이 있으면 '포기 비용'이 싸다 → 빨리 포기하고 즉시 그린다(listEpisodes 와 같은 규칙).
const EP_SNAP_DEADLINE_MS = 2500;

function epSnapLru() {
  try {
    const v = JSON.parse(localStorage.getItem(EP_SNAP_LRU) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}
// 요청 번호 — '늦게 도착한 옛 응답이 더 새 응답을 덮어쓰는' 경합을 막는다. 데드라인을 넘긴 요청은
// 계속 살아 있다가 나중에 스냅샷을 갱신하는데, 그 사이 온라인 복귀로 다시 읽어 더 새 값이 이미
// 저장돼 있을 수 있다. 그때 지각 응답이 그냥 쓰면 방금 받은 vocab 이 옛 것으로 되돌아간다.
// (xcheck 패널 grok 지적, 2026-08-27.)
let _epReqSeq = 0;
const _epSnapSeq = new Map();   // id → 그 회차 스냅샷을 마지막으로 쓴 요청 번호

function saveEpisodeSnapshot(id, row, seq) {
  const key = String(id);
  if (seq != null) {
    const last = _epSnapSeq.get(key);
    if (last != null && last > seq) return;   // 이미 더 새 응답이 저장됐다 — 지각 응답은 버린다
    _epSnapSeq.set(key, seq);
  }
  try {
    // transcript/transcript_ko 는 붙기 전이지만, 혹시 호출 순서가 바뀌어도 절대 안 들어가게 막는다
    // (수 MB 짜리라 한 번만 새도 localStorage 가 즉시 터진다).
    const { transcript: _t, transcript_ko: _tk, ...slim } = row;
    let lru = epSnapLru().filter((k) => k !== key);
    lru.push(key);
    // 상한 초과분 정리 → 그 다음에 쓴다. 쓰기가 quota 로 실패하면 한 개씩 더 비우고 재시도한다
    // (조용히 실패하면 '오프라인에서 이 회차만 안 열림'이 되는데, 원인을 찾기가 매우 어렵다).
    for (const old of lru.splice(0, Math.max(0, lru.length - EP_SNAP_MAX))) {
      try { localStorage.removeItem(EP_SNAP_KEY(old)); } catch (e) {}
    }
    const payload = JSON.stringify(slim);
    let wrote = false;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          localStorage.setItem(EP_SNAP_KEY(key), payload);
          wrote = true;
          break;
        } catch (e) {
          // quota — 가장 오래된 스냅샷을 버리고 다시 시도. 자기 자신만 남으면 포기한다.
          const victim = lru.find((k) => k !== key);
          if (!victim) break;
          lru = lru.filter((k) => k !== victim);
          try { localStorage.removeItem(EP_SNAP_KEY(victim)); } catch (e2) {}
        }
      }
    } finally {
      // 끝내 못 썼으면 자기 자신도 색인에서 뺀다 — 색인은 '실제로 저장돼 있는 것'과 정확히 일치해야
      // 한다. (첫 수정은 이 줄이 없어서 실패한 회차가 그대로 유령으로 남았다 — 테스트가 잡았다.)
      if (!wrote) { lru = lru.filter((k) => k !== key); _epSnapSeq.delete(key); }
      // ⛔ 색인은 성공/실패와 무관하게 반드시 쓴다. 예전엔 성공 경로에서만 썼는데, 4번을 다 실패하면
      // 이미 지운 회차들이 색인에 '유령'으로 남았다 — 다음 저장이 그 유령들을 다시 evict 하려 들고
      // removeItem 은 no-op 이라 0바이트를 비운 채 재시도를 낭비한다(quota 복구가 영구히 무력화).
      // (xcheck 패널 gemini 지적, 2026-08-27.)
      try { localStorage.setItem(EP_SNAP_LRU, JSON.stringify(lru)); } catch (e) {}
    }
  } catch (e) { /* 스냅샷은 있으면 좋은 것이지 필수는 아니다 */ }
}
export function loadEpisodeSnapshot(id) {
  try {
    const v = JSON.parse(localStorage.getItem(EP_SNAP_KEY(id)) || 'null');
    return v && typeof v === 'object' && v.id != null ? v : null;
  } catch (e) { return null; }
}

export async function listEpisodes() {
  // 기다릴 가치는 '포기했을 때 잃는 것'에 비례한다. 스냅샷이 있으면 실패가 싸므로 빨리 포기하고
  // 즉시 목록을 그린다. 스냅샷이 없으면 빈 화면뿐이라 느린 회선에도 끝까지 기다린다.
  const snapFirst = loadEpisodesSnapshot();
  try {
    const { data, error } = await withDeadline(
      withShow(supabase.from('episodes_list').select('*'))
        .order('pub_date', { ascending: false, nullsFirst: false }),
      'listEpisodes', snapFirst ? 2500 : READ_DEADLINE_MS);
    if (error) throw new Error(error.message);
    const rows = data || [];
    if (rows.length) saveEpisodesSnapshot(rows);
    return rows;
  } catch (e) {
    const snap = loadEpisodesSnapshot();
    if (snap) {
      console.warn('[db] listEpisodes failed → 스냅샷 사용:', e && e.message);
      return snap;
    }
    throw e;
  }
}

// 이전/다음 '에피소드'(곡) id — ⏮/⏭ 트랙 이동용. 라이브러리와 같은 쇼 안에서 시간순(pub_date asc)
// 으로 줄세워, 더 나중에 나온 화가 '다음'(다음 회차), 더 예전 화가 '이전'(이전 곡)이 된다.
// id+pub_date 만 가볍게 받아 메모리에서 인접 회차를 찾는다(수백 행이라 단일 쿼리로 충분).
// 회차 순서 id 목록은 세션 중 거의 안 바뀌므로 쇼별로 1회만 받아 메모(회차 열 때마다·오프라인
// 프리페치마다 전체 목록을 다시 받던 낭비 제거). 쇼 전환 시 키가 바뀌어 자동 갱신, 새 회차는 다음
// 부팅에 반영(prev/next 네비 용도라 세션 내 staleness 무해).
let _navIds = null, _navIdsShow = null;
export async function episodeNav(id) {
  const show = MULTISHOW ? currentShow() : '_';
  if (!_navIds || _navIdsShow !== show) {
    const { data, error } = await withShow(
      supabase.from('episodes_list').select('id, pub_date'))
      .order('pub_date', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true });
    if (error) throw new Error(error.message);
    _navIds = (data || []).map((e) => e.id);
    _navIdsShow = show;
  }
  const ids = _navIds;
  const i = ids.indexOf(Number(id));
  if (i < 0) return { prevId: null, nextId: null };
  return {
    prevId: i > 0 ? ids[i - 1] : null,
    nextId: i < ids.length - 1 ? ids[i + 1] : null,
  };
}

// 광고 리다이렉트 체인(podtrac/pscrb/swap.fm…)을 벗겨 megaphone CDN 직접 URL 로.
// RSS audio_url 은 6단계 302 광고 추적 래퍼라 모바일에서 재생 시작이 느리고/불안정하며,
// 요청마다 동적 광고가 끼어 길이가 달라져 트랜스크립트 타임스탬프와 어긋난다.
// 다행히 최종 megaphone 경로가 원본 문자열 끝에 그대로 박혀 있어 정규식으로 추출 가능.
const _MEGAPHONE = /(traffic\.megaphone\.fm\/[A-Za-z0-9_-]+\.mp3)/;
export function cleanAudioUrl(u) {
  if (!u) return u;
  const m = u.match(_MEGAPHONE);
  return m ? 'https://' + m[1] : u;
}

// 호스팅 완료 매니페스트 — 이 목록의 회차만 R2(자막=오디오)로 스트리밍. 1회 fetch 후 메모리 캐시.
let _hosted = null, _hostedP = null;
export async function hostedSet() {
  if (_hosted) return _hosted;
  if (!_hostedP) {
    _hostedP = (async () => {
      // 최대 3회 재시도. 성공해야만 영구 캐시(_hosted). 끝까지 실패하면 이 세션을 megaphone(DAI)로
      // '오염'시키지 않도록 빈 집합을 굳히지 않고(_hostedP 리셋) 다음 호출이 다시 받게 한다.
      // (과거 버그: 일시적 fetch 실패 → 빈 집합 캐시 → 그 세션 전체가 megaphone 폴백 → 자막 desync.)
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(`${STORAGE_URL}/transcripts/audio_hosted.json`, { cache: 'no-cache' });
          if (r.ok) {
            const a = await r.json();
            _hosted = new Set((a || []).map(Number));
            return _hosted;
          }
        } catch (e) { /* 재시도 */ }
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      }
      _hostedP = null;            // 실패는 캐시하지 않음 → 다음 호출 재시도
      return new Set();
    })();
  }
  return _hostedP;
}
// 예문 한국어 사전번역 맵(vocab_id → ko). 1회 fetch 후 메모리 캐시. (scripts/translate_examples 생성)
let _exKo = null, _exKoP = null;
export async function examplesKo() {
  if (_exKo) return _exKo;
  if (!_exKoP) {
    _exKoP = fetch(`${STORAGE_URL}/transcripts/examples_ko.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : {}))
      .then((m) => { _exKo = m || {}; return _exKo; })
      .catch(() => { _exKo = {}; return _exKo; });
  }
  return _exKoP;
}
// 자막 Storage URL — 단일 출처. offline.js 가 오프라인 doc 캐시(transcript pin) 준비여부를
// 확인·정리할 때도 이 함수로 만든 URL 을 그대로 써야 SW 가 실제로 캐시한 요청과 정확히 일치한다
// (postgrest-js 의 select 인코딩과 달리 이건 우리 코드의 순수 문자열 템플릿이라 손으로 재현해도
// 안전 — 그래도 드리프트를 원천 차단하려면 여기서 export 한 걸 그대로 재사용하는 편이 낫다).
export function transcriptUrl(id, transcribedAt) {
  return `${STORAGE_URL}/transcripts/${id}.json?v=${encodeURIComponent(transcribedAt)}`;
}
export function transcriptKoUrl(id, transcribedAt) {
  return `${STORAGE_URL}/transcripts/${id}_ko.json?v=${encodeURIComponent(transcribedAt)}`;
}

// 자막 문장 한국어 사전번역 맵(trKey(문장) → ko). episode.js 가 재생 중 즉시 조회(직역 MyMemory 대체).
// transcribed_at 으로 버전키 → 재싱크로 자막이 바뀌면 새 번역을 받는다. 회차별 메모리 캐시.
const _trKoCache = new Map();
export async function transcriptKo(id, transcribedAt) {
  if (!transcribedAt) return {};
  if (_trKoCache.has(id)) return _trKoCache.get(id);
  const p = fetch(transcriptKoUrl(id, transcribedAt), { cache: 'force-cache' })
    .then((r) => (r.ok ? r.json() : {}))
    .then((m) => m || {})
    .catch(() => ({}));
  _trKoCache.set(id, p);
  return p;
}

// 회차 오디오 소스 결정: 호스팅됐으면 R2(광고 로테이션 무관·완전 일치), 아니면 기존 megaphone clean.
export async function audioSrcFor(id, audioUrl) {
  const h = await hostedSet();
  return h.has(Number(id)) ? hostedAudioUrl(id) : cleanAudioUrl(audioUrl);
}

// GET /api/episodes/{id} 대체 → { ...episode, vocab, transcript }
export async function getEpisode(id) {
  // 스냅샷이 있으면 짧게 기다렸다 그것으로 그린다(위 EP_SNAP 주석: 오프라인 실측 32.6초).
  // 없으면 이 화면에 그릴 게 아예 없으므로 느린 회선에서도 기본 데드라인까지 기다린다.
  const snap = loadEpisodeSnapshot(id);
  // 확실히 오프라인이고 스냅샷이 있으면 아예 안 물어본다 — 기다려서 얻을 게 없다.
  // (navigator.onLine 은 false 일 때만 믿는다: true 는 도달성을 보장하지 않는다. service-worker.js
  //  networkFirst·app.js 부팅 예산·translate.js 와 같은 규칙.) 실측으로 오프라인 회차 진입이
  //  3.6초 → 1초 미만. 온라인 복귀 시엔 app.js 의 'online' 핸들러가 route() 를 다시 돌려 갱신한다.
  if (snap && navigator.onLine === false) {
    return hydrateEpisode({ ...snap });
  }
  // ⚠ postgrest-js 의 쿼리빌더는 '실행되지 않은 thenable' 이라 .then() 을 부를 때마다 요청이 나간다.
  // 아래에서 데드라인용 + (포기했을 때만) 지각도착용으로 붙일 수 있으므로, 여기서 한 번만 실행시켜
  // 진짜 Promise 로 굳힌다 — Promise.resolve 가 thenable 의 then 을 정확히 한 번 부른다.
  const q = Promise.resolve(
    supabase
      .from('episodes')
      .select(
        '*, vocab:vocab_cards(id, term, kind, definition, example_sentence, sentence_start_sec, sentence_end_sec)'
      )
      .eq('id', id)
      .single());
  const seq = ++_epReqSeq;
  let ep;
  try {
    const { data, error } = await withDeadline(
      q, `getEpisode(${id})`, snap ? EP_SNAP_DEADLINE_MS : READ_DEADLINE_MS);
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`episode ${id} not found`);
    ep = data;
    saveEpisodeSnapshot(id, ep, seq);
  } catch (e) {
    // 데드라인을 넘겨도 원래 요청은 계속 살아 있다(Promise.race 는 취소가 아니다). 포기한 뒤에야
    // 이 핸들러를 붙이는 이유는 두 벌 저장을 피하기 위해서다 — 제때 도착한 경우는 위에서 이미
    // 저장했고, 여기서 또 붙이면 같은 응답을 두 번 직렬화해 localStorage 에 쓰게 된다.
    // 늦게라도 성공하면 스냅샷'만' 갱신한다. 화면은 안 건드린다 — 이미 그려진 회차를 뒤늦게
    // 덮으면 스크롤·재생 위치가 튄다. seq 로 '지각 응답이 더 새 응답을 덮는' 경합을 막는다.
    //
    // ⚠ 스냅샷이 없어 던지는 경우에도 이 핸들러는 붙인다. 예전엔 곧장 던져서, 느린 회선에서 처음
    // 여는 회차가 8초 뒤 에러 카드를 띄우고 그 직후 도착한 응답을 버렸다 — 다시 눌러도 똑같이
    // 8초를 기다린다. 붙여 두면 두 번째 시도는 스냅샷으로 즉시 열린다.
    // (xcheck 패널 gemini 지적, 2026-08-27.)
    q.then((late) => { if (late && !late.error && late.data) saveEpisodeSnapshot(id, late.data, seq); })
      .catch(() => {});   // unhandledrejection 로그 방지
    if (!snap) throw e;
    console.warn('[db] getEpisode failed → 스냅샷 사용:', e && e.message);
    // 스냅샷은 재사용되므로 얕은 복사 — 아래에서 audio_url/transcript 를 덮어쓴다.
    ep = { ...snap };
  }

  return hydrateEpisode(ep);
}

// 회차 '행'에 자막·번역·오디오소스를 붙여 화면이 기대하는 모양으로 만든다. 행의 출처(네트워크 /
// 스냅샷)와 무관하게 **완전히 같은 처리**를 거치게 하려고 따로 뺐다 — 두 경로가 갈라지면 오프라인
// 에서만 오디오 소스가 다르게 정해지는(=자막과 어긋나는) 버그가 생긴다. 여기서 쓰는 fetch 들은
// 전부 인증이 필요 없는 공개 URL 이라 SW 캐시로 오프라인에서도 그대로 동작한다.
async function hydrateEpisode(ep) {
  const id = ep.id;
  // 원본 정렬: 타임스탬프 있는 것 먼저, 그 안에서 start asc, 그 다음 id asc
  ep.vocab = (ep.vocab || []).sort((a, b) => {
    const an = a.sentence_start_sec, bn = b.sentence_start_sec;
    if (an == null && bn == null) return a.id - b.id;
    if (an == null) return 1;
    if (bn == null) return -1;
    return an - bn || a.id - b.id;
  });
  // audioSrcFor(hostedSet 대기)와 자막·번역 fetch 는 모두 ep 에만 의존하고 서로 독립 → 순차 대신 병렬로
  // (회차 열 때 오디오소스 결정 RTT 를 자막 로딩과 겹쳐 첫 재생·자막 표시가 빨라진다).
  const origUrl = ep.audio_url;            // DB 원본(megaphone) URL — cleanAudioUrl 폴백용
  const [manifestUrl, transcript, transcriptKoData] = await Promise.all([
    audioSrcFor(ep.id, ep.audio_url),      // 매니페스트(audio_hosted.json) 기반 결정 — 폴백용
    fetchTranscript(id, ep.transcribed_at),
    transcriptKo(id, ep.transcribed_at),   // 문맥 인지 사전번역(있으면 직역 대체)
  ]);
  // ★ SYNC 안전장치 — 재생 오디오는 반드시 '자막이 만들어진 바로 그 오디오'여야 한다. 진실원은
  //   transcript.r2_audio (재STT 가 R2 오디오로 됐는지). 매니페스트가 아니라 이 플래그로 소스를 정하면:
  //   ① hostedSet()(audio_hosted.json) 이 일시적 네트워크 실패로 빈 집합이 돼도, r2_audio 자막 회차는
  //      여전히 R2 를 재생 → 'hosted 회차가 megaphone 으로 떨어져 완전히 desync' 경로가 사라진다.
  //   ② 매니페스트↔자막이 어긋나도(둘 중 하나만 갱신) 항상 자막과 일치하는 오디오를 고른다.
  //   자막이 없거나 플래그가 없으면 기존 매니페스트 결정을 그대로 쓴다(회귀 없음).
  if (transcript && typeof transcript.r2_audio === 'boolean') {
    ep.audio_url = transcript.r2_audio ? hostedAudioUrl(ep.id) : cleanAudioUrl(origUrl);
  } else {
    ep.audio_url = manifestUrl;
  }
  ep.transcript = transcript;
  ep.transcript_ko = transcriptKoData;
  return ep;
}

async function fetchTranscript(id, transcribedAt) {
  if (!transcribedAt) return null;
  try {
    // 캐시버스트: transcribed_at 을 URL 버전키로 → 재싱크(--from-r2)로 transcript 가 바뀌면
    // URL 이 달라져 항상 새 자막을 받는다.
    // ⚠ force-cache 를 다시 쓰지 말 것(v1.59.0 실기기 버그, 2026-08-07 수정). 예전 가정은 "버전별
    // URL 은 불변이라 한 번 받으면 영구 캐시해도 된다" 였다 — 틀렸다. 그 URL(=transcribed_at) 은
    // 'STT 를 다시 돌리지 않는 한' 안 바뀐다는 뜻이었지, 'JSON 내용이 안 바뀐다'는 보장이 아니었다.
    // scripts/wh_backfill_video_ids.py 가 기존 transcript JSON 에 video_id 를 제자리(in-place)로
    // 패치하면서 transcribed_at 은 일부러 안 건드린다(건드리면 aep-offline-meta 캐시 키가 깨져
    // 오프라인 저장해 둔 오디오가 전부 다시 받아진다) — 즉 같은 URL 에서 내용이 바뀔 수 있다. 오늘은
    // video_id, 앞으로 다른 필드도 같은 방식(제자리 패치)으로 늘어날 수 있다.
    // force-cache 는 "신선도 무관, 캐시에 뭐라도 있으면 그걸 씀 — 네트워크 왕복조차 안 함" 이라, 이미
    // 받아 간 기기는 백필 이후에도 옛 JSON 을 영구히 서빙했다(실기기 v1.59.0: 📺 토글이 영영 안 뜸,
    // 원인은 transcript.video_id 가 undefined 로 굳어 있던 것 — 서버는 이미 최신이었다). Storage
    // 응답이 이미 `cache-control: no-cache` 를 보내므로(실측 확인) 캐시 옵션 없는 기본 fetch 도 매번
    // 오리진에 재검증(조건부 GET, 대개 값싼 304)한다 — audio_hosted.json/examples_ko.json 과 같은
    // 이 파일의 다른 fetch 들과 동일한 패턴(no-cache)으로 맞춘다. 오프라인 동작은 그대로다: 이 fetch
    // 가 실패(offline)하면 그대로 던지고, 그 reject 는 service-worker.js::networkFirst() 의
    // DOC_CACHE/DATA_CACHE 폴백이 받는다 — 캐시 모드는 '온라인일 때 최신을 받는지'에만 영향한다.
    const r = await fetch(transcriptUrl(id, transcribedAt), { cache: 'no-cache' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ─────────────────────────── Study (표현 탐색 허브) ───────────────────────────
async function _count(table, build) {
  let q = withShow(supabase.from(table).select('*', { count: 'exact', head: true }));
  if (build) q = build(q);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

const STUDY_KINDS = ['idiom', 'phrasal_verb', 'collocation', 'word'];

// "알아요/마스터" 센티넬: interval_days >= 365 (markKnown 만 설정). 일반 SM-2 로는 잘 도달 안 함.
const KNOWN_INTERVAL = 365;

// Study 홈 통계 — 전체 표현 / 학습(reps>0) / 오늘 복습 / 알아요(마스터) / 종류별 개수
export async function studyOverview() {
  const today = todayStr();
  const [total, learned, dueReview, dueNew, known, ...kindCounts] = await Promise.all([
    _count('vocab_cards'),
    _count('srs_cards', (q) => q.gt('reps', 0)),
    _count('srs_cards', (q) => q.lte('due_date', today).gt('reps', 0)),
    _count('srs_cards', (q) => q.lte('due_date', today).eq('reps', 0)),
    _count('srs_cards', (q) => q.gte('interval_days', KNOWN_INTERVAL)),
    ...STUDY_KINDS.map((k) => _count('vocab_cards', (q) => q.eq('kind', k))),
  ]);
  const byKind = STUDY_KINDS.map((k, i) => ({ kind: k, total: kindCounts[i] }));
  // due = 오늘 실제 복습 세션 크기(srsQueue 상한과 동일: 복습 50 + 신규 5) — 'N due' CTA 가 실제 풀 양과 일치.
  const due = Math.min(dueReview, REVIEW_LIMIT) + Math.min(dueNew, NEW_LIMIT);
  return { total, learned, due, dueReview, dueNew, known, byKind };
}

// 보존력(retention) 통계 — Proficiency 5축 중 '안 잊는 힘'. 학습(reps>0) 카드 중 장기간격(>90d) 비율.
// strong(>90d) 에는 markKnown(interval 365)·실제 장기복습 도달분이 모두 포함된다. mature(>21d)는 참고치.
// (lapse 율은 SM-2 가 again 시 reps=0 으로 리셋해 신규처럼 위장 → 별도 추적 필요, 본 버전 범위 밖.)
export async function retentionStats() {
  const [learned, strong, mature] = await Promise.all([
    _count('srs_cards', (q) => q.gt('reps', 0)),
    _count('srs_cards', (q) => q.gt('reps', 0).gt('interval_days', 90)),
    _count('srs_cards', (q) => q.gt('reps', 0).gt('interval_days', 21)),
  ]);
  return { learned, strong, mature, retentionFrac: learned ? strong / learned : 0 };
}

// "알아요" — 해당 vocab 의 SRS 카드를 마스터(1년 뒤 복습) 상태로. 진도(known)에 즉시 반영된다.
export async function markKnown(vocabId) {
  const due = new Date();
  due.setDate(due.getDate() + KNOWN_INTERVAL);
  const { error } = await supabase
    .from('srs_cards')
    .update({ interval_days: KNOWN_INTERVAL, reps: 4, ease: 2.6, due_date: todayStr(due) })
    .eq('vocab_id', vocabId);
  if (error) throw new Error(error.message);
}

// "알아요" 해제 — SRS 카드를 다시 복습 대상으로 되돌린다(known 진도에서 빠짐). 카드 왼쪽 스와이프용.
export async function markUnknown(vocabId) {
  const { error } = await supabase
    .from('srs_cards')
    .update({ interval_days: 0, reps: 0, ease: 2.5, due_date: todayStr(new Date()) })
    .eq('vocab_id', vocabId);
  if (error) throw new Error(error.message);
}

// 운전 캡처 → 카드 생성(Study 트리아지). 같은 term 의 vocab 이 이미 있으면 새로 만들지 않고
// 그 SRS 카드를 오늘 복습으로 리셋(markUnknown) — 중복 카드 방지 + 기존 Claude 정의를 그대로 활용.
// 없으면 vocab_cards(단어/구 + 실제 발화 문장·시각) + srs_cards(due=오늘, reps=0) 를 함께 만든다.
// due=오늘 → srsQueue 의 '신규' 풀에 바로 들어가 오늘/내일 세션에 자연 편입(별도 복습 UI 불필요).
export async function createCaptureCard({ episodeId, term, ko, sentence, startSec, endSec }) {
  const { data: existing, error: qerr } = await withShow(
    supabase.from('vocab_cards').select('id').ilike('term', term))   // ilike + 와일드카드 없음 = 대소문자 무시 완전일치
    .limit(1);
  if (qerr) throw new Error(qerr.message);
  if (existing && existing.length) {
    await markUnknown(existing[0].id);        // ingest 가 vocab 마다 srs 카드를 만들므로 항상 짝이 있다
    return { reused: true, vocabId: existing[0].id };
  }
  const show = currentShow();
  const kind = /\s/.test(term.trim()) ? 'collocation' : 'word';
  const { data: v, error } = await supabase.from('vocab_cards').insert({
    episode_id: episodeId, show, term, kind,
    definition: ko || null,                   // 실시간 사전 소스가 MyMemory 뿐 — 한국어 뜻을 정의로
    example_sentence: sentence || null,
    sentence_start_sec: startSec ?? null, sentence_end_sec: endSec ?? null,
  }).select('id').single();
  if (error) throw new Error(error.message);
  const { error: serr } = await supabase.from('srs_cards').insert({
    episode_id: episodeId, vocab_id: v.id, show,
    front: term, back: ko || term, category: kind, due_date: todayStr(),
  });
  if (serr) throw new Error(serr.message);
  return { reused: false, vocabId: v.id };
}

// vocab 행 → 뷰 표준 모양(에피소드 제목·재생 audio_url·known·예문 한글). expressionsByKind/allExpressions 공용.
const VOCAB_SELECT =
  'id, term, kind, definition, example_sentence, episode_id, sentence_start_sec, sentence_end_sec, episodes(title, audio_url), srs:srs_cards(interval_days)';
function _mapVocab(v, hosted, exKo) {
  return {
    ...v,
    episode_title: v.episodes?.title || '',
    // 인라인 문장 재생용 — 호스팅된 회차는 R2(자막 문장시각과 일치) 아니면 megaphone clean.
    audio_url: hosted.has(Number(v.episode_id)) ? hostedAudioUrl(v.episode_id) : cleanAudioUrl(v.episodes?.audio_url || ''),
    known: Array.isArray(v.srs) && v.srs.some((s) => (s.interval_days || 0) >= KNOWN_INTERVAL),
    example_ko: exKo[String(v.id)] || null,   // 사전번역(있으면 KR 버튼 즉시 표시)
  };
}

// 종류별 표현 목록 (+ 에피소드 제목). 각 kind 는 1000행 미만이라 단일 쿼리로 충분.
export async function expressionsByKind(kind, limit = 800) {
  const { data, error } = await withShow(
    supabase.from('vocab_cards').select(VOCAB_SELECT).eq('kind', kind))
    .order('term', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  const [hosted, exKo] = await Promise.all([hostedSet(), examplesKo()]);
  return (data || []).map((v) => _mapVocab(v, hosted, exKo));
}

// 전 kind 통합 — 약점(미마스터) 집중 퀴즈용(B4). 호출부가 known=false 우선 샘플링.
export async function allExpressions(limit = 1500) {
  const { data, error } = await withShow(
    supabase.from('vocab_cards').select(VOCAB_SELECT))
    .limit(limit);
  if (error) throw new Error(error.message);
  const [hosted, exKo] = await Promise.all([hostedSet(), examplesKo()]);
  return (data || []).map((v) => _mapVocab(v, hosted, exKo));
}

// ─────────────────────────── SRS ───────────────────────────
const GRADE_TO_Q = { again: 0, hard: 3, good: 4, easy: 5 };

// SM-2 업데이트 — SRS 채점의 단일 출처(클라이언트)
function sm2(ease, interval, reps, grade) {
  const q = GRADE_TO_Q[grade];
  if (q < 3) return { ease: Math.max(1.3, ease - 0.2), interval: 1, reps: 0 };
  const nreps = reps + 1;
  let ni;
  if (nreps === 1) ni = 1;
  else if (nreps === 2) ni = 6;
  else ni = Math.max(1, Math.round(interval * ease));
  const nease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  return { ease: nease, interval: ni, reps: nreps };
}

const QUEUE_SELECT =
  '*, episodes(title, audio_url), vocab_cards(example_sentence, sentence_start_sec, sentence_end_sec, kind)';

function flattenCard(r, hosted) {
  return {
    ...r,
    episode_title: r.episodes?.title || '',
    // 호스팅된 회차는 R2(자막 문장시각 일치) 아니면 megaphone clean.
    audio_url: (hosted && hosted.has(Number(r.episode_id))) ? hostedAudioUrl(r.episode_id) : cleanAudioUrl(r.episodes?.audio_url || ''),
    example_sentence: r.vocab_cards?.example_sentence ?? null,
    sentence_start_sec: r.vocab_cards?.sentence_start_sec ?? null,
    sentence_end_sec: r.vocab_cards?.sentence_end_sec ?? null,
    vkind: r.vocab_cards?.kind ?? null,
  };
}

// GET /api/srs/queue 대체
export async function srsQueue() {
  const today = todayStr();
  // review·fresh·hostedSet 은 서로 독립 → 순차 3 RTT 대신 병렬 1회분으로(Review 탭 열림 지연 단축).
  const [review, fresh, hosted] = await Promise.all([
    withShow(supabase.from('srs_cards').select(QUEUE_SELECT)
      .lte('due_date', today).gt('reps', 0))
      .order('due_date', { ascending: true }).order('id', { ascending: true })
      .limit(REVIEW_LIMIT),
    withShow(supabase.from('srs_cards').select(QUEUE_SELECT)
      .lte('due_date', today).eq('reps', 0))
      .order('id', { ascending: true })
      .limit(NEW_LIMIT),
    hostedSet(),
  ]);
  if (review.error) throw new Error(review.error.message);
  if (fresh.error) throw new Error(fresh.error.message);
  return [...review.data, ...fresh.data].map((r) => flattenCard(r, hosted));
}

// POST /api/srs/review 대체
export async function srsReview(cardId, grade) {
  const { data: row, error } = await supabase
    .from('srs_cards').select('ease, interval_days, reps').eq('id', cardId).single();
  if (error) throw new Error(error.message);

  const r = sm2(row.ease, row.interval_days, row.reps, grade);
  const due = new Date();
  due.setDate(due.getDate() + r.interval);
  const dueStr = todayStr(due);

  const { error: uerr } = await supabase
    .from('srs_cards')
    .update({ ease: r.ease, interval_days: r.interval, reps: r.reps, due_date: dueStr })
    .eq('id', cardId);
  if (uerr) throw new Error(uerr.message);

  return { card_id: cardId, ease: r.ease, interval_days: r.interval, reps: r.reps, due_date: dueStr };
}

// GET /api/srs/stats 대체
export async function srsStats() {
  const today = todayStr();
  const base = () => withShow(supabase.from('srs_cards').select('*', { count: 'exact', head: true }));
  const run = async (q) => {
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return count || 0;
  };

  const [total, dueReview, dueNew, backlogNew, learned] = await Promise.all([
    run(base()),
    run(base().lte('due_date', today).gt('reps', 0)),
    run(base().lte('due_date', today).eq('reps', 0)),
    run(base().gt('due_date', today).eq('reps', 0)),
    run(base().gt('reps', 0)),
  ]);

  return {
    total,
    today_batch: Math.min(dueReview, REVIEW_LIMIT) + Math.min(dueNew, NEW_LIMIT),
    today_review: Math.min(dueReview, REVIEW_LIMIT),
    today_new: Math.min(dueNew, NEW_LIMIT),
    backlog_new: backlogNew,
    learned,
  };
}
