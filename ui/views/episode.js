// Now Playing — large cover, scrubber, transport, transcript + vocab below.
import { escapeHtml, fmtTime, fmtDate, fmtDuration } from '/app.js';
import { getEpisode } from '/db.js';
import { speak, prefetch } from '/tts.js';
import { player, getProgress } from '/player.js';
import { SHOW_COVER, SHOW_COVER_SM } from '/config.js';

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

  // === 광고-무관 싱크 (#2) ===
  // 인제스트가 앱과 "똑같은" clean megaphone URL 로 STT 하므로 transcript ≡ stream
  // (광고 포함 동일 바이트) → 보정 offset 불필요. transcript 시각 = audio 시각.
  // (수동 싱크 버튼/calibration 은 제거 — scripts/retranscribe.py 가 구조적으로 해결.)
  //
  // HL_LAG(초): 하이라이트/단어 팔로우를 오디오보다 이만큼 "늦게" 따라가게 한다(>0).
  // whisper 단어 타임스탬프가 실제 음성보다 살짝 빨라, 보정 없으면 하이라이트가 음성보다
  // 앞서 보인다 → 양수 lag 로 "Shana 가 말하기 시작한 직후" 따라오도록. (사용자 튜닝값)
  const HL_LAG = 0.2;
  const txTime = () => player.time - HL_LAG;

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

    // 쉐도잉 반복(loop): 현재 문장 끝에서 그 문장 처음으로 되돌려 무한 반복
    if (shadowMode === 'loop' && lastActiveSent >= 0 && !player.paused) {
      const cur = sentRanges[lastActiveSent];
      if (cur && Number.isFinite(cur.end) && txTime() >= cur.end - 0.06) {
        player.seek(cur.start + 0.01);
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
  async function fillTranslation(idx) {
    if (!$notes) return;
    const sel = () => $notes.querySelector(`.tx-trans-row[data-idx="${idx}"] .tx-trans-ko`);
    let row = sel();
    if (!row) return;
    const text = getSentText(idx);
    if (!text) { row.textContent = ''; return; }
    if (_trCache[idx]) { row.textContent = _trCache[idx]; return; }
    const seq = ++_trSeq;
    try {
      const ko = await translateEnKo(text);
      if (seq !== _trSeq) return;            // 더 최신 문장으로 넘어갔으면 폐기
      row = sel(); if (!row) return;
      row.textContent = ko || '(번역 없음)';
      _trCache[idx] = ko; saveTrCache(ep.id, _trCache);
    } catch (e) {
      row = sel(); if (row) row.textContent = '· 번역을 불러올 수 없어요 (네트워크)';
    }
    // 다음 문장 미리 번역(부드러운 전환) — easy 가 아닌 문장만
    const nxt = idx + 1;
    if (showTrans && nxt < sentRanges.length && !_trCache[nxt] && !isEasySentence(nxt)) {
      const t2 = getSentText(nxt);
      if (t2) translateEnKo(t2).then((k) => { _trCache[nxt] = k; saveTrCache(ep.id, _trCache); }).catch(() => {});
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
    $notes.innerHTML = `<div class="tx-trans-row" data-idx="${idx}"><span class="tx-trans-ico">한</span><span class="tx-trans-ko">…</span></div>`;
    $notes.classList.add('show');
    $notes.setAttribute('aria-hidden', 'false');
    fillTranslation(idx);
  }

  let lastActiveSent = -1;
  let lastActivePara = -1;
  let userScrolledUntil = 0;     // suspend auto-follow until this timestamp
  let autoScrollUntil = 0;       // (레거시) — 부드러운 ease 로 대체되어 게이트엔 더 안 씀

  // === 부드러운 자동 스크롤 (Apple Podcasts 느낌) ===
  // 네이티브 scrollTo({smooth}) 는 매 문장마다 재시작돼 끊긴다. 대신 rAF 로 매 프레임
  // 목표(scrollTarget)를 향해 지수적으로 ease → 문장이 바뀌면 목표만 갱신되어 연속·부드럽게.
  let scrollTarget = null;
  let scrollRaf = 0;
  const SCROLL_EASE = 0.12;       // 0~1, 클수록 빠르게 따라붙음(작을수록 더 부드럽고 느긋함)
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
    const t = txTime();
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
    if (newPara !== lastActivePara) {
      paraEls.forEach((p, i) => {
        p.classList.toggle('active', i === newPara);
        if (newPara >= 0 && i < newPara) p.classList.add('played');
        else if (i >= newPara) p.classList.remove('played');
      });
      lastActivePara = newPara;
    }

    // 핵심: 현재 "문장"을 매 문장 전환마다 상단 ~32% 위치로 부드럽게 고정 → 음성과 시선 일치.
    const userActive = Date.now() < userScrolledUntil;
    if (idx >= 0 && scroll && !userActive) {
      const sentEl = sentRanges[idx].el;
      const rect = sentEl.getBoundingClientRect();
      const cont = scroll.getBoundingClientRect();
      const elTop = rect.top - cont.top + scroll.scrollTop;
      // 현재 문장을 상단 ~22% 에 두되, 거기서 2줄 더 위로 끌어올려 붙인다 → 하단 번역/해설
      // 카드와 한 화면에 더 여유롭게 함께 보이도록(#9, 사용자 요청). lh = 한 줄 높이.
      const lh = parseFloat(getComputedStyle(sentRanges[idx].paraEl).lineHeight) || 40;
      const target = elTop - Math.max(8, scroll.clientHeight * 0.22 - lh * 2);
      const clamped = Math.max(0, Math.min(target, scroll.scrollHeight - scroll.clientHeight));
      // 문장이 바뀔 때마다 목표만 갱신 → rAF ease 가 부드럽게 따라감(네이티브 smooth 의 끊김 제거)
      const ref = scrollTarget != null ? scrollTarget : scroll.scrollTop;
      if (Math.abs(clamped - ref) > 2) smoothScrollTo(clamped);
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
  if ($tx) {
    $tx.addEventListener('click', (e) => {
      const w = e.target.closest('.w');
      const sent = e.target.closest('.tx-sent');
      const para = e.target.closest('.tx-para');
      let seekTo = null;
      if (w)        seekTo = parseFloat(w.dataset.s);
      else if (sent) seekTo = parseFloat(sent.dataset.start);
      else if (para) seekTo = parseFloat(para.dataset.start);
      if (seekTo == null) return;
      player.seek(seekTo);  // transcript 시각 = audio 시각 (offset 0)
      player.play();
      scrollSentToCenter(sent || para);
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
    { mode: 'off',  label: '🔁 쉐도잉', on: false },
    { mode: 'loop', label: '🔁 반복',   on: true },
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
  // --tx-scale 을 시트 카드(.tx-card 와 .tx-notes 의 공통 조상)에 두어 본문 + 한글번역이
  // 함께 스케일되도록(#: 번역 폰트도 A−/A＋ 로 조절).
  const $scaleEl = $sheet ? $sheet.querySelector('.tx-sheet-card') : null;
  function applyTxScale() {
    txScale = Math.max(0.8, Math.min(1.6, Math.round(txScale * 100) / 100));
    if ($scaleEl) $scaleEl.style.setProperty('--tx-scale', String(txScale));
    try { localStorage.setItem(FS_KEY, String(txScale)); } catch (e) {}
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
    player.seek(sel.start + 0.01);
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
    const t = txTime();
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

function transcriptSheetHtml(segments, title, sub) {
  segments.forEach((s, i) => { s._idx = i; });
  const paras = groupIntoParagraphs(segments);
  const body = paras.map((para) => {
    const sentsHtml = para.segments.map((s) => {
      return `<span class="tx-sent" data-i="${s._idx}" data-start="${s.start}" data-end="${s.end}">${renderSegmentWords(s)}</span>`;
    }).join(' ');
    return `<p class="tx-para" data-start="${para.start}" data-end="${para.end}">
      <span class="ts">${escapeHtml(fmtTime(para.start))}</span>${sentsHtml}
    </p>`;
  }).join('');

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
            <button id="tx-trans" class="tx-toggle tx-trans-toggle" aria-pressed="false" aria-label="한국어 번역">한 번역</button>
            <button id="tx-shadow" class="tx-toggle tx-loop-toggle" aria-pressed="false" aria-label="Shadowing mode">🔁 쉐도잉</button>
            <button id="tx-speed" class="tx-toggle tx-speed-toggle" aria-label="Playback speed">1×</button>
            <button id="tx-fs-dn" class="tx-toggle tx-fs-btn" aria-label="글자 작게">A−</button>
            <button id="tx-fs-up" class="tx-toggle tx-fs-btn" aria-label="글자 크게">A＋</button>
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

// === EN→KO 문장 번역 (#8) — 무료 MyMemory API. 세션 메모리 + per-episode localStorage 캐시 ===
const _TR_MEM = new Map();
async function translateEnKo(text) {
  const key = text.slice(0, 480);  // API 길이 제한 여유
  if (_TR_MEM.has(key)) return _TR_MEM.get(key);
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(key)}&langpair=en|ko`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('translate http ' + r.status);
  const j = await r.json();
  let ko = (j && j.responseData && j.responseData.translatedText) || '';
  // MyMemory 가 가끔 따옴표/대문자 경고문을 섞어 보내므로 정리
  if (/MYMEMORY WARNING/i.test(ko)) ko = '';
  _TR_MEM.set(key, ko);
  return ko;
}
function loadTrCache(epId) {
  try { return JSON.parse(localStorage.getItem('aep-tr-' + epId) || '{}'); } catch { return {}; }
}
function saveTrCache(epId, obj) {
  try { localStorage.setItem('aep-tr-' + epId, JSON.stringify(obj)); } catch (e) { /* quota */ }
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

  const ENDS = /[.!?…]["')\]]?$/;
  const out = [];
  let cur = null;
  for (const w of words) {
    if (!cur) cur = { start: w.start, end: w.end, words: [] };
    cur.words.push(w);
    if (Number.isFinite(w.end)) cur.end = w.end;
    const txt = (w.word || '').trim();
    const tooLong = (cur.end - cur.start) > 14 || cur.words.length > 45;
    if ((ENDS.test(txt) && cur.words.length >= 2) || tooLong) {
      cur.text = cur.words.map((x) => x.word).join('').trim();
      out.push(cur);
      cur = null;
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
  return words.map((w) => {
    const txt = (w.word || '').replace(/^\s+/, '');
    const start = (w.start ?? seg.start);
    const end   = (w.end   ?? seg.end);
    return `<span class="w" data-s="${(+start).toFixed(2)}" data-e="${(+end).toFixed(2)}">${escapeHtml(txt)}</span>`;
  }).join(' ');
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
