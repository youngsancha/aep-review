// 핵심 클라이언트 로직 단위 테스트 (node --test, 빌드툴 없음) — 회귀 위험 큰 순수 로직만.
//   ① SM-2 간격/ease 계산 (ui/db.js::sm2)
//   ② 데일리 스트릭 경계: 자정·연속성 끊김·타임존/DST (ui/views/study.js::getStreak/_dayKey)
// 복사 드리프트 방지: 실제 소스에서 함수를 추출해 실행(resegment_parity.mjs 와 동일 기법).
// 시간→문장 인덱스 매핑(findActiveSentIdx)은 renderEpisode 클로저라 순수 추출 불가 →
// 통합 검증(scripts/_pwtest_async.py 의 seek→active 어서션)이 실제 코드 경로를 커버한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 소스에서 함수 추출 ──
function grabConst(src, name) {
  const m = new RegExp(`^const ${name} = .*;`, 'm').exec(src);
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}
function grabFn(src, name) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error('fn not found: ' + name);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, '') === '}') { end = i; break; }
  }
  if (end < 0) throw new Error('fn end not found: ' + name);
  return lines.slice(start, end + 1).join('\n');
}

const dbSrc = readFileSync(join(ROOT, 'ui/db.js'), 'utf8');
const sm2 = new Function(grabConst(dbSrc, 'GRADE_TO_Q') + '\n' + grabFn(dbSrc, 'sm2') + '\nreturn sm2;')();

const studySrc = readFileSync(join(ROOT, 'ui/views/study.js'), 'utf8');
const STREAK_BODY = grabConst(studySrc, '_dayKey') + '\n' + grabFn(studySrc, 'getStreak') + '\nreturn { getStreak, _dayKey };';
function makeStreak(ls) { return new Function('localStorage', STREAK_BODY)(ls); }
function fakeLS(obj) {
  const store = { ...obj };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
const { _dayKey } = makeStreak(fakeLS({}));
const keyFor = (off) => { const d = new Date(); d.setDate(d.getDate() - off); return _dayKey(d); };
const streakOf = (days) => makeStreak(fakeLS({ 'aep-study-days': JSON.stringify(days) })).getStreak();

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

// ─────────────────────────── SM-2 ───────────────────────────
test('SM-2: again(q<3) → ease-0.2, interval 1, reps 0', () => {
  const r = sm2(2.5, 10, 3, 'again');
  approx(r.ease, 2.3); assert.equal(r.interval, 1); assert.equal(r.reps, 0);
});

test('SM-2: again 은 ease 를 1.3 아래로 못 내린다(바닥)', () => {
  approx(sm2(1.4, 10, 3, 'again').ease, 1.3);
  approx(sm2(1.3, 10, 3, 'again').ease, 1.3);
});

test('SM-2: good 1차→interval 1, 2차→6, 3차→round(interval*ease)', () => {
  const r1 = sm2(2.5, 0, 0, 'good');
  assert.equal(r1.interval, 1); assert.equal(r1.reps, 1); approx(r1.ease, 2.5);
  const r2 = sm2(2.5, 1, 1, 'good');
  assert.equal(r2.interval, 6); assert.equal(r2.reps, 2); approx(r2.ease, 2.5);
  const r3 = sm2(2.5, 6, 2, 'good');
  assert.equal(r3.interval, 15); assert.equal(r3.reps, 3); approx(r3.ease, 2.5);  // round(6*2.5)=15
});

test('SM-2: easy(q=5) 는 ease +0.1, hard(q=3) 는 ease -0.14', () => {
  approx(sm2(2.5, 6, 2, 'easy').ease, 2.6);
  approx(sm2(2.5, 6, 2, 'hard').ease, 2.36);
  // hard 도 q>=3 이라 reps/interval 은 전진
  const h = sm2(2.5, 6, 2, 'hard');
  assert.equal(h.reps, 3); assert.equal(h.interval, 15);
});

test('SM-2: 반복 hard 로 ease 가 1.3 바닥에 수렴', () => {
  let ease = 2.5;
  for (let i = 0; i < 30; i++) ease = sm2(ease, 6, 2, 'hard').ease;
  approx(ease, 1.3);
});

// ─────────────────────────── 데일리 스트릭 ───────────────────────────
test('streak: 빈 기록 → 0', () => assert.equal(streakOf([]), 0));

test('streak: 오늘만 → 1', () => assert.equal(streakOf([keyFor(0)]), 1));

test('streak: 오늘·어제·그제 연속 → 3', () => {
  assert.equal(streakOf([keyFor(0), keyFor(1), keyFor(2)]), 3);
});

test('streak: 오늘 없고 어제만 → 1 (어제부터 카운트, 자정 직후 보호)', () => {
  assert.equal(streakOf([keyFor(1)]), 1);
});

test('streak: 어제 비어 끊김(오늘·그제) → 1', () => {
  assert.equal(streakOf([keyFor(0), keyFor(2)]), 1);
});

test('streak: 오늘·어제 모두 없음(그제·그그제) → 0', () => {
  assert.equal(streakOf([keyFor(3), keyFor(4)]), 0);
});

test('streak: 타임존/DST — 400일 후진이 중복·누락 없이 모두 고유·연속', () => {
  const keys = [];
  for (let off = 0; off <= 400; off++) keys.push(keyFor(off));
  // _dayKey 가 로컬 Y-M-D 라, setDate(-1) 400회는 DST 경계를 넘어도 401개 '서로 다른' 날이어야 한다.
  assert.equal(new Set(keys).size, 401, 'DST 경계에서 같은 키가 두 번 나오면 안 됨');
  assert.equal(streakOf(keys), 401);  // 월/연 경계 다수 포함 연속 카운트
});
