// Global audio player + mini-player UI.
// Single <audio> element survives across route changes.
// Now Playing view binds to it, mini-player reflects state always.
import { showCover, currentShow } from '/config.js';
import { bindMediaSession } from '/media-session.js';
import { bindScrub } from '/scrub.js';
import { toast } from '/app.js';   // hoisted export — 순환 import 에서도 안전(함수 선언)
import * as guard from '/stall-guard.js';

const SVG_PLAY  = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';
const SVG_PAUSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

class Player {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this._resumeAt = null; this._resumeRate = null; this._restoreFn = null;
    this.current = null;  // { id, title, show, cover, src }
    this.listeners = new Set();

    this.audio.addEventListener('timeupdate', () => this._emit('timeupdate'));
    this.audio.addEventListener('play',  () => this._emit('play'));
    this.audio.addEventListener('pause', () => this._emit('pause'));
    this.audio.addEventListener('ended', () => this._emit('ended'));
    this.audio.addEventListener('loadedmetadata', () => this._emit('meta'));
    this.audio.addEventListener('error', () => this._emit('error'));

    // === 정체 감시(stall-guard.js) — 오프라인·화면꺼짐·에어팟에서 재생이 소리 없이 멈추는 문제 ===
    this._guard = guard.initialState();
    this.audio.addEventListener('timeupdate', () => guard.noteTime(this._guard, this.audio.currentTime, Date.now()));
    // 일시정지가 길었다면 lastAdvanceAt 이 한참 옛날 → ▶ 직후 5초 감시가 '정체'로 오판해 불필요한 재로드를 한다.
    // 단 shouldReloadBeforePlay 는 play() 안에서 이 이벤트보다 먼저 평가되므로 죽은 파이프라인 복구는 그대로다.
    // ⛔ 'playing' 에는 걸지 않는다: waiting↔playing 을 오가며 시간이 멈춘 파이프라인이 매번 시계를 되감아
    // 정체 판정이 영영 안 난다. 일시정지 복귀는 'play' 하나로 충분하고, 그 뒤 진행은 timeupdate 가 잡는다.
    this.audio.addEventListener('play', () => guard.notePlay(this._guard, Date.now()));
    this.audio.addEventListener('waiting', () => { guard.noteWaiting(this._guard, Date.now()); playLog('waiting', this._snap()); });
    this.audio.addEventListener('stalled', () => { guard.noteWaiting(this._guard, Date.now()); playLog('stalled', this._snap()); });
    this.audio.addEventListener('error', () => playLog('error', this._snap()));
    // 백그라운드에서는 브라우저가 타이머를 1분에 한 번으로 늦출 수 있다 — 그래도 1분 안에는 복구된다.
    setInterval(() => this._watch(), 5000);
    document.addEventListener('visibilitychange', () => playLog(document.visibilityState, this._snap()));
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('controllerchange', () => playLog('sw-controllerchange', this._snap()));
    }
  }

  _snap() {
    const a = this.audio;
    return { paused: a.paused, ended: a.ended, currentTime: a.currentTime || 0,
             error: a.error ? { code: a.error.code } : null, ready: a.readyState, net: a.networkState,
             online: navigator.onLine };
  }

  _watch() {
    if (!this.current || !this.current.src) return;
    const verdict = guard.decide(this._guard, this._snap(), Date.now());
    if (verdict === 'ok') return;
    playLog(verdict, this._snap());
    if (verdict === 'give-up') return;   // 상한 도달 — 진짜 죽은 파일. 토스트는 error 경로가 맡는다.
    this._reload(true);
  }

  // 재로드 직전 위치·속도를 인스턴스에 하나씩만 보관한다(트랙 변경 시 해제). src 를 다시 세팅하면 load 알고리즘이
  // currentTime 을 0, playbackRate 를 기본값으로 되돌리므로, 에러 후 재생·겹친 재로드가 0:00·1× 로 가거나 옛 위치를
  // 새 트랙에 적용하지 않게 모든 경로가 이 값을 쓴다. 이미 복원 대기 중이면(아직 loadedmetadata 전) 덮어쓰지 않는다.
  _resetSrc(thenPlay) {
    const a = this.audio;
    if (this._resumeAt == null) this._resumeAt = a.currentTime || 0;
    if (this._resumeRate == null) this._resumeRate = a.playbackRate || 1;
    if (this._restoreFn) a.removeEventListener('loadedmetadata', this._restoreFn);   // 겹친 재로드: 앞의 복원은 폐기
    const track = this.current;
    a.src = track.src;
    const restore = () => {
      a.removeEventListener('loadedmetadata', restore);
      if (this._restoreFn === restore) this._restoreFn = null;
      if (this.current !== track) return;           // 그 사이 트랙이 바뀜 — 옛 위치를 새 트랙에 쓰지 않는다
      const t = this._resumeAt, rate = this._resumeRate;
      this._resumeAt = null; this._resumeRate = null;
      try { if (t) a.currentTime = t; if (rate) a.playbackRate = rate; } catch (e) {}
      if (thenPlay) a.play().catch((err) => playLog('reload-play-failed', { name: err && err.name }));
    };
    this._restoreFn = restore;
    a.addEventListener('loadedmetadata', restore);
    try { a.load(); } catch (e) {}
  }

  // 같은 위치로 src 를 다시 로드한다: 새 fetch → (죽어 있던 SW 가 다시 뜨고) 캐시에서 다시 읽는다.
  _reload(thenPlay) {
    const a = this.audio;
    guard.noteRecovery(this._guard, Date.now());
    playLog('reload', { t: this._resumeAt ?? (a.currentTime || 0), thenPlay });
    try { a.pause(); } catch (e) {}
    this._resetSrc(thenPlay);
  }

  load(track) {
    if (this.current && this.current.id === track.id) {
      if (!this.audio.src && track.src) this.audio.src = track.src;  // 방어: src 비었으면 복구
      return;
    }
    this.current = track;
    this._resumeAt = null; this._resumeRate = null;
    if (this._restoreFn) { this.audio.removeEventListener('loadedmetadata', this._restoreFn); this._restoreFn = null; }
    this.audio.src = track.src;
    guard.noteTrackChange(this._guard);
    this._emit('track');
  }

  play() {
    const a = this.audio;
    // 딥링크/새로고침 직후 콜드 스타트: src 가 비었거나 에러면 현재 트랙으로 (재)설정 + 강제 로드.
    // (네비게이션과 달리 직접 에피소드 로드 시 오디오가 한 번도 '워밍업' 안 돼 첫 재생이 먹통이던 문제)
    if (this.current && this.current.src && (a.error || !a.currentSrc)) {
      this._resetSrc(false);   // 위치 보존(예전엔 src 재설정으로 0:00 부터 다시 시작) — 재생은 아래 tryPlay/onReady
    } else if (this.current && this.current.src
               && guard.shouldReloadBeforePlay(this._guard, this._snap(), Date.now())) {
      // 에어팟/잠금화면 ▶: 오래 waiting 이던 파이프라인은 play() 가 resolve 만 하고 소리가 안 난다 → 재로드 후 재생.
      this._reload(true);
      return;
    }
    const tryPlay = () => { const p = a.play(); if (p && p.catch) p.catch((err) => { if (!(err && err.name === 'NotAllowedError')) { /* 로드 후 재시도가 처리 */ } }); };
    tryPlay();  // 제스처 보존: 클릭 스택에서 즉시 1회
    // 아직 로드 전이라 못 켜졌으면, 재생 가능해지는 즉시 1회 자동 재시도(여러 이벤트로 견고하게).
    if (a.paused) {
      const onReady = () => {
        a.removeEventListener('canplay', onReady);
        a.removeEventListener('loadeddata', onReady);
        a.removeEventListener('canplaythrough', onReady);
        a.play().catch(() => {});
      };
      a.addEventListener('canplay', onReady, { once: true });
      a.addEventListener('loadeddata', onReady, { once: true });
      a.addEventListener('canplaythrough', onReady, { once: true });
    }
  }
  pause()   { this.audio.pause(); }
  toggle()  { this.audio.paused ? this.play() : this.pause(); }
  seek(t)   { if (Number.isFinite(t)) { this._resumeAt = null; this.audio.currentTime = t; } }   // 사용자 시크가 대기 중인 복원 위치를 이긴다
  rate(r)   { this._resumeRate = null; this.audio.playbackRate = r; }   // 사용자 선택이 대기 중인 복원 속도를 이긴다
  skip(d)   { this._resumeAt = null; this.audio.currentTime = Math.max(0, this.audio.currentTime + d); }

  on(fn)  { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(ev) {
    // Each listener runs in its own try/catch — one bad listener can't block others.
    for (const fn of this.listeners) {
      try { fn(ev, this); } catch (err) { console.error('[player] listener failed:', err); }
    }
  }

  get paused()   { return this.audio.paused; }
  get time()     { return this.audio.currentTime || 0; }
  get duration() { return this.audio.duration || 0; }
}

