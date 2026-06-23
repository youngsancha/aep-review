// Global audio player + mini-player UI.
// Single <audio> element survives across route changes.
// Now Playing view binds to it, mini-player reflects state always.
import { SHOW_COVER_SM } from '/config.js';
import { bindMediaSession } from '/media-session.js';

const SVG_PLAY  = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';
const SVG_PAUSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

class Player {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.current = null;  // { id, title, show, cover, src }
    this.listeners = new Set();

    this.audio.addEventListener('timeupdate', () => this._emit('timeupdate'));
    this.audio.addEventListener('play',  () => this._emit('play'));
    this.audio.addEventListener('pause', () => this._emit('pause'));
    this.audio.addEventListener('ended', () => this._emit('ended'));
    this.audio.addEventListener('loadedmetadata', () => this._emit('meta'));
  }

  load(track) {
    if (this.current && this.current.id === track.id) {
      if (!this.audio.src && track.src) this.audio.src = track.src;  // 방어: src 비었으면 복구
      return;
    }
    this.current = track;
    this.audio.src = track.src;
    this._emit('track');
  }

  play() {
    const a = this.audio;
    // 딥링크/새로고침 직후 콜드 스타트: src 가 비었거나 에러면 현재 트랙으로 (재)설정 + 강제 로드.
    // (네비게이션과 달리 직접 에피소드 로드 시 오디오가 한 번도 '워밍업' 안 돼 첫 재생이 먹통이던 문제)
    if (this.current && this.current.src && (a.error || !a.currentSrc)) {
      a.src = this.current.src;
      try { a.load(); } catch (e) {}
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
  seek(t)   { if (Number.isFinite(t)) this.audio.currentTime = t; }
  rate(r)   { this.audio.playbackRate = r; }
  skip(d)   { this.audio.currentTime = Math.max(0, this.audio.currentTime + d); }

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

export const player = new Player();
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
function markCompleted(id) {
  const s = loadDone();
  if (!s.has(id)) { s.add(id); try { localStorage.setItem(DONE_KEY, JSON.stringify([...s])); } catch (e) {} }
}
export function getLatestProgress() {
  const m = loadMap(); let best = null;
  for (const id in m) { const e = m[id]; if (e && (!best || e.at > best.at)) best = { id: Number(id), ...e }; }
  return best;
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
    markCompleted(c.id);
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
const $fill   = document.getElementById('mp-progress-fill');

function fmt(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function refreshMini() {
  if (!player.current) {
    $mp.classList.add('hidden');
    $mp.setAttribute('aria-hidden', 'true');
    return;
  }
  $mp.classList.remove('hidden');
  $mp.setAttribute('aria-hidden', 'false');
  $cover.src = player.current.cover || SHOW_COVER_SM;
  $title.textContent = player.current.title || '—';
  const dur = player.duration;
  $sub.textContent = dur
    ? `${fmt(player.time)} / ${fmt(dur)}`
    : (player.current.show || '');
  $play.innerHTML = player.paused ? SVG_PLAY : SVG_PAUSE;
  if (dur) $fill.style.width = (player.time / dur * 100).toFixed(2) + '%';
}

player.on(refreshMini);

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
