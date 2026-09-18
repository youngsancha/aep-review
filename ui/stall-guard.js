// 재생 정체(stall) 감시 — 순수 판정 로직. DOM/Audio 는 player.js 가 넘겨주는 스냅샷으로만 본다.
//
// 증상(Roy, 2026-09-14, 여러 번 재현): 오프라인 + 에어팟 + 화면 꺼짐으로 ~40분 듣다 보면 재생이 멈추고,
// 그 뒤 에어팟 ▶ 를 눌러도 재생되지 않는다. 코드에는 stalled/waiting 에 대한 복구가 전혀 없었고 audio.play()
// 는 미디어 파이프라인이 죽어도 resolve 하므로 ▶ 는 '성공한 무반응'이 된다. 원인 후보는 여럿이고(안드로이드가
// 유휴 SW 를 종료해 Range 응답이 끊김 · 캐시 읽기 오류 · 오디오 포커스 회수 뒤 파이프라인 정지) 증상은 같다:
//   "한 번 진행하던 재생이, paused 가 아닌데 더는 움직이지 않는다".
// 그래서 원인 대신 그 증상을 재고, 같은 위치로 src 를 다시 로드해 새 fetch → (SW 재기동 →) 캐시에서 읽게 한다.
//
// ⛔ v1.75.1 의 첫 판은 이 판정을 **초기 로딩에도** 적용했다(복구 직후 '진행한 것으로' 시계를 되감았고, ▶ 전
// 재로드도 '한 번도 안 움직인' 상태에서 발동). 폰의 오프라인 로딩이 12초를 넘기자 로드를 반복 재시작해
// "오프라인이 느려지고 아예 안 틀어지는" 회귀가 됐다(Roy, 2026-09-17). 규칙:
//   ① 이번 (재)로드 뒤 한 번도 진행하지 않았으면 정체가 아니다 — 로딩은 브라우저 몫이다.
//   ② 엘리먼트가 '데이터 받는 중'(networkState LOADING · readyState < FUTURE_DATA)이면 문턱을 45초로 올린다.
//   ③ ▶ 직전 재로드는 '진행한 적이 있고' 그 뒤 12초 넘게 waiting 인 경우에만.
//   ④ 재로드 뒤에는 45초의 유예를 주고, 5분에 4회를 넘기면 포기한다.
export const STALL_MS = 12_000;          // 재생 중 진행이 없으면 정체로 보는 시간
export const LOADING_STALL_MS = 45_000;  // 엘리먼트가 아직 데이터를 받는 중이라고 할 때의 문턱
export const RELOAD_GRACE_MS = 45_000;   // 재로드 뒤 다시 판정하기까지의 유예
export const MAX_RECOVER = 4;
export const RECOVER_WINDOW_MS = 5 * 60_000;
const HAVE_FUTURE_DATA = 3, NETWORK_LOADING = 2;

export function initialState() {
  return { lastTime: -1, lastAdvanceAt: null, waitingSince: 0, reloadAt: null, recoveries: [] };
}

// timeupdate 마다: currentTime 이 실제로 움직였을 때만 '진행'.
export function noteTime(st, t, now) {
  if (st.lastTime < 0 || Math.abs(t - st.lastTime) > 0.05) {
    st.lastTime = t;
    st.lastAdvanceAt = now;
    st.waitingSince = 0;
  }
  return st;
}

export function noteWaiting(st, now) { if (!st.waitingSince) st.waitingSince = now; return st; }
export function noteTrackChange(st) { return Object.assign(st, initialState()); }

function loading(snap) {
  return snap.net === NETWORK_LOADING && (snap.ready ?? 0) < HAVE_FUTURE_DATA;
}

// snap: { paused, ended, currentTime, error, ready, net } — audio 엘리먼트에서 읽은 값.
// 반환: 'ok' | 'stalled' | 'give-up'
export function decide(st, snap, now) {
  if (snap.paused || snap.ended) return 'ok';
  let stalled;
  if (snap.error) {
    stalled = true;
  } else if (st.lastAdvanceAt === null) {
    // ① 이번 로드 뒤 진행 없음 → 로딩 중. 단 ④ 재로드 유예가 지나면 한 번 더 시도.
    stalled = st.reloadAt !== null && (now - st.reloadAt) >= RELOAD_GRACE_MS;
  } else {
    const limit = loading(snap) ? LOADING_STALL_MS : STALL_MS;
    stalled = (now - st.lastAdvanceAt) >= limit && Math.abs(snap.currentTime - st.lastTime) <= 0.05;
  }
  if (!stalled) return 'ok';
  const recent = st.recoveries.filter((at) => now - at < RECOVER_WINDOW_MS);
  if (recent.length >= MAX_RECOVER) return 'give-up';
  return 'stalled';
}

export function noteRecovery(st, now) {
  st.recoveries = st.recoveries.filter((at) => now - at < RECOVER_WINDOW_MS);
  st.recoveries.push(now);
  st.lastAdvanceAt = null;   // 진행한 적 없음으로 되돌린다 — 다음 판정은 실제 진행(또는 유예 만료) 뒤에
  st.reloadAt = now;
  st.waitingSince = 0;
  return st;
}

// ▶(에어팟/잠금화면/버튼) 직전 판정 — 진행한 적이 있는 재생이 오래 waiting 이면 파이프라인이 죽었을 가능성이
// 높다 → play() 전에 재로드. 초기 로딩(진행 전)에는 절대 발동하지 않는다(③).
export function shouldReloadBeforePlay(st, snap, now) {
  if (snap.error) return true;
  if (st.lastAdvanceAt === null || !st.waitingSince) return false;
  return (now - st.waitingSince) >= STALL_MS;
}
