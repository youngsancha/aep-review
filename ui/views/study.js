// Study 탭 — 에피소드에서 추출된 실생활 표현을 종류별로 탐색하는 허브.
// 데이터는 기존 vocab_cards (claude 추출, 영+한 정의, 타임스탬프). SRS 복습은 #/srs 가 담당.
import { escapeHtml, highlightTerm } from '/app.js';
import { studyOverview, expressionsByKind, markKnown } from '/db.js';
import { speak, prefetch } from '/tts.js';
import { playSentenceClip, stopClip } from '/clip.js';
import { translateEnKo } from '/translate.js';

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
function playExample(c, rate) {
  if (!c) return;
  if (c.audio_url && c.sentence_start_sec != null)
    playSentenceClip(c.audio_url, c.sentence_start_sec, c.sentence_end_sec, null, rate);
  else
    speak(c.example_sentence, rate ? { playbackRate: rate } : undefined);
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
    root.innerHTML = `<div class="empty">불러오기 실패: ${escapeHtml(e.message)}</div>`;
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
        <div class="study-greet-sub">지금 알아야 할 실생활 표현 ${ov.total.toLocaleString()}개</div>
      </div>
      <div class="study-progress-card">
        <svg class="study-ring" viewBox="0 0 80 80" width="96" height="96" aria-hidden="true">
          <circle class="study-ring-bg" cx="40" cy="40" r="34"></circle>
          <circle class="study-ring-fg" id="study-ring-fg" cx="40" cy="40" r="34"
                  stroke-dasharray="${ringDash(pct)}" transform="rotate(-90 40 40)"></circle>
          <text x="40" y="38" class="study-ring-pct" id="study-ring-pct">${pct}%</text>
          <text x="40" y="53" class="study-ring-sub">알아요</text>
        </svg>
        <div class="study-progress-meta">
          <div class="study-progress-big"><b id="study-known-n">${knownCount.toLocaleString()}</b><span> / ${ov.total.toLocaleString()} 표현 마스터</span></div>
          <div class="study-progress-pills">
            ${getStreak() > 0 ? `<span class="study-pill streak">🔥 ${getStreak()}일 연속</span>` : ''}
            <span class="study-pill">📚 학습 ${ov.learned.toLocaleString()}</span>
            <span class="study-pill">🔁 복습 ${ov.due.toLocaleString()}</span>
          </div>
          <div class="study-ovbar"><span id="study-known-bar" style="width:${pct}%"></span></div>
        </div>
      </div>
      ${ov.due > 0 ? `
        <a class="study-cta" href="#/srs">
          <div class="study-cta-t">🔁 오늘 복습 ${ov.due}개</div>
          <div class="study-cta-m">플래시카드로 정리하기 ▸</div>
        </a>` : ''}
      <div class="study-kinds">
        ${kinds.map((k) => `
          <button class="study-kind-chip${k.kind === selected ? ' on' : ''}" data-kind="${k.kind}">
            <span class="study-kind-emoji">${KIND_EMOJI[k.kind] || '•'}</span>
            <span class="study-kind-name">${KIND_LABEL[k.kind] || k.kind}</span>
            <span class="study-kind-n">${k.total}</span>
          </button>`).join('')}
      </div>
      <input class="study-search" id="study-q" type="search" placeholder="🔍 표현·뜻 검색" value="${escapeHtml(q)}" />
      <div class="study-quiz-row">
        <button class="study-quiz-btn" id="study-quiz-read">🎯 4지선다</button>
        <button class="study-quiz-btn" id="study-quiz-listen">🎧 듣기</button>
        <button class="study-quiz-btn" id="study-quiz-dict">✍️ 받아쓰기</button>
        <button class="study-quiz-btn" id="study-quiz-cloze">🧩 빈칸</button>
        <button class="study-quiz-btn" id="study-quiz-speak">🎤 스피킹</button>
        <button class="study-quiz-btn" id="study-quiz-prod">🗣️ 한→영</button>
        <button class="study-quiz-btn" id="study-quiz-sent">💬 문장</button>
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

  function rowHtml(v) {
    const epTitle = (v.episode_title || '').replace(/^\d+\s*[-:.]\s*/, '');
    return `
      <li class="study-x${v.known ? ' known' : ''}" data-id="${v.id}" data-ep="${v.episode_id}" data-t="${v.sentence_start_sec != null ? Math.floor(v.sentence_start_sec) : ''}">
        <div class="study-x-top">
          <span class="study-x-term">${escapeHtml(v.term)}</span>
          <button class="study-x-tts" data-text="${escapeHtml(v.term)}" aria-label="발음 듣기">🔊</button>
          <button class="study-x-know" data-id="${v.id}" aria-label="알아요로 표시">${v.known ? '✓ 알아요' : '알아요'}</button>
        </div>
        ${v.definition ? `<div class="study-x-def">${escapeHtml(v.definition)}</div>` : ''}
        ${v.example_sentence ? `
          <div class="study-x-ex">
            <span class="study-x-ex-q">“${highlightTerm(v.example_sentence, v.term)}”</span>
            ${(v.audio_url && v.sentence_start_sec != null)
              ? `<button class="study-x-ctx" data-url="${escapeHtml(v.audio_url)}" data-s="${v.sentence_start_sec}" data-e="${v.sentence_end_sec ?? ''}" aria-label="맥락에서 듣기(실제 음성)">🎧</button>` : ''}
            <button class="study-x-exspk" data-text="${escapeHtml(v.example_sentence)}" aria-label="문장 듣기(TTS)">🔊</button>
          </div>` : ''}
        ${epTitle ? `<div class="study-x-ep">🎧 ${escapeHtml(epTitle)}</div>` : ''}
      </li>`;
  }

  function listHtml() {
    const ql = q.toLowerCase();
    const filtered = !ql ? items
      : items.filter((v) => (v.term || '').toLowerCase().includes(ql) || (v.definition || '').toLowerCase().includes(ql));
    if (!filtered.length) return '<div class="empty">해당 표현이 없어요.</div>';
    return `<ul class="study-xlist">${filtered.map(rowHtml).join('')}</ul>`;
  }

  function wireList() {
    root.querySelectorAll('.study-x-tts, .study-x-exspk').forEach((b) =>
      b.addEventListener('click', (e) => { e.stopPropagation(); speak(b.dataset.text); }));
    // '맥락에서 듣기'(#19/#20): 화면 전환 없이 그 문장의 '실제 음성'만 인라인 재생.
    root.querySelectorAll('.study-x-ctx').forEach((b) =>
      b.addEventListener('click', (e) => { e.stopPropagation(); playSentenceClip(b.dataset.url, b.dataset.s, b.dataset.e, b); }));
    root.querySelectorAll('.study-x-know').forEach((b) =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const li = b.closest('.study-x');
        if (!li || li.classList.contains('known')) return;  // 이미 알아요
        const id = Number(b.dataset.id);
        b.disabled = true;
        try {
          await markKnown(id);
          li.classList.add('known');
          b.textContent = '✓ 알아요';
          const item = items.find((x) => x.id === id); if (item) item.known = true;
          applyKnown(1);
          if (navigator.vibrate) navigator.vibrate(10);
        } catch (err) {
          b.disabled = false;
        }
      }));
    // (#19) 카드 본문을 클릭하면 에피소드(사용자 인지: Library)로 튕기던 동작 제거 —
    // 카드는 '학습용'(읽기 + 발음·맥락·알아요 버튼)으로만 동작. 의도치 않은 화면전환 X.
    prefetch([...root.querySelectorAll('.study-x-term')].slice(0, 8).map((e) => e.textContent));
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
    const sq = root.querySelector('#study-q');
    if (sq) {
      let t = 0;
      sq.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          q = sq.value.trim();
          root.querySelector('#study-list').innerHTML = listHtml();
          wireList();
          const s2 = root.querySelector('#study-q');
          s2.focus();
          s2.setSelectionRange(s2.value.length, s2.value.length);
        }, 150);
      });
    }
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
      if (el) el.innerHTML = '<div class="empty">퀴즈를 만들 표현이 부족해요(4개 이상 필요).</div>';
      return;
    }
    const N = Math.min(10, pool.length);
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
        ? `<button class="quiz-bigspk" id="q-spk" aria-label="다시 듣기">🔊</button>
           <div class="quiz-q">듣고 알맞은 뜻을 고르세요</div>`
        : `<div class="quiz-def">${escapeHtml(c.definition)}</div>
           <button class="quiz-spk" id="q-spk" aria-label="발음 듣기">🔊 발음 힌트</button>
           <div class="quiz-q">알맞은 표현을 고르세요</div>`;
      root.innerHTML = `
        <div class="quiz-bar"><span class="quiz-count">${idx + 1} / ${qs.length}</span><span class="quiz-score">${score}점</span></div>
        <div class="quiz-prompt">${promptHtml}</div>
        <div class="quiz-opts">
          ${qs[idx].options.map((o) => `<button class="quiz-opt${mode === 'listen' ? ' quiz-opt-def' : ''}" data-ok="${o.id === c.id ? '1' : '0'}">${escapeHtml(optLabel(o))}</button>`).join('')}
        </div>
        <button class="quiz-exit" id="q-exit">← Study 홈</button>`;
      root.querySelector('#q-spk').addEventListener('click', () => speak(c.term));
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
      const msg = pct >= 80 ? '훌륭해요! 🎉' : pct >= 50 ? '잘했어요! 💪' : '다시 도전! 🔥';
      root.innerHTML = `
        <div class="quiz-summary">
          <div class="quiz-sum-msg">${msg}</div>
          <div class="quiz-sum-score">${score}/${qs.length}</div>
          <div class="quiz-sum-pct">정답률 ${pct}%</div>
          <div class="quiz-sum-actions">
            <button class="study-cta-btn" id="q-again">다시 풀기</button>
            <button class="study-cta-btn secondary" id="q-home">Study 홈</button>
          </div>
        </div>`;
      root.querySelector('#q-again').addEventListener('click', startQuiz);
      root.querySelector('#q-home').addEventListener('click', () => renderStudy(root));
    }
    paintQ();
  }

  // ── 문장 학습 덱 (예문을 듣고/읽고 → 뜻·표현 공개, 문장 단위 이해) ──
  function startSentences() {
    stopClip();
    const pool = items.filter((v) => v.example_sentence && v.example_sentence.trim());
    if (!pool.length) {
      const el = root.querySelector('#study-list');
      if (el) el.innerHTML = '<div class="empty">예문이 있는 표현이 아직 없어요.</div>';
      return;
    }
    const cards = _shuffle(pool).slice(0, Math.min(20, pool.length));
    let idx = 0, revealed = false;
    prefetch(cards.slice(0, 6).map((c) => c.example_sentence));

    function finishS() {
      root.innerHTML = `
        <div class="quiz-summary">
          <div class="quiz-sum-msg">문장 완독! 📖</div>
          <div class="quiz-sum-score">${cards.length}</div>
          <div class="quiz-sum-pct">예문 학습 완료</div>
          <div class="quiz-sum-actions">
            <button class="study-cta-btn" id="s-again">다시</button>
            <button class="study-cta-btn secondary" id="s-home">Study 홈</button>
          </div>
        </div>`;
      root.querySelector('#s-again').addEventListener('click', startSentences);
      root.querySelector('#s-home').addEventListener('click', () => renderStudy(root));
    }
    function paintS() {
      stopClip();  // 다음 문장 카드로 넘어가면 이전 맥락 재생 정지
      if (idx >= cards.length) return finishS();
      const c = cards[idx];
      revealed = false;
      root.innerHTML = `
        <div class="quiz-bar"><span class="quiz-count">${idx + 1} / ${cards.length}</span><span class="quiz-score">💬 문장</span></div>
        <div class="sent-card" id="sent-card">
          <div class="sent-en">${escapeHtml(c.example_sentence)} <span class="sent-spk">🔊</span></div>
          <div class="sent-reveal" id="sent-reveal" hidden>
            <div class="sent-term">${escapeHtml(c.term)}</div>
            <div class="sent-def">${escapeHtml(c.definition || '')}</div>
            ${(c.sentence_start_sec != null && c.audio_url) ? `<button class="srs-context-btn" id="sent-ctx" data-url="${escapeHtml(c.audio_url)}" data-s="${c.sentence_start_sec}" data-e="${c.sentence_end_sec ?? ''}">🎧 맥락에서 듣기</button>` : ''}
          </div>
        </div>
        <button class="study-cta-btn" id="sent-action">뜻 보기</button>
        <button class="quiz-exit" id="sent-exit">← Study 홈</button>`;
      root.querySelector('#sent-card').addEventListener('click', () => playExample(c));
      requestAnimationFrame(() => playExample(c));
      if (idx + 1 < cards.length) prefetch([cards[idx + 1].example_sentence]);
      root.querySelector('#sent-exit').addEventListener('click', () => renderStudy(root));
      root.querySelector('#sent-action').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!revealed) {
          revealed = true;
          root.querySelector('#sent-reveal').hidden = false;
          e.target.textContent = '다음 ▸';
          const cx = root.querySelector('#sent-ctx');
          if (cx) cx.addEventListener('click', (ev) => { ev.stopPropagation(); playSentenceClip(cx.dataset.url, cx.dataset.s, cx.dataset.e, cx); });
        } else { idx++; paintS(); }
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
      if (el) el.innerHTML = '<div class="empty">예문이 있는 표현이 아직 없어요.</div>';
      return;
    }
    const cards = _shuffle(pool).slice(0, Math.min(12, pool.length));
    let idx = 0, correct = 0;
    prefetch(cards.slice(0, 4).map((c) => c.example_sentence));

    function finishD() {
      const pct = Math.round((correct / cards.length) * 100);
      const msg = pct >= 80 ? '귀가 트였어요! 👂' : pct >= 50 ? '점점 들려요! 💪' : '반복이 답! 🔁';
      root.innerHTML = `
        <div class="quiz-summary">
          <div class="quiz-sum-msg">${msg}</div>
          <div class="quiz-sum-score">${correct}/${cards.length}</div>
          <div class="quiz-sum-pct">받아쓰기 정확도 ${pct}%</div>
          <div class="quiz-sum-actions">
            <button class="study-cta-btn" id="d-again">다시</button>
            <button class="study-cta-btn secondary" id="d-home">Study 홈</button>
          </div>
        </div>`;
      root.querySelector('#d-again').addEventListener('click', startDictation);
      root.querySelector('#d-home').addEventListener('click', () => renderStudy(root));
    }
    function paintD() {
      if (idx >= cards.length) return finishD();
      const c = cards[idx];
      root.innerHTML = `
        <div class="quiz-bar"><span class="quiz-count">${idx + 1} / ${cards.length}</span><span class="quiz-score">${correct} 맞음</span></div>
        <div class="dict-card">
          <div class="dict-label">🎧 듣고 받아쓰기</div>
          <button class="quiz-bigspk" id="d-spk" aria-label="다시 듣기">🔊</button>
          <div class="dict-slow"><button class="dict-slow-btn" id="d-slow">🐢 천천히</button></div>
        </div>
        <textarea class="dict-input" id="d-in" rows="2" placeholder="들은 문장을 입력하세요" autocomplete="off" autocorrect="off" autocapitalize="sentences" spellcheck="false" enterkeyhint="done"></textarea>
        <div class="dict-actions">
          <button class="study-cta-btn secondary" id="d-skip">모르겠어요</button>
          <button class="study-cta-btn" id="d-check">채점</button>
        </div>
        <div id="d-result"></div>
        <button class="quiz-exit" id="d-exit">← Study 홈</button>`;
      const input = root.querySelector('#d-in');
      input.focus();
      const replay = (pb) => playExample(c, pb);  // Shana 실제 음성(없으면 TTS), 천천히=속도인자
      requestAnimationFrame(() => replay());
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
        if (score >= 0.9) correct++;
        const cls = score >= 0.9 ? 'correct' : score >= 0.6 ? 'partial' : 'wrong';
        const label = score >= 0.9 ? '정답! 🎉' : score >= 0.6 ? '거의 맞았어요' : '다시 들어보세요';
        root.querySelector('#d-check').disabled = true;
        root.querySelector('#d-skip').disabled = true;
        input.disabled = true;
        root.querySelector('#d-result').innerHTML = `
          <div class="dict-result ${cls}">
            <div class="dict-score">${Math.round(score * 100)}점 · ${label}</div>
            <div class="dict-answer">${diffHtml(input.value, c.example_sentence)}</div>
            ${c.definition ? `<div class="dict-def">${escapeHtml(c.term)} — ${escapeHtml(c.definition)}</div>` : ''}
            <button class="study-cta-btn" id="d-next">다음 →</button>
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
      if (el) el.innerHTML = '<div class="empty">예문이 있는 표현이 아직 없어요.</div>';
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const cards = _shuffle(pool).slice(0, Math.min(12, pool.length));
    let idx = 0, scoreSum = 0, scored = 0;
    prefetch(cards.slice(0, 4).map((c) => c.example_sentence));

    function finishSp() {
      const avg = scored ? Math.round(scoreSum / scored) : 0;
      const msg = !scored ? '연습 완료! 🎤' : avg >= 80 ? '원어민급 발음! 🌟' : avg >= 55 ? '좋아요, 더 또렷하게! 💪' : '천천히 따라 말해봐요 🔁';
      root.innerHTML = `
        <div class="quiz-summary">
          <div class="quiz-sum-msg">${msg}</div>
          <div class="quiz-sum-score">${scored ? avg + '점' : cards.length}</div>
          <div class="quiz-sum-pct">${scored ? '평균 발음 정확도' : '문장 따라 말하기 완료'}</div>
          <div class="quiz-sum-actions">
            <button class="study-cta-btn" id="sp-again">다시</button>
            <button class="study-cta-btn secondary" id="sp-home">Study 홈</button>
          </div>
        </div>`;
      root.querySelector('#sp-again').addEventListener('click', startSpeaking);
      root.querySelector('#sp-home').addEventListener('click', () => renderStudy(root));
    }

    function paintSp() {
      if (idx >= cards.length) return finishSp();
      const c = cards[idx];
      root.innerHTML = `
        <div class="quiz-bar"><span class="quiz-count">${idx + 1} / ${cards.length}</span><span class="quiz-score">🎤 스피킹</span></div>
        <div class="speak-card">
          <div class="speak-label">🎯 듣고 따라 말하세요</div>
          <div class="speak-target" id="sp-target">${escapeHtml(c.example_sentence)} <span class="speak-spk">🔊</span></div>
          ${c.definition ? `<div class="speak-def">${escapeHtml(c.definition)}</div>` : ''}
        </div>
        <button class="speak-mic" id="sp-mic"><span class="speak-mic-ico">🎤</span><span id="sp-mic-label">말하기</span></button>
        <div class="speak-hint" id="sp-hint">${SR ? '버튼을 누르고 또렷하게 말해보세요' : '⚠️ 음성 인식 미지원 브라우저 — 녹음 후 직접 비교해요 (Chrome·Android 권장)'}</div>
        <div id="sp-result"></div>
        <div class="dict-actions"><button class="study-cta-btn secondary" id="sp-skip">넘어가기</button></div>
        <button class="quiz-exit" id="sp-exit">← Study 홈</button>`;
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
          <div class="dict-score">발음 정확도 ${sc}점</div>
          <div class="dict-answer">${diffHtml(said, c.example_sentence)}</div>
          <div class="speak-heard">인식: “${escapeHtml(said || '—')}”</div>
          <div id="sp-compare" class="speak-compare"></div>
          <button class="study-cta-btn" id="sp-next">다음 →</button>
        </div>`;
      root.querySelector('#sp-next').addEventListener('click', () => { idx++; paintSp(); });
    }

    // 내 발음 녹음이 준비되면 결과에 'A/B 비교'(원문 ↔ 내 발음)를 끼워넣는다.
    // 네이티브 발음을 익히는 가장 강력한 도구 = 내 목소리를 원어민 모델과 바로 들어비교.
    function injectCompare(url, c) {
      const box = root.querySelector('#sp-compare');
      if (!box) return;
      box.innerHTML = `
        <div class="speak-ab-label">🎧 내 발음 다시 듣기 · 원문과 비교</div>
        <div class="speak-ab-row">
          <button class="study-cta-btn secondary" id="sp-orig2">🔊 원문</button>
          <audio class="speak-audio" controls src="${url}"></audio>
        </div>`;
      box.querySelector('#sp-orig2').addEventListener('click', () => playExample(c));
    }

    function wireRecognition(mic, c) {
      let listening = false, rec = null;
      let myRec = null, myStream = null, chunks = [];
      const label = () => root.querySelector('#sp-mic-label');
      function reset() { listening = false; mic.classList.remove('listening'); const l = label(); if (l) l.textContent = '말하기'; }
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
        rec = new SR();
        rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1; rec.continuous = false;
        listening = true; mic.classList.add('listening');
        const l = label(); if (l) l.textContent = '듣는 중…';
        rec.onresult = (e) => { reset(); showResult((e.results[0][0].transcript || '').trim(), c); stopMyRec(); };
        rec.onerror = (e) => { reset(); stopMyRec(); const h = root.querySelector('#sp-hint'); if (h) h.textContent = (e.error === 'not-allowed') ? '🎙️ 마이크 권한을 허용해주세요' : '인식 실패 — 다시 시도'; };
        rec.onend = () => { if (listening) { reset(); stopMyRec(); } };
        try { rec.start(); } catch (e) { reset(); stopMyRec(); }
      });
    }

    function wireRecorder(mic, c) {
      let recorder = null, chunks = [], recording = false;
      const label = () => root.querySelector('#sp-mic-label');
      mic.addEventListener('click', async () => {
        if (recording) { try { recorder && recorder.stop(); } catch (e) {} return; }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          const h = root.querySelector('#sp-hint'); if (h) h.textContent = '이 브라우저는 녹음을 지원하지 않아요.';
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
            const l = label(); if (l) l.textContent = '다시 녹음';
            root.querySelector('#sp-result').innerHTML = `
              <div class="dict-result partial">
                <div class="dict-score">내 발음 vs 원문</div>
                <audio class="speak-audio" controls src="${url}"></audio>
                <div class="dict-actions">
                  <button class="study-cta-btn secondary" id="sp-orig">🔊 원문</button>
                  <button class="study-cta-btn" id="sp-next">다음 →</button>
                </div>
              </div>`;
            root.querySelector('#sp-orig').addEventListener('click', () => playExample(c));
            root.querySelector('#sp-next').addEventListener('click', () => { idx++; paintSp(); });
          };
          recorder.start(); recording = true; mic.classList.add('listening');
          const l = label(); if (l) l.textContent = '녹음 중… (탭하면 종료)';
        } catch (e) {
          const h = root.querySelector('#sp-hint'); if (h) h.textContent = '🎙️ 마이크 권한이 필요해요.';
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
      if (el) el.innerHTML = '<div class="empty">말하기 연습할 예문이 아직 없어요.</div>';
      return;
    }
    const cards = _shuffle(pool).slice(0, Math.min(10, pool.length));
    let idx = 0, scoreSum = 0, scored = 0;

    function finishPr() {
      const avg = scored ? Math.round(scoreSum / scored) : 0;
      const msg = !scored ? '연습 완료! 🗣️' : avg >= 80 ? '원어민처럼 구사했어요! 🌟' : avg >= 55 ? '좋아요, 더 자연스럽게! 💪' : '천천히 영어로 옮겨봐요 🔁';
      root.innerHTML = `
        <div class="quiz-summary">
          <div class="quiz-sum-msg">${msg}</div>
          <div class="quiz-sum-score">${scored ? avg + '점' : cards.length}</div>
          <div class="quiz-sum-pct">${scored ? '평균 생산(말하기) 정확도' : '한→영 말하기 완료'}</div>
          <div class="quiz-sum-actions">
            <button class="study-cta-btn" id="pr-again">다시</button>
            <button class="study-cta-btn secondary" id="pr-home">Study 홈</button>
          </div>
        </div>`;
      root.querySelector('#pr-again').addEventListener('click', startProduction);
      root.querySelector('#pr-home').addEventListener('click', () => renderStudy(root));
    }

    async function paintPr() {
      if (idx >= cards.length) return finishPr();
      const c = cards[idx];
      root.innerHTML = `
        <div class="quiz-bar"><span class="quiz-count">${idx + 1} / ${cards.length}</span><span class="quiz-score">🗣️ 한→영</span></div>
        <div class="speak-card">
          <div class="speak-label">🇰🇷 한국어를 보고 영어로 말하세요</div>
          <div class="prod-ko" id="pr-ko">번역 불러오는 중…</div>
          ${c.term ? `<div class="speak-def">힌트 표현: <b>${escapeHtml(c.term)}</b></div>` : ''}
        </div>
        <button class="speak-mic" id="pr-mic"><span class="speak-mic-ico">🎤</span><span id="pr-mic-label">${SR ? '말하기' : '녹음'}</span></button>
        <div class="speak-hint" id="pr-hint">${SR ? '영어로 말한 뒤 정답과 비교돼요' : '⚠️ 음성 인식 미지원 — 녹음 후 정답과 비교 (Chrome·Android 권장)'}</div>
        <div id="pr-result"></div>
        <div class="dict-actions"><button class="study-cta-btn secondary" id="pr-reveal">모르겠어요 (정답 보기)</button></div>
        <button class="quiz-exit" id="pr-exit">← Study 홈</button>`;
      root.querySelector('#pr-exit').addEventListener('click', () => renderStudy(root));
      root.querySelector('#pr-reveal').addEventListener('click', () => revealPr('', c));
      // 한국어는 비동기 로드(실패해도 진행: 표현 뜻 폴백). translateEnKo 는 절대 throw 안 함.
      const ko = await translateEnKo(c.example_sentence);
      const koEl = root.querySelector('#pr-ko');
      if (koEl) koEl.textContent = ko || (c.definition ? `(뜻 힌트) ${c.definition}` : '표현을 활용해 영어로 말해보세요');
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
          <div class="dict-score">${said ? `생산 정확도 ${sc}점` : '정답'}</div>
          <div class="dict-answer">${said ? diffHtml(said, c.example_sentence) : escapeHtml(c.example_sentence)}</div>
          ${said ? `<div class="speak-heard">내가 말함: “${escapeHtml(said)}”</div>` : ''}
          <div id="pr-compare" class="speak-compare"></div>
          <button class="study-cta-btn" id="pr-next">다음 →</button>
        </div>`;
      root.querySelector('#pr-next').addEventListener('click', () => { idx++; paintPr(); });
      requestAnimationFrame(() => playExample(c));  // 정답 원어민 음성 자동 재생(귀로 확인)
      if (recUrl) {
        const box = root.querySelector('#pr-compare');
        if (box) {
          box.innerHTML = `
            <div class="speak-ab-label">🎧 내 발음 다시 듣기 · 원문과 비교</div>
            <div class="speak-ab-row"><button class="study-cta-btn secondary" id="pr-orig2">🔊 원문</button><audio class="speak-audio" controls src="${recUrl}"></audio></div>`;
          box.querySelector('#pr-orig2').addEventListener('click', () => playExample(c));
        }
      }
    }

    // 인식(점수) + 병렬 녹음(내 발음 비교) — v93 스피킹과 동일 패턴, 완전 가드.
    function wirePrRec(mic, c) {
      let listening = false, rec = null, myRec = null, myStream = null, chunks = [];
      const label = () => root.querySelector('#pr-mic-label');
      function reset() { listening = false; mic.classList.remove('listening'); const l = label(); if (l) l.textContent = '말하기'; }
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
        const l = label(); if (l) l.textContent = '듣는 중…';
        rec.onresult = (e) => { reset(); revealPr((e.results[0][0].transcript || '').trim(), c); stopMyRec(); };
        rec.onerror = (e) => { reset(); stopMyRec(); const h = root.querySelector('#pr-hint'); if (h) h.textContent = (e.error === 'not-allowed') ? '🎙️ 마이크 권한을 허용해주세요' : '인식 실패 — 다시 시도'; };
        rec.onend = () => { if (listening) { reset(); stopMyRec(); } };
        try { rec.start(); } catch (e) { reset(); stopMyRec(); }
      });
    }
    // revealPr 가 먼저 #pr-compare 를 만들고, 녹음 blob 이 준비되면 그 안에 A/B 를 채운다.
    function revealAttachRec(box, url, c) {
      box.innerHTML = `
        <div class="speak-ab-label">🎧 내 발음 다시 듣기 · 원문과 비교</div>
        <div class="speak-ab-row"><button class="study-cta-btn secondary" id="pr-orig3">🔊 원문</button><audio class="speak-audio" controls src="${url}"></audio></div>`;
      box.querySelector('#pr-orig3').addEventListener('click', () => playExample(c));
    }

    function wirePrRecorder(mic, c) {
      let recorder = null, chunks = [], recording = false;
      const label = () => root.querySelector('#pr-mic-label');
      mic.addEventListener('click', async () => {
        if (recording) { try { recorder && recorder.stop(); } catch (e) {} return; }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          const h = root.querySelector('#pr-hint'); if (h) h.textContent = '이 브라우저는 녹음을 지원하지 않아요.'; mic.disabled = true; return;
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
          const l = label(); if (l) l.textContent = '녹음 중… (탭하면 종료)';
        } catch (e) {
          const h = root.querySelector('#pr-hint'); if (h) h.textContent = '🎙️ 마이크 권한이 필요해요.';
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
      if (el) el.innerHTML = '<div class="empty">빈칸을 만들 예문이 아직 없어요.</div>';
      return;
    }
    const cards = _shuffle(pool).slice(0, Math.min(12, pool.length));
    let idx = 0, correct = 0;
    prefetch(cards.slice(0, 4).map((c) => c.term));

    function finishC() {
      const pct = Math.round((correct / cards.length) * 100);
      const msg = pct >= 80 ? '표현이 손에 익었어요! 🧩' : pct >= 50 ? '좋아요! 💪' : '반복해서 익혀봐요 🔁';
      root.innerHTML = `
        <div class="quiz-summary">
          <div class="quiz-sum-msg">${msg}</div>
          <div class="quiz-sum-score">${correct}/${cards.length}</div>
          <div class="quiz-sum-pct">빈칸 정확도 ${pct}%</div>
          <div class="quiz-sum-actions">
            <button class="study-cta-btn" id="cz-again">다시</button>
            <button class="study-cta-btn secondary" id="cz-home">Study 홈</button>
          </div>
        </div>`;
      root.querySelector('#cz-again').addEventListener('click', startCloze);
      root.querySelector('#cz-home').addEventListener('click', () => renderStudy(root));
    }
    function paintC() {
      if (idx >= cards.length) return finishC();
      const c = cards[idx];
      root.innerHTML = `
        <div class="quiz-bar"><span class="quiz-count">${idx + 1} / ${cards.length}</span><span class="quiz-score">${correct} 맞음</span></div>
        <div class="cloze-card">
          <div class="dict-label">🧩 빈칸에 들어갈 표현은?</div>
          <div class="cloze-sent">${clozeBlank(c.example_sentence, c.term, '<span class="cloze-blank">____</span>')} <span class="speak-spk" id="cz-spk">🔊</span></div>
          ${c.definition ? `<div class="cloze-hint">뜻: ${escapeHtml(c.definition)}</div>` : ''}
        </div>
        <input class="dict-input" id="cz-in" type="text" placeholder="표현 입력" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done" />
        <div class="dict-actions">
          <button class="study-cta-btn secondary" id="cz-skip">모르겠어요</button>
          <button class="study-cta-btn" id="cz-check">확인</button>
        </div>
        <div id="cz-result"></div>
        <button class="quiz-exit" id="cz-exit">← Study 홈</button>`;
      const input = root.querySelector('#cz-in');
      input.focus();
      if (idx + 1 < cards.length) prefetch([cards[idx + 1].term]);
      root.querySelector('#cz-spk').addEventListener('click', () => playExample(c));  // 힌트: Shana 실제 문장 듣기(선택)
      root.querySelector('#cz-exit').addEventListener('click', () => renderStudy(root));
      root.querySelector('#cz-skip').addEventListener('click', () => reveal(0));
      root.querySelector('#cz-check').addEventListener('click', () => reveal(scoreText(input.value, c.term)));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') reveal(scoreText(input.value, c.term)); });

      function reveal(score) {
        if (score >= 0.85) correct++;
        const cls = score >= 0.85 ? 'correct' : score >= 0.5 ? 'partial' : 'wrong';
        const label = score >= 0.85 ? '정답! 🎉' : score >= 0.5 ? '거의 맞았어요' : '오답';
        root.querySelector('#cz-check').disabled = true;
        root.querySelector('#cz-skip').disabled = true;
        input.disabled = true;
        root.querySelector('#cz-result').innerHTML = `
          <div class="dict-result ${cls}">
            <div class="dict-score">${label} — <b>${escapeHtml(c.term)}</b></div>
            <div class="dict-answer">${clozeBlank(c.example_sentence, c.term, `<b class="cloze-ans">${escapeHtml(c.term)}</b>`)}</div>
            ${c.definition ? `<div class="dict-def">${escapeHtml(c.definition)}</div>` : ''}
            <button class="study-cta-btn" id="cz-next">다음 →</button>
          </div>`;
        speak(c.term);
        root.querySelector('#cz-next').addEventListener('click', () => { idx++; paintC(); });
      }
    }
    paintC();
  }

  if (!selected) {
    root.innerHTML = heroHtml() + '<div class="empty">표현 데이터가 아직 없어요.</div>';
    return;
  }
  await loadKind(selected);
}
