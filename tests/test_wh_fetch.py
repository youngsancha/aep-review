"""wh_fetch 순수 로직 단위검증 — 네트워크/DB/yt-dlp 없이 파싱만.

end-to-end(discover_new/ingest_one)는 Supabase 서비스키·R2·yt-dlp 가 필요해 CI(wh-sync.yml)에서만
검증된다. 여기선 목록 HTML 파싱 + 슬러그→날짜/제목의 순수 함수, discover_all() 의 페이지네이션 루프
(가짜 _fetch 로 네트워크 없이), ingest_page() 의 pub_date 폴백만 고정한다.
"""
from urllib.error import URLError

from ingest import store
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


# ─────────────────────────── discover_all() 페이지네이션 ───────────────────────────
# 실제 whitehouse.gov 목록은 6페이지(64건)+7페이지째 HTTPError 로 끝난다(관찰값). 여기선 _fetch 를
# 가짜로 바꿔 네트워크 없이 세 가지 종료 조건과 순서보존/중복제거를 검증한다.

def _page_url(n: int) -> str:
    return w.LISTING_URL if n == 1 else w.LISTING_PAGE_URL.format(page=n)


def _briefing_html(*slugs: str) -> str:
    return "".join(f'<a href="/videos/{s}/">x</a>' for s in slugs)


def test_discover_all_stops_on_http_error(monkeypatch):
    pages = {
        _page_url(1): _briefing_html("a-brief-members-of-the-media-jul-3-2026"),
        _page_url(2): _briefing_html("b-brief-members-of-the-media-jun-1-2026"),
    }

    def fake_fetch(url):
        if url in pages:
            return pages[url]
        raise URLError("no more pages")   # page/3/ = 자연스러운 끝(실측: whitehouse.gov 는 HTTPError)

    monkeypatch.setattr(w, "_fetch", fake_fetch)
    monkeypatch.setattr(w.time, "sleep", lambda s: None)
    assert w.discover_all() == [
        "a-brief-members-of-the-media-jul-3-2026",
        "b-brief-members-of-the-media-jun-1-2026",
    ]


def test_discover_all_stops_on_empty_page(monkeypatch):
    pages = {
        _page_url(1): _briefing_html("a-brief-members-of-the-media-jul-3-2026"),
        _page_url(2): "<html>no briefings on this page</html>",
        _page_url(3): _briefing_html("should-not-be-reached-brief-members-of-the-media-jan-1-2026"),
    }
    monkeypatch.setattr(w, "_fetch", lambda url: pages[url])
    monkeypatch.setattr(w.time, "sleep", lambda s: None)
    assert w.discover_all() == ["a-brief-members-of-the-media-jul-3-2026"]   # 3페이지 도달 안 함


def test_discover_all_stops_when_page_repeats_only_seen_slugs(monkeypatch):
    pages = {
        _page_url(1): _briefing_html(
            "a-brief-members-of-the-media-jul-3-2026", "b-brief-members-of-the-media-jul-2-2026"),
        _page_url(2): _briefing_html("a-brief-members-of-the-media-jul-3-2026"),   # 전부 이미 본 슬러그
        _page_url(3): _briefing_html("should-not-be-reached-brief-members-of-the-media-jan-1-2026"),
    }
    monkeypatch.setattr(w, "_fetch", lambda url: pages[url])
    monkeypatch.setattr(w.time, "sleep", lambda s: None)
    assert w.discover_all() == [
        "a-brief-members-of-the-media-jul-3-2026",
        "b-brief-members-of-the-media-jul-2-2026",
    ]


def test_discover_all_walks_multiple_pages_preserving_order(monkeypatch):
    pages = {
        _page_url(1): _briefing_html(
            "p1a-brief-members-of-the-media-jul-3-2026", "p1b-brief-members-of-the-media-jul-2-2026"),
        _page_url(2): _briefing_html("p2a-brief-members-of-the-media-jun-1-2026"),
        _page_url(3): _briefing_html("p3a-brief-members-of-the-media-may-1-2026"),
    }

    def fake_fetch(url):
        if url in pages:
            return pages[url]
        raise URLError("end")

    monkeypatch.setattr(w, "_fetch", fake_fetch)
    monkeypatch.setattr(w.time, "sleep", lambda s: None)
    assert w.discover_all() == [
        "p1a-brief-members-of-the-media-jul-3-2026",
        "p1b-brief-members-of-the-media-jul-2-2026",
        "p2a-brief-members-of-the-media-jun-1-2026",
        "p3a-brief-members-of-the-media-may-1-2026",
    ]


