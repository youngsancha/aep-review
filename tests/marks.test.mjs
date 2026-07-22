// 운전 캡처(marks.js) 순수 헬퍼 단위검증 (node --test).
// marks.js 는 media-session.js 처럼 top-level import/DOM 이 없어 node 에서 직접 import 가능 —
// 브라우저 배선(initDriveCapture/addMark)은 scripts/_pwtest.py 하니스가 실제 DOM 으로 커버한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushMark, groupRuns, sentencesAround } from '../ui/marks.js';

test('pushMark: 연타(4초 안 같은 회차)는 흡수, 다른 시각/회차는 추가', () => {
  const m1 = { k: '1:100', ep: 1, t: 100, at: 1 };
  let r = pushMark([], m1);
  assert.equal(r.added, true);
  assert.equal(r.list.length, 1);

  // 2.5초 뒤 연타 → dedupe(핸들 버튼 더블탭 보호)
  r = pushMark(r.list, { k: '1:103', ep: 1, t: 102.5, at: 2 });
  assert.equal(r.added, false);
  assert.equal(r.list.length, 1);

  // 같은 시각이라도 다른 회차면 별개 마크
  r = pushMark(r.list, { k: '2:100', ep: 2, t: 100, at: 3 });
  assert.equal(r.added, true);
  assert.equal(r.list.length, 2);

  // 같은 회차, 4초 이상 떨어지면 별개 마크
  r = pushMark(r.list, { k: '1:110', ep: 1, t: 110, at: 4 });
  assert.equal(r.added, true);
  assert.equal(r.list.length, 3);
});

test('pushMark: FIFO 상한(100) — 초과 시 가장 오래된 것부터 버린다', () => {
  let list = [];
  for (let i = 0; i < 120; i++) {
    list = pushMark(list, { k: `1:${i * 10}`, ep: 1, t: i * 10, at: i }).list;
  }
  assert.equal(list.length, 100);
  assert.equal(list[0].t, 200);          // 앞의 20개(0~190)가 밀려남
  assert.equal(list[99].t, 1190);
});

test('groupRuns: 인접 선택은 하나의 run(구), 떨어진 선택은 분리', () => {
  assert.deepEqual(groupRuns([]), []);
  assert.deepEqual(groupRuns([3]), [[3]]);
  assert.deepEqual(groupRuns([5, 3, 4, 9]), [[3, 4, 5], [9]]);   // 정렬 후 병합
  assert.deepEqual(groupRuns([1, 3, 5]), [[1], [3], [5]]);
});

test('sentencesAround: t 주변 단어를 구두점/큰 쉼 경계로 문장 묶음', () => {
  const segments = [
    { start: 0, end: 6, text: 'Hello there. Big gap follows',
      words: [
        { word: 'Hello', start: 0.0, end: 0.4 },
        { word: 'there.', start: 0.5, end: 0.9 },      // 종결 구두점 → 문장 경계
        { word: 'Big', start: 1.1, end: 1.4 },
        { word: 'gap', start: 1.5, end: 1.9 },
        { word: 'follows', start: 4.0, end: 4.4 },     // 1.9→4.0 큰 쉼(>0.8s) → 경계
      ] },
  ];
  const sents = sentencesAround(segments, 2.0, 9, 3);
  assert.equal(sents.length, 3);
  assert.equal(sents[0].text, 'Hello there.');
  assert.equal(sents[1].text, 'Big gap');
  assert.equal(sents[2].text, 'follows');
  // 시각 보존 — 예문 클립 재생(start/end)에 그대로 쓰인다
  assert.equal(sents[0].start, 0.0);
  assert.equal(sents[0].end, 0.9);
  // 윈도 밖 단어는 제외: t=2.0, after=3 → start 5.0 초과 단어는 안 들어옴 (여기선 전부 포함 범위)
  const narrow = sentencesAround(segments, 0.5, 0.6, 0.5);
  assert.deepEqual(narrow.map((s) => s.text), ['Hello there.']);
});
