"""Supabase 데이터 접근 계층 (인제스트 sink).

기존 SQLite(api/db.py) 자리. faster-whisper/claude 로직은 그대로 두고,
"무엇이 처리됐나" 추적 + 결과 write 만 Supabase 로.

service_role 키 사용 (RLS 우회) — .env 의 SUPABASE_URL / SUPABASE_SERVICE_KEY.
TTS 키 공식·합성 헬퍼의 단일 출처 (마이그레이션 스크립트·프론트와 동일해야 함).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from datetime import date, datetime
from functools import lru_cache
from pathlib import Path
from collections.abc import Sequence
from typing import Any

import edge_tts
from dotenv import load_dotenv
from supabase import Client, create_client

log = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 프론트(ui/tts.js)·마이그레이션과 반드시 동일.
TTS_VOICE = "en-US-JennyNeural"
TTS_RATE = "-5%"


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


@lru_cache(maxsize=1)
def client() -> Client:
    load_dotenv(PROJECT_ROOT / ".env")
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        raise SystemExit("SUPABASE_URL / SUPABASE_SERVICE_KEY 가 .env 에 없습니다. supabase/README.md 참고.")
    return create_client(url, key)


# ─────────────────────────── R2 (오디오 호스팅) ───────────────────────────
# 우리가 STT 하는 '바로 그 오디오'를 R2 에 올려, 앱이 그걸 스트리밍 → 자막=오디오 영구 일치(DAI 광고
# 로테이션 무관, 완전 자동 싱크). 업로드는 S3 호환 API(R2_ENDPOINT). 로컬 네트워크가 막아도 CI 는 OK.
@lru_cache(maxsize=1)
def r2():
    load_dotenv(PROJECT_ROOT / ".env")
    import boto3
    from botocore.config import Config
    ep = os.environ.get("R2_ENDPOINT")
    ak = os.environ.get("R2_ACCESS_KEY_ID")
    sk = os.environ.get("R2_SECRET_ACCESS_KEY")
    if not (ep and ak and sk):
        raise SystemExit("R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY 가 환경에 없습니다.")
    return boto3.client("s3", endpoint_url=ep, aws_access_key_id=ak, aws_secret_access_key=sk,
                        region_name="auto", config=Config(signature_version="s3v4", retries={"max_attempts": 3}))


def r2_bucket() -> str:
    return os.environ.get("R2_BUCKET", "aep-audio")


def r2_audio_exists(ep_id: int) -> bool:
    import botocore
    try:
        r2().head_object(Bucket=r2_bucket(), Key=f"{ep_id}.mp3")
        return True
    except botocore.exceptions.ClientError:
        return False


def upload_audio_r2(ep_id: int, path: Any) -> int:
    """오디오 파일을 R2 의 {id}.mp3 로 업로드. 반환: 바이트 수."""
    p = Path(path)
    r2().upload_file(str(p), r2_bucket(), f"{ep_id}.mp3", ExtraArgs={"ContentType": "audio/mpeg"})
    return p.stat().st_size


# 호스팅 '완료'(=R2 오디오 + 그와 일치하는 자막) 매니페스트 — Supabase transcripts 버킷의 public JSON.
# 앱은 이 목록의 회차만 R2 스트리밍(자막 일치 보장), 나머지는 기존 megaphone(폴백).
HOSTED_MANIFEST = "audio_hosted.json"


def _is_not_found(e: Exception) -> bool:
    """Storage 다운로드 예외가 '객체 없음(404)' 인지 — 일시적 네트워크 오류와 구분."""
    s = f"{type(e).__name__}: {e}".lower()
    return any(k in s for k in ("not_found", "not found", "404", "no such", "object not found"))


def load_hosted(strict: bool = False) -> set[int]:
    """호스팅 매니페스트 로드. 객체가 없으면(최초) 빈 집합.

    strict=True: 일시적 오류(네트워크)면 빈 집합 대신 예외를 올린다 — 호출부(mark_hosted)가
    매니페스트를 '빈 상태에서 덮어쓰기'(축소)하지 않게 한다. (2026-06-24 사고: load 실패→빈집합
    →AEP 268개 전부 유실→앱이 AEP 를 megaphone DAI 로 재생→자막 desync. 이 가드로 재발 차단.)
    """
    try:
        raw = client().storage.from_("transcripts").download(HOSTED_MANIFEST)
        return set(json.loads(raw))
    except Exception as e:
        if _is_not_found(e):
            return set()             # 매니페스트 자체가 없음(최초 호스팅) → 빈 집합이 맞음
        if strict:
            raise                    # 일시적 오류 → 절대 빈 집합 반환 X (호출부 축소 방지)
        log.warning("load_hosted 매니페스트 다운로드 실패(%s) — 빈 집합 반환(비-strict 읽기)", e)
        return set()


def mark_hosted(ep_id: int) -> None:
    ids = load_hosted(strict=True)   # 일시적 오류면 raise → 이 회차 마킹만 다음에 재시도(매니페스트 보존)
    if int(ep_id) in ids:
        return
    ids.add(int(ep_id))
    body = json.dumps(sorted(ids)).encode("utf-8")
    sb = client().storage.from_("transcripts")
    try:
        sb.update(HOSTED_MANIFEST, body, {"content-type": "application/json", "upsert": "true"})
    except Exception:
        sb.upload(HOSTED_MANIFEST, body, {"content-type": "application/json", "upsert": "true"})


# ─────────────────────────── episodes ───────────────────────────
# ⛔⛔ PostgREST 는 select 를 기본 1,000 행에서 **조용히** 자른다. 에러도 경고도 없고,
# 응답은 완전한 결과와 구별되지 않는다. 이것이 aep-sync 를 2026-08-23 부터 매일 죽인
# 원인이다: 일일 cron 은 show=None 으로 돌아 필터 없는 경로를 타고, episodes 가 1,026 행이
# 되는 순간 dedupe 집합에 1,000 개만 담겼다. 잘려나간 26 개 중 하나가 RSS 에 다시 나타나면
# 이미 있는 회차를 신규로 보고 insert → episodes_show_guid_key 중복키로 런 전체가 죽는다.
# 코드는 한 줄도 안 바뀌었고 **데이터가 자라서** 깨졌다.
_PAGE = 1000        # PostgREST 기본 상한. 여기 맞춰 명시적으로 페이지를 넘긴다.
_IN_CHUNK = 200     # in_() 한 번에 넣는 guid 수 (URL 길이 안전선)


def existing_guids(show: str | None = None,
                   guids: Sequence[str] | None = None) -> set[str]:
    """이미 저장된 guid 집합.

    show=None(레거시): 전체 guid. show 지정(멀티-쇼): (show, guid) 쇼별 독립 dedupe.

    ⭐ 검사할 배치를 이미 아는 호출자는 `guids` 를 넘겨라. 그러면 질의가 **테이블 크기가
    아니라 배치 크기에 비례**하므로 episodes 가 아무리 커져도 절대 잘리지 않는다.
    `guids` 없이 부르는 경로는 명시적으로 페이지를 넘겨 서버의 조용한 절단을 받지 않는다.
    """
    def _base():
        q = client().table("episodes").select("guid")
        return q.eq("show", show) if show else q

    found: set[str] = set()

    if guids is not None:
        todo = list(dict.fromkeys(guids))       # 순서 보존 dedupe
        for i in range(0, len(todo), _IN_CHUNK):
            rows = _base().in_("guid", todo[i:i + _IN_CHUNK]).execute().data or []
            found.update(r["guid"] for r in rows)
        return found

    # ⛔⛔ .range() without .order() is not pagination. Postgres does not promise a row
    # order without ORDER BY, so page 2 can be drawn from a different physical order than
    # page 1 and a guid falls between them — the same silent omission this function was
    # rewritten to stop. Ordering by id ASCENDING also makes a concurrent insert harmless:
    # a new row always lands after every page already read, so it can never shift one.
    # (Raised by xcheck 2026-08-30.)
    start = 0
    while True:
        rows = _base().order("id", desc=False).range(start, start + _PAGE - 1).execute().data or []
        found.update(r["guid"] for r in rows)
        if len(rows) < _PAGE:
            return found
        start += _PAGE


def upsert_episodes(items: list[dict[str, Any]], show: str | None = None) -> tuple[int, int]:
    """RSS 신규만 insert. 반환: (added, skipped).

    show=None(기본·레거시): show 컬럼을 건드리지 않는다 → 마이그레이션 전에도 안전(DB default 'aep'
    가 채움). show 지정 시 그 슬러그로 기록 + 쇼별 dedupe(멀티-쇼). 이 분기 덕에 일일 cron(show 미지정)
    은 컬럼 유무와 무관하게 동작하고, AEE 적재(--show allears)만 show 컬럼을 쓴다.
    """
    # 이 배치의 guid 만 물어본다 → 테이블이 커져도 절대 잘리지 않는다.
    have = existing_guids(show, guids=[it["guid"] for it in items])
    now = _now()
    new_rows: list[dict[str, Any]] = []
    for it in items:
        if it["guid"] in have:
            continue
        row = {
            "guid": it["guid"], "season": it["season"], "episode_no": it["episode_no"],
            "title": it["title"], "pub_date": it["pub_date"] or None,
            "duration_sec": it["duration_sec"], "description": it["description"],
            "audio_url": it["audio_url"], "created_at": now,
        }
        if show:
            row["show"] = show
        new_rows.append(row)
    if new_rows:
        try:
            client().table("episodes").insert(new_rows).execute()
        except Exception as e:
            # dedupe 가 제대로면 여기 올 일이 없다. 그래도 한 건의 중복키가 하루치 런
            # 전체(전사·vocab 포함)를 죽이게 두지는 않는다 — 실제로 그래서 7일을 잃었다.
            # ⛔ 조용히 넘기지 않는다: 여기 오는 것 자체가 dedupe 버그의 신호다.
            if "duplicate key" not in str(e):
                raise
            log.error("upsert_episodes: DEDUPE MISSED %d row(s) — inserting with "
                      "on_conflict ignore so the run continues, but this is a bug: %s",
                      len(new_rows), e)
            res = (client().table("episodes")
                   .upsert(new_rows, on_conflict="show,guid", ignore_duplicates=True)
                   .execute())
            # 시도한 수가 아니라 실제로 들어간 수를 돌려준다 — 이 경로는 이미 dedupe 가
            # 틀렸다는 뜻이므로, 개수까지 낙관적으로 보고하면 신호가 한 번 더 흐려진다.
            written = len(res.data or [])
            return written, len(items) - written
    return len(new_rows), len(items) - len(new_rows)


def episodes_needing_transcription(show: str | None = None) -> list[dict[str, Any]]:
    q = (client().table("episodes")
         .select("id, audio_url, duration_sec")
         .is_("transcribed_at", "null").not_.is_("audio_url", "null"))
    if show:                                  # 멀티-쇼: 해당 쇼의 pending 만(None=전체, 현행)
        q = q.eq("show", show)
    # pub_date 동률이 실제로 존재한다 → id 를 2차 키로 넣어 전순서를 만든다.
    # (샤딩된 병렬 실행이 같은 목록을 봐야 하고, 재실행 순서도 재현 가능해야 한다.)
    return q.order("pub_date", desc=True).order("id", desc=True).execute().data or []


def episodes_needing_vocab(show: str | None = None) -> list[dict[str, Any]]:
    # show 미포함 select → 마이그레이션 전에도 안전. 쇼 라벨은 extract_pending 이 show 인자로 전달.
    q = (client().table("episodes")
         .select("id, title")
         .not_.is_("transcribed_at", "null").is_("vocab_extracted_at", "null"))
    if show:
        q = q.eq("show", show)
    return q.order("pub_date", desc=True).execute().data or []


def mark_transcribed(ep_id: int, whisper_duration: float | None) -> None:
    patch: dict[str, Any] = {"transcribed_at": _now()}
    if whisper_duration:
        cur = (client().table("episodes").select("duration_sec").eq("id", ep_id)
               .single().execute().data or {})
        if not cur.get("duration_sec"):  # COALESCE 흉내 — 기존 값 우선
            patch["duration_sec"] = int(whisper_duration)
    client().table("episodes").update(patch).eq("id", ep_id).execute()


def mark_vocab_extracted(ep_id: int) -> None:
    client().table("episodes").update({"vocab_extracted_at": _now()}).eq("id", ep_id).execute()


def episodes_by_recency(limit: int | None = None) -> list[dict[str, Any]]:
    """pub_date 내림차순 episode 목록 (재정렬용). audio_url 있는 것만.

    ⛔⛔ limit 없이 부르면 **반드시 페이지를 넘겨야 한다.** 호출자 대부분이 "전체"를
    뜻하고 그걸로 감사·업로드를 돈다: verify_done 은 총 개수를 세고, verify_hosting 과
    host_audio/upload_audio_r2 는 전 회차를 훑는다. PostgREST 의 조용한 1,000 행 절단을
    그대로 받으면 1,026 번째부터는 **모든 감사에서 존재하지 않는 회차**가 되고, 감사는
    초록으로 끝난다. upsert_episodes 를 7 일간 죽인 것과 같은 상한이지만, 이쪽은 에러조차
    내지 않으므로 발견되지 않는다.
    """
    # 페이지는 **id 오름차순**으로 넘고 정렬은 메모리에서 한다. pub_date 내림차순으로
    # 페이지를 넘기면 최신 회차가 하나 들어오는 순간 뒤 페이지 전체가 한 칸씩 밀려
    # 어떤 행은 두 번, 어떤 행은 한 번도 안 나온다. id 는 단조 증가라 새 행이 항상
    # 읽은 페이지 뒤에 붙는다. (xcheck 지적 2026-08-30)
    def _page(start: int, end: int):
        return (client().table("episodes")
                .select("id, audio_url, pub_date, transcribed_at, duration_sec")
                .not_.is_("audio_url", "null")
                .order("id", desc=False)
                .range(start, end).execute().data or [])

    rows: list[dict[str, Any]] = []
    start = 0
    # ⛔ limit > _PAGE 도 서버 상한에 걸린다 — 요청했다고 받는 게 아니다. 그래서 limit
    # 이 있어도 상한 크기로 나눠 돈다.
    while True:
        want = _PAGE if limit is None else min(_PAGE, limit - len(rows))
        if want <= 0:
            break
        page = _page(start, start + want - 1)
        rows.extend(page)
        if len(page) < want:
            break
        start += want

    rows.sort(key=lambda r: (r.get("pub_date") is None, r.get("pub_date"), r.get("id")),
              reverse=True)
    return rows[:limit] if limit else rows


def vocab_for_episode(ep_id: int) -> list[dict[str, Any]]:
    res = (client().table("vocab_cards")
           .select("id, example_sentence, sentence_start_sec, sentence_end_sec")
           .eq("episode_id", ep_id).execute())
    return res.data or []


def update_vocab_times(vocab_id: int, start: float | None, end: float | None) -> None:
    client().table("vocab_cards").update(
        {"sentence_start_sec": start, "sentence_end_sec": end}
    ).eq("id", vocab_id).execute()


def episode_title(ep_id: int) -> str | None:
    res = client().table("episodes").select("title").eq("id", ep_id).single().execute()
    return (res.data or {}).get("title")


# ─────────────────────── transcripts (Storage) ───────────────────────
def upload_transcript(ep_id: int, data: dict[str, Any]) -> None:
    payload = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    client().storage.from_("transcripts").upload(
        path=f"{ep_id}.json", file=payload,
        file_options={"content-type": "application/json", "upsert": "true"},
    )


def download_transcript(ep_id: int) -> dict[str, Any] | None:
    try:
        raw = client().storage.from_("transcripts").download(f"{ep_id}.json")
        return json.loads(raw)
    except Exception:
        log.exception("transcript 다운로드 실패 ep=%s", ep_id)
        return None


# ─────────────────────────── vocab + srs ───────────────────────────
def insert_vocab_and_srs(ep_id: int, vocab_list: list[dict[str, Any]],
                         show: str | None = None) -> tuple[int, list[str]]:
    """vocab_cards + srs_cards 시드. 반환: (added, tts_texts).
    show=None(레거시): show 컬럼 미기록(마이그레이션 전 안전). 지정 시 episode.show 로 비정규화."""
    now = _now()
    today = date.today().isoformat()
    added = 0
    tts_texts: list[str] = []
    c = client()
    for v in vocab_list:
        term = (v.get("term") or "").strip()
        if not term:
            continue
        vrow = {
            "episode_id": ep_id, "term": term, "kind": v.get("kind"),
            "definition": v.get("definition"), "example_sentence": v.get("example_sentence"),
            "sentence_start_sec": v.get("sentence_start_sec"),
            "sentence_end_sec": v.get("sentence_end_sec"), "created_at": now,
        }
        if show:
            vrow["show"] = show
        vres = c.table("vocab_cards").insert(vrow).execute()
        vocab_id = vres.data[0]["id"]

        back = v.get("definition") or ""
        ex = v.get("example_sentence")
        if ex:
            back = f"{back}\n\n— {ex}" if back else f"— {ex}"
        srow = {
            "episode_id": ep_id, "vocab_id": vocab_id, "front": term, "back": back,
            "category": v.get("kind"), "due_date": today, "created_at": now,
        }
        if show:
            srow["show"] = show
        c.table("srs_cards").insert(srow).execute()
        added += 1
        tts_texts.append(term)
        if ex and ex.strip():
            tts_texts.append(ex.strip())
    return added, tts_texts


# ─────────────────────────── TTS (Storage) ───────────────────────────
def tts_key(text: str, voice: str = TTS_VOICE, rate: str = TTS_RATE) -> str:
    """ui/tts.js 와 동일한 sha1 키 — 미리 생성 TTS 파일명의 단일 출처."""
    return hashlib.sha1(f"{voice}|{rate}|{text}".encode("utf-8")).hexdigest()


async def synth(text: str) -> bytes:
    """edge-tts → mp3 bytes."""
    chunks: list[bytes] = []
    communicate = edge_tts.Communicate(text, TTS_VOICE, rate=TTS_RATE)
    async for ev in communicate.stream():
        if ev["type"] == "audio":
            chunks.append(ev["data"])
    return b"".join(chunks)


def existing_tts_names() -> set[str]:
    names: set[str] = set()
    bucket = client().storage.from_("tts")
    offset = 0
    while True:
        page = bucket.list("", {"limit": 1000, "offset": offset})
        if not page:
            break
        names.update(o["name"] for o in page)
        if len(page) < 1000:
            break
        offset += 1000
    return names


async def pregen_tts(texts: list[str], concurrency: int = 5) -> int:
    """주어진 텍스트들을 기본 보이스로 합성해 tts/{sha1}.mp3 업로드. 이미 있으면 스킵."""
    uniq = sorted({t.strip() for t in texts if t and t.strip()})
    existing = existing_tts_names()
    todo = [(t, tts_key(t)) for t in uniq if f"{tts_key(t)}.mp3" not in existing]
    if not todo:
        return 0
    bucket = client().storage.from_("tts")
    sem = asyncio.Semaphore(concurrency)
    # storage3 의 httpx 클라이언트는 스레드 간 동시 호출이 안전하지 않다(HTTP/2 multiplex
    # 를 여러 OS 스레드가 만지면 WinError 10035 / RemoteProtocolError). 합성(edge-tts)은
    # 동시에 두되, 업로드는 이 lock 으로 직렬화해 공유 클라이언트를 한 번에 한 스레드만 쓴다.
    upload_lock = asyncio.Lock()
    done = 0

    def _upload(key: str, data: bytes) -> None:
        for attempt in range(3):  # 일시적 소켓/연결 오류 재시도
            try:
                bucket.upload(
                    path=f"{key}.mp3", file=data,
                    file_options={"content-type": "audio/mpeg", "upsert": "true"},
                )
                return
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(0.5 * (attempt + 1))

    async def worker(text: str, key: str) -> None:
        nonlocal done
        async with sem:
            try:
                data = await synth(text)
                if not data:
                    return
                async with upload_lock:
                    await asyncio.to_thread(_upload, key, data)
                done += 1
            except Exception:
                log.exception("TTS 실패: %r", text[:40])

    await asyncio.gather(*(worker(t, k) for t, k in todo))
    log.info("TTS 업로드: 성공 %d / 대상 %d", done, len(todo))
    return done
