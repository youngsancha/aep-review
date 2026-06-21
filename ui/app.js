// aep-review router (hash-based) + shared utils.
import { renderTimeline } from '/views/timeline.js';
import { renderEpisode } from '/views/episode.js';
import { renderSrs } from '/views/srs.js';
import { renderStudy } from '/views/study.js';
import { renderLogin } from '/views/login.js';
import { supabase } from '/supabase.js';

export const APP_VERSION = String(window.APP_VERSION || 'dev');

const $app = document.getElementById('app');
const $title = document.getElementById('page-title');
const $back = document.getElementById('back-btn');
const $sync = document.getElementById('sync-btn');
const $version = document.getElementById('app-version');

if ($version) $version.textContent = 'v' + APP_VERSION;

// === 전역 오류 안전망 (안정성: 오류 0 목표) ===
// 예기치 못한 오류/거부가 콘솔 스팸이나 깨진 화면으로 이어지지 않게 잡아 로깅만 한다.
// (개별 기능은 이미 자체적으로 graceful 처리 — 번역/재생 등. 이건 최후의 그물.)
window.addEventListener('error', (e) => { console.error('[uncaught]', e.error || e.message); });
window.addEventListener('unhandledrejection', (e) => { console.error('[unhandledrejection]', e.reason); });

const ROUTES = [
  { re: /^#?\/$/,                    handler: renderTimeline, title: 'Library', tab: 'timeline', back: false },
  { re: /^#?\/episode\/(\d+)(?:\/(\d+))?$/, handler: renderEpisode, title: 'Episode', tab: 'timeline', back: true },
  { re: /^#?\/study$/,               handler: renderStudy,    title: 'Study',    tab: 'study',    back: false },
  { re: /^#?\/srs$/,                 handler: renderSrs,      title: 'Review',   tab: 'srs',      back: false },
];

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
      $app.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
      try {
        await r.handler($app, ...m.slice(1));
      } catch (e) {
        console.error('[route] view render failed:', e);
        $app.innerHTML = `<div class="empty error">
          <p>Something went wrong.</p>
          <button class="btn primary" id="route-retry">Retry</button>
        </div>`;
        document.getElementById('route-retry')?.addEventListener('click', () => route());
      }
      // 뷰 전환 페이드인 (reflow 트릭으로 매 라우트마다 재시작; reduced-motion 에선 무시됨)
      $app.classList.remove('view-enter');
      void $app.offsetWidth;
      $app.classList.add('view-enter');
      return;
    }
  }
  $app.innerHTML = `<div class="empty">404 — ${escapeHtml(hash)} (v${APP_VERSION})</div>`;
}

// === Auth gate (Supabase 단일 사용자) ===
let authed = false;

async function boot() {
  let session = null;
  try {
    ({ data: { session } } = await supabase.auth.getSession());
  } catch (e) {
    console.error('auth getSession failed', e);
  }
  if (session) {
    authed = true;
    document.body.classList.remove('logged-out');
    route();
  } else {
    showLogin();
  }
}

function showLogin() {
  authed = false;
  document.body.classList.add('logged-out');
  $back.hidden = true;
  $title.textContent = 'American English Podcast';
  renderLogin($app, () => {
    authed = true;
    document.body.classList.remove('logged-out');
    location.hash = '#/';
    route();
  });
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT' && authed) showLogin();
});

window.addEventListener('hashchange', () => { if (authed) route(); });
window.addEventListener('load', boot);
if (document.readyState !== 'loading') boot();

$back.addEventListener('click', () => history.back());

// 동기화 버튼 재활용 — 신규 에피소드는 GitHub Actions cron 이 Supabase 에 채운다.
//   탭        = 현재 화면 데이터 새로고침
//   길게 누름 = 로그아웃
let _syncHold = null;
function refreshData() {
  $sync.disabled = true;
  $sync.classList.add('syncing');
  Promise.resolve(route()).finally(() => {
    setTimeout(() => {
      $sync.disabled = false;
      $sync.classList.remove('syncing');
      toast('Synced to latest');
    }, 350);
  });
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

export async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
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

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}
