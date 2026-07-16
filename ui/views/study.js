// Study 탭 — 에피소드에서 추출된 실생활 표현을 종류별로 탐색하는 허브.
// 데이터는 기존 vocab_cards (claude 추출, 영+한 정의, 타임스탬프). SRS 복습은 #/srs 가 담당.
import { escapeHtml, highlightTerm } from '/app.js';
import { studyOverview, expressionsByKind, allExpressions, markKnown, markUnknown, retentionStats, srsQueue, srsReview } from '/db.js';
import { speak, prefetch } from '/tts.js';
import { playSentenceClip, stopClip } from '/clip.js';
import { translateEnKo } from '/translate.js';
import { renderEssentials } from '/views/essentials.js';
import { recordMeasure, readProficiency, recordSnapshot, markSeen, loadSeen, loadSnapshots, weakestAxis } from '/proficiency.js';

const KIND_LABEL = { idiom: 'Idioms', phrasal_verb: 'Phrasal Verbs', collocation: 'Collocations', word: 'Words' };
const KIND_EMOJI = { idiom: '💬', phrasal_verb: '🔗', collocation: '🧩', word: '📖' };

// Proficiency 5축 표기(키·라벨·이모지) — proficiency.js 의 scores 키와 1:1.
const PROF_AXES = [
  ['breadth', '어휘폭', '📚'],
  ['retention', '보존력', '🧠'],
  ['listening', '청해', '👂'],
  ['production', '산출', '🗣️'],
  ['automaticity', '자동화', '⚡'],
];
// 각 축을 '무엇을 하면 오르는가' — ⓘ 안내 시트가 그대로 보여준다. (proficiency.js 계산식과 1:1)
const AXIS_HELP = {
  breadth:      { how: '아는 표현을 오른쪽으로 스와이프해 <b>Known</b>(마스터)', where: '표현 목록 · Sentences 덱(✓Known)', goal: '전체 표현의 90% 마스터' },
  retention:    { how: '매일 <b>복습(due)</b>을 풀어 간격을 90일↑로 키우기', where: '오늘의 플랜 → 복습(SRS)', goal: '학습카드의 75%가 간격 90일↑' },
  listening:    { how: '<b>받아쓰기·클로즈·듣기</b> 정확도 ↑ — 레벨체크는 처음 보는 문장', where: '✍️Dictation · 🧩Cloze · 🎧Listen · 🎯레벨체크', goal: '정확도 92% (레벨체크 후 unseen만 반영)' },
  production:   { how: '또박또박 <b>말해서</b> 인식 정확도 ↑', where: '🎤Speak · 🗣️KR→EN (마이크 필요)', goal: '평균 단어일치 85%' },
  automaticity: { how: '퀴즈를 <b>빨리 답</b> + 에피소드 <b>쉐도잉 반복</b>', where: 'Quiz/Listen 속도 · 플레이어 🔁Repeat·5×·10×', goal: '응답 ≤2.2초 + 쉐도잉 400회' },
};

// ── 오늘 세션 상태 (localStorage) — 원버튼 데일리 플로우: 복습 → 새 표현 → 약점 드릴 ──
const SESS_KEY = 'aep-session';
const SESS_SIZE_KEY = 'aep-session-size';
// 단계별 분량 — S/M/L ≈ 5/10/20분 (복습 ~8s/장 · 새 표현 ~15s/장 · 드릴은 모드별 소요로 산정)
const SESS_CAPS = {
  S: { review: 10, fresh: 2, drills: 1, read: 6, dictation: 3, cloze: 4, prod: 3, min: 5 },
  M: { review: 20, fresh: 3, drills: 1, read: 10, dictation: 5, cloze: 7, prod: 5, min: 10 },
  L: { review: 40, fresh: 5, drills: 2, read: 12, dictation: 7, cloze: 9, prod: 6, min: 20 },
};
const DRILL_LABEL = { dictation: '✍️ 받아쓰기', read: '🎯 스피드 퀴즈', prod: '🗣️ KR→EN', cloze: '🧩 빈칸' };
function sessSize() { try { const v = localStorage.getItem(SESS_SIZE_KEY); return SESS_CAPS[v] ? v : 'M'; } catch (e) { return 'M'; } }
function loadSess() { try { return JSON.parse(localStorage.getItem(SESS_KEY) || 'null'); } catch (e) { return null; } }
function saveSess(st) { try { localStorage.setItem(SESS_KEY, JSON.stringify(st)); } catch (e) { /* quota */ } }
// "definition (한글)\n\n— example" → def/example 분리 (srs.js 와 동일 규칙 — 미수출이라 사본)
function splitBack(back) {
  const parts = String(back || '').split(/\n\s*—\s*/);
  return { def: (parts[0] || '').trim(), example: (parts[1] || '').trim() };
}
// 세션 드릴 완료 훅 — 설정돼 있으면 드릴 finish 가 자체 요약 대신 이걸 호출(세션이 다음 단계로).
// renderStudy 진입 시 항상 초기화(스테일 훅이 다른 화면 흐름을 가로채지 않게).
let _sessNext = null;

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

// 주간 활동 — 최근 7일(오늘 포함) 학습 여부. aep-study-days(스트릭과 동일 소스) 재사용.
function weekActivity() {
  let s = new Set();
  try { s = new Set(JSON.parse(localStorage.getItem('aep-study-days') || '[]')); } catch (e) {}
  const out = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const dd = new Date(today); dd.setDate(today.getDate() - i);
    out.push({ label: ['S', 'M', 'T', 'W', 'T', 'F', 'S'][dd.getDay()], on: s.has(_dayKey(dd)), today: i === 0 });
  }
  return out;
}

