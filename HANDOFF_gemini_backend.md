# Handoff — Gemini LLM backend for vocab extraction

Written 2026-08-23. Everything below is done and verified **except one blocked step** that needs a credential only the owner can fetch.

---

## TL;DR — the one thing left to do

`SUPABASE_SERVICE_KEY` is empty in `.env`, so the ingest cannot write to Supabase.

```
Supabase dashboard → project lbcvuztpyaapyckxmqhk → Settings → API Keys → service_role
→ paste into ~/projects/aep-review/.env after SUPABASE_SERVICE_KEY=
```

Then run the backlog (see **Running the ingest** below). Nothing else is pending.

---

## Why this work exists (it is NOT a cost saving)

`extract_vocab.py` shells out to `claude -p` on purpose — the owner is a Claude Max
subscriber, and the module header says `Anthropic API 직접 호출 금지 (Max 이중과금)`.
That path already costs **$0**, so switching to Gemini saves nothing.

The actual problem is **portability**. `claude -p` only runs where a logged-in Claude Code
CLI exists. That is why `cron_fetch` carries a `--no-vocab` escape hatch labelled
"claude CLI 없을 때" — on a server, in CI, or under a scheduler, the vocab step silently
drops out of the pipeline entirely.

The Gemini backend is an HTTP path that runs anywhere, so vocab extraction can be automated.

---

## What changed

| File | Change |
|---|---|
| `ingest/gemini_client.py` | **new** — httpx-based Gemini client. Vertex + service account (default), manual token (debug), AI Studio key (does not draw the credit). Mints and caches its own access tokens. |
| `ingest/extract_vocab.py` | **new** `call_llm()` dispatcher; `extract_for_episode` now calls it instead of `call_claude`. `call_claude` is unchanged and still exported (`scripts/translate_examples.py` imports it). |
| `ingest/cron_fetch.py` | docstring only — documents `AEP_LLM_BACKEND=auto`. |
| `tests/test_llm_backend.py` | **new** — 19 tests, no network, no spend. |
| `.env.example` | documents the new variables. |

All of it is **uncommitted** on `main`.

### Backend selection

```
AEP_LLM_BACKEND unset / "claude-cli"   → `claude -p`   (DEFAULT — byte-identical to before)
AEP_LLM_BACKEND=gemini                 → HTTP
AEP_LLM_BACKEND=auto                   → CLI if on PATH, else Gemini
```

The default is deliberately the old behavior: with no env var set, this work changes nothing.
An unrecognised value (typo) falls back to `claude-cli` rather than silently switching vendor.

Gemini responses go through the **same** `_parse_vocab_json()` as the Claude path, so fence
stripping and brace matching cannot diverge between backends.

---

## Running the ingest

Once the Supabase key is in `.env`:

```bash
cd ~/projects/aep-review
set -a; source <(grep -hE '^[A-Z_]+=' .env .env.local); set +a
AEP_LLM_BACKEND=auto .venv/bin/python -m ingest.cron_fetch
```

Sanity check before a long run (should print `vertex-sa | configured: True`):

```bash
.venv/bin/python -c "from ingest import gemini_client as gc; print(gc.backend(), '| configured:', gc.configured())"
```

Useful flags (`ingest/cron_fetch.py` docstring has the full list):

```bash
--limit 5        # cap episodes processed this cycle
--no-vocab       # skip vocab extraction entirely
```

**Estimated cost: ~$0.03 for 13 episodes.** Measured on 2026-08-23 with `gemini-2.5-flash`:
6,302 input + 1,016 output tokens per episode ≈ $0.0022 each. The $10/month Google Cloud
credit from Google AI Pro covers roughly 4,500 episodes.

---

## Verification already done

`tests/test_llm_backend.py` — 19 tests covering backend dispatch, case/whitespace tolerance,
unknown-value fallback, `auto` with and without the CLI on PATH, shared JSON parsing,
timeout forwarding, and the auth-path precedence (service account beats manual token,
project derived from the key file, malformed key ignored, token cached not re-minted). Vendor calls are mocked, so CI needs no key and spends nothing.

```
pytest: 42 passed, 2 skipped
ruff:   clean on ingest/gemini_client.py, ingest/extract_vocab.py, tests/test_llm_backend.py
```

A **live** Vertex extraction was also run against a realistic 15-line transcript
(everything except the Supabase write): **14 items extracted, 14/14 schema-valid** —
correct `kind` enum values, timestamps matching the line each expression actually appears on
(the PWA uses these to seek audio), and definitions in the required
`English definition (한국어 gloss)` format. Sample: `walked that back` → `phrasal_verb`
`[15.1-21.0]`, `stonewalling` → `word` `[58.0-64.5]`.

So the only unproven link in the chain is the Supabase write, which is blocked purely on the key.

---

## Traps

**Auth is a service-account key — nothing expires, nothing to refresh.**
`.env.local` points `GOOGLE_APPLICATION_CREDENTIALS` at
`~/.config/gcloud/keys/roy-ai-credit-sa.json` (chmod 600, service account
`gemini-caller@roy-ai-credit.iam.gserviceaccount.com`, role `roles/aiplatform.user`).
`gemini_client.py` mints and caches its own access tokens from it. `vertex-setup` creates
the account and key; `vertex-setup --env <dir>` wires a project to it.

⚠️ Do **not** put `GOOGLE_VERTEX_TOKEN` (from `gcloud auth print-access-token`) into `.env`.
It expires in ~1h and the failure is silent. It remains supported only as a debug fallback
when no key file is present, and `backend()` reports it distinctly as `vertex-token`.

**The `x-goog-user-project` header** is mandatory when calling with a *user-account* token:
without it the request is attributed to gcloud's shared client project (`32555940559`) and
**the $10 credit is never drawn down** — the call still succeeds, so the failure is silent.
A service account belongs to the project so it does not need the header, but the client
sends it on both paths to keep one code path.

**AI Studio does not draw the credit.** A `GEMINI_API_KEY` — even one created inside
`roy-ai-credit` with billing linked — bills AI Studio's own prepay balance and returns
`429 "Your prepayment credits are depleted"`. Vertex is the only path to the credit.

**Model IDs**: only `gemini-2.5-flash`, `gemini-2.5-flash-lite`, and `gemini-2.5-pro` resolve
on Vertex `us-central1` for this account. Every `gemini-3.x` id returns a real 404 there even
though 3.x exists in the consumer Gemini app. Override with `GEMINI_MODEL_FAST` if this changes.

**zsh eats `"$var:generateContent"`** as a `:g` history modifier, mangling the URL into an
HTML 404 that looks like an API outage. Always write `"${var}:generateContent"`.

---

## Not done / possible next steps

- Commit the changed files (all uncommitted on `main`).
- `build_prompt()` still carries its `TODO(human)` placeholder prompt — the extraction quality
  above came from that placeholder, so tuning it to the owner's level is still open.
- The `E702` ruff warning on `ingest/store.py:57` predates this work and was left alone.
