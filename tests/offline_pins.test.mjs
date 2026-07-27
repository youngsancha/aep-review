// 수동 오프라인 다운로드 '핀' 단위검증 (node --test).
// ui/offline-pins.js 는 순수 모듈(브라우저 import·top-level localStorage 접근 없음)이라 직접 import.
// 핵심 계약: 핀은 자동 프리페치 정리(최근 N개 밖 삭제)로부터 수동 다운로드를 보호한다 →
// 라운드트립·중복승격·상한·손상값 내성이 깨지면 사용자가 받아 둔 오디오가 조용히 사라진다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = await import(pathToFileURL(join(ROOT, 'ui/offline-pins.js')).href);

function fakeLS(seed = {}) {
  const store = { ...seed };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

test('빈 저장소 → 빈 배열', () => {
  globalThis.localStorage = fakeLS();
  assert.deepEqual(P.loadPins(), []);
  assert.equal(P.isPinned(7), false);
  delete globalThis.localStorage;
});

test('pin → 라운드트립, isPinned true', () => {
  globalThis.localStorage = fakeLS();
  P.pinEpisode(312);
  assert.deepEqual(P.loadPins(), [312]);
  assert.equal(P.isPinned(312), true);
  assert.equal(P.isPinned('312'), true, '문자열 id 도 같은 핀으로 인식');
  delete globalThis.localStorage;
});

test('중복 pin → 중복 없이 최신으로 승격', () => {
  globalThis.localStorage = fakeLS();
  P.pinEpisode(1); P.pinEpisode(2); P.pinEpisode(1);
  assert.deepEqual(P.loadPins(), [2, 1], '1 이 뒤로 이동하고 중복은 없다');
  delete globalThis.localStorage;
});

test('unpin → 제거, 없는 id unpin 은 무해', () => {
  globalThis.localStorage = fakeLS();
  P.pinEpisode(1); P.pinEpisode(2);
  assert.deepEqual(P.unpinEpisode(1), [2]);
  assert.deepEqual(P.unpinEpisode(99), [2], '미존재 id 는 그대로');
  assert.equal(P.isPinned(1), false);
  delete globalThis.localStorage;
});

test('PIN_LIMIT 초과 → 오래된 것부터 밀린다', () => {
  globalThis.localStorage = fakeLS();
  for (let i = 1; i <= P.PIN_LIMIT + 5; i++) P.pinEpisode(i);
  const pins = P.loadPins();
  assert.equal(pins.length, P.PIN_LIMIT);
  assert.equal(pins[0], 6, '가장 오래된 5개가 밀려남');
  assert.equal(pins[pins.length - 1], P.PIN_LIMIT + 5);
  delete globalThis.localStorage;
});

test('손상된 저장값 → 빈 배열로 폴백(throw 금지)', () => {
  globalThis.localStorage = fakeLS({ 'aep-offline-pins': '{not json' });
  assert.deepEqual(P.loadPins(), []);
  globalThis.localStorage = fakeLS({ 'aep-offline-pins': '{"a":1}' });
  assert.deepEqual(P.loadPins(), [], '배열이 아니면 무시');
  globalThis.localStorage = fakeLS({ 'aep-offline-pins': '[1,"x",3]' });
  assert.deepEqual(P.loadPins(), [1, 3], '숫자가 아닌 항목만 버린다');
  delete globalThis.localStorage;
});

test('localStorage 자체가 던져도 죽지 않는다(사파리 프라이빗 모드)', () => {
  globalThis.localStorage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceeded'); },
  };
  assert.deepEqual(P.loadPins(), []);
  assert.doesNotThrow(() => P.pinEpisode(1));
  delete globalThis.localStorage;
});
