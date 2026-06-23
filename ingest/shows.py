"""멀티-쇼 정의 — 인제스트(Python) 쪽 단일 출처.

프론트(ui/config.js) 의 SHOWS 와 slug·RSS 가 반드시 일치해야 한다(둘이 같은 쇼를 가리킴).
한 앱에서 두 영어 팟캐스트를 고른다: American English Podcast / All Ears English.
둘 다 Megaphone 호스팅이라 기존 megaphone clean-URL/R2 재전사 싱크가 공통 적용된다.

에피소드 id 는 두 쇼가 공유하는 단일 시퀀스(전역 유일)라 R2 키(`{id}.mp3`)·transcript 경로는
쇼별로 나눌 필요 없다. 쇼 구분은 episodes.show(slug) 컬럼 하나로 충분하다(dedupe 키 = (show, guid)).
"""
from __future__ import annotations

SHOWS: list[dict[str, str]] = [
    {
        "slug": "aep",
        "name": "American English Podcast",
        "rss": "https://feeds.megaphone.fm/americanenglishpodcast",
    },
    {
        "slug": "allears",
        "name": "All Ears English",
        "rss": "https://feeds.megaphone.fm/allearsenglish",
    },
]

SHOW_BY_SLUG: dict[str, dict[str, str]] = {s["slug"]: s for s in SHOWS}
DEFAULT_SHOW = "aep"


def show_slugs() -> list[str]:
    return [s["slug"] for s in SHOWS]


def rss_for(slug: str) -> str:
    s = SHOW_BY_SLUG.get(slug)
    if not s:
        raise KeyError(f"unknown show slug: {slug!r} (known: {show_slugs()})")
    return s["rss"]
