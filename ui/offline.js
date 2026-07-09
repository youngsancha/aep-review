// 오프라인 모드 — 최근 회차를 미리 받아 비행기모드에서도 온라인과 동일하게 청취.
//  · 데이터(회차 행·자막·한글 사전번역·vocab)는 getEpisode() 워밍으로 SW DATA_CACHE 에,
//    오디오(R2 전체 파일)는 AUDIO_CACHE 에 저장 — 서빙은 service-worker.js 가 담당.
//  · R2 버킷에 CORS 가 없어(2026-07 실측) 기본은 no-cors(opaque) 저장 — Chrome 계열 재생 OK.
//    버킷 CORS 를 켜면 다음 다운로드부터 자동으로 읽기가능 응답(오프라인 시크 지원)으로 업그레이드.
//  · 자막 재싱크(transcribed_at 변경) 시 해당 오디오를 지우고 다시 받는다(자막=오디오 일치 유지).
//  · 트리거: app.js 가 로그인 후 잠시 뒤 백그라운드로 1회 호출(ensureOfflineCache).
import { listEpisodes, getEpisode, episodeNav, hostedSet } from '/db.js';
import { hostedAudioUrl } from '/config.js';
import { toast } from '/app.js';

const AUDIO_CACHE = 'aep-review-audio-v1';   // service-worker.js 와 반드시 동일한 이름
const META_KEY = 'aep-offline-meta';         // { [id]: transcribedAt } — 다운로드 당시 자막 버전
const COUNT_KEY = 'aep-offline-n';           // 유지 회차 수 오버라이드(기본 15, 0=끔)

export function offlineCount() {
  try {
    const n = parseInt(localStorage.getItem(COUNT_KEY) || '', 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(30, n)) : 15;
  } catch (e) { return 15; }
}

function loadMeta() { try { return JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch { return {}; } }
function saveMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) {} }

// 오프라인 재생 가능한(오디오 캐시 완료) 회차 id 집합 — 라이브러리 ⬇ 배지용.
export async function offlineReadyIds() {
  try {
    const cache = await caches.open(AUDIO_CACHE);
    const keys = await cache.keys();
    return new Set(
      keys.map((r) => Number((new URL(r.url).pathname.match(/\/(\d+)\.mp3$/) || [])[1]))
          .filter(Number.isFinite)
    );
  } catch (e) { return new Set(); }
}

// 오디오 1개 저장. 이미 있으면 no-op. CORS 시도 → 실패 시 no-cors(opaque) 폴백.
// 네트워크 자체가 죽었으면 no-cors fetch 도 throw → 호출부(순차 루프)가 중단한다.
async function cacheAudio(url) {
  const cache = await caches.open(AUDIO_CACHE);
  if (await cache.match(url, { ignoreVary: true })) return false;
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (res.ok) { await cache.put(url, res); return true; }
  } catch (e) { /* 버킷 CORS 미설정 — opaque 폴백 */ }
  const res = await fetch(url, { mode: 'no-cors' });
  await cache.put(url, res);
  return true;
}

// 벤더 모듈(esm.sh) 워밍 — 최초 방문은 SW 미제어 로드라 캐시가 비어 있을 수 있다.
// 페이지가 SW 제어 하일 때 fetch 하면 SW 의 vendorSWR 가 VENDOR_CACHE 에 채운다.
// esm.sh 출력은 상대경로 import 체인이라 얕은 재귀(깊이 3)로 하위 모듈까지 따라간다.
async function warmVendor(url, depth = 0, seen = new Set()) {
  if (seen.has(url) || depth > 3) return;
  seen.add(url);
  try {
    const res = await fetch(url);
    const txt = await res.text();
    const subs = [...txt.matchAll(/(?:from|import)\s*"(\/[^"]+)"/g)].map((m) => 'https://esm.sh' + m[1]);
    for (const u of subs) await warmVendor(u, depth + 1, seen);
  } catch (e) { /* 오프라인/일시 오류 — 다음 부팅에서 재시도 */ }
}

let _ran = false;
export async function ensureOfflineCache() {
  if (_ran) return;              // 세션당 1회
  _ran = true;
  const n = offlineCount();
  if (!n || !navigator.onLine) return;
  if (navigator.connection && navigator.connection.saveData) return;   // 데이터 절약 모드 존중
  try { navigator.storage?.persist?.(); } catch (e) {}                  // 브라우저 임의 축출 방지

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    await warmVendor('https://esm.sh/@supabase/supabase-js@2');
  }

  // R2 호스팅(자막=오디오 일치 보장) 회차만 대상 — megaphone(DAI)은 세션마다 광고가 달라 캐시 무의미.
  const [items, hosted] = await Promise.all([listEpisodes(), hostedSet()]);
  const targets = items.filter((e) => hosted.has(Number(e.id))).slice(0, n);
  if (!targets.length) return;
  try { await episodeNav(targets[0].id); } catch (e) {}   // ⏮/⏭ 용 id 목록도 DATA_CACHE 에

  const meta = loadMeta();
  const cache = await caches.open(AUDIO_CACHE);
  let fresh = 0;
  for (const e of targets) {
    try {
      const ep = await getEpisode(e.id);      // REST 행+자막+한글번역 → SW DATA_CACHE 워밍
      const url = hostedAudioUrl(e.id);
      if (meta[e.id] && ep.transcribed_at && meta[e.id] !== ep.transcribed_at) {
        await cache.delete(url, { ignoreVary: true });    // 재싱크 → 옛 오디오 폐기
      }
      if (await cacheAudio(url)) fresh++;     // 순차 다운로드(대역폭 독점 방지)
      meta[e.id] = ep.transcribed_at || meta[e.id] || '';
      saveMeta(meta);
    } catch (err) {
      if (!navigator.onLine) break;           // 네트워크 유실 — 다음 부팅에서 이어받는다
      console.warn('[offline] episode cache failed', e.id, err);
    }
  }

  // 대상 밖(오래된) 오디오 정리 — 최근 N개만 유지
  const keep = new Set(targets.map((e) => hostedAudioUrl(e.id)));
  try {
    const keys = await cache.keys();
    for (const req of keys) if (!keep.has(req.url)) await cache.delete(req);
  } catch (e) {}

  if (fresh > 0) {
    const ready = await offlineReadyIds();
    toast(`Offline: ${ready.size} episodes ready`);
  }
}
