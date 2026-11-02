# E-Podcast (aep-review): working notes for agents

Read `README.md` for the architecture. These are the rules that have cost something to learn.

## Before calling anything done

1. `npm run gate`, `.venv/bin/python -m pytest -q`, `.venv/bin/ruff check .`
2. `.venv/bin/python scripts/_pwtest.py` for anything under `ui/`. Exactly one copy at a time: it binds
   port 8123 and writes `ui/_*` fixtures that it removes on exit. A green `node --test` run says little
   about the episode screen, which only the harness actually renders.

## Invariants

- **Versions.** `APP_VERSION` and the service worker `VERSION` move together; use `scripts/release.py`.
- **Adding a module.** It must appear in three places: the import itself, the `paths` importmap in
  `ui/index.html`, and `SHELL_CRITICAL` in `ui/service-worker.js`. Miss one and the app still works
  online but dies on the offline boot. `tests/module_graph.test.mjs` checks all three.
- **The harness mocks `/db.js`.** A new `db.js` export needs a stub in `_pwtest.py`, or the episode
  page fails to link there while production is fine.
- **Translation keys are sentence text** (`trKey`), identical in JS and Python. Changing resegmentation
  or normalisation orphans existing `_ko.json` entries. `tests/test_resegment_parity.py` guards it.
- **Order of the daily loop is a data invariant.** Sentence boundaries run before translation, or the
  day's translations lose their keys. See the header of `scripts/daily_local_loop.sh`.
- **The local LLM must run with batch size 1.** Larger batches make exaone merge lines and renumber:
  valid JSON, natural Korean, every sentence paired with its neighbour's translation.

## Automation limits

- Automated paths use ollama only, never Claude quota. `ingest/llm_policy.py` enforces it.
- Commit freely, push rarely. Every push to `main` spends one of about 100 Vercel deployments a day
  shared across the whole account. Use `scripts/release.py --no-push` in a loop.
- Supabase free tier: a Storage overage answers 402 to everything, service key included, and cannot
  be cleared by deleting files. `scripts/storage_guard.py` warns at 0.8 GB.

## Service worker

- HTML navigations are network-first. Serving them from cache strands old HTML pointing at gone
  chunks.
- A cached copy beats any failed response (`res.ok`), not just a thrown fetch.
- An error page must never be cached as a download: `cacheAudio` falls back to `no-cors` only when the
  CORS fetch throws, because an opaque body hides a 404.
