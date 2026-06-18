"""SQLite 연결 + 스키마.

`data/episodes.db` 단일 파일. 음성/transcript 본문은 파일시스템.
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
DB_PATH = DATA_DIR / "episodes.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT UNIQUE NOT NULL,
  season INTEGER,
  episode_no INTEGER,
  title TEXT NOT NULL,
  pub_date TEXT NOT NULL,
  duration_sec INTEGER,
  description TEXT,
  audio_url TEXT,
  audio_path TEXT,
  transcript_path TEXT,
  transcribed_at TEXT,
  vocab_extracted_at TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_episodes_pub ON episodes(pub_date DESC);

CREATE TABLE IF NOT EXISTS vocab_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  kind TEXT,
  definition TEXT,
  example_sentence TEXT,
  sentence_start_sec REAL,
  sentence_end_sec REAL,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_vocab_episode ON vocab_cards(episode_id);

CREATE TABLE IF NOT EXISTS srs_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  vocab_id INTEGER REFERENCES vocab_cards(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  category TEXT,
  ease REAL DEFAULT 2.5,
  interval_days INTEGER DEFAULT 0,
  due_date TEXT NOT NULL,
  reps INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_srs_due ON srs_cards(due_date);
"""


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "audio").mkdir(exist_ok=True)
    (DATA_DIR / "transcripts").mkdir(exist_ok=True)
    (DATA_DIR / "tts").mkdir(exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
