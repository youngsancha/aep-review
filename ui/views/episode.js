// Now Playing — large cover, scrubber, transport, transcript + vocab below.
import { escapeHtml, fmtTime, fmtDate, fmtDuration } from '/app.js';
import { getEpisode } from '/db.js';
import { speak, prefetch } from '/tts.js';
import { player } from '/player.js';

const SVG_PLAY  = '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';
const SVG_PAUSE = '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const SVG_MINI_PLAY  = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>';
const SVG_MINI_PAUSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const SVG_BACK15 = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3.5-7.1"/><polyline points="3 4 3 10 9 10"/></svg>';
const SVG_FWD30 = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.5-7.1"/><polyline points="21 4 21 10 15 10"/></svg>';

const SPEEDS = [1, 1.25, 1.5, 0.85, 1];

export async function renderEpisode(root, idStr) {
  const id = parseInt(idStr, 10);
  const ep = await getEpisode(id);
  document.body.classList.add('on-episode');
  // Safeguard: even if we early-return below, ensure the class is removed on nav away.
  window.addEventListener('hashchange', () => document.body.classList.remove('on-episode'), { once: true });

  const segments = ep.transcript?.segments || [];
  const vocabs = ep.vocab || [];

  const showLabel = `S${ep.season ?? '–'}${ep.episode_no != null ? ` · E${ep.episode_no}` : ''} · ${fmtDate(ep.pub_date)}`;

  root.innerHTML = `
    <div class="np-wrap">
      <div class="np-cover-wrap">
        <img class="np-cover" src="/icons/icon-512.png" alt="" onerror="this.src='/icons/icon-192.png'" />
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
          ${segments.length ? `
          <button class="np-tx-btn" id="np-tx-btn" aria-label="Transcript">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>
            <span>Transcript</span>
          </button>
          ` : ''}
        </div>
      ` : `<div class="empty">audio not downloaded yet</div>`}
    </div>

    ${vocabs.length ? `
      <div class="section-h"><h2>Vocabulary</h2><span class="count">${vocabs.length}</span></div>
      <ul class="vocab-list">
        ${vocabs.map((v) => vocabHtml(v)).join('')}
      </ul>
    ` : ''}

    ${!segments.length && !ep.transcribed_at ? `<div class="empty">transcript pending</div>` : ''}
  `;

  // Build transcript sheet (overlay) and attach to body — not inline.
  // Sheet must be in DOM BEFORE player wiring queries .tx-scroll/.tx-sent below.
  // Wrapped in try/catch so a broken transcript can't kill audio playback.
  let $sheet = null;
  if (segments.length) {
    try {
      const wrap = document.createElement('div');
      wrap.innerHTML = transcriptSheetHtml(segments).trim();
      $sheet = wrap.firstElementChild;
      document.body.appendChild($sheet);
    } catch (err) {
      console.error('[transcript] sheet build failed:', err);
      $sheet = null;
    }
  }

  // openSheet/closeSheet/escClose defined below, after state vars.
  let escClose = () => {};

  if (!ep.audio_url) {
    return; // no playback wiring needed
  }

  // Connect to global player
  const track = {
    id: ep.id,
    title: (ep.title || '').replace(/^\d+\s*[-:.]\s*/, ''),
    show: 'American English Podcast',
    cover: '/icons/icon-192.png',
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
    const t = player.time;
    const idx = findActiveSentIdx(t);
    if (idx === lastActiveSent) return;

    if (lastActiveSent >= 0 && sentRanges[lastActiveSent]) {
      sentRanges[lastActiveSent].el.classList.remove('active');
    }
    if (idx >= 0) sentRanges[idx].el.classList.add('active');
    lastActiveSent = idx;

    // paragraph active + scroll on paragraph change only
    const newPara = idx >= 0 ? paraEls.indexOf(sentRanges[idx].paraEl) : -1;
    const txCard = document.querySelector('.tx-card');
    const scroll = document.querySelector('.tx-scroll');

    if (newPara !== lastActivePara) {
      paraEls.forEach((p, i) => {
        p.classList.toggle('active', i === newPara);
        if (newPara >= 0 && i < newPara) p.classList.add('played');
        else if (i >= newPara) p.classList.remove('played');
      });
      lastActivePara = newPara;

      const userActive = Date.now() < userScrolledUntil;
      if (newPara >= 0 && scroll && !userActive && Date.now() > autoScrollUntil) {
        const target = paraTops[newPara] - scroll.clientHeight * 0.30;
        const clamped = Math.max(0, target);
        if (Math.abs(clamped - scroll.scrollTop) > 40) {
          autoScrollUntil = Date.now() + 700;
          scroll.scrollTo({ top: clamped, behavior: 'smooth' });
        }
      }
      txCard?.classList.toggle('live', !userActive);
      txCard?.classList.toggle('no-follow', userActive);
    }
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
      let seekTo = null;
      if (w)        seekTo = parseFloat(w.dataset.s);
      else if (sent) seekTo = parseFloat(sent.dataset.start);
      else if (para) seekTo = parseFloat(para.dataset.start);
      if (seekTo == null) return;
      player.seek(seekTo);
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

  const off = player.on(refresh);
  // Cleanup on route change — detach player listener, remove sheet, restore body scroll
  window.addEventListener('hashchange', () => {
    off();
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

function transcriptSheetHtml(segments) {
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
        <div class="tx-sheet-bg" style="background-image:url('/icons/icon-512.png')"></div>
        <div class="tx-sheet-header">
          <div class="tx-sheet-handle"></div>
          <h3>Transcript</h3>
          <button class="tx-sheet-close" aria-label="Close">×</button>
        </div>
        <div class="tx-card">
          <div class="tx-search">
            <input id="tx-search" class="tx-search-input" type="search" placeholder="Search transcript..." />
            <button id="tx-toggle-ts" class="tx-toggle" aria-pressed="false">Time</button>
          </div>
          <div class="tx-scroll">
            ${body}
          </div>
        </div>
        <button class="tx-live-badge" type="button" aria-label="Resume auto-follow">↓ Now playing</button>
        <div class="tx-sheet-controls">
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
        </div>
      </div>
    </div>
  `;
}

function groupIntoParagraphs(segments) {
  const out = [];
  let cur = null;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const prev = i > 0 ? segments[i - 1] : null;
    const gap = prev ? s.start - prev.end : 0;
    const sentenceEnd = prev && /[.!?…"']\s*$/.test(prev.text || '');
    const tooLong = cur && (s.end - cur.start) > 25;
    const breakHere = !cur || (sentenceEnd && gap > 0.4) || gap > 1.4 || tooLong;
    if (breakHere) {
      cur = { start: s.start, end: s.end, segments: [s] };
      out.push(cur);
    } else {
      cur.segments.push(s);
      cur.end = s.end;
    }
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
