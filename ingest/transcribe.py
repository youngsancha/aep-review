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
import time

from ingest import store
from ingest.audio_download import clean_audio_url, download_to

log = logging.getLogger(__name__)

# CI(ubuntu-latest, medium.en, int8 CPU) 실측: 20분 오디오 ≈ 13-14분 → 약 0.70x 실시간.
# 예산 초과로 job 이 강제 종료되면 그 에피소드의 연산이 통째로 버려지므로, 시작 추정은
# 실측보다 보수적으로 잡고(아래 SAFETY) 매 에피소드마다 실측값으로 보정한다.
STT_RATE_GUESS = 0.75
STT_RATE_SAFETY = 1.15
# duration_sec 이 비어 있는 행의 대체값 (RSS 가 길이를 안 준 경우).
UNKNOWN_DURATION_S = 1800.0

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


class TimeBudget:
    """이번 실행의 남은 벽시계 예산 안에 다음 에피소드 STT 가 들어가는지 판정한다.

    순수 로직 — 경과시간을 호출자가 넘기므로 테스트에서 가짜 시계로 구동할 수 있다.
    `limit`(건수) 대신 이걸 쓰는 이유: CI job 은 *시간* 으로 잘리는데 건수로 세면
    마지막 에피소드가 STT 도중에 강제 종료돼 그 연산이 통째로 버려진다.
    """

    def __init__(self, budget_s: float | None = None, rate: float = STT_RATE_GUESS) -> None:
        self.budget_s = budget_s
        self.rate = rate
        self._samples = 0

    def estimate(self, duration_sec: float | None) -> float:
        return float(duration_sec or UNKNOWN_DURATION_S) * self.rate * STT_RATE_SAFETY

    def fits(self, duration_sec: float | None, elapsed_s: float, done: int) -> tuple[bool, str]:
        """(진행할지, 사유). 예산 미설정이면 항상 True."""
        if not self.budget_s:
            return True, ""
        est = self.estimate(duration_sec)
        if elapsed_s + est <= self.budget_s:
            return True, ""
        if done == 0:
            # 한 건도 못 하고 멈추면 이 에피소드가 영구히 큐를 막는다 → 예산을 넘겨서라도 시도.
            return True, f"over budget (est {est:.0f}s > budget {self.budget_s:.0f}s) but nothing done yet — trying anyway"
        return False, f"stopping cleanly: est {est:.0f}s + elapsed {elapsed_s:.0f}s > budget {self.budget_s:.0f}s"

    def observe(self, duration_sec: float | None, took_s: float) -> None:
        """실측으로 rate 보정 — 러너 성능/모델 편차를 실행 중에 흡수한다."""
        dur = float(duration_sec or 0)
        if dur <= 0 or took_s <= 0:
            return
        sample = took_s / dur
        self._samples += 1
        self.rate = sample if self._samples == 1 else (self.rate + sample) / 2


def in_shard(ep_id: int, shard: int, shards: int) -> bool:
    """id 모듈로 샤딩 — 쿼리 정렬에 의존하지 않으므로 병렬 job 간 겹침/누락이 없다.

    (pub_date 동률이 실제로 존재해서 '목록 위치' 기반 스트라이핑은 안전하지 않다.)
    """
    return shards <= 1 or ep_id % shards == shard


