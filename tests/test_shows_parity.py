"""멀티-쇼 SSOT 파리티 — ingest/shows.py(Python) ↔ ui/config.js(JS) 의 slug+rss 일치 보장.

둘이 같은 쇼를 가리켜야 인제스트(write)와 프론트(read)가 어긋나지 않는다. 한쪽만 고치면
이 테스트가 깨져 SSOT 이탈을 즉시 잡는다. 외부호출 없음(파일 텍스트 파싱만).
"""
from __future__ import annotations

import re
from pathlib import Path

from ingest import shows

CONFIG_JS = Path(__file__).resolve().parent.parent / "ui" / "config.js"


def _js_shows() -> list[tuple[str, str | None]]:
    """config.js 의 SHOWS 에서 (slug, rss) 를 문서 순서대로 추출. rss 는 문자열 또는 null."""
    src = CONFIG_JS.read_text(encoding="utf-8")
    # SHOWS = [ ... ]; 블록만 잘라 각 쇼 객체({ ... })별로 slug + rss(문자열|null)를 읽는다.
    m = re.search(r"export const SHOWS = \[(.*?)\];", src, re.S)
    assert m, "config.js 에서 SHOWS 배열을 못 찾음"
    block = m.group(1)
    out: list[tuple[str, str | None]] = []
    # slug 단위로 쇼 객체를 나눠, 그 안에서 rss 값(따옴표 문자열 또는 null)을 찾는다.
    for om in re.finditer(r"slug:\s*'([^']+)'(.*?)(?=slug:\s*'|$)", block, re.S):
        slug, body = om.group(1), om.group(2)
        rm = re.search(r"rss:\s*(?:'([^']+)'|null)", body)
        out.append((slug, rm.group(1) if (rm and rm.group(1)) else None))
    return out


def test_slug_and_rss_parity():
    py = [(s["slug"], s["rss"]) for s in shows.SHOWS]
    js = _js_shows()
    assert py == js, f"shows.py {py} != config.js {js}"


def test_default_show_matches():
    src = CONFIG_JS.read_text(encoding="utf-8")
    m = re.search(r"export const DEFAULT_SHOW = '([^']+)'", src)
    assert m and m.group(1) == shows.DEFAULT_SHOW == "aep"


def test_rss_for_known_and_unknown():
    assert shows.rss_for("allears").endswith("/allearsenglish")
    try:
        shows.rss_for("nope")
        assert False, "unknown slug 은 KeyError 여야"
    except KeyError:
        pass
