// aep-review router (hash-based) + shared utils.
// 뷰 모듈은 라우트별 '동적 import'(지연 로드)로 불러온다 — 부팅 때 첫 화면(라이브러리)에 필요한
// 것만 파싱하고 episode/study/srs/login(대형 모듈들)은 진입 시 로드해 초기 JS 파싱/평가를 줄인다.
// SW SHELL 이 전부 캐시하므로 지연 로드여도 오프라인·재방문은 즉시(네트워크 아닌 파싱만 지연).
import { supabase } from '/supabase.js';
import { APP_NAME } from '/config.js';

export const APP_VERSION = String(window.APP_VERSION || 'dev');

const $app = document.getElementById('app');
const $title = document.getElementById('page-title');
const $back = document.getElementById('back-btn');
const $sync = document.getElementById('sync-btn');
const $version = document.getElementById('app-version');

if ($version) $version.textContent = 'v' + APP_VERSION;
// 버전 표시 = Settings 진입점(지금까지 아무 동작 없던 pill 에 역할 부여). 로그아웃(노출)·테마
// Auto/Light/Dark·오프라인 개수를 한 메뉴로 모은다. settings.js 는 탭 시에만 동적 로드.
if ($version) {
  $version.setAttribute('role', 'button');
  $version.setAttribute('tabindex', '0');
  $version.setAttribute('aria-label', 'Settings');
  const openSet = () => import('/settings.js').then((m) => m.openSettings({
    applyTheme, version: APP_VERSION, onSignOut: signOut,
  })).catch((e) => console.error('[settings]', e));
  $version.addEventListener('click', openSet);
  $version.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSet(); } });
}

// === 전역 오류 안전망 (안정성: 오류 0 목표) ===
// 예기치 못한 오류/거부가 콘솔 스팸이나 깨진 화면으로 이어지지 않게 잡아 로깅만 한다.
// (개별 기능은 이미 자체적으로 graceful 처리 — 번역/재생 등. 이건 최후의 그물.)
window.addEventListener('error', (e) => { console.error('[uncaught]', e.error || e.message); });
window.addEventListener('unhandledrejection', (e) => { console.error('[unhandledrejection]', e.reason); });

