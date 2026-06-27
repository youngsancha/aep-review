// proficiency.js 5축 수치화 단위검증 (node --test). 순수 모듈(브라우저 import·top-level localStorage
// 무접근)이라 정규식 추출 없이 직접 import. localStorage I/O 는 globalThis 에 페이크를 꽂아 검증.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = await import(pathToFileURL(join(ROOT, 'ui/proficiency.js')).href);  // Win: file:// URL 필요

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

// ─────────────────────────── CEFR 밴드 ───────────────────────────
test('cefrBand: 0 → 밴드 미달, 다음 A1', () => {
  const r = P.cefrBand(0);
  assert.equal(r.band, '—'); assert.equal(r.nextLabel, 'A1'); assert.equal(r.nextAt, 1000); assert.equal(r.toNext, 1000);
});
test('cefrBand: 5000 → B2, 다음 C1(8000), toNext 3000', () => {
  const r = P.cefrBand(5000);
  assert.equal(r.band, 'B2'); assert.equal(r.nextLabel, 'C1'); assert.equal(r.nextAt, 8000); assert.equal(r.toNext, 3000);
});
test('cefrBand: 최상단(20000) → C2, 다음 없음', () => {
  const r = P.cefrBand(20000);
  assert.equal(r.band, 'C2'); assert.equal(r.nextLabel, null); assert.equal(r.toNext, 0);
});

// ─────────────────────────── 목표 벡터 ───────────────────────────
test('bandTargets: C2 가 가장 공격적, 미지정은 C2 폴백', () => {
  assert.equal(P.bandTargets('C2').breadthFrac, 0.90);
  assert.ok(P.bandTargets('B2').listening < P.bandTargets('C2').listening);
  assert.ok(P.bandTargets('C2').latencyMs < P.bandTargets('B2').latencyMs);  // 빠를수록 ↑목표
  assert.deepEqual(P.bandTargets('???'), P.bandTargets('C2'));
});

// ─────────────────────────── raw 측정 (로그→축) ───────────────────────────
test('rawFromLog: breadthFrac=known/corpus, retention 전달', () => {
  const r = P.rawFromLog([], { known: 90, corpusTotal: 300, retentionFrac: 0.5 });
  approx(r.breadthFrac, 0.3); approx(r.retentionFrac, 0.5);
});
test('rawFromLog: listening 은 n 가중, unseen 있으면 unseen 우선', () => {
  const log = [
    { mode: 'dictation', score: 0.5, n: 10, unseen: false, ms: null },
    { mode: 'cloze', score: 1.0, n: 10, unseen: false, ms: null },
    { mode: 'listen', score: 0.8, n: 5, unseen: true, ms: 3000 },
  ];
  const r = P.rawFromLog(log, { corpusTotal: 100 });
  approx(r.listening, 0.8);          // unseen 표본만(0.8)
  approx(r.listeningUnseen, 0.8);
  approx(r.latencyMs, 3000);         // 단일 latency 의 중앙값
});
test('rawFromLog: unseen 없으면 전체 n 가중 평균', () => {
  const log = [
    { mode: 'dictation', score: 0.5, n: 10, unseen: false, ms: null },
    { mode: 'cloze', score: 1.0, n: 30, unseen: false, ms: null },
  ];
  const r = P.rawFromLog(log, { corpusTotal: 100 });
  approx(r.listening, (0.5 * 10 + 1.0 * 30) / 40);  // 0.875
  assert.equal(r.listeningUnseen, null);
});
test('rawFromLog: production 평균, latency 중앙값', () => {
  const log = [
    { mode: 'speak', score: 0.6, n: 1, ms: null },
    { mode: 'prod', score: 0.8, n: 1, ms: null },
    { mode: 'read', score: 1, n: 4, ms: 1000 },
    { mode: 'read', score: 1, n: 4, ms: 3000 },
    { mode: 'read', score: 1, n: 4, ms: 2000 },
  ];
  const r = P.rawFromLog(log, { corpusTotal: 100 });
  approx(r.production, 0.7);
  approx(r.latencyMs, 2000);  // [1000,2000,3000] 중앙값
});

