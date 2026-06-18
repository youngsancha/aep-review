"""FastAPI app — 라우트 + PWA static mount.

실행:
    python -m api.run            # host 0.0.0.0 (LAN 폰 접속)
    uvicorn api.server:app --port 8767 --reload
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .db import init_db
from .routes_episodes import router as episodes_router
from .routes_srs import router as srs_router
from .routes_sync import router as sync_router
from .routes_tts import router as tts_router

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
UI_DIR = PROJECT_ROOT / "ui"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="American English Podcast 복습", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)

app.include_router(episodes_router)
app.include_router(srs_router)
app.include_router(sync_router)
app.include_router(tts_router)

if UI_DIR.exists():
    app.mount("/", StaticFiles(directory=str(UI_DIR), html=True), name="ui")


def main() -> None:
    import uvicorn

    port = int(os.getenv("PORT", "8767"))
    uvicorn.run("api.server:app", host="127.0.0.1", port=port, reload=True)


if __name__ == "__main__":
    main()
