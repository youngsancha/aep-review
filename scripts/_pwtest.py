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
export const toast = (msg) => { (window.__toasts = window.__toasts || []).push(msg); };
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
  const segments = FIX_SENTS.map((s,i)=>{
    // 현실적 발화속도(~0.45s/단어)로 단어를 앞쪽에 채우고, 문장 사이는 자연스러운 쉼으로 남긴다.
    // (예전엔 단어를 문장 간격 전체에 균등분배 → 1.3s/단어의 비현실적 느린 속도로 dur 하드캡 오작동)
    const st=s[0], toks=s[1].split(' '), per=0.45, en=+(st+per*toks.length).toFixed(2);
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
  // id 2 = R2 호스팅 회차(오프라인 저장 칩 대상), 그 외 = megaphone 회차(칩 없음).
  // config.js 는 목으로 대체되지 않으므로 실제 hostedAudioUrl 를 그대로 쓴다.
  const { hostedAudioUrl } = await import('/config.js');
  const audioUrl = Number(id) === 2 ? hostedAudioUrl(2) : 'https://example.com/test.mp3';
  return { id, title:'Test Episode', season:2, episode_no:12, pub_date:'2026-01-01',
           duration_sec:1700, audio_url:audioUrl, transcribed_at:'2026-01-01',
           description:'<p>This is a <b>test</b> episode description.</p>', vocab, transcript };
}
export async function episodeNav(id){ return { prevId:null, nextId:null }; }
export async function retentionStats() { return { learned:12, strong:4, mature:8, retentionFrac:0.33 }; }
export async function allExpressions() { return expressionsByKind('idiom'); }
export async function srsQueue() {
  // 실제 flattenCard 형태(front/back = srs_cards 컬럼) — 세션 1단계(복습 reps>0) + 2단계(신규 reps=0) 겸용
  return [
    { id:2, vocab_id:2, front:'put up with', back:'to tolerate (참고 견디다)\n\n— I had to put up with all day long.',
      episode_id:1, episode_title:'211 - Test', audio_url:'http://localhost:8123/_clip_test.mp3',
      example_sentence:'I had to put up with all day long.', sentence_start_sec:100, sentence_end_sec:105,
      ease:2.5, interval_days:6, reps:2, due_date:'2026-01-01', vkind:'idiom' },
    { id:1, vocab_id:1, front:'fill in the gap', back:'to provide a missing piece of information (빈칸을 채우다)',
      term:'fill in the gap', kind:'idiom',
      definition:'to provide a missing piece of information (빈칸을 채우다)',
      episode_id:1, episode_title:'211 - Test', audio_url:'http://localhost:8123/_clip_test.mp3',
      example_sentence:'fill in the gap', example_ko:'빈칸을 채우다', sentence_start_sec:100, sentence_end_sec:105,
      ease:2.5, interval_days:0, reps:0, due_date:'2026-01-01', vkind:'idiom' },
  ];
}
export async function srsReview(cardId, grade) { (window.__reviews=window.__reviews||[]).push([cardId,grade]); return {}; }
export async function studyOverview() {
  return { total:1905, learned:12, due:50, dueReview:40, dueNew:10, known:240, byKind:[
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
    example_sentence:'I had to '+b[0]+' all day long.', example_ko:'하루 종일 '+b[0]+' 해야 했어요.',
    episode_id:1, sentence_start_sec:100+i,
    sentence_end_sec:105+i, audio_url:'http://localhost:8123/_clip_test.mp3',
    episode_title:'211 - Test', known:false }));
}
export async function markKnown(id) { (window.__known = window.__known || []).push(id); }
export async function markUnknown(id) { window.__unknown = (window.__unknown || []).concat(id); }
export function cleanAudioUrl(u) { return u; }
export async function audioSrcFor(id, u) { return u; }
export async function hostedSet() { return new Set(); }
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
export function getCompletedAt() { return { 2: { at: Date.now() - 3600e3, title: '210 - Another' } }; }
export async function createCaptureCard(c) { (window.__captures = window.__captures || []).push(c); return { reused: false, vocabId: 99 }; }
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
  // 오프라인 저장 칩 검증용 훅 — 임의 회차 재렌더 + 오디오 캐시 심기(네트워크 없이 '이미 받음' 상태 재현).
  window.__renderEp = (id) => renderEpisode(document.getElementById('app'), String(id));
  window.__seedAudio = async (id) => {
    const { hostedAudioUrl } = await import('/config.js');
    const c = await caches.open('aep-review-audio-v1');
    await c.put(new Request(hostedAudioUrl(id)), new Response(new Blob(['x'], {type:'audio/mpeg'})));
  };
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


SRS_HARNESS = UI / "_harness_srs.html"
SRS_HARNESS_HTML = """<!doctype html><html><head><meta charset="utf-8" />
<script type="importmap">{"imports":{
  "/app.js":"/_mocks.js","/db.js":"/_mocks.js","/tts.js":"/_mocks.js","/player.js":"/_mocks.js"
}}</script><link rel="stylesheet" href="/style.css" /></head><body><main id="app"></main>
<script type="module">
  import { renderSrs } from '/views/srs.js';
  window.__ready=false;
  renderSrs(document.getElementById('app')).then(()=>{window.__ready=true;})
    .catch((e)=>{(window.__err=window.__err||[]).push('render:'+e);window.__ready=true;});
</script></body></html>
"""

