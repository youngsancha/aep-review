// convo.js — 회화 턴 채점/프롬프트의 순수 로직 회귀 고정.
// 핵심 계약 세 가지를 못 박는다:
//   ① '표현을 썼는가' 는 완전일치가 아니라 굴절·분리를 허용해야 한다(구동사).
//   ② 못 잰 성분은 점수를 깎으면 안 된다(재정규화) — 단, 침묵은 0점이어야 한다.
//   ③ 같은 카드는 늘 같은 질문을 받아야 한다(안정 해시).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normTokens, stem, usedExpression, countFillers, scoreTurn, turnTips,
  buildTurn, hashKey, endStop, ASK_TEMPLATES, WEIGHTS, MIN_WORDS, GOOD_WORDS, FAST_MS, SLOW_MS, WPM_LO, WPM_HI,
} from '../ui/convo.js';

test('normTokens: 문장부호를 털고 축약은 남긴다', () => {
  assert.deepEqual(normTokens("I'll hold off, really!"), ["i'll", 'hold', 'off', 'really']);
  assert.deepEqual(normTokens('well-known'), ['well', 'known']);
  assert.deepEqual(normTokens('  '), []);
  assert.deepEqual(normTokens(null), []);
  assert.deepEqual(normTokens('It’s fine'), ["it's", 'fine']);   // 곡선 어포스트로피
});

test('stem: 짧은 단어와 -ss/-us/-is 는 건드리지 않는다', () => {
  assert.equal(stem('off'), 'off');
  assert.equal(stem('miss'), 'miss');
  assert.equal(stem('bus'), 'bus');
  assert.equal(stem('takes'), 'take');
  assert.equal(stem('boxes'), 'box');
  assert.equal(stem('holding'), 'hold');
  assert.equal(stem('worked'), 'work');
  assert.equal(stem('studies'), 'study');
});

test('usedExpression: 구동사의 분리 목적어를 허용한다', () => {
  assert.equal(usedExpression("I'll hold it off until Monday", 'hold off'), true);
  assert.equal(usedExpression('We are holding off the launch', 'hold off'), true);
  assert.equal(usedExpression('hold off', 'hold off'), true);
});

test('usedExpression: 멀리 떨어진 우연한 일치는 사용으로 치지 않는다', () => {
  // "hold" 와 "off" 가 둘 다 있지만 한 표현으로 쓰인 게 아니다(간격 > USE_GAP).
  assert.equal(usedExpression('Hold on a second and then turn the lights off', 'hold off'), false);
  assert.equal(usedExpression('I have no idea', 'hold off'), false);
  assert.equal(usedExpression('', 'hold off'), false);
  assert.equal(usedExpression('anything', ''), false);
});

test('countFillers: um/uh 를 세고 일반 단어는 세지 않는다', () => {
  assert.equal(countFillers('um I think uh maybe'), 2);
  assert.equal(countFillers('I like this'), 0);          // 담화표지 like 단독은 세지 않음
  assert.equal(countFillers('uh like I mean'), 2);       // 군말 뒤의 like 만
  assert.equal(countFillers(''), 0);
});

test('scoreTurn: 침묵은 0점 — 재정규화가 점수를 만들어내면 안 된다', () => {
  const r = scoreTurn({ said: '', term: 'hold off', latencyMs: 1000, speakMs: 2000 });
  assert.equal(r.score, 0);
  assert.equal(r.words, 0);
  assert.equal(r.used, false);
  assert.deepEqual(r.tips, ['마이크를 켜고 한 문장이라도 소리 내어 답해보세요.']);
});

test('scoreTurn: 표현을 쓴 충분한 길이의 빠른 턴은 고득점', () => {
  const said = 'I had to hold off on buying a new laptop until my bonus arrived last month';
  const r = scoreTurn({ said, term: 'hold off', latencyMs: 1200, speakMs: 7000 });
  assert.equal(r.used, true);
  assert.equal(r.words, 16);
  assert.ok(r.score > 0.9, `expected >0.9, got ${r.score}`);
  assert.ok(r.wpm > 0);
});

