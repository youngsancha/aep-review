// scrub.js: pointercancel must not seek. stall-guard.js: ▶ after a long pause must not look like a stall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindScrub } from '../ui/scrub.js';
import * as g from '../ui/stall-guard.js';

function fakeTrack() {
  const l = {};
  return {
    l, classList: { add() {}, remove() {} },
    addEventListener: (k, f) => { l[k] = f; }, removeEventListener() {},
    setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, width: 100 }),
  };
}
const ev = (x) => ({ clientX: x, pointerId: 1, preventDefault() {}, stopPropagation() {} });

test('scrub: pointerup seeks, pointercancel does not', () => {
  const t = fakeTrack(); const seeks = []; let cancelled = 0;
  const s = bindScrub(t, { onPreview() {}, onSeek: (f) => seeks.push(f), onCancel: () => cancelled++ });
  t.l.pointerdown(ev(10)); t.l.pointerup(ev(50));
  assert.deepEqual(seeks, [0.5]);
  t.l.pointerdown(ev(10)); t.l.pointercancel(ev(90));
  assert.deepEqual(seeks, [0.5]); assert.equal(cancelled, 1); assert.equal(s.isDragging(), false);
});

test('stall-guard: notePlay resets the clock after a long pause', () => {
  const st = g.initialState();
  g.noteTime(st, 10, 0);                       // 진행 기록 후 장시간 일시정지
  const snap = { paused: false, ended: false, currentTime: 10, error: null, ready: 4, net: 1 };
  assert.equal(g.decide(st, snap, 600_000), 'stalled');   // 시계를 안 되감으면 오판
  g.notePlay(st, 600_000);
  assert.equal(g.decide(st, snap, 605_000), 'ok');
  assert.equal(g.decide(st, snap, 600_000 + g.STALL_MS + 1), 'stalled');   // 진짜 정체는 여전히 잡는다
});

test('stall-guard: notePlay leaves the fresh-load rule alone', () => {
  const st = g.initialState();
  g.notePlay(st, 5);
  assert.equal(st.lastAdvanceAt, null);
});
