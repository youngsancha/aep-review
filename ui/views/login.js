// 로그인 화면 — Supabase Auth (email + password) 단일 사용자.
// 세션이 없으면 app.js 가 이 화면을 띄운다. 성공 시 onSuccess() 호출.
import { supabase } from '/supabase.js';
import { escapeHtml } from '/app.js';

export function renderLogin(root, onSuccess) {
  root.innerHTML = `
    <div class="login-wrap">
      <img class="login-cover" src="/icons/icon-512.png" alt="" onerror="this.src='/icons/icon-192.png'" />
      <h1 class="login-title">American English Podcast</h1>
      <p class="login-sub">복습 PWA · 로그인</p>
      <form id="login-form" class="login-form">
        <input id="login-email" class="login-input" type="email" inputmode="email"
               autocomplete="username" placeholder="이메일" required />
        <input id="login-pass" class="login-input" type="password"
               autocomplete="current-password" placeholder="비밀번호" required />
        <button class="btn primary login-btn" type="submit">로그인</button>
        <p id="login-err" class="login-err" hidden></p>
      </form>
    </div>
  `;

  const form = root.querySelector('#login-form');
  const $btn = root.querySelector('.login-btn');
  const $err = root.querySelector('#login-err');

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
      $err.textContent = '로그인 실패: ' + escapeHtml(String(err.message || err));
      $err.hidden = false;
      $btn.disabled = false;
      $btn.textContent = '로그인';
    }
  });
}
