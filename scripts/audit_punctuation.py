"""Find transcripts whose punctuation collapsed, and print the ids to repair.

Whisper sometimes loses sentence punctuation early in an episode and never gets it back, because each
segment is prompted with the text before it. The app then cuts sentences at its word cap, so both the
transcript and its translations read as fragments. transcribe_one() now catches this on new audio; this
script finds what was stored before that fix. Both use the same _punct_ratio and PUNCT_MIN.

    python -m scripts.audit_punctuation                       # per-show table
    python -m scripts.audit_punctuation --show cnn10 --ids    # comma list for the repair workflow

    gh workflow run aep-r2-upload.yml -f retranscribe_ids=<ids> -f retranscribe_limit=25

A repair takes about 11 minutes for a 10-minute episode (two passes) and the job budget is 300 minutes, so
send at most 25 ids at a time.

⛔ Repair and translation are one job. Sentence text is the translation key, and a repair changes nearly
every sentence: on the pilot (ep 985) only 14 of 153 sentences kept a stored translation. Every show has
translations now, and the daily loop only reaches the newest 50 per show, so follow each batch with

    AEP_LLM_BACKEND=ollama python -m scripts.translate_transcripts --ids <same ids>

which needs ollama and takes roughly 12 minutes per 10-minute episode.

Read-only. Trust a run only if it reports 0 download failures.
"""
from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import json
import os
import sys
import urllib.error
import urllib.request

from ingest.transcribe import PUNCT_MIN, _punct_ratio


def fetch_rows(sb) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:   # PostgREST silently caps a response at 1000 rows
        chunk = (sb.table("episodes").select("id,show").not_.is_("transcribed_at", "null")
                 .order("id").range(offset, offset + 999).execute().data)
        rows += chunk
        if len(chunk) < 1000:
            return rows
        offset += 1000


def read_ratio(base: str, row: dict) -> dict | None:
    """Ratio for one episode; None for a missing file. A transient failure raises, so it can be counted."""
    last: Exception | None = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(f"{base}{row['id']}.json", timeout=30) as r:
                return {**row, "ratio": _punct_ratio(json.load(r))}
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = e
        except OSError as e:
            last = e
    raise RuntimeError(f"episode {row['id']}: {last}")


def summarise(results: list[dict]) -> dict[str, dict]:
    by_show: dict[str, list[float]] = collections.defaultdict(list)
    for r in results:
        by_show[r["show"]].append(r["ratio"])
    return {show: {"n": len(v), "low": sum(1 for x in v if x < PUNCT_MIN), "median": sorted(v)[len(v) // 2]}
            for show, v in sorted(by_show.items())}


def low_ids(results: list[dict], show: str | None = None) -> list[int]:
    """Worst first, so a partial repair run fixes the most broken episodes."""
    low = [r for r in results if r["ratio"] < PUNCT_MIN and (show is None or r["show"] == show)]
    return [r["id"] for r in sorted(low, key=lambda r: r["ratio"])]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--show", help="limit to one show slug")
    p.add_argument("--ids", action="store_true", help="print only the comma-separated ids, worst first")
    args = p.parse_args()

    from dotenv import load_dotenv
    load_dotenv(".env")
    load_dotenv(".env.local", override=True)
    from ingest import store

    rows = fetch_rows(store.client())
    if args.show:
        rows = [r for r in rows if r["show"] == args.show]
    base = os.environ["SUPABASE_URL"].rstrip("/") + "/storage/v1/object/public/transcripts/"
    results: list[dict] = []
    failures = 0
    with cf.ThreadPoolExecutor(3) as ex:
        for fut in [ex.submit(read_ratio, base, r) for r in rows]:
            try:
                res = fut.result()
            except RuntimeError:
                failures += 1
                continue
            if res:
                results.append(res)

    if args.ids:
        print(",".join(str(i) for i in low_ids(results, args.show)))
    else:
        for show, s in summarise(results).items():
            print(f"{show:8} n={s['n']:4}  below {PUNCT_MIN}: {s['low']:4}  median {s['median']:.4f}")
    print(f"download failures: {failures}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
