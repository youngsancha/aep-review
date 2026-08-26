"""Regenerate tests/fixtures/transcripts/ — the committed corpus for the resegment parity test.

Why these exist: `data/transcripts/` is gitignored (pipeline output), so on CI or a fresh
checkout it is empty and tests/test_resegment_parity.py had nothing to compare — it SKIPPED,
which reads as green. That test is the only thing pinning ui/views/episode.js `resegment`/`trKey`
to their Python port in scripts/translate_transcripts.py, and a divergence there silently breaks
every `_ko.json` lookup (the app falls through to free machine translation and nobody notices).

Each fixture is a *contiguous head slice* of a real transcript — not synthesised — so the word
timings that drive resegment's gap rules stay realistic. The slice lengths below were chosen by
tracing which lines of resegment() each one executes: together they reach every line the full
4.2 MB corpus reaches, in 172 KB.

Usage (needs a populated data/transcripts/):
    python -m scripts.make_parity_fixtures            # write
    python -m scripts.make_parity_fixtures --check    # verify committed fixtures still match
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "transcripts"
DEST = ROOT / "tests" / "fixtures" / "transcripts"

# (episode id, segments to keep). Spread across all three shows so a show-specific segmentation
# branch cannot fall outside the comparison — the failure that hid the U.S./Ms. abbreviation bug.
SPEC: list[tuple[str, int]] = [
    ("470", 40),    # allears
    ("509", 60),    # allears — alone reaches full line coverage
    ("521", 40),    # aep
    ("522", 40),    # aep
    ("554", 60),    # wh briefing
    ("1024", 20),   # wh briefing, newest profile
]


def build(ep_id: str, n_segments: int) -> dict:
    tr = json.loads((SRC / f"{ep_id}.json").read_text(encoding="utf-8"))
    segs = (tr.get("segments") or [])[:n_segments]
    if len(segs) < n_segments:
        raise SystemExit(f"ep {ep_id}: only {len(segs)} segments, spec wants {n_segments}")
    last_end = segs[-1].get("end")
    return {
        "language": tr.get("language"),
        # Duration is trimmed to the slice, not copied from the source — a fixture that claims the
        # full episode's duration would be a small lie in committed test data.
        "duration": last_end,
        "segments": segs,
        "aligned": tr.get("aligned"),
        "r2_audio": tr.get("r2_audio"),
        "_fixture": {"source_episode": ep_id, "segments_kept": n_segments},
    }


def main() -> None:
    check = "--check" in sys.argv[1:]
    if not check:
        DEST.mkdir(parents=True, exist_ok=True)
    problems = []
    for ep_id, n in SPEC:
        if not (SRC / f"{ep_id}.json").exists():
            raise SystemExit(
                f"release aborted — {SRC.relative_to(ROOT)}/{ep_id}.json missing. "
                "Fixtures can only be regenerated on a machine with the transcript pipeline output."
            )
        payload = json.dumps(build(ep_id, n), ensure_ascii=False, separators=(",", ":"))
        out = DEST / f"{ep_id}.json"
        if check:
            if not out.exists():
                problems.append(f"{out.relative_to(ROOT)} missing")
            elif out.read_text(encoding="utf-8") != payload:
                problems.append(f"{out.relative_to(ROOT)} differs from the source slice")
        else:
            out.write_text(payload, encoding="utf-8")
            print(f"  wrote {out.relative_to(ROOT)}  ({len(payload) / 1024:.0f} KB, {n} segments)")
    if check:
        if problems:
            raise SystemExit("fixture check failed:\n  " + "\n  ".join(problems))
        print("fixtures match data/transcripts slices")


if __name__ == "__main__":
    main()
