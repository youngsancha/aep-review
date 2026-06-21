"""밤샘 빌드용 원클릭 릴리스: APP_VERSION 과 SW VERSION 을 동시에 bump → commit → push.

루프 매 반복에서 코드 변경이 있으면 호출한다:
    python -m scripts.release "feat: 문장 반복(쉐도잉) 토글"

ui/index.html 의 window.APP_VERSION 과 ui/service-worker.js 의 VERSION 은 반드시
같은 값이어야 한다(SW 캐시 키·importmap 쿼리스트링). 둘을 한 번에 올려 push 하면
폰 PWA 의 service worker 가 새 셸을 받아 즉시 갱신된다 → 밤새 진행상황을 폰에서 확인 가능.
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


def bump() -> str:
    idx = INDEX.read_text(encoding="utf-8")
    m = re.search(r"window\.APP_VERSION = '(\d+)'", idx)
    if not m:
        raise SystemExit("APP_VERSION 을 index.html 에서 못 찾음")
    new = str(int(m.group(1)) + 1)
    INDEX.write_text(
        re.sub(r"(window\.APP_VERSION = ')\d+(')", rf"\g<1>{new}\g<2>", idx),
        encoding="utf-8",
    )
    sw = SW.read_text(encoding="utf-8")
    if "const VERSION = '" not in sw:
        raise SystemExit("VERSION 을 service-worker.js 에서 못 찾음")
    SW.write_text(
        re.sub(r"(const VERSION = ')\d+(')", rf"\g<1>{new}\g<2>", sw),
        encoding="utf-8",
    )
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


def main() -> None:
    msg = sys.argv[1] if len(sys.argv) > 1 else "update"
    check_ui_tracked()   # 배포 누락 가드(아래 bump/commit 전에)
    new = bump()
    full = f"{msg}\n\nv{new}\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
    subprocess.run(["git", "add", "-A"], cwd=ROOT, check=True)
    subprocess.run(["git", "commit", "-q", "-m", full], cwd=ROOT, check=True)
    subprocess.run(["git", "push", "-q", "origin", "main"], cwd=ROOT, check=True)
    print(f"released v{new}: {msg}")


if __name__ == "__main__":
    main()
