// 수동 오프라인 다운로드 '핀' — 회차 화면의 ⬇ 버튼으로 직접 받은 회차 id 목록.
//
// 왜 필요한가: ensureOfflineCache() 는 마지막에 '자동 대상(최근 N개)' 밖의 오디오를 지운다.
// 핀이 없으면 사용자가 손수 받아 둔 회차가 다음 부팅 때 조용히 사라진다(무신호 통근길에 낭패).
// 그래서 정리 루프가 이 목록을 보존 대상에 포함시킨다.
//
// 순수 모듈(브라우저 전용 import 없음) — node --test 에서 그대로 import 하고
// globalThis.localStorage 페이크로 검증한다(proficiency.js 와 동일 패턴).

const PIN_KEY = 'aep-offline-pins';
// 사용자가 계속 핀을 찍어도 저장 용량이 무한 증가하지 않도록 상한. 넘치면 가장 오래된 것부터 밀린다
// (오디오 자체는 정리 루프가 회수). 통근 청취 패턴상 수십 개면 충분하다.
export const PIN_LIMIT = 50;

/** 저장된 핀 id 배열(핀 찍은 순서, 오래된 것 먼저). 손상된 값은 빈 배열로 취급. */
export function loadPins() {
  try {
    const raw = JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(Number).filter(Number.isFinite);
  } catch (e) { return []; }
}

/** 상한을 적용해 저장하고, 실제 저장된 배열을 돌려준다. */
export function savePins(ids) {
  const trimmed = ids.slice(-PIN_LIMIT);
  try { localStorage.setItem(PIN_KEY, JSON.stringify(trimmed)); } catch (e) {}
  return trimmed;
}

/** id 를 핀에 추가(중복이면 최신으로 승격). 저장된 배열 반환. */
export function pinEpisode(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return loadPins();
  return savePins([...loadPins().filter((x) => x !== n), n]);
}

/** id 를 핀에서 제거. 저장된 배열 반환. */
export function unpinEpisode(id) {
  const n = Number(id);
  return savePins(loadPins().filter((x) => x !== n));
}

/** 핀 여부. */
export function isPinned(id) {
  const n = Number(id);
  return loadPins().includes(n);
}
