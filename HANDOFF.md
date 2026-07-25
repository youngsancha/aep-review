# E-Podcast (aep-review) — Session Handoff

**Written:** 2026-07-25 · **Live version:** v1.43.0 (verified live on prod) · **Branch:** main (clean, HEAD == origin/main == prod)

This file hands off an interactive session to the next one. Read this first, then the auto-memory
topic file `~/.claude/projects/-Users-youngsancha/memory/aep-review-project.md` (has the full,
accumulated trap/history detail — this file is the *current* snapshot + open decisions only).

---

## 1. What the app is

E-Podcast — English-podcast shadowing PWA for the user's daily commute (car) + daily study.
- **Stack:** vanilla JS, no build step. Supabase (data/auth) + Cloudflare R2 (audio) + Vercel (static host).
- **Repo:** `~/projects/aep-review`, GitHub `youngsancha/aep-review`, branch `main`, Vercel git auto-deploy.
- **Prod:** https://aep-review.vercel.app
- **User's device:** Samsung Galaxy S23 (Android) — the app is installed as a home-screen PWA/WebAPK.
- **UI language rule:** home + player/sheet *chrome* = English; in-session *learner/study copy* = Korean
  (Known/Essentials tokens and mode badges like `🗣️KR→EN` stay English even inside Korean copy).

## 2. Deploy + gate workflow (do this every change)

1. Edit under `ui/`. Bump BOTH `ui/index.html` `window.APP_VERSION` AND `ui/service-worker.js` `const VERSION`
   (must match). New JS module → register in BOTH `ui/index.html` importmap AND `ui/service-worker.js` SHELL.
2. Gates (all must pass): `node scripts/jscheck.mjs` · `npx eslint ui scripts tests` ·
   `node --test tests/*.mjs` (77) · `.venv/bin/python -m pytest -q` (23) ·
   `.venv/bin/python scripts/_pwtest.py` → prints `RESULT: PASS`.
3. Commit (Korean commit msg OK; use `git commit -F <file>`, NOT `-m` with backticks) + `git push origin main`.
4. Verify live: poll `curl -s https://aep-review.vercel.app/ | grep APP_VERSION` until it flips.
   Vercel git webhook OCCASIONALLY drops a push silently → if it doesn't flip in ~2min, run
   `~/.local/bin/vercel deploy --prod --yes` from the repo.

## 3. What THIS session did — ultracode menu/feature audit + 7 shipped versions

User asked: "ultracode 메뉴 기능 정밀진단하고 업그레이드" (precisely diagnose menu/feature
implementation, then upgrade). Ran a multi-agent Workflow (5-surface parallel audit
[library/player-sheet/study/srs-essentials/chrome-router] → per-finding adversarial verify →
completeness critic). **17 confirmed + 6 critic findings** (1 refuted by the verifier — the
adversarial pass caught a bogus finding before it hit code). Full digest: `HANDOFF-menu-audit-2026-07-25.json`
(keys: `confirmed` 17, `critic` 6, `lows` 28).

Shipped batches (all gated green, all live):
- **v1.41.0** — [HIGH] read/weak quiz auto-spoke the answer (leaked correct option + inflated automaticity
  axis) → gated to listen mode; [HIGH] drive nexttrack override persisted after leaving episode → teardown
  setDrive(false); offline session no longer marks "완료"; SRS offline state; Review tab wayfinding
  (tab:'study'+back:true); EN chrome toasts; 44px touch targets.
- **v1.42.0** — NEW **Settings sheet** `ui/settings.js` (version-pill `#app-version` opens it): Theme
  Auto/Light/Dark, Offline downloads Off/5/15/30, visible Sign out. Consolidated the scattered settings +
  the previously-hidden 700ms-long-press logout. Dedicated harness `_harness_settings.html`.
- **v1.42.1** — Vocabulary "알아요" learning action on the episode screen (was a dead-end); vocab ▶TTS
  wired before the `!audio_url` early-return (was dead on audio-less eps); Sync ↻ guards `#/srs` too
  (was resetting active review queue/score); np-endmode state-specific aria-label.
- **v1.42.2** — Essentials learner copy → Korean.
- **v1.42.3** — Essentials list-swipe → header progress bar refreshes in place.
- **v1.43.0** — Shadow repeat cycle gained **2× / 3× Auto** (now off → 2×Smart → 1×Smart → 2×Auto →
  3×Auto → 5×Auto → 10×Auto). Just REPEAT_OF + SHADOW array in episode.js — `inRepeatMode()` and
  `REPEAT_OF[mode]` abstractions carry it through all gates.

