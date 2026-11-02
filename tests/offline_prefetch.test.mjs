// The real ui/offline.js: when the automatic download counts as done, and what is allowed into the
// audio cache. A wrong answer to either is silent: the phone reports "downloaded" or simply never tries
// again, and the failure only shows up on a commute with no signal.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { UI, resolveUiModules, installStorage } from './helpers/ui-modules.mjs';

// /db.js stands in for the network layer. Each test decides what it answers.
const DB_NAMES = ['listEpisodes', 'getEpisode', 'episodeNav', 'hostedSet', 'transcriptUrl', 'transcriptKoUrl',
  'loadEpisodeSnapshot'];
resolveUiModules({
  '/app.js': 'export function toast(){}',
  '/db.js': DB_NAMES.map((n) => `export const ${n} = (...a) => globalThis.__db.${n}(...a);`).join('\n'),
});

const store = installStorage();
const audioCache = new Map();
Object.assign(globalThis, {
  caches: {
    open: async () => ({
      match: async (url) => audioCache.get(String(url?.url ?? url)),
      put: async (url, res) => { audioCache.set(String(url), res); },
      delete: async (key) => audioCache.delete(String(key?.url ?? key)),
      keys: async () => [...audioCache.keys()].map((url) => ({ url })),
    }),
  },
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });

const { hostedAudioUrl } = await import(new URL('config.js', UI).href);
const { pinEpisode } = await import(new URL('offline-pins.js', UI).href);

let fresh = 0;
// A new module instance per test: `_ran` is session state and must start clean.
const loadOffline = () => import(`${new URL('offline.js', UI).href}?t=${++fresh}`);

const eps = (...ids) => ids.map((id) => ({ id, transcribed_at: 'v1' }));
const ok = () => new Response('mp3', { status: 200 });
let fetched;

function setNetwork(handler) {
  fetched = [];
  globalThis.fetch = async (url, init) => { fetched.push(init?.mode); return handler(url, init); };
}

beforeEach(() => {
  audioCache.clear();
  store.clear();
  setNetwork(ok);
  globalThis.__db = {
    listEpisodes: async () => eps(1),
    hostedSet: async () => new Set([1]),
    getEpisode: async (id) => ({ id, transcribed_at: 'v1' }),
    episodeNav: async () => ({}),
    transcriptUrl: () => 'https://t/1.json',
    transcriptKoUrl: () => 'https://t/1_ko.json',
    loadEpisodeSnapshot: () => null,
  };
});

test('booting in a dead zone tries again when the signal returns', async () => {
  const m = await loadOffline();
  globalThis.__db.listEpisodes = async () => { throw new Error('offline'); };
  await m.ensureOfflineCache();
  assert.equal(audioCache.size, 0);
  globalThis.__db.listEpisodes = async () => eps(1);
  await m.ensureOfflineCache();
  assert.equal(audioCache.size, 1);
});

test('an unreachable manifest is not "nothing to download": it retries', async () => {
  // hostedSet() answers an empty set on failure and never throws. With data dead but onLine true, the
  // episode list still comes from the service worker cache.
  const m = await loadOffline();
  globalThis.__db.hostedSet = async () => new Set();
  await m.ensureOfflineCache();
  assert.equal(audioCache.size, 0);
  globalThis.__db.hostedSet = async () => new Set([1]);
  await m.ensureOfflineCache();
  assert.equal(audioCache.size, 1);
});

test('a show with no hosted episodes is a real answer: once per session', async () => {
  const m = await loadOffline();
  let lists = 0;
  globalThis.__db.listEpisodes = async () => { lists++; return eps(1); };
  globalThis.__db.hostedSet = async () => new Set([999]);
  await m.ensureOfflineCache();
  await m.ensureOfflineCache();
  assert.equal(lists, 1);
});

test('a finished run does not repeat in the same session', async () => {
  const m = await loadOffline();
  await m.ensureOfflineCache();
  fetched = [];
  await m.ensureOfflineCache();
  assert.deepEqual(fetched, []);
});

test('overlapping calls run once', async () => {
  const m = await loadOffline();
  let lists = 0;
  globalThis.__db.listEpisodes = async () => { lists++; return eps(1); };
  await Promise.all([m.ensureOfflineCache(), m.ensureOfflineCache()]);
  assert.equal(lists, 1);
});

