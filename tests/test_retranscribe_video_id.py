"""retranscribe_one() 의 video_id 스레딩(Part A) 단위검증 — STT/네트워크/R2 는 전부 몽키패치로 대체.

retranscribe_one() 자체는 실제 오디오 다운로드+STT 가 필요한 통합함수라 기존에 직접 테스트가 없었다
(ingest/wh_fetch.py 의 ingest_page() 테스트들과 같은 수준으로 몽키패치). 여기선 'video_id 인자가
r2_audio 와 같은 자리에 실리는가'만 좁게 고정한다 — 나머지 동작(STT 자체·remap 등)은 기존 커버리지
밖에 그대로 둔다(범위를 넓히지 않음).
"""
from scripts import retranscribe as rt


def _stub_common(monkeypatch, uploaded, duration):
    def fake_download_to(url, apath):
        apath.write_bytes(b"fake-mp3-bytes")
        return len(b"fake-mp3-bytes")
    monkeypatch.setattr(rt, "download_to", fake_download_to)
    monkeypatch.setattr(rt, "transcribe_one", lambda apath: {"duration": duration, "segments": []})
    monkeypatch.setattr(rt.store, "upload_audio_r2", lambda ep_id, apath: None)
    monkeypatch.setattr(rt.store, "upload_transcript", lambda ep_id, data: uploaded.append((ep_id, data)))
    monkeypatch.setattr(rt.store, "mark_transcribed", lambda ep_id, dur: None)
    monkeypatch.setattr(rt.store, "mark_hosted", lambda ep_id: None)


def test_retranscribe_one_threads_video_id_like_r2_audio(monkeypatch):
    monkeypatch.setenv("R2_PUBLIC_BASE", "https://pub.example.dev")
    uploaded = []
    _stub_common(monkeypatch, uploaded, duration=1274.26)

    out = rt.retranscribe_one({"id": 42}, remap=False, host_r2=False, from_r2=True,
                              video_id="8ytbAVpDBXs")
    assert out["ep"] == 42
    ep_id, data = uploaded[0]
    assert ep_id == 42
    assert data["video_id"] == "8ytbAVpDBXs"
    assert data["r2_audio"] is True   # 같은 커밋(from_r2)에서 둘 다 실림 — wh_fetch.py 신규 인제스트 경로


def test_retranscribe_one_omits_video_id_when_not_given(monkeypatch):
    """기존 호출부(scripts/retranscribe.py main() 의 배치 재정렬)는 video_id 를 안 넘긴다 —
    그 경로가 transcript 에 엉뚱한/빈 video_id 키를 심으면 안 된다(하위호환)."""
    monkeypatch.setenv("R2_PUBLIC_BASE", "https://pub.example.dev")
    uploaded = []
    _stub_common(monkeypatch, uploaded, duration=900)

    rt.retranscribe_one({"id": 43}, remap=False, host_r2=False, from_r2=True)
    _ep_id, data = uploaded[0]
    assert "video_id" not in data


def test_retranscribe_one_falsy_video_id_not_written(monkeypatch):
    """meta.get('video_id') 가 None 인 채(비-YouTube 소스 등) 넘어와도 조용히 생략."""
    monkeypatch.setenv("R2_PUBLIC_BASE", "https://pub.example.dev")
    uploaded = []
    _stub_common(monkeypatch, uploaded, duration=900)

    rt.retranscribe_one({"id": 44}, remap=False, host_r2=False, from_r2=True, video_id=None)
    _ep_id, data = uploaded[0]
    assert "video_id" not in data
