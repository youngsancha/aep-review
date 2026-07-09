// aep-review service worker — 오프라인 지원.
//  ① 동일 출처 앱 셸 → stale-while-revalidate (버전 캐시).
//  ② Supabase 데이터/Storage(자막·번역·vocab·essentials·소형 TTS) → network-first + 캐시 폴백
//     (온라인=항상 최신, 오프라인=마지막으로 본 자료 열람). 데이터 캐시는 버전과 분리·상한 트림.
//  ③ esm.sh 벤더 모듈(supabase-js) → stale-while-revalidate — 이게 없으면 오프라인 부팅 불가.
//  ④ R2 회차 오디오 → 캐시 우선(offline.js 가 최근 회차를 미리 저장). CORS(읽기가능) 캐시는
//     Range 요청에 206 합성 → 오프라인 시크 지원. opaque(no-cors 폴백) 캐시는 온라인=네트워크
//     우선(평소와 동일), 오프라인=전체 응답 폴백. 미캐시 회차는 그대로 네트워크 스트리밍.
//  ⑤ 쇼 커버(imgix) → cache-first — 오프라인 라이브러리/로그인 화면용.
const VERSION = '1.18.1';
const CACHE = 'aep-review-shell-v' + VERSION;
// 데이터/벤더/오디오/이미지 캐시는 버전과 무관하게 유지(셸 업그레이드해도 오프라인 자료 보존).
const DATA_CACHE = 'aep-review-data-v1';
const VENDOR_CACHE = 'aep-review-vendor-v1';
const AUDIO_CACHE = 'aep-review-audio-v1';
const IMG_CACHE = 'aep-review-img-v1';
const DATA_MAX = 400;   // 회차 프리페치(최근 N개 행+자막+번역)가 들어가도록 160→400
const IMG_MAX = 30;
const Q = '?v=' + VERSION;
const SHELL = [
  '/', '/index.html', '/manifest.json',
  '/style.css' + Q,
  '/app.js' + Q, '/tts.js' + Q, '/player.js' + Q, '/media-session.js' + Q, '/scrub.js' + Q,
  '/config.js' + Q, '/supabase.js' + Q, '/db.js' + Q, '/clip.js' + Q, '/translate.js' + Q, '/proficiency.js' + Q, '/offline.js' + Q,
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
      // 현재 셸 + 영속 캐시(데이터/벤더/오디오/이미지)만 남기고 옛 셸 캐시 제거.
      .then((keys) => {
        const KEEP = new Set([CACHE, DATA_CACHE, VENDOR_CACHE, AUDIO_CACHE, IMG_CACHE]);
        return Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k)));
      })
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
    // ignoreVary: 저장 응답의 Vary(Accept-Encoding 등) 때문에 오프라인 매칭이 어긋나지 않게.
    const cached = await cache.match(req, { ignoreVary: true });
    if (cached) return cached;
    throw err;   // 오프라인 + 미캐시 → 호출부가 빈 데이터로 처리(앱은 graceful degrade)
  }
}

// esm.sh 벤더 모듈(supabase-js 등): stale-while-revalidate.
// 첫 제어 로드에서 캐시된 뒤로는 오프라인에서도 모듈 import 가 성공해 앱이 부팅된다.
async function vendorSWR(req) {
  const cache = await caches.open(VENDOR_CACHE);
  const cached = await cache.match(req.url, { ignoreVary: true });
  const network = fetch(req).then((res) => {
    if (res && res.status === 200) cache.put(req.url, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

// 쇼 커버(imgix): cache-first. <img> 는 no-cors 라 opaque 응답도 그대로 표시 가능.
async function imageCacheFirst(req) {
  const cache = await caches.open(IMG_CACHE);
  const cached = await cache.match(req.url, { ignoreVary: true });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.status === 200 || res.type === 'opaque')) {
      cache.put(req.url, res.clone()).then(() => trimCache(IMG_CACHE, IMG_MAX)).catch(() => {});
    }
    return res;
  } catch (err) {
    return Response.error();  // 오프라인 + 미캐시 → onerror 폴백 아이콘이 표시된다
  }
}

// R2 회차 오디오: 캐시 우선(offline.js 가 채움).
//  · 읽기가능(CORS) 캐시 → Range 요청에 206 을 합성해 오프라인 시크까지 완전 지원.
//  · opaque(no-cors 폴백) 캐시 → 바디를 읽을 수 없어 합성 불가: 온라인이면 평소처럼 네트워크
//    스트리밍(동작 무변화), 오프라인일 때만 전체 응답을 폴백으로 준다(Chrome 계열 재생 OK).
//  · 미캐시 → 그대로 네트워크(기존과 동일한 스트리밍).
async function serveAudio(req) {
  const cache = await caches.open(AUDIO_CACHE);
  const cached = await cache.match(req.url, { ignoreVary: true });
  if (!cached) return fetch(req);
  if (cached.type === 'opaque') {
    try { return await fetch(req); } catch (err) { return cached; }
  }
  const range = req.headers.get('range');
  if (range && cached.status === 200) {
    const m = /bytes=(\d+)-(\d+)?/i.exec(range);
    if (m) {
      const blob = await cached.blob();   // blob.slice 는 지연 로드 — 대용량이어도 메모리 안전
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), blob.size - 1) : blob.size - 1;
      if (start >= blob.size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
      }
      return new Response(blob.slice(start, end + 1), {
        status: 206,
        statusText: 'Partial Content',
        headers: {
          'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
          'Content-Range': `bytes ${start}-${end}/${blob.size}`,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
        },
      });
    }
  }
  return cached;
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

  // ② R2 회차 오디오 — offline.js 가 미리 받은 회차는 캐시에서(오프라인 재생·Range 합성).
  if (url.hostname.endsWith('.r2.dev')) {
    e.respondWith(serveAudio(req));
    return;
  }

  // ③ esm.sh 벤더 모듈(supabase-js) — 캐시해 두면 오프라인에서도 앱이 부팅된다.
  if (url.hostname === 'esm.sh') {
    e.respondWith(vendorSWR(req));
    return;
  }

  // ④ 쇼 커버(imgix) — 오프라인 라이브러리/로그인 화면용 cache-first.
  if (url.hostname === 'megaphone.imgix.net') {
    e.respondWith(imageCacheFirst(req));
    return;
  }

  // ⑤ 그 외 cross-origin(megaphone 스트리밍·MyMemory 등)은 그대로 네트워크(SW 우회).
  if (url.origin !== self.location.origin) return;

  // ⑥ 같은 출처 앱 셸: stale-while-revalidate
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