test('a 404 is never cached as a download, not even as an opaque response', async () => {
  const m = await loadOffline();
  setNetwork(() => new Response('gone', { status: 404 }));
  await assert.rejects(m.cacheEpisodeAudio(1), /audio HTTP 404/);
  assert.equal(audioCache.size, 0);
  assert.deepEqual(fetched, ['cors'], 'no no-cors retry after the server has answered');
});

test('a thrown CORS fetch falls back to an opaque download', async () => {
  const m = await loadOffline();
  const opaque = new Response('mp3', { status: 200 });
  setNetwork((_url, init) => {
    if (init?.mode === 'cors') throw new TypeError('Failed to fetch');
    return opaque;
  });
  await m.cacheEpisodeAudio(1);
  assert.equal(audioCache.get(hostedAudioUrl(1)), opaque);
  assert.deepEqual(fetched, ['cors', 'no-cors']);
});

test('a failed episode does not stop the rest, and is not recorded as downloaded', async () => {
  const m = await loadOffline();
  globalThis.__db.listEpisodes = async () => eps(1, 2);
  globalThis.__db.hostedSet = async () => new Set([1, 2]);
  setNetwork((url) => (String(url).includes('/1.mp3') ? new Response('', { status: 503 }) : ok()));
  await m.ensureOfflineCache();
  assert.deepEqual([...audioCache.keys()], [hostedAudioUrl(2)]);
  assert.deepEqual(Object.keys(JSON.parse(store.get('aep-offline-meta'))), ['2']);
});

test('the cleanup keeps an episode pinned while the downloads were running', async () => {
  const m = await loadOffline();
  globalThis.__db.listEpisodes = async () => eps(1, 7);
  globalThis.__db.hostedSet = async () => new Set([1, 7]);
  store.set('aep-offline-n', '1');                       // only episode 1 is a target
  audioCache.set(hostedAudioUrl(7), ok());
  globalThis.__db.getEpisode = async (id) => { pinEpisode(7); return { id, transcribed_at: 'v1' }; };
  await m.ensureOfflineCache();
  assert.ok(audioCache.has(hostedAudioUrl(7)));
});

test('the cleanup still removes an unpinned episode outside the window', async () => {
  const m = await loadOffline();
  globalThis.__db.listEpisodes = async () => eps(1, 7);
  globalThis.__db.hostedSet = async () => new Set([1, 7]);
  store.set('aep-offline-n', '1');
  audioCache.set(hostedAudioUrl(7), ok());
  await m.ensureOfflineCache();
  assert.ok(!audioCache.has(hostedAudioUrl(7)));
});

test('lie-fi: a cached list and manifest with every download failing is not a finished run', async () => {
  // onLine stays true and the service worker answers the list and manifest, so only the audio fails.
  const m = await loadOffline();
  setNetwork(() => { throw new TypeError('Failed to fetch'); });
  await m.ensureOfflineCache();
  assert.equal(audioCache.size, 0);
  setNetwork(ok);
  await m.ensureOfflineCache();
  assert.equal(audioCache.size, 1);
});

test('a partly finished run picks up the rest, and skips what it already has', async () => {
  const m = await loadOffline();
  globalThis.__db.listEpisodes = async () => eps(1, 2);
  globalThis.__db.hostedSet = async () => new Set([1, 2]);
  setNetwork((url) => (String(url).includes('/2.mp3') ? new Response('', { status: 503 }) : ok()));
  await m.ensureOfflineCache();
  assert.equal(audioCache.size, 1);
  setNetwork(ok);
  await m.ensureOfflineCache();
  assert.equal(audioCache.size, 2);
  assert.deepEqual(fetched, ['cors'], 'only the missing episode is fetched');
});

test('a failed run does not free space it has not replaced', async () => {
  const m = await loadOffline();
  globalThis.__db.listEpisodes = async () => eps(1, 7);
  globalThis.__db.hostedSet = async () => new Set([1, 7]);
  store.set('aep-offline-n', '1');
  audioCache.set(hostedAudioUrl(7), ok());            // yesterday's download, now outside the window
  setNetwork(() => { throw new TypeError('Failed to fetch'); });
  await m.ensureOfflineCache();
  assert.ok(audioCache.has(hostedAudioUrl(7)), 'the only playable episode must survive a dead zone');
});
