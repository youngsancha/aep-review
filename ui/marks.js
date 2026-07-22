// 운전 캡처(Drive capture) — 주행 중 '지금 들리는 문장'을 원탭(플로팅 🔖)/차 핸들 ⏭ 버튼으로
// 북마크만 해 두고, 학습(단어 고르기·카드 만들기)은 나중에 Study 홈 트리아지에서 한다.
// 원칙: 차에서는 1비트(타임스탬프)만 — 읽기·고르기·확인이 필요한 일은 전부 정차 후로 미룬다.
//
// 설계: media-session.js 처럼 top-level 에서 DOM/navigator/다른 모듈을 만지지 않는다.
//  - 순수 헬퍼(pushMark/groupRuns/sentencesAround)는 node --test 가 직접 import 해 검증(tests/marks.test.mjs).
//  - 브라우저 배선은 initDriveCapture({ player, toast }) 주입으로만 일어난다(episode.js 가 호출).

const MARKS_KEY = 'aep-marks';
const FAB_POS_KEY = 'aep-fab-pos';   // 사용자가 드래그로 옮긴 FAB 위치 {l,t}(px) — 기기별 유지
const MAX_MARKS = 100;      // FIFO 상한 — 트리아지 없이 쌓여도 localStorage 를 못 채우게
// 연타 흡수 간격: 4s → 1.5s (2026-07-22). 실주행에서 몇 초 간격의 '의도된' 연속 탭이 흡수돼
// "눌렀는데 반응이 없다"로 느껴졌다. 실수 더블탭(<0.5s)만 막으면 충분 — 나머지는 전부 저장.
const DEDUPE_SEC = 1.5;
const REACTION_SEC = 1.5;   // '듣고 → 누르기'의 반응 지연 보정 — 살짝 과거 시각을 저장
const FWD_SEC = 30;         // media-session.js DEFAULT_FWD 와 동기(캡처 OFF 시 ⏭ 원복용)

let _player = null;
let _toast = null;

// ─────────────────────────── 순수 헬퍼 (node 검증 대상) ───────────────────────────

// 연타 dedupe + FIFO 상한. added=false 면 기존 마크에 흡수(연타)된 것.
export function pushMark(list, mark) {
  for (const m of list) {
    if (m.ep === mark.ep && Math.abs(m.t - mark.t) < DEDUPE_SEC) return { list, added: false };
  }
  const out = list.concat([mark]);
  while (out.length > MAX_MARKS) out.shift();
  return { list: out, added: true };
}

// 선택된 단어 인덱스 → 연속 구간(run) 묶음. 인접 단어를 함께 고르면 하나의 구(句) 카드가 된다
// (예: "pull"+"off" 선택 → 카드 1장 "pull off").
export function groupRuns(indices) {
  const sorted = [...indices].sort((a, b) => a - b);
  const runs = [];
  for (const i of sorted) {
    const last = runs[runs.length - 1];
    if (last && i === last[last.length - 1] + 1) last.push(i);
    else runs.push([i]);
  }
  return runs;
}

