// Settings 시트 — 흩어져 있던 앱 설정을 한곳에. (정밀진단 v1.41.x: 로그아웃이 ↻ 롱프레스에만
// 숨어 있고, 테마는 Auto 로 못 돌아오며, 오프라인 개수는 라이브러리 상태줄의 발견성 낮은 탭에만
// 있었다 — 이 셋을 발견 가능한 한 메뉴로.) 지금까지 아무 동작 없던 버전 표시를 탭하면 열린다.
//
// 앱 크롬이므로 문구는 영어. app.js 가 deps(테마 적용/현재 테마/로그아웃 콜백/버전)를 주입한다.
// offline.js(오프라인 개수)는 여기서 동적 import — SHELL 에 있어 오프라인에서도 로드된다.
import { toast, escapeHtml, withTimeout } from '/app.js';
import { supabase } from '/supabase.js';

const OFFLINE_STEPS = [
  { n: 0, label: 'Off' },
  { n: 5, label: '5' },
  { n: 15, label: '15' },
  { n: 30, label: '30' },
];
const THEME_STEPS = [
  { v: 'auto', label: 'Auto' },
  { v: 'light', label: 'Light' },
  { v: 'dark', label: 'Dark' },
];

// Study 탭(aep-session-size)과 동일한 키/값(S/M/L, 기본 M) — 한쪽만 바꾸면 드리프트하므로
// 여기서도 이 세 값만 유효하게 취급한다(study.js::sessSize 와 동일 판정).
const SESS_SIZE_KEY = 'aep-session-size';
const SESSION_SIZE_STEPS = [
  { v: 'S', label: 'S · 5 min' },
  { v: 'M', label: 'M · 10 min' },
  { v: 'L', label: 'L · 20 min' },
];
function getSessionSize() {
  try {
    const v = localStorage.getItem(SESS_SIZE_KEY);
    return (v === 'S' || v === 'M' || v === 'L') ? v : 'M';
  } catch (e) { return 'M'; }
}
function setSessionSize(v) {
  try { localStorage.setItem(SESS_SIZE_KEY, v); } catch (e) { /* quota */ }
}

// 로그인된 계정 표시용 — app.js::boot() 의 getSession() 패턴을 그대로 재사용(3.5s 예산, 오프라인
// 이면 800ms). 저장된 세션은 있는데(hasStoredSession) getSession 이 오프라인 토큰갱신 재시도에
// 락이 잡혀 응답을 못 주는 경우가 있어 — 그때는 user 가 null 로 와도 정상(오프라인 문구로 처리).
const ACCOUNT_FETCH_TIMEOUT_MS = 3500;
async function fetchAccount() {
  try {
    const budget = navigator.onLine === false ? 800 : ACCOUNT_FETCH_TIMEOUT_MS;
    const res = await withTimeout(supabase.auth.getSession(), budget, { data: { session: null } });
    const user = (res && res.data && res.data.session && res.data.session.user) || null;
    if (!user) return null;
    const meta = user.user_metadata || {};
    const email = user.email || meta.email || '';
    const provider = (user.app_metadata && user.app_metadata.provider) || 'google';
    return {
      email,
      avatar: meta.avatar_url || meta.picture || '',
      initial: (email || meta.name || meta.full_name || '?').trim().charAt(0).toUpperCase() || '?',
      provider: provider.charAt(0).toUpperCase() + provider.slice(1),
    };
  } catch (e) {
    console.error('[settings] account fetch failed', e);
    return null;
  }
}

function seg(name, steps, cur, keyOf) {
  return `<div class="set-seg" role="group" aria-label="${name}">${steps.map((s) => {
    const val = keyOf(s);
    return `<button class="set-seg-btn${val === cur ? ' on' : ''}" data-v="${val}">${escapeHtml(String(s.label))}</button>`;
  }).join('')}</div>`;
}