const ROUTES = [
  { re: /^#?\/$/,                    load: () => import('/views/timeline.js').then((m) => m.renderTimeline), title: 'E-Podcast', tab: 'timeline', back: false, key: 'timeline' },
  { re: /^#?\/episode\/(\d+)(?:\/(\d+))?$/, load: () => import('/views/episode.js').then((m) => m.renderEpisode), title: 'Episode', tab: 'timeline', back: true, key: 'episode' },
  { re: /^#?\/study$/,               load: () => import('/views/study.js').then((m) => m.renderStudy), title: 'Study',    tab: 'study',    back: false, key: 'study' },
  { re: /^#?\/srs$/,                 load: () => import('/views/srs.js').then((m) => m.renderSrs),   title: 'Review',   tab: 'study',    back: true,  key: 'srs' },
];

let _prevKey = null;  // 직전 라우트 키 — 같은 뷰(에피소드↔에피소드) 전환 감지용
async function route() {
  const hash = location.hash || '#/';
  for (const r of ROUTES) {
    const m = hash.match(r.re);
    if (m) {
      $title.textContent = r.title;
      $back.hidden = !r.back;
      document.querySelectorAll('#tabbar a').forEach((a) => {
        if (a.dataset.tab === r.tab) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      });
      // 에피소드 → 에피소드(앞/뒤 회차) 전환은 화면 전체 깜빡임을 피한다:
      //   · 스피너로 비우지 않고 옛 화면을 유지한 채 데이터를 받아온 뒤 한 번에 교체
      //   · 뷰 페이드인도 재생하지 않음
      //  → 커버(같은 캐시 URL)는 그대로, 메타·스크러버만 조용히 바뀐다. (on-episode 유지는 episode.js)
      const inPlace = r.key === 'episode' && _prevKey === 'episode';
      if (!inPlace) $app.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
      try {
        const handler = await r.load();          // 동적 import(캐시 히트) → 렌더
        await handler($app, ...m.slice(1));
      } catch (e) {
        console.error('[route] view render failed:', e);
        $app.innerHTML = `<div class="empty error">
          <p>Something went wrong.</p>
          <button class="btn primary" id="route-retry">Retry</button>
        </div>`;
        document.getElementById('route-retry')?.addEventListener('click', () => route());
      }
      _prevKey = r.key;
      if (!inPlace) {
        // 뷰 전환 페이드인 (reflow 트릭으로 재시작; reduced-motion 에선 무시됨)
        $app.classList.remove('view-enter');
        void $app.offsetWidth;
        $app.classList.add('view-enter');
      }
      return;
    }
  }
  // 매칭 라우트가 없을 때도 크롬을 초기화한다. 예전엔 이 갱신들이 전부 매칭 분기 안에만 있어,
  // 에피소드 → 잘못된 해시로 가면 뒤로가기 버튼이 남고 직전 탭이 계속 강조됐다(_prevKey 도 잔존).
  $title.textContent = APP_NAME;
  $back.hidden = true;
  document.querySelectorAll('#tabbar a').forEach((a) => a.removeAttribute('aria-current'));
  _prevKey = null;
  $app.innerHTML = `<div class="empty">404 — ${escapeHtml(hash)} (v${APP_VERSION})</div>`;
}

// === Auth gate (Supabase 단일 사용자) ===
let authed = false;

// getSession 은 보통 로컬 우선이라 즉시 반환되지만, 만약 네트워크 새로고침이 매달리면 부팅이
// 무한 스피너로 멈춘다(C2/AUDIT P5). ms 안에 안 오면 fallback 으로 강등 → 로그인/스피너 표시,
// 뒤늦게 세션이 오면 onAuthStateChange 가 게이트를 연다(무손실 복구).
export function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}
const SESSION_TIMEOUT_MS = 3500;

// 오프라인 부팅 우회: 토큰이 만료돼 리프레시가 필요한데 오프라인이면 getSession 이 세션을 못
// 돌려준다 → 저장된 세션 흔적이 있으면 입장시킨다(읽기는 SW 캐시, 쓰기는 실패해도 UI 는 graceful).
// 온라인 복귀 후에는 onAuthStateChange(TOKEN_REFRESHED/SIGNED_OUT)가 상태를 바로잡는다.
function hasStoredSession() {
  try {
    return Object.keys(localStorage).some((k) => k.startsWith('sb-') && k.endsWith('-auth-token'));
  } catch (e) { return false; }
}

// === 앱 아이콘 바로가기(manifest shortcuts) — /?sc=resume|transcript 진입 처리 ===
// 아이콘을 길게 눌러 Resume/Transcript 를 고르면 가장 최근 듣던 회차로 바로 이동해 재생을
// 시작한다(transcript 는 시트까지 자동 오픈). 대상 = 이어듣기 맵(aep-progress)의 최신 항목,
// 없으면 최근 완주(aep-completed)의 마지막. 둘 다 없으면 평소처럼 라이브러리로 부팅.
function lastPlayedId() {
  try {
    const m = JSON.parse(localStorage.getItem('aep-progress') || '{}') || {};
    let best = null, at = -1;
    for (const k of Object.keys(m)) { const p = m[k]; if (p && p.at > at) { at = p.at; best = k; } }
    if (best != null) return best;
    const done = JSON.parse(localStorage.getItem('aep-completed') || '[]');
    if (Array.isArray(done) && done.length) return done[done.length - 1];
  } catch (e) {}
  return null;
}
function consumeShortcut() {
  let sc = null;
  try { sc = new URLSearchParams(location.search).get('sc'); } catch (e) {}
  if (sc !== 'resume' && sc !== 'transcript') return false;
  try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}  // 새로고침 재발동 방지
  const id = lastPlayedId();
  if (id == null) return false;
  // renderEpisode 가 이미 소비하는 플래그 재사용: autoplay(메인 화면 재생) / open-script(시트+재생).
  try { sessionStorage.setItem(sc === 'transcript' ? 'aep-open-script' : 'aep-autoplay', String(id)); } catch (e) {}
  const target = '#/episode/' + id;
  if (location.hash === target) return false;   // 이미 그 화면 → 일반 라우팅이 플래그를 소비
  location.hash = target;                        // hashchange → route() 렌더(직접 route 호출 시 이중 렌더)
  return true;
}

// 로그인 후 잠시 뒤 백그라운드로 최근 회차(자막+오디오)를 내려받아 오프라인 청취를 준비한다.
// 부팅 직후 대역폭 경쟁(목록/자막 로딩)을 피해 지연 실행. 세션당 1회(offline.js 내부 가드).
let _offlineKicked = false;
function kickOfflineCache() {
  if (_offlineKicked || !navigator.onLine) return;
  _offlineKicked = true;
  setTimeout(() => {
    import('/offline.js')
      .then((m) => m.ensureOfflineCache())
      .catch((e) => console.warn('[offline] prefetch failed:', e));
  }, 4000);
}

// 지연 로드의 유일한 트레이드오프(첫 진입 시 파싱 지연)를 없앤다: 부팅 후 유휴 시간에 다음에 열 확률이
// 높은 뷰(episode → study)를 백그라운드로 미리 파싱해 첫 진입을 즉시로. (SW 캐시 히트라 네트워크 0.)
let _viewsWarmed = false;
function prefetchViews() {
  if (_viewsWarmed) return;
  _viewsWarmed = true;
  const warm = () => { import('/views/episode.js').catch(() => {}); import('/views/study.js').catch(() => {}); };
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 3000 });
  else setTimeout(warm, 1500);
}

