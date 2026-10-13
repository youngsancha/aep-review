"""storage_guard: drains retired buckets completely, keeps a bucket that did not empty,
and measures the rest — against a fake Storage client (no network)."""
from __future__ import annotations

import pytest

from scripts import storage_guard as sg


class _Bucket:
    def __init__(self, store: "_Storage", bid: str):
        self.s, self.id = store, bid

    def list(self, prefix, options):
        objs = self.s.objects[self.id]
        names, folders = [], set()
        for path in sorted(objs):
            rel = path[len(prefix) + 1:] if prefix else path
            if prefix and not path.startswith(prefix + "/"):
                continue
            head, _, rest = rel.partition("/")
            if rest:
                folders.add(head)
            else:
                names.append({"name": head, "id": "x", "metadata": {"size": objs[path]}})
        rows = [{"name": f, "id": None, "metadata": None} for f in sorted(folders)] + names
        off, lim = options["offset"], options["limit"]
        return rows[off:off + lim]

    def remove(self, paths):
        self.s.remove_calls.append(len(paths))
        for p in paths:
            if p not in self.s.sticky:
                self.s.objects[self.id].pop(p, None)
        return []


class _B:
    def __init__(self, bid):
        self.id = bid


class _Storage:
    def __init__(self, objects, sticky=()):
        self.objects, self.sticky = objects, set(sticky)
        self.remove_calls, self.deleted = [], []

    def from_(self, bid):
        return _Bucket(self, bid)

    def list_buckets(self):
        return [_B(b) for b in self.objects]

    def delete_bucket(self, bid):
        self.deleted.append(bid)
        self.objects.pop(bid)


def _fake(monkeypatch, storage):
    class _C:
        pass
    c = _C()
    c.storage = storage
    monkeypatch.setattr(sg.store, "client", lambda: c)
    monkeypatch.setattr(sg, "_warn", lambda total: storage.__dict__.setdefault("warned", total))


def test_walk_pages_and_recurses(monkeypatch):
    monkeypatch.setattr(sg, "PAGE", 3)
    objs = {f"{i:02d}.mp3": 10 for i in range(7)} | {"sub/a.mp3": 5, "sub/deep/b.mp3": 1}
    st = _Storage({"tts": objs})
    got = dict(sg.walk(st.from_("tts")))
    assert got == objs


def test_drain_removes_everything_in_batches_and_deletes_bucket(monkeypatch):
    monkeypatch.setattr(sg, "PAGE", 4)
    monkeypatch.setattr(sg, "REMOVE_BATCH", 5)
    st = _Storage({"tts": {f"{i}.mp3": 100 for i in range(12)}, "transcripts": {"1.json": 7}})
    assert sg.drain(st, "tts") == (12, 1200)
    assert st.remove_calls == [5, 5, 2]
    assert st.deleted == ["tts"]
    assert st.objects == {"transcripts": {"1.json": 7}}


def test_drain_keeps_bucket_when_objects_survive(monkeypatch):
    st = _Storage({"tts": {"a.mp3": 1, "b.mp3": 1}}, sticky={"b.mp3"})
    with pytest.raises(RuntimeError, match="1 objects still present"):
        sg.drain(st, "tts")
    assert st.deleted == []


def test_main_drains_retired_and_warns_over_threshold(monkeypatch, capsys):
    st = _Storage({"tts": {"x.mp3": 400}, "transcripts": {"1.json": 900}})
    _fake(monkeypatch, st)
    monkeypatch.setattr(sg, "WARN_BYTES", 500)
    assert sg.main([]) == 0
    assert st.deleted == ["tts"]
    assert st.warned == 900          # only what is LEFT counts, not the drained bucket
    assert "tts: removed 1 objects" in capsys.readouterr().out


def test_main_is_a_noop_once_retired_buckets_are_gone(monkeypatch):
    st = _Storage({"transcripts": {"1.json": 9}})
    _fake(monkeypatch, st)
    assert sg.main([]) == 0
    assert st.deleted == [] and st.remove_calls == [] and "warned" not in st.__dict__


def test_dry_run_deletes_nothing(monkeypatch, capsys):
    st = _Storage({"tts": {"x.mp3": 4}, "transcripts": {}})
    _fake(monkeypatch, st)
    assert sg.main(["--dry-run"]) == 0
    assert st.objects["tts"] == {"x.mp3": 4} and st.deleted == []
    assert "would remove 1 objects" in capsys.readouterr().out