// transcript 세그먼트에서 t 주변([-before,+after]s에 시작하는) 단어를 문장 단위로 묶어 반환:
// [{ text, start, end, words: [{ word, start, end }] }]. episode.js resegment 의 미니 버전 —
// 종결 구두점/큰 쉼(>0.8s)에서만 끊는다(트리아지 표시·예문 추출용이라 이 정도면 충분).
export function sentencesAround(segments, t, before = 9, after = 3) {
  const words = [];
  for (const seg of segments || []) {
    if (!seg.words || !seg.words.length) continue;
    for (const w of seg.words) {
      if (w.word == null) continue;
      const s = w.start ?? seg.start;
      if (s >= t - before && s <= t + after) {
        words.push({ word: String(w.word).trim(), start: s, end: w.end ?? seg.end });
      }
    }
  }
  const ENDS = /[.!?…]["')\]]?$/;
  const out = [];
  let cur = null;
  let prevEnd = null;
  const close = () => {
    if (cur && cur.words.length) {
      cur.text = cur.words.map((x) => x.word).join(' ');
      out.push(cur);
    }
    cur = null;
  };
  for (const w of words) {
    if (cur && prevEnd != null && (w.start - prevEnd) > 0.8) close();
    if (!cur) cur = { start: w.start, end: w.end, words: [] };
    cur.words.push(w);
    cur.end = w.end;
    prevEnd = w.end;
    if (ENDS.test(w.word)) close();
  }
  close();
  return out;
}

// ─────────────────────────── 저장 ───────────────────────────

export function loadMarks() {
  try { return JSON.parse(localStorage.getItem(MARKS_KEY) || '[]') || []; } catch { return []; }
}
function saveMarks(list) {
  try { localStorage.setItem(MARKS_KEY, JSON.stringify(list)); } catch (e) { /* quota */ }
}
export function removeMark(key) {
  saveMarks(loadMarks().filter((m) => m.k !== key));
}

// 운전 모드 상태는 '메모리 전용 + 회차 진입마다 OFF 리셋'(사용자 요청 2026-07-22: transcript 에
// 처음 들어가면 항상 꺼진 상태). 지난 주행에서 켜둔 모드가 다음날까지 남는 것을 막는 게 목적 —
// PWA 는 백그라운드에서 며칠 살아남으므로 localStorage 는 물론 메모리 유지도 '항상 OFF'를 못
// 보장한다. 그래서 initDriveCapture(=renderEpisode 마다 호출)가 매번 명시적으로 끈다.
let _drive = false;
export function driveOn() { return _drive; }

// ─────────────────────────── 브라우저 배선 ───────────────────────────

// '지금 이 순간' 북마크 — FAB 과 차량 ⏭ 버튼이 공유하는 단일 진입점.
export function addMark() {
  if (!_player || !_player.current) return false;
  const t = Math.round(Math.max(0, (_player.time || 0) - REACTION_SEC) * 10) / 10;
  const mark = {
    k: _player.current.id + ':' + Math.round(t),
    ep: _player.current.id,
    title: _player.current.title || '',
    t,
    at: Date.now(),
  };
  const { list, added } = pushMark(loadMarks(), mark);
  if (added) saveMarks(list);
  // 안내는 영어 — 플레이어/시트 컨트롤 표기(Shadow·Transcript 등)와 통일(사용자 요청 2026-07-22).
  if (_toast) _toast(added ? `🔖 Saved (${list.length}) — make cards in Study` : '🔖 Already saved this moment');
  const fab = document.getElementById('drive-fab');
  if (fab) {
    const n = fab.querySelector('.drive-fab-n');
    if (n) n.textContent = String(list.length);
    fab.classList.remove('pop');
    void fab.offsetWidth;                      // 리플로 강제 → 연속 탭에도 애니메이션 재시작
    fab.classList.add('pop');
  }
  return added;
}

// 차 핸들/블루투스 '다음 트랙'(AVRCP→Media Session nexttrack)을 캡처 ON 이면 북마크로,
// OFF 면 원래 +30s 스킵으로. PWA 가 차량 버튼을 받을 수 있는 유일한 웹 표준 통로라
// bindMediaSession(player.js)의 기본 등록을 setActionHandler 재호출로 덮어쓴다.
// ⏮(previoustrack -15s)·seekforward/backward 는 건드리지 않는다 — 되감기는 운전 중에도 필요.
function applyDriveMS() {
  try {
    const ms = typeof navigator !== 'undefined' && navigator.mediaSession;
    if (!ms || typeof ms.setActionHandler !== 'function') return;
    ms.setActionHandler('nexttrack', driveOn() ? () => addMark() : () => { if (_player) _player.skip(+FWD_SEC); });
  } catch (e) { /* 미지원 액션 — 무시 */ }
}

export function setDrive(on) {
  _drive = !!on;
  document.body.classList.toggle('drive-capture', _drive);
  applyDriveMS();
}

// episode.js 렌더마다 호출(멱등). FAB 은 body 직속이라 transcript 시트의 배경 inert
// (#topbar/#tabbar/#app/#miniplayer)에 안 걸려 시트를 연 쉐도잉 중에도 눌린다.
// 표시 여부는 CSS 가 body.drive-capture.on-episode 로만 결정 — 라우트 이탈 시 자동 숨김.
export function initDriveCapture(deps) {
  _player = deps.player;
  _toast = deps.toast;
  setDrive(false);                                            // 회차 진입 = 항상 OFF 로 시작
  try { localStorage.removeItem('aep-drive'); } catch (e) {}  // 구버전(persist 시절) 잔재 정리
  let fab = document.getElementById('drive-fab');
  if (!fab) {
    fab = document.createElement('button');
    fab.id = 'drive-fab';
    fab.setAttribute('aria-label', 'Save this sentence (drag to move)');
    fab.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' +
      `<i class="drive-fab-n">${loadMarks().length}</i>`;
    bindFabPointer(fab);
    document.body.appendChild(fab);
    applyFabPos(fab);
    window.addEventListener('resize', () => applyFabPos(fab));  // 회전/리사이즈 → 화면 안으로 재클램프
  } else {
    const n = fab.querySelector('.drive-fab-n');
    if (n) n.textContent = String(loadMarks().length);
  }
}

// ─────────────────────────── FAB 탭/드래그 ───────────────────────────
// 신뢰성 원칙(주행 중 실패 0): click 이벤트를 쓰지 않는다 — click 은 탭 중 손가락이 조금만
// 밀려도(주행 진동) 브라우저가 제스처로 판정해 아예 발화하지 않는 일이 있었다(사용자 보고
// 2026-07-22). 대신 pointer 이벤트 + setPointerCapture + CSS touch-action:none 으로 터치를
// 처음부터 끝까지 우리가 소유한다: 12px 이상 움직이면 '위치 이동(드래그)', 그 미만이면 놓는
// 순간 무조건 저장. 시스템이 제스처를 뺏어(pointercancel) 가도 이동이 없었다면 저장한다.
const DRAG_START_PX = 12;

function clampPos(l, t, size) {
  const m = 8;
  return {
    l: Math.min(Math.max(l, m), window.innerWidth - size - m),
    t: Math.min(Math.max(t, m), window.innerHeight - size - m),
  };
}

function applyFabPos(fab) {
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null'); } catch (e) { /* 파싱 실패 → 기본 위치 */ }
  if (!pos || !Number.isFinite(pos.l) || !Number.isFinite(pos.t)) return;   // 기본 위치는 CSS(right/bottom)
  const { l, t } = clampPos(pos.l, pos.t, fab.offsetWidth || 64);
  fab.style.left = l + 'px';
  fab.style.top = t + 'px';
  fab.style.right = 'auto';
  fab.style.bottom = 'auto';
}

function bindFabPointer(fab) {
  let pid = null, sx = 0, sy = 0, sl = 0, st = 0, moved = false;
  fab.addEventListener('pointerdown', (e) => {
    if (pid != null) return;                 // 멀티터치 두 번째 손가락 무시
    pid = e.pointerId; moved = false;
    sx = e.clientX; sy = e.clientY;
    const r = fab.getBoundingClientRect(); sl = r.left; st = r.top;
    try { fab.setPointerCapture(pid); } catch (err) { /* 미지원 — move/up 은 그래도 옴 */ }
    e.preventDefault();
  });
  fab.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) < DRAG_START_PX) return;
    moved = true;
    fab.classList.add('dragging');
    const { l, t } = clampPos(sl + dx, st + dy, fab.offsetWidth || 64);
    fab.style.left = l + 'px'; fab.style.top = t + 'px';
    fab.style.right = 'auto'; fab.style.bottom = 'auto';
  });
  const finish = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    fab.classList.remove('dragging');
    if (moved) {
      const r = fab.getBoundingClientRect();
      try { localStorage.setItem(FAB_POS_KEY, JSON.stringify({ l: Math.round(r.left), t: Math.round(r.top) })); } catch (err) { /* quota */ }
    } else {
      addMark();          // 탭(이동 없음) — pointercancel 이어도 저장: 차 안에선 놓치는 쪽이 더 비싸다
    }
  };
  fab.addEventListener('pointerup', finish);
  fab.addEventListener('pointercancel', finish);
}