// boot 은 두 경로로 호출된다(load 리스너 + 즉시 호출). 동적 주입 모듈은 DOM 파싱 후(readyState
// 'interactive') 실행되지만 dynamic script 는 load 를 지연시켜 둘 다 발화 → 재진입 가드로 1회만.
// (가드 없으면 route()·listEpisodes 가 이중 실행되고, 에피소드 딥링크 리로드 시 트랜스크립트 시트가
//  두 개 생겨 탭-시크·자동추종이 깨졌다.)
let _booted = false;
async function boot() {
  if (_booted) return;
  _booted = true;
  // Google OAuth 리다이렉트(?code=)로 돌아온 경우: supabase-js 가 비동기로 세션을 교환 중 →
  // 로그인 화면 깜빡임 없이 onAuthStateChange(SIGNED_IN)을 기다린다.
  const pendingOAuth = location.search.includes('code=') || location.hash.includes('access_token');
  let session = null;
  try {
    const res = await withTimeout(
      supabase.auth.getSession(), SESSION_TIMEOUT_MS, { data: { session: null } });
    session = (res && res.data && res.data.session) || null;
  } catch (e) {
    console.error('auth getSession failed', e);
  }
  // 딥링크 콜드스타트 레이스(버그헌트 #5): getSession 을 기다리는 사이 onAuthStateChange 의
  // INITIAL_SESSION 이 이미 게이트를 열고 route() 했을 수 있다 → 여기서 또 route() 하면 이중 렌더
  // (에피소드면 시트 2개). 이미 입장했으면 boot 은 아무것도 하지 않는다.
  if (authed) return;
  if (session) {
    authed = true;
    document.body.classList.remove('logged-out');
    if (!consumeShortcut()) route();   // 바로가기 진입이면 hashchange 가 라우팅한다
    kickOfflineCache();
    prefetchViews();
  } else if (!navigator.onLine && hasStoredSession()) {
    authed = true;
    document.body.classList.remove('logged-out');
    if (!consumeShortcut()) route();
    toast('Offline — downloaded episodes only');
  } else if (pendingOAuth) {
    document.body.classList.add('logged-out');
    $app.innerHTML = '<div class="login-wrap"><p class="login-sub">Signing in…</p></div>';
    // PKCE 코드 교환이 만료(사용자가 동의창에 머묾)·유실(불안정 모바일망)되면 supabase-js 는 아무
    // 이벤트도 안 보낸다 → 영구 "Signing in…" 고착. 10s 안에 세션이 안 열리면 죽은 ?code= 를 지우고
    // 로그인 화면으로 되돌린다(그 전에 세션이 오면 authed=true 라 no-op).
    setTimeout(() => { if (!authed) { cleanAuthUrl(); showLogin(); } }, 10000);
  } else {
    showLogin();
  }
}

// OAuth 복귀 후 URL 의 ?code=/토큰 흔적을 지워 재교환·뒤로가기 꼬임을 막는다.
function cleanAuthUrl() {
  if (location.search.includes('code=') || location.hash.includes('access_token')) {
    history.replaceState(null, '', location.pathname + '#/');
  }
}

function showLogin() {
  authed = false;
  document.body.classList.add('logged-out');
  $back.hidden = true;
  $title.textContent = APP_NAME;   // 로그아웃 화면 헤더 = 앱 이름(특정 쇼 이름 아님)
  import('/views/login.js').then((m) => m.renderLogin($app, () => {
    authed = true;
    document.body.classList.remove('logged-out');
    location.hash = '#/';
    route();
  })).catch((e) => console.error('[login] load failed:', e));
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT' && authed) { showLogin(); return; }
  // Google OAuth 리다이렉트 복귀(또는 다른 탭 로그인)로 세션이 생기면 게이트를 연다.
  if (session && !authed && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
    authed = true;
    document.body.classList.remove('logged-out');
    cleanAuthUrl();
    // INITIAL_SESSION 이 boot 보다 먼저 게이트를 여는 레이스에서도 바로가기 진입이 동작하게 여기서도 처리.
    if (consumeShortcut()) { kickOfflineCache(); prefetchViews(); return; }
    if (!location.hash || location.hash === '#') location.hash = '#/';
    route();
    kickOfflineCache();
    prefetchViews();
  }
});

