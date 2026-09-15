"""transcribe_pending() 의 직접 R2 호스팅 경로가 transcript 에 `r2_audio: true` 를 싣는지 고정.

배경(실측 2026-09-14): 2026-08-24 의 직접 업로드 경로(7f85188)는 오디오를 R2 에 올리고
mark_hosted 까지 했지만 transcript JSON 엔 플래그를 안 실었다. 앱은 그 플래그를 '완벽 싱크'의
진실원으로 쓰므로(ui/db.js, ui/views/episode.js perfectSync) 09-07 이후 신규 25편 전부가 R2 를
정확히 재생하면서도 "아직 완전 자동싱크 전" 배너를 띄웠다. 재STT 잡은 --skip-hosted 라 매니페스트에
있는 회차를 건너뛰어 아무도 채워 주지 않았다.

STT/네트워크/R2/DB 는 전부 몽키패치. upload_transcript 는 dict 를 **복사해서** 기록한다 — 같은 dict
가 두 번 올라가므로 참조를 그대로 두면 첫 업로드의 내용을 알 수 없다.
"""
from __future__ import annotations

import copy

from ingest import transcribe as tr


def _row(ep_id: int) -> dict:
    return {"id": ep_id, "audio_url": f"https://cdn.example/{ep_id}.mp3?x=1", "duration_sec": 100}


def _stub(monkeypatch, rows, *, r2_fail_for=(), transcript_fail_on_call=None):
    calls = {"uploads": [], "hosted": [], "r2": [], "transcribed": []}

    def fake_download_to(url, apath):
        apath.write_bytes(b"fake-mp3")
        return 8

    def fake_upload_transcript(ep_id, data):
        if transcript_fail_on_call is not None and len(calls["uploads"]) + 1 == transcript_fail_on_call:
            raise RuntimeError("storage hiccup")
        calls["uploads"].append((ep_id, copy.deepcopy(data)))

    def fake_upload_audio_r2(ep_id, apath):
        if ep_id in r2_fail_for:
            raise RuntimeError("R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY 가 환경에 없습니다.")
        calls["r2"].append(ep_id)
        return 8

    monkeypatch.setattr(tr, "download_to", fake_download_to)
    monkeypatch.setattr(tr, "transcribe_one", lambda apath: {"duration": 100.0, "segments": []})
    monkeypatch.setattr(tr.store, "episodes_needing_transcription", lambda show=None: list(rows))
    monkeypatch.setattr(tr.store, "upload_transcript", fake_upload_transcript)
    monkeypatch.setattr(tr.store, "mark_transcribed", lambda ep_id, dur: calls["transcribed"].append(ep_id))
    monkeypatch.setattr(tr.store, "upload_audio_r2", fake_upload_audio_r2)
    monkeypatch.setattr(tr.store, "mark_hosted", lambda ep_id: calls["hosted"].append(ep_id))
    return calls


def test_hosted_episode_gets_r2_audio_true(monkeypatch):
    calls = _stub(monkeypatch, [_row(7)])
    assert tr.transcribe_pending() == 1
    ups = [d for ep, d in calls["uploads"] if ep == 7]
    # 첫 업로드: STT 결과 보존(플래그 전). 마지막 업로드: 플래그 실림.
    assert len(ups) == 2
    assert "r2_audio" not in ups[0]
    assert ups[-1]["r2_audio"] is True
    assert ups[-1]["aligned"] is True
    assert calls["hosted"] == [7]
    assert calls["transcribed"] == [7]


def test_r2_failure_is_nonfatal_and_leaves_no_true_flag(monkeypatch):
    """호스팅 실패 → transcript 는 남되 r2_audio=true 가 절대 실리면 안 된다(megaphone 폴백 = 정직한
    배너). 그리고 루프는 다음 회차를 계속 처리한다(SystemExit 사고의 회귀 방지)."""
    calls = _stub(monkeypatch, [_row(7), _row(8)], r2_fail_for={7})
    assert tr.transcribe_pending() == 2
    ups7 = [d for ep, d in calls["uploads"] if ep == 7]
    assert len(ups7) == 1 and ups7[0].get("r2_audio") is not True
    assert 7 not in calls["hosted"]
    ups8 = [d for ep, d in calls["uploads"] if ep == 8]
    assert ups8[-1]["r2_audio"] is True and calls["hosted"] == [8]


def test_manifest_implies_flag(monkeypatch):
    """플래그가 실린 transcript 업로드가 실패하면 mark_hosted 도 하면 안 된다 — 매니페스트에 있는데
    플래그가 없는 회차는 재STT 잡(--skip-hosted)이 영영 건너뛴다(바로 이번 사고의 형태)."""
    # 2번째 upload_transcript 호출(= ep 7 의 플래그 업로드)만 실패시킨다.
    calls = _stub(monkeypatch, [_row(7)], transcript_fail_on_call=2)
    assert tr.transcribe_pending() == 1
    assert calls["r2"] == [7]            # 오디오는 올라갔지만
    assert calls["hosted"] == []         # 매니페스트엔 넣지 않는다 → 다음날 재STT 잡이 주워 간다
