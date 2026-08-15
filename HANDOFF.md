# E-Podcast (aep-review) — Session Handoff

**Written:** 2026-08-10 · **Live:** v1.68.0 (verified on prod) · **Branch:** main, clean, HEAD == origin/main

Read this first, then the auto-memory topic file
`~/.claude/projects/-Users-youngsancha/memory/aep-review-project.md` (full accumulated trap history).
This file is the *current* snapshot + what is open.

---

## 1. What the app is

E-Podcast — English shadowing PWA for the owner's commute + daily study.
- **Stack:** vanilla JS, no build step. Supabase (data/auth) + Cloudflare R2 (audio) + Vercel (static).
- **Repo:** `~/projects/aep-review`, GitHub `youngsancha/aep-review`, `main`, Vercel git auto-deploy.
- **Prod:** https://aep-review.vercel.app · **Device:** Galaxy S23, installed as a PWA.
- **Three shows:** `aep` American English Podcast (272) · `allears` All Ears English (281) ·
  `wh` White House Briefing (**64, complete** — see §3).
- **UI language rule:** home + player/sheet chrome = English; in-session learner copy = Korean.

## 2. Deploy + gate workflow (every change)

1. Edit under `ui/`. Bump BOTH `ui/index.html` `window.APP_VERSION` AND `ui/service-worker.js`
   `const VERSION` (must match). New JS module → register in BOTH the `ui/index.html` importmap AND
   the SW `SHELL` list. **Shipping code without bumping the version delivers nothing** — the SW keeps
   serving the old `SHELL` cache, so the change is live on the server and invisible on the phone.
   That happened once this session.
2. Six gates, all must pass:
   `node scripts/jscheck.mjs` · `npx eslint ui scripts tests` · `node --test tests/*.mjs` ·
   `.venv/bin/python -m pytest -q` · `.venv/bin/python -m ruff check ingest scripts tests conftest.py` ·
   `.venv/bin/python scripts/_pwtest.py` → `RESULT: PASS`
3. Commit with `git commit -F <file>` (never `-m` with backticks — zsh eats them), push `origin main`.
4. Verify live: `until curl -s https://aep-review.vercel.app/ | grep -q "APP_VERSION = 'X.Y.Z'"; do sleep 10; done`

**When `_pwtest` fails it now tells you where.** `GROUPS-FAILED:` names the failing group and
`EP-SUBFAILED:` names the item inside the (30+ term) `ep` conjunction. Before that existed, a bare
`RESULT: FAIL` cost hours of eyeballing this session — and led to a real failure being misattributed.

**Visual work must be verified with screenshots, not reasoning.** `scripts/_pwtest.py` has `_shot(pg, name)`,
a no-op unless `AEP_SHOTS=<dir>` is set: `AEP_SHOTS=/tmp/shots .venv/bin/python scripts/_pwtest.py`.
The harness pages (`ui/_harness_*.html`) exist **only while that script runs** — it writes then deletes
them — so they cannot be driven from a standalone script.

---

## 3. ✅ DONE — White House briefings, all 64

64 discoverable briefings are all ingested end-to-end (audio → R2 → STT → vocab → Kokoro speech →
Korean pre-translation). Verified 2026-08-10: **64/64 with `transcribed_at`, 64/64 with a `_ko.json`
whose keys match the current `resegment()` output** (>98% key hit per episode).

The machinery stays in place and is worth keeping:
- `com.roy.aep-wh-ingest` (LaunchAgent) → `scripts/wh_ingest_supervisor.sh` → `scripts/wh_ingest_all.sh`.
  It exits 0 when nothing remains, and `KeepAlive` only restarts on failure — so it is idle now and
  will pick up **new** briefings on the next login/reboot without any action.
- Log `~/Library/Logs/aep-wh-all.log` (`[sup]` = supervisor lines) · progress `grep -c COMPLETE`.
- It earned its keep: the driver died once mid-run and the supervisor restarted it 5 minutes later.
- ⚠ Must run **locally on the Mac mini** — both audio sources block datacenter IPs, which is why
  `wh-sync.yml` is dispatch-only.
