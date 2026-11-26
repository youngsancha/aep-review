"""The nightly Korean translation job must cover every show, not a frozen list.

ko_quality_pass.sh hardcoded ("aep", "allears", "wh") from 2026-08-15 to 2026-11-25, so cnn10 never
received a _ko.json and its newest episodes showed no Korean subtitles offline.
"""
import re
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "ko_quality_pass.sh"


def test_target_list_derives_shows_from_registry():
    src = SCRIPT.read_text()
    assert "for show in show_slugs():" in src
    assert not re.search(r"for show in \(\s*[\"']", src), "show list is hardcoded again"
