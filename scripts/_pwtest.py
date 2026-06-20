"""로그인 없이 episode 뷰를 헤드리스로 자가검증하는 재사용 하니스.

db/player/tts 를 목으로 치환(importmap)하고 공개 transcript(1.json)를 실제로 불러와
renderEpisode 를 띄운 뒤, 런타임 에러·문장수·재생 버튼 동작을 확인한다.
픽스처(_mocks.js/_harness.html)는 실행 중에만 ui/ 에 만들고 끝나면 지운다(배포 오염 방지).

    python scripts/_pwtest.py
"""
import json, subprocess, sys, time
from pathlib import Path
from urllib.parse import urlparse, parse_qs

UI = Path(__file__).resolve().parent.parent / "ui"
MOCKS = UI / "_mocks.js"
HARNESS = UI / "_harness.html"
STUDY_HARNESS = UI / "_harness_study.html"
TIMELINE_HARNESS = UI / "_harness_timeline.html"

MOCKS_JS = r"""
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
export const highlightTerm = (text, term) => {
  const s = String(text ?? ''); if (!term) return escapeHtml(s);
  const re = new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(s)) !== null) { out += escapeHtml(s.slice(last, m.index)) + '<mark class="term-hl">' + escapeHtml(m[0]) + '</mark>'; last = m.index + m[0].length; if (m[0].length === 0) re.lastIndex++; }
  return out + escapeHtml(s.slice(last));
};
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
// 결정적 고정 트랜스크립트 (Storage 라이브 데이터에 의존하지 않음 → 재정렬 backfill 과 무관하게 안정).
const FIX_SENTS = [
  [0,   'Welcome back to the show everyone, today we begin.'],
  [10,  'We are going to talk about something quite interesting.'],
  [22,  'Shana explains a particularly tricky idiom in detail here.'],
  [35,  'Sometimes language learners genuinely struggle with these expressions.'],
  [48,  'Let us look at one concrete example together right now.'],
  [60,  'Here comes a particularly nuanced sentence for you.'],
  [68,  'You often need to fill in the gap yourself somehow.'],
  [82,  'That phrase appears constantly throughout real conversations.'],
  [95,  'Practice it repeatedly until it becomes second nature.'],
  [110, 'Thanks for listening and we will see you next time.'],
];
function buildTranscript(){
  const starts = FIX_SENTS.map(s=>s[0]).concat([122]);
  const segments = FIX_SENTS.map((s,i)=>{
    const st=s[0], en=starts[i+1]-0.3, toks=s[1].split(' '), per=(en-st)/toks.length;
    const words=toks.map((w,j)=>({start:+(st+per*j).toFixed(2), end:+(st+per*(j+1)).toFixed(2), word:(j?' ':'')+w}));
    return {idx:i, start:st, end:en, text:s[1], words};
  });
  return {language:'en', duration:122, aligned:true, segments};
}
export async function getEpisode(id){
  const transcript = buildTranscript();
  const vocab = [{ id:1, term:'fill in the gap', kind:'idiom',
    definition:'to provide a missing piece of information (빈칸을 채우다)',
    example_sentence:'fill in the gap', sentence_start_sec:70, sentence_end_sec:75 }];
  return { id, title:'Test Episode', season:2, episode_no:12, pub_date:'2026-01-01',
           duration_sec:1700, audio_url:'https://example.com/test.mp3', transcribed_at:'2026-01-01',
           description:'<p>This is a <b>test</b> episode description.</p>', vocab, transcript };
}
export async function studyOverview() {
  return { total:1905, learned:12, due:50, known:240, byKind:[
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
    example_sentence:'I had to '+b[0]+' all day long.', episode_id:1, sentence_start_sec:100+i,
    sentence_end_sec:105+i, audio_url:'http://localhost:8123/_clip_test.mp3',
    episode_title:'211 - Test', known:false }));
}
export async function markKnown(id) { (window.__known = window.__known || []).push(id); }
export function cleanAudioUrl(u) { return u; }
export async function listEpisodes() {
  return [
    { id:1, season:2, episode_no:12, title:'211 - The Latest One', pub_date:'2026-06-10', duration_sec:1700,
      description:'<p>A <b>great</b> latest episode.</p>', has_audio:true, transcribed_at:'2026-01-01', vocab_count:12,
      audio_url:'https://traffic.megaphone.fm/ABC123.mp3' },
    { id:2, season:2, episode_no:11, title:'210 - Another', pub_date:'2026-06-01', duration_sec:1600,
      description:'<p>desc two</p>', has_audio:true, transcribed_at:'2026-01-01', vocab_count:8,
      audio_url:'https://traffic.megaphone.fm/DEF456.mp3' },
    { id:3, season:1, episode_no:9, title:'9 - Older one', pub_date:'2025-12-01', duration_sec:1500,
      description:'', has_audio:true, transcribed_at:null, vocab_count:0,
      audio_url:'https://traffic.megaphone.fm/GHI789.mp3' },
  ];
}
export async function srsStats() { return { total:1905, today_batch:50, today_review:40, today_new:10, backlog_new:0, learned:12 }; }
export function getProgress() { return null; }
export function getLatestProgress() { return { id:1, t:300, dur:1700, title:'211 - The Latest One', at:Date.now() }; }
export function getProgressMap() { return { 1: { t:300, dur:1700, title:'211 - The Latest One', at:Date.now() } }; }
export function getCompleted() { return new Set([2]); }
"""

