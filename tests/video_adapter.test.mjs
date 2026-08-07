// ui/video.js(VideoAdapter) 단위검증 (node --test) — 네트워크·실제 YouTube iframe 없이, 가짜
// YT.Player 모양의 스텁을 attach()/handleState() 로 직접 주입해 로직만 고정한다.
// mount()/loadApi()(<script src="https://www.youtube.com/iframe_api"> 주입 + new YT.Player(...))는
// 브라우저·네트워크가 있어야 해서 여기선 안 건드린다 — 그 경로는 scripts/_pwtest.py 가 '토글 노출
// 여부'만 DOM 으로 커버한다(실제 iframe 은 하니스에서도 안 띄움, 과제 요구사항).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VideoAdapter } from '../ui/video.js';

// 실제 YT.Player 표면(playVideo/pauseVideo/seekTo/getCurrentTime/getDuration/setPlaybackRate/destroy)
// 만 흉내낸 스텁. 호출을 기록해 어댑터가 올바른 메서드를 올바른 인자로 호출하는지도 검증한다.
function fakeYt(overrides = {}) {
  const calls = [];
  return {
    calls,
    _t: overrides.t ?? 0,
    _dur: overrides.dur ?? 1274,
    playVideo() { calls.push(['playVideo']); },
    pauseVideo() { calls.push(['pauseVideo']); },
    seekTo(t, allowSeekAhead) { calls.push(['seekTo', t, allowSeekAhead]); this._t = t; },
    getCurrentTime() { return this._t; },
    getDuration() { return this._dur; },
    setPlaybackRate(r) { calls.push(['setPlaybackRate', r]); },
    destroy() { calls.push(['destroy']); },
  };
}

function withEvents(adapter) {
  const events = [];
  adapter.on((ev) => events.push(ev));
  return events;
}

test('attach(): duration/time 초기화 + meta 이벤트 발행', () => {
  const a = new VideoAdapter();
  const events = withEvents(a);
  const yt = fakeYt({ t: 12, dur: 900 });
  a.attach(yt);
  assert.equal(a.duration, 900);
  assert.equal(a.time, 12);
  assert.deepEqual(events, ['meta']);
});

test('play/pause/toggle → 실제 YT.Player 메서드 호출 + paused 게터 반영', () => {
  const a = new VideoAdapter();
  const yt = fakeYt();
  a.attach(yt);
  assert.equal(a.paused, true);           // attach 직후엔 아직 PLAYING 이벤트 전 → paused 기본값 true

  a.play();
  assert.deepEqual(yt.calls, [['playVideo']]);
  a.handleState(1);                       // YT.PlayerState.PLAYING
  assert.equal(a.paused, false);

  a.pause();
  a.handleState(2);                       // YT.PlayerState.PAUSED
  assert.equal(a.paused, true);
  assert.deepEqual(yt.calls, [['playVideo'], ['pauseVideo']]);

  a.toggle();                             // paused=true → toggle 은 play() 를 호출
  assert.deepEqual(yt.calls.at(-1), ['playVideo']);
});

test('handleState: play/pause/ended 이벤트가 player.js 와 같은 이름으로 발행된다', () => {
  const a = new VideoAdapter();
  a.attach(fakeYt());
  const events = withEvents(a);
  a.handleState(1);   // playing
  a.handleState(2);   // paused
  a.handleState(0);   // ended
  assert.deepEqual(events, ['play', 'pause', 'ended']);
});

test('seek(): yt.seekTo 호출 + time 즉시 갱신 + timeupdate 한 틱 발행(오디오의 currentTime= 대입과 동일 계약)', () => {
  const a = new VideoAdapter();
  const yt = fakeYt();
  a.attach(yt);
  const events = withEvents(a);
  a.seek(42.5);
  assert.deepEqual(yt.calls, [['seekTo', 42.5, true]]);
  assert.equal(a.time, 42.5);
  assert.deepEqual(events, ['timeupdate']);
});

test('skip(): 현재 시각 + delta 로 seek, 음수로 내려가지 않게 0 에서 클램프', () => {
  const a = new VideoAdapter();
  const yt = fakeYt({ t: 10 });
  a.attach(yt);
  a.skip(5);
  assert.equal(yt.calls.at(-1)[1], 15);
  a.skip(-100);
  assert.equal(yt.calls.at(-1)[1], 0);   // 10+5-100 = -85 → 0 으로 클램프
});

