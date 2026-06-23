"""load_existing 404-vs-일시오류 가드 회귀 테스트 (C1 / AUDIT P4·I1).

핵심 계약: 일시 다운로드 오류(404 아님)일 때 기존 _ko.json 을 덮어쓰지 않는다(축소 방지).
번역 잡을 실행하지 않으며(외부호출·_ko.json write 없음), store.client 를 가짜로 주입해
순수 로직만 검증한다.
"""
from __future__ import annotations

import json

import pytest

from scripts import translate_transcripts as tt


class _FakeStorage:
    def __init__(self, behavior):
        self._b = behavior

    def from_(self, _bucket):
        return self

    def download(self, _path):
        b = self._b
        if isinstance(b, Exception):
            raise b
        return b  # bytes


class _FakeClient:
    def __init__(self, behavior):
        self.storage = _FakeStorage(behavior)


def _patch_client(monkeypatch, behavior):
    monkeypatch.setattr(tt.store, "client", lambda: _FakeClient(behavior))


# ── _is_not_found 분류 ──
@pytest.mark.parametrize("msg", [
    "Object not found", "not_found", "404 Not Found", "NoSuchKey",
    "{'statusCode': '404', 'error': 'not_found'}",
])
def test_is_not_found_true(msg):
    assert tt._is_not_found(Exception(msg)) is True


@pytest.mark.parametrize("msg", [
    "Connection reset by peer", "timed out", "500 Internal Server Error", "SSL error",
])
def test_is_not_found_false(msg):
    assert tt._is_not_found(Exception(msg)) is False


# ── load_existing 반환 계약 ──
def test_load_existing_missing_returns_empty(monkeypatch):
    _patch_client(monkeypatch, Exception("Object not found"))
    assert tt.load_existing(1) == {}          # 신규 → {}


def test_load_existing_transient_returns_none(monkeypatch):
    _patch_client(monkeypatch, ConnectionError("Connection reset by peer"))
    assert tt.load_existing(1) is None        # 일시 오류 → None(스킵 신호)


def test_load_existing_success_returns_dict(monkeypatch):
    _patch_client(monkeypatch, json.dumps({"k": "안녕"}).encode("utf-8"))
    assert tt.load_existing(1) == {"k": "안녕"}


def test_load_existing_corrupt_returns_empty(monkeypatch):
    _patch_client(monkeypatch, b"{not valid json")
    assert tt.load_existing(1) == {}          # 손상 → 자가치유({})


# ── translate_episode: 일시 오류 시 덮어쓰지 않고 스킵 ──
def test_translate_episode_skips_on_transient(monkeypatch):
    monkeypatch.setattr(tt, "fetch_transcript",
                        lambda ep_id: {"segments": [{"start": 0.0, "end": 2.0, "text": "Hello there."}]})
    monkeypatch.setattr(tt, "load_existing", lambda ep_id: None)   # 일시 오류 신호
    saved = []
    monkeypatch.setattr(tt, "save_existing", lambda ep_id, m: saved.append((ep_id, m)))
    def _boom(*a, **k):
        raise AssertionError("스킵돼야 하므로 claude 호출 금지")
    monkeypatch.setattr(tt, "_call_claude", _boom)

    n, added = tt.translate_episode(999)
    assert added == 0           # 아무것도 추가 안 함
    assert saved == []          # save_existing 미호출 → 기존 _ko.json 보존
    assert n >= 1               # 문장 수는 셈
