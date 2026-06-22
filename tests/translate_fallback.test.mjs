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
  grabLine(/^const _TR_MEM = .*;/m) + '\n' +
  grabLine(/^let _trQuotaHit = .*;/m) + '\n' +
  grabFn('translateEnKo') + '\n' +
  'return translateEnKo;';

// 새 인스턴스마다 모듈 상태(_TR_MEM/_trQuotaHit) 격리 → 시나리오 독립.
function makeFn(fetchStub, email = '') {
  return new Function('fetch', 'TRANSLATE_EMAIL', BODY)(fetchStub, email);
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
