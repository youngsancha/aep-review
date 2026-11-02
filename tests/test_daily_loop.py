"""scripts/daily_local_loop.sh, run for real against stub commands in a throwaway tree.

The loop is launchd-only and always exits 0, so a broken gate shows up as a quiet log line. On
2026-11-01 ollama lost its models: step 1 died in 6 s, step 2 hung for 1,504 s and then reported
success with 0 episodes, and nobody was told.
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _stub(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body + "\n", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


@pytest.fixture
def sandbox(tmp_path):
    def run(ollama_ok: bool, failing: str = "") -> tuple[list[str], list[str], str]:
        repo = tmp_path / "repo"
        home = tmp_path / "home"
        (repo / "scripts").mkdir(parents=True)
        home.mkdir()
        shutil.copy(ROOT / "scripts" / "daily_local_loop.sh", repo / "scripts")
        calls = tmp_path / "calls.log"
        tasks = tmp_path / "tasks.log"
        # The preflight is the only `-c` call. Every step is `python -m <module>`.
        _stub(repo / ".venv" / "bin" / "python", f"""
case "$1" in
  -c) exit {0 if ollama_ok else 1} ;;
  -m) echo "$2" >> "{calls}"; case "$2" in *{failing or "__none__"}*) exit 3 ;; esac ;;
esac
exit 0""")
        _stub(repo / "scripts" / "ko_quality_pass.sh", f'echo "ko_quality_pass $*" >> "{calls}"')
        _stub(home / ".local" / "bin" / "td-task", f'echo "$*" >> "{tasks}"')
        _stub(home / ".local" / "bin" / "ccsecret", "exit 1")
        env = {"HOME": str(home), "PATH": "/usr/bin:/bin"}
        r = subprocess.run(["bash", str(repo / "scripts" / "daily_local_loop.sh")], env=env,
                           capture_output=True, text=True, timeout=30)
        assert r.returncode == 0, r.stderr     # launchd contract: the loop always exits 0
        read = lambda p: p.read_text(encoding="utf-8").splitlines() if p.exists() else []  # noqa: E731
        return read(calls), read(tasks), r.stdout

    return run


def test_all_steps_run_in_order_when_ollama_has_the_model(sandbox):
    calls, tasks, _ = sandbox(ollama_ok=True)
    assert calls[0] == "scripts.storage_guard"
    assert calls[1:3] == ["scripts.resegment_llm", "ingest.extract_vocab"]
    assert calls[3].startswith("ko_quality_pass ")
    assert tasks == []


def test_translation_defaults_to_two_shards(sandbox):
    # Four shards took a 16 GB machine to 15 GB of swap (2026-10-25).
    calls, _, _ = sandbox(ollama_ok=True)
    assert calls[3] == "ko_quality_pass 50 2"


def test_missing_model_skips_llm_steps_and_files_one_task(sandbox):
    calls, tasks, out = sandbox(ollama_ok=False)
    assert calls == ["scripts.storage_guard"]     # guard needs no LLM, so it still runs
    assert len(tasks) == 1
    assert "[ollama]" in tasks[0] and "-P aep-review" in tasks[0]
    assert "건너뜀" in out


def test_a_failed_step_does_not_stop_the_next_and_is_reported(sandbox):
    calls, tasks, _ = sandbox(ollama_ok=True, failing="extract_vocab")
    assert calls[-1].startswith("ko_quality_pass ")
    assert len(tasks) == 1 and "vocab" in tasks[0]


def test_stub_env_does_not_leak_real_home():
    # Guards the fixture itself: the script must take its log path from $HOME.
    assert 'LOG="$HOME/Library/Logs/aep-daily-loop.log"' in (
        ROOT / "scripts" / "daily_local_loop.sh").read_text(encoding="utf-8")
    assert os.environ.get("HOME")
