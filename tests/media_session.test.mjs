// Media Session 연동 단위검증 (node --test) — A1.
// ui/media-session.js 는 DOM/navigator 를 top-level 에서 안 만져 node 에서 직접 import 가능.
// 실제 차량/블루투스 동작은 자동화 불가(수동 체크리스트는 NOTES). 여기선 "표준 액션이 player
// 메서드에 올바로 매핑되는가 + 메타/위치/상태가 배선되는가"를 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mediaSessionActions, buildMetadata, updatePositionState, bindMediaSession,
  DEFAULT_BACK, DEFAULT_FWD,
} from '../ui/media-session.js';

// 호출을 기록하는 player 스텁(인앱 player 의 표면만 흉내).
function fakePlayer(over = {}) {
  const calls = [];
  const listeners = [];
  const p = {
    calls,
    current: over.current ?? null,
    time: over.time ?? 0,
    duration: over.duration ?? 0,
    audio: over.audio ?? { playbackRate: 1 },
    play: () => calls.push(['play']),
    pause: () => calls.push(['pause']),
    skip: (d) => calls.push(['skip', d]),
    seek: (t) => calls.push(['seek', t]),
    on: (fn) => { listeners.push(fn); return () => {}; },
    _emit: (ev) => listeners.forEach((fn) => fn(ev, p)),
  };
  return p;
}

test('actions: play/pause → player.play/pause', () => {
  const p = fakePlayer();
  const a = mediaSessionActions(p);
  a.play(); a.pause();
  assert.deepEqual(p.calls, [['play'], ['pause']]);
});

test('actions: seekforward/backward 기본값 = 앱 버튼(fwd 30 / back 15)', () => {
  const p = fakePlayer();
  const a = mediaSessionActions(p);
  a.seekforward({}); a.seekbackward({});
  assert.deepEqual(p.calls, [['skip', DEFAULT_FWD], ['skip', -DEFAULT_BACK]]);
  assert.equal(DEFAULT_FWD, 30);
  assert.equal(DEFAULT_BACK, 15);
});

test('actions: seekOffset 주어지면 그 값 사용', () => {
  const p = fakePlayer();
  const a = mediaSessionActions(p);
  a.seekforward({ seekOffset: 10 }); a.seekbackward({ seekOffset: 5 });
  assert.deepEqual(p.calls, [['skip', 10], ['skip', -5]]);
});

test('actions: 핸들 next/prev track → 빨리감기/되감기로 매핑', () => {
  const p = fakePlayer();
  const a = mediaSessionActions(p, { back: 15, fwd: 30 });
  a.nexttrack(); a.previoustrack();
  assert.deepEqual(p.calls, [['skip', 30], ['skip', -15]]);
});

test('actions: seekto 는 유효 seekTime 만 seek(차량 진행바)', () => {
  const p = fakePlayer();
  const a = mediaSessionActions(p);
  a.seekto({ seekTime: 42.5 });
  a.seekto({});                 // seekTime 없음 → 무시
  a.seekto({ seekTime: NaN });  // 무효 → 무시
  assert.deepEqual(p.calls, [['seek', 42.5]]);
});

test('buildMetadata: 제목/쇼/아트워크 매핑', () => {
  let captured = null;
  class MM { constructor(o) { captured = o; Object.assign(this, o); } }
  const m = buildMetadata({ title: 'Ep 100', show: 'AEP', cover: 'http://x/c.jpg' }, MM);
  assert.ok(m instanceof MM);
  assert.equal(captured.title, 'Ep 100');
  assert.equal(captured.artist, 'AEP');
  assert.equal(captured.artwork.length, 1);
  assert.equal(captured.artwork[0].src, 'http://x/c.jpg');
});

test('buildMetadata: cover 없으면 artwork 빈 배열, ctor 없으면 null', () => {
  class MM { constructor(o) { Object.assign(this, o); } }
  assert.deepEqual(buildMetadata({ title: 'x' }, MM).artwork, []);
  assert.equal(buildMetadata({ title: 'x' }, null), null);
  assert.equal(buildMetadata(null, MM), null);
});

test('updatePositionState: duration 유효할 때만 setPositionState(아니면 호출 안 함)', () => {
  const calls = [];
  const ms = { setPositionState: (s) => calls.push(s) };
  updatePositionState(ms, fakePlayer({ duration: 0 }));   // 무효
  updatePositionState(ms, fakePlayer({ duration: NaN }));  // 무효
  assert.equal(calls.length, 0);
  updatePositionState(ms, fakePlayer({ duration: 100, time: 30, audio: { playbackRate: 1.5 } }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { duration: 100, playbackRate: 1.5, position: 30 });
});

test('updatePositionState: position 은 [0,duration] 으로 클램프', () => {
  const calls = [];
  const ms = { setPositionState: (s) => calls.push(s) };
  updatePositionState(ms, fakePlayer({ duration: 100, time: 999 }));
  assert.equal(calls[0].position, 100);  // 초과분 클램프
});

test('bindMediaSession: 미지원 환경이면 no-op(false)', () => {
  assert.equal(bindMediaSession(fakePlayer(), { navigator: {} }), false);
  assert.equal(bindMediaSession(fakePlayer(), { navigator: { mediaSession: {} } }), false); // setActionHandler 없음
});

test('bindMediaSession: 지원 환경 → 핸들러 등록 + track/play 이벤트로 메타·상태 갱신', () => {
  const handlers = {};
  const ms = {
    metadata: undefined,
    playbackState: 'none',
    setActionHandler: (n, h) => { handlers[n] = h; },
    setPositionState: () => {},
  };
  class MM { constructor(o) { Object.assign(this, o); } }
  const p = fakePlayer({ current: { title: 'Ep 1', show: 'AEP', cover: 'c.jpg' }, duration: 50 });
  const ok = bindMediaSession(p, { navigator: { mediaSession: ms }, MediaMetadata: MM });
  assert.equal(ok, true);
  // 표준 액션 6종 등록 확인
  for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'nexttrack', 'previoustrack']) {
    assert.equal(typeof handlers[a], 'function', `missing handler: ${a}`);
  }
  // 초기 메타데이터 즉시 반영
  assert.equal(ms.metadata.title, 'Ep 1');
  // play/pause 이벤트 → playbackState
  p._emit('play');  assert.equal(ms.playbackState, 'playing');
  p._emit('pause'); assert.equal(ms.playbackState, 'paused');
  // 핸들러가 실제 player 를 움직이는지(왕복 검증)
  handlers.play();
  assert.deepEqual(p.calls.at(-1), ['play']);
});
