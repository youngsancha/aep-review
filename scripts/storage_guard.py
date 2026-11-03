"""Storage guard: drain retired buckets and warn before the free-plan Storage cap bites.

The org was restricted on 2026-10-11 (Storage 1.25 GB against the 1.1 GB free quota): every
API call, service key included, answered 402 until the quota refilled on 2026-10-18. The quota
is the billing-period AVERAGE size, so a cleanup only helps if it happens early in a cycle —
that is why this runs daily instead of when someone notices.

1. Any bucket in RETIRED is emptied object by object, verified empty, then deleted.
   `aep-tts` (was `tts` in the old project) = Study speech mp3s, retired with Study in v1.80.0 (the SW answers 410 for them).
2. The remaining aep-* buckets (never other apps' buckets on roy-hub) are measured; above WARN_BYTES a td-task is filed (de-duplicated).

Idempotent: once the retired buckets are gone it is a few list calls and exits 0.

    python -m scripts.storage_guard            # drain + measure
    python -m scripts.storage_guard --dry-run  # measure only
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from typing import Any, Iterator

from ingest import store

# Only buckets with this prefix are ever listed, measured or deleted: roy-hub is shared with other
# apps whose buckets (and whose own `tts`, if any) are not ours to touch. The old standalone project's
# `tts` bucket was never copied to roy-hub, so the retired entry is `aep-tts` and normally absent (no-op).
PREFIX = "aep-"
RETIRED = ("aep-tts",)
PAGE = 1000          # Storage list page size
REMOVE_BATCH = 500   # paths per remove() call
# The org is now on Pro with a 100 GB pooled quota shared by every app on roy-hub, so 5 GB for the
# aep- buckets alone is the point where it is worth a look (the old free-plan 1 GB cap no longer applies).
WARN_BYTES = 5_000_000_000


def walk(bucket: Any, prefix: str = "") -> Iterator[tuple[str, int]]:
    """Every object under prefix as (path, size). Folders come back with id None."""
    offset = 0
    while True:
        items = bucket.list(prefix, {"limit": PAGE, "offset": offset}) or []
        for it in items:
            path = f"{prefix}/{it['name']}" if prefix else it["name"]
            if it.get("id") is None:
                yield from walk(bucket, path)
            else:
                yield path, int((it.get("metadata") or {}).get("size") or 0)
        if len(items) < PAGE:
            return
        offset += PAGE


def drain(storage: Any, bucket_id: str) -> tuple[int, int]:
    """Remove every object in bucket_id, verify it is empty, delete it. Returns (count, bytes)."""
    bucket = storage.from_(bucket_id)
    objects = list(walk(bucket))  # collect first: deleting while paging shifts the offsets
    for i in range(0, len(objects), REMOVE_BATCH):
        bucket.remove([p for p, _ in objects[i:i + REMOVE_BATCH]])
    left = sum(1 for _ in walk(bucket))
    if left:
        raise RuntimeError(f"{bucket_id}: {left} objects still present after remove — bucket kept")
    storage.delete_bucket(bucket_id)
    return len(objects), sum(s for _, s in objects)


def _warn(total: int) -> None:
    title = (f"Supabase Storage (aep- buckets) at {total / 1e9:.2f} GB (warn at "
             f"{WARN_BYTES / 1e9:.1f} GB, pooled org quota 100 GB) — move assets to R2")
    print(f"WARNING: {title}")
    if shutil.which("td-task"):
        subprocess.run(["td-task", "add", title, "-P", "aep-review", "-p", "1"], check=False)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="measure only, delete nothing")
    args = ap.parse_args(argv)

    storage = store.client().storage
    present = {b.id for b in storage.list_buckets() if b.id.startswith(PREFIX)}
    for bucket_id in RETIRED:
        if bucket_id not in present:
            continue
        if args.dry_run:
            objs = list(walk(storage.from_(bucket_id)))
            print(f"[dry-run] {bucket_id}: would remove {len(objs)} objects, "
                  f"{sum(s for _, s in objs) / 1e6:.1f} MB")
            continue
        n, size = drain(storage, bucket_id)
        print(f"{bucket_id}: removed {n} objects, {size / 1e6:.1f} MB; bucket deleted")
        present.discard(bucket_id)

    total = 0
    for bucket_id in sorted(present):
        objs = list(walk(storage.from_(bucket_id)))
        size = sum(s for _, s in objs)
        total += size
        print(f"{bucket_id}: {len(objs)} objects, {size / 1e6:.1f} MB")
    print(f"total: {total / 1e9:.3f} GB")
    if total > WARN_BYTES:
        _warn(total)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # storage3 masks a 402 restriction as KeyError('error'); show the cause
        print(f"storage_guard failed: {e.__context__ or e}", file=sys.stderr)
        sys.exit(1)
