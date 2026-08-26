"""resegment SSOT 파리티 — ui/views/episode.js 와 scripts/translate_transcripts.py 가
*동일한 문장 분절*과 *동일한 trKey* 를 내는지 실 transcript 픽스처로 검증한다.

왜 중요한가: 사전번역(_ko.json)은 Python 의 resegment+trkey 로 키를 만든다. 앱은 episode.js 의
resegment+trKey 로 같은 키를 조회한다. 두 분절이 1글자라도 어긋나면 trKey 가 달라져 _preKo
적중에 실패 → 조용히 MyMemory(직역) 폴백으로 새서 사전번역 품질이 무력화된다.

JS 쪽은 scripts/resegment_parity.mjs 가 episode.js 의 '실제' 함수 소스를 추출해 실행하므로
복사 드리프트가 없다. node 가 없으면 skip.

⛔ This test used to SKIP — and therefore read green — whenever `data/transcripts/` was empty.
That directory is gitignored pipeline output, so it IS empty on CI and on every fresh checkout:
the only guard on this invariant did nothing at all, indefinitely, without anyone seeing a
warning. It now runs against `tests/fixtures/transcripts/`, which is committed, and treats the
absence of that corpus as a FAILURE rather than a skip. `data/transcripts/` is still compared on
top whenever it happens to be populated — a wider net, never the only one.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from scripts.translate_transcripts import resegment, trkey

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "transcripts"   # committed — see scripts/make_parity_fixtures.py
TX_DIR = ROOT / "data" / "transcripts"                    # gitignored pipeline output, optional
HARNESS = ROOT / "scripts" / "resegment_parity.mjs"

# 너무 많으면 느리니 대표 표본(앞/중간/뒤 골고루) — 충분히 넓게 잡아 분절 분기 다 커버.
SAMPLE_IDS = ["1", "10", "50", "100", "150", "200", "250", "260", "264"]

# The committed corpus is 6 slices across all three shows, ~342 sentences. A floor is asserted so
# that a fixture being truncated, emptied or dropped shrinks the comparison *loudly* — otherwise a
# 1-sentence corpus would still pass every parity assertion below and mean nothing.
MIN_FIXTURE_EPISODES = 5
MIN_FIXTURE_SENTENCES = 300


def _ids_in(directory: Path) -> list[str]:
    if not directory.exists():
        return []
    return sorted((p.stem for p in directory.glob("*.json") if p.stem.isdigit()), key=int)


def _segments(directory: Path, ep_id: str) -> list[dict]:
    tr = json.loads((directory / f"{ep_id}.json").read_text(encoding="utf-8"))
    return tr.get("segments", [])


def _run_harness(directory: Path, ids: list[str]) -> dict:
    proc = subprocess.run(
        ["node", str(HARNESS), "--dir", str(directory), "--ids", ",".join(ids)],
        capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT), timeout=180,
    )
    assert proc.returncode == 0, f"node 하니스 실패({directory.name}): {proc.stderr[:500]}"
    return json.loads(proc.stdout)


def test_committed_fixture_corpus_is_present_and_substantial():
    """Absence must fail, not skip — this is the check that was missing for months.

    Kept separate from the parity tests so it still runs (and still fails) on a machine with no
    node, where the comparison itself can only skip.
    """
    ids = _ids_in(FIXTURES)
    assert ids, (
        f"{FIXTURES.relative_to(ROOT)} has no transcript fixtures. The JS/Python resegment parity "
        "check cannot run without them and MUST NOT quietly skip — that is how a trKey divergence "
        "survives. Restore them from git, or regenerate with "
        "`python -m scripts.make_parity_fixtures` on a machine that has data/transcripts/."
    )
    assert len(ids) >= MIN_FIXTURE_EPISODES, (
        f"only {len(ids)} fixture episodes, expected >= {MIN_FIXTURE_EPISODES} "
        "(one per show family, so a show-specific segmentation branch stays inside the comparison)"
    )
    total = sum(len(resegment(_segments(FIXTURES, i))) for i in ids)
    assert total >= MIN_FIXTURE_SENTENCES, (
        f"fixture corpus resegments to only {total} sentences, expected >= {MIN_FIXTURE_SENTENCES}. "
        "A shrunken corpus makes every parity assertion below pass while comparing almost nothing."
    )


@pytest.fixture(scope="module")
def js_output() -> dict:
    """node 하니스로 JS resegment 결과를 받아온다. node 없으면 전체 skip.

    Returns {"<dir label>/<ep id>": {"sents", "keys", "dir"}} so the Python side can read the
    matching file back from the directory the JS result actually came from.
    """
    fixture_ids = _ids_in(FIXTURES)
    if not fixture_ids:
        # Not a skip. test_committed_fixture_corpus_is_present_and_substantial explains why.
        pytest.fail(f"{FIXTURES.relative_to(ROOT)} is empty — parity cannot be verified.")
    if shutil.which("node") is None:
        pytest.skip("node 미설치 — JS 파리티 비교 skip")
    if not HARNESS.exists():
        pytest.fail("resegment_parity.mjs 없음 — 파리티 하니스가 사라졌다")

    merged: dict[str, dict] = {}
    for label, directory, ids in _corpora(fixture_ids):
        if not ids:
            continue
        for ep_id, res in _run_harness(directory, ids).items():
            merged[f"{label}/{ep_id}"] = {**res, "dir": directory}
    assert merged, "하니스가 아무 회차도 못 읽었다"
    # ⛔ "green" must not be able to mean "compared almost nothing". The harness skips ids whose
    # file it cannot read, silently and by design (`catch { continue }`), so a corrupt or renamed
    # fixture would shrink the comparison without failing anything. Pin that every committed
    # fixture actually reached the JS side.
    missing = [i for i in fixture_ids if f"fixtures/{i}" not in merged]
    assert not missing, (
        f"하니스가 픽스처 {missing} 를 못 읽었다 — 파일이 깨졌거나 이름이 바뀌었다. "
        "비교 대상이 조용히 줄어든 채로 통과하면 안 된다."
    )
    return merged


def _corpora(fixture_ids: list[str]) -> list[tuple[str, Path, list[str]]]:
    """The committed corpus always; the pipeline corpus too when the machine happens to have it."""
    out = [("fixtures", FIXTURES, fixture_ids)]
    # ⚠ 예전엔 _disk_ids()[:8] 이었다. glob 순서가 사실상 id 오름차순이라 '가장 오래된 8개'만
    # 비교했고, 새로 받은 회차(백악관 브리핑처럼 분절 분기가 다른 것)는 픽스처를 넣어도 영영
    # 비교 대상에 못 들어갔다 — 2026-08-07 에 U.S./Ms. 약어 분절 버그를 고치면서 드러났다.
    # 양끝(오래된 것 + 최신)을 함께 잡는다.
    # ⛔ 예전엔 `[존재하는 SAMPLE_IDS] or (disk[:5]+disk[-5:])` 였다. `or` 는 앞이 비었을
    # 때만 뒤를 쓰므로, SAMPLE_IDS 중 하나만 디스크에 있어도 양끝 폴백이 통째로 죽는다 —
    # [:8] 을 고치면서 없앴다고 본 그 실명이 형태만 바꿔 남아 있었다. 이제 둘을 '합친다'.
    disk = _ids_in(TX_DIR)
    if disk:
        picked = [i for i in SAMPLE_IDS if (TX_DIR / f"{i}.json").exists()]
        out.append(("disk", TX_DIR, sorted({*picked, *disk[:5], *disk[-5:]}, key=int)))
    return out


def test_sentence_boundaries_match(js_output):
    """각 회차: JS 문장 리스트 == Python 문장 리스트 (개수·내용 1글자도 안 어긋남)."""
    mismatches = []
    for key, js in js_output.items():
        ep_id = key.split("/", 1)[1]
        py_sents = [s for s in resegment(_segments(js["dir"], ep_id))]
        js_sents = js["sents"]
        if py_sents != js_sents:
            # 첫 불일치 위치를 찾아 보고
            n = min(len(py_sents), len(js_sents))
            first = next((k for k in range(n) if py_sents[k] != js_sents[k]), n)
            mismatches.append(
                f"ep {key}: len js={len(js_sents)} py={len(py_sents)}, "
                f"first diff @ {first}:\n    JS={js_sents[first] if first < len(js_sents) else '<none>'!r}\n"
                f"    PY={py_sents[first] if first < len(py_sents) else '<none>'!r}"
            )
    assert not mismatches, "resegment 분절 불일치:\n" + "\n".join(mismatches)


def test_trkeys_match(js_output):
    """trKey 정규화까지 동일해야 _preKo 조회가 맞는다(소문자·공백정규화·180자)."""
    mismatches = []
    for key, js in js_output.items():
        ep_id = key.split("/", 1)[1]
        py_keys = [trkey(s) for s in resegment(_segments(js["dir"], ep_id))]
        if py_keys != js["keys"]:
            n = min(len(py_keys), len(js["keys"]))
            first = next((k for k in range(n) if py_keys[k] != js["keys"][k]), n)
            mismatches.append(f"ep {key} trKey diff @ {first}")
    assert not mismatches, "trKey 불일치: " + ", ".join(mismatches)
