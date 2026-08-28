"""로그인 없이 episode 뷰를 헤드리스로 자가검증하는 재사용 하니스.

db/player/tts 를 목으로 치환(importmap)하고 공개 transcript(1.json)를 실제로 불러와
renderEpisode 를 띄운 뒤, 런타임 에러·문장수·재생 버튼 동작을 확인한다.
픽스처(_mocks.js/_harness.html)는 실행 중에만 ui/ 에 만들고 끝나면 지운다(배포 오염 방지).

    python scripts/_pwtest.py
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs

UI = Path(__file__).resolve().parent.parent / "ui"
MOCKS = UI / "_mocks.js"
HARNESS = UI / "_harness.html"
STUDY_HARNESS = UI / "_harness_study.html"
TIMELINE_HARNESS = UI / "_harness_timeline.html"
DBCACHE_MOCK = UI / "_dbcachemock.js"
DBCACHE_HARNESS = UI / "_harness_dbcache.html"

# 시각 변경(레이아웃/타이포)은 어서션으로 못 잡는다. 하니스 페이지는 이 스크립트가 실행 중에만
# 생성되므로 밖에서 따로 띄울 수 없어, 매번 일회용 스크립트를 다시 만드는 대신 여기에 훅을 둔다.
# 기본은 완전 무동작 — AEP_SHOTS=<디렉터리> 를 줄 때만 찍는다(게이트 성능/결과에 영향 없음).
SHOT_DIR = os.environ.get("AEP_SHOTS")


def _shot(pg, name: str) -> None:
    if not SHOT_DIR:
        return
    d = Path(SHOT_DIR)
    d.mkdir(parents=True, exist_ok=True)
    try:
        pg.screenshot(path=str(d / f"{name}.png"))
    except Exception as e:                     # 스크린샷 실패가 게이트를 죽이면 안 된다
        print("  shot failed", name, e)


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
export const stripTrailingUrl = (t) => String(t ?? '').replace(/\s*(?:[-—–]\s*)?https?:\/\/\S+\s*$/, '').trim();
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
// ?fx=loop → 쉐도잉 '반복 되감기 앵커' 검증용 픽스처. 한 회차 안에서 문단 길이를 끝에서 끝까지
// 훑는다(3단어 한 문장 … 26단어 두 문장). 사용자 신고의 핵심이 "문장이 길 때와 짧을 때 배지 위치가
// 다르다" 였으므로, 길이 스펙트럼 자체가 픽스처의 목적이다.
// 문단 경계는 groupIntoParagraphs 의 gap>1.6 규칙으로 강제한다(문단 사이 3.0s, 문장 사이 0.3s).
// ⚠ resegment 가 이 문장들을 다시 쪼개면 픽스처의 의도가 무너진다 → 두 규칙을 지킨다:
//   ① 한 문장 ≤13단어(하드캡 14, dur>9s 도 회피)  ② 문장 중간에 대문자 STARTER(The/It/They…)나
//      11번째 단어 이후의 접속사(and/but/so…)를 두지 않는다. 콤마는 7단어 이전에만.
const LOOP_PARAS = [
  ['Shana opens the lesson.'],                                                       // 4단어 — 아주 짧은 1문장
  ['Today our topic covers a surprisingly common English speaking habit.'],          // 10단어 — 보통 1문장
  ['Listeners often ask about pronunciation details.',                               // 6+6 — 2문장
   'Practice makes real progress happen quickly.'],
  ['Learners sometimes struggle enormously with unfamiliar idiomatic expressions during fast natural everyday conversation.'],  // 13단어 — 긴 1문장
  ['Understanding these subtle differences takes considerable patience from every dedicated language learner worldwide.',       // 13+13 — 가장 긴 문단
   'Repetition through shadowing builds genuine fluency faster than passive listening ever possibly could.'],
  ['Repeat that phrase.'],                                                           // 3단어 — 가장 긴 문단 '바로 뒤'의 가장 짧은 문단
  ['Careful listening reveals connected speech patterns inside ordinary casual American conversation.',                          // 11+12
   'Shadowing along slowly trains your mouth muscles for those unfamiliar sound combinations.'],
  ['Thanks for listening everyone, we will see you again next week.'],               // 마지막 문단 — 스크롤 한계(--loop-tail) 검증
];
function buildLoopTranscript(){
  const segments = []; let t = 2, idx = 0;
  for (const para of LOOP_PARAS) {
    for (const text of para) {
      const toks = text.split(' '), per = 0.45;
      const words = toks.map((w,j)=>({start:+(t+per*j).toFixed(2), end:+(t+per*(j+1)).toFixed(2), word:(j?' ':'')+w}));
      const en = +(t+per*toks.length).toFixed(2);
      segments.push({idx: idx++, start:t, end:en, text, words});
      t = +(en + 0.3).toFixed(2);     // 문장 사이 0.3s → 같은 문단으로 묶인다
    }
    t = +(t + 2.7).toFixed(2);        // 문단 사이 합계 3.0s → gap>1.6 으로 문단 강제 분할
  }
  return {language:'en', duration:+(t+5).toFixed(2), aligned:true, segments};
}
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
  // ?fx=loop 인 페이지만 문단길이 스윕 픽스처를 쓴다 — 기존 하니스 흐름은 1바이트도 안 바뀐다.
  const loopFx = new URLSearchParams(location.search).get('fx') === 'loop';
  if (loopFx) {
    return { id, title:'Loop Anchor Fixture', season:1, episode_no:1, pub_date:'2026-01-01',
             duration_sec:200, audio_url:'https://example.com/test.mp3', transcribed_at:'2026-01-01',
             show:'aep', description:'', vocab:[], transcript: buildLoopTranscript() };
  }
  const transcript = buildTranscript();
  // id 4 = wh(백악관 브리핑) 회차 — video_id 있음 → 📺 Video 토글 노출 검증용(실제 iframe 은 절대
  // 안 띄움, mount() 를 호출하지 않는 한 네트워크 무관 — 과제 요구사항: 하니스에서 실제 YouTube
  // iframe 을 로드하지 않는다). description 은 실제 wh_fetch.py 산출 형태 그대로(끝에 원본 URL) —
  // stripTrailingUrl 이 화면에서 그걸 걷어내는지도 같이 검증한다.
  const isWh = Number(id) === 4;
  if (isWh) transcript.video_id = 'dQw4w9WgXcQ';
  const vocab = [{ id:1, term:'fill in the gap', kind:'idiom',
    definition:'to provide a missing piece of information (빈칸을 채우다)',
    example_sentence:'fill in the gap', sentence_start_sec:70, sentence_end_sec:75 }];
  // id 2 = R2 호스팅 회차(오프라인 저장 칩 대상), 그 외 = megaphone 회차(칩 없음).
  // config.js 는 목으로 대체되지 않으므로 실제 hostedAudioUrl 를 그대로 쓴다.
  const { hostedAudioUrl } = await import('/config.js');
  // id 3 = 자막만 있고 audio_url 이 없는 회차(아직 호스팅 전). 여는 버튼 없이 시트만 만들어지던
  // 고아 노드 회귀를 잡는다.
  const audioUrl = Number(id) === 3 ? '' : (Number(id) === 2 ? hostedAudioUrl(2) : 'https://example.com/test.mp3');
  return { id, title: isWh ? '4 - WH Briefing Test' : 'Test Episode', season:2, episode_no:12, pub_date:'2026-01-01',
           duration_sec:1700, audio_url:audioUrl, transcribed_at:'2026-01-01',
           show: isWh ? 'wh' : 'aep', guid: isWh ? 'press-secretary-test-briefing' : undefined,
           description: isWh
             ? 'White House press briefing — https://www.whitehouse.gov/videos/press-secretary-test-briefing/'
             : '<p>This is a <b>test</b> episode description.</p>',
           vocab, transcript };
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
// offline.js 가 doc 캐시(회차행+자막 핀) 준비여부 확인에 쓰는 URL 빌더 — 실제 db.js 와 동일한
// 계약(순수 문자열 템플릿, id+transcribedAt 만으로 결정)만 지키면 되고 실제 STORAGE_URL 은 무관.
export function transcriptUrl(id, transcribedAt) { return `/mock-transcripts/${id}.json?v=${encodeURIComponent(transcribedAt)}`; }
export async function audioSrcFor(id, u) { return u; }
export async function hostedSet() { return new Set(); }
export async function listEpisodes() {
  return [
    // id 1 = wh(백악관 브리핑) — Continue(진도 있음)·Latest Episode 카드가 둘 다 이 회차를 그려서
    // 📺 Video 어포던스를 카드 두 곳 모두에서 한 번에 검증할 수 있다. description 끝의 원본 URL 로
    // stripTrailingUrl 이 라이브러리 카드에서도 적용되는지 같이 검증(요구사항 #2).
    { id:1, season:2, episode_no:12, title:'211 - The Latest One', pub_date:'2026-06-10', duration_sec:1700,
      description:'White House press briefing — https://www.whitehouse.gov/videos/the-latest-one/',
      has_audio:true, transcribed_at:'2026-01-01', vocab_count:12, show:'wh',
      audio_url:'https://traffic.megaphone.fm/ABC123.mp3' },
    { id:2, season:2, episode_no:11, title:'210 - Another', pub_date:'2026-06-01', duration_sec:1600,
      description:'<p>desc two</p>', has_audio:true, transcribed_at:'2026-01-01', vocab_count:8, show:'aep',
      audio_url:'https://traffic.megaphone.fm/DEF456.mp3' },
    { id:3, season:1, episode_no:9, title:'9 - Older one', pub_date:'2025-12-01', duration_sec:1500, show:'aep',
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
  // video.js 는 importmap 에 안 잡혀 있어 실 모듈이 로드된다(ES 모듈은 URL 당 싱글턴이므로 episode.js
  // 가 내부에서 잡는 video 싱글턴과 완전히 같은 인스턴스) — 테스트가 영상 모드 중 재생 시각을
  // 직접 밀어(video.seek) KR 패널 겹침 회귀(아래 KR-PANEL-OVERLAP)를 실제 하이라이트 파이프라인으로
  // 재현한다. 프로덕션 코드는 전혀 안 건드림(하니스 전용 훅).
  import { video as __videoAdapter } from '/video.js';
  window.__video = __videoAdapter;
  window.__ready=false;
  // 📺 Library 진입 체인(라이브러리 카드/행의 📺 → aep-open-video 플래그 → hashchange → 회차 진입 즉시
  // Video 모드 on) 재현용 — 실 app.js::route() 는 이 하니스에서 통째로 목이라 없다. 그 대신 동일한
  // 계약(해시 매칭 → renderEpisode 호출, 절대 직접 호출 안 함 → 이중 렌더 방지)만 미러링하는 초소형
  // 라우터를 hashchange 리스너로 하나 둔다 — 최초 렌더(아래, id 1) '이전에' 등록해 실제 app.js 처럼
  // '리스너가 먼저 있고 그 뒤에 라우팅이 일어나는' 순서를 그대로 지킨다.
  window.addEventListener('hashchange', () => {
    const m = location.hash.match(/^#\\/episode\\/(\\d+)/);
    if (m) renderEpisode(document.getElementById('app'), m[1]);
  });
  // 실제 YouTube IFrame API 스텁 — video.js::loadApi() 는 window.YT.Player 가 이미 있으면 <script>
  // 주입을 건너뛰므로 네트워크 없이 mount() 가 실제 흐름(onReady→attach→resolve)을 그대로 탄다.
  // tests/video_adapter.test.mjs 의 fakeYt() 와 같은 표면(playVideo/pauseVideo/seekTo/getCurrentTime/
  // getDuration/setPlaybackRate/destroy)만 흉내내고 실 iframe/네트워크는 절대 안 만든다.
  window.__ytCalls = [];
  window.__ytMounts = [];
  window.YT = {
    Player: function (el, opts) {
      const self = { _t: 0 };
      window.__ytMounts.push({ el, videoId: opts.videoId, playerVars: opts.playerVars });
      self.playVideo = () => { window.__ytCalls.push(['play']); };
      self.pauseVideo = () => { window.__ytCalls.push(['pause']); };
      self.seekTo = (t) => { self._t = t; window.__ytCalls.push(['seekTo', t]); };
      self.getCurrentTime = () => self._t;
      self.getDuration = () => 1274;
      self.setPlaybackRate = (r) => { window.__ytCalls.push(['rate', r]); };
      self.destroy = () => { window.__ytCalls.push(['destroy']); };
      setTimeout(() => opts.events.onReady(), 0);   // 실제 API 처럼 비동기(다음 틱)로 ready
      return self;
    },
  };
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


ROUTER_MOCK = UI / "_routermock.js"
ROUTER_HARNESS = UI / "_harness_router.html"
# 라우터(app.js)는 지금까지 전 하니스에서 목으로 대체돼 한 번도 실행되지 않았다.
# 여기서는 app.js 를 '진짜'로 돌리고 supabase(인증)와 뷰 모듈만 스텁으로 바꾼다.
ROUTER_MOCK_JS = r"""
export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: { user: { id: 'test' } } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => {},
  },
};
const rec = (name) => async (root, ...args) => {
  (window.__renders = window.__renders || []).push([name, ...args]);
  // 높이를 크게 줘서 '탭 재탭 → 맨 위로' 스크롤 동작을 검증할 수 있게 한다.
  root.innerHTML = '<div class="stub-view" data-view="' + name + '" style="height:2400px"></div>';
};
export const renderTimeline = rec('timeline');
export const renderEpisode  = rec('episode');
export const renderStudy    = rec('study');
export const renderSrs      = rec('srs');
export const renderLogin    = () => {};
export const ensureOfflineCache = async () => {};
export const openSettings = () => {};
"""
ROUTER_HARNESS_HTML = """<!doctype html><html><head><meta charset="utf-8" />
<script type="importmap">{"imports":{
  "/supabase.js":"/_routermock.js",
  "/views/timeline.js":"/_routermock.js","/views/episode.js":"/_routermock.js",
  "/views/study.js":"/_routermock.js","/views/srs.js":"/_routermock.js",
  "/views/login.js":"/_routermock.js","/offline.js":"/_routermock.js",
  "/settings.js":"/_routermock.js"
}}</script><link rel="stylesheet" href="/style.css" /></head><body>
<header id="topbar">
  <button id="back-btn" hidden aria-label="Back">&lsaquo;</button>
  <h1 id="page-title">E-Podcast</h1>
  <span id="app-version">v?</span>
  <button id="sync-btn" aria-label="Sync">&#8635;</button>
</header>
<main id="app"></main>
<nav id="tabbar">
  <a href="#/"      data-tab="timeline"><span class="label">Library</span></a>
  <a href="#/study" data-tab="study"><span class="label">Study</span></a>
