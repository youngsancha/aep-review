// A service worker update must never reload the page out from under someone listening with the screen off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateReloader, PAUSE_GRACE_MS, AFTER_ENDED_MS } from '../ui/sw-reload.js';

function setup({ hidden = true, fresh = false, playing = false } = {}) {
  const t = { now: 1000, queue: [], reloads: 0, hidden, fresh, audio: { paused: !playing, ended: false } };
  const timers = {
    setTimeout: (fn, ms) => { const job = { fn, at: t.now + ms }; t.queue.push(job); return job; },
    clearTimeout: (job) => { t.queue = t.queue.filter((j) => j !== job); },
  };
  t.advance = (ms) => {
    t.now += ms;
    for (const job of t.queue.filter((j) => j.at <= t.now)) {
      t.queue = t.queue.filter((j) => j !== job);
      job.fn();
    }
  };
  t.r = createUpdateReloader({
    audio: () => t.audio, isHidden: () => t.hidden, isFresh: () => t.fresh,
    reload: () => { t.reloads++; }, now: () => t.now, timers,
  });
  return t;
}
const pause = (t) => { t.audio.paused = true; t.r.onPause(); };
const play = (t) => { t.audio.paused = false; t.r.onPlay(); };

test('nothing playing, screen off: reloads at once', () => {
  const t = setup();
  t.r.onControllerChange();
  assert.equal(t.reloads, 1);
});

test('a page in use on screen waits until it is hidden', () => {
  const t = setup({ hidden: false });
  t.r.onControllerChange();
  assert.equal(t.reloads, 0);
  t.hidden = true;
  t.r.onHidden();
  assert.equal(t.reloads, 1);
});

test('just after a pull-to-refresh it reloads even on screen', () => {
  const t = setup({ hidden: false, fresh: true });
  t.r.onControllerChange();
  assert.equal(t.reloads, 1);
});

test('playing with the screen off never reloads', () => {
  const t = setup({ playing: true });
  t.r.onControllerChange();
  t.r.onHidden();
  t.advance(60 * 60_000);
  assert.equal(t.reloads, 0);
});

test('a phone call: the pause does not reload, and playback resumes in the same page', () => {
  const t = setup({ playing: true });
  t.r.onControllerChange();
  pause(t);
  t.advance(3 * 60_000);
  assert.equal(t.reloads, 0);
  play(t);
  t.advance(PAUSE_GRACE_MS * 2);
  assert.equal(t.reloads, 0, 'the timer from the pause must not fire after playback resumed');
});

test('the app going to the background for that call does not reload either', () => {
  const t = setup({ hidden: false, playing: true });
  t.r.onControllerChange();
  pause(t);
  t.hidden = true;
  t.r.onHidden();
  assert.equal(t.reloads, 0);
});

test('a long pause with the screen off finally applies the update', () => {
  const t = setup({ playing: true });
  t.r.onControllerChange();
  pause(t);
  t.advance(PAUSE_GRACE_MS);
  assert.equal(t.reloads, 1);
});

test('an update arriving during a short pause waits out the rest of that pause', () => {
  const t = setup({ playing: true });
  pause(t);
  t.advance(60_000);
  t.r.onControllerChange();
  assert.equal(t.reloads, 0);
  t.advance(PAUSE_GRACE_MS - 60_000);
  assert.equal(t.reloads, 1);
});

test('a second pause restarts the wait', () => {
  const t = setup({ playing: true });
  t.r.onControllerChange();
  pause(t);
  t.advance(PAUSE_GRACE_MS - 1000);
  play(t);
  pause(t);
  t.advance(2000);
  assert.equal(t.reloads, 0);
});

test('the episode ending applies the update soon after, unless the next one started', () => {
  const t = setup({ playing: true });
  t.r.onControllerChange();
  t.audio.paused = true; t.audio.ended = true;
  t.r.onEnded();
  t.advance(AFTER_ENDED_MS);
  assert.equal(t.reloads, 1);

  const next = setup({ playing: true });
  next.r.onControllerChange();
  next.r.onEnded();
  next.advance(AFTER_ENDED_MS);            // autoplay already started the next episode
  assert.equal(next.reloads, 0);
});

test('reloads at most once', () => {
  const t = setup();
  t.r.onControllerChange();
  t.r.onControllerChange();
  t.r.onHidden();
  assert.equal(t.reloads, 1);
});

test('with no audio element yet the page is simply idle', () => {
  const reloads = [];
  const r = createUpdateReloader({ audio: () => undefined, isHidden: () => true, isFresh: () => false,
    reload: () => reloads.push(1) });
  r.onControllerChange();
  assert.equal(reloads.length, 1);
});