def transcribe_pending(limit: int | None = None, show: str | None = None,
                       time_budget_s: float | None = None,
                       shard: int = 0, shards: int = 1) -> int:
    """transcribed_at NULL 이고 audio_url 있는 episode 처리. show 지정 시 그 쇼만(None=전체).

    원본 CDN 에서 mp3 임시 다운 → STT → transcript JSON 을 Storage 업로드 →
    episodes.transcribed_at 마킹 → 임시 mp3 삭제. 반환: 처리 건수. (transcript 는 id 로 저장 — 쇼 무관)
    """
    count = 0
    rows = store.episodes_needing_transcription(show)
    if shards > 1:
        rows = [r for r in rows if in_shard(r["id"], shard, shards)]
        log.info("shard %d/%d: %d of the pending episodes", shard, shards, len(rows))
    budget = TimeBudget(time_budget_s)
    started = time.monotonic()

    with tempfile.TemporaryDirectory(prefix="aep_stt_") as tmpdir:
        for row in rows:
            if limit and count >= limit:
                break
            ok, why = budget.fits(row.get("duration_sec"), time.monotonic() - started, count)
            if why:
                log.warning("budget ep=%s: %s", row["id"], why)
            if not ok:
                break
            ep_id = row["id"]
            apath = Path(tmpdir) / f"{ep_id}.mp3"
            ep_started = time.monotonic()
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
                apath.unlink(missing_ok=True)
                continue

            data["aligned"] = True  # clean URL 기준 정렬됨 → 클라이언트 offset 0
            store.upload_transcript(ep_id, data)
            store.mark_transcribed(ep_id, data.get("duration"))

            # ⚠ 방금 STT 한 '바로 이 파일'을 그대로 R2 에 올린다 — 지우기 전에.
            #
            # 예전엔 여기서 파일을 버리고, 호스팅은 별도 잡(scripts/host_audio.py, GitHub Actions
            # 매일 17시)이 '같은 clean URL 을 다시 받아서' 처리했다. megaphone 은 동적광고(DAI)라
            # 같은 URL 도 시점이 다르면 다른 광고가 박힌다. 기존 쇼는 두 시점 사이에 CDN 캐시가
            # 같은 광고를 서빙해 우연히 통했지만, CNN 10 에서 깨졌다(2026-08-24 실측, ep 633):
            #   자막(STT 시점) 첫 문장 = "Hey, what's your story?"  (Ancestry 광고)
            #   R2(재다운로드)  첫 문장 = "This episode is brought to you by PayPal."
            # 길이는 703.87s vs 704.0s 로 0.13초 차이였다 — 즉 **길이 검사로는 절대 못 잡는다**.
            # 광고가 '같은 길이의 다른 광고'로 바뀌기 때문이다. 재다운로드를 없애는 것이 유일한
            # 확실한 해법이다: 자막을 만든 바이트와 앱이 스트리밍할 바이트가 같은 파일이 된다.
            try:
                store.upload_audio_r2(ep_id, apath)
                store.mark_hosted(ep_id)
                log.info("hosted ep=%s (자막을 만든 바로 그 오디오)", ep_id)
            except Exception:
                # 호스팅 실패는 치명적이지 않다 — 앱이 megaphone 으로 폴백하고 드리프트 안내를
                # 띄운다. 자막은 이미 저장됐으므로 다음 호스팅 잡이 다시 시도할 수 있다.
                log.exception("R2 host failed ep=%s — megaphone 폴백으로 남는다", ep_id)
            finally:
                apath.unlink(missing_ok=True)
            count += 1
            # 실측은 다운로드+STT 전체(=예산이 실제로 소비되는 시간) 기준으로 잡는다.
            took = time.monotonic() - ep_started
            budget.observe(row.get("duration_sec") or data.get("duration"), took)
            log.info("transcribed ep=%s segments=%d took=%.0fs rate=%.2fx",
                     ep_id, len(data["segments"]), took, budget.rate)
    return count


if __name__ == "__main__":
    import argparse
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--show", default=None)
    p.add_argument("--time-budget-min", type=float, default=None,
                   help="이 시간 안에 끝날 만큼만 처리하고 깨끗이 종료 (CI job timeout 보다 작게)")
    p.add_argument("--shard", type=int, default=0)
    p.add_argument("--shards", type=int, default=1)
    args = p.parse_args()
    n = transcribe_pending(limit=args.limit, show=args.show,
                           time_budget_s=(args.time_budget_min or 0) * 60 or None,
                           shard=args.shard, shards=args.shards)
    log.info("transcribed=%d", n)