let _inAppNavs = 0;   // 앱 안에서 실제로 일어난 해시 이동 횟수 — 뒤로가기 폴백 판정용
window.addEventListener('hashchange', () => { _inAppNavs++; if (authed) route(); });
window.addEventListener('load', boot);
if (document.readyState !== 'loading') boot();

// 공유 링크(#/episode/5)로 바로 들어오거나 PWA 를 에피소드로 콜드 실행하면 앞선 앱 내 히스토리가
// 없어 history.back() 이 앱을 벗어나거나 아무 일도 하지 않았다 → 그럴 땐 라이브러리로 보낸다.
$back.addEventListener('click', () => { if (_inAppNavs > 0) history.back(); else location.hash = '#/'; });

// 동기화 버튼 재활용 — 신규 에피소드는 GitHub Actions cron 이 Supabase 에 채운다.
//   탭        = 현재 화면 데이터 새로고침
//   길게 누름 = 로그아웃
let _syncHold = null;
function refreshData() {
  $sync.disabled = true;
  $sync.classList.add('syncing');
  const done = (msg = 'Synced to latest') => setTimeout(() => {
    $sync.disabled = false;
    $sync.classList.remove('syncing');
    toast(msg);
  }, 350);
  // 에피소드 화면에선 재라우팅 금지 — 같은 해시라 hashchange 없이 route()→renderEpisode 가 재실행되면
  // teardown(시트 제거·리스너 해제)이 안 돼 트랜스크립트 시트가 중복 생성되고 player 리스너가 겹친다
  // (버그헌트 #1). 에피소드 데이터는 이미 로드돼 있어 새로고침 불필요 → 스핀 애니메이션만.
  // 복습(#/srs)도 재라우팅 금지 — renderSrs 재실행이 진행 중 카드 큐·점수를 처음부터 리셋해
  // 학습 데이터가 조용히 날아간다(정밀진단 수정). 에피소드와 동일하게 스핀 애니메이션만.
  // 이 두 화면은 의도적으로 재라우팅하지 않는다(아래 사유) → 실제로는 아무것도 새로 받지 않으므로
  // 'Synced to latest' 는 거짓 확인이었다. 사실대로 알린다.
  if (/^#\/(episode|srs)\b/.test(location.hash || '')) { done('Nothing to refresh here'); return; }
  Promise.resolve(route()).finally(done);
}
async function signOut() {
  if (!confirm('Log out?')) return;
  try { await supabase.auth.signOut(); } catch (e) { /* ignore */ }
  showLogin();
}
$sync.addEventListener('click', () => { if (authed) refreshData(); });
$sync.addEventListener('pointerdown', () => {
  _syncHold = setTimeout(() => { _syncHold = null; signOut(); }, 700);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
  $sync.addEventListener(ev, () => { if (_syncHold) { clearTimeout(_syncHold); _syncHold = null; } })
);

// === 테마 (라이트/다크) — 기본 auto(시스템), 탭하면 명시적 전환 ===
const $theme = document.getElementById('theme-btn');
const _mql = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
function effectiveTheme() {
  const saved = localStorage.getItem('aep-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return _mql && _mql.matches ? 'dark' : 'light';
}
function applyTheme(pref) {
  if (pref === 'light' || pref === 'dark') document.documentElement.setAttribute('data-theme', pref);
  else document.documentElement.removeAttribute('data-theme');
  const eff = effectiveTheme();
  // 토글 스위치: 노브 위치(좌=라이트/우=다크)를 클래스로 구동. textContent 로 내부 마크업을 덮지 않는다.
  if ($theme) { $theme.classList.toggle('is-dark', eff === 'dark'); $theme.setAttribute('aria-checked', eff === 'dark' ? 'true' : 'false'); }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', eff === 'dark' ? '#0B0B10' : '#cc6cff');
}
$theme?.addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('aep-theme', next);
  applyTheme(next);
  toast(next === 'dark' ? 'Dark theme' : 'Light theme');
});
applyTheme(localStorage.getItem('aep-theme') || 'auto');
// 자동(미설정) 모드에서 시스템 테마가 바뀌면 아이콘/상태바색 갱신
_mql?.addEventListener?.('change', () => {
  const saved = localStorage.getItem('aep-theme');
  if (saved !== 'light' && saved !== 'dark') applyTheme('auto');
});

// === Shared utils ===
let _toastTimer = null;
export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}


