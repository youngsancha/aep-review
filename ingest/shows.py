"""멀티-쇼 정의 — 인제스트(Python) 쪽 단일 출처.

프론트(ui/config.js) 의 SHOWS 와 slug·RSS 가 반드시 일치해야 한다(둘이 같은 쇼를 가리킴).
한 앱에서 두 영어 팟캐스트를 고른다: American English Podcast / All Ears English.
둘 다 Megaphone 호스팅이라 기존 megaphone clean-URL/R2 재전사 싱크가 공통 적용된다.

에피소드 id 는 두 쇼가 공유하는 단일 시퀀스(전역 유일)라 R2 키(`{id}.mp3`)·transcript 경로는
쇼별로 나눌 필요 없다. 쇼 구분은 episodes.show(slug) 컬럼 하나로 충분하다(dedupe 키 = (show, guid)).
"""
from __future__ import annotations

# source="rss": megaphone RSS + enclosure audio (cron_fetch/rss_fetch 경로).
# source="whitehouse": RSS 없음 — whitehouse.gov 브리핑 목록을 HTML 스크레이프 → yt-dlp 오디오 추출 →
#   R2 업로드 → R2 재STT(wh_fetch 경로). 미 연방정부 저작물이라 미국 내 퍼블릭 도메인(17 USC §105);
#   whitehouse.gov(공식 배포)를 소스로 삼는다. 별도 워크플로우 wh-sync.yml 로만 돈다(일일 cron 아님).
SHOWS: list[dict[str, str | None]] = [
    {
        "slug": "aep",
        "name": "American English Podcast",
        "source": "rss",
        "rss": "https://feeds.megaphone.fm/americanenglishpodcast",
    },
    {
        "slug": "allears",
        "name": "All Ears English",
        "source": "rss",
        "rss": "https://feeds.megaphone.fm/allearsenglish",
    },
    {
        "slug": "wh",
        "name": "White House Briefing",
        "source": "whitehouse",
        "rss": None,
        # whitehouse.gov 영상 목록에서 'press-briefings' 플레이리스트 필터.
        "listing": "https://www.whitehouse.gov/videos/?query-inherit-playlist_term=press-briefings",
    },
    {
        "slug": "cnn10",
        "name": "CNN 10",
        "source": "rss",
        # ⚠ rss.cnn.com/services/podcasting/cnn10/rss.xml 은 죽은 피드다 — video/mp4 이고
        # 마지막 항목이 2020-11 이다. 실제 오디오 피드는 Apple Podcasts(id 1766786641)
        # 역조회로 얻은 이 Megaphone 주소이고, aep/allears 와 같은 호스트라 기존
        # megaphone clean-URL/R2 재전사 싱크가 그대로 적용된다.
        "rss": "https://feeds.megaphone.fm/WMHY2232473209",
    },
]

SHOW_BY_SLUG: dict[str, dict[str, str | None]] = {s["slug"]: s for s in SHOWS}
DEFAULT_SHOW = "aep"


def show_slugs() -> list[str]:
    return [s["slug"] for s in SHOWS]


def rss_for(slug: str) -> str:
    s = SHOW_BY_SLUG.get(slug)
    if not s:
        raise KeyError(f"unknown show slug: {slug!r} (known: {show_slugs()})")
    rss = s.get("rss")
    if not rss:
        raise KeyError(f"show {slug!r} has no RSS (source={s.get('source')!r}); use its own fetch path")
    return rss
