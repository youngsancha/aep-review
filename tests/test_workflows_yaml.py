"""워크플로 YAML 정적 검사.

왜 있나 (2026-07-27): 스텝에 `env:` 를 두 번 쓴 채로 커밋했는데 `yaml.safe_load` 는
그냥 통과시켰다 — PyYAML 은 중복 키를 조용히 허용하고 뒤엣것으로 덮어쓴다. GitHub 은
거부한다("'env' is already defined"), 그것도 dispatch 를 시도해야 알 수 있다.
로컬에서 통과하고 원격에서만 깨지는 오류라 게이트가 잡아야 한다.
"""
from __future__ import annotations

import glob
from pathlib import Path

import pytest
import yaml

WORKFLOWS = sorted(glob.glob(str(Path(__file__).resolve().parents[1] / ".github/workflows/*.yml")))


class _StrictLoader(yaml.SafeLoader):
    pass


def _no_duplicate_keys(loader, node, deep=False):
    seen: set = set()
    for key_node, _ in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in seen:
            raise yaml.YAMLError(f"duplicate key {key!r} at line {key_node.start_mark.line + 1}")
        seen.add(key)
    return yaml.SafeLoader.construct_mapping(loader, node, deep)


_StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _no_duplicate_keys)


def test_workflows_exist():
    assert WORKFLOWS, ".github/workflows 에 yml 이 없다"


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: Path(p).name)
def test_no_duplicate_keys(path):
    yaml.load(Path(path).read_text(), _StrictLoader)


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: Path(p).name)
def test_jobs_have_timeout(path):
    """timeout-minutes 가 없으면 GitHub 기본 360분까지 매달린다 — STT 잡에선 비싸다."""
    doc = yaml.load(Path(path).read_text(), _StrictLoader)
    for name, job in (doc.get("jobs") or {}).items():
        if "steps" not in job:          # matrix 를 만들기만 하는 준비 job 등은 제외
            continue
        heavy = any("retranscribe" in str(s.get("run", "")) or "cron_fetch" in str(s.get("run", ""))
                    or "wh_fetch" in str(s.get("run", "")) for s in job["steps"])
        if heavy:
            assert job.get("timeout-minutes"), f"{Path(path).name}:{name} STT 잡에 timeout-minutes 없음"


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: Path(p).name)
def test_stt_steps_carry_a_time_budget(path):
    """시간 예산 없이 STT 를 돌리면 job timeout 에서 잘려 그 회차 연산이 통째로 버려진다.

    2026-07-26 까지 aep-sync 가 매일 이렇게 죽었다. 회귀 방지.
    """
    doc = yaml.load(Path(path).read_text(), _StrictLoader)
    for name, job in (doc.get("jobs") or {}).items():
        for step in job.get("steps", []):
            run = str(step.get("run", ""))
            if "cron_fetch" in run or "scripts.retranscribe" in run:
                assert "--time-budget-min" in run, (
                    f"{Path(path).name}:{name} STT 스텝에 --time-budget-min 없음 — "
                    "건수 제한만으로는 job timeout 을 못 막는다"
                )