export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// 문장 속에서 표현(term)이 나온 부분을 <mark> 로 강조 (나머지는 escape). 조각별 안전 결합.
// Study/Review 에서 "Shana 가 정확히 어떤 문장에서 이 표현을 썼는지" 한눈에 보여주기 위함.
export function highlightTerm(text, term) {
  const s = String(text || '');
  if (!term) return escapeHtml(s);
  const re = new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(s)) !== null) {
    out += escapeHtml(s.slice(last, m.index)) + '<mark class="term-hl">' + escapeHtml(m[0]) + '</mark>';
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;  // 빈 매치 무한루프 방지
  }
  return out + escapeHtml(s.slice(last));
}

export function fmtTime(sec) {
  if (sec == null) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// === Service worker ===
// 좀비 셸 자가치유 — 배포 직후 새로고침이 옛 html 을 서빙한 사이 새 SW 가 활성화되면, 옛 셸 캐시가
// 삭제돼 이 페이지(임포트맵 ?v=옛버전)와 캐시가 어긋난다. 내 버전보다 '새로운' 셸 캐시가 보이면
// 즉시 1회 재로드해 최신 셸로 갈아탄다(내비게이션은 SW 가 network-first 라 재로드=최신 html 보장).
// sessionStorage 가드로 무한 루프 방지(오프라인 폴백으로 옛 html 이 또 와도 1회로 그침).
(async function healStaleShell() {
  try {
    if (!('caches' in window)) return;
    const parts = (s) => String(s).split('.').map((n) => parseInt(n, 10) || 0);
    const isNewer = (a, b) => {   // a > b (semver)
      const x = parts(a), y = parts(b);
      for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
      return false;
    };
    const vers = (await caches.keys())
      .map((n) => (n.match(/^aep-review-shell-v(.+)$/) || [])[1])
      .filter(Boolean);
    const KEY = 'aep-heal-' + APP_VERSION;
    if (vers.some((v) => isNewer(v, APP_VERSION)) && !sessionStorage.getItem(KEY)) {
      sessionStorage.setItem(KEY, '1');
      location.reload();
    }
  } catch (e) { /* 캐시 미지원 등 — 무시 */ }
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js?v=' + APP_VERSION, {updateViaCache: 'none'})
    .then((reg) => {
      if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (nw) nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            nw.postMessage('SKIP_WAITING');
          }
        });
      });
    })
    .catch((e) => console.warn('SW register failed:', e));

  // 새 버전(SW) 적용 시 새로고침 — 단, '사용 중'엔 끊지 않는다. 재생 중 페이지가 갑자기 reload 되면
  // 오디오가 끊기고 재생버튼이 안 먹는 것처럼 보였다(사용자 보고). 그래서 화면이 가려질 때(백그라운드)
  // 또는 사용자가 직접 새로고침할 때만 적용 → 활성 사용 중엔 절대 끊기지 않음.
  // 예외: 페이지가 갓 로드된 상태(<15s, 사용자가 방금 새로고침한 직후)라면 즉시 완료한다 —
  // 당겨서 새로고침 한 번으로 업데이트가 그 자리에서 끝나고 바로 재생 가능(사용자 요청 2026-07-09).
  let reloaded = false, pendingReload = false;
  const doReload = () => { if (!reloaded) { reloaded = true; location.reload(); } };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (document.hidden || performance.now() < 15000) doReload();
    else pendingReload = true;
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && pendingReload) doReload(); });
}

// 비보안 컨텍스트(http LAN 직접접속 등)에서는 crypto.subtle 부재로 고품질 TTS 키 계산 불가 →
// speak() 가 브라우저 기본음으로 자동 강등된다(tts.js). 왜 음질이 다른지 1회만 안내(https·설치앱에선 안 뜸).
try {
  if (!window.isSecureContext && !localStorage.getItem('aep-hint-insecure')) {
    localStorage.setItem('aep-hint-insecure', '1');
    setTimeout(() => toast('http 접속이라 음성은 브라우저 기본음으로 재생돼요 · https·설치앱 권장'), 1600);
  }
} catch (e) { /* no-storage/quota */ }
