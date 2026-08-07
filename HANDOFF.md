# E-Podcast (aep-review) — Session Handoff

**Written:** 2026-08-07 · **Live:** v1.60.0 (verified on prod) · **Branch:** main, clean, HEAD == origin/main

Read this first, then the auto-memory topic file
`~/.claude/projects/-Users-youngsancha/memory/aep-review-project.md` (full accumulated trap history).
This file is the *current* snapshot + what is in flight.

---

## 1. What the app is

E-Podcast — English shadowing PWA for the owner's commute + daily study.
- **Stack:** vanilla JS, no build step. Supabase (data/auth) + Cloudflare R2 (audio) + Vercel (static).
- **Repo:** `~/projects/aep-review`, GitHub `youngsancha/aep-review`, `main`, Vercel git auto-deploy.
- **Prod:** https://aep-review.vercel.app · **Device:** Galaxy S23, installed as a PWA.
- **Three shows:** `aep` American English Podcast (272) · `allears` All Ears English (281) ·
  `wh` White House Briefing (growing, see §3).
- **UI language rule:** home + player/sheet chrome = English; in-session learner copy = Korean.

## 2. Deploy + gate workflow (every change)

1. Edit under `ui/`. Bump BOTH `ui/index.html` `window.APP_VERSION` AND `ui/service-worker.js`
   `const VERSION` (must match). New JS module → register in BOTH the `ui/index.html` importmap AND
   the SW `SHELL` list.
2. Six gates, all must pass:
   `node scripts/jscheck.mjs` · `npx eslint ui scripts tests` · `node --test tests/*.mjs` ·
   `.venv/bin/python -m pytest -q` · `.venv/bin/python -m ruff check ingest scripts tests conftest.py` ·
   `.venv/bin/python scripts/_pwtest.py` → `RESULT: PASS`
3. Commit with `git commit -F <file>` (never `-m` with backticks — zsh eats them), push `origin main`.
4. Verify live: `until curl -s https://aep-review.vercel.app/ | grep -q "APP_VERSION = 'X.Y.Z'"; do sleep 10; done`

**Visual work must be verified with screenshots, not reasoning.** `scripts/_pwtest.py` has `_shot(pg, name)`,
a no-op unless `AEP_SHOTS=<dir>` is set: `AEP_SHOTS=/tmp/shots .venv/bin/python scripts/_pwtest.py`.
The harness pages (`ui/_harness_*.html`) exist **only while that script runs** — it writes then deletes
them — so they cannot be driven from a standalone script. Two bugs that passed all six gates were caught
only by looking at the screenshots.

---

## 3. ⏳ IN FLIGHT — White House briefing ingest (~52 episodes, ~33 h left)

A driver is running that ingests every remaining briefing, **completing one episode fully before
starting the next** (audio → R2 → STT → vocab → Kokoro speech → Korean pre-translation). Batching by
stage would leave a pile of transcript-less rows if it dies at hour 20; this way an interruption leaves
finished episodes plus untouched work.

- **Script:** `scripts/wh_ingest_all.sh` (was in a scratchpad; moved into the repo so it survives a
  session ending). **Resume by simply re-running it** — every stage is idempotent: `wh_fetch` skips
  guids already in the DB, `kokoro_pregen` skips existing keys, `translate_transcripts` checkpoints
  per sentence.
- **Log:** `~/Library/Logs/aep-wh-all.log` · progress = `grep -c COMPLETE`.
- **Pace:** ~38 min/episode (21-min briefing ≈ 22 min CPU STT + vocab + translation).
- **Order is newest-first**, so an interruption still leaves the most recent briefings done.
- 64 briefings are discoverable in total (6 paginated listing pages); 59 of them are Karoline Leavitt.
- Secrets come from the Keychain via `ccsecret` at runtime — all five are stored, nothing user-only
  remains for this pipeline.

⚠ This must run **locally on the Mac mini**. Both audio sources block datacenter IPs (YouTube answers
"Sign in to confirm you're not a bot"; C-SPAN returns 403). `wh-sync.yml` is dispatch-only for that reason.

## 4. ⏳ IN FLIGHT — a Sonnet agent on the transcript sheet (NOT yet in the tree)