## 4. Remaining backlog (confirmed, NOT yet shipped)

Ranked by value. Pick up here if continuing the audit upgrade:
1. **Per-episode manual "Download for offline" button** — `episode.js` ~line 92 shows a dead-end
   "audio not downloaded yet"; wire an on-demand button → `offline.js` cacheAudio(hostedAudioUrl(id))
   with progress/done feedback. (medium, user-facing on no-signal commute)
2. **Study kind-chip full repaint** — switching Idioms/Phrasal/etc. rebuilds the whole shell + Drive;
   should only toggle `.study-kind-chip.on` + re-render `#study-list`. (medium perf/UX, study.js loadKind)
3. **Mini-player −15s back button** — only +30s exists; asymmetric. Layout is tight (skipped as low value).
4. **Brand-name unify** — login title + `media-session.js` say "American English Podcast" but the app is
   "E-Podcast"; make config.js the single source. (low)
5. **28 low-severity items** in `HANDOFF-menu-audit-2026-07-25.json` (`lows` array) — file:line + fix each.

## 5. OPEN DECISION — Android home-screen widget (user asked, awaiting choice)

User asked "안드로이드에 위젯으로 구현방법 있음?". My assessment given to them:
- **A PWA cannot make a native Android home-screen widget.** The `widgets` manifest member targets the
  Windows 11 Widgets Board, not Android launchers. Real widget = native Kotlin (Jetpack Glance / RemoteViews).
- **Already have (widget-ish):** lock-screen/notification media controls (media-session.js — play/±skip/
  artwork/position) + home-icon long-press shortcuts (manifest `shortcuts`: Resume, Transcript).
- **Options I laid out (effort ↑):**
  - **①** Enhance what exists, 0 native: add `?sc=study` / `?sc=drive` shortcut routes so the home-icon
    long-press menu covers study + drive capture too. (recommended first — can do today)
  - **②** TWA wrapper (PWABuilder/Bubblewrap → APK) + a **deep-link-only Glance widget** (3 static buttons
    Resume/Study/Drive that open the TWA at a route). Needs `ui/.well-known/assetlinks.json` hosted
    (domain is theirs). No live data in the widget (widget can't run the PWA's JS). Personal use → sideload
    APK, no Play Store needed.
  - **③** ② + native Kotlin widget that fetches Supabase directly (streak/due/now-playing) via WorkManager.
    Real second (Kotlin) codebase to maintain — likely overkill for a commute tool.
- **My recommendation:** do ① now, and ② only if they want a real resident home-screen widget.
- **Not yet started** — waiting on the user to pick ①/②/③. If they pick ②, I'd prepare the Bubblewrap
  config + Glance widget code + `assetlinks.json`, and hand them only the device steps (APK build + `adb install`
  on the S23). Note: `ui/.well-known/assetlinks.json` does NOT exist yet.

## 6. Repo traps (also in the memory topic file)

- **Re-rendering an episode in place** (same hash, no hashchange) appends a 2nd transcript sheet + doubles
  player listeners. That's why `refreshData()` (Sync ↻) early-returns on `#/episode/` and now `#/srs`.
- **Multi-agent Workflow session-limit trap:** if agents hit "session limit" / "Fable 5 limit", the workflow
  RESUMES from cache — `Workflow({scriptPath, resumeFromRunId})` replays completed agents instantly, only
  failed ones re-run. Switch the session model (`/model`) if one model's quota is exhausted; workflow agents
  inherit the resolved session model.
- **⛔ 2 human-only blockers (unchanged):** `.env` `SUPABASE_SERVICE_KEY` is empty (blocks ingest/migration);
  Supabase Google auth provider is OFF (email+password login works meanwhile, but Google is the intended
  primary login).
- Dark tokens live in TWO CSS blocks (`[data-theme=dark]` + `@media prefers-color-scheme`) — edit both.
- `.venv` is uv-style Python 3.12 (no pip binary). Playwright is installed there for `_pwtest.py`.

## 7. Files to read on pickup

- This file (`HANDOFF.md`) + `HANDOFF-menu-audit-2026-07-25.json` (full audit findings).
- Auto-memory topic: `~/.claude/projects/-Users-youngsancha/memory/aep-review-project.md` (full history/traps).
- `docs/NIGHT_BUILD.md` / `BACKLOG.md` in-repo (older, cross-check git log before implementing — some items
  already done).
