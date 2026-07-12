// 로그인 화면 — Google 단독(사용자 요청 2026-07-09). 세션이 없으면 app.js 가 이 화면을 띄운다.
// email+password 폼은 기본 숨김 — Google 프로바이더가 서버(대시보드)에서 비활성(400)일 때만
// 비상 폴백으로 노출한다(안 그러면 프로바이더 설정 전엔 로그인 수단이 전무). 성공 시 onSuccess().
import { supabase } from '/supabase.js';
import { escapeHtml } from '/app.js';
import { SHOW_COVER } from '/config.js';

// Google 버튼은 리다이렉트 직전 disabled 로 잠근다. 사용자가 Google 페이지에서 '뒤로가기' 하면
// iOS Safari/Chrome 은 이 페이지를 bfcache 에서 '있는 그대로'(disabled·에러없음) 복원 → 버튼이
// 영구 무반응이 됐다. pageshow(persisted) 에서 현재 DOM 의 버튼을 다시 활성화한다(모듈 1회 등록,
// 이벤트 시점에 DOM 조회하므로 항상 최신 버튼을 대상으로 함).
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  const g = document.getElementById('login-google');
  if (g) g.disabled = false;
});

export function renderLogin(root, onSuccess) {
  root.innerHTML = `
    <div class="login-wrap">
      <div class="login-glow" style="background-image:url('${SHOW_COVER}')"></div>
      <img class="login-cover" src="${SHOW_COVER}" alt="" onerror="this.src='/icons/icon-512.png'" />
      <h1 class="login-title">American English Podcast</h1>
      <p class="login-sub">Shadowing Practice · Sign In</p>
      <button id="login-google" class="btn login-google" type="button">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
        <span>Continue with Google</span>
      </button>
      <p id="login-err" class="login-err" hidden></p>
      <div id="login-or" class="login-or" hidden><span>or</span></div>
      <form id="login-form" class="login-form" hidden>
        <input id="login-email" class="login-input" type="email" inputmode="email"
               autocomplete="username" placeholder="Email" required />
        <input id="login-pass" class="login-input" type="password"
               autocomplete="current-password" placeholder="Password" required />
        <button class="btn primary login-btn" type="submit">Sign In</button>
      </form>
    </div>
  `;

  const form = root.querySelector('#login-form');
  const $btn = root.querySelector('.login-btn');
  const $err = root.querySelector('#login-err');
  const $google = root.querySelector('#login-google');
  const $or = root.querySelector('#login-or');

  // 프로바이더 미설정(400) 시에만 email+password 폼을 폴백으로 노출.
  function revealEmailFallback(msg) {
    $err.textContent = msg;
    $err.hidden = false;
    $or.hidden = false;
    form.hidden = false;
    $google.disabled = false;
  }

  // Google 로그인 — Supabase OAuth(PKCE). 리다이렉트 후 복귀 처리는 app.js(onAuthStateChange).
  // skipBrowserRedirect 로 URL 만 받아 먼저 검사: 프로바이더가 대시보드에서 비활성이면 authorize 가
  // 400 JSON 을 반환하는데, 바로 네비게이션하면 사용자가 raw JSON 페이지를 보게 된다(실사고 2026-07-04).
  $google.addEventListener('click', async () => {
    $err.hidden = true;
    $google.disabled = true;
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        // 해시(#/) 라우터와 충돌 없도록 쿼리 없는 앱 루트로 복귀(?code= 만 붙음).
        options: {
          redirectTo: window.location.origin + window.location.pathname,
          skipBrowserRedirect: true,
        },
      });
      if (error) throw error;
      try {
        // 정상이면 302(opaqueredirect, status 0) — 400 만 프로바이더 미설정 신호.
        const probe = await fetch(data.url, { redirect: 'manual' });
        if (probe.status === 400) {
          revealEmailFallback('Google sign-in is not enabled on the server yet — use email + password below.');
          return;
        }
      } catch (_) { /* 프로브 실패(네트워크 등)는 무시하고 정상 경로로 진행 */ }
      window.location.assign(data.url);   // 여기서 Google 로 리다이렉트
    } catch (err) {
      // 예기치 못한 실패에도 로그인 수단이 남도록 폴백 폼을 함께 연다.
      revealEmailFallback('Google sign-in failed: ' + String(err.message || err));
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $err.hidden = true;
    $btn.disabled = true;
    $btn.textContent = '…';
    const email = root.querySelector('#login-email').value.trim();
    const password = root.querySelector('#login-pass').value;
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      onSuccess();
    } catch (err) {
      $err.textContent = 'Sign-in failed: ' + escapeHtml(String(err.message || err));
      $err.hidden = false;
      $btn.disabled = false;
      $btn.textContent = 'Sign In';
    }
  });
}
