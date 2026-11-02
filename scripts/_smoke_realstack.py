"""Real-stack smoke: everything real except the network.

scripts/_pwtest.py swaps /player.js, /db.js and /app.js for mocks so it can drive the episode screen
quickly, which means a green run proves nothing about how those modules behave together. This script
serves the actual ui/ and lets the actual service worker, supabase-js, db.js, player.js and app.js run.
Only the far end of the network is fake, answered by a Playwright route.

It walks the path Roy actually uses, and the failures it has to catch are the ones that shipped:

  1. Library renders from a stored session.
  2. Episode opens, the transcript opens, real audio plays.
  3. Leaving the episode removes its transcript sheet (v1.80.0 threw in cleanup and leaked one per visit).
  4. Offline prefetch downloads the audio.
  5. Network dies, cold reload: the shell, the episode and the transcript come from the service worker
     within seconds, and downloaded audio plays. The spinner this guards against once took 33 seconds.

    .venv/bin/python scripts/_smoke_realstack.py

Exits non-zero on any failed check. One copy at a time: it binds port 8124.
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import time
import wave
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# Without this Chromium's service worker fetches bypass context.route and would reach the real Supabase.
os.environ["PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS"] = "1"

from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PORT = 8124
BASE = f"http://localhost:{PORT}"
# Wall clock, so it needs a machine that is not on fire: raise it rather than read a fail as a regression
# when the load average is high. The check exists to catch the 30-second spinner, not to benchmark.
OFFLINE_BOOT_LIMIT_S = float(os.environ.get("AEP_SMOKE_BOOT_LIMIT", "5"))
AUDIO_SECONDS = 60

SENTENCES = [
    "Hello everyone and welcome back to the show.", "Today we are talking about ordering coffee.",
    "It sounds simple, but there are a few traps.", "First, let's look at how people really say it.",
    "Can I get a small latte, please?", "Notice how the question stays soft.",
    "Next, we'll practice the rhythm of the sentence.", "Try saying it along with me now.",
    "Great job, that was really natural.", "Thanks for listening, and see you next time.",
]


def transcript(ep_id: int) -> dict:
    segments = []
    for i, text in enumerate(SENTENCES):
        start = i * 5.0
        words = [{"start": start + j * 0.4, "end": start + j * 0.4 + 0.35, "word": " " + w}
                 for j, w in enumerate(text.split())]
        segments.append({"start": start, "end": start + 4.8, "text": text, "words": words})
    return {"language": "en", "duration": float(AUDIO_SECONDS), "r2_audio": True, "segments": segments}


def episode_row(ep_id: int) -> dict:
    return {
        "id": ep_id, "show": "aep", "guid": f"smoke-{ep_id}", "title": f"{ep_id} - Ordering coffee",
        "description": "<p>A smoke test episode.</p>", "pub_date": f"2026-10-{ep_id:02d}T00:00:00Z",
        "duration_sec": AUDIO_SECONDS, "audio_url": f"https://traffic.megaphone.fm/{ep_id}.mp3",
        "has_audio": True, "transcribed_at": "2026-10-01T00:00:00Z", "vocab_count": 0,
        "season": 1, "episode_no": ep_id, "vocab": [],
    }


def silent_wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(8000)
        w.writeframes(b"\x80" * (8000 * AUDIO_SECONDS))
    return buf.getvalue()


class FakeNetwork:
    """The far end of every request the app makes. `down` makes every request fail like a dead radio."""

    def __init__(self) -> None:
        self.down = False
        self.ids = [2, 1]
        self.audio = silent_wav()
        self.unexpected: list[str] = []

    def _json(self, route, body, status=200):
        route.fulfill(status=status, content_type="application/json",
                      headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(body))

    def _audio(self, route, request):
        headers = {"Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes", "Content-Type": "audio/wav"}
        rng = request.headers.get("range", "")
        if rng.startswith("bytes="):
            lo, _, hi = rng[6:].partition("-")
            lo = int(lo or 0)
            hi = int(hi) if hi else len(self.audio) - 1
            headers["Content-Range"] = f"bytes {lo}-{hi}/{len(self.audio)}"
            route.fulfill(status=206, headers=headers, body=self.audio[lo:hi + 1])
        else:
            route.fulfill(status=200, headers=headers, body=self.audio)

    def handle(self, route, request):
        if self.down:
            route.abort("internetdisconnected")
            return
        url = urlparse(request.url)
        host = url.hostname or ""
        if host in ("localhost", "127.0.0.1"):
            route.continue_()
        elif host.endswith(".r2.dev"):
            self._audio(route, request)
        elif host.endswith(".supabase.co"):
            self._supabase(route, request, url)
        else:
            route.fulfill(status=200, content_type="image/png", body=b"")   # covers, fonts, translation API

    def _supabase(self, route, request, url):
        path = url.path
        if path.startswith("/storage/v1/object/public/transcripts/"):
            name = path.rsplit("/", 1)[1]
            if name == "audio_hosted.json":
                self._json(route, self.ids)
            elif name.endswith("_ko.json"):
                self._json(route, {})
            else:
                self._json(route, transcript(int(name.removesuffix(".json"))))
        elif path == "/rest/v1/episodes_list":
            self._json(route, [episode_row(i) for i in self.ids])
        elif path == "/rest/v1/episodes":
            ep_id = int(parse_qs(url.query).get("id", ["eq.1"])[0].removeprefix("eq."))
            self._json(route, episode_row(ep_id))
        else:
            self.unexpected.append(f"{request.method} {path}")
            self._json(route, [])


SEED_SESSION = """
(() => {
  const key = 'sb-lbcvuztpyaapyckxmqhk-auth-token';
  if (localStorage.getItem(key)) return;
  const exp = Math.floor(Date.now() / 1000) + 3600 * 24;
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\\+/g, '-').replace(/\\//g, '_');
  localStorage.setItem(key, JSON.stringify({
    access_token: `${b64({ alg: 'HS256' })}.${b64({ sub: 'smoke', exp, role: 'authenticated' })}.sig`,
    refresh_token: 'smoke', token_type: 'bearer', expires_in: 86400, expires_at: exp,
    user: { id: 'smoke', aud: 'authenticated', email: 'smoke@example.com' },
  }));
})();
"""


class Checks:
    def __init__(self) -> None:
        self.failed: list[str] = []

    def __call__(self, name: str, ok, detail="") -> None:
        print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + str(detail) if detail != '' else ''}", flush=True)
        if not ok:
            self.failed.append(name)


def sheets(page) -> int:
    return page.evaluate("document.querySelectorAll('.tx-sheet').length")


def wait_time_advances(page, seconds=15.0) -> float:
    """Current audio position once it has moved, or 0. Real decoding, not a mock's counter.

    Everywhere in run(): page.wait_for_timeout, never time.sleep. The sync API only services route
    handlers while inside a Playwright call, so a sleep freezes the fake network along with the test.
    """
    deadline = time.time() + seconds
    while time.time() < deadline:
        t = page.evaluate("window.__player.time")
        if t > 0.5:
            return t
        page.wait_for_timeout(200)
    return 0.0


def run(page, context, net: FakeNetwork, check: Checks, errors: list[str]) -> None:
    # 1. Library. On a first visit the service worker takes control and app.js reloads the page, so
    # anything done before that settles is lost with the old document.
    page.goto(f"{BASE}/#/", wait_until="domcontentloaded", timeout=90000)
    page.wait_for_function("!!navigator.serviceWorker.controller", timeout=20000)
    page.wait_for_timeout(1500)
    page.wait_for_selector(".ep-row[data-id]", timeout=15000)
    check("library renders from a stored session", page.locator(".ep-row[data-id]").count() == 2)

    # 2. Episode, transcript, audio
    page.locator('.ep-row[data-id="2"]').click()
    page.wait_for_selector("#np-play", timeout=15000)
    check("episode screen opens by tapping a row", page.evaluate("location.hash") == "#/episode/2")
    # The mocks harness never measured this row: at 360 px, the width of most Galaxy phones, flexbox
    # squeezed the only button without a fixed basis and ▶ became an oval.
    for width in (320, 360, 412):
        page.set_viewport_size({"width": width, "height": 804})
        page.wait_for_timeout(250)
        box = page.evaluate("""() => {
          const r = document.getElementById('np-play').getBoundingClientRect();
          const row = [...document.querySelectorAll('.np-controls > *')].map((e) => e.getBoundingClientRect());
          return { w: r.width, h: r.height, left: Math.min(...row.map((b) => b.left)),
                   right: Math.max(...row.map((b) => b.right)), vw: innerWidth };
        }""")
        check(f"play button is a circle and the controls fit at {width}px",
              box["w"] == box["h"] == 72 and box["left"] >= 0 and box["right"] <= box["vw"], box)
    page.set_viewport_size({"width": 412, "height": 804})
    page.click("#np-tx-btn")
    page.wait_for_selector(".tx-sheet.open", timeout=15000)
    n_sent = page.evaluate("document.querySelectorAll('.tx-sheet .tx-sent').length")
    check("transcript shows every sentence", n_sent == len(SENTENCES), n_sent)
    page.click("#tx-mini-play")
    t = wait_time_advances(page)
    check("real audio plays on the real player", t > 0.5, f"t={t:.1f}")
    page.evaluate("window.__player.pause()")

    # 3. Leaving must tear the episode down
    page.click(".tx-sheet-close")
    page.wait_for_timeout(500)
    page.click("#back-btn")
    page.wait_for_selector(".ep-row[data-id]", timeout=15000)
    check("leaving an episode removes its transcript sheet", sheets(page) == 0, sheets(page))
    check("on-episode class is cleared", not page.evaluate("document.body.classList.contains('on-episode')"))
    page.locator('.ep-row[data-id="1"]').click()
    page.wait_for_selector("#np-play", timeout=15000)
    page.wait_for_timeout(500)
    check("the next episode has exactly one sheet", sheets(page) == 1, sheets(page))

    # 4. Prefetch. The app kicks it 4 s after boot; forceRun makes the wait deterministic.
    page.evaluate("""async () => {
      await navigator.serviceWorker.ready;
      const m = await import('/offline.js');
      await m.forceRun();
    }""")
    ready = page.evaluate("""async () => {
      const m = await import('/offline.js');
      return [...await m.offlineReadyIds()].sort();
    }""")
    check("offline prefetch downloaded the audio", ready == [1, 2], ready)
    check("the service worker controls the page", page.evaluate("!!navigator.serviceWorker.controller"))

    # 5. Dead network, cold boot
    net.down = True
    context.set_offline(True)
    page.evaluate("window.__preReload = 1")
    t0 = time.time()
    page.reload(wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("#np-play", timeout=max(30000, int(OFFLINE_BOOT_LIMIT_S * 4000)))
    boot_s = time.time() - t0
    check("offline run is a real cold boot", page.evaluate("window.__preReload === undefined"))
    check(f"offline boot reaches the episode within {OFFLINE_BOOT_LIMIT_S:.0f} s", boot_s < OFFLINE_BOOT_LIMIT_S, f"{boot_s:.2f}s")
    check("offline: not sent to the login screen", not page.evaluate("document.body.classList.contains('logged-out')"))
    page.click("#np-tx-btn")
    page.wait_for_selector(".tx-sheet.open", timeout=15000)
    n_off = page.evaluate("document.querySelectorAll('.tx-sheet .tx-sent').length")
    check("offline: transcript comes from the cache", n_off == len(SENTENCES), n_off)
    page.click("#tx-mini-play")
    t = wait_time_advances(page)
    check("offline: downloaded audio plays", t > 0.5, f"t={t:.1f}")
    page.evaluate("window.__player.pause()")
    page.click(".tx-sheet-close")

    # Signal returns: the app must stay usable and must not re-render the episode out from under the sheet.
    net.down = False
    context.set_offline(False)
    page.wait_for_timeout(1000)
    page.click("#np-tx-btn")
    page.wait_for_selector(".tx-sheet.open", timeout=15000)
    check("after reconnecting there is still one sheet", sheets(page) == 1, sheets(page))

    check("no uncaught page errors", not errors, errors[:3])
    check("no request outside the fake backend's map", not net.unexpected, sorted(set(net.unexpected))[:5])


def main() -> int:
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", "ui"],
                           cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    check = Checks()
    errors: list[str] = []
    try:
        time.sleep(0.6)
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
            try:
                net = FakeNetwork()
                context = browser.new_context(viewport={"width": 412, "height": 804}, is_mobile=True, has_touch=True,
                                              service_workers="allow")
                context.add_init_script(SEED_SESSION)
                context.route("**/*", net.handle)
                page = context.new_page()
                page.on("pageerror", lambda e: errors.append(str(e)))
                logs: list[str] = []
                page.on("console", lambda m: logs.append(f"{m.type}: {m.text}"[:220]))
                try:
                    run(page, context, net, check, errors)
                except Exception:
                    # A timeout alone says nothing. Show what the app was doing when it stopped.
                    print("STOPPED at", page.evaluate("location.hash"), "\nerrors:", errors[:5], "\nconsole:", *logs[-12:],
                          "\nscreen:", page.evaluate("document.getElementById('app')?.innerText?.slice(0, 300)"),
                          sep="\n  ", flush=True)
                    raise
            finally:
                browser.close()   # never kill: a killed Chromium leaks a 1.4 GB code-sign clone
    finally:
        srv.terminate()
        srv.wait(timeout=5)
    print(f"RESULT: {'PASS' if not check.failed else 'FAIL ' + str(check.failed)}")
    return 1 if check.failed else 0


if __name__ == "__main__":
    sys.exit(main())
