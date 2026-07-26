// Now Playing — large cover, scrubber, transport, transcript + vocab below.
import { escapeHtml, fmtTime, fmtDate, fmtDuration, toast } from '/app.js';
import { getEpisode, episodeNav, markKnown } from '/db.js';
import { speak, prefetch } from '/tts.js';
import { player, getProgress } from '/player.js';
import { showCover, currentShow, showMeta } from '/config.js';
import { translateEnKo } from '/translate.js';
import { bindScrub } from '/scrub.js';
import { addShadowReps } from '/proficiency.js';
import { initDriveCapture, setDrive, driveOn } from '/marks.js';

// 현재 쇼 커버(렌더 시 평가) — 멀티-쇼에서 에피소드가 속한 쇼의 아트워크를 보여준다.
// (라이브러리가 현재 쇼만 노출하므로 열람 중 에피소드 = currentShow). 정적 SHOW_COVER 대체.
const COVER = () => showCover(currentShow()) + '&w=720&h=720';
const COVER_SM = () => showCover(currentShow()) + '&w=160&h=160';

const SVG_PLAY  = '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';
const SVG_PAUSE = '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const SVG_MINI_PLAY  = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';
const SVG_MINI_PAUSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const SVG_BACK15 = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
const SVG_FWD30 = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';
// ⏮/⏭ 트랙(에피소드) 이동 아이콘 — 트랜스크립트 시트의 ⏮/⏭ 과 동일 글리프(메인 화면용 28px).
const SVG_PREV_TRACK = '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M7 6h2.2v12H7zM19 6v12l-8.5-6z"/></svg>';
const SVG_NEXT_TRACK = '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M14.8 6H17v12h-2.2zM5 6l8.5 6L5 18z"/></svg>';
// 운전 캡처 칩 글리프 — END_MODES 와 동일하게 currentColor 단색(컬러 이모지 사각박스 회피).
const SVG_CAR = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11l1.4-4.2A2 2 0 0 1 8.3 5.5h7.4a2 2 0 0 1 1.9 1.3L19 11"/><path d="M4 11h16a1 1 0 0 1 1 1v4h-2.2M3 16V12a1 1 0 0 1 1-1"/><circle cx="7.5" cy="16.5" r="1.7"/><circle cx="16.5" cy="16.5" r="1.7"/><path d="M9.2 16.5h5.6"/></svg>';

// 1× 에서 탭마다 1.25 → 1.5 → 0.5 → 0.75 → 1.0 → 1.25 … 순환 (사용자 지정 순서)
const SPEEDS = [1, 1.25, 1.5, 0.5, 0.75];

