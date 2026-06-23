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
    """필요한 체인만 흉내: select/eq/insert/execute."""
    def __init__(self, client, table):
        self._c = client
        self._t = table
        self._flt: dict = {}
        self._ins = None

    def select(self, *a, **k):
        return self

    def eq(self, col, val):
        self._flt[col] = val
        return self

    def insert(self, rows):
        self._ins = rows if isinstance(rows, list) else [rows]
        return self

    def execute(self):
        if self._ins is not None:
            self._c.inserts.setdefault(self._t, []).extend(self._ins)
            return _Resp([{"id": self._c.next_id()} for _ in self._ins])
        rows = list(self._c.seed.get(self._t, []))
        for k, v in self._flt.items():
            rows = [r for r in rows if r.get(k) == v]
        return _Resp(rows)


class _Client:
    def __init__(self, seed=None):
        self.seed = seed or {}        # table -> rows (select)
        self.inserts: dict = {}        # table -> inserted rows
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
