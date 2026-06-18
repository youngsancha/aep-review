// Now Playing — large cover, scrubber, transport, transcript + vocab below.
import { escapeHtml, fmtTime, fmtDate, fmtDuration } from '/app.js';
import { getEpisode } from '/db.js';
import { speak, prefetch } from '/tts.js';
import { player } from '/player.js';
import { SHOW_COVER, SHOW_COVER_SM } from '/config.js';

const SVG_PLAY  = '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';
const SVG_PAUSE = '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const SVG_MINI_PLAY  = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';
const SVG_MINI_PAUSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const SVG_BACK15 = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3.5-7.1"/><polyline points="3 4 3 10 9 10"/></svg>';
const SVG_FWD30 = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.5-7.1"/><polyline points="21 4 21 10 15 10"/></svg>';

const SPEEDS = [1, 1.25, 1.5, 0.85, 1];

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
  let shadowMode = 'off';  // off | loop(문장 반복) | pause(문장 끝 자동 멈춤)
  let autoPausedSent = -1;

  // === 광고 싱크 보정 (#7) ===
  // 최근 에피소드는 시작부 동적 광고(DAI)로 스트리밍 audio 와 transcript 타임스탬프가 어긋난다.
  // 모든 audio↔transcript 매핑을 txTime()=player.time-adOffset 로 보정하고, 탭-보정으로 1탭에 고정.
  const OFFKEY = `aep-aoff-${ep.id}`;
  let adOffset = parseFloat(localStorage.getItem(OFFKEY) || '0') || 0;
  const txTime = () => player.time - adOffset;
  function setOffset(v) {
    adOffset = Math.max(-30, Math.min(600, Math.round(v * 100) / 100));
    try { localStorage.setItem(OFFKEY, String(adOffset)); } catch (e) {}
  }
  let calibrating = false;

  // === 현재 문장 번역 항상 표시 토글 (#8) — 무료 MyMemory API, 결과는 per-episode 캐시 ===
  let showTrans = false;
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

    // 쉐도잉 모드: 현재 문장 끝에서 반복(loop) 또는 자동 멈춤(pause, 따라 말할 시간)
    if (shadowMode !== 'off' && lastActiveSent >= 0 && !player.paused) {
      const cur = sentRanges[lastActiveSent];
      if (cur && Number.isFinite(cur.end) && txTime() >= cur.end - 0.06) {
        if (shadowMode === 'loop') player.seek(cur.start + 0.01 + adOffset);
        else if (lastActiveSent !== autoPausedSent) { player.pause(); autoPausedSent = lastActiveSent; }
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
    const ns = (idx >= 0 && vNotes[idx]) ? vNotes[idx] : [];
    // 번역카드는 showTrans 가 켜져 있고 "easy 가 아닌" 문장에서만 (조금이라도 어려우면 노출)
    const wantTrans = showTrans && idx >= 0 && !isEasySentence(idx);
    if (!ns.length && !wantTrans) {
      $notes.classList.remove('show');
      $notes.setAttribute('aria-hidden', 'true');
      return;
    }
    const transBlock = wantTrans
      ? `<div class="tx-trans-row" data-idx="${idx}"><span class="tx-trans-ico">한</span><span class="tx-trans-ko">…</span></div>`
      : '';
    $notes.innerHTML = transBlock + ns.map((v) => `
      <div class="tx-note">
        <div class="tx-note-term"><span>${escapeHtml(v.term)}</span><span class="tx-note-kind">${escapeHtml((v.kind || 'word').replace('_', ' '))}</span><button class="tx-note-tts" data-text="${escapeHtml(v.term)}" aria-label="발음 듣기">🔊</button></div>
        ${v.definition ? `<div class="tx-note-def">${escapeHtml(v.definition)}</div>` : ''}
      </div>`).join('');
    $notes.classList.add('show');
    $notes.setAttribute('aria-hidden', 'false');
    if (wantTrans) fillTranslation(idx);
  }

  let lastActiveSent = -1;
  let lastActivePara = -1;
  let userScrolledUntil = 0;     // suspend auto-follow until this timestamp
  let autoScrollUntil = 0;       // we are mid auto-scroll until this timestamp

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
    if (idx >= 0 && scroll && !userActive && Date.now() > autoScrollUntil) {
      const sentEl = sentRanges[idx].el;
      const rect = sentEl.getBoundingClientRect();
      const cont = scroll.getBoundingClientRect();
      const elTop = rect.top - cont.top + scroll.scrollTop;
      // 현재 문장을 화면 상단 ~22% 에 고정 → 하단 번역/해설 카드와 한 화면에 함께 보이도록 위로 올림(#9)
      const target = elTop - scroll.clientHeight * 0.22;
      const clamped = Math.max(0, Math.min(target, scroll.scrollHeight - scroll.clientHeight));
      if (Math.abs(clamped - scroll.scrollTop) > 8) {
        autoScrollUntil = Date.now() + 600;
        scroll.scrollTo({ top: clamped, behavior: 'smooth' });
      }
    }
    txCard?.classList.toggle('live', !userActive);
    txCard?.classList.toggle('no-follow', userActive);
  }

  // Detect REAL user-initiated scrolling via wheel/touch — not via 'scroll' event,
  // because our own programmatic smooth-scroll fires scroll events for ~600ms.
  const $txScroll = document.querySelector('.tx-scroll');
  if ($txScroll) {
    const markUser = () => { userScrolledUntil = Date.now() + 4000; };
    $txScroll.addEventListener('wheel', markUser, { passive: true });
    $txScroll.addEventListener('touchstart', markUser, { passive: true });
    $txScroll.addEventListener('touchmove', markUser, { passive: true });
    $txScroll.addEventListener('keydown', (e) => {
      if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key)) markUser();
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
    autoScrollUntil = Date.now() + 700;
    userScrolledUntil = Date.now() + 3000;  // give user 3s to read before auto-follow resumes
    $tx.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }
  if ($tx) {
    $tx.addEventListener('click', (e) => {
      const w = e.target.closest('.w');
      const sent = e.target.closest('.tx-sent');
      const para = e.target.closest('.tx-para');
      // 싱크 보정 모드(#7): 지금 들리는 문장을 탭 → 그 문장 시작이 현재 재생시점이 되도록 offset 고정
      if (calibrating && (sent || para)) {
        const base = parseFloat((sent || para).dataset.start);
        setOffset(player.time - base);
        endCalibrate();
        highlightActiveSegment();
        return;
      }
      let seekTo = null;
      if (w)        seekTo = parseFloat(w.dataset.s);
      else if (sent) seekTo = parseFloat(sent.dataset.start);
      else if (para) seekTo = parseFloat(para.dataset.start);
      if (seekTo == null) return;
      player.seek(seekTo + adOffset);  // transcript 시각 → audio 시각
      player.play();
      scrollSentToCenter(sent || para);
    });
  }

  // Search filter
  const $search = document.getElementById('tx-search');
  if ($search) {
    let timer = 0;
    $search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => applySearch($search.value.trim().toLowerCase()), 120);
    });
  }
  const wordEls = Array.from(document.querySelectorAll('.tx-scroll .w'));
  function applySearch(q) {
    wordEls.forEach((w) => w.classList.remove('match'));
    if (!q) return;
    wordEls.forEach((w) => {
      const text = w.textContent.toLowerCase().replace(/[^a-z']/g, '');
      if (text && text.includes(q)) w.classList.add('match');
    });
  }

  // "Now playing" badge tap → resume auto-follow
  const $card = document.querySelector('.tx-card');
  document.querySelector('.tx-live-badge')?.addEventListener('click', () => {
    userScrolledUntil = 0;
    lastActivePara = -1;  // force re-trigger of scroll on next update
    highlightActiveSegment();
  });

  // Toggle timestamp visibility
  const $tsToggle = document.getElementById('tx-toggle-ts');
  $tsToggle?.addEventListener('click', () => {
    const on = $card.classList.toggle('show-ts');
    $tsToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
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
  const SHADOW = [
    { mode: 'off',   label: '🔁 쉐도잉',   on: false },
    { mode: 'loop',  label: '🔁 반복',     on: true },
    { mode: 'pause', label: '⏸ 문장멈춤', on: true },
  ];
  let shadowIdx = 0;
  const $shadow = document.getElementById('tx-shadow');
  $shadow?.addEventListener('click', (e) => {
    e.stopPropagation();
    shadowIdx = (shadowIdx + 1) % SHADOW.length;
    const s = SHADOW[shadowIdx];
    shadowMode = s.mode;
    autoPausedSent = -1;
    $shadow.textContent = s.label;
    $shadow.classList.toggle('on', s.on);
    $shadow.setAttribute('aria-pressed', s.on ? 'true' : 'false');
  });

  // 쉐도잉용 속도 조절 (시트 안에서 느리게 따라 말하기)
  const SHEET_SPEEDS = [1, 0.85, 0.75, 1.25];
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

  // 한국어 번역 항상 표시 토글 (#8)
  const $trans = document.getElementById('tx-trans');
  $trans?.addEventListener('click', (e) => {
    e.stopPropagation();
    showTrans = !showTrans;
    $trans.classList.toggle('on', showTrans);
    $trans.setAttribute('aria-pressed', showTrans ? 'true' : 'false');
    renderNotes(lastActiveSent);
  });

  // 오디오 싱크 보정 토글 (#7)
  function endCalibrate() {
    calibrating = false;
    $sheet?.classList.remove('calibrating');
    const b = document.getElementById('tx-calib');
    if (b) { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); }
  }
  const $calib = document.getElementById('tx-calib');
  $calib?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (calibrating) { endCalibrate(); return; }
    calibrating = true;
    $sheet?.classList.add('calibrating');
    $calib.classList.add('on');
    $calib.setAttribute('aria-pressed', 'true');
  });

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
    player.seek(sel.start + 0.01 + adOffset);
    player.play();
    scrollSentToCenter(sel.el);
  }
  document.getElementById('tx-prev-sent')?.addEventListener('click', (e) => { e.stopPropagation(); jumpSent(-1); });
  document.getElementById('tx-next-sent')?.addEventListener('click', (e) => { e.stopPropagation(); jumpSent(1); });

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

  // 딥링크 #/episode/:id/:t — 그 시점부터 재생 (Study/SRS 에서 표현의 맥락으로 점프)
  const seekTo = tStr != null ? parseFloat(tStr) : NaN;
  if (Number.isFinite(seekTo) && seekTo > 0) {
    const go = () => { player.seek(seekTo + adOffset); player.play(); };
    if (player.duration) go();
    else { const offMeta = player.on((ev) => { if (ev === 'meta') { go(); offMeta(); } }); }
  }

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
          <div class="tx-search">
            <input id="tx-search" class="tx-search-input" type="search" placeholder="Search transcript..." />
            <button id="tx-trans" class="tx-toggle tx-trans-toggle" aria-pressed="false" aria-label="한국어 번역">한 번역</button>
            <button id="tx-shadow" class="tx-toggle tx-loop-toggle" aria-pressed="false" aria-label="Shadowing mode">🔁 쉐도잉</button>
            <button id="tx-speed" class="tx-toggle tx-speed-toggle" aria-label="Playback speed">1×</button>
            <button id="tx-calib" class="tx-toggle tx-calib-toggle" aria-pressed="false" aria-label="오디오에 싱크 맞추기">🎯 싱크</button>
            <button id="tx-toggle-ts" class="tx-toggle" aria-pressed="false">Time</button>
          </div>
          <div class="tx-scroll">
            ${body}
          </div>
        </div>
        <button class="tx-live-badge" type="button" aria-label="Resume auto-follow">↓ Now playing</button>
        <div class="tx-calib-hint" aria-hidden="true">🎯 지금 <b>들리는 문장</b>을 탭하면 오디오와 싱크가 맞춰져요</div>
        <div class="tx-notes" aria-hidden="true"></div>
        <div class="tx-sheet-controls">
          <button class="tx-mini-btn tx-sent-btn" id="tx-prev-sent" aria-label="Previous sentence">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M7 6h2.2v12H7zM19 6v12l-8.5-6z"/></svg>
          </button>
          <button class="tx-mini-btn" id="tx-mini-back" aria-label="Back 15s">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3.5-7.1"/><polyline points="3 4 3 10 9 10"/></svg>
            <span class="skip-num">15</span>
          </button>
          <button class="tx-mini-play" id="tx-mini-play" aria-label="Play/Pause">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
          </button>
          <button class="tx-mini-btn" id="tx-mini-fwd" aria-label="Forward 30s">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.5-7.1"/><polyline points="21 4 21 10 15 10"/></svg>
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
