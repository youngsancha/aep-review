// When a new service worker takes over, the page should reload to pick up the new shell, but never in
// the middle of listening. A reload stops the audio and nothing brings it back: this app is mostly heard
// with the screen off, so "the page is hidden" says nothing about whether someone is using it.
//
// A short pause is still listening. A phone call or a Bluetooth reconnect pauses the element from the
// outside, and reloading in that gap means AirPods ▶ finds a page with nothing loaded. So the page counts
// as busy while it plays and for a while after it pauses. Pure logic: app.js passes in what it touches.
export const PAUSE_GRACE_MS = 5 * 60_000;
export const AFTER_ENDED_MS = 3000;

export function createUpdateReloader({ audio, isHidden, isFresh, reload, now = Date.now, timers = globalThis }) {
  let reloaded = false, pending = false, pausedAt = null, timer = null;

  const playing = () => { const a = audio(); return !!a && !a.paused && !a.ended; };
  const inPauseGrace = () => pausedAt !== null && now() - pausedAt < PAUSE_GRACE_MS;
  const later = (ms) => {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => { if (pending && isHidden()) apply(); }, ms);
  };
  function apply() {
    if (reloaded) return;
    if (playing() || inPauseGrace()) {
      pending = true;
      if (inPauseGrace()) later(PAUSE_GRACE_MS - (now() - pausedAt));
      return;
    }
    reloaded = true;
    reload();
  }

  return {
    onControllerChange() { if (isHidden() || isFresh()) apply(); else pending = true; },
    onHidden() { if (pending) apply(); },
    onPlay() { pausedAt = null; timers.clearTimeout(timer); },
    onPause() { pausedAt = now(); if (pending) later(PAUSE_GRACE_MS); },
    onEnded() { pausedAt = null; if (pending) later(AFTER_ENDED_MS); },
  };
}
