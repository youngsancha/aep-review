"""White House 브리핑 인제스트 — E-Podcast 세 번째 쇼('wh').

RSS 가 없는 소스라 rss_fetch 를 못 쓴다. 흐름:
  1. whitehouse.gov 'press-briefings' 목록 페이지(들)를 HTML 스크레이프 → 브리핑 페이지 슬러그 수집.
     슬러그가 곧 안정적 guid (예: press-secretary-...-jul-23-2026), 날짜는 슬러그에서 파싱.
  2. episodes(show='wh') 의 기존 guid 와 대조해 신규만.
  3. 신규 각각: yt-dlp 로 whitehouse.gov 페이지의 임베드 오디오 추출(→ 임시 mp3, ffmpeg).
  4. episodes 행 insert(show='wh') → 반환 id → 그 mp3 를 R2 {id}.mp3 로 업로드 →
     retranscribe_one(from_r2=True, remap=False) 로 R2 오디오를 STT → transcript(r2_audio=true)+mark_hosted.
     (앱은 r2_audio=true 회차를 R2 스트리밍 → 자막≡오디오 완벽 싱크. 브리핑은 DAI 광고가 없어 드리프트 없음.)

법적: 미 연방정부 저작물(백악관 브리핑)은 미국 내 퍼블릭 도메인(17 USC §105). 공식 배포처인
whitehouse.gov 를 소스로 한다. 단일 사용자·개인용 앱.

로컬에선 SUPABASE_SERVICE_KEY(빈 .env)·R2 자격증명이 없어 end-to-end 실행 불가 → CI(wh-sync.yml)에서만
전체가 돈다. 오디오 추출부(yt-dlp→mp3)는 로컬에서 검증됨. vocab 은 CI 에서 생략(--no-vocab), 로컬 Claude 로.

사용:
    python -m ingest.wh_fetch --limit 3            # 최신 미적재 브리핑 3개
    python -m ingest.wh_fetch --list-only          # 발견된 신규 슬러그만 출력(네트워크 조회, DB 미기록)
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

log = logging.getLogger("wh_fetch")

SHOW = "wh"
LISTING_URL = "https://www.whitehouse.gov/videos/?query-inherit-playlist_term=press-briefings"
PAGE_URL = "https://www.whitehouse.gov/videos/{slug}/"
_UA = "Mozilla/5.0 (compatible; epodcast-ingest/1.0)"

_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
# 슬러그 끝의 날짜: '...-jul-23-2026' / '...-mar-4-2026'
_DATE_RE = re.compile(r"-([a-z]{3})-(\d{1,2})-(\d{4})$")
# 목록 HTML 에서 브리핑 페이지 슬러그 — 실제 패턴 '...brief(s)-members-of-the-media-DATE'.
# 'brief' 만 매칭하면 'not-a-briefing' 같은 비-브리핑도 걸리므로 'members-of-the-media' 까지 요구.
_SLUG_RE = re.compile(r"/videos/([a-z0-9-]*brief[a-z0-9-]*members-of-the-media[a-z0-9-]*)/")


def _fetch(url: str) -> str:
    req = Request(url, headers={"User-Agent": _UA})
    with urlopen(req, timeout=45) as r:  # noqa: S310 (고정 whitehouse.gov 도메인)
        return r.read().decode("utf-8", "replace")


# ─────────────────────────── 순수 헬퍼(단위검증) ───────────────────────────

def parse_slugs(html: str) -> list[str]:
    """목록 HTML → 브리핑 슬러그(등장순·중복 제거). 순수 함수."""
    seen: dict[str, None] = {}
    for m in _SLUG_RE.finditer(html):
        seen.setdefault(m.group(1), None)
    return list(seen.keys())


def slug_to_pubdate(slug: str) -> str | None:
    """슬러그 끝 날짜 → 'YYYY-MM-DD'. 못 찾으면 None. 순수 함수."""
    m = _DATE_RE.search(slug)
    if not m:
        return None
    mon = _MONTHS.get(m.group(1))
    if not mon:
        return None
    return f"{int(m.group(3)):04d}-{mon:02d}-{int(m.group(2)):02d}"


def title_from_slug(slug: str) -> str:
    """슬러그 → 사람이 읽는 제목(메타데이터 없을 때 폴백). 순수 함수."""
    base = _DATE_RE.sub("", slug).replace("-", " ").strip()
    return base[:1].upper() + base[1:] if base else slug


# ─────────────────────────── yt-dlp 추출 ───────────────────────────

def extract_audio(page_url: str, out_mp3: Path) -> dict[str, Any]:
    """whitehouse.gov 브리핑 페이지 → 임베드 오디오를 mp3 로. 반환: {title, duration}.
    yt-dlp(generic→youtube 임베드 해석) + ffmpeg. format 140(m4a) 우선, 없으면 bestaudio.
    메타데이터는 --write-info-json 으로 받아 title/duration 을 안정적으로 읽는다."""
    import json

    base = out_mp3.with_suffix("")   # yt-dlp 가 .mp3 / .info.json 을 붙임
    # CI(데이터센터 IP)에선 YouTube 가 익명 추출을 봇으로 막는다("Sign in to confirm…"). 로컬(주거용
    # IP)에선 통과. 우회: ① player_client 를 tv/web_safari/mweb 로(봇체크에 덜 걸리는 클라이언트),
    # ② YT_COOKIES(넷스케이프 쿠키 파일 내용) 시크릿이 있으면 --cookies 로 인증(가장 확실).
    extra: list[str] = ["--extractor-args", "youtube:player_client=tv,web_safari,mweb,default"]
    cookiefile = None
    cookies = os.environ.get("YT_COOKIES")
    if cookies:
        cookiefile = base.with_suffix(".cookies.txt")
        cookiefile.write_text(cookies, "utf-8")
        extra += ["--cookies", str(cookiefile)]
    # `python -m yt_dlp` (콘솔 스크립트 대신) — venv 든 CI 든 같은 인터프리터의 모듈을 쓴다
    # (로컬 venv 엔 yt-dlp 바이너리가 PATH 에 없을 수 있어 FileNotFound 방지).
    cmd = [
        sys.executable, "-m", "yt_dlp", "-f", "140/bestaudio/best",
        "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0",
        "--write-info-json", "--no-playlist",
        "--socket-timeout", "60", "--no-warnings", "--quiet",
        *extra,
        "-o", str(base) + ".%(ext)s", page_url,
    ]
    try:
        subprocess.run(cmd, check=True, timeout=1800)
    finally:
        if cookiefile:
            cookiefile.unlink(missing_ok=True)
    title, dur, update = "", None, None
    info = base.with_suffix(".info.json")
    if info.exists():
        try:
            d = json.loads(info.read_text("utf-8"))
            title = (d.get("title") or "").strip()
            if d.get("duration") is not None:
                dur = int(float(d["duration"]))
            ud = d.get("upload_date") or d.get("release_date")   # yt-dlp: YYYYMMDD
            if ud and len(str(ud)) == 8:
                update = f"{str(ud)[:4]}-{str(ud)[4:6]}-{str(ud)[6:8]}"
        except (ValueError, OSError):
            pass
        info.unlink(missing_ok=True)
    return {"title": title, "duration": dur, "upload_date": update}


# ─────────────────────────── 신규 발견 ───────────────────────────

def discover_new(limit: int | None) -> list[str]:
    """목록 스크레이프 + DB 대조 → 신규 슬러그(최신 우선, 목록 순서 = 최신순)."""
    from ingest import store
    html = _fetch(LISTING_URL)
    slugs = parse_slugs(html)
    have = store.existing_guids(SHOW)
    fresh = [s for s in slugs if s not in have]
    return fresh[: (limit or len(fresh))]


# ─────────────────────────── 적재 ───────────────────────────

def _r2_public_url(ep_id: int) -> str:
    base = (os.environ.get("R2_PUBLIC_BASE") or "").rstrip("/")
    return f"{base}/{ep_id}.mp3"


# C-SPAN 프로그램 URL → 안정적 guid. '/program/.../{id}' 의 끝 숫자 ID 를 쓴다.
_CSPAN_ID_RE = re.compile(r"c-span\.org/(?:program|event|video)/(?:[a-z0-9-]+/)*(\d{4,})")


def cspan_guid(url: str) -> str | None:
    m = _CSPAN_ID_RE.search(url)
    return f"cspan-{m.group(1)}" if m else None


def ingest_page(page_url: str, guid: str, pub_date: str | None, title_fallback: str,
                do_stt: bool = True) -> dict[str, Any]:
    """소스 무관 코어: 오디오 추출 → episodes insert → R2 업로드 → (옵션) R2 재STT. 반환 요약.
    whitehouse.gov(YouTube 임베드)·C-SPAN(자체 m3u8) 둘 다 extract_audio 로 처리된다
    (yt-dlp '-f 140/bestaudio/best' → YouTube 는 140, C-SPAN 은 bestaudio 로 폴백)."""
    from ingest import store
    from scripts.retranscribe import retranscribe_one

    with tempfile.TemporaryDirectory(prefix="wh_") as tmp:
        mp3 = Path(tmp) / "a.mp3"
        meta = extract_audio(page_url, mp3)
        if not mp3.exists() or mp3.stat().st_size < 10_000:
            raise RuntimeError(f"audio extract produced no/empty file for {guid}")
        title = meta.get("title") or title_fallback
        row = {
            "guid": guid, "season": None, "episode_no": None,
            "title": title, "pub_date": pub_date or meta.get("upload_date"),
            "duration_sec": meta.get("duration"),
            "description": f"White House press briefing — {page_url}",
            "audio_url": page_url,      # 임시 폴백(비-null 필수); R2 업로드 후 R2 URL 로 교체
            "show": SHOW, "created_at": store._now(),
        }
        res = store.client().table("episodes").insert(row).execute()
        ep_id = res.data[0]["id"]
        store.upload_audio_r2(ep_id, mp3)   # R2 {id}.mp3
        store.client().table("episodes").update({"audio_url": _r2_public_url(ep_id)}).eq("id", ep_id).execute()
    out: dict[str, Any] = {"guid": guid, "id": ep_id, "title": title}
    if do_stt:
        # from_r2: 방금 올린 R2 오디오를 STT → 자막≡오디오. remap=False(신규라 재매핑 대상 없음).
        r = retranscribe_one({"id": ep_id}, remap=False, host_r2=False, from_r2=True)
        out["segments"] = r.get("segments")
    return out


def ingest_one(slug: str, do_stt: bool = True) -> dict[str, Any]:
    """whitehouse.gov 브리핑 1건(슬러그)."""
    return ingest_page(PAGE_URL.format(slug=slug), guid=slug,
                       pub_date=slug_to_pubdate(slug), title_fallback=title_from_slug(slug), do_stt=do_stt)


def run(limit: int | None = 3, do_stt: bool = True, cspan_urls: list[str] | None = None) -> dict[str, Any]:
    """cspan_urls 지정 시: 그 C-SPAN 프로그램들만 적재(반자동, 쿠키 불필요). 아니면 whitehouse.gov 자동 발견."""
    from ingest import store
    done, errs = [], []
    if cspan_urls:
        have = store.existing_guids(SHOW)
        targets = [(u, cspan_guid(u)) for u in cspan_urls]
        fresh = [(u, g) for (u, g) in targets if g and g not in have]
        log.info("wh(cspan): %d url(s), %d new: %s", len(cspan_urls), len(fresh), [g for _, g in fresh])
        for url, g in fresh:
            try:
                done.append(ingest_page(url, guid=g, pub_date=None, title_fallback="White House Daily Briefing", do_stt=do_stt))
                log.info("wh(cspan): ingested %s", g)
            except Exception as e:  # noqa: BLE001
                log.exception("wh(cspan): FAILED %s", url)
                errs.append({"url": url, "error": str(e)[:200]})
        return {"new": len(fresh), "ingested": len(done), "errors": errs, "items": done}

    fresh = discover_new(limit)
    log.info("wh: discovered %d new briefing(s): %s", len(fresh), fresh)
    for slug in fresh:
        try:
            done.append(ingest_one(slug, do_stt=do_stt))
            log.info("wh: ingested %s", slug)
        except Exception as e:  # noqa: BLE001 — 한 건 실패가 나머지를 막지 않게
            log.exception("wh: FAILED %s", slug)
            errs.append({"slug": slug, "error": str(e)[:200]})
    return {"new": len(fresh), "ingested": len(done), "errors": errs, "items": done}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=3, help="최신 미적재 브리핑 N개 (기본 3)")
    p.add_argument("--all", action="store_true", help="발견된 신규 전부")
    p.add_argument("--no-stt", action="store_true", help="STT 생략(오디오+행만; 자막은 나중에)")
    p.add_argument("--list-only", action="store_true", help="신규 슬러그만 출력(DB 미기록)")
    p.add_argument("--cspan-urls", default=None,
                   help="C-SPAN 프로그램 URL 콤마구분(반자동, 쿠키불필요). 지정 시 whitehouse.gov 자동발견 대신 이것만 적재")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.list_only:
        for s in discover_new(None if args.all else args.limit):
            print(s, "→", slug_to_pubdate(s))
        return 0
    cspan = [u.strip() for u in args.cspan_urls.split(",") if u.strip()] if args.cspan_urls else None
    res = run(limit=None if args.all else args.limit, do_stt=not args.no_stt, cspan_urls=cspan)
    log.info("wh done: %s", {k: v for k, v in res.items() if k != "items"})
    return 1 if res["errors"] and not res["ingested"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
