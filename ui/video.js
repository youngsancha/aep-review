// YouTube IFrame Player adapter — exposes the exact same surface as player.js
// (play/pause/toggle/seek/rate/skip/on, getters paused/time/duration) so the transcript sync engine
// in ui/views/episode.js (highlight/auto-follow/tap-to-seek/shadow-repeat/word popover) can drive off
// this instead of the shared <audio> element without any changes to that code — see the DriverRouter
// comment at the top of episode.js for how the swap works.
//
// Only relevant to White House briefing episodes that carry a transcript.video_id (Part A: captured by
// ingest/wh_fetch.py::extract_audio() at ingest time, backfilled for older episodes by
// scripts/wh_backfill_video_ids.py). The measured fact this whole feature rests on: the transcript
// timeline maps 1:1 onto the YouTube timeline (same R2 audio bytes were extracted from that exact
// video and STT'd), so no offset/realignment is needed once this adapter's `time` matches player.time.
//
// 두 가지 설계 포인트:
//  1. YouTube IFrame API 는 `timeupdate` 이벤트가 없다 — getCurrentTime() 을 오디오 경로와 같은
//     ~4Hz 로 폴링해 같은 이벤트 모양('timeupdate', 리스너에 (ev, adapter) 로 전달)을 합성한다.
//     폴링은 재생 중(YT.PlayerState.PLAYING)에만 돌고 일시정지/버퍼링/미마운트 시 즉시 멈춘다
//     (v1.38.0 성능 작업이 의도적으로 막은 상시 4Hz/60fps 스핀을 다시 들이지 않는다).
//  2. 실제 iframe 생성(`<script src="https://www.youtube.com/iframe_api">` 주입 + `new YT.Player(...)`)
//     은 mount()/loadApi() 에 격리돼 있다 — tests/video_adapter.test.mjs 는 네트워크 없이 attach()로
//     가짜 YT.Player 모양의 스텁(playVideo/pauseVideo/seekTo/getCurrentTime/getDuration/
//     setPlaybackRate/destroy)을 주입해 틱 합성·seek·rate·재생상태·teardown 만 검증한다.

const POLL_MS = 250;   // ~4Hz — ui/player.js 의 <audio> timeupdate 체감 주기와 동일하게 맞춘다

// YT.PlayerState 상수(문서화): -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
// 전역 `YT` 심볼을 직접 쓰지 않고(no-undef 회피 + 테스트 격리) 항상 숫자로 비교한다.
const STATE_ENDED = 0;
const STATE_PLAYING = 1;
const STATE_PAUSED = 2;
const STATE_BUFFERING = 3;

function safeCall(fn, fallback) {
  try { const v = fn(); return v == null ? fallback : v; } catch (e) { return fallback; }
}

export class VideoAdapter {
  constructor(opts = {}) {
    this.yt = null;                     // 실제(or 테스트가 주입한 가짜) YT.Player 인스턴스
    this.listeners = new Set();
    this._pollMs = opts.pollMs || POLL_MS;
    this._pollId = 0;
    this._lastTime = 0;
    this._duration = 0;
    this._paused = true;
  }

  // === 재생 표면 — player.js 와 완전히 동일 ===============================================
  play()   { if (this.yt) safeCall(() => this.yt.playVideo()); }
  pause()  { if (this.yt) safeCall(() => this.yt.pauseVideo()); }
  toggle() { this.paused ? this.play() : this.pause(); }
  seek(t) {
    if (!this.yt || !Number.isFinite(t)) return;
    safeCall(() => this.yt.seekTo(t, true));
    this._lastTime = t;
    this._emit('timeupdate');   // 오디오의 <audio>.currentTime=t 와 동일하게 seek 즉시 한 틱 반영
  }
  rate(r) { if (this.yt) safeCall(() => this.yt.setPlaybackRate(r)); }
  skip(d) { this.seek(Math.max(0, this.time + d)); }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(ev) {
    for (const fn of this.listeners) {
      try { fn(ev, this); } catch (err) { console.error('[video] listener failed:', err); }
    }
  }

