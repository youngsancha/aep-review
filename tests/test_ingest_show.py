"""멀티-쇼 인제스트 show 스레딩 회귀 테스트 (iter3).

upsert_episodes / existing_guids / insert_vocab_and_srs 가 show 를 올바로 쓰고 필터하는지
가짜 Supabase client 로 검증(외부호출·실제 write 0). 기본 show='aep' 하위호환도 확인.
"""
from __future__ import annotations

import pytest

from ingest import store


class _Resp:
    def __init__(self, data):
        self.data = data


class _Q:
    """필요한 체인만 흉내: select/eq/in_/range/insert/upsert/execute.

    ⛔⛔ 이 가짜는 PostgREST 의 **조용한 1,000 행 절단을 반드시 재현해야 한다.**
    절단을 흉내내지 않는 가짜는 aep-sync 를 7 일간 죽인 버그를 통과시킨다 — 실제로
    기존 테스트는 전부 초록이었고 프로덕션만 매일 실패했다. 가짜가 서버보다 관대하면
    그 테스트는 아무것도 지키지 않는다.
    """
    def __init__(self, client, table):
        self._c = client
        self._t = table
        self._flt: dict = {}
        self._in: tuple[str, list] | None = None
        self._range: tuple[int, int] | None = None
        self._null_filters: list[tuple[str, bool]] = []   # (col, must_be_null)
        self._order: list[tuple[str, bool]] = []
        self._negate_next_is = False
        self._ins = None
        self._upsert_ignore = False

    def select(self, *a, **k):
        return self

    def eq(self, col, val):
        self._flt[col] = val
        return self

    def in_(self, col, vals):
        self._in = (col, list(vals))
        return self

    # .not_.is_(col, "null") 체인과 .order() — episodes_by_recency 가 쓰는 형태.
    @property
    def not_(self):
        self._negate_next_is = True
        return self

    def is_(self, col, val):
        assert val == "null"
        self._null_filters.append((col, not getattr(self, "_negate_next_is", False)))
        self._negate_next_is = False
        return self

    def order(self, col, desc=False):
        self._order.append((col, desc))
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def insert(self, rows):
        self._ins = rows if isinstance(rows, list) else [rows]
        return self

    def upsert(self, rows, *, on_conflict="", ignore_duplicates=False, **k):
        self._ins = rows if isinstance(rows, list) else [rows]
        self._upsert_ignore = ignore_duplicates
        return self

    def execute(self):
        if self._ins is not None:
            seeded = {(r.get("show"), r.get("guid")) for r in self._c.seed.get(self._t, [])}
            rows = self._ins
            if self._upsert_ignore:
                rows = [r for r in rows if (r.get("show"), r.get("guid")) not in seeded]
            else:
                for r in rows:
                    if (r.get("show"), r.get("guid")) in seeded:
                        raise RuntimeError(
                            'duplicate key value violates unique constraint '
                            '"episodes_show_guid_key"')
            self._c.inserts.setdefault(self._t, []).extend(rows)
            return _Resp([{"id": self._c.next_id()} for _ in rows])

        rows = list(self._c.seed.get(self._t, []))
        for k, v in self._flt.items():
            rows = [r for r in rows if r.get(k) == v]
        if self._in is not None:
            col, vals = self._in
            wanted = set(vals)
            rows = [r for r in rows if r.get(col) in wanted]
        for col, must_be_null in self._null_filters:
            rows = [r for r in rows if (r.get(col) is None) == must_be_null]
        for col, desc in reversed(self._order):
            rows.sort(key=lambda r: (r.get(col) is None, r.get(col)), reverse=desc)
        if self._range is not None:
            start, end = self._range
            rows = rows[start:end + 1]
        # 서버의 기본 상한. 명시적 range 든 아니든 한 응답은 이 크기를 넘지 않는다.
        return _Resp(rows[:self._c.page_cap])


class _Client:
    def __init__(self, seed=None, page_cap=1000):
        self.seed = seed or {}        # table -> rows (select)
        self.inserts: dict = {}        # table -> inserted rows
        self.page_cap = page_cap
        self._id = 1000

    def table(self, t):
        return _Q(self, t)

    def next_id(self):
        self._id += 1
        return self._id


@pytest.fixture
def fake(monkeypatch):
    c = _Client(seed={"episodes": [
        {"guid": "g-aep-1", "show": "aep"},
        {"guid": "g-aep-2", "show": "aep"},
        {"guid": "g-ae-1", "show": "allears"},
    ]})
    monkeypatch.setattr(store, "client", lambda: c)
    return c


def test_existing_guids_filters_by_show(fake):
    assert store.existing_guids("aep") == {"g-aep-1", "g-aep-2"}
    assert store.existing_guids("allears") == {"g-ae-1"}


def test_existing_guids_legacy_none_returns_all(fake):
    # show=None(레거시): 전체 guid(마이그레이션 전 show 컬럼 참조 안 함)
    assert store.existing_guids() == {"g-aep-1", "g-aep-2", "g-ae-1"}


