// 오프라인 라이브러리 회귀 테스트 (node --test) — 사용자 신고 2026-07-29(차량).
//
// 증상: 오프라인에서 앱이 스켈레톤에 영구 고착. 원인은 '실패'가 아니라 '침묵'이었다 —
// supabase-js 는 인증 요청을 navigator.locks 로 직렬화하는데, 오프라인에서 토큰 갱신이
// 재시도를 반복하며 락을 쥐면 뒤따르는 PostgREST 호출이 요청조차 못 나간 채 영원히 대기한다
// (실측: auth 7회 / REST 0회). 끝나지 않으므로 route() 의 catch 도 뷰의 에러 상태도 안 뜬다.
//
// 여기서 고정하는 계약:
//   ① 네트워크 읽기는 마감 시한을 넘기면 '거절'된다(무한 대기 금지).
//   ② 성공한 목록은 스냅샷으로 남는다(오프라인에서 네트워크 없이 그리기 위해).
//   ③ 읽기가 실패/지연되면 스냅샷으로 폴백한다.
//   ④ 스냅샷이 있으면 더 빨리 포기한다 — 기다릴 가치는 포기했을 때 잃는 것에 비례한다.
//   ⑤ 스냅샷이 없으면 던진다(빈 화면을 조용히 성공으로 위장하지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'ui/db.js'), 'utf8');

function grab(re) {
  const m = re.exec(SRC);
  if (!m) throw new Error('not found in ui/db.js: ' + re);
  return m[0].replace(/^export\s+/gm, '');
}
// 함수 본문 통째로 (닫는 '}' 가 줄 맨 앞에 오는 형식을 따른다)
function grabFn(name) {
  const lines = SRC.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`function ${name}\\(`).test(l));
  if (start < 0) throw new Error('fn not found: ' + name);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n').replace(/^export\s+/, '');
  }
  throw new Error('fn end not found: ' + name);
}

const BODY = [
  '"use strict";',
  grab(/^const READ_DEADLINE_MS = .*;$/m),
  grab(/^const EPS_SNAP_KEY = .*;$/m),
  grab(/^const EPS_SNAP_MAX = .*;$/m),
  grabFn('withDeadline'),
  grabFn('saveEpisodesSnapshot'),
  grabFn('loadEpisodesSnapshot'),
  grabFn('listEpisodes'),
  'return { listEpisodes, loadEpisodesSnapshot, saveEpisodesSnapshot, withDeadline, READ_DEADLINE_MS };',
].join('\n');

function makeDb({ query, store = {}, MULTISHOW = true, show = 'aep' }) {
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const withShow = (q) => q;
  const supabase = { from: () => ({ select: () => ({ order: () => query() }) }) };
  const quietConsole = { warn() {}, error() {} };
  const mod = new Function(
    'supabase', 'withShow', 'MULTISHOW', 'currentShow', 'localStorage', 'console', BODY,
  )(supabase, withShow, MULTISHOW, () => show, localStorage, quietConsole);
  return { ...mod, store };
}

const ROWS = [
  { id: 2, title: 'Two', pub_date: '2026-07-02', description: 'x'.repeat(4000) },
  { id: 1, title: 'One', pub_date: '2026-07-01', description: 'y'.repeat(4000) },
];
const ok = (rows) => async () => ({ data: rows, error: null });
const never = () => new Promise(() => {});          // 영원히 안 끝남 = 실측된 실패 모드

test('성공하면 목록을 반환하고 스냅샷을 남긴다', async () => {
  const db = makeDb({ query: ok(ROWS) });
  const out = await db.listEpisodes();
  assert.equal(out.length, 2);
  const snap = JSON.parse(db.store['aep-eps-snap-aep']);
  assert.equal(snap.length, 2);
  assert.equal(snap[0].title, 'Two');
});

test('스냅샷에서 description 은 빠진다 (localStorage 한도 보호)', async () => {
  const db = makeDb({ query: ok(ROWS) });
  await db.listEpisodes();
  const snap = JSON.parse(db.store['aep-eps-snap-aep']);
  assert.ok(!('description' in snap[0]), 'description 을 넣으면 회차 수백 개에서 quota 를 넘긴다');
  assert.ok(db.store['aep-eps-snap-aep'].length < 2000);
});

test('읽기가 끝나지 않아도 스냅샷이 있으면 그것으로 그린다', async () => {
  const store = { 'aep-eps-snap-aep': JSON.stringify([{ id: 9, title: 'Cached' }]) };
  const db = makeDb({ query: never, store });
  const t0 = Date.now();
  const out = await db.listEpisodes();
  assert.equal(out[0].title, 'Cached');
  assert.ok(Date.now() - t0 < 4000, '스냅샷이 있으면 빨리 포기해야 한다(실측 2.5s 예산)');
});

test('스냅샷이 없으면 던진다 — 빈 목록을 성공으로 위장하지 않는다', async () => {
  const db = makeDb({ query: async () => { throw new Error('offline'); } });
  await assert.rejects(() => db.listEpisodes(), /offline/);
});

test('스냅샷 없이 끝나지 않는 읽기는 마감 시한에 거절된다 (무한 대기 금지)', async () => {
  const db = makeDb({ query: never });
  await assert.rejects(() => db.listEpisodes(), /timed out/,
    '거절되지 않으면 뷰가 스켈레톤에 영구 고착한다 — 이 버그의 본체');
});

test('멀티쇼: 스냅샷 키가 쇼별로 분리된다', async () => {
  const store = {};
  await makeDb({ query: ok(ROWS), store, show: 'aep' }).listEpisodes();
  await makeDb({ query: ok(ROWS), store, show: 'allears' }).listEpisodes();
  assert.ok(store['aep-eps-snap-aep'] && store['aep-eps-snap-allears'],
    '쇼가 섞이면 라이브러리에 다른 팟캐스트 회차가 뜬다');
});

test('MULTISHOW=false 면 레거시 단일 키를 쓴다', async () => {
  const db = makeDb({ query: ok(ROWS), MULTISHOW: false });
  await db.listEpisodes();
  assert.ok(db.store['aep-eps-snap-_']);
});

test('withDeadline 은 성공을 지연시키지 않는다', async () => {
  const db = makeDb({ query: ok(ROWS) });
  const t0 = Date.now();
  await db.withDeadline(Promise.resolve('x'), 'fast', 5000);
  assert.ok(Date.now() - t0 < 200, '타이머가 이벤트루프를 붙잡으면 안 된다');
});
