// Now Playing — large cover, scrubber, transport, transcript + vocab below.
import { escapeHtml, fmtTime, fmtDate, fmtDuration } from '/app.js';
import { getEpisode } from '/db.js';
import { speak, prefetch } from '/tts.js';
import { player, getProgress } from '/player.js';
import { SHOW_COVER, SHOW_COVER_SM } from '/config.js';
import { translateEnKo } from '/translate.js';

const SVG_PLAY  = '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';
const SVG_PAUSE = '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const SVG_MINI_PLAY  = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';
const SVG_MINI_PAUSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const SVG_BACK15 = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
const SVG_FWD30 = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';

// 1× 에서 탭마다 1.25 → 1.5 → 0.5 → 0.75 → 1.0 → 1.25 … 순환 (사용자 지정 순서)
const SPEEDS = [1, 1.25, 1.5, 0.5, 0.75];

export async function renderEpisode(root, idStr, tStr) {
  const id = parseInt(idStr, 10);
  const ep = await getEpisode(id);
  document.body.classList.add('on-episode');
  // Safeguard: even if we early-return below, ensure the class is removed on nav away.
  window.addEventListener('hashchange', () => document.body.classList.remove('on-episode'), { once: true });

  const segments = ep.transcript?.segments || [];
  const sentences = resegment(segments);  // Whisper segment → 구두점 기준 진짜 문장
  const vocabs = ep.vocab || [];

  const showLabel = `S${ep.season ?? '–'}${ep.episode_no != null ? ` · E${ep.episode_no}` : ''} · ${fmtDate(ep.pub_date)}`;
  const txTitle = (ep.title || '').replace(/^\d+\s*[-:.]\s*/, '');

  root.innerHTML = `
    <div class="np-wrap">
      <div class="np-cover-wrap">
        <div class="np-glow" style="background-image:url('${SHOW_COVER}')"></div>
        <img class="np-cover" src="${SHOW_COVER}" alt="" onerror="this.src='/icons/icon-512.png'" />
      </div>
      <div class="np-meta">
        <div class="np-show">${escapeHtml(showLabel)}</div>
        <h1 class="np-title">${escapeHtml((ep.title || '').replace(/^\d+\s*[-:.]\s*/, ''))}</h1>
        <p class="np-subtitle">${ep.duration_sec ? escapeHtml(fmtDuration(ep.duration_sec)) : ''}</p>
      </div>
      ${ep.audio_url ? `
        <div class="np-scrubber">
          <input id="np-scrub" type="range" min="0" max="100" step="0.1" value="0" />
          <div class="np-times">
            <span id="np-cur">0:00</span>
            <span id="np-rem">-0:00</span>
          </div>
        </div>
        <div class="np-controls">
          <button class="np-ctrl-btn" id="np-back" aria-label="Back 15s">${SVG_BACK15}<span class="skip-num">15</span></button>
          <button class="np-play-btn" id="np-play" aria-label="Play/Pause">${SVG_PLAY}</button>
          <button class="np-ctrl-btn" id="np-fwd" aria-label="Forward 30s">${SVG_FWD30}<span class="skip-num">30</span></button>
        </div>
        <div class="np-extras">
          <button class="speed" id="np-speed">1×</button>
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
      </div>
    ` : ''}

    ${vocabs.length ? `
      <div class="section-h"><h2>Vocabulary</h2><span class="count">${vocabs.length}</span></div>
      <ul class="vocab-list">
        ${vocabs.map((v) => vocabHtml(v)).join('')}
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
      wrap.innerHTML = transcriptSheetHtml(sentences, txTitle, showLabel).trim();
      $sheet = wrap.firstElementChild;
      document.body.appendChild($sheet);
    } catch (err) {
      console.error('[transcript] sheet build failed:', err);
      $sheet = null;
    }
  }

  // openSheet/closeSheet/escClose defined below, after state vars.
  let escClose = () => {};

  // About 설명 펼치기/접기 (audio 유무와 무관하게 동작하도록 early-return 앞에 둠)
  document.getElementById('np-about-text')?.addEventListener('click', (e) => e.currentTarget.classList.toggle('expanded'));

  if (!ep.audio_url) {
    return; // no playback wiring needed
  }

  // Connect to global player
  const track = {
    id: ep.id,
    title: (ep.title || '').replace(/^\d+\s*[-:.]\s*/, ''),
    show: 'American English Podcast',
    cover: SHOW_COVER_SM,
    src: ep.audio_url,
  };
  player.load(track);

  const $play  = document.getElementById('np-play');
  const $back  = document.getElementById('np-back');
  const $fwd   = document.getElementById('np-fwd');
  const $scrub = document.getElementById('np-scrub');
  const $cur   = document.getElementById('np-cur');
  const $rem   = document.getElementById('np-rem');
  const $speed = document.getElementById('np-speed');
  let speedIdx = 0;
  let shadowMode = 'off';  // off | loop(문장 반복)
  let loopPara = -1, loopStart = 0, loopEnd = 0;  // 반복 모드: 되풀이할 '문단'과 그 시작/끝(자막시각)

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
  let _trSeq = 0;

  function refresh() {
    const dur = player.duration;
    if (dur) {
      $scrub.value = (player.time / dur * 100).toFixed(2);
      $cur.textContent = fmtTime(player.time);
      $rem.textContent = '-' + fmtTime(Math.max(0, dur - player.time));
    }
    const playIcon = player.paused ? SVG_PLAY : SVG_PAUSE;
    $play.innerHTML = playIcon;
    const $miniPlay = document.getElementById('tx-mini-play');
    if ($miniPlay) $miniPlay.innerHTML = player.paused ? SVG_MINI_PLAY : SVG_MINI_PAUSE;
    highlightActiveSegment();

    // 쉐도잉 반복(loop): 누를 때 확정한 '문단' 전체를 끝(마지막 문장)에서 처음(첫 문장)으로 되돌려
    // 무한 반복. 문단 안에선 문장이 정상 진행·하이라이트되고, 문단 끝에서만 처음으로 되감는다.
    if (shadowMode === 'loop' && loopPara >= 0 && !player.paused) {
      if (Number.isFinite(loopEnd) && txTime() >= loopEnd - 0.06) {
        player.seek(toAudio(loopStart) + 0.01);
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
  // Cache offsetTop now (stable until DOM mutates) — survives scroll animations.
  const paraTops = paraEls.map((el) => el.offsetTop);

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
  // 해설 패널의 표현 탭 → 발음 재생 (쉐도잉 중 어려운 표현을 바로 듣고 따라하기)
  if ($notes) $notes.addEventListener('click', (e) => {
    const b = e.target.closest('.tx-note-tts');
    if (b) { e.stopPropagation(); speak(b.dataset.text); }
  });
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
    const seq = ++_trSeq;
    const ko = await translateEnKo(text);   // 절대 throw 안 함
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
      if (t2 && _trCache[ck2] == null) translateEnKo(t2).then((k) => { if (k) { _trCache[ck2] = k; saveTrCache(ep.id, _trCache); } });
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
  let autoScrollUntil = 0;       // (레거시) — 부드러운 ease 로 대체되어 게이트엔 더 안 씀

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
    if (!sentRanges.length) return;
    let t = txTime();
    // 반복 모드: 문단 끝에서 처음으로 되감은 직후 txTime 이 HL_LAG(0.2s)만큼 뒤로 가 직전 문단이
    // 잠깐 잡히는 것 방지 — 활성 판정 시각을 반복 문단 시작 아래로 안 내려가게 클램프.
    if (shadowMode === 'loop' && loopPara >= 0) t = Math.max(t, loopStart);
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
    if (idx === lastActiveSent) return;

    if (lastActiveSent >= 0 && sentRanges[lastActiveSent]) {
      sentRanges[lastActiveSent].el.classList.remove('active');
    }
    if (idx >= 0) sentRanges[idx].el.classList.add('active');
    lastActiveSent = idx;
    renderNotes(idx);  // 현재 문장의 어려운 표현 해설을 하단 패널에

    const scroll = document.querySelector('.tx-scroll');
    const txCard = document.querySelector('.tx-card');

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
    const userActive = Date.now() < userScrolledUntil;
    if (idx >= 0 && scroll && !userActive) {
      const cont = scroll.getBoundingClientRect();
      const h = scroll.clientHeight;
      const sRect = sentRanges[idx].el.getBoundingClientRect();
      const sRelTop = sRect.top - cont.top, sRelBot = sRect.bottom - cont.top;
      let target = null;
      if (paraChanged) {
        const pTop = sentRanges[idx].paraEl.getBoundingClientRect().top - cont.top + scroll.scrollTop;
        target = pTop - Math.max(8, h * 0.16);
      } else if (sRelBot > h * (showTrans ? 0.58 : 0.90) || sRelTop < h * 0.04) {
        // 번역카드(하단 오버레이)가 켜져 있으면 활성 문장을 더 위(20%)로 올려 카드와 안 겹치게.
        target = sRelTop + scroll.scrollTop - Math.max(8, h * (showTrans ? 0.20 : 0.30));
      }
      if (target != null) {
        const clamped = Math.max(0, Math.min(target, scroll.scrollHeight - h));
        const ref = scrollTarget != null ? scrollTarget : scroll.scrollTop;  // rAF ease 로 부드럽게
        if (Math.abs(clamped - ref) > 2) smoothScrollTo(clamped);
      }
    }
    txCard?.classList.toggle('live', !userActive);
    txCard?.classList.toggle('no-follow', userActive);
  }

  // Detect REAL user-initiated scrolling via wheel/touch — not via 'scroll' event,
  // because our own programmatic smooth-scroll fires scroll events for ~600ms.
  const $txScroll = document.querySelector('.tx-scroll');
  if ($txScroll) {
    // cancel=true 인 실제 스크롤 제스처(휠/드래그/스크롤키)에선 진행 중인 auto-ease 를 즉시 멈춤.
    // 단순 탭(touchstart)은 cancel 하지 않음 → 단어 탭→가운데 정렬 ease 가 살아있게.
    const markUser = (cancel) => { userScrolledUntil = Date.now() + 4000; if (cancel) cancelEase(); };
    $txScroll.addEventListener('wheel', () => markUser(true), { passive: true });
    $txScroll.addEventListener('touchstart', () => markUser(false), { passive: true });
    $txScroll.addEventListener('touchmove', () => markUser(true), { passive: true });
    $txScroll.addEventListener('keydown', (e) => {
      if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key)) markUser(true);
    });
  }

  // Click in transcript → seek + scroll the SENTENCE to viewport center
  const $tx = document.querySelector('.tx-scroll');
  function scrollSentToCenter(sentEl) {
    if (!sentEl || !$tx) return;
    const rect = sentEl.getBoundingClientRect();
    const cont = $tx.getBoundingClientRect();
    const elTop = rect.top - cont.top + $tx.scrollTop;
    const target = elTop - $tx.clientHeight / 2 + rect.height / 2;
    userScrolledUntil = Date.now() + 3000;  // give user 3s to read before auto-follow resumes
    smoothScrollTo(Math.max(0, target));    // 부드러운 ease 로 가운데 정렬
  }
  // 단어/문장 탭으로 그 지점부터 재생할 때: 이미 화면에 잘 보이면 스크롤하지 않는다(사용자 보고:
  // 탭하면 화면이 '밀리며' 시작되는 위화감 제거 → 탭한 그 자리에서 바로 시작). 머리가 잘리거나
  // 하단 번역·컨트롤에 가리거나 화면 밖일 때만 자동추적과 동일한 22% 줄에 살짝 정렬한다.
  function scrollSentIntoViewIfNeeded(sentEl) {
    if (!sentEl || !$tx) return;
    userScrolledUntil = Date.now() + 3000;  // 어느 경우든 자동추적은 3s 보류(탭 지점 유지)
    const rect = sentEl.getBoundingClientRect();
    const cont = $tx.getBoundingClientRect();
    const relTop = rect.top - cont.top, relBot = rect.bottom - cont.top;
    const h = $tx.clientHeight;
    if (relTop >= h * 0.12 && relBot <= h * 0.60) return;   // 편안한 밴드 안 → 그대로 둔다
    const target = relTop + $tx.scrollTop - Math.max(8, h * 0.22);
    smoothScrollTo(Math.max(0, Math.min(target, $tx.scrollHeight - h)));
  }
  // (수동 싱크 보정 UI 제거됨 — 모든 회차가 R2 재STT 로 자동 싱크(offset 0))

  if ($tx) {
    $tx.addEventListener('click', (e) => {
      const w = e.target.closest('.w');
      const sent = e.target.closest('.tx-sent');
      const para = e.target.closest('.tx-para');
      let txSec = null;
      if (w)        txSec = parseFloat(w.dataset.s);
      else if (sent) txSec = parseFloat(sent.dataset.start);
      else if (para) txSec = parseFloat(para.dataset.start);
      if (txSec == null) return;
      // 반복 중에 다른 문장을 탭하면, 그 문장이 속한 문단으로 반복 대상을 옮긴다(그 문장이 반복됨).
      if (shadowMode === 'loop') {
        const pEl = para || (sent && sent.closest('.tx-para'));
        const ps = pEl ? sentRanges.filter((s) => s.paraEl === pEl) : [];
        if (ps.length) {
          loopPara = paraEls.indexOf(pEl);
          loopStart = ps[0].start;
          loopEnd = ps[ps.length - 1].end;
        }
      }
      player.seek(toAudio(txSec));   // 자막 시각 → 오디오 시각
      player.play();
      scrollSentIntoViewIfNeeded(sent || para);   // 이미 보이면 안 움직임(탭 그 자리서 시작)
    });
  }

  // "Now playing" badge tap → resume auto-follow
  const $card = document.querySelector('.tx-card');
  document.querySelector('.tx-live-badge')?.addEventListener('click', () => {
    userScrolledUntil = 0;
    lastActivePara = -1;  // force re-trigger of scroll on next update
    highlightActiveSegment();
  });

  // === Sheet open/close (defined here so it can read state vars and fns above) ===
  function openSheet() {
    if (!$sheet) return;
    $sheet.classList.add('open');
    $sheet.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    // Wipe ALL state and stale classes, then re-evaluate from current player time.
    setTimeout(() => {
      sentRanges.forEach((s) => s.el.classList.remove('active'));
      paraEls.forEach((p) => p.classList.remove('active', 'played'));
      lastActiveSent = -1;
      lastActivePara = -1;
      autoScrollUntil = 0;
      userScrolledUntil = 0;
      highlightActiveSegment();
      showControls();  // 열 때 컨트롤 표시 후 잠시 뒤 자동 숨김
    }, 80);
  }
  function closeSheet() {
    if (!$sheet) return;
    $sheet.classList.remove('open');
    $sheet.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }
  escClose = (e) => { if (e.key === 'Escape') closeSheet(); };
  document.addEventListener('keydown', escClose);
  document.getElementById('np-tx-btn')?.addEventListener('click', openSheet);
  $sheet?.querySelector('.tx-sheet-close')?.addEventListener('click', closeSheet);
  $sheet?.querySelector('.tx-sheet-backdrop')?.addEventListener('click', closeSheet);
  if ($sheet) bindSheetDrag($sheet, closeSheet);
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
  // 쉐도잉(off) ↔ 반복(loop) 2단계 토글. 문장멈춤(pause)은 제거(사용자 요청).
  const SHADOW = [
    { mode: 'off',  label: '🔁 Shadow', on: false },
    { mode: 'loop', label: '🔁 Repeat', on: true },
  ];
  let shadowIdx = 0;
  const $shadow = document.getElementById('tx-shadow');
  $shadow?.addEventListener('click', (e) => {
    e.stopPropagation();
    shadowIdx = (shadowIdx + 1) % SHADOW.length;
    const s = SHADOW[shadowIdx];
    shadowMode = s.mode;
    $shadow.textContent = s.label;
    $shadow.classList.toggle('on', s.on);
    $shadow.setAttribute('aria-pressed', s.on ? 'true' : 'false');
    if (shadowMode === 'loop') {
      // 누르는 즉시 처음으로 점프하지 않는다 — 지금 위치에서 그 '문단' 끝까지 자연스럽게 읽은 뒤,
      // 문단 끝에서 처음으로 되감아 반복(사용자 요청). 현재 문장이 속한 문단으로 경계만 확정.
      const si = findActiveSentIdx(player.time - syncOffset);
      if (si >= 0 && sentRanges[si]) {
        const paraEl = sentRanges[si].paraEl;
        const ps = sentRanges.filter((s) => s.paraEl === paraEl);
        loopPara = paraEls.indexOf(paraEl);
        loopStart = ps[0].start;
        loopEnd = ps[ps.length - 1].end;
        userScrolledUntil = 0;   // 자동추적 재개
      }
    } else {
      loopPara = -1;
    }
    if (player.paused) player.play();  // 모드 전환 즉시 이어 재생 (반복→쉐도잉도 버튼 없이 바로 재생)
  });

  // 쉐도잉용 속도 조절 (시트 안에서 느리게 따라 말하기)
  const SHEET_SPEEDS = [1, 1.25, 1.5, 0.5, 0.75];  // 1×→1.25→1.5→0.5→0.75→… (사용자 지정 순서)
  let sheetSpeedIdx = 0;
  const $txSpeed = document.getElementById('tx-speed');
  $txSpeed?.addEventListener('click', (e) => {
    e.stopPropagation();
    sheetSpeedIdx = (sheetSpeedIdx + 1) % SHEET_SPEEDS.length;
    const r = SHEET_SPEEDS[sheetSpeedIdx];
    player.rate(r);
    $txSpeed.textContent = (r === 1 ? '1×' : r + '×');
    $txSpeed.classList.toggle('on', r !== 1);
  });

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
  let txScale = parseFloat(localStorage.getItem(FS_KEY) || '1') || 1;
  // --tx-scale 은 시트 카드(.tx-card 와 .tx-notes 의 공통 조상)에 둔다 → 본문(영어 transcript)만
  // A−/A＋ 로 스케일된다. 한글 번역(.tx-trans-ko)은 고정 크기라 --tx-scale 영향을 받지 않는다(사용자 요청).
  const $scaleEl = $sheet ? $sheet.querySelector('.tx-sheet-card') : null;
  function applyTxScale() {
    txScale = Math.max(0.8, Math.min(1.6, Math.round(txScale * 100) / 100));
    // 글자 크기 변경 시 보던 위치 유지: 화면에 보이는 문장을 앵커로 잡고, 리플로우 후 같은 화면
    // 위치로 스크롤을 보정한다(예전엔 scrollTop 고정이라 글자가 커지며 내용이 아래로 쭉 밀렸다).
    const sc = document.querySelector('.tx-scroll');
    let anchor = null, before = 0;
    if (sc) {
      const cont = sc.getBoundingClientRect();
      anchor = sc.querySelector('.tx-sent.active')
        || [...sc.querySelectorAll('.tx-sent')].find((el) => el.getBoundingClientRect().bottom - cont.top > 4);
      if (anchor) before = anchor.getBoundingClientRect().top - cont.top;
    }
    if ($scaleEl) $scaleEl.style.setProperty('--tx-scale', String(txScale));
    try { localStorage.setItem(FS_KEY, String(txScale)); } catch (e) {}
    if (sc && anchor) {
      const after = anchor.getBoundingClientRect().top - sc.getBoundingClientRect().top;  // 읽기→리플로우 강제
      sc.scrollTop += (after - before);   // 앵커를 변경 전과 같은 화면 위치로
    }
  }
  applyTxScale();
  document.getElementById('tx-fs-up')?.addEventListener('click', (e) => { e.stopPropagation(); txScale += 0.1; applyTxScale(); });
  document.getElementById('tx-fs-dn')?.addEventListener('click', (e) => { e.stopPropagation(); txScale -= 0.1; applyTxScale(); });

  // 문장 단위 이전/다음 점프 (쉐도잉)
  function jumpSent(dir) {
    if (!sentRanges.length) return;
    let idx = lastActiveSent >= 0 ? lastActiveSent : findActiveSentIdx(txTime());
    if (idx < 0) idx = 0;
    let target;
    if (dir < 0) {
      const cur = sentRanges[idx];
      // 현재 문장을 1초 이상 진행했으면 그 문장 처음으로, 아니면 이전 문장으로
      target = (cur && txTime() > cur.start + 1.0) ? idx : idx - 1;
    } else {
      target = idx + 1;
    }
    target = Math.max(0, Math.min(sentRanges.length - 1, target));
    const sel = sentRanges[target];
    if (!sel) return;
    player.seek(toAudio(sel.start) + 0.01);
    player.play();
    scrollSentToCenter(sel.el);
  }
  document.getElementById('tx-prev-sent')?.addEventListener('click', (e) => { e.stopPropagation(); jumpSent(-1); });
  document.getElementById('tx-next-sent')?.addEventListener('click', (e) => { e.stopPropagation(); jumpSent(1); });

  // === 하단 전송 컨트롤 자동 숨김 + 화면 탭하면 다시 올라오기 (사용자 요청) ===
  const $sheetCard = $sheet ? $sheet.querySelector('.tx-sheet-card') : null;
  let ctrlHideTimer = 0;
  function showControls() {
    if (!$sheetCard) return;
    $sheetCard.classList.remove('controls-hidden');
    clearTimeout(ctrlHideTimer);
    ctrlHideTimer = setTimeout(() => $sheetCard.classList.add('controls-hidden'), 3200);
  }
  // 시트 어디든 탭(포인터 누름) → 컨트롤 다시 표시 + 숨김 타이머 리셋
  $sheetCard?.addEventListener('pointerdown', showControls, { passive: true });

  // === 재생 중 화면 꺼짐 방지 (Screen Wake Lock) — transcript/Now-Playing 화면 (사용자 요청) ===
  let wakeLock = null;
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
  const offWake = player.on((ev) => {
    if (ev === 'play') acquireWake();
    else if (ev === 'pause' || ev === 'ended') releaseWake();
  });
  // 브라우저는 탭이 숨겨지면 wake lock 을 자동 해제 → 복귀 시 재취득
  const onVis = () => { if (document.visibilityState === 'visible' && !player.paused) acquireWake(); };
  document.addEventListener('visibilitychange', onVis);
  if (!player.paused) acquireWake();

  const off = player.on(refresh);

  // === 단어 단위 따라가기 (karaoke) — rAF 로 timeupdate(4Hz)보다 부드럽게 ===
  const wordTimed = Array.from(document.querySelectorAll('.tx-scroll .w'))
    .map((el) => ({ el, s: parseFloat(el.dataset.s) }))
    .filter((w) => Number.isFinite(w.s));
  let lastWordIdx = -1;
  function updateWord() {
    if (!wordTimed.length) return;
    if ($sheet && !$sheet.classList.contains('open')) return;  // 시트 닫힘 → 단어 하이라이트 갱신 불필요(배터리)
    let t = txTime();
    // 반복 모드: 되감기 직후 HL_LAG 로 t 가 직전 문장 단어로 내려가 카라오케가 깜빡이던 것 방지.
    if (shadowMode === 'loop' && loopPara >= 0) t = Math.max(t, loopStart);
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
  function startRaf() { if (!rafId) rafId = requestAnimationFrame(rafLoop); }
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
    releaseWake();
    document.removeEventListener('visibilitychange', onVis);
    clearTimeout(ctrlHideTimer);
    cancelEase();
    stopRaf();
    document.removeEventListener('keydown', escClose);
    document.body.style.overflow = '';
    document.body.classList.remove('on-episode');
    $sheet?.remove();
  }, { once: true });

  $play.addEventListener('click', () => player.toggle());
  $back.addEventListener('click', () => player.skip(-15));
  $fwd.addEventListener('click',  () => player.skip(30));
  $scrub.addEventListener('input', () => {
    const dur = player.duration;
    if (dur) player.seek(dur * parseFloat($scrub.value) / 100);
  });
  $speed.addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    const r = SPEEDS[speedIdx];
    player.rate(r);
    $speed.textContent = (r === 1 ? '1×' : r + '×');
  });

  // Transcript click → seek
  document.querySelectorAll('#transcript-list li').forEach((li) => {
    li.addEventListener('click', () => {
      player.seek(parseFloat(li.dataset.start || '0'));
      player.play();
    });
  });

  // Vocab interactions
  document.querySelectorAll('.vocab-card .tts').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      speak(btn.dataset.text);
    });
  });
  document.querySelectorAll('.vocab-card .ex').forEach((el) => {
    el.addEventListener('click', () => {
      const start = parseFloat(el.dataset.start || '0');
      if (start > 0) {
        player.seek(start);
        player.play();
      }
    });
  });
  prefetch(vocabs.map((v) => v.term).filter(Boolean));

  // "스크립트로 보기" 진입 플래그(라이브러리에서 설정): 자동재생 + 트랜스크립트 시트 자동 열기 (논스톱)
  let wantScript = false;
  try {
    const si = sessionStorage.getItem('aep-open-script');
    if (si && parseInt(si, 10) === ep.id) { wantScript = true; sessionStorage.removeItem('aep-open-script'); }
  } catch (e) {}

  // 시작 위치: 딥링크(:t) > 저장된 이어듣기 위치. 자동재생: 딥링크이거나 "스크립트로 보기"일 때.
  const seekTo = tStr != null ? parseFloat(tStr) : NaN;
  const prog = getProgress(ep.id);
  let startAt = null;
  if (Number.isFinite(seekTo) && seekTo > 0) startAt = seekTo;
  else if (prog && prog.t > 5 && (!prog.dur || prog.t < prog.dur - 10)) startAt = prog.t;
  const autoPlay = (Number.isFinite(seekTo) && seekTo > 0) || wantScript;
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
  if (!card || !header) return;

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
  document.addEventListener('mousemove', (e) => { if (dragging) move(e.clientY); });
  document.addEventListener('mouseup', end);
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