- `scripts/wh_retranslate.sh` tops up `_ko.json` after a `resegment` change (translates only missing
  keys). ⚠ It deliberately skips the newest episode (the ingest may be writing that file), so after
  running it, **check that episode by hand** — that gap left ep570 6% stale until it was measured.

---

## 4. Transcript sheet — where it landed

- ✅ Fullscreen study mode (`⤢`, right-hand end of the toolbar): header + toolbar hidden, video flush
  at the top, transcript below. Exits via ✕ / Esc / turning the video off. Always OFF on entry.
- ✅ Pressing play in video mode (bottom control **or** tapping the video) enters fullscreen. Only on
  the paused→playing transition, so exiting fullscreen mid-playback is respected.
- ✅ YouTube's own controls are off (`controls: 0`) — shadow repeat seeks constantly and YouTube
  raised its chrome on every seek. A transparent `.tx-video-tap` layer gives back tap-to-play/pause.
- ✅ Toolbar is one row **structurally** (`flex-wrap: nowrap` + `overflow-x: auto`), not by pixel budget.
- ✅ Active sentence stays in the upper half and is never clipped at the top (§6).
- ✅ **Shadow rewind lands on the same screen every time.** Returning to the top of a repeated
  paragraph puts the countdown badge exactly `LOOP_HEAD_GAP` (26 px) below the top of `.tx-scroll`,
  with the paragraph starting right under it — independent of paragraph or sentence length.
  Owned by `atLoopHead()` / `loopHeadTarget()` / `anchorLoopHead()` in `ui/views/episode.js`;
  the two `.tx-scroll.loop-tail::before/::after` spacers give the first and last paragraphs the
  scroll room to reach that position. Locked by `_pwtest` group `loopanchor` (§6).
- ⬜ **Header (title/date) compaction for the normal sheet — never started.** Still wanted.

---

## 5. What shipped (v1.61.0 → v1.67.0)

- **v1.61.0** fullscreen study mode · toolbar one row · KR panel overlap 4/8 → 1/8 failing.
- **v1.62.0** toolbar measured at its *widest* label · `controls: 0` · play → fullscreen.
- **v1.63.0** sentence-boundary fixes that the user experienced as "sync is off" (§6).
- **v1.64.0** chips restored to a comfortable size; `⤢` pinned right with `margin-left: auto`.
- **v1.65.0** active sentence kept in the upper half instead of sinking to the bottom.
- **v1.66.0** one row guaranteed by CSS; chips widened for the device.
- **v1.67.0** active sentence never pushed above the top of the scroll area.
- **v1.68.0** shadow rewind always lands on the same screen (badge pinned, paragraph right below);
  `smoothScrollTo` now actually reaches its target.

## 6. Traps this session added (details in the memory topic file)

- **"Sync is off" was not a timing bug.** Measured: stored word timestamps vs a fresh `medium.en`
  pass = median **−0.01 s** over 58 words; the R2 audio and the YouTube video are the same timeline
  (identical text at 146 s); `syncOffset` 0. What was wrong was **where sentences were cut**:
  a speaker pausing before the final word ("...like never ▁ before.") made the gap rule close the
  sentence early, and the `n >= 2` guard then prevented that orphan from closing, so it swallowed the
  next sentence. Shadow repeat rewinds by *paragraph*, so such a paragraph starts mid-sentence every
  single repetition. Abbreviations (`U.S.`, `Ms.`) split sentences the same way. **Measure the data
  before assuming a clock is wrong.**
- **`resegment` has THREE copies** — `ui/views/episode.js`, `scripts/translate_transcripts.py`,
  `scripts/verify_hosting.py`. Only the first two are pinned by `tests/test_resegment_parity.py`, and
  that test compared `_disk_ids()[:8]`, i.e. the *oldest* fixtures — new-show fixtures could never
  enter the comparison. Now it takes both ends.
