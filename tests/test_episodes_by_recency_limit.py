"""episodes_by_recency(limit=N) 은 **최신** N 편이어야 한다.

배경(실측 2026-09-14): 2026-08-30 의 페이징 수정(6a5a99a)이 페이지를 id 오름차순으로 넘기면서
limit 을 페이지 크기에 적용했다 — "12 행 받고 pub_date 로 정렬" 은 가장 오래된 12편을 최신순으로
돌려준다. `retranscribe --recent 12 --skip-hosted` 는 그 2주 동안 매일 id 1~12(전부 호스팅됨)를
보고 "처리할 episode 없음" 으로 끝났다. limit 은 전체를 받아 정렬한 **뒤에** 잘라야 한다.

PostgREST 체인(.table().select().not_.is_().order().range().execute().data)을 흉내 내는 가짜
클라이언트로 페이지 요청까지 검증한다.
"""
from __future__ import annotations

from ingest import store


class _Q:
    def __init__(self, rows, log):
        self._rows, self._log = rows, log
        self.not_ = self          # `.not_.is_(...)` 체인

    def table(self, *_):
        return self

    def select(self, *_):
        return self

    def is_(self, *_):
        return self

    def order(self, col, desc=False):
        self._rows = sorted(self._rows, key=lambda r: r[col], reverse=desc)
        return self

    def range(self, start, end):
        self._log.append((start, end))
        self._slice = (start, end + 1)
        return self

    def execute(self):
        s, e = self._slice
        return type("R", (), {"data": self._rows[s:e]})()


def _rows(n):
    # id 는 단조 증가, pub_date 는 id 와 무관하게 섞는다(백카탈로그 인제스트는 큰 id + 옛 pub_date).
    return [{"id": i, "audio_url": f"u{i}", "pub_date": f"2026-01-{(i * 7) % 28 + 1:02d}",
             "transcribed_at": None, "duration_sec": 1} for i in range(1, n + 1)]


def test_limit_returns_newest_not_lowest_ids(monkeypatch):
    rows, log = _rows(50), []
    monkeypatch.setattr(store, "client", lambda: _Q(rows, log))
    got = store.episodes_by_recency(limit=5)
    expect = sorted(rows, key=lambda r: (r["pub_date"], r["id"]), reverse=True)[:5]
    assert [r["id"] for r in got] == [r["id"] for r in expect]
    assert got[0]["id"] != 1              # 회귀 형태: id 1 이 '최신' 으로 오면 안 된다


def test_pages_past_the_postgrest_cap(monkeypatch):
    rows, log = _rows(store._PAGE + 5), []
    monkeypatch.setattr(store, "client", lambda: _Q(rows, log))
    got = store.episodes_by_recency(limit=3)
    assert len(got) == 3
    assert len(log) == 2 and log[0] == (0, store._PAGE - 1)   # limit 이 있어도 전체를 페이지로 받는다


def test_no_limit_returns_all_sorted(monkeypatch):
    rows, log = _rows(30), []
    monkeypatch.setattr(store, "client", lambda: _Q(rows, log))
    got = store.episodes_by_recency()
    assert len(got) == 30
    dates = [r["pub_date"] for r in got]
    assert dates == sorted(dates, reverse=True)
