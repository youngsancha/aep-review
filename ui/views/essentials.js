// Essentials — 큐레이션된 '네이티브 핵심표현' 별도 학습 모드(팟캐스트 vocab 과 분리).
// 데이터: 같은 출처 정적 팩(/data/essentials.json) → 오프라인 캐시 가능($0). 일상+비즈니스 영어.
// 학습: 카테고리 탐색 + '카드게임' 반복학습(오른쪽=Known, 왼쪽=Again 재투입). Known 은 localStorage.
import { escapeHtml } from '/app.js';
import { speak, prefetch } from '/tts.js';
import { stopClip } from '/clip.js';

const SRC = '/data/essentials.json';
const KNOWN_KEY = 'aep-ess-known';
let _pack = null;

async function loadPack() {
  if (_pack) return _pack;
  const res = await fetch(SRC, { cache: 'no-cache' });
  _pack = await res.json();
  return _pack;
}

function knownSet() {
  try { return new Set(JSON.parse(localStorage.getItem(KNOWN_KEY) || '[]')); } catch (e) { return new Set(); }
}
function saveKnown(s) {
  try { localStorage.setItem(KNOWN_KEY, JSON.stringify([...s])); } catch (e) { /* quota */ }
}
function setKnown(id, on) {
  const s = knownSet();
  if (on) s.add(id); else s.delete(id);
  saveKnown(s);
  return s;
}

const _shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

