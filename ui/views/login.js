// 로그인 화면 — Supabase Auth (email + password) 단일 사용자.
// 세션이 없으면 app.js 가 이 화면을 띄운다. 성공 시 onSuccess() 호출.
import { supabase } from '/supabase.js';
import { escapeHtml } from '/app.js';
import { SHOW_COVER } from '/config.js';

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
      <div class="login-or"><span>or</span></div>
      <form id="login-form" class="login-form">
        <input id="login-email" class="login-input" type="email" inputmode="email"
               autocomplete="username" placeholder="Email" required />
        <input id="login-pass" class="login-input" type="password"
               autocomplete="current-password" placeholder="Password" required />
        <button class="btn primary login-btn" type="submit">Sign In</button>
        <p id="login-err" class="login-err" hidden></p>
      </form>
    </div>
  `;

  const form = root.querySelector('#login-form');
  const $btn = root.querySelector('.login-btn');
  const $err = root.querySelector('#login-err');
  const $google = root.querySelector('#login-google');

  // Google 로그인 — Supabase OAuth(PKCE). 리다이렉트 후 복귀 처리는 app.js(onAuthStateChange).
  $google.addEventListener('click', async () => {
    $err.hidden = true;
    $google.disabled = true;
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        // 해시(#/) 라우터와 충돌 없도록 쿼리 없는 앱 루트로 복귀(?code= 만 붙음).
        options: { redirectTo: window.location.origin + window.location.pathname },
      });
      if (error) throw error;   // 정상이면 여기서 페이지가 Google 로 리다이렉트됨
    } catch (err) {
      $err.textContent = 'Google sign-in failed: ' + escapeHtml(String(err.message || err));
      $err.hidden = false;
      $google.disabled = false;
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
