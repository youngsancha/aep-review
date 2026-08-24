"""resegment SSOT 파리티 — ui/views/episode.js 와 scripts/translate_transcripts.py 가
*동일한 문장 분절*과 *동일한 trKey* 를 내는지 실 transcript 픽스처로 검증한다.

왜 중요한가: 사전번역(_ko.json)은 Python 의 resegment+trkey 로 키를 만든다. 앱은 episode.js 의
resegment+trKey 로 같은 키를 조회한다. 두 분절이 1글자라도 어긋나면 trKey 가 달라져 _preKo
적중에 실패 → 조용히 MyMemory(직역) 폴백으로 새서 사전번역 품질이 무력화된다.

JS 쪽은 scripts/resegment_parity.mjs 가 episode.js 의 '실제' 함수 소스를 추출해 실행하므로
복사 드리프트가 없다. node 가 없으면 skip.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from scripts.translate_transcripts import resegment, trkey

ROOT = Path(__file__).resolve().parents[1]
TX_DIR = ROOT / "data" / "transcripts"
HARNESS = ROOT / "scripts" / "resegment_parity.mjs"

# 너무 많으면 느리니 대표 표본(앞/중간/뒤 골고루) — 충분히 넓게 잡아 분절 분기 다 커버.
SAMPLE_IDS = ["1", "10", "50", "100", "150", "200", "250", "260", "264"]


def _disk_ids() -> list[str]:
    if not TX_DIR.exists():
        return []
    return [p.stem for p in TX_DIR.glob("*.json") if p.stem.isdigit()]


def _py_segments(ep_id: str) -> list[dict]:
    tr = json.loads((TX_DIR / f"{ep_id}.json").read_text(encoding="utf-8"))
    return tr.get("segments", [])


@pytest.fixture(scope="module")
def js_output() -> dict:
    """node 하니스로 JS resegment 결과를 받아온다. node 없으면 전체 skip."""
    if shutil.which("node") is None:
        pytest.skip("node 미설치 — JS 파리티 비교 skip")
    if not HARNESS.exists():
        pytest.skip("resegment_parity.mjs 없음")
    # ⚠ 예전엔 _disk_ids()[:8] 이었다. glob 순서가 사실상 id 오름차순이라 '가장 오래된 8개'만
    # 비교했고, 새로 받은 회차(백악관 브리핑처럼 분절 분기가 다른 것)는 픽스처를 넣어도 영영
    # 비교 대상에 못 들어갔다 — 2026-08-07 에 U.S./Ms. 약어 분절 버그를 고치면서 드러났다.
    # 양끝(오래된 것 + 최신)을 함께 잡는다.
    # ⛔ 예전엔 `[존재하는 SAMPLE_IDS] or (disk[:5]+disk[-5:])` 였다. `or` 는 앞이 비었을
    # 때만 뒤를 쓰므로, SAMPLE_IDS 중 하나만 디스크에 있어도 양끝 폴백이 통째로 죽는다 —
    # [:8] 을 고치면서 없앴다고 본 그 실명이 형태만 바꿔 남아 있었다. 이제 둘을 '합친다'.
    disk = sorted(_disk_ids(), key=int)
    picked = [i for i in SAMPLE_IDS if (TX_DIR / f"{i}.json").exists()]
    # 항상 양끝을 포함한다: 가장 오래된 쪽(초기 aep)과 가장 최신 쪽(새 쇼가 들어오는 자리).
    ids = sorted({*picked, *disk[:5], *disk[-5:]}, key=int)
    if not ids:
        pytest.skip("data/transcripts 픽스처 없음")
    proc = subprocess.run(
        ["node", str(HARNESS), "--ids", ",".join(ids)],
        capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT), timeout=120,
    )
    assert proc.returncode == 0, f"node 하니스 실패: {proc.stderr[:500]}"
    return json.loads(proc.stdout)


def test_sentence_boundaries_match(js_output):
    """각 회차: JS 문장 리스트 == Python 문장 리스트 (개수·내용 1글자도 안 어긋남)."""
    mismatches = []
    for ep_id, js in js_output.items():
        py_sents = [s for s in resegment(_py_segments(ep_id))]
        js_sents = js["sents"]
        if py_sents != js_sents:
            # 첫 불일치 위치를 찾아 보고
            n = min(len(py_sents), len(js_sents))
            first = next((k for k in range(n) if py_sents[k] != js_sents[k]), n)
            mismatches.append(
                f"ep {ep_id}: len js={len(js_sents)} py={len(py_sents)}, "
                f"first diff @ {first}:\n    JS={js_sents[first] if first < len(js_sents) else '<none>'!r}\n"
                f"    PY={py_sents[first] if first < len(py_sents) else '<none>'!r}"
            )
    assert not mismatches, "resegment 분절 불일치:\n" + "\n".join(mismatches)


def test_trkeys_match(js_output):
    """trKey 정규화까지 동일해야 _preKo 조회가 맞는다(소문자·공백정규화·180자)."""
    mismatches = []
    for ep_id, js in js_output.items():
        py_keys = [trkey(s) for s in resegment(_py_segments(ep_id))]
        if py_keys != js["keys"]:
            n = min(len(py_keys), len(js["keys"]))
            first = next((k for k in range(n) if py_keys[k] != js["keys"][k]), n)
            mismatches.append(f"ep {ep_id} trKey diff @ {first}")
    assert not mismatches, "trKey 불일치: " + ", ".join(mismatches)