test('scoreTurn: 표현을 안 쓰면 가중치만큼 정확히 깎인다', () => {
  const said = 'I waited a little longer before buying a new laptop last month okay';
  const withOut = scoreTurn({ said, term: 'hold off', latencyMs: 1200, speakMs: 5000 });
  const withIn = scoreTurn({ said: 'I decided to hold off on a new laptop last month for sure', term: 'hold off', latencyMs: 1200, speakMs: 5000 });
  assert.equal(withOut.used, false);
  assert.equal(withIn.used, true);
  assert.ok(withIn.score - withOut.score > 0.3, `used 가 ${WEIGHTS.used} 만큼은 벌어져야 한다`);
  assert.ok(withOut.tips.some((t) => t.includes('hold off')));
});

test('scoreTurn: 타이밍을 못 재도 상한이 깎이지 않는다(재정규화)', () => {
  const said = 'I had to hold off on buying a new laptop until my bonus arrived last month';
  const timed = scoreTurn({ said, term: 'hold off', latencyMs: FAST_MS, speakMs: 7000 });
  const untimed = scoreTurn({ said, term: 'hold off', latencyMs: null, speakMs: null });
  assert.equal(untimed.wpm, null);
  assert.equal(untimed.parts.latency, undefined);
  assert.ok(untimed.score >= 0.99, `타이밍 없이도 만점 가능해야 한다 — got ${untimed.score}`);
  assert.ok(timed.score >= 0.99);
});

test('scoreTurn: 짧은 발화 구간은 wpm 을 만들어내지 않는다', () => {
  const r = scoreTurn({ said: 'yes I did', term: '', latencyMs: 900, speakMs: 300 });
  assert.equal(r.wpm, null);                 // 700ms 미만 → 신뢰 불가
  assert.ok(r.parts.fluency != null);        // 군말만으로는 여전히 잰다
});

test('scoreTurn: 느린 시작은 latency 성분을 0 으로 만든다', () => {
  const said = 'I had to hold off on buying a new laptop until my bonus arrived last month';
  const slow = scoreTurn({ said, term: 'hold off', latencyMs: SLOW_MS + 1000, speakMs: 7000 });
  assert.equal(slow.parts.latency, 0);
  assert.ok(slow.tips.some((t) => t.includes('3초')));
});

test('scoreTurn: 점수는 항상 0..1', () => {
  const cases = [
    { said: 'um uh um uh um uh um uh', term: 'hold off', latencyMs: 20000, speakMs: 900 },
    { said: 'a '.repeat(200), term: 'hold off', latencyMs: 1, speakMs: 700 },
    { said: 'hold off', term: 'hold off', latencyMs: -5, speakMs: -5 },
  ];
  for (const c of cases) {
    const r = scoreTurn(c);
    assert.ok(r.score >= 0 && r.score <= 1, `${r.score} out of range for ${JSON.stringify(c)}`);
  }
});

test('scoreTurn: 인자 없이 불러도 던지지 않는다', () => {
  const r = scoreTurn();
  assert.equal(r.score, 0);
});

test('turnTips: 최대 2개, 잘한 턴에도 다음 할 일을 준다', () => {
  const good = turnTips({ used: true, term: 'hold off', words: GOOD_WORDS, wpm: 130, latencyMs: 1000, fillerRatio: 0 });
  assert.equal(good.length, 1);
  const bad = turnTips({ used: false, term: 'hold off', words: 2, wpm: 40, latencyMs: 9000, fillerRatio: 0.5 });
  assert.equal(bad.length, 2);
  assert.ok(MIN_WORDS < GOOD_WORDS && WPM_LO < WPM_HI);
});

test('buildTurn: 같은 카드는 늘 같은 턴을 준다', () => {
  const card = { term: 'hold off', example_sentence: 'We decided to hold off on the announcement.', example_ko: '발표를 미루기로 했어요.' };
  const a = buildTurn(card), b = buildTurn(card);
  assert.deepEqual(a, b);
  assert.equal(a.term, 'hold off');
  assert.ok(a.partner && a.instruction);
});

test('buildTurn: 예문이 없으면 열린 질문으로 떨어진다', () => {
  const t = buildTurn({ term: 'under the weather' });
  assert.equal(t.kind, 'ask');
  assert.ok(t.partner.includes('under the weather'));
  assert.ok(t.partnerKo);
  // 표현은 반드시 따옴표 안에 '인용'된다 — 문법적으로 끼워 넣으면 문장이 깨진다.
  assert.ok(t.partner.includes('"under the weather"'));
});