export async function renderEssentials(root, goBack) {
  stopClip();
  root.innerHTML = '<div class="study-greet"><h2>Essentials</h2></div><div class="empty"><span class="spinner"></span></div>';
  let pack;
  try { pack = await loadPack(); } catch (e) {
    root.innerHTML = `<div class="empty">Failed to load Essentials.<br><button class="study-cta-btn" id="ess-back">← Study</button></div>`;
    root.querySelector('#ess-back')?.addEventListener('click', () => goBack());
    return;
  }
  const cats = pack.categories;
  const cards = pack.cards;
  let sel = 'all';   // 선택 카테고리 id
  let dir = 'en';    // 카드게임 방향: 'en'=EN→뜻(인식), 'ko'=한국어→EN(말로 생산)

  function inSel(c) { return sel === 'all' || c.cat === sel; }
  function known() { return knownSet(); }

  function overview() {
    const kn = known();
    const pool = cards.filter(inSel);
    const masteredAll = cards.filter((c) => kn.has(c.id)).length;
    const pct = cards.length ? Math.round((masteredAll / cards.length) * 100) : 0;
    root.innerHTML = `
      <div class="ess-head">
        <button class="ess-back" id="ess-back" aria-label="Back to Study">←</button>
        <div class="ess-title"><h2>Essentials</h2><span class="ess-sub">미국 현지·비즈니스 핵심표현</span></div>
      </div>
      <div class="ess-progress">
        <div class="ess-prog-bar"><span style="width:${pct}%"></span></div>
        <div class="ess-prog-meta"><b>${masteredAll}</b> / ${cards.length} mastered · ${pct}%</div>
      </div>
      <div class="ess-cats">
        <button class="ess-cat${sel === 'all' ? ' on' : ''}" data-cat="all"><span class="ess-cat-emoji">✨</span><span class="ess-cat-name">All</span><span class="ess-cat-n">${cards.length}</span></button>
        ${cats.map((k) => {
          const n = cards.filter((c) => c.cat === k.id).length;
          return `<button class="ess-cat${sel === k.id ? ' on' : ''}" data-cat="${k.id}"><span class="ess-cat-emoji">${k.emoji}</span><span class="ess-cat-name">${escapeHtml(k.label)}</span><span class="ess-cat-n">${n}</span></button>`;
        }).join('')}
      </div>
      <div class="ess-dir" role="group" aria-label="Study direction">
        <button class="ess-dir-btn${dir === 'en' ? ' on' : ''}" data-dir="en">EN → 뜻 <small>인식</small></button>
        <button class="ess-dir-btn${dir === 'ko' ? ' on' : ''}" data-dir="ko">🇰🇷 → EN <small>말하기</small></button>
      </div>
      <button class="ess-play" id="ess-play">🃏 ${(() => {
        const u = pool.filter((c) => !kn.has(c.id)).length;
        const n = Math.min(18, u || pool.length);
        return u ? `Study ${n} new card${n > 1 ? 's' : ''}` : `Review ${n} card${n > 1 ? 's' : ''}`;
      })()}</button>
      <div class="ess-list" id="ess-list"></div>`;
    root.querySelector('#ess-back').addEventListener('click', () => goBack());
    root.querySelectorAll('.ess-cat').forEach((b) => b.addEventListener('click', () => { sel = b.dataset.cat; overview(); }));
    root.querySelectorAll('.ess-dir-btn').forEach((b) => b.addEventListener('click', () => { dir = b.dataset.dir; overview(); }));
    root.querySelector('#ess-play').addEventListener('click', () => startGame(pool, dir));
    paintList();
    prefetch(pool.slice(0, 8).map((c) => c.term));
  }

  function paintList() {
    const kn = known();
    const pool = cards.filter(inSel);
    const el = root.querySelector('#ess-list');
    if (!el) return;
    el.innerHTML = `<div class="study-swipe-tip"><b>Tap</b> for audio · <b>KR</b> for meaning · <b>swipe →</b> Known</div>`
      + `<ul class="study-xlist">${pool.map((c) => `
        <li class="study-x ess-x tap${kn.has(c.id) ? ' known' : ''}" data-id="${c.id}" data-term="${escapeHtml(c.term)}">
          <div class="study-x-swipe-hint">✓ Known</div>
          <div class="study-x-top">
            <span class="study-x-term">${escapeHtml(c.term)}</span>
            <button class="study-x-tr" data-id="${c.id}" aria-label="Show Korean">KR</button>
            <span class="study-x-known-badge" aria-hidden="true">✓ Known</span>
          </div>
          <div class="ess-x-reg">${c.register}</div>
          <div class="study-x-ex tappable" data-ex="${escapeHtml(c.example)}">“${escapeHtml(c.example)}”</div>
          <div class="study-x-tr-out" hidden>${escapeHtml(c.ko)} — ${escapeHtml(c.example_ko)}</div>
        </li>`).join('')}</ul>`;
    el.querySelectorAll('.ess-x').forEach((li) => {
      li.addEventListener('click', (e) => {
        if (li.dataset.swiped === '1') return;
        if (e.target.closest('.study-x-tr')) {
          const out = li.querySelector('.study-x-tr-out'); if (out) out.hidden = !out.hidden; return;
        }
        if (e.target.closest('.study-x-ex')) { speak(e.target.closest('.study-x-ex').dataset.ex); return; }
        speak(li.dataset.term);
      });
      wireSwipe(li);
    });
  }

  // 리스트 스와이프: 오른쪽=Known, 왼쪽=되돌리기(localStorage)
  function wireSwipe(li) {
    let x0 = null, y0 = null, sw = false;
    const hint = li.querySelector('.study-x-swipe-hint');
    const reset = () => { li.style.transition = ''; li.style.transform = ''; li.classList.remove('swipe-armed', 'swipe-left'); x0 = null; };
    li.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; sw = false; });
    li.addEventListener('pointermove', (e) => {
      if (x0 == null) return;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      if (!sw && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) + 4) sw = true;
      if (!sw) return;
      const isKnown = li.classList.contains('known');
      if ((dx > 0 && isKnown) || (dx < 0 && !isKnown)) return;
      if (hint) hint.textContent = dx < 0 ? '↺ Unknown' : '✓ Known';
      li.style.transition = 'none';
      li.style.transform = `translateX(${Math.max(-132, Math.min(dx, 132))}px)`;
      li.classList.toggle('swipe-armed', Math.abs(dx) > 78);
      li.classList.toggle('swipe-left', dx < 0);
    });
    li.addEventListener('pointerup', (e) => {
      const dx = x0 != null ? e.clientX - x0 : 0;
      const isKnown = li.classList.contains('known');
      if (sw) { li.dataset.swiped = '1'; setTimeout(() => { li.dataset.swiped = ''; }, 350); }
      if (sw && dx > 78 && !isKnown) { setKnown(li.dataset.id, true); li.classList.add('known'); if (navigator.vibrate) navigator.vibrate(12); }
      else if (sw && dx < -78 && isKnown) { setKnown(li.dataset.id, false); li.classList.remove('known'); if (navigator.vibrate) navigator.vibrate(12); }
      reset();
    });
  }

  // ── 카드게임 반복학습 — 오른쪽=Known(덱에서 제거), 왼쪽=Again(뒤로 재투입). 덱 비울 때까지.
  //    dir='en' 인식(영어→뜻) / dir='ko' 생산(한국어 보고 영어로 말하기). ──
  function startGame(srcCards, dir) {
    stopClip();
    if (!srcCards.length) return;
    const prod = dir === 'ko';
    // 한 라운드는 '아직 모르는 것 우선'으로 최대 18장만 — 작은 분량을 끝까지 마스터하는 성취가
    // 매일 습관·빠른 진척의 핵심. 다 알면 전체에서 복습. ('Play again' 이 다음 미지 배치로 이어감)
    const kn = knownSet();
    const unknown = srcCards.filter((c) => !kn.has(c.id));
    const base = unknown.length ? unknown : srcCards;
    let deck = _shuffle(base).slice(0, Math.min(18, base.length));
    const total = deck.length;
    let mastered = 0, againCnt = 0;
    prefetch(deck.slice(0, 6).map((c) => c.term));

    function finish() {
      const msg = againCnt === 0 ? 'Flawless deck! 🌟' : 'Deck cleared! 🃏';
      root.innerHTML = `
        <div class="quiz-summary">
          <div class="quiz-sum-msg">${msg}</div>
          <div class="quiz-sum-score">${total}</div>
          <div class="quiz-sum-pct">mastered${againCnt ? ` · ${againCnt} repeats` : ''}</div>
          <div class="quiz-sum-actions">
            <button class="study-cta-btn" id="ess-again">Play again</button>
            <button class="study-cta-btn secondary" id="ess-done">Essentials Home</button>
          </div>
        </div>`;
      root.querySelector('#ess-again').addEventListener('click', () => startGame(srcCards, dir));
      root.querySelector('#ess-done').addEventListener('click', overview);
    }

    function advance(knownIt) {
      const c = deck[0];
      if (!c) return finish();
      if (knownIt) { mastered++; setKnown(c.id, true); deck.shift(); }
      else { againCnt++; deck.push(deck.shift()); }
      paint();
    }

    function paint() {
      stopClip();
      if (!deck.length) return finish();
      const c = deck[0];
      // 생산(ko): 한국어 뜻만 보여주고 영어를 '말하게' → 정답(영어)은 reveal 까지 숨김.
      const front = prod
        ? `<div class="ess-card-ko">${escapeHtml(c.ko)}</div><div class="ess-prod-hint">🗣️ Say it in English</div>`
        : `<div class="ess-card-term">${escapeHtml(c.term)} <span class="sent-spk">🔊</span></div>`;
      const reveal = prod
        ? `<div class="ess-card-term">${escapeHtml(c.term)} <span class="sent-spk">🔊</span></div>
           <div class="ess-card-ex">“${escapeHtml(c.example)}”</div>
           <div class="ess-card-exko">${escapeHtml(c.example_ko)}</div>`
        : `<div class="sent-ko">${escapeHtml(c.ko)}</div>
           <div class="ess-card-ex">“${escapeHtml(c.example)}”</div>
           <div class="ess-card-exko">${escapeHtml(c.example_ko)}</div>
           <div class="ess-x-reg">${c.register}</div>`;
      root.innerHTML = `
        <div class="quiz-bar"><span class="quiz-count">${mastered} / ${total} mastered</span><span class="quiz-score">${prod ? '🗣️ KR→EN' : '🃏 Essentials'}</span></div>
        <div class="sent-card sent-swipe ess-card" id="ess-card" data-id="${c.id}">
          <div class="sent-swipe-badge" id="ess-badge"></div>
          ${front}
          <div class="sent-reveal" id="ess-reveal" hidden>${reveal}</div>
        </div>
        <div class="sent-game-row">
          <button class="sent-game-btn again" id="ess-g-again">↺ Again</button>
          <button class="study-cta-btn" id="ess-g-show">${prod ? 'Show answer' : 'Show meaning'}</button>
          <button class="sent-game-btn known" id="ess-g-known">✓ Known</button>
        </div>
        <div class="study-swipe-tip">Swipe → Known · ← Again (repeats)</div>
        <button class="quiz-exit" id="ess-g-exit">← Essentials Home</button>`;
      const card = root.querySelector('#ess-card');
      // 인식모드: 탭/진입 시 영어 발음 자동. 생산모드: 정답 노출 방지 위해 침묵(reveal 후에만 발음).
      card.addEventListener('click', () => { if (!card.dataset.swiped && !prod) speak(c.term); });
      if (!prod) requestAnimationFrame(() => speak(c.term));
      if (deck[1]) prefetch([deck[1].term]);
      root.querySelector('#ess-g-exit').addEventListener('click', overview);
      root.querySelector('#ess-g-again').addEventListener('click', () => advance(false));
      root.querySelector('#ess-g-known').addEventListener('click', () => advance(true));
      root.querySelector('#ess-g-show').addEventListener('click', (e) => {
        e.stopPropagation();
        root.querySelector('#ess-reveal').hidden = false;
        e.target.disabled = true;
        speak(prod ? c.term : c.example);   // 생산모드: 정답 영어 발음(내 산출과 비교) / 인식모드: 예문
      });
      wireGameSwipe(card, advance);
    }

    function wireGameSwipe(card, adv) {
      let x0 = null, y0 = null, sw = false;
      const badge = card.querySelector('#ess-badge');
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

    paint();
  }

  overview();
}
