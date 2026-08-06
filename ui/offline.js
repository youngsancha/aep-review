// 오프라인 모드 — 최근 회차를 미리 받아 비행기모드에서도 온라인과 동일하게 청취.
//  · 데이터(회차 행·자막·한글 사전번역·vocab)는 getEpisode() 워밍으로 SW DATA_CACHE 에 들어간다.
//    다만 DATA_CACHE 는 TTS 등 무관한 트래픽에 밀려 FIFO 트림될 수 있어(사용자 신고: 오디오는
//    오프라인에 살아있는데 자막만 사라짐), '핀'(자동 다운로드 대상 + 수동 다운로드) 회차의 회차행
//    +자막만은 SW 에 ADD_PINNED_EPISODES 로 알려 DOC_CACHE(안 트림됨)에도 함께 남긴다 — 실제
//    캐시 put 은 SW 의 networkFirst 가 실제 요청/응답을 그대로 미러링해서 하므로(아래
//    notifyPinnedIds/episodeDocReady), 여기서 PostgREST 쿼리 URL 을 직접 재현할 필요가 없다.
//  · 오디오(R2 전체 파일)는 AUDIO_CACHE 에 저장 — 서빙은 service-worker.js 가 담당.
//  · R2 버킷에 CORS 가 없어(2026-07 실측) 기본은 no-cors(opaque) 저장 — Chrome 계열 재생 OK.
//    버킷 CORS 를 켜면 다음 다운로드부터 자동으로 읽기가능 응답(오프라인 시크 지원)으로 업그레이드.
//  · 자막 재싱크(transcribed_at 변경) 시 해당 오디오 + doc 캐시를 지우고 다시 받는다(자막=오디오
//    일치 유지 — 오디오·자막이 같은 META_KEY 로 무효화되므로 둘이 어긋날 수 없다).
//  · 트리거: app.js 가 로그인 후 잠시 뒤 백그라운드로 1회 호출(ensureOfflineCache).
import { listEpisodes, getEpisode, episodeNav, hostedSet, transcriptUrl } from '/db.js';
import { hostedAudioUrl } from '/config.js';
import { toast } from '/app.js';
import { loadPins, pinEpisode, unpinEpisode } from '/offline-pins.js';

const AUDIO_CACHE = 'aep-review-audio-v1';   // service-worker.js 와 반드시 동일한 이름
const DOC_CACHE = 'aep-review-doc-v1';       // 회차행+자막 '핀' 캐시 — service-worker.js 와 동일한 이름
const META_KEY = 'aep-offline-meta';         // { [id]: transcribedAt } — 다운로드 당시 자막 버전
const COUNT_KEY = 'aep-offline-n';           // 유지 회차 수 오버라이드(기본 15, 0=끔)
const STATUS_KEY = 'aep-offline-run';        // 마지막 프리페치 실행 기록 — 라이브러리 상태줄/진단용

// SW 에게 '이 회차 id 들은 다운로드/핀 대상 — networkFirst 응답을 DOC_CACHE 에도 남겨라' 알림.
// MessageChannel 로 ack 를 기다려서, 이 함수가 resolve 된 뒤에 이어지는 getEpisode() 호출부터는
// SW 가 확실히 pinnedEpisodeIds 를 반영한 상태로 처리한다(경합 방지). SW 미제어(첫 방문 등)거나
// 타임아웃(1s)이면 그냥 넘어간다 — 다음 세션이 다시 시도하므로 무해하다.
function notifyPinnedIds(ids) {
  const arr = [...ids].map(Number).filter(Number.isFinite);
  if (!arr.length) return Promise.resolve(false);
  return new Promise((resolve) => {
    const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!ctrl) { resolve(false); return; }
    let done = false;
    const mc = new MessageChannel();
    mc.port1.onmessage = () => { done = true; resolve(true); };
    try { ctrl.postMessage({ type: 'ADD_PINNED_EPISODES', ids: arr }, [mc.port2]); }
    catch (e) { resolve(false); return; }
    setTimeout(() => { if (!done) resolve(false); }, 1000);
  });
}

