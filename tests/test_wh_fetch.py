"""wh_fetch 순수 로직 단위검증 — 네트워크/DB/yt-dlp 없이 파싱만.

end-to-end(discover_new/ingest_one)는 Supabase 서비스키·R2·yt-dlp 가 필요해 CI(wh-sync.yml)에서만
검증된다. 여기선 목록 HTML 파싱 + 슬러그→날짜/제목의 순수 함수만 고정한다.
"""
from ingest import wh_fetch as w


def test_parse_slugs_dedup_and_order():
    html = """
      <a href="/videos/press-secretary-karoline-leavitt-briefs-members-of-the-media-jul-23-2026/">x</a>
      <a href="/videos/vice-president-jd-vance-briefs-members-of-the-media-jun-18-2026/">y</a>
      <a href="/videos/press-secretary-karoline-leavitt-briefs-members-of-the-media-jul-23-2026/">dup</a>
      <a href="/videos/some-remarks-not-a-briefing-jul-1-2026/">no</a>
    """
    slugs = w.parse_slugs(html)
    assert slugs == [
        "press-secretary-karoline-leavitt-briefs-members-of-the-media-jul-23-2026",
        "vice-president-jd-vance-briefs-members-of-the-media-jun-18-2026",
    ]  # 'brief' 없는 슬러그 제외, 등장순 + 중복 제거


def test_slug_to_pubdate():
    assert w.slug_to_pubdate("press-secretary-x-briefs-media-jul-23-2026") == "2026-07-23"
    assert w.slug_to_pubdate("x-briefs-media-mar-4-2026") == "2026-03-04"   # 한 자리 일 → zero-pad
    assert w.slug_to_pubdate("x-briefs-media-dec-31-2025") == "2025-12-31"
    assert w.slug_to_pubdate("no-date-here") is None
    assert w.slug_to_pubdate("bad-month-xyz-3-2026") is None


def test_title_from_slug_strips_date():
    t = w.title_from_slug("press-secretary-karoline-leavitt-briefs-members-of-the-media-jul-23-2026")
    assert t == "Press secretary karoline leavitt briefs members of the media"
    assert "2026" not in t and "-" not in t


def test_wh_show_registered_without_rss():
    from ingest.shows import SHOW_BY_SLUG, rss_for
    wh = SHOW_BY_SLUG["wh"]
    assert wh["source"] == "whitehouse"
    assert wh["rss"] is None
    # rss_for 는 비-RSS 쇼에서 명확히 실패해야(엉뚱한 피드 조회 방지)
    try:
        rss_for("wh")
        assert False, "rss_for('wh') should raise"
    except KeyError:
        pass


def test_cspan_guid():
    from ingest import wh_fetch as w
    assert w.cspan_guid("https://www.c-span.org/program/white-house-event/white-house-daily-briefing/677472") == "cspan-677472"
    assert w.cspan_guid("https://c-span.org/program/662693") == "cspan-662693"
    assert w.cspan_guid("https://www.c-span.org/event/white-house-event/x/445397") == "cspan-445397"
    assert w.cspan_guid("https://example.com/no-id") is None
