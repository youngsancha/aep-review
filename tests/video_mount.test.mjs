// VideoAdapter.mount(): the promise episode.js waits on while its video toggle is locked and the audio is
// paused. If it never settled, the toggle stayed dead and the sound stayed off, so every way out is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VideoAdapter } from '../ui/video.js';

function stage(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const players = [];
  class Player {
    constructor(el, opts) { this.opts = opts; this.destroyed = false; players.push(this); }
    destroy() { this.destroyed = true; }
    getCurrentTime() { return 0; }
    getDuration() { return 100; }
  }
  globalThis.window = { YT: { Player } };
  globalThis.document = { createElement: () => ({}) };
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  return { players, container: { appendChild() {} }, video: new VideoAdapter() };
}
// mount() awaits loadApi() before it arms anything.
const armed = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('onReady resolves the mount and attaches the player', async (t) => {
  const { players, container, video } = stage(t);
  const p = video.mount(container, 'abc');
  await armed();
  players[0].opts.events.onReady();
  assert.equal(await p, video);
  assert.equal(video.yt, players[0]);
});

test('no onReady within the limit rejects, so the toggle comes back', async (t) => {
  const { container, video } = stage(t);
  const p = video.mount(container, 'abc');
  await armed();
  t.mock.timers.tick(10000);
  await assert.rejects(p, /timed out/);
});

test('an onReady after the timeout is ignored', async (t) => {
  const { players, container, video } = stage(t);
  const p = video.mount(container, 'abc');
  await armed();
  t.mock.timers.tick(10000);
  await assert.rejects(p);
  players[0].opts.events.onReady();
  assert.ok(!video.yt);
});

test('leaving the screen during a mount rejects it at once', async (t) => {
  const { container, video } = stage(t);
  const p = video.mount(container, 'abc');
  await armed();
  video.unmount();
  await assert.rejects(p, /aborted/);
});

test('a player error rejects the mount and tells listeners', async (t) => {
  const { players, container, video } = stage(t);
  const events = [];
  video.on((ev) => events.push(ev));
  const p = video.mount(container, 'abc');
  await armed();
  players[0].opts.events.onError();
  await assert.rejects(p, /YT player error/);
  assert.ok(events.includes('error'));
});

test('the timer is cleared on success, so a good mount never rejects later', async (t) => {
  const { players, container, video } = stage(t);
  const p = video.mount(container, 'abc');
  await armed();
  players[0].opts.events.onReady();
  await p;
  t.mock.timers.tick(60000);
  assert.equal(video.yt, players[0]);
});

test('unmount with nothing mounting is a no-op', (t) => {
  const { video } = stage(t);
  video.unmount();
  assert.ok(!video.yt);
});
