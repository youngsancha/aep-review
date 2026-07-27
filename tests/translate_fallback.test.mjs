// graceful fallback 체인 #1(번역) 계약 회귀 테스트 (node --test) — BACKLOG 3 보강(additive).
// ui/translate.js::translateEnKo 의 불변식을 고정한다:
//   ① 절대 throw 안 함(네트워크 오류·비정상 응답에도) → 호출부가 조용히 번역행 숨김.
//   ② 429/403/쿼터경고 감지 시 세션 내 추가 요청 중단(_trQuotaHit 래치) → 실패 누적 방지.
//   ③ 성공분만 메모리 캐시(빈 값 캐시 X → 한도 회복 후 재시도 가능).
// 실제 소스에서 함수를 추출해 fetch 를 주입(런타임 코드 변경 없음). 폴백 '순서'는 손대지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'ui/translate.js'), 'utf8');

function grabLine(re) {
  const m = re.exec(SRC);
  if (!m) throw new Error('line not found: ' + re);
  return m[0];
}
function grabFn(name) {
  const lines = SRC.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(`function ${name}(`));
  if (start < 0) throw new Error('fn not found: ' + name);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, '') === '}') { end = i; break; }
  }
  return lines.slice(start, end + 1).join('\n').replace(/^export\s+/, '');
}

const BODY =
  '"use strict";\n' +       // 선언 안 된 모듈 변수를 빠뜨리면 조용한 암묵적 전역이 되지 않게
  grabLine(/^const _TR_MEM = .*;/m) + '\n' +
  grabLine(/^let _trQuotaHit = .*;/m) + '\n' +
  grabLine(/^let _lastIssue = .*;/m) + '\n' +
  // 한 줄 함수라 grabFn(닫는 '}' 만 있는 줄을 찾는다)으로는 못 잡는다 — 줄째로 가져온다.
  grabLine(/^export function lastTrIssue\(\).*$/m).replace(/^export\s+/, '') + '\n' +
  grabFn('translateEnKo') + '\n' +
  'return { translateEnKo, lastTrIssue };';

// 새 인스턴스마다 모듈 상태(_TR_MEM/_trQuotaHit/_lastIssue) 격리 → 시나리오 독립.
function makeMod(fetchStub, email = '') {
  return new Function('fetch', 'TRANSLATE_EMAIL', BODY)(fetchStub, email);
}
function makeFn(fetchStub, email = '') {
  return makeMod(fetchStub, email).translateEnKo;
}
// 응답 디스크립터: {status, ok?, body} 또는 {throw:true}. 호출수는 stub.count.
function stubFetch(...responses) {
  const f = async () => {
    const r = responses[Math.min(f.count, responses.length - 1)];
    f.count++;
    if (r.throw) throw new Error('network down');
    return { status: r.status ?? 200, ok: r.ok ?? ((r.status ?? 200) < 400), json: async () => r.body };
  };
  f.count = 0;
  return f;
}
const okBody = (txt, st = 200) => ({ status: 200, body: { responseData: { translatedText: txt }, responseStatus: st } });

test('빈 입력 → 즉시 "" (fetch 호출 안 함)', async () => {
  const f = stubFetch(okBody('X'));
  assert.equal(await makeFn(f)(''), '');
  assert.equal(f.count, 0);
});

test('성공 → 번역 반환 + 동일 텍스트는 캐시(추가 fetch 없음)', async () => {
  const f = stubFetch(okBody('안녕하세요'));
  const tr = makeFn(f);
  assert.equal(await tr('hello'), '안녕하세요');
  assert.equal(await tr('hello'), '안녕하세요');  // 캐시 적중
  assert.equal(f.count, 1);
});

test('429 → "" 반환 + 쿼터 래치(이후 다른 텍스트도 fetch 없이 "")', async () => {
  const f = stubFetch({ status: 429 });
  const tr = makeFn(f);
  assert.equal(await tr('a'), '');
  assert.equal(await tr('b'), '');   // 래치되어 호출 안 함
  assert.equal(f.count, 1);
});

test('쿼터 경고 텍스트 → "" + 래치', async () => {
  const f = stubFetch(okBody('MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS'));
  const tr = makeFn(f);
  assert.equal(await tr('a'), '');
  assert.equal(await tr('b'), '');
  assert.equal(f.count, 1);
});

test('responseStatus 403 → "" (정상 텍스트라도 거부)', async () => {
  const f = stubFetch(okBody('안녕', 403));
  assert.equal(await makeFn(f)('hi'), '');
});

