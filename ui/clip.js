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

// url: 정제된 CDN mp3, start/end: 초. btn: 재생중 표시할 버튼(선택). rate: 재생속도. loop: 끝에서
// 처음으로 되감아 무한 반복(드릴 자동반복용). 다음 카드/정지 시 stopClip 으로 종료.
// onError: 클립(R2/CDN) 로드·재생 실패 시 호출 — 호출부가 speak() TTS 로 캐스케이드(무음 방지, AUDIT I2).
//   clip.js 는 tts.js 를 import 하지 않고 콜백만 받아 결합도를 낮춘다.
export function playSentenceClip(url, start, end, btn, rate, loop, minDur, onError) {
  if (!url) return;
  const toggleOff = (_btn === btn && _clip && btn);  // 같은 버튼 재탭 → 정지(버튼 없으면 토글 안 함)
  stopClip();
  if (toggleOff) return;
  try { player.pause(); } catch (e) {}        // 전역 에피소드 재생은 멈추고 '문장만'
  // 시작 앞 여유(lead-in): whisper 문장 시작 타임스탬프가 첫 단어 onset 보다 살짝 늦게 찍혀
  // 첫 단어(주어)가 잘리던 문제 — 특히 무한반복 시 매 루프 첫부분이 잘려 안 들리던 버그. 끝(minDur)과
  // 대칭으로 시작도 보호한다. go()·atEnd(루프 재seek) 둘 다 이 s 를 써서 첫 재생·반복이 함께 고쳐진다.
  const LEAD_IN = 0.3;
  const s = Math.max(0, (Number(start) || 0) - LEAD_IN);
  let e = (Number.isFinite(+end) && +end > s) ? +end : s + 14;  // end 없으면 14s 캡
  // 최소 재생길이 바닥(minDur): whisper 가 단어 타임스탬프를 짧게 욱여넣어(예: 7단어 0.9s) 매핑은
  // 옳아도 클립이 말 도중 끊기는 경우 — 단어수 기준 보수적 발화속도(~0.33s/단어)로 끝을 늘린다.
  // '늘리기만' 하므로 정상 매핑(이미 충분히 긴) 클립은 불변. 과확장 방지 위해 +6s 한도.
  if (minDur && minDur > 0 && (e - s) < minDur) e = s + Math.min(minDur, (e - s) + 6);
  const a = new Audio(url);
  a.preload = 'auto';
  if (rate && rate > 0) a.playbackRate = rate;  // currentTime 은 미디어시각이라 종료판정엔 영향 없음
  _clip = a; _btn = btn || null;
  if (btn) btn.classList.add('ctx-playing');
  const go = () => { try { a.currentTime = s; } catch (_) {} if (rate && rate > 0) a.playbackRate = rate; a.play().catch(() => {}); };
  if (a.readyState >= 1) go();
  else a.addEventListener('loadedmetadata', go, { once: true });
  const atEnd = () => { if (loop) { try { a.currentTime = s; } catch (_) {} a.play().catch(() => {}); } else stopClip(); };
  a.ontimeupdate = () => { if (a.currentTime >= e) atEnd(); };  // 문장 끝 → 반복 or 정지
  a.onended = atEnd;
  a.onerror = () => { stopClip(); if (typeof onError === 'function') onError(); };  // 클립 실패 → 호출부 TTS 폴백
}

// 다른 화면으로 이동하면 즉시 정지 — 모듈 로드 시 1회만 등록(누적 없음).
window.addEventListener('hashchange', stopClip);
