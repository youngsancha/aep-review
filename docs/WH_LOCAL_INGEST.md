# White House briefings ('wh' show) — local ingest runbook

Status as of 2026-07-26. Read this before touching `ingest/wh_fetch.py` or
`.github/workflows/wh-sync.yml`.

## Why this exists

`wh` is the third show in E-Podcast: White House press briefings scraped from
whitehouse.gov (US federal works are public domain, 17 USC §105). There is no RSS
feed, so `ingest/wh_fetch.py` scrapes the briefings listing, resolves each page's
embedded video with `yt-dlp`, transcodes to mp3, inserts an `episodes` row, uploads
`{id}.mp3` to R2, and re-transcribes from R2 so the transcript matches the exact
bytes the app streams.

The pipeline was built to run in GitHub Actions, and that is the part that does not
work: **both audio sources block datacenter IPs.**

| Source | From GitHub Actions | From this Mac mini (residential IP) |
| --- | --- | --- |
| whitehouse.gov (YouTube embed) | "Sign in to confirm you're not a bot" | works |
| C-SPAN (self-hosted m3u8) | HTTP 403 (WAF) | works |

`player_client` extractor-args did not help; a `YT_COOKIES` secret would work but
needs periodic refreshing. So `wh-sync.yml` is **dispatch-only** (schedule commented
out) and the Mac mini is the real ingest path.

## Verified locally on the Mac mini (2026-07-26)

Every stage except the two credentialed writes was executed and passed:

- discovery — listing scrape returned 12 briefing slugs, dates parsed
- audio — `extract_audio()` on the Jun 18 2026 briefing produced a 56 MB mp3,
  `duration=2844`, correct title and `upload_date`
- R2 network — boto3 reached `*.r2.cloudflarestorage.com` and listed a sibling
  bucket; public reads from `pub-*.r2.dev` return 200. **The "local R2 is
  SNI-blocked" note in older handoffs is obsolete — the network path is fine.**
- STT — `faster-whisper` `medium.en` on a 60 s slice produced 25 segments in ~77 s
  (≈1.3× realtime on CPU, so a 47-minute briefing takes roughly an hour)

## The only remaining blocker: two write credentials

`ingest/store.py` needs `SUPABASE_SERVICE_KEY` (RLS bypass for inserts) and the R2
API token pair. Both already exist as encrypted GitHub Actions secrets, which are
write-only by design — they cannot be read back, so they have to be re-copied from
the dashboards once:

```bash
# Supabase → project lbcvuztpyaapyckxmqhk → Project Settings → API Keys → "Secret" (sb_secret_…)
pbpaste | ccsecret set aep-review SUPABASE_SERVICE_KEY

# Cloudflare → R2 → Manage R2 API Tokens → create/reveal a token with write access to aep-audio
pbpaste | ccsecret set aep-review R2_ACCESS_KEY_ID
pbpaste | ccsecret set aep-review R2_SECRET_ACCESS_KEY
```

`R2_ENDPOINT` is already pre-filled in `.env` (account endpoint inferred from the
sibling cnpod-review project — same Cloudflare account). If the first upload fails
with `NoSuchBucket`, store the real endpoint with
`pbpaste | ccsecret set aep-review R2_ENDPOINT`, which takes precedence over `.env`.

The first `ccsecret get` may raise a Keychain access dialog — choose "Always Allow".

## Running it

```bash
scripts/wh_local.sh --discover-only      # scrape only — needs NO credentials; use it to check
                                         # whitehouse.gov is reachable and the slug regex still
                                         # matches (exit 1 / "0 briefing(s)" means it broke)
scripts/wh_local.sh --list-only          # new slugs vs the DB (needs the Supabase key)
scripts/wh_local.sh --limit 1            # ingest the newest unloaded briefing, full STT
scripts/wh_local.sh --limit 3 --no-stt   # audio + rows now, transcripts later
scripts/wh_local.sh --cspan-urls "https://www.c-span.org/program/…/123456"
```

Secrets are pulled from the Keychain at runtime and exported; `python-dotenv` loads
`.env` with `override=False`, so the Keychain values win. Log: `~/Library/Logs/aep-wh-local.log`.

Start with `--limit 1`. It writes one row, one R2 object, one transcript — easy to
inspect in the app (show selector → White House) before committing to a backfill.

## Notes and traps

- `--no-vocab` is a CI concern only; the local path does not generate vocabulary.
- Briefings carry no dynamic ad insertion, so transcript/audio stay in sync — this
  is why `retranscribe_one(from_r2=True, remap=False)` is the right call here.
- One discovered slug has no trailing date (`…-brief-members-of-the-media`) and
  ingests with `pub_date=None`; `yt-dlp`'s `upload_date` fills it in.
- Anonymous Supabase reads return zero rows for every show — RLS is owner-scoped, so
  do not read an empty REST response as "the table is empty".
- If a scheduled local run is ever wanted, a LaunchAgent calling `wh_local.sh` is the
  natural home, replacing the disabled CI cron. Nothing is installed today.