// 재생 사건 링버퍼(localStorage 'aep-play-log', 최근 40건) — 폰에서만 나는 문제의 증거를 남긴다.
// 읽기: window.__playLog() 또는 USB 디버깅으로 localStorage 를 본다. 절대 네트워크로 보내지 않는다.
const PLAY_LOG_KEY = 'aep-play-log';
function playLog(ev, data) {
  try {
    const arr = JSON.parse(localStorage.getItem(PLAY_LOG_KEY) || '[]');
    arr.push({ at: new Date().toISOString(), ev, id: player && player.current ? player.current.id : null, ...(data || {}) });
    while (arr.length > 40) arr.shift();
    localStorage.setItem(PLAY_LOG_KEY, JSON.stringify(arr));
  } catch (e) { /* quota/private mode */ }
}
window.__playLog = () => { try { return JSON.parse(localStorage.getItem(PLAY_LOG_KEY) || '[]'); } catch { return []; } };

export const player = new Player();

// 재생 실패를 조용한 데드버튼으로 두지 않고 알린다(사용자 보고: 오프라인에서 미다운로드 회차 ▶ 무반응).
// 콜드스타트 복구(빈 src→재로드)나 트랙 교체(ABORTED)의 일시 오류는 무시하고, 실제 미디어 오류만
// 3초 디바운스로 토스트. 오프라인이면 '받은 회차만' 안내, 온라인이면 재시도 유도.
let _lastErrToast = 0;
player.on((ev) => {
  if (ev !== 'error') return;
  if (!player.current || !player.current.src) return;
  const err = player.audio.error;
  if (err && err.code === err.MEDIA_ERR_ABORTED) return;   // 트랙 교체 등 정상 중단
  const now = Date.now();
  if (now - _lastErrToast < 3000) return;
  _lastErrToast = now;
  toast(navigator.onLine ? 'Playback failed — try again' : 'Offline — only downloaded (⬇) episodes play');
});
window.__player = player;  // debug