- **A fixed `sleep` cannot measure an easing animation.** `smoothScrollTo` closes 12%/frame, so settle
  time scales with distance. Because easing is deterministic, the wrong number is *identical every
  run* — it reads like a solid bug, not a race.
- **"Re-check after it settles" recursed into itself** under `prefers-reduced-motion: reduce` (that
  path scrolls synchronously). Headless Chromium reports `reduce`, so it blew the stack and Playwright
  reported `Execution context was destroyed ... because of a navigation`. `git stash push -- <file>`
  found it in one run — bisect before theorising.
- **Anchoring must not be one-directional.** Letting the view follow a sentence *down* while a gate
  still blocked pulling it *up* left the spoken sentence stranded above the screen during repeat.
  The three anchoring paths (paragraph entry / sentence follow / panel-growth re-anchor) must apply
  the same rule: lower only when the tail is really covered, and never past the point where the head
  clips. When a sentence is taller than the usable area those two cannot both hold — show its start.
- **The harness is not the phone.** `_pwtest` renders the same chips ~49 px wider (measured twice), and
  its `.tx-scroll` reports a height far larger than the sheet. Sizing to the harness makes the device
  look sparse; sizing to the device fails the gate. The fix was to stop budgeting pixels and make the
  invariant structural.
- **Two `.tx-sheet.open` elements exist in parts of `_pwtest`.** Any unscoped `document.querySelector`
  there measures the wrong sheet. Scope from `#tx-video-toggle` → `.closest('.tx-sheet')`.
- **`smoothScrollTo` used to stop ~4 px short of its target, silently.** `easeScroll` moved
  `diff × 0.12` per frame; once `diff` fell to ~4 px that step is 0.48 px, the browser quantises it
  away, `scrollTop` stops changing — and because the arrival test was `|diff| < 0.5`, the rAF loop
  kept spinning without ever arriving (so the arrival callback never fired either). Every auto-scroll
  in the app landed up to 4 px off. It now enforces a 1 px minimum step. **This looked exactly like
  "the anchor calculation is wrong"** — the fix only became findable by logging the target *and* the
  reached value: the target was right all along.
- **A measuring function must not mutate layout.** The first version of `loopHeadTarget()` adjusted
  the scroller's bottom padding while computing. Shrinking padding makes the browser clamp
  `scrollTop` on the spot, so the geometry it had just read no longer described reality — the badge
  drifted 4–106 px per rewind. Reserve space in a *separate* step, before anchoring.
- **`clientHeight` includes padding, so sizing padding from it explodes.** Setting
  `--loop-tail = clientHeight` fed back on itself: measured 585 → 798 → 4720 → … → 33 554 432 px.
  Setting it to `0px` and re-reading in the same task does **not** reliably give the padding-free
  height either. The reserve is now pure CSS in viewport units (`100vh`), which cannot self-reference.
- **`_pwtest` group `loopanchor` sweeps paragraph length end to end** (`?fx=loop` fixture: 3-word
  single sentence … 26-word two-sentence paragraph) in two layouts, and asserts the badge's *spread*
  across all of them is ≤ 2 px — not just that each one looks reasonable. It also asserts the fixture
  really covered both `« viewport` and `» viewport` paragraphs; a sweep of only short paragraphs
  would have passed while the reported bug (long paragraphs) survived.

## 7. Open / deferred

- ⚠ **`_pwtest` is red on one item: `libvideo` / `LIBRARY-VIDEO-LAYOUT`.** In the harness `.tx-scroll`
  measures 918 px taller than its `.tx-sheet-card` (`sc.bottom` 1698 vs `card.bottom` 780). It fails
  **without** this session's `episode.js` changes too (verified by stashing them), the CSS chain
  (`92vh` → `flex:1` → `flex:1`) is correct, and the device renders fine — so suspect the harness
  page's height context (`html`/`body`). Worth fixing: this inflated height is what makes the KR-panel
  `usable` area unrealistically small and has distorted other judgements all session. Filed.
  Re-confirmed 2026-08-10 after the v1.68.0 work: the numbers are byte-identical (`sc` height 1324
  inside a 717 px card), so nothing since has touched it. Note the scoping fix is already in — all
  four rects come from the same sheet — so "two open sheets" is *not* the explanation any more.
