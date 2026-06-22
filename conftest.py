"""pytest 부트스트랩 — 프로젝트 루트를 sys.path 에 넣어 `scripts`/`ingest` 네임스페이스
패키지를 테스트가 import 할 수 있게 한다(scripts/ 에 __init__.py 가 없어도 동작)."""
import sys
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
