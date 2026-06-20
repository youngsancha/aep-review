"""faster-whisper 로컬 STT — 영어 팟캐스트 → segments + word timestamps JSON.

medium.en 모델 기본. CUDA 가능하면 GPU, 아니면 CPU fallback.
chcn-teams 의 OpenAI Whisper API 호출 자리에 들어가는 영어용 로컬 엔진.

JSON 형식:
{
  "language": "en",
  "duration": 1830.0,
  "segments": [
    {"idx": 0, "start": 0.0, "end": 3.4, "text": "...", "words": [{"start":..,"end":..,"word":".."}]}
  ]
}
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any

# pip-installed nvidia-cublas-cu12 / nvidia-cudnn-cu12 ship DLLs under
# site-packages/nvidia/*/bin which Windows LoadLibrary doesn't search by default.
# CTranslate2 needs cublas64_12.dll + cudnn*64_9.dll for medium.en+ on CUDA.
if sys.platform == "win32":
    _path_prepend: list[str] = []
    for _sp in [p for p in sys.path if p.endswith("site-packages")]:
        for _sub in ("nvidia/cublas/bin", "nvidia/cudnn/bin"):
            _dll_dir = os.path.join(_sp, _sub.replace("/", os.sep))
            if os.path.isdir(_dll_dir):
                try:
                    os.add_dll_directory(_dll_dir)  # type: ignore[attr-defined]
                except (AttributeError, OSError):
                    pass
                _path_prepend.append(_dll_dir)
    # PATH prepend covers LoadLibrary calls deep inside ctranslate2 native ext
    # that os.add_dll_directory's user-search-dirs flag doesn't reach.
    if _path_prepend:
        os.environ["PATH"] = os.pathsep.join(_path_prepend + [os.environ.get("PATH", "")])

import tempfile

from ingest import store
from ingest.audio_download import clean_audio_url, download_to

log = logging.getLogger(__name__)

_model = None  # lazy singleton — medium.en 로드 시간 5-10초


def _device() -> tuple[str, str]:
    """(device, compute_type). AEP_WHISPER_DEVICE 환경변수로 강제 가능."""
    pref = (os.getenv("AEP_WHISPER_DEVICE") or "auto").lower()
    if pref == "cpu":
        return "cpu", "int8"
    if pref == "cuda":
        return "cuda", "float16"
    # auto: prefer CUDA via CTranslate2 (no torch dependency required)
    try:
        import ctranslate2  # type: ignore

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def _get_model():
    global _model
    if _model is not None:
        return _model
    from faster_whisper import WhisperModel  # type: ignore

    model_size = os.getenv("AEP_WHISPER_MODEL", "medium.en")
    device, compute = _device()
    log.info("loading faster-whisper model=%s device=%s compute=%s", model_size, device, compute)
    _model = WhisperModel(model_size, device=device, compute_type=compute)
    return _model


# 정상 전사는 1마침표당 ~10단어, 전사 실패 잔재는 25단어+ → 임계 미달이면 beam 을 올려 1회 재시도.
# 구두점이 없으면 클라이언트가 문장을 구(句) 중간에서 자른다(사용자 보고 근본원인) → 여기서 자가복구.
PUNCT_MIN = 0.04   # 1마침표 / 25단어


def _punct_ratio(data: dict[str, Any]) -> float:
    txt = " ".join(s.get("text", "") for s in data.get("segments", []))
    w = len(txt.split())
    p = txt.count(".") + txt.count("?") + txt.count("!")
    return p / max(w, 1)


def transcribe_one(audio_path: Path) -> dict[str, Any]:
    model = _get_model()

    def _pass(beam: int) -> dict[str, Any]:
        segments_iter, info = model.transcribe(
            str(audio_path),
            language="en",
            word_timestamps=True,
            vad_filter=True,  # 침묵 구간 스킵 → 빠르고 hallucination 감소
            beam_size=beam,
        )
        segments_out: list[dict[str, Any]] = []
        for i, seg in enumerate(segments_iter):
            words = []
            if seg.words:
                for w in seg.words:
                    words.append({
                        "start": round(w.start, 3) if w.start is not None else None,
                        "end": round(w.end, 3) if w.end is not None else None,
                        "word": w.word,
                    })
            segments_out.append({
                "idx": i,
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": seg.text.strip(),
                "words": words,
            })
        return {
            "language": info.language or "en",
            "duration": round(info.duration, 2) if info.duration else None,
            "segments": segments_out,
        }

    beam_size = int(os.getenv("AEP_WHISPER_BEAM", "5"))
    data = _pass(beam_size)
    # 구두점 품질 게이트(durable): 임계 미달이면 beam 을 올려 1회 재시도(더 나으면 채택) → 어떤 회차도
    # '구두점 없는 자막'으로 저장되지 않게 자가복구. 모든 전사 경로(인제스트·재싱크) 공통 적용.
    if _punct_ratio(data) < PUNCT_MIN and beam_size < 5:
        r0 = _punct_ratio(data)
        log.warning("구두점 빈약(1마침표/%.0f단어) → beam=5 재시도", 1 / max(r0, 1e-9))
        data2 = _pass(5)
        if _punct_ratio(data2) > r0:
            data = data2
            log.info("beam=5 로 구두점 개선(1마침표/%.0f단어)", 1 / max(_punct_ratio(data), 1e-9))
    return data


def transcribe_pending(limit: int | None = None) -> int:
    """transcribed_at NULL 이고 audio_url 있는 episode 처리.

    원본 CDN 에서 mp3 임시 다운 → STT → transcript JSON 을 Storage 업로드 →
    episodes.transcribed_at 마킹 → 임시 mp3 삭제. 반환: 처리 건수.
    """
    count = 0
    rows = store.episodes_needing_transcription()

    with tempfile.TemporaryDirectory(prefix="aep_stt_") as tmpdir:
        for row in rows:
            if limit and count >= limit:
                break
            ep_id = row["id"]
            apath = Path(tmpdir) / f"{ep_id}.mp3"
            try:
                # 앱이 스트리밍하는 것과 똑같은 clean URL 로 받아야 STT 타임스탬프가 스트림과 일치(#2)
                download_to(clean_audio_url(row["audio_url"]), apath)
            except Exception:
                log.exception("download failed ep=%s", ep_id)
                continue
            try:
                data = transcribe_one(apath)
            except Exception:
                log.exception("transcribe failed ep=%s", ep_id)
                continue
            finally:
                apath.unlink(missing_ok=True)

            data["aligned"] = True  # clean URL 기준 정렬됨 → 클라이언트 offset 0
            store.upload_transcript(ep_id, data)
            store.mark_transcribed(ep_id, data.get("duration"))
            count += 1
            log.info("transcribed ep=%s segments=%d", ep_id, len(data["segments"]))
    return count


if __name__ == "__main__":
    import argparse
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None)
    args = p.parse_args()
    n = transcribe_pending(limit=args.limit)
    log.info("transcribed=%d", n)