HARNESS_HTML = """<!doctype html><html><head><meta charset="utf-8" />
<script type="importmap">{"imports":{
  "/app.js":"/_mocks.js","/db.js":"/_mocks.js","/tts.js":"/_mocks.js","/player.js":"/_mocks.js"
}}</script><link rel="stylesheet" href="/style.css" /></head><body><main id="app"></main>
<script type="module">
  import { renderEpisode, detectContentStart, detectAdRanges } from '/views/episode.js';
  window.__ready=false;
  // 프리롤 광고 감지 단위검증: 광고2 + 인사말 + 진행자 인트로 → 본편 시작 인덱스 2('Hi everybody')
  window.__adK = detectContentStart([
    {text:'Support for this show comes from a sponsor you will hear now.'},
    {text:'New markdowns up to seventy percent off at the store today.'},
    {text:'Hi everybody, welcome back to the show.'},
    {text:'My name is Shana and this is the American English Podcast.'}
  ]);
  // 미드롤 광고 감지 단위검증: 본편 사이 서드파티 광고 클러스터(2~4) → 구간 {s:2,e:5}, 본편(0,1,5,6)은 유지
  window.__adRanges = detectAdRanges([
    {text:'Hi everybody, my name is Shana.', start:0},
    {text:'Today we learn a great idiom together.', start:5},
    {text:'Learn more at windows.com slash student offer.', start:10},
    {text:'Get up to 45% off site-wide at blinds.com.', start:14},
    {text:'Rules and restrictions apply.', start:18},
    {text:'So as I was saying, let us continue the lesson.', start:22},
    {text:'That is all for today, thanks for listening everyone.', start:30}
  ]);
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


TIMELINE_HARNESS_HTML = """<!doctype html><html><head><meta charset="utf-8" />
<script type="importmap">{"imports":{
  "/app.js":"/_mocks.js","/db.js":"/_mocks.js","/tts.js":"/_mocks.js","/player.js":"/_mocks.js"
}}</script><link rel="stylesheet" href="/style.css" /></head><body><main id="app"></main>
<script type="module">
  import { renderTimeline } from '/views/timeline.js';
  window.__ready=false;
  renderTimeline(document.getElementById('app')).then(()=>{window.__ready=true;})
    .catch((e)=>{(window.__err=window.__err||[]).push('render:'+e);window.__ready=true;});
