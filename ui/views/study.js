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
    `;
  }

  function rowHtml(v) {
    const epTitle = (v.episode_title || '').replace(/^\d+\s*[-:.]\s*/, '');
    return `
      <li class="study-x" data-ep="${v.episode_id}">
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
      li.addEventListener('click', () => { if (li.dataset.ep) location.hash = `#/episode/${li.dataset.ep}`; }));
    prefetch([...root.querySelectorAll('.study-x-term')].slice(0, 8).map((e) => e.textContent));
  }

  function paintShell() {
    root.innerHTML = heroHtml() + '<div id="study-list"></div>';
    root.querySelectorAll('.study-kind-chip').forEach((b) =>
      b.addEventListener('click', () => loadKind(b.dataset.kind)));
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

  if (!selected) {
    root.innerHTML = heroHtml() + '<div class="empty">표현 데이터가 아직 없어요.</div>';
    return;
  }
  await loadKind(selected);
}