// 차량/핸들/잠금화면/블루투스 미디어 컨트롤 연동(미지원 환경이면 자동 no-op).
bindMediaSession(player);

// === 재생 위치 저장(이어듣기) — 에피소드별 audio 시각을 localStorage 에 (transcript 딥링크와 별개) ===
const PROG_KEY = 'aep-progress';
function loadMap() { try { return JSON.parse(localStorage.getItem(PROG_KEY) || '{}') || {}; } catch { return {}; } }
function saveMap(m) { try { localStorage.setItem(PROG_KEY, JSON.stringify(m)); } catch (e) { /* quota */ } }
export function getProgress(id) { const m = loadMap(); return m[id] || null; }
export function getProgressMap() { return loadMap(); }  // 전체 진도 맵(라이브러리 행별 표시용)

// 끝까지 들은 에피소드(완료) 집합 — 라이브러리에 '✓ 들음' 표시용
const DONE_KEY = 'aep-completed';
function loadDone() { try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); } catch { return new Set(); } }
export function getCompleted() { return loadDone(); }
function markCompleted(id, title) {
  const s = loadDone();
  if (!s.has(id)) { s.add(id); try { localStorage.setItem(DONE_KEY, JSON.stringify([...s])); } catch (e) {} }
  // 완료 '시각+제목' 별도 맵 — Study 홈 '최근 들은 회차' 트리아지용. 진도맵(aep-progress)은
  // 완료 시 삭제되므로, 출퇴근에 끝까지 들은 회차는 이 맵이 없으면 최근 목록에서 사라진다.
  try {
    const m = JSON.parse(localStorage.getItem(DONE_AT_KEY) || '{}') || {};
    if (!m[id]) { m[id] = { at: Date.now(), title: title || '' }; localStorage.setItem(DONE_AT_KEY, JSON.stringify(m)); }
  } catch (e) { /* quota */ }
}
const DONE_AT_KEY = 'aep-completed-at';
export function getCompletedAt() {
  try { return JSON.parse(localStorage.getItem(DONE_AT_KEY) || '{}') || {}; } catch { return {}; }
}
let _lastSave = 0;
function saveProgress() {
  const c = player.current; if (!c) return;
  const t = player.time, dur = player.duration;
  const m = loadMap();
  if (dur && t > 5 && t < dur - 10) {
    m[c.id] = { t, dur, title: c.title, at: Date.now() };
    saveMap(m);
  } else if (dur && t >= dur - 10) {  // 거의 끝까지 들음 → 완료 기록 + 이어듣기에서 제거
    markCompleted(c.id, c.title);
    if (m[c.id]) { delete m[c.id]; saveMap(m); }
  }
}
player.on((ev) => {
  if (ev === 'timeupdate') { const n = Date.now(); if (n - _lastSave > 5000) { _lastSave = n; saveProgress(); } }
  else if (ev === 'pause' || ev === 'ended') { saveProgress(); }
});