// 이 회차의 doc 캐시(회차행 + 자막)가 이미 준비됐는가 — 준비됐으면 getEpisode() 재요청(REST 3콜)을
// 건너뛴다. 회차행은 URL 을 손으로 재현하지 않고(postgrest-js 인코딩에 의존하지 않기 위해) 이미
// 저장된 키들을 순회해 패턴으로 찾는다. 자막은 db.js::transcriptUrl 이 단일 출처라 안전하게 재사용.
async function episodeDocReady(id, transcribedAt) {
  try {
    const cache = await caches.open(DOC_CACHE);
    const keys = await cache.keys();
    const hasRow = keys.some((req) => {
      const u = new URL(req.url);
      return u.pathname === '/rest/v1/episodes' && u.searchParams.get('id') === `eq.${id}`;
    });
    if (!hasRow) return false;
    if (!transcribedAt) return true;   // 이 회차엔 자막이 없다(아직 STT 전) — 회차행만으로 충분
    return !!(await cache.match(transcriptUrl(id, transcribedAt), { ignoreVary: true }));
  } catch (e) { return false; }
}

// 이 회차의 doc 캐시 항목(회차행 + 자막 + 한글자막)을 전부 지운다 — 오디오 삭제/재싱크와 짝을
// 맞춰 두 캐시가 어긋나지 않게 한다(오디오만 지우고 doc 은 남으면, 다음에 그 회차를 다시 열 때
// 낡은 자막이 새 오디오와 안 맞을 수 있다).
async function deleteEpisodeDoc(id) {
  try {
    const cache = await caches.open(DOC_CACHE);
    const keys = await cache.keys();
    await Promise.all(keys.filter((req) => {
      const u = new URL(req.url);
      if (u.pathname === '/rest/v1/episodes' && u.searchParams.get('id') === `eq.${id}`) return true;
      const m = /\/storage\/v1\/object\/public\/transcripts\/(\d+)(?:_ko)?\.json$/.exec(u.pathname);
      return !!m && Number(m[1]) === Number(id);
    }).map((req) => cache.delete(req)));
  } catch (e) {}
}

function setStatus(patch) {
  try {
    const cur = JSON.parse(localStorage.getItem(STATUS_KEY) || '{}') || {};
    localStorage.setItem(STATUS_KEY, JSON.stringify({ ...cur, ...patch, at: Date.now() }));
  } catch (e) {}
}
// 마지막 실행 상태 {phase: running|done|skipped|error, done, total, note, at} — timeline 상태줄이 읽는다.
export function offlineRunStatus() {
  try { return JSON.parse(localStorage.getItem(STATUS_KEY) || 'null'); } catch (e) { return null; }
}

export function offlineCount() {
  try {
    const n = parseInt(localStorage.getItem(COUNT_KEY) || '', 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(30, n)) : 15;
  } catch (e) { return 15; }
}

// 유지 회차 수 변경(라이브러리 상태줄 탭). 0~30 으로 클램프하고 저장한 값을 돌려준다.
export function setOfflineCount(n) {
  const v = Math.max(0, Math.min(30, parseInt(n, 10) || 0));
  try { localStorage.setItem(COUNT_KEY, String(v)); } catch (e) {}
  return v;
}

