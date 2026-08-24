// service-worker.js 의 HEAD(count) 캐싱 검증.
//
// studyOverview() 는 카운트 8개를 HEAD + Prefer: count=exact 로 가져오고, 개수는 본문이 아니라
// Content-Range 헤더에 온다. 그래서 이 테스트가 지키는 것은 두 가지다:
//   ① 오프라인에서 그 헤더가 캐시를 왕복해도 살아남는가 (아니면 Study 홈이 0 으로 보인다)
//   ② HEAD 응답이 같은 URL 의 GET 과 칸을 공유하지 않는가 (공유하면 본문 없는 응답이 GET 에
//      반환되어 호출부가 행을 하나도 못 받는다)
//
// SW 는 export 가 없는 전역 스크립트라 vm 샌드박스에 self/caches/fetch 를 심어 로드한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../ui/service-worker.js', import.meta.url), 'utf8');
const REST = 'https://x.supabase.co/rest/v1/vocab_cards?select=*';

/** 아주 작은 Cache API 스텁 — put 의 GET-only 제약까지 흉내낸다(그게 이 설계의 이유다). */
function makeCaches() {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async put(req, res) {
        const method = (req.method || 'GET').toUpperCase();
        if (method !== 'GET') throw new TypeError('Request method must be GET');
        m.set(req.url, res);
      },
      async match(req) { return m.get(typeof req === 'string' ? req : req.url) || undefined; },
      async keys() { return [...m.keys()].map((u) => ({ url: u })); },
      async delete(req) { return m.delete(typeof req === 'string' ? req : req.url); },
    };
  };
  return { api: { open, keys: async () => [...stores.keys()], delete: async () => true }, stores };
}

function load({ online, fetchImpl }) {
  const { api, stores } = makeCaches();
  const listeners = {};
  const sandbox = {
    self: {
      addEventListener: (k, fn) => { listeners[k] = fn; },
      navigator: { onLine: online },
      skipWaiting: () => {}, clients: { claim: () => {} }, registration: {},
    },
    caches: api,
    fetch: fetchImpl,
    Request: globalThis.Request, Response: globalThis.Response,
    Headers: globalThis.Headers, URL: globalThis.URL, console,
    setTimeout, clearTimeout, setImmediate, Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { listeners, stores, sandbox };
}

function respond(listeners, req) {
  let out;
  listeners.fetch({ request: req, respondWith: (p) => { out = p; }, waitUntil: () => {} });
  return out;
}

// SW 는 res.type 이 'cors'|'basic' 일 때만 캐시한다(부분응답·opaque 를 걸러내려고).
// Node 의 Response 는 type 이 'default' 라 그대로 쓰면 캐시 경로를 아예 안 탄다 — 실제 CORS
// 응답을 흉내내려면 명시해야 한다.
const countRes = (n) => {
  const r = new Response(null, { status: 200, headers: { 'content-range': `0-0/${n}` } });
  Object.defineProperty(r, 'type', { value: 'cors' });
  return r;
};

/** cache.put 은 fire-and-forget 으로 걸린다 — 검사 전에 대기열을 비운다. */
const settle = () => new Promise((r) => setImmediate(r));

test('HEAD count: Content-Range survives the cache round-trip while offline', async () => {
  // ① 온라인에서 한 번 받아 캐시를 채운다.
  const on = load({ online: true, fetchImpl: async () => countRes(6123) });
  const first = await respond(on.listeners, new Request(REST, { method: 'HEAD' }));
  assert.equal(first.headers.get('content-range'), '0-0/6123');
  await settle();

  // 캐시에 들어간 키를 그대로 오프라인 샌드박스로 옮긴다.
  const off = load({ online: false, fetchImpl: async () => { throw new Error('offline'); } });
  for (const [name, m] of on.stores) {
    const c = await off.sandbox.caches.open(name);
    for (const [url, res] of m) await c.put({ url, method: 'GET' }, res);
  }
  const cached = await respond(off.listeners, new Request(REST, { method: 'HEAD' }));
  assert.equal(cached.headers.get('content-range'), '0-0/6123',
    'offline 에서 개수가 사라지면 Study 홈이 전부 0 으로 보인다');
});

test('HEAD entries are namespaced away from a GET of the same URL', async () => {
  const on = load({ online: true, fetchImpl: async () => countRes(42) });
  await respond(on.listeners, new Request(REST, { method: 'HEAD' }));
  await settle();
  const keys = [...on.stores.values()].flatMap((m) => [...m.keys()]);
  assert.ok(keys.length > 0, 'HEAD 응답이 캐시되지 않았다');
  assert.ok(keys.every((k) => k.includes('__sw_head=1')),
    `HEAD 는 마커가 붙은 키에만 저장돼야 한다 — 실제: ${keys.join(', ')}`);
  assert.ok(!keys.includes(REST), 'HEAD 가 같은 URL 의 GET 칸을 차지했다');
});

test('writes (POST/PATCH) are still left alone', async () => {
  const on = load({ online: true, fetchImpl: async () => countRes(1) });
  let handled = true;
  on.listeners.fetch({
    request: new Request(REST, { method: 'POST' }),
    respondWith: () => { handled = false; }, waitUntil: () => {},
  });
  assert.equal(handled, true, '쓰기 요청은 SW 가 가로채면 안 된다');
});

test('HEAD to a non-Supabase host is not intercepted', async () => {
  const on = load({ online: true, fetchImpl: async () => countRes(1) });
  let intercepted = false;
  on.listeners.fetch({
    request: new Request('https://example.com/x', { method: 'HEAD' }),
    respondWith: () => { intercepted = true; }, waitUntil: () => {},
  });
  assert.equal(intercepted, false);
});
