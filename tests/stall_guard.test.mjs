import test from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../ui/stall-guard.js';

const snap = (o = {}) => ({ paused: false, ended: false, currentTime: 100, error: null, ...o });

test('advancing playback is never a stall', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 0);
  g.noteTime(st, 100.3, 300);
  assert.equal(g.decide(st, snap({ currentTime: 100.3 }), 300 + g.STALL_MS - 1), 'ok');   // 마지막 진행 기준
  g.noteTime(st, 101, 1000);
  assert.equal(g.decide(st, snap({ currentTime: 101 }), 1000 + g.STALL_MS - 1), 'ok');
});

test('frozen currentTime while not paused becomes a stall after STALL_MS', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 0);
  assert.equal(g.decide(st, snap(), g.STALL_MS - 1), 'ok');
  assert.equal(g.decide(st, snap(), g.STALL_MS + 1), 'stalled');
});

test('paused or ended is never a stall; a media error is', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 0);
  assert.equal(g.decide(st, snap({ paused: true }), 10 * g.STALL_MS), 'ok');
  assert.equal(g.decide(st, snap({ ended: true }), 10 * g.STALL_MS), 'ok');
  assert.equal(g.decide(st, snap({ error: { code: 2 } }), 1), 'stalled');
});

test('recoveries are capped inside the window, then it gives up', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 0);
  let now = 0;
  for (let i = 0; i < g.MAX_RECOVER; i++) {
    now += g.STALL_MS + 1;
    assert.equal(g.decide(st, snap(), now), 'stalled', `recovery #${i + 1}`);
    g.noteRecovery(st, now);
  }
  now += g.STALL_MS + 1;
  assert.equal(g.decide(st, snap(), now), 'give-up');
  // 창이 지나면 다시 시도한다(다음 회차/한참 뒤의 새 정체).
  assert.equal(g.decide(st, snap(), now + g.RECOVER_WINDOW_MS + 1), 'stalled');
});

test('a recovery restarts the stall timer', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 0);
  g.noteRecovery(st, 20_000);
  assert.equal(g.decide(st, snap(), 20_000 + g.STALL_MS - 1), 'ok');
});

test('reload-before-play only after a long waiting or an error', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 0);
  assert.equal(g.shouldReloadBeforePlay(st, snap({ paused: true }), 60_000), false);
  g.noteWaiting(st, 1000);
  assert.equal(g.shouldReloadBeforePlay(st, snap({ paused: true }), 1000 + g.STALL_MS - 1), false);
  assert.equal(g.shouldReloadBeforePlay(st, snap({ paused: true }), 1000 + g.STALL_MS), true);
  g.noteTime(st, 101, 2000);   // 진행이 있으면 waiting 은 지워진다
  assert.equal(g.shouldReloadBeforePlay(st, snap({ paused: true }), 60_000), false);
  assert.equal(g.shouldReloadBeforePlay(st, snap({ error: { code: 3 } }), 0), true);
});

test('track change resets everything', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 0); g.noteWaiting(st, 5); g.noteRecovery(st, 6);
  g.noteTrackChange(st);
  assert.deepEqual(st, g.initialState());
});