</script></body></html>
"""


def main() -> int:
    MOCKS.write_text(MOCKS_JS, encoding="utf-8")
    HARNESS.write_text(HARNESS_HTML, encoding="utf-8")
    STUDY_HARNESS.write_text(STUDY_HARNESS_HTML, encoding="utf-8")
    TIMELINE_HARNESS.write_text(TIMELINE_HARNESS_HTML, encoding="utf-8")
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
            # 번역 API(MyMemory) 가짜 응답 — 원문(q)을 그대로 에코해 번역↔문장 대응을 검증 가능하게.
            # ('[KO] '+원문) → 화면의 번역이 현재 활성 문장과 일치하는지 확인(인덱스 mismatch 회귀 방지).
            def _mm(route):
                q = parse_qs(urlparse(route.request.url).query).get('q', [''])[0]
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({"responseData": {"translatedText": "[KO] " + q}}))
            pg.route("**/api.mymemory.translated.net/**", _mm)
            pg.goto("http://localhost:8123/_harness.html")
            pg.wait_for_function("window.__ready===true", timeout=10000)
            n_sent = pg.eval_on_selector_all(".tx-sent", "els=>els.length")
            about = pg.eval_on_selector_all(".np-about-text", "els=>els.length")
            # 프리롤 광고(DAI): detectContentStart 단위검증(=2) + 앵커없는 픽스처엔 광고바 미표시(폴백 안전)
            ad_detect = pg.evaluate("window.__adK")
            ad_none = pg.query_selector(".tx-ad-skip") is None
            # 미드롤 광고 구간 감지: {s:2,e:5} 한 구간(본편 0,1,5,6 사이의 광고 2~4)
            ad_ranges = pg.evaluate("window.__adRanges")
            ad_mid_ok = (isinstance(ad_ranges, list) and len(ad_ranges) == 1
                         and ad_ranges[0].get('s') == 2 and ad_ranges[0].get('e') == 5)
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
            # 번역 기본 ON(#8): 클릭 없이도 not-easy 문장에서 번역행이 뜨고 채워지는지 + 버튼 on
            trans_default_on = pg.eval_on_selector("#tx-trans", "el=>el.classList.contains('on')") if pg.query_selector("#tx-trans") else None
            pg.evaluate("window.__player.seek(71)")  # vocab 문장(난이도 not-easy)에서 번역카드 노출
            time.sleep(0.4)
            trans_ok = pg.eval_on_selector(".tx-trans-ko", "el=>el.textContent") if pg.query_selector(".tx-trans-ko") else None
            # 번역 폰트가 본문 글자크기(--tx-scale)와 함께 커지는지: 24px*scale 이어야
            trans_fs = pg.eval_on_selector(".tx-trans-ko", "el=>parseFloat(getComputedStyle(el).fontSize)") if pg.query_selector(".tx-trans-ko") else None
            # 광고-무관 싱크(#2): 수동 싱크 버튼은 제거됨. 문장 탭 → 그 data-start 로 정확히 seek
            # (offset 0 — transcript 시각 = audio 시각). 보정 UI 부재 + 1:1 매핑을 검증.
            calib_gone = pg.query_selector("#tx-calib") is None
            sent0_start = pg.eval_on_selector(".tx-scroll .tx-sent", "el=>parseFloat(el.dataset.start)")
            pg.eval_on_selector(".tx-scroll .tx-sent", "el=>el.click()")
            time.sleep(0.2)
            seeked_to = pg.evaluate("window.__player.time")
            sync_ok = (sent0_start is not None and seeked_to is not None and abs(seeked_to - sent0_start) < 0.2)
            # 하단 컨트롤 자동숨김 + 탭하면 다시 표시: hidden 강제 후 pointerdown → 해제되는지
            ctrl_reveal = None
            if pg.query_selector(".tx-sheet-card"):
                pg.eval_on_selector(".tx-sheet-card", "el=>el.classList.add('controls-hidden')")
                pg.dispatch_event(".tx-sheet-card", "pointerdown")
                time.sleep(0.05)
                ctrl_reveal = pg.eval_on_selector(".tx-sheet-card", "el=>!el.classList.contains('controls-hidden')")
            # 글자 크기(#17): A＋ 클릭 시 .tx-card 의 --tx-scale 증가
            fs_ok = None
            if pg.query_selector("#tx-fs-up"):
                _b = pg.eval_on_selector(".tx-card", "el=>parseFloat(getComputedStyle(el).getPropertyValue('--tx-scale'))||1")
                pg.click("#tx-fs-up"); time.sleep(0.1)
                _a = pg.eval_on_selector(".tx-card", "el=>parseFloat(getComputedStyle(el).getPropertyValue('--tx-scale'))||1")
                fs_ok = _a > _b
            # 한글 번역 고정 크기(#): A＋ 로 본문(--tx-scale)이 커져도 .tx-trans-ko 폰트는 그대로여야(사용자 요청).
            trans_fixed = None
            pg.evaluate("window.__player.seek(71)"); time.sleep(0.3)  # 번역 패널 다시 노출
            if pg.query_selector(".tx-trans-ko"):
                _tb = pg.eval_on_selector(".tx-trans-ko", "el=>parseFloat(getComputedStyle(el).fontSize)")
                if pg.query_selector("#tx-fs-up"): pg.click("#tx-fs-up"); time.sleep(0.1)
                _ta = pg.eval_on_selector(".tx-trans-ko", "el=>parseFloat(getComputedStyle(el).fontSize)")
                trans_fixed = (_tb is not None and _ta is not None and abs(_ta - _tb) < 0.5)
            # 다크 테마(#12): data-theme=dark 시 배경이 실제로 어두워지는지
            pg.evaluate("document.documentElement.setAttribute('data-theme','dark')")
            time.sleep(0.1)
            dark_bg = pg.eval_on_selector("body", "el=>getComputedStyle(el).backgroundColor")
            m = __import__("re").findall(r"\d+", dark_bg or "")
            dark_ok = bool(m) and (int(m[0]) + int(m[1]) + int(m[2]) < 120)
            pg.evaluate("document.documentElement.removeAttribute('data-theme')")
            # 싱크 보정(#): 🎯 버튼 → '지금 들리는 문장' 탭 → per-episode offset(=오디오−자막) 저장
            # (가장 마지막에 — player.time 을 바꾸므로 앞 검증에 영향 없게)
            sync_cal_ok = None
            if pg.query_selector("#tx-sync"):
                pg.evaluate("window.__player.seek(50)")        # 현재 오디오 시각 50s
                pg.click("#tx-sync")                            # 보정 모드
                time.sleep(0.1)
                pg.eval_on_selector(".tx-scroll .tx-sent", "el=>el.click()")  # 첫 문장(자막 start 0) 탭
                time.sleep(0.1)
                _st = pg.evaluate("localStorage.getItem('aep-sync-1')")
                sync_cal_ok = (_st is not None and abs(float(_st) - 50) < 1.0)  # offset ≈ 50−0
            calls = pg.evaluate("window.__calls||[]")
            werr = pg.evaluate("window.__err||[]")
            print("dark_bg=", dark_bg, " dark_ok=", dark_ok)
            print("sentences=", n_sent, " sheet_open=", sheet_open, " ad_detect=", ad_detect, " ad_none=", ad_none, " ad_mid=", ad_ranges, " ad_mid_ok=", ad_mid_ok)
            # VOCAB 은 더 이상 노트에 안 뜸 — 번역만. (vocab term/def 카드 DOM 이 없어야 정상.
            #  문자열 매칭은 번역이 예문을 에코하면 오탐 → DOM 부재로 견고하게 확인)
            notes_no_vocab = (pg.query_selector(".tx-notes .tx-note-term") is None
                              and pg.query_selector(".tx-notes .tx-note-def") is None)
            print("notes_show=", notes_show, " notes_no_vocab=", notes_no_vocab)
            print("trans_default_on=", trans_default_on, " trans_ok=", trans_ok, " trans_fs=", trans_fs, " trans_fixed=", trans_fixed)
            print("calib_gone=", calib_gone, " sync_ok=", sync_ok, " (sent0=", sent0_start, "→", seeked_to, ") ctrl_reveal=", ctrl_reveal, " fs_ok=", fs_ok, " sync_cal_ok=", sync_cal_ok)
            print("PLAYER CALLS=", calls)
            print("window.__err=", werr, " CONSOLE=", errs)
            print("episode: about_blocks=", about)
            ep_ok = (n_sent > 0 and not werr and not errs and any(c[0] == "toggle" for c in calls)
                     and notes_show is True and notes_no_vocab and about == 1
                     and isinstance(trans_ok, str) and trans_ok.startswith("[KO]")
                     and "fill in the gap" in trans_ok  # 번역이 현재 활성 문장과 대응(인덱스 mismatch 아님)
                     and trans_default_on is True
                     and trans_fs is not None and trans_fs >= 20 and trans_fixed is True
                     and calib_gone is True and sync_ok is True and ctrl_reveal is True
                     and fs_ok is True and dark_ok and ad_detect == 2 and ad_none is True
                     and ad_mid_ok is True and sync_cal_ok is True)

            # === Study 뷰 회귀 ===
            pg.goto("http://localhost:8123/_harness_study.html")
            pg.wait_for_function("window.__ready===true", timeout=10000)
            time.sleep(0.3)
            study_x = pg.eval_on_selector_all(".study-x", "els=>els.length")
            # 각 표현에 Shana 예문(+term 강조)이 함께 표시되는지 (학습 맥락)
            study_ex = pg.eval_on_selector_all(".study-x-ex", "els=>els.length")
            study_hl = bool(pg.query_selector(".study-x-ex .term-hl"))
            # 맥락에서 듣기(#20): 인라인 재생 버튼 .study-x-ctx 존재
            study_ctx = pg.eval_on_selector_all(".study-x-ctx", "els=>els.length")
            # 카드 본문 클릭 버그(#19): 더 이상 에피소드로 네비게이트 안 함
            pg.evaluate("location.hash=''")
            if pg.query_selector(".study-x"):
                pg.eval_on_selector(".study-x", "el=>el.click()")
                time.sleep(0.1)
            study_no_nav = pg.evaluate("location.hash.indexOf('/episode/')<0")
            # 맥락 버튼 클릭 → 화면전환 없이 인라인(에러 없이, 네비 X)
            ctx_no_nav = None
            if pg.query_selector(".study-x-ctx"):
                pg.evaluate("location.hash=''")
                pg.eval_on_selector(".study-x-ctx", "el=>el.click()")
                time.sleep(0.1)
                ctx_no_nav = pg.evaluate("location.hash.indexOf('/episode/')<0")
            study_chips = pg.eval_on_selector_all(".study-kind-chip", "els=>els.length")
            ring_pct = pg.eval_on_selector("#study-ring-pct", "el=>el.textContent") if pg.query_selector("#study-ring-pct") else None
            # 알아요 마크(#10): 버튼 클릭 → markKnown 호출 + 행 known + 카운트 증가
            known_before = pg.eval_on_selector("#study-known-n", "el=>el.textContent") if pg.query_selector("#study-known-n") else None
            know_marked = known_after = None
            if pg.query_selector(".study-x-know"):
                pg.eval_on_selector(".study-x-know", "el=>el.click()")
                time.sleep(0.3)
                know_marked = pg.evaluate("(window.__known||[]).length>0")
                known_after = pg.eval_on_selector("#study-known-n", "el=>el.textContent") if pg.query_selector("#study-known-n") else None
            # 받아쓰기(#13): 모드 진입 시 입력칸/채점 버튼이 뜨는지
            dict_ok = None
            if pg.query_selector("#study-quiz-dict"):
                pg.click("#study-quiz-dict")
                time.sleep(0.3)
                dict_ok = bool(pg.query_selector("#d-in") and pg.query_selector("#d-check") and pg.query_selector("#d-spk"))
                pg.click("#d-exit") if pg.query_selector("#d-exit") else None
                time.sleep(0.2)
            # 빈칸 채우기(#16): 모드 진입 시 빈칸/입력/확인이 뜨는지
            cloze_ok = None
            if pg.query_selector("#study-quiz-cloze"):
                pg.click("#study-quiz-cloze")
                time.sleep(0.3)
                cloze_ok = bool(pg.query_selector(".cloze-blank") and pg.query_selector("#cz-in") and pg.query_selector("#cz-check"))
                pg.click("#cz-exit") if pg.query_selector("#cz-exit") else None
                time.sleep(0.2)
            # 스피킹(#13): 모드 진입 시 타깃문장/마이크 버튼이 뜨는지 (마이크는 누르지 않음)
            speak_ok = None
            if pg.query_selector("#study-quiz-speak"):
                pg.click("#study-quiz-speak")
                time.sleep(0.3)
                speak_ok = bool(pg.query_selector(".speak-card") and pg.query_selector("#sp-mic")
                                and pg.query_selector("#sp-target") and pg.query_selector("#sp-hint"))
                pg.click("#sp-exit") if pg.query_selector("#sp-exit") else None
                time.sleep(0.2)
            study_chips = pg.eval_on_selector_all(".study-kind-chip", "els=>els.length")
            quiz_opts = 0
            if pg.query_selector("#study-quiz-read"):
                pg.click("#study-quiz-read")
                time.sleep(0.3)
                quiz_opts = pg.eval_on_selector_all(".quiz-opt", "els=>els.length")
            study_err = pg.evaluate("window.__err||[]")
            print("STUDY: expressions=", study_x, " examples=", study_ex, " term_hl=", study_hl,
                  " ctx_btns=", study_ctx, " no_nav=", study_no_nav, " ctx_no_nav=", ctx_no_nav,
                  " kind_chips=", study_chips, " quiz_opts=", quiz_opts,
                  " ring=", ring_pct, " known", known_before, "->", known_after, " marked=", know_marked,
                  " dict_ok=", dict_ok, " cloze_ok=", cloze_ok, " speak_ok=", speak_ok, " err=", study_err)
            study_ok = (study_x >= 4 and study_ex >= 4 and study_hl and study_chips == 4
                        and quiz_opts == 4 and not study_err
                        and ring_pct is not None and know_marked is True
                        and known_before != known_after and dict_ok is True
                        and cloze_ok is True and speak_ok is True
                        and study_ctx >= 4 and study_no_nav is True and ctx_no_nav is True)

            # === Timeline(Library) 회귀 ===
            pg.set_viewport_size({"width": 390, "height": 844})  # 모바일 폭 — 가로 오버플로(#1) 재현 조건
            pg.goto("http://localhost:8123/_harness_timeline.html")
            pg.wait_for_function("window.__ready===true", timeout=10000)
            time.sleep(0.3)
            # 가로 오버플로(#1): 문서 스크롤폭이 뷰포트폭을 넘지 않아야(좌우로 밀리면 안 됨)
            tl_overflow = pg.evaluate(
                "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) "
                "- document.documentElement.clientWidth")
            tl_no_pan = (tl_overflow is not None and tl_overflow <= 1)
            tl_feat = pg.eval_on_selector_all(".feat-card", "els=>els.length")
            tl_rows = pg.eval_on_selector_all(".ep-row", "els=>els.length")
            tl_hero = pg.eval_on_selector_all(".show-hero", "els=>els.length")
            # 컴팩트 히어로(#): 로고 헤더 높이를 줄여 이어듣기+최신이 한 화면에 — 높이 < 130px
            tl_hero_h = pg.eval_on_selector(".show-hero", "el=>el.offsetHeight") if pg.query_selector(".show-hero") else 999
            tl_compact = tl_hero_h is not None and tl_hero_h < 130
            tl_featplay = bool(pg.query_selector(".feat-play"))
            tl_cont = bool(pg.query_selector(".cont-card"))   # 이어듣기 카드(#15)
            # 접이식 시즌: 최신만 펼침, 이전 시즌은 접힘
            tl_seasons = pg.eval_on_selector_all(".season-group", "els=>els.length")
            tl_first_open = pg.eval_on_selector(".season-group", "el=>el.open") if pg.query_selector(".season-group") else None
            tl_has_collapsed = pg.evaluate("[...document.querySelectorAll('.season-group')].some(d=>!d.open)")
            # 들은 진도 막대: 진도 있는 ep(id1) 행에 .ep-progress 표시
            tl_progress = bool(pg.query_selector(".ep-row.resumable .ep-progress"))
            # 완료 표시: 완료한 ep(id2) 행에 '✓ 들음' 칩 + played 클래스
            tl_done = bool(pg.query_selector(".ep-row.played .chip.done-ep"))
            # 이어재생 ▶ → 인라인 load+seek(resume)+play (화면 진입 없이 바로 실행)
            tl_contplay = None
            if pg.query_selector(".cont-play"):
                pg.eval_on_selector(".cont-play", "el=>el.click()")
                time.sleep(0.15)
                _cc = pg.evaluate("window.__calls||[]")
                tl_contplay = any(c[0] == "play" for c in _cc) and any(c[0] == "seek" for c in _cc)
            # 스크립트로 보기 → sessionStorage 플래그(논스톱 진입). 기본 네비는 막고 클릭만.
            tl_script_flag = None
            if pg.query_selector(".cont-script"):
                pg.eval_on_selector(".cont-script", "el=>{el.addEventListener('click',e=>e.preventDefault(),{once:true}); el.click();}")
                tl_script_flag = pg.evaluate("sessionStorage.getItem('aep-open-script')")
            # 에피소드 검색(#15): 'older' 입력 시 1개로 필터
            tl_search = None
            if pg.query_selector("#ep-search"):
                pg.fill("#ep-search", "older")
                time.sleep(0.25)
                tl_search = pg.eval_on_selector_all("#ep-groups .ep-row", "els=>els.length")
            tl_err = pg.evaluate("window.__err||[]")
            print("TIMELINE: feat=", tl_feat, " rows=", tl_rows, " hero=", tl_hero, " feat_play=", tl_featplay,
                  " cont=", tl_cont, " contplay=", tl_contplay, " script_flag=", tl_script_flag,
                  " seasons=", tl_seasons, " first_open=", tl_first_open, " has_collapsed=", tl_has_collapsed,
                  " progress=", tl_progress, " done=", tl_done, " search_rows=", tl_search,
                  " hero_h=", tl_hero_h, " compact=", tl_compact, " overflow_px=", tl_overflow, " err=", tl_err)
            timeline_ok = (tl_feat == 1 and tl_rows >= 3 and tl_hero == 1 and tl_featplay
                           and tl_cont and tl_contplay is True and tl_script_flag == "1"
                           and tl_seasons >= 2 and tl_first_open is True and tl_has_collapsed is True
                           and tl_progress is True and tl_done is True and tl_compact is True
                           and tl_search == 1 and tl_no_pan and not tl_err)

            ok = ep_ok and study_ok and timeline_ok
            b.close()
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