// 누적 퀴즈 정답률 — 모드 무관 합산(read/listen/dictation/cloze). localStorage.
const QUIZ_STATS_KEY = 'aep-quiz-stats';
function quizStats() {
  try { return JSON.parse(localStorage.getItem(QUIZ_STATS_KEY) || '{"correct":0,"total":0,"sessions":0}'); }
  catch (e) { return { correct: 0, total: 0, sessions: 0 }; }
}
function recordQuiz(correct, total) {
  if (!total) return;
  try {
    const s = quizStats();
    s.correct += correct; s.total += total; s.sessions += 1;
    localStorage.setItem(QUIZ_STATS_KEY, JSON.stringify(s));
  } catch (e) { /* quota */ }
}

// Study 예문 재생 — 가능하면 Shana '실제 음성'(에피소드 클립)으로, 없으면 TTS 폴백.
// 네이티브 영어 학습엔 합성음보다 실제 발화(억양·연음·리듬)가 핵심이라 실제 음성을 우선한다.
function playExample(c, rate, loop) {
  if (!c) return;
  if (c.audio_url && c.sentence_start_sec != null) {
    // 단어수 기반 최소 재생길이 — whisper 타임스탬프 압축으로 클립이 말 도중 끊기는 것 방지(늘리기만).
    const wc = (c.example_sentence || '').trim().split(/\s+/).filter(Boolean).length;
    const minDur = wc >= 4 ? Math.min(wc * 0.33, 12) : 0;
    // 클립(R2) 실패 시 TTS 로 캐스케이드 — 드릴이 무음으로 멈추지 않게(AUDIT I2).
    playSentenceClip(c.audio_url, c.sentence_start_sec, c.sentence_end_sec, null, rate, loop, minDur,
      () => speak(c.example_sentence, rate ? { playbackRate: rate } : undefined));
  } else {
    speak(c.example_sentence, rate ? { playbackRate: rate } : undefined);  // TTS 폴백은 단발
  }
}

