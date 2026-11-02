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
            location: { origin: 'https://app.test' },
            skipWaiting() {}, clients: { claim() {} }, registration: {} },
    caches: {
      open, keys: async () => [...stores.keys()], delete: async () => true,
      match: async (key) => {
        for (const m of stores.values()) { if (m.has(key)) return m.get(key); }
        return undefined;
      },
    },
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

// A readable (CORS) download answers Range requests from a sliced Blob: this is what makes seeking work with
// no signal. Every offline ⟲15 and every shadowing repeat lands here.
const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
const AC_NAME = /const AUDIO_CACHE\s*=\s*['"`]([^'"`]+)/.exec(SRC)[1];
async function seeded(body = BYTES) {
  const t = load({ fetchImpl: async () => { throw new TypeError('offline'); } });
  const cache = await t.open(AC_NAME);
  await cache.put({ url: AUDIO }, withType(new Response(body, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(body.length) } }), 'cors'));
  return { t, cache };
}
const ranged = (t, range) => respond(t.listeners, new Request(AUDIO, { headers: { range } }));
const bytesOf = async (res) => new Uint8Array(await res.arrayBuffer());

test('range: a bounded request gets exactly those bytes', async () => {
  const { t } = await seeded();
  const res = await ranged(t, 'bytes=100-199');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 100-199/1000');
  assert.equal(res.headers.get('content-length'), '100');
  assert.deepEqual(await bytesOf(res), BYTES.slice(100, 200));
});

test('range: an open-ended request runs to the last byte', async () => {
  const { t } = await seeded();
  const res = await ranged(t, 'bytes=990-');
  assert.equal(res.headers.get('content-range'), 'bytes 990-999/1000');
  assert.deepEqual(await bytesOf(res), BYTES.slice(990));
});

test('range: an end past the file is clamped', async () => {
  const { t } = await seeded();
  const res = await ranged(t, 'bytes=990-5000');
  assert.equal(res.headers.get('content-range'), 'bytes 990-999/1000');
});

test('range: a start past the file is a 416 naming the real size', async () => {
  const { t } = await seeded();
  const res = await ranged(t, 'bytes=1000-');
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), 'bytes */1000');
});

test('range: an end before the start is unsatisfiable, not a negative length', async () => {
  const { t } = await seeded();
  assert.equal((await ranged(t, 'bytes=100-50')).status, 416);
});

test('range: without a Range header the whole download is served', async () => {
  const { t } = await seeded();
  assert.equal((await respond(t.listeners, new Request(AUDIO))).status, 200);
});

test('range: replaced audio is never served from the old bytes', async () => {
  // A re-sync swaps the file under the same URL. Old bytes here mean new subtitles over old sound.
  const { t, cache } = await seeded();
  await bytesOf(await ranged(t, 'bytes=0-9'));
  const fresh = new Uint8Array(1000).fill(7);
  await cache.put({ url: AUDIO }, withType(new Response(fresh, { status: 200, headers: { 'Content-Length': '1000', 'ETag': '"new"' } }), 'cors'));
  assert.deepEqual(await bytesOf(await ranged(t, 'bytes=0-9')), fresh.slice(0, 10));
});

test('range: requests racing on one episode copy it into memory once', async () => {
  const { t, cache } = await seeded();
  const original = cache.match;
  let reads = 0;
  // Shadowing fires Range requests in quick succession, and each copy is the whole 30-60 MB file.
  const proto = Response.prototype.blob;
  Response.prototype.blob = function blob() { reads++; return proto.call(this); };
  try {
    await Promise.all([ranged(t, 'bytes=0-9'), ranged(t, 'bytes=10-19'), ranged(t, 'bytes=20-29')]);
  } finally {
    Response.prototype.blob = proto;
    cache.match = original;
  }
  assert.equal(reads, 1);
});

test('range: a replaced file is detected with only the headers CORS exposes', async () => {
  // ETag is not a CORS-safelisted header, so on a phone only Last-Modified and Content-Length are visible.
  const { t, cache } = await seeded();
  await bytesOf(await ranged(t, 'bytes=0-9'));
  const fresh = new Uint8Array(1000).fill(9);
  await cache.put({ url: AUDIO }, withType(new Response(fresh, { status: 200, headers: { 'Content-Length': '1000', 'Last-Modified': 'Sun, 01 Nov 2026 00:00:00 GMT' } }), 'cors'));
  assert.deepEqual(await bytesOf(await ranged(t, 'bytes=0-9')), fresh.slice(0, 10));
});

test('range: a failed read is not remembered, so the next request tries again', async () => {
  const { t } = await seeded();
  const proto = Response.prototype.blob;
  Response.prototype.blob = () => Promise.reject(new Error('disk'));
  await assert.rejects(ranged(t, 'bytes=0-9'));
  Response.prototype.blob = proto;
  await new Promise((r) => setImmediate(r));
  assert.equal((await ranged(t, 'bytes=0-9')).status, 206);
});

// Opening the app. The worst incidents in this repo happened on this path, and it had no test.
const PAGE = 'https://app.test/';
const SHELL_CACHE = /const CACHE\s*=\s*[`'"]([^`'"$]*)/.exec(SRC)[1] + /const VERSION = '([^']+)'/.exec(SRC)[1];
const html = (body, status = 200) => withType(new Response(body, { status, headers: { 'Content-Type': 'text/html' } }), 'basic');
const open_ = (t) => respond(t.listeners, { url: PAGE, mode: 'navigate', method: 'GET', headers: new Headers() });
async function withShell(fetchImpl) {
  const t = load({ fetchImpl });
  await (await t.open(SHELL_CACHE)).put('/index.html', html('cached shell'));
  return t;
}

test('opening the app: a good response is served and refreshes the shell', async () => {
  const t = await withShell(async () => html('new shell'));
  assert.equal(await (await open_(t)).text(), 'new shell');
  await new Promise((r) => setImmediate(r));
  assert.equal(await (await (await t.open(SHELL_CACHE)).match('/index.html')).clone().text(), 'new shell');
});

test('opening the app: a 5xx from the host does not replace a working app with an error page', async () => {
  const t = await withShell(async () => html('Bad gateway', 503));
  const cache = await t.open(SHELL_CACHE);
  const shell = await cache.match('/index.html');
  assert.equal(await (await open_(t)).clone().text(), 'cached shell');
  assert.equal(await cache.match('/index.html'), shell, 'an error must not overwrite the cached shell');
});

test('opening the app: with no shell yet the real error is shown, not a blank failure', async () => {
  const t = load({ fetchImpl: async () => html('Bad gateway', 503) });
  const res = await open_(t);
  assert.equal(res.status, 503);
});

test('opening the app: no network falls back to the shell', async () => {
  const t = await withShell(async () => { throw new TypeError('offline'); });
  assert.equal(await (await open_(t)).text(), 'cached shell');
});

test('opening the app: a hanging network gives way to the shell within seconds', async () => {
  const t = await withShell(() => new Promise(() => {}));
  const t0 = Date.now();
  assert.equal(await (await open_(t)).text(), 'cached shell');
  assert.ok(Date.now() - t0 < 4000);
});