test('네트워크 오류(fetch throw) → "" (절대 throw 안 함), 래치 안 함 → 다음 성공 가능', async () => {
  const f = stubFetch({ throw: true }, okBody('성공'));
  const tr = makeFn(f);
  assert.equal(await tr('a'), '');     // 1번째: 네트워크 오류 → ''
  assert.equal(await tr('b'), '성공');  // 2번째: 회복 → 정상 (래치 안 됨)
  assert.equal(f.count, 2);
});

test('!ok(예: 500) → "" (래치 안 함)', async () => {
  const f = stubFetch({ status: 500, ok: false, body: {} }, okBody('정상'));
  const tr = makeFn(f);
  assert.equal(await tr('a'), '');
  assert.equal(await tr('b'), '정상');
});

// === 실패 사유 보고 (2026-07-27) ===
// 신고: 차량·오프라인에서 KR 을 켰는데 아무 일도 안 일어남. 원인은 번역 실패 시 호출부가
// 패널을 '조용히 숨긴' 것. 이제 translate.js 가 사유를 남기고 episode.js 가 그 자리에
// 한 줄로 보여준다. 사유가 틀리면 사용자에게 엉뚱한 안내가 나가므로 계약으로 고정한다.

test('성공하면 사유는 빈 문자열', async () => {
  const m = makeMod(stubFetch(okBody('안녕')));
  assert.equal(await m.translateEnKo('hi'), '안녕');
  assert.equal(m.lastTrIssue(), '');
});

test('429 → 사유 quota, 래치 이후에도 quota 유지', async () => {
  const m = makeMod(stubFetch({ status: 429 }));
  await m.translateEnKo('a');
  assert.equal(m.lastTrIssue(), 'quota');
  await m.translateEnKo('b');           // 래치 경로(fetch 안 함)
  assert.equal(m.lastTrIssue(), 'quota');
});

test('쿼터 경고 텍스트 → 사유 quota (200 응답이라도)', async () => {
  const m = makeMod(stubFetch(okBody('MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS')));
  await m.translateEnKo('a');
  assert.equal(m.lastTrIssue(), 'quota');
});

test('!ok(500) → 사유 error (offline 아님 — 서버는 닿았다)', async () => {
  const m = makeMod(stubFetch({ status: 500 }));
  await m.translateEnKo('a');
  assert.equal(m.lastTrIssue(), 'error');
});

// node 21+ 는 navigator 를 getter-only 전역으로 제공한다 → 대입이 아니라 defineProperty.
// async: await 없이 return fn() 하면 finally 가 프라미스 '반환' 시점에 돌아 본문 실행 전에
// navigator 를 되돌린다(실제로 이 테스트가 그렇게 거짓 실패했다).
async function withOnLine(value, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: value }, configurable: true });
  try { return await fn(); } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had);
    else delete globalThis.navigator;
  }
}

test('fetch throw + onLine 이 undefined → offline 로 단정하지 않고 error', async () => {
  // node 의 실제 navigator 에는 onLine 이 없다 = "모른다". 모를 때 offline 이라 하면 오안내.
  const m = makeMod(stubFetch({ throw: true }));
  await m.translateEnKo('a');
  assert.equal(m.lastTrIssue(), 'error');
});

test('fetch throw + navigator.onLine=false → offline', async () => {
  await withOnLine(false, async () => {
    const m = makeMod(stubFetch({ throw: true }));
    await m.translateEnKo('a');
    assert.equal(m.lastTrIssue(), 'offline');
  });
});

test('fetch throw + navigator.onLine=true → error (onLine 은 true 일 때 못 믿는다)', async () => {
  await withOnLine(true, async () => {
    const m = makeMod(stubFetch({ throw: true }));
    await m.translateEnKo('a');
    assert.equal(m.lastTrIssue(), 'error');
  });
});

test('캐시 적중은 이전 실패 사유를 지운다', async () => {
  const m = makeMod(stubFetch(okBody('안녕'), { throw: true }));
  await m.translateEnKo('hi');          // 성공 → 캐시
  await m.translateEnKo('other');       // 실패 → 사유 남음
  assert.notEqual(m.lastTrIssue(), '');
  assert.equal(await m.translateEnKo('hi'), '안녕');   // 캐시 적중
  assert.equal(m.lastTrIssue(), '', '캐시로 성공했는데 옛 실패 사유가 남으면 오안내가 나간다');
});
