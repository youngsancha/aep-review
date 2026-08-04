"""Pre-generate every Study/SRS/Essentials voice line with **Kokoro** and upload to
Storage `tts/{sha1}.mp3`, so the app plays Kokoro instead of the Edge Neural voice.

Why pre-generate instead of calling Kokoro at runtime
----------------------------------------------------
Kokoro runs on the Mac mini (speakloop gateway, mlx-audio on the Metal GPU). The app is a
static PWA used in a car — on cellular, sometimes fully offline. A runtime call would need
the mini awake, a tunnel host that does not churn, and a network round trip per phrase, and
it would be dead offline. Pre-generated files reuse the machinery that already exists: the
same `sha1(voice|rate|text)` key as `ui/tts.js`, the same Storage bucket, the same service
worker cache. The client change is three lines.

Contract with the client (`ui/tts.js`)
--------------------------------------
Key = ``sha1(f"{VOICE}|{RATE}|{text}")`` with VOICE/RATE below. `ui/tts.js` computes the
identical key, so a file uploaded here is found by `speak()` with no lookup table.
The gateway returns WAV; we transcode to mp3 (ffmpeg) because the bucket serves
`audio/mpeg` and a WAV is ~6x the bytes for the same phrase.

    scripts/kokoro_pregen.sh                  # wrapper: Keychain secrets + venv
    python -m scripts.pregen_kokoro_tts --limit 50      # smoke a small batch
    python -m scripts.pregen_kokoro_tts                 # everything (resumable)

Resumability: the job is idempotent — it lists the bucket first and skips keys already
there — so re-running after any interruption picks up where it stopped.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from ingest import store

# ── Kokoro identity. Must match ui/tts.js KOKORO_VOICE / DEFAULT_RATE. ──────────────
VOICE = "kokoro-af_heart"
RATE = "+0%"
# The speakloop gateway's CORS-open one-shot endpoint (gateway/app.py::api_tts).
GATEWAY = os.environ.get("KOKORO_TTS_URL", "http://127.0.0.1:8788/api/tts")
GATEWAY_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")

PACK = Path(__file__).resolve().parent.parent / "ui" / "data" / "essentials.json"

# The gateway truncates at 500 chars; anything longer would be silently cut mid-sentence,
# so skip it and let the client fall back rather than upload a half phrase.
MAX_CHARS = 500
# A wall of failures means the gateway died or the GPU is wedged — retrying then only
# burns hours and exits 0, which reads as "finished". (Same trap the translation backfill
# hit: a quota wall is not a transient error.)
MAX_CONSECUTIVE_FAILS = 15


def kokoro_key(text: str) -> str:
    return hashlib.sha1(f"{VOICE}|{RATE}|{text}".encode("utf-8")).hexdigest()


def _collect_texts() -> list[str]:
    """Every string the app can hand to speak(), newest episode first.

    Study/SRS/Essentials only ever speak a vocab term, a vocab example sentence, or an
    essentials term/example — all bounded sets. (Drills reuse example_sentence; nothing
    speaks a raw transcript line.) Order matters: this job runs for hours, and the newest
    episodes are the ones the user is actually studying today.
    """
    rows: list[dict[str, Any]] = []
    page = 0
    while True:
        chunk = (
            store.client()
            .table("vocab_cards")
            .select("term,example_sentence,episode_id")
            .order("episode_id", desc=True)
            .range(page * 1000, page * 1000 + 999)
            .execute()
            .data
        )
        rows.extend(chunk)
        if len(chunk) < 1000:
            break
        page += 1

    texts: list[str] = []
    for r in rows:
        for k in ("term", "example_sentence"):
            v = (r.get(k) or "").strip()
            if v:
                texts.append(v)

    pack = json.loads(PACK.read_text(encoding="utf-8"))
    for c in pack["cards"]:
        for k in ("term", "example"):
            v = (c.get(k) or "").strip()
            if v:
                texts.append(v)

    seen: set[str] = set()
    out: list[str] = []
    for t in texts:                      # dedupe but KEEP the newest-first order
        if t not in seen and len(t) <= MAX_CHARS:
            seen.add(t)
            out.append(t)
    return out


def _to_mp3(wav: bytes) -> bytes:
    """WAV (gateway, 24 kHz mono) → mp3. 64k mono is transparent for speech and lands
    ~6x smaller, which matters across ~10k files in a 1 GB Storage tier."""
    p = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0",
         "-codec:a", "libmp3lame", "-b:a", "64k", "-ac", "1", "-f", "mp3", "pipe:1"],
        input=wav, capture_output=True, check=True,
    )
    return p.stdout


async def _synth(client: httpx.AsyncClient, text: str) -> bytes:
    r = await client.get(GATEWAY, params={"text": text, "voice": GATEWAY_VOICE}, timeout=120)
    r.raise_for_status()
    return r.content


async def run(limit: int | None, concurrency: int) -> int:
    texts = _collect_texts()
    existing = store.existing_tts_names()
    pending = [t for t in texts if f"{kokoro_key(t)}.mp3" not in existing]
    todo = pending[:limit] if limit else pending
    # Count BEFORE --limit truncates, or a 6-item smoke run reports "9104 already done"
    # and a partial batch reads as a finished one.
    print(f"texts={len(texts)}  already in Storage={len(texts) - len(pending)}  "
          f"pending={len(pending)}  this run={len(todo)}", flush=True)
    if not todo:
        return 0

    bucket = store.client().storage.from_("tts")
    # storage3's httpx client is not safe to share across threads (HTTP/2 multiplexing),
    # so synthesis fans out but uploads go through this lock — same rule as store.pregen_tts.
    upload_lock = asyncio.Lock()
    sem = asyncio.Semaphore(concurrency)
    done = 0
    fails = 0
    consecutive = 0
    t0 = time.time()
    stop = asyncio.Event()

    async with httpx.AsyncClient() as client:
        async def one(text: str) -> None:
            nonlocal done, fails, consecutive
            if stop.is_set():
                return
            async with sem:
                if stop.is_set():
                    return
                try:
                    mp3 = _to_mp3(await _synth(client, text))
                    async with upload_lock:
                        await asyncio.to_thread(
                            bucket.upload,
                            path=f"{kokoro_key(text)}.mp3", file=mp3,
                            file_options={"content-type": "audio/mpeg", "upsert": "true"},
                        )
                except Exception as e:                       # noqa: BLE001 - report, keep going
                    fails += 1
                    consecutive += 1
                    print(f"  FAIL ({consecutive}) {text[:48]!r}: {e}", flush=True)
                    if consecutive >= MAX_CONSECUTIVE_FAILS:
                        stop.set()
                    return
                consecutive = 0
                done += 1
                if done % 50 == 0:
                    el = time.time() - t0
                    rate = done / el
                    left = (len(todo) - done) / rate if rate else 0
                    print(f"  {done}/{len(todo)}  {rate:.1f}/s  ~{left / 60:.0f} min left",
                          flush=True)

        await asyncio.gather(*(one(t) for t in todo))

    print(f"uploaded={done}  failed={fails}  elapsed={(time.time() - t0) / 60:.1f} min")
    if stop.is_set():
        print(f"ABORTED after {MAX_CONSECUTIVE_FAILS} consecutive failures — the gateway is "
              f"probably down. Re-run once it is back; finished files are skipped.",
              file=sys.stderr)
        return 2
    return 0


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="only the first N pending texts")
    ap.add_argument("--concurrency", type=int, default=2,
                    help="parallel synth calls (the GPU serialises anyway; >3 just queues)")
    a = ap.parse_args()
    return asyncio.run(run(a.limit, a.concurrency))


if __name__ == "__main__":
    raise SystemExit(main())