// === Mini-player wiring ===
const $mp     = document.getElementById('miniplayer');
const $cover  = document.getElementById('mp-cover');
const $title  = document.getElementById('mp-title');
const $sub    = document.getElementById('mp-sub');
const $play   = document.getElementById('mp-play');
const $fwd    = document.getElementById('mp-fwd');
const $prog   = document.getElementById('mp-progress');
const $fill   = document.getElementById('mp-progress-fill');
const $handle = document.getElementById('mp-progress-handle');

function fmt(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

let _miniTrackId = null, _miniPaused = null;
function refreshMini() {
  if (!player.current) {
    $mp.classList.add('hidden');
    $mp.setAttribute('aria-hidden', 'true');
    $mp.inert = true;            // 숨긴 플레이어의 버튼에 키보드 포커스가 들어가지 않게
    return;
  }
  $mp.classList.remove('hidden');
  $mp.setAttribute('aria-hidden', 'false');
  $mp.inert = false;
  // 커버/제목은 '트랙이 바뀔 때만' 재기록 — 매 timeupdate(4Hz)마다 .src/.textContent 쓰기를 없앤다.
  if (player.current.id !== _miniTrackId) {
    _miniTrackId = player.current.id;
    $cover.src = player.current.cover || (showCover(currentShow()) + '&w=160&h=160');
    $title.textContent = player.current.title || '—';
  }
  const dur = player.duration;
  $sub.textContent = dur
    ? `${fmt(player.time)} / ${fmt(dur)}`
    : (player.current.show || '');
  // 재생 아이콘도 상태 변화 시에만 innerHTML 재파싱.
  if (_miniPaused !== player.paused) {
    _miniPaused = player.paused;
    $play.innerHTML = player.paused ? SVG_PLAY : SVG_PAUSE;
  }
  // 스크럽(드래그) 중엔 fill/핸들을 player.time 으로 덮어쓰지 않는다 — 미리보기 위치를 유지.
  if (dur && !(mpScrub && mpScrub.isDragging())) {
    const pct = (player.time / dur * 100).toFixed(2);
    $fill.style.width = pct + '%';
    if ($handle) $handle.style.left = pct + '%';
  }
}

player.on(refreshMini);

// === 미니플레이어 진행바 스와이프 시크 (Apple Podcasts 식) ===
// 진행바를 탭/드래그하면 그 지점으로 재생 위치를 옮긴다. 드래그 중엔 fill·핸들·시간만 미리 갱신하고
// (오디오는 안 끊김), 손을 뗄 때 한 번 seek + 재생. mpScrub 은 refreshMini 의 게이트로도 쓰인다.
let mpScrub = null;
if ($prog) {
  mpScrub = bindScrub($prog, {
    onPreview(frac) {
      const pct = (frac * 100).toFixed(2);
      $fill.style.width = pct + '%';
      if ($handle) $handle.style.left = pct + '%';
      const dur = player.duration;
      if (dur) $sub.textContent = `${fmt(dur * frac)} / ${fmt(dur)}`;
    },
    onSeek(frac) {
      const dur = player.duration;
      if (dur) { player.seek(dur * frac); player.play(); }
    },
    onCancel() { refreshMini(); },   // 제스처 취소: seek 없이 미리보기를 실제 재생 위치로 되돌린다

  });
}

$play.addEventListener('click', (e) => {
  e.stopPropagation();
  player.toggle();
});
$fwd.addEventListener('click', (e) => {
  e.stopPropagation();
  player.skip(30);
});
$mp.addEventListener('click', () => {
  if (player.current) location.hash = `#/episode/${player.current.id}`;
});

refreshMini();
