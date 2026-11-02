// The real ui/player.js against a fake <audio> that follows the HTML load algorithm. The browser harness
// replaces player.js with a mock, so without this file nothing executes the recovery paths: reloading a
// dead pipeline, resuming after an error, and every overlap of those with a seek or a track change.
//
// The one spec behaviour everything here depends on: load() puts currentTime back to 0 and playbackRate
// back to defaultPlaybackRate. Whatever the listener had must be carried across by the player.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { UI, resolveUiModules, installStorage } from './helpers/ui-modules.mjs';

// /app.js boots the whole page, so only its toast() is kept.
resolveUiModules({ '/app.js': 'export function toast(){}' });

class FakeAudio extends EventTarget {
  constructor() {
    super();
    Object.assign(this, { currentTime: 0, playbackRate: 1, defaultPlaybackRate: 1, paused: true, ended: false,
      src: '', currentSrc: '', error: null, readyState: 0, networkState: 0, preload: '', loads: 0, plays: 0 });
  }
  load() {
    this.loads++;
    this.currentTime = 0;
    this.playbackRate = this.defaultPlaybackRate;
    this.readyState = 0;
    this.error = null;
    this.currentSrc = this.src;
  }
  play() {
    this.plays++;
    const wasPaused = this.paused;
    this.paused = false;
    if (wasPaused) this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
  pause() {
    if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); }
  }
  // Test helpers: what the browser does on its own.
  metadataArrived() { this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); }
  fire(type) { this.dispatchEvent(new Event(type)); }
}

const element = () => ({
  addEventListener() {}, removeEventListener() {}, setAttribute() {}, querySelector: () => null,
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: {}, dataset: {},
});
installStorage();
Object.assign(globalThis, {
  window: globalThis,
  Audio: FakeAudio,
  document: { getElementById: () => element(), addEventListener() {}, visibilityState: 'visible', body: element() },
  location: { hash: '#/' },
});
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;           // the player's 5 s watchdog would keep the test process alive
const { player } = await import(new URL('player.js', UI).href);
const guard = await import(new URL('stall-guard.js', UI).href);
globalThis.setInterval = realSetInterval;

const A = { id: 1, title: 'A', src: 'https://r2/1.mp3' };
const B = { id: 2, title: 'B', src: 'https://r2/2.mp3' };
const a = player.audio;

beforeEach(() => {
  player.current = null;
  player._resumeAt = null;
  player._resumeRate = null;
  player._restoreFn = null;
  player._guard = guard.initialState();
  Object.assign(a, { currentTime: 0, playbackRate: 1, paused: true, ended: false, error: null, src: '', currentSrc: '', plays: 0, loads: 0 });
  player.load({ ...A });
  a.currentSrc = a.src;
});

test('a reload returns to the same position and speed, then plays', async () => {
  a.currentTime = 754; a.playbackRate = 1.5;
  player._reload(true);
  assert.equal(a.currentTime, 0, 'load() resets the element');
  a.metadataArrived();
  assert.equal(a.currentTime, 754);
  assert.equal(a.playbackRate, 1.5);
  assert.equal(a.paused, false);
});

test('overlapping reloads keep the first position and speed', () => {
  a.currentTime = 754; a.playbackRate = 1.5;
  player._reload(true);
  player._reload(true);          // element now reads 0 and 1×: those must not be what gets restored
  a.metadataArrived();
  assert.equal(a.currentTime, 754);
  assert.equal(a.playbackRate, 1.5);
});

test('only the last overlapping reload restores', () => {
  a.currentTime = 100;
  player._reload(true);
  player._reload(true);
  let restores = 0;
  const seen = Object.getOwnPropertyDescriptor(a, 'currentTime');
  Object.defineProperty(a, 'currentTime', { configurable: true, get: () => 100, set: () => { restores++; } });
  a.metadataArrived();
  Object.defineProperty(a, 'currentTime', seen);
  assert.equal(restores, 1);
});

test('a track change during a reload does not carry the old position across', () => {
  a.currentTime = 754; a.playbackRate = 1.5;
  player._reload(true);
  player.load({ ...B });
  a.metadataArrived();
  assert.equal(a.currentTime, 0);
  assert.equal(player._resumeAt, null);
});

test('a user seek during a reload beats the restore', () => {
  a.currentTime = 754;
  player._reload(false);
  player.seek(30);
  a.metadataArrived();
  assert.equal(a.currentTime, 30);
});

test('a speed change during a reload beats the restore', () => {
  a.playbackRate = 1.5;
  player._reload(false);
  player.rate(2);
  a.metadataArrived();
  assert.equal(a.playbackRate, 2);
});

test('▶ after a media error resumes where it stopped, not at 0:00', () => {
  a.currentTime = 1200; a.error = { code: 2 };
  player.play();
  assert.equal(a.loads, 1);
  a.metadataArrived();
  assert.equal(a.currentTime, 1200);
  assert.equal(a.paused, false);
});

test('a position saved for a reload does not leak into the next reload', () => {
  a.currentTime = 754;
  player._reload(false);
  a.metadataArrived();
  a.currentTime = 800;
  player._reload(false);
  a.metadataArrived();
  assert.equal(a.currentTime, 800);
});

test('▶ after a long pause does not look like a stall', () => {
  const t0 = Date.now();
  guard.noteTime(player._guard, 10, t0 - 600_000);        // last progress ten minutes ago
  a.currentTime = 10; a.readyState = 4; a.currentSrc = a.src;
  player.play();
  assert.equal(guard.decide(player._guard, player._snap(), Date.now()), 'ok');
  assert.equal(a.loads, 0, 'no reload for a healthy resume');
});

test('a pipeline flapping waiting↔playing with a frozen clock is still a stall', () => {
  const t0 = Date.now();
  a.paused = false; a.currentTime = 10; a.readyState = 4;
  guard.noteTime(player._guard, 10, t0 - 60_000);
  a.fire('waiting');
  a.fire('playing');
  assert.equal(guard.decide(player._guard, player._snap(), Date.now()), 'stalled');
});
