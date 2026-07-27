// Media Session 연동 — 차량(테슬라)·핸들 버튼·잠금화면·블루투스 미디어 컨트롤을 전역 플레이어에 배선.
// 브라우저 표준 navigator.mediaSession 만 사용(추가 권한·라이브러리 없음). "차가 폰을 자동 실행"시키는
// 표준 API 는 없으므로(NOTES 한계 참고), 폰에서 재생을 시작한 뒤 차/핸들/잠금화면 컨트롤로 '조작'되게 한다.
//
// 설계: DOM/navigator 를 top-level 에서 만지지 않아 node --test 로 순수 단위검증 가능.
//  - mediaSessionActions(player, cfg) → { action: handler } 맵(주입 테스트).
//  - buildMetadata(track, MediaMetadataCtor) → 메타데이터 객체(스텁 ctor 테스트).
//  - bindMediaSession(player, deps?) → 실제 배선(미지원 환경이면 no-op, false 반환).

// 인앱 버튼과 동일(episode.js: back 15s / fwd 30s) → 컨트롤 간 일관.
export const DEFAULT_BACK = 15;
export const DEFAULT_FWD = 30;
// 앱 이름 — 트랙에 쇼 정보가 없을 때만 쓰는 폴백. 예전엔 'American English Podcast' 를 하드코딩해
// artist/album 에 넣었는데, 멀티-쇼(All Ears English·White House Briefing) 이후로는 어떤 쇼를 틀어도
// 잠금화면/차량 디스플레이에 AEP 로 표시되는 오표기였다. 실제 쇼 이름은 호출부가 track.show 로 준다.
// ⚠ 이 모듈은 node 단위테스트에서 직접 import 하려고 의도적으로 import 가 없다(절대경로 '/config.js'
// 는 node 에서 해석 불가). 그래서 config.js 의 APP_NAME 을 여기 복제하고, 두 값이 어긋나면
// tests/media_session.test.mjs 가 실패한다.
export const APP_NAME = 'E-Podcast';

// 액션 핸들러 맵 — 차량/핸들/잠금화면의 표준 미디어 액션을 player 메서드로 변환.
export function mediaSessionActions(player, cfg = {}) {
  const back = cfg.back || DEFAULT_BACK;
  const fwd = cfg.fwd || DEFAULT_FWD;
  return {
    play: () => player.play(),
    pause: () => player.pause(),
    // 일부 UI 는 seekOffset 을 넘김(없으면 앱 기본값).
    seekbackward: (d) => player.skip(-((d && d.seekOffset) || back)),
    seekforward: (d) => player.skip(+((d && d.seekOffset) || fwd)),
    // 차량 진행바 드래그/숫자 시킹.
    seekto: (d) => { if (d && Number.isFinite(d.seekTime)) player.seek(d.seekTime); },
    // 핸들/블루투스의 이전·다음 트랙 = 팟캐스트에선 빨리감기/되감기로 매핑(트랙이 하나라).
    previoustrack: () => player.skip(-back),
    nexttrack: () => player.skip(+fwd),
  };
}

// 잠금화면/차량 디스플레이용 메타데이터(제목·쇼·아트워크).
export function buildMetadata(track, MediaMetadataCtor) {
  if (!MediaMetadataCtor || !track) return null;
  const art = track.cover
    ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }]
    : [];
  return new MediaMetadataCtor({
    title: track.title || APP_NAME,
    artist: track.show || APP_NAME,
    album: track.show || APP_NAME,   // 앨범 = 그 회차가 속한 쇼(고정 AEP 아님)
    artwork: art,
  });
}

// 재생위치/길이/속도를 차량 화면 진행바에 동기화. duration 이 유효할 때만(아니면 throw).
export function updatePositionState(ms, player) {
  if (!ms || typeof ms.setPositionState !== 'function') return;
  const dur = player.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;
  const rate = (player.audio && player.audio.playbackRate) || 1;
  try {
    ms.setPositionState({
      duration: dur,
      playbackRate: rate > 0 ? rate : 1,
      position: Math.min(Math.max(player.time, 0), dur),
    });
  } catch (e) { /* 브라우저별 제약 — 무시(견고성) */ }
}

// 실제 배선. deps 주입 가능(테스트). 미지원 환경이면 아무것도 안 하고 false.
export function bindMediaSession(player, deps = {}) {
  const nav = deps.navigator || (typeof navigator !== 'undefined' ? navigator : null);
  const MM = deps.MediaMetadata || (typeof MediaMetadata !== 'undefined' ? MediaMetadata : null);
  const ms = nav && nav.mediaSession;
  if (!ms || typeof ms.setActionHandler !== 'function') return false;

  const actions = mediaSessionActions(player, deps.cfg);
  for (const [name, handler] of Object.entries(actions)) {
    // 일부 브라우저는 특정 액션 미지원 → 등록 실패를 삼킨다(견고성).
    try { ms.setActionHandler(name, handler); } catch (e) { /* unsupported action */ }
  }

  const setMeta = (track) => {
    try { ms.metadata = buildMetadata(track, MM); } catch (e) { /* ignore */ }
  };
  setMeta(player.current);          // 이미 트랙이 있으면 즉시 반영
  updatePositionState(ms, player);

  player.on((ev) => {
    if (ev === 'track') setMeta(player.current);
    else if (ev === 'play') ms.playbackState = 'playing';
    else if (ev === 'pause' || ev === 'ended') ms.playbackState = 'paused';
    if (ev === 'timeupdate' || ev === 'meta' || ev === 'play' || ev === 'track') {
      updatePositionState(ms, player);
    }
  });
  return true;
}
