// 인라인 '맥락에서 듣기' — 에피소드의 실제 음성에서 '그 문장 구간만' 재생(화면 전환 없이).
// Study/SRS 공용. 전역 에피소드 플레이어(player.js)와는 독립된 Audio 로, 딱 그 문장만 듣고 멈춘다.
// 같은 버튼을 다시 누르면 토글로 정지. 다른 화면(탭)으로 이동하면 즉시 정지.
import { player } from '/player.js';

let _clip = null;
let _btn = null;

export function stopClip() {
  if (_clip) {
    try { _clip.pause(); } catch (e) {}
    _clip.ontimeupdate = _clip.onended = _clip.onerror = null;
    _clip = null;
  }
  if (_btn) { _btn.classList.remove('ctx-playing'); _btn = null; }
}

// url: 정제된 CDN mp3, start/end: 초. btn: 재생중 표시할 버튼(선택). rate: 재생속도(받아쓰기 천천히 등).
export function playSentenceClip(url, start, end, btn, rate) {
  if (!url) return;
  const toggleOff = (_btn === btn && _clip && btn);  // 같은 버튼 재탭 → 정지(버튼 없으면 토글 안 함)
  stopClip();
  if (toggleOff) return;
  try { player.pause(); } catch (e) {}        // 전역 에피소드 재생은 멈추고 '문장만'
  const s = Math.max(0, Number(start) || 0);
  const e = (Number.isFinite(+end) && +end > s) ? +end : s + 14;  // end 없으면 14s 캡
  const a = new Audio(url);
  a.preload = 'auto';
  if (rate && rate > 0) a.playbackRate = rate;  // currentTime 은 미디어시각이라 종료판정엔 영향 없음
  _clip = a; _btn = btn || null;
  if (btn) btn.classList.add('ctx-playing');
  const go = () => { try { a.currentTime = s; } catch (_) {} if (rate && rate > 0) a.playbackRate = rate; a.play().catch(() => {}); };
  if (a.readyState >= 1) go();
  else a.addEventListener('loadedmetadata', go, { once: true });
  a.ontimeupdate = () => { if (a.currentTime >= e) stopClip(); };  // 문장 끝에서 정지
  a.onended = stopClip;
  a.onerror = stopClip;
}

// 다른 화면으로 이동하면 즉시 정지 — 모듈 로드 시 1회만 등록(누적 없음).
window.addEventListener('hashchange', stopClip);
