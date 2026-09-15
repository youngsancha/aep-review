// 재생 정체(stall) 감시 — 순수 판정 로직. DOM/Audio 는 player.js 가 넘겨주는 스냅샷으로만 본다.
//
// 증상(Roy, 2026-09-14, 여러 번 재현): 오프라인 모드 + 에어팟 + 화면 꺼짐으로 ~40분 듣다 보면 재생이
// 멈추고, 그 뒤 에어팟 ▶ 를 눌러도 재생되지 않는다. 코드에는 stalled/waiting 에 대한 복구가 전혀 없었고
// (player.js 는 timeupdate/play/pause/ended/error 만 들었다), audio.play() 는 미디어 파이프라인이 죽어도
// resolve 하므로 ▶ 는 '성공한 무반응'이 된다. 원인 후보는 여럿이고(안드로이드가 유휴 SW 를 종료해 Range
// 응답이 끊김 · 캐시 읽기 오류 · 오디오 포커스 회수 뒤 파이프라인 정지) 어느 것이든 증상은 같다:
//   "paused 가 아닌데 currentTime 이 안 움직인다".
// 그래서 원인을 맞히는 대신 그 증상을 재고, 같은 위치로 src 를 다시 로드해 새 fetch → (SW 재기동 →)
// 캐시에서 다시 읽게 한다. 재시도는 상한을 두어 진짜 죽은 파일에서 무한 루프를 돌지 않는다.
export const STALL_MS = 12_000;      // 이만큼 진행이 없으면 정체로 본다(버퍼링 잠깐은 넘긴다)
export const MAX_RECOVER = 4;        // 한 트랙에서 허용하는 복구 횟수
export const RECOVER_WINDOW_MS = 5 * 60_000;   // 이 창 안에서 MAX_RECOVER 를 넘으면 포기

export function initialState() {
  return { lastTime: -1, lastAdvanceAt: null, waitingSince: 0, recoveries: [] };
}

// timeupdate 마다 호출: currentTime 이 실제로 움직였을 때만 '진행'으로 친다.
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

// snapshot: { paused, ended, currentTime, error } — audio 엘리먼트에서 읽은 값.
// 반환: 'ok' | 'stalled' | 'give-up'
export function decide(st, snap, now) {
  if (snap.paused || snap.ended) return 'ok';
  if (st.lastAdvanceAt === null) return 'ok';                 // 아직 한 번도 진행 안 함(로딩 중)
  const stalled = (now - st.lastAdvanceAt) >= STALL_MS
    && (Math.abs(snap.currentTime - st.lastTime) <= 0.05);
  if (!stalled && !snap.error) return 'ok';
  const recent = st.recoveries.filter((at) => now - at < RECOVER_WINDOW_MS);
  if (recent.length >= MAX_RECOVER) return 'give-up';
  return 'stalled';
}

export function noteRecovery(st, now) {
  st.recoveries = st.recoveries.filter((at) => now - at < RECOVER_WINDOW_MS);
  st.recoveries.push(now);
  st.lastAdvanceAt = now;    // 복구 직후 곧바로 또 정체로 찍지 않게 타이머를 새로 시작
  return st;
}

// ▶(에어팟/잠금화면/버튼) 직전 판정 — '재생 중' 이 아니어도 마지막 진행 뒤 오래 멈춰 있었고
// waiting 을 본 적이 있으면 파이프라인이 죽었을 가능성이 높다 → play() 전에 재로드가 안전하다.
export function shouldReloadBeforePlay(st, snap, now) {
  if (snap.error) return true;
  if (!st.waitingSince) return false;
  return (now - st.waitingSince) >= STALL_MS;
}
