"""scripts/release.py: flag parsing and the commit message it writes."""
from __future__ import annotations

import pytest

from scripts import release


def test_defaults_release_with_every_gate_and_a_push():
    opts = release.parse_args(["fix: typo"])
    assert (opts.msg, opts.level, opts.explicit) == ("fix: typo", "minor", None)
    assert opts.push is True and opts.gates is True and opts.dry_run is False


def test_no_push_is_how_a_loop_batches_deploys():
    assert release.parse_args(["--patch", "--no-push", "fix"]).push is False


def test_skip_gates_is_explicit():
    assert release.parse_args(["--skip-gates", "hotfix"]).gates is False


def test_unknown_flag_stops_the_release():
    with pytest.raises(SystemExit):
        release.parse_args(["--force", "x"])


def test_version_goes_on_the_subject():
    assert release.commit_message("fix: typo", "1.2.3") == "fix: typo (v1.2.3)"


def test_body_and_trailers_stay_last():
    # Git only reads trailers from the final paragraph, so nothing may be appended after them.
    msg = "fix: typo\n\nBody.\n\nCo-Authored-By: A <a@example.com>"
    assert release.commit_message(msg, "1.2.3") == (
        "fix: typo (v1.2.3)\n\nBody.\n\nCo-Authored-By: A <a@example.com>"
    )
