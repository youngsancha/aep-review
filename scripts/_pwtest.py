"""로그인 없이 episode 뷰를 헤드리스로 자가검증하는 재사용 하니스.

db/player/tts 를 목으로 치환(importmap)하고 공개 transcript(1.json)를 실제로 불러와
renderEpisode 를 띄운 뒤, 런타임 에러·문장수·재생 버튼 동작을 확인한다.
픽스처(_mocks.js/_harness.html)는 실행 중에만 ui/ 에 만들고 끝나면 지운다(배포 오염 방지).

    python scripts/_pwtest.py
"""
import subprocess, sys, time
from pathlib import Path

UI = Path(__file__).resolve().parent.parent / "ui"
MOCKS = UI / "_mocks.js"
HARNESS = UI / "_harness.html"
STUDY_HARNESS = UI / "_harness_study.html"

MOCKS_JS = r"""
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
export const fmtTime = (s) => { s = Math.max(0, s | 0); const m = (s / 60) | 0; const ss = s % 60; return m + ':' + String(ss).padStart(2, '0'); };
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '');
export const fmtDuration = (s) => Math.round(s / 60) + ' min';
export const speak = () => {};
export const prefetch = () => {};
const calls = []; window.__calls = calls; window.__err = window.__err || [];
class MockPlayer {
  constructor(){this.audio={};this._t=0;this._paused=true;this.listeners=new Set();}
  load(t){calls.push(['load',t&&t.id]);this.current=t;}
  play(){calls.push(['play']);this._paused=false;this._emit('play');}
  pause(){calls.push(['pause']);this._paused=true;this._emit('pause');}
  toggle(){calls.push(['toggle']);this._paused?this.play():this.pause();}
  seek(t){calls.push(['seek',t]);this._t=t;this._emit('timeupdate');}
  rate(r){calls.push(['rate',r]);} skip(d){calls.push(['skip',d]);this._t=Math.max(0,this._t+d);}
  on(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  _emit(ev){for(const fn of this.listeners){try{fn(ev,this);}catch(e){window.__err.push('listener:'+e);}}}
  get paused(){return this._paused;} get time(){return this._t;} get duration(){return 1700;}
}
export const player = new MockPlayer(); window.__player = player;
const PUB = 'https://lbcvuztpyaapyckxmqhk.supabase.co/storage/v1/object/public/transcripts/1.json';
export async function getEpisode(id){
  const transcript = await (await fetch(PUB)).json();
  const vocab = [{ id:1, term:'fill in the gap', kind:'idiom',
    definition:'to provide a missing piece of information (빈칸을 채우다)',
    example_sentence:'fill in the gap', sentence_start_sec:70, sentence_end_sec:75 }];
  return { id, title:'Test Episode', season:2, episode_no:12, pub_date:'2026-01-01',
           duration_sec:1700, audio_url:'https://example.com/test.mp3', transcribed_at:'2026-01-01',
           description:'<p>This is a <b>test</b> episode description.</p>', vocab, transcript };
}
export async function studyOverview() {
  return { total:1905, learned:12, due:50, byKind:[
    {kind:'idiom',total:600},{kind:'phrasal_verb',total:700},{kind:'collocation',total:500},{kind:'word',total:105}] };
}
export async function expressionsByKind(kind) {
  const base = [
    ['put up with','to tolerate (참고 견디다)'],
    ['fill in the gap','to provide missing info (빈칸을 채우다)'],
    ['jump right into','to start immediately (바로 시작하다)'],
    ['cover it up','to hide wrongdoing (은폐하다)'],
    ['suffer from','to be affected by (~을 앓다)'],
  ];
  return base.map((b,i) => ({ id:i+1, term:b[0], kind, definition:b[1],
    example_sentence:'...', episode_id:1, sentence_start_sec:100+i, episode_title:'211 - Test' }));
}
"""

HARNESS_HTML = """<!doctype html><html><head><meta charset="utf-8" />
<script type="importmap">{"imports":{
  "/app.js":"/_mocks.js","/db.js":"/_mocks.js","/tts.js":"/_mocks.js","/player.js":"/_mocks.js"
}}</script><link rel="stylesheet" href="/style.css" /></head><body><main id="app"></main>
<script type="module">
  import { renderEpisode } from '/views/episode.js';
  window.__ready=false;
  renderEpisode(document.getElementById('app'),'1').then(()=>{window.__ready=true;})
    .catch((e)=>{(window.__err=window.__err||[]).push('render:'+e);window.__ready=true;});
</script></body></html>
"""


STUDY_HARNESS_HTML = """<!doctype html><html><head><meta charset="utf-8" />
<script type="importmap">{"imports":{
  "/app.js":"/_mocks.js","/db.js":"/_mocks.js","/tts.js":"/_mocks.js","/player.js":"/_mocks.js"
}}</script><link rel="stylesheet" href="/style.css" /></head><body><main id="app"></main>
<script type="module">
  import { renderStudy } from '/views/study.js';
  window.__ready=false;
  renderStudy(document.getElementById('app')).then(()=>{window.__ready=true;})
    .catch((e)=>{(window.__err=window.__err||[]).push('render:'+e);window.__ready=true;});
</script></body></html>
"""