SETTINGS_HARNESS = UI / "_harness_settings.html"
OFFLINE_MOCK = UI / "_offmock.js"
OFFLINE_MOCK_JS = r"""
let _n = 15;
export function offlineCount(){ return _n; }
export function setOfflineCount(n){ _n = n; (window.__offset = window.__offset || []).push(n); }
export async function forceRun(){ (window.__force = window.__force || []).push(1); }
"""
# Settings 시트 전용 하니스 — settings.js 를 직접 로드(실제 app.js 는 topbar 배선이 하니스에서
# 안 도므로 커버 불가). /app.js→_mocks(toast/escapeHtml), /offline.js→_offmock 로 치환.
SETTINGS_HARNESS_HTML = """<!doctype html><html><head><meta charset="utf-8" />
<script type="importmap">{"imports":{
  "/app.js":"/_mocks.js","/offline.js":"/_offmock.js"
}}</script><link rel="stylesheet" href="/style.css" /></head><body>
<span id="app-version">v0</span>
<script type="module">
  import { openSettings } from '/settings.js';
  window.__theme=[]; window.__signout=0; window.__ready=false;
  openSettings({ applyTheme:(v)=>window.__theme.push(v), version:'9.9.9', onSignOut:()=>{window.__signout++;} })
    .then(()=>{window.__ready=true;})
    .catch((e)=>{(window.__err=window.__err||[]).push('settings:'+e);window.__ready=true;});
</script></body></html>
"""