  get paused()   { return this._paused; }
  get time()     { return this._lastTime || 0; }
  get duration() { return this._duration || (this.yt ? safeCall(() => this.yt.getDuration(), 0) : 0); }

  // === 내부 배선 — mount() 가 real YT.Player 로, 테스트는 이 두 메서드를 직접 호출 =============
  attach(yt) {
    this.yt = yt;
    this._duration = safeCall(() => yt.getDuration(), 0);
    this._lastTime = safeCall(() => yt.getCurrentTime(), 0);
    this._emit('meta');
  }
  handleState(state) {
    if (state === STATE_PLAYING) {
      this._paused = false;
      this._startTick();
      this._emit('play');
    } else if (state === STATE_PAUSED) {
      this._paused = true;
      this._stopTick();
      this._emit('pause');
    } else if (state === STATE_ENDED) {
      this._paused = true;
      this._stopTick();
      this._emit('ended');
    } else if (state === STATE_BUFFERING) {
      // 버퍼링 중엔 getCurrentTime() 값을 믿을 수 없어 틱만 멈춘다(재생/일시정지 상태 자체는 안 바꿈).
      this._stopTick();
    }
  }
  tick() {
    if (!this.yt) return;
    const t = safeCall(() => this.yt.getCurrentTime(), null);
    if (Number.isFinite(t)) this._lastTime = t;
    this._emit('timeupdate');
  }
  get polling() { return !!this._pollId; }
  _startTick() {
    if (this._pollId) return;
    this._pollId = setInterval(() => this.tick(), this._pollMs);
  }
  _stopTick() {
    if (!this._pollId) return;
    clearInterval(this._pollId);
    this._pollId = 0;
  }

  // === 마운트/언마운트 — episode.js 의 📺 토글이 호출. player 표면엔 없는 추가 메서드
  // (player.js 는 <audio> 가 이미 DOM 에 있어 mount 개념이 필요 없다). ===========================
  async mount(container, videoId) {
    if (!container || !videoId) throw new Error('video mount: container/videoId 필요');
    await loadApi();
    return new Promise((resolve, reject) => {
      try {
        const el = document.createElement('div');
        container.appendChild(el);
        // window.YT 는 loadApi() 가 보장(전역 YT 자체는 eslint.config.js 에 일부러 선언 안 함).
        const yt = new window.YT.Player(el, {
          videoId,
          playerVars: { rel: 0, playsinline: 1 },
          events: {
            onReady: () => { this.attach(yt); resolve(this); },
            onStateChange: (e) => this.handleState(e.data),
            onError: () => { this._emit('error'); reject(new Error('YT player error')); },
          },
        });
      } catch (err) { reject(err); }
    });
  }
  unmount() {
    this._stopTick();
    if (this.yt) { safeCall(() => this.yt.destroy()); }
    this.yt = null;
    this._paused = true;
    this._lastTime = 0;
    this._duration = 0;
    // 컨테이너 DOM 은 episode.js 가 시트와 함께 지운다(여기서 건드리지 않음) — mount() 가 만든
    // 내부 <div> 는 destroy() 가 제거를 시도하지만 실패해도(테스트 스텁 등) 무해.
  }
}

// 앱 전역에서 하나만 필요 — player.js 와 같은 싱글턴 패턴(episode.js 가 회차마다 mount/unmount).
export const video = new VideoAdapter();

// === YouTube IFrame API 지연 로드 =============================================================
// 절대 부팅 시점에 로드하지 않는다 — 사용자가 📺 를 처음 켤 때만 <script> 를 주입한다(오프라인
// 앱·비-wh 회차 사용자는 이 스크립트를 영원히 안 받는다).
let _apiPromise = null;
function loadApi() {
  if (typeof window !== 'undefined' && window.YT && window.YT.Player) return Promise.resolve();
  if (_apiPromise) return _apiPromise;
  _apiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) { try { prev(); } catch (e) {} } resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  });
  return _apiPromise;
}