// '지금 받기'/재시도 — 세션 1회 가드를 풀고 프리페치를 다시 돌린다(개수 변경·에러 후 수동 실행).
export async function forceRun() {
  _ran = false;
  await ensureOfflineCache();
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

// ─────────────── 회차 1개 수동 다운로드(회차 화면 ⬇ 버튼) ───────────────
// 자동 프리페치(최근 N개)와 별개로, 지금 보고 있는 회차를 즉시 받아 둔다. 받은 회차는 핀에
// 올라가 정리 루프의 삭제 대상에서 빠진다(offline-pins.js 참고).

/** 이 회차 오디오가 이미 캐시에 있는가. */
export async function isEpisodeCached(id) {
  try {
    const cache = await caches.open(AUDIO_CACHE);
    return !!(await cache.match(hostedAudioUrl(id), { ignoreVary: true }));
  } catch (e) { return false; }
}

/** 회차 오디오를 받아 캐시 + 핀. 이미 있으면 다운로드는 건너뛰되 핀은 보장한다.
 *  자막도 같은 취급을 받도록(요구사항: 자동/수동 다운로드가 동일하게) doc 캐시도 함께 채운다 —
 *  회차 화면은 이미 이 회차를 열람해 getEpisode() 를 한 번 호출했겠지만, 그건 이 회차가 아직
 *  '핀' 대상이 되기 전이라 SW 가 DOC_CACHE 에 남기지 않았을 수 있다 → 핀 알림 후 재요청해 확정한다. */
export async function cacheEpisodeAudio(id) {
  const fresh = await cacheAudio(hostedAudioUrl(id));
  pinEpisode(id);          // 이미 캐시돼 있던 경우에도 '사용자가 원한 회차'로 고정
  await notifyPinnedIds([id]);
  try { await getEpisode(id); } catch (e) { /* 오프라인/일시 오류 — 다음 오프라인 프리페치가 백필한다 */ }
  return fresh;
}

/** 회차 오디오를 캐시에서 제거 + 핀 해제(사용자가 저장공간을 되돌릴 때). doc 캐시도 함께 지워
 *  오디오·자막 두 캐시가 어긋나지 않게 한다. */
export async function removeEpisodeAudio(id) {
  unpinEpisode(id);
  await deleteEpisodeDoc(id);
  try {
    const cache = await caches.open(AUDIO_CACHE);
    return await cache.delete(hostedAudioUrl(id), { ignoreVary: true });
  } catch (e) { return false; }
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
  if (!n) { setStatus({ phase: 'skipped', note: 'disabled (aep-offline-n=0)' }); return; }
  if (!navigator.onLine) return;   // 오프라인 접속 자체는 정상 상황 — 기록 안 함
  if (navigator.connection && navigator.connection.saveData) {
    setStatus({ phase: 'skipped', note: 'Data Saver on' });   // 절약 모드 존중 — 상태줄로 이유를 보여준다
    return;
  }
  try { navigator.storage?.persist?.(); } catch (e) {}                  // 브라우저 임의 축출 방지

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    // 벤더 모듈이 이미 캐시돼 있으면 재다운로드하지 않는다(매 부팅 ~100–200KB 재요청 제거).
    let vkeys = [];
    try { vkeys = await (await caches.open('aep-review-vendor-v1')).keys(); } catch (e) {}
    if (!vkeys.length) await warmVendor('https://esm.sh/@supabase/supabase-js@2');
  }

  // R2 호스팅(자막=오디오 일치 보장) 회차만 대상 — megaphone(DAI)은 세션마다 광고가 달라 캐시 무의미.
  let items, hosted;
  try {
    [items, hosted] = await Promise.all([listEpisodes(), hostedSet()]);
  } catch (err) {
    setStatus({ phase: 'error', note: 'list: ' + String(err && err.message || err).slice(0, 100) });
    return;
  }
  const targets = items.filter((e) => hosted.has(Number(e.id))).slice(0, n);
  if (!targets.length) {
    // 원인을 구분한다. 예전엔 둘 다 'no hosted episodes in list' 였는데, 오프라인에서 매니페스트를
    // 못 받아 hosted 가 빈 집합이 된 경우까지 '이 쇼에 호스팅 회차가 없다'고 잘못 말했다.
    const note = hosted.size === 0 ? 'hosted manifest unavailable (offline?)'
      : 'this show has no hosted episodes yet';
    setStatus({ phase: 'error', note });
    return;
  }
  try { await episodeNav(targets[0].id); } catch (e) {}   // ⏮/⏭ 용 id 목록도 DATA_CACHE 에

  const pins = loadPins();
  // SW 에 '이 회차들은 핀' 이라고 먼저 알린다 — 뒤이은 getEpisode() 호출들이 그 응답을 DOC_CACHE 에도
  // 남기게 하려면 요청이 나가기 전에 SW 가 알고 있어야 한다(경합 방지, notifyPinnedIds 주석 참고).
  await notifyPinnedIds([...targets.map((e) => e.id), ...pins]);

  const meta = loadMeta();
  const cache = await caches.open(AUDIO_CACHE);
  let ok = 0, fresh = 0;
  setStatus({ phase: 'running', done: 0, total: targets.length, note: '' });
  for (const e of targets) {
    try {
      const url = hostedAudioUrl(e.id);
      // 정상 상태 최적화: 오디오가 이미 캐시돼 있고 자막 버전(list.transcribed_at)이 지난 다운로드
      // 때와 같고, doc 캐시(회차행+자막)까지 이미 준비돼 있으면 getEpisode(REST 3콜)·다운로드를
      // 건너뛴다 → 매 부팅 ~45콜 재요청 제거(데이터/배터리). doc 캐시가 없으면(이 기능 배포 전에
      // 받은 회차 — ⛔ 백필 안 하면 그 회차들은 영영 자막 없는 오프라인으로 남는다) 아래로 떨어져
      // getEpisode() 를 다시 부른다: 오디오는 그대로 재사용하고 doc 만 채운다(1회성 비용).
      const listTa = e.transcribed_at || '';
      const audioCached = !!(await cache.match(url, { ignoreVary: true }));
      const metaMatches = !!(audioCached && meta[e.id] && listTa && meta[e.id] === listTa);
      if (metaMatches && await episodeDocReady(e.id, listTa)) {
        ok++;
        setStatus({ phase: 'running', done: ok, total: targets.length });
        continue;
      }
      // 자막 버전이 실제로 바뀐 재싱크라면(단순 doc 백필이 아니라) 옛 자막 URL(버전키 포함)이
      // doc 캐시에 orphan 으로 남지 않도록 먼저 비운다. getEpisode() 가 곧바로 새 값을 채운다.
      if (meta[e.id] && listTa && meta[e.id] !== listTa) {
        await deleteEpisodeDoc(e.id);
      }
      const ep = await getEpisode(e.id);      // REST 행+자막+한글번역 → SW DATA_CACHE + (핀이므로) DOC_CACHE 워밍
      if (meta[e.id] && ep.transcribed_at && meta[e.id] !== ep.transcribed_at) {
        await cache.delete(url, { ignoreVary: true });    // 재싱크 → 옛 오디오 폐기
      }
      if (await cacheAudio(url)) fresh++;     // 순차 다운로드(대역폭 독점 방지)
      meta[e.id] = ep.transcribed_at || meta[e.id] || '';
      saveMeta(meta);
      ok++;
      setStatus({ phase: 'running', done: ok, total: targets.length });
    } catch (err) {
      setStatus({ note: `ep${e.id}: ` + String(err && err.message || err).slice(0, 100) });
      if (!navigator.onLine) break;           // 네트워크 유실 — 다음 부팅에서 이어받는다
      console.warn('[offline] episode cache failed', e.id, err);
    }
  }
  setStatus({ phase: 'done', done: ok, total: targets.length });

  // 수동 핀(자동 대상 N개 밖 — 예: 다른 쇼 회차, 오래전에 받아 둔 회차)도 같은 취급을 받는다.
  // 오디오가 이미 있는(=사용자가 실제로 받아 둔) 핀만 대상 — 오디오조차 없는 핀은 여기서 할 일이 없다
  // (cacheEpisodeAudio 가 다운로드 시점에 이미 자체적으로 doc 을 채운다).
  const targetIds = new Set(targets.map((e) => Number(e.id)));
  for (const pid of pins) {
    if (targetIds.has(Number(pid)) || !navigator.onLine) continue;
    try {
      const audioCached = !!(await cache.match(hostedAudioUrl(pid), { ignoreVary: true }));
      if (!audioCached) continue;
      if (await episodeDocReady(pid, meta[pid] || '')) continue;
      const ep = await getEpisode(pid);       // 쇼 무관 — id 는 전역 유일(db.js 주석 참고)
      meta[pid] = ep.transcribed_at || meta[pid] || '';
      saveMeta(meta);
    } catch (err) { if (!navigator.onLine) break; }
  }

  // 대상 밖(오래된) 오디오 정리 — 최근 N개만 유지. ⚠ 멀티쇼: 에피소드 id 는 두 쇼가 공유하는 전역
  // 시퀀스라, 삭제를 '현재 쇼에 속한 id'로 한정하지 않으면 다른 쇼가 받아 둔 오디오까지 지운다
  // (쇼 전환→재실행 때마다 상대 쇼 캐시 수백 MB 증발). listEpisodes 는 현재 쇼 전체를 주므로
  // curIds 에 없는(=다른 쇼) 키는 건드리지 않는다.
  // ⚠ 수동 다운로드(핀)는 자동 대상 밖이어도 보존한다 — 없으면 사용자가 손수 받아 둔 회차가
  // 다음 부팅의 이 정리 루프에서 말없이 삭제된다(무신호 통근길에 재생 불가).
  const curIds = new Set(items.map((e) => Number(e.id)));
  const keep = new Set([
    ...targets.map((e) => hostedAudioUrl(e.id)),
    ...pins.map((id) => hostedAudioUrl(id)),
  ]);
  try {
    const keys = await cache.keys();
    for (const req of keys) {
      const cid = Number((new URL(req.url).pathname.match(/\/(\d+)\.mp3$/) || [])[1]);
      if (Number.isFinite(cid) && curIds.has(cid) && !keep.has(req.url)) {
        await cache.delete(req);
        await deleteEpisodeDoc(cid);          // 오디오와 doc(자막) 캐시를 같은 생명주기로 유지
      }
    }
  } catch (e) {}

  if (fresh > 0) {
    const ready = await offlineReadyIds();
    toast(`Offline: ${ready.size} episodes ready`);
  }
}
