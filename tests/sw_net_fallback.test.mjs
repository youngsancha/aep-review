// service-worker.js — lie-fi / 비정상 응답에서 캐시 사본이 이겨야 하는 두 경로.
//  · networkFirst: 사본이 있으면 401/429/5xx 네트워크 응답이 사본을 이기면 안 된다.
//  · serveAudio(opaque 사본): 네트워크가 매달려도 ~2.5s 뒤 사본으로 폴백한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../ui/service-worker.js', import.meta.url), 'utf8');
const REST = 'https://x.supabase.co/rest/v1/episodes?select=*';
const AUDIO = 'https://pub-x.r2.dev/audio/7.mp3';

function load({ fetchImpl }) {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async put(req, res) { m.set(typeof req === 'string' ? req : req.url, res); },
      async match(req) { return m.get(typeof req === 'string' ? req : req.url); },
      async keys() { return [...m.keys()].map((u) => ({ url: u })); },
      async delete(req) { return m.delete(typeof req === 'string' ? req : req.url); },
    };
  };
  const listeners = {};
  const sandbox = {
    self: { addEventListener: (k, fn) => { listeners[k] = fn; }, navigator: { onLine: true },
            skipWaiting() {}, clients: { claim() {} }, registration: {} },
    caches: { open, keys: async () => [...stores.keys()], delete: async () => true },
    fetch: fetchImpl, Request, Response, Headers, URL, console,
    setTimeout, clearTimeout, setImmediate, Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { listeners, open, sandbox };
}
const respond = (l, req) => {
  let out; l.fetch({ request: req, respondWith: (p) => { out = p; }, waitUntil() {} }); return out;
};
const withType = (res, type) => { Object.defineProperty(res, 'type', { value: type }); return res; };

test('networkFirst: a 503 does not beat a cached copy', async () => {
  const t = load({ fetchImpl: async () => withType(new Response('boom', { status: 503 }), 'cors') });
  // 어떤 캐시 이름이든 사본이 보이도록 SW 가 쓰는 DATA 캐시를 소스에서 찾아 심는다.
  const DATA = /const DATA_CACHE\s*=\s*['"`]([^'"`]+)/.exec(SRC)?.[1];
  assert.ok(DATA, 'DATA_CACHE name not found in service-worker.js');
  await (await t.open(DATA)).put({ url: REST }, withType(new Response('cached', { status: 200 }), 'cors'));
  const res = await respond(t.listeners, new Request(REST));
  assert.equal(await res.text(), 'cached');
});

test('networkFirst: a 200 still wins over the cached copy', async () => {
  const t = load({ fetchImpl: async () => withType(new Response('fresh', { status: 200 }), 'cors') });
  const DATA = /const DATA_CACHE\s*=\s*['"`]([^'"`]+)/.exec(SRC)[1];
  await (await t.open(DATA)).put({ url: REST }, withType(new Response('cached', { status: 200 }), 'cors'));
  const res = await respond(t.listeners, new Request(REST));
  assert.equal(await res.text(), 'fresh');
});

test('serveAudio: opaque cached copy answers when the network hangs (lie-fi)', async () => {
  const t = load({ fetchImpl: () => new Promise(() => {}) });
  const AC = /const AUDIO_CACHE\s*=\s*['"`]([^'"`]+)/.exec(SRC)[1];
  const opaque = withType(new Response('x', { status: 200 }), 'opaque');
  await (await t.open(AC)).put({ url: AUDIO }, opaque);
  const t0 = Date.now();
  const res = await respond(t.listeners, new Request(AUDIO));
  assert.equal(res, opaque);
  assert.ok(Date.now() - t0 < 4000);
});

test('serveAudio: a readable error does not beat the opaque cached copy', async () => {
  const t = load({ fetchImpl: async () => withType(new Response('bad gateway', { status: 502 }), 'cors') });
  const AC = /const AUDIO_CACHE\s*=\s*['"`]([^'"`]+)/.exec(SRC)[1];
  const opaque = withType(new Response('x', { status: 200 }), 'opaque');
  await (await t.open(AC)).put({ url: AUDIO }, opaque);
  assert.equal(await respond(t.listeners, new Request(AUDIO)), opaque);
});

test('serveAudio: an opaque network answer still wins, though its status is unreadable', async () => {
  // <audio> without crossorigin fetches no-cors: .ok is false on every success, so testing .ok here
  // would silently stop streaming and pin playback to the cached copy.
  const fresh = withType(new Response('net', { status: 200 }), 'opaque');
  Object.defineProperty(fresh, 'ok', { value: false });
  const t = load({ fetchImpl: async () => fresh });
  const AC = /const AUDIO_CACHE\s*=\s*['"`]([^'"`]+)/.exec(SRC)[1];
  await (await t.open(AC)).put({ url: AUDIO }, withType(new Response('x', { status: 200 }), 'opaque'));
  assert.equal(await respond(t.listeners, new Request(AUDIO)), fresh);
});