test('rate(): yt.setPlaybackRate 로 위임', () => {
  const a = new VideoAdapter();
  const yt = fakeYt();
  a.attach(yt);
  a.rate(1.5);
  assert.deepEqual(yt.calls, [['setPlaybackRate', 1.5]]);
});

test('틱 합성: tick() 이 getCurrentTime() 을 읽어 time 을 갱신하고 timeupdate 를 발행한다', () => {
  const a = new VideoAdapter();
  const yt = fakeYt({ t: 3 });
  a.attach(yt);
  const events = withEvents(a);
  yt._t = 3.25;              // YouTube 쪽 시각이 흘렀다고 가정(실제로는 폴링 인터벌이 이 값을 읽음)
  a.tick();
  assert.equal(a.time, 3.25);
  assert.deepEqual(events, ['timeupdate']);
});

test('틱 게이팅: PLAYING 에서만 폴링이 돌고, PAUSED/ENDED/unmount 에서 즉시 멈춘다(상시 스핀 금지)', () => {
  const a = new VideoAdapter({ pollMs: 5 });
  a.attach(fakeYt());
  assert.equal(a.polling, false);         // attach 직후(아직 재생 시작 전)엔 폴링 없음

  a.handleState(1);                       // playing
  assert.equal(a.polling, true);

  a.handleState(2);                       // paused
  assert.equal(a.polling, false);

  a.handleState(1);                       // 다시 playing
  assert.equal(a.polling, true);
  a.handleState(0);                       // ended
  assert.equal(a.polling, false);
});

test('틱 게이팅: 버퍼링 상태(3)도 폴링을 멈춘다(getCurrentTime 신뢰 불가 구간)', () => {
  const a = new VideoAdapter();
  a.attach(fakeYt());
  a.handleState(1);
  assert.equal(a.polling, true);
  a.handleState(3);   // buffering
  assert.equal(a.polling, false);
});

test('실제 폴링: setInterval 로 tick() 이 주기적으로 돌며 timeupdate 를 여러 번 발행한다', async () => {
  const a = new VideoAdapter({ pollMs: 8 });
  a.attach(fakeYt({ t: 0 }));
  const events = withEvents(a);
  a.handleState(1);   // playing → 폴링 시작
  await new Promise((r) => setTimeout(r, 40));
  a.handleState(2);   // paused → 폴링 정지
  const n1 = events.filter((e) => e === 'timeupdate').length;
  assert.ok(n1 >= 2, `expected several timeupdate ticks, got ${n1}`);
  await new Promise((r) => setTimeout(r, 30));
  const n2 = events.filter((e) => e === 'timeupdate').length;
  assert.equal(n2, n1, 'polling must not continue after pause');
});

test('unmount(): 폴링을 멈추고 yt.destroy() 호출 + paused/time/duration 이 초기 상태로', () => {
  const a = new VideoAdapter();
  const yt = fakeYt({ t: 55, dur: 900 });
  a.attach(yt);
  a.handleState(1);
  assert.equal(a.polling, true);

  a.unmount();
  assert.equal(a.polling, false);
  assert.deepEqual(yt.calls.at(-1), ['destroy']);
  assert.equal(a.paused, true);
  assert.equal(a.time, 0);
  assert.equal(a.duration, 0);
  assert.equal(a.yt, null);

  // unmount 이후 조작은 전부 무해(no-op) — yt 가 없으니 어떤 실제 메서드도 다시 호출되지 않는다.
  const callsBefore = yt.calls.length;
  a.play(); a.pause(); a.seek(10); a.rate(2); a.skip(5); a.tick();
  assert.equal(yt.calls.length, callsBefore);
});

test('on()/off: 구독 해제 후엔 이벤트를 더 받지 않는다', () => {
  const a = new VideoAdapter();
  a.attach(fakeYt());
  const events = [];
  const off = a.on((ev) => events.push(ev));
  a.handleState(1);
  off();
  a.handleState(2);
  assert.deepEqual(events, ['play']);
});

test('리스너 하나가 던져도 나머지 리스너·호출부는 안 죽는다', () => {
  const a = new VideoAdapter();
  a.attach(fakeYt());
  const seen = [];
  a.on(() => { throw new Error('boom'); });
  a.on((ev) => seen.push(ev));
  assert.doesNotThrow(() => a.handleState(1));
  assert.deepEqual(seen, ['play']);
  a.unmount();   // handleState(1) 이 폴링을 시작시켰다 — 테스트 프로세스가 안 걸리게 정리
});
