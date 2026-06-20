// === EN→KO 문장 번역 (무료 MyMemory API) — episode.js(현재 문장 번역) + study.js(한→영 생산 드릴) 공용 ===
// 안정성 원칙: 절대 throw 하지 않는다(호출부에 오류가 새어나가지 않게). 실패/한도초과면 '' 반환 →
// 호출부가 조용히 번역행을 숨김(사용자에게 에러 메시지 X). 한도 초과(429) 감지 시 세션 동안
// 추가 요청을 멈춰 더 이상 실패가 누적되지 않게 한다. 세션 메모리 캐시(_TR_MEM)로 중복 호출 절감.
import { TRANSLATE_EMAIL } from '/config.js';

const _TR_MEM = new Map();
let _trQuotaHit = false;

export async function translateEnKo(text) {
  const key = (text || '').slice(0, 480);  // API 길이 제한 여유
  if (!key) return '';
  if (_TR_MEM.has(key)) return _TR_MEM.get(key);
  if (_trQuotaHit) return '';      // 한도 초과 후엔 조용히 빈 값
  const de = (TRANSLATE_EMAIL && TRANSLATE_EMAIL.indexOf('@') > 0) ? '&de=' + encodeURIComponent(TRANSLATE_EMAIL) : '';
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(key)}&langpair=en|ko${de}`;
  let j = null;
  try {
    const r = await fetch(url);
    if (r.status === 429) { _trQuotaHit = true; return ''; }
    if (!r.ok) return '';
    j = await r.json();
  } catch (e) {
    return '';  // 네트워크 오류 → 조용히 빈 값
  }
  let ko = (j && j.responseData && j.responseData.translatedText) || '';
  const st = j && j.responseStatus;
  // 한도/경고/오류 응답은 빈 값으로 처리하고 이후 요청 중단
  if (/MYMEMORY WARNING|YOU USED ALL|QUOTA|INVALID/i.test(ko) || st === 403 || st === '403' || st === 429 || st === '429') {
    _trQuotaHit = true; ko = '';
  }
  if (ko) _TR_MEM.set(key, ko);  // 성공한 것만 캐시(빈 값은 캐시 안 함 → 한도 회복 후 재시도 가능)
  return ko;
}
