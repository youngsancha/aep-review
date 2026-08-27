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

// ─────────────────────────── 회차 '상세' 스냅샷 (사용자 신고 2026-08-27 "오프라인모드 안됨") ────
//
// 목록은 위 계약으로 2026-07-29 에 고쳐졌는데 **상세는 그대로 남아 있었다**. views/episode.js 는
// `const ep = await getEpisode(id)` 한 줄에 화면 전체를 걸고 있어서, 이 읽기가 늦으면 라우터가
// 칠해 둔 스피너에서 영영 안 넘어간다(app.js: 던지면 에러 카드, '안 끝나면' 스피너).
//
// 실측(2026-08-27, 실제 supabase-js·오프라인·만료 세션):
//   · PostgREST 읽기 한 건이 32.6초 뒤에야 settle — auth 7회 재시도가 _getAccessToken() 안에서
//     인라인으로 돌고 그 뒤에야 REST 가 나간다.
//   · ⛔ app.js 의 오프라인 우회가 부르는 stopAutoRefresh() 로는 1ms 도 안 줄었다(32.59초).
//   · 실제 앱 + 실제 SW 로 잰 회차 진입: 25,471ms → 1,303ms.
//
// 여기서 고정하는 계약:
//   ⑥ 성공한 회차 상세는 스냅샷으로 남는다.
//   ⑦ 읽기가 끝나지 않아도 스냅샷이 있으면 그것으로 그린다(무한 스피너 금지).
//   ⑧ 스냅샷이 없으면 마감 시한에 거절된다 — 스피너 대신 에러 카드가 뜬다.
//   ⑨ navigator.onLine === false + 스냅샷 → 아예 안 물어본다.
//   ⑩ 자막/번역은 스냅샷에 넣지 않는다(수 MB — 한 번만 새도 localStorage 가 터진다).
//   ⑪ 쿼리빌더는 정확히 한 번만 실행된다(postgrest-js 빌더는 .then() 마다 요청이 나간다).

const EP_BODY = [
  '"use strict";',
  grab(/^const READ_DEADLINE_MS = .*;$/m),
  grab(/^const EP_SNAP_KEY = .*;$/m),
  // 이 두 줄은 끝에 설명 주석이 붙어 있어 `;$` 로는 안 잡힌다 — 줄 끝까지 통째로 가져온다.
  grab(/^const EP_SNAP_LRU = .*$/m),
  grab(/^const EP_SNAP_MAX = .*$/m),
  grab(/^const EP_SNAP_DEADLINE_MS = .*;$/m),
  grab(/^let _epReqSeq = .*;$/m),
  grab(/^const _epSnapSeq = .*$/m),
  grabFn('withDeadline'),
  grabFn('epSnapLru'),
  grabFn('saveEpisodeSnapshot'),
  grabFn('loadEpisodeSnapshot'),
  grabFn('getEpisode'),
  'return { getEpisode, loadEpisodeSnapshot, saveEpisodeSnapshot };',
].join('\n');

function makeEpDb({ query, store = {}, onLine = true, hydrate, quota }) {
  // quota() → true 면 그 시점부터 스냅샷 '본문' 쓰기가 QuotaExceededError 로 실패한다(색인은 통과).
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      if (quota && quota() && k.startsWith('aep-ep-snap-') && k !== 'aep-ep-snap-lru') {
        const err = new Error('QuotaExceededError'); err.name = 'QuotaExceededError'; throw err;
      }
      store[k] = String(v);
    },
    removeItem: (k) => { delete store[k]; },
  };
  let builds = 0;
  // postgrest-js 빌더 흉내: thenable 이고, then() 이 불릴 때마다 요청이 '나간다'.
  const builder = () => ({ then: (res, rej) => { builds++; return query().then(res, rej); } });
  const supabase = { from: () => ({ select: () => ({ eq: () => ({ single: builder }) }) }) };
  const mod = new Function(
    'supabase', 'localStorage', 'console', 'navigator', 'hydrateEpisode', EP_BODY,
  )(supabase, localStorage, { warn() {}, error() {} }, { onLine },
    hydrate || (async (ep) => ep));
  return { ...mod, store, builds: () => builds };
}

const EP = {
  id: 218, title: 'Expression', transcribed_at: '2026-08-12T00:00:00Z',
  audio_url: 'https://traffic.megaphone.fm/X.mp3',
  vocab: [{ id: 2, term: 'b', sentence_start_sec: 5 }, { id: 1, term: 'a', sentence_start_sec: 1 }],
};
const okEp = (row) => async () => ({ data: row, error: null });

test('회차: 성공하면 상세 스냅샷을 남긴다', async () => {
  const db = makeEpDb({ query: okEp(EP) });
  const out = await db.getEpisode(218);
  assert.equal(out.id, 218);
  assert.equal(JSON.parse(db.store['aep-ep-snap-218']).title, 'Expression');
});

test('회차: 읽기가 끝나지 않아도 스냅샷이 있으면 그것으로 그린다 (무한 스피너 금지)', async () => {
  const store = { 'aep-ep-snap-218': JSON.stringify({ id: 218, title: 'Cached' }) };
  const db = makeEpDb({ query: never, store });
  const t0 = Date.now();
  const out = await db.getEpisode(218);
  assert.equal(out.title, 'Cached');
  assert.ok(Date.now() - t0 < 4000, '실측: 고치기 전엔 32.6초 뒤에야 settle 했다');
});

