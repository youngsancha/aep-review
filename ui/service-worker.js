// aep-review service worker — 오프라인 지원.
//  ① 동일 출처 앱 셸 → stale-while-revalidate (버전 캐시).
//  ② Supabase 데이터/Storage(자막·번역·vocab·essentials·소형 TTS) → network-first + 캐시 폴백
//     (온라인=항상 최신, 오프라인=마지막으로 본 자료 열람). 데이터 캐시는 버전과 분리·상한 트림.
//  ③ 대용량 오디오(R2 CDN)·esm.sh 는 그대로 네트워크(SW 우회) — Range 재생/용량 때문.
const VERSION = '1.8.2';
const CACHE = 'aep-review-shell-v' + VERSION;
// 데이터 캐시는 버전과 무관하게 유지(셸 업그레이드해도 오프라인 자료 보존). 용량 상한으로 트림.
const DATA_CACHE = 'aep-review-data-v1';
const DATA_MAX = 160;
const Q = '?v=' + VERSION;
const SHELL = [
  '/', '/index.html', '/manifest.json',
  '/style.css' + Q,
  '/app.js' + Q, '/tts.js' + Q, '/player.js' + Q, '/media-session.js' + Q, '/scrub.js' + Q,
  '/config.js' + Q, '/supabase.js' + Q, '/db.js' + Q, '/clip.js' + Q, '/translate.js' + Q,
  '/views/timeline.js' + Q, '/views/episode.js' + Q, '/views/srs.js' + Q, '/views/study.js' + Q, '/views/login.js' + Q,
  '/views/essentials.js' + Q, '/data/essentials.json',
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
      // 현재 셸 캐시 + 데이터 캐시만 남기고 옛 셸 캐시 제거(데이터 캐시는 보존).
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 데이터 캐시 용량 상한 — 오래된 항목부터 제거(대략 FIFO).
async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (const req of keys.slice(0, keys.length - max)) await cache.delete(req);
}

// network-first: 온라인이면 항상 최신을 받고 캐시에 갱신, 오프라인이면 마지막으로 본 응답을 돌려준다.
async function networkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(req);
    // 부분응답(206)·오류는 캐시 불가/부적합 → 그대로 반환. 정상 200 만 저장.
    if (res && res.status === 200 && (res.type === 'cors' || res.type === 'basic')) {
      cache.put(req, res.clone()).then(() => trimCache(DATA_CACHE, DATA_MAX)).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;   // 오프라인 + 미캐시 → 호출부가 빈 데이터로 처리(앱은 graceful degrade)
  }
}

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;

  // ① Supabase 데이터/Storage(자막·번역·vocab·essentials 등) → network-first(오프라인 열람 가능).
  //    REST(/rest/v1/) + Storage 객체(/storage/v1/object/). 대용량 오디오는 별도 CDN(R2)이라 제외.
  if (url.hostname.endsWith('.supabase.co') &&
      (url.pathname.includes('/rest/v1/') || url.pathname.includes('/storage/v1/object/'))) {
    e.respondWith(networkFirst(req));
    return;
  }

  // ② 그 외 cross-origin(R2 오디오·esm.sh 등)은 그대로 네트워크(SW 우회).
  if (url.origin !== self.location.origin) return;

  // ③ 같은 출처 앱 셸: stale-while-revalidate
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
