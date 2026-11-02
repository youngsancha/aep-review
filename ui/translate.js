// 안정성 원칙: 절대 throw 하지 않는다(호출부에 오류가 새어나가지 않게). 실패/한도초과면 '' 반환 →
// 호출부가 조용히 번역행을 숨김(사용자에게 에러 메시지 X). 한도 초과(429) 감지 시 세션 동안
// 추가 요청을 멈춰 더 이상 실패가 누적되지 않게 한다. 세션 메모리 캐시(_TR_MEM)로 중복 호출 절감.
import { TRANSLATE_EMAIL } from '/config.js';

const _TR_MEM = new Map();
let _trQuotaHit = false;
let _lastIssue = '';   // 마지막 실패 사유: 'offline' | 'quota' | 'error' | ''

/** 왜 번역이 비었는지 — 호출부가 사용자에게 '조용한 무반응' 대신 이유를 보여줄 수 있게.
 *  (번역행을 그냥 숨기면 KR 토글이 고장난 것처럼 보인다 — 실제 사용자 신고 2026-07-27.) */
export function lastTrIssue() { return _lastIssue; }

export async function translateEnKo(text) {
  const key = (text || '').slice(0, 480);  // API 길이 제한 여유
  if (!key) return '';
  if (_TR_MEM.has(key)) { _lastIssue = ''; return _TR_MEM.get(key); }
  if (_trQuotaHit) { _lastIssue = 'quota'; return ''; }      // 한도 초과 후엔 조용히 빈 값
  const de = (TRANSLATE_EMAIL && TRANSLATE_EMAIL.indexOf('@') > 0) ? '&de=' + encodeURIComponent(TRANSLATE_EMAIL) : '';
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(key)}&langpair=en|ko${de}`;
  let j = null;
  // 무응답 요청이 번역행을 영원히 붙잡지 않게 ~4초 뒤 중단 → 아래 catch 의 실패 값('')으로 흐른다.
  const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const tm = ctl ? setTimeout(() => ctl.abort(), 4000) : null;
  try {
    const r = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
    if (r.status === 429) { _trQuotaHit = true; _lastIssue = 'quota'; return ''; }
    if (!r.ok) { _lastIssue = 'error'; return ''; }
    j = await r.json();
  } catch (e) {
    // 네트워크 오류 → 빈 값(throw 안 함). navigator.onLine 은 false 일 때만 믿는다:
    // true 여도 실제로는 끊겨 있을 수 있으므로(캡티브 포털·차량 이동 중 셀룰러 끊김).
    _lastIssue = (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'offline' : 'error';
    return '';
  } finally {
    if (tm) clearTimeout(tm);   // 429/오류 응답의 조기 return 도 타이머를 남기지 않는다
  }
  let ko = (j && j.responseData && j.responseData.translatedText) || '';
  const st = j && j.responseStatus;
  // 진짜 한도 응답만 세션 중단: responseStatus 429, 또는 MyMemory 가 번역문 자리에 넣는 경고문
  // ("MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS…" — 문장 맨 앞). 번역 '결과 텍스트'에
  // 우연히 INVALID/QUOTA 가 들어갔다고, 혹은 403(잘못된 de 이메일 등 한도와 무관)이라고 세션 전체를
  // 침묵시키지 않는다 — 403 은 이번 건만 실패 처리.
  if (st === 429 || st === '429' || /^\s*MYMEMORY WARNING/i.test(ko)) {
    _trQuotaHit = true; ko = '';
  } else if (st === 403 || st === '403') {
    ko = '';
  }
  if (ko) _TR_MEM.set(key, ko);  // 성공한 것만 캐시(빈 값은 캐시 안 함 → 한도 회복 후 재시도 가능)
  _lastIssue = ko ? '' : (_trQuotaHit ? 'quota' : 'error');
  return ko;
}