test('buildTurn: 두 종류가 모두 나온다(코퍼스 다양성)', () => {
  const kinds = new Set();
  for (let i = 0; i < 40; i++) {
    kinds.add(buildTurn({ term: 'term' + i, example_sentence: 'Example sentence number ' + i + '.' }).kind);
  }
  assert.deepEqual([...kinds].sort(), ['ask', 'reply']);
});

test('buildTurn: 빈 카드에도 던지지 않는다', () => {
  const t = buildTurn();
  assert.ok(t.partner);
  assert.equal(t.term, '');
});

test('hashKey: 결정적이고 음수가 아니다', () => {
  assert.equal(hashKey('abc'), hashKey('abc'));
  assert.notEqual(hashKey('abc'), hashKey('abd'));
  assert.ok(hashKey('') >= 0);
  assert.ok(hashKey('a'.repeat(500)) >= 0);
});

// 실제 코퍼스가 잡아낸 결함: Essentials 256장 중 다수가 문장부호로 끝나는 표현이다
// ("What's up?" · "My bad.") — 템플릿이 마침표를 겹쳐 붙이면 화면과 TTS 양쪽에서 `"My bad.".` 이 된다.
test('ASK_TEMPLATES: 문장부호로 끝나는 표현에 마침표를 겹쳐 붙이지 않는다', () => {
  assert.equal(endStop("What's up?"), '');
  assert.equal(endStop('My bad.'), '');
  assert.equal(endStop('hold off'), '.');
  for (const term of ["What's up?", 'My bad.', 'It is what it is.', 'hold off']) {
    for (const tpl of ASK_TEMPLATES) {
      const q = tpl.en(term);
      assert.ok(!/["'][.?!]{1}\.|\.\.(?!\.)/.test(q), `겹친 마침표: ${q}`);
      assert.ok(!q.includes('".".') && !q.includes('?".'), `겹친 마침표: ${q}`);
    }
  }
});

// 한국어 조사(을/를)는 앞 음절의 받침으로 정해진다 — 영어 표현 뒤에는 규칙이 성립하지 않으므로
// 지시문이 조사에 기대면 안 된다.
test('buildTurn: 지시문이 영어 표현 뒤 한국어 조사에 기대지 않는다', () => {
  for (const term of ['hold off', 'call it a day', "What's up?"]) {
    const t = buildTurn({ term, example_sentence: 'We should call it a day.' });
    assert.ok(!/[”"]\s*(을|를|은|는|이|가)\s/.test(t.instruction), `조사 의존: ${t.instruction}`);
  }
});

// 실제 코퍼스가 잡아낸 두 번째 결함: reply 모드의 상대 발화는 대개 목표 표현을 이미 포함한다.
// 지시문은 그 사실을 숨기지 말아야 한다(숨기면 '힌트 없는 산출'로 오인된다).
test('buildTurn: 상대가 표현을 먼저 쓰는 턴은 그렇다고 말한다', () => {
  // kind 는 안정 해시로 정해지므로 '되받는 턴'과 '안 되받는 턴'이 각각 나오는 카드를 찾아 검증한다.
  const findKind = (make) => {
    for (let i = 0; i < 50; i++) { const t = buildTurn(make(i)); if (t.kind === 'reply') return t; }
    throw new Error('reply 턴을 못 찾았다');
  };
  const echo = findKind((i) => ({ term: 'no worries' + (i ? ' ' + i : ''), example_sentence: `Sorry I'm late${i}! — No worries${i ? ' ' + i : ''}, we just started.` }));
  assert.equal(echo.echoes, true);
  assert.ok(echo.instruction.includes('되받아'), echo.instruction);

  const noEcho = findKind((i) => ({ term: 'ballpark figure', example_sentence: `Could you give me a rough number by Friday? (${i})` }));
  assert.equal(noEcho.echoes, false);
  assert.ok(!noEcho.instruction.includes('되받아'), noEcho.instruction);
  assert.ok(noEcho.instruction.includes('ballpark figure'));
});
