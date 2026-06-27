// Study 탭 — 에피소드에서 추출된 실생활 표현을 종류별로 탐색하는 허브.
// 데이터는 기존 vocab_cards (claude 추출, 영+한 정의, 타임스탬프). SRS 복습은 #/srs 가 담당.
import { escapeHtml, highlightTerm } from '/app.js';
import { studyOverview, expressionsByKind, markKnown, markUnknown } from '/db.js';
import { speak, prefetch } from '/tts.js';
import { playSentenceClip, stopClip } from '/clip.js';
import { translateEnKo } from '/translate.js';
import { renderEssentials } from '/views/essentials.js';

const KIND_LABEL = { idiom: 'Idioms', phrasal_verb: 'Phrasal Verbs', collocation: 'Collocations', word: 'Words' };
const KIND_EMOJI = { idiom: '💬', phrasal_verb: '🔗', collocation: '🧩', word: '📖' };

// 데일리 학습 스트릭 — 매일 꾸준함이 유창성의 핵심. Study 를 연 날을 기록해 연속일을 센다(추가형).
const _dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function markStudyDay() {
  try {
    const s = new Set(JSON.parse(localStorage.getItem('aep-study-days') || '[]'));
    s.add(_dayKey(new Date()));
    localStorage.setItem('aep-study-days', JSON.stringify([...s].slice(-400)));
  } catch (e) { /* quota */ }
}
function getStreak() {
  try {
    const s = new Set(JSON.parse(localStorage.getItem('aep-study-days') || '[]'));
    const d = new Date();
    if (!s.has(_dayKey(d))) d.setDate(d.getDate() - 1);  // 오늘 아직이면 어제부터 카운트
    let n = 0;
    while (s.has(_dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  } catch (e) { return 0; }
}

// Study 예문 재생 — 가능하면 Shana '실제 음성'(에피소드 클립)으로, 없으면 TTS 폴백.
// 네이티브 영어 학습엔 합성음보다 실제 발화(억양·연음·리듬)가 핵심이라 실제 음성을 우선한다.
function playExample(c, rate, loop) {
  if (!c) return;
  if (c.audio_url && c.sentence_start_sec != null) {
    // 단어수 기반 최소 재생길이 — whisper 타임스탬프 압축으로 클립이 말 도중 끊기는 것 방지(늘리기만).
    const wc = (c.example_sentence || '').trim().split(/\s+/).filter(Boolean).length;
    const minDur = wc >= 4 ? Math.min(wc * 0.33, 12) : 0;
    playSentenceClip(c.audio_url, c.sentence_start_sec, c.sentence_end_sec, null, rate, loop, minDur);
  } else {
    speak(c.example_sentence, rate ? { playbackRate: rate } : undefined);  // TTS 폴백은 단발
  }
}

export async function renderStudy(root) {
  stopClip();  // 홈/다른 모드로 진입 시 인라인 문장 재생 정지(겹침 방지)
  markStudyDay();  // 오늘 학습 기록(스트릭)
  root.innerHTML = `
    <div class="study-greet"><h2>Study</h2></div>
    <div class="skel-hero" style="height:84px"></div>
    <div class="study-kinds">${'<span class="skel-chip"></span>'.repeat(4)}</div>
    ${'<div class="skel-x"></div>'.repeat(5)}`;
  let ov;
  try {
    ov = await studyOverview();
  } catch (e) {
    root.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(e.message)}</div>`;
    return;
  }

  const kinds = ov.byKind.filter((k) => k.total > 0);
  let selected = kinds.length ? kinds[0].kind : null;
  let items = [];
  let q = '';
  let knownCount = ov.known || 0;          // "알아요" 누적 (낙관적 갱신)
  const RING_C = 2 * Math.PI * 34;          // 진도 링 둘레 (r=34)

  function ringDash(pct) { return `${((pct / 100) * RING_C).toFixed(1)} ${RING_C.toFixed(1)}`; }

  function heroHtml() {
    const pct = ov.total ? Math.round((knownCount / ov.total) * 100) : 0;
    return `
      <div class="study-greet">
        <h2>Study</h2>
        <div class="study-greet-sub">${ov.total.toLocaleString()} real-life expressions to master</div>
      </div>
      <div class="study-progress-card">
        <svg class="study-ring" viewBox="0 0 80 80" width="96" height="96" aria-hidden="true">
          <circle class="study-ring-bg" cx="40" cy="40" r="34"></circle>
          <circle class="study-ring-fg" id="study-ring-fg" cx="40" cy="40" r="34"
                  stroke-dasharray="${ringDash(pct)}" transform="rotate(-90 40 40)"></circle>
          <text x="40" y="38" class="study-ring-pct" id="study-ring-pct">${pct}%</text>
          <text x="40" y="53" class="study-ring-sub">Known</text>
        </svg>
        <div class="study-progress-meta">
          <div class="study-progress-big"><b id="study-known-n">${knownCount.toLocaleString()}</b><span> / ${ov.total.toLocaleString()} mastered</span></div>
          <div class="study-progress-pills">
            ${getStreak() > 0 ? `<span class="study-pill streak">🔥 ${getStreak()}-day streak</span>` : ''}
            <span class="study-pill">📚 Learned ${ov.learned.toLocaleString()}</span>
          </div>
          <div class="study-ovbar"><span id="study-known-bar" style="width:${pct}%"></span></div>
        </div>
      </div>
      ${ov.due > 0 ? `
      <a class="study-due-cta" href="#/srs">
        <span class="study-due-ico">🔥</span>
        <span class="study-due-txt"><b>${ov.due} due to review</b><span>지금 복습 — 간격반복으로 장기기억</span></span>
        <span class="study-due-go">›</span>
      </a>` : ''}
      <button class="study-ess-cta" id="study-essentials">
        <span class="study-ess-ico">✨</span>
        <span class="study-ess-txt"><b>Essentials</b><span>미국 현지·비즈니스 핵심표현 — 빠르게 네이티브로</span></span>
        <span class="study-ess-go">›</span>
      </button>
      <div class="study-kinds">
        ${kinds.map((k) => `
          <button class="study-kind-chip${k.kind === selected ? ' on' : ''}" data-kind="${k.kind}">
            <span class="study-kind-emoji">${KIND_EMOJI[k.kind] || '•'}</span>
            <span class="study-kind-name">${KIND_LABEL[k.kind] || k.kind}</span>
            <span class="study-kind-n">${k.total}</span>
          </button>`).join('')}
      </div>
      <div class="study-quiz-row">
        <button class="study-quiz-btn" id="study-quiz-read"><span class="qb-ico">🎯</span><span class="qb-txt">Quiz</span></button>
        <button class="study-quiz-btn" id="study-quiz-listen"><span class="qb-ico">🎧</span><span class="qb-txt">Listen</span></button>
        <button class="study-quiz-btn" id="study-quiz-dict"><span class="qb-ico">✍️</span><span class="qb-txt">Dictation</span></button>
        <button class="study-quiz-btn" id="study-quiz-cloze"><span class="qb-ico">🧩</span><span class="qb-txt">Cloze</span></button>
        <button class="study-quiz-btn" id="study-quiz-speak"><span class="qb-ico">🎤</span><span class="qb-txt">Speak</span></button>
        <button class="study-quiz-btn" id="study-quiz-prod"><span class="qb-ico">🗣️</span><span class="qb-txt">KR→EN</span></button>
        <button class="study-quiz-btn" id="study-quiz-sent"><span class="qb-ico">💬</span><span class="qb-txt">Sentences</span></button>
      </div>
    `;
  }

  // "알아요" 누적을 헤더 링/막대/숫자에 즉시 반영
  function applyKnown(delta) {
    knownCount = Math.max(0, Math.min(ov.total, knownCount + delta));
    const pct = ov.total ? Math.round((knownCount / ov.total) * 100) : 0;
    const n = root.querySelector('#study-known-n'); if (n) n.textContent = knownCount.toLocaleString();
    const bar = root.querySelector('#study-known-bar'); if (bar) bar.style.width = pct + '%';
    const ring = root.querySelector('#study-ring-fg'); if (ring) ring.setAttribute('stroke-dasharray', ringDash(pct));
    const pctEl = root.querySelector('#study-ring-pct'); if (pctEl) pctEl.textContent = pct + '%';
  }

  // 정의 끝의 (한글 뜻) 을 다음 줄로 분리 — 영어 정의에 한글이 이어붙지 않게.
  function defHtml(def) {
    const s = String(def || '');
    const m = s.match(/^(.*\S)\s*([(\[（].*?[)\]）])\s*$/);
    if (m && /[가-힣]/.test(m[2])) {
      return `<span class="def-en">${escapeHtml(m[1])}</span><span class="def-ko">${escapeHtml(m[2])}</span>`;
    }
    return escapeHtml(s);
  }
  function rowHtml(v) {
    const epTitle = (v.episode_title || '').replace(/^\d+\s*[-:.]\s*/, '');
    const hasClip = !!(v.audio_url && v.sentence_start_sec != null);
    // 상호작용: 카드 탭 → 발음(term), 예문 탭 → 맥락 실음성, 오른쪽 스와이프 → Known, KR → 예문 번역.
    return `
      <li class="study-x tap${v.known ? ' known' : ''}" data-id="${v.id}" data-ep="${v.episode_id}" data-term="${escapeHtml(v.term)}">
        <div class="study-x-swipe-hint">✓ Known</div>
        <div class="study-x-top">
          <span class="study-x-term">${escapeHtml(v.term)}</span>
          ${v.example_sentence ? `<button class="study-x-tr" data-id="${v.id}" aria-label="Show Korean translation">KR</button>` : ''}
          <span class="study-x-known-badge" aria-hidden="true">✓ Known</span>
        </div>
        ${v.definition ? `<div class="study-x-def">${defHtml(v.definition)}</div>` : ''}
        ${v.example_sentence ? `
          <div class="study-x-ex${hasClip ? ' tappable' : ''}" data-id="${v.id}" aria-label="${hasClip ? 'Tap to hear in context' : ''}">
            <span class="study-x-ex-q">“${highlightTerm(v.example_sentence, v.term)}”</span>
          </div>
          <div class="study-x-tr-out" hidden></div>` : ''}
        ${epTitle ? `<div class="study-x-ep">🎧 ${escapeHtml(epTitle)}</div>` : ''}
      </li>`;
  }

  // 검색/필터 — term/뜻/예문에 q 부분일치. q 는 loadKind 에서 kind 전환 시 ''로 초기화.
  function matchQ(v) {
    if (!q) return true;
    const s = q.toLowerCase();
    return (v.term || '').toLowerCase().includes(s)
      || (v.definition || '').toLowerCase().includes(s)
      || (v.example_sentence || '').toLowerCase().includes(s);
  }
  function xlistHtml() {
    const list = items.filter(matchQ);
    if (!list.length) return '<div class="empty">No matches.</div>';
    return `<ul class="study-xlist">${list.map(rowHtml).join('')}</ul>`;
  }
  function listHtml() {
    if (!items.length) return '<div class="empty">No expressions.</div>';
    return `<div class="study-swipe-tip"><b>Swipe →</b> to mark <b>Known</b> · <b>←</b> to undo · tap card for audio</div>`
      + `<input class="study-search" id="study-search" type="search" inputmode="search" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Search expressions…" value="${escapeHtml(q)}" />`
      + `<div id="study-xlist-host">${xlistHtml()}</div>`;
  }

  async function markKnownLi(li) {
    if (!li || li.classList.contains('known')) return;
    const id = Number(li.dataset.id);
    try {
      await markKnown(id);
      li.classList.add('known');
      const item = items.find((x) => x.id === id); if (item) item.known = true;
      applyKnown(1);
      if (navigator.vibrate) navigator.vibrate(12);
    } catch (err) { /* keep */ }
  }
  async function markUnknownLi(li) {
    if (!li || !li.classList.contains('known')) return;
    const id = Number(li.dataset.id);
    try {
      await markUnknown(id);
      li.classList.remove('known');
      const item = items.find((x) => x.id === id); if (item) item.known = false;
      applyKnown(-1);
      if (navigator.vibrate) navigator.vibrate(12);
    } catch (err) { /* keep */ }
  }
  // 스와이프: 오른쪽 → Known(미지일 때), 왼쪽 → Unknown(known 일 때 되돌리기). 임계 넘기면 처리.
  function wireSwipeKnown(li) {
    let x0 = null, y0 = null, sw = false;
    const hint = li.querySelector('.study-x-swipe-hint');
    const reset = () => { li.style.transition = ''; li.style.transform = ''; li.classList.remove('swipe-armed', 'swipe-left'); x0 = null; };
    li.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; sw = false; });
    li.addEventListener('pointermove', (e) => {
      if (x0 == null) return;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      if (!sw && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) + 4) sw = true;
      if (!sw) return;
      const known = li.classList.contains('known');
      const allow = (dx > 0 && !known) || (dx < 0 && known);   // 방향별 허용
      if (!allow) return;
      if (hint) hint.textContent = dx < 0 ? '↺ Unknown' : '✓ Known';
      li.style.transition = 'none';
      li.style.transform = `translateX(${Math.max(-132, Math.min(dx, 132))}px)`;
      li.classList.toggle('swipe-armed', Math.abs(dx) > 78);
      li.classList.toggle('swipe-left', dx < 0);
    });
    li.addEventListener('pointerup', (e) => {
      const dx = x0 != null ? e.clientX - x0 : 0;
      const known = li.classList.contains('known');
      if (sw) { li.dataset.swiped = '1'; setTimeout(() => { li.dataset.swiped = ''; }, 350); }  // 뒤따르는 click(발음) 무시
      if (sw && dx > 78 && !known) markKnownLi(li);
      else if (sw && dx < -78 && known) markUnknownLi(li);
      reset();
    });
    ['pointercancel', 'pointerleave'].forEach((ev) => li.addEventListener(ev, reset));
  }
  function wireRows() {
    // 예문 탭 → 맥락 실음성(기존). stopPropagation 으로 카드 탭(발음)과 분리.
    root.querySelectorAll('.study-x-ex.tappable').forEach((el) =>
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const it = items.find((x) => x.id === Number(el.dataset.id));
        if (it) playExample(it);
      }));
    // KR 버튼 → 예문의 한국어 번역을 그 자리에 토글 표시 (#36).
    root.querySelectorAll('.study-x-tr').forEach((b) =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const li = b.closest('.study-x'); const out = li && li.querySelector('.study-x-tr-out');
        const it = items.find((x) => x.id === Number(b.dataset.id));
        if (!out || !it) return;
        if (!out.hidden) { out.hidden = true; b.classList.remove('on'); return; }
        out.hidden = false; b.classList.add('on');
        if (!out.dataset.loaded) {
          if (it.example_ko) {            // 사전번역(전체 예문) 있으면 즉시 표시
            out.textContent = it.example_ko;
          } else {                         // 없으면(아직 생성 전 등) 온디맨드 폴백
            out.textContent = '…';
            const ko = await translateEnKo(it.example_sentence);
            out.textContent = ko || 'Translation unavailable';
          }
          out.dataset.loaded = '1';
        }
      }));
    // 카드 탭 → 발음(term) 재생 (#38). 예문/KR 버튼은 stopPropagation 으로 제외. 스와이프 직후면 무시.
    root.querySelectorAll('.study-x').forEach((li) => {
      li.addEventListener('click', (e) => {
        if (li.dataset.swiped === '1') return;
        if (e.target.closest('.study-x-ex') || e.target.closest('.study-x-tr')) return;
        speak(li.dataset.term);
      });
      wireSwipeKnown(li);
    });
    prefetch([...root.querySelectorAll('.study-x-term')].slice(0, 8).map((e) => e.textContent));
  }

  // 검색창은 한 번만 그리고(포커스·IME 유지), 입력 시 결과 호스트(#study-xlist-host)만 다시 그린다.
  function wireList() {
    const search = root.querySelector('#study-search');
    if (search) search.addEventListener('input', () => {
      q = search.value;
      const host = root.querySelector('#study-xlist-host');
      if (host) { host.innerHTML = xlistHtml(); wireRows(); }
    });
    wireRows();
  }

  function paintShell() {
    root.innerHTML = heroHtml() + '<div id="study-list"></div>';
    root.querySelectorAll('.study-kind-chip').forEach((b) =>
      b.addEventListener('click', () => loadKind(b.dataset.kind)));
    root.querySelector('#study-quiz-read')?.addEventListener('click', () => startQuiz('read'));
    root.querySelector('#study-quiz-listen')?.addEventListener('click', () => startQuiz('listen'));
    root.querySelector('#study-quiz-dict')?.addEventListener('click', startDictation);
    root.querySelector('#study-quiz-cloze')?.addEventListener('click', startCloze);
    root.querySelector('#study-quiz-speak')?.addEventListener('click', startSpeaking);
    root.querySelector('#study-quiz-prod')?.addEventListener('click', startProduction);
    root.querySelector('#study-quiz-sent')?.addEventListener('click', startSentences);
    root.querySelector('#study-essentials')?.addEventListener('click', () => renderEssentials(root, () => renderStudy(root)));
  }

  async function loadKind(k) {
    stopClip();
    selected = k;
    q = '';
    paintShell();
    const listEl = root.querySelector('#study-list');
    listEl.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    try {
      items = await expressionsByKind(k);
    } catch (e) {
      items = [];
    }
    listEl.innerHTML = listHtml();
    wireList();
  }

  // ── 4지선다 퀴즈 (현재 종류의 표현으로 능동 회상) ──
  const _shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, r) => p[0] - r[0]).map((x) => x[1]);
  function startQuiz(mode = 'read') {
    stopClip();
    const pool = items.filter((v) => v.term && v.definition);
    if (pool.length < 4) {
      const el = root.querySelector('#study-list');
      if (el) el.innerHTML = '<div class="empty">Not enough expressions for a quiz (need 4+).</div>';
      return;
    }
    const N = Math.min(20, pool.length);
    const qs = _shuffle(pool).slice(0, N).map((correct) => {
      const others = _shuffle(pool.filter((x) => x.id !== correct.id)).slice(0, 3);
      return { correct, options: _shuffle([correct, ...others]) };
    });
    let idx = 0, score = 0, answered = false;

    function paintQ() {
      if (idx >= qs.length) return finishQ();
      const c = qs[idx].correct;
      const optLabel = (o) => (mode === 'listen' ? (o.definition || '') : (o.term || ''));
      const promptHtml = mode === 'listen'
        ? `<button class="quiz-bigspk" id="q-spk" aria-label="Replay">🔊</button>
           <div class="quiz-q">Listen and pick the meaning</div>`
        : `<div class="quiz-def">${escapeHtml(c.definition)}</div>
           <button class="quiz-spk" id="q-spk" aria-label="Play pronunciation">🔊 Hint</button>
           <div class="quiz-q">Pick the right expression</div>`;
      root.innerHTML = `
        <div class="quiz-bar"><span class="quiz-count">${idx + 1} / ${qs.length}</span><span class="quiz-score">${score} pts</span></div>
        <div class="quiz-prompt">${promptHtml}</div>
        <div class="quiz-opts">
          ${qs[idx].options.map((o) => `<button class="quiz-opt${mode === 'listen' ? ' quiz-opt-def' : ''}" data-ok="${o.id === c.id ? '1' : '0'}">${escapeHtml(optLabel(o))}</button>`).join('')}
        </div>
        <button class="quiz-exit" id="q-exit">← Study Home</button>`;
      root.querySelector('#q-spk').addEventListener('click', () => speak(c.term));
      requestAnimationFrame(() => speak(c.term));  // 진입/다음 카드 시 발음 자동재생
      if (mode === 'listen') requestAnimationFrame(() => speak(c.term));
      root.querySelector('#q-exit').addEventListener('click', () => renderStudy(root));
      root.querySelectorAll('.quiz-opt').forEach((b) => b.addEventListener('click', () => answerQ(b, c)));
    }
    function answerQ(btn, c) {
      if (answered) return;
      answered = true;
      const ok = btn.dataset.ok === '1';
      if (ok) { score++; btn.classList.add('right'); }
      else { btn.classList.add('wrong'); root.querySelectorAll('.quiz-opt').forEach((b) => { if (b.dataset.ok === '1') b.classList.add('right'); }); }
      if (navigator.vibrate) navigator.vibrate(ok ? 12 : [20, 40, 20]);
      speak(c.term);
      root.querySelectorAll('.quiz-opt').forEach((b) => { b.disabled = true; });
      if (mode === 'listen') {  // 듣기 퀴즈: 답한 뒤 정답 표현을 노출
        const pr = root.querySelector('.quiz-prompt');
        if (pr) pr.insertAdjacentHTML('beforeend', `<div class="quiz-reveal">${escapeHtml(c.term)}</div>`);
      }
      setTimeout(() => { idx++; answered = false; paintQ(); }, ok ? 750 : 1600);
    }
    function finishQ() {
      const pct = Math.round((score / qs.length) * 100);
      const msg = pct >= 80 ? 'Excellent! 🎉' : pct >= 50 ? 'Well done! 💪' : 'Try again! 🔥';
      root.innerHTML = `
        <div class="quiz-summary">
          <div class="quiz-sum-msg">${msg}</div>
          <div class="quiz-sum-score">${score}/${qs.length}</div>
          <div class="quiz-sum-pct">Accuracy ${pct}%</div>
          <div class="quiz-sum-actions">
            <button class="study-cta-btn" id="q-again">Retry</button>
            <button class="study-cta-btn secondary" id="q-home">Study Home</button>
          </div>
        </div>`;
      root.querySelector('#q-again').addEventListener('click', startQuiz);
      root.querySelector('#q-home').addEventListener('click', () => renderStudy(root));
    }
    paintQ();
  }

  // ── 문장 학습 덱 (예문을 듣고/읽고 → 뜻·표현 공개, 문장 단위 이해) ──
  // ── Sentences = '카드게임' 반복학습 — 오른쪽 스와이프=Known(마스터·덱에서 제거),
  // 왼쪽=Again(맨 뒤로 재투입→다시 만남). 덱을 다 비울 때까지 반복. 탭=발음, Show meaning=뜻/한국어. ──
  function startSentences() {
    stopClip();
    const pool = items.filter((v) => v.example_sentence && v.example_sentence.trim());
    if (!pool.length) {
      const el = root.querySelector('#study-list');
      if (el) el.innerHTML = '<div class="empty">No expressions with examples yet.</div>';
      return;
    }
    let deck = _shuffle(pool).slice(0, Math.min(20, pool.length));
    const total = deck.length;
    let mastered = 0, againCnt = 0;
    prefetch(deck.slice(0, 6).map((c) => c.example_sentence));

    function finishS() {
      stopClip();
      const msg = againCnt === 0 ? 'Flawless deck! 🌟' : 'Deck cleared! 🃏';
      root.innerHTML = `
        <div class="quiz-summary">
          <div class="quiz-sum-msg">${msg}</div>
          <div class="quiz-sum-score">${total}</div>
          <div class="quiz-sum-pct">mastered${againCnt ? ` · ${againCnt} repeats` : ''}</div>
          <div class="quiz-sum-actions">
            <button class="study-cta-btn" id="s-again">Play again</button>
            <button class="study-cta-btn secondary" id="s-home">Study Home</button>
          </div>
        </div>`;
      root.querySelector('#s-again').addEventListener('click', startSentences);
      root.querySelector('#s-home').addEventListener('click', () => renderStudy(root));
    }

    // knownIt=true(오른쪽): 마스터 처리 후 덱에서 제거. false(왼쪽): 맨 뒤로 재투입(반복).
    function advance(knownIt) {
      const c = deck[0];
      if (!c) return finishS();
      if (knownIt) {
        mastered++;
        if (!c.known) { c.known = true; markKnown(c.id).catch(() => {}); applyKnown(1); }
        deck.shift();
      } else {
        againCnt++;
        deck.push(deck.shift());  // 맨 뒤로 → 끝까지 다 알 때까지 다시 만남
      }
      paintS();
    }

    function paintS() {
      stopClip();
      if (!deck.length) return finishS();
      const c = deck[0];
      root.innerHTML = `
        <div class="quiz-bar"><span class="quiz-count">${mastered} / ${total} mastered</span><span class="quiz-score">💬 Sentences</span></div>
        <div class="sent-card sent-swipe" id="sent-card" data-id="${c.id}">
          <div class="sent-swipe-badge" id="sent-badge"></div>
          <div class="sent-en">${escapeHtml(c.example_sentence)} <span class="sent-spk">🔊</span></div>
          <div class="sent-reveal" id="sent-reveal" hidden>
            ${c.example_ko ? `<div class="sent-ko">${escapeHtml(c.example_ko)}</div>` : ''}
            <div class="sent-term">${escapeHtml(c.term)}</div>
            <div class="sent-def">${escapeHtml(c.definition || '')}</div>
            ${(c.sentence_start_sec != null && c.audio_url) ? `<button class="srs-context-btn" id="sent-ctx" data-url="${escapeHtml(c.audio_url)}" data-s="${c.sentence_start_sec}" data-e="${c.sentence_end_sec ?? ''}">🎧 Hear in context</button>` : ''}
          </div>
        </div>
        <div class="sent-game-row">
          <button class="sent-game-btn again" id="sent-again">↺ Again</button>
          <button class="study-cta-btn" id="sent-action">Show meaning</button>
          <button class="sent-game-btn known" id="sent-known">✓ Known</button>
        </div>
        <div class="study-swipe-tip">Swipe → Known · ← Again (repeats)</div>
        <button class="quiz-exit" id="sent-exit">← Study Home</button>`;
      const card = root.querySelector('#sent-card');
      card.addEventListener('click', () => { if (!card.dataset.swiped) playExample(c); });
      requestAnimationFrame(() => playExample(c, undefined, true));  // 문장 음성 자동 반복
      if (deck[1]) prefetch([deck[1].example_sentence]);
      root.querySelector('#sent-exit').addEventListener('click', () => renderStudy(root));
      root.querySelector('#sent-again').addEventListener('click', () => advance(false));
      root.querySelector('#sent-known').addEventListener('click', () => advance(true));
      root.querySelector('#sent-action').addEventListener('click', (e) => {
        e.stopPropagation();
        root.querySelector('#sent-reveal').hidden = false;
        e.target.disabled = true;
        const cx = root.querySelector('#sent-ctx');
        if (cx) cx.addEventListener('click', (ev) => { ev.stopPropagation(); playSentenceClip(cx.dataset.url, cx.dataset.s, cx.dataset.e, cx); });
      });
      wireSentSwipe(card, advance);
    }

    // 카드 스와이프: 오른쪽=Known, 왼쪽=Again. 임계 78px. 던지듯 날아간 뒤 advance.
    function wireSentSwipe(card, adv) {
      let x0 = null, y0 = null, sw = false;
      const badge = card.querySelector('#sent-badge');
      const reset = () => { card.style.transition = 'transform .2s'; card.style.transform = ''; card.classList.remove('swipe-armed', 'swipe-left'); if (badge) badge.textContent = ''; x0 = null; };
      card.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; sw = false; });
      card.addEventListener('pointermove', (e) => {
        if (x0 == null) return;
        const dx = e.clientX - x0, dy = e.clientY - y0;
        if (!sw && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) + 4) sw = true;
        if (!sw) return;
        if (badge) badge.textContent = dx < 0 ? '↺ Again' : '✓ Known';
        card.style.transition = 'none';
        card.style.transform = `translateX(${Math.max(-150, Math.min(dx, 150))}px) rotate(${Math.max(-8, Math.min(dx / 18, 8))}deg)`;
        card.classList.toggle('swipe-armed', Math.abs(dx) > 78);
        card.classList.toggle('swipe-left', dx < 0);
      });
      card.addEventListener('pointerup', (e) => {
        const dx = x0 != null ? e.clientX - x0 : 0;
        if (sw) { card.dataset.swiped = '1'; setTimeout(() => { card.dataset.swiped = ''; }, 350); }
        if (sw && Math.abs(dx) > 78) {
          const knownIt = dx > 0;
          card.style.transition = 'transform .25s ease-out';
          card.style.transform = `translateX(${knownIt ? 460 : -460}px) rotate(${knownIt ? 14 : -14}deg)`;
          stopClip();
          setTimeout(() => adv(knownIt), 170);
        } else reset();
      });
    }

    paintS();
  }

  // ── 받아쓰기(Dictation) — 듣고 그대로 타이핑 → 단어 단위 채점 + 차이 표시 (리스닝) ──
  // 축약형·구어 축약(native reductions)을 표준형으로 펼친다. 음성인식(말하기 드릴)이 "I'm"을
  // "I am"으로, "gonna"를 "going to"로 내놓아도 정답과 어긋나지 않게 — 사용자/정답 '양쪽'에 같은
  // 규칙을 적용하므로 모호한 경우(it's=it is/has)도 일관되게 일치한다(언어학적 정확성보다 대칭성).
  const _CONTR = {
    "i'm": "i am", "you're": "you are", "we're": "we are", "they're": "they are",
    "i've": "i have", "you've": "you have", "we've": "we have", "they've": "they have",
    "i'll": "i will", "you'll": "you will", "he'll": "he will", "she'll": "she will", "we'll": "we will", "they'll": "they will", "it'll": "it will",
    "i'd": "i would", "you'd": "you would", "he'd": "he would", "she'd": "she would", "we'd": "we would", "they'd": "they would",
    "it's": "it is", "he's": "he is", "she's": "she is", "that's": "that is", "there's": "there is", "here's": "here is",
    "what's": "what is", "who's": "who is", "where's": "where is", "how's": "how is", "let's": "let us",
    "won't": "will not", "can't": "can not", "cannot": "can not", "don't": "do not", "doesn't": "does not",
    "didn't": "did not", "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not",
    "haven't": "have not", "hasn't": "has not", "hadn't": "had not", "ain't": "is not",
    "wouldn't": "would not", "shouldn't": "should not", "couldn't": "could not", "mustn't": "must not",
    "gonna": "going to", "wanna": "want to", "gotta": "got to", "gimme": "give me", "lemme": "let me",
    "kinda": "kind of", "sorta": "sort of", "outta": "out of", "dunno": "do not know", "y'all": "you all",
  };
  const _normApos = (s) => String(s || '').replace(/[‘’ʼ]/g, "'");  // 곱슬따옴표 → ASCII '
  function normWords(s) {
    const cleaned = _normApos(s).toLowerCase().replace(/[^a-z0-9'\s]/g, ' ');
    const out = [];
    for (const tok of cleaned.split(/\s+/)) {
      if (!tok) continue;
      const exp = _CONTR[tok];
      if (exp) out.push(...exp.split(' '));
      else out.push(tok.replace(/'/g, ''));   // 비매핑 토큰은 따옴표 제거(소유격 john's=johns 일관화)
    }
    return out;
  }
  function wordEdit(a, b) {  // 단어 배열 간 Levenshtein
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return dp[m][n];
  }
  function scoreText(user, ans) {
    const a = normWords(user), b = normWords(ans);
    if (!b.length) return 0;
    return Math.max(0, 1 - wordEdit(a, b) / Math.max(a.length, b.length, 1));
  }
  function diffHtml(user, ans) {  // 정답 문장에서 맞춘/놓친 단어 표시(축약 정규화 동일 적용)
    const got = new Set(normWords(user));
    return _normApos(ans).split(/(\s+)/).map((tok) => {
      if (!tok.trim()) return tok;
      const parts = normWords(tok);                          // 정답 토큰도 같은 규칙으로 펼쳐
      const ok = parts.length > 0 && parts.every((p) => got.has(p));  // 펼친 부분이 모두 인식되면 hit
      return `<span class="dw ${ok ? 'hit' : 'miss'}">${escapeHtml(tok)}</span>`;
    }).join('');
  }
  function startDictation() {
    stopClip();
    const pool = items.filter((v) => v.example_sentence && v.example_sentence.trim());
    if (!pool.length) {
      const el = root.querySelector('#study-list');
      if (el) el.innerHTML = '<div class="empty">No expressions with examples yet.</div>';
      return;
    }
    const cards = _shuffle(pool).slice(0, Math.min(20, pool.length));
    let idx = 0, correct = 0;
    prefetch(cards.slice(0, 4).map((c) => c.example_sentence));

    function finishD() {
      const pct = Math.round((correct / cards.length) * 100);
      const msg = pct >= 80 ? 'Great ears! 👂' : pct >= 50 ? 'Getting there! 💪' : 'Keep at it! 🔁';
      root.innerHTML = `
        <div class="quiz-summary">
          <div class="quiz-sum-msg">${msg}</div>
          <div class="quiz-sum-score">${correct}/${cards.length}</div>
          <div class="quiz-sum-pct">Dictation accuracy ${pct}%</div>
          <div class="quiz-sum-actions">
            <button class="study-cta-btn" id="d-again">Again</button>
            <button class="study-cta-btn secondary" id="d-home">Study Home</button>
          </div>
        </div>`;
      root.querySelector('#d-again').addEventListener('click', startDictation);
      root.querySelector('#d-home').addEventListener('click', () => renderStudy(root));
    }
    function paintD() {
      if (idx >= cards.length) return finishD();
      const c = cards[idx];
      root.innerHTML = `
        <div class="quiz-bar"><span class="quiz-count">${idx + 1} / ${cards.length}</span><span class="quiz-score">${correct} correct</span></div>
        <div class="dict-card">
          <div class="dict-label">🎧 Listen & type</div>
          <button class="quiz-bigspk" id="d-spk" aria-label="Replay">🔊</button>
          <div class="dict-slow"><button class="dict-slow-btn" id="d-slow">🐢 Slow</button></div>
        </div>
        <textarea class="dict-input" id="d-in" rows="2" placeholder="Type what you hear" autocomplete="off" autocorrect="off" autocapitalize="sentences" spellcheck="false" enterkeyhint="done"></textarea>
        <div class="dict-actions">
          <button class="study-cta-btn secondary" id="d-skip">Don&#39;t know</button>
          <button class="study-cta-btn" id="d-check">Check</button>
        </div>
        <div id="d-result"></div>
        <button class="quiz-exit" id="d-exit">← Study Home</button>`;
      const input = root.querySelector('#d-in');
      input.focus();
      const replay = (pb, loop) => playExample(c, pb, loop);  // Shana 실제 음성(없으면 TTS), 천천히=속도인자
      requestAnimationFrame(() => replay(undefined, true));  // 답 쓸 때까지 자동 반복(채점/스킵 시 정지)
      if (idx + 1 < cards.length) prefetch([cards[idx + 1].example_sentence]);
      root.querySelector('#d-spk').addEventListener('click', () => replay());
      root.querySelector('#d-slow').addEventListener('click', () => replay(0.62));
      root.querySelector('#d-exit').addEventListener('click', () => renderStudy(root));
      root.querySelector('#d-skip').addEventListener('click', () => reveal(0));
      root.querySelector('#d-check').addEventListener('click', () => reveal(scoreText(input.value, c.example_sentence)));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) reveal(scoreText(input.value, c.example_sentence));
      });

      function reveal(score) {
        stopClip();  // 답 제출 → 자동반복 정지
        if (score >= 0.9) correct++;
        const cls = score >= 0.9 ? 'correct' : score >= 0.6 ? 'partial' : 'wrong';
        const label = score >= 0.9 ? 'Correct! 🎉' : score >= 0.6 ? 'Almost!' : 'Listen again';
        root.querySelector('#d-check').disabled = true;
        root.querySelector('#d-skip').disabled = true;
        input.disabled = true;
        root.querySelector('#d-result').innerHTML = `
          <div class="dict-result ${cls}">
            <div class="dict-score">${Math.round(score * 100)} pts · ${label}</div>
            <div class="dict-answer">${diffHtml(input.value, c.example_sentence)}</div>
            ${c.definition ? `<div class="dict-def">${escapeHtml(c.term)} — ${escapeHtml(c.definition)}</div>` : ''}
            <button class="study-cta-btn" id="d-next">Next →</button>
          </div>`;
        root.querySelector('#d-next').addEventListener('click', () => { idx++; paintD(); });
      }
    }
    paintD();
  }

  // ── 스피킹(Speaking) — 듣고 따라 말하기. Web Speech 인식으로 발음을 글로 받아 채점, 미지원시 녹음 후 비교(스피킹) ──
  function startSpeaking() {
    stopClip();
    const pool = items.filter((v) => v.example_sentence && v.example_sentence.trim());
    if (!pool.length) {
      const el = root.querySelector('#study-list');
      if (el) el.innerHTML = '<div class="empty">No expressions with examples yet.</div>';
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const cards = _shuffle(pool).slice(0, Math.min(20, pool.length));
    let idx = 0, scoreSum = 0, scored = 0;
    prefetch(cards.slice(0, 4).map((c) => c.example_sentence));

    function finishSp() {
      const avg = scored ? Math.round(scoreSum / scored) : 0;
      const msg = !scored ? 'Practice done! 🎤' : avg >= 80 ? 'Native-level! 🌟' : avg >= 55 ? 'Good — clearer! 💪' : 'Repeat slowly 🔁';
      root.innerHTML = `
        <div class="quiz-summary">
          <div class="quiz-sum-msg">${msg}</div>
          <div class="quiz-sum-score">${scored ? avg + ' pts' : cards.length}</div>
          <div class="quiz-sum-pct">${scored ? 'Avg pronunciation' : 'Shadowing complete'}</div>
          <div class="quiz-sum-actions">
            <button class="study-cta-btn" id="sp-again">Again</button>
            <button class="study-cta-btn secondary" id="sp-home">Study Home</button>
          </div>
        </div>`;
      root.querySelector('#sp-again').addEventListener('click', startSpeaking);
      root.querySelector('#sp-home').addEventListener('click', () => renderStudy(root));
    }

    function paintSp() {
      if (idx >= cards.length) return finishSp();
      const c = cards[idx];
      root.innerHTML = `
        <div class="quiz-bar"><span class="quiz-count">${idx + 1} / ${cards.length}</span><span class="quiz-score">🎤 Speak</span></div>
        <div class="speak-card">
          <div class="speak-label">🎯 Listen & repeat</div>
          <div class="speak-target" id="sp-target">${escapeHtml(c.example_sentence)} <span class="speak-spk">🔊</span></div>
          ${c.definition ? `<div class="speak-def">${escapeHtml(c.definition)}</div>` : ''}
        </div>
        <button class="speak-mic" id="sp-mic"><span class="speak-mic-ico">🎤</span><span id="sp-mic-label">Speak</span></button>
        <div class="speak-hint" id="sp-hint">${SR ? 'Tap the button and speak clearly' : '⚠️ Speech recognition not supported — record & compare (Chrome/Android)'}</div>
        <div id="sp-result"></div>
        <div class="dict-actions"><button class="study-cta-btn secondary" id="sp-skip">Skip</button></div>
        <button class="quiz-exit" id="sp-exit">← Study Home</button>`;
      root.querySelector('#sp-target').addEventListener('click', () => playExample(c));
      requestAnimationFrame(() => playExample(c));
      if (idx + 1 < cards.length) prefetch([cards[idx + 1].example_sentence]);
      root.querySelector('#sp-exit').addEventListener('click', () => renderStudy(root));
      root.querySelector('#sp-skip').addEventListener('click', () => { idx++; paintSp(); });
      const mic = root.querySelector('#sp-mic');
      if (SR) wireRecognition(mic, c); else wireRecorder(mic, c);
    }

    function showResult(said, c) {
      const sc = Math.round(scoreText(said, c.example_sentence) * 100);
      scoreSum += sc; scored++;
      const cls = sc >= 80 ? 'correct' : sc >= 55 ? 'partial' : 'wrong';
      root.querySelector('#sp-result').innerHTML = `
        <div class="dict-result ${cls}">
          <div class="dict-score">Pronunciation ${sc} pts</div>
          <div class="dict-answer">${diffHtml(said, c.example_sentence)}</div>
          <div class="speak-heard">Heard: “${escapeHtml(said || '—')}”</div>
          <div id="sp-compare" class="speak-compare"></div>
          <button class="study-cta-btn" id="sp-next">Next →</button>
        </div>`;
      root.querySelector('#sp-next').addEventListener('click', () => { idx++; paintSp(); });
    }

    // 내 발음 녹음이 준비되면 결과에 'A/B 비교'(원문 ↔ 내 발음)를 끼워넣는다.
    // 네이티브 발음을 익히는 가장 강력한 도구 = 내 목소리를 원어민 모델과 바로 들어비교.
    function injectCompare(url, c) {
      const box = root.querySelector('#sp-compare');
      if (!box) return;
      box.innerHTML = `
        <div class="speak-ab-label">🎧 Replay my voice · compare</div>
        <div class="speak-ab-row">
          <button class="study-cta-btn secondary" id="sp-orig2">🔊 Original</button>
          <audio class="speak-audio" controls src="${url}"></audio>
        </div>`;
      box.querySelector('#sp-orig2').addEventListener('click', () => playExample(c));
    }

    function wireRecognition(mic, c) {
      let listening = false, rec = null;
      let myRec = null, myStream = null, chunks = [];
      const label = () => root.querySelector('#sp-mic-label');
      function reset() { listening = false; mic.classList.remove('listening'); const l = label(); if (l) l.textContent = 'Speak'; }
      function stopMyRec() { try { if (myRec && myRec.state !== 'inactive') myRec.stop(); } catch (e) {} }
      mic.addEventListener('click', async () => {
        if (listening) { try { rec && rec.stop(); } catch (e) {} return; }
        // 인식과 '동시에' 내 목소리를 녹음(추가형) — 점수만이 아니라 원문과 직접 들어비교.
        // getUserMedia 실패/미지원이어도 아래 인식 로직은 그대로 동작(완전 가드).
        chunks = [];
        try {
          myStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          myRec = new MediaRecorder(myStream); myRec.ondataavailable = (e) => chunks.push(e.data);
          myRec.onstop = () => {
            try { myStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
            if (chunks.length) injectCompare(URL.createObjectURL(new Blob(chunks, { type: 'audio/webm' })), c);
          };
          myRec.start();
        } catch (e) { myRec = null; }
        // continuous+interim: 말 도중 쉬어도 끊기지 않고 계속 듣는다(예전엔 첫 쉼에서 끊겨 피드백 없이
        // Speak 로 복귀하던 버그). 탭하면 끝내고, 끝나면 '무엇이든' 인식된 텍스트로 반드시 채점·피드백.
        rec = new SR();
        rec.lang = 'en-US'; rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = true;
        listening = true; mic.classList.add('listening');
        const l = label(); if (l) l.textContent = 'Listening… (tap to finish)';
        let finalText = '';
        rec.onresult = (e) => {
          let interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) finalText += t + ' '; else interim += t;
          }
          const h = root.querySelector('#sp-hint'); if (h) h.textContent = (finalText + interim).trim() || 'Listening…';
        };
        rec.onerror = (e) => {
          const h = root.querySelector('#sp-hint');
          if (h) h.textContent = (e.error === 'not-allowed') ? '🎙️ Please allow mic access'
            : (e.error === 'no-speech') ? '🎙️ No speech heard — tap and speak' : 'Recognition error — try again';
        };
        rec.onend = () => {
          reset(); stopMyRec();
          const said = finalText.trim();
          if (said) showResult(said, c);   // 인식된 게 있으면 반드시 채점·피드백(끊겨도 피드백 보장)
        };
        try { rec.start(); } catch (e) { reset(); stopMyRec(); }
      });
    }

    function wireRecorder(mic, c) {
      let recorder = null, chunks = [], recording = false;
      const label = () => root.querySelector('#sp-mic-label');
      mic.addEventListener('click', async () => {
        if (recording) { try { recorder && recorder.stop(); } catch (e) {} return; }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          const h = root.querySelector('#sp-hint'); if (h) h.textContent = 'This browser does not support recording.';
          mic.disabled = true; return;
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          recorder = new MediaRecorder(stream); chunks = [];
          recorder.ondataavailable = (e) => chunks.push(e.data);
          recorder.onstop = () => {
            stream.getTracks().forEach((t) => t.stop());
            const url = URL.createObjectURL(new Blob(chunks, { type: 'audio/webm' }));
            recording = false; mic.classList.remove('listening');
            const l = label(); if (l) l.textContent = 'Record again';
            root.querySelector('#sp-result').innerHTML = `
              <div class="dict-result partial">
                <div class="dict-score">My voice vs original</div>
                <audio class="speak-audio" controls src="${url}"></audio>
                <div class="dict-actions">
                  <button class="study-cta-btn secondary" id="sp-orig">🔊 Original</button>
                  <button class="study-cta-btn" id="sp-next">Next →</button>
                </div>
              </div>`;
            root.querySelector('#sp-orig').addEventListener('click', () => playExample(c));
            root.querySelector('#sp-next').addEventListener('click', () => { idx++; paintSp(); });
          };
          recorder.start(); recording = true; mic.classList.add('listening');
          const l = label(); if (l) l.textContent = 'Recording… (tap to stop)';
        } catch (e) {
          const h = root.querySelector('#sp-hint'); if (h) h.textContent = '🎙️ Mic access needed.';
        }
      });
    }

    paintSp();
  }

  // ── 한→영 '말로 생산'(Production) — 한국어 뜻만 보고 영어를 직접 '말한다' → 이해/모방을 넘어 '구사' ──
  // 기존 스피킹(영어 보고 따라말하기=모방)과 달리 영어를 가리고 한국어→영어 산출. 네이티브 회화 핵심.
  function startProduction() {
    stopClip();
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const pool = items.filter((v) => v.example_sentence && v.example_sentence.trim().split(/\s+/).length >= 3);
    if (!pool.length) {
      const el = root.querySelector('#study-list');
      if (el) el.innerHTML = '<div class="empty">No examples to practice yet.</div>';
      return;
    }
    const cards = _shuffle(pool).slice(0, Math.min(20, pool.length));
    let idx = 0, scoreSum = 0, scored = 0;

    function finishPr() {
      const avg = scored ? Math.round(scoreSum / scored) : 0;
      const msg = !scored ? 'Practice done! 🗣️' : avg >= 80 ? 'Native-like! 🌟' : avg >= 55 ? 'Good — more natural! 💪' : 'Translate slowly 🔁';
      root.innerHTML = `
        <div class="quiz-summary">
          <div class="quiz-sum-msg">${msg}</div>
          <div class="quiz-sum-score">${scored ? avg + ' pts' : cards.length}</div>
          <div class="quiz-sum-pct">${scored ? 'Avg production' : 'KR→EN complete'}</div>
          <div class="quiz-sum-actions">
            <button class="study-cta-btn" id="pr-again">Again</button>
            <button class="study-cta-btn secondary" id="pr-home">Study Home</button>
          </div>
        </div>`;
      root.querySelector('#pr-again').addEventListener('click', startProduction);
      root.querySelector('#pr-home').addEventListener('click', () => renderStudy(root));
    }

    async function paintPr() {
      if (idx >= cards.length) return finishPr();
      const c = cards[idx];
      root.innerHTML = `
        <div class="quiz-bar"><span class="quiz-count">${idx + 1} / ${cards.length}</span><span class="quiz-score">🗣️ KR→EN</span></div>
        <div class="speak-card">
          <div class="speak-label">🇰🇷 See the Korean, say it in English</div>
          <div class="prod-ko" id="pr-ko">Loading translation…</div>
          ${c.term ? `<div class="speak-def">Hint: <b>${escapeHtml(c.term)}</b></div>` : ''}
        </div>
        <button class="speak-mic" id="pr-mic"><span class="speak-mic-ico">🎤</span><span id="pr-mic-label">${SR ? 'Speak' : 'Record'}</span></button>
        <div class="speak-hint" id="pr-hint">${SR ? 'Speak in English, then compare with the answer' : '⚠️ Speech recognition not supported — record & compare (Chrome/Android)'}</div>
        <div id="pr-result"></div>
        <div class="dict-actions"><button class="study-cta-btn secondary" id="pr-reveal">Don&#39;t know (show answer)</button></div>
        <button class="quiz-exit" id="pr-exit">← Study Home</button>`;
      root.querySelector('#pr-exit').addEventListener('click', () => renderStudy(root));
      root.querySelector('#pr-reveal').addEventListener('click', () => revealPr('', c));
      // 한국어 프롬프트: 사전번역(claude·고품질) 우선 → 즉시 표시(await 생략, 깜빡임 제거).
      // 없을 때만 온디맨드(MyMemory) 폴백. 한→영 드릴에선 '한국어 자극'의 품질이 곧 산출 품질이라 중요.
      const ko = c.example_ko || await translateEnKo(c.example_sentence);
      const koEl = root.querySelector('#pr-ko');
      if (koEl) koEl.textContent = ko || (c.definition ? `(meaning) ${c.definition}` : 'Use the expression and say it in English');
      const mic = root.querySelector('#pr-mic');
      if (SR) wirePrRec(mic, c); else wirePrRecorder(mic, c);
      if (idx + 1 < cards.length) prefetch([cards[idx + 1].example_sentence]);
    }

    function revealPr(said, c, recUrl) {
      const sc = said ? Math.round(scoreText(said, c.example_sentence) * 100) : 0;
      if (said) { scoreSum += sc; scored++; }
      const cls = !said ? 'partial' : sc >= 80 ? 'correct' : sc >= 55 ? 'partial' : 'wrong';
      root.querySelector('#pr-result').innerHTML = `
        <div class="dict-result ${cls}">
          <div class="dict-score">${said ? `Production ${sc} pts` : 'Answer'}</div>
          <div class="dict-answer">${said ? diffHtml(said, c.example_sentence) : escapeHtml(c.example_sentence)}</div>
          ${said ? `<div class="speak-heard">I said: “${escapeHtml(said)}”</div>` : ''}
          <div id="pr-compare" class="speak-compare"></div>
          <button class="study-cta-btn" id="pr-next">Next →</button>
        </div>`;
      root.querySelector('#pr-next').addEventListener('click', () => { idx++; paintPr(); });
      requestAnimationFrame(() => playExample(c));  // 정답 원어민 음성 자동 재생(귀로 확인)
      if (recUrl) {
        const box = root.querySelector('#pr-compare');
        if (box) {
          box.innerHTML = `
            <div class="speak-ab-label">🎧 Replay my voice · compare</div>
            <div class="speak-ab-row"><button class="study-cta-btn secondary" id="pr-orig2">🔊 Original</button><audio class="speak-audio" controls src="${recUrl}"></audio></div>`;
          box.querySelector('#pr-orig2').addEventListener('click', () => playExample(c));
        }
      }
    }

    // 인식(점수) + 병렬 녹음(내 발음 비교) — v93 스피킹과 동일 패턴, 완전 가드.
    function wirePrRec(mic, c) {
      let listening = false, rec = null, myRec = null, myStream = null, chunks = [];
      const label = () => root.querySelector('#pr-mic-label');
      function reset() { listening = false; mic.classList.remove('listening'); const l = label(); if (l) l.textContent = 'Speak'; }
      function stopMyRec() { try { if (myRec && myRec.state !== 'inactive') myRec.stop(); } catch (e) {} }
      mic.addEventListener('click', async () => {
        if (listening) { try { rec && rec.stop(); } catch (e) {} return; }
        chunks = [];
        let pendingUrl = null;
        try {
          myStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          myRec = new MediaRecorder(myStream); myRec.ondataavailable = (e) => chunks.push(e.data);
          myRec.onstop = () => {
            try { myStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
            if (chunks.length) { pendingUrl = URL.createObjectURL(new Blob(chunks, { type: 'audio/webm' }));
              const box = root.querySelector('#pr-compare'); if (box) revealAttachRec(box, pendingUrl, c); }
          };
          myRec.start();
        } catch (e) { myRec = null; }
        rec = new SR();
        rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1; rec.continuous = false;
        listening = true; mic.classList.add('listening');
        const l = label(); if (l) l.textContent = 'Listening…';
        rec.onresult = (e) => { reset(); revealPr((e.results[0][0].transcript || '').trim(), c); stopMyRec(); };
        rec.onerror = (e) => { reset(); stopMyRec(); const h = root.querySelector('#pr-hint'); if (h) h.textContent = (e.error === 'not-allowed') ? '🎙️ Please allow mic access' : 'Recognition failed — try again'; };
        rec.onend = () => { if (listening) { reset(); stopMyRec(); } };
        try { rec.start(); } catch (e) { reset(); stopMyRec(); }
      });
    }
    // revealPr 가 먼저 #pr-compare 를 만들고, 녹음 blob 이 준비되면 그 안에 A/B 를 채운다.
    function revealAttachRec(box, url, c) {
      box.innerHTML = `
        <div class="speak-ab-label">🎧 Replay my voice · compare</div>
        <div class="speak-ab-row"><button class="study-cta-btn secondary" id="pr-orig3">🔊 Original</button><audio class="speak-audio" controls src="${url}"></audio></div>`;
      box.querySelector('#pr-orig3').addEventListener('click', () => playExample(c));
    }

    function wirePrRecorder(mic, c) {
      let recorder = null, chunks = [], recording = false;
      const label = () => root.querySelector('#pr-mic-label');
      mic.addEventListener('click', async () => {
        if (recording) { try { recorder && recorder.stop(); } catch (e) {} return; }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          const h = root.querySelector('#pr-hint'); if (h) h.textContent = 'This browser does not support recording.'; mic.disabled = true; return;
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          recorder = new MediaRecorder(stream); chunks = [];
          recorder.ondataavailable = (e) => chunks.push(e.data);
          recorder.onstop = () => {
            stream.getTracks().forEach((t) => t.stop());
            const url = URL.createObjectURL(new Blob(chunks, { type: 'audio/webm' }));
            recording = false; mic.classList.remove('listening');
            revealPr('', c, url);  // 인식 불가 → 점수 없이 정답+내 녹음 비교만
          };
          recorder.start(); recording = true; mic.classList.add('listening');
          const l = label(); if (l) l.textContent = 'Recording… (tap to stop)';
        } catch (e) {
          const h = root.querySelector('#pr-hint'); if (h) h.textContent = '🎙️ Mic access needed.';
        }
      });
    }

    paintPr();
  }

  // ── 빈칸 채우기(Cloze) — 예문에서 표현을 가리고 떠올려 입력 → 능동 회상 ──
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function clozeBlank(ex, term, fill) {
    // term 출현 위치를 fill 로, 나머지는 escapeHtml — 조각별로 안전 결합(센티넬 불필요).
    const re = new RegExp(escapeRe(term), 'gi');
    let out = '', last = 0, m;
    while ((m = re.exec(ex)) !== null) {
      out += escapeHtml(ex.slice(last, m.index)) + fill;
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    return out + escapeHtml(ex.slice(last));
  }
  function startCloze() {
    stopClip();
    const pool = items.filter((v) => v.example_sentence && v.term &&
      v.example_sentence.toLowerCase().includes(v.term.toLowerCase()));
    if (!pool.length) {
      const el = root.querySelector('#study-list');
      if (el) el.innerHTML = '<div class="empty">No examples for cloze yet.</div>';
      return;
    }
    const cards = _shuffle(pool).slice(0, Math.min(20, pool.length));
    let idx = 0, correct = 0;
    prefetch(cards.slice(0, 4).map((c) => c.term));

    function finishC() {
      const pct = Math.round((correct / cards.length) * 100);
      const msg = pct >= 80 ? 'Got it down! 🧩' : pct >= 50 ? 'Nice! 💪' : 'Keep practicing 🔁';
      root.innerHTML = `
        <div class="quiz-summary">
          <div class="quiz-sum-msg">${msg}</div>
          <div class="quiz-sum-score">${correct}/${cards.length}</div>
          <div class="quiz-sum-pct">Cloze accuracy ${pct}%</div>
          <div class="quiz-sum-actions">
            <button class="study-cta-btn" id="cz-again">Again</button>
            <button class="study-cta-btn secondary" id="cz-home">Study Home</button>
          </div>
        </div>`;
      root.querySelector('#cz-again').addEventListener('click', startCloze);
      root.querySelector('#cz-home').addEventListener('click', () => renderStudy(root));
    }
    function paintC() {
      if (idx >= cards.length) return finishC();
      const c = cards[idx];
      root.innerHTML = `
        <div class="quiz-bar"><span class="quiz-count">${idx + 1} / ${cards.length}</span><span class="quiz-score">${correct} correct</span></div>
        <div class="cloze-card">
          <div class="dict-label">🧩 What fills the blank?</div>
          <div class="cloze-sent">${clozeBlank(c.example_sentence, c.term, '<span class="cloze-blank">____</span>')} <span class="speak-spk" id="cz-spk">🔊</span></div>
          ${c.definition ? `<div class="cloze-hint">Meaning: ${escapeHtml(c.definition)}</div>` : ''}
        </div>
        <input class="dict-input" id="cz-in" type="text" placeholder="Type the expression" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done" />
        <div class="dict-actions">
          <button class="study-cta-btn secondary" id="cz-skip">Don&#39;t know</button>
          <button class="study-cta-btn" id="cz-check">Check</button>
        </div>
        <div id="cz-result"></div>
        <button class="quiz-exit" id="cz-exit">← Study Home</button>`;
      const input = root.querySelector('#cz-in');
      input.focus();
      if (idx + 1 < cards.length) prefetch([cards[idx + 1].term]);
      root.querySelector('#cz-spk').addEventListener('click', () => playExample(c));  // 힌트: Shana 실제 문장 듣기(선택)
      requestAnimationFrame(() => playExample(c, undefined, true));  // 카드 표시 즉시 음성 자동 반복
      root.querySelector('#cz-exit').addEventListener('click', () => renderStudy(root));
      root.querySelector('#cz-skip').addEventListener('click', () => reveal(0));
      root.querySelector('#cz-check').addEventListener('click', () => reveal(scoreText(input.value, c.term)));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') reveal(scoreText(input.value, c.term)); });

      function reveal(score) {
        stopClip();  // 답 제출 → 자동반복 정지
        if (score >= 0.85) correct++;
        const cls = score >= 0.85 ? 'correct' : score >= 0.5 ? 'partial' : 'wrong';
        const label = score >= 0.85 ? 'Correct! 🎉' : score >= 0.5 ? 'Almost!' : 'Wrong';
        root.querySelector('#cz-check').disabled = true;
        root.querySelector('#cz-skip').disabled = true;
        input.disabled = true;
        root.querySelector('#cz-result').innerHTML = `
          <div class="dict-result ${cls}">
            <div class="dict-score">${label} — <b>${escapeHtml(c.term)}</b></div>
            <div class="dict-answer">${clozeBlank(c.example_sentence, c.term, `<b class="cloze-ans">${escapeHtml(c.term)}</b>`)}</div>
            ${c.definition ? `<div class="dict-def">${escapeHtml(c.definition)}</div>` : ''}
            <button class="study-cta-btn" id="cz-next">Next →</button>
          </div>`;
        speak(c.term);
        root.querySelector('#cz-next').addEventListener('click', () => { idx++; paintC(); });
      }
    }
    paintC();
  }

  if (!selected) {
    root.innerHTML = heroHtml() + '<div class="empty">No expression data yet.</div>';
    return;
  }
  await loadKind(selected);
}