// ─────────────────────────── 축 점수 (목표 대비 %) ───────────────────────────
test('axisScores: 목표 도달=100, 절반=50, 표본 없으면 null', () => {
  const raw = { breadthFrac: 0.9, retentionFrac: 0.375, listening: 0.46, production: 0, latencyMs: 4400, samples: { listen: 3, prod: 0, lat: 5 } };
  const s = P.axisScores(raw, P.bandTargets('C2'));
  assert.equal(s.breadth, 100);             // 0.9/0.9
  assert.equal(s.retention, 50);            // 0.375/0.75
  assert.equal(s.listening, 50);            // 0.46/0.92
  assert.equal(s.production, null);         // 표본 0
  assert.equal(s.automaticity, 50);         // 2200/4400
});
test('axisScores: 초과 달성은 100 으로 캡', () => {
  const raw = { breadthFrac: 2, retentionFrac: 1, listening: 1, production: 1, latencyMs: 500, samples: { listen: 1, prod: 1, lat: 1 } };
  const s = P.axisScores(raw, P.bandTargets('C2'));
  assert.equal(s.breadth, 100); assert.equal(s.automaticity, 100);
});

// ─────────────────────────── 종합 지수 ───────────────────────────
test('fluencyIndex: 측정된 축만 가중평균, null 제외', () => {
  assert.equal(P.fluencyIndex({ breadth: 100, retention: 100, listening: 100, production: 100, automaticity: 100 }), 100);
  // listening/production/automaticity 미측정 → breadth·retention 만(둘 다 50)
  assert.equal(P.fluencyIndex({ breadth: 50, retention: 50, listening: null, production: null, automaticity: null }), 50);
});
test('fluencyIndex: listening 가중(1.1) 반영', () => {
  // breadth 0, listening 100 (가중 1 vs 1.1) → 100*1.1/(1+1.1)=52.38→52
  assert.equal(P.fluencyIndex({ breadth: 0, retention: null, listening: 100, production: null, automaticity: null }), 52);
});

// ─────────────────────────── 약점 축 / 정확도 ───────────────────────────
test('weakestAxis: 최저 비-null 축', () => {
  assert.equal(P.weakestAxis({ breadth: 80, retention: 30, listening: 90, production: null, automaticity: 60 }), 'retention');
  assert.equal(P.weakestAxis({ breadth: null, retention: null, listening: null, production: null, automaticity: null }), null);
});
test('accuracyPct: ACC 모드만 n 가중(speak/prod 제외)', () => {
  const log = [
    { mode: 'read', score: 1.0, n: 10 },
    { mode: 'dictation', score: 0.0, n: 10 },
    { mode: 'speak', score: 0.5, n: 5 },   // 제외
  ];
  assert.equal(P.accuracyPct(log), 50);
  assert.equal(P.accuracyPct([]), null);
});

// ─────────────────────────── ISO 주차 ───────────────────────────
test('isoWeek: 형식 YYYY-Www', () => {
  assert.match(P.isoWeek(new Date('2026-06-27T00:00:00Z')), /^\d{4}-W\d{2}$/);
});

// ─────────────────────────── localStorage 로그 라운드트립 ───────────────────────────
function fakeLS() {
  const store = {};
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
}
test('recordMeasure/loadLog: 기록·복원, 잘못된 입력 무시', () => {
  globalThis.localStorage = fakeLS();
  P.recordMeasure('dictation', 0.8, 10, { unseen: true, ms: 1500 });
  P.recordMeasure('read', 5, 1);     // score>1 → 1 로 클램프
  P.recordMeasure('', 1, 1);          // mode 없음 → 무시
  P.recordMeasure('read', 1, 0);      // n=0 → 무시
  const log = P.loadLog();
  assert.equal(log.length, 2);
  assert.equal(log[0].mode, 'dictation'); assert.equal(log[0].unseen, true); assert.equal(log[0].ms, 1500);
  assert.equal(log[1].score, 1);
  delete globalThis.localStorage;
});
test('getTarget/setTarget: 기본 C2, 유효값만 저장', () => {
  globalThis.localStorage = fakeLS();
  assert.equal(P.getTarget(), 'C2');
  P.setTarget('B2'); assert.equal(P.getTarget(), 'B2');
  P.setTarget('ZZ'); assert.equal(P.getTarget(), 'B2');  // 무효 무시
  delete globalThis.localStorage;
});