Four items, priority order (told to ship 1-3 and report 4 undone rather than rush):
1. **The active sentence hides behind the Korean panel.** `_highlightImpl` anchors the active paragraph
   against the scroll container's *full* height, but `.tx-notes` is a pinned bottom overlay, so the
   usable viewport is shorter. Audio-only had enough slack to hide it; video mode halved the scroll area
   and it became "the line I need to read is off-screen". Fix = anchor against the usable area (measure
   the panel, it is 1-3 lines depending on text size) + bottom padding on `.tx-scroll` so the last
   sentences can clear it.
2. **Fullscreen focus study mode** — a toolbar chip that hides header + toolbar, pins the video flush to
   the top of the screen and gives the transcript everything below. Must have a visible exit (no
   gesture-only), must default OFF on every entry (memory-only, same rule as drive mode and video mode).
3. **Toolbar on one row at 360px** — 7 chips currently wrap. `.tx-loop-toggle`'s fixed `min-width` exists
   because the shadow label cycles (`Shadow` … `10× Auto`); it may shrink but must stay fixed, and the
   44px `::after` touch expanders must survive.
4. Header (title/date) compaction for the *normal* sheet.

If that agent is gone, the four items above are the spec — re-run them.

---

## 5. What shipped this session (v1.55.0 → v1.60.0)

- **v1.55.0** Study session card redesigned after reading-booster's Review deck (centred card, labelled
  `Listen` pill, equal-weight grade buttons) · **all app TTS moved to Kokoro** · About text 14→16px.
- **v1.56.0** 1-second paragraphs (`MIN_PARA_SEC`) · the "capital The" report (Whisper drops the terminal
  period; `The` was missing from `STARTER`).
- **v1.57.0** offline transcripts pinned so they survive TTS cache pressure.
- **v1.58.0** video + synced transcript study mode.
- **v1.59.0** the YouTube API script could hang forever · video pinned to the top.
- **v1.60.0** transcripts were frozen on-device by `force-cache` · `Transcript`/`Video` equal-weight
  primary buttons · toolbar order `KR · 가 · A · …`.

Also: the daily cron only ever read the `aep` feed, so **All Ears English silently missed 6 weeks**
(31 episodes recovered) · WH listing pagination 12 → 64.

## 6. Traps this session added (details in the memory topic file)

- **`[hidden]` loses to any class rule.** UA `[hidden]{display:none}` has specificity 0, so
  `.dict-actions{display:flex}` defeats it. Symptom: session grade buttons were tappable before the
  answer was revealed. Patched twice before as one-offs; `style.css` now has a global
  `[hidden]{display:none!important}` — do not re-add per-element patches.
- **`resegment()` output text is the `_ko.json` lookup key.** Changing sentence boundaries silently drops
  those lines to the MyMemory fallback (and to nothing offline). Measured blast radius was 14.6%, of
  which 92% was a single appended period → fixed by stripping terminal punctuation in `trKey()` on both
  sides, no regeneration. `tests/test_resegment_parity.py` pins `resegment` AND `trKey` across the JS and
  **two** Python copies — and it **skips when `data/transcripts/` is empty**, so it had been silently
  green. Put real transcripts there before trusting it.
- **A patched-in-place file behind an immutable URL.** `fetchTranscript()` used `cache: 'force-cache'`
  with a URL versioned only by `transcribed_at`; the `video_id` backfill changed the JSON without
  changing `transcribed_at`, so devices served the pre-backfill copy forever. Note the SW's
  "network-first" does **not** save you — `networkFirst` forwards the original request's cache mode into
  its own `fetch(req)`. Now `cache: 'no-cache'`.
- **Failure by doing nothing is the expensive kind.** The video feature failed with zero console output
  because an injected `<script>` had no `onerror`/timeout and its rejected promise was cached in a module
  singleton. Bail paths now log why.
- **A "safety" guard can protect the wrong thing.** `wh_backfill_video_ids` excluded the newest episode
  by `pub_date` when the one being written is always the newest by **id**.

## 7. Open / deferred

- Mini-player has no −15s (asymmetric with +30s); layout is tight — skipped as low value.
- `tests/test_resegment_parity.py` skips without fixtures — filed on the ops dashboard.
- `_pwtest` flaked twice with `Unable to adopt element handle from a different document`, both times
  passing on re-run; it correlates with the ingest job pegging the CPU.
- Android home-screen widget: options laid out (shortcut routes / TWA+Glance / native), owner has not picked.
- No user-only blockers remain. R2 keys are in the Keychain vault; ⚠ they were pasted into a chat
  transcript, so rolling that token after the ingest finishes is worth doing (the GitHub Actions token is
  separate and unaffected).
