"""헤드리스 스모크 검증 (async Playwright) — _pwtest.py 의 sync API 가 Python 3.14 +
Playwright 1.58 조합에서 드라이버 연결에 실패하는 문제를 우회한다(async API 는 정상 동작).

_pwtest.py 의 하니스 픽스처(MOCKS_JS / *_HARNESS_HTML)를 그대로 재사용해, 세 뷰(episode/study/
timeline)를 띄우고 (1) window.__err 0, (2) 콘솔 error/warning 0, (3) 핵심 렌더(문장수·표현수·행수)·
광고감지 단위검증을 확인한다. 전체 마이크로 어서션은 _pwtest.py(sync 복구 시)가 담당 — 이건 무인
검증용 '클린 렌더' 게이트.

    python scripts/_pwtest_async.py     # exit 0=PASS, 1=FAIL
"""
import asyncio
import subprocess
import sys
import time

from _pwtest import (  # 동일 디렉터리(scripts) — 픽스처 단일 출처 재사용
    HARNESS,
    HARNESS_HTML,
    MOCKS,
    MOCKS_JS,
    STUDY_HARNESS,
    STUDY_HARNESS_HTML,
    TIMELINE_HARNESS,
    TIMELINE_HARNESS_HTML,
    UI,
)


async def run() -> bool:
    from urllib.parse import parse_qs, urlparse

    from playwright.async_api import async_playwright

    errs: list[str] = []
    ok = True
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page()
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))

        async def _mm(route):
            q = parse_qs(urlparse(route.request.url).query).get("q", [""])[0]
            await route.fulfill(
                status=200, content_type="application/json",
                body='{"responseData": {"translatedText": "[KO] ' + q.replace('"', "") + '"}}')
        await pg.route("**/api.mymemory.translated.net/**", _mm)

        # ── episode ──
        await pg.goto("http://localhost:8123/_harness.html")
        await pg.wait_for_function("window.__ready===true", timeout=15000)
        n_sent = await pg.eval_on_selector_all(".tx-sent", "els=>els.length")
        ad_detect = await pg.evaluate("window.__adK")
        ad_ranges = await pg.evaluate("window.__adRanges")
        ep_err = await pg.evaluate("window.__err||[]")
        ad_mid_ok = (isinstance(ad_ranges, list) and len(ad_ranges) == 1
                     and ad_ranges[0].get("s") == 2 and ad_ranges[0].get("e") == 5)
        # 시간→문장 매핑(findActiveSentIdx, 클로저라 통합으로 검증): FIX_SENTS starts=[0,10,22,35,48,60,...]
        # seek(50) → txTime=49.8(HL_LAG 0.2) → start<=49.8 인 마지막 문장 = start 48.
        await pg.evaluate("window.__player.seek(50)")
        await asyncio.sleep(0.2)
        act = await pg.query_selector(".tx-sent.active")
        active_start = float(await act.get_attribute("data-start")) if act else None
        time_map_ok = active_start is not None and abs(active_start - 48) < 0.5
        ep_ok = (n_sent > 0 and not ep_err and ad_detect == 2 and ad_mid_ok and time_map_ok)
        print(f"EPISODE: sentences={n_sent} ad_detect={ad_detect} ad_mid_ok={ad_mid_ok} "
              f"time_map(active@50s={active_start})={time_map_ok} err={ep_err}")

        # ── study ──
        await pg.goto("http://localhost:8123/_harness_study.html")
        await pg.wait_for_function("window.__ready===true", timeout=15000)
        await asyncio.sleep(0.3)
        study_x = await pg.eval_on_selector_all(".study-x", "els=>els.length")
        study_chips = await pg.eval_on_selector_all(".study-kind-chip", "els=>els.length")
        study_err = await pg.evaluate("window.__err||[]")
        study_ok = (study_x >= 4 and study_chips == 4 and not study_err)
        print(f"STUDY: expressions={study_x} kind_chips={study_chips} err={study_err}")

        # ── timeline ──
        await pg.set_viewport_size({"width": 390, "height": 844})
        await pg.goto("http://localhost:8123/_harness_timeline.html")
        await pg.wait_for_function("window.__ready===true", timeout=15000)
        await asyncio.sleep(0.3)
        tl_rows = await pg.eval_on_selector_all(".ep-row", "els=>els.length")
        tl_feat = await pg.eval_on_selector_all(".feat-card", "els=>els.length")
        tl_overflow = await pg.evaluate(
            "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)"
            " - document.documentElement.clientWidth")
        tl_err = await pg.evaluate("window.__err||[]")
        tl_ok = (tl_rows >= 3 and tl_feat == 1 and (tl_overflow is not None and tl_overflow <= 1) and not tl_err)
        print(f"TIMELINE: rows={tl_rows} feat={tl_feat} overflow_px={tl_overflow} err={tl_err}")

        await b.close()
        ok = ep_ok and study_ok and tl_ok
    if errs:
        print("CONSOLE error/warning:", errs)
        ok = False
    return ok


def main() -> int:
    MOCKS.write_text(MOCKS_JS, encoding="utf-8")
    HARNESS.write_text(HARNESS_HTML, encoding="utf-8")
    STUDY_HARNESS.write_text(STUDY_HARNESS_HTML, encoding="utf-8")
    TIMELINE_HARNESS.write_text(TIMELINE_HARNESS_HTML, encoding="utf-8")
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8123", "--directory", str(UI)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    try:
        ok = asyncio.run(run())
    finally:
        srv.terminate()
        MOCKS.unlink(missing_ok=True)
        HARNESS.unlink(missing_ok=True)
        STUDY_HARNESS.unlink(missing_ok=True)
        TIMELINE_HARNESS.unlink(missing_ok=True)
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
