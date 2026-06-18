// aep-review service worker — app shell 캐시.
// 데이터/오디오/TTS 는 모두 cross-origin(Supabase·CDN) → SW 를 우회(온라인).
// 따라서 여기선 동일 출처 정적 셸만 캐시한다.
const VERSION = '55';
const CACHE = 'aep-review-shell-v' + VERSION;
const Q = '?v=' + VERSION;
const SHELL = [
  '/', '/index.html', '/manifest.json',
  '/style.css' + Q,
  '/app.js' + Q, '/tts.js' + Q, '/player.js' + Q,
  '/config.js' + Q, '/supabase.js' + Q, '/db.js' + Q,
  '/views/timeline.js' + Q, '/views/episode.js' + Q, '/views/srs.js' + Q, '/views/study.js' + Q, '/views/login.js' + Q,
  '/icons/icon-64.png', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(url, {cache: 'reload'});
        if (res && res.ok) await cache.put(url, res.clone());
      } catch (err) {
        console.warn('SW install fetch fail', url, err);
      }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Supabase(데이터/Storage)·CDN(오디오)·esm.sh 는 cross-origin → 그대로 네트워크.
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') return;

  // App shell: stale-while-revalidate
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const networkPromise = fetch(req, {cache: 'no-store'}).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        cache.put(req, res.clone());
      }
      return res;
    }).catch(() => null);
    return cached || (await networkPromise) || cache.match('/index.html');
  })());
});