export async function openSettings(deps) {
  if (document.querySelector('.set-backdrop')) return;   // 중복 열림 방지
  let off = null;
  try { off = await import('/offline.js'); } catch (e) { /* 오프라인 모듈 없으면 그 섹션만 생략 */ }
  const account = await fetchAccount();

  const curTheme = (() => {
    let s = null; try { s = localStorage.getItem('aep-theme'); } catch (e) {}
    return (s === 'light' || s === 'dark') ? s : 'auto';
  })();
  const curOffline = off ? off.offlineCount() : null;
  const curSessSize = getSessionSize();

  const back = document.createElement('div');
  back.className = 'set-backdrop';
  back.innerHTML = `
    <div class="set-sheet" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="set-grab"></div>
      <div class="set-head"><h3>Settings</h3><button class="set-x" id="set-x" aria-label="Close">✕</button></div>
      <div class="set-body">
        <div class="set-row">
          <div class="set-row-l"><b>Theme</b><span>Auto follows your device</span></div>
          ${seg('Theme', THEME_STEPS, curTheme, (s) => s.v)}
        </div>
        ${off ? `
        <div class="set-row">
          <div class="set-row-l"><b>Offline downloads</b><span>Keep the latest N episodes for no-signal listening</span></div>
          ${seg('Offline downloads', OFFLINE_STEPS, String(curOffline), (s) => String(s.n))}
        </div>` : ''}
        <div class="set-row" id="set-row-sesssize">
          <div class="set-row-l"><b>오늘 세션 크기</b><span>Study 홈 · 오늘의 세션 카드와 같은 설정이에요</span></div>
          ${seg('오늘 세션 크기', SESSION_SIZE_STEPS, curSessSize, (s) => s.v)}
        </div>
        <div class="set-note">Transcript &amp; translation text size live on the <b>A</b> / <b>가</b> chips inside an episode’s transcript.</div>
        ${account ? `
        <div class="set-row">
          <div class="set-row-l" style="display:flex;align-items:center;gap:10px;">
            <span aria-hidden="true" style="flex:0 0 36px;width:36px;height:36px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--tint-soft);color:var(--tint-hover);font-weight:700;font-size:15px;">${account.avatar ? `<img src="${escapeHtml(account.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;" />` : escapeHtml(account.initial)}</span>
            <span>
              <b style="display:block;">${escapeHtml(account.email || '계정')}</b>
              <span style="display:block;font-size:12.5px;color:var(--text-3);margin-top:2px;">${escapeHtml(account.provider)}</span>
            </span>
          </div>
        </div>` : `
        <div class="set-note">오프라인 — 계정 정보를 불러올 수 없어요</div>`}
        <button class="btn set-signout" id="set-signout">Sign out</button>
        <div class="set-ver">E-Podcast · v${escapeHtml(String(deps.version || (window.APP_VERSION || '')))}</div>
      </div>
    </div>`;
  document.body.appendChild(back);
  requestAnimationFrame(() => back.classList.add('open'));

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    back.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => back.remove(), 240);
  }
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.querySelector('#set-x')?.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  // 테마 세그먼트 — Auto/Light/Dark. Auto 는 localStorage 제거(시스템 추종 복귀).
  back.querySelectorAll('.set-seg')[0]?.querySelectorAll('.set-seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const v = b.dataset.v;
      try { if (v === 'auto') localStorage.removeItem('aep-theme'); else localStorage.setItem('aep-theme', v); } catch (e) {}
      deps.applyTheme(v);   // app.js applyTheme('auto'|'light'|'dark')
      back.querySelectorAll('.set-seg')[0].querySelectorAll('.set-seg-btn').forEach((x) => x.classList.toggle('on', x === b));
    });
  });

  // 오프라인 개수 세그먼트 — 0(Off)/5/15/30. 켜면 즉시 프리페치.
  if (off) {
    const oSeg = back.querySelectorAll('.set-seg')[1];
    oSeg?.querySelectorAll('.set-seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const n = parseInt(b.dataset.v, 10) || 0;
        off.setOfflineCount(n);
        oSeg.querySelectorAll('.set-seg-btn').forEach((x) => x.classList.toggle('on', x === b));
        if (n > 0) { toast(`Saving latest ${n} for offline…`); off.forceRun && off.forceRun(); }
        else toast('Offline downloads off');
      });
    });
  }

  // 오늘 세션 크기 세그먼트 — S/M/L, Study 탭과 동일 키(aep-session-size). Offline 행이 조건부라
  // 인덱스가 흔들리므로(위 [0]/[1] 방식) id 로 직접 선택해 안전하게 바인딩한다.
  const sizeRow = back.querySelector('#set-row-sesssize');
  sizeRow?.querySelectorAll('.set-seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      setSessionSize(b.dataset.v);
      sizeRow.querySelectorAll('.set-seg-btn').forEach((x) => x.classList.toggle('on', x === b));
    });
  });

  back.querySelector('#set-signout')?.addEventListener('click', () => {
    close();
    deps.onSignOut && deps.onSignOut();
  });
}
