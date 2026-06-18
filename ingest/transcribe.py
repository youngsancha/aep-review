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
from ingest.audio_download import download_to

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


def transcribe_one(audio_path: Path) -> dict[str, Any]:
    model = _get_model()
    beam_size = int(os.getenv("AEP_WHISPER_BEAM", "5"))
    segments_iter, info = model.transcribe(
        str(audio_path),
        language="en",
        word_timestamps=True,
        vad_filter=True,  # 침묵 구간 스킵 → 빠르고 hallucination 감소
        beam_size=beam_size,
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
                download_to(row["audio_url"], apath)
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
