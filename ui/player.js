// Global audio player + mini-player UI.
// Single <audio> element survives across route changes.
// Now Playing view binds to it, mini-player reflects state always.
import { SHOW_COVER_SM } from '/config.js';

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
    if (this.current && this.current.id === track.id) return;
    this.current = track;
    this.audio.src = track.src;
    this._emit('track');
  }

  play()    { this.audio.play().catch(() => {}); }
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