def main() -> int:
    MOCKS.write_text(MOCKS_JS, encoding="utf-8")
    HARNESS.write_text(HARNESS_HTML, encoding="utf-8")
    STUDY_HARNESS.write_text(STUDY_HARNESS_HTML, encoding="utf-8")
    TIMELINE_HARNESS.write_text(TIMELINE_HARNESS_HTML, encoding="utf-8")
    SRS_HARNESS.write_text(SRS_HARNESS_HTML, encoding="utf-8")
    SETTINGS_HARNESS.write_text(SETTINGS_HARNESS_HTML, encoding="utf-8")
    OFFLINE_MOCK.write_text(OFFLINE_MOCK_JS, encoding="utf-8")
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
            # 운전 캡처(v1.39.1): 칩은 transcript 시트 툴바(#tx-drive) — 시트를 연 뒤에만 클릭 가능
            # (닫힌 시트는 pointer-events:none). 칩 ON → FAB 표시 → 탭 = 현재 시각 마크(aep-marks)
            # → 칩 OFF → FAB 숨김. 저장된 마크는 아래 Study 하니스가 트리아지로 이어받는다.
            drive_ok = None
            if sheet_open and pg.query_selector("#tx-drive"):
                # v1.39.3: 회차 진입 시 항상 OFF 로 시작(상태 비영속) — 칩 off + FAB 숨김이 초기값
                chip_off0 = pg.eval_on_selector("#tx-drive", "el=>el.getAttribute('aria-pressed')==='false'")
                fab_hidden0 = pg.eval_on_selector("#drive-fab", "el=>getComputedStyle(el).display==='none'") if pg.query_selector("#drive-fab") else False
                pg.evaluate("window.__player.seek(23)")   # 마크 t≈21.5 → 픽스처 문장 3(22s~) 주변
                pg.click("#tx-drive"); time.sleep(0.1)
                fab_vis = pg.eval_on_selector("#drive-fab", "el=>getComputedStyle(el).display!=='none'") if pg.query_selector("#drive-fab") else False
                if fab_vis:
                    pg.click("#drive-fab"); time.sleep(0.1)
                nmarks = pg.evaluate("JSON.parse(localStorage.getItem('aep-marks')||'[]').length")
                # v1.40.0 드래그: 12px+ 이동 = 위치 이동(마크 생성 없음) + aep-fab-pos 저장 + 실제 이동
                bb = pg.eval_on_selector("#drive-fab", "el=>{const r=el.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};}")
                pg.mouse.move(bb["x"] + bb["w"] / 2, bb["y"] + bb["h"] / 2)
                pg.mouse.down()
                pg.mouse.move(bb["x"] + bb["w"] / 2 - 120, bb["y"] + bb["h"] / 2 - 80, steps=8)
                pg.mouse.up(); time.sleep(0.1)
                bb2 = pg.eval_on_selector("#drive-fab", "el=>{const r=el.getBoundingClientRect();return {x:r.left,y:r.top};}")
                pos_saved = pg.evaluate("!!localStorage.getItem('aep-fab-pos')")
                nmarks2 = pg.evaluate("JSON.parse(localStorage.getItem('aep-marks')||'[]').length")
                drag_ok = bool(pos_saved and abs(bb2["x"] - bb["x"]) > 60 and nmarks2 == nmarks)
                pg.click("#tx-drive"); time.sleep(0.1)    # OFF 복귀(이후 단계·FAB 간섭 방지)
                fab_hidden = pg.eval_on_selector("#drive-fab", "el=>getComputedStyle(el).display==='none'") if pg.query_selector("#drive-fab") else False
                drive_ok = bool(chip_off0 and fab_hidden0 and fab_vis and nmarks == 1 and drag_ok and fab_hidden)
            # 재생바 시크 = 자동추적 즉시 재개(v1.40.1): 컨트롤을 깨우는 탭(.tx-scroll touchstart,
            # 4s 보류)이 걸린 직후 시크해도 화면이 곧장 새 문단으로 이동해야 한다. 목 플레이어는
            # 자동 timeupdate 가 없어 '즉시 재앵커'가 아니면 scrollTop 이 영영 안 변한다(결정적).
            seek_follow = None
            if sheet_open and pg.query_selector("#tx-seek-track"):
                pg.eval_on_selector(".tx-sheet-card", "el=>el.classList.remove('controls-hidden')")
                pg.dispatch_event(".tx-scroll", "touchstart")
                st0 = pg.eval_on_selector(".tx-scroll", "el=>el.scrollTop")
                sb = pg.eval_on_selector("#tx-seek-track", "el=>{const r=el.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};}")
                sy = sb["y"] + sb["h"] / 2
                pg.mouse.move(sb["x"] + sb["w"] * 0.01, sy)
                pg.mouse.down()
                pg.mouse.move(sb["x"] + sb["w"] * 0.06, sy, steps=6)   # frac 0.06 → t≈102(픽스처 마지막 문장 부근)
                pg.mouse.up(); time.sleep(0.4)
                st1 = pg.eval_on_selector(".tx-scroll", "el=>el.scrollTop")
                tnow = pg.evaluate("window.__player._t")
                seek_follow = bool(tnow > 90 and (st1 - st0) > 60)
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
            # 글자 크기(#17): 단일 'A' 칩 탭 시 .tx-card 의 --tx-scale 증가(기본 1.0 → 다음 단계 1.15)
            fs_ok = None
            if pg.query_selector("#tx-fs"):
                _b = pg.eval_on_selector(".tx-card", "el=>parseFloat(getComputedStyle(el).getPropertyValue('--tx-scale'))||1")
                pg.click("#tx-fs"); time.sleep(0.1)
                _a = pg.eval_on_selector(".tx-card", "el=>parseFloat(getComputedStyle(el).getPropertyValue('--tx-scale'))||1")
                fs_ok = _a > _b
            # 한글 번역 고정 크기(#): A＋ 로 본문(--tx-scale)이 커져도 .tx-trans-ko 폰트는 그대로여야(사용자 요청).
            trans_fixed = None
            pg.evaluate("window.__player.seek(71)"); time.sleep(0.3)  # 번역 패널 다시 노출
            if pg.query_selector(".tx-trans-ko"):
                _tb = pg.eval_on_selector(".tx-trans-ko", "el=>parseFloat(getComputedStyle(el).fontSize)")
                if pg.query_selector("#tx-fs"): pg.click("#tx-fs"); time.sleep(0.1)
                _ta = pg.eval_on_selector(".tx-trans-ko", "el=>parseFloat(getComputedStyle(el).fontSize)")
                trans_fixed = (_tb is not None and _ta is not None and abs(_ta - _tb) < 0.5)
            # 단어 롱프레스 사전(신규 필수모드): .w 를 ~500ms 길게 누르면 팝오버(발음 버튼+단어+뜻)가 뜬다.
            wordpop_ok = None
            _w = pg.query_selector(".tx-scroll .w")
            if _w:
                try: _w.scroll_into_view_if_needed(); time.sleep(0.2)   # 앞선 시크/폰트변경으로 밀렸을 수 있어 뷰로
                except Exception: pass
                bb = _w.bounding_box()
                if bb:
                    pg.mouse.move(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
                    pg.mouse.down(); time.sleep(0.62)         # 450ms 임계 초과 유지 → 사전
                    pop = pg.query_selector(".tx-wordpop.show")
                    wtext = pg.eval_on_selector(".tx-wordpop-w", "el=>el.textContent") if pg.query_selector(".tx-wordpop-w") else None
                    spk = pg.query_selector(".tx-wordpop-spk") is not None
                    pg.mouse.up(); time.sleep(0.4)
                    ko = pg.eval_on_selector(".tx-wordpop-ko", "el=>el.textContent") if pg.query_selector(".tx-wordpop-ko") else None
                    looked = _w.evaluate("el=>el.classList.contains('looked')")   # 찾아본 단어 점선표시
                    wordpop_ok = (pop is not None and bool(wtext) and spk and ko not in (None, "", "…") and looked is True)
                    pg.mouse.click(5, 5); time.sleep(0.1)     # 바깥 탭 → 닫힘(이어 재생)
            # 다크 테마(#12): data-theme=dark 시 배경이 실제로 어두워지는지
            pg.evaluate("document.documentElement.setAttribute('data-theme','dark')")
            time.sleep(0.1)
            dark_bg = pg.eval_on_selector("body", "el=>getComputedStyle(el).backgroundColor")
            m = __import__("re").findall(r"\d+", dark_bg or "")
            dark_ok = bool(m) and (int(m[0]) + int(m[1]) + int(m[2]) < 120)
            pg.evaluate("document.documentElement.removeAttribute('data-theme')")
            # 수동 싱크 보정(🎯) UI 는 제거됨 — 모든 회차가 R2 재STT 로 자동 싱크(offset 0).
            # 따라서 #tx-sync 버튼이 더 이상 존재하지 않아야 한다.
            sync_btn_gone = pg.query_selector("#tx-sync") is None
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
            print("calib_gone=", calib_gone, " sync_ok=", sync_ok, " (sent0=", sent0_start, "→", seeked_to, ") ctrl_reveal=", ctrl_reveal, " fs_ok=", fs_ok, " sync_btn_gone=", sync_btn_gone)
            # Vocabulary '알아요' 학습 액션(v1.42.1): 버튼 존재 → 탭 → markKnown 호출 + 카드 .vknown 흐림
            vk_btn = pg.query_selector(".vocab-card .vocab-known")
            vk_ok = None
            if vk_btn:
                pg.eval_on_selector(".vocab-card .vocab-known", "el=>el.click()")
                time.sleep(0.15)
                vk_marked = pg.evaluate("(window.__known||[]).length>0")
                vk_dim = pg.eval_on_selector(".vocab-card", "el=>el.classList.contains('vknown')")
                vk_aria = pg.eval_on_selector(".vocab-card .vocab-known", "el=>el.getAttribute('aria-pressed')")
                vk_ok = bool(vk_marked and vk_dim and vk_aria == "true")
            print("wordpop_ok=", wordpop_ok, " drive_ok=", drive_ok, " seek_follow=", seek_follow, " vk_ok=", vk_ok)
            # 오프라인 저장 칩(v1.45.0): ① megaphone 회차(id 1)엔 칩이 없어야 하고(캐시해도 광고가
            # 매번 달라 무의미), ② R2 호스팅 회차(id 2)엔 'Offline' 로 뜨고, ③ 오디오가 이미 캐시에
            # 있으면 재진입 시 'Saved' 로 그려져야 한다(다운로드 네트워크 없이 캐시만 심어 검증).
            dl_none_mega = pg.query_selector("#np-dl") is None
            pg.evaluate("window.__renderEp(2)"); time.sleep(0.45)
            dl_idle = pg.eval_on_selector("#np-dl", "el=>el.textContent.trim()") if pg.query_selector("#np-dl") else None
            pg.evaluate("window.__seedAudio(2)")
            pg.evaluate("window.__renderEp(2)"); time.sleep(0.45)
            dl_saved = pg.eval_on_selector("#np-dl", "el=>el.textContent.trim()") if pg.query_selector("#np-dl") else None
            dl_aria = pg.eval_on_selector("#np-dl", "el=>el.getAttribute('aria-label')") if pg.query_selector("#np-dl") else None
            print("OFFLINE-CHIP: none_on_megaphone=", dl_none_mega, " idle=", dl_idle, " saved=", dl_saved, " aria=", dl_aria)
            print("PLAYER CALLS=", calls)
            print("window.__err=", werr, " CONSOLE=", errs)
            print("episode: about_blocks=", about)
            ep_ok = (dl_none_mega is True and dl_idle == "Offline" and dl_saved == "Saved"
                     and dl_aria == "Remove offline download"
                     and n_sent > 0 and not werr and not errs and any(c[0] == "toggle" for c in calls)
                     and notes_show is True and notes_no_vocab and about == 1
                     and isinstance(trans_ok, str) and trans_ok.startswith("[KO]")
                     and "fill in the gap" in trans_ok  # 번역이 현재 활성 문장과 대응(인덱스 mismatch 아님)
                     and trans_default_on is True
                     and trans_fs is not None and trans_fs >= 20 and trans_fixed is True
                     and calib_gone is True and sync_ok is True and ctrl_reveal is True
                     and fs_ok is True and dark_ok and ad_detect == 2 and ad_none is True
                     and ad_mid_ok is True and sync_btn_gone is True
                     and wordpop_ok is True and drive_ok is True and seek_follow is True
                     and vk_ok is True)

            # === Study 뷰 회귀 ===
            pg.goto("http://localhost:8123/_harness_study.html")
            pg.wait_for_function("window.__ready===true", timeout=10000)
            time.sleep(0.3)
            # v1.31.0 IA: Practice/My stats 가 <details> 접힘 → 모드 클릭 전 열어준다(재렌더마다 다시 접힘)
            def open_disclosures():
                pg.evaluate("document.querySelectorAll('details.study-practice,details.study-stats').forEach(d=>d.open=true)")
            open_disclosures()
            study_x = pg.eval_on_selector_all(".study-x", "els=>els.length")
            # 각 표현에 Shana 예문(+term 강조)이 함께 표시되는지 (학습 맥락)
            study_ex = pg.eval_on_selector_all(".study-x-ex", "els=>els.length")
            study_hl = bool(pg.query_selector(".study-x-ex .term-hl"))
            # 맥락에서 듣기: 별도 버튼 없이 예문(.study-x-ex.tappable) 자체가 재생 트리거
            study_ctx = pg.eval_on_selector_all(".study-x-ex.tappable", "els=>els.length")
            # Essentials 별도 모드: CTA → 카테고리/리스트/카드게임(인식) + Known 진행 + 생산(KR→EN) 토글 + #ess-back 복귀
            ess_ok = None
            ess_prod = None
            if pg.query_selector("#study-essentials"):
                pg.click("#study-essentials")
                pg.wait_for_selector(".ess-cats", timeout=5000)
                ess_cats = pg.eval_on_selector_all(".ess-cat", "els=>els.length")
                ess_list = pg.eval_on_selector_all(".ess-x", "els=>els.length")
                has_play = bool(pg.query_selector("#ess-play"))
                pg.click("#ess-play"); time.sleep(0.3)  # 기본 인식(EN→뜻)
                has_card = bool(pg.query_selector("#ess-card") and pg.query_selector("#ess-g-known") and pg.query_selector(".ess-card-term"))
                before = pg.eval_on_selector(".quiz-count", "el=>el.textContent") if pg.query_selector(".quiz-count") else ""
                pg.click("#ess-g-known"); time.sleep(0.25)
                after = pg.eval_on_selector(".quiz-count", "el=>el.textContent") if pg.query_selector(".quiz-count") else ""
                pg.click("#ess-g-exit"); time.sleep(0.2)  # 게임 → essentials 개요
                # 생산(KR→EN): 한국어 front + 영어 정답은 reveal 후
                if pg.query_selector('.ess-dir-btn[data-dir="ko"]'):
                    pg.click('.ess-dir-btn[data-dir="ko"]'); time.sleep(0.2)
                    pg.click("#ess-play"); time.sleep(0.3)
                    front_ko = bool(pg.query_selector(".ess-card-ko"))
                    hidden_before = pg.eval_on_selector("#ess-reveal", "el=>el.hidden") if pg.query_selector("#ess-reveal") else None
                    if pg.query_selector("#ess-g-show"):
                        pg.click("#ess-g-show"); time.sleep(0.2)
                    term_shown = bool(pg.query_selector("#ess-reveal .ess-card-term")) and (pg.eval_on_selector("#ess-reveal", "el=>!el.hidden") if pg.query_selector("#ess-reveal") else False)
                    ess_prod = bool(front_ko and hidden_before is True and term_shown)
                    pg.click("#ess-g-exit") if pg.query_selector("#ess-g-exit") else None
                    time.sleep(0.2)
                pg.click("#ess-back") if pg.query_selector("#ess-back") else None
                time.sleep(0.4)
                ess_ok = bool(ess_cats >= 9 and ess_list > 0 and has_play and has_card and before != after and ess_prod is True)
            # 카드 본문 클릭 버그(#19): 더 이상 에피소드로 네비게이트 안 함
            pg.evaluate("location.hash=''")
            if pg.query_selector(".study-x"):
                pg.eval_on_selector(".study-x", "el=>el.click()")
                time.sleep(0.1)
            study_no_nav = pg.evaluate("location.hash.indexOf('/episode/')<0")
            # 예문 탭 → 화면전환 없이 인라인 재생(에러 없이, 네비 X)
            ctx_no_nav = None
            if pg.query_selector(".study-x-ex.tappable"):
                pg.evaluate("location.hash=''")
                pg.eval_on_selector(".study-x-ex.tappable", "el=>el.click()")
                time.sleep(0.1)
                ctx_no_nav = pg.evaluate("location.hash.indexOf('/episode/')<0")
            study_chips = pg.eval_on_selector_all(".study-kind-chip", "els=>els.length")
            # v1.31.0: 링 카드 → 헤더 서브라인 + Today 카드(.cont-bar + ▶ Start)가 유일한 진행 신호
            today_ok = bool(pg.query_selector(".study-today .cont-play") and pg.query_selector("#study-known-bar")
                            and pg.query_selector("#study-pct"))
            # KR 번역 버튼 존재(#36) + 오른쪽 스와이프 → Known(#39): 버튼 대신 제스처로 마킹
            study_tr = pg.eval_on_selector_all(".study-x-tr", "els=>els.length")
            known_before = pg.eval_on_selector("#study-known-n", "el=>el.textContent") if pg.query_selector("#study-known-n") else None
            know_marked = known_after = None
            if pg.query_selector(".study-x"):
                pg.eval_on_selector(".study-x", """el=>{
                  const o={bubbles:true,cancelable:true};
                  el.dispatchEvent(new PointerEvent('pointerdown',Object.assign({},o,{clientX:12,clientY:20})));
                  el.dispatchEvent(new PointerEvent('pointermove',Object.assign({},o,{clientX:120,clientY:22})));
                  el.dispatchEvent(new PointerEvent('pointerup',Object.assign({},o,{clientX:120,clientY:22})));
                }""")
                time.sleep(0.3)
                know_marked = pg.evaluate("(window.__known||[]).length>0")
                known_after = pg.eval_on_selector("#study-known-n", "el=>el.textContent") if pg.query_selector("#study-known-n") else None
            # 받아쓰기(#13): 모드 진입 시 입력칸/채점 버튼이 뜨는지
            dict_ok = None
            if pg.query_selector("#study-quiz-dict"):
                open_disclosures()
                pg.click("#study-quiz-dict")
                time.sleep(0.3)
                dict_ok = bool(pg.query_selector("#d-in") and pg.query_selector("#d-check") and pg.query_selector("#d-spk"))
                pg.click("#d-exit") if pg.query_selector("#d-exit") else None
                time.sleep(0.2)
            # 빈칸 채우기(#16): 모드 진입 시 빈칸/입력/확인이 뜨는지
            cloze_ok = None
            if pg.query_selector("#study-quiz-cloze"):
                open_disclosures()
                pg.click("#study-quiz-cloze")
                time.sleep(0.3)
                cloze_ok = bool(pg.query_selector(".cloze-blank") and pg.query_selector("#cz-in") and pg.query_selector("#cz-check"))
                pg.click("#cz-exit") if pg.query_selector("#cz-exit") else None
                time.sleep(0.2)
            # 스피킹(#13): 모드 진입 시 타깃문장/마이크 버튼이 뜨는지 (마이크는 누르지 않음)
            speak_ok = None
            if pg.query_selector("#study-quiz-speak"):
                open_disclosures()
                pg.click("#study-quiz-speak")
                time.sleep(0.3)
                speak_ok = bool(pg.query_selector(".speak-card") and pg.query_selector("#sp-mic")
                                and pg.query_selector("#sp-target") and pg.query_selector("#sp-hint"))
                pg.click("#sp-exit") if pg.query_selector("#sp-exit") else None
                time.sleep(0.2)
            # 문장(Sentences) = 카드게임: (a) Show meaning 후 한국어앵커(.sent-ko),
            # (b) Known 버튼→markKnown 호출+다음 카드, (c) Again→재투입(반복, markKnown 호출 안 함)
            sent_ko_ok = None
            sent_game_ok = None
            if pg.query_selector("#study-quiz-sent"):
                open_disclosures()
                pg.click("#study-quiz-sent")
                time.sleep(0.3)
                has_card = bool(pg.query_selector("#sent-card.sent-swipe")
                                and pg.query_selector("#sent-known") and pg.query_selector("#sent-again"))
                if pg.query_selector("#sent-action"):
                    pg.click("#sent-action")  # Show meaning
                    time.sleep(0.2)
                sent_ko_ok = bool(pg.query_selector(".sent-ko"))
                kb = pg.evaluate("(window.__known||[]).length")
                if pg.query_selector("#sent-known"):
                    pg.click("#sent-known"); time.sleep(0.2)  # 오른쪽=Known
                ka = pg.evaluate("(window.__known||[]).length")
                if pg.query_selector("#sent-again"):
                    pg.click("#sent-again"); time.sleep(0.2)  # 왼쪽=Again(반복, known 증가 X)
                ka2 = pg.evaluate("(window.__known||[]).length")
                sent_game_ok = bool(has_card and ka > kb and ka2 == ka and pg.query_selector("#sent-card"))
                pg.click("#sent-exit") if pg.query_selector("#sent-exit") else None
                time.sleep(0.2)
            # 드릴 버튼 줄 균일성: 8개 모두 qb-ico+qb-txt, 높이 동일(들쭉날쭉 2줄/1줄 혼재 없음)
            open_disclosures()
            qb_ico = pg.eval_on_selector_all(".study-quiz-row .qb-ico", "els=>els.length")
            qb_txt = pg.eval_on_selector_all(".study-quiz-row .qb-txt", "els=>els.length")
            qb_uniform = pg.eval_on_selector_all(
                ".study-quiz-row .study-quiz-btn",
                "els=>{const h=els.map(e=>e.offsetHeight);return h.length===8 && Math.max(...h)-Math.min(...h)<=1;}")
            study_chips = pg.eval_on_selector_all(".study-kind-chip", "els=>els.length")
            quiz_opts = 0
            if pg.query_selector("#study-quiz-read"):
                open_disclosures()
                pg.click("#study-quiz-read")
                time.sleep(0.3)
                quiz_opts = pg.eval_on_selector_all(".quiz-opt", "els=>els.length")
            # 오늘 세션(v1.32.0): 시작 → 복습 채점 → 새 표현 학습시작 → 드릴(콜드스타트=받아쓰기) 진입
            #                     → 드릴 중도이탈 시 상태 저장(stage=drill, 홈 카드가 '이어서 하기')
            sess_ok = None
            if pg.query_selector("#q-exit"):   # 직전 quiz_opts 블록이 read 퀴즈에 진입한 상태 → 홈 복귀
                pg.click("#q-exit"); time.sleep(0.5)
            if pg.query_selector("#sess-go"):
                pg.evaluate("localStorage.removeItem('aep-session'); localStorage.removeItem('aep-study-days'); localStorage.removeItem('aep-measure-log')")
                sizes = pg.eval_on_selector_all(".sess-size button", "els=>els.length")
                pg.click("#sess-go"); time.sleep(0.5)
                has_rev = bool(pg.query_selector("#sess-reveal"))
                if has_rev:
                    pg.click("#sess-reveal"); time.sleep(0.1)
                    pg.click("#sess-good"); time.sleep(0.3)
                graded = pg.evaluate("(window.__reviews||[]).length") >= 1
                has_new = bool(pg.query_selector("#sess-learn"))
                if has_new:
                    pg.click("#sess-learn"); time.sleep(0.5)
                in_drill = bool(pg.query_selector("#d-in"))   # 미측정 콜드스타트 → 받아쓰기 결정적
                streak_before_done = pg.evaluate("JSON.parse(localStorage.getItem('aep-study-days')||'[]').length") == 0
                if pg.query_selector("#d-exit"):
                    pg.click("#d-exit"); time.sleep(0.5)
                st = pg.evaluate("JSON.parse(localStorage.getItem('aep-session')||'null')")
                resume_saved = bool(st and st.get('stage') == 'drill' and not st.get('completedAt'))
                resume_label = pg.eval_on_selector("#sess-go", "el=>el.textContent") if pg.query_selector("#sess-go") else ''
                sess_ok = bool(sizes == 3 and has_rev and graded and has_new and in_drill
                               and streak_before_done and resume_saved and ('Resume' in (resume_label or '')))
            # 🚗 운전 캡처 트리아지(v1.39.0): episode 하니스가 남긴 마크(aep-marks)가 Drive 섹션에 뜨고,
            # 단어 탭 → '카드 만들기' → createCaptureCard 호출 + 마크 소거. 최근 들은 회차 행도 확인.
            time.sleep(0.3)
            dm_card = pg.query_selector(".dm-card") is not None
            dm_recent = pg.query_selector(".dm-recent") is not None
            drive_tri_ok = None
            if dm_card:
                dm_words = pg.eval_on_selector_all(".dm-card .dm-w", "els=>els.length")
                pg.eval_on_selector(".dm-card .dm-w", "el=>el.click()")
                time.sleep(0.05)
                make_enabled = pg.eval_on_selector(".dm-card .dm-make", "el=>!el.disabled")
                pg.eval_on_selector(".dm-card .dm-make", "el=>el.click()")
                # 카드 생성은 translate fetch → createCaptureCard → removeMark 비동기 체인 — 고정 sleep
                # 대신 완료를 폴링(0.5s 로는 route RTT 에 따라 ncap 읽기가 먼저 실행되는 타이밍 플레이크).
                try:
                    pg.wait_for_function("(window.__captures||[]).length>=1", timeout=8000)
                except Exception:
                    pass
                time.sleep(0.2)
                ncap = pg.evaluate("(window.__captures||[]).length")
                nmarks_after = pg.evaluate("JSON.parse(localStorage.getItem('aep-marks')||'[]').length")
                cap_ko = pg.evaluate("((window.__captures||[])[0]||{}).ko||''")
                print("DRIVE-TRI: words=", dm_words, " make_enabled=", make_enabled, " ncap=", ncap,
                      " nmarks_after=", nmarks_after, " cap_ko=", repr(cap_ko),
                      " captures=", pg.evaluate("window.__captures||[]"))
                drive_tri_ok = bool(dm_words > 0 and make_enabled and ncap == 1 and nmarks_after == 0
                                    and isinstance(cap_ko, str) and cap_ko.startswith('[KO]'))
            # v1.45.0: 종류 칩 전환은 셸을 재생성하지 않는다(칩 .on + #study-list 만 교체).
            # 검증법: 셸 노드(.study-kinds)에 표식을 심고 다른 칩을 누른 뒤 표식이 살아있는지 본다
            # — 살아있으면 innerHTML 전면 재생성이 없었다는 뜻(예전엔 paintShell 로 통째로 날아갔다).
            # 다른 study 검사가 모두 끝난 뒤 실행해 상태 변경이 앞 단계에 영향을 주지 않게 한다.
            chip_keep = chip_on_idx = chip_aria = None
            _chips = pg.query_selector_all(".study-kind-chip")
            if len(_chips) >= 2:
                pg.evaluate("document.querySelector('.study-kinds').dataset.pwmark='1'")
                _chips[1].click(); time.sleep(0.5)
                chip_keep = pg.eval_on_selector(".study-kinds", "el=>el.dataset.pwmark||''")
                chip_on_idx = pg.eval_on_selector_all(".study-kind-chip", "els=>els.findIndex(e=>e.classList.contains('on'))")
                chip_aria = pg.eval_on_selector_all(
                    ".study-kind-chip", "els=>els.map(e=>e.getAttribute('aria-pressed')).join(',')")
            chip_swap_ok = (chip_keep == '1' and chip_on_idx == 1
                            and isinstance(chip_aria, str) and chip_aria.split(',')[1] == 'true'
                            and chip_aria.split(',')[0] == 'false')
            study_err = pg.evaluate("window.__err||[]")
            print("KIND-CHIP: shell_kept=", chip_keep, " on_idx=", chip_on_idx, " aria=", chip_aria, " ok=", chip_swap_ok)
            print("STUDY: expressions=", study_x, " examples=", study_ex, " term_hl=", study_hl,
                  " ctx_btns=", study_ctx, " no_nav=", study_no_nav, " ctx_no_nav=", ctx_no_nav,
                  " kind_chips=", study_chips, " quiz_opts=", quiz_opts,
                  " today=", today_ok, " known", known_before, "->", known_after, " marked=", know_marked, " tr_btns=", study_tr,
                  " dict_ok=", dict_ok, " cloze_ok=", cloze_ok, " speak_ok=", speak_ok,
                  " sent_ko=", sent_ko_ok, " sent_game=", sent_game_ok,
                  " qb_ico=", qb_ico, " qb_txt=", qb_txt, " qb_uniform=", qb_uniform,
                  " ess=", ess_ok, " ess_prod=", ess_prod, " sess=", sess_ok,
                  " dm_card=", dm_card, " dm_recent=", dm_recent, " drive_tri=", drive_tri_ok, " err=", study_err)
            study_ok = (chip_swap_ok is True
                        and study_x >= 4 and study_ex >= 4 and study_hl and study_chips == 4
                        and quiz_opts == 4 and not study_err
                        and today_ok is True and know_marked is True
                        and known_before != known_after and dict_ok is True
                        and cloze_ok is True and speak_ok is True
                        and sent_ko_ok is True and sent_game_ok is True and ess_ok is True
                        and qb_ico == 8 and qb_txt == 8 and qb_uniform is True
                        and study_ctx >= 4 and study_no_nav is True and ctx_no_nav is True
                        and study_tr >= 4
                        and sess_ok is True
                        and dm_card and dm_recent and drive_tri_ok is True)

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
            tl_hero = pg.eval_on_selector_all(".library-head", "els=>els.length")
            # 슬림 라이브러리 헤더(브랜딩 히어로 제거): 높이 < 130px
            tl_hero_h = pg.eval_on_selector(".library-head", "el=>el.offsetHeight") if pg.query_selector(".library-head") else 999
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
            tl_search = tl_clear_collapsed = None
            if pg.query_selector("#ep-search"):
                pg.fill("#ep-search", "older")
                time.sleep(0.25)
                tl_search = pg.eval_on_selector_all("#ep-groups .ep-row", "els=>els.length")
                # v1.45.3(low #1): 검색어를 지우면 시즌 접힘 기본값으로 돌아와야 한다.
                # 예전엔 빈 쿼리도 openAll=true 로 렌더해서, 검색을 한 번 쓰면 모든 시즌이
                # 펼쳐진 채 남았다(긴 목록이 다시 다 펼쳐짐).
                pg.fill("#ep-search", "")
                time.sleep(0.3)
                tl_clear_collapsed = pg.evaluate(
                    "[...document.querySelectorAll('.season-group')].some(d=>!d.open)")
            tl_err = pg.evaluate("window.__err||[]")
            print("TIMELINE: feat=", tl_feat, " rows=", tl_rows, " hero=", tl_hero, " feat_play=", tl_featplay,
                  " cont=", tl_cont, " contplay=", tl_contplay, " script_flag=", tl_script_flag,
                  " seasons=", tl_seasons, " first_open=", tl_first_open, " has_collapsed=", tl_has_collapsed,
                  " progress=", tl_progress, " done=", tl_done, " search_rows=", tl_search,
                  " hero_h=", tl_hero_h, " compact=", tl_compact, " overflow_px=", tl_overflow,
                  " clear_collapsed=", tl_clear_collapsed, " err=", tl_err)
            timeline_ok = (tl_feat == 1 and tl_rows >= 3 and tl_hero == 1 and tl_featplay
                           and tl_cont and tl_contplay is True and tl_script_flag == "1"
                           and tl_seasons >= 2 and tl_first_open is True and tl_has_collapsed is True
                           and tl_progress is True and tl_done is True and tl_compact is True
                           and tl_search == 1 and tl_clear_collapsed is True
                           and tl_no_pan and not tl_err)

            # === Settings 시트 회귀 (v1.41.0) ===
            pg.goto("http://localhost:8123/_harness_settings.html")
            pg.wait_for_function("window.__ready===true", timeout=10000)
            time.sleep(0.2)
            set_sheet = pg.query_selector(".set-sheet[role=dialog]") is not None
            theme_btns = pg.eval_on_selector_all(".set-seg", "els=>els[0]?els[0].querySelectorAll('.set-seg-btn').length:0")
            off_btns = pg.eval_on_selector_all(".set-seg", "els=>els[1]?els[1].querySelectorAll('.set-seg-btn').length:0")
            has_signout = pg.query_selector("#set-signout") is not None
            # 현재 오프라인=15 → 'on' 초기값 확인
            off_on0 = pg.eval_on_selector_all(".set-seg", "els=>els[1]?[...els[1].querySelectorAll('.set-seg-btn')].find(b=>b.classList.contains('on'))?.dataset.v:null")
            # Dark 테마 탭 → applyTheme('dark') 호출 + .on 이동
            pg.eval_on_selector_all(".set-seg", "els=>[...els[0].querySelectorAll('.set-seg-btn')].find(b=>b.dataset.v==='dark').click()")
            time.sleep(0.1)
            theme_called = pg.evaluate("(window.__theme||[]).includes('dark')")
            # 오프라인 30 탭 → setOfflineCount(30) + forceRun
            pg.eval_on_selector_all(".set-seg", "els=>[...els[1].querySelectorAll('.set-seg-btn')].find(b=>b.dataset.v==='30').click()")
            time.sleep(0.1)
            off_set = pg.evaluate("(window.__offset||[]).includes(30)")
            forced = pg.evaluate("(window.__force||[]).length>0")
            # 로그아웃 → onSignOut 호출 + 시트 닫힘
            pg.click("#set-signout"); time.sleep(0.4)
            signout_called = pg.evaluate("window.__signout")
            sheet_closed = pg.query_selector(".set-backdrop") is None
            set_err = pg.evaluate("window.__err||[]")
            settings_ok = bool(set_sheet and theme_btns == 3 and off_btns == 4 and has_signout
                               and off_on0 == "15" and theme_called and off_set and forced
                               and signout_called == 1 and sheet_closed and not set_err)
            print("SETTINGS: sheet=", set_sheet, " theme_btns=", theme_btns, " off_btns=", off_btns,
                  " off_on0=", off_on0, " theme_called=", theme_called, " off_set=", off_set,
                  " forced=", forced, " signout=", signout_called, " closed=", sheet_closed, " err=", set_err)

            # === SRS 복습 (v1.45.4 — 지금까지 자동검증이 전혀 없던 화면) ===
            # 목 큐는 카드 2장. A=again → B=good → 재큐된 A=good 으로 채점하면
            # 진짜 first-pass 는 1/2=50%, 옛 계산(mastered/done)은 2/3=67% 라 숫자로 구분된다.
            pg.goto("http://localhost:8123/_harness_srs.html")
            pg.wait_for_function("window.__ready===true", timeout=10000)
            cls0 = pg.eval_on_selector("#card", "el=>el.className")
            pg.click("#card"); time.sleep(0.35)
            srs_mask1 = pg.query_selector(".srs-hint-mono") is not None    # 단계1: 마스킹 힌트 노출
            srs_term1 = pg.query_selector(".srs-term") is not None         # 단계1: 정답은 아직 숨김
            pg.click("#card"); time.sleep(0.35)
            srs_mask2 = pg.query_selector(".srs-hint-mono") is not None    # 단계2: 힌트가 사라져야 함
            srs_term2 = pg.query_selector(".srs-term") is not None         # 단계2: 정답 노출
            def _grade(kind):
                pg.click(f'[data-grade="{kind}"]'); time.sleep(0.6)
            _grade("again")
            pg.click("#card"); time.sleep(0.3); pg.click("#card"); time.sleep(0.3)
            _grade("good")
            pg.click("#card"); time.sleep(0.3); pg.click("#card"); time.sleep(0.3)
            _grade("good")
            time.sleep(0.4)
            srs_meta = pg.eval_on_selector(".srs-summary-meta", "el=>el.textContent.replace(/\\s+/g,' ').trim()") \
                if pg.query_selector(".srs-summary-meta") else None
            srs_reviews = pg.evaluate("window.__reviews||[]")
            srs_err = pg.evaluate("window.__err||[]")
            srs_ok = (cls0.find("srs-stage-0") >= 0
                      and srs_mask1 is True and srs_term1 is False
                      and srs_mask2 is False and srs_term2 is True
                      and isinstance(srs_meta, str) and "50% first-pass" in srs_meta
                      and "3 reviews" in srs_meta and "1 retried" in srs_meta
                      and len(srs_reviews) == 3 and not srs_err)
            print("SRS: stage1_mask=", srs_mask1, " stage1_term=", srs_term1,
                  " stage2_mask=", srs_mask2, " stage2_term=", srs_term2,
                  " meta=", repr(srs_meta), " reviews=", srs_reviews, " ok=", srs_ok, " err=", srs_err)

            ok = ep_ok and study_ok and timeline_ok and settings_ok and srs_ok
            b.close()
    finally:
        srv.terminate()
        MOCKS.unlink(missing_ok=True)
        HARNESS.unlink(missing_ok=True)
        STUDY_HARNESS.unlink(missing_ok=True)
        TIMELINE_HARNESS.unlink(missing_ok=True)
        SRS_HARNESS.unlink(missing_ok=True)
        SETTINGS_HARNESS.unlink(missing_ok=True)
        OFFLINE_MOCK.unlink(missing_ok=True)
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
