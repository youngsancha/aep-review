// Settings 시트 — 흩어져 있던 앱 설정을 한곳에. (정밀진단 v1.41.x: 로그아웃이 ↻ 롱프레스에만
// 숨어 있고, 테마는 Auto 로 못 돌아오며, 오프라인 개수는 라이브러리 상태줄의 발견성 낮은 탭에만
// 있었다 — 이 셋을 발견 가능한 한 메뉴로.) 지금까지 아무 동작 없던 버전 표시를 탭하면 열린다.
//
// 앱 크롬이므로 문구는 영어. app.js 가 deps(테마 적용/현재 테마/로그아웃 콜백/버전)를 주입한다.
// offline.js(오프라인 개수)는 여기서 동적 import — SHELL 에 있어 오프라인에서도 로드된다.
import { toast, escapeHtml } from '/app.js';

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

  const curTheme = (() => {
    let s = null; try { s = localStorage.getItem('aep-theme'); } catch (e) {}
    return (s === 'light' || s === 'dark') ? s : 'auto';
  })();
  const curOffline = off ? off.offlineCount() : null;

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
        <div class="set-note">Transcript &amp; translation text size live on the <b>A</b> / <b>가</b> chips inside an episode’s transcript.</div>
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

  back.querySelector('#set-signout')?.addEventListener('click', () => {
    close();
    deps.onSignOut && deps.onSignOut();
  });
}