test('회차: 스냅샷이 없으면 마감 시한에 거절된다 (스피너 대신 에러 카드)', async () => {
  const db = makeEpDb({ query: never });
  await assert.rejects(() => db.getEpisode(218), /timed out/);
});

test('회차: 확실히 오프라인이면 스냅샷을 쓰고 아예 안 물어본다', async () => {
  const store = { 'aep-ep-snap-218': JSON.stringify({ id: 218, title: 'Cached' }) };
  const db = makeEpDb({ query: never, store, onLine: false });
  const out = await db.getEpisode(218);
  assert.equal(out.title, 'Cached');
  assert.equal(db.builds(), 0, 'onLine=false 에서 기다려서 얻을 게 없다 — 요청 자체를 만들지 않는다');
});

test('회차: 자막·번역은 스냅샷에 안 들어간다 (수 MB — quota 즉사)', async () => {
  const db = makeEpDb({ query: okEp({ ...EP, transcript: { segments: new Array(500).fill('x') }, transcript_ko: { a: 'b' } }) });
  await db.getEpisode(218);
  const snap = JSON.parse(db.store['aep-ep-snap-218']);
  assert.ok(!('transcript' in snap) && !('transcript_ko' in snap));
});

test('회차: 쿼리빌더는 정확히 한 번만 실행된다', async () => {
  // postgrest-js 빌더는 '실행되지 않은 thenable' 이라 .then() 마다 요청이 나간다.
  // 데드라인용 + 지각도착용으로 두 번 붙이면 회차를 열 때마다 REST 가 두 번 나간다.
  const store = { 'aep-ep-snap-218': JSON.stringify({ id: 218, title: 'Cached' }) };
  const db = makeEpDb({ query: never, store });
  await db.getEpisode(218);
  assert.equal(db.builds(), 1);
});

test('회차: 스냅샷 개수가 상한을 넘으면 오래된 것부터 지운다', async () => {
  const store = {};
  const db = makeEpDb({ query: okEp(EP), store });
  for (let i = 1; i <= 45; i++) await db.getEpisode(i) && 0;
  const kept = Object.keys(store).filter((k) => k.startsWith('aep-ep-snap-') && k !== 'aep-ep-snap-lru');
  assert.ok(kept.length <= 40, `상한 40 을 넘겼다: ${kept.length}`);
  assert.ok(!store['aep-ep-snap-1'], '가장 오래된 것이 남아 있으면 상한이 동작하지 않는 것');
});

// ── xcheck 패널(gemini·grok)이 잡은 세 건, 2026-08-27 ──────────────────────────────────────

test('회차: quota 복구가 다 실패해도 색인은 저장된다 (유령 키 금지)', async () => {
  // 성공 경로에서만 색인을 쓰면, 다 실패했을 때 '이미 지운' id 가 색인에 남는다 → 다음 저장이
  // 그 유령을 evict 하려 들지만 removeItem 은 no-op 이라 0바이트를 비운다(복구가 영구 무력화).
  const store = {};
  let hard = false;
  const db = makeEpDb({ query: okEp(EP), store, quota: () => hard });
  for (let i = 1; i <= 5; i++) await db.getEpisode(i);
  assert.equal(JSON.parse(store['aep-ep-snap-lru']).length, 5);

  hard = true;                                     // 이제부터 스냅샷 본문 쓰기는 전부 실패한다
  db.saveEpisodeSnapshot(99, { id: 99 });
  const after = JSON.parse(store['aep-ep-snap-lru']);
  for (const k of after) {
    assert.ok(store[`aep-ep-snap-${k}`] !== undefined,
      `색인에 유령 키가 남았다: ${k} — 다음 quota 복구가 0바이트를 비운다`);
  }
});

test('회차: 지각 응답이 더 새 스냅샷을 덮지 않는다', async () => {
  // 데드라인을 넘긴 옛 요청이 나중에 도착해도, 그 사이 온라인 복귀로 저장된 최신값을 되돌리면 안 된다.
  const store = {};
  const db = makeEpDb({ query: okEp(EP), store });
  db.saveEpisodeSnapshot(7, { id: 7, title: 'OLD' }, 1);   // 요청 #1
  db.saveEpisodeSnapshot(7, { id: 7, title: 'NEW' }, 2);   // 요청 #2 — 더 새 응답
  db.saveEpisodeSnapshot(7, { id: 7, title: 'OLD' }, 1);   // #1 이 지각 도착
  assert.equal(JSON.parse(store['aep-ep-snap-7']).title, 'NEW');
});

test('회차: 스냅샷 없이 실패해도 지각 응답은 스냅샷으로 남는다', async () => {
  // 느린 회선에서 처음 여는 회차: 8초 뒤 에러 카드를 띄우되, 그 직후 도착한 응답은 살려 둔다 →
  // 다시 누르면 즉시 열린다. 예전엔 곧장 던져서 그 응답을 버렸고 재시도도 똑같이 8초였다.
  const store = {};
  let release;
  const slow = () => new Promise((res) => { release = () => res({ data: EP, error: null }); });
  const db = makeEpDb({ query: slow, store });
  await assert.rejects(() => db.getEpisode(218), /timed out/);
  assert.equal(store['aep-ep-snap-218'], undefined, '아직은 안 왔다');
  release();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(store['aep-ep-snap-218'], '지각 응답이 버려졌다 — 재시도가 또 8초를 기다린다');
});
