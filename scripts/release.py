"""One-click release for overnight builds: bump APP_VERSION and the SW VERSION together, commit, push.

Call it from each loop iteration that changed code:

    python -m scripts.release "feat: 문장 반복(쉐도잉) 토글"      # minor bump (default): 1.70.0 -> 1.71.0
    python -m scripts.release --patch "fix: typo"                   # 1.70.0 -> 1.70.1
    python -m scripts.release --major "feat!: new shell"            # 1.70.0 -> 2.0.0
    python -m scripts.release --set 2.0.0 "feat!: new shell"        # explicit
    python -m scripts.release --dry-run "..."                       # print the plan, touch nothing

`window.APP_VERSION` in ui/index.html and `VERSION` in ui/service-worker.js MUST hold the
same value (they key the SW cache and the importmap query string). Bumping both in one step and
pushing makes the phone PWA's service worker fetch the new shell immediately.

⛔ Both constants are semver (MAJOR.MINOR.PATCH). An earlier version of this script assumed an
integer counter, so it died on 1.x.y with "APP_VERSION 을 index.html 에서 못 찾음" and versions
had to be bumped by hand — the exact drift risk this script exists to remove. Worse, its
service-worker guard only checked that the literal prefix `const VERSION = '` was present, then
called re.sub; re.sub silently returns the text unchanged when the pattern misses, so a
non-matching SW version would have been written back untouched with no error at all. Every write
below is therefore asserted by substitution count, and the result is re-read from disk and
compared before anything is committed.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# Windows 콘솔(cp949)에서 커밋 메시지의 em-dash 등 비ASCII 출력 시 크래시 방지.
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "ui" / "index.html"
SW = ROOT / "ui" / "service-worker.js"

# (file, human label, regex with the version string as group 2)
APP_RE = re.compile(r"(window\.APP_VERSION = ')([^']*)(')")
SW_RE = re.compile(r"(const VERSION = ')([^']*)(')")
SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")

LEVELS = ("major", "minor", "patch")


def _read_version(path: Path, pattern: re.Pattern[str], label: str) -> str:
    """Return the single semver literal `pattern` finds in `path`, or exit with why not."""
    text = path.read_text(encoding="utf-8")
    found = pattern.findall(text)
    if not found:
        raise SystemExit(f"release aborted — no {label} literal in {path.relative_to(ROOT)}")
    if len(found) > 1:
        raise SystemExit(
            f"release aborted — {label} appears {len(found)}x in {path.relative_to(ROOT)}; "
            "a bump would be ambiguous. Keep exactly one assignment."
        )
    value = found[0][1]
    if not SEMVER_RE.match(value):
        raise SystemExit(
            f"release aborted — {label} is {value!r} in {path.relative_to(ROOT)}, "
            "which is not MAJOR.MINOR.PATCH. Fix it by hand, then re-run."
        )
    return value


def _rewritten(path: Path, pattern: re.Pattern[str], new: str, label: str) -> str:
    """Return `path`'s text with its one `label` literal set to `new`. Writes nothing.

    ⛔ re.sub reports success by returning a string, not by raising — a missed pattern hands back
    the original text unchanged. Only the count tells the truth, so it is asserted here.

    Both files are rewritten in memory before either is written, so a failure on the second file
    can never leave the first one half-bumped — which would be the very drift this script exists
    to prevent.
    """
    text = path.read_text(encoding="utf-8")
    out, n = pattern.subn(rf"\g<1>{new}\g<3>", text)
    if n != 1:
        raise SystemExit(
            f"release aborted — expected exactly 1 {label} substitution in "
            f"{path.relative_to(ROOT)}, made {n}. Nothing written."
        )
    return out


def next_version(current: str, level: str) -> str:
    major, minor, patch = (int(x) for x in current.split("."))
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def bump(level: str = "minor", explicit: str | None = None, dry_run: bool = False) -> str:
    """Move both constants to the next version. Returns the new version.

    The two files are read first and BOTH must already agree; a pre-existing mismatch means a
    hand-edit went half-applied and a deploy is already serving a new shell against a stale SW
    cache. The bump unifies them, but it says so loudly rather than papering over it.
    """
    app_v = _read_version(INDEX, APP_RE, "window.APP_VERSION")
    sw_v = _read_version(SW, SW_RE, "service-worker VERSION")
    # ⛔ Bump from whichever constant is HIGHER, not from APP_VERSION. If they have drifted, the
    # next version has to clear BOTH, or the bump can land exactly on the value the other file
    # already holds — the service-worker cache key would then not change and phones would keep
    # serving the stale shell, which is the whole failure this script exists to prevent.
    base = max(app_v, sw_v, key=lambda v: tuple(int(x) for x in v.split(".")))
    if app_v != sw_v:
        print(
            f"⚠ drift found before bump: APP_VERSION={app_v} but service-worker VERSION={sw_v}. "
            f"They must match (SW cache key). Bumping from the higher of the two ({base}) so the "
            "new version clears both, and unifying them."
        )

    if explicit is not None:
        if not SEMVER_RE.match(explicit):
            raise SystemExit(f"release aborted — --set {explicit!r} is not MAJOR.MINOR.PATCH.")
        new = explicit
    else:
        new = next_version(base, level)

    if new == app_v or new == sw_v:
        raise SystemExit(
            f"release aborted — new version {new} equals a current one "
            f"(APP_VERSION={app_v}, SW={sw_v}); the SW cache key would not change."
        )

    plan = (
        f"  ui/index.html        window.APP_VERSION  {app_v} -> {new}\n"
        f"  ui/service-worker.js VERSION             {sw_v} -> {new}"
    )
    if dry_run:
        print(f"[dry-run] would bump ({explicit and 'explicit' or level}):\n{plan}")
        print("[dry-run] no files written, no commit, no push.")
        return new

    index_out = _rewritten(INDEX, APP_RE, new, "window.APP_VERSION")
    sw_out = _rewritten(SW, SW_RE, new, "service-worker VERSION")
    INDEX.write_text(index_out, encoding="utf-8")
    SW.write_text(sw_out, encoding="utf-8")

    # Post-write verification: re-read from disk so the guarantee is about the files that will be
    # committed, not about what this process believes it wrote.
    after_app = _read_version(INDEX, APP_RE, "window.APP_VERSION")
    after_sw = _read_version(SW, SW_RE, "service-worker VERSION")
    if not (after_app == after_sw == new):
        raise SystemExit(
            "release aborted — post-write check failed: "
            f"APP_VERSION={after_app}, SW VERSION={after_sw}, expected {new} for both. "
            "Files are on disk in that state; fix before committing."
        )
    print(f"bumped both constants: {app_v} -> {new}")
    return new


def check_ui_tracked() -> None:
    """ui/ 하위 정적 자산이 전부 git 추적되는지 확인 — 누락 시 release 중단.

    `.gitignore` 의 'data/' 규칙이 `ui/data/essentials.json` 까지 잡아 **한 번도 커밋 안 되고
    프로덕션 404** 였던 사고(2026-06-21) 재발 방지. gitignore 로 묻혀 `git status` 에도 안 뜨는
    파일을 잡으려면 '디스크 vs git ls-files' 비교가 유일한 방법(staging/ignore 무관).
    """
    ui = ROOT / "ui"
    tracked = set(subprocess.run(
        ["git", "ls-files", "ui"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.split())
    missing = []
    for p in ui.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT).as_posix()
        if p.name.startswith("_"):   # 하니스 픽스처(_mocks.js/_harness*.html)는 일시 생성물 → 제외
            continue
        if rel not in tracked:
            missing.append(rel)
    if missing:
        raise SystemExit(
            "release 중단 — ui/ 하위 비추적 파일(배포 누락 위험, 프로덕션 404 유발):\n  "
            + "\n  ".join(sorted(missing))
            + "\n→ .gitignore 확인(예: !ui/data/) 후 git add 하고 재시도."
        )
    # 2차 가드: .vercelignore 의 '앵커 없는' 디렉터리 패턴이 ui/ 하위를 잡으면 배포에서 제외된다
    # (git 엔 있지만 Vercel 이 안 올림 → 404). 'data/' 가 ui/data 까지 잡았던 사고의 두 번째 층.
    vi = ROOT / ".vercelignore"
    if vi.exists():
        snared = []
        for raw in vi.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith("!") or line.startswith("/"):
                continue
            name = line.rstrip("/")
            if "/" not in name and (ui / name).is_dir():   # 앵커 없는 디렉터리명이 ui/ 하위에 존재
                snared.append(f"'{line}' → ui/{name}/ 가 배포 제외됨")
        if snared:
            raise SystemExit(
                "release 중단 — .vercelignore 앵커없는 패턴이 ui/ 자산을 배포에서 제외(프로덕션 404):\n  "
                + "\n  ".join(snared)
                + "\n→ 해당 패턴을 '/data/' 처럼 루트 앵커로 고치고 재시도."
            )


def parse_args(argv: list[str]) -> tuple[str, str, str | None, bool]:
    """-> (commit message, level, explicit version or None, dry_run)."""
    level = "minor"
    explicit: str | None = None
    dry_run = False
    rest: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--major", "--minor", "--patch"):
            level = a[2:]
        elif a == "--dry-run":
            dry_run = True
        elif a == "--set":
            i += 1
            if i >= len(argv):
                raise SystemExit("release aborted — --set needs a version, e.g. --set 2.0.0")
            explicit = argv[i]
        elif a.startswith("--set="):
            explicit = a.split("=", 1)[1]
        elif a.startswith("--"):
            raise SystemExit(f"release aborted — unknown flag {a!r}")
        else:
            rest.append(a)
        i += 1
    msg = rest[0] if rest else "update"
    return msg, level, explicit, dry_run


def main() -> None:
    msg, level, explicit, dry_run = parse_args(sys.argv[1:])
    check_ui_tracked()   # 배포 누락 가드(아래 bump/commit 전에)
    new = bump(level=level, explicit=explicit, dry_run=dry_run)
    if dry_run:
        return
    full = f"{msg}\n\nv{new}\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
    subprocess.run(["git", "add", "-A"], cwd=ROOT, check=True)
    subprocess.run(["git", "commit", "-q", "-m", full], cwd=ROOT, check=True)
    subprocess.run(["git", "push", "-q", "origin", "main"], cwd=ROOT, check=True)
    print(f"released v{new}: {msg}")


if __name__ == "__main__":
    main()