export async function renderStudy(root) {
  stopClip();  // 홈/다른 모드로 진입 시 인라인 문장 재생 정지(겹침 방지)
  _sessNext = null;   // 스테일 세션 훅 무효화(드릴을 세션 밖에서 열 때 가로채기 방지)
  // 스트릭(markStudyDay)은 '세션 완료'에서만 — 탭을 연 것만으로 오르던 것을 정직하게(sessSummary)
  root.innerHTML = `
    <div class="library-head"><h1 class="library-title">Study</h1></div>
    <div class="skel-hero" style="height:84px"></div>
    <div class="study-kinds">${'<span class="skel-chip"></span>'.repeat(4)}</div>
    ${'<div class="skel-x"></div>'.repeat(5)}`;
  // 보존력(retentionStats)은 studyOverview 와 독립 → 미리 병렬로 띄워 Study 홈 로딩 RTT 를 줄인다.
  const retP = retentionStats().catch(() => ({ retentionFrac: 0 }));
  let ov;
  try {
    ov = await studyOverview();
    try { localStorage.setItem('aep-study-ov', JSON.stringify(ov)); } catch (e) {}
  } catch (e) {
    // studyOverview 는 HEAD count 쿼리라 SW 가 캐시하지 못한다(비-GET) → 오프라인이면 첫 await 가 throw.
    // 마지막으로 성공한 개요를 재사용해 화면을 유지하고, 없으면 막다른 에러 대신 친절한 안내를 보여준다
    // (Essentials 는 셸 캐시라 오프라인에서도 학습 가능 — 지하철에서 Study 진입이 죽지 않게).
    try { ov = JSON.parse(localStorage.getItem('aep-study-ov') || 'null'); } catch (e2) { ov = null; }
    if (!ov) {
      const offline = !navigator.onLine;
      root.innerHTML = `<div class="empty study-offline">
        <p class="study-offline-title">${offline ? '📴 오프라인이에요' : '불러오지 못했어요'}</p>
        <p class="study-offline-sub">${offline
          ? 'Study 통계는 온라인에서 채워져요. Essentials 는 오프라인에서도 학습할 수 있어요.'
          : escapeHtml(e.message)}</p>
        <button class="btn primary" id="study-ess-cta">✨ Essentials 열기</button>
        <button class="btn" id="study-retry">다시 시도</button>
      </div>`;
      document.getElementById('study-ess-cta')?.addEventListener('click', () => renderEssentials(root, () => renderStudy(root)));
      document.getElementById('study-retry')?.addEventListener('click', () => renderStudy(root));
      return;
    }
  }

  // 5축 수치화 — 보존력은 위에서 병렬로 띄운 retP(실패해도 0 으로 graceful), 나머지는 localStorage 측정 로그.
  const ret = await retP;
  const prof = readProficiency({ known: ov.known, corpusTotal: ov.total, retentionFrac: ret.retentionFrac });
  recordSnapshot(prof.index, prof.scores);   // 주간 1건(추세) — Phase 2 에서 시각화

  const kinds = ov.byKind.filter((k) => k.total > 0);
  let selected = kinds.length ? kinds[0].kind : null;
  let items = [];
  let q = '';
  let knownCount = ov.known || 0;          // "알아요" 누적 (낙관적 갱신)

  // Proficiency 패널 — Fluency Index(목표 밴드 대비 0~100) + 5축 막대 + CEFR ≈밴드 + 정직성 주석.
  // 미측정 축(드릴 기록 없음)은 '—'·회색으로 표시해 "아직 모름"을 솔직히 드러낸다.
  function profCardHtml() {
    const cefr = prof.cefr;
    const vocabSub = cefr.nextLabel ? `어휘 ${cefr.band} · 다음 ${cefr.nextLabel}` : `어휘 ${cefr.band}`;
    const axes = PROF_AXES.map(([k, label, emoji]) => {
      const v = prof.scores[k];
      const has = v != null;
      return `
        <div class="prof-axis tappable${has ? '' : ' un'}" data-axis="${k}" role="button" tabindex="0" aria-label="${label} 올리는 법">
          <span class="prof-axis-l">${emoji} ${label}</span>
          <span class="prof-axis-bar"><i style="width:${has ? v : 0}%"></i></span>
          <span class="prof-axis-v">${has ? v : '—'}</span>
        </div>`;
    }).join('');
    return `
      <div class="prof-card">
        <div class="prof-head">
          <div class="prof-index"><b>${prof.index}</b><span>/100<i>→ 목표 C2</i></span></div>
          <div class="prof-cefr">현재 ≈ <b>${prof.currentBand}</b><span>${vocabSub}</span></div>
        </div>
        <div class="prof-axes">${axes}</div>
        ${profSpark()}
        <button class="prof-help" id="prof-info">ⓘ 점수 올리는 법 — 무엇을 공부하면 오르나</button>
        <div class="prof-note">이 앱이 보여준 표현·드릴 기록 기준 · unseen(레벨체크) 우선 · ASR은 ‘알아들힘’(발음 정확도 아님)</div>
      </div>`;
  }

  // ⓘ 안내 시트 — 5축이 무엇이고 각각 '무엇을 하면 오르는가'를 앱 안에서 바로. focusKey 축을 강조.
  function openProfInfo(focusKey) {
    const rows = PROF_AXES.map(([k, label, emoji]) => {
      const h = AXIS_HELP[k]; const v = prof.scores[k];
      return `
        <div class="pinfo-axis${k === focusKey ? ' focus' : ''}" id="pinfo-${k}">
          <div class="pinfo-axis-h">${emoji} <b>${label}</b><span>${v != null ? v + '/100' : '미측정'}</span></div>
          <div class="pinfo-line"><i>이렇게</i> ${h.how}</div>
          <div class="pinfo-line"><i>어디서</i> ${escapeHtml(h.where)}</div>
          <div class="pinfo-line"><i>만점</i> ${escapeHtml(h.goal)}</div>
        </div>`;
    }).join('');
    const back = document.createElement('div');
    back.className = 'pinfo-backdrop';
    back.innerHTML = `
      <div class="pinfo-sheet" role="dialog" aria-modal="true" aria-label="점수 올리는 법">
        <div class="pinfo-grab"></div>
        <div class="pinfo-head"><h3>점수 올리는 법</h3><button class="pinfo-x" id="pinfo-x" aria-label="닫기">✕</button></div>
        <div class="pinfo-body">
          <p class="pinfo-intro"><b>Fluency Index</b>는 5개 능력을 <b>네이티브(C2) 목표 대비 달성률</b>로 합친 한 숫자예요. 현재 ≈ <b>${prof.currentBand}</b> · 목표 C2. 아래 축을 올리면 지수가 오릅니다.</p>
          ${rows}
          <div class="pinfo-tip">💡 어느 걸 할지 고민되면 <b>🎯 오늘의 플랜</b>을 누르세요 — 가장 약한 축으로 바로 보냅니다.</div>
          <p class="pinfo-caveat">측정은 이 앱이 보여준 표현·드릴 기록 기준입니다. 레벨체크(처음 보는 문장)를 우선하고, 말하기는 발음 정확도가 아니라 ‘알아들힘’을 봅니다.</p>
        </div>
      </div>`;
    document.body.appendChild(back);
    requestAnimationFrame(() => back.classList.add('open'));
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() { back.classList.remove('open'); document.removeEventListener('keydown', onKey); setTimeout(() => back.remove(), 260); }
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    back.querySelector('#pinfo-x')?.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    if (focusKey) requestAnimationFrame(() => back.querySelector(`#pinfo-${focusKey}`)?.scrollIntoView({ block: 'center' }));
  }

  // Fluency Index 주간 추세 스파크라인 — 스냅샷 2개 이상일 때만(최근 12주).
  function profSpark() {
    const snaps = loadSnapshots().slice().sort((a, b) => (a.w < b.w ? -1 : 1)).slice(-12);
    if (snaps.length < 2) return '';
    const pts = snaps.map((s) => s.idx);
    const W = 116, H = 26, step = W / (pts.length - 1);
    const coords = pts.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / 100) * H).toFixed(1)}`).join(' ');
    const delta = pts[pts.length - 1] - pts[0];
    return `<div class="prof-trend">
        <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${coords}"/></svg>
        <span class="prof-trend-d ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'}${Math.abs(delta)} <i>${snaps.length}주 추세</i></span>
      </div>`;
  }

  // ── Study 홈 = Library 리듬 (v1.31.0) ──
  // 헤더 한 줄(유일한 숫자 요약) → Today 카드(유일한 주 CTA) → Practice(접힘) → Essentials 행
  // → Expressions(본문 리스트) → 맨 아래 My stats(접힘). 예전엔 콘텐츠 앞에 8개 블록·진행지표
  // 17개·탭 가능 컨트롤 21개가 쌓여 '지금 무엇을 할지'가 없었다(UX 감사 2026-07-16).
  function heroHtml() {
    const pct = ov.total ? Math.round((knownCount / ov.total) * 100) : 0;
    const streak = getStreak();
    return `
      <div class="library-head">
        <h1 class="library-title">Study</h1>
        <div class="library-sub"><b id="study-known-n">${knownCount.toLocaleString()}</b> known · <span id="study-pct">${pct}</span>% of ${ov.total.toLocaleString()}${streak > 0 ? ` · 🔥 ${streak}-day` : ''}</div>
      </div>
      <div class="section-h"><h2>Today</h2></div>
      <div class="cont-card study-today">
        <div class="cont-body">
          <div class="cont-title" id="sess-title">${(() => {
            const st = loadSess(); const t = _dayKey(new Date());
            if (st && st.d === t && st.completedAt) return '✓ 오늘 세션 완료';
            if (st && st.d === t && st.stage !== 'done') return '오늘 세션 — 진행 중';
            return '오늘 세션';
          })()}</div>
          <div class="cont-bar"><span id="study-known-bar" style="width:${pct}%"></span></div>
          <div class="cont-meta" id="sess-preview">${(() => {
            const caps = SESS_CAPS[sessSize()];
            const st = loadSess(); const t = _dayKey(new Date());
            const drills = (st && st.d === t && !st.completedAt && st.drillModes) ? st.drillModes : pickDrills(caps.drills);
            const nRev = Math.min(ov.dueReview ?? ov.due ?? 0, caps.review);
            const nNew = Math.min(ov.dueNew ?? 0, caps.fresh);
            return `복습 ${nRev} · 새 표현 ${nNew} · ${drills.map((m) => DRILL_LABEL[m] || m).join(' · ')}`;
          })()}</div>
          <div class="cont-actions">
            <button class="cont-play" id="sess-go">${(() => {
              const st = loadSess(); const t = _dayKey(new Date());
              if (st && st.d === t && st.completedAt) return '한 세션 더';
              if (st && st.d === t && st.stage !== 'done') return '▶ 이어서 하기';
              return '▶ Start';
            })()}</button>
            <a class="cont-script" id="plan-level" role="button" tabindex="0">Level check ›</a>
            <a class="cont-script" href="#/srs">Review${ov.due > 0 ? ` ${ov.due}` : ''} ›</a>
          </div>
          <div class="sess-size" role="group" aria-label="세션 크기">
            ${['S', 'M', 'L'].map((z) => `<button data-size="${z}" class="${z === sessSize() ? 'on' : ''}">${z} · ${SESS_CAPS[z].min}분</button>`).join('')}
          </div>
        </div>
      </div>
      <details class="season-group study-practice">
        <summary class="section-h season-head"><h2>Practice</h2><span class="season-right"><span class="count">8 modes</span><span class="season-caret" aria-hidden="true">⌄</span></span></summary>
        <div class="study-quiz-row">
          <button class="study-quiz-btn" id="study-quiz-read"><span class="qb-ico">🎯</span><span class="qb-txt">Quiz</span><span class="qb-sub">뜻 보고 표현 고르기</span></button>
          <button class="study-quiz-btn" id="study-quiz-listen"><span class="qb-ico">🎧</span><span class="qb-txt">Listen</span><span class="qb-sub">듣고 뜻 고르기</span></button>
          <button class="study-quiz-btn" id="study-quiz-weak"><span class="qb-ico">⚡</span><span class="qb-txt">Weak</span><span class="qb-sub">미마스터 집중 퀴즈</span></button>
          <button class="study-quiz-btn" id="study-quiz-dict"><span class="qb-ico">✍️</span><span class="qb-txt">Dictation</span><span class="qb-sub">듣고 받아쓰기</span></button>
          <button class="study-quiz-btn" id="study-quiz-cloze"><span class="qb-ico">🧩</span><span class="qb-txt">Cloze</span><span class="qb-sub">빈칸에 표현 채우기</span></button>
          <button class="study-quiz-btn" id="study-quiz-speak"><span class="qb-ico">🎤</span><span class="qb-txt">Speak</span><span class="qb-sub">듣고 따라 말하기</span></button>
          <button class="study-quiz-btn" id="study-quiz-prod"><span class="qb-ico">🗣️</span><span class="qb-txt">KR→EN</span><span class="qb-sub">한국어 보고 영어로</span></button>
          <button class="study-quiz-btn" id="study-quiz-sent"><span class="qb-ico">💬</span><span class="qb-txt">Sentences</span><span class="qb-sub">문장 카드 반복</span></button>
        </div>
        <div class="study-scope-note">연습 대상: 아래 Expressions 에서 선택한 종류</div>
      </details>
      <button class="study-ess-row" id="study-essentials">
        <span class="study-ess-ico">✨</span>
        <span class="study-ess-txt"><b>Essentials</b><span>미국 현지·비즈니스 핵심표현</span></span>
        <span class="study-ess-go">›</span>
      </button>
      <div class="section-h"><h2>Expressions</h2><span class="count">${ov.total.toLocaleString()}</span></div>
      <div class="study-kinds">
        ${kinds.map((k) => `
          <button class="study-kind-chip${k.kind === selected ? ' on' : ''}" data-kind="${k.kind}">
            <span class="study-kind-emoji">${KIND_EMOJI[k.kind] || '•'}</span>
            <span class="study-kind-name">${KIND_LABEL[k.kind] || k.kind}</span>
            <span class="study-kind-n">${k.total}</span>
          </button>`).join('')}
      </div>
    `;
  }

  // 맨 아래 'My stats'(접힘) — 실력 대시보드 전체(지수·CEFR·5축·스파크라인·주간 띠·보조 필)를
  // 리스트 뒤로 강등. 데이터를 버리지 않고 '원할 때만' 펼쳐 보게 한다.
  function statsHtml() {
    const qs = quizStats();
    return `
      <details class="season-group study-stats">
        <summary class="section-h season-head"><h2>My stats</h2><span class="season-right"><span class="count">Fluency ${prof.index}</span><span class="season-caret" aria-hidden="true">⌄</span></span></summary>
        ${profCardHtml()}
        <div class="study-week">
          ${weekActivity().map((d) => `<span class="study-week-d${d.on ? ' on' : ''}${d.today ? ' today' : ''}"><i>${d.label}</i><b></b></span>`).join('')}
        </div>
        <div class="study-statpills">
          <span class="study-pill">📚 Learned ${ov.learned.toLocaleString()}</span>
          ${qs.total ? `<span class="study-pill">🎯 ${Math.round(qs.correct / qs.total * 100)}% quiz</span>` : ''}
        </div>
      </details>
    `;
  }

  // "알아요" 누적을 헤더 서브라인 + Today 카드 진행바에 즉시 반영
  function applyKnown(delta) {
    knownCount = Math.max(0, Math.min(ov.total, knownCount + delta));
    const pct = ov.total ? Math.round((knownCount / ov.total) * 100) : 0;
    const n = root.querySelector('#study-known-n'); if (n) n.textContent = knownCount.toLocaleString();
    const bar = root.querySelector('#study-known-bar'); if (bar) bar.style.width = pct + '%';
    const pctEl = root.querySelector('#study-pct'); if (pctEl) pctEl.textContent = pct;
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
        ${epTitle ? `<div class="study-x-ep${v.episode_id != null ? ' tappable' : ''}"${v.episode_id != null ? ` data-ep="${v.episode_id}" data-t="${Math.floor(v.sentence_start_sec || 0)}" role="button" tabindex="0" aria-label="에피소드에서 이 표현 듣기"` : ''}>🎧 ${escapeHtml(epTitle)}${v.episode_id != null ? ' <span class="study-x-ep-go" aria-hidden="true">›</span>' : ''}</div>` : ''}
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
    // 에피소드 제목 탭 → 그 표현이 나온 회차의 정확한 지점부터 재생(문맥 딥링크 #/episode/:id/:t 복원 —
    // v39 에서 만든 라우트가 그동안 아무 데서도 안 쓰였다). Study↔Player 를 잇는 핵심 학습 루프.
    root.querySelectorAll('.study-x-ep.tappable').forEach((el) => {
      const go = (e) => { e.stopPropagation(); if (el.dataset.ep) location.hash = `#/episode/${el.dataset.ep}/${el.dataset.t || 0}`; };
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } });
    });
    // 카드 탭 → 발음(term) 재생 (#38). 예문/KR/에피소드 버튼은 stopPropagation 으로 제외. 스와이프 직후면 무시.
    root.querySelectorAll('.study-x').forEach((li) => {
      li.addEventListener('click', (e) => {
        if (li.dataset.swiped === '1') return;
        if (e.target.closest('.study-x-ex') || e.target.closest('.study-x-tr') || e.target.closest('.study-x-ep')) return;
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
    root.innerHTML = heroHtml() + '<div id="study-list"></div>' + statsHtml();
    root.querySelectorAll('.study-kind-chip').forEach((b) =>
      b.addEventListener('click', () => loadKind(b.dataset.kind)));
    root.querySelector('#study-quiz-read')?.addEventListener('click', () => startQuiz('read'));
    root.querySelector('#study-quiz-listen')?.addEventListener('click', () => startQuiz('listen'));
    root.querySelector('#study-quiz-weak')?.addEventListener('click', startWeakQuiz);
    // ⚠ 이 3개는 (source||items).filter 를 쓰는데, 핸들러로 함수를 '직접' 넘기면 클릭 이벤트가
    // source 인자로 들어가 event.filter 에서 TypeError → 모드가 클릭 즉시 죽었다(프로덕션 실버그).
    // 반드시 인자 없는 화살표로 감싼다(위 read/listen 과 동일 패턴).
    root.querySelector('#study-quiz-dict')?.addEventListener('click', () => startDictation());
    root.querySelector('#study-quiz-cloze')?.addEventListener('click', () => startCloze());
    root.querySelector('#study-quiz-speak')?.addEventListener('click', startSpeaking);
    root.querySelector('#study-quiz-prod')?.addEventListener('click', () => startProduction());
    root.querySelector('#study-quiz-sent')?.addEventListener('click', startSentences);
    root.querySelector('#study-essentials')?.addEventListener('click', () => renderEssentials(root, () => renderStudy(root)));
    root.querySelector('#plan-level')?.addEventListener('click', startLevelCheck);
    // ⓘ 안내: 약점 축을 강조해 열기. 각 축 행을 탭하면 그 축으로 포커스.
    root.querySelector('#prof-info')?.addEventListener('click', () => openProfInfo(weakestAxis(prof.scores)));
    root.querySelectorAll('.prof-axis[data-axis]').forEach((el) => {
      const open = () => openProfInfo(el.dataset.axis);
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    // 오늘 세션 — 복습→새 표현→약점 드릴 체이닝(원버튼). 크기 노브는 저장 후 카드만 다시 그림.
    root.querySelector('#sess-go')?.addEventListener('click', () => startSession());
    root.querySelectorAll('.sess-size button').forEach((b) => b.addEventListener('click', () => {
      try { localStorage.setItem(SESS_SIZE_KEY, b.dataset.size); } catch (e) { /* quota */ }
      paintShell();
      const listEl = root.querySelector('#study-list');
      if (listEl) { listEl.innerHTML = listHtml(); wireList(); }
    }));
  }

  // ── 오늘 세션 — 복습(SRS) → 새 표현 소개 → 약점 드릴을 한 버튼으로 체이닝 (v1.32.0) ──
  // 항목 선택: srsQueue(복습 due + 신규) 그대로 → 채점된 카드는 다음 조회에서 자연히 빠지므로
  // 같은 날 재진입(이어서 하기)이 별도 카드 상태 저장 없이 정확하다. 드릴은 prof.scores 의
  // 최약축을 모드로 매핑(콜드스타트 = 받아쓰기). 완료 시에만 markStudyDay(정직한 스트릭).
  const AXIS_DRILL = { listening: 'dictation', production: 'prod', automaticity: 'read' };
  function pickDrills(n) {
    const ranked = ['listening', 'production', 'automaticity']
      .filter((k) => prof.scores[k] != null)
      .sort((a, b) => prof.scores[a] - prof.scores[b])
      .map((k) => AXIS_DRILL[k]);
    const out = ranked.length ? ranked : ['dictation', 'read'];   // 미측정 콜드스타트 기본
    if (n > out.length && !out.includes('cloze')) out.push('cloze');
    return out.slice(0, n);
  }

  async function startSession() {
    stopClip();
    const size = sessSize();
    const caps = SESS_CAPS[size];
    const today = _dayKey(new Date());
    let st = loadSess();
    const resumable = st && st.d === today && !st.completedAt && st.stage !== 'done';
    if (!resumable) {
      st = { v: 1, d: today, size, stage: 'review', drillIdx: 0,
             drillModes: pickDrills(caps.drills),
             stats: { reviewDone: 0, reviewAgain: 0, newDone: 0, newKnown: 0, drills: [] },
             completedAt: null };
    }
    saveSess(st);
    root.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    let queue = [];
    try { queue = await srsQueue(); } catch (e) { queue = []; }   // 오프라인 → 복습/새표현 자동 스킵
    runSessStage(st, queue);
  }

  function sessHeaderHtml(st, label, i, n) {
    const segs = ['복습', '새 표현', ...st.drillModes.map(() => '드릴')];
    const cur = st.stage === 'review' ? 0 : st.stage === 'new' ? 1 : 2 + st.drillIdx;
    return `
      <div class="quiz-bar sess-bar">
        <span class="quiz-count">${label} ${i} / ${n}</span>
        <span class="sess-segs">${segs.map((sg, k) => `<i class="${k < cur ? 'done' : k === cur ? 'on' : ''}">${sg}</i>`).join('')}</span>
      </div>`;
  }

  function runSessStage(st, queue) {
    saveSess(st);
    if (st.stage === 'review') return sessReview(st, queue);
    if (st.stage === 'new') return sessNew(st, queue);
    if (st.stage === 'drill') return sessDrill(st);
    return sessSummary(st);
  }

  // 1단계 복습 — 간이 플래시카드(뜻 → 정답 공개 → Again/알았어요). Again 은 덱 맨 뒤로 재투입.
  function sessReview(st, queue) {
    const caps = SESS_CAPS[st.size] || SESS_CAPS.M;
    const cards = queue.filter((c) => (c.reps || 0) > 0).slice(0, caps.review);
    if (!cards.length) { st.stage = 'new'; return runSessStage(st, queue); }
    const total = cards.length;
    let done = 0;
    prefetch(cards.slice(0, 4).map((c) => c.front || c.term).filter(Boolean));
    function paint() {
      const c = cards[0];
      if (!c) { st.stage = 'new'; return runSessStage(st, queue); }
      const term = c.front || c.term || '';
      const definition = splitBack(c.back).def || c.definition || '';
      root.innerHTML = `
        ${sessHeaderHtml(st, '복습', Math.min(done + 1, total), total)}
        <div class="sent-card sess-flash" id="sess-flash">
          <div class="quiz-def">${escapeHtml(definition)}</div>
          <div class="sent-reveal" id="sess-rev" hidden>
            <div class="sent-term">${escapeHtml(term)} <span class="sent-spk">🔊</span></div>
            ${c.example_sentence ? `<div class="sent-def">“${highlightTerm(c.example_sentence, term)}”</div>` : ''}
          </div>
        </div>
        <button class="study-cta-btn" id="sess-reveal">정답 보기</button>
        <div class="dict-actions" id="sess-grades" hidden>
          <button class="study-cta-btn secondary" id="sess-again">↺ Again</button>
          <button class="study-cta-btn" id="sess-good">알았어요 ✓</button>
        </div>
        <button class="quiz-exit" id="sess-exit">✕ 저장하고 나가기</button>`;
      root.querySelector('#sess-exit').addEventListener('click', () => { saveSess(st); renderStudy(root); });
      root.querySelector('#sess-flash').addEventListener('click', () => speak(term));
      root.querySelector('#sess-reveal').addEventListener('click', (e) => {
        e.currentTarget.hidden = true;
        root.querySelector('#sess-rev').hidden = false;
        root.querySelector('#sess-grades').hidden = false;
        speak(term);
      });
      const grade = (g) => {
        srsReview(c.id, g).catch(() => {});   // fire-and-forget(오프라인이어도 흐름 유지)
        if (g === 'again') { st.stats.reviewAgain++; cards.push(cards.shift()); }
        else { st.stats.reviewDone++; done++; cards.shift(); }
        saveSess(st);
        paint();
      };
      root.querySelector('#sess-again').addEventListener('click', () => grade('again'));
      root.querySelector('#sess-good').addEventListener('click', () => grade('good'));
    }
    paint();
  }

  // 2단계 새 표현 — 오디오 퍼스트 소개 카드. 이미 알아요=markKnown / 학습 시작=SM-2 진입(내일 due).
  function sessNew(st, queue) {
    const caps = SESS_CAPS[st.size] || SESS_CAPS.M;
    const cards = queue.filter((c) => (c.reps || 0) === 0).slice(0, caps.fresh);
    if (!cards.length) { st.stage = 'drill'; return runSessStage(st, queue); }
    let i = 0;
    function paint() {
      const c = cards[i];
      if (!c) { st.stage = 'drill'; return runSessStage(st, queue); }
      const term = c.front || c.term || '';
      const definition = splitBack(c.back).def || c.definition || '';
      root.innerHTML = `
        ${sessHeaderHtml(st, '새 표현', i + 1, cards.length)}
        <div class="sent-card sess-flash" id="sess-flash">
          <div class="sent-term">${escapeHtml(term)} <span class="sent-spk">🔊</span></div>
          ${definition ? `<div class="sent-def">${escapeHtml(definition)}</div>` : ''}
          ${c.example_sentence ? `<div class="sent-def sess-ex">“${highlightTerm(c.example_sentence, term)}”</div>` : ''}
        </div>
        <div class="dict-actions">
          <button class="study-cta-btn secondary" id="sess-know">이미 알아요 ✓</button>
          <button class="study-cta-btn" id="sess-learn">학습 시작 ▸</button>
        </div>
        <button class="quiz-exit" id="sess-exit">✕ 저장하고 나가기</button>`;
      requestAnimationFrame(() => playExample(c));   // 뜻을 읽기 전에 실제 음성부터(오디오 퍼스트)
      root.querySelector('#sess-flash').addEventListener('click', () => playExample(c));
      root.querySelector('#sess-exit').addEventListener('click', () => { saveSess(st); stopClip(); renderStudy(root); });
      root.querySelector('#sess-know').addEventListener('click', () => {
        if (c.vocab_id != null) markKnown(c.vocab_id).catch(() => {});
        st.stats.newKnown++; applyKnown(1); advance();
      });
      root.querySelector('#sess-learn').addEventListener('click', () => {
        srsReview(c.id, 'good').catch(() => {});
        st.stats.newDone++; advance();
      });
      function advance() { stopClip(); saveSess(st); i++; paint(); }
    }
    paint();
  }

  // 3단계 드릴 — 최약축 모드에 기존 드릴 엔진을 풀만 잘라 넘긴다. 완료는 _sessNext 훅으로 돌아온다.
  async function sessDrill(st) {
    const caps = SESS_CAPS[st.size] || SESS_CAPS.M;
    const mode = st.drillModes[st.drillIdx];
    if (!mode) return sessSummary(st);
    root.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    let all = [];
    try { all = await allExpressions(); } catch (e) { all = []; }
    const valid = {
      read: (v) => v.term && v.definition,
      cloze: (v) => v.example_sentence && v.term && v.example_sentence.toLowerCase().includes(v.term.toLowerCase()),
      dictation: (v) => v.example_sentence && v.example_sentence.trim(),
      prod: (v) => v.example_sentence && v.example_sentence.trim().split(/\s+/).length >= 3,
    }[mode] || (() => true);
    let pool = all.filter((v) => !v.known && valid(v));   // 미마스터 우선(startWeakQuiz 와 동일)
    if (pool.length < 4) pool = all.filter(valid);
    if (pool.length < (mode === 'read' || mode === 'cloze' ? 4 : 1)) return sessSummary(st);  // 풀 부족/오프라인
    const sliced = _shuffle(pool).slice(0, caps[mode] || 5);
    _sessNext = (res) => {
      _sessNext = null;
      st.stats.drills.push(res);
      st.drillIdx++;
      saveSess(st);
      if (st.drillIdx < st.drillModes.length) sessDrill(st);
      else sessSummary(st);
    };
    if (mode === 'read') startQuiz('read', sliced);
    else if (mode === 'cloze') startCloze(sliced);
    else if (mode === 'prod') startProduction(sliced);
    else startDictation(sliced);
  }

  // 요약 — 여기서만 스트릭이 오른다(세션 완료 = 학습한 날). '한 세션 더'는 새 풀로 재시작.
  function sessSummary(st) {
    _sessNext = null;
    stopClip();
    st.stage = 'done';
    st.completedAt = Date.now();
    saveSess(st);
    markStudyDay();
    const drills = st.stats.drills.map((d) => {
      const lbl = DRILL_LABEL[d.mode] || d.mode;
      return d.total ? `${lbl} · ${d.correct}/${d.total}` : lbl;
    });
    root.innerHTML = `
      <div class="quiz-summary">
        <div class="quiz-sum-msg">오늘 세션 완료! ✅</div>
        <div class="quiz-sum-score">🔥 ${getStreak()}</div>
        <div class="quiz-sum-pct">일 연속 학습</div>
        <div class="sess-sum-lines">
          <div>복습 ${st.stats.reviewDone}장${st.stats.reviewAgain ? ` (↺ ${st.stats.reviewAgain})` : ''}</div>
          <div>새 표현 ${st.stats.newDone + st.stats.newKnown}개${st.stats.newKnown ? ` (이미 앎 ${st.stats.newKnown})` : ''}</div>
          ${drills.map((d) => `<div>${d}</div>`).join('')}
        </div>
        <div class="quiz-sum-actions">
          <button class="study-cta-btn" id="sess-home">홈으로</button>
          <button class="study-cta-btn secondary" id="sess-more">한 세션 더</button>
        </div>
      </div>`;
    root.querySelector('#sess-home').addEventListener('click', () => renderStudy(root));
    root.querySelector('#sess-more').addEventListener('click', () => {
      try { localStorage.removeItem(SESS_KEY); } catch (e) { /* quota */ }
      startSession();
    });
  }

  // ── 레벨 체크 — 드릴에서 안 만난(unseen) 표현만 골라 받아쓰기. 외운 게 아닌 실제 청해를 비편향 측정. ──
  async function startLevelCheck() {
    stopClip();
    const listEl = root.querySelector('#study-list');
    if (listEl) listEl.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    let all = [];
    try { all = await allExpressions(); } catch (e) { all = []; }
    const seen = loadSeen();
    const withEx = all.filter((v) => v.example_sentence && v.example_sentence.trim());
    const unseen = withEx.filter((v) => !seen.has(v.id));
    const pool = unseen.length >= 5 ? unseen : withEx;   // unseen 부족(첫 측정 등)하면 전체로 폴백
    if (!pool.length) {
      if (listEl) listEl.innerHTML = '<div class="empty">No material to test yet.</div>';
      return;
    }
    startDictation(pool, true);   // unseen=true → listeningUnseen 으로 기록(axisScores 우선 채택)
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
  function startQuiz(mode = 'read', source = null, unseen = false) {
    stopClip();
    const pool = (source || items).filter((v) => v.term && v.definition);
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
    markSeen(qs.map((x) => x.correct.id));   // 본 표현 적립(Level Check unseen 판정)
    let idx = 0, score = 0, answered = false;
    let tShown = 0; const lats = [];   // 응답 지연(자동화 축) — 카드 표시→선택까지 ms

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
      root.querySelector('#q-exit').addEventListener('click', () => renderStudy(root));
      root.querySelectorAll('.quiz-opt').forEach((b) => b.addEventListener('click', () => answerQ(b, c)));
      tShown = performance.now();   // 표시 시각 기록(다음 클릭까지가 응답 지연)
    }
    function answerQ(btn, c) {
      if (answered) return;
      answered = true;
      if (tShown) lats.push(performance.now() - tShown);   // 응답 지연 누적
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
      recordQuiz(score, qs.length);
      const med = lats.length ? [...lats].sort((a, b) => a - b)[lats.length >> 1] : 0;
      recordMeasure(mode, score / qs.length, qs.length, { ms: med, unseen });
      if (_sessNext) { const go = _sessNext; _sessNext = null; return go({ mode, correct: score, total: qs.length }); }
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
      root.querySelector('#q-again').addEventListener('click', () => startQuiz(mode, source, unseen));
      root.querySelector('#q-home').addEventListener('click', () => renderStudy(root));
    }
    paintQ();
  }

  // ── 약점 집중 퀴즈 (전 kind 통합 + 미마스터(known=false) 우선) ──
  async function startWeakQuiz() {
    stopClip();
    const listEl = root.querySelector('#study-list');
    if (listEl) listEl.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    let all = [];
    try { all = await allExpressions(); } catch (e) { all = []; }
    const weak = all.filter((v) => !v.known && v.term && v.definition);
    const pool = weak.length >= 4 ? weak : all.filter((v) => v.term && v.definition);
    if (pool.length < 4) {
      if (listEl) listEl.innerHTML = '<div class="empty">Not enough expressions for a quiz (need 4+).</div>';
      return;
    }
    startQuiz('read', pool);   // 4지선다 회상 — startQuiz 가 셔플·슬라이스
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
    markSeen(deck.map((c) => c.id));
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
        if (cx) cx.addEventListener('click', (ev) => { ev.stopPropagation(); playSentenceClip(cx.dataset.url, cx.dataset.s, cx.dataset.e, cx, undefined, false, 0, () => speak(c.example_sentence)); });
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
  function startDictation(source = null, unseen = false) {
    stopClip();
    const pool = (source || items).filter((v) => v.example_sentence && v.example_sentence.trim());
    if (!pool.length) {
      const el = root.querySelector('#study-list');
      if (el) el.innerHTML = '<div class="empty">No expressions with examples yet.</div>';
      return;
    }
    const cards = _shuffle(pool).slice(0, Math.min(20, pool.length));
    markSeen(cards.map((c) => c.id));
    let idx = 0, correct = 0;
    prefetch(cards.slice(0, 4).map((c) => c.example_sentence));

    function finishD() {
      recordQuiz(correct, cards.length);
      recordMeasure('dictation', correct / cards.length, cards.length, { unseen });
      if (_sessNext) { const go = _sessNext; _sessNext = null; return go({ mode: 'dictation', correct, total: cards.length }); }
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
      root.querySelector('#d-again').addEventListener('click', () => startDictation(source, unseen));
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
    markSeen(cards.map((c) => c.id));
    let idx = 0, scoreSum = 0, scored = 0;
    prefetch(cards.slice(0, 4).map((c) => c.example_sentence));

    function finishSp() {
      const avg = scored ? Math.round(scoreSum / scored) : 0;
      if (scored) recordMeasure('speak', avg / 100, scored);   // 산출(Production) 축 — 이전엔 버려지던 점수
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
  function startProduction(source = null) {
    stopClip();
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const pool = (source || items).filter((v) => v.example_sentence && v.example_sentence.trim().split(/\s+/).length >= 3);
    if (!pool.length) {
      const el = root.querySelector('#study-list');
      if (el) el.innerHTML = '<div class="empty">No examples to practice yet.</div>';
      return;
    }
    const cards = _shuffle(pool).slice(0, Math.min(20, pool.length));
    markSeen(cards.map((c) => c.id));
    let idx = 0, scoreSum = 0, scored = 0;

    function finishPr() {
      const avg = scored ? Math.round(scoreSum / scored) : 0;
      if (scored) recordMeasure('prod', avg / 100, scored);   // 산출(KR→EN) 축
      if (_sessNext) { const go = _sessNext; _sessNext = null; return go({ mode: 'prod', correct: scored ? avg : 0, total: scored ? 100 : 0 }); }
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
      root.querySelector('#pr-again').addEventListener('click', () => startProduction(source));
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
  function startCloze(source = null, unseen = false) {
    stopClip();
    const pool = (source || items).filter((v) => v.example_sentence && v.term &&
      v.example_sentence.toLowerCase().includes(v.term.toLowerCase()));
    if (!pool.length) {
      const el = root.querySelector('#study-list');
      if (el) el.innerHTML = '<div class="empty">No examples for cloze yet.</div>';
      return;
    }
    const cards = _shuffle(pool).slice(0, Math.min(20, pool.length));
    markSeen(cards.map((c) => c.id));
    let idx = 0, correct = 0;
    prefetch(cards.slice(0, 4).map((c) => c.term));

    function finishC() {
      recordQuiz(correct, cards.length);
      recordMeasure('cloze', correct / cards.length, cards.length, { unseen });
      if (_sessNext) { const go = _sessNext; _sessNext = null; return go({ mode: 'cloze', correct, total: cards.length }); }
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
      root.querySelector('#cz-again').addEventListener('click', () => startCloze(source, unseen));
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
    root.innerHTML = heroHtml() + '<div class="empty">No expression data yet.</div>' + statsHtml();
    return;
  }
  await loadKind(selected);
}
