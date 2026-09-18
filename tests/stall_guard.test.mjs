import test from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../ui/stall-guard.js';

const snap = (o = {}) => ({ paused: false, ended: false, currentTime: 100, error: null, ready: 4, net: 1, ...o });

test('advancing playback is never a stall', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 1000);
  g.noteTime(st, 100.3, 1300);
  assert.equal(g.decide(st, snap({ currentTime: 100.3 }), 1300 + g.STALL_MS - 1), 'ok');
});

test('initial load that never advanced is NOT a stall, however long (v1.75.1 regression)', () => {
  const st = g.initialState();
  g.noteWaiting(st, 1000);                       // 로딩 중 waiting 만 본 상태
  assert.equal(g.decide(st, snap({ ready: 0, net: 2 }), 1000 + 10 * g.STALL_MS), 'ok');
  assert.equal(g.shouldReloadBeforePlay(st, snap({ paused: true, ready: 0, net: 2 }), 1000 + 10 * g.STALL_MS), false);
});

test('frozen currentTime mid-playback becomes a stall after STALL_MS', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 1000);
  assert.equal(g.decide(st, snap(), 1000 + g.STALL_MS - 1), 'ok');
  assert.equal(g.decide(st, snap(), 1000 + g.STALL_MS + 1), 'stalled');
});

test('while the element reports it is still loading, the threshold is the longer one', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 1000);
  const loading = snap({ ready: 2, net: 2 });
  assert.equal(g.decide(st, loading, 1000 + g.STALL_MS + 1), 'ok');
  assert.equal(g.decide(st, loading, 1000 + g.LOADING_STALL_MS + 1), 'stalled');
});

test('paused or ended is never a stall; a media error is', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 1000);
  assert.equal(g.decide(st, snap({ paused: true }), 10 * g.STALL_MS), 'ok');
  assert.equal(g.decide(st, snap({ ended: true }), 10 * g.STALL_MS), 'ok');
  assert.equal(g.decide(st, snap({ error: { code: 2 } }), 1001), 'stalled');
});

test('after a recovery: quiet until the grace passes, then one more try; capped, then give up', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 1000);
  let now = 1000 + g.STALL_MS + 1;
  assert.equal(g.decide(st, snap(), now), 'stalled');
  g.noteRecovery(st, now);
  assert.equal(g.decide(st, snap({ ready: 0, net: 2 }), now + g.RELOAD_GRACE_MS - 1), 'ok');     // 재로드 중
  assert.equal(g.decide(st, snap({ ready: 0, net: 2 }), now + g.RELOAD_GRACE_MS + 1), 'stalled'); // 유예 만료
  for (let i = 1; i < g.MAX_RECOVER; i++) { now += g.RELOAD_GRACE_MS + 1; g.noteRecovery(st, now); }
  now += g.RELOAD_GRACE_MS + 1;
  assert.equal(g.decide(st, snap(), now), 'give-up');
  assert.equal(g.decide(st, snap(), now + g.RECOVER_WINDOW_MS + 1), 'stalled');   // 창이 지나면 다시
});

test('a real advance after recovery re-arms normal stall detection', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 1000);
  g.noteRecovery(st, 20_000);
  g.noteTime(st, 100.5, 21_000);
  assert.equal(g.decide(st, snap({ currentTime: 100.5 }), 21_000 + g.STALL_MS + 1), 'stalled');
});

test('reload-before-play only after it had played, then waited long, or on error', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 1000);
  assert.equal(g.shouldReloadBeforePlay(st, snap({ paused: true }), 60_000), false);
  g.noteWaiting(st, 2000);
  assert.equal(g.shouldReloadBeforePlay(st, snap({ paused: true }), 2000 + g.STALL_MS - 1), false);
  assert.equal(g.shouldReloadBeforePlay(st, snap({ paused: true }), 2000 + g.STALL_MS), true);
  g.noteTime(st, 101, 3000);   // 진행이 있으면 waiting 은 지워진다
  assert.equal(g.shouldReloadBeforePlay(st, snap({ paused: true }), 60_000), false);
  assert.equal(g.shouldReloadBeforePlay(st, snap({ error: { code: 3 } }), 0), true);
});

test('track change resets everything', () => {
  const st = g.initialState();
  g.noteTime(st, 100, 1000); g.noteWaiting(st, 1005); g.noteRecovery(st, 1006);
  g.noteTrackChange(st);
  assert.deepEqual(st, g.initialState());
});