- Old `aep`/`allears` `_ko.json` are **60–70% stale** (ep100 243/413, ep400 347/478, ep520 272/393),
  from resegment changes accumulated long before this session. Online it is masked by on-demand
  translation; offline those lines show nothing. ~480 episodes — needs a cost decision. Filed.
- Header compaction for the normal sheet (§4).
- Mini-player has no −15s (asymmetric with +30s) — skipped as low value.
- Android home-screen widget: options laid out, owner has not picked.
- R2 keys are in the Keychain vault; they were pasted into a chat transcript, so rolling that token is
  still worth doing (the GitHub Actions token is separate and unaffected).
- **Korean translation quality pass is RUNNING — see §8.** Do not start a second one, and do not run
  any `_ko.json` cleanup while it is alive.

---

## 8. 🔄 IN PROGRESS — Korean translation quality pass (started 2026-08-15)

**The owner's report was "the translations are too literal; I want the speaker's actual intent."
Measuring first showed that was not a translation-quality problem at all.** Coverage of the LLM
pre-translations across the newest 50 episodes of each show (73,748 sentences):

| show | sentences | translated | coverage |
|---|---|---|---|
| aep | 18,496 | 5,744 | **31.1 %** |
| allears | 21,063 | 2,026 | **9.6 %** |
| wh | 34,189 | 34,171 | 99.9 % |

A sentence whose key is missing from `_ko.json` does **not** show as "no translation" — the app
silently falls back to MyMemory, a free MT API that translates each sentence in isolation and so
loses pronouns, idioms and discourse flow. That fallback, not the stored translations, is what read
as wooden Korean. For the newest All Ears English episodes coverage was **0.0 %** — every single
line came from MyMemory. Two causes were mixed together: episodes with no `_ko.json` at all, and
episodes whose file exists but whose keys were invalidated by later `resegment()` changes.

**What runs:** LaunchAgent `com.roy.aep-ko-quality` → `scripts/ko_quality_pass.sh`, 4 shards.
- Phase A `scripts.translate_transcripts` — fills every missing sentence.
- Phase B `scripts.refine_translations` — re-reviews the *existing* translations against the same
  rules and returns only the lines that need fixing. This is the only path that can ever improve an
  already-translated line: `translate_transcripts` is idempotent and never looks at one twice.
- Both are checkpointed; a stop for what looks like a Claude usage limit exits non-zero so
  `KeepAlive` resumes it after 30 min. Logs: `~/Library/Logs/aep-ko-quality.log` + `aep-ko-*-N.log`.
- ⚠ The run holds a lock dir. Two writers on one `_ko.json` lose work — the checkpoint uploads the
  whole file, so the last writer wins.

**Verified after the first episodes:** 624/522/520/521/267 all went to **100.0 %** coverage
(re-read from Storage, not inferred from logs).

**New tooling:** `scripts/audit_ko_coverage.py` is the measurement that was missing — no gate could
see this rot because the app shows a translation either way. `--min-pct 95` exits 1, so it can be
wired into a gate or a cron. **Run it after any `resegment()` change**: changing sentence boundaries
invalidates `_ko.json` keys wholesale, and nothing else will tell you.

**Also found, deliberately not fixed yet:** `_ko.json` files accumulate orphan keys from older
segmentations — ep 520 carries 283 dead keys for 386 sentences (~42 % of the file). The app
downloads the whole file per episode, so this is wasted weight on offline pins and load. Filed.
Cleanup must not run while the quality pass is alive.