export async function renderEpisode(root, idStr, tStr) {
  const id = parseInt(idStr, 10);
  // 스테일 렌더 방지: 느린 네트워크에서 getEpisode 를 기다리는 사이 사용자가 다른 화면으로
  // 이동(뒤로가기·다른 회차)했다면, 이 늦은 렌더가 현재 화면을 덮어쓰지 않게 즉시 중단한다.
  // 진입 시점 해시를 저장했다 await 후 바뀌었으면 중단(router 는 빠른 해시 변경 시 핸들러를 동시
  // 실행할 수 있음 — 열린 시트/미니플레이어가 어긋나던 문제). 해시 없이 직접 호출하는 하니스는
  // 해시가 안 바뀌므로 정상 진행된다.
  const _startHash = location.hash;
  const ep = await getEpisode(id);
  if (location.hash !== _startHash) return;
  document.body.classList.add('on-episode');
  // Safeguard: even if we early-return below, ensure the class is removed on nav away.
  // 단, 다른 '회차'로 이동 중이면 on-episode 를 유지(미니플레이어가 잠깐 보였다 사라지는 깜빡임 방지).
  window.addEventListener('hashchange', () => {
    if (!/^#?\/episode\/\d+/.test(location.hash)) document.body.classList.remove('on-episode');
  }, { once: true });

  const vknown = loadVKnown();   // '알아요' 로컬 마크 (vocabHtml + 아래 배선 공용)
  const segments = ep.transcript?.segments || [];
  const sentences = resegment(segments);  // Whisper segment → 구두점 기준 진짜 문장
  const vocabs = ep.vocab || [];

  const showLabel = `S${ep.season ?? '–'}${ep.episode_no != null ? ` · E${ep.episode_no}` : ''} · ${fmtDate(ep.pub_date)}`;
  const txTitle = (ep.title || '').replace(/^\d+\s*[-:.]\s*/, '');

  root.innerHTML = `
    <div class="np-wrap">
      <div class="np-cover-wrap">
        <div class="np-glow" style="background-image:url('${COVER()}')"></div>
        <img class="np-cover" src="${COVER()}" alt="" onerror="this.src='/icons/icon-512.png'" />
      </div>
      <div class="np-meta">
        <div class="np-show">${escapeHtml(showLabel)}</div>
        <h1 class="np-title">${escapeHtml((ep.title || '').replace(/^\d+\s*[-:.]\s*/, ''))}</h1>
        <p class="np-subtitle">${escapeHtml(showMeta(currentShow()).name)}${ep.duration_sec ? ` · ${escapeHtml(fmtDuration(ep.duration_sec))}` : ''}</p>
      </div>
      ${ep.audio_url ? `
        <div class="np-scrubber">
          <input id="np-scrub" type="range" min="0" max="100" step="0.1" value="0" aria-label="탐색" aria-valuetext="0:00" />
          <div class="np-times">
            <span id="np-cur">0:00</span>
            <span id="np-rem">-0:00</span>
          </div>
        </div>
        <div class="np-controls">
          <button class="np-ctrl-btn" id="np-prev" aria-label="Restart / previous episode">${SVG_PREV_TRACK}</button>
          <button class="np-ctrl-btn" id="np-back" aria-label="Back 15s">${SVG_BACK15}<span class="skip-num">15</span></button>
          <button class="np-play-btn" id="np-play" aria-label="Play/Pause">${SVG_PLAY}</button>
          <button class="np-ctrl-btn" id="np-fwd" aria-label="Forward 30s">${SVG_FWD30}<span class="skip-num">30</span></button>
          <button class="np-ctrl-btn" id="np-next" aria-label="Next episode">${SVG_NEXT_TRACK}</button>
        </div>
        <div class="np-extras">
          <button class="speed" id="np-speed">1×</button>
          <button class="speed np-end-btn" id="np-endmode" aria-label="After the episode ends"></button>
          ${sentences.length ? `
          <button class="np-tx-btn" id="np-tx-btn" aria-label="Transcript">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>
            <span>Transcript</span>
          </button>
          ` : ''}
        </div>
      ` : `<div class="empty">audio not downloaded yet</div>`}
    </div>

    ${ep.description ? `
      <div class="np-about">
        <div class="section-h"><h2>About</h2></div>
        <p class="np-about-text" id="np-about-text">${escapeHtml(stripTags(ep.description))}</p>
        <button class="np-about-toggle" id="np-about-toggle" hidden aria-expanded="false">더보기</button>
      </div>
    ` : ''}

    ${(ep.show === 'wh' && ep.guid) ? `
      <a class="np-wh-video" href="https://www.whitehouse.gov/videos/${encodeURIComponent(ep.guid)}/" target="_blank" rel="noopener noreferrer">
        <span class="np-wh-video-ico">📺</span>
        <span class="np-wh-video-txt"><b>Watch the full video</b><span>whitehouse.gov · 오디오는 이 앱에서 쉐도잉</span></span>
        <span class="np-wh-video-go">↗</span>
      </a>
    ` : ''}

    ${vocabs.length ? `
      <div class="section-h"><h2>Vocabulary</h2><span class="count">${vocabs.length}</span></div>
      <ul class="vocab-list">
        ${vocabs.map((v) => vocabHtml(v, vknown)).join('')}
      </ul>
    ` : ''}

    ${!sentences.length && !ep.transcribed_at ? `<div class="empty">transcript pending</div>` : ''}
  `;

  // Build transcript sheet (overlay) and attach to body — not inline.
  // Sheet must be in DOM BEFORE player wiring queries .tx-scroll/.tx-sent below.
  // Wrapped in try/catch so a broken transcript can't kill audio playback.
  let $sheet = null;
  if (sentences.length) {
    try {
      const wrap = document.createElement('div');
      // r2_audio===true 회차만 완벽 자동싱크(자막≡서빙오디오). 아니면 광고 뒤 드리프트 가능 → 안내 바.
      const perfectSync = ep.transcript?.r2_audio === true;
      wrap.innerHTML = transcriptSheetHtml(sentences, txTitle, showLabel, perfectSync).trim();
      $sheet = wrap.firstElementChild;
      document.body.appendChild($sheet);
    } catch (err) {
      console.error('[transcript] sheet build failed:', err);
      $sheet = null;
    }
  }

  // openSheet/closeSheet/escClose defined below, after state vars.
  let escClose = () => {};

  // About 설명 펼치기/접기 (audio 유무와 무관하게 동작하도록 early-return 앞에 둠).
  // 4줄 클램프가 실제로 넘칠 때만 '더보기' 버튼을 노출(발견성) — 텍스트 탭도 계속 동작, 라벨 동기화.
  const $about = document.getElementById('np-about-text');
  const $aboutToggle = document.getElementById('np-about-toggle');
  if ($about && $aboutToggle) {
    const overflowing = $about.scrollHeight > $about.clientHeight + 4;
    if (overflowing) { $aboutToggle.hidden = false; $about.classList.add('clamped'); }
    const syncToggle = () => {
      const open = $about.classList.contains('expanded');
      $aboutToggle.textContent = open ? '접기' : '더보기';
      $aboutToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const toggle = () => { $about.classList.toggle('expanded'); syncToggle(); };
    $about.addEventListener('click', toggle);
    $aboutToggle.addEventListener('click', toggle);
  }

  // Vocab 발음(TTS)·'알아요'·prefetch 는 오디오가 필요 없다 → early-return '앞'에 배선한다.
  // (예전엔 audio 아래에 있어 오디오 미다운로드 회차에서 ▶ 발음/알아요 버튼이 죽어 있었다 — 정밀진단 수정.)
  document.querySelectorAll('.vocab-card .tts').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); speak(btn.dataset.text); });
  });
  document.querySelectorAll('.vocab-card .vocab-known').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      const card = btn.closest('.vocab-card');
      const nowKnown = !(card && card.classList.contains('vknown'));
      if (nowKnown) { vknown.add(id); markKnown(id).catch(() => {}); }   // SRS 마스터로도 반영(카드 없으면 no-op)
      else vknown.delete(id);
      saveVKnown(vknown);
      if (card) card.classList.toggle('vknown', nowKnown);
      btn.setAttribute('aria-pressed', nowKnown ? 'true' : 'false');
      btn.textContent = nowKnown ? '✓ 알아요' : '알아요';
    });
  });
  prefetch(vocabs.map((v) => v.term).filter(Boolean));

  if (!ep.audio_url) {
    return; // no playback wiring needed
  }

  // Connect to global player
  const track = {
    id: ep.id,
    title: (ep.title || '').replace(/^\d+\s*[-:.]\s*/, ''),
    show: showMeta(currentShow()).name,
    cover: COVER_SM(),
    src: ep.audio_url,
  };
  player.load(track);

  const $play  = document.getElementById('np-play');
  const $back  = document.getElementById('np-back');
  const $fwd   = document.getElementById('np-fwd');
  const $scrub = document.getElementById('np-scrub');
  let npScrubbing = false;   // 메인 재생바 드래그 중이면 refresh 가 값을 덮어쓰지 않게(#6)
  const $cur   = document.getElementById('np-cur');
  const $rem   = document.getElementById('np-rem');
  const $speed = document.getElementById('np-speed');
  // 트랜스크립트 시트 시크 바(스와이프) 요소 — 시트가 닫혀 있어도 DOM 엔 존재한다.
  const $txSeekTrack  = document.getElementById('tx-seek-track');
  const $txSeekFill   = document.getElementById('tx-seek-fill');
  const $txSeekHandle = document.getElementById('tx-seek-handle');
  const $txSeekCur    = document.getElementById('tx-seek-cur');
  const $txSeekRem    = document.getElementById('tx-seek-rem');
  let txScrub = null;
  let speedIdx = 0;
  let shadowMode = 'off';  // off | smart2(2× Smart) | smart(1× Smart) | auto5/auto10(고정 N회)
  let loopPara = -1, loopStart = 0, loopEnd = 0;  // 반복 대상 '문단'과 그 시작/끝(자막시각)
  let loopCount = 0;       // smart2/smart/auto5/auto10: 현재 문단을 몇 번 반복했는지(0~N)
  let loopTarget = 0;      // 이 문단의 목표 반복 횟수 — smart(2)는 문단마다 다름, autoN 은 고정
  let shadowIdx = 0;       // 쉐도잉 버튼 단계(off→smart2→smart→auto5→auto10 순환) — refresh 에서 종료시 리셋하려 상위 선언
  const REPEAT_OF = { auto2: 2, auto3: 3, auto5: 5, auto10: 10 };  // N× Auto: 한 문단을 N번 반복 후 다음 문단으로
  // Smart: 문단 길이(초)에 비례해 반복 횟수를 유동 결정 — 짧은 문단 5회, 긴 문단 최대 12회.
  // (v1.19.0: 3~10 → 5~12 — 사용자 요청 2026-07-10. 비율(0~20s 선형 매핑)은 유지)
  // 실측 캘리브레이션(2026-07-09, 최신 8회차 981문단): groupIntoParagraphs 가 문단을 ~16s에서 끊어
  // 분포가 0~20s(중앙값 10s) → 0~20s 에 5~12회를 선형 매핑(기본 5회 + 초당 0.35회):
  // 0~2s→5~6회, 6s→7회, 10s→9회, 16s→11회, 20s+→12회.
  const smartReps = (durSec) => Math.max(5, Math.min(12, Math.round(5 + durSec * 0.35)));
  // 2× Smart = Smart 반복의 2배(사용자 요청 2026-07-17) — 상한도 2배(최대 24회).
  const smartRepsFor = (durSec) => shadowMode === 'smart2' ? smartReps(durSec) * 2 : smartReps(durSec);
  // 반복(쉐도잉) 모드 공통 게이트 — smart2/smart/auto5/auto10 전부.
  function inRepeatMode() { return shadowMode !== 'off'; }
  let navPrevId = null, navNextId = null;  // 이전/다음 '에피소드'(곡) id — episodeNav 로 채움
  let lastPrevTap = 0;     // ⏮ 더블탭(연속 두 번) 판정용 — 처음엔 맨 앞, 빠르게 한 번 더면 이전 곡
  let followTimer = 0;     // 일시정지 중 자동추적 복귀 예약 타이머 — cleanup 에서 지우려 상위 선언(누수 방지)
  let _lastPaused = null;  // 재생/일시정지 아이콘을 '상태 변화 시에만' 재파싱(매 timeupdate innerHTML 방지)

  // 이전/다음 '에피소드' id 미리 조회 — ⏮/⏭ 버튼이 즉시 쓰도록(비동기, 실패해도 재생엔 영향 없음).
  episodeNav(ep.id).then((n) => { navPrevId = n.prevId; navNextId = n.nextId; }).catch(() => {});

  // === 싱크 (자동) ===
  // 모든 회차는 '서빙되는 R2 오디오 그 자체'로 STT(scripts/retranscribe.py --from-r2)되어
  // 자막 ≡ 스트림이 보장된다 → 클라이언트 오프셋 0(자동 싱크). 수동 보정(🎯) UI 는 제거됨.
  const syncOffset = 0;
  // HL_LAG: whisper 단어 타임스탬프가 음성보다 살짝 빨라, 하이라이트를 약간 늦게 따라오게(>0).
  const HL_LAG = 0.2;
  const txTime = () => player.time - syncOffset - HL_LAG;     // 오디오 시각 → 자막 시각
  const toAudio = (txSec) => txSec + syncOffset;              // 자막 시각 → 오디오 시각(시크용)

  // === 현재 문장 번역 항상 표시 (#8) — 무료 MyMemory API, 결과는 per-episode 캐시 ===
  // 기본 ON: 끄지 않는 한 항상 번역카드가 따라온다. 사용자가 끄면 그 선택을 기억(localStorage).
  const TRANS_KEY = 'aep-tx-trans';
  let showTrans = localStorage.getItem(TRANS_KEY) !== '0';
  const _trCache = loadTrCache(ep.id);
  const _preKo = ep.transcript_ko || {};   // trKey(문장)→ko 문맥 인지 사전번역(있으면 직역 MyMemory 대체)
  let _trSeq = 0;

  function refresh() {
    const dur = player.duration;
    if (dur) {
      if (!npScrubbing) $scrub.value = (player.time / dur * 100).toFixed(2);  // 드래그 중엔 안 덮어씀(#6)
      $scrub.setAttribute('aria-valuetext', `${fmtTime(player.time)} / ${fmtTime(dur)}`);  // 스크린리더에 시간 맥락
      $cur.textContent = fmtTime(player.time);
      $rem.textContent = '-' + fmtTime(Math.max(0, dur - player.time));
      // 트랜스크립트 시트 시크 바도 동기화 — 시트가 열려 있을 때만(닫힘 시엔 안 보이는 쓰기 낭비 방지).
      // 스크럽 드래그 중엔 미리보기 위치를 유지(덮어쓰지 않음).
      if (txScrub && !txScrub.isDragging() && $sheet && $sheet.classList.contains('open')) {
        const pct = (player.time / dur * 100).toFixed(2);
        if ($txSeekFill)   $txSeekFill.style.width = pct + '%';
        if ($txSeekHandle) $txSeekHandle.style.left = pct + '%';
        if ($txSeekCur)    $txSeekCur.textContent = fmtTime(player.time);
        if ($txSeekRem)    $txSeekRem.textContent = '-' + fmtTime(Math.max(0, dur - player.time));
      }
    }
    // 재생/일시정지 아이콘은 상태가 바뀔 때만 innerHTML 재파싱(SVG 파싱+노드 교체가 4Hz로 도는 것 방지).
    // 재생 중 시트를 열면 다음 timeupdate 에서 미니 아이콘이 즉시(≤250ms) 맞춰진다.
    if (_lastPaused !== player.paused) {
      _lastPaused = player.paused;
      $play.innerHTML = player.paused ? SVG_PLAY : SVG_PAUSE;
      const $miniPlay = document.getElementById('tx-mini-play');
      if ($miniPlay) $miniPlay.innerHTML = player.paused ? SVG_MINI_PLAY : SVG_MINI_PAUSE;
      document.querySelector('.np-wrap')?.classList.toggle('is-paused', player.paused);  // 커버 축소 모션
    }
    highlightActiveSegment();

    // 쉐도잉 반복: 누를 때 확정한 '문단'을 끝(마지막 문장)에서 처음(첫 문장)으로 되돌린다.
    //  loop  = 무한 반복.
    //  smart = 문단 길이 비례 5~15회(loopTarget, setLoopPara 가 산정) 후 다음 문단으로.
    //  auto5/auto10 = 고정 5·10회 반복 후 '다음 문단'으로 자동 이동(문단 사이 광고는 시크로 건너뜀).
    //          마지막 문단까지 끝나면 쉐도잉을 끄고 그대로 계속 재생.
    // 반복 모드가 켜졌지만 아직 대상 문단이 없을 때(에피소드 맨 앞 t=0, 또는 프리롤 광고 중 켜서
    // confirmLoopBoundary 가 문장을 못 찾은 경우): 본편 문장이 재생되기 시작하면 그 문단을 자동으로
    // 반복 대상으로 확정한다. (이게 없으면 앞부분에서 Smart·Repeat 를 켜도 끝까지 한 번도 반복 안 됨.)
    if (inRepeatMode() && loopPara < 0 && !player.paused) {
      const si0 = findActiveSentIdx(txTime());
      if (si0 >= 0 && sentRanges[si0]) setLoopPara(paraEls.indexOf(sentRanges[si0].paraEl));
    }
    if ((inRepeatMode()) && loopPara >= 0 && !player.paused) {
      if (Number.isFinite(loopEnd) && txTime() >= loopEnd - 0.06) {
        // 사용자가 반복 문단을 한참 지나쳐 '앞으로' 시크(드래그·+30s·잠금화면)한 경우: 되감지 말고
        // 지금 위치의 문단으로 반복 대상을 옮긴다. 가짜 반복 횟수(addShadowReps)도 기록하지 않는다.
        // (자연스러운 문단 끝 도달은 loopEnd 를 한 틱(≤~0.4s@1.5×)만 넘으므로 임계값 1.5s 로 구분.
        //  뒤로 시크는 되감기 자체가 뒤로 시크라 여기서 relocate 하면 안 됨 → '앞으로'만 처리.)
        if (txTime() > loopEnd + 1.5) { loopCount = 0; confirmLoopBoundary(); return; }
        addShadowReps(1);   // 한 문단 따라말하기 1회 완료 — 자동화 축 보조 신호(Study Proficiency)
        loopCount++;
        if (loopCount < (loopTarget || 5)) {
          player.seek(toAudio(loopStart) + 0.01);     // 같은 문단 반복
          updateLoopBadge();                          // 카운트다운 갱신(남은 횟수)
        } else {
          loopCount = 0;
          if (setLoopPara(loopPara + 1)) {
            player.seek(toAudio(loopStart) + 0.01);   // 다음 문단으로(광고 건너뜀)
          } else {
            endShadow();                              // 마지막 문단 → 쉐도잉 종료
          }
        }
      }
    }
  }

  // Sentence-level tracking (one per Whisper segment).
  const sentEls = Array.from(document.querySelectorAll('.tx-scroll .tx-sent'));
  const sentRanges = sentEls.map((el) => ({
    el,
    start: parseFloat(el.dataset.start),
    end: parseFloat(el.dataset.end),
    paraEl: el.closest('.tx-para'),
  }));
  const paraEls = Array.from(document.querySelectorAll('.tx-para'));

  // 광고 바(프리롤 + 미드롤/엔드롤): 각 바는 자기 시간구간[start,end) 동안 강조되고,
  // 탭하면 그 광고가 끝나는 지점(본편 재개)으로 점프한다.
  const adBars = $sheet ? Array.from($sheet.querySelectorAll('.tx-ad-skip')).map((el) => ({
    el, start: parseFloat(el.dataset.start) || 0, end: parseFloat(el.dataset.end) || 0,
  })) : [];
  adBars.forEach((b) => b.el.addEventListener('click', (e) => {
    e.stopPropagation();
    player.seek((b.end || 0) + 0.01);
    player.play();
    // 광고 스킵은 명시적 '본편으로' 동작 → 자동추적을 즉시 재개한다. (이 버튼이 .tx-scroll 안에 있어
    // 탭의 touchstart 가 userScrolledUntil 을 4초 세팅해 본편 따라가기가 멈추던 버그 수정.)
    userScrolledUntil = 0;
    lastAdEl = null; lastActivePara = -1;   // 본편 첫 문장으로 즉시 재정렬되게 강제 재평가
    highlightActiveSegment();
  }));

  // 즉시 해설: 각 vocab(어려운 표현)을 그 example 시점이 속한 문장에 매핑 → 그 문장이
  // 재생될 때 하단 패널에 term + 한국어 해설을 띄운다(쉐도잉하며 바로 이해).
  const vNotes = sentRanges.map(() => []);
  for (const v of vocabs) {
    const t = v.sentence_start_sec;
    if (t == null) continue;
    let vi = -1;
    for (let i = 0; i < sentRanges.length; i++) { if (sentRanges[i].start <= t) vi = i; else break; }
    if (vi >= 0) vNotes[vi].push(v);
  }
  const $notes = $sheet ? $sheet.querySelector('.tx-notes') : null;
  function getSentText(idx) {
    const el = sentRanges[idx] && sentRanges[idx].el;
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  // showTrans 가 켜져 있으면 현재 문장의 한국어 번역을 비동기로 채운다(캐시 우선).
  // 번역행이 비거나 실패하면 조용히 패널을 숨긴다(에러 텍스트 절대 표시 X — 안정성 우선).
  function hideTransPanel() {
    if (!$notes) return;
    $notes.classList.remove('show');
    $notes.setAttribute('aria-hidden', 'true');
  }
  async function fillTranslation(idx) {
    if (!$notes) return;
    const sel = () => $notes.querySelector(`.tx-trans-row[data-idx="${idx}"] .tx-trans-ko`);
    let row = sel();
    if (!row) return;
    const text = getSentText(idx);
    if (!text) { hideTransPanel(); return; }
    const ck = trKey(text);                 // '문장 텍스트' 기준 캐시 키(인덱스 X) → 항상 그 문장에 정확히 매칭
    if (_trCache[ck]) { row.textContent = _trCache[ck]; return; }
    if (_preKo[ck]) { row.textContent = _preKo[ck]; _trCache[ck] = _preKo[ck]; saveTrCache(ep.id, _trCache); return; }  // 사전번역 우선
    const seq = ++_trSeq;
    const ko = await translateEnKo(text);   // 사전번역 없을 때만 온디맨드(절대 throw 안 함)
    if (seq !== _trSeq) return;             // 더 최신 문장으로 넘어갔으면 폐기
    if (ko) {
      row = sel(); if (row) row.textContent = ko;
      _trCache[ck] = ko; saveTrCache(ep.id, _trCache);
    } else {
      hideTransPanel();                     // 실패/한도 → 조용히 숨김
    }
    // 다음 문장 미리 번역(부드러운 전환) — easy 가 아닌 문장만, 캐시에만 저장
    const nxt = idx + 1;
    if (showTrans && nxt < sentRanges.length && !isEasySentence(nxt)) {
      const t2 = getSentText(nxt);
      const ck2 = trKey(t2);
      if (t2 && _trCache[ck2] == null) {
        if (_preKo[ck2]) { _trCache[ck2] = _preKo[ck2]; saveTrCache(ep.id, _trCache); }   // 사전번역이면 호출 불필요
        else translateEnKo(t2).then((k) => { if (k) { _trCache[ck2] = k; saveTrCache(ep.id, _trCache); } });
      }
    }
  }
  // 현재 문장이 "easy" 인가 — 어려운 표현(vocab)이 있거나 흔치 않은 단어가 있으면 not-easy.
  function isEasySentence(idx) {
    if (idx < 0) return true;
    if (vNotes[idx] && vNotes[idx].length) return false;  // 추출된 어려운 표현 포함
    return easyByWords(getSentText(idx));
  }
  function renderNotes(idx) {
    if (!$notes) return;
    // VOCAB(즉시해설)은 더 이상 표시하지 않음 — 단어/표현은 Study·Review 에서 학습.
    // 재생 중 하단 카드엔 한글번역만(충분함, 사용자 요청). vNotes 는 난이도 판정에만 계속 사용.
    const wantTrans = showTrans && idx >= 0 && !isEasySentence(idx);
    if (!wantTrans) {
      $notes.classList.remove('show');
      $notes.setAttribute('aria-hidden', 'true');
      return;
    }
    $notes.innerHTML = `<div class="tx-trans-row" data-idx="${idx}"><span class="tx-trans-ico">KR</span><span class="tx-trans-ko">…</span></div>`;
    $notes.classList.add('show');
    $notes.setAttribute('aria-hidden', 'false');
    fillTranslation(idx);
  }

  let lastActiveSent = -1;
  let lastActivePara = -1;
  let lastAdEl = null;   // 현재 강조 중인 광고 바(중복 스크롤 방지)
  let userScrolledUntil = 0;     // suspend auto-follow until this timestamp
  let followResume = false;      // 실스크롤로 이탈함 → 보류 만료 시 반복 문단으로 1회 복귀 신호

  // === 부드러운 자동 스크롤 (Apple Podcasts 느낌) ===
  // 네이티브 scrollTo({smooth}) 는 매 문장마다 재시작돼 끊긴다. 대신 rAF 로 매 프레임
  // 목표(scrollTarget)를 향해 지수적으로 ease → 문장이 바뀌면 목표만 갱신되어 연속·부드럽게.
  let scrollTarget = null;
  let scrollRaf = 0;
  const SCROLL_EASE = 0.12;       // 0~1, 클수록 빠르게 따라붙음(작을수록 더 부드럽고 느긋함)
  // 동작 줄이기 설정이면 ease 없이 즉시 이동(접근성)
  const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function easeScroll() {
    scrollRaf = 0;
    const sc = document.querySelector('.tx-scroll');
    if (!sc || scrollTarget == null) return;
    const cur = sc.scrollTop;
    const diff = scrollTarget - cur;
    if (Math.abs(diff) < 0.5) { sc.scrollTop = scrollTarget; scrollTarget = null; return; }
    sc.scrollTop = cur + diff * SCROLL_EASE;
    scrollRaf = requestAnimationFrame(easeScroll);
  }
  function smoothScrollTo(top) {
    if (REDUCED_MOTION) { const sc = document.querySelector('.tx-scroll'); if (sc) sc.scrollTop = top; return; }
    scrollTarget = top;
    if (!scrollRaf) scrollRaf = requestAnimationFrame(easeScroll);
  }
  function cancelEase() { scrollTarget = null; if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; } }

  function findActiveSentIdx(t) {
    // Active = LAST segment with start <= t.
    // Ignoring segment.end means the active sentence stays highlighted through
    // silence gaps until the next sentence actually starts — no boundary flicker.
    const sr = sentRanges;
    if (!sr.length) return -1;
    if (lastActiveSent >= 0) {
      const cur = sr[lastActiveSent];
      const next = sr[lastActiveSent + 1];
      if (t >= cur.start && (!next || t < next.start)) return lastActiveSent;
      if (next && t >= next.start) {
        const after = sr[lastActiveSent + 2];
        if (!after || t < after.start) return lastActiveSent + 1;
      }
    }
    // binary search: largest idx with start <= t
    let lo = 0, hi = sr.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sr[mid].start <= t) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return found;
  }

  function highlightActiveSegment() {
    try {
      _highlightImpl();
    } catch (err) {
      console.error('[transcript] highlight failed:', err);
    }
  }
  function _highlightImpl() {
    // 성능: 시트가 닫혀 있으면 하이라이트/스크롤 지오메트리는 '보이지 않는' 작업이라 통째로 건너뛴다.
    // (화면 켜고 시트 닫은 채 듣는 흔한 상태에서 4Hz 리플로우·querySelector 낭비 제거.) openSheet 가
    // 열 때 active/para 상태를 전부 지우고 highlightActiveSegment 를 재실행하므로 싱크엔 영향 없음.
    if (!($sheet && $sheet.classList.contains('open'))) return;
    // 추적 상태 클래스(live/no-follow → 'Now playing' 배지 표시)는 어떤 조기 return 보다 먼저 갱신.
    // 예전엔 함수 끝에서만 갱신해서, 단일 문장 문단 반복(idx 불변)·광고 구간·일시정지처럼
    // 조기 return 에 걸리는 상황에서 배지가 영영 안 사라졌다(사용자 보고 2026-07-10).
    const txCard = document.querySelector('.tx-card');
    const userActive = Date.now() < userScrolledUntil;
    txCard?.classList.toggle('live', !userActive);
    txCard?.classList.toggle('no-follow', userActive);
    if (!sentRanges.length) return;
    let t = txTime();
    // 반복 모드: 문단 끝에서 처음으로 되감은 직후 txTime 이 HL_LAG(0.2s)만큼 뒤로 가 직전 문단이
    // 잠깐 잡히는 것 방지 — 활성 판정 시각을 반복 문단 시작 아래로 안 내려가게 클램프.
    if ((inRepeatMode()) && loopPara >= 0) t = Math.max(t, loopStart);
    // 광고 구간이면 해당 광고 바만 강조하고 본문 하이라이트는 보류한다. 본편 문장 타임스탬프는
    // 그대로라, 광고가 끝나면 findActiveSentIdx 가 다음 본편 문장을 제 시각에 잡아 싱크가 이어진다.
    // 광고 경계는 '정확한 컷'이라 HL_LAG 미적용한 실제 오디오 위치로 판정 → 스킵 직후 즉시 본편 인식.
    const tAd = player.time - syncOffset;
    let inAd = null;
    for (const b of adBars) { const on = tAd >= b.start && tAd < b.end; b.el.classList.toggle('active', on); if (on) inAd = b; }
    if (inAd) {
      if (lastActiveSent >= 0 && sentRanges[lastActiveSent]) sentRanges[lastActiveSent].el.classList.remove('active');
      if (lastActiveSent !== -1) { lastActiveSent = -1; renderNotes(-1); }
      if (lastAdEl !== inAd.el) {                 // 새 광고 진입 → 광고 바를 화면에 보이게
        lastAdEl = inAd.el;
        const scroll = document.querySelector('.tx-scroll');
        if (scroll && Date.now() >= userScrolledUntil) {
          const rect = inAd.el.getBoundingClientRect(), cont = scroll.getBoundingClientRect();
          const top = rect.top - cont.top + scroll.scrollTop - Math.max(8, scroll.clientHeight * 0.3);
          smoothScrollTo(Math.max(0, Math.min(top, scroll.scrollHeight - scroll.clientHeight)));
        }
      }
      return;
    }
    lastAdEl = null;
    const idx = findActiveSentIdx(t);
    // 반복(loop/auto5/auto10) 중 사용자가 스크롤로 벗어난 경우: 보류(4s) 만료 시 반복 문단으로 복귀.
    // 반복은 같은 문단에 머물러 paraChanged 가 다시 안 오고, out-of-band 보정도 inLoopPara 게이트에
    // 막히므로 여기서 1회 강제 재배치하지 않으면 화면이 영영 안 돌아온다(사용자 보고 2026-07-08).
    let resumeNow = false;
    if (followResume && Date.now() >= userScrolledUntil) {
      followResume = false;   // 반복 모드가 아니면 소거만(일반 재생은 기존 out-of-band 복귀로 충분)
      if ((inRepeatMode()) && loopPara >= 0) {
        resumeNow = true;
        lastActivePara = -1;  // paraChanged 강제 → 아래에서 문단 시작을 상단 ~10% 로 재배치
      }
    }
    if (idx === lastActiveSent && !resumeNow) return;

    if (lastActiveSent >= 0 && sentRanges[lastActiveSent]) {
      sentRanges[lastActiveSent].el.classList.remove('active');
    }
    if (idx >= 0) sentRanges[idx].el.classList.add('active');
    lastActiveSent = idx;
    renderNotes(idx);  // 현재 문장의 어려운 표현 해설을 하단 패널에

    const scroll = document.querySelector('.tx-scroll');

    // 문단 played/active 표시 (시각용)
    const newPara = idx >= 0 ? paraEls.indexOf(sentRanges[idx].paraEl) : -1;
    const paraChanged = newPara !== lastActivePara;
    if (paraChanged) {
      paraEls.forEach((p, i) => {
        p.classList.toggle('active', i === newPara);
        if (newPara >= 0 && i < newPara) p.classList.add('played');
        else if (i >= newPara) p.classList.remove('played');
      });
      lastActivePara = newPara;
    }

    // 문단 단위 따라가기: 새 '문단'에 들어설 때만 그 문단 시작을 상단 ~16% 줄에 맞춰 문단 전체가
    // 한 화면에 들어오게 한다 → 한 문단을 읽는 동안엔 화면이 안 움직인다(사용자 보고: 4줄 문장 다음
    // 1줄로 넘어갈 때 화면이 위로 튀던 문제 제거). 같은 문단에서 활성 문장이 화면 밖으로 나가려
    // 할 때(아주 긴 문단)만 예외적으로 그 문장을 ~30% 로 살짝 당긴다.
    if (idx >= 0 && scroll && !userActive) {
      const cont = scroll.getBoundingClientRect();
      const h = scroll.clientHeight;
      const sRect = sentRanges[idx].el.getBoundingClientRect();
      const sRelTop = sRect.top - cont.top, sRelBot = sRect.bottom - cont.top;
      let target = null;
      // 반복(loop/auto5) 중 같은 문단 안에서는 문장이 진행돼도 화면을 움직이지 않는다(사용자 요청):
      // 문단 진입 시(paraChanged) 한 번만 위치를 잡고, 끝→처음 되감기 때 '아래로 흔들렸다 되돌아오던'
      // 스크롤을 없앤다. (auto5 가 '다음 문단'으로 넘어갈 때는 paraChanged 라 정상 재배치된다.)
      const inLoopPara = (inRepeatMode()) && loopPara >= 0 && newPara === loopPara;
      // 반환 보장(사용자 보고 2026-07-13 "현재문단 못찾아감"): inLoopPara 게이트는 '보이는 문단 안'의
      // 흔들림만 막아야 한다. 활성 문장이 화면에서 '완전히' 사라졌다면(위/아래 밖) followResume 신호가
      // 탭 등으로 지워졌어도 아래 out-of-band 당김이 복귀시킨다 — 보이는 동안엔 기존과 100% 동일.
      const sentOffscreen = sRelBot <= 0 || sRelTop >= h;
      if (paraChanged) {
        const pTop = sentRanges[idx].paraEl.getBoundingClientRect().top - cont.top + scroll.scrollTop;
        target = pTop - Math.max(8, h * 0.10);   // 문단 시작을 더 위(≈10%)로 — 재생 중 현재문장 상향(사용자 요청)
      } else if ((!inLoopPara || sentOffscreen) && (sRelBot > h * (showTrans ? 0.58 : 0.90) || sRelTop < h * 0.04)) {
        // 번역카드(하단 오버레이)가 켜져 있으면 활성 문장을 더 위(≈13%)로 올려 카드와 안 겹치고 위쪽에 자리잡게.
        target = sRelTop + scroll.scrollTop - Math.max(8, h * (showTrans ? 0.13 : 0.22));
      }
      if (target != null) {
        const clamped = Math.max(0, Math.min(target, scroll.scrollHeight - h));
        const ref = scrollTarget != null ? scrollTarget : scroll.scrollTop;  // rAF ease 로 부드럽게
        if (Math.abs(clamped - ref) > 2) smoothScrollTo(clamped);
      }
    }
  }

  // Detect REAL user-initiated scrolling via wheel/touch — not via 'scroll' event,
  // because our own programmatic smooth-scroll fires scroll events for ~600ms.
  const $txScroll = document.querySelector('.tx-scroll');
  if ($txScroll) {
    // cancel=true 인 실제 스크롤 제스처(휠/드래그/스크롤키)에선 진행 중인 auto-ease 를 즉시 멈춤.
    // 단순 탭(touchstart)은 cancel 하지 않음 → 단어 탭→가운데 정렬 ease 가 살아있게.
    // (followTimer 는 renderEpisode 스코프에 선언 — cleanup 에서 clearTimeout 으로 지운다)
    const markUser = (cancel) => {
      userScrolledUntil = Date.now() + 4000;
      if (cancel) { cancelEase(); followResume = true; }  // 실스크롤(휠/드래그/키)만 복귀 예약 — 단순 탭 제외
      // 일시정지 중엔 timeupdate 가 없어 보류 만료를 아무도 재평가 안 함 → 1회 예약(배지 해제+복귀).
      clearTimeout(followTimer);
      followTimer = setTimeout(highlightActiveSegment, 4200);
    };
    $txScroll.addEventListener('wheel', () => markUser(true), { passive: true });
    $txScroll.addEventListener('touchstart', () => markUser(false), { passive: true });
    $txScroll.addEventListener('touchmove', () => markUser(true), { passive: true });
    $txScroll.addEventListener('keydown', (e) => {
      if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key)) markUser(true);
    });
  }

  const $tx = document.querySelector('.tx-scroll');
  // 단어/문장 탭으로 그 지점부터 재생할 때: 이미 화면에 잘 보이면 스크롤하지 않는다(사용자 보고:
  // 탭하면 화면이 '밀리며' 시작되는 위화감 제거 → 탭한 그 자리에서 바로 시작). 머리가 잘리거나
  // 하단 번역·컨트롤에 가리거나 화면 밖일 때만 자동추적과 동일한 22% 줄에 살짝 정렬한다.
  function scrollSentIntoViewIfNeeded(sentEl) {
    if (!sentEl || !$tx) return;
    userScrolledUntil = Date.now() + 3000;  // 어느 경우든 자동추적은 3s 보류(탭 지점 유지)
    followResume = false;                   // 탭 = 명시적 위치 선택 → 반복 문단 강제 복귀는 취소
    const rect = sentEl.getBoundingClientRect();
    const cont = $tx.getBoundingClientRect();
    const relTop = rect.top - cont.top, relBot = rect.bottom - cont.top;
    const h = $tx.clientHeight;
    if (relTop >= h * 0.12 && relBot <= h * 0.60) return;   // 편안한 밴드 안 → 그대로 둔다
    const target = relTop + $tx.scrollTop - Math.max(8, h * 0.22);
    smoothScrollTo(Math.max(0, Math.min(target, $tx.scrollHeight - h)));
  }
  // (수동 싱크 보정 UI 제거됨 — 모든 회차가 R2 재STT 로 자동 싱크(offset 0))

  // ─── 단어 롱프레스 → 즉석 사전 (신규 필수모드) ────────────────────────────────────────────
  // 탭 = 그 지점 재생(기존), 길게 누름(≈450ms) = 그 단어의 발음(🔊)+한국어 뜻 팝오버. 쉐도잉 중
  // 모르는 단어를 화면을 안 떠나고 바로 확인. 열리면 재생을 잠시 멈춰 읽을 시간을 주고 닫으면 이어 재생.
  // 번역은 per-word localStorage 캐시(aep-wordko)로 재조회 최소화, 오프라인이면 발음만.
  let _wpEl = null, _lpTimer = 0, _lpSuppress = false, _lpStart = null, _lpWasPlaying = false;
  const WORDKO_KEY = 'aep-wordko';
  const loadWordKo = () => { try { return JSON.parse(localStorage.getItem(WORDKO_KEY) || '{}') || {}; } catch { return {}; } };
  const cleanWord = (s) => (s || '').replace(/^[^A-Za-z'’-]+/, '').replace(/[^A-Za-z'’-]+$/, '');
  function _wpOutside(ev) { if (_wpEl && !_wpEl.contains(ev.target)) hideWordPop(); }
  function hideWordPop() {
    if (_wpEl) _wpEl.classList.remove('show');
    document.removeEventListener('pointerdown', _wpOutside, true);
    if (_lpWasPlaying) { _lpWasPlaying = false; player.play(); }   // 열 때 재생 중이었으면 이어 재생
  }
  async function showWordPop(wEl) {
    const word = cleanWord(wEl.textContent);
    if (!word) return;
    _lpWasPlaying = !player.paused;
    if (_lpWasPlaying) player.pause();     // 읽는 동안 정지(자동스크롤도 멈춰 팝오버가 안 밀린다)
    if (!_wpEl) { _wpEl = document.createElement('div'); _wpEl.className = 'tx-wordpop'; document.body.appendChild(_wpEl); }
    _wpEl.innerHTML =
      `<button class="tx-wordpop-spk" aria-label="Pronounce">🔊</button>` +
      `<span class="tx-wordpop-w">${escapeHtml(word)}</span>` +
      `<span class="tx-wordpop-ko">…</span>`;
    _wpEl.querySelector('.tx-wordpop-spk').addEventListener('click', (e) => { e.stopPropagation(); speak(word); });
    _wpEl.classList.add('show');
    // 위치: 단어 바로 위 중앙(화면 밖이면 클램프, 위 공간 없으면 아래로)
    const r = wEl.getBoundingClientRect();
    const pw = _wpEl.offsetWidth, ph = _wpEl.offsetHeight;
    let left = Math.max(8, Math.min(r.left + r.width / 2 - pw / 2, window.innerWidth - pw - 8));
    let top = r.top - ph - 10;
    if (top < 8) top = r.bottom + 10;
    _wpEl.style.left = left + 'px';
    _wpEl.style.top = top + 'px';
    speak(word);                            // 길게 누르는 즉시 발음도 들려준다
    document.addEventListener('pointerdown', _wpOutside, true);
    const koEl = _wpEl.querySelector('.tx-wordpop-ko');
    const cache = loadWordKo(), key = word.toLowerCase();
    if (cache[key]) { koEl.textContent = cache[key]; wEl.classList.add('looked'); return; }
    if (!navigator.onLine) { koEl.textContent = '(오프라인 — 발음만)'; return; }
    try {
      const ko = await translateEnKo(word);
      koEl.textContent = ko || '—';
      if (ko) { cache[key] = ko; wEl.classList.add('looked'); try { localStorage.setItem(WORDKO_KEY, JSON.stringify(cache)); } catch (e) {} }
    } catch { koEl.textContent = '—'; }
  }

  if ($tx) {
    $tx.addEventListener('click', (e) => {
      if (_lpSuppress) { _lpSuppress = false; return; }   // 방금 롱프레스였음 → 시크하지 않음
      const w = e.target.closest('.w');
      const sent = e.target.closest('.tx-sent');
      const para = e.target.closest('.tx-para');
      let txSec = null;
      if (w)        txSec = parseFloat(w.dataset.s);
      else if (sent) txSec = parseFloat(sent.dataset.start);
      else if (para) txSec = parseFloat(para.dataset.start);
      if (txSec == null) return;
      // 반복 중에 다른 문장을 탭하면, 그 문장이 속한 문단으로 반복 대상을 옮긴다(auto5 카운트도 리셋).
      if (inRepeatMode()) {
        const pEl = para || (sent && sent.closest('.tx-para'));
        // loopCount 를 먼저 리셋해야 setLoopPara 가 그리는 카운트다운 배지가 전체 횟수로 시작한다.
        if (pEl) { loopCount = 0; setLoopPara(paraEls.indexOf(pEl)); }
      }
      player.seek(toAudio(txSec));   // 자막 시각 → 오디오 시각
      player.play();
      scrollSentIntoViewIfNeeded(sent || para);   // 이미 보이면 안 움직임(탭 그 자리서 시작)
    });
    // 롱프레스 판정: .w 위에서 pointerdown 후 450ms 안 움직이고 유지 → 사전. 움직이면(스크롤) 취소.
    const _lpCancel = () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = 0; } };
    $tx.addEventListener('pointerdown', (e) => {
      const w = e.target.closest('.w');
      if (!w) return;
      _lpStart = { x: e.clientX, y: e.clientY };
      _lpCancel();
      _lpTimer = setTimeout(() => { _lpTimer = 0; _lpSuppress = true; showWordPop(w); }, 450);
    });
    $tx.addEventListener('pointermove', (e) => {
      if (_lpTimer && _lpStart && (Math.abs(e.clientX - _lpStart.x) > 10 || Math.abs(e.clientY - _lpStart.y) > 10)) _lpCancel();
    });
    $tx.addEventListener('pointerup', _lpCancel);
    $tx.addEventListener('pointercancel', _lpCancel);
  }

  // "Now playing" badge tap → resume auto-follow
  document.querySelector('.tx-live-badge')?.addEventListener('click', () => {
    userScrolledUntil = 0;
    followResume = false;
    lastActivePara = -1;  // force re-trigger of scroll on next update
    lastActiveSent = -1;  // 이게 없으면 'idx 불변' 조기 return 에 걸려 탭이 무반응(활성 문장이 안 바뀐 동안)
    highlightActiveSegment();
  });

  // === Sheet open/close (defined here so it can read state vars and fns above) ===
  // 전체화면 시트 열림 동안 배경(탑바·탭바·앱·미니플레이어)을 inert 로 → Tab/스크린리더가 뒤 페이지로
  // 새지 않게(포커스 트랩). inert 미지원 브라우저는 조용히 무시(무해). 닫을 때 원복.
  const _bgInert = ['#topbar', '#tabbar', '#app', '#miniplayer'];
  function setBgInert(on) {
    for (const sel of _bgInert) {
      const el = document.querySelector(sel);
      if (el) { if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert'); }
    }
  }
  function openSheet() {
    if (!$sheet) return;
    $sheet.classList.add('open');
    $sheet.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    setBgInert(true);
    $sheet.querySelector('.tx-sheet-close')?.focus?.();   // 포커스를 시트 안으로
    wakePolicy();   // Transcript 열림 = 화면 계속 켜둠(30초 카운트 해제)
    // 신규 필수모드 발견성 — 트랜스크립트를 처음 열 때 1회만 롱프레스 사전 안내(숨은 제스처라 힌트 필요).
    try {
      if (!localStorage.getItem('aep-hint-wordpop')) {
        localStorage.setItem('aep-hint-wordpop', '1');
        setTimeout(() => toast('💡 단어를 길게 누르면 뜻·발음이 나와요'), 1200);
      }
    } catch (e) {}
    // Wipe ALL state and stale classes, then re-evaluate from current player time.
    setTimeout(() => {
      sentRanges.forEach((s) => s.el.classList.remove('active'));
      paraEls.forEach((p) => p.classList.remove('active', 'played'));
      lastActiveSent = -1;
      lastActivePara = -1;
      userScrolledUntil = 0;
      followResume = false;
      lastWordIdx = -1;      // 단어 카라오케도 재동기화 대상으로 리셋
      highlightActiveSegment();
      updateWord();          // 열자마자 단어 하이라이트 즉시 맞춤(닫힘 동안 rAF 멈춰 있었으므로)
      startRaf();            // 재생 중이면 카라오케 rAF 재가동
      showControls();  // 열 때 컨트롤 표시 후 잠시 뒤 자동 숨김
    }, 80);
  }
  function closeSheet() {
    if (!$sheet) return;
    $sheet.classList.remove('open');
    $sheet.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    stopRaf();   // 시트 닫힘 → 보이지 않는 카라오케 60fps 루프 정지(배터리)
    setBgInert(false);
    document.getElementById('np-tx-btn')?.focus?.();   // 포커스를 연 버튼으로 복원
    wakePolicy();   // 일반 화면 복귀 → 30초 무조작 시 화면 꺼짐 허용 카운트 시작
  }
  escClose = (e) => { if (e.key === 'Escape') closeSheet(); };
  document.addEventListener('keydown', escClose);
  document.getElementById('np-tx-btn')?.addEventListener('click', openSheet);
  $sheet?.querySelector('.tx-sheet-close')?.addEventListener('click', closeSheet);
  // 비완벽싱크 안내 바 닫기 — 이 회차 동안만 숨김(스크롤 지오메트리 밖 요소라 싱크엔 영향 없음).
  $sheet?.querySelector('#tx-drift-x')?.addEventListener('click', () => {
    const n = $sheet.querySelector('#tx-drift-note'); if (n) n.remove();
  });
  $sheet?.querySelector('.tx-sheet-backdrop')?.addEventListener('click', closeSheet);
  const destroySheetDrag = $sheet ? bindSheetDrag($sheet, closeSheet) : null;
  // Mini-controls inside sheet
  document.getElementById('tx-mini-play')?.addEventListener('click', (e) => {
    e.stopPropagation();
    player.toggle();
  });
  document.getElementById('tx-mini-back')?.addEventListener('click', (e) => {
    e.stopPropagation();
    player.skip(-15);
  });
  document.getElementById('tx-mini-fwd')?.addEventListener('click', (e) => {
    e.stopPropagation();
    player.skip(30);
  });
  // 시트 시크 바 스와이프(Apple Podcasts 식) — 드래그/탭으로 재생 위치 이동 후 이어 재생.
  if ($txSeekTrack) {
    txScrub = bindScrub($txSeekTrack, {
      onPreview(frac) {
        const dur = player.duration; if (!dur) return;
        const pct = (frac * 100).toFixed(2);
        if ($txSeekFill)   $txSeekFill.style.width = pct + '%';
        if ($txSeekHandle) $txSeekHandle.style.left = pct + '%';
        if ($txSeekCur)    $txSeekCur.textContent = fmtTime(dur * frac);
        if ($txSeekRem)    $txSeekRem.textContent = '-' + fmtTime(Math.max(0, dur - dur * frac));
        showControls();   // 스크럽 중 컨트롤이 자동으로 사라지지 않게
      },
      onSeek(frac) {
        const dur = player.duration;
        if (!dur) return;
        player.seek(dur * frac);
        player.play();
        // 재생바 시크 = 명시적 위치 선택 → 자동추적 즉시 재개(탭 시크·광고 스킵과 동일 규약).
        // 이게 없으면: 직전에 컨트롤을 깨우려고 .tx-scroll 을 만진 탭이 4s 보류를 걸고, 그 보류 중
        // 시크 틱이 paraChanged 를 '스크롤 없이' 소진 → 단일 문장 반복 문단에선 idx 가 다시 안 바뀌어
        // 화면이 영영 새 문단으로 못 간다(사용자 보고 2026-07-23 "재생바 앞으로 스크롤해도 문단 안 바뀜").
        userScrolledUntil = 0;
        followResume = false;
        lastActiveSent = -1;
        lastActivePara = -1;   // 강제 재평가 — 같은 문장 안 시크도 즉시 재앵커
        highlightActiveSegment();
      },
    });
  }
  // 쉐도잉 버튼: off(Shadow) → 2× Smart → 1× Smart → 2× Auto → 3× Auto → 5× Auto → 10× Auto → off … 순환.
  // (2026-07-17: Repeat∞ 제거, 2× Smart 추가, 고정폭 통일. 2026-07-25 사용자 요청: 2×/3× Auto 추가 —
  //  적은 반복으로 빠르게 따라 말하고 다음 문단으로 넘어가고 싶을 때. auto 는 2→3→5→10 오름차순.)
  // 2× Smart = 문단 길이 비례 반복(smart)의 2배. N× Auto = 문단을 고정 N회 반복 후 다음 문단으로.
  const SHADOW = [
    { mode: 'off',    label: 'Shadow',   on: false },
    { mode: 'smart2', label: '2× Smart', on: true },
    { mode: 'smart',  label: '1× Smart', on: true },
    { mode: 'auto2',  label: '2× Auto',  on: true },
    { mode: 'auto3',  label: '3× Auto',  on: true },
    { mode: 'auto5',  label: '5× Auto',  on: true },
    { mode: 'auto10', label: '10× Auto', on: true },
  ];
  const $shadow = document.getElementById('tx-shadow');
  // 한 '문단'을 반복 대상으로 확정 — pIdx 의 문단 시작/끝(자막시각)을 loopStart/End 로.
  // 목표 반복 횟수도 여기서 산정(smart=문단 길이 비례, autoN=고정, loop=0(무한)) + 배지 갱신.
  function setLoopPara(pIdx) {
    const pEl = paraEls[pIdx];
    if (!pEl) return false;
    const ps = sentRanges.filter((s) => s.paraEl === pEl);
    if (!ps.length) return false;
    loopPara = pIdx; loopStart = ps[0].start; loopEnd = ps[ps.length - 1].end;
    loopTarget = (shadowMode === 'smart' || shadowMode === 'smart2')
      ? smartRepsFor(loopEnd - loopStart) : (REPEAT_OF[shadowMode] || 0);
    updateLoopBadge();
    return true;
  }
  // 반복 카운트다운 배지 — 반복 중인 문단 위에 남은 횟수를 표시. 모든 반복 모드
  // (2× Smart / 1× Smart / 5× Auto / 10× Auto)가 "↻ N" 으로 남은 횟수 카운트다운(사용자 요청 2026-07-17).
  // 모드 종료/문단 이동 시 이전 배지는 제거된다.
  function updateLoopBadge() {
    document.querySelectorAll('.tx-loop-badge').forEach((b) => b.remove());
    if (!inRepeatMode() || loopPara < 0) return;
    const pEl = paraEls[loopPara];
    if (!pEl) return;
    const b = document.createElement('span');
    b.className = 'tx-loop-badge';
    b.textContent = `↻ ${Math.max(0, loopTarget - loopCount)}`;
    pEl.appendChild(b);
  }
  // 현재 재생 위치가 속한 문단을 반복 대상으로(loop/auto5 진입 시 공용). 즉시 되감지 않고
  // 지금 문단을 끝까지 자연스럽게 읽은 뒤, 끝에서 반복/다음이동(사용자 요청).
  function confirmLoopBoundary() {
    const si = findActiveSentIdx(player.time - syncOffset);
    if (si >= 0 && sentRanges[si]) {
      setLoopPara(paraEls.indexOf(sentRanges[si].paraEl));
      userScrolledUntil = 0;   // 자동추적 재개
    }
  }
  // auto5 가 마지막 문단까지 끝났을 때 — 쉐도잉을 끄고 버튼/상태 초기화(그대로 계속 재생).
  function endShadow() {
    shadowMode = 'off'; shadowIdx = 0; loopPara = -1; loopCount = 0; loopTarget = 0;
    updateLoopBadge();   // 카운트다운 배지 제거
    if ($shadow) {
      $shadow.textContent = SHADOW[0].label;
      $shadow.classList.remove('on');
      $shadow.setAttribute('aria-pressed', 'false');
    }
  }
  $shadow?.addEventListener('click', (e) => {
    e.stopPropagation();
    shadowIdx = (shadowIdx + 1) % SHADOW.length;
    const s = SHADOW[shadowIdx];
    shadowMode = s.mode;
    loopCount = 0;
    $shadow.textContent = s.label;
    $shadow.classList.toggle('on', s.on);
    $shadow.setAttribute('aria-pressed', s.on ? 'true' : 'false');
    if (inRepeatMode()) confirmLoopBoundary();
    else loopPara = -1;
    updateLoopBadge();   // off 전환 시 배지 제거(반복 모드는 setLoopPara 가 이미 갱신)
    if (player.paused) player.play();  // 모드 전환 즉시 이어 재생
  });

  // 쉐도잉용 속도 조절 — 메인 화면(np-speed)과 시트(tx-speed)가 같은 speedIdx 를 공유한다. 하나에서
  // 바꾸면 다른 하나도 즉시 같은 값으로 반영(예전엔 speedIdx/sheetSpeedIdx 가 따로 놀아, 시트에서
  // 0.75× 로 바꾸고 닫으면 메인 칩은 1× 로 남고 다음 탭이 엉뚱한 기준에서 시작했다).
  const $txSpeed = document.getElementById('tx-speed');
  function setSpeed(idx) {
    speedIdx = ((idx % SPEEDS.length) + SPEEDS.length) % SPEEDS.length;
    const r = SPEEDS[speedIdx];
    player.rate(r);
    const lbl = r === 1 ? '1×' : r + '×';
    if ($speed) $speed.textContent = lbl;
    if ($txSpeed) { $txSpeed.textContent = lbl; $txSpeed.classList.toggle('on', r !== 1); }
  }
  $txSpeed?.addEventListener('click', (e) => { e.stopPropagation(); setSpeed(speedIdx + 1); });
  // 재생속도는 공유 <audio> 에 유지된다(회차 이동해도 그대로) → 이 회차 칩/인덱스를 실제 속도에 맞춘다.
  // (버그헌트 #2: 안 맞추면 라벨은 1× 인데 실제로는 1.5× 로 재생되고, 다음 탭이 엉뚱한 값에서 시작.)
  { const cur = player.audio ? player.audio.playbackRate : 1; const i = SPEEDS.indexOf(cur); if (i > 0) setSpeed(i); }

  // 한국어 번역 표시 토글 (#8) — 기본 ON. 초기 버튼 상태도 showTrans 에 맞춘다.
  const $trans = document.getElementById('tx-trans');
  if ($trans) {
    $trans.classList.toggle('on', showTrans);
    $trans.setAttribute('aria-pressed', showTrans ? 'true' : 'false');
  }
  $trans?.addEventListener('click', (e) => {
    e.stopPropagation();
    showTrans = !showTrans;
    try { localStorage.setItem(TRANS_KEY, showTrans ? '1' : '0'); } catch (e) {}
    $trans.classList.toggle('on', showTrans);
    $trans.setAttribute('aria-pressed', showTrans ? 'true' : 'false');
    renderNotes(lastActiveSent);
  });

  // 글자 크기 조절 (#17) — 읽기 영역 스케일을 localStorage 에 저장
  const FS_KEY = 'aep-tx-scale';
  // 본문(영어 transcript) 글자 크기 — A−/A＋ 두 버튼을 '가' 칩과 동일한 '단일 A 칩 순환'으로 통합
  // (사용자 요청 2026-07-12). 탭마다 작게→보통→크게→더크게→아주크게 순환, 기본(1.0)이 아니면 .on 표시.
  // --tx-scale 은 시트 카드(.tx-card 와 .tx-notes 의 공통 조상)에 둔다 → 본문만 스케일되고
  // 한글 번역(.tx-trans-ko)은 고정 크기라 영향을 안 받는다(별도 '가' 칩으로 조절).
  const FS_STEPS = [0.85, 1.0, 1.15, 1.3, 1.5];
  let fsIdx = (() => {                          // 기존 연속 스케일 저장값 → 가장 가까운 단계(하위호환)
    const saved = parseFloat(localStorage.getItem(FS_KEY) || '1') || 1;
    let best = 1, bd = Infinity;
    FS_STEPS.forEach((s, i) => { const d = Math.abs(s - saved); if (d < bd) { bd = d; best = i; } });
    return best;
  })();
  let txScale = FS_STEPS[fsIdx];
  const $scaleEl = $sheet ? $sheet.querySelector('.tx-sheet-card') : null;
  const $fs = document.getElementById('tx-fs');
  function applyTxScale() {
    txScale = FS_STEPS[fsIdx];
    // 글자 크기 변경 시 '보던 문장 그대로'. 핵심: 자동 따라가기(easeScroll rAF 루프)가 변경 전 목표로
    // scrollTop 을 계속 끌어당겨 내 보정과 싸웠다(그래서 몇 문단씩 밀림). → ease 취소 + 자동추적 잠시
    // 보류 후, 레이아웃 정착(rAF)되면 앵커를 원래 화면 위치로 '딱 한 번' 되돌린다.
    const sc = document.querySelector('.tx-scroll');
    let anchor = null, desired = 0;
    if (sc) {
      const cTop = sc.getBoundingClientRect().top;
      anchor = sc.querySelector('.tx-sent.active')
        || [...sc.querySelectorAll('.tx-sent')].find((el) => el.getBoundingClientRect().bottom > cTop + 22);
      if (anchor) desired = anchor.getBoundingClientRect().top - cTop;
    }
    cancelEase();                          // 진행 중인 자동 스크롤 ease 중단(경쟁 제거)
    userScrolledUntil = Date.now() + 1200; // 자동추적이 보정을 덮어쓰지 않게 잠시 보류
    if ($scaleEl) $scaleEl.style.setProperty('--tx-scale', String(txScale));
    if ($fs) $fs.classList.toggle('on', txScale !== 1);   // 기본 크기가 아닐 때만 활성 표시
    try { localStorage.setItem(FS_KEY, String(txScale)); } catch (e) {}
    if (sc && anchor) {
      requestAnimationFrame(() => {
        cancelEase();                      // rAF 시점에도 혹시 재개됐으면 다시 중단
        const now = anchor.getBoundingClientRect().top - sc.getBoundingClientRect().top;
        sc.scrollTop += (now - desired);   // 앵커를 변경 전 화면 위치로(단일 보정)
      });
    }
  }
  applyTxScale();
  $fs?.addEventListener('click', (e) => { e.stopPropagation(); fsIdx = (fsIdx + 1) % FS_STEPS.length; applyTxScale(); });

  // 한국어 번역 글자 크기 ('가' 칩) — A−/A＋(본문 --tx-scale)와 '완전 독립'. 별도 --ko-scale 을
  // 번역카드(.tx-notes; 노드는 유지되고 innerHTML 만 갱신됨)에 둬 문장이 바뀌어도 크기가 유지된다.
  // 추가 +/− 버튼 없이 칩 하나를 탭할 때마다 작게→보통→크게→아주크게 순환(cnpod-review 와 동일).
  const KO_KEY = 'aep-tx-ko-scale';
  const KO_STEPS = [0.85, 1.0, 1.22, 1.45];
  let koIdx = (() => { const i = KO_STEPS.indexOf(parseFloat(localStorage.getItem(KO_KEY) || '1')); return i >= 0 ? i : 1; })();
  const $koSize = document.getElementById('tx-ko-size');
  function applyKoScale() {
    const s = KO_STEPS[koIdx];
    if ($notes) $notes.style.setProperty('--ko-scale', String(s));
    if ($koSize) $koSize.classList.toggle('on', s !== 1);  // 기본(1.0)이 아닐 때만 활성 표시
    try { localStorage.setItem(KO_KEY, String(s)); } catch (e) {}
  }
  applyKoScale();
  $koSize?.addEventListener('click', (e) => {
    e.stopPropagation();
    koIdx = (koIdx + 1) % KO_STEPS.length;
    applyKoScale();
  });

  // ⏮/⏭ = '에피소드(곡)' 단위 이동 (미디어 플레이어 표준) — 트랜스크립트 시트와 메인 화면이 공유.
  //   ⏭ 다음 → 바로 다음 에피소드.
  //   ⏮ 이전 → 1번 누르면 현재 회차 '맨 처음'으로, 1.5초 내 연속 두 번이면 '이전 에피소드'.
  // openScript: 트랜스크립트에서 이동 시 true → 다음 화도 스크립트 시트 자동 오픈+재생.
  //             메인 화면에서 이동 시 false → 다음 화의 '메인 재생화면'에 머물되 자동재생만.
  function gotoEpisode(targetId, openScript) {
    if (targetId == null) return;
    try { sessionStorage.setItem(openScript ? 'aep-open-script' : 'aep-autoplay', String(targetId)); } catch (e) {}
    location.hash = `#/episode/${targetId}`;
  }
  function prevPress(openScript) {
    const now = Date.now();
    if (now - lastPrevTap < 1500) {            // 연속 두 번 → 이전 에피소드
      lastPrevTap = 0;
      if (navPrevId != null) gotoEpisode(navPrevId, openScript);
      else { player.seek(0); player.play(); }  // 첫 회차면 맨 앞 유지
    } else {                                    // 첫 번째 → 현재 회차 맨 처음으로
      lastPrevTap = now;
      player.seek(0);
      player.play();
    }
  }
  function nextPress(openScript) {
    if (navNextId != null) gotoEpisode(navNextId, openScript);
  }
  document.getElementById('tx-prev-sent')?.addEventListener('click', (e) => { e.stopPropagation(); prevPress(true); });
  document.getElementById('tx-next-sent')?.addEventListener('click', (e) => { e.stopPropagation(); nextPress(true); });

  // === 재생 종료 동작 칩 — '일반 재생화면' 전용(Transcript 시트엔 없음, 사용자 요청 2026-07-15) ===
  // 회차가 끝나면 ▸ 다음 회차 자동재생(기본) / 이 회차 처음부터 반복 / 한 번만(정지).
  // 탭마다 순환, 선택은 localStorage 로 유지. 쉐도잉(문단 반복)은 끝에 도달하기 전에 처리되므로
  // 여기 오는 'ended' 는 항상 자연 종료다.
  const END_KEY = 'aep-endmode';
  // 라벨 = 텍스트색(currentColor) 글리프 단독 — 컬러 이모지의 사각 박스 없이 1× 칩과 같은
  // 회색 칩/흰 아이콘 조합, 글리프가 칩 안을 크게 채운다(사용자 요청 2026-07-15).
  // 다음 회차(스킵) / 반복(루프 화살표) / 한 번만(루프 화살표+중앙 1 — cnpod-review 와 동일 글리프).
  // 영문 텍스트·안내 토스트 없음.
  // aria: 세 모드가 같은 라벨('After the episode ends')이면 스크린리더로 현재 상태 구별 불가였다 →
  // 상태별 aria-label 로 지금 어떤 종료 동작인지 읽히게(정밀진단 a11y 수정).
  const END_MODES = [
    { mode: 'next',   aria: 'When the episode ends: play the next episode', label: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M14.8 6H17v12h-2.2zM5 6l8.5 6L5 18z"/></svg>' },
    { mode: 'repeat', aria: 'When the episode ends: repeat this episode', label: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>' },
    { mode: 'once',   aria: 'When the episode ends: stop', label: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="15.5" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor" stroke="none">1</text></svg>' },
  ];
  let endIdx = (() => {
    let s = null; try { s = localStorage.getItem(END_KEY); } catch (e) {}
    const i = END_MODES.findIndex((m) => m.mode === s);
    return i >= 0 ? i : 0;                        // 기본 = 다음 회차 재생
  })();
  const $endMode = document.getElementById('np-endmode');
  function applyEndMode() {
    const m = END_MODES[endIdx];
    if ($endMode) { $endMode.innerHTML = m.label; $endMode.setAttribute('aria-label', m.aria); }   // 강조색 없음 — 항상 1× 칩과 동일한 회색 유지
    try { localStorage.setItem(END_KEY, m.mode); } catch (e) {}
  }
  applyEndMode();
  $endMode?.addEventListener('click', () => { endIdx = (endIdx + 1) % END_MODES.length; applyEndMode(); });
  // 탭 하이라이트: 속도 칩은 탭 후에도 하이라이트(모바일 끈적 hover)가 남지만, 이 칩은 탭마다
  // 글리프를 innerHTML 로 갈아끼우며 즉시 회색으로 꺼졌다(사용자 보고 2026-07-15). 속도 칩과
  // 같은 느낌을 결정적으로 재현 — 누르면 켜고, 칩 '밖'을 터치할 때 끈다.
  $endMode?.addEventListener('pointerdown', () => $endMode.classList.add('pressed'));
  const onEndModeOutside = (e) => { if ($endMode && !$endMode.contains(e.target)) $endMode.classList.remove('pressed'); };
  document.addEventListener('pointerdown', onEndModeOutside, true);
  // 자연 종료 시 선택대로 처리. Transcript 시트를 연 채 끝났다면 다음 회차도 시트를 연 채 이어간다(⏭ 과 동일).
  const offEnded = player.on((ev) => {
    if (ev !== 'ended') return;
    const mode = END_MODES[endIdx].mode;
    if (mode === 'repeat') { player.seek(0); player.play(); }
    else if (mode === 'next' && navNextId != null) gotoEpisode(navNextId, sheetOpen());
  });

  // === 운전 캡처(Drive capture) — 주행 중 '지금 문장' 북마크 (marks.js) ===
  // ON: 플로팅 🔖 FAB(시트 위에도 뜸) + 차 핸들 ⏭(Media Session nexttrack)이 현재 시각을 저장.
  // OFF: ⏭ 은 원래 +30s 스킵으로 복귀. 저장만 하고 단어 고르기/카드 만들기는 Study 홈 트리아지에서 —
  // 운전 중 '읽고 고르는' 상호작용을 아예 없애는 게 목적(캡처와 학습의 시간 분리).
  // 칩은 transcript 시트 툴바(#tx-drive)에 — 차에선 시트를 연 쉐도잉 상태라 NP 화면 칩은 손이
  // 안 닿았다(사용자 요청 2026-07-22, v1.39.1에서 이동). 안내 문구는 플레이어 쪽 표기와 맞춰 영어.
  // getLoop: 쉐도잉 반복 중이면 반복 문단 범위를 marks.js 에 제공 — 마크가 '그 문단'에 묶이고,
  // 문단 재시크 직후 눌러도 직전 문단으로 오기록되지 않는다(저장 문단 불일치 수리 2026-07-22).
  initDriveCapture({
    player, toast,
    getLoop: () => (inRepeatMode() && loopPara >= 0 && Number.isFinite(loopStart) && Number.isFinite(loopEnd))
      ? { start: loopStart, end: loopEnd } : null,
  });
  const $drive = document.getElementById('tx-drive');
  const syncDriveChip = () => {
    if (!$drive) return;
    $drive.setAttribute('aria-pressed', driveOn() ? 'true' : 'false');
  };
  syncDriveChip();
  $drive?.addEventListener('click', (e) => {
    e.stopPropagation();               // 시트 탭 리스너(컨트롤 표시 등)와 분리
    const on = !driveOn();
    setDrive(on);
    syncDriveChip();
    toast(on ? '🚗 Drive capture ON — 🔖 or car ⏭ saves this sentence' : 'Drive capture OFF — ⏭ skips +30s again');
  });

  // === 하단 전송 컨트롤 자동 숨김 + 화면 탭하면 다시 올라오기 (사용자 요청) ===
  const $sheetCard = $sheet ? $sheet.querySelector('.tx-sheet-card') : null;
  let ctrlHideTimer = 0;
  function showControls() {
    if (!$sheetCard) return;
    $sheetCard.classList.remove('controls-hidden');
    clearTimeout(ctrlHideTimer);
    ctrlHideTimer = setTimeout(() => $sheetCard.classList.add('controls-hidden'), 6000);
  }
  // 시트 어디든 탭(포인터 누름) → 컨트롤 다시 표시 + 숨김 타이머 리셋
  $sheetCard?.addEventListener('pointerdown', showControls, { passive: true });

  // === 재생 중 화면 꺼짐 정책 (Screen Wake Lock) ===
  // Transcript 시트가 열려 있는 동안엔 계속 켜둔다(쉐도잉 중 화면 유지 — 기존 동작 그대로).
  // '일반 재생화면'은 마지막 터치 후 30초가 지나면 lock 을 놓아 기기의 자동 잠금 설정대로 화면이
  // 꺼지게 한다(사용자 요청 2026-07-15). 웹은 화면을 직접 끌 수 없어 '켜두기 중단'이 가능한 전부.
  let wakeLock = null;
  let wakeIdleTimer = 0;
  const WAKE_IDLE_MS = 30000;
  const sheetOpen = () => !!($sheet && $sheet.classList.contains('open'));
  async function acquireWake() {
    try {
      if ('wakeLock' in navigator && !wakeLock && !player.paused) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* 미지원/사용자 거부 — 무시 */ }
  }
  async function releaseWake() {
    const w = wakeLock; wakeLock = null;
    try { if (w) await w.release(); } catch (e) {}
  }
  function wakePolicy() {
    clearTimeout(wakeIdleTimer); wakeIdleTimer = 0;
    if (player.paused) return;
    acquireWake();
    if (!sheetOpen()) wakeIdleTimer = setTimeout(() => { if (!sheetOpen()) releaseWake(); }, WAKE_IDLE_MS);
  }
  const offWake = player.on((ev) => {
    if (ev === 'play') wakePolicy();
    else if (ev === 'pause' || ev === 'ended') { clearTimeout(wakeIdleTimer); wakeIdleTimer = 0; releaseWake(); }
  });
  // 브라우저는 탭이 숨겨지면 wake lock 을 자동 해제 → 복귀 시 재평가(시트 열림이면 계속 켜둠)
  const onVis = () => { if (document.visibilityState === 'visible' && !player.paused) wakePolicy(); };
  document.addEventListener('visibilitychange', onVis);
  // 아무 터치든 30초 카운트 리셋(놓았던 lock 도 재취득) — 캡처 단계라 stopPropagation 에도 안전.
  const onAnyPointer = () => { if (!player.paused) wakePolicy(); };
  document.addEventListener('pointerdown', onAnyPointer, { capture: true, passive: true });
  if (!player.paused) wakePolicy();

  const off = player.on(refresh);

  // === 단어 단위 따라가기 (karaoke) — rAF 로 timeupdate(4Hz)보다 부드럽게 ===
  const wordTimed = Array.from(document.querySelectorAll('.tx-scroll .w'))
    .map((el) => ({ el, s: parseFloat(el.dataset.s) }))
    .filter((w) => Number.isFinite(w.s));
  let lastWordIdx = -1;
  // 이미 찾아본 단어(aep-wordko 캐시)는 점선 밑줄로 표시 — 어휘 진도가 한눈에 보이고 다시 찾기 쉽다.
  (function markLookedWords() {
    try {
      const known = loadWordKo();
      if (!Object.keys(known).length) return;
      for (const el of document.querySelectorAll('.tx-scroll .w')) {
        if (known[cleanWord(el.textContent).toLowerCase()]) el.classList.add('looked');
      }
    } catch (e) {}
  })();
  function updateWord() {
    if (!wordTimed.length) return;
    if ($sheet && !$sheet.classList.contains('open')) return;  // 시트 닫힘 → 단어 하이라이트 갱신 불필요(배터리)
    let t = txTime();
    // 반복 모드: 되감기 직후 HL_LAG 로 t 가 직전 문장 단어로 내려가 카라오케가 깜빡이던 것 방지.
    if ((inRepeatMode()) && loopPara >= 0) t = Math.max(t, loopStart);
    let lo = 0, hi = wordTimed.length - 1, found = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (wordTimed[m].s <= t) { found = m; lo = m + 1; } else hi = m - 1; }
    if (found === lastWordIdx) return;
    // 현재 단어(cur) 이동
    if (lastWordIdx >= 0 && wordTimed[lastWordIdx]) wordTimed[lastWordIdx].el.classList.remove('cur');
    if (found >= 0 && wordTimed[found]) wordTimed[found].el.classList.add('cur');
    // 지나간 단어(spoken) 음영 — 변경된 구간만 토글
    if (found > lastWordIdx) {
      for (let i = Math.max(0, lastWordIdx); i < found; i++) wordTimed[i].el.classList.add('spoken');
    } else if (found < lastWordIdx) {
      for (let i = Math.max(0, found); i <= lastWordIdx && i < wordTimed.length; i++) wordTimed[i].el.classList.remove('spoken');
    }
    lastWordIdx = found;
  }
  let rafId = 0;
  function rafLoop() { updateWord(); rafId = requestAnimationFrame(rafLoop); }
  // 성능: 단어 카라오케 rAF(60fps)는 '시트가 열려 재생 중'일 때만 돈다. 시트 닫힘 상태(화면 켜고
  // 듣기)에선 카라오케가 안 보이므로 60fps 웨이크업을 통째로 없앤다. openSheet/closeSheet 가 시작/정지.
  function startRaf() { if (!rafId && !player.paused && $sheet && $sheet.classList.contains('open')) rafId = requestAnimationFrame(rafLoop); }
  function stopRaf() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
  const offWord = player.on((ev) => {
    if (ev === 'play') startRaf();
    else if (ev === 'pause' || ev === 'ended') { stopRaf(); updateWord(); }
  });
  if (!player.paused) startRaf();
  updateWord();

  // Cleanup on route change — detach player listener, remove sheet, restore body scroll
  window.addEventListener('hashchange', () => {
    off();
    offWord();
    offWake();
    offEnded();
    clearTimeout(wakeIdleTimer);
    document.removeEventListener('pointerdown', onAnyPointer, { capture: true });
    document.removeEventListener('pointerdown', onEndModeOutside, true);
    releaseWake();
    document.removeEventListener('visibilitychange', onVis);
    clearTimeout(ctrlHideTimer);
    clearTimeout(followTimer);   // 자동추적 복귀 예약 — 다음 회차 시트를 건드리지 않게 취소
    clearTimeout(_lpTimer); document.removeEventListener('pointerdown', _wpOutside, true); _wpEl?.remove();  // 단어 사전 팝오버 정리
    cancelEase();
    stopRaf();
    txScrub?.destroy();
    destroySheetDrag?.();        // 시트 드래그의 document 마우스 리스너 제거(누수 방지)
    setBgInert(false);           // 시트 열린 채 이탈해도 배경 inert 가 다음 화면에 남지 않게
    document.removeEventListener('keydown', escClose);
    document.body.style.overflow = '';
    // 운전 캡처 OFF 로 복원 — 회차를 떠나면 차/잠금화면 ⏭(nexttrack)이 다시 +30초 스킵이 되게 한다.
    // 없으면 캡처를 켠 채 라이브러리/학습으로 나가도 ⏭ 이 계속 '직전 회차 북마크'로 하이재킹된다
    // (다음 회차 진입 시 initDriveCapture 가 어차피 OFF 로 리셋하므로 회차↔회차 전환엔 무해). v1.41.0.
    setDrive(false);
    // 에피소드↔에피소드 전환에선 on-episode 유지 → 미니플레이어가 잠깐 보였다 사라지는 깜빡임 방지.
    if (!/^#?\/episode\/\d+/.test(location.hash)) document.body.classList.remove('on-episode');
    $sheet?.remove();
  }, { once: true });

  $play.addEventListener('click', () => player.toggle());
  $back.addEventListener('click', () => player.skip(-15));
  $fwd.addEventListener('click',  () => player.skip(30));
  // 메인 Now-Playing 화면의 ⏮/⏭ — 트랜스크립트와 동일 동작(시트는 안 열고 자동재생만, openScript=false).
  document.getElementById('np-prev')?.addEventListener('click', () => prevPress(false));
  document.getElementById('np-next')?.addEventListener('click', () => nextPress(false));
  $scrub.addEventListener('input', () => {
    const dur = player.duration;
    if (dur) player.seek(dur * parseFloat($scrub.value) / 100);
  });
  // 드래그 중 표시 — 이 사이엔 refresh 가 $scrub.value 를 안 덮어써 썸이 튀지 않는다(#6).
  ['pointerdown', 'touchstart'].forEach((ev) => $scrub.addEventListener(ev, () => { npScrubbing = true; }, { passive: true }));
  ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'change', 'blur'].forEach((ev) => $scrub.addEventListener(ev, () => { npScrubbing = false; }));
  $speed.addEventListener('click', () => setSpeed(speedIdx + 1));

  // Vocab 예문 시크만 여기(오디오 필요) — .tts/.vocab-known/prefetch 는 위 early-return 앞에서 배선됨.
  document.querySelectorAll('.vocab-card .ex').forEach((el) => {
    el.addEventListener('click', () => {
      const start = parseFloat(el.dataset.start || '0');
      if (start > 0) {
        player.seek(start);
        player.play();
      }
    });
  });

  // "스크립트로 보기" 진입 플래그(라이브러리/트랜스크립트 ⏮⏭ 에서 설정): 자동재생 + 시트 자동 열기.
  // aep-autoplay: 메인 화면 ⏮/⏭ 로 회차 이동 시 — 시트는 안 열고 자동재생만(메인 화면 유지).
  let wantScript = false;
  let wantAutoplay = false;
  try {
    const si = sessionStorage.getItem('aep-open-script');
    if (si && parseInt(si, 10) === ep.id) { wantScript = true; sessionStorage.removeItem('aep-open-script'); }
    const sa = sessionStorage.getItem('aep-autoplay');
    if (sa && parseInt(sa, 10) === ep.id) { wantAutoplay = true; sessionStorage.removeItem('aep-autoplay'); }
  } catch (e) {}

  // 시작 위치: 딥링크(:t) > 저장된 이어듣기 위치. 자동재생: 딥링크이거나 "스크립트로 보기"일 때.
  const seekTo = tStr != null ? parseFloat(tStr) : NaN;
  const prog = getProgress(ep.id);
  let startAt = null;
  if (Number.isFinite(seekTo) && seekTo > 0) startAt = seekTo;
  else if (prog && prog.t > 5 && (!prog.dur || prog.t < prog.dur - 10)) startAt = prog.t;
  const autoPlay = (Number.isFinite(seekTo) && seekTo > 0) || wantScript || wantAutoplay;
  if (startAt != null || autoPlay) {
    const go = () => { if (startAt != null) player.seek(startAt); if (autoPlay) player.play(); };
    if (player.duration) go();
    else { const offMeta = player.on((ev) => { if (ev === 'meta') { go(); offMeta(); } }); }
  }
  if (wantScript) openSheet();  // 트랜스크립트 시트 바로 열기

  refresh();
}

function bindSheetDrag($sheet, closeSheet) {
  const card = $sheet.querySelector('.tx-sheet-card');
  const header = $sheet.querySelector('.tx-sheet-header');
  if (!card || !header) return () => {};

  let dragging = false;
  let startY = 0;
  let lastY = 0;
  const THRESHOLD = 80;

  function start(y) {
    dragging = true;
    startY = y;
    lastY = y;
    card.style.transition = 'none';
  }
  function move(y) {
    if (!dragging) return;
    lastY = y;
    const delta = y - startY;
    // resist upward drag (sheet is already at top); free downward
    const visual = delta > 0 ? delta : delta * 0.25;
    card.style.transform = `translateY(${visual}px)`;
  }
  function end() {
    if (!dragging) return;
    dragging = false;
    const delta = lastY - startY;
    card.style.transition = '';
    card.style.transform = '';
    if (Math.abs(delta) > THRESHOLD) closeSheet();
  }

  header.addEventListener('touchstart', (e) => start(e.touches[0].clientY), { passive: true });
  header.addEventListener('touchmove',  (e) => move(e.touches[0].clientY),  { passive: true });
  header.addEventListener('touchend', end);
  header.addEventListener('touchcancel', end);

  header.addEventListener('mousedown', (e) => { e.preventDefault(); start(e.clientY); });
  // document 레벨 마우스 리스너는 렌더마다 쌓이면 누수(회차를 옮길수록 죽은 리스너 누적) →
  // 이름 있는 핸들러로 등록하고 destroy 를 반환해 cleanup 에서 제거한다.
  const onDocMove = (e) => { if (dragging) move(e.clientY); };
  document.addEventListener('mousemove', onDocMove);
  document.addEventListener('mouseup', end);
  return () => {
    document.removeEventListener('mousemove', onDocMove);
    document.removeEventListener('mouseup', end);
  };
}

// === 프리롤 광고(DAI) 구간 감지 (#) ===
// megaphone 동적광고(DAI)는 '재생할 때마다 다른' 광고를 끼워넣는다 → 우리가 STT 한 광고(자막)와
// 사용자가 실제로 듣는 광고(음성)가 서로 다르다. 그래서 광고 구간 자막은 음성과 절대 일치할 수 없다
// (재정렬·재STT 로도 못 고침). 본편 시작(진행자 인트로 "...my name is Shana...")을 앵커로 찾아
// 그 앞 광고 문장들을 자막에서 감추고 '광고' 플레이스홀더로 대체한다. 본편 자막/싱크는 손대지 않는다.
const AD_CONTENT_RE = /(my name is sh|welcome to the american english|this is the american english podcast)/i;
const AD_GREET_RE = /^["'\s]*(hi\b|hey\b|hello\b|welcome back|what'?s up|good (morning|afternoon|evening))/i;
export function detectContentStart(sentences) {
  const limit = Math.min(sentences.length, 50);  // 프리롤 영역만 탐색(본편/아웃트로 언급 오탐 방지)
  for (let i = 0; i < limit; i++) {
    if (AD_CONTENT_RE.test(sentences[i].text || '')) {
      let k = i;  // 바로 앞 인사말("Hi everybody")이 있으면 그것을 본편 시작으로 포함
      for (let j = i - 1; j >= 0 && j >= i - 2; j--) {
        if (AD_GREET_RE.test(sentences[j].text || '')) k = j; else break;
      }
      return k;
    }
  }
  return 0;  // 앵커 없음 → 아무것도 감추지 않음(안전 폴백 — 기존 동작 유지)
}
// === 미드롤/엔드롤 광고(DAI) 감지 — 서드파티 광고 신호 점수화 ===
// 본편 중간/끝의 서드파티 광고(windows.com·blinds.com·"45% off"·"terms apply"·"learn more at"…)는
// DAI 라 음성과 다르다. Shana 자체 홍보(AmericanEnglishPodcast.com/Academy/premium)는 베이크된
// 콘텐츠라 싱크 정상 → 광고로 보지 않는다(화이트리스트). 오탐("go to Virginia city" 등) 방지 위해
// 강한 신호 점수≥3(앵커) 또는 ≥3문장 클러스터만 광고로 인정.
const AD_SELF_RE = /(americanenglishpodcast\.com|the academy|premium content|episode notes)/i;
function adScore(text) {
  const t = String(text || '').toLowerCase();
  if (!t || AD_SELF_RE.test(t)) return 0;                  // 빈문장/자체홍보 제외
  let s = 0;
  if (/\b[a-z][a-z0-9-]*\.com\b/.test(t)) s += 2;          // 서드파티 도메인
  if (/promo code|use code|coupon code/.test(t)) s += 2;
  if (/free trial|terms (and conditions )?apply|rules (and restrictions )?apply/.test(t)) s += 2;
  if (/brought to you by|sponsored by|this episode is sponsored/.test(t)) s += 2;
  if (/\d{1,3}\s?% off|percent off/.test(t)) s += 1;
  if (/learn more at|subscribe now at|sign up (now|today)|offer ends|limited[- ]time/.test(t)) s += 1;
  if (/\bslash\b/.test(t)) s += 1;                          // 광고 URL 읽기 "X.com slash Y"
  return s;
}
// 광고 시간구간 [{s,e}] (문장 인덱스, 끝 배타적). 프리롤(인트로 앵커 앞) + 강한 광고 클러스터.
export function detectAdRanges(sentences) {
  const ranges = [];
  const K = detectContentStart(sentences);
  if (K > 0) ranges.push({ s: 0, e: K });
  const score = sentences.map((x) => adScore(x.text));
  let i = Math.max(K, 0);
  while (i < sentences.length) {
    if (score[i] >= 2) {
      let last = i, gap = 0, maxs = score[i], cnt = 1;
      for (let k = i + 1; k < sentences.length; k++) {
        if (score[k] >= 2) { last = k; gap = 0; maxs = Math.max(maxs, score[k]); cnt++; }
        else { gap++; if (gap > 1) break; }   // 광고 사이 1문장 갭까지 한 블록으로 연결
      }
      if (maxs >= 3 || cnt >= 3) { ranges.push({ s: i, e: last + 1 }); i = last + 1; continue; }
    }
    i++;
  }
  ranges.sort((a, b) => a.s - b.s);
  const merged = [];
  for (const r of ranges) {                    // 인접/겹침 병합(프리롤+첫 클러스터 등)
    const prev = merged[merged.length - 1];
    if (prev && r.s <= prev.e) prev.e = Math.max(prev.e, r.e);
    else merged.push({ ...r });
  }
  return merged;
}
function adBarHtml(adStart, resumeStart, isPre) {
  return `<button class="tx-ad-skip" type="button" data-start="${adStart}" data-end="${resumeStart}" data-skip="${resumeStart}" aria-label="Skip ad to episode">
    <span class="tx-ad-ico">📢</span>
    <span class="tx-ad-text"><b>Ad break</b><small>Audio ads vary each play, so they may differ from the script</small></span>
    <span class="tx-ad-go">${isPre ? 'To episode' : 'Skip'} ›</span>
  </button>`;
}

function transcriptSheetHtml(segments, title, sub, perfectSync) {
  // 광고(DAI) 구간을 감지해 자막에서 감추고 '광고' 바로 대체. 본편 문장의 타임스탬프는 그대로 두므로
  // 광고가 끝나면 다음 본편 문장이 제 시각에 하이라이트된다(싱크 보존). 광고 없으면 전부 표시(폴백).
  const adRanges = detectAdRanges(segments);
  const isAd = new Array(segments.length).fill(false);
  for (const r of adRanges) for (let i = r.s; i < r.e; i++) isAd[i] = true;

  const renderPara = (para) => {
    const sentsHtml = para.segments.map((s) =>
      `<span class="tx-sent" data-i="${s._idx}" data-start="${s.start}" data-end="${s.end}">${renderSegmentWords(s)}</span>`).join(' ');
    return `<p class="tx-para" data-start="${para.start}" data-end="${para.end}">
      <span class="ts">${escapeHtml(fmtTime(para.start))}</span>${sentsHtml}
    </p>`;
  };
  // 본편 run + 광고 바(자리표시)를 교대로 조립. 본편 문장에만 _idx 부여(하이라이트 대상).
  let ci = 0, i = 0, body = '';
  while (i < segments.length) {
    if (isAd[i]) {
      const r = adRanges.find((x) => x.s === i) || { e: i + 1 };
      const adStart = Number.isFinite(segments[i].start) ? segments[i].start : 0;
      const resume = segments[r.e] ? segments[r.e].start : (segments[r.e - 1]?.end ?? adStart);
      body += adBarHtml(adStart, resume, r.s === 0);
      i = r.e;
    } else {
      const run = [];
      while (i < segments.length && !isAd[i]) { segments[i]._idx = ci++; run.push(segments[i]); i++; }
      body += groupIntoParagraphs(run).map(renderPara).join('');
    }
  }

  return `
    <div class="tx-sheet" role="dialog" aria-modal="true" aria-label="Transcript" aria-hidden="true">
      <div class="tx-sheet-backdrop"></div>
      <div class="tx-sheet-card">
        <div class="tx-sheet-bg" style="background-image:url('${COVER()}')"></div>
        <div class="tx-sheet-header">
          <div class="tx-sheet-handle"></div>
          <h3 class="tx-sheet-title">${escapeHtml(title || 'Transcript')}</h3>
          ${sub ? `<div class="tx-sheet-sub">${escapeHtml(sub)}</div>` : ''}
          <button class="tx-sheet-close" aria-label="Close">×</button>
        </div>
        <div class="tx-card">
          <div class="tx-toolbar">
            <button id="tx-trans" class="tx-toggle tx-trans-toggle" aria-pressed="false" aria-label="Korean translation">KR</button>
            <button id="tx-ko-size" class="tx-toggle tx-ko-size-btn" aria-label="Translation text size">가</button>
            <button id="tx-shadow" class="tx-toggle tx-loop-toggle" aria-pressed="false" aria-label="Shadowing mode">Shadow</button>
            <button id="tx-speed" class="tx-toggle tx-speed-toggle" aria-label="Playback speed">1×</button>
            <button id="tx-fs" class="tx-toggle tx-fs-btn" aria-label="Text size" title="글자 크기">A</button>
            <button id="tx-drive" class="tx-toggle tx-drive-btn" aria-pressed="false" aria-label="Drive capture">${SVG_CAR}</button>
          </div>
          ${(!perfectSync && adRanges.length) ? `
          <div class="tx-drift-note" id="tx-drift-note" role="note">
            <span class="tx-drift-txt">이 회차는 아직 완전 자동싱크 전이에요 — 광고 뒤 자막이 밀리면 문장을 탭해 맞추세요</span>
            <button class="tx-drift-x" id="tx-drift-x" aria-label="닫기">×</button>
          </div>` : ''}
          <div class="tx-scroll">
            ${body}
          </div>
        </div>
        <button class="tx-live-badge" type="button" aria-label="Resume auto-follow">↓ Now playing</button>
        <div class="tx-notes" aria-hidden="true"></div>
        <div class="tx-sheet-controls">
          <div class="tx-seek" id="tx-seek">
            <div class="tx-seek-track" id="tx-seek-track">
              <span class="tx-seek-fill" id="tx-seek-fill"></span>
              <span class="tx-seek-handle" id="tx-seek-handle"></span>
            </div>
            <div class="tx-seek-times"><span id="tx-seek-cur">0:00</span><span id="tx-seek-rem">-0:00</span></div>
          </div>
          <div class="tx-ctrl-row">
            <button class="tx-mini-btn tx-sent-btn" id="tx-prev-sent" aria-label="Restart / previous episode">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M7 6h2.2v12H7zM19 6v12l-8.5-6z"/></svg>
            </button>
            <button class="tx-mini-btn" id="tx-mini-back" aria-label="Back 15s">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
              <span class="skip-num">15</span>
            </button>
            <button class="tx-mini-play" id="tx-mini-play" aria-label="Play/Pause">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
            </button>
            <button class="tx-mini-btn" id="tx-mini-fwd" aria-label="Forward 30s">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
              <span class="skip-num">30</span>
            </button>
            <button class="tx-mini-btn tx-sent-btn" id="tx-next-sent" aria-label="Next episode">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M14.8 6H17v12h-2.2zM5 6l8.5 6L5 18z"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// === 문장 난이도 판정 (#8) ===
// "조금이라도 easy 가 아닌" 문장만 번역카드를 띄운다. 흔한 기초 단어로만 이뤄진 짧은 문장은 easy.
// 길이≥4 인 단어 중 COMMON 목록에 없는 단어가 하나라도 있거나, 문장이 길면 not-easy 로 본다(번역 노출).
const COMMON_EASY = new Set((
  'the a an and or but so if then than that this these those there here when while because as of to in on ' +
  'at by for with from into over under about after before up down out off again very just only also too not no ' +
  'yes yeah okay ok well right sure i you he she it we they me him her us them my your his its our their mine ' +
  'is am are was were be been being do does did done have has had having will would can could shall should may ' +
  'might must want wants wanted need needs go goes went gone going get gets got gotten come comes came make makes ' +
  'made take takes took know knows knew think thinks see sees saw look looks like likes feel feels say says said ' +
  'tell told give gives gave find found use uses used work works call calls try keep let put mean means ' +
  'good bad nice great big small long short high low new old same other more most much many some any each every ' +
  'all both few little lot kind sort thing things people person man woman kid day days time year week now today ' +
  'really pretty maybe always never often sometimes still even back away around down what who how why which whose ' +
  'one two three first last next another such own way ways part lot bit'
).split(/\s+/).filter(Boolean));

function easyByWords(text) {
  const words = String(text || '').toLowerCase().match(/[a-z']+/g) || [];
  if (!words.length) return true;
  if (words.length > 9) return false;                 // 긴 문장 → not easy
  for (const w of words) {
    if (w.length >= 4 && !COMMON_EASY.has(w)) return false;  // 흔치 않은 단어 포함 → not easy
  }
  return true;
}

// translateEnKo 는 /translate.js 로 분리(episode·study 공용). 아래는 per-episode 표시 캐시만 유지.
// 번역 캐시 키 = '문장 텍스트'(정규화). 인덱스 기준이면 resegment/광고 슬라이스로 문장 경계가 바뀔 때
// 같은 인덱스가 다른 문장을 가리켜 번역이 엉뚱한 문장에 붙는다(영↔한 mismatch). 텍스트 기준이면 안전.
function trKey(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 180);
}
function loadTrCache(epId) {
  try { localStorage.removeItem('aep-tr-' + epId); } catch (e) {}  // 구버전(인덱스 기반) 캐시 폐기 → mismatch 원인 제거
  try { return JSON.parse(localStorage.getItem('aep-trk-' + epId) || '{}'); } catch { return {}; }
}
function saveTrCache(epId, obj) {
  try { localStorage.setItem('aep-trk-' + epId, JSON.stringify(obj)); } catch (e) { /* quota */ }
}

function resegment(segments) {
  // Whisper segment 는 문장 경계를 무시한 ~5초 덩어리다. 단어 타임스탬프를 모아
  // 구두점 기준으로 진짜 "문장"으로 재분할한다(정확한 start/end 보존) → 싱크·스크롤 정확도↑.
  const words = [];
  for (const seg of segments || []) {
    if (seg.words && seg.words.length) {
      for (const w of seg.words) {
        if (w.word == null) continue;
        words.push({ word: w.word, start: w.start ?? seg.start, end: w.end ?? seg.end });
      }
    } else if (seg.text) {
      words.push({ word: seg.text, start: seg.start, end: seg.end });
    }
  }
  if (!words.length) return segments || [];

  // 광고/낭독처럼 구두점이 거의 없는 run-on 도 적절한 길이로 자른다:
  //  ① 종결 구두점(.?!…)  ② 문장 사이 큰 쉼(gap)  ③ 긴 절의 콤마  ④ 길이 하드캡.
  const ENDS = /[.!?…]["')\]]?$/;
  const COMMA = /[,;:]["')\]]?$/;
  // 등위·종속 접속사 앞은 영어 절(clause)이 자연스럽게 갈리는 지점. 절이 이미 길면 '그 앞'에서
  // 끊어 "…is so | alive", "…layer of | yellow" 같은 구(句) 중간 하드캡 절단을 막는다.
  // 관계대명사(that/which/who)는 제외 — "the pollen that is in our area" 처럼 붙어야 자연스러운 절을 안 쪼개려고.
  const CONJ = /^(and|but|so|or|because|when|while|if|since|though|although|unless)$/i;
  // 종결 구두점이 빠진(소형 STT) 자막에서도 문장 경계를 잡는 대문자 '문장-시작어'. 절이 ≥3단어
  // 찼고 다음 단어가 대문자 시작어(But/They/If/He…)면 그 앞에서 끊는다('I'·고유명사는 목록에 없어 제외).
  const STARTER = /^(But|And|So|Or|Now|Then|Well|Yeah|Yes|No|Okay|OK|Here|There|This|That|These|Those|He|She|It|They|We|You|Who|If|When|Where|What|Why|How|Because|Although|Though|While|Since|Maybe|Actually|Finally|However|Meanwhile|Anyway|Plus|Also)$/;
  const out = [];
  let cur = null;
  let prevEnd = null;
  const close = () => {
    cur.text = cur.words.map((x) => x.word).join('').trim();
    out.push(cur); cur = null;
  };
  for (const w of words) {
    const gap = (prevEnd != null && Number.isFinite(w.start)) ? (w.start - prevEnd) : 0;
    // ② 쉼(gap) 기반 분할 — diarization 없이 화자 전환/문장 경계를 추정한다.
    //    큰 쉼(≥0.8s)은 거의 항상 경계(화자 교대 포함)라 짧아도 끊고, 중간 쉼(≥0.45s)은
    //    절이 어느 정도 찼을 때만 끊는다 → Shana↔게스트가 한 문장으로 길게 이어지던 문제(#) 완화.
    if (cur && (gap > 1.5 ||                       // 큰 비발화 간격(긴 쉼·음악·광고구간 등)은 단어수 무관 분리
                (cur.words.length >= 3 && gap > 0.8) ||
                (cur.words.length >= 7 && gap > 0.45))) close();
    // ②' 접속사 앞 분할 — 절이 충분히 길 때(≥11단어) 접속사 '앞'에서 끊어 구 중간 절단 방지.
    if (cur && cur.words.length >= 11) {
      const lead = (w.word || '').trim().replace(/^[^A-Za-z']+/, '').toLowerCase();
      if (CONJ.test(lead)) close();
    }
    // ②'' 대문자 문장-시작어 앞 분할 — 구두점이 빠진 자막의 문장 경계 복원(절이 ≥3단어일 때).
    if (cur && cur.words.length >= 3) {
      const raw = (w.word || '').trim().replace(/^[^A-Za-z']+/, '');
      if (/^[A-Z]/.test(raw) && STARTER.test(raw.split("'")[0])) close();
    }
    if (!cur) cur = { start: w.start, end: w.end, words: [] };
    cur.words.push(w);
    if (Number.isFinite(w.end)) { cur.end = w.end; prevEnd = w.end; }
    const txt = (w.word || '').trim();
    const n = cur.words.length;
    const dur = cur.end - cur.start;
    if ((ENDS.test(txt) && n >= 2) ||           // ① 종결 구두점
        (COMMA.test(txt) && n >= 7) ||          // ③ 긴 절은 콤마에서(9→7: 더 짧게)
        dur > 9 || n >= 14) {                   // ④ 하드캡 — 18w/12s→14w/9s: 한 문장이 4줄↑로
                                                //    번역카드와 겹쳐 안 보이던 문제 방지(전체적으로 짧게)
      close();
    }
  }
  if (cur) { cur.text = cur.words.map((x) => x.word).join('').trim(); out.push(cur); }
  return out;
}

function groupIntoParagraphs(segments) {
  const out = [];
  let cur = null;
  const endsSentence = (txt) => /[.!?…]["')\]]?\s*$/.test((txt || '').trim());
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const prev = i > 0 ? segments[i - 1] : null;
    const gap = prev ? s.start - prev.end : 0;
    const prevEnds = prev && endsSentence(prev.text);
    const paraLen = cur && prev ? prev.end - cur.start : 0;

    // 자연스러운 단락: 문장 끝에서 2~3문장마다, 또는 큰 쉼에서만 끊는다(절 중간 금지).
    let brk = false;
    if (!cur) brk = true;
    else if (prevEnds && (cur._sents >= 2 || paraLen > 9)) brk = true;
    else if (prevEnds && gap > 0.5) brk = true;
    else if (gap > 1.6) brk = true;
    else if (paraLen > 16) brk = true;  // 안전 상한

    if (brk) {
      cur = { start: s.start, end: s.end, segments: [s], _sents: 0 };
      out.push(cur);
    } else {
      cur.segments.push(s);
      cur.end = s.end;
    }
    if (endsSentence(s.text)) cur._sents++;
  }
  return out;
}

function renderSegmentWords(seg) {
  const words = seg.words;
  if (!words || !words.length) {
    // fallback: split by whitespace, distribute time evenly
    const parts = (seg.text || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    const dur = (seg.end - seg.start) || 0.001;
    const per = dur / parts.length;
    return parts.map((w, i) => {
      const ws = seg.start + per * i;
      const we = seg.start + per * (i + 1);
      return `<span class="w" data-s="${ws.toFixed(2)}" data-e="${we.toFixed(2)}">${escapeHtml(w)}</span>`;
    }).join(' ');
  }
  // whisper 단어는 앞 공백으로 띄어쓰기를 인코딩한다(" U" = 공백+U, ".S." = 앞단어에 이어붙임).
  // 그 규칙을 보존: 앞 공백 있으면 span 앞에 공백 텍스트노드, 없으면 그대로 이어붙여 "U.S." 가 "U .S." 로
  // 벌어지지 않게 한다. (전부 .join(' ') 하면 ".S." 앞에 잘못된 공백이 생겼던 버그)
  return words.map((w) => {
    const raw = (w.word || '');
    const lead = /^\s/.test(raw) ? ' ' : '';
    const txt = raw.replace(/^\s+/, '');
    const start = (w.start ?? seg.start);
    const end   = (w.end   ?? seg.end);
    return `${lead}<span class="w" data-s="${(+start).toFixed(2)}" data-e="${(+end).toFixed(2)}">${escapeHtml(txt)}</span>`;
  }).join('');
}

// 회차 화면에서 '알아요' 처리한 vocab id (localStorage) — 재방문 시 흐리게 표시.
// SRS 마스터(markKnown)와 별개의 로컬 힌트라, 오프라인/SRS 카드 부재에도 카드 상태가 유지된다.
const VKNOWN_KEY = 'aep-vocab-known';
function loadVKnown() { try { return new Set(JSON.parse(localStorage.getItem(VKNOWN_KEY) || '[]')); } catch { return new Set(); } }
function saveVKnown(set) { try { localStorage.setItem(VKNOWN_KEY, JSON.stringify([...set])); } catch (e) { /* quota */ } }

function vocabHtml(v, known) {
  const kind = v.kind || 'word';
  const ex = v.example_sentence
    ? `<p class="ex" data-start="${v.sentence_start_sec || 0}">${escapeHtml(v.example_sentence)}</p>`
    : '';
  const isKnown = known && known.has(v.id);
  return `
    <li class="vocab-card ${kind}${isKnown ? ' vknown' : ''}" data-id="${v.id}">
      <div class="term">
        <span>${escapeHtml(v.term)}</span>
        <button class="tts" data-text="${escapeHtml(v.term)}" aria-label="Play pronunciation">▶</button>
        <span class="chip ${kind}" style="margin-left:auto">${escapeHtml(kind.replace('_', ' '))}</span>
      </div>
      ${v.definition ? `<p class="def">${escapeHtml(v.definition)}</p>` : ''}
      ${ex}
      <button class="vocab-known" data-id="${v.id}" aria-pressed="${isKnown ? 'true' : 'false'}">${isKnown ? '✓ 알아요' : '알아요'}</button>
    </li>
  `;
}
