# E-Podcast (aep-review)

A phone-first PWA for listening to English podcasts with a synced transcript, Korean translation and
shadowing. Live at <https://aep-review.vercel.app>. No server of its own: Supabase, Vercel static
hosting and a service worker that keeps whole episodes playable offline.

| Show | Slug | Source |
|---|---|---|
| American English Podcast | `aep` | Megaphone RSS |
| All Ears English | `allears` | Megaphone RSS |
| White House press briefings | `wh` | YouTube and whitehouse.gov (`ingest/wh_fetch.py`) |
| CNN 10 | `cnn10` | Megaphone RSS |

`ui/config.js` and `ingest/shows.py` must list the same shows; `tests/test_shows_parity.py` enforces it.

## Architecture

```
GitHub Actions and the local Mac                         Python lives only here
  RSS → audio → faster-whisper STT → vocabulary, sentence boundaries, Korean translation
        │
        ▼
Supabase                  Postgres: episodes, vocab_cards (row level security on)
                          Storage:  transcripts/{id}.json and {id}_ko.json (public read)
Cloudflare R2             hosted episode audio, so word timings match what plays
        │
        ▼
Vercel (static ui/)       vanilla ES modules, no bundler, importmap in index.html
  data   supabase-js called directly from the browser
  audio  <audio> pointed at R2, or at the original CDN when an episode is not hosted yet
  speech the device's speech synthesis for word pronunciation
  auth   Supabase Auth, single owner
```

Ad insertion is why R2 exists: Megaphone stitches different ads into each play, so only audio we host
ourselves stays in sync with the transcript. `transcript.r2_audio === true` is the app's truth for
perfect sync, not the `audio_hosted.json` manifest.

## Running it

```bash
npx serve ui                       # or: python -m http.server 8000 --directory ui
```

`ui/config.js` holds the public Supabase URL and anon key. Ingest reads `.env` and `.env.local`
(see `.env.example`). First-time Supabase setup is in `supabase/README.md`.

## Gates

```bash
npm run gate                       # eslint (no warnings allowed), syntax check, node tests
.venv/bin/python -m pytest -q      # python tests, including the JS/Python resegment parity
.venv/bin/ruff check .
.venv/bin/python scripts/_pwtest.py          # the episode screen in Chromium, core modules mocked
.venv/bin/python scripts/_smoke_realstack.py  # every real module and service worker, fake network
```

`.github/workflows/ci.yml` runs everything except the two browser checks on every push. Those are
tuned to phone viewports and Android and macOS fonts, so they run locally, and `scripts/release.py`
will not release without them.

## Releasing

```bash
python -m scripts.release --patch "fix: …"        # gates, bump both versions, commit, push
python -m scripts.release --no-push "fix: …"      # same, without the push
```

`window.APP_VERSION` in `ui/index.html` and `VERSION` in `ui/service-worker.js` key the shell cache and
must stay equal; the script keeps them so. Every push to `main` spends one of the roughly 100 Vercel
deployments a day shared by the whole account, so batch them. `aep-deploy-watch` deploys by itself
when production falls behind `origin/main`, for example after the daily limit resets.

## What runs unattended

| When | Where | What |
|---|---|---|
| 16:00 UTC | `aep-sync` (Actions) | New episodes: RSS, STT, host the audio on R2 |
| 17:00 UTC | `aep-r2-upload` (Actions) | Re-transcribes hosted audio, working through the back catalogue |
| 16:30 local | `com.roy.aep-daily-loop` (Mac) | `scripts/daily_local_loop.sh`: storage guard, then sentence boundaries, vocabulary and Korean translation on local ollama |

The local loop must never touch the Claude quota: `ingest/llm_policy.py` refuses it without a double
opt-in. It files a `td-task` when ollama cannot see its model or a step fails.

## Layout

- `ui/`: the PWA. `views/` holds the Library, Episode and login screens; `db.js` is the data layer.
- `ingest/`: RSS, STT and LLM pipeline. `store.py` is the single Supabase and R2 sink.
- `scripts/`: operations, audits, the release script and the browser harness.
- `supabase/`: schema, migrations and setup notes.
- `tests/`: `*.mjs` run under `node --test`, `test_*.py` under pytest.

## Cost

Nothing: Supabase free tier (the 1 GB Storage cap is watched by `scripts/storage_guard.py`), Vercel
Hobby, GitHub Actions on a public repo, Cloudflare R2's free tier and a local LLM.

Study, Review, Essentials, drills and stored speech were retired in v1.80.0. Their SRS history stays in
the database, unread by the app. Old Study links return to the Library.