function transcriptSheetHtml(segments, title, sub) {
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
    <div class="tx-sheet" aria-hidden="true">
      <div class="tx-sheet-backdrop"></div>
      <div class="tx-sheet-card">
        <div class="tx-sheet-bg" style="background-image:url('${SHOW_COVER}')"></div>
        <div class="tx-sheet-header">
          <div class="tx-sheet-handle"></div>
          <h3 class="tx-sheet-title">${escapeHtml(title || 'Transcript')}</h3>
          ${sub ? `<div class="tx-sheet-sub">${escapeHtml(sub)}</div>` : ''}
          <button class="tx-sheet-close" aria-label="Close">×</button>
        </div>
        <div class="tx-card">
          <div class="tx-toolbar">
            <button id="tx-trans" class="tx-toggle tx-trans-toggle" aria-pressed="false" aria-label="Korean translation">KR</button>
            <button id="tx-shadow" class="tx-toggle tx-loop-toggle" aria-pressed="false" aria-label="Shadowing mode">🔁 Shadow</button>
            <button id="tx-speed" class="tx-toggle tx-speed-toggle" aria-label="Playback speed">1×</button>
            <button id="tx-fs-dn" class="tx-toggle tx-fs-btn" aria-label="Decrease text size">A−</button>
            <button id="tx-fs-up" class="tx-toggle tx-fs-btn" aria-label="Increase text size">A＋</button>
          </div>
          <div class="tx-scroll">
            ${body}
          </div>
        </div>
        <button class="tx-live-badge" type="button" aria-label="Resume auto-follow">↓ Now playing</button>
        <div class="tx-notes" aria-hidden="true"></div>
        <div class="tx-sheet-controls">
          <button class="tx-mini-btn tx-sent-btn" id="tx-prev-sent" aria-label="Previous sentence">
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
          <button class="tx-mini-btn tx-sent-btn" id="tx-next-sent" aria-label="Next sentence">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M14.8 6H17v12h-2.2zM5 6l8.5 6L5 18z"/></svg>
          </button>
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

function vocabHtml(v) {
  const kind = v.kind || 'word';
  const ex = v.example_sentence
    ? `<p class="ex" data-start="${v.sentence_start_sec || 0}">${escapeHtml(v.example_sentence)}</p>`
    : '';
  return `
    <li class="vocab-card ${kind}">
      <div class="term">
        <span>${escapeHtml(v.term)}</span>
        <button class="tts" data-text="${escapeHtml(v.term)}" aria-label="play">▶</button>
        <span class="chip ${kind}" style="margin-left:auto">${escapeHtml(kind.replace('_', ' '))}</span>
      </div>
      ${v.definition ? `<p class="def">${escapeHtml(v.definition)}</p>` : ''}
      ${ex}
    </li>
  `;
}