</nav>
<script>window.APP_VERSION='test';</script>
<script type="module" src="/app.js"></script>
</body></html>
"""

# === 📺 Library→Video 진입 체인 풀-통합 재현(버그 리포트, 실기기 v1.58.0) ===================
# 위 ROUTER_HARNESS 는 뷰를 전부 스텁으로 갈아 real app.js::route() 만 검증했고, 위의 episode
# 하니시(HARNESS_HTML)는 renderEpisode 를 직접(또는 손으로 흉내낸 미니 라우터로) 불러 real app.js
# 를 아예 안 태웠다 — 그 조합(진짜 app.js 라우팅 + 진짜 timeline.js 카드 + 진짜 episode.js) 은
# 지금까지 한 번도 같이 돈 적이 없다. 이 하니스만 그 셋을 전부 real 로 두고 db/player/tts/supabase
# 만 목한다 — Library 카드의 실제 <a> 를 Playwright 로 '진짜' 클릭(isTrusted, 기본 네비게이션 포함)
# 해서 사용자가 실기기에서 겪은 경로를 최대한 그대로 재현한다.
REALVIDEO_MOCK = UI / "_realvideomock.js"
REALVIDEO_HARNESS = UI / "_harness_realvideo.html"
REALVIDEO_MOCK_JS = r"""
export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: { user: { id: 'test' } } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => {},
    stopAutoRefresh: () => {},
  },
};
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
  get paused(){return this._paused;} get time(){return this._t;} get duration(){return 1274;}
}
export const player = new MockPlayer(); window.__player = player;
export function getProgress(){ return null; }
export function getProgressMap(){ return {}; }
export function getCompleted(){ return new Set(); }
export function getCompletedAt(){ return {}; }
export const speak = () => {};
export const prefetch = () => {};
// 실기기 신고를 그대로: wh(백악관 브리핑) 회차 1개, video_id 있음, Continue/Latest/목록 행 모두
// 같은 id 를 그려 세 진입점(cont-video/feat-video/ep-video) 을 전부 같은 클릭으로 검증할 수 있게 한다.
const EP_ID = 4;
export async function listEpisodes() {
  return [
    { id: EP_ID, season:2, episode_no:12, title:'211 - The Latest One', pub_date:'2026-06-10', duration_sec:1700,
      description:'White House press briefing — https://www.whitehouse.gov/videos/the-latest-one/',
      has_audio:true, transcribed_at:'2026-01-01', vocab_count:0, show:'wh',
      audio_url:'https://example.com/wh.mp3' },
  ];
}
export async function audioSrcFor(id, u) { return u; }
export async function hostedSet() { return new Set(); }
export function cleanAudioUrl(u) { return u; }
export function transcriptUrl(id, transcribedAt) { return `/mock-transcripts/${id}.json?v=${encodeURIComponent(transcribedAt)}`; }
export async function episodeNav() { return { prevId:null, nextId:null }; }
export async function markKnown() {}
export async function getEpisode(id) {
  const FIX = [[0,'Hello everyone welcome back.'],[4,'Today we have a briefing.'],[8,'Thanks for watching along.']];
  const segments = FIX.map((s,i)=>{
    const st=s[0], toks=s[1].split(' '), per=0.4, en=+(st+per*toks.length).toFixed(2);
    const words=toks.map((w,j)=>({start:+(st+per*j).toFixed(2), end:+(st+per*(j+1)).toFixed(2), word:(j?' ':'')+w}));
    return {idx:i, start:st, end:en, text:s[1], words};
  });
  const transcript = { language:'en', duration:1274, aligned:true, r2_audio:true, segments, video_id:'dQw4w9WgXcQ' };
  return { id: Number(id), title:'211 - The Latest One', season:2, episode_no:12, pub_date:'2026-06-10',
           duration_sec:1700, audio_url:'https://example.com/wh.mp3', transcribed_at:'2026-01-01',
           show:'wh', guid:'press-secretary-test-briefing',
           description:'White House press briefing — https://www.whitehouse.gov/videos/the-latest-one/',
           vocab:[], transcript };
}
"""
REALVIDEO_HARNESS_HTML = """<!doctype html><html><head><meta charset="utf-8" />
<script type="importmap">{"imports":{
  "/supabase.js":"/_realvideomock.js","/db.js":"/_realvideomock.js",
  "/tts.js":"/_realvideomock.js","/player.js":"/_realvideomock.js"
}}</script><link rel="stylesheet" href="/style.css" /></head><body>
<header id="topbar">
  <button id="back-btn" hidden aria-label="Back">&lsaquo;</button>
  <h1 id="page-title">E-Podcast</h1>
  <span id="app-version">v?</span>
  <button id="sync-btn" aria-label="Sync">&#8635;</button>
</header>
<main id="app"></main>
<nav id="tabbar">
  <a href="#/"      data-tab="timeline"><span class="label">Library</span></a>
  <a href="#/study" data-tab="study"><span class="label">Study</span></a>
</nav>
<script>
  window.APP_VERSION='test';
  // 실제 YouTube IFrame API 스텁(HARNESS_HTML 과 동일 계약) — 네트워크 0, video.js 를 real 로 태운다.
  // ?noyt=1 로 열면 이 스텁을 아예 안 심는다 — video.js::loadApi() 가 real <script src=iframe_api>
  // 경로를 그대로 타게 해, 그 요청이 막혔을 때(광고차단기·방화벽·일시 네트워크 실패) 실제로 무슨 일이
  // 일어나는지(REQUEST_TIMEOUT_MS 타임아웃/onerror 회귀 검증용) 재현할 수 있게 한다.
  window.__ytCalls = [];
  window.__ytMounts = [];
  if (!location.search.includes('noyt')) {
    window.YT = {
      Player: function (el, opts) {
        const self = { _t: 0 };
        window.__ytMounts.push({ el, videoId: opts.videoId, playerVars: opts.playerVars });
        self.playVideo = () => { window.__ytCalls.push(['play']); };
        self.pauseVideo = () => { window.__ytCalls.push(['pause']); };
        self.seekTo = (t) => { self._t = t; window.__ytCalls.push(['seekTo', t]); };
        self.getCurrentTime = () => self._t;
        self.getDuration = () => 1274;
        self.setPlaybackRate = (r) => { window.__ytCalls.push(['rate', r]); };
        self.destroy = () => { window.__ytCalls.push(['destroy']); };
        setTimeout(() => opts.events.onReady(), 30);   // 실 API 처럼 약간의 비동기 지연을 둔다
        return self;
      },
    };
  }
</script>
<script type="module" src="/app.js"></script>
</body></html>
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

# === CACHE-REGRESSION: ui/db.js::fetchTranscript() 이 patched-in-place transcript 를 실제로
# 다시 받아 오는지(v1.59.0 실기기 버그, 2026-08-07 수정) ==========================================
# 위 하니스들은 전부 /db.js 자체를 목으로 갈아 끼워서(getEpisode 가 canned 데이터를 그대로 반환)
# db.js 안의 실제 fetch()/cache 옵션은 지금까지 단 한 번도 실행된 적이 없었다 — 이 버그는 바로 그
# fetch() 의 cache 모드에 있었으므로 여기서만은 db.js 를 진짜로 돌려야 한다. /supabase.js 만 목한다
# (진짜 supabase-js 는 esm.sh 네트워크 + 실 프로젝트가 필요해 하니스에 안 맞는다) — REST(episodes
# 단건조회)만 손으로 흉내낸 최소 체이닝으로 답하고, 나머지(Storage 자막·매니페스트)는 db.js 의 진짜
# fetch() 가 그대로 나가되 Playwright page.route() 가 가로챈다(실제 인터넷 접속 0). 브라우저의 진짜
# HTTP 디스크 캐시가 관여해야 이 버그가 재현되므로(Node fetch 엔 그런 캐시가 없다) 반드시 Playwright.
DBCACHE_MOCK_JS = r"""
function chain(getRow) {
  return { select() { return this; }, eq() { return this; }, single: async () => ({ data: getRow(), error: null }) };
}
let _row = null;
window.__setEpisodeRow = (row) => { _row = row; };
export const supabase = { from: () => chain(() => _row) };
// db.js 는 `${STORAGE_URL}/transcripts/...` 로 자막을 받는다 — 실제 프로젝트 호스트 대신 같은 출처
// 상대경로를 써서, page.route() 가 실제 supabase.co 를 흉내낼 필요 없이 같은 서버(8123)에서 가로챈다.
export const STORAGE_URL = '/storage/v1/object/public';
"""
DBCACHE_HARNESS_HTML = """<!doctype html><html><head><meta charset="utf-8" />
<script type="importmap">{"imports":{ "/supabase.js":"/_dbcachemock.js" }}</script>
</head><body>
<script type="module">
  // db.js 자체는 실제(목 아님) — 오직 이걸로 fetchTranscript() 의 실제 cache 옵션을 검증한다.
  import { getEpisode } from '/db.js';
  window.__getEpisode = (id) => getEpisode(id);
  window.__ready = true;
</script>
</body></html>
"""


