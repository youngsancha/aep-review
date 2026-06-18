"""American English Podcast RSS 피드 → episodes 테이블 적재.

guid 기반 dedupe. mp3 다운로드는 audio_download.py 가 별도 처리.

CLI:
    python -m ingest.rss_fetch --limit 5
    python -m ingest.rss_fetch --all      # 263화 전체 메타 적재
"""
from __future__ import annotations

import argparse
import logging
import re
from datetime import datetime, timezone
from typing import Any

import feedparser

from ingest import store

log = logging.getLogger(__name__)

RSS_URL = "https://feeds.megaphone.fm/americanenglishpodcast"

# "211 - Preposition Party 🎉: ..." → episode_no 211
# "⭐ Feature: 5-Minute English ..." → episode_no None
EP_NUM_RE = re.compile(r"^\s*(\d+)\s*[-:.]")


def _parse_episode_no(title: str, itunes_episode: Any) -> int | None:
    if itunes_episode is not None:
        try:
            return int(itunes_episode)
        except (ValueError, TypeError):
            pass
    m = EP_NUM_RE.match(title)
    return int(m.group(1)) if m else None


def _to_iso(struct_time) -> str:
    if not struct_time:
        return ""
    dt = datetime(*struct_time[:6], tzinfo=timezone.utc)
    return dt.isoformat()


def _audio_url(entry) -> str | None:
    for enc in entry.get("enclosures", []):
        if "audio" in (enc.get("type") or ""):
            return enc.get("href")
    return None


def fetch_feed(limit: int | None = None) -> list[dict[str, Any]]:
    """RSS 파싱 → 정규화된 dict 리스트. 최신순."""
    parsed = feedparser.parse(RSS_URL)
    if parsed.bozo and not parsed.entries:
        raise RuntimeError(f"RSS parse failed: {parsed.bozo_exception}")

    out: list[dict[str, Any]] = []
    for entry in parsed.entries:
        guid = entry.get("id") or entry.get("guid") or entry.get("link")
        if not guid:
            continue
        title = (entry.get("title") or "").strip()
        out.append({
            "guid": guid,
            "title": title,
            "pub_date": _to_iso(entry.get("published_parsed")) or entry.get("published") or "",
            "season": int(entry["itunes_season"]) if entry.get("itunes_season") else None,
            "episode_no": _parse_episode_no(title, entry.get("itunes_episode")),
            "duration_sec": _duration_sec(entry.get("itunes_duration")),
            "description": entry.get("summary") or entry.get("description") or "",
            "audio_url": _audio_url(entry),
        })
        if limit and len(out) >= limit:
            break
    return out


def _duration_sec(s: str | None) -> int | None:
    if not s:
        return None
    s = str(s).strip()
    if s.isdigit():
        return int(s)
    parts = s.split(":")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    if len(nums) == 3:
        h, m, sec = nums
        return h * 3600 + m * 60 + sec
    if len(nums) == 2:
        m, sec = nums
        return m * 60 + sec
    return None


def upsert_episodes(items: list[dict[str, Any]]) -> tuple[int, int]:
    """신규만 Supabase 에 적재. 반환: (added, skipped)."""
    return store.upsert_episodes(items)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None, help="처음 N 개만 (최신순)")
    p.add_argument("--all", action="store_true", help="피드 전체")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    limit = None if args.all else (args.limit or 5)
    items = fetch_feed(limit=limit)
    added, skipped = upsert_episodes(items)
    log.info("fetched=%d added=%d skipped=%d", len(items), added, skipped)


if __name__ == "__main__":
    main()