def test_discover_all_hard_page_cap_guards_runaway(monkeypatch):
    # 세 종료 조건이 전부 실수로 안 걸리는(각 페이지가 새 슬러그를 계속 내놓는) 병적인 경우에도
    # _MAX_PAGES 에서 멈춰야 무한루프가 안 된다.
    monkeypatch.setattr(w, "_MAX_PAGES", 3)
    monkeypatch.setattr(w.time, "sleep", lambda s: None)
    calls: list[str] = []

    def fake_fetch(url):
        calls.append(url)
        n = len(calls)
        return _briefing_html(f"page{n}-brief-members-of-the-media-jan-{n}-2026")

    monkeypatch.setattr(w, "_fetch", fake_fetch)
    slugs = w.discover_all()
    assert len(calls) == 3
    assert len(slugs) == 3


# ─────────────────────────── ingest_page() pub_date 폴백 ───────────────────────────
# 64개 슬러그 중 10개는 슬러그에 날짜가 없다(slug_to_pubdate → None). 그 경우 ingest_page 는
# yt-dlp 가 돌려준 upload_date(extract_audio 의 meta)를 episodes.pub_date 로 써야 한다.

class _FakeResp:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    """episodes 테이블 흉내: insert(...).execute() / update(...).eq(...).execute() 만."""
    def __init__(self, sink):
        self._sink = sink

    def insert(self, row):
        self._sink["inserted"] = row
        return self

    def update(self, patch):
        self._sink.setdefault("updates", []).append(patch)
        return self

    def eq(self, col, val):
        return self

    def execute(self):
        return _FakeResp([{"id": 999}])


def test_ingest_page_falls_back_to_yt_dlp_upload_date_when_slug_has_no_date(monkeypatch):
    slug = ("press-secretary-karoline-leavitt-scott-bessent-and-kelly-loeffler"
            "-brief-members-of-the-media")   # 실제 무-날짜 슬러그(날짜 성분 없음)
    assert w.slug_to_pubdate(slug) is None   # 전제조건: 이 슬러그는 폴백 케이스

    def fake_extract_audio(page_url, out_mp3):
        out_mp3.write_bytes(b"0" * 20_000)   # ingest_page 의 '빈 파일 아님' 체크 통과용
        return {"title": "Press briefing", "duration": 900, "upload_date": "2026-05-09"}

    monkeypatch.setattr(w, "extract_audio", fake_extract_audio)

    sink: dict = {}
    fake_client = type("C", (), {"table": lambda self, name: _FakeQuery(sink)})()
    monkeypatch.setattr(store, "client", lambda: fake_client)
    monkeypatch.setattr(store, "_now", lambda: "2026-08-06T00:00:00Z")
    monkeypatch.setattr(store, "upload_audio_r2", lambda ep_id, path: None)

    out = w.ingest_page(
        w.PAGE_URL.format(slug=slug), guid=slug,
        pub_date=w.slug_to_pubdate(slug), title_fallback=w.title_from_slug(slug),
        do_stt=False,
    )
    assert out["id"] == 999
    assert sink["inserted"]["pub_date"] == "2026-05-09"   # yt-dlp upload_date 로 폴백


def test_ingest_page_prefers_slug_date_over_yt_dlp_upload_date(monkeypatch):
    slug = "press-secretary-x-briefs-media-jul-23-2026"
    assert w.slug_to_pubdate(slug) == "2026-07-23"

    def fake_extract_audio(page_url, out_mp3):
        out_mp3.write_bytes(b"0" * 20_000)
        return {"title": "Press briefing", "duration": 900, "upload_date": "2099-01-01"}

    monkeypatch.setattr(w, "extract_audio", fake_extract_audio)

    sink: dict = {}
    fake_client = type("C", (), {"table": lambda self, name: _FakeQuery(sink)})()
    monkeypatch.setattr(store, "client", lambda: fake_client)
    monkeypatch.setattr(store, "_now", lambda: "2026-08-06T00:00:00Z")
    monkeypatch.setattr(store, "upload_audio_r2", lambda ep_id, path: None)

    w.ingest_page(
        w.PAGE_URL.format(slug=slug), guid=slug,
        pub_date=w.slug_to_pubdate(slug), title_fallback=w.title_from_slug(slug),
        do_stt=False,
    )
    assert sink["inserted"]["pub_date"] == "2026-07-23"   # 슬러그 날짜가 폴백보다 우선
