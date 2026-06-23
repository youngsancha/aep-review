// Car Mode (운전 중 큰 버튼·고대비) — A3.
// 폰을 차에 거치하고 쓰는 화면. 오디오 컨트롤만 큼직하게(재생/±스킵/진행바), 학습 인터랙션(자막/단어)
// 은 의도적으로 배제(운전 부담↓). 잠금화면/핸들/블루투스 컨트롤은 A1(Media Session)이 별도로 처리한다.
// 재생 자체는 전역 player(player.js) 를 그대로 사용 → 다른 화면과 상태 일관.
import { player, getLatestProgress } from '/player.js';
import { listEpisodes, audioSrcFor } from '/db.js';
import { SHOW_COVER, SHOW_COVER_SM } from '/config.js';

const SVG_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';
const SVG_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

// 무엇을 틀지 결정(순수): 이미 로드된 트랙 우선, 없으면 마지막 이어듣기, 둘 다 없으면 none.
export function driveTarget(current, latest) {
  if (current && current.id) return { mode: 'current', id: current.id, title: current.title || '', resume: 0 };
  if (latest && latest.id) return { mode: 'resume', id: latest.id, title: latest.title || '', resume: latest.t || 0 };
  return { mode: 'none' };
}

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const cleanTitle = (t) => (t || '').replace(/^\d+\s*[-:.]\s*/, '');

let _off = null;  // player 구독 해제 핸들 — 화면 떠날 때 누수 방지
function cleanup() { if (_off) { _off(); _off = null; } }
window.addEventListener('hashchange', cleanup);  // 모듈 1회 등록

export async function renderDrive(root) {
  cleanup();
  const tgt = driveTarget(player.current, getLatestProgress());

  if (tgt.mode === 'none') {
    root.innerHTML = `<div class="drive drive-empty">
      <div class="drive-art" style="background-image:url('${SHOW_COVER}')"></div>
      <p class="drive-title">No recent episode</p>
      <p class="drive-hint">라이브러리에서 에피소드를 한 번 재생하면 여기서 이어들을 수 있어요.</p>
      <a class="drive-exit" href="#/">← Library</a>
    </div>`;
    return;
  }

  // 이어듣기 대상이면 오디오 소스를 player 에 로드(자동재생 X — 운전자가 큰 ▶ 를 직접 탭).
  if (tgt.mode === 'resume') {
    try {
      const items = await listEpisodes();
      const ep = items.find((e) => e.id === tgt.id);
      if (ep && ep.audio_url) {
        const src = await audioSrcFor(ep.id, ep.audio_url);
        player.load({ id: ep.id, title: ep.title, show: 'American English Podcast', cover: SHOW_COVER_SM, src });
        const seekResume = () => { if (tgt.resume > 0) player.seek(tgt.resume); };
        if (player.duration) seekResume();
        else { const offMeta = player.on((ev) => { if (ev === 'meta') { seekResume(); offMeta(); } }); }
      }
    } catch (e) { /* 오프라인 등 — 캐시된 오디오면 ▶ 로 여전히 재생 가능 */ }
  }

  root.innerHTML = `
    <div class="drive">
      <div class="drive-art" style="background-image:url('${SHOW_COVER}')"></div>
      <p class="drive-title" id="dr-title">${cleanTitle(tgt.title) || 'American English Podcast'}</p>
      <div class="drive-time">
        <span id="dr-cur">0:00</span>
        <div class="drive-bar"><span id="dr-fill"></span></div>
        <span id="dr-dur">--:--</span>
      </div>
      <div class="drive-controls">
        <button id="dr-back" class="drive-skip" aria-label="Back 15 seconds">−15</button>
        <button id="dr-play" class="drive-play" aria-label="Play or pause">${player.paused ? SVG_PLAY : SVG_PAUSE}</button>
        <button id="dr-fwd" class="drive-skip" aria-label="Forward 30 seconds">+30</button>
      </div>
      <a class="drive-exit" href="#/">← Library</a>
    </div>`;

  const $play = root.querySelector('#dr-play');
  const $cur = root.querySelector('#dr-cur');
  const $dur = root.querySelector('#dr-dur');
  const $fill = root.querySelector('#dr-fill');
  const $title = root.querySelector('#dr-title');

  const update = () => {
    if (!document.body.contains($play)) { cleanup(); return; }  // 화면 떠남 → 정리
    $play.innerHTML = player.paused ? SVG_PLAY : SVG_PAUSE;
    const dur = player.duration, t = player.time;
    $cur.textContent = fmt(t);
    $dur.textContent = dur ? fmt(dur) : '--:--';
    $fill.style.width = dur ? (t / dur * 100).toFixed(1) + '%' : '0%';
    if (player.current && player.current.title) $title.textContent = cleanTitle(player.current.title);
  };

  root.querySelector('#dr-play').addEventListener('click', () => player.toggle());
  root.querySelector('#dr-back').addEventListener('click', () => player.skip(-15));
  root.querySelector('#dr-fwd').addEventListener('click', () => player.skip(30));
  _off = player.on(update);
  update();
}