def test_upsert_writes_show_and_dedupes_per_show(fake):
    items = [
        {"guid": "g-ae-1", "season": None, "episode_no": None, "title": "dup", "pub_date": "",
         "duration_sec": None, "description": "", "audio_url": "u"},     # 이미 allears 에 존재 → skip
        {"guid": "g-ae-2", "season": 1, "episode_no": 2, "title": "new", "pub_date": "",
         "duration_sec": 100, "description": "d", "audio_url": "u2"},     # 신규
    ]
    added, skipped = store.upsert_episodes(items, "allears")
    assert (added, skipped) == (1, 1)
    inserted = fake.inserts["episodes"]
    assert len(inserted) == 1
    assert inserted[0]["show"] == "allears"
    assert inserted[0]["guid"] == "g-ae-2"


def test_upsert_legacy_omits_show(fake):
    # show 미지정(None) → show 키 미기록 → 마이그레이션 전에도 insert 안전(DB default 'aep' 가 채움).
    items = [{"guid": "g-new", "season": None, "episode_no": None, "title": "t", "pub_date": "",
              "duration_sec": None, "description": "", "audio_url": "u"}]
    store.upsert_episodes(items)
    assert "show" not in fake.inserts["episodes"][0]


def test_insert_vocab_and_srs_labels_show_when_given(fake):
    vocab = [{"term": "ballpark figure", "kind": "idiom", "definition": "대략", "example_sentence": "Give me a ballpark figure."}]
    added, tts = store.insert_vocab_and_srs(42, vocab, "allears")
    assert added == 1
    assert fake.inserts["vocab_cards"][0]["show"] == "allears"
    assert fake.inserts["srs_cards"][0]["show"] == "allears"
    assert fake.inserts["vocab_cards"][0]["episode_id"] == 42
    assert "ballpark figure" in tts


def test_insert_vocab_and_srs_legacy_omits_show(fake):
    vocab = [{"term": "x", "kind": "word", "definition": "d", "example_sentence": "e"}]
    store.insert_vocab_and_srs(42, vocab)   # show 미지정 → 레거시(컬럼 미기록)
    assert "show" not in fake.inserts["vocab_cards"][0]
    assert "show" not in fake.inserts["srs_cards"][0]


# ───────────────── PostgREST 1,000 행 상한 회귀 (2026-08-30) ─────────────────
# aep-sync 는 2026-08-23 부터 7 일간 매일 죽었다. 코드는 안 바뀌었고 episodes 가 1,026 행이
# 되었을 뿐이다: 필터 없는 dedupe 조회가 1,000 개만 받아왔고, 잘린 26 개 중 하나가 RSS 에
# 다시 나타나 이미 있는 회차를 신규로 insert → 중복키로 런 전체(전사 포함)가 중단됐다.

@pytest.fixture
def big(monkeypatch):
    """1,026 회차 — 프로덕션이 깨진 바로 그 크기."""
    rows = [{"guid": f"g-{i:05d}", "show": "aep"} for i in range(1026)]
    c = _Client(seed={"episodes": rows}, page_cap=1000)
    monkeypatch.setattr(store, "client", lambda: c)
    return c


def test_existing_guids_pages_past_the_server_cap(big):
    # 배치를 안 넘기는 호출자(wh_fetch 등)도 절단되면 안 된다 — 페이지를 넘겨 전부 받는다.
    assert len(store.existing_guids()) == 1026


def test_existing_guids_batch_query_is_never_truncated(big):
    # 상한 너머(#1010)에 있는 guid 도 배치 질의로는 반드시 보인다.
    assert store.existing_guids(guids=["g-01010"]) == {"g-01010"}


def test_upsert_episodes_skips_an_episode_beyond_the_cap(big):
    """이것이 실제 버그다: 상한 너머의 기존 회차를 신규로 보고 다시 넣으려 했다."""
    item = {
        "guid": "g-01010", "season": 1, "episode_no": 1010, "title": "이미 있는 회차",
        "pub_date": None, "duration_sec": 60, "description": "", "audio_url": "http://x/1010.mp3",
    }
    added, skipped = store.upsert_episodes([item])
    assert (added, skipped) == (0, 1)
    assert big.inserts.get("episodes") is None   # 단 한 행도 쓰지 않는다


def test_upsert_episodes_still_adds_a_genuinely_new_episode(big):
    item = {
        "guid": "g-99999", "season": 1, "episode_no": 9999, "title": "진짜 신규",
        "pub_date": None, "duration_sec": 60, "description": "", "audio_url": "http://x/9999.mp3",
    }
    added, skipped = store.upsert_episodes([item])
    assert (added, skipped) == (1, 0)
    assert [r["guid"] for r in big.inserts["episodes"]] == ["g-99999"]


def test_episodes_by_recency_is_not_truncated(big):
    """감사·업로드가 전 회차를 보는지. 절단되면 1,026 번째부터 조용히 존재하지 않게 된다."""
    for r in big.seed["episodes"]:
        r["audio_url"] = f"http://x/{r['guid']}.mp3"
    assert len(store.episodes_by_recency()) == 1026
    assert len(store.episodes_by_recency(limit=5)) == 5
