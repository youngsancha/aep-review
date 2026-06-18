// Study 탭 — 에피소드에서 추출된 실생활 표현을 종류별로 탐색하는 허브.
// 데이터는 기존 vocab_cards (claude 추출, 영+한 정의, 타임스탬프). SRS 복습은 #/srs 가 담당.
import { escapeHtml } from '/app.js';
import { studyOverview, expressionsByKind } from '/db.js';
import { speak, prefetch } from '/tts.js';

const KIND_LABEL = { idiom: 'Idioms', phrasal_verb: 'Phrasal Verbs', collocation: 'Collocations', word: 'Words' };
const KIND_EMOJI = { idiom: '💬', phrasal_verb: '🔗', collocation: '🧩', word: '📖' };

export async function renderStudy(root) {
  root.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
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

  function heroHtml() {
    const pct = ov.total ? Math.round((ov.learned / ov.total) * 100) : 0;
    return `
      <div class="study-greet">
        <h2>Study</h2>
        <div class="study-greet-sub">에피소드 속 실생활 표현 ${ov.total.toLocaleString()}개</div>
      </div>
      <div class="study-hero">
        <div class="study-hcol"><div class="study-hnum">${ov.learned}</div><div class="study-hlbl">학습</div></div>
        <div class="study-hsep"></div>
        <div class="study-hcol"><div class="study-hnum">${ov.total}</div><div class="study-hlbl">전체 표현</div></div>
        <div class="study-hsep"></div>
        <div class="study-hcol"><div class="study-hnum">${ov.due}</div><div class="study-hlbl">복습 대기</div></div>
      </div>
      <div class="study-ovbar"><span style="width:${pct}%"></span></div>
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
        <button class="study-quiz-btn" id="study-quiz-sent">💬 문장</button>
      </div>
    `;
  }

  function rowHtml(v) {
    const epTitle = (v.episode_title || '').replace(/^\d+\s*[-:.]\s*/, '');
    return `
      <li class="study-x" data-ep="${v.episode_id}" data-t="${v.sentence_start_sec != null ? Math.floor(v.sentence_start_sec) : ''}">
        <div class="study-x-top">
          <span class="study-x-term">${escapeHtml(v.term)}</span>
          <button class="study-x-tts" data-text="${escapeHtml(v.term)}" aria-label="발음 듣기">🔊</button>
        </div>
        ${v.definition ? `<div class="study-x-def">${escapeHtml(v.definition)}</div>` : ''}
        ${epTitle ? `<div class="study-x-ep">${escapeHtml(epTitle)}</div>` : ''}
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
    root.querySelectorAll('.study-x-tts').forEach((b) =>
      b.addEventListener('click', (e) => { e.stopPropagation(); speak(b.dataset.text); }));
    root.querySelectorAll('.study-x').forEach((li) =>
      li.addEventListener('click', () => {
        if (!li.dataset.ep) return;
        location.hash = li.dataset.t ? `#/episode/${li.dataset.ep}/${li.dataset.t}` : `#/episode/${li.dataset.ep}`;
      }));
    prefetch([...root.querySelectorAll('.study-x-term')].slice(0, 8).map((e) => e.textContent));
  }

  function paintShell() {
    root.innerHTML = heroHtml() + '<div id="study-list"></div>';
    root.querySelectorAll('.study-kind-chip').forEach((b) =>
      b.addEventListener('click', () => loadKind(b.dataset.kind)));
    root.querySelector('#study-quiz-read')?.addEventListener('click', () => startQuiz('read'));
    root.querySelector('#study-quiz-listen')?.addEventListener('click', () => startQuiz('listen'));
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
            ${(c.sentence_start_sec != null && c.episode_id) ? `<button class="srs-context-btn" id="sent-ctx" data-ep="${c.episode_id}" data-t="${Math.floor(c.sentence_start_sec)}">🎧 맥락에서 듣기</button>` : ''}
          </div>
        </div>
        <button class="study-cta-btn" id="sent-action">뜻 보기</button>
        <button class="quiz-exit" id="sent-exit">← Study 홈</button>`;
      root.querySelector('#sent-card').addEventListener('click', () => speak(c.example_sentence));
      requestAnimationFrame(() => speak(c.example_sentence));
      if (idx + 1 < cards.length) prefetch([cards[idx + 1].example_sentence]);
      root.querySelector('#sent-exit').addEventListener('click', () => renderStudy(root));
      root.querySelector('#sent-action').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!revealed) {
          revealed = true;
          root.querySelector('#sent-reveal').hidden = false;
          e.target.textContent = '다음 ▸';
          const cx = root.querySelector('#sent-ctx');
          if (cx) cx.addEventListener('click', (ev) => { ev.stopPropagation(); location.hash = `#/episode/${cx.dataset.ep}/${cx.dataset.t}`; });
        } else { idx++; paintS(); }
      });
    }
    paintS();
  }

  if (!selected) {
    root.innerHTML = heroHtml() + '<div class="empty">표현 데이터가 아직 없어요.</div>';
    return;
  }
  await loadKind(selected);
}
