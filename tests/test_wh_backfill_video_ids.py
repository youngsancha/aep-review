"""scripts/wh_backfill_video_ids.py 단위검증 — 네트워크/DB/yt-dlp 없이 순수 로직 + 저장 계층 호출만.

wh_transcribed_rows() 자체(Supabase 쿼리 빌더 체이닝)는 store.py 의 다른 얇은 조회 함수들과 같은
리스크 등급이라 여기선 직접 검증하지 않는다(그 함수들도 CI 통합 실행으로만 커버됨) — select_targets
(최신-스킵/명시적 id 선택의 실제 로직)·backfill_one(멱등·dry-run·상태 판정)·resolve_video_id(yt-dlp
출력 파싱 + 익스트랙터 게이트)만 고정한다.
"""
import subprocess

from scripts import wh_backfill_video_ids as b


def _rows(*ids):
    """pub_date 내림차순(최신 우선)이라고 가정한 픽스처 — id 가 클수록 최신이라고 치자."""
    return [{"id": i, "guid": f"guid-{i}", "pub_date": f"2026-0{i}-01"} for i in ids]


# ─────────────────────────── select_targets() ───────────────────────────

def test_select_targets_skips_newest_by_default():
    rows = _rows(5, 4, 3)   # rows[0](id=5) = 최신
    out = b.select_targets(rows, ids=None, skip_newest=True)
    assert [r["id"] for r in out] == [4, 3]


def test_select_targets_include_newest():
    rows = _rows(5, 4, 3)
    out = b.select_targets(rows, ids=None, skip_newest=False)
    assert [r["id"] for r in out] == [5, 4, 3]


def test_select_targets_explicit_ids_bypasses_skip_newest():
    # --ids 로 최신(id=5)을 명시하면 skip_newest 와 무관하게 포함된다 — 콜리전은 호출자 책임.
    rows = _rows(5, 4, 3)
    out = b.select_targets(rows, ids=[5], skip_newest=True)
    assert [r["id"] for r in out] == [5]


def test_select_targets_explicit_ids_filters_to_only_those():
    rows = _rows(5, 4, 3)
    out = b.select_targets(rows, ids=[3], skip_newest=True)
    assert [r["id"] for r in out] == [3]


def test_select_targets_empty_rows():
    assert b.select_targets([], ids=None, skip_newest=True) == []
    assert b.select_targets([], ids=[1], skip_newest=True) == []


# ─────────────────────────── resolve_video_id() ───────────────────────────

class _FakeProc:
    def __init__(self, stdout):
        self.stdout = stdout


def test_resolve_video_id_parses_youtube_id(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeProc("youtube|8ytbAVpDBXs\n"))
    assert b.resolve_video_id("https://www.whitehouse.gov/videos/ep554/") == "8ytbAVpDBXs"


def test_resolve_video_id_none_for_non_youtube_extractor(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeProc("generic|677472\n"))
    assert b.resolve_video_id("https://www.c-span.org/program/677472") is None


def test_resolve_video_id_none_on_malformed_output(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeProc("no-pipe-here"))
    assert b.resolve_video_id("https://example.com/x") is None


def test_resolve_video_id_none_on_subprocess_failure(monkeypatch):
    def boom(*a, **k):
        raise subprocess.CalledProcessError(1, "yt-dlp")
    monkeypatch.setattr(subprocess, "run", boom)
    assert b.resolve_video_id("https://example.com/x") is None


def test_resolve_video_id_none_on_timeout(monkeypatch):
    def boom(*a, **k):
        raise subprocess.TimeoutExpired("yt-dlp", 120)
    monkeypatch.setattr(subprocess, "run", boom)
    assert b.resolve_video_id("https://example.com/x") is None


# ─────────────────────────── backfill_one() ───────────────────────────

def test_backfill_one_skips_when_transcript_missing(monkeypatch):
    monkeypatch.setattr(b.store, "download_transcript", lambda ep_id: None)
    status = b.backfill_one({"id": 1, "guid": "g1"})
    assert status == "skipped-no-transcript"


def test_backfill_one_skips_when_already_has_id(monkeypatch):
    monkeypatch.setattr(b.store, "download_transcript", lambda ep_id: {"video_id": "already"})
    uploaded = []
    monkeypatch.setattr(b.store, "upload_transcript", lambda ep_id, data: uploaded.append(data))
    status = b.backfill_one({"id": 1, "guid": "g1"})
    assert status == "skipped-has-id"
    assert uploaded == []   # 멱등 — 이미 있으면 절대 다시 안 씀


def test_backfill_one_skips_when_resolve_fails(monkeypatch):
    monkeypatch.setattr(b.store, "download_transcript", lambda ep_id: {"segments": []})
    monkeypatch.setattr(b, "resolve_video_id", lambda url: None)
    uploaded = []
    monkeypatch.setattr(b.store, "upload_transcript", lambda ep_id, data: uploaded.append(data))
    status = b.backfill_one({"id": 1, "guid": "g1"})
    assert status == "skipped-no-video-id"
    assert uploaded == []


def test_backfill_one_dry_run_never_uploads(monkeypatch):
    monkeypatch.setattr(b.store, "download_transcript", lambda ep_id: {"segments": []})
    monkeypatch.setattr(b, "resolve_video_id", lambda url: "8ytbAVpDBXs")
    uploaded = []
    monkeypatch.setattr(b.store, "upload_transcript", lambda ep_id, data: uploaded.append(data))
    status = b.backfill_one({"id": 1, "guid": "g1"}, dry_run=True)
    assert status == "dry-run"
    assert uploaded == []


def test_backfill_one_patches_and_uploads(monkeypatch):
    tr = {"segments": [{"start": 0, "end": 1, "text": "hi"}]}
    monkeypatch.setattr(b.store, "download_transcript", lambda ep_id: tr)
    monkeypatch.setattr(b, "resolve_video_id", lambda url: "8ytbAVpDBXs")
    uploaded = []
    monkeypatch.setattr(b.store, "upload_transcript", lambda ep_id, data: uploaded.append((ep_id, data)))
    status = b.backfill_one({"id": 42, "guid": "press-secretary-ep554"})
    assert status == "patched"
    assert len(uploaded) == 1
    ep_id, data = uploaded[0]
    assert ep_id == 42
    assert data["video_id"] == "8ytbAVpDBXs"
    assert data["segments"] == tr["segments"]   # 나머지 transcript 내용은 그대로 보존


def test_backfill_one_uses_page_url_from_guid(monkeypatch):
    seen_urls = []
    monkeypatch.setattr(b.store, "download_transcript", lambda ep_id: {"segments": []})
    monkeypatch.setattr(b, "resolve_video_id", lambda url: seen_urls.append(url) or "vid123")
    monkeypatch.setattr(b.store, "upload_transcript", lambda ep_id, data: None)
    b.backfill_one({"id": 1, "guid": "press-secretary-x-jul-23-2026"})
    assert seen_urls == ["https://www.whitehouse.gov/videos/press-secretary-x-jul-23-2026/"]
