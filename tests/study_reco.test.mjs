// AXIS_DRILL(축→드릴 모드) 매핑 단위 테스트 — study.js 의 오늘 세션 드릴 선택(pickDrills)과
// Practice 그리드 추천 배지(heroHtml 의 reco())가 이 상수 하나를 공유한다. 소스에서 그대로
// 추출해 실행하므로 복사본이 아니라 실제 값이 드리프트 없이 맞는지 검증한다
// (srs_streak.test.mjs 의 grabConst 기법과 동일 — 새 테이블을 여기서 다시 손으로 안 만든다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { weakestAxis } from '../ui/proficiency.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function grabConst(src, name) {
  const m = new RegExp(`^const ${name} = .*;`, 'm').exec(src);
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}

const studySrc = readFileSync(join(ROOT, 'ui/views/study.js'), 'utf8');
const AXIS_DRILL = new Function(grabConst(studySrc, 'AXIS_DRILL') + '\nreturn AXIS_DRILL;')();

test('AXIS_DRILL: listening/production/automaticity 세 축만 매핑한다(breadth/retention 은 Practice 모드가 없음)', () => {
  assert.deepEqual(Object.keys(AXIS_DRILL).sort(), ['automaticity', 'listening', 'production']);
});

test('AXIS_DRILL 값은 실제 드릴/버튼 모드 이름과 일치한다', () => {
  assert.equal(AXIS_DRILL.listening, 'dictation');
  assert.equal(AXIS_DRILL.production, 'convo');
  assert.equal(AXIS_DRILL.automaticity, 'read');
});

test('weakestAxis + AXIS_DRILL: listening 이 최약축이면 dictation 추천', () => {
  const scores = { breadth: 90, retention: 90, listening: 20, production: 80, automaticity: 80 };
  assert.equal(AXIS_DRILL[weakestAxis(scores)], 'dictation');
});

test('weakestAxis + AXIS_DRILL: production 이 최약축이면 convo 추천', () => {
  const scores = { breadth: 90, retention: 90, listening: 80, production: 10, automaticity: 80 };
  assert.equal(AXIS_DRILL[weakestAxis(scores)], 'convo');
});

test('weakestAxis + AXIS_DRILL: automaticity 가 최약축이면 read 추천', () => {
  const scores = { breadth: 90, retention: 90, listening: 80, production: 80, automaticity: 5 };
  assert.equal(AXIS_DRILL[weakestAxis(scores)], 'read');
});

test('weakestAxis + AXIS_DRILL: breadth/retention 이 최약축이면 매핑 없음(배지 안 뜸)', () => {
  const scores = { breadth: 10, retention: 90, listening: 80, production: 80, automaticity: 80 };
  assert.equal(AXIS_DRILL[weakestAxis(scores)], undefined);
});

test('weakestAxis + AXIS_DRILL: 미측정(scores 비어있음) → null → 매핑 없음(배지 안 뜸)', () => {
  assert.equal(weakestAxis({}), null);
  assert.equal(AXIS_DRILL[weakestAxis({})], undefined);
});