def main() -> int:
    MOCKS.write_text(MOCKS_JS, encoding="utf-8")
    HARNESS.write_text(HARNESS_HTML, encoding="utf-8")
    STUDY_HARNESS.write_text(STUDY_HARNESS_HTML, encoding="utf-8")
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8123", "--directory", str(UI)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    errs = []
    ok = True
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            b = p.chromium.launch(); pg = b.new_page()
            pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
            pg.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
            # 번역 API(MyMemory) 는 결정적 테스트를 위해 가짜 응답으로 가로챈다.
            pg.route("**/api.mymemory.translated.net/**", lambda route: route.fulfill(
                status=200, content_type="application/json",
                body='{"responseData":{"translatedText":"(테스트 번역)"}}'))
            pg.goto("http://localhost:8123/_harness.html")
            pg.wait_for_function("window.__ready===true", timeout=10000)
            n_sent = pg.eval_on_selector_all(".tx-sent", "els=>els.length")
            about = pg.eval_on_selector_all(".np-about-text", "els=>els.length")
            if pg.query_selector("#np-play"):
                pg.click("#np-play")
            sheet_open = None
            if pg.query_selector("#np-tx-btn"):
                pg.click("#np-tx-btn"); time.sleep(0.4)
                sheet_open = pg.eval_on_selector(".tx-sheet", "el=>el.classList.contains('open')")
                if pg.query_selector("#tx-mini-play"):
                    pg.click("#tx-mini-play")
            # 즉시 해설 패널: vocab 시점(70s)으로 seek → 패널이 뜨고 해당 표현이 보이는지
            pg.evaluate("window.__player.seek(71)")
            time.sleep(0.3)
            notes_show = pg.eval_on_selector(".tx-notes", "el=>el.classList.contains('show')") if pg.query_selector(".tx-notes") else None
            notes_text = pg.eval_on_selector(".tx-notes", "el=>el.textContent") if pg.query_selector(".tx-notes") else ""
            # 번역 토글(#8): 켠 뒤 현재 문장의 번역 행이 뜨고 채워지는지
            trans_ok = None
            if pg.query_selector("#tx-trans"):
                pg.click("#tx-trans")
                pg.evaluate("window.__player.seek(72)")
                time.sleep(0.4)
                trans_ok = pg.eval_on_selector(".tx-trans-ko", "el=>el.textContent") if pg.query_selector(".tx-trans-ko") else None
            # 싱크 보정(#7): 토글 → calibrating 클래스 → 문장 탭 → 해제 + offset 저장
            calib_on = calib_off = off_val = None
            if pg.query_selector("#tx-calib"):
                pg.click("#tx-calib")
                calib_on = pg.eval_on_selector(".tx-sheet", "el=>el.classList.contains('calibrating')")
                pg.evaluate("window.__player.seek(50)")
                pg.eval_on_selector(".tx-scroll .tx-sent", "el=>el.click()")
                time.sleep(0.2)
                calib_off = pg.eval_on_selector(".tx-sheet", "el=>!el.classList.contains('calibrating')")
                off_val = pg.evaluate("parseFloat(localStorage.getItem('aep-aoff-1')||'NaN')")
            # 다크 테마(#12): data-theme=dark 시 배경이 실제로 어두워지는지
            pg.evaluate("document.documentElement.setAttribute('data-theme','dark')")
            time.sleep(0.1)
            dark_bg = pg.eval_on_selector("body", "el=>getComputedStyle(el).backgroundColor")
            m = __import__("re").findall(r"\d+", dark_bg or "")
            dark_ok = bool(m) and (int(m[0]) + int(m[1]) + int(m[2]) < 120)
            pg.evaluate("document.documentElement.removeAttribute('data-theme')")
            calls = pg.evaluate("window.__calls||[]")
            werr = pg.evaluate("window.__err||[]")
            print("dark_bg=", dark_bg, " dark_ok=", dark_ok)
            print("sentences=", n_sent, " sheet_open=", sheet_open)
            print("notes_show=", notes_show, " notes_has_term=", ("fill in the gap" in (notes_text or "")))
            print("trans_ok=", trans_ok)
            print("calib_on=", calib_on, " calib_off=", calib_off, " offset_saved=", off_val)
            print("PLAYER CALLS=", calls)
            print("window.__err=", werr, " CONSOLE=", errs)
            print("episode: about_blocks=", about)
            ep_ok = (n_sent > 0 and not werr and not errs and any(c[0] == "toggle" for c in calls)
                     and notes_show is True and "fill in the gap" in (notes_text or "") and about == 1
                     and trans_ok == "(테스트 번역)"
                     and calib_on is True and calib_off is True and off_val is not None
                     and dark_ok)

            # === Study 뷰 회귀 ===
            pg.goto("http://localhost:8123/_harness_study.html")
            pg.wait_for_function("window.__ready===true", timeout=10000)
            time.sleep(0.3)
            study_x = pg.eval_on_selector_all(".study-x", "els=>els.length")
            study_chips = pg.eval_on_selector_all(".study-kind-chip", "els=>els.length")
            study_err = pg.evaluate("window.__err||[]")
            quiz_opts = 0
            if pg.query_selector("#study-quiz-read"):
                pg.click("#study-quiz-read")
                time.sleep(0.3)
                quiz_opts = pg.eval_on_selector_all(".quiz-opt", "els=>els.length")
            print("STUDY: expressions=", study_x, " kind_chips=", study_chips, " quiz_opts=", quiz_opts, " err=", study_err)
            study_ok = (study_x >= 4 and study_chips == 4 and quiz_opts == 4 and not study_err)

            ok = ep_ok and study_ok
            b.close()
    finally:
        srv.terminate()
        MOCKS.unlink(missing_ok=True)
        HARNESS.unlink(missing_ok=True)
        STUDY_HARNESS.unlink(missing_ok=True)
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
