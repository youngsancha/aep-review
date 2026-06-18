"""LAN 노출 진입점: `python -m api.run` (host=0.0.0.0).

같은 Wi-Fi 의 폰에서 LAN IP 로 접근 가능. PWA 인스톨 테스트용.
"""
from __future__ import annotations

import os

import uvicorn


def main() -> None:
    reload = os.getenv("AEP_RELOAD", "1") not in ("0", "false", "False", "")
    port = int(os.getenv("PORT", "8767"))
    uvicorn.run("api.server:app", host="0.0.0.0", port=port, reload=reload)


if __name__ == "__main__":
    main()