def main() -> int:
    MOCKS.write_text(MOCKS_JS, encoding="utf-8")
    HARNESS.write_text(HARNESS_HTML, encoding="utf-8")
    STUDY_HARNESS.write_text(STUDY_HARNESS_HTML, encoding="utf-8")
    TIMELINE_HARNESS.write_text(TIMELINE_HARNESS_HTML, encoding="utf-8")
    SRS_HARNESS.write_text(SRS_HARNESS_HTML, encoding="utf-8")
    ROUTER_MOCK.write_text(ROUTER_MOCK_JS, encoding="utf-8")
    ROUTER_HARNESS.write_text(ROUTER_HARNESS_HTML, encoding="utf-8")
    REALVIDEO_MOCK.write_text(REALVIDEO_MOCK_JS, encoding="utf-8")
    REALVIDEO_HARNESS.write_text(REALVIDEO_HARNESS_HTML, encoding="utf-8")
    SETTINGS_HARNESS.write_text(SETTINGS_HARNESS_HTML, encoding="utf-8")
    OFFLINE_MOCK.write_text(OFFLINE_MOCK_JS, encoding="utf-8")
    DBCACHE_MOCK.write_text(DBCACHE_MOCK_JS, encoding="utf-8")
    DBCACHE_HARNESS.write_text(DBCACHE_HARNESS_HTML, encoding="utf-8")
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
            # ⚡ 성능 회귀 가드 — 닫힌 시트가 레이아웃되면 안 된다.
            # 실측(2026-08-01, 자막 420문장·CPU 4x): 닫힌 시트도 transform 으로만 숨겨져 있어 span
            # 11,650개가 매번 배치됐고, 회차 열기가 롱태스크 173ms 였다(트랜스크립트를 안 여는
            # 사용자도 지불). content-visibility:hidden 으로 195ms→55ms, 롱태스크 소멸.
            # 여기서는 '닫힌 시트의 자식이 실제로 렌더 대상에서 빠졌는가'를 본다 —
            # content-visibility:hidden 서브트리의 자손은 레이아웃 박스가 0 이 된다.
            cv_ok = None
            if pg.query_selector(".tx-sheet"):
                # 자손 지오메트리로 검증하려 했으나 신뢰할 수 없었다(cv:hidden 인데도 높이가 0 이
                # 아니게 읽혔다) → 실제로 우리가 제어하는 것, 즉 '규칙이 살아 있는가'만 단언한다.
                # 누가 지우거나 덮어쓰면 여기서 걸린다. 효과 수치는 커밋 메시지의 실측을 참조.
                cv_ok = pg.evaluate("""() => {
                  const sheet = document.querySelector('.tx-sheet');
                  const card = sheet.querySelector('.tx-sheet-card');
                  const wasOpen = sheet.classList.contains('open');
                  sheet.classList.remove('open');
                  const cv = getComputedStyle(card).contentVisibility;
                  if (wasOpen) sheet.classList.add('open');
                  return { cv };
                }""")
                print("PERF-CLOSED-SHEET:", cv_ok)

            # 쉐도잉 순환 — 여태 커버리지가 없었다. 라벨과 실제 반복 배수가 서로 다른 곳에 있어
            # (SHADOW 표 / smartRepsFor) 한쪽만 바꾸면 조용히 어긋난다. v1.51.0 에서 배수를
            # SMART_MULT 로 라벨 옆에 모았고, 여기서 '라벨 순서'와 '반복이 단조 감소'를 고정한다.
            shadow_ok = None
            if sheet_open and pg.query_selector("#tx-shadow"):
                cycle, widths = [], set()
                for _ in range(9):
                    st = pg.evaluate("""() => {
                      const b = document.getElementById('tx-shadow');
                      const badge = document.querySelector('.tx-loop-badge');
                      return { label: b.textContent.trim(),
                               w: Math.round(b.getBoundingClientRect().width),
                               reps: badge ? parseInt(badge.textContent.replace(/\\D/g, ''), 10) : 0 };
                    }""")
                    cycle.append(st); widths.add(st["w"])
                    if len(cycle) > 1 and st["label"] == "Shadow":
                        break
                    pg.click("#tx-shadow"); time.sleep(0.22)
                labels = [c["label"] for c in cycle]
                smart = [c["reps"] for c in cycle if c["label"].endswith("Smart")]
                shadow_ok = bool(
                    labels[:4] == ["Shadow", "3× Smart", "2× Smart", "1× Smart"]
                    and labels[-1] == "Shadow"
                    # Smart 는 3×>2×>1× 로 '반드시' 줄어야 한다 — 라벨만 바꾸고 배수를 안 바꾸면 여기서 걸린다
                    and len(smart) == 3 and smart[0] > smart[1] > smart[2] >= 2
                    # 고정폭(96px): 라벨 길이가 달라져도 버튼이 흔들리면 안 된다(v1.35.0)
                    and len(widths) == 1)
                print("SHADOW-CYCLE:", labels, " smart reps=", smart, " widths=", widths, " ok=", shadow_ok)
                for _ in range(2):   # 'Shadow'(off) 로 확실히 되돌려 이후 단계와 간섭 없게
                    if pg.evaluate("document.getElementById('tx-shadow').textContent.trim()") == "Shadow":
                        break
                    pg.click("#tx-shadow"); time.sleep(0.2)

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
                # 주행 중 신뢰성(v1.50.0): 칩이 click 에만 의존하면 차량 진동으로 손가락이 몇 px
                # 밀릴 때 브라우저가 제스처로 판정해 click 을 아예 안 보낸다 → 드라이브 모드를 켤 수
                # 없고 FAB 도 안 뜬다(사용자 신고 2026-07-30). FAB 은 2026-07-22 에 같은 이유로
                # 포인터 캡처로 바꿨는데 '켜는 칩'만 남아 있었다.
                # click 을 캡처 단계에서 죽여 그 상황을 모사한다 — 포인터 경로만으로 토글돼야 한다.
                # 리로드로 되돌리면 이후 검사들의 누적 상태가 날아간다 → 플래그로 껐다 켠다.
                pg.evaluate("""() => { const el = document.getElementById('tx-drive');
                  window.__blockClick = true;
                  el.addEventListener('click', (e) => {
                    if (window.__blockClick) { e.stopImmediatePropagation(); e.preventDefault(); }
                  }, true); }""")
                pg.click("#tx-drive"); time.sleep(0.2)
                drive_noclick = pg.evaluate("!document.body.classList.contains('drive-capture')")
                pg.click("#tx-drive"); time.sleep(0.2)    # 다시 ON — 이중토글이 있으면 여기서 어긋난다
                drive_noclick2 = pg.evaluate("document.body.classList.contains('drive-capture')")
                pg.evaluate("() => { window.__blockClick = false; }")
                pg.click("#tx-drive"); time.sleep(0.15)   # OFF 복귀(이후 단계·FAB 간섭 방지)
                fab_hidden = pg.eval_on_selector("#drive-fab", "el=>getComputedStyle(el).display==='none'") if pg.query_selector("#drive-fab") else False
                drive_ok = bool(chip_off0 and fab_hidden0 and fab_vis and nmarks == 1 and drag_ok and fab_hidden
                                and drive_noclick and drive_noclick2)
                print("DRIVE-TAP: click 차단 상태에서 토글 off=", drive_noclick, " 재토글 on=", drive_noclick2)
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
            # 즉시 해설 패널: vocab 시점(70s)으로 seek → 패널이 뜨는지.
            # (예전엔 패널 텍스트도 받아 뒀지만 설계가 바뀌어 지금은 아래 notes_no_vocab 이
            #  '패널에 vocab term/def 가 없어야 한다'를 검증한다 → 텍스트 캡처는 불필요.)
            pg.evaluate("window.__player.seek(71)")
            time.sleep(0.3)
            notes_show = pg.eval_on_selector(".tx-notes", "el=>el.classList.contains('show')") if pg.query_selector(".tx-notes") else None
            # 번역 기본 ON(#8): 클릭 없이도 not-easy 문장에서 번역행이 뜨고 채워지는지 + 버튼 on
            trans_default_on = pg.eval_on_selector("#tx-trans", "el=>el.classList.contains('on')") if pg.query_selector("#tx-trans") else None
            pg.evaluate("window.__player.seek(71)")  # vocab 문장(난이도 not-easy)에서 번역카드 노출
            time.sleep(0.4)
            trans_ok = pg.eval_on_selector(".tx-trans-ko", "el=>el.textContent") if pg.query_selector(".tx-trans-ko") else None
            # 번역 폰트가 본문 글자크기(--tx-scale)와 함께 커지는지: 24px*scale 이어야
            trans_fs = pg.eval_on_selector(".tx-trans-ko", "el=>parseFloat(getComputedStyle(el).fontSize)") if pg.query_selector(".tx-trans-ko") else None
            # 번역 실패를 '조용히 숨기지' 않는다 (사용자 신고 2026-07-27: 차량·오프라인에서 KR 을
            # 켰는데 아무 일도 안 일어남). 사전번역(_ko.json)이 있는 회차는 12% 뿐이라 나머지는 전부
            # 온디맨드 MyMemory 경로 → 오프라인이면 실패가 '정상 경로'다. 그 자리에 사유를 보여야 한다.
            # 캐시 적중을 피해야 실제 네트워크 경로를 탄다. 여기까지의 seek(23/102/71)과 각 호출의
            # '다음 문장 프리페치'로 22·35·68·82·95·110 은 이미 캐시됐다 → 미방문은 0·10·48·60.
            # 48s 를 쓴다. (abort_hits 를 함께 단언하므로, 나중에 누가 앞에서 48s 를 건드리면
            #  조용히 통과하지 않고 소리내어 실패한다.)
            # set_offline 만으로는 안 된다 — pg.route 가 네트워크 계층보다 앞서서 모의 응답이 그대로
            # 나간다. 라우트를 abort 로 갈아끼워야 fetch 가 실제로 throw 한다. offline 플래그는
            # navigator.onLine=false 를 만들어 사유가 'offline' 로 잡히게 하는 용도.
            _errs_before = len(errs)
            pg.context.set_offline(True)
            pg.unroute("**/api.mymemory.translated.net/**")   # 기존 성공 목을 먼저 걷어낸다
            _mm_hits = []
            pg.route("**/api.mymemory.translated.net/**", lambda r: (_mm_hits.append(1), r.abort()))
            try:
                pg.evaluate("window.__player.seek(50)")
                time.sleep(0.6)
                tr_iss_txt = pg.eval_on_selector(".tx-trans-ko", "el=>el.textContent") if pg.query_selector(".tx-trans-ko") else None
                tr_iss_cls = pg.eval_on_selector(".tx-trans-ko", "el=>el.classList.contains('tx-trans-issue')") if pg.query_selector(".tx-trans-ko") else None
                tr_iss_shown = pg.eval_on_selector(".tx-notes", "el=>el.classList.contains('show')") if pg.query_selector(".tx-notes") else None
            finally:
                pg.context.set_offline(False)
                pg.unroute("**/api.mymemory.translated.net/**")
                pg.route("**/api.mymemory.translated.net/**", _mm)
            # abort 는 콘솔에 net::ERR_FAILED 를 남긴다 — 이 블록이 '의도적으로' 만든 실패이므로
            # 걷어낸다. 같은 창에서 난 그 외 오류는 그대로 남겨 진짜 회귀를 놓치지 않는다.
            _new_errs = errs[_errs_before:]
            del errs[_errs_before:]
            errs.extend(e for e in _new_errs if "ERR_FAILED" not in e)
            # 오프라인이면 'connection' 문구여야 한다 — 사유를 잘못 잡으면 엉뚱한 안내가 나간다.
            # abort_hits>0 이 없으면 '캐시 적중이라 네트워크를 안 탔다'를 성공으로 오인할 수 있다.
            tr_issue_ok = bool(len(_mm_hits) > 0 and tr_iss_shown and tr_iss_cls
                               and isinstance(tr_iss_txt, str)
                               and "connection" in tr_iss_txt and "…" not in tr_iss_txt)
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
            print("trans_issue_ok=", tr_issue_ok, " text=", repr(tr_iss_txt), " issue_cls=", tr_iss_cls,
                  " panel_shown=", tr_iss_shown, " abort_hits=", len(_mm_hits))
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
            # 호스팅 회차에선 extras 칩이 4개(1×·반복·Transcript·Offline)가 되고, 실측으로 폰 폭을
            # 넘긴다(360px 화면에서 394px 필요). flex-wrap 이 없으면 body 의 overflow-x:hidden 이
            # 양쪽을 잘라 Offline 칩이 화면 밖으로 사라졌다(사용자 신고 2026-07-30, v1.48.0 수정).
            # 개수가 아니라 '전부 화면 안에 있는가'를 본다 — 칩이 더 늘어도 유효한 불변식이다.
            # ⚠ 반드시 폰 폭에서 재야 한다. 기본 1280px 에서는 칩이 당연히 들어가므로 단언이
            #   공허하게 통과한다(처음 이 검사를 넣었을 때 실제로 그랬다). 360px = Galaxy S23 급.
            _vp_before = pg.viewport_size
            pg.set_viewport_size({"width": 360, "height": 780})
            pg.evaluate("window.__renderEp(2)"); time.sleep(0.5)
            chips_fit = pg.evaluate("""() => {
              const ex = document.querySelector('.np-extras');
              if (!ex) return null;
              const kids = [...ex.children];
              const bad = kids.filter((e) => { const r = e.getBoundingClientRect();
                return r.left < -0.5 || r.right > innerWidth + 0.5; });
              return { n: kids.length, offscreen: bad.length, vw: window.innerWidth,
                       labels: bad.map((e) => e.textContent.trim().slice(0, 12)) };
            }""")
            print("EXTRAS-FIT:", chips_fit)
            # 세로도 봐야 한다: 고정 탭바(60px)가 칩 줄을 덮으면 재생 컨트롤을 누를 수 없다
            # (사용자 신고 2026-07-30 — 3줄 제목에서 실측 -34px). 제목은 길이 상한이 없으므로
            # 커버 축소만으로는 못 막는다 → .np-title 2줄 클램프가 레이아웃을 유계로 만든다.
            # 하니스엔 탭바가 없으니 '뷰포트 하단 - 탭바 높이' 를 대신 기준으로 삼는다.
            pg.evaluate("""(t) => { const h = document.querySelector('.np-title'); if (h) h.textContent = t; }""",
                        "3 Must-Know Expressions for IELTS Speaking and Daily Life with Aubrey Carter "
                        "and Even More Words Appended Here To Push It Further")
            time.sleep(0.35)
            np_fit = pg.evaluate("""() => {
              const ex = document.querySelector('.np-extras');
              const ti = document.querySelector('.np-title');
              if (!ex || !ti) return null;
              const TABBAR = 60;
              return { titleH: Math.round(ti.getBoundingClientRect().height),
                       clearance: Math.round(innerHeight - TABBAR - ex.getBoundingClientRect().bottom),
                       vh: innerHeight };
            }""")
            print("NP-VERTICAL-FIT:", np_fit)
            pg.set_viewport_size(_vp_before)
            pg.evaluate("window.__renderEp(2)"); time.sleep(0.4)
            # v1.45.5(low #9): 자막은 있는데 오디오가 없는 회차 — 여는 버튼(#np-tx-btn)이 렌더되지
            # 않으므로 시트를 만들면 열 수 없는 고아 노드가 body 에 남는다. 대신 사용자에게 안내 문구가
            # 보여야 한다. 예전 오라클은 "시트 수가 늘지 않는다"(이전 렌더가 남긴 시트가 있어 증가분으로
            # 판정)였는데, 그 '남긴 시트' 자체가 버그였다(2026-08-27: 같은 해시 재렌더가 옛 시트를 body 에
            # 남겨 자동추적이 그걸 스크롤했다). 이제 renderEpisode 가 직전 렌더를 먼저 걷으므로 오디오
            # 없는 회차 뒤에는 시트가 **0개**여야 한다 — 고아도, 잔존도 없이.
            sheets_before = pg.eval_on_selector_all(".tx-sheet", "els=>els.length")
            pg.evaluate("window.__renderEp(3)"); time.sleep(0.5)
            sheets_after = pg.eval_on_selector_all(".tx-sheet", "els=>els.length")
            noaudio_btn = pg.query_selector("#np-tx-btn") is None
            noaudio_note = pg.evaluate(
                "[...document.querySelectorAll('.empty')].some(e=>/Transcript opens once/.test(e.textContent))")
            noaudio_ok = (sheets_after == 0 and noaudio_btn is True and noaudio_note is True)
            print("NO-AUDIO-EP: sheets", sheets_before, "->", sheets_after, " no_tx_btn=", noaudio_btn,
                  " note=", noaudio_note, " ok=", noaudio_ok)
            # 📺 Video 모드 토글(v1.58.0): ep.transcript.video_id 가 있고 온라인일 때만 시트 툴바에
            # 뜬다. id 1 = video_id 없음(기존 목 회차, non-wh) → 시트 토글도, 메인 화면 1차 Video
            # 버튼(#np-video-btn)도 없어야 하고 Transcript 칩은 예전 그대로 .np-extras 안에 직접
            # 있어야 한다(v1.60.0 요구사항: 비-wh 화면은 오늘과 100% 동일 — .np-primary-row 자체가
            # 안 생겨야 함). id 4 = wh + video_id 있는 목 회차 → 시트 토글도, 메인 화면 1차 Video
            # 버튼(#np-video-btn, Transcript 와 동급으로 나란히)도 있어야 하고, 외부 원본 링크
            # (.np-ext-video-link, About 옆으로 격하)도 같이 뜨며, About 텍스트는 stripTrailingUrl 이
            # 원본 URL 을 걷어낸 뒤라야 한다(요구사항 #1 위치 이동 + #2 URL 노이즈 제거 회귀). 시트
            # 토글 자체는 실제 YouTube iframe 을 절대 로드하지 않지만(안 누름), 메인 Video 버튼은
            # turnVideoOn() 을 곧장 태우므로(요구사항: Library 진입과 정확히 같은 메커니즘 재사용)
            # 하니스가 심어 둔 가짜 YT 스텁으로 실제 마운트까지 확인한다(네트워크 0).
            # ⚠ __renderEp() 는 hashchange 를 안 태우므로 이전 렌더의 시트(body 직속, position:fixed
            # 풀스크린)가 안 지워진 채 쌓인다 → id=4 는 이 블록에서 딱 한 번만 렌더한다(두 번 렌더하면
            # body 에 #tx-video-toggle id 가 중복돼 document.getElementById 가 옛 스테일 시트를 집어
            # 검증이 엉뚱한 노드를 본다). eval_on_selector 로 실제 DOM click() 을 직접 호출해
            # 포인터-가시성 시뮬레이션을 우회한다(이 파일의 기존 관례, 예: .study-x/.cont-play
            # 재렌더 후 클릭도 전부 이 패턴).
            pg.evaluate("window.__renderEp(1)"); time.sleep(0.4)
            no_video_btn_id1 = pg.query_selector("#np-video-btn") is None
            tx_btn_in_extras_id1 = bool(pg.evaluate("!!document.querySelector('.np-extras > #np-tx-btn')"))
            no_primary_row_id1 = pg.query_selector(".np-primary-row") is None
            if pg.query_selector("#np-tx-btn"):
                pg.eval_on_selector("#np-tx-btn", "el=>el.click()"); time.sleep(0.3)
            video_toggle_hidden = pg.query_selector("#tx-video-toggle") is None
            # 툴바 한 줄 검증(비-wh, 6칩: KR·가·A·Shadow·1×·🚗) — 360/390 두 폭 모두에서 전부 화면
            # 안에 있고 '한 줄'인지 확인한다. '한 줄'은 offsetTop 완전 동일이 아니라 문턱(<8px)으로
            # 판정한다 — 🚗 는 다른 세로 패딩을 써서 같은 줄이어도 top 이 몇 px 어긋난다(실측 확인,
            # 이 파일의 다른 곳처럼 처음 넣을 때 직접 재서 정함). 줄바꿈되면 최소 30px+ 씩 뛰므로
            # 8px 문턱으로 확실히 구분된다. 여러 섹션이 쌓아 둔 스테일 '.tx-sheet.open' 중 가장 최근
            # 것(body 에 마지막으로 append 된 것)만 본다 — 위 npvid_sheet_open 주석과 같은 이유.
            def _toolbar_row_of_last_open_sheet():
                return pg.evaluate("""() => {
                  const sheets = [...document.querySelectorAll('.tx-sheet.open')];
                  const sheet = sheets[sheets.length - 1];
                  const tb = sheet ? sheet.querySelector('.tx-toolbar') : null;
                  if (!tb) return null;
                  const kids = [...tb.querySelectorAll('.tx-toggle')];
                  const tops = kids.map((k) => k.getBoundingClientRect().top);
                  const bad = kids.filter((e) => { const r = e.getBoundingClientRect();
                    return r.left < -0.5 || r.right > innerWidth + 0.5; });
                  return { n: kids.length, offscreen: bad.length,
                           topRange: kids.length ? Math.max(...tops) - Math.min(...tops) : 0 };
                }""")
            _vp_before_tb1 = pg.viewport_size
            tb_normal = {}
            for _vw in (360, 390):
                pg.set_viewport_size({"width": _vw, "height": 780}); time.sleep(0.2)
                tb_normal[_vw] = _toolbar_row_of_last_open_sheet()
                _shot(pg, f"tx-toolbar-normal-{_vw}")
            pg.set_viewport_size(_vp_before_tb1); time.sleep(0.2)
            print("TX-TOOLBAR-NORMAL (6 chips):", tb_normal)
            tb_normal_ok = all(
                isinstance(tb_normal[v], dict) and tb_normal[v]["n"] == 6
                and tb_normal[v]["offscreen"] == 0 and tb_normal[v]["topRange"] < 8
                for v in (360, 390))
            pg.evaluate("window.__renderEp(4)"); time.sleep(0.4)
            np_video_btn_present = pg.query_selector("#np-video-btn") is not None
            wh_chip_shown = bool(pg.query_selector(".np-ext-video-link"))
            about_txt = pg.eval_on_selector("#np-about-text", "el=>el.textContent") if pg.query_selector("#np-about-text") else None
            about_no_url = bool(about_txt) and "http" not in about_txt and "White House press briefing" in about_txt
            # 메인 화면 Video 버튼을 직접 클릭 — 시트가 열리고 그 자리에서 곧장 Video 모드까지 켜져야
            # 한다(Transcript 버튼처럼 시트만 여는 게 아니라, Library 의 📺 Video › 와 같은 결과).
            pg.evaluate("window.__ytCalls=[]; window.__ytMounts=[];")
            if pg.query_selector("#np-video-btn"):
                pg.eval_on_selector("#np-video-btn", "el=>el.click()"); time.sleep(0.3)
            video_toggle_shown = pg.query_selector("#tx-video-toggle") is not None
            # ⚠ document.querySelector('.tx-sheet')(단수) 는 이전 섹션들(chips_fit 의 id=2, NO-AUDIO-EP
            # 의 id=3 등)이 남긴 스테일 시트 중 '문서상 첫 번째'를 집어(hashchange 청소를 아직 안 거쳤다)
            # 방금 연 id=4 시트가 아닐 수 있다 — 반드시 '.open' 이 붙은 것만 골라야 한다(열린 시트는
            # 항상 하나뿐).
            npvid_sheet_open = pg.query_selector(".tx-sheet.open") is not None
            npvid_toggle_on = pg.eval_on_selector("#tx-video-toggle", "el=>el.classList.contains('on')") if pg.query_selector("#tx-video-toggle") else None
            npvid_wrap_visible = pg.eval_on_selector("#tx-video-wrap", "el=>el.hidden===false") if pg.query_selector("#tx-video-wrap") else None
            npvid_yt_mounted = pg.evaluate("(window.__ytMounts||[]).length")
            # 툴바 순서(사용자 요청): KR·가·A·Shadow·1×·🚗·📺·⤢(풀스크린, wh 전용이라 📺 옆 맨 끝) —
            # 가/A(두 텍스트 크기 칩)를 나란히 붙인다. 나머지 칩은 전부 id 로만 동작(#tx-shadow 등)
            # 하므로 마크업 '순서만' 바꿔도 안전(behaviour·id·cycling·자체 폭 불변). 360px·390px 두
            # 폭 모두에서 화면 밖으로 밀려나는 칩이 없는지, 그리고 '한 줄'인지(offsetTop 문턱 <8px —
            # 🚗/📺/⤢ 는 다른 세로 패딩을 써서 같은 줄이어도 top 이 몇 px 어긋난다, 실측 확인) 함께
            # 확인한다 — 8칩(wh, 영상 있음)이 실기기 신고의 실제 재현 케이스였다(390px 에서 두 줄:
            # KR·가·A·Shadow·1×·🚗 / 📺 단독).
            # ⚠ 여기서도 같은 스테일-시트 문제(위 npvid_sheet_open 주석 참고) — 이 시점엔 아직 옛 시트를
            # 안 닫아서 '.tx-sheet.open' 이 둘이다. '#tx-video-toggle' 은 id=4 시트에만 존재하는
            # 유일한 앵커라 거기서 .closest('.tx-sheet') 로 정확히 그 시트만 스코프한다.
            tx_toolbar_order = pg.evaluate("""() => {
              const sheet = document.getElementById('tx-video-toggle')?.closest('.tx-sheet');
              return sheet ? [...sheet.querySelectorAll('.tx-toolbar .tx-toggle')].map(el => el.id) : [];
            }""")
            # ⚠ 이 검사는 반드시 '가장 넓은 라벨'에서 해야 한다. 쉐도잉 칩은 Shadow → 3× Smart →
            # 2× Smart → 1× Smart → 2× Auto → 3× Auto → 5× Auto → 10× Auto 로 순환하는데, 기본값
            # 'Shadow'(6자)가 그 중 가장 좁다. 예전엔 기본 상태에서만 재서 '360/390 한 줄 통과' 가
            # 나왔지만 실기기 사용자는 '2× Smart' 상태였고 그때는 두 줄이었다(2026-08-07 스크린샷).
            # 라벨 하나가 실측 85px 로 Shadow 보다 ~30px 넓다 — 고정 min-width 를 줄여도 내용이 더
            # 넓으면 의미가 없다. 8단계를 전부 돌면서 최악값을 취한다(8번 누르면 제자리로 돌아온다).
            _vp_before_toolbar = pg.viewport_size
            tx_toolbar_fit = {}
            tx_toolbar_worst = {}
            _steps_seen = []
            for _vw in (360, 390):
                pg.set_viewport_size({"width": _vw, "height": 780}); time.sleep(0.2)
                worst = None
                # 라벨을 직접 써 넣어 최악 폭을 만든다. 칩을 실제로 눌러 순환시키려 했으나 하니스에선
                # 클릭이 라벨을 안 바꾼다(8번 눌러도 계속 'Shadow'). 여기서 볼 것은 순환 '동작' 이
                # 아니라 각 라벨에서의 '레이아웃 폭' 이고, 순환 자체는 다른 곳에서 검증된다.
                for _label in ('Shadow', '3× Smart', '2× Smart', '1× Smart',
                               '2× Auto', '3× Auto', '5× Auto', '10× Auto'):
                    pg.evaluate("""(lb) => {
                      const sheet = document.getElementById('tx-video-toggle')?.closest('.tx-sheet');
                      const sh = sheet?.querySelector('#tx-shadow');
                      if (sh) sh.textContent = lb;
                    }""", _label); time.sleep(0.05)
                    r = pg.evaluate("""() => {
                      const sheet = document.getElementById('tx-video-toggle')?.closest('.tx-sheet');
                      const tb = sheet ? sheet.querySelector('.tx-toolbar') : null;
                      if (!tb) return null;
                      const kids = [...tb.querySelectorAll('.tx-toggle')];
                      const tops = kids.map((k) => k.getBoundingClientRect().top);
                      const bad = kids.filter((e) => { const r = e.getBoundingClientRect();
                        return r.left < -0.5 || r.right > innerWidth + 0.5; });
                      const sh = sheet.querySelector('#tx-shadow');
                      const used = kids.reduce((s, k) => s + k.getBoundingClientRect().width, 0);
                      return { n: kids.length, offscreen: bad.length,
                               topRange: kids.length ? Math.max(...tops) - Math.min(...tops) : 0,
                               label: sh ? sh.textContent.trim() : '?',
                               chipsW: Math.round(used), avail: innerWidth,
                               // nowrap 이 된 뒤로는 '두 줄인가' 대신 '가로로 넘쳤는가' 가 실제 신호다.
                               overflow: Math.max(0, tb.scrollWidth - tb.clientWidth) };
                    }""")
                    if r:
                        _steps_seen.append(r)
                    if r and (worst is None or r["topRange"] > worst["topRange"]
                              or (r["topRange"] == worst["topRange"] and r["chipsW"] > worst["chipsW"])):
                        worst = r
                    if _label == 'Shadow':
                        tx_toolbar_fit[_vw] = r        # 기본 상태 — 참고용
                    _shot(pg, f"tx-toolbar-wh-{_vw}-{_label.replace(' ', '')}")
                tx_toolbar_worst[_vw] = worst
                if _vw == 360:
                    print("TX-TOOLBAR-STEPS(360):", [(s["label"], s["chipsW"], s["topRange"]) for s in _steps_seen])
                _steps_seen.clear()
            pg.set_viewport_size(_vp_before_toolbar); time.sleep(0.2)
            print("TX-TOOLBAR-WORST-LABEL:", tx_toolbar_worst)
            print("TX-TOOLBAR-ORDER:", tx_toolbar_order, " fit=", tx_toolbar_fit)
            tx_toolbar_order_ok = (
                tx_toolbar_order == ['tx-trans', 'tx-ko-size', 'tx-fs', 'tx-shadow', 'tx-speed',
                                      'tx-drive', 'tx-video-toggle', 'tx-fullscreen']
                # 한 줄은 이제 CSS(nowrap)가 보장하지만, wrap 으로 되돌아가는 회귀를 잡으려면
                # 계속 확인해야 한다 → topRange 는 두 폭 모두에서 assert.
                # 가로 넘침(overflow)은 390 에서만 assert 한다: 하니스는 같은 칩을 실기기보다 49px
                # 넓게 재므로(폰트 스택 차이, 2026-08-07 2회 측정) 360 에서의 넘침은 실기기에 없는
                # 조건이다. 360 수치는 사람이 여유를 보도록 출력만 한다.
                and all(isinstance(tx_toolbar_worst[v], dict) and tx_toolbar_worst[v]["n"] == 8
                        and tx_toolbar_worst[v]["topRange"] < 8 for v in (360, 390))
                and tx_toolbar_worst[390]["overflow"] == 0)
            print("VIDEO-TOGGLE: hidden_no_id=", video_toggle_hidden, " shown_with_id=", video_toggle_shown,
                  " wh_chip=", wh_chip_shown, " about_no_url=", about_no_url, " about_txt=", repr(about_txt))
            print("PRIMARY-VIDEO-BTN: absent_no_id=", no_video_btn_id1, " tx_in_extras_no_id=", tx_btn_in_extras_id1,
                  " no_primary_row_no_id=", no_primary_row_id1, " present_with_id=", np_video_btn_present,
                  " click->sheet_open=", npvid_sheet_open, " toggle_on=", npvid_toggle_on,
                  " wrap_visible=", npvid_wrap_visible, " yt_mounted=", npvid_yt_mounted)
            primary_video_btn_ok = (no_video_btn_id1 is True and tx_btn_in_extras_id1 is True
                                     and no_primary_row_id1 is True and np_video_btn_present is True
                                     and npvid_sheet_open is True and npvid_toggle_on is True
                                     and npvid_wrap_visible is True and npvid_yt_mounted == 1)
            # 시트를 닫아 메인 화면(1차 액션 버튼들)이 다시 보이게 한다 — 실제 닫기 버튼을 눌러
            # closeSheet()(videoOn 이면 turnVideoOff() 도 같이) 를 정상 경로로 태운다. 안 닫으면
            # 방금 켠 Video 시트(풀스크린 오버레이)가 아래 스크린샷을 덮어 버튼 줄이 안 보인다.
            # ⚠ 위 npvid_sheet_open 과 같은 이유로 반드시 '.tx-sheet.open' 스코프 안에서만 닫기
            # 버튼을 찾는다 — 스코프 없는 '.tx-sheet-close' 는 이전 섹션들의 스테일 시트 중 문서상
            # 첫 번째를 집어(이미 닫혀 있어 클릭이 무의미) 지금 열려 있는 id=4 시트를 안 닫힌 채로 둔다.
            # ⚠ 실측: 이 시점에 열린('.open') 시트가 하나가 아니라 '둘' 이었다 — 맨 위(하니스 로드 시
            # 최초 렌더)에서 연 뒤 한 번도 안 닫은 시트가 여태 살아 있고(그 섹션은 닫기를 검증하지
            # 않아 무해했다), 방금 내가 연 id=4 시트가 그 위에 하나 더. 단수 '.tx-sheet.open
            # .tx-sheet-close' 는 문서상 첫 번째(=옛날 그 시트)를 집어 그걸 닫고, 정작 방금 연 시트는
            # 그대로 열린 채 남아 스크린샷을 덮었다 — forEach 로 열려 있는 시트를 전부 닫는다.
            pg.evaluate("document.querySelectorAll('.tx-sheet.open .tx-sheet-close').forEach(el => el.click())")
            time.sleep(0.3)
            # 시각 회귀(요구사항 — 추론이 아니라 실제로 봐야 한다): 두 케이스 모두 폰 뷰포트에서 찍는다.
            # id=4(video_id 있음) = Transcript+Video 두 버튼 나란히, id=1(없음) = Transcript 단독
            # (오늘과 동일). 390/360 두 폭에서 줄바꿈·잘림이 없는지 눈으로 확인.
            _vp_before_primary = pg.viewport_size
            for _vw in (390, 360):
                pg.set_viewport_size({"width": _vw, "height": 780}); time.sleep(0.2)
                _shot(pg, f"primary-actions-wh-video-{_vw}")
            pg.evaluate("window.__renderEp(1)"); time.sleep(0.4)
            for _vw in (390, 360):
                pg.set_viewport_size({"width": _vw, "height": 780}); time.sleep(0.2)
                _shot(pg, f"primary-actions-no-video-{_vw}")
            pg.set_viewport_size(_vp_before_primary); time.sleep(0.2)
            pg.evaluate("window.__renderEp(4)"); time.sleep(0.4)   # 아래 LIBRARY-VIDEO-DEEPLINK 블록은 id=4 상태를 이어받는다
            # 📺 Library 진입 체인 회귀(실기기 v1.58.0 신고): Continue/Latest Episode 카드나 목록 행의
            # 📺 Video 버튼 → aep-open-video 플래그 → hashchange → 회차 진입에서 Video 모드까지 자동으로
            # 켜져야 한다("시트만 열리고 영상은 안 켜짐" 신고). __renderEp() 직접호출(위의 다른 검증들이
            # 쓰는 지름길)은 hashchange 를 안 태우므로 이 경로를 재현 못 한다 — 반드시 location.hash 를
            # 바꿔 hashchange 가 실제로 라우팅을 몰게 한다(위에서 등록한 하니스 미니 라우터, 이 함수
            # 안에서 route() 격 호출을 또 하면 이중렌더+시트중복이라 절대 하지 않는다).
            pg.evaluate("location.hash=''"); time.sleep(0.3)   # 위 __renderEp(4) 잔여 시트를 hashchange cleanup 으로 정리
            pg.evaluate("sessionStorage.setItem('aep-open-video','4')")
            pg.evaluate("window.__ytCalls=[]; window.__ytMounts=[];")
            pg.evaluate("location.hash='#/episode/4'")
            try:
                pg.wait_for_function(
                    "document.getElementById('tx-video-toggle') && "
                    "document.getElementById('tx-video-toggle').getAttribute('aria-pressed')==='true'",
                    timeout=3000)
            except Exception:
                pass
            time.sleep(0.2)
            lv_sheet_open = pg.eval_on_selector(".tx-sheet", "el=>el.classList.contains('open')") if pg.query_selector(".tx-sheet") else False
            lv_toggle_pressed = pg.eval_on_selector("#tx-video-toggle", "el=>el.getAttribute('aria-pressed')") if pg.query_selector("#tx-video-toggle") else None
            lv_toggle_on = pg.eval_on_selector("#tx-video-toggle", "el=>el.classList.contains('on')") if pg.query_selector("#tx-video-toggle") else None
            lv_wrap_visible = pg.eval_on_selector("#tx-video-wrap", "el=>el.hidden===false") if pg.query_selector("#tx-video-wrap") else None
            lv_yt_mounted = pg.evaluate("(window.__ytMounts||[]).length")
            lv_yt_played = pg.evaluate("(window.__ytCalls||[]).some(c=>c[0]==='play')")
            lv_audio_paused = pg.evaluate("(window.__calls||[]).some(c=>c[0]==='pause')")
            lv_player_vars = pg.evaluate("(window.__ytMounts||[])[0]?.playerVars || null")
            print("LIBRARY-VIDEO-DEEPLINK: sheet_open=", lv_sheet_open, " toggle_pressed=", lv_toggle_pressed,
                  " toggle_on=", lv_toggle_on, " wrap_visible=", lv_wrap_visible,
                  " yt_mounted=", lv_yt_mounted, " yt_played=", lv_yt_played, " audio_paused=", lv_audio_paused,
                  " player_vars=", lv_player_vars)
            # YouTube 자체 풀스크린 진입로 차단(사용자 신고: 세로 풀스크린 + 유튜브 자체 자막이 우리
            # 자막과 겹침) — playsinline(iOS 인라인 유지)·fs:0(풀스크린 버튼 제거)·cc_load_policy:0
            # (자체 자막 기본 끔)이 실제로 new YT.Player(...) 에 전달되는지 고정한다.
            lv_playervars_ok = (isinstance(lv_player_vars, dict)
                                 and lv_player_vars.get("playsinline") == 1
                                 and lv_player_vars.get("fs") == 0
                                 and lv_player_vars.get("modestbranding") == 1
                                 and lv_player_vars.get("iv_load_policy") == 3
                                 and lv_player_vars.get("cc_load_policy") == 0
                                 and lv_player_vars.get("rel") == 0)
            # 레이아웃(사용자 신고 #2): 영상은 시트 상단에 고정, 자막(.tx-scroll)이 그 아래 남은 높이를
            # 채우고 자체 스크롤해야 한다 — 영상이 자막과 함께 밀려 올라가면 안 된다. 실측(폰 뷰포트)
            # 으로 기하를 재고, 사람이 봐도 확인할 수 있게 스크린샷도 남긴다(AEP_SHOTS 설정 시).
            _vp_before_video = pg.viewport_size
            pg.set_viewport_size({"width": 390, "height": 780})   # iPhone 급 세로 폰
            time.sleep(0.3)
            _shot(pg, "video-mode-on-pinned-top")
            # ⚠ 네 요소를 반드시 '같은 시트'에서 집어야 한다. 예전엔 vw 만 document.getElementById
            # (문서 순서상 첫 번째)로, 나머지는 '.tx-sheet.open'(역시 첫 번째)로 집었다 — 이 구간엔
            # 열린 시트가 둘일 수 있어(위 TX-TOOLBAR 주석) 서로 다른 시트의 사각형을 섞어 쟀고,
            # 그래서 '자막이 시트 밖으로 918px 넘침' 같은 실제로는 없는 실패가 나왔다.
            lv_geo = pg.evaluate("""() => {
              const sheet = document.getElementById('tx-video-toggle')?.closest('.tx-sheet')
                         || document.querySelector('.tx-sheet.open');
              const tb = sheet?.querySelector('.tx-toolbar');
              const vw = sheet?.querySelector('#tx-video-wrap');
              const sc = sheet?.querySelector('.tx-scroll');
              const card = sheet?.querySelector('.tx-sheet-card');
              if (!tb || !vw || !sc || !card) return null;
              const r = (el) => el.getBoundingClientRect();
              return { tb: r(tb), vw: r(vw), sc: r(sc), card: r(card) };
            }""")
            print("LIBRARY-VIDEO-LAYOUT:", lv_geo)
            # A bare geometry verdict cannot be acted on: "sc.bottom 1698 vs card.bottom 780" says
            # a box is too tall but not which ancestor stopped constraining it, and this check sat
            # red for two weeks partly for that reason. On failure, dump the layout chain from
            # .tx-scroll up to .tx-sheet, plus how many sheets/scrolls are live — the two things
            # that actually distinguish a CSS bug from leftover DOM state in this suite.
            def _lv_diag():
                d = pg.evaluate("""() => {
                  const sheet = document.getElementById('tx-video-toggle')?.closest('.tx-sheet')
                             || document.querySelector('.tx-sheet.open');
                  if (!sheet) return {error: 'no sheet'};
                  const sc = sheet.querySelector('.tx-scroll');
                  if (!sc) return {error: 'no .tx-scroll in sheet'};
                  const chain = [];
                  for (let el = sc; el; el = el.parentElement) {
                    const cs = getComputedStyle(el), b = el.getBoundingClientRect();
                    chain.push(`${el.tagName.toLowerCase()}.${(el.className||'').toString().trim()}`
                      + ` display=${cs.display} flex=${cs.flex} minH=${cs.minHeight}`
                      + ` maxH=${cs.maxHeight} h=${Math.round(b.height)} top=${Math.round(b.top)}`
                      + ` bottom=${Math.round(b.bottom)} ovY=${cs.overflowY} cv=${cs.contentVisibility}`);
                    if (el.classList.contains('tx-sheet')) break;
                  }
                  return {
                    sheetsTotal: document.querySelectorAll('.tx-sheet').length,
                    sheetsOpen: document.querySelectorAll('.tx-sheet.open').length,
                    scrollsInDoc: document.querySelectorAll('.tx-scroll').length,
                    scrollsInSheet: sheet.querySelectorAll('.tx-scroll').length,
                    cardsInSheet: sheet.querySelectorAll('.tx-sheet-card').length,
                    scScrollHeight: sc.scrollHeight, scClientHeight: sc.clientHeight,
                    krOverlay: getComputedStyle(sc).getPropertyValue('--kr-overlay'),
                    scPadBottom: getComputedStyle(sc).paddingBottom,
                    scClassList: [...sc.classList],
                    chain,
                  };
                }""")
                print("LIBRARY-VIDEO-LAYOUT-DIAG:")
                for k, v in (d or {}).items():
                    if k == "chain":
                        for line in v:
                            print("    ", line)
                    else:
                        print(f"     {k} = {v}")

            lv_layout_ok = False
            if isinstance(lv_geo, dict):
                tb, vw, sc, card = lv_geo["tb"], lv_geo["vw"], lv_geo["sc"], lv_geo["card"]
                vw_ratio = (vw["width"] / vw["height"]) if vw["height"] else 0
                lv_layout_ok = (
                    tb["top"] <= vw["top"] + 1               # 툴바가 영상보다 위(또는 같은 줄)
                    and vw["top"] < sc["top"]                 # 영상이 자막 스크롤 영역보다 위
                    and sc["top"] >= vw["bottom"] - 1          # 자막이 영상 '아래'에서 시작(겹침 없음)
                    and sc["bottom"] <= card["bottom"] + 1     # 자막이 시트 안에 담김(넘치지 않음)
                    and 1.5 < vw_ratio < 2.0                   # 영상이 대략 16:9(≈1.78) 그대로(우리쪽 레터박스 없음)
                )
            if not lv_layout_ok:
                _lv_diag()
            # 껐을 때 원상복구(요구사항 #4) — 다시 토글해 .tx-video-wrap 이 hidden 되고 .tx-scroll 이
            # 그 공간을 도로 흡수하는지 확인한다.
            if pg.query_selector("#tx-video-toggle"):
                pg.eval_on_selector("#tx-video-toggle", "el=>el.click()"); time.sleep(0.3)
            lv_off_hidden = pg.eval_on_selector("#tx-video-wrap", "el=>el.hidden") if pg.query_selector("#tx-video-wrap") else None
            lv_off_geo = pg.evaluate("""() => {
              const vw = document.getElementById('tx-video-wrap');
              const sc = document.querySelector('.tx-sheet.open .tx-scroll');
              if (!vw || !sc) return null;
              return { vwDisplay: getComputedStyle(vw).display, scTop: sc.getBoundingClientRect().top };
            }""")
            print("LIBRARY-VIDEO-OFF-RESTORE: hidden=", lv_off_hidden, " geo=", lv_off_geo)
            lv_off_ok = (lv_off_hidden is True and isinstance(lv_off_geo, dict)
                         and lv_off_geo.get("vwDisplay") == "none")
            pg.set_viewport_size(_vp_before_video)

            # === KR 번역 패널(.tx-notes) 겹침 회귀 ===
            # 사용자 신고: 영상 모드에서 재생 중인 문장('...creation, innovation, and long-')이 하단
            # KR 패널 뒤에 잘려 보임 — _highlightImpl 이 패널 유무를 h 의 고정 비율(58%)로 어림한 게
            # 원인(영상 모드는 스크롤 영역 h 자체가 작아 그 어림이 깨짐). 이제 패널의 실측 위치를
            # 앵커 계산에 쓴다(위 episode.js 수정) — 여기서 실제 하이라이트 파이프라인으로 재현한다.
            # window.__video(하니스 훅, 위에서 등록)로 영상 모드의 재생 시각을 직접 밀어 여러 문장을
            # '진행'시키면서 매번 확인 — KR 패널이 뜬 문장에서 한 번도 안 가려져야 pass.
            pg.evaluate("window.__DIAG_KR = true")
            pg.set_viewport_size({"width": 390, "height": 780}); time.sleep(0.2)
            if pg.query_selector("#tx-video-toggle") and pg.eval_on_selector("#tx-video-toggle", "el=>el.getAttribute('aria-pressed')") != 'true':
                pg.eval_on_selector("#tx-video-toggle", "el=>el.click()"); time.sleep(0.4)   # video ON
            if pg.query_selector("#tx-trans") and pg.eval_on_selector("#tx-trans", "el=>el.getAttribute('aria-pressed')") != 'true':
                pg.click("#tx-trans"); time.sleep(0.1)   # KR ON(기본값이지만 명시적으로 확정)
            kr_checks = []
            # ⚠ 고정 sleep 으로 재면 안 된다. smoothScrollTo 는 rAF 로 프레임당 12% 씩 접근하는
            # 이징이라 수렴 시간이 '이동 거리'에 비례한다 — 첫 seek 은 앞 테스트가 남긴 위치(측정값
            # scrollTop 1308 → target 222, 1086px)에서 출발해 ~0.82s 가 걸리는데 0.7s 에 재면 항상
            # 이징 '중간값'을 잡아 첫 샘플만 실패한다(2026-08-07: 앱 쪽 패딩·앵커를 고쳐도 수치가
            # 1px 도 안 변해서 드러났다 — 실행마다 값이 완전히 동일한 게 이징의 결정론성 힌트였다).
            # 스크롤이 멈출 때까지 기다린 뒤 잰다. 판정 기준(겹치면 실패)은 그대로다.
            def _settle_scroll(max_wait=3.0):
                prev, stable = None, 0
                waited = 0.0
                while waited < max_wait:
                    cur = pg.evaluate("() => { const s=document.querySelector('.tx-scroll'); return s ? Math.round(s.scrollTop) : -1; }")
                    stable = stable + 1 if cur == prev else 0
                    if stable >= 2:
                        return
                    prev = cur
                    time.sleep(0.1); waited += 0.1

            for _t in (11, 23, 36, 49, 61, 69, 83, 96):   # FIX_SENTS 각 문장 진입 직후 시각
                pg.evaluate(f"window.__video.seek({_t})"); time.sleep(0.2); _settle_scroll()
                r = pg.evaluate("""() => {
                  // ⚠ 이 구간엔 열린 시트가 둘일 수 있다(위 TX-TOOLBAR 주석 참고). 스코프 없이
                  // 첫 번째 .tx-sheet.open 을 집으면 '옛 시트'를 재게 된다 — 그러면 무엇을 고쳐도
                  // 수치가 안 변한다. 측정도 조작(seek)과 같은 시트여야 한다.
                  const sheet = document.getElementById('tx-video-toggle')?.closest('.tx-sheet')
                             || document.querySelector('.tx-sheet.open');
                  const active = sheet ? sheet.querySelector('.tx-sent.active') : null;
                  const notes = sheet ? sheet.querySelector('.tx-notes') : null;
                  if (!active || !notes) return null;
                  const notesOn = notes.classList.contains('show');
                  if (!notesOn) return { notesOn };
                  const a = active.getBoundingClientRect(), n = notes.getBoundingClientRect();
                  const sc = sheet.querySelector('.tx-scroll');
                  const cTop = sc ? sc.getBoundingClientRect().top : 0;
                  return { notesOn, t: %d, activeBottom: Math.round(a.bottom), notesTop: Math.round(n.top),
                           aboveNotes: a.bottom <= n.top + 0.5,
                           // 위로 잘림(머리가 스크롤 영역 위로 넘어감) — 읽을 수 없는 상태.
                           // v1.65.0 회귀 재발 방지(2× Smart 반복 중 되감기에서 발생).
                           topClipped: Math.round(a.top) < Math.round(cTop) - 1,
                           // 문장 높이와 '안 가려진 높이' — 판정을 나누는 데 쓴다(아래 파이썬 주석).
                           sentH: Math.round(a.height), usable: Math.round(n.top - cTop),
                           text: active.textContent.trim().slice(0, 40),
                           sheets: document.querySelectorAll('.tx-sheet.open').length,
                           scoped: sheet === document.querySelector('.tx-sheet.open') };
                }""" % _t)
                kr_checks.append(r)
            _shot(pg, "kr-panel-overlap-video-390")
            print("KR-PANEL-OVERLAP (video mode, KR on):", kr_checks)
            print("KR-DIAG:", pg.evaluate("() => (window.__KRDIAG || []).slice(0, 3)"))
            print("KR-REDIAG:", pg.evaluate("() => (window.__REDIAG || []).slice(0, 12)"))
            kr_shown_checks = [c for c in kr_checks if isinstance(c, dict) and c.get("notesOn") is True]
            # ⚠ 문장이 '안 가려진 높이'(usable = KR 패널 위 여백)보다 크면 '머리가 보인다' 와
            # '꼬리가 패널 위' 를 동시에 만족하는 게 물리적으로 불가능하다. 그때 옳은 동작은
            # 시작을 보여주는 것이다 — 읽기는 위에서 시작하고 패널엔 그 문장의 번역이 떠 있다.
            # 그래서 판정을 나눈다: 들어가는 문장은 가리면 실패, 안 들어가는 문장은 머리가
            # 잘리면 실패. (예전엔 전자만 봐서, 앱이 긴 문장의 머리를 잘라 화면 위로 밀어내도
            # 통과했다 — 사용자 신고 2026-08-10 이 그 상태였다.)
            def _fits(c):
                # 문턱 18 = 앱이 요구하는 여유의 합(머리 위 8px + 꼬리와 패널 사이 10px).
                # 그보다 여유가 없으면 두 조건을 동시에 만족하는 게 산술적으로 불가능하다 —
                # 실제로 sentH 156 / usable 167 인 지점이 여기 걸렸다(여유 11px < 18px).
                return (c.get("sentH") or 0) + 18 <= (c.get("usable") or 0)
            kr_overlap_ok = len(kr_shown_checks) >= 1 and all(
                (c.get("aboveNotes") is True) if _fits(c) else (c.get("topClipped") is not True)
                for c in kr_shown_checks)
            kr_clip_ok = all(c.get("topClipped") is not True for c in kr_shown_checks if _fits(c))
            print("KR-TOP-CLIP:", [c.get("t") for c in kr_shown_checks if c.get("topClipped")] or "none")
            # KR 꺼짐 — 이 로직 자체를 안 타므로(safeBottom = h*0.90, 예전 상수 그대로) 예전과
            # 동일해야 한다: 활성 문장이 화면 안(완전히 안 사라짐)에 있으면 충분한 회귀 가드.
            if pg.query_selector("#tx-trans"):
                pg.click("#tx-trans"); time.sleep(0.1)   # KR OFF
            pg.evaluate("window.__video.seek(69)"); time.sleep(0.7)
            kr_off_check = pg.evaluate("""() => {
              const sheet = document.querySelector('.tx-sheet.open');
              const active = sheet ? sheet.querySelector('.tx-sent.active') : null;
              const notes = sheet ? sheet.querySelector('.tx-notes') : null;
              if (!active) return null;
              const sc = sheet.querySelector('.tx-scroll');
              const a = active.getBoundingClientRect(), c = sc.getBoundingClientRect();
              return { notesOn: !!(notes && notes.classList.contains('show')),
                       visible: a.bottom > c.top && a.top < c.bottom };
            }""")
            print("KR-OFF-UNCHANGED (video mode):", kr_off_check)
            kr_off_ok = isinstance(kr_off_check, dict) and kr_off_check["notesOn"] is False and kr_off_check["visible"] is True
            if pg.query_selector("#tx-trans"):
                pg.click("#tx-trans"); time.sleep(0.1)   # KR 다시 ON(아래 마지막 문장 테스트가 필요로 함)
            # 마지막 문장까지 패널 위로 끌어올릴 여유가 있는가(요구사항 #2) — .tx-scroll 하단 패딩이
            # --kr-overlay 만큼 늘어나 있어야 스크롤 최댓값에서 마지막 문단이 패널 위로 온전히
            # 빠져나온다. idx=6(t=68, vocab 붙어 있어 always-shown)로 패널을 띄운 채, 스크롤을
            # 인위적으로 끝까지 내려 실제 도달 가능한지 지오메트리로 확인한다(활성 문장이 무엇이든
            # 무관 — 패딩 메커니즘 자체의 검증).
            pg.evaluate("window.__video.seek(69)"); time.sleep(0.5)
            last_reach = pg.evaluate("""() => {
              const sheet = document.querySelector('.tx-sheet.open');
              const notes = sheet.querySelector('.tx-notes');
              const sc = sheet.querySelector('.tx-scroll');
              const paras = [...sc.querySelectorAll('.tx-para')];
              const lastPara = paras[paras.length - 1];
              if (!notes || !sc || !lastPara) return null;
              const notesOn = notes.classList.contains('show');
              const padBottom = parseFloat(getComputedStyle(sc).paddingBottom) || 0;
              sc.scrollTop = sc.scrollHeight - sc.clientHeight;   // 스크롤 최댓값으로 강제 이동
              const lp = lastPara.getBoundingClientRect(), n = notes.getBoundingClientRect(), c = sc.getBoundingClientRect();
              return { notesOn, padBottom, lastParaBottom: Math.round(lp.bottom), notesTop: Math.round(n.top),
                       reachable: lp.bottom <= n.top + 0.5 };
            }""")
            print("KR-PANEL-LAST-SENTENCE-REACHABLE:", last_reach)
            last_reach_ok = (isinstance(last_reach, dict) and last_reach["notesOn"] is True
                              and last_reach["padBottom"] > 110 and last_reach["reachable"] is True)
            kr_panel_ok = kr_overlap_ok and kr_off_ok and last_reach_ok and kr_clip_ok

            # === 🖥 풀스크린 스터디 모드 ===
            # 사용자 요청: 헤더(핸들·제목·날짜)+툴바를 감추고 영상을 화면 맨 위에 붙여 트랜스크립트에
            # 최대 공간을 준다. 진입 시 video 가 꺼져 있으면 먼저 켠다(항상 'video on' 전제) — 여기서는
            # 이미 켜져 있으므로(위 KR 테스트) 곧장 켜져야 한다. 탈출구(#tx-fs-exit)가 항상 뜨는지,
            # 나가면 헤더/툴바가 복원되는지, video 를 끄면 풀스크린도 같이 꺼지는지까지 확인한다.
            if pg.query_selector("#tx-trans"):
                pg.click("#tx-trans"); time.sleep(0.1)   # 스크린샷을 KR on 상태로 통일
            pg.set_viewport_size({"width": 390, "height": 780}); time.sleep(0.2)
            fs_before = pg.evaluate("""() => {
              const sheet = document.querySelector('.tx-sheet.open .tx-sheet-card');
              return sheet ? { fs: sheet.classList.contains('fullscreen'),
                                headerVisible: getComputedStyle(sheet.querySelector('.tx-sheet-header')).display !== 'none' } : null;
            }""")
            if pg.query_selector("#tx-fullscreen"):
                pg.eval_on_selector("#tx-fullscreen", "el=>el.click()"); time.sleep(0.4)
            fs_on = pg.evaluate("""() => {
              const sheet = document.querySelector('.tx-sheet.open .tx-sheet-card');
              if (!sheet) return null;
              const header = sheet.querySelector('.tx-sheet-header');
              const toolbar = sheet.querySelector('.tx-toolbar');
              const exit = sheet.querySelector('#tx-fs-exit');
              const wrap = sheet.querySelector('#tx-video-wrap');
              const vidToggle = sheet.querySelector('#tx-video-toggle');
              const er = exit ? exit.getBoundingClientRect() : null;
              return {
                fsClass: sheet.classList.contains('fullscreen'),
                headerHidden: getComputedStyle(header).display === 'none',
                toolbarHidden: getComputedStyle(toolbar).display === 'none',
                videoOn: vidToggle && vidToggle.classList.contains('on'),
                wrapPadTop: wrap ? parseFloat(getComputedStyle(wrap).paddingTop) : null,
                exitVisible: exit && !exit.hidden,
                exitBox: er ? { w: Math.round(er.width), h: Math.round(er.height) } : null,
                cardTop: Math.round(sheet.getBoundingClientRect().top),
              };
            }""")
            _shot(pg, "fullscreen-on-390")
            print("FULLSCREEN-ON:", fs_before, "->", fs_on)
            fullscreen_on_ok = (isinstance(fs_before, dict) and fs_before["fs"] is False and fs_before["headerVisible"] is True
                                 and isinstance(fs_on, dict) and fs_on["fsClass"] is True and fs_on["headerHidden"] is True
                                 and fs_on["toolbarHidden"] is True and fs_on["videoOn"] is True
                                 and fs_on["wrapPadTop"] == 0 and fs_on["exitVisible"] is True
                                 and isinstance(fs_on["exitBox"], dict) and fs_on["exitBox"]["w"] >= 44 and fs_on["exitBox"]["h"] >= 44
                                 and fs_on["cardTop"] <= 1)
            if pg.query_selector("#tx-fs-exit"):
                pg.eval_on_selector("#tx-fs-exit", "el=>el.click()"); time.sleep(0.4)
            fs_off = pg.evaluate("""() => {
              const sheet = document.querySelector('.tx-sheet.open .tx-sheet-card');
              if (!sheet) return null;
              const header = sheet.querySelector('.tx-sheet-header');
              const toolbar = sheet.querySelector('.tx-toolbar');
              const vidToggle = sheet.querySelector('#tx-video-toggle');
              return { fsClass: sheet.classList.contains('fullscreen'),
                       headerVisible: getComputedStyle(header).display !== 'none',
                       toolbarVisible: getComputedStyle(toolbar).display !== 'none',
                       videoStillOn: vidToggle && vidToggle.classList.contains('on') };
            }""")
            _shot(pg, "fullscreen-off-390")
            print("FULLSCREEN-OFF (via exit chip):", fs_off)
            # 나가는 건 풀스크린만 — video 는 그대로 켜진 채여야 한다(요구사항: exit 는 풀스크린 한
            # 단계만 뒤로, video 끄기는 별도 결정 — 아래에서 video 를 끄면 풀스크린도 같이 꺼지는
            # '반대 방향' 대칭을 확인한다).
            fullscreen_off_ok = (isinstance(fs_off, dict) and fs_off["fsClass"] is False
                                  and fs_off["headerVisible"] is True and fs_off["toolbarVisible"] is True
                                  and fs_off["videoStillOn"] is True)
            # video 를 끄면 풀스크린도 같이 꺼진다(turnVideoOff 안의 exitFullscreen 호출) — 대칭 확인.
            if pg.query_selector("#tx-fullscreen"):
                pg.eval_on_selector("#tx-fullscreen", "el=>el.click()"); time.sleep(0.4)   # 다시 풀스크린 진입
            fs_reentered = pg.eval_on_selector(".tx-sheet.open .tx-sheet-card", "el=>el.classList.contains('fullscreen')")
            if pg.query_selector("#tx-video-toggle"):
                pg.eval_on_selector("#tx-video-toggle", "el=>el.click()"); time.sleep(0.4)   # video OFF
            fs_after_video_off = pg.evaluate("""() => {
              const sheet = document.querySelector('.tx-sheet.open .tx-sheet-card');
              const vidToggle = sheet.querySelector('#tx-video-toggle');
              return { fsClass: sheet.classList.contains('fullscreen'),
                       videoOn: vidToggle && vidToggle.classList.contains('on') };
            }""")
            print("FULLSCREEN-VIDEO-COUPLING: reentered=", fs_reentered, " after video off=", fs_after_video_off)
            fullscreen_coupling_ok = (fs_reentered is True and isinstance(fs_after_video_off, dict)
                                       and fs_after_video_off["fsClass"] is False and fs_after_video_off["videoOn"] is False)
            fullscreen_ok = fullscreen_on_ok and fullscreen_off_ok and fullscreen_coupling_ok
            libvideo_ok = (lv_sheet_open is True and lv_toggle_pressed == "true" and lv_toggle_on is True
                           and lv_wrap_visible is True and lv_yt_mounted == 1 and lv_yt_played is True
                           and lv_audio_paused is True and lv_playervars_ok is True
                           and lv_layout_ok is True and lv_off_ok is True)
            print("PLAYER CALLS=", calls)
            print("window.__err=", werr, " CONSOLE=", errs)
            print("episode: about_blocks=", about)
            ep_ok = (noaudio_ok is True
                     and isinstance(chips_fit, dict) and chips_fit["n"] >= 4 and chips_fit["offscreen"] == 0
                     # titleH 상한 = 2줄(22px * 1.28 * 2 ≈ 57) + 여유. 클램프가 풀리면 여기서 걸린다.
                     and isinstance(np_fit, dict) and np_fit["titleH"] <= 62 and np_fit["clearance"] >= 8
                     and dl_none_mega is True and dl_idle == "Offline" and dl_saved == "Saved"
                     and dl_aria == "Remove offline download"
                     and n_sent > 0 and not werr and not errs and any(c[0] == "toggle" for c in calls)
                     and notes_show is True and notes_no_vocab and about == 1
                     and isinstance(trans_ok, str) and trans_ok.startswith("[KO]")
                     and "fill in the gap" in trans_ok  # 번역이 현재 활성 문장과 대응(인덱스 mismatch 아님)
                     and trans_default_on is True
                     and trans_fs is not None and trans_fs >= 20 and trans_fixed is True
                     and tr_issue_ok is True
                     and calib_gone is True and sync_ok is True and ctrl_reveal is True
                     and fs_ok is True and dark_ok and ad_detect == 2 and ad_none is True
                     and ad_mid_ok is True and sync_btn_gone is True
                     and isinstance(cv_ok, dict) and cv_ok["cv"] == "hidden"
                     and shadow_ok is True
                     and wordpop_ok is True and drive_ok is True and seek_follow is True
                     and vk_ok is True
                     and video_toggle_hidden is True and video_toggle_shown is True
                     and wh_chip_shown is True and about_no_url is True
                     and primary_video_btn_ok is True and tx_toolbar_order_ok is True and tb_normal_ok is True
                     and libvideo_ok is True and kr_panel_ok is True and fullscreen_ok is True)
            # ep 묶음은 항목이 30개가 넘는 논리곱이라 실패해도 무엇이 걸렸는지 안 보인다 → 찍는다.
            print("EP-SUBFAILED:", [k for k, v in {
                "noaudio": noaudio_ok is True, "chips_fit": isinstance(chips_fit, dict) and chips_fit["offscreen"] == 0,
                "np_fit": isinstance(np_fit, dict) and np_fit["titleH"] <= 62 and np_fit["clearance"] >= 8,
                "download": dl_none_mega is True and dl_idle == "Offline" and dl_saved == "Saved",
                "notes": notes_show is True and bool(notes_no_vocab) and about == 1,
                "trans": isinstance(trans_ok, str) and trans_ok.startswith("[KO]") and "fill in the gap" in trans_ok,
                "trans_fs": trans_fs is not None and trans_fs >= 20 and trans_fixed is True,
                "sync": sync_ok is True, "fs": fs_ok is True, "ads": ad_detect == 2 and ad_none is True and ad_mid_ok is True,
                "shadow": shadow_ok is True, "wordpop": wordpop_ok is True, "drive": drive_ok is True,
                "seek_follow": seek_follow is True, "vk": vk_ok is True,
                "video_toggle": video_toggle_hidden is True and video_toggle_shown is True,
                "primary_video": primary_video_btn_ok is True, "toolbar_order": tx_toolbar_order_ok is True,
                "tb_normal": tb_normal_ok is True, "libvideo": libvideo_ok is True,
                "kr_panel": kr_panel_ok is True, "fullscreen": fullscreen_ok is True,
                "errs": (not werr) and (not errs),
            }.items() if not v] or "none")

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
                _shot(pg, "sess-prompt")
                has_rev = bool(pg.query_selector("#sess-reveal"))
                if has_rev:
                    pg.click("#sess-reveal"); time.sleep(0.1)
                    _shot(pg, "sess-revealed")
                    pg.click("#sess-good"); time.sleep(0.3)
                    _shot(pg, "sess-new")
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
            # v1.45.7: Today 카드의 'Level check ›'(#plan-level) — 커버리지가 없던 컨트롤인데
            # v1.45.6 에서 히트 영역(.cont-script::after 44px)과 키보드 핸들러를 동시에 건드렸다.
            # ① 클릭이 여전히 받아쓰기(레벨 체크)로 진입하는지 ② role="button" 답게 Enter 로도 되는지.
            lvl_click = lvl_key = None
            if pg.query_selector("#plan-level"):
                pg.eval_on_selector("#plan-level", "el=>el.click()"); time.sleep(0.45)
                lvl_click = bool(pg.query_selector("#d-in") and pg.query_selector("#d-check"))
                exitToStudyHome = "history.back()"
                pg.evaluate(exitToStudyHome); time.sleep(0.5)
                if pg.query_selector("#plan-level"):
                    pg.eval_on_selector("#plan-level", """el=>el.dispatchEvent(
                        new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}))""")
                    time.sleep(0.45)
                    lvl_key = bool(pg.query_selector("#d-in") and pg.query_selector("#d-check"))
            print("LEVEL-CHECK: click=", lvl_click, " enter_key=", lvl_key)
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
            study_ok = (chip_swap_ok is True and lvl_click is True and lvl_key is True
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
            # 📺 Library 진입점(요구사항 #3, v1.58.0): wh(백악관 브리핑) 회차에만 뜬다. id 1 = wh 라
            # Continue·Latest Episode 카드가 둘 다 id 1 을 그려 한 번에 같이 검증되고, id 2/3(비-wh)
            # 행엔 없어야 한다. 클릭은 aep-open-video 플래그(aep-open-script 와 같은 일회용 세션플래그
            # 관례)만 심는지 확인 — 카드는 preventDefault 로 실제 네비를 막고, 행 버튼(.ep-video)은
            # 자체적으로 location.hash 를 세팅하지만 이 하니스엔 라우터가 없어 무해하다.
            tl_video_cont = bool(pg.query_selector(".cont-video"))
            tl_video_feat = bool(pg.query_selector(".feat-video"))
            tl_video_row_wh = bool(pg.query_selector('.ep-row[data-id="1"] .ep-video'))
            tl_video_row_non_wh = (pg.query_selector('.ep-row[data-id="2"] .ep-video') is None
                                    and pg.query_selector('.ep-row[data-id="3"] .ep-video') is None)
            tl_video_flag = None
            if pg.query_selector(".cont-video"):
                pg.eval_on_selector(".cont-video", "el=>{el.addEventListener('click',e=>e.preventDefault(),{once:true}); el.click();}")
                tl_video_flag = pg.evaluate("sessionStorage.getItem('aep-open-video')")
            tl_video_row_flag = None
            if pg.query_selector('.ep-row[data-id="1"] .ep-video'):
                pg.evaluate("sessionStorage.removeItem('aep-open-video')")
                pg.eval_on_selector('.ep-row[data-id="1"] .ep-video', "el=>el.click()")
                tl_video_row_flag = pg.evaluate("sessionStorage.getItem('aep-open-video')")
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
            print("TIMELINE-VIDEO: cont=", tl_video_cont, " feat=", tl_video_feat, " row_wh=", tl_video_row_wh,
                  " row_non_wh_absent=", tl_video_row_non_wh, " cont_flag=", tl_video_flag,
                  " row_flag=", tl_video_row_flag)
            timeline_ok = (tl_feat == 1 and tl_rows >= 3 and tl_hero == 1 and tl_featplay
                           and tl_cont and tl_contplay is True and tl_script_flag == "1"
                           and tl_seasons >= 2 and tl_first_open is True and tl_has_collapsed is True
                           and tl_progress is True and tl_done is True and tl_compact is True
                           and tl_search == 1 and tl_clear_collapsed is True
                           and tl_no_pan and not tl_err
                           and tl_video_cont and tl_video_feat and tl_video_row_wh
                           and tl_video_row_non_wh and tl_video_flag == "1" and tl_video_row_flag == "1")

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

            # === 라우터 (v1.45.7 — app.js 를 실제로 태우는 첫 하니스) ===
            # 검증 대상: 콜드 딥링크 뒤로가기 폴백(#20) · 404 크롬 초기화(#25) ·
            # 새로고침을 건너뛰는 경로의 정직한 토스트(#26) · 활성 탭 재탭 맨위로(#23).
            pg.goto("http://localhost:8123/_harness_router.html#/episode/1")
            pg.wait_for_function("(window.__renders||[]).length>0", timeout=10000)
            rt_deep = pg.evaluate("window.__renders[0]")            # ['episode','1'] 로 콜드 진입
            rt_back_shown = pg.eval_on_selector("#back-btn", "el=>!el.hidden")
            # #26: 에피소드에서 ↻ 는 실제로 아무것도 새로 받지 않는다 → 문구가 사실이어야 한다
            # ⚠ 이 하니스는 http://localhost 에서 돌아 app.js 의 'Browser voice over http…' 토스트가
            # 부팅 1.6초 뒤 반드시 뜬다. #toast 는 단일 슬롯이라 '비어있지 않음'을 기다리면 그 토스트를
            # 잡거나 확인 직전에 덮여 간헐 실패한다 → 먼저 지나가게 두고, 기대 문구와 '같아질 때'까지 기다린다.
            time.sleep(2.2)
            # 'online' 재라우팅 가드(2026-08-27): 에피소드 화면에선 브라우저 'online'(차에서 LTE↔WiFi 전환)이
            # route() 를 다시 돌리면 안 된다 — hashchange 없는 재렌더는 시트를 중복 생성하고 자동추적이 옛
            # 시트를 스크롤한다(refreshData 가 막아 둔 버그헌트 #1 을 'online' 핸들러가 다시 열었었다).
            # ⚠ 위 2.2초 뒤에 재야 한다: 이 페이지가 이 실행에서 실제 app.js 를 처음 띄우는 곳이라 그 사이
            # SW 설치 → controllerchange → reload 가 일어나고, 그 전에 evaluate 하면 컨텍스트가 죽는다.
            rt_n0 = pg.evaluate("window.__renders.length")
            pg.evaluate("window.dispatchEvent(new Event('online'))"); time.sleep(0.5)
            rt_online_ep = pg.evaluate("window.__renders.length") - rt_n0       # 기대 0
            pg.click("#sync-btn")
            try:
                pg.wait_for_function(
                    "() => { const t = document.getElementById('toast');"
                    " return t && t.textContent.trim() === 'Nothing to refresh here'; }", timeout=8000)
            except Exception:
                pass
            rt_toast_ep = pg.eval_on_selector("#toast", "el=>el.textContent.trim()") if pg.query_selector("#toast") else None
            # #20: 앱 내 이동이 없었던 콜드 딥링크 → 뒤로가기가 앱을 벗어나지 않고 라이브러리로
            pg.click("#back-btn"); time.sleep(0.5)
            rt_back_hash = pg.evaluate("location.hash")
            rt_still_alive = pg.evaluate("!!document.getElementById('tabbar')")
            # 반대로 라이브러리에선 'online' 이 목록을 다시 받아야 한다(스켈레톤/빈 목록 자동 회복) — 가드가
            # 너무 넓어져 회복 경로까지 막히면 안 된다.
            rt_n1 = pg.evaluate("window.__renders.length")
            pg.evaluate("window.dispatchEvent(new Event('online'))"); time.sleep(0.5)
            rt_online_lib = pg.evaluate("window.__renders.length") - rt_n1      # 기대 1
            # #25: 404 는 뒤로가기 버튼·탭 강조·제목을 초기화해야 한다
            pg.evaluate("location.hash='#/episode/1'"); time.sleep(0.4)
            pg.evaluate("location.hash='#/nope'"); time.sleep(0.4)
            rt_404_back = pg.eval_on_selector("#back-btn", "el=>el.hidden")
            rt_404_tabs = pg.eval_on_selector_all("#tabbar a", "els=>els.filter(a=>a.hasAttribute('aria-current')).length")
            rt_404_title = pg.eval_on_selector("#page-title", "el=>el.textContent")
            # #23: 이미 활성인 탭 재탭 → 맨 위로
            pg.evaluate("location.hash='#/'"); time.sleep(0.4)
            # ⚠ 스크롤 컨테이너는 window 가 아니라 body 다(html/body 의 overflow-x:hidden 이 세로축을
            # auto 로 승격 → body 가 자체 스크롤 박스). 실측: bodyScrollH 2600 vs htmlScrollH 844.
            pg.evaluate("document.body.scrollTop = 900"); time.sleep(0.2)
            rt_scroll_before = pg.evaluate("document.body.scrollTop")
            pg.eval_on_selector('#tabbar a[data-tab="timeline"]', "el=>el.click()"); time.sleep(1.0)
            rt_scroll_after = pg.evaluate("document.body.scrollTop")
            rt_err = pg.evaluate("window.__err||[]")
            router_ok = (isinstance(rt_deep, list) and rt_deep[0] == "episode"
                         and rt_back_shown is True
                         and rt_toast_ep == "Nothing to refresh here"
                         and rt_back_hash == "#/" and rt_still_alive is True
                         and rt_404_back is True and rt_404_tabs == 0 and rt_404_title == "E-Podcast"
                         and rt_scroll_before > 100 and rt_scroll_after == 0
                         and rt_online_ep == 0 and rt_online_lib == 1
                         and not rt_err)
            print("ROUTER: deep=", rt_deep, " back_shown=", rt_back_shown, " sync_toast=", repr(rt_toast_ep),
                  " back_hash=", rt_back_hash, " alive=", rt_still_alive,
                  " 404[back_hidden=", rt_404_back, " tabs_lit=", rt_404_tabs, " title=", repr(rt_404_title), "]",
                  " scroll", rt_scroll_before, "->", rt_scroll_after,
                  " online_rerender[episode=", rt_online_ep, " library=", rt_online_lib, "]", " err=", rt_err, " ok=", router_ok)

            # === 📺 Library→Video 진입 체인 풀-통합 재현 (사용자 실기기 신고, v1.58.0) ==============
            # 위 라우터 검증과 달리 뷰를 전혀 스텁하지 않는다 — 진짜 timeline.js 카드의 진짜 <a> 를
            # Playwright 로 실제 클릭(isTrusted, 기본 네비게이션 포함)해 실기기 경로를 최대한 그대로
            # 재현한다. episode 하니스(위 LIBRARY-VIDEO-DEEPLINK) 의 손으로 짠 미니 라우터 재현은
            # 통과했다 — real app.js::route() + real timeline.js 조합에서만 나타나는 차이가 있는지 확인.
            errs.clear()
            pg.goto("http://localhost:8123/_harness_realvideo.html")
            pg.wait_for_selector(".feat-video", timeout=10000)
            time.sleep(0.3)
            pg.click(".feat-video")
            try:
                pg.wait_for_function(
                    "document.getElementById('tx-video-toggle') && "
                    "document.getElementById('tx-video-toggle').getAttribute('aria-pressed')==='true'",
                    timeout=5000)
            except Exception:
                pass
            time.sleep(0.3)
            rv_hash = pg.evaluate("location.hash")
            rv_sheet_open = pg.eval_on_selector(".tx-sheet", "el=>el.classList.contains('open')") if pg.query_selector(".tx-sheet") else False
            rv_toggle_pressed = pg.eval_on_selector("#tx-video-toggle", "el=>el.getAttribute('aria-pressed')") if pg.query_selector("#tx-video-toggle") else None
            rv_toggle_on = pg.eval_on_selector("#tx-video-toggle", "el=>el.classList.contains('on')") if pg.query_selector("#tx-video-toggle") else None
            rv_wrap_visible = pg.eval_on_selector("#tx-video-wrap", "el=>el.hidden===false") if pg.query_selector("#tx-video-wrap") else None
            rv_yt_mounted = pg.evaluate("(window.__ytMounts||[]).length")
            rv_sheets_count = pg.eval_on_selector_all(".tx-sheet", "els=>els.length")
            # 브라우저 'online'(차에서 LTE↔WiFi 전환)이 에피소드 화면에서 route() 를 다시 돌리면 hashchange 가
            # 없어 옛 시트가 body 에 남고, '첫 번째 .tx-scroll' 을 잡던 자동추적이 그 옛 시트를 스크롤했다
            # (사용자 신고 2026-08-27 "싱크위치로 안 감" — 하이라이트는 움직이는데 화면만 안 따라감).
            # 실측: 'online' 1회 → 시트 2개, 같은 재생 구간 scrollTop 0→139 가 0→0. 여기서 그 트리거를 그대로
            # 쏘고 시트가 여전히 하나인지 본다(app.js canReroute 가드 + episode.js _teardown 두 겹 모두 검증).
            pg.evaluate("window.dispatchEvent(new Event('online'))"); time.sleep(0.8)
            rv_sheets_after_online = pg.eval_on_selector_all(".tx-sheet", "els=>els.length")
            rv_err = pg.evaluate("window.__err||[]")
            print("REALVIDEO: hash=", rv_hash, " sheet_open=", rv_sheet_open,
                  " toggle_pressed=", rv_toggle_pressed, " toggle_on=", rv_toggle_on, " wrap_visible=", rv_wrap_visible,
                  " yt_mounted=", rv_yt_mounted, " sheets_count=", rv_sheets_count,
                  " sheets_after_online=", rv_sheets_after_online, " err=", rv_err, " console=", errs)
            realvideo_ok = (rv_sheet_open is True and rv_toggle_pressed == "true" and rv_toggle_on is True
                            and rv_wrap_visible is True and rv_yt_mounted == 1 and rv_sheets_count == 1
                            and rv_sheets_after_online == 1)

            # === 진짜 근본원인 재현: YouTube IFrame API 스크립트가 안 뜨면(광고차단기·방화벽·일시
            # 네트워크 실패) video.js::loadApi() 가 예전엔 영원히 pending — turnVideoOn() 이 그 안에서
            # 통째로 멈추고(toast 도 console 도 0), '시트는 열리는데 영상만 안 켜짐' 이 실기기 신고와
            # 정확히 일치했다(scripts/_pwtest.py 밖에서 이 route()-abort 로 직접 재현·확인함).
            # ?noyt=1 로 스텁을 빼고 real <script src=iframe_api> 요청 자체를 막아, 고친 loadApi() 가
            # ① onerror 로 제때 reject 해 기존 catch(toast+상태복구)가 실제로 도는지, ② 실패한
            # _apiPromise 를 계속 붙들지 않고 지워서 다음 시도가 재시도될 수 있는지(네트워크 복구 후
            # 다시 켜면 성공) 를 검증한다.
            pg.route("**/www.youtube.com/iframe_api", lambda route: route.abort())
            pg.goto("http://localhost:8123/_harness_realvideo.html?noyt=1")
            pg.wait_for_selector(".feat-video", timeout=10000)
            time.sleep(0.3)
            pg.click(".feat-video")
            try:
                pg.wait_for_function(
                    "() => { const t = document.getElementById('toast');"
                    " return t && /Could not load video/.test(t.textContent); }", timeout=5000)
            except Exception:
                pass
            time.sleep(0.2)
            fail_toast = pg.evaluate(
                "() => { const t = document.getElementById('toast');"
                " return !!(t && /Could not load video/.test(t.textContent)); }")
            fail_wrap_hidden = pg.eval_on_selector("#tx-video-wrap", "el=>el.hidden") if pg.query_selector("#tx-video-wrap") else None
            fail_toggle_pressed = pg.eval_on_selector("#tx-video-toggle", "el=>el.getAttribute('aria-pressed')") if pg.query_selector("#tx-video-toggle") else None
            fail_console_warned = any("mount failed" in e for e in errs)
            print("REALVIDEO-YT-BLOCKED: toast=", fail_toast, " wrap_hidden=", fail_wrap_hidden,
                  " toggle_pressed=", fail_toggle_pressed, " console_had_mount_failed=", fail_console_warned)
            # 네트워크가 회복됐다고 가정: 차단을 풀고 real API 대신 스텁을 심어(이 문서엔 처음부터 스텁이
            # 없었으므로 지금 주입) 재시도가 실제로 성공하는지 — _apiPromise 가 실패를 영구 캐시하지
            # 않았어야 이게 통과한다.
            pg.unroute("**/www.youtube.com/iframe_api")
            pg.evaluate("""() => {
              window.__ytMounts = [];
              window.YT = { Player: function (el, opts) {
                const self = { _t: 0 };
                window.__ytMounts.push({ el, videoId: opts.videoId });
                self.playVideo = () => {}; self.pauseVideo = () => {}; self.seekTo = (t) => { self._t = t; };
                self.getCurrentTime = () => self._t; self.getDuration = () => 1274;
                self.setPlaybackRate = () => {}; self.destroy = () => {};
                setTimeout(() => opts.events.onReady(), 10);
                return self;
              } };
              // window.onYouTubeIframeAPIReady 가 이미 이전 시도(reject 이전)에 등록돼 있었을 수 있으니
              // 그대로 둬도 무해 — loadApi() 는 window.YT 가 이미 있으면 <script> 를 아예 다시 안 쏜다.
            }""")
            if pg.query_selector("#tx-video-toggle"):
                pg.eval_on_selector("#tx-video-toggle", "el=>el.click()")
            try:
                pg.wait_for_function(
                    "document.getElementById('tx-video-toggle') && "
                    "document.getElementById('tx-video-toggle').getAttribute('aria-pressed')==='true'",
                    timeout=5000)
            except Exception:
                pass
            time.sleep(0.2)
            retry_pressed = pg.eval_on_selector("#tx-video-toggle", "el=>el.getAttribute('aria-pressed')") if pg.query_selector("#tx-video-toggle") else None
            retry_mounted = pg.evaluate("(window.__ytMounts||[]).length")
            print("REALVIDEO-YT-RETRY-AFTER-RECOVERY: toggle_pressed=", retry_pressed, " mounted=", retry_mounted)
            ytblocked_ok = (fail_toast is True and fail_wrap_hidden is True and fail_toggle_pressed == "false"
                            and retry_pressed == "true" and retry_mounted == 1)

            # === CACHE-REGRESSION: ui/db.js::fetchTranscript() 이 제자리 패치(같은 URL, 다른 내용)를
            # 실제로 다시 받아 오는지 (v1.59.0 실기기 버그, 2026-08-07 수정) ============================
            # scripts/wh_backfill_video_ids.py 는 기존 transcript JSON 에 video_id 를 in-place 로
            # 패치하면서 transcribed_at(=URL 버전키) 은 일부러 안 건드린다 — 즉 '같은 URL, 다른 바디'가
            # 실제로 일어난다. force-cache 였을 때(고친 버그)는 첫 fetch 가 브라우저 HTTP 캐시에 항목을
            # 남기면, no-cache 오리진 헤더와 무관하게 두 번째 fetch 가 신선도 확인도 네트워크 왕복도
            # 없이 그 캐시를 그대로 돌려줬다 — 여기서 같은 URL 에 다른 바디를 두 번 서빙해 재현하고,
            # 두 번째 getEpisode() 가 새 내용(video_id)을 보는지 + 실제로 두 번 다 네트워크(라우트)를
            # 탔는지(=캐시로 조용히 짧게 끝나지 않았는지) 함께 단언한다. `cache-control: no-cache` 는
            # 실측(curl) 으로 확인한 실제 Storage 오리진 응답 헤더를 그대로 재현한 것.
            dbcache_hits = {"transcript": 0}
            TRANSCRIPT_BODIES = [
                {"language": "en", "duration": 100, "segments": []},                              # 최초: video_id 없음
                {"language": "en", "duration": 100, "segments": [], "video_id": "PATCHED-BY-BACKFILL"},  # 백필 후 제자리 패치
            ]

            def _dbcache_route(route):
                url = route.request.url
                path = url.split("?")[0]
                if path.endswith("audio_hosted.json"):
                    route.fulfill(status=200, content_type="application/json", body="[]")
                elif path.endswith("_ko.json"):
                    route.fulfill(status=200, content_type="application/json", body="{}")
                elif "/transcripts/" in path and path.endswith(".json"):
                    i = min(dbcache_hits["transcript"], len(TRANSCRIPT_BODIES) - 1)
                    dbcache_hits["transcript"] += 1
                    route.fulfill(status=200, content_type="application/json",
                                  headers={"cache-control": "no-cache", "etag": f'"v{i}"'},
                                  body=json.dumps(TRANSCRIPT_BODIES[i]))
                else:
                    route.fulfill(status=404, body="not found")

            pg2 = b.new_page()
            pg2.route("**/storage/v1/object/public/**", _dbcache_route)
            pg2.goto("http://localhost:8123/_harness_dbcache.html")
            pg2.wait_for_function("window.__ready===true", timeout=10000)
            pg2.evaluate("""() => window.__setEpisodeRow({
              id: 999, title: 'Cache Regression', season: 1, episode_no: 1, pub_date: '2026-01-01',
              duration_sec: 100, audio_url: 'https://traffic.megaphone.fm/ABC.mp3',
              transcribed_at: '2026-01-01', show: 'wh', guid: 'cache-regression-test',
              description: '', vocab: [],
            })""")
            ep1 = pg2.evaluate("async () => await window.__getEpisode(999)")
            ep2 = pg2.evaluate("async () => await window.__getEpisode(999)")
            vid1 = ((ep1 or {}).get("transcript") or {}).get("video_id")
            vid2 = ((ep2 or {}).get("transcript") or {}).get("video_id")
            print("CACHE-REGRESSION: 1st video_id=", vid1, " 2nd video_id=", vid2,
                  " transcript_fetch_hits=", dbcache_hits["transcript"])
            dbcache_ok = (vid1 is None and vid2 == "PATCHED-BY-BACKFILL"
                          and dbcache_hits["transcript"] == 2)
            pg2.close()

            # === 🔁 반복 되감기 앵커 — 문단 길이 전 구간 스윕 (LOOP-HEAD-ANCHOR) ===
            # 사용자 신고 2026-08-10: "문단을 읽고 다시 그 문단의 처음으로 돌아올라갈 때, 문장이
            # 길면 반복횟수 배지가 화면에서 사라지고 짧으면 다시 보인다 — 들쭉날쭉."
            # 요구사항 그대로 검증한다: 문단 길이를 전 구간(3단어 … 26단어) 훑으면서 매 되감기마다
            #  ① 배지가 화면 안에 있고 ② '항상 같은 높이'에 오고 ③ 그 바로 밑에 문단 첫 문장이 보이는가.
            # 두 레이아웃에서 돌린다 — 오디오 모드(스크롤 영역이 큼) + 영상 모드·최대 글자크기
            # (문단이 스크롤 영역보다 확실히 길어지는 조건 = 예전에 배지가 잘려 나가던 조건).
            LOOP_GAP = 26      # episode.js::LOOP_HEAD_GAP 과 같은 값(상단 mask 페이드 22px 바깥)

            def _settle_any(page, max_wait=3.0):
                prev, stable, waited = None, 0, 0.0
                while waited < max_wait:
                    cur = page.evaluate("() => { const s=document.querySelector('.tx-sheet.open .tx-scroll');"
                                        " return s ? Math.round(s.scrollTop) : -1; }")
                    stable = stable + 1 if cur == prev else 0
                    if stable >= 2:
                        return
                    prev = cur
                    time.sleep(0.1); waited += 0.1

            MEASURE_JS = """() => {
              const sheet = document.querySelector('.tx-sheet.open');
              const sc = sheet && sheet.querySelector('.tx-scroll');
              const badge = sheet && sheet.querySelector('.tx-loop-badge');
              if (!sc || !badge) return { badge: false };
              const pEl = badge.closest('.tx-para');
              const first = pEl && pEl.querySelector('.tx-sent');
              if (!pEl || !first) return { badge: false };
              const c = sc.getBoundingClientRect(), b = badge.getBoundingClientRect();
              const p = pEl.getBoundingClientRect(), f = first.getBoundingClientRect();
              return {
                badge: true,
                pIdx: [...sc.querySelectorAll('.tx-para')].indexOf(pEl),
                paraH: Math.round(p.height), viewH: Math.round(sc.clientHeight),
                badgeTop: Math.round(b.top - c.top), badgeBot: Math.round(b.bottom - c.top),
                // 배지가 스크롤 영역 안에 '온전히' 들어와 있는가(위로 잘리는 게 원래 증상).
                badgeInside: b.top >= c.top - 0.5 && b.bottom <= c.bottom + 0.5,
                absHead: Math.round(b.top - c.top + sc.scrollTop), scrollTop: Math.round(sc.scrollTop),
                firstTop: Math.round(f.top - c.top),
                firstVisible: f.top >= c.top - 1 && f.top < c.bottom - 4,
                atMaxScroll: Math.round(sc.scrollTop) >= Math.round(sc.scrollHeight - sc.clientHeight) - 1,
                text: first.textContent.trim().slice(0, 26),
              };
            }"""

            loop_errs = []   # ep_ok 는 이 블록보다 앞에서 계산되므로 errs 에 넣으면 아무도 안 본다.

            def _loop_sweep(video_mode, scale):
                page = b.new_page()
                page.on("pageerror", lambda e: loop_errs.append("LOOPPAGE: " + str(e)))
                page.on("console", lambda m: loop_errs.append(f"LOOPPAGE {m.type}: {m.text}")
                        if m.type == "error" else None)
                page.add_init_script("try{localStorage.setItem('aep-tx-scale','%s')}catch(e){}" % scale)
                page.route("**/api.mymemory.translated.net/**", _mm)
                page.set_viewport_size({"width": 390, "height": 780})
                page.goto("http://localhost:8123/_harness.html?fx=loop")
                page.wait_for_function("window.__ready===true", timeout=10000)
                page.click("#np-tx-btn"); time.sleep(0.4)
                if video_mode and page.query_selector("#tx-video-toggle"):
                    page.eval_on_selector("#tx-video-toggle", "el=>el.click()"); time.sleep(0.4)
                # KR 패널은 켠 상태로 — safeBottom/usable 이 개입하는(예전에 규칙이 갈리던) 조건이다.
                if page.eval_on_selector("#tx-trans", "el=>el.getAttribute('aria-pressed')") != "true":
                    page.click("#tx-trans"); time.sleep(0.2)
                page.click("#tx-shadow"); time.sleep(0.2)      # off → 3× Smart
                meta = page.evaluate("""() => {
                  const sc = document.querySelector('.tx-sheet.open .tx-scroll');
                  return [...sc.querySelectorAll('.tx-para')].map((p) => {
                    const ss = [...p.querySelectorAll('.tx-sent')];
                    return { n: ss.length, starts: ss.map((s) => parseFloat(s.dataset.start)),
                             end: parseFloat(ss[ss.length - 1].dataset.end) };
                  });
                }""")
                rows = []
                for p, m in enumerate(meta):
                    # ① 반복 대상을 이 문단으로 옮긴다. 문단 사이 3s 공백이 loopEnd+1.5s 임계를 넘겨
                    #    confirmLoopBoundary 가 '지금 위치의 문단'으로 재지정한다(앞으로 시크 규약).
                    page.evaluate("t => window.__player.seek(t)", m["starts"][0] + 0.2)
                    time.sleep(0.05)
                    # ② 문단을 끝까지 '읽는다' — 화면이 문장을 따라 아래로 내려가는 실제 상태 재현.
                    for st in m["starts"]:
                        page.evaluate("t => window.__player.seek(t)", st + 0.25)
                        time.sleep(0.05)
                    _settle_any(page)
                    # ③ 문단 끝 도달 → 되감기(여기가 사용자가 말한 '문단 처음으로 돌아올라갈 때').
                    page.evaluate("t => window.__player.seek(t)", m["end"] + 0.3)
                    time.sleep(0.1); _settle_any(page)
                    r = page.evaluate(MEASURE_JS)
                    r["want"] = p
                    rows.append(r)
                page.close()
                return rows

            loop_rows_audio = _loop_sweep(video_mode=False, scale="1.0")
            loop_rows_video = _loop_sweep(video_mode=True, scale="1.5")
            loop_ok = True
            for tag, rows in (("audio/1.0", loop_rows_audio), ("video/1.5", loop_rows_video)):
                print(f"LOOP-HEAD-ANCHOR [{tag}]:")
                for r in rows:
                    print("   ", r)
                tops = [r.get("badgeTop") for r in rows if r.get("badge")]
                # 세 가지를 본다. '일정한 위치'가 요구사항의 핵심이라 spread 를 직접 단언한다.
                per_row = all(
                    r.get("badge") is True and r.get("pIdx") == r["want"]
                    and r.get("badgeInside") is True
                    and abs((r.get("badgeTop") or 0) - LOOP_GAP) <= 2
                    and r.get("firstVisible") is True
                    and (r.get("firstTop") or 0) >= (r.get("badgeTop") or 0)
                    for r in rows)
                spread = (max(tops) - min(tops)) if tops else 999
                # 픽스처가 실제로 '전 구간'을 덮었는지도 확인한다 — 짧은 문단만 돌고 통과하면
                # 이 테스트는 원래 버그를 못 잡는다(긴 문단에서만 나던 증상이었다).
                heights = [r.get("paraH") or 0 for r in rows]
                view = rows[0].get("viewH") or 1
                covered = len(rows) >= 6 and min(heights) < view * 0.25 and max(heights) > view * 0.6
                print(f"    spread={spread}px  paraH={min(heights)}..{max(heights)} viewH={view}"
                      f"  per_row={per_row} covered={covered}")
                loop_ok = loop_ok and per_row and spread <= 2 and covered
            if loop_errs:
                print("LOOP-PAGE-ERRORS:", loop_errs[:6])
            loop_ok = loop_ok and not loop_errs

            # 실패 시 어느 묶음인지 바로 보이게 한다 — 예전엔 RESULT: FAIL 만 나와서 큰 논리곱을
            # 사람이 눈으로 되짚어야 했다(2026-08-10: 이것 때문에 한참 헤맸다).
            _groups = {"ep": ep_ok, "study": study_ok, "timeline": timeline_ok, "settings": settings_ok,
                       "srs": srs_ok, "router": router_ok, "realvideo": realvideo_ok,
                       "ytblocked": ytblocked_ok, "dbcache": dbcache_ok, "loopanchor": loop_ok}
            print("GROUPS-FAILED:", [k for k, v in _groups.items() if not v] or "none")
            ok = all(_groups.values())
            b.close()
    finally:
        srv.terminate()
        MOCKS.unlink(missing_ok=True)
        HARNESS.unlink(missing_ok=True)
        STUDY_HARNESS.unlink(missing_ok=True)
        TIMELINE_HARNESS.unlink(missing_ok=True)
        SRS_HARNESS.unlink(missing_ok=True)
        ROUTER_MOCK.unlink(missing_ok=True)
        ROUTER_HARNESS.unlink(missing_ok=True)
        REALVIDEO_MOCK.unlink(missing_ok=True)
        REALVIDEO_HARNESS.unlink(missing_ok=True)
        SETTINGS_HARNESS.unlink(missing_ok=True)
        OFFLINE_MOCK.unlink(missing_ok=True)
        DBCACHE_MOCK.unlink(missing_ok=True)
        DBCACHE_HARNESS.unlink(missing_ok=True)
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
