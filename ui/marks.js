// 운전 캡처(Drive capture) — 주행 중 '지금 들리는 문장'을 원탭(플로팅 🔖)/차 핸들 ⏭ 버튼으로
// 북마크만 해 두고, 학습(단어 고르기·카드 만들기)은 나중에 Study 홈 트리아지에서 한다.
// 원칙: 차에서는 1비트(타임스탬프)만 — 읽기·고르기·확인이 필요한 일은 전부 정차 후로 미룬다.
//
// 설계: media-session.js 처럼 top-level 에서 DOM/navigator/다른 모듈을 만지지 않는다.
//  - 순수 헬퍼(pushMark/groupRuns/sentencesAround)는 node --test 가 직접 import 해 검증(tests/marks.test.mjs).
//  - 브라우저 배선은 initDriveCapture({ player, toast }) 주입으로만 일어난다(episode.js 가 호출).

const MARKS_KEY = 'aep-marks';
const MAX_MARKS = 100;      // FIFO 상한 — 트리아지 없이 쌓여도 localStorage 를 못 채우게
const DEDUPE_SEC = 4;       // 같은 회차에서 이 간격 안의 연타(핸들 버튼 더블탭)는 한 개로
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
    fab.setAttribute('aria-label', 'Save this sentence');
    fab.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' +
      `<i class="drive-fab-n">${loadMarks().length}</i>`;
    fab.addEventListener('click', (e) => { e.stopPropagation(); addMark(); });
    document.body.appendChild(fab);
  } else {
    const n = fab.querySelector('.drive-fab-n');
    if (n) n.textContent = String(loadMarks().length);
  }
}
